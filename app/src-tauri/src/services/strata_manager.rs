//! 智慧模型（Strata 引擎）旁路进程管理。
//!
//! 与 fast27b_manager / dsh_manager 同一套进程管理规范，但启动形态不同：
//! strata 的推理内核 `strata.exe` 不直接对外提供 OpenAI 接口，必须由它自带的
//! Python 网关托管——网关负责拉起内核、套 chat template、解析工具调用，再对外
//! 暴露 `/v1/chat/completions`。所以这里 spawn 的是「Python 网关」，内核是它的
//! 子进程，Job Object 一并兜住两层。
//!
//! - 启动：`python -m serve.server --engine strata --config <run.json> --host --port --api-key`
//!   （实测 CLI 的 `--host` / `--port` 覆盖 config 内同名字段，因此不改写用户的
//!   run config；上下文、KV、专家驻留等参数一律由 strata 自己的 launch 决定）
//! - 进程树：Job Object（KILL_ON_JOB_CLOSE）整树回收，应用退出时联动 stop_strata
//! - 就绪：轮询 `GET /health`，必须 `loaded == true`（接口早于权重加载就绪，
//!   只看 200 会把「正在加载 90GiB 权重」误判成「可对话」）
//! - 日志：stdout/stderr 双读线程 → 环形缓冲 + `strata:log` 事件
//!
//! 安全边界：三个输入路径（Python、源码目录、run config）都来自应用配置，
//! 启动前逐一校验；参数为参数列表，无 shell 参与。
//!
//! 不清扫「孤儿 strata 进程」：`启动模型.bat` 起的实例可能正在为别的用途服务，
//! 端口冲突时报错并指明原因，由用户决定停谁。

use std::io::{BufRead, BufReader};
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::services::strata_metrics;

// 参数列表式子进程封装（std::process::Command 的本文件内别名），
// 程序路径来自应用配置并经启动前校验，无 shell、无命令字符串拼接。
use std::process::Command as SpawnProcess;

/// 日志环形缓冲上限（与 fast27b / dsh 一致）。
const LOG_CAP: usize = 5000;

/// 探活轮询间隔（每 5 个 200ms tick 约 1 秒一次）。
const TICK: Duration = Duration::from_millis(200);

/// 请求统计采样间隔。
///
/// 网关把每个请求留在自己的 `history` 里（最多 500 条），本地只是定期把新增的收进来。
/// 4 秒够快——面板本身按分钟分桶；又够慢——90GiB 权重在跑时别给网关添负担。
const METRICS_INTERVAL: Duration = Duration::from_secs(4);

/// 允许调用 `/v1/*` 的页面来源。
///
/// strata 的 CORS 头**只**在 `cors_origins` 里列出来源时才发送，而它没有对应的
/// 命令行参数——只能写进 run config。不配这一项时，前端 fetch 会被浏览器直接拦掉
/// （表现为 `TypeError: Failed to fetch`，且服务端日志里连一条请求都看不到）。
/// Tauri 的 WebView 在 Windows 上的页面来源是 `http://tauri.localhost`，
/// dev 模式下是 `http://localhost:1420`。
const CORS_ORIGINS: &[&str] = &[
    "http://tauri.localhost",
    "https://tauri.localhost",
    // 非 Windows 的 Tauri WebView 来源；留着不影响 Windows。
    "tauri://localhost",
    // 本项目的 vite dev 端口是 3000（见 vite.config.ts / tauri.conf.json devUrl）。
    // 1420 是 Tauri 模板默认值，保留兼容但不再是实际来源。
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:1420",
    "http://127.0.0.1:1420",
];

/// 智慧模型运行期事件（由 commands 层转发为 Tauri `strata:ready`/`strata:stopped`/`strata:error`）。
#[derive(Debug, Clone)]
pub enum StrataRuntimeEvent {
    /// 服务就绪且模型已加载，携带服务根地址（http://127.0.0.1:<port>）。
    Ready(String),
    /// 进程退出，携带原因说明。
    Stopped(String),
    /// 运行期错误。
    Error(String),
}

/// 启动参数（由 commands 层从 AppConfig.strata 组装）。
#[derive(Debug, Clone)]
pub struct StrataStartOptions {
    /// Python 解释器（Python312 实测依赖齐全：jinja2 / yaml / regex / psutil / requests / numpy / PIL）。
    pub python_path: PathBuf,
    /// strata 源码目录（serve 与 strata_control 包所在处），作为子进程工作目录。
    pub work_dir: PathBuf,
    /// strata launch 生成的 run config json。
    pub config_path: PathBuf,
    pub port: u16,
    /// true = 0.0.0.0（对局域网开放）。
    pub lan: bool,
    pub api_key: String,
    /// 加载超时（秒）：首次加载按 18 分钟留余量，热启动约 30 秒。
    pub ready_timeout_secs: u64,
    /// 附加给网关的参数，原样透传。
    pub extra_args: Vec<String>,
}

impl StrataStartOptions {
    fn host(&self) -> &'static str {
        if self.lan {
            "0.0.0.0"
        } else {
            "127.0.0.1"
        }
    }

    /// 网关命令行。
    ///
    /// `-m serve.server` 而不是 `strata.py serve`：后者会再套一层 CLI 编排
    /// （引擎检查、模型准备、调优），对已经配置好 run config 的场景是多余的一跳，
    /// 而且会多出一个常驻 Python 进程。直接起网关，内核仍由网关自己拉起。
    ///
    /// `config_path` 传派生配置而不是用户原始文件——派生副本只补 CORS 来源与
    /// 独立日志路径两项，引擎参数原样保留。
    fn build_args(&self, config_path: &Path) -> Vec<String> {
        let mut args = vec![
            "-m".to_string(),
            "serve.server".to_string(),
            "--engine".to_string(),
            "strata".to_string(),
            "--config".to_string(),
            config_path.to_string_lossy().to_string(),
            "--host".to_string(),
            self.host().to_string(),
            "--port".to_string(),
            self.port.to_string(),
            "--api-key".to_string(),
            self.api_key.clone(),
        ];
        args.extend(self.extra_args.iter().cloned());
        args
    }
}

/// 从 run config 的引擎参数里取出 `--pack` 路径。
///
/// strata.exe 的命令行是 `strata.exe --serve --pack <目录> --native <文件> …`，
/// 里面既不含可执行文件路径也不含端口，所以停止时唯一可靠的锚点就是这个 pack 目录。
fn engine_pack_path(config_path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(config_path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let args = value.get("args")?.as_array()?;
    let mut iterator = args.iter();
    while let Some(item) = iterator.next() {
        if item.as_str() == Some("--pack") {
            return iterator.next().and_then(|value| value.as_str()).map(str::to_string);
        }
    }
    None
}

/// 回收本次启动的 strata.exe 内核。
///
/// Job Object 是首选手段，但它在应用自身已被外层 Job 托管时附加不上（从某些宿主启动
/// 就会这样），而 Python 网关被强杀后不会执行自己的收尾，内核就会带着几十 GB 内存
/// 留下来。这里按 `--pack` 路径精确匹配，只杀本次启动的那一个，不动
/// 「启动模型.bat」起的实例。
fn stop_orphan_engine(pack_path: Option<&str>) {
    let Some(anchor) = pack_path else {
        add_strata_log("[strata] 没解析到 --pack，跳过残留内核清理（内核可能仍在占用显存）");
        return;
    };
    let anchor_text = anchor.replace('/', "\\").to_ascii_lowercase();
    let mut system = sysinfo::System::new_all();
    system.refresh_processes();
    let mut stopped = 0usize;
    let mut looked = 0usize;
    for process in system.processes().values() {
        if !process.name().eq_ignore_ascii_case("strata.exe") {
            continue;
        }
        looked += 1;
        // 按参数逐项精确比较，不做子串匹配：`--serve` 必须独立成项，
        // `--pack` 的值必须与本次启动完全一致。子串匹配会误伤
        // `gyro-gyro-m` / `gyro-gyro-m-abl` 这类同前缀 pack，也会把
        // 「启动模型.bat」起的实例当成自己的残留。
        let cmd = process.cmd();
        let has_serve = cmd.iter().any(|part| part.eq_ignore_ascii_case("--serve"));
        let uses_pack = cmd.iter().enumerate().any(|(index, part)| {
            let normalized = part.replace('/', "\\").to_ascii_lowercase();
            if normalized == "--pack" {
                cmd.get(index + 1)
                    .map(|value| value.replace('/', "\\").to_ascii_lowercase() == anchor_text)
                    .unwrap_or(false)
            } else {
                normalized
                    .strip_prefix("--pack=")
                    .map(|value| value == anchor_text)
                    .unwrap_or(false)
            }
        });
        if !has_serve || !uses_pack {
            continue;
        }
        eprintln!("[strata] 回收残留内核 pid={:?}", process.pid());
        if process.kill() {
            stopped += 1;
        }
    }
    if stopped > 0 {
        add_strata_log(&format!("[strata] 已回收 {} 个残留内核进程", stopped));
        std::thread::sleep(Duration::from_millis(500));
    } else if looked > 0 {
        add_strata_log(&format!(
            "[strata] 扫描到 {} 个 strata.exe，但没有命令行匹配本次启动的 pack（{}），未处理",
            looked, anchor
        ));
    }
}

/// 生成一份派生 run config：在用户原始配置基础上补两项，原文不动。
///
/// 1. `cors_origins` 合并进 Tauri 页面来源——否则前端 fetch 被浏览器拦掉，
///    服务端连请求都收不到。
/// 2. `log` 指向本应用数据目录下的独立文件——原配置的引擎日志是
///    `%LOCALAPPDATA%\Strata\launch\*.engine.log`，和「启动模型.bat」起的实例共用
///    同一个文件会互相覆盖，排障时看不出是谁写的。
///
/// 引擎参数（上下文、KV、专家驻留、mmap）一律原样带过去，不做任何改写。
fn prepare_derived_config(options: &StrataStartOptions) -> Result<PathBuf, String> {
    let raw = std::fs::read_to_string(&options.config_path).map_err(|error| {
        format!(
            "无法读取启动配置（{}）：{}",
            options.config_path.display(),
            error
        )
    })?;
    let mut value: serde_json::Value = serde_json::from_str(&raw).map_err(|error| {
        format!(
            "启动配置不是合法 JSON（{}）：{}",
            options.config_path.display(),
            error
        )
    })?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| "启动配置的顶层必须是 JSON 对象。".to_string())?;

    let mut origins: Vec<String> = object
        .get("cors_origins")
        .and_then(|item| item.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    for origin in CORS_ORIGINS {
        if !origins.iter().any(|existing| existing == origin) {
            origins.push((*origin).to_string());
        }
    }
    object.insert("cors_origins".to_string(), serde_json::json!(origins));

    // 派生启动配置与引擎日志都落在「日志目录」的 strata 子目录里，
    // 用户改日志目录后新起的引擎立刻跟着走。
    let domain_dir = crate::services::storage_paths::log_dir().join("strata");
    std::fs::create_dir_all(&domain_dir)
        .map_err(|error| format!("无法创建 {}：{}", domain_dir.display(), error))?;

    let engine_log = domain_dir.join(format!("engine-{}.log", options.port));
    object.insert(
        "log".to_string(),
        serde_json::json!(engine_log.to_string_lossy()),
    );

    let target = domain_dir.join(format!("run-{}.json", options.port));
    let serialized = serde_json::to_string_pretty(&value)
        .map_err(|error| format!("派生启动配置序列化失败：{}", error))?;
    std::fs::write(&target, serialized)
        .map_err(|error| format!("无法写入派生启动配置（{}）：{}", target.display(), error))?;
    Ok(target)
}

/// 运行期生效的网络参数（停止/状态查询用）。
#[derive(Debug, Clone)]
struct ActiveConfig {
    port: u16,
    host: &'static str,
    /// 引擎的 `--pack` 路径，停止时用它精确定位要回收的 strata.exe。
    /// 没读到（配置结构不同）时为 None，此时只能靠 Job Object 或 strata 自己的清理。
    pack_path: Option<String>,
}

/// `/health` 的解析结果。
///
/// strata 的 `/health` 免鉴权，返回
/// `{"status":"ok","max_context":N,"model":"…","loaded":bool,"service":"strata"}`。
/// `loaded` 是唯一可信的「权重已加载」信号：网关会先 bind 端口再加载权重，
/// 这段时间 `/health` 已经 200，但 `loaded` 还是 false。
#[derive(Debug, Clone, Default)]
pub struct StrataHealth {
    pub loaded: bool,
    pub model: Option<String>,
    pub max_context: Option<u64>,
}

/// 探测 `/health`。连不上返回 None（进程没起或还没 bind）。
pub fn probe_health(port: u16) -> Option<StrataHealth> {
    let url = format!("http://127.0.0.1:{}/health", port);
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .no_proxy()
        .build()
        .ok()?;
    let response = client.get(&url).send().ok()?;
    if response.status().as_u16() != 200 {
        return None;
    }
    let value: serde_json::Value = response.json().ok()?;
    Some(StrataHealth {
        loaded: value.get("loaded").and_then(|v| v.as_bool()).unwrap_or(false),
        model: value
            .get("model")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        max_context: value.get("max_context").and_then(|v| v.as_u64()),
    })
}

/// 读取网关 `/v1/models` 报出的模型 ID。
///
/// 智慧模型的模型名由 run config 决定（S：`qwen3.8-flash-next-gyro-gyro-s`，
/// M：`qwen3.8-flash-next-gyro-gyro-m`），应用配置里没有这一项——接入 dsh 时
/// 必须按网关实际回报的 ID 写，写错会得到一个 404，而错误出在 dsh 侧，最难查。
pub fn probe_model_ids(port: u16, api_key: &str) -> Vec<String> {
    let url = format!("http://127.0.0.1:{}/v1/models", port);
    let Ok(client) = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(3))
        .no_proxy()
        .build()
    else {
        return Vec::new();
    };
    let Ok(response) = client.get(&url).bearer_auth(api_key).send() else {
        return Vec::new();
    };
    if response.status().as_u16() != 200 {
        return Vec::new();
    }
    let Ok(value) = response.json::<serde_json::Value>() else {
        return Vec::new();
    };
    value
        .get("data")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("id").and_then(|id| id.as_str()).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Job Object（整树回收）
// ---------------------------------------------------------------------------

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
        // 必须是 PriorityClass / SchedulingClass（各 u32），
        // 多 4 字节会让 SetInformationJobObject 报 ERROR_BAD_LENGTH。
        PriorityClass: u32,
        SchedulingClass: u32,
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

    #[cfg(target_pointer_width = "64")]
    const _: () = assert!(std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() == 144);

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

    pub fn attach(process_handle: HANDLE) -> bool {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                eprintln!("[strata] Job Object 创建失败");
                return false;
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
                eprintln!("[strata] SetInformationJobObject 失败");
                CloseHandle(job);
                return false;
            }
            if AssignProcessToJobObject(job, process_handle) == 0 {
                // 常见原因：应用自身已被外层 Job 托管（从某些宿主启动时会这样），
                // 子进程继承了那个 Job，再指派到新 Job 会被拒绝。
                // 这种情况 Job 兜不住内核，stop 时靠按命令行精确清理补上。
                eprintln!("[strata] AssignProcessToJobObject 失败");
                CloseHandle(job);
                return false;
            }
            if let Ok(mut guard) = JOB_HANDLE.lock() {
                *guard = Some(JobHandle(job));
            }
            eprintln!("[strata] Job Object 已附加到 strata 网关进程");
            true
        }
    }

    /// 终止整棵树（网关 + 它拉起的 strata.exe 内核）。
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
// 全局状态
// ---------------------------------------------------------------------------

static STRATA_CHILD: Mutex<Option<Child>> = Mutex::new(None);
static STRATA_ACTIVE: Mutex<Option<ActiveConfig>> = Mutex::new(None);
static STRATA_LOGS: Mutex<Vec<String>> = Mutex::new(Vec::new());
/// 代数计数：每次启停自增，旧监视线程发现代数变化后不再上报事件。
static STRATA_GENERATION: AtomicU32 = AtomicU32::new(0);
/// 启停串行化（状态查询不走这把锁，避免探活阻塞启停）。
static STRATA_OPERATION: Mutex<()> = Mutex::new(());

struct EngineLogReaders {
    threads: Vec<JoinHandle<()>>,
}

static STRATA_LOG_READERS: Mutex<Option<EngineLogReaders>> = Mutex::new(None);

// ---------------------------------------------------------------------------
// 日志缓冲
// ---------------------------------------------------------------------------

/// 日志文件（与环形缓冲同步落盘，应用外可排查；目录由「数据管理 → 日志目录」决定，
/// 未配置时落在应用数据目录的 strata 子目录）。
fn log_file_path() -> Option<PathBuf> {
    Some(
        crate::services::storage_paths::log_dir()
            .join("strata")
            .join("engine.log"),
    )
}

/// 追加一行到智慧模型日志环形缓冲，并同步落盘（失败静默，不影响内存缓冲）。
pub fn add_strata_log(line: &str) {
    if let Ok(mut logs) = STRATA_LOGS.lock() {
        if logs.len() >= LOG_CAP {
            let drop_count = logs.len() - LOG_CAP + 1;
            logs.drain(..drop_count);
        }
        logs.push(line.to_string());
    }
    if let Some(path) = log_file_path() {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            use std::io::Write;
            let _ = writeln!(file, "{}", line);
        }
    }
}

pub fn get_strata_logs() -> Vec<String> {
    STRATA_LOGS
        .lock()
        .map(|logs| logs.clone())
        .unwrap_or_default()
}

pub fn clear_strata_logs() {
    if let Ok(mut logs) = STRATA_LOGS.lock() {
        logs.clear();
    }
}

pub fn is_strata_running() -> bool {
    STRATA_CHILD
        .lock()
        .ok()
        .and_then(|mut guard| {
            guard
                .as_mut()
                .map(|child| matches!(child.try_wait(), Ok(None)))
        })
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// 启动前校验
// ---------------------------------------------------------------------------

pub(crate) fn validate_options(options: &StrataStartOptions) -> Result<(), String> {
    if !options.python_path.is_file() {
        return Err(format!(
            "Python 解释器不存在：{}。请在设置里指定可用的 Python，或用「启动模型.bat」确认 strata 能在命令行跑起来。",
            options.python_path.display()
        ));
    }
    let serve_entry = options.work_dir.join("serve").join("server.py");
    if !serve_entry.is_file() {
        return Err(format!(
            "在 {} 下没找到 serve/server.py。请把「源码目录」指向 strata 仓库根（含 serve 与 strata_control 的那一层）。",
            options.work_dir.display()
        ));
    }
    if !options.config_path.is_file() {
        return Err(format!(
            "启动配置不存在：{}。先用「启动模型.bat」跑通一次，strata 会把 run config 写到 %LOCALAPPDATA%\\Strata\\launch\\ 下。",
            options.config_path.display()
        ));
    }
    if options.api_key.trim().is_empty() {
        return Err("API Key 不能为空（本地服务也用它做 Bearer 鉴权）。".to_string());
    }
    if options.port == 0 {
        return Err("端口不能为 0。".to_string());
    }
    if options.ready_timeout_secs == 0 {
        return Err("加载超时不能为 0。".to_string());
    }
    // 附加参数追加在应用参数之后，argparse 后出现的同名 flag 会覆盖前面的值。
    // 允许它们改写网络/鉴权目标，应用就会去错误端口探活或用错误 Key 请求。
    const RESERVED: &[&str] = &["--engine", "--config", "--host", "--port", "--api-key"];
    for arg in &options.extra_args {
        let name = arg.split('=').next().unwrap_or(arg).trim();
        if RESERVED.iter().any(|reserved| name.eq_ignore_ascii_case(reserved)) {
            return Err(format!(
                "附加参数不能覆盖 {name}：端口、监听地址、鉴权与启动配置由页面上方的字段统一管理。"
            ));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 请求性能采集
// ---------------------------------------------------------------------------

/// 拉一次网关 `GET /metrics`（含它保留的全部请求历史）。
///
/// `?requests=all` 是网关的开关：不带它只回最近 12 条，带它回全部（最多 500 条）。
fn fetch_metrics(port: u16, api_key: &str) -> Option<serde_json::Value> {
    let url = format!("http://127.0.0.1:{}/metrics?requests=all", port);
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .no_proxy()
        .build()
        .ok()?;
    let response = client.get(&url).bearer_auth(api_key).send().ok()?;
    if response.status().as_u16() != 200 {
        return None;
    }
    response.json().ok()
}

/// 指标采集成独立线程，不挂在监视线程上：监视线程只管就绪与退出，
/// 采集慢一次（网关在长请求里偶尔 >1 秒）不该拖住就绪判定。
///
/// 代数校验与监视线程同源：stop/restart 递增代数，本线程在下一拍自行退出。
fn spawn_metrics_collector(port: u16, api_key: String, generation: u32) {
    std::thread::spawn(move || loop {
        std::thread::sleep(METRICS_INTERVAL);
        if STRATA_GENERATION.load(Ordering::SeqCst) != generation || !is_strata_running() {
            return;
        }
        if let Some(value) = fetch_metrics(port, &api_key) {
            strata_metrics::ingest_metrics(&value);
        }
    });
}

// ---------------------------------------------------------------------------
// 启动 / 停止
// ---------------------------------------------------------------------------

pub fn start_strata(
    options: &StrataStartOptions,
    on_log: impl Fn(String) + Send + Sync + 'static,
    on_progress: impl Fn(String) + Send + Sync + 'static,
    on_event: impl Fn(StrataRuntimeEvent) + Send + Sync + 'static,
) -> Result<(), String> {
    let _operation = STRATA_OPERATION
        .lock()
        .map_err(|_| "strata 启停管理器 Mutex 已中毒".to_string())?;
    start_strata_locked(options, on_log, on_progress, on_event)
}

fn start_strata_locked(
    options: &StrataStartOptions,
    on_log: impl Fn(String) + Send + Sync + 'static,
    on_progress: impl Fn(String) + Send + Sync + 'static,
    on_event: impl Fn(StrataRuntimeEvent) + Send + Sync + 'static,
) -> Result<(), String> {
    if is_strata_running() {
        return Err("Strata 已在运行，请先停止后再启动。".to_string());
    }
    validate_options(options)?;
    drain_log_readers();

    // 端口被占用时提前失败。strata 自己的网关也会在 bind 失败时报错退出，
    // 但那条错误要等 Python 起来才看得到，不如这里直接说清楚是谁占了。
    if std::net::TcpListener::bind(("127.0.0.1", options.port)).is_err() {
        return Err(format!(
            "端口 {} 已被占用：可能是「启动模型.bat」或另一次启动留下的实例（strata 默认监听 8080，本应用特意错开到 {}）。请先停掉那个实例，或在设置里换一个端口。",
            options.port, options.port
        ));
    }

    // 派生配置：补 CORS 来源与独立引擎日志，用户原始 run config 不动。
    let derived_config = prepare_derived_config(options)?;
    let args = options.build_args(&derived_config);
    let mut command = SpawnProcess::new(options.python_path.as_os_str());
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    command
        .args(&args)
        // cwd 必须是 strata 仓库根：`-m serve.server` 的包发现、
        // `component:strata-engine` 的组件解析、run config 里的相对路径都依赖它。
        .current_dir(&options.work_dir)
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command.spawn().map_err(|e| {
        format!(
            "无法启动 Strata 网关（{}）：{}",
            options.python_path.display(),
            e
        )
    })?;
    add_strata_log(&format!(
        "[strata] 启动：{} -m serve.server --config {} --host {} --port {}（派生配置，原始：{}）",
        options.python_path.display(),
        derived_config.display(),
        options.host(),
        options.port,
        options.config_path.display()
    ));
    eprintln!("[strata] spawned pid={:?}", child.id());

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    if let Ok(mut guard) = STRATA_CHILD.lock() {
        *guard = Some(child);
    }
    let pack_anchor = engine_pack_path(&derived_config);
    add_strata_log(&format!(
        "[strata] 内核回收锚点：{}",
        pack_anchor.as_deref().unwrap_or("（没解析到 --pack）")
    ));
    if let Ok(mut guard) = STRATA_ACTIVE.lock() {
        *guard = Some(ActiveConfig {
            port: options.port,
            host: options.host(),
            pack_path: pack_anchor,
        });
    }

    // 附加 Job Object：父进程崩溃/退出时 OS 回收整棵树（Python 网关 + strata.exe 内核）。
    // 附加失败不是致命错误——stop_strata 还有按命令行精确清理这一道。
    #[cfg(windows)]
    {
        let attached = {
            if let Some(child) = STRATA_CHILD.lock().ok().and_then(|mut g| g.take()) {
                let result = job_guard::attach(child.as_raw_handle());
                if let Ok(mut guard) = STRATA_CHILD.lock() {
                    *guard = Some(child);
                }
                result
            } else {
                false
            }
        };
        if !attached {
            add_strata_log(
                "[strata] 未能附加 Job Object（应用可能已被外层 Job 托管）；停止时将按命令行回收内核。",
            );
        }
    }

    let generation = STRATA_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;

    // 请求统计：与监视线程分开，采一次慢不动就绪判定。
    spawn_metrics_collector(options.port, options.api_key.clone(), generation);

    let (tx, rx) = channel::<String>();
    let mut readers = Vec::new();
    if let Some(out) = stdout {
        let tx_out = tx.clone();
        readers.push(std::thread::spawn(move || {
            read_log_pipe(BufReader::new(out), tx_out);
        }));
    }
    if let Some(err) = stderr {
        let tx_err = tx.clone();
        readers.push(std::thread::spawn(move || {
            read_log_pipe(BufReader::new(err), tx_err);
        }));
    }
    drop(tx);
    if let Ok(mut guard) = STRATA_LOG_READERS.lock() {
        *guard = Some(EngineLogReaders { threads: readers });
    }

    // 监视线程：日志转发 + 就绪轮询 + 退出检测。
    let probe_port = options.port;
    let ready_timeout = Duration::from_secs(options.ready_timeout_secs);
    std::thread::spawn(move || {
        let started = Instant::now();
        let mut ready_fired = false;
        let mut pipes_closed = false;
        let mut health_tick = 0u32;

        loop {
            if pipes_closed {
                std::thread::sleep(TICK);
            } else {
                match rx.recv_timeout(TICK) {
                    Ok(line) => {
                        add_strata_log(&line);
                        on_log(line);
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => {
                        pipes_closed = true;
                    }
                }
            }

            // 代数已变：本轮启动已被 stop/重启取代，本线程只清尾不再上报。
            if STRATA_GENERATION.load(Ordering::SeqCst) != generation {
                return;
            }

            if !ready_fired {
                health_tick += 1;
                // 每 5 个 tick（约 1 秒）探测一次。必须同时满足 loaded == true：
                // 网关先 bind 再加载权重，只看 200 会把「正在加载」当成「可对话」。
                if health_tick % 5 == 0 {
                    if let Some(health) = probe_health(probe_port) {
                        if health.loaded {
                            ready_fired = true;
                            let url = format!("http://127.0.0.1:{}", probe_port);
                            let model = health.model.unwrap_or_else(|| "未知模型".to_string());
                            add_strata_log(&format!(
                                "[strata] 就绪：{}（模型 {}，上下文 {}）",
                                url,
                                model,
                                health
                                    .max_context
                                    .map(|v| v.to_string())
                                    .unwrap_or_else(|| "未知".to_string())
                            ));
                            on_event(StrataRuntimeEvent::Ready(url));
                            on_progress(format!("Strata 已就绪：{}", model));
                        }
                    }
                }
                if !ready_fired {
                    // 每 15 秒报一次进度：首次加载 100K 上下文 + 90GiB 专家权重
                    // 实测约 18 分钟，没有进度提示用户会以为卡死。
                    if health_tick % 75 == 0 {
                        let seconds = started.elapsed().as_secs();
                        on_progress(format!(
                            "正在加载 Strata（已等待 {} 分 {} 秒，首次加载可能需要十几分钟）...",
                            seconds / 60,
                            seconds % 60
                        ));
                    }
                    if started.elapsed() > ready_timeout {
                        on_event(StrataRuntimeEvent::Error(format!(
                            "Strata 在 {} 分钟内未完成加载（/health 的 loaded 仍为 false）。请到日志区查看具体报错。",
                            ready_timeout.as_secs() / 60
                        )));
                        // 超时后继续抽干日志并等待退出，不再重复报错。
                        ready_fired = true;
                    }
                }
            }

            if pipes_closed && STRATA_GENERATION.load(Ordering::SeqCst) == generation {
                // 停止期间不能等待操作锁，否则 stop 在 join 读线程时会与本监视线程互等。
                let Ok(_operation) = STRATA_OPERATION.try_lock() else {
                    continue;
                };
                if STRATA_GENERATION.load(Ordering::SeqCst) != generation {
                    return;
                }
                drain_log_readers();
                let exit_info = STRATA_CHILD
                    .lock()
                    .ok()
                    .and_then(|mut guard| {
                        guard
                            .as_mut()
                            .and_then(|child| child.try_wait().ok().flatten())
                    })
                    .map(|status| match status.code() {
                        Some(code) => format!("退出码 {}", code),
                        None => "进程已被终止".to_string(),
                    })
                    .unwrap_or_else(|| "进程已退出".to_string());
                if let Ok(mut guard) = STRATA_CHILD.lock() {
                    *guard = None;
                }
                if let Ok(mut guard) = STRATA_ACTIVE.lock() {
                    *guard = None;
                }
                on_event(StrataRuntimeEvent::Stopped(format!(
                    "Strata 进程已退出（{}）。",
                    exit_info
                )));
                return;
            }
        }
    });

    Ok(())
}

fn read_log_pipe<R: BufRead>(reader: R, tx: Sender<String>) {
    for line in reader.lines() {
        match line {
            Ok(line) => {
                if tx.send(line).is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
}

fn drain_log_readers() {
    let readers = STRATA_LOG_READERS
        .lock()
        .ok()
        .and_then(|mut guard| guard.take());
    if let Some(readers) = readers {
        for thread in readers.threads {
            let _ = thread.join();
        }
    }
}

/// 停止智慧模型：整树终止（网关 + 内核），排空日志后清运行态。
pub fn stop_strata() -> Result<(), String> {
    let _operation = STRATA_OPERATION
        .lock()
        .map_err(|_| "strata 启停管理器 Mutex 已中毒".to_string())?;
    stop_strata_locked()
}

fn stop_strata_locked() -> Result<(), String> {
    // 先失效当前代数的运行事件，防止监视线程把「我们主动停的」报成「意外退出」。
    let stop_generation = STRATA_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;

    // 清理锚点必须在清空运行态之前取出来。
    let pack_path = STRATA_ACTIVE
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().and_then(|config| config.pack_path.clone()));

    // 优先走 Job Object 整树终止：strata.exe 内核是网关的子进程，
    // 只杀 Python 会留下正在占显存的内核。
    job_guard::terminate();

    let mut had_process = false;
    if let Ok(mut guard) = STRATA_CHILD.lock() {
        if let Some(mut child) = guard.take() {
            had_process = true;
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    if let Ok(mut guard) = STRATA_ACTIVE.lock() {
        *guard = None;
    }
    // 引擎已经不在跑，采集线程也停了；把最后一次快照里的「在途请求」清零。
    crate::services::strata_metrics::clear_active_requests();
    drain_log_readers();

    // 第二道：Job Object 附加不上时（应用已被外层 Job 托管），内核可能活下来。
    // strata 自己的 job 会在网关进程消失后回收内核，但那需要几秒——这里等一会再看，
    // 仍在就强杀。放到后台线程，避免 stop 命令把界面卡住。
    if pack_path.is_some() {
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(6));
            // 这 6 秒里用户可能已经重新启动（restart / 停止后立刻再启动），
            // 新一代替换了代数：此时不能再按旧 pack 扫描，否则会把刚起来的
            // 新内核当成残留杀掉。
            if STRATA_GENERATION.load(Ordering::SeqCst) != stop_generation
                || is_strata_running()
            {
                return;
            }
            stop_orphan_engine(pack_path.as_deref());
        });
    }

    if had_process {
        add_strata_log("[strata] 已停止（整树终止）");
    }
    Ok(())
}

/// 应用退出时调用：失败不影响退出流程。
pub fn stop_strata_on_exit() {
    let _ = stop_strata();
}

pub fn restart_strata(
    options: &StrataStartOptions,
    on_log: impl Fn(String) + Send + Sync + 'static,
    on_progress: impl Fn(String) + Send + Sync + 'static,
    on_event: impl Fn(StrataRuntimeEvent) + Send + Sync + 'static,
) -> Result<(), String> {
    stop_strata()?;
    // 内核退出后释放显存需要一点时间，立即重启用同一个 90GiB 权重会撞上残留占用。
    std::thread::sleep(Duration::from_millis(800));
    start_strata(options, on_log, on_progress, on_event)
}

// ---------------------------------------------------------------------------
// 状态汇总（commands 层合并进 StrataStatus）
// ---------------------------------------------------------------------------

/// 运行状态快照（commands 层序列化给前端）。
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct StrataRuntimeStatus {
    /// 子进程存活。
    pub running: bool,
    /// 「可对话」：进程存活 + `/health` 的 loaded 为 true。
    pub api_ready: bool,
    /// `/health` 可访问（接口在线；权重可能仍在加载）。
    pub api_reachable: bool,
    /// 权重是否已加载（`/health` 的 loaded）。
    pub model_loaded: bool,
    /// 网关回报的模型名。
    pub model_name: Option<String>,
    /// 网关回报的上下文上限。
    pub max_context: Option<u64>,
    pub port: Option<u16>,
    pub lan: Option<bool>,
    pub pid: Option<u32>,
}

/// 汇总运行状态。
pub fn runtime_status() -> StrataRuntimeStatus {
    // 只在持锁期间做轻量 try_wait；探活是阻塞 HTTP（最长 2 秒），放到锁外做，
    // 避免状态轮询拖住 stop/start 等同样需要该锁的调用。
    let child_view = STRATA_CHILD.lock().ok().map(|mut guard| {
        let running = guard
            .as_mut()
            .map(|child| matches!(child.try_wait(), Ok(None)))
            .unwrap_or(false);
        let pid = guard.as_ref().map(|child| child.id());
        (running, pid)
    });
    let (running, pid) = child_view.unwrap_or((false, None));
    let active = STRATA_ACTIVE.lock().ok().and_then(|g| g.clone());

    let (port, lan, health) = match &active {
        Some(config) => (
            Some(config.port),
            Some(config.host == "0.0.0.0"),
            if running {
                probe_health(config.port)
            } else {
                None
            },
        ),
        None => (None, None, None),
    };

    let api_reachable = health.is_some();
    let model_loaded = health.as_ref().map(|h| h.loaded).unwrap_or(false);

    StrataRuntimeStatus {
        running,
        api_ready: running && model_loaded,
        api_reachable,
        model_loaded,
        model_name: health.as_ref().and_then(|h| h.model.clone()),
        max_context: health.as_ref().and_then(|h| h.max_context),
        port,
        lan,
        pid,
    }
}
