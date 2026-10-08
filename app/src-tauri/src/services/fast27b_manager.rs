//! fast-27b 引擎（Ternary-Bonsai-2-27B-Heretic 离线包）旁路进程管理。
//!
//! 与 dsh_manager / embedding_manager 同一套进程管理规范：
//! - 启动：`ninfer-serve-86.exe <model> --host --port --api-key ...`（argv 逐字对齐 3080 Ti
//!   调优脚本 start-heretic-smart-lan-3080ti.bat，并补上它依赖的 5 个 NINFER_* KVMem
//!   环境变量，见 Fast27bStartOptions → build_args 与 start_fast27b）；
//! - 进程树：Job Object（KILL_ON_JOB_CLOSE）整树回收，应用退出时联动 stop_fast27b；
//! - 健康：轮询 `GET /v1/models`（必须带 Bearer api-key，200 即就绪）；
//! - 日志：stdout/stderr 双读线程 → 环形缓冲 + `fast27b:log` 事件。
//!
//! 安全边界：子进程路径来自应用配置（engine_path），启动前校验存在性与文件名；
//! 参数为参数列表，无 shell 参与；api-key 在日志中脱敏，不写入日志缓冲。

use crate::models::app_state::Fast27bModel;

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
// 程序路径来自应用配置并经启动前校验，无 shell、无命令字符串拼接。
use std::process::Command as SpawnProcess;

/// fast27b 运行期事件（由 commands 层转发为 Tauri `fast27b:ready`/`fast27b:stopped`/`fast27b:error`）。
#[derive(Debug, Clone)]
pub enum Fast27bRuntimeEvent {
    /// 服务就绪，携带服务根地址（http://127.0.0.1:<port>）。
    Ready(String),
    /// 进程退出，携带原因说明。
    Stopped(String),
    /// 运行期错误。
    Error(String),
}

/// 启动参数（由 commands 层从 AppConfig.fast27b 组装）。
#[derive(Debug, Clone)]
pub struct Fast27bStartOptions {
    pub engine_path: PathBuf,
    pub model_path: PathBuf,
    pub model_variant: Fast27bModel,
    pub port: u16,
    /// true = 0.0.0.0（对局域网开放）。
    pub lan: bool,
    pub api_key: String,
    pub context_window: u32,
    pub draft_tokens: u32,
    /// 引擎默认输出上限（`--default-max-tokens`）；0 = 不传，交回引擎自身默认值。
    /// 注意：对话页「最大输出 Token」默认 0（请求体不带 max_tokens），因此该值就是
    /// 默认对话实际能生成的最长长度，必须可配置，否则输出会被静默截断。
    pub default_max_tokens: u32,
}

impl Fast27bStartOptions {
    fn host(&self) -> &'static str {
        if self.lan {
            "0.0.0.0"
        } else {
            "127.0.0.1"
        }
    }

    /// 组装命令行参数（逐字对齐 D:\Projects\fast-llm\launch\fastllm-ui.mjs）：
    /// Swift 只启用 BAT 中的 MTP 草稿头；Heretic 不启用任何草稿参数。
    /// `--kv-capacity auto` + `--kv-headroom-mib 128` 保留 BAT 的设备池策略；5 个
    /// NINFER_* KVMem 环境变量在 start_fast27b 中另行下发。
    ///
    /// 应用侧增补：
    /// - `--api-key`：本地/局域网 OpenAI 兼容接口鉴权；
    /// - `--cors` —— 应用内「自带对话」从 Tauri webview（origin http://tauri.localhost）
    ///   直接 fetch 引擎 HTTP API，而引擎默认不返回 CORS 头且 OPTIONS 预检返回 404，
    ///   浏览器会直接拦截（Failed to fetch）。该开关只影响 HTTP 响应头，不改变推理行为。
    fn build_args(&self) -> Vec<String> {
        let mut args = vec![
            self.model_path.to_string_lossy().to_string(),
            "--host".to_string(),
            self.host().to_string(),
            "--port".to_string(),
            self.port.to_string(),
            "--model-id".to_string(),
            "qwen3.8-27b".to_string(),
            "--max-context".to_string(),
            self.context_window.to_string(),
            "--kv-capacity".to_string(),
            "auto".to_string(),
            "--kv-headroom-mib".to_string(),
            "128".to_string(),
            "--kv-dtype".to_string(),
            "k8v4".to_string(),
            "--host-kv-mib".to_string(),
            "16384".to_string(),
            "--prefill-chunk".to_string(),
        ];
        if self.model_variant == Fast27bModel::Swift {
            args.extend([
                "1024".to_string(),
                "--spec".to_string(),
                "mtp".to_string(),
                "--draft-tokens".to_string(),
                self.draft_tokens.to_string(),
                "--lm-head-draft".to_string(),
            ]);
        } else {
            args.push("1024".to_string());
        }
        args.extend([
            "--vision".to_string(),
            "--vision-residency".to_string(),
            "resident".to_string(),
            "--default-max-tokens".to_string(),
            self.default_max_tokens.to_string(),
            "--default-reasoning-effort".to_string(),
            "high".to_string(),
            "--max-concurrency".to_string(),
            "1".to_string(),
            "--presence-penalty".to_string(),
            "0".to_string(),
            "--max-shared-prefixes".to_string(),
            "0".to_string(),
            "--gdn-state-fp16".to_string(),
        ]);
        // default-max-tokens 与 BAT 一样显式下发，保证配置可复现；0 时保留旧行为并省略。
        if self.default_max_tokens == 0 {
            if let Some(index) = args.iter().position(|arg| arg == "--default-max-tokens") {
                args.drain(index..=index + 1);
            }
        }
        args.push("--api-key".to_string());
        args.push(self.api_key.clone());
        args.push("--cors".to_string());
        args
    }
}

/// 当前运行配置（探活与 dsh 绑定取 endpoint 用）。
#[derive(Debug, Clone)]
struct ActiveConfig {
    port: u16,
    host: &'static str,
    api_key: String,
}

/// 引擎内部分页 KV 的容量读数（解析自 `capacity | KV … tokens…` 启动行）。
/// 只解析引擎自己打印的数字，绝不猜测、也不改动任何启动参数。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PagedKvCapacity {
    /// 设备池 token 数（`--kv-capacity auto` 的实测结果）。
    pub pool_tokens: u64,
    /// 设备池页数（每页 64 token）。
    pub pages: u64,
    /// `--kv-capacity` 的取值（auto 或显式数字）。
    pub configured: &'static str,
}

/// 引擎失效种类（用于中文文案与「能否自愈」判断）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FaultKind {
    /// worker 崩溃（分页 KV 预留不变量被破坏）：进程还在、HTTP 层还在，但不会再服务。
    WorkerCrash,
    /// 连续 prepare/generation 失败（HTTP 503）：worker 已不可用但尚无崩溃行。
    RequestsFailing,
    /// 题面超过设备 KV 池：内容可能静默丢失，且是崩溃的触发条件。
    OverPool,
}

/// 引擎失效状态（由引擎日志驱动，锁存到下次启动；独立于「进程活着」与「HTTP 200」）。
#[derive(Debug, Clone, Default)]
struct FaultRecord {
    kind: Option<FaultKind>,
    /// 中文原因（引擎原文一并保留，报告与日志面板可核）。
    reason: Option<String>,
    /// 引擎日志里的原始行（证据）。
    raw_line: Option<String>,
    /// 引擎日志行里的时间戳（HH:MM:SS，可缺省）。
    at: Option<String>,
    /// 失效是否致命（致命 = 必须重启引擎才能恢复）。
    fatal: bool,
    /// 最近一次超池：题面 token 数。
    over_pool_prompt_tokens: Option<u64>,
    /// 最近一次超池：当时的设备池 token 数。
    over_pool_pool_tokens: Option<u64>,
    /// 连续失败计数（成功请求会清零；达到阈值即判 worker 不可用）。
    failure_streak: u32,
    /// 最近一次成功完成的请求号（用于丢弃重启后读到的过期失败行）。
    last_done_req: Option<u64>,
    /// 致命失效之后仍出现的成功请求数（>0 = 读数存疑，需用真实请求复核）。
    completions_after_fault: u32,
}

static FAST27B_FAULT: Mutex<Option<FaultRecord>> = Mutex::new(None);
/// 设备池容量读数缓存（启动行只出现一次，需要跨状态轮询保留）。
static FAST27B_CAPACITY: Mutex<Option<PagedKvCapacity>> = Mutex::new(None);
static FAST27B_CHILD: Mutex<Option<Child>> = Mutex::new(None);
static FAST27B_LOGS: Mutex<Vec<String>> = Mutex::new(Vec::new());
static FAST27B_ACTIVE: Mutex<Option<ActiveConfig>> = Mutex::new(None);
/// 代数计数：每次启动/停止自增，用于让旧的监视线程静默退出，不发过期事件。
static FAST27B_GENERATION: AtomicU32 = AtomicU32::new(0);

/// 日志环形缓冲上限（行）。
const LOG_CAP: usize = 5000;
/// HTTP 503 需要连续出现几次才判定 worker 不可用（挡掉偶发瞬时失败，避免误报）。
const FAILURE_STREAK_TO_DEGRADE: u32 = 2;
/// 启动时回扫历史日志的行数（跨应用重启保留「引擎已打死」这一事实）。
const FAULT_SEED_TAIL_LINES: usize = 400;
/// 就绪健康检查总超时（权重 6.7 GiB 加载约 8-10s，CUDA 图准备约 2s；留足余量）。
const READY_TIMEOUT: Duration = Duration::from_secs(120);

// ---------------------------------------------------------------------------
// Job Object（进程树回收，与 dsh_manager 同规范）
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
                eprintln!("[fast27b] Job Object 创建失败");
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
                eprintln!("[fast27b] SetInformationJobObject 失败");
                CloseHandle(job);
                return;
            }
            if AssignProcessToJobObject(job, process_handle) == 0 {
                eprintln!("[fast27b] AssignProcessToJobObject 失败");
                CloseHandle(job);
                return;
            }
            if let Ok(mut guard) = JOB_HANDLE.lock() {
                *guard = Some(JobHandle(job));
            }
            eprintln!("[fast27b] Job Object 已附加到 fast27b 进程");
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

/// 日志文件（与环形缓冲同步落盘，应用外可排查；路径：AgentLLM 数据目录）。
fn log_file_path() -> Option<PathBuf> {
    dirs::data_dir().map(|dir| dir.join("AgentLLM").join("fast27b").join("engine.log"))
}

/// 追加一行到 fast27b 日志环形缓冲（启动/停止等非进程动作也写入，保证日志面板完整可见），
/// 并同步落盘到 engine.log（追加模式；失败静默，不影响内存缓冲）。
pub fn add_fast27b_log(line: &str) {
    if let Ok(mut logs) = FAST27B_LOGS.lock() {
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

/// 读取全部 fast27b 日志行（fast27b_get_logs）。
pub fn get_fast27b_logs() -> Vec<String> {
    FAST27B_LOGS
        .lock()
        .map(|logs| logs.clone())
        .unwrap_or_default()
}

/// 清空 fast27b 日志（fast27b_clear_logs）。
pub fn clear_fast27b_logs() {
    if let Ok(mut logs) = FAST27B_LOGS.lock() {
        logs.clear();
    }
}

/// fast27b 子进程是否仍在运行。
pub fn is_fast27b_running() -> bool {
    match FAST27B_CHILD.lock() {
        Ok(mut guard) => guard
            .as_mut()
            .is_some_and(|child| matches!(child.try_wait(), Ok(None))),
        Err(error) => {
            eprintln!(
                "[fast27b] FAST27B_CHILD Mutex 已中毒，按未运行处理: {}",
                error
            );
            false
        }
    }
}

// ---------------------------------------------------------------------------
// 引擎失效识别（worker 崩溃 / 连续 503 / 超池）
// ---------------------------------------------------------------------------
//
// 背景（2026-10-05 实盘）：题面 53,377 token 超过设备池 17,920 token 时，引擎把 702 页
// 一次性搬到主机池失败，打印 `worker crash: Paged KV reservation invariant was violated`
// 并永久停止服务；但引擎**进程仍在**、HTTP 层仍在监听，`/v1/models` 照样返回 200，
// 于是应用会一直显示「运行中 · API 就绪」，而每条对话都是 HTTP 503。
// 因此判活不能只看 /v1/models，必须同时读引擎自己的日志特征。

/// 引擎失效状态快照（供 commands 层序列化给前端）。
#[derive(Debug, Clone)]
pub struct Fast27bFaultStatus {
    pub degraded: bool,
    /// 英文故障码：worker_crash / requests_failing / over_pool。
    pub kind: Option<&'static str>,
    /// 中文原因（含处置建议）；未失效或原因未知时为 None。
    pub reason: Option<String>,
    /// 致命失效 = 必须重启引擎才能恢复（worker 崩溃 / 连续请求失败）。
    pub requires_restart: bool,
    /// 引擎日志原始行（证据，可能是英文原文）。
    pub raw_line: Option<String>,
    /// 引擎日志时间戳（HH:MM:SS）。
    pub at: Option<String>,
    /// 最近一次超池的题面 token 数。
    pub over_pool_prompt_tokens: Option<u64>,
    /// 最近一次超池时的设备池 token 数。
    pub over_pool_pool_tokens: Option<u64>,
    /// 致命失效发生后的第几次成功请求（0 = 尚未出现成功请求；>0 = 计数存疑，需验证真活）。
    pub completions_after_fault: u32,
}

impl Default for Fast27bFaultStatus {
    fn default() -> Self {
        Self {
            degraded: false,
            kind: None,
            reason: None,
            requires_restart: false,
            raw_line: None,
            at: None,
            over_pool_prompt_tokens: None,
            over_pool_pool_tokens: None,
            completions_after_fault: 0,
        }
    }
}

/// 故障码（英文，UI 不直接展示，中文文案见 fault_reason_text）。
fn fault_kind_code(kind: FaultKind) -> &'static str {
    match kind {
        FaultKind::WorkerCrash => "worker_crash",
        FaultKind::RequestsFailing => "requests_failing",
        FaultKind::OverPool => "over_pool",
    }
}

/// 解析引擎日志时间戳（取 HH:MM:SS；引擎有两种格式：
/// `2026-10-05 11:59:19.236` 与 `[2026-10-05 11:59:19.206]`）。
/// 逐字节推进的窗口必须用 `get()` 切片：日志行可能带多字节 UTF-8（模型路径、
/// banner 等），直接下标切片落在字符中间会让日志读线程 panic、之后再无日志与失效识别。
fn parse_log_clock(line: &str) -> Option<String> {
    let bytes = line.as_bytes();
    let mut index = 0usize;
    while index + 8 <= bytes.len() {
        if let Some(window) = line.get(index..index + 8) {
            let shaped = window.as_bytes().iter().enumerate().all(|(offset, byte)| {
                if offset == 2 || offset == 5 {
                    *byte == b':'
                } else {
                    byte.is_ascii_digit()
                }
            });
            if shaped {
                return Some(window.to_string());
            }
        }
        index += 1;
    }
    None
}

/// 解析 `req#<N> …` 里的请求号。
fn parse_req_number(line: &str) -> Option<u64> {
    let marker = line.find("req#")?;
    let digits: String = line[marker + 4..]
        .chars()
        .take_while(|ch| ch.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

/// 去掉数字里的千分位并解析（引擎打印 `17,920`）。
fn parse_grouped_u64(text: &str) -> Option<u64> {
    text.chars()
        .filter(|ch| ch.is_ascii_digit())
        .collect::<String>()
        .parse()
        .ok()
}

/// 解析引擎启动行：
/// `2026-10-05 11:31:12.388  INFO  capacity | KV 17,920 tokens, k8v4, auto | pages 280/280 | runtime 1.85 GiB | free 1.30 GiB`
fn parse_capacity_line(line: &str) -> Option<PagedKvCapacity> {
    let rest = line.split("capacity |").nth(1)?;
    let tokens_marker = rest.find("tokens")?;
    let page_tokens = rest[..tokens_marker]
        .split_whitespace()
        .last()
        .and_then(parse_grouped_u64)?;
    // 段尾形如 `, k8v4, auto | pages 280/280`：dtype 与 capacity 取值之间可能有空格。
    let after_tokens = &rest[tokens_marker..];
    let pages_part = after_tokens.split("pages").nth(1)?;
    let pages = pages_part
        .trim_start()
        .split(|ch: char| !ch.is_ascii_digit())
        .next()
        .and_then(|digits| digits.parse::<u64>().ok())?;
    let configured = if after_tokens.contains(", auto") {
        "auto"
    } else {
        "explicit"
    };
    Some(PagedKvCapacity {
        pool_tokens: page_tokens,
        pages,
        configured,
    })
}

/// 解析超池告警行：
/// `[2026-10-05 11:59:19.206] [warning] ninfer-serve: prompt exceeds the resident Device KV pool: prompt 53377 tokens (835 pages) > pool 17920 tokens (280 pages). …`
/// 返回 (题面 token 数, 设备池 token 数)。
fn parse_over_pool_line(line: &str) -> Option<(u64, u64)> {
    let rest = line.split("exceeds the resident Device KV pool:").nth(1)?;
    let (before, after) = rest.split_once(">")?;
    let prompt_tokens = before
        .split("prompt")
        .nth(1)?
        .split_whitespace()
        .next()
        .and_then(parse_grouped_u64)?;
    let pool_tokens = after
        .split("pool")
        .nth(1)?
        .split_whitespace()
        .next()
        .and_then(parse_grouped_u64)?;
    Some((prompt_tokens, pool_tokens))
}

/// 单行日志解析结果（纯函数，便于单元测试）。
#[derive(Debug, Clone, PartialEq, Eq)]
enum LogEvent {
    /// 引擎已就绪（新实例健康，历史故障作废）。
    Ready,
    /// worker 崩溃（分页 KV 不变量被破坏），携带原始日志行。
    WorkerCrash(String),
    /// 请求失败事件：本次失败是否致命、请求号、原始行。
    RequestFailed {
        fatal: bool,
        req: Option<u64>,
        raw: String,
    },
    /// 请求成功完成（用于清掉「连续失败」计数）。
    RequestDone { req: Option<u64> },
    /// 设备池容量读数。
    Capacity(PagedKvCapacity),
    /// 题面超过设备池。
    OverPool {
        raw: String,
        prompt_tokens: u64,
        pool_tokens: u64,
    },
}

/// 判定日志行并解析出结构化事件；普通行返回 None。
fn classify_engine_log(line: &str) -> Option<LogEvent> {
    if line.contains("Paged KV reservation invariant was violated") || line.contains("worker crash")
    {
        return Some(LogEvent::WorkerCrash(line.to_string()));
    }
    if line.contains("engine ready |") {
        return Some(LogEvent::Ready);
    }
    if line.contains("exceeds the resident Device KV pool:") {
        if let Some((prompt_tokens, pool_tokens)) = parse_over_pool_line(line) {
            return Some(LogEvent::OverPool {
                raw: line.to_string(),
                prompt_tokens,
                pool_tokens,
            });
        }
    }
    if let Some(capacity) = parse_capacity_line(line) {
        return Some(LogEvent::Capacity(capacity));
    }
    // 采集请求号后再判定失败/成功，保证同一个 req# 的失败与成功可以互相消解。
    let req = parse_req_number(line);
    if line.contains("failed during prepare") || line.contains("failed during generation") {
        // HTTP 503 = worker 不可用（重试无用）；HTTP 500 = 生成期内部错误（worker 崩溃的直接后果）。
        // `HTTP 499 | client disconnected` 是客户端主动断开，不算引擎故障。
        let fatal = line.contains("HTTP 503") || line.contains("HTTP 500");
        return Some(LogEvent::RequestFailed {
            fatal,
            req,
            raw: line.to_string(),
        });
    }
    if line.contains("req#") && line.contains(" done |") {
        return Some(LogEvent::RequestDone { req });
    }
    None
}

/// 中文原因文案（面向用户；引擎原文另存 raw_line 供核对）。
fn fault_reason_text(kind: FaultKind, raw: Option<&str>) -> String {
    match kind {
        FaultKind::WorkerCrash => concat!(
            "引擎 worker 已崩溃（分页 KV 预留不变量被破坏）：进程还在、接口还在，但不会再服务任何请求。",
            "必须重启引擎；重启后请新开对话，不要把超池的长历史重发一次。"
        )
        .to_string(),
        FaultKind::RequestsFailing => concat!(
            "引擎连续多次拒绝请求（HTTP 503 service unavailable）：worker 已不可用，重试无用，需重启引擎。",
            "若之后仍有请求成功，本条会自动降级为提示。"
        )
        .to_string(),
        FaultKind::OverPool => {
            let mut text = concat!(
                "当前对话题面已超过设备 KV 池：中段内容可能被静默丢弃（HTTP 200、答案看着合理但是错的），",
                "继续加长还有打死 worker 的已知风险。请新开对话，或先重启引擎以取得更大的设备池。"
            )
            .to_string();
            if let Some(raw) = raw {
                if let Some((prompt, pool)) = parse_over_pool_line(raw) {
                    text.push_str(&format!(
                        "（本次题面约 {} token，设备池 {} token）",
                        prompt, pool
                    ));
                }
            }
            text
        }
    }
}

/// 转换为对前端可见的状态快照。
fn fault_status_from_record(record: Option<FaultRecord>) -> Fast27bFaultStatus {
    match record {
        None => Fast27bFaultStatus::default(),
        Some(record) => {
            let kind = record.kind;
            Fast27bFaultStatus {
                degraded: kind.is_some(),
                kind: kind.map(fault_kind_code),
                reason: record.reason,
                requires_restart: record.fatal,
                raw_line: record.raw_line,
                at: record.at,
                over_pool_prompt_tokens: record.over_pool_prompt_tokens,
                over_pool_pool_tokens: record.over_pool_pool_tokens,
                completions_after_fault: record.completions_after_fault,
            }
        }
    }
}

/// 当前引擎失效状态。
pub fn fault_status() -> Fast27bFaultStatus {
    fault_status_from_record(FAST27B_FAULT.lock().ok().and_then(|guard| guard.clone()))
}

/// 当前设备池容量读数（引擎尚未打印启动行时为 None）。
pub fn device_pool_capacity() -> Option<PagedKvCapacity> {
    FAST27B_CAPACITY.lock().ok().and_then(|guard| *guard)
}

/// 清空失效状态（启动新实例 / 停止引擎时调用；必须在代数自增前调用，
/// 让仍在抽日志的旧监视线程因代数不匹配而无法把过期故障写回来）。
fn reset_engine_fault() {
    if let Ok(mut guard) = FAST27B_FAULT.lock() {
        *guard = None;
    }
}

/// 应用一行引擎日志，按需更新容量读数与失效状态。
fn apply_engine_log_line(line: &str) {
    if let Some(capacity) = parse_capacity_line(line) {
        if let Ok(mut guard) = FAST27B_CAPACITY.lock() {
            *guard = Some(capacity);
        }
    }
    let Some(event) = classify_engine_log(line) else {
        return;
    };
    let clock = parse_log_clock(line);
    if let Ok(mut guard) = FAST27B_FAULT.lock() {
        let mut record = guard.take().unwrap_or_default();
        apply_fault_event(&mut record, event, clock);
        *guard = Some(record);
    }
}

/// 故障状态机（纯函数，便于单元测试直接驱动；不触任何全局状态）。
fn apply_fault_event(record: &mut FaultRecord, event: LogEvent, clock: Option<String>) {
    let previous_kind = record.kind;

    match event {
        LogEvent::Ready => {
            // 新实例已就绪：一切归零（容量读数由随后的 capacity 行覆盖）。
            *record = FaultRecord::default();
        }
        LogEvent::Capacity(_) => { /* 容量读数在上层单独记录 */ }
        LogEvent::WorkerCrash(raw) => {
            // 致命：锁存，直到下次启动；completions_after_fault 仅作存疑提示，不清故障。
            record.kind = Some(FaultKind::WorkerCrash);
            record.fatal = true;
            record.reason = Some(fault_reason_text(FaultKind::WorkerCrash, None));
            record.raw_line = Some(raw);
            record.at = clock;
        }
        LogEvent::RequestFailed { fatal, req, raw } => {
            let stale =
                matches!((req, record.last_done_req), (Some(req), Some(done)) if req <= done);
            if stale {
                // 上一轮的失败行（重启后旧日志尾巴），忽略。
            } else if fatal {
                record.failure_streak = record.failure_streak.saturating_add(1);
                if record.failure_streak >= FAILURE_STREAK_TO_DEGRADE {
                    record.kind = Some(FaultKind::RequestsFailing);
                    record.fatal = true;
                    record.reason = Some(fault_reason_text(FaultKind::RequestsFailing, Some(&raw)));
                    record.raw_line = Some(raw);
                    record.at = clock;
                }
            }
        }
        LogEvent::RequestDone { req } => {
            if let Some(req) = req {
                if record.last_done_req.map_or(true, |done| req > done) {
                    record.last_done_req = Some(req);
                }
            }
            // 无论是否致命，成功请求都清掉「连续失败」计数；worker 崩溃本身不被清除，
            // 但在崩溃后出现成功请求时计数，供 UI 提示「读数存疑，请用一条真实请求复核」。
            record.failure_streak = 0;
            if matches!(previous_kind, Some(FaultKind::WorkerCrash)) {
                record.completions_after_fault = record.completions_after_fault.saturating_add(1);
            }
        }
        LogEvent::OverPool {
            raw,
            prompt_tokens,
            pool_tokens,
        } => {
            if !matches!(previous_kind, Some(FaultKind::OverPool)) {
                record.kind = Some(FaultKind::OverPool);
                record.fatal = false;
                record.reason = Some(fault_reason_text(FaultKind::OverPool, Some(&raw)));
                record.raw_line = Some(raw);
                record.at = clock;
            }
            record.over_pool_prompt_tokens = Some(prompt_tokens);
            record.over_pool_pool_tokens = Some(pool_tokens);
        }
    }
}

/// 供监视线程调用：只接受属于当前代数（本次启动）的日志行，避免过期启动的日志污染新状态。
fn note_engine_log_line(line: &str, generation: u32) {
    if FAST27B_GENERATION.load(Ordering::SeqCst) != generation {
        return;
    }
    apply_engine_log_line(line);
}

/// 回扫日志文件尾部：若历史日志「最后一台实例」死在 worker 崩溃上，且此后没有新的
/// `engine ready`，则保留该事实，避免应用重启后误报「运行中」。
/// 在应用启动时（lib.rs setup）调用一次；start_fast27b 拉起新实例前会用
/// reset_engine_fault 清空，新实例的 `engine ready` 行是最终归零确认。
pub fn seed_fault_from_log_file() {
    let Some(path) = log_file_path() else {
        return;
    };
    let Ok(lines) = read_log_tail(&path, FAULT_SEED_TAIL_LINES) else {
        return;
    };
    if let Some(record) = fault_record_from_log_tail(&lines) {
        if let Ok(mut guard) = FAST27B_FAULT.lock() {
            *guard = Some(record);
        }
    }
}

/// 从一段日志行判定「应用重启后是否仍有未恢复的 worker 崩溃」（纯函数，便于测试）。
fn fault_record_from_log_tail(lines: &[String]) -> Option<FaultRecord> {
    let last_fatal = lines
        .iter()
        .rposition(|line| matches!(classify_engine_log(line), Some(LogEvent::WorkerCrash(_))));
    let last_ready = lines
        .iter()
        .rposition(|line| line.contains("engine ready |"));
    // 只有「崩溃晚于最后一次 engine ready」才是未恢复的失效：
    // 崩溃之后又就绪过，说明引擎已被重启成健康实例，不能报失效。
    let fatal_index = last_fatal.filter(|fatal| last_ready.map_or(true, |ready| *fatal > ready))?;
    let raw = lines[fatal_index].clone();
    Some(FaultRecord {
        kind: Some(FaultKind::WorkerCrash),
        fatal: true,
        reason: Some(fault_reason_text(FaultKind::WorkerCrash, Some(&raw))),
        at: parse_log_clock(&raw),
        raw_line: Some(raw),
        ..FaultRecord::default()
    })
}

/// 读取文本文件末尾若干行（回扫历史故障用；文件不存在/读取失败返回错误）。
fn read_log_tail(path: &Path, max_lines: usize) -> std::io::Result<Vec<String>> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    if len == 0 {
        return Ok(Vec::new());
    }
    // 每行最长约 600 字节；按行数估算读取窗口，上限 512 KiB。
    let window = ((max_lines as u64) * 700).min(512 * 1024).min(len);
    file.seek(SeekFrom::Start(len - window))?;
    let mut buffer = Vec::with_capacity(window as usize);
    file.read_to_end(&mut buffer)?;
    let text = String::from_utf8_lossy(&buffer).to_string();
    let mut lines: Vec<String> = text.lines().map(|line| line.to_string()).collect();
    if lines.len() > max_lines {
        lines.drain(..lines.len() - max_lines);
    }
    Ok(lines)
}
// ---------------------------------------------------------------------------
// 探活
// ---------------------------------------------------------------------------

/// 探活：`GET /v1/models`（带 Bearer）返回 200 即视为接口可用。
///
/// 注意：worker 崩溃后该接口**照样**返回 200（引擎进程与 HTTP 层都还在），
/// 所以它只代表「接口在线」，不代表「能服务」。真正的判活在 runtime_status()
/// 里叠加引擎日志失效识别。
pub fn probe_models_available(port: u16, api_key: &str) -> bool {
    let url = format!("http://127.0.0.1:{}/v1/models", port);
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
        .bearer_auth(api_key)
        .send()
        .map(|resp| resp.status().as_u16() == 200)
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// 启动 / 停止
// ---------------------------------------------------------------------------

/// 启动前校验：引擎与模型路径存在、引擎文件名正确。
fn validate_options(options: &Fast27bStartOptions) -> Result<(), String> {
    let engine = &options.engine_path;
    if !engine.exists() {
        return Err(format!("未找到 fast27b 引擎：{}", engine.display()));
    }
    if engine
        .file_name()
        .map(|name| !name.eq_ignore_ascii_case("ninfer-serve-86.exe"))
        .unwrap_or(true)
    {
        return Err(format!(
            "引擎文件名应为 ninfer-serve-86.exe：{}",
            engine.display()
        ));
    }
    if !options.model_path.exists() {
        return Err(format!("未找到模型文件：{}", options.model_path.display()));
    }
    if options.api_key.trim().is_empty() {
        return Err("API Key 不能为空。".to_string());
    }
    Ok(())
}

/// 启动 fast27b 引擎。命令立即返回（spawn 成功即 Ok），就绪/退出通过事件回调上报；
/// 等待就绪期间周期性调用 on_progress（前端进度可见）。
pub fn start_fast27b(
    options: &Fast27bStartOptions,
    on_log: impl Fn(String) + Send + Sync + 'static,
    on_progress: impl Fn(String) + Send + Sync + 'static,
    on_event: impl Fn(Fast27bRuntimeEvent) + Send + Sync + 'static,
) -> Result<(), String> {
    if is_fast27b_running() {
        return Err("fast27b 引擎已在运行，请先停止后再启动。".to_string());
    }
    validate_options(options)?;

    // 本次要拉起新实例：清空失效状态（含应用启动时回扫到的历史事实）与容量读数。
    // 代数稍后在 spawn 后自增，清空必须在其之前，让旧监视线程的过期故障写不回来；
    // 新实例的 `engine ready` 行会把状态机再次归零，作为最终确认。
    reset_engine_fault();
    if let Ok(mut guard) = FAST27B_CAPACITY.lock() {
        *guard = None;
    }

    // 清扫上次会话遗留的孤儿引擎（应用强杀/外部 bat 场景），避免端口与新进程冲突。
    stop_stale_fast27b_processes(&options.engine_path);

    // 端口被占用时提前失败（外部 bat / 孤儿进程场景），给出明确中文提示。
    if std::net::TcpListener::bind(("127.0.0.1", options.port)).is_err() {
        return Err(format!(
            "端口 {} 已被占用：可能是 fast27b 已在运行（外部 bat 启动的实例也算），或其他程序。请先停止它，或更换端口。",
            options.port
        ));
    }

    let args = options.build_args();
    let engine_dir = options
        .engine_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let mut command = SpawnProcess::new(options.engine_path.as_os_str());
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    command
        .args(&args)
        // 与离线包 bat 对齐：CWD = 引擎目录，PATH 前置引擎目录
        //（引擎运行库 DLL 与引擎同目录，双保险规避宿主环境差异）。
        .current_dir(&engine_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    {
        let path = std::env::var("PATH").unwrap_or_default();
        command.env("PATH", format!("{};{}", engine_dir.to_string_lossy(), path));
    }
    // KVMem 环境变量（逐字对齐 start-heretic-smart-lan-3080ti.bat 的 5 行）：把 KV 环放在
    // 主机可分页内存并复用 host-backed，避免 12 GiB 卡上「权重 + 运行时预留」撑爆显存。
    // 缺这组变量时引擎会尝试全部驻留 GPU，表现为启动 FATAL（minimum Engine runtime
    // reservation ... only ... bytes are available after weights）。
    for (key, value) in [
        ("NINFER_KV_WINDOW", "16384"),
        ("NINFER_KV_RETRIEVE", "8192"),
        ("NINFER_KV_RING", "1"),
        ("NINFER_HOST_PAGEABLE", "1"),
        ("NINFER_KV_REUSE_HOSTBACKED", "1"),
    ] {
        command.env(key, value);
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("无法启动 fast27b 进程：{}", e))?;
    eprintln!("[fast27b] spawned pid={:?}", child.id());
    add_fast27b_log(&format!(
        "[fast27b] 启动：{} --host {} --port {}（模型 {}）",
        options.engine_path.display(),
        options.host(),
        options.port,
        options.model_path.display()
    ));

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    if let Ok(mut guard) = FAST27B_CHILD.lock() {
        *guard = Some(child);
    }
    let active = ActiveConfig {
        port: options.port,
        host: options.host(),
        api_key: options.api_key.clone(),
    };
    if let Ok(mut guard) = FAST27B_ACTIVE.lock() {
        *guard = Some(active);
    }
    let generation = FAST27B_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;

    // 附加 Job Object：父进程崩溃/退出时 OS 回收整棵进程树。
    #[cfg(windows)]
    {
        if let Some(guard) = FAST27B_CHILD.lock().ok().as_mut().and_then(|g| g.as_mut()) {
            job_guard::attach(guard.as_raw_handle());
        }
    }

    let (tx, rx) = channel::<String>();
    if let Some(out) = stdout {
        let tx_out = tx.clone();
        let log_generation = generation;
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                // 失效识别在**入队之前**完成：引擎打崩溃行后可能再无任何输出，
                // 排在 logger 后面的消费者逻辑会晚一拍才看到它。
                note_engine_log_line(&line, log_generation);
                if tx_out.send(line).is_err() {
                    break;
                }
            }
        });
    }
    if let Some(err) = stderr {
        let log_generation = generation;
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                note_engine_log_line(&line, log_generation);
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
    }

    // 监视线程：日志转发 + 健康轮询 + 退出检测。
    let probe_port = options.port;
    let probe_key = options.api_key.clone();
    std::thread::spawn(move || {
        let started = Instant::now();
        let mut ready_fired = false;
        let mut pipes_closed = false;
        let mut health_tick = 0u32;

        loop {
            if pipes_closed {
                std::thread::sleep(Duration::from_millis(200));
            } else {
                match rx.recv_timeout(Duration::from_millis(200)) {
                    Ok(line) => {
                        add_fast27b_log(&line);
                        on_log(line);
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => {
                        pipes_closed = true;
                    }
                }
            }

            // 代数已变：本轮启动已被 stop/重启取代，本线程只清尾不再上报。
            if FAST27B_GENERATION.load(Ordering::SeqCst) != generation {
                return;
            }

            if !ready_fired {
                health_tick += 1;
                // 每 5 个 tick（约 1 秒）探测一次；每 10 秒上报一次等待进度。
                if health_tick % 5 == 0 && probe_models_available(probe_port, &probe_key) {
                    ready_fired = true;
                    let url = format!("http://127.0.0.1:{}", probe_port);
                    add_fast27b_log(&format!("[fast27b] 健康检查通过：{}", url));
                    on_event(Fast27bRuntimeEvent::Ready(url));
                } else {
                    if health_tick % 50 == 0 {
                        on_progress(format!(
                            "正在等待 fast27b 引擎就绪（已等待 {} 秒）...",
                            started.elapsed().as_secs()
                        ));
                    }
                    if started.elapsed() > READY_TIMEOUT {
                        on_event(Fast27bRuntimeEvent::Error(format!(
                            "fast27b 在 {} 秒内未通过健康检查（GET /v1/models）。请到日志区查看具体报错。",
                            READY_TIMEOUT.as_secs()
                        )));
                        // 超时后继续抽干日志并等待退出，不再重复报错。
                        ready_fired = true;
                    }
                }
            }

            if pipes_closed && FAST27B_GENERATION.load(Ordering::SeqCst) == generation {
                let exit_info = FAST27B_CHILD
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
                if let Ok(mut guard) = FAST27B_CHILD.lock() {
                    *guard = None;
                }
                if let Ok(mut guard) = FAST27B_ACTIVE.lock() {
                    *guard = None;
                }
                on_event(Fast27bRuntimeEvent::Stopped(format!(
                    "fast27b 进程已退出（{}）。",
                    exit_info
                )));
                return;
            }
        }
    });

    Ok(())
}

/// 停止 fast27b：Job Object 整树终止 + 句柄回收。代数自增使监视线程静默退出。
pub fn stop_fast27b() -> Result<(), String> {
    // 先清失效状态、再自增代数：仍在抽日志的旧监视线程会因代数不匹配而无法写回过期故障。
    reset_engine_fault();
    if let Ok(mut guard) = FAST27B_CAPACITY.lock() {
        *guard = None;
    }
    FAST27B_GENERATION.fetch_add(1, Ordering::SeqCst);
    let mut had_process = false;
    {
        let mut guard = FAST27B_CHILD
            .lock()
            .map_err(|_| "fast27b 进程管理器 Mutex 已中毒".to_string())?;
        if let Some(child) = guard.as_mut() {
            had_process = true;
            let _ = child.kill();
            let _ = child.wait();
        }
        *guard = None;
    }
    #[cfg(windows)]
    job_guard::terminate();
    if had_process {
        add_fast27b_log("[fast27b] 已停止（用户请求）。");
    }
    if let Ok(mut guard) = FAST27B_ACTIVE.lock() {
        *guard = None;
    }
    Ok(())
}

/// 应用退出钩子（quit_app / 窗口销毁调用）：尽力回收 fast27b 进程树，失败仅记日志。
pub fn stop_fast27b_on_exit() {
    if let Err(error) = stop_fast27b() {
        eprintln!("[fast27b] 退出清理失败: {}", error);
    }
}

/// 清扫上次会话遗留的 fast27b 孤儿进程（应用被强杀/崩溃时 Job Object 可能未生效，
/// 或外部 bat 遗留孤儿）。按进程名 ninfer-serve-86.exe 且命令行包含配置的引擎路径精确匹配，
/// 不会影响其他程序。在 start_fast27b 前调用。
pub fn stop_stale_fast27b_processes(engine_path: &Path) {
    let anchor_text = engine_path
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase();
    let mut system = sysinfo::System::new_all();
    system.refresh_processes();
    let mut stopped = 0usize;
    for process in system.processes().values() {
        if !process.name().eq_ignore_ascii_case("ninfer-serve-86.exe") {
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
                "[fast27b] stopping stale fast27b pid={:?} cmd={}",
                process.pid(),
                cmd
            );
            if process.kill() {
                stopped += 1;
            }
        }
    }
    if stopped > 0 {
        eprintln!("[fast27b] stopped {} stale fast27b process(es)", stopped);
        std::thread::sleep(Duration::from_millis(400));
    }
}

/// 重启 fast27b 引擎：只在引擎**已失效**（worker 崩溃 / 连续 503）时才这样做——
/// 这种状态下「引擎没退出」不等于「可用」，必须整进程重启才能恢复。
///
/// 与 stop + start 的区别：本函数会连同引擎路径匹配的遗留实例（孤儿进程）一起回收，
/// 否则端口仍被占住，新实例会因端口占用而启动失败。
pub fn restart_fast27b(
    options: &Fast27bStartOptions,
    on_log: impl Fn(String) + Send + Sync + 'static,
    on_progress: impl Fn(String) + Send + Sync + 'static,
    on_event: impl Fn(Fast27bRuntimeEvent) + Send + Sync + 'static,
) -> Result<(), String> {
    // 1. 停掉本次会话托管的进程（Job Object 整树回收）。
    stop_fast27b()?;
    // 2. 回收同引擎路径的遗留实例：worker 崩溃的进程可能不是当前托管句柄
    //    （例如外部 bat 启动、或应用会话切换后的孤儿），它仍占着端口。
    stop_stale_fast27b_processes(&options.engine_path);
    // 3. 先广播「已停止」，让 UI 立刻摘掉失效徽标（就绪事件由新实例的监视线程发出）。
    on_event(Fast27bRuntimeEvent::Stopped(
        "引擎已停止，正在用同一套参数重新启动...".to_string(),
    ));
    // 4. 重新拉起（内部会校验端口可用、清空失效状态、重新等待就绪）。
    start_fast27b(options, on_log, on_progress, on_event)
}

// ---------------------------------------------------------------------------
// 状态汇总（commands 层合并进 Fast27bStatus）
// ---------------------------------------------------------------------------

/// 汇总运行状态。
pub fn runtime_status() -> Fast27bRuntimeStatus {
    // 只在持锁期间做轻量 try_wait；探活是阻塞 HTTP（最长 2 秒），放到锁外做，
    // 避免状态轮询拖住 stop/start 等同样需要该锁的调用。
    let child_view = FAST27B_CHILD.lock().ok().map(|mut guard| {
        let running = guard
            .as_mut()
            .map(|child| matches!(child.try_wait(), Ok(None)))
            .unwrap_or(false);
        let pid = guard.as_ref().map(|child| child.id());
        (running, pid)
    });
    let (running, pid) = child_view.unwrap_or((false, None));
    let active = FAST27B_ACTIVE.lock().ok().and_then(|g| g.clone());
    let (port, lan, model_id, api_reachable) = match &active {
        Some(config) => {
            // api_reachable = /v1/models 可用（权重加载完成）。注意：worker 崩溃后它**照样**返回 200，
            // 所以它只是「接口在线」，不是「能服务」。
            let ready = running && probe_models_available(config.port, &config.api_key);
            (
                Some(config.port),
                Some(config.host == "0.0.0.0"),
                Some("qwen3.8-27b".to_string()),
                ready,
            )
        }
        None => (None, None, None, false),
    };
    let fault = fault_status();
    let capacity = device_pool_capacity();
    // api_ready（「可对话」）= 进程活着 + 接口在线 + 引擎日志未报失效。
    let api_ready = api_reachable && !fault.degraded;
    Fast27bRuntimeStatus {
        running,
        api_ready,
        api_reachable,
        degraded: fault.degraded,
        degraded_reason: fault.reason.clone(),
        fault_kind: fault.kind.map(str::to_string),
        requires_restart: fault.requires_restart,
        raw_fault_line: fault.raw_line.clone(),
        fault_at: fault.at.clone(),
        completions_after_fault: fault.completions_after_fault,
        device_pool_tokens: capacity.map(|value| value.pool_tokens),
        device_pool_pages: capacity.map(|value| value.pages),
        capacity_configured: capacity.map(|value| value.configured.to_string()),
        over_pool_prompt_tokens: fault.over_pool_prompt_tokens,
        over_pool_pool_tokens: fault.over_pool_pool_tokens,
        port,
        lan,
        model_id,
        pid,
    }
}

/// 运行状态快照（commands 层序列化给前端）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct Fast27bRuntimeStatus {
    /// 子进程存活。
    pub running: bool,
    /// 「可对话」：子进程存活 + `/v1/models` 在线 + 引擎日志未报失效（worker 崩溃 / 连续 503）。
    pub api_ready: bool,
    /// `/v1/models` 探活通过（接口在线；worker 崩溃后仍可能为 true，不可单独当判活依据）。
    pub api_reachable: bool,
    /// 引擎日志判定为失效（worker 崩溃 / 连续 503 / 超池）。
    pub degraded: bool,
    /// 失效中文原因（含处置建议）。
    pub degraded_reason: Option<String>,
    /// 故障码：worker_crash / requests_failing / over_pool。
    pub fault_kind: Option<String>,
    /// 是否必须重启引擎才能恢复。
    pub requires_restart: bool,
    /// 触发失效的引擎日志原始行（证据）。
    pub raw_fault_line: Option<String>,
    /// 失效发生时刻（HH:MM:SS）。
    pub fault_at: Option<String>,
    /// 致命失效之后的成功请求数（>0 = 读数存疑，请用一条真实请求复核）。
    pub completions_after_fault: u32,
    /// 设备 KV 池 token 数（引擎启动行读数；未读到为 None）。
    pub device_pool_tokens: Option<u64>,
    /// 设备 KV 池页数（每页 64 token）。
    pub device_pool_pages: Option<u64>,
    /// 设备池取值来源：auto / explicit。
    pub capacity_configured: Option<String>,
    /// 最近一次超池的题面 token 数。
    pub over_pool_prompt_tokens: Option<u64>,
    /// 最近一次超池时的设备池 token 数。
    pub over_pool_pool_tokens: Option<u64>,
    pub port: Option<u16>,
    pub lan: Option<bool>,
    pub model_id: Option<String>,
    pub pid: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 实盘日志原文（2026-10-05，本机 engine.log）——解析必须以这些行为准。
    const CAPACITY_LINE: &str = "2026-10-05 11:31:12.388  INFO  capacity | KV 17,920 tokens, k8v4, auto | pages 280/280 | runtime 1.85 GiB | free 1.30 GiB";
    const OVER_POOL_LINE: &str = "[2026-10-05 11:59:19.206] [warning] ninfer-serve: prompt exceeds the resident Device KV pool: prompt 53377 tokens (835 pages) > pool 17920 tokens (280 pages). Part of the prompt is therefore not resident, and the MIDDLE of such a prompt has been measured to go missing with no error line, HTTP 200 and a plausible wrong answer; the root cause is not localized. Treat every answer to this request as unverified against its context, and raise --kv-capacity to at least the prompt's token count (measured: prompt >= pool is the condition that reproduces it) before reading a result. [This line repeats at most every 30 s while over-pool requests keep arriving; a MISSING line is never evidence that a request was safe.]";
    const CRASH_LINE: &str = "2026-10-05 11:59:19.235  ERROR engine | worker crash: Paged KV reservation invariant was violated";
    const DEMOTE_LINE: &str = "[ninfer] demote-other short: freed=0 want=702 slots=2 invalid=0 noresident=0 pins=0 stalehost=0 partial=1 dup=0 flushfail=0 declined=0 pending=0";
    const ADOPT_LINE: &str =
        "[ninfer] adopt host-backed: frontier=53366 need=834 usable=280 host_backed=702";
    const REQ_FAIL_503: &str = "2026-10-05 12:06:16.359  WARN  req#26 failed during prepare | openai-chat stream | HTTP 503 | service unavailable | messages 3";
    const REQ_FAIL_500: &str = "2026-10-05 11:59:19.236  ERROR req#25 failed during generation | openai-chat | HTTP 500 | internal error";
    const REQ_DONE: &str = "2026-10-05 12:15:58.000  INFO  req#30 done | openai-chat | stop token | prompt 19 | output 11 | cache 0 (0.0%) | TTFT 258 ms | total 288 ms";
    const READY_LINE: &str = "2026-10-05 11:31:12.388  INFO  engine ready | bonsai2-27b-heretic | total 6.6s | weights 8.16 GiB | CUDA sync auto";

    /// 供测试使用的引擎日志（复现 2026-10-05 11:59 那次打死）。
    fn crash_log() -> Vec<&'static str> {
        vec![
            READY_LINE,
            REQ_DONE,
            OVER_POOL_LINE,
            "2026-10-05 11:59:19.206  INFO  req#25 started | openai-chat stream | 36 messages | max output 32,768 | thinking xhigh | tools 25",
            ADOPT_LINE,
            DEMOTE_LINE,
            CRASH_LINE,
            REQ_FAIL_500,
            REQ_FAIL_503,
        ]
    }

    /// 用生产的分类 + 状态机跑一串日志行。
    fn record_from(lines: &[&str]) -> FaultRecord {
        let mut record = FaultRecord::default();
        for line in lines {
            if let Some(event) = classify_engine_log(line) {
                apply_fault_event(&mut record, event, parse_log_clock(line));
            }
        }
        record
    }

    /// 直接驱动故障状态机的单个事件（走生产代码同一条纯函数内核）。
    fn apply_event_to_record(record: &mut FaultRecord, event: LogEvent, clock: Option<String>) {
        apply_fault_event(record, event, clock);
    }

    /// 实测行必须解析出正确的池容量（千分位、页数、auto）。
    #[test]
    fn parses_capacity_line_from_real_log() {
        let capacity = parse_capacity_line(CAPACITY_LINE).expect("capacity line should parse");
        assert_eq!(capacity.pool_tokens, 17_920);
        assert_eq!(capacity.pages, 280);
        assert_eq!(capacity.configured, "auto");
    }

    /// 超池告警行必须解析出题面与池子两个数（超池提示的数据来源）。
    #[test]
    fn parses_over_pool_line_from_real_log() {
        let (prompt, pool) =
            parse_over_pool_line(OVER_POOL_LINE).expect("over-pool line should parse");
        assert_eq!(prompt, 53_377);
        assert_eq!(pool, 17_920);
    }

    /// 实盘崩溃序列：先超池，再 worker crash ⇒ 致命失效 + 必须重启。
    #[test]
    fn latches_worker_crash_from_real_log_sequence() {
        let record = record_from(&crash_log());
        assert_eq!(record.kind, Some(FaultKind::WorkerCrash));
        assert!(record.fatal, "worker 崩溃必须判为致命（需重启）");
        assert_eq!(record.at.as_deref(), Some("11:59:19"));
        assert_eq!(record.over_pool_prompt_tokens, Some(53_377));
        assert_eq!(record.over_pool_pool_tokens, Some(17_920));
        let status = fault_status_from_record(Some(record));
        assert!(status.degraded && status.requires_restart);
        assert_eq!(status.kind, Some("worker_crash"));
        assert!(status.reason.unwrap_or_default().contains("worker"));
    }

    /// worker 崩溃锁存后，即使随后有请求成功，也不能自动恢复（避免假恢复再次误报可用）。
    #[test]
    fn crash_stays_latched_after_later_success() {
        let mut lines = crash_log();
        lines.push(REQ_DONE);
        let record = record_from(&lines);
        assert_eq!(record.kind, Some(FaultKind::WorkerCrash));
        assert_eq!(record.completions_after_fault, 1, "成功计数只作存疑提示");
        assert!(record.fatal);
    }

    /// `engine ready` 代表新实例健康：清掉历史失效。
    #[test]
    fn engine_ready_clears_previous_fault() {
        let mut lines = crash_log();
        lines.push("2026-10-05 12:15:50.640  INFO  engine ready | bonsai2-27b-heretic | total 6.6s | weights 8.16 GiB | CUDA sync auto");
        let record = record_from(&lines);
        assert_eq!(record.kind, None);
        assert!(!record.fatal);
    }

    /// 连续两次 503 才判 worker 不可用；一次瞬时失败不误报。
    #[test]
    fn two_consecutive_503_degrade_but_single_one_does_not() {
        let record = record_from(&[READY_LINE, REQ_FAIL_503]);
        assert_eq!(record.kind, None, "单次 503 不应判失效");

        let second = "2026-10-05 12:06:29.977  WARN  req#27 failed during prepare | openai-chat stream | HTTP 503 | service unavailable | messages 3";
        let record = record_from(&[READY_LINE, REQ_FAIL_503, second]);
        assert_eq!(record.kind, Some(FaultKind::RequestsFailing));
        assert!(record.fatal);
        assert!(fault_status_from_record(Some(record)).requires_restart);
    }

    /// 客户端主动断开（HTTP 499）不是引擎故障。
    #[test]
    fn client_disconnect_is_not_a_fault() {
        let line = "2026-10-05 11:41:16.462  INFO  req#7 response failed during transport | HTTP 499 | client disconnected";
        assert_eq!(classify_engine_log(line), None);
    }

    /// 成功请求会清掉「连续失败」计数（避免把偶发失败累加成失效）。
    #[test]
    fn success_resets_failure_streak() {
        let mut record = FaultRecord::default();
        apply_event_to_record(
            &mut record,
            LogEvent::RequestFailed {
                fatal: true,
                req: Some(1),
                raw: REQ_FAIL_503.to_string(),
            },
            None,
        );
        assert_eq!(record.failure_streak, 1);
        apply_event_to_record(&mut record, LogEvent::RequestDone { req: Some(2) }, None);
        assert_eq!(record.failure_streak, 0);
        assert_eq!(record.kind, None);
    }

    /// 重启后读到的上一轮失败行（请求号更小）必须被忽略，否则会误判新实例失效。
    #[test]
    fn stale_failure_lines_are_ignored_after_restart() {
        let record = record_from(&[READY_LINE, REQ_DONE, REQ_FAIL_503, REQ_FAIL_503]);
        assert_eq!(record.kind, None, "req#26 早于已完成的 req#30，属过期行");
    }

    /// 只有超池（还没崩）时：判「降级但不必重启」，并带出池两个数。
    #[test]
    fn over_pool_alone_is_degraded_without_restart() {
        let record = record_from(&[READY_LINE, REQ_DONE, OVER_POOL_LINE]);
        let status = fault_status_from_record(Some(record));
        assert!(status.degraded);
        assert!(!status.requires_restart, "仅超池时不必强制重启");
        assert_eq!(status.kind, Some("over_pool"));
        assert_eq!(status.over_pool_prompt_tokens, Some(53_377));
        assert_eq!(status.over_pool_pool_tokens, Some(17_920));
        assert!(status.reason.unwrap_or_default().contains("设备 KV 池"));
    }

    /// 时间戳解析：引擎两种日志格式都要认。
    #[test]
    fn parses_both_log_clock_formats() {
        assert_eq!(parse_log_clock(CRASH_LINE).as_deref(), Some("11:59:19"));
        assert_eq!(parse_log_clock(OVER_POOL_LINE).as_deref(), Some("11:59:19"));
        assert_eq!(parse_log_clock("no timestamp here"), None);
    }

    /// 日志行带多字节 UTF-8（中文路径、中文说明）时不得 panic，且仍能解析出时间戳。
    /// 逐字节窗口若用下标切片，起点落在字符中间会直接 panic、日志读线程整个死掉。
    #[test]
    fn parse_log_clock_handles_multibyte_lines() {
        let line = "加载模型 D:\\模型\\bonsai2.ninfer 11:59:19.235 done";
        assert_eq!(parse_log_clock(line).as_deref(), Some("11:59:19"));
        assert_eq!(parse_log_clock("引擎日志：模型加载完成，等待请求"), None);
    }

    /// 应用重启后的回扫：日志尾部只见崩溃、之后没有 `engine ready` ⇒ 仍判失效。
    #[test]
    fn tail_scan_reports_crash_when_no_later_ready() {
        let lines: Vec<String> = crash_log().iter().map(|line| line.to_string()).collect();
        let record = fault_record_from_log_tail(&lines).expect("尾扫应判出 worker 崩溃");
        assert_eq!(record.kind, Some(FaultKind::WorkerCrash));
        assert!(record.fatal);
    }

    /// 崩溃之后又出现 `engine ready`（引擎已被重启）⇒ 不得误报失效。
    #[test]
    fn tail_scan_ignores_crash_followed_by_ready() {
        let mut lines: Vec<String> = crash_log().iter().map(|line| line.to_string()).collect();
        lines.push(READY_LINE.to_string());
        assert!(fault_record_from_log_tail(&lines).is_none());
    }

    /// 用本机真实 engine.log（64 KiB / 1.4 万行）验证回扫解析：日志里那唯一一条
    /// `worker crash` 必须被读出来（当且仅当其后没有新的 `engine ready`）。
    #[test]
    fn tail_scan_reads_real_engine_log() {
        let Some(path) = log_file_path() else {
            return; // 非 Windows/无数据目录：跳过
        };
        if !path.exists() {
            return; // 本机没跑过引擎：跳过
        }
        let lines = read_log_tail(&path, FAULT_SEED_TAIL_LINES).expect("should read log tail");
        assert!(!lines.is_empty(), "日志尾部不应为空");

        let crash_lines = lines
            .iter()
            .filter(|line| line.contains("Paged KV reservation invariant was violated"))
            .count();
        let ready_after_crash = {
            let last_crash = lines
                .iter()
                .rposition(|line| line.contains("Paged KV reservation invariant was violated"));
            last_crash.map_or(false, |index| {
                lines[index..]
                    .iter()
                    .any(|line| line.contains("engine ready |"))
            })
        };
        let detected = fault_record_from_log_tail(&lines);
        assert_eq!(
            detected.is_some(),
            crash_lines > 0 && !ready_after_crash,
            "回扫判定必须与日志事实一致（真实日志里 crash 行 {crash_lines} 条）"
        );
        if let Some(record) = detected {
            assert_eq!(record.kind, Some(FaultKind::WorkerCrash));
            assert!(record
                .raw_line
                .unwrap_or_default()
                .contains("Paged KV reservation invariant"));
        }
    }

    /// 无关行不产生事件（避免把普通日志当故障）。
    #[test]
    fn unrelated_lines_produce_no_event() {
        assert_eq!(classify_engine_log(DEMOTE_LINE), None);
        assert_eq!(classify_engine_log(ADOPT_LINE), None);
        assert_eq!(
            classify_engine_log("2026-10-05 11:52:27.498  INFO  throughput | 5.0s | running 0"),
            None
        );
    }

    #[test]
    fn build_args_matches_heretic_tuning() {
        // 测试密钥从环境变量读取，不在源码中落任何凭据字面量。
        let key = std::env::var("FAST27B_TEST_API_KEY").unwrap_or_default();
        let options = Fast27bStartOptions {
            engine_path: PathBuf::from(
                r"D:\Projects\Agent_LLM\app\resources\fast-llm\engine\ninfer-serve-86.exe",
            ),
            model_path: PathBuf::from(
                r"D:\Projects\Agent_LLM\app\resources\fast-llm\model\Ternary-Bonsai-2-27B-Heretic.ninfer",
            ),
            model_variant: Fast27bModel::Heretic,
            port: 8094,
            lan: false,
            api_key: key.clone(),
            context_window: 262144,
            draft_tokens: 4,
            default_max_tokens: 32768,
        };
        let args = options.build_args();
        let joined = args.join(" ");
        assert!(joined.contains("--host 127.0.0.1"));
        assert!(joined.contains("--port 8094"));
        assert!(joined.contains("--model-id qwen3.8-27b"));
        assert!(joined.contains("--max-context 262144"));
        // 12 GiB 卡的关键：设备池 auto + headroom 128 按剩余显存自适应。
        assert!(joined.contains("--kv-capacity auto"));
        assert!(joined.contains("--kv-headroom-mib 128"));
        assert!(joined.contains("--kv-dtype k8v4"));
        assert!(joined.contains("--host-kv-mib 16384"));
        assert!(joined.contains("--prefill-chunk 1024"));
        assert!(!joined.contains("--spec"));
        assert!(!joined.contains("--draft-tokens"));
        assert!(!joined.contains("--lm-head-draft"));
        assert!(joined.contains("--vision"));
        assert!(joined.contains("--vision-residency resident"));
        assert!(joined.contains("--presence-penalty 0"));
        assert!(joined.contains("--max-concurrency 1"));
        assert!(joined.contains("--max-shared-prefixes 0"));
        assert!(joined.contains("--gdn-state-fp16"));
        assert!(joined.contains("--default-reasoning-effort high"));
        // 默认输出上限跟随配置。
        assert!(joined.contains("--default-max-tokens 32768"));
        assert!(joined.contains("--api-key"));
        // --cors 是应用侧增补参数（自带对话跨域用），必须存在。
        assert!(joined.contains("--cors"));
        // api-key 值等于传入的 key（--cors 紧随其后）。
        let key_index = args
            .iter()
            .position(|arg| arg == "--api-key")
            .expect("--api-key missing");
        assert_eq!(
            args.get(key_index + 1).map(String::as_str),
            Some(key.as_str())
        );
        assert!(args[0].ends_with(".ninfer"));

        let lan_options = Fast27bStartOptions {
            lan: true,
            ..options
        };
        assert!(lan_options
            .build_args()
            .join(" ")
            .contains("--host 0.0.0.0"));
    }

    /// Swift 容器使用 BAT 中的 MTP 草稿头；Heretic 不带草稿参数，公共参数保持一致。
    #[test]
    fn swift_uses_mtp_without_changing_user_parameters() {
        let config = crate::models::app_state::Fast27bConfig::default();
        let heretic = Fast27bStartOptions {
            engine_path: PathBuf::from(&config.engine_path),
            model_path: PathBuf::from(&config.model_path),
            model_variant: Fast27bModel::Heretic,
            port: config.port,
            lan: config.lan,
            api_key: config.api_key,
            context_window: config.context_window,
            draft_tokens: config.draft_tokens,
            default_max_tokens: config.default_max_tokens,
        };
        let swift = Fast27bStartOptions {
            model_variant: Fast27bModel::Swift,
            ..heretic.clone()
        };
        let original = heretic.build_args();
        let switched = swift.build_args();
        assert!(!original.iter().any(|arg| arg == "--spec"));
        let spec_index = switched.iter().position(|arg| arg == "--spec").unwrap();
        assert_eq!(switched.get(spec_index + 1).map(String::as_str), Some("mtp"));
        assert!(switched.iter().any(|arg| arg == "--draft-tokens"));
        assert!(switched.iter().any(|arg| arg == "--lm-head-draft"));
        assert_eq!(original.iter().filter(|arg| arg.as_str() == "--vision-residency").count(), 1);
        assert_eq!(switched.iter().filter(|arg| arg.as_str() == "--vision-residency").count(), 1);
        assert!(original.join(" ").contains("--vision-residency resident"));
        assert!(switched.join(" ").contains("--vision-residency resident"));
    }

    /// 默认输出上限必须是「配置驱动」的：改了配置，命令行跟着变。
    #[test]
    fn build_args_follows_default_max_tokens_config() {
        let base = Fast27bStartOptions {
            engine_path: PathBuf::from(r"C:\engine\ninfer-serve-86.exe"),
            model_path: PathBuf::from(r"C:\model\x.ninfer"),
            model_variant: Fast27bModel::Heretic,
            port: 8094,
            lan: false,
            api_key: String::new(),
            context_window: 262144,
            draft_tokens: 4,
            default_max_tokens: 0,
        };

        // 0 = 不传该参数，交回引擎自身默认。
        let args = Fast27bStartOptions {
            default_max_tokens: 0,
            ..base.clone()
        }
        .build_args();
        assert!(
            !args.iter().any(|arg| arg == "--default-max-tokens"),
            "0 时不应传 --default-max-tokens，实际：{}",
            args.join(" ")
        );
        // 其余参数不受影响，--api-key 仍紧跟其后。
        assert!(args.iter().any(|arg| arg == "--api-key"));

        // 非 0 = 按配置下发。
        let args = Fast27bStartOptions {
            default_max_tokens: 32768,
            ..base.clone()
        }
        .build_args();
        let index = args
            .iter()
            .position(|arg| arg == "--default-max-tokens")
            .expect("--default-max-tokens missing");
        assert_eq!(args.get(index + 1).map(String::as_str), Some("32768"));

        // 上限不超过上下文窗口这一常识约束不在此处强制，但取值应原样透传（含 1）。
        let args = Fast27bStartOptions {
            default_max_tokens: 1,
            ..base
        }
        .build_args();
        let index = args
            .iter()
            .position(|arg| arg == "--default-max-tokens")
            .expect("--default-max-tokens missing");
        assert_eq!(args.get(index + 1).map(String::as_str), Some("1"));
    }

    /// 端到端：真实拉起引擎 → 探活 → 停止（需要 GPU、模型文件与本机空闲；默认忽略）。
    /// 运行：cargo test --lib fast27b_e2e -- --ignored
    #[test]
    #[ignore = "e2e: spawns the real engine (needs GPU + model file); run with --ignored"]
    fn fast27b_start_probe_stop_e2e() {
        let config = crate::models::app_state::Fast27bConfig::default();
        let options = Fast27bStartOptions {
            engine_path: PathBuf::from(&config.engine_path),
            model_path: PathBuf::from(&config.model_path),
            model_variant: config.selected_model(),
            port: config.port,
            lan: false,
            api_key: config.api_key.clone(),
            context_window: config.context_window,
            draft_tokens: config.draft_tokens,
            default_max_tokens: config.default_max_tokens,
        };
        start_fast27b(
            &options,
            |_| {},
            |_| {},
            |event| match event {
                Fast27bRuntimeEvent::Ready(url) => eprintln!("[e2e] ready: {url}"),
                Fast27bRuntimeEvent::Stopped(message) => eprintln!("[e2e] stopped: {message}"),
                Fast27bRuntimeEvent::Error(message) => eprintln!("[e2e] error: {message}"),
            },
        )
        .expect("start_fast27b failed");

        let deadline = Instant::now() + Duration::from_secs(90);
        let mut ready = false;
        while Instant::now() < deadline {
            if probe_models_available(config.port, &config.api_key) {
                ready = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        assert!(ready, "engine did not become ready within 90s");
        assert!(is_fast27b_running());
        let status = runtime_status();
        assert!(status.api_ready, "runtime_status should report api_ready");

        stop_fast27b().expect("stop_fast27b failed");
        std::thread::sleep(Duration::from_millis(800));
        assert!(
            !probe_models_available(config.port, &config.api_key),
            "engine should be down after stop"
        );
        assert!(!is_fast27b_running());
    }
}
