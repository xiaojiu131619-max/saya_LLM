//! 向量（Embedding）/ 重排（Rerank）模型旁车进程管理。
//!
//! 与对话 / VLM 模型（process_manager）**并行**运行：本模块持有独立的子进程槽位、
//! 独立的 Windows Job Object、独立的日志缓冲与代数计数，互不干扰。对话服务启停、
//! 内核更新、跑分重启都只作用于 `process_manager` 的单进程，不会波及这里的向量服务。
//!
//! 启动参数：`llama-server -m <模型> --embeddings [--pooling <mode>] [--rerank]
//! [--embd-normalize <n>]`。`--embeddings` 会把服务限定为只提供向量用途，
//! 与对话/补全互斥（llama.cpp 明确要求只对专用嵌入模型使用）。
//!
//! 与 dsh_manager 同一套进程规范：Job Object（KILL_ON_JOB_CLOSE）整树回收、
//! 健康轮询 `/health`、stdout/stderr 双读线程汇聚到本模块日志缓冲。

use std::io::{BufRead, BufReader};
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use serde::Serialize;

use crate::models::server_config::ServerConfig;

// ---------------------------------------------------------------------------
// Job Object（进程树回收，与 process_manager / dsh_manager 同规范但独立实例）
// ---------------------------------------------------------------------------

#[cfg(windows)]
#[allow(non_snake_case, non_upper_case_globals, dead_code)]
mod job_guard {
    use std::sync::Mutex;

    type HANDLE = *mut std::ffi::c_void;

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
                eprintln!("[embedding] Job Object 创建失败");
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
                eprintln!("[embedding] SetInformationJobObject 失败");
                CloseHandle(job);
                return;
            }
            if AssignProcessToJobObject(job, process_handle) == 0 {
                eprintln!("[embedding] AssignProcessToJobObject 失败");
                CloseHandle(job);
                return;
            }
            if let Ok(mut guard) = JOB_HANDLE.lock() {
                // 上一次启动的 Job Object 可能在进程自行退出时未被回收（只有
                // stop_embedding_server 会关闭它），覆盖前先终止并关闭，避免句柄泄漏。
                if let Some(JobHandle(previous)) = guard.take() {
                    TerminateJobObject(previous, 1);
                    CloseHandle(previous);
                }
                *guard = Some(JobHandle(job));
            }
            eprintln!("[embedding] Job Object 已附加到向量服务进程");
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
// 状态
// ---------------------------------------------------------------------------

/// 向量服务运行期事件（commands 层转发为 Tauri 事件）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingProgress {
    pub progress: u32,
    pub stage: String,
    pub log: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingError {
    pub error_type: String,
    pub title: String,
    pub details: String,
    pub suggestions: Vec<String>,
}

/// 多模态向量能力（就绪后从 llama-server `/props` 读取一次）。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingMediaInfo {
    pub vision: bool,
    pub video: bool,
    pub audio: bool,
    /// 服务端每次启动随机生成的媒体标记。图片/视频向量的 `prompt_string`
    /// 必须以它开头，客户端必须从 `/props` 动态获取——写死的 `<__media__>`
    /// 永远匹配不上（内核会报 "number of media markers in text (0)"）。
    pub media_marker: Option<String>,
}

/// 向量服务状态快照。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub model_name: Option<String>,
    pub model_path: Option<String>,
    /// 当前是否以重排端点（--rerank）启动。
    pub rerank: bool,
    pub pid: Option<u32>,
    /// 是否挂了 mmproj（多模态向量：可编码图片 / 视频）。
    pub multimodal: bool,
    /// 多模态能力与媒体标记；仅在服务运行且可读取 /props 时有值。
    pub media: Option<EmbeddingMediaInfo>,
}

static EMBEDDING_CHILD: Lazy<Mutex<Option<Child>>> = Lazy::new(|| Mutex::new(None));
static EMBEDDING_LOGS: Lazy<Mutex<Vec<String>>> = Lazy::new(|| Mutex::new(Vec::new()));
static EMBEDDING_CONFIG: Lazy<Mutex<Option<ServerConfig>>> = Lazy::new(|| Mutex::new(None));
/// 就绪后探测到的多模态能力与媒体标记。
static EMBEDDING_MEDIA: Lazy<Mutex<Option<EmbeddingMediaInfo>>> = Lazy::new(|| Mutex::new(None));
/// 代数计数：每次启动/停止自增，让旧的监视线程静默退出，不发过期事件。
static EMBEDDING_GENERATION: AtomicU64 = AtomicU64::new(0);

const LOG_CAP: usize = 3000;
/// 向量模型通常远小于对话模型，就绪超时无需 10 分钟。
const READY_TIMEOUT: Duration = Duration::from_secs(180);

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

pub fn add_embedding_log(line: &str) {
    if let Ok(mut logs) = EMBEDDING_LOGS.lock() {
        if logs.len() >= LOG_CAP {
            let drop_count = logs.len() - LOG_CAP + 1;
            logs.drain(..drop_count);
        }
        logs.push(line.to_string());
    }
}

pub fn get_embedding_logs() -> Vec<String> {
    EMBEDDING_LOGS
        .lock()
        .map(|logs| logs.clone())
        .unwrap_or_default()
}

pub fn clear_embedding_logs() {
    if let Ok(mut logs) = EMBEDDING_LOGS.lock() {
        logs.clear();
    }
}

/// 向量服务子进程是否仍在运行。
pub fn is_embedding_running() -> bool {
    match EMBEDDING_CHILD.lock() {
        Ok(mut guard) => guard
            .as_mut()
            .is_some_and(|child| matches!(child.try_wait(), Ok(None))),
        Err(error) => {
            eprintln!("[embedding] EMBEDDING_CHILD Mutex 已中毒，按未运行处理: {}", error);
            false
        }
    }
}

/// 向量服务子进程 PID（用于让对话服务的孤儿清扫避开它）。
pub fn embedding_child_pid() -> Option<u32> {
    EMBEDDING_CHILD
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|child| child.id()))
}

/// 探测 `/props` 的多模态能力与媒体标记。就绪后调用一次即可（标记仅在进程内随机，
/// 重启变化，但同一进程内稳定）。
fn probe_media_info(port: u16, host: &str, api_key: Option<&str>) -> Option<EmbeddingMediaInfo> {
    let url = format!("http://{}:{}/props", host, port);
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .no_proxy()
        .build()
        .ok()?;
    let mut request = client.get(&url);
    if let Some(key) = api_key.map(str::trim).filter(|key| !key.is_empty()) {
        request = request.bearer_auth(key);
    }
    let json: serde_json::Value = request.send().ok()?.json().ok()?;
    let modalities = json.get("modalities");
    let flag = |name: &str| {
        modalities
            .and_then(|m| m.get(name))
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    };
    Some(EmbeddingMediaInfo {
        vision: flag("vision"),
        video: flag("video"),
        audio: flag("audio"),
        media_marker: json
            .get("media_marker")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .filter(|marker| !marker.is_empty()),
    })
}

pub fn embedding_status() -> EmbeddingStatus {
    let mut guard = EMBEDDING_CHILD.lock().ok();
    let running = guard
        .as_mut()
        .and_then(|g| g.as_mut())
        .map(|child| matches!(child.try_wait(), Ok(None)))
        .unwrap_or(false);
    let pid = guard
        .as_ref()
        .and_then(|g| g.as_ref())
        .map(|child| child.id());
    let config = EMBEDDING_CONFIG.lock().ok().and_then(|c| c.clone());
    let media = if running {
        EMBEDDING_MEDIA.lock().ok().and_then(|m| m.clone())
    } else {
        None
    };
    EmbeddingStatus {
        running,
        port: config.as_ref().filter(|_| running).map(|c| c.port),
        model_name: config.as_ref().and_then(|c| c.model_alias.clone()),
        model_path: config.as_ref().map(|c| c.model_path.clone()),
        rerank: config.as_ref().map(|c| c.rerank).unwrap_or(false),
        pid: running.then_some(pid).flatten(),
        multimodal: running
            && config
                .as_ref()
                .and_then(|c| c.mmproj_path.as_ref())
                .is_some_and(|path| !path.trim().is_empty()),
        media,
    }
}

// ---------------------------------------------------------------------------
// 启动 / 停止
// ---------------------------------------------------------------------------

fn bind_host(config: &ServerConfig) -> String {
    let host = config.host.trim();
    if host.is_empty() {
        "127.0.0.1".to_string()
    } else {
        host.to_string()
    }
}

fn health_check_host(config: &ServerConfig) -> String {
    match bind_host(config).as_str() {
        "0.0.0.0" | "::" | "[::]" => "127.0.0.1".to_string(),
        host => host.to_string(),
    }
}

fn port_is_listening(port: u16, host: &str) -> bool {
    use std::net::{TcpStream, ToSocketAddrs};
    let addr = format!("{}:{}", host, port);
    let Ok(addrs) = addr.to_socket_addrs() else {
        return false;
    };
    addrs
        .into_iter()
        .any(|addr| TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok())
}

/// 健康探测：`GET /health` 返回 2xx 即就绪。
fn probe_health(port: u16, host: &str) -> bool {
    let url = format!("http://{}:{}/health", host, port);
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
        .map(|resp| resp.status().is_success())
        .unwrap_or(false)
}

/// 构造向量服务的命令行参数（在 `spawn_server_process` 的通用参数基础上做减法 +
/// 追加 --embeddings/--pooling/--rerank/--embd-normalize）。
///
/// 刻意不复用 process_manager 的对话参数集：向量服务不需要 KV 量化、投机解码、
/// 工具模板等，且 `--embeddings` 与它们语义冲突。只保留与显存/上下文
/// 直接相关的通用项（设备、ngl、ctx、batch、线程、flash-attn、load-mode）。
///
/// mmproj 例外：多模态嵌入模型（如 WeMM）**必须**挂上 mmproj 才能编码图片与视频，
/// 所以这里与对话侧一样传 --mmproj/--mmproj-offload。
fn build_embedding_args(exe: &str, config: &ServerConfig) -> Vec<String> {
    let host = bind_host(config);
    let mut args: Vec<String> = vec![
        "-m".into(),
        config.model_path.clone(),
        "--port".into(),
        config.port.to_string(),
        "--host".into(),
        host,
        "-ngl".into(),
        config.ngl.to_string(),
        "-c".into(),
        config.n_ctx.to_string(),
        "-b".into(),
        config.batch_size.to_string(),
        "--embeddings".into(),
    ];

    if let Some(mmproj) = config
        .mmproj_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        args.push("--mmproj".into());
        args.push(mmproj.to_string());
        args.push("--mmproj-offload".into());
    }

    if config.ubatch_size > 0 {
        args.push("-ub".into());
        args.push(config.ubatch_size.to_string());
    }
    if config.threads > 0 {
        args.push("-t".into());
        args.push(config.threads.to_string());
    }
    if let Some(alias) = config.model_alias.as_deref().filter(|a| !a.trim().is_empty()) {
        args.push("--alias".into());
        args.push(alias.to_string());
    }
    // 向量/重排模型的批处理槽位：并行请求数（--parallel）。沿用对话侧的语义。
    if config.parallel > 0 {
        args.push("-np".into());
        args.push(config.parallel.to_string());
    }
    if let Some(pooling) = config
        .pooling
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        args.push("--pooling".into());
        args.push(pooling.to_string());
    }
    if config.rerank {
        args.push("--rerank".into());
    }
    if let Some(normalize) = config.embd_normalize {
        args.push("--embd-normalize".into());
        args.push(normalize.to_string());
    }

    // 设备选择：CPU 模式走 none，其余沿用配置（与对话侧同一设备解析结果）。
    if config.no_cuda {
        args.push("--device".into());
        args.push("none".into());
        args.push("--no-op-offload".into());
    } else if let Some(device) = config
        .device
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        args.push("--device".into());
        args.push(device.to_string());
        if let Some(main_gpu) = config.main_gpu {
            if device.to_ascii_lowercase().starts_with("cuda") {
                args.push("--main-gpu".into());
                args.push(main_gpu.to_string());
            }
        }
    }

    // mmap/mlock 代际差异：旧内核 --mmap/--no-mmap/--mlock，新内核 --load-mode。
    // 复用 process_manager 的探测口径，避免两处漂移。
    if crate::services::process_manager::kernel_supports_load_mode(exe) {
        args.push("--load-mode".into());
        args.push(
            match (config.mmap, config.mlock) {
                (true, false) => "mmap",
                (true, true) => "mmap+mlock",
                (false, true) => "mlock",
                (false, false) => "none",
            }
            .into(),
        );
    } else {
        args.push(if config.mmap { "--mmap" } else { "--no-mmap" }.into());
        if config.mlock {
            args.push("--mlock".into());
        }
    }

    if !config.kv_offload {
        args.push("--no-kv-offload".into());
    }
    if let Some(api_key) = config
        .api_key
        .as_ref()
        .map(|key| key.trim())
        .filter(|key| !key.is_empty())
    {
        args.push("--api-key".into());
        args.push(api_key.to_string());
    }

    args
}

/// 启动向量模型服务（旁车）。spawn 成功即返回，就绪/退出通过回调上报。
pub fn start_embedding_server(
    config: &ServerConfig,
    exe: String,
    on_progress: impl Fn(EmbeddingProgress) + Send + Sync + 'static,
    on_ready: impl Fn() + Send + Sync + 'static,
    on_error: impl Fn(EmbeddingError) + Send + Sync + 'static,
) -> Result<(), String> {
    if is_embedding_running() {
        return Err("向量模型服务已在运行，请先停止后再启动。".to_string());
    }
    if config.model_path.trim().is_empty() || !Path::new(&config.model_path).exists() {
        return Err(format!("向量模型文件不存在：{}", config.model_path));
    }
    if exe.trim().is_empty() || !Path::new(&exe).exists() {
        return Err("找不到 llama-server.exe，无法启动向量服务。".to_string());
    }

    // 端口占用提前失败，给出明确中文提示（不静默改端口，保持可复现）。
    if port_is_listening(config.port, &health_check_host(config)) {
        return Err(format!(
            "端口 {} 已被占用：可能是对话服务或其它程序。请在向量服务设置里换一个端口。",
            config.port
        ));
    }

    // 清扫上次会话遗留的孤儿向量服务进程（应用被强杀时 Job Object 可能未生效）。
    crate::services::process_manager::stop_stale_servers_for_exe_excluding(
        &exe,
        &crate::services::process_manager::managed_llama_pids(),
    );

    let args = build_embedding_args(&exe, config);
    let mut cmd = Command::new(&exe);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    // 多模态嵌入的视频路径需要子进程能调用 ffmpeg/ffprobe：把找到的目录前置进 PATH。
    if config
        .mmproj_path
        .as_deref()
        .is_some_and(|path| !path.trim().is_empty())
    {
        let video_runtime = crate::services::process_manager::configure_media_runtime_path_pub(
            &mut cmd,
            Path::new(&exe),
        );
        // 挂了 mmproj 才能编码图片/视频；缺 ffmpeg 时视频路径会在运行时解码失败。
        // 这里提前在日志里给出可见提示，图片向量不受影响。
        if !video_runtime.native_video_ready {
            add_embedding_log(
                "[embedding] 未检测到 ffmpeg / ffprobe：多模态嵌入的图片向量可用，视频向量会解码失败。可在「核心更新 → 视频运行时」一键安装。",
            );
        }
    }
    cmd.args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let command_line = build_redacted_command_line(&exe, &args);
    eprintln!("[embedding] spawn: {}", command_line);
    add_embedding_log(&format!("[embedding] spawn: {}", command_line));

    let mut child = cmd.spawn().map_err(|e| format!("无法启动向量服务进程：{}", e))?;
    eprintln!("[embedding] child pid = {:?}", child.id());

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    if let Ok(mut guard) = EMBEDDING_CHILD.lock() {
        *guard = Some(child);
    } else {
        return Err("向量服务进程管理器 Mutex 已中毒".to_string());
    }
    if let Ok(mut guard) = EMBEDDING_CONFIG.lock() {
        *guard = Some(config.clone());
    }
    if let Ok(mut guard) = EMBEDDING_MEDIA.lock() {
        *guard = None;
    }

    // 附加独立 Job Object：父进程崩溃/退出时 OS 回收整棵进程树。
    #[cfg(windows)]
    {
        if let Some(guard) = EMBEDDING_CHILD.lock().ok().as_mut().and_then(|g| g.as_mut()) {
            job_guard::attach(guard.as_raw_handle());
        }
    }

    let generation = EMBEDDING_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let (tx, rx) = mpsc::channel::<String>();
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

    let port = config.port;
    let health_host = health_check_host(config);
    let api_key = config.api_key.clone();
    std::thread::spawn(move || {
        let started = Instant::now();
        let mut ready_fired = false;
        let mut max_progress = 0u32;
        let mut pipes_closed = false;
        let mut last_health = Instant::now() - Duration::from_secs(1);

        let on_progress = std::sync::Arc::new(on_progress);
        let on_ready = std::sync::Arc::new(on_ready);
        let on_error = std::sync::Arc::new(on_error);

        loop {
            if pipes_closed {
                std::thread::sleep(Duration::from_millis(200));
            } else {
                match rx.recv_timeout(Duration::from_millis(200)) {
                    Ok(line) => {
                        add_embedding_log(&line);
                        let p = crate::services::process_manager::parse_progress(&line);
                        if p > max_progress {
                            max_progress = p;
                        }
                        on_progress(EmbeddingProgress {
                            progress: max_progress,
                            stage: crate::services::process_manager::stage_name(max_progress),
                            log: line,
                        });
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => {
                        pipes_closed = true;
                    }
                }
            }

            // 代数已变：本轮启动已被 stop/重启取代，本线程只清尾不再上报。
            if EMBEDDING_GENERATION.load(Ordering::SeqCst) != generation {
                return;
            }

            if !ready_fired && last_health.elapsed() >= Duration::from_millis(500) {
                last_health = Instant::now();
                if probe_health(port, &health_host) {
                    ready_fired = true;
                    add_embedding_log(&format!(
                        "[embedding] 向量服务就绪，端口 {}。",
                        port
                    ));
                    // 就绪后读取一次多模态能力与媒体标记（图片/视频向量必需）。
                    if let Some(media) = probe_media_info(port, &health_host, api_key.as_deref()) {
                        if media.vision || media.video {
                            add_embedding_log(&format!(
                                "[embedding] 多模态向量已就绪（图片 {}，视频 {}），媒体标记 {}",
                                if media.vision { "支持" } else { "不支持" },
                                if media.video { "支持" } else { "不支持" },
                                media.media_marker.as_deref().unwrap_or("未知"),
                            ));
                        }
                        if let Ok(mut guard) = EMBEDDING_MEDIA.lock() {
                            *guard = Some(media);
                        }
                    }
                    on_ready();
                } else if started.elapsed() > READY_TIMEOUT {
                    ready_fired = true;
                    on_error(EmbeddingError {
                        error_type: "timeout".into(),
                        title: "向量服务启动超时".into(),
                        details: format!(
                            "向量服务在 {} 秒内未通过 /health 健康检查。",
                            READY_TIMEOUT.as_secs()
                        ),
                        suggestions: vec![
                            "确认该 GGUF 确实是嵌入/重排模型（元数据应含 pooling_type）".into(),
                            "换用更小的上下文长度或降低 GPU 卸载层数后重试".into(),
                            "到向量服务日志区查看内核的具体报错".into(),
                        ],
                    });
                }
            }

            if pipes_closed && EMBEDDING_GENERATION.load(Ordering::SeqCst) == generation {
                let exit_info = EMBEDDING_CHILD
                    .lock()
                    .ok()
                    .and_then(|mut guard| {
                        guard.as_mut().and_then(|child| child.try_wait().ok().flatten())
                    })
                    .map(|status| match status.code() {
                        Some(code) => format!("退出码 {}", code),
                        None => "进程已被终止".to_string(),
                    })
                    .unwrap_or_else(|| "进程已退出".to_string());

                // 就绪前退出 = 启动失败，上报错误；就绪后退出 = 运行期结束。
                if !ready_fired {
                    on_error(EmbeddingError {
                        error_type: "exited".into(),
                        title: "向量服务启动失败".into(),
                        details: format!("向量服务在监听端口前退出（{}）。", exit_info),
                        suggestions: vec![
                            "确认加载的是嵌入/重排模型，而非对话模型".into(),
                            "查看向量服务日志里的内核报错原文".into(),
                        ],
                    });
                }

                if let Ok(mut guard) = EMBEDDING_CHILD.lock() {
                    *guard = None;
                }
                if let Ok(mut guard) = EMBEDDING_CONFIG.lock() {
                    *guard = None;
                }
                add_embedding_log(&format!("[embedding] 进程已退出（{}）。", exit_info));
                return;
            }
        }
    });

    Ok(())
}

/// 停止向量服务：Job Object 整树终止 + 句柄回收。代数自增使旧监视线程静默退出。
pub fn stop_embedding_server() -> Result<(), String> {
    EMBEDDING_GENERATION.fetch_add(1, Ordering::SeqCst);
    #[cfg(windows)]
    job_guard::terminate();

    let mut had_process = false;
    {
        let mut guard = EMBEDDING_CHILD
            .lock()
            .map_err(|_| "向量服务进程管理器 Mutex 已中毒".to_string())?;
        if let Some(child) = guard.as_mut() {
            had_process = true;
            let _ = child.kill();
            let _ = child.wait();
        }
        *guard = None;
    }
    if let Ok(mut guard) = EMBEDDING_CONFIG.lock() {
        *guard = None;
    }
    if let Ok(mut guard) = EMBEDDING_MEDIA.lock() {
        *guard = None;
    }
    if had_process {
        add_embedding_log("[embedding] 已停止（用户请求）。");
    }
    Ok(())
}

/// 应用退出钩子：尽力回收向量服务进程树，失败仅记日志。
pub fn stop_embedding_on_exit() {
    if let Err(error) = stop_embedding_server() {
        eprintln!("[embedding] 退出清理失败: {}", error);
    }
}

/// 拼接日志用的命令行，`--api-key` 后紧跟的实参脱敏为 ***。
fn build_redacted_command_line(exe: &str, args: &[String]) -> String {
    let mut out = exe.to_string();
    let mut redact_next = false;
    for arg in args {
        out.push(' ');
        if redact_next {
            out.push_str("***");
            redact_next = false;
            continue;
        }
        if arg == "--api-key" {
            redact_next = true;
        }
        out.push_str(arg);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedding_args_include_embeddings_flag() {
        let config = ServerConfig {
            model_path: "D:/models/bge-m3.gguf".to_string(),
            port: 8081,
            ngl: 99,
            n_ctx: 8192,
            batch_size: 2048,
            ubatch_size: 2048,
            pooling: Some("cls".to_string()),
            rerank: true,
            embd_normalize: Some(2),
            ..ServerConfig::default()
        };
        let args = build_embedding_args("llama-server.exe", &config);
        assert!(args.iter().any(|a| a == "--embeddings"));
        assert!(args.iter().any(|a| a == "--rerank"));
        assert!(args.windows(2).any(|w| w == ["--pooling", "cls"]));
        assert!(args.windows(2).any(|w| w == ["--embd-normalize", "2"]));
        // 纯文本向量模型未配 mmproj：不应出现投影参数。
        assert!(!args.iter().any(|a| a == "--mmproj"));
        // 对话专属参数不应出现在向量服务命令行里。
        assert!(!args.iter().any(|a| a == "--tools"));
        assert!(!args.iter().any(|a| a == "--kv-unified"));
    }

    #[test]
    fn embedding_args_keep_mmproj_for_multimodal() {
        // 多模态嵌入模型（WeMM 等）必须挂 mmproj 才能编码图片/视频。
        let config = ServerConfig {
            model_path: "D:/models/wemm.gguf".to_string(),
            mmproj_path: Some("D:/models/mmproj-wemm.gguf".to_string()),
            port: 8081,
            ..ServerConfig::default()
        };
        let args = build_embedding_args("llama-server.exe", &config);
        assert!(args.iter().any(|a| a == "--embeddings"));
        assert!(args.windows(2).any(|w| w == ["--mmproj", "D:/models/mmproj-wemm.gguf"]));
        assert!(args.iter().any(|a| a == "--mmproj-offload"));
        // 即便挂了 mmproj，也不该带生成类参数。
        assert!(!args.iter().any(|a| a == "--spec-type"));
        assert!(!args.iter().any(|a| a == "-md"));
    }

    #[test]
    fn embedding_args_omit_optional_flags_when_unset() {
        let config = ServerConfig {
            model_path: "D:/models/nomic.gguf".to_string(),
            port: 8081,
            ..ServerConfig::default()
        };
        let args = build_embedding_args("llama-server.exe", &config);
        assert!(!args.iter().any(|a| a == "--pooling"));
        assert!(!args.iter().any(|a| a == "--rerank"));
        assert!(!args.iter().any(|a| a == "--embd-normalize"));
    }
}
