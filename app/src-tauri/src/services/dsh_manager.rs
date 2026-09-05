//! dsh 旁路进程管理（F4/F6，Phase 2）。
//!
//! 与 llama-server（process_manager）同一套进程管理规范：
//! - 启动：`node <bin.js> web --no-open --port <port>`，注入 DSH_HOME/PATH/代理 env，
//!   CWD 为用户工作区（spike 结论：dsh 按启动 CWD 归档会话）；
//! - 进程树：Job Object（KILL_ON_JOB_CLOSE）整树回收，应用退出时联动 stop_dsh；
//! - 健康：轮询 `GET /`（spike 实测健康路径），就绪后发 Ready；
//! - 日志：stdout/stderr 双读线程 → 环形缓冲 + `dsh:log` 事件；
//!   启动日志中解析 `dsh web: <url>` 作为 Web UI 地址锚点。
//!
//! 安全边界：子进程程序只接受应用自管目录解析出的路径（resolve_node /
//! dsh_bin_js），参数固定为参数列表，无 shell 参与；代理只作用于出站 env，
//! NO_PROXY 恒定放行本机回环，避免 dsh 访问本地 llama-server 被代理劫持。

use std::io::{BufRead, BufReader};
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant};

// 参数列表式子进程封装（std::process::Command 的本文件内别名），
// 程序路径只来自应用自管目录，无 shell、无命令字符串拼接。
use std::process::Command as SpawnProcess;

/// dsh 运行期事件（由 commands 层转发为 Tauri `dsh:ready`/`dsh:stopped`/`dsh:error`）。
#[derive(Debug, Clone)]
pub enum DshRuntimeEvent {
    /// Web UI 就绪，携带实际地址（从启动日志解析，或按端口构造）。
    Ready(String),
    /// 进程退出，携带原因说明。
    Stopped(String),
    /// 运行期错误。
    Error(String),
}

/// 启动参数（由 commands 层从 AppConfig 组装）。
pub struct DshStartOptions {
    pub node_path: PathBuf,
    pub bin_path: PathBuf,
    pub dsh_port: u16,
    pub dsh_home: PathBuf,
    /// dsh 工作区目录（None = 用户主目录）。
    pub workspace_dir: Option<String>,
    pub proxy_url: Option<String>,
}

static DSH_CHILD: Mutex<Option<Child>> = Mutex::new(None);
static DSH_LOGS: Mutex<Vec<String>> = Mutex::new(Vec::new());
static DSH_WEB_URL: Mutex<Option<String>> = Mutex::new(None);
/// 代数计数：每次启动/停止自增，用于让旧的监视线程静默退出，不发过期事件。
static DSH_GENERATION: AtomicU32 = AtomicU32::new(0);

/// 日志环形缓冲上限（行）。
const LOG_CAP: usize = 5000;
/// 健康检查总超时。
const READY_TIMEOUT: Duration = Duration::from_secs(90);

// ---------------------------------------------------------------------------
// Job Object（进程树回收，与 process_manager 同规范）
// ---------------------------------------------------------------------------

#[cfg(windows)]
#[allow(non_snake_case, non_upper_case_globals, dead_code)]
mod job_guard {
    use std::sync::Mutex;

    type HANDLE = *mut std::ffi::c_void;

    // HANDLE 是裸指针，需要包装才能在线程间安全传递
    struct JobHandle(HANDLE);
    unsafe impl Send for JobHandle {}
    unsafe impl Sync for JobHandle {}

    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
    const JobObjectExtendedLimitInformation: u32 = 9;

    #[repr(C)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        PerProcessUserTimeLimit: i64,
        PerJobUserTimeLimit: i64,
        LimitFlags: u32,
        MinimumWorkingSetSize: usize,
        MaximumWorkingSetSize: usize,
        ActiveProcessLimit: u32,
        Affinity: usize,
        ChildProcessCount: u32,
        Reserved: [u32; 2],
    }

    #[repr(C)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION,
        IoInfo: [u64; 6],
        ProcessMemoryLimit: usize,
        JobMemoryLimit: usize,
        PeakProcessMemoryUsed: usize,
        PeakJobMemoryUsed: usize,
    }

    extern "system" {
        fn CreateJobObjectW(lpJobAttributes: *const u8, lpName: *const u16) -> HANDLE;
        fn SetInformationJobObject(
            hJob: HANDLE,
            JobObjectInfoClass: u32,
            lpJobObjectInfo: *const u8,
            cbJobObjectInfoLength: u32,
        ) -> i32;
        fn AssignProcessToJobObject(hJob: HANDLE, hProcess: HANDLE) -> i32;
        fn TerminateJobObject(hJob: HANDLE, uExitCode: u32) -> i32;
        fn CloseHandle(hObject: HANDLE) -> i32;
    }

    static JOB_HANDLE: Mutex<Option<JobHandle>> = Mutex::new(None);

    pub fn attach(process_handle: HANDLE) {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                eprintln!("[dsh] Job Object 创建失败");
                return;
            }
            let mut info = std::mem::zeroed::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ret = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const u8,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ret == 0 {
                eprintln!("[dsh] SetInformationJobObject 失败");
                CloseHandle(job);
                return;
            }
            if AssignProcessToJobObject(job, process_handle) == 0 {
                eprintln!("[dsh] AssignProcessToJobObject 失败");
                CloseHandle(job);
                return;
            }
            if let Ok(mut guard) = JOB_HANDLE.lock() {
                *guard = Some(JobHandle(job));
            }
            eprintln!("[dsh] Job Object 已附加到 dsh 进程");
        }
    }

    pub fn terminate() {
        if let Ok(mut guard) = JOB_HANDLE.lock() {
            if let Some(JobHandle(job)) = guard.take() {
                unsafe {
                    TerminateJobObject(job, 1);
                    CloseHandle(job);
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 日志缓冲
// ---------------------------------------------------------------------------

/// 追加一行到 dsh 日志环形缓冲（安装/检测等非进程动作也写入，保证日志面板完整可见）。
pub fn add_dsh_log(line: &str) {
    if let Ok(mut logs) = DSH_LOGS.lock() {
        if logs.len() >= LOG_CAP {
            let drop_count = logs.len() - LOG_CAP + 1;
            logs.drain(..drop_count);
        }
        logs.push(line.to_string());
    }
}

/// 读取全部 dsh 日志行（dsh_get_logs）。
pub fn get_dsh_logs() -> Vec<String> {
    DSH_LOGS.lock().map(|logs| logs.clone()).unwrap_or_default()
}

/// 清空 dsh 日志（dsh_clear_logs）。
pub fn clear_dsh_logs() {
    if let Ok(mut logs) = DSH_LOGS.lock() {
        logs.clear();
    }
}

/// 当前 Web UI 地址（启动日志解析结果；未运行时为 None）。
pub fn web_url() -> Option<String> {
    DSH_WEB_URL.lock().ok().and_then(|guard| guard.clone())
}

/// dsh 子进程是否仍在运行。
pub fn is_dsh_running() -> bool {
    match DSH_CHILD.lock() {
        Ok(mut guard) => guard
            .as_mut()
            .is_some_and(|child| matches!(child.try_wait(), Ok(None))),
        Err(error) => {
            eprintln!("[dsh] DSH_CHILD Mutex 已中毒，按未运行处理: {}", error);
            false
        }
    }
}

// ---------------------------------------------------------------------------
// 启动 / 停止
// ---------------------------------------------------------------------------

/// 从日志行解析 Web UI 地址（锚点：`dsh web: http://...`，取首个空白前的片段）。
fn parse_web_url(line: &str) -> Option<String> {
    let idx = line.find("dsh web: http")?;
    let remainder = line[idx + "dsh web: ".len()..].trim();
    Some(remainder.split_whitespace().next()?.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_url_parse_from_startup_log() {
        assert_eq!(
            parse_web_url("dsh web: http://127.0.0.1:3080"),
            Some("http://127.0.0.1:3080".to_string())
        );
        assert_eq!(
            parse_web_url("2026-09-04 info dsh web: http://127.0.0.1:3081  ready"),
            Some("http://127.0.0.1:3081".to_string())
        );
        assert_eq!(parse_web_url("listening on port 3000"), None);
    }
}

/// 健康探测：`GET /` 返回 200 即就绪（spike 实测；/health 等路径均为 404）。
fn probe_health(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{}/", port);
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .no_proxy()
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };
    client
        .get(&url)
        .send()
        .map(|resp| resp.status().as_u16() == 200)
        .unwrap_or(false)
}

/// 启动 dsh 旁路进程。命令立即返回（spawn 成功即 Ok），就绪/退出通过事件回调上报；
/// 等待就绪期间周期性调用 on_progress（前端进度条可见）。
pub fn start_dsh(
    options: &DshStartOptions,
    on_log: impl Fn(String) + Send + Sync + 'static,
    on_progress: impl Fn(String) + Send + Sync + 'static,
    on_event: impl Fn(DshRuntimeEvent) + Send + Sync + 'static,
) -> Result<(), String> {
    if is_dsh_running() {
        return Err("dsh 已在运行，请先关闭后再开启。".to_string());
    }

    // 先清扫上次会话可能遗留的孤儿 dsh（应用强杀/崩溃场景），避免端口与新进程冲突。
    stop_stale_dsh_processes();

    let node_dir = options
        .node_path
        .parent()
        .map(Path::to_string_lossy)
        .map(|dir| dir.to_string())
        .unwrap_or_default();
    if !options.node_path.exists() {
        return Err(format!("未找到 Node.js：{}", options.node_path.display()));
    }
    if !options.bin_path.exists() {
        return Err("尚未安装 dsh 包，请先在 Agent 页完成安装。".to_string());
    }

    std::fs::create_dir_all(&options.dsh_home)
        .map_err(|e| format!("无法创建 DSH_HOME（{}）：{}", options.dsh_home.display(), e))?;
    let workspace = options
        .workspace_dir
        .as_deref()
        .map(PathBuf::from)
        .filter(|dir| dir.is_dir())
        .or_else(|| dirs::home_dir())
        .ok_or_else(|| "无法确定 dsh 工作区目录。".to_string())?;

    // 端口被占用时提前失败，给出明确中文提示。
    if std::net::TcpListener::bind(("127.0.0.1", options.dsh_port)).is_err() {
        return Err(format!(
            "端口 {} 已被占用：可能是已在运行的 dsh，或其他程序。请更换端口后重试。",
            options.dsh_port
        ));
    }

    let mut command = SpawnProcess::new(options.node_path.as_os_str());
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    command
        .arg(&options.bin_path)
        .args(["web", "--no-open", "--port", &options.dsh_port.to_string()])
        .current_dir(&workspace)
        .env("DSH_HOME", &options.dsh_home)
        .env("NO_COLOR", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if !node_dir.is_empty() {
        let path = std::env::var("PATH").unwrap_or_default();
        command.env("PATH", format!("{};{}", node_dir, path));
    }
    if let Some(proxy) = options.proxy_url.as_deref().filter(|url| !url.trim().is_empty()) {
        command
            .env("HTTP_PROXY", proxy)
            .env("HTTPS_PROXY", proxy)
            .env("http_proxy", proxy)
            .env("https_proxy", proxy)
            .env("NO_PROXY", "127.0.0.1,localhost")
            .env("no_proxy", "127.0.0.1,localhost");
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("无法启动 dsh 进程：{}", e))?;
    eprintln!("[dsh] spawned pid={:?} cwd={}", child.id(), workspace.display());
    add_dsh_log(&format!("[dsh] 启动：{} web --no-open --port {}（工作区 {}）",
        options.bin_path.display(), options.dsh_port, workspace.display()));

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    if let Ok(mut guard) = DSH_CHILD.lock() {
        *guard = Some(child);
    }
    if let Ok(mut url) = DSH_WEB_URL.lock() {
        *url = None;
    }
    let generation = DSH_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;

    // 附加 Job Object：父进程崩溃/退出时 OS 回收整棵进程树。
    #[cfg(windows)]
    {
        if let Some(guard) = DSH_CHILD.lock().ok().as_mut().and_then(|g| g.as_mut()) {
            job_guard::attach(guard.as_raw_handle());
        }
    }

    let (tx, rx) = channel::<String>();
    if let Some(out) = stdout {
        let tx_out = tx.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if tx_out.send(line).is_err() {
                    break;
                }
            }
        });
    }
    if let Some(err) = stderr {
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
    }

    // 监视线程：日志转发 + 健康轮询 + 退出检测。
    let port = options.dsh_port;
    std::thread::spawn(move || {
        let started = Instant::now();
        let mut ready_fired = false;
        let mut parsed_url: Option<String> = None;
        let mut health_tick = 0u32;
        let mut pipes_closed = false;

        loop {
            if pipes_closed {
                std::thread::sleep(Duration::from_millis(200));
            } else {
                match rx.recv_timeout(Duration::from_millis(200)) {
                    Ok(line) => {
                        if parsed_url.is_none() {
                            if let Some(url) = parse_web_url(&line) {
                                parsed_url = Some(url.clone());
                                if let Ok(mut guard) = DSH_WEB_URL.lock() {
                                    *guard = Some(url);
                                }
                            }
                        }
                        add_dsh_log(&line);
                        on_log(line);
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => {
                        pipes_closed = true;
                    }
                }
            }

            // 代数已变：本轮启动已被 stop/重启取代，本线程只清尾不再上报。
            if DSH_GENERATION.load(Ordering::SeqCst) != generation {
                return;
            }

            if !ready_fired {
                health_tick += 1;
                // 每 5 个 tick（约 1 秒）探测一次健康；每 5 秒上报一次等待进度。
                if health_tick % 5 == 0 && probe_health(port) {
                    ready_fired = true;
                    let url = parsed_url
                        .clone()
                        .unwrap_or_else(|| format!("http://127.0.0.1:{}", port));
                    add_dsh_log(&format!("[dsh] 健康检查通过：{}", url));
                    on_event(DshRuntimeEvent::Ready(url));
                } else {
                    if health_tick % 25 == 0 {
                        on_progress(format!(
                            "正在等待 dsh Web 服务就绪（已等待 {} 秒）...",
                            started.elapsed().as_secs()
                        ));
                    }
                    if started.elapsed() > READY_TIMEOUT {
                        on_event(DshRuntimeEvent::Error(format!(
                            "dsh 在 {} 秒内未通过健康检查（GET /）。请到日志区查看具体报错。",
                            READY_TIMEOUT.as_secs()
                        )));
                        // 超时后继续抽干日志并等待退出，不再重复报错。
                        ready_fired = true;
                    }
                }
            }

            if pipes_closed && DSH_GENERATION.load(Ordering::SeqCst) == generation {
                let exit_info = DSH_CHILD
                    .lock()
                    .ok()
                    .and_then(|mut guard| guard.as_mut().and_then(|child| child.try_wait().ok().flatten()))
                    .map(|status| match status.code() {
                        Some(code) => format!("退出码 {}", code),
                        None => "进程已被终止".to_string(),
                    })
                    .unwrap_or_else(|| "进程已退出".to_string());
                if let Ok(mut guard) = DSH_CHILD.lock() {
                    *guard = None;
                }
                if let Ok(mut url) = DSH_WEB_URL.lock() {
                    *url = None;
                }
                on_event(DshRuntimeEvent::Stopped(format!("dsh 进程已退出（{}）。", exit_info)));
                return;
            }
        }
    });

    Ok(())
}

/// 停止 dsh：Job Object 整树终止 + 句柄回收。代数自增使监视线程静默退出。
pub fn stop_dsh() -> Result<(), String> {
    DSH_GENERATION.fetch_add(1, Ordering::SeqCst);
    let mut had_process = false;
    {
        let mut guard = DSH_CHILD
            .lock()
            .map_err(|_| "dsh 进程管理器 Mutex 已中毒".to_string())?;
        if let Some(child) = guard.as_mut() {
            had_process = true;
            // 先温和请求退出（无标准输入通道，直接走强杀路径）。
            let _ = child.kill();
            let _ = child.wait();
        }
        *guard = None;
    }
    #[cfg(windows)]
    job_guard::terminate();
    if had_process {
        add_dsh_log("[dsh] 已停止（用户请求）。");
    }
    if let Ok(mut url) = DSH_WEB_URL.lock() {
        *url = None;
    }
    Ok(())
}

/// 应用退出钩子（quit_app 调用）：尽力回收 dsh 进程树，失败仅记日志。
pub fn stop_dsh_on_exit() {
    if let Err(error) = stop_dsh() {
        eprintln!("[dsh] 退出清理失败: {}", error);
    }
}

/// 清扫上次会话遗留的 dsh 孤儿进程（应用被强杀/崩溃时 Job Object 可能未生效，
/// 实测发生过）。按命令行包含本应用 packages 目录的 bin.js 路径精确匹配，
/// 不会影响任何其他 node 程序。在 start_dsh 前调用。
pub fn stop_stale_dsh_processes() {
    let anchor = crate::services::dsh_installer::dsh_bin_js();
    let anchor_text = anchor.to_string_lossy().replace('/', "\\").to_ascii_lowercase();
    let mut system = sysinfo::System::new_all();
    system.refresh_processes();
    let mut stopped = 0usize;
    for process in system.processes().values() {
        if !process.name().eq_ignore_ascii_case("node.exe") {
            continue;
        }
        let cmd = process
            .cmd()
            .iter()
            .map(|part| part.replace('/', "\\"))
            .collect::<Vec<_>>()
            .join(" ")
            .to_ascii_lowercase();
        if cmd.contains(&anchor_text) {
            eprintln!(
                "[dsh] stopping stale dsh pid={:?} cmd={}",
                process.pid(),
                cmd
            );
            if process.kill() {
                stopped += 1;
            }
        }
    }
    if stopped > 0 {
        eprintln!("[dsh] stopped {} stale dsh process(es)", stopped);
        std::thread::sleep(std::time::Duration::from_millis(400));
    }
}

// ---------------------------------------------------------------------------
// 状态汇总（commands 层合并进 DshStatus）
// ---------------------------------------------------------------------------

/// 汇总运行状态（installer::dsh_status 合并使用）。
pub fn runtime_status() -> crate::models::dsh_types::DshRuntimeStatus {
    let mut guard = DSH_CHILD.lock().ok();
    let running = guard
        .as_mut()
        .and_then(|g| g.as_mut())
        .map(|child| matches!(child.try_wait(), Ok(None)))
        .unwrap_or(false);
    let pid = guard
        .as_ref()
        .and_then(|g| g.as_ref())
        .map(|child| child.id());
    crate::models::dsh_types::DshRuntimeStatus {
        running,
        web_url: if running { web_url() } else { None },
        pid,
    }
}
