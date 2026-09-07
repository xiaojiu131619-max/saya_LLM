use std::collections::HashSet;
use std::io::{BufRead, BufReader};
use std::net::{IpAddr, TcpStream, ToSocketAddrs, UdpSocket};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
#[allow(non_snake_case, non_upper_case_globals, dead_code)]
mod job_guard {
    use std::sync::Mutex;

    type HANDLE = *mut std::ffi::c_void;

    // HANDLE 是裸指针，需要包装才能在线程间安全传递
    struct JobHandle(HANDLE);
    unsafe impl Send for JobHandle {}
    unsafe impl Sync for JobHandle {}

    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x00002000;
    const JOB_OBJECT_LIMIT_TERMINATE: u32 = 0x00000004;
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
            // 创建一个无名 Job Object
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                eprintln!("[server] Job Object 创建失败");
                return;
            }

            // 设置 KILL_ON_JOB_CLOSE：父进程退出时 OS 自动终止子进程
            let mut info = std::mem::zeroed::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

            let ret = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const u8,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ret == 0 {
                eprintln!("[server] SetInformationJobObject 失败");
                CloseHandle(job);
                return;
            }

            // 将子进程附加到 Job Object
            let ret = AssignProcessToJobObject(job, process_handle);
            if ret == 0 {
                eprintln!("[server] AssignProcessToJobObject 失败");
                CloseHandle(job);
                return;
            }

            if let Ok(mut guard) = JOB_HANDLE.lock() {
                *guard = Some(JobHandle(job));
            }
            eprintln!("[server] Job Object 已附加到子进程");
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

    pub fn cleanup() {
        if let Ok(mut guard) = JOB_HANDLE.lock() {
            if let Some(JobHandle(handle)) = guard.take() {
                unsafe {
                    CloseHandle(handle);
                }
            }
        }
    }
}

#[cfg(windows)]
use std::os::windows::io::AsRawHandle;

use anyhow::{bail, Result};
use once_cell::sync::Lazy;
use serde::Serialize;
use sysinfo::System;

use crate::models::ping_result::PingResult;
use crate::models::server_config::ServerConfig;
use crate::services::gguf_parser::parse_gguf_header;
use crate::services::model_scanner::mtp_draft_is_compatible;

static CHILD_PROCESS: Lazy<Mutex<Option<Child>>> = Lazy::new(|| Mutex::new(None));
static SERVER_LOGS: Lazy<Mutex<Vec<String>>> = Lazy::new(|| Mutex::new(Vec::new()));
static SYSTEM_LOGS: Lazy<Mutex<Vec<SystemLogEntry>>> = Lazy::new(|| Mutex::new(Vec::new()));

/// 单个模型的 token 累计（来自 llama-server `slot print_timing` 日志行）。
/// 对外 API / dsh / 应用内聊天请求都会产生这些日志行，在这里统一累计，
/// 前端据此把「经 llama-server 的全部 token 消耗」并入使用详情。
#[derive(Debug, Clone, Default, Serialize)]
pub struct TokenUsageAgg {
    pub model_name: String,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
    pub response_count: u64,
    /// 最近一次解析到的时间戳（毫秒），用于去抖。
    pub last_seen_ms: u64,
}

/// 全量 token 累计表：key = 模型 alias（同一次服务期间只有一个模型）。
static API_TOKEN_USAGE: Lazy<Mutex<Vec<TokenUsageAgg>>> = Lazy::new(|| Mutex::new(Vec::new()));
static LAST_SERVER_CONFIG: Lazy<Mutex<Option<ServerConfig>>> = Lazy::new(|| Mutex::new(None));
static SERVER_GENERATION: AtomicU64 = AtomicU64::new(0);

/// 系统日志条目：统一日志中枢的最小单元。
/// 所有来源（llama-server 输出、服务生命周期事件、API 请求）都汇聚到这里，
/// 带真实时间戳与分类，供前端「系统日志」页按时间轴展示。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemLogEntry {
    /// Unix 毫秒时间戳。
    pub timestamp: u64,
    /// 单调递增序列号，用于增量轮询时避免同毫秒日志丢失。
    pub seq: u64,
    /// debug | info | warn | error
    pub level: String,
    /// llama | server | api | app
    pub category: String,
    pub message: String,
}

const MAX_SYSTEM_LOGS: usize = 5000;

/// 日志序列号计数器，用于增量轮询时避免同毫秒日志丢失。
static LOG_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

const KNOWN_LLAMA_SERVER_TOOLS: &[&str] = &[
    "read_file",
    "file_glob_search",
    "grep_search",
    "exec_shell_command",
    "write_file",
    "edit_file",
    "apply_diff",
    "get_datetime",
];

#[derive(Debug, Default, PartialEq, Eq)]
struct ServerToolSelection {
    enabled: Vec<String>,
    ignored: Vec<String>,
}

fn parse_available_server_tools(help: &str) -> Option<HashSet<String>> {
    let normalized = help.to_ascii_lowercase();
    let (_, tail) = normalized.split_once("available tools:")?;
    let section = tail.chars().take(1024).collect::<String>();
    Some(
        KNOWN_LLAMA_SERVER_TOOLS
            .iter()
            .filter(|tool| section.contains(**tool))
            .map(|tool| (*tool).to_string())
            .collect(),
    )
}

fn probe_available_server_tools(exe: &str) -> std::io::Result<Option<HashSet<String>>> {
    let mut command = Command::new(exe);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let output = command.arg("--help").output()?;
    let help = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(parse_available_server_tools(&help))
}

fn select_server_tools(
    configured: Option<&str>,
    available: Option<&HashSet<String>>,
) -> ServerToolSelection {
    let Some(configured) = configured.map(str::trim).filter(|value| !value.is_empty()) else {
        return ServerToolSelection::default();
    };
    let fallback = KNOWN_LLAMA_SERVER_TOOLS
        .iter()
        .map(|tool| (*tool).to_string())
        .collect::<HashSet<_>>();
    let available = available.unwrap_or(&fallback);
    let mut selection = ServerToolSelection::default();
    let mut seen = HashSet::new();

    for requested in configured
        .split(',')
        .map(str::trim)
        .filter(|tool| !tool.is_empty())
    {
        let requested = requested.to_ascii_lowercase();
        if requested == "all" {
            for tool in KNOWN_LLAMA_SERVER_TOOLS {
                if available.contains(*tool) && seen.insert((*tool).to_string()) {
                    selection.enabled.push((*tool).to_string());
                }
            }
            continue;
        }
        if !KNOWN_LLAMA_SERVER_TOOLS.contains(&requested.as_str())
            || !available.contains(&requested)
        {
            if seen.insert(format!("ignored:{requested}")) {
                selection.ignored.push(requested);
            }
            continue;
        }
        if seen.insert(requested.clone()) {
            selection.enabled.push(requested);
        }
    }
    selection
}

fn server_tools_are_protected(host: &str, api_key: Option<&str>) -> bool {
    if api_key.is_some_and(|key| !key.trim().is_empty()) {
        return true;
    }
    let normalized = host.trim().trim_start_matches('[').trim_end_matches(']');
    normalized.eq_ignore_ascii_case("localhost")
        || normalized
            .parse::<IpAddr>()
            .map(|address| address.is_loopback())
            .unwrap_or(false)
}

fn append_server_tools(
    cmd: &mut Command,
    exe: &str,
    configured: Option<&str>,
    host: &str,
    api_key: Option<&str>,
) {
    if configured.is_some_and(|tools| !tools.trim().is_empty())
        && !server_tools_are_protected(host, api_key)
    {
        let message = "[server] 出于安全考虑，已阻止在非本机监听且未设置 API key 时公开 llama.cpp 原生工具；设置 API key 或改回本机监听后可重新启用。";
        eprintln!("{}", message);
        add_log(message);
        return;
    }
    let available = match probe_available_server_tools(exe) {
        Ok(Some(tools)) => Some(tools),
        Ok(None) => Some(HashSet::new()),
        Err(error) => {
            let message = format!(
                "[server] 无法读取 llama-server 工具能力，使用兼容白名单：{}",
                error
            );
            eprintln!("{}", message);
            add_log(&message);
            None
        }
    };
    let selection = select_server_tools(configured, available.as_ref());
    if !selection.ignored.is_empty() {
        let message = format!(
            "[server] 已忽略非原生或当前内核不支持的工具：{}",
            selection.ignored.join(", ")
        );
        eprintln!("{}", message);
        add_log(&message);
    }
    if !selection.enabled.is_empty() {
        cmd.arg("--tools").arg(selection.enabled.join(","));
        // 内核在启用 server tools 时会把默认 CORS 收紧为仅允许 http://localhost
        //（"for security reasons, this will limit --cors-origins to localhost"），
        // 而本应用 WebView 的 origin 是 http://tauri.localhost，会被浏览器拦截，
        // 对话请求直接 Failed to fetch。显式传回通配符即可恢复默认的 Origin 回显。
        // 注意 b10687 实测：--cors-origins 的逗号分隔列表与多次传参都有缺陷
        //（整串当单值回显 / 仅最后一个生效），只有 "*" 行为正确。
        cmd.arg("--cors-origins").arg("*");
    }
}

#[derive(Clone, Serialize)]
pub struct ServerProgress {
    pub progress: u32,
    pub stage: String,
    pub log: String,
}

#[derive(Clone, Serialize)]
pub struct ServerError {
    pub error_type: String,
    pub title: String,
    pub details: String,
    pub suggestions: Vec<String>,
}

fn build_redacted_command_line(exe: &str, cmd: &Command) -> String {
    let mut s = exe.to_string();
    // 对 --api-key 后紧跟的实参做脱敏，避免明文密钥进入日志缓冲（会被 get_server_logs 回传前端）与 stderr。
    let mut redact_next = false;
    for a in cmd.get_args() {
        s.push(' ');
        if redact_next {
            s.push_str("***");
            redact_next = false;
            continue;
        }
        if a == "--api-key" {
            redact_next = true;
        }
        s.push_str(&a.to_string_lossy());
    }
    s
}

pub(crate) fn is_allowed_exe_name(name: &str) -> bool {
    matches!(name, "llama-server.exe" | "llama-bench.exe" | "llama-cli.exe" | "llama-quantize.exe" | "llama-fit-params.exe")
}

/// 把用户/配置提供的可执行文件路径解析为实际可用的路径。
///
/// 解析结果一定会被交给 `Command::new` 执行，所以这里是安全边界：
/// 绝对路径必须同时通过「允许目录」和「白名单文件名」两道检查，
/// 无法通过则返回空串，由调用方按“未找到”处理。
pub(crate) fn resolve_exe_path(path: &str) -> String {
    let requested = Path::new(path);
    if requested.is_absolute() && requested.exists() {
        // 只允许 resources 目录或 exe 同目录下的可执行文件。
        // 必须先 canonicalize：Path::starts_with 是按组件比较的，不会解析 `..`，
        // 否则 `<exe_dir>\resources\..\..\evil\llama-server.exe` 能骗过目录检查。
        let canonical_requested = match requested.canonicalize() {
            Ok(p) => p,
            Err(error) => {
                eprintln!("[server] 无法规范化可执行文件路径 {}: {}", path, error);
                return String::new();
            }
        };
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|e| e.parent().map(|d| d.to_path_buf()));
        let allowed_dirs: Vec<PathBuf> = [
            exe_dir.as_ref().map(|d| d.join("resources")),
            exe_dir.as_ref().and_then(|d| d.parent().map(|g| g.join("resources"))),
            exe_dir.clone(),
            // 用户指定的自编译核心所在目录：同样只放行该目录与白名单文件名。
            crate::services::auto_updater::kernel_override()
                .and_then(|p| p.parent().map(|d| d.to_path_buf())),
        ]
        .into_iter()
        .flatten()
        .filter_map(|d| d.canonicalize().ok())
        .collect();
        let is_allowed = allowed_dirs
            .iter()
            .any(|d| canonical_requested.starts_with(d));
        if !is_allowed {
            eprintln!("[server] 拒绝非允许路径的可执行文件: {}", path);
            return String::new();
        }
        if !is_allowed_exe_name(
            canonical_requested
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(""),
        ) {
            eprintln!("[server] 拒绝非白名单的可执行文件名: {}", path);
            return String::new();
        }
        return path.to_string();
    }

    let fname = requested
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path);
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|d| d.to_path_buf()));
    let grandparent = exe_dir
        .as_ref()
        .and_then(|d| d.parent().map(|p| p.to_path_buf()));

    let candidates: Vec<PathBuf> = [
        // 用户指定的自编译核心优先；路径失效时自然落回版本化目录与内置 resources。
        crate::services::auto_updater::kernel_override(),
        // 版本化核心目录优先：kernels/<版本>_<时间>/ 里的最新一个。
        crate::services::auto_updater::active_kernel_exe(),
        exe_dir
            .as_ref()
            .map(|d| d.join("_up_").join("resources").join(fname)),
        grandparent
            .as_ref()
            .map(|g| g.join("_up_").join("resources").join(fname)),
        exe_dir.as_ref().map(|d| d.join("resources").join(fname)),
        grandparent
            .as_ref()
            .map(|g| g.join("resources").join(fname)),
        exe_dir.as_ref().map(|d| d.join(fname)),
        exe_dir.as_ref().map(|d| d.join(path)),
        Some(PathBuf::from(format!("_up_/resources/{}", fname))),
        Some(PathBuf::from(format!("resources/{}", fname))),
        Some(PathBuf::from(format!("../{}", path))),
        Some(PathBuf::from(format!("./{}", path))),
        Some(PathBuf::from(format!("./{}", fname))),
        Some(PathBuf::from(format!("../resources/{}", fname))),
        Some(PathBuf::from(format!("../../resources/{}", fname))),
        Some(PathBuf::from(path)),
        Some(PathBuf::from(fname)),
    ]
    .into_iter()
    .flatten()
    .collect();

    for c in &candidates {
        if c.exists() {
            if let Some(name) = c.file_name().and_then(|n| n.to_str()) {
                if is_allowed_exe_name(name) {
                    eprintln!("[server] resolved exe: {}", c.display());
                    return c.to_string_lossy().to_string();
                }
                eprintln!("[server] 跳过非白名单文件: {}", c.display());
            }
        }
    }
    eprintln!("[server] exe not found, tried: {:?}", candidates);
    String::new()
}

#[derive(Debug, Clone, Serialize)]
pub struct VideoRuntimeInfo {
    pub ffmpeg_available: bool,
    pub ffprobe_available: bool,
    pub native_video_ready: bool,
    pub ffmpeg_path: Option<String>,
    pub ffprobe_path: Option<String>,
}

fn media_binary_file_name(stem: &str) -> String {
    if cfg!(windows) {
        format!("{}.exe", stem)
    } else {
        stem.to_string()
    }
}

fn push_unique_dir(dirs: &mut Vec<PathBuf>, path: PathBuf) {
    if path.as_os_str().is_empty() || dirs.iter().any(|existing| existing == &path) {
        return;
    }
    dirs.push(path);
}

fn media_search_dirs(server_exe: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(parent) = server_exe.parent() {
        push_unique_dir(&mut dirs, parent.to_path_buf());
    }

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(app_dir) = current_exe.parent() {
            push_unique_dir(&mut dirs, app_dir.to_path_buf());
            push_unique_dir(&mut dirs, app_dir.join("_up_").join("resources"));
            push_unique_dir(&mut dirs, app_dir.join("resources"));
            if let Some(parent) = app_dir.parent() {
                push_unique_dir(&mut dirs, parent.join("_up_").join("resources"));
                push_unique_dir(&mut dirs, parent.join("resources"));
            }
        }
    }

    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            push_unique_dir(&mut dirs, dir);
        }
    }
    dirs
}

fn find_media_binary(server_exe: &Path, stem: &str) -> Option<PathBuf> {
    let file_name = media_binary_file_name(stem);
    media_search_dirs(server_exe)
        .into_iter()
        .map(|dir| dir.join(&file_name))
        .find(|candidate| candidate.is_file())
}

fn video_runtime_info_for_exe(server_exe: &Path) -> VideoRuntimeInfo {
    let ffmpeg = find_media_binary(server_exe, "ffmpeg");
    let ffprobe = find_media_binary(server_exe, "ffprobe");
    VideoRuntimeInfo {
        ffmpeg_available: ffmpeg.is_some(),
        ffprobe_available: ffprobe.is_some(),
        native_video_ready: ffmpeg.is_some() && ffprobe.is_some(),
        ffmpeg_path: ffmpeg.map(|path| path.to_string_lossy().to_string()),
        ffprobe_path: ffprobe.map(|path| path.to_string_lossy().to_string()),
    }
}

/// 独立检测 ffmpeg/ffprobe 是否就绪（服务未启动时也可调用），
/// 供前端在「视频候选」提示里说明原生视频所需的工具是否齐全。
pub fn check_video_runtime() -> VideoRuntimeInfo {
    // 搜索目录主要依赖 current_exe 与 PATH；llama-server 路径能解析时再补上它的同级目录。
    let server_exe = resolve_exe_path("resources/llama-server.exe");
    if server_exe.is_empty() {
        let fallback = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("agent-llm.exe"));
        video_runtime_info_for_exe(&fallback)
    } else {
        video_runtime_info_for_exe(Path::new(&server_exe))
    }
}

fn configure_media_runtime_path(command: &mut Command, server_exe: &Path) -> VideoRuntimeInfo {
    let info = video_runtime_info_for_exe(server_exe);
    let mut prepended = Vec::new();
    for path in [&info.ffmpeg_path, &info.ffprobe_path]
        .into_iter()
        .flatten()
    {
        if let Some(parent) = Path::new(path).parent() {
            push_unique_dir(&mut prepended, parent.to_path_buf());
        }
    }

    if !prepended.is_empty() {
        if let Some(existing) = std::env::var_os("PATH") {
            for dir in std::env::split_paths(&existing) {
                push_unique_dir(&mut prepended, dir);
            }
        }
        if let Ok(path) = std::env::join_paths(prepended) {
            command.env("PATH", path);
        }
    }
    info
}

pub fn get_video_runtime_info() -> VideoRuntimeInfo {
    let configured_exe = LAST_SERVER_CONFIG
        .lock()
        .ok()
        .and_then(|config| config.as_ref().map(|value| value.executable_path.clone()))
        .unwrap_or_else(|| "resources/llama-server.exe".to_string());
    let resolved = resolve_exe_path(&configured_exe);
    video_runtime_info_for_exe(Path::new(&resolved))
}

fn same_path(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(aa), Ok(bb)) => aa == bb,
        _ => a == b,
    }
}

fn stop_stale_servers_for_exe(exe: &str) {
    let exe_path = Path::new(exe);
    let mut system = System::new_all();
    system.refresh_processes();

    let process_name = media_binary_file_name("llama-server");
    let mut stopped = 0usize;
    for process in system.processes_by_exact_name(&process_name) {
        if let Some(process_exe) = process.exe() {
            if same_path(process_exe, exe_path) {
                eprintln!(
                    "[server] stopping stale llama-server pid={:?} path={}",
                    process.pid(),
                    process_exe.display()
                );
                if process.kill() {
                    stopped += 1;
                }
            }
        }
    }

    if stopped > 0 {
        eprintln!(
            "[server] stopped {} stale llama-server process(es)",
            stopped
        );
        std::thread::sleep(Duration::from_millis(400));
    }
}

fn parse_progress(line: &str) -> u32 {
    if line.contains("server is listening") {
        return 100;
    }
    if line.contains("model loaded") {
        return 92;
    }
    if line.to_ascii_lowercase().contains("model buffer size") {
        return 85;
    }

    if line.contains("offloaded ") {
        if let Some(caps) = line.find("offloaded ") {
            let rest = &line[caps + 10..];
            if let Some(slash) = rest.find('/') {
                let done: u32 = rest[..slash].trim().parse().unwrap_or(0);
                let rest2 = &rest[slash + 1..];
                let end: u32 = rest2
                    .split_whitespace()
                    .next()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(1);
                if end > 0 {
                    return 20 + ((done * 60).checked_div(end).unwrap_or(1).min(65));
                }
            }
        }
    }
    if line.contains("offload") {
        return 40;
    }
    if line.contains("llama_new_context_with_model") {
        return 82;
    }
    if line.contains("fitting params") {
        return 30;
    }
    if line.contains("KV cache") {
        return 75;
    }
    if line.contains("loading model") || line.contains("load_model") {
        return 12;
    }
    if line.contains("llama_init_from_file") {
        return 22;
    }
    if line.contains("ggml init") || line.contains("initialize ggml") {
        return 5;
    }
    if line.contains("System info") || line.contains("system info") {
        return 3;
    }
    if line.contains("llama") && line.contains("build") {
        return 2;
    }
    5
}

fn stage_name(progress: u32) -> String {
    match progress {
        0..=15 => "启动推理引擎...".into(),
        16..=35 => "分析模型参数...".into(),
        36..=55 => "加载模型权重...".into(),
        56..=85 => "加载模型到显存...".into(),
        86..=99 => "初始化服务...".into(),
        _ => "服务就绪".into(),
    }
}

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

fn is_external_bind_host(host: &str) -> bool {
    let normalized = host.trim().trim_start_matches('[').trim_end_matches(']');
    if matches!(normalized, "0.0.0.0" | "::") {
        return true;
    }
    if normalized.eq_ignore_ascii_case("localhost") {
        return false;
    }
    normalized
        .parse::<IpAddr>()
        .map(|address| !address.is_loopback() && !address.is_unspecified())
        .unwrap_or(false)
}

fn discover_lan_ip() -> Option<IpAddr> {
    for probe in ["1.1.1.1:80", "8.8.8.8:80"] {
        let Ok(socket) = UdpSocket::bind("0.0.0.0:0") else {
            continue;
        };
        if socket.connect(probe).is_err() {
            continue;
        }
        let Ok(address) = socket.local_addr().map(|address| address.ip()) else {
            continue;
        };
        if !address.is_loopback() && !address.is_unspecified() {
            return Some(address);
        }
    }
    None
}

fn external_host_for_bind(host: &str, detected_lan_ip: Option<IpAddr>) -> Option<String> {
    let normalized = host.trim().trim_start_matches('[').trim_end_matches(']');
    if matches!(normalized, "0.0.0.0" | "::") {
        return detected_lan_ip.map(|address| address.to_string());
    }
    is_external_bind_host(normalized).then(|| normalized.to_string())
}

pub fn lan_ip_address() -> Option<String> {
    discover_lan_ip().map(|address| address.to_string())
}

fn port_is_listening(config: &ServerConfig) -> bool {
    let addr = format!("{}:{}", health_check_host(config), config.port);
    let Ok(addrs) = addr.to_socket_addrs() else {
        return false;
    };

    addrs
        .into_iter()
        .any(|addr| TcpStream::connect_timeout(&addr, Duration::from_millis(150)).is_ok())
}

fn wait_for_port_release(config: &ServerConfig, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if !port_is_listening(config) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    !port_is_listening(config)
}

fn detect_error(line: &str) -> Option<ServerError> {
    let line_lower = line.to_lowercase();

    // Some llama.cpp builds can crash during the empty warmup pass after the
    // model is already loaded. Treat it as a launch failure with actionable
    // GPU/parameter guidance instead of leaving the frontend waiting.
    if line_lower.contains("ggml_assert(buffer)")
        || line_lower.contains("assert(buffer)")
        || (line_lower.contains("warm")
            && line_lower.contains("buffer")
            && line_lower.contains("failed"))
    {
        return Some(ServerError {
            error_type: "warmup".into(),
            title: "模型预热失败".into(),
            details: line.into(),
            suggestions: vec![
                "这是 llama.cpp 预热阶段失败，请先查看 [server] spawn 命令确认当前显式参数".into(),
                "如果仍然失败，再手动降低 GPU 卸载层数或上下文长度后重试".into(),
                "显存接近上限时，关闭 mlock 并改用更小的 KV 缓存类型".into(),
            ],
        });
    }

    if line_lower.contains("invalid device")
        || (line_lower.contains("unknown device") && line_lower.contains("device"))
    {
        return Some(ServerError {
            error_type: "device".into(),
            title: "加速设备无效".into(),
            details: line.into(),
            suggestions: vec![
                "当前内核没有该设备。NVIDIA 请用 CUDA 包，AMD / Intel 请用 Vulkan 包。".into(),
                "请到「核心更新」下载与本机匹配的官方包后重试，不要在 Vulkan 内核上指定 CUDA0。".into(),
            ],
        });
    }

    if line_lower.contains("vulkan error")
        || line_lower.contains("vk_error")
        || (line_lower.contains("ggml-vulkan") && line_lower.contains("failed"))
        || (line_lower.contains("vulkan")
            && (line_lower.contains("failed to") || line_lower.contains("not found")))
    {
        return Some(ServerError {
            error_type: "vulkan".into(),
            title: "Vulkan 错误".into(),
            details: line.into(),
            suggestions: vec![
                "确认已安装 AMD / Intel 官方显卡驱动，并且 Vulkan 可用。".into(),
                "在「核心更新」下载 Vulkan 版 llama.cpp，不要使用 CUDA 包。".into(),
                "可先降低 GPU 卸载层数或上下文长度后重试。".into(),
            ],
        });
    }

    // CUDA errors - broad matching
    if line_lower.contains("cuda error")
        || line_lower.contains("cuda init")
        || line_lower.contains("cudamalloc")
        || line_lower.contains("failed to initialize cuda")
        || line_lower.contains("no cuda device")
        || line_lower.contains("no cuda")
        || (line_lower.contains("failed") && line_lower.contains("cuda"))
        || (line_lower.contains("nvcc") && line_lower.contains("not found"))
        || line_lower.contains("could not find cuda")
        || line_lower.contains("cuda driver")
        || line_lower.contains("cuda dll")
        // Blackwell / sm_120 特有的错误——llama.cpp 里缺少 kernel image 的经典报错
        || line_lower.contains("no kernel image is available for execution on the device")
        || (line_lower.contains("no kernel") && line_lower.contains("available"))
        || (line_lower.contains("cuda") && line_lower.contains("not supported"))
        || line_lower.contains("cublas_status_not_supported")
        || line_lower.contains("unsupported gpu architecture")
        || (line_lower.contains("ptx") && line_lower.contains("jit"))
    {
        // 如果日志里包含 sm_120 / Blackwell 线索，给针对性建议
        let is_blackwell = line_lower.contains("sm_120")
            || line_lower.contains("blackwell")
            || line_lower.contains("sm 120")
            || line_lower.contains("compute capability 12");
        let suggestions = if is_blackwell
            || line_lower.contains("no kernel image is available for execution on the device")
        {
            vec![
                "你的 NVIDIA 50 系显卡 (Blackwell/sm_120) 需要 CUDA 12.8+ 的 llama.cpp 构建才能原生运行。".into(),
                "当前安装的内核版本太低，不包含 sm_120 kernel——请到设置 → llama.cpp 内核 → 检查更新，然后更新到 cuda-12.8 或更新的包。".into(),
                "如果更新后仍有问题，请确认 NVIDIA 驱动版本 ≥580，或手动安装最新驱动后重试。".into(),
            ]
        } else {
            vec![
                "更新 NVIDIA 驱动".into(),
                "确保 CUDA 驱动版本与 llama-server 兼容".into(),
                "检查 resources/ 目录下的 DLL 是否完整".into(),
            ]
        };
        return Some(ServerError {
            error_type: "cuda".into(),
            title: "CUDA 错误".into(),
            details: line.into(),
            suggestions,
        });
    }

    // OOM
    if line_lower.contains("out of memory")
        || line_lower.contains("cuda oom")
        || line_lower.contains("out of vram")
        || (line_lower.contains("allocate") && line_lower.contains("failed"))
    {
        return Some(ServerError {
            error_type: "oom".into(),
            title: "显存不足".into(),
            details: line.into(),
            suggestions: vec![
                "降低 GPU 卸载层数".into(),
                "减少上下文长度".into(),
                "使用更小的量化模型".into(),
            ],
        });
    }

    // Model errors
    if line_lower.contains("error loading model")
        || line_lower.contains("unknown format")
        || line_lower.contains("invalid model")
        || line_lower.contains("failed to load model")
    {
        return Some(ServerError {
            error_type: "model".into(),
            title: "模型格式错误".into(),
            details: line.into(),
            suggestions: vec!["检查模型文件是否完整".into(), "更新 llama.cpp 版本".into()],
        });
    }

    // Port conflict
    if line.contains("Address already in use")
        || line.contains("bind() failed")
        || (line_lower.contains("port") && line_lower.contains("in use"))
    {
        return Some(ServerError {
            error_type: "port".into(),
            title: "端口被占用".into(),
            details: line.into(),
            suggestions: vec![
                "关闭占用该端口的程序".into(),
                "在设置中修改默认端口".into(),
            ],
        });
    }

    // Llama load failure（排除可恢复的警告）
    if line_lower.contains("failed")
        && (line_lower.contains("llama") || line_lower.contains("model"))
        && !line_lower.contains("memory slot")
        && !line_lower.contains("mlock")
        && !line_lower.contains("retrying")
    {
        return Some(ServerError {
            error_type: "load".into(),
            title: "加载失败".into(),
            details: line.into(),
            suggestions: vec![
                "检查 llama-server.exe 是否匹配当前 GPU".into(),
                "尝试手动运行 llama-server.exe 查看具体错误".into(),
            ],
        });
    }

    None
}

#[allow(dead_code)]
fn start_server_once_legacy<F: Fn(ServerProgress) + Send + 'static>(
    config: &ServerConfig,
    on_progress: F,
    on_ready: impl Fn() + Send + Sync + 'static,
    on_error: impl Fn(ServerError) + Send + Sync + 'static,
) -> Result<()> {
    eprintln!(
        "[server] start_server called with: ngl={}, n_ctx={}, host={}, port={}",
        config.ngl,
        config.n_ctx,
        bind_host(config),
        config.port
    );

    {
        let mut guard = CHILD_PROCESS.lock().map_err(|e| anyhow::anyhow!("进程管理器 Mutex 已中毒: {}", e))?;
        if let Some(mut old_child) = guard.take() {
            eprintln!("[server] stopping existing server before restart...");
            let _ = old_child.kill();
            let _ = old_child.wait();
        }
    }

    let exe = resolve_exe_path(&config.executable_path);
    eprintln!("[server] resolved exe path: {}", exe);
    if !Path::new(&exe).exists() {
        return Err(anyhow::anyhow!(
            "找不到 llama-server.exe (搜索路径: {})。请在设置中指定正确路径，或将其放入 resources/ 目录。",
            exe
        ));
    }

    stop_stale_servers_for_exe(&exe);
    clear_logs();

    // Honor the configured ngl exactly. The detail page defaults the slider to
    // the model's full layer count, so an untouched config still offloads every
    // layer — but if the user (or Auto-Tune) lowered ngl, we respect that here
    // instead of forcing it back to max.
    let effective_ngl = config.ngl;
    eprintln!("[server] using configured ngl={}", effective_ngl);
    let host = bind_host(config);

    let mut cmd = Command::new(&exe);
    configure_media_runtime_path(&mut cmd, Path::new(&exe));
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    cmd.arg("-m")
        .arg(&config.model_path)
        .arg("--port")
        .arg(config.port.to_string())
        .arg("--host")
        .arg(&host)
        .arg("-ngl")
        .arg(effective_ngl.to_string())
        .arg("-c")
        .arg(config.n_ctx.to_string())
        .arg("-b")
        .arg(config.batch_size.to_string());

    if let Some(alias) = config.model_alias.as_deref().filter(|a| !a.is_empty()) {
        cmd.arg("--alias").arg(alias);
    }

    if config.ubatch_size > 0 {
        cmd.arg("-ub").arg(config.ubatch_size.to_string());
    }
    if config.threads > 0 {
        cmd.arg("-t").arg(config.threads.to_string());
    }
    if config.parallel > 0 {
        cmd.arg("-np").arg(config.parallel.to_string());
    }

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    cmd.arg("--flash-attn")
        .arg(if config.flash_attn { "on" } else { "off" });
    if !config.kv_offload {
        cmd.arg("--no-kv-offload");
    }
    cmd.arg(if config.kv_unified {
        "--kv-unified"
    } else {
        "--no-kv-unified"
    });
    cmd.arg(if config.mmap { "--mmap" } else { "--no-mmap" });
    if config.mlock {
        cmd.arg("--mlock");
    }
    if config.no_warmup {
        cmd.arg("--no-warmup");
    }
    if config.no_cuda {
        cmd.arg("--device").arg("none");
    }
    if config.ncmoe > 0 {
        cmd.arg("-ncmoe").arg(config.ncmoe.to_string());
    }
    append_server_tools(
        &mut cmd,
        &exe,
        config.tools.as_deref(),
        &host,
        config.api_key.as_deref(),
    );
    if let Some(api_key) = config
        .api_key
        .as_ref()
        .map(|key| key.trim())
        .filter(|key| !key.is_empty())
    {
        cmd.arg("--api-key").arg(api_key);
    }
    if config.cache_type_k_enabled && !config.cache_type_k.trim().is_empty() {
        cmd.arg("-ctk").arg(&config.cache_type_k);
    }
    if config.cache_type_v_enabled && !config.cache_type_v.trim().is_empty() {
        cmd.arg("-ctv").arg(&config.cache_type_v);
    }
    if let Some(value) = config.rope_freq_base {
        if value > 0.0 {
            cmd.arg("--rope-freq-base").arg(value.to_string());
        }
    }
    if let Some(value) = config.rope_freq_scale {
        if value > 0.0 {
            cmd.arg("--rope-freq-scale").arg(value.to_string());
        }
    }
    if let Some(seed) = config.seed {
        cmd.arg("-s").arg(seed.to_string());
    }
    if let Some(template) = config
        .chat_template
        .as_ref()
        .map(|template| template.trim())
        .filter(|template| !template.is_empty())
    {
        cmd.arg("--chat-template").arg(template);
    }

    // Print the exact command line so the user can copy-paste and test manually.
    eprintln!(
        "[server] spawn: {}",
        build_redacted_command_line(&exe, &cmd)
    );

    let mut child = cmd.spawn()?;
    eprintln!("[server] child pid = {:?}", child.id());

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    {
        let mut guard = CHILD_PROCESS.lock().map_err(|e| anyhow::anyhow!("进程管理器 Mutex 已中毒: {}", e))?;
        *guard = Some(child);
    }

    // 附加 Job Object：确保父进程崩溃时子进程被 OS 回收
    #[cfg(windows)]
    {
        if let Some(guard) = CHILD_PROCESS.lock().ok().as_mut().and_then(|g| g.as_mut()) {
            job_guard::attach(guard.as_raw_handle());
        }
    }

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

    // Whichever signals readiness/failure first wins; the guard makes sure the
    // frontend only ever receives one terminal event.
    let fired = Arc::new(AtomicBool::new(false));
    let on_ready = Arc::new(on_ready);
    let on_error = Arc::new(on_error);

    // HTTP health-check fallback: the log line "server is listening" can be
    // missed (buffering, reworded across llama.cpp versions), which previously
    // left the loading screen stuck forever. Polling /health is authoritative.
    {
        let fired = fired.clone();
        let on_ready = on_ready.clone();
        let port = config.port;
        let health_host = health_check_host(config);
        let api_key = config
            .api_key
            .as_ref()
            .map(|key| key.trim().to_string())
            .filter(|key| !key.is_empty());
        std::thread::spawn(move || {
            let client = match reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(2))
                .build()
            {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("[server] health-check client build failed: {}", e);
                    return;
                }
            };
            let url = format!("http://{}:{}/health", health_host, port);
            eprintln!("[server] health-check polling {}", url);
            let deadline = Instant::now() + Duration::from_secs(600);
            while Instant::now() < deadline {
                // Give up if the process already died.
                if !is_server_running() {
                    eprintln!("[server] health-check abort: process died");
                    return;
                }
                let request = client.get(&url);
                let request = if let Some(key) = &api_key {
                    request.bearer_auth(key)
                } else {
                    request
                };
                if let Ok(resp) = request.send() {
                    if resp.status().is_success() {
                        eprintln!("[server] health-check ready ({})", resp.status());
                        if !fired.swap(true, Ordering::SeqCst) {
                            on_ready();
                        }
                        return;
                    }
                }
                std::thread::sleep(Duration::from_millis(500));
            }
            eprintln!("[server] health-check timed out after 600s");
        });
    }

    std::thread::spawn(move || {
        let mut max_progress = 0u32;
        for line in rx {
            add_log(&line);
            let p = parse_progress(&line);
            if p > max_progress {
                max_progress = p;
            }
            on_progress(ServerProgress {
                progress: max_progress,
                stage: stage_name(max_progress),
                log: line.clone(),
            });

            if line.contains("server is listening") {
                if !fired.swap(true, Ordering::SeqCst) {
                    on_ready();
                }
                return;
            }

            if let Some(err) = detect_error(&line) {
                if !fired.swap(true, Ordering::SeqCst) {
                    on_error(err);
                }
                return;
            }
        }

        // Log stream ended. If we never signaled readiness, the process bailed
        // before listening — report a failure (unless the health check already
        // declared success).
        if !fired.swap(true, Ordering::SeqCst) {
            eprintln!(
                "[server] log stream ended without ready/error signal — process exited early"
            );
            on_error(ServerError {
                error_type: "unknown".into(),
                title: "启动失败".into(),
                details: "进程异常退出，请在 llama.cpp 目录下手动运行 llama-server.exe 测试".into(),
                suggestions: vec![
                    "检查模型文件路径是否正确".into(),
                    "在命令行手动测试: llama-server.exe -m 模型路径".into(),
                    "检查显卡驱动是否正常".into(),
                ],
            });
        }
    });

    Ok(())
}

enum MonitorResult {
    Ready,
    Error(ServerError),
    Exited,
    TimedOut,
}

fn server_request(
    client: &reqwest::blocking::Client,
    url: &str,
    api_key: Option<&str>,
) -> reqwest::blocking::RequestBuilder {
    let request = client.get(url);
    if let Some(key) = api_key {
        request.bearer_auth(key)
    } else {
        request
    }
}

fn models_endpoint_ready(
    client: &reqwest::blocking::Client,
    models_url: &str,
    api_key: Option<&str>,
) -> bool {
    match server_request(client, models_url, api_key).send() {
        Ok(resp) if resp.status().is_success() => match resp.json::<serde_json::Value>() {
            Ok(json) => json
                .get("data")
                .and_then(|data| data.as_array())
                .is_some_and(|models| {
                    models.iter().any(|model| {
                        model
                            .get("id")
                            .and_then(|id| id.as_str())
                            .is_some_and(|id| !id.trim().is_empty())
                    })
                }),
            Err(error) => {
                eprintln!("[server] /v1/models JSON parse failed: {}", error);
                false
            }
        },
        Ok(resp) => {
            eprintln!("[server] /v1/models not ready ({})", resp.status());
            false
        }
        Err(_) => false,
    }
}

fn extract_model_ids(json: &serde_json::Value) -> Vec<String> {
    json.get("data")
        .and_then(|data| data.as_array())
        .map(|models| {
            models
                .iter()
                .filter_map(|model| model.get("id").and_then(|id| id.as_str()))
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// 当前生效的 llama-server 启动配置（进程未启动时可能为 None）。
/// 供 dsh 接入等处读取真实上下文长度等参数，避免写死固定值。
pub fn current_server_config() -> Option<ServerConfig> {
    LAST_SERVER_CONFIG
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
}

pub fn ping_server() -> PingResult {
    let config = match LAST_SERVER_CONFIG
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
    {
        Some(config) => config,
        None => return PingResult::unavailable("尚未启动过 llama-server。"),
    };

    if !is_server_running() {
        return PingResult::unavailable("llama-server 未运行。");
    }

    if !port_is_listening(&config) {
        return PingResult::unavailable(format!("端口 {} 未监听。", config.port));
    }

    let bind_host = bind_host(&config);
    let host = health_check_host(&config);
    let base_url = format!("http://{}:{}", host, config.port);
    let external_base_url = external_host_for_bind(&bind_host, discover_lan_ip())
        .map(|host| format!("http://{}:{}", host, config.port));
    let health_url = format!("{}/health", base_url);
    let models_url = format!("{}/v1/models", base_url);
    let api_key = config.api_key.as_deref();
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
    {
        Ok(client) => client,
        Err(error) => return PingResult::unavailable(format!("创建 HTTP 客户端失败：{}", error)),
    };

    let started = Instant::now();
    let health_resp = server_request(&client, &health_url, api_key).send();
    let latency_ms = Some(started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64);
    let (health_ok, status_code, health_error) = match health_resp {
        Ok(resp) => (
            resp.status().is_success(),
            Some(resp.status().as_u16()),
            None,
        ),
        Err(error) => (false, None, Some(format!("/health 请求失败：{}", error))),
    };

    let mut models = Vec::new();
    let mut models_ok = false;
    let mut models_error = None;
    match server_request(&client, &models_url, api_key).send() {
        Ok(resp) => {
            if resp.status().is_success() {
                match resp.json::<serde_json::Value>() {
                    Ok(json) => {
                        models = extract_model_ids(&json);
                        models_ok = !models.is_empty();
                        if !models_ok {
                            models_error = Some("/v1/models 未返回可用模型。".to_string());
                        }
                    }
                    Err(error) => {
                        models_error = Some(format!("/v1/models 响应解析失败：{}", error));
                    }
                }
            } else {
                models_error = Some(format!("/v1/models 返回状态码 {}。", resp.status()));
            }
        }
        Err(error) => {
            models_error = Some(format!("/v1/models 请求失败：{}", error));
        }
    }

    PingResult {
        reachable: health_ok && models_ok,
        latency_ms,
        status_code,
        health_ok,
        models_ok,
        models,
        base_url: Some(base_url.clone()),
        external_base_url,
        bind_host: Some(bind_host),
        api_key_required: api_key.is_some_and(|key| !key.trim().is_empty()),
        protocol_standards: detect_protocol_standards(&client, &base_url, api_key, models_ok),
        error: health_error.or(models_error),
    }
}

/// 探测 llama-server 实际提供哪些兼容协议，而不是硬编码。
/// OpenAI 兼容以 /v1/models 可用为准；Anthropic 兼容以 /v1/messages 端点存在为准
/// （404 说明内核没有这个端点，其余响应——包括 400/401——都说明端点存在）。
fn detect_protocol_standards(
    client: &reqwest::blocking::Client,
    base_url: &str,
    api_key: Option<&str>,
    openai_ok: bool,
) -> Vec<String> {
    let mut standards = Vec::new();
    if openai_ok {
        standards.push("OpenAI".to_string());
    }
    let messages_url = format!("{}/v1/messages", base_url);
    let mut probe = client
        .post(&messages_url)
        .header("Content-Type", "application/json")
        .body("{}");
    if let Some(key) = api_key {
        probe = probe.bearer_auth(key);
    }
    let anthropic_present = match probe.send() {
        Ok(resp) => resp.status() != reqwest::StatusCode::NOT_FOUND,
        Err(_) => false,
    };
    if anthropic_present {
        standards.push("Anthropic".to_string());
    }
    standards
}

fn compatible_cpu_config(config: &ServerConfig) -> ServerConfig {
    let mut fallback = config.clone();
    fallback.no_cuda = true;
    fallback.ngl = 0;
    fallback.device = Some("none".to_string());
    fallback.main_gpu = None;
    fallback.n_ctx = fallback.n_ctx.min(4096);
    fallback.batch_size = fallback.batch_size.min(128);
    fallback.flash_attn = false;
    fallback.kv_offload = false;
    fallback.mlock = false;
    fallback.ncmoe = 0;
    fallback
}

fn should_retry_with_cpu(error: &ServerError, config: &ServerConfig) -> bool {
    config.retry_cpu_fallback
        && !config.no_cuda
        && matches!(
            error.error_type.as_str(),
            "warmup" | "cuda" | "vulkan" | "oom"
        )
}

fn bytes_contain(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

fn any_file_contains(candidates: &[PathBuf], markers: &[&[u8]]) -> bool {
    candidates.iter().any(|candidate| {
        std::fs::read(candidate)
            .ok()
            .is_some_and(|bytes| markers.iter().any(|marker| bytes_contain(&bytes, marker)))
    })
}

fn runtime_supports_mtp_architecture(exe: &str, architecture: &str) -> bool {
    // 标记以部署内核二进制中实际存在的 "<ARCH> MTP" 断言字符串为准（与
    // gguf_parser.rs 的白名单保持同步）；未列出的架构一律视为不支持，显式报错
    // 而不是放行后让 llama-server 崩溃。
    let markers: &[&[u8]] = match architecture {
        "cohere2moe" => &[b"COHERE2MOE MTP", b"models\\cohere2moe.cpp"],
        "deepseek32" => &[b"DEEPSEEK32 MTP", b"models\\deepseek32.cpp"],
        "deepseek4" => &[b"DEEPSEEK4 MTP", b"models\\deepseek4.cpp"],
        "gemma4-assistant" => &[
            b"Gemma4Assistant requires",
            b"Gemma 4 assistant requires",
            b"gemma4-assistant",
        ],
        "glm-dsa" => &[b"GLM_DSA MTP", b"models\\glm-dsa.cpp"],
        "glm4" => &[b"GLM4 MTP", b"models\\glm4.cpp"],
        "hy-v3" => &[b"HY_V3 MTP", b"models\\hy-v3.cpp"],
        "mimo2" => &[b"MIMO2 MTP", b"models\\mimo2.cpp"],
        "nemotron_h_moe" => &[b"NEMOTRON_H_MOE MTP", b"models\\nemotron_h_moe.cpp"],
        "qwen35" => &[b"QWEN35 MTP", b"models\\qwen35.cpp"],
        "qwen35moe" => &[b"QWEN35MOE MTP", b"models\\qwen35moe.cpp"],
        "qwen3next" => &[b"QWEN3NEXT MTP", b"models\\qwen3next.cpp"],
        "step35" => &[b"STEP35 MTP", b"models\\step35.cpp"],
        _ => return false,
    };
    let exe_path = Path::new(exe);
    let architecture_candidates = [
        exe_path.with_file_name("llama.dll"),
        exe_path.with_file_name("libllama.so"),
        exe_path.with_file_name("libllama.dylib"),
        exe_path.to_path_buf(),
    ];
    let driver_candidates = [
        exe_path.with_file_name("llama-common.dll"),
        exe_path.with_file_name("libllama-common.so"),
        exe_path.with_file_name("libllama-common.dylib"),
        exe_path.to_path_buf(),
    ];
    any_file_contains(&architecture_candidates, markers)
        && any_file_contains(&driver_candidates, &[b"draft-mtp"])
}

/// DSpark/DFlash 侧车启动前校验：文件存在 + 内核带对应 --spec-type 能力。
/// 与 MTP 校验同样采用显式失败：不支持时阻止启动并给出中文指引，
/// 不做静默降级（用户显式选择的参数不能被悄悄丢弃）。
fn validate_drafter_config(exe: &str, config: &ServerConfig) -> Result<()> {
    // 按 MTP > DSpark > DFlash 优先级，只有不会被更高优先级遮蔽时才校验侧车；
    // 被遮蔽的侧车即使文件缺失也不应阻断本次启动。
    let mtp_active = config
        .mtp_draft_path
        .as_deref()
        .map(str::trim)
        .is_some_and(|path| !path.is_empty());
    if mtp_active {
        return Ok(());
    }
    let candidates: [(&str, &str); 2] = [
        (
            config
                .dspark_draft_path
                .as_deref()
                .map(str::trim)
                .filter(|path| !path.is_empty())
                .unwrap_or(""),
            "draft-dspark",
        ),
        (
            config
                .dflash_draft_path
                .as_deref()
                .map(str::trim)
                .filter(|path| !path.is_empty())
                .unwrap_or(""),
            "draft-dflash",
        ),
    ];
    for (draft_path, marker) in candidates {
        if draft_path.is_empty() {
            continue;
        }
        if !Path::new(draft_path).is_file() {
            bail!("推测解码侧车文件不存在：{}；请重新扫描模型或关闭该侧车。", draft_path);
        }
        let exe_path = Path::new(exe);
        let runtime_candidates = [
            exe_path.with_file_name("llama.dll"),
            exe_path.with_file_name("libllama.so"),
            exe_path.with_file_name("libllama.dylib"),
            exe_path.with_file_name("llama-common.dll"),
            exe_path.to_path_buf(),
        ];
        let marker_bytes = marker.as_bytes();
        if !any_file_contains(&runtime_candidates, &[marker_bytes]) {
            bail!(
                "当前 llama.cpp 内核不支持 {} 推测解码（--spec-type {}）；请更新内核，或关闭该侧车后加载。",
                marker.trim_start_matches("draft-"),
                marker
            );
        }
        // 只校验优先级最高的那个侧车。
        break;
    }
    Ok(())
}

fn validate_mtp_config(exe: &str, config: &ServerConfig) -> Result<()> {    let draft_path = config
        .mtp_draft_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty());
    let spec_mtp = config
        .spec_type
        .as_deref()
        .map(|types| types.split(',').any(|value| value.trim() == "draft-mtp"))
        .unwrap_or(false);
    if draft_path.is_none() && !spec_mtp {
        return Ok(());
    }

    let main = parse_gguf_header(Path::new(&config.model_path))
        .map_err(|error| anyhow::anyhow!("无法读取主模型的 MTP 元数据: {}", error))?;
    let draft = draft_path
        .map(|draft_path| {
            parse_gguf_header(Path::new(draft_path))
                .map_err(|error| anyhow::anyhow!("无法读取独立 MTP head: {}", error))
        })
        .transpose()?;
    if let Some(draft) = draft.as_ref() {
        if !mtp_draft_is_compatible(&main, draft) {
            bail!("独立 MTP head 与主模型不兼容，已阻止启动；请检查架构、层数、词表与 tokenizer。")
        }
    } else if !main.has_embedded_mtp {
        bail!("已启用 MTP，但主 GGUF 没有当前 llama.cpp 可执行的内置 MTP tensor，也没有选择独立 head。")
    }
    let runtime_architecture = draft
        .as_ref()
        .map(|metadata| metadata.architecture.as_str())
        .unwrap_or(main.architecture.as_str());
    if !runtime_supports_mtp_architecture(exe, runtime_architecture) {
        bail!(
            "当前 llama.cpp 内核不支持 {} 架构的 MTP graph；请先更新内核，或关闭 MTP 后加载。",
            runtime_architecture
        )
    }
    Ok(())
}

fn llama_command(exe: &str) -> Command {
    let mut cmd = Command::new(exe);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    cmd
}

/// 解析 `llama-server --list-devices` 输出，例如 `Vulkan0: AMD Radeon RX 7700 XT`。
pub(crate) fn parse_listed_devices(output: &str) -> Vec<String> {
    output
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with("Available devices") {
                return None;
            }
            let id = trimmed.split(':').next()?.trim();
            if id.eq_ignore_ascii_case("none") {
                return None;
            }
            let lower = id.to_ascii_lowercase();
            (lower.starts_with("vulkan")
                || lower.starts_with("cuda")
                || lower.starts_with("metal")
                || lower.starts_with("sycl")
                || lower.starts_with("hip")
                || lower.starts_with("musa")
                || lower.starts_with("cann")
                || lower.starts_with("opencl"))
            .then(|| id.to_string())
        })
        .collect()
}

pub(crate) fn list_runtime_devices(exe: &str) -> Vec<String> {
    let output = llama_command(exe).arg("--list-devices").output().ok();
    let Some(output) = output else {
        return Vec::new();
    };
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    parse_listed_devices(&combined)
}

/// 按本机内核实际设备选择 offload 目标。
/// Vulkan 包只有 `Vulkan0`，硬编码 `CUDA0` 会被 llama.cpp 直接拒绝（invalid device）。
/// 列表为空时返回 None，启动命令不传 `--device`，交给内核自动选择。
fn pick_offload_device(available: &[String], requested: Option<&str>) -> Option<String> {
    let requested = requested
        .map(str::trim)
        .filter(|device| !device.is_empty() && !device.eq_ignore_ascii_case("none"));

    if let Some(requested) = requested {
        if available.is_empty()
            || available
                .iter()
                .any(|device| device.eq_ignore_ascii_case(requested))
        {
            return Some(requested.to_string());
        }
        eprintln!(
            "[server] 请求的设备 {} 不在本机内核列表 {:?} 中，改用实际设备",
            requested, available
        );
    }

    available
        .iter()
        .find(|device| device.to_ascii_lowercase().starts_with("cuda"))
        .cloned()
        .or_else(|| available.first().cloned())
}

fn resolve_offload_device(exe: &str, requested: Option<&str>) -> Option<String> {
    pick_offload_device(&list_runtime_devices(exe), requested)
}

fn spawn_server_process(exe: &str, config: &ServerConfig) -> Result<Receiver<String>> {
    validate_mtp_config(exe, config)?;
    validate_drafter_config(exe, config)?;
    let effective_ngl = config.ngl;
    let host = bind_host(config);
    let selected_device = if config.no_cuda {
        Some("none".to_string())
    } else {
        resolve_offload_device(exe, config.device.as_deref())
    };
    let uses_cuda_device = selected_device
        .as_deref()
        .map(|device| device.to_ascii_lowercase().starts_with("cuda"))
        .unwrap_or(false);
    let selected_main_gpu = if config.no_cuda || !uses_cuda_device {
        None
    } else {
        config.main_gpu.or(Some(0))
    };
    eprintln!(
        "[server] spawning with ngl={}, n_ctx={}, batch={}, host={}, port={}, device={:?}, main_gpu={:?}, no_cuda={}",
        effective_ngl,
        config.n_ctx,
        config.batch_size,
        host,
        config.port,
        selected_device,
        selected_main_gpu,
        config.no_cuda
    );

    let mut cmd = Command::new(exe);
    let video_runtime = configure_media_runtime_path(&mut cmd, Path::new(exe));
    if config.mmproj_path.is_some() && !video_runtime.native_video_ready {
        add_log("[multimodal] 未找到 ffmpeg/ffprobe；视频将使用图像帧兼容模式。");
    }
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    cmd.arg("-m")
        .arg(&config.model_path)
        .arg("--port")
        .arg(config.port.to_string())
        .arg("--host")
        .arg(&host)
        .arg("-ngl")
        .arg(effective_ngl.to_string())
        .arg("-c")
        .arg(config.n_ctx.to_string())
        .arg("-b")
        .arg(config.batch_size.to_string());

    if let Some(alias) = config.model_alias.as_deref().filter(|a| !a.is_empty()) {
        cmd.arg("--alias").arg(alias);
    }

    if config.ubatch_size > 0 {
        cmd.arg("-ub").arg(config.ubatch_size.to_string());
    }
    if config.threads > 0 {
        cmd.arg("-t").arg(config.threads.to_string());
    }
    if config.parallel > 0 {
        cmd.arg("-np").arg(config.parallel.to_string());
    }

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    cmd.arg("--flash-attn")
        .arg(if config.flash_attn { "on" } else { "off" });
    if !config.kv_offload {
        cmd.arg("--no-kv-offload");
    }
    cmd.arg(if config.kv_unified {
        "--kv-unified"
    } else {
        "--no-kv-unified"
    });
    cmd.arg(if config.mmap { "--mmap" } else { "--no-mmap" });
    if config.mlock {
        cmd.arg("--mlock");
    }
    if config.no_warmup {
        cmd.arg("--no-warmup");
    }
    if config.no_cuda {
        cmd.arg("--device").arg("none");
        cmd.arg("--no-op-offload");
    } else if let Some(device) = selected_device.as_deref() {
        cmd.arg("--device").arg(device);
        if let Some(main_gpu) = selected_main_gpu {
            cmd.arg("--main-gpu").arg(main_gpu.to_string());
        }
    }
    if config.ncmoe > 0 {
        cmd.arg("-ncmoe").arg(config.ncmoe.to_string());
    }
    append_server_tools(
        &mut cmd,
        exe,
        config.tools.as_deref(),
        &host,
        config.api_key.as_deref(),
    );
    if let Some(api_key) = config
        .api_key
        .as_ref()
        .map(|key| key.trim())
        .filter(|key| !key.is_empty())
    {
        cmd.arg("--api-key").arg(api_key);
    }
    if config.cache_type_k_enabled && !config.cache_type_k.trim().is_empty() {
        cmd.arg("-ctk").arg(&config.cache_type_k);
    }
    if config.cache_type_v_enabled && !config.cache_type_v.trim().is_empty() {
        cmd.arg("-ctv").arg(&config.cache_type_v);
    }
    if let Some(value) = config.rope_freq_base {
        if value > 0.0 {
            cmd.arg("--rope-freq-base").arg(value.to_string());
        }
    }
    if let Some(value) = config.rope_freq_scale {
        if value > 0.0 {
            cmd.arg("--rope-freq-scale").arg(value.to_string());
        }
    }
    if let Some(seed) = config.seed {
        cmd.arg("-s").arg(seed.to_string());
    }
    if let Some(template) = config
        .chat_template
        .as_ref()
        .map(|template| template.trim())
        .filter(|template| !template.is_empty())
    {
        cmd.arg("--chat-template").arg(template);
    }
    if let Some(mmproj_path) = config
        .mmproj_path
        .as_ref()
        .map(|path| path.trim())
        .filter(|path| !path.is_empty())
    {
        cmd.arg("--mmproj").arg(mmproj_path);
        cmd.arg("--mmproj-offload");
    }
    // 推测解码侧车：同一时刻只挂一个草稿模型，优先级 MTP > DSpark > DFlash。
    let mtp_draft_path = config
        .mtp_draft_path
        .as_ref()
        .map(|path| path.trim())
        .filter(|path| !path.is_empty());
    let dspark_draft_path = config
        .dspark_draft_path
        .as_ref()
        .map(|path| path.trim())
        .filter(|path| !path.is_empty());
    let dflash_draft_path = config
        .dflash_draft_path
        .as_ref()
        .map(|path| path.trim())
        .filter(|path| !path.is_empty());
    // (草稿路径, 未显式指定 spec_type 时跟随的默认模式)
    let drafter: Option<(&str, &str)> = mtp_draft_path
        .map(|path| (path, "draft-mtp"))
        .or_else(|| dspark_draft_path.map(|path| (path, "dspark")))
        .or_else(|| dflash_draft_path.map(|path| (path, "dflash")));
    if let Some((draft_path, _)) = drafter {
        cmd.arg("-md").arg(draft_path);
        if let Some(device) = selected_device.as_deref().filter(|device| *device != "none") {
            cmd.arg("--spec-draft-device").arg(device);
            cmd.arg("-ngld").arg(effective_ngl.to_string());
        }
    }
    let spec_type = config
        .spec_type
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        // 显式 spec_type 必须与选中的草稿模式一致，避免 -md 与 --spec-type 来自不同模式。
        .filter(|value| {
            match drafter {
                Some((_, default_mode)) => *value == default_mode,
                // 没有 -md 时只接受内置 MTP 的 draft-mtp。
                None => *value == "draft-mtp",
            }
        })
        .or_else(|| drafter.map(|(_, default_mode)| default_mode));
    if let Some(spec_type) = spec_type {
        // Embedded MTP deliberately reaches this branch without `-md`.
        cmd.arg("--spec-type").arg(spec_type);
        // llama.cpp 已知问题（ggml-org/llama.cpp#24343，截至 b10687 未修）：
        // draft-mtp 模式下内核的 memory fitting 会先为草稿模型试建 context，
        // 此时主模型的 ctx_other 尚未设置，导致初始化失败退出
        // （报错 "Gemma4Assistant requires ctx_other to be set"）。
        // 官方 workaround 是关闭 fitting；只对 draft-mtp 附加，不影响其他模式。
        if spec_type == "draft-mtp" {
            cmd.arg("-fit").arg("off");
        }
    }
    // 草稿深度（--spec-draft-n-max）只在用户显式设置时传递，保持内核默认行为。
    if let Some(n_max) = config.spec_draft_n_max.filter(|value| *value > 0) {
        cmd.arg("--spec-draft-n-max").arg(n_max.to_string());
    }

    let command_line = build_redacted_command_line(exe, &cmd);
    eprintln!("[server] spawn: {}", command_line);
    add_log(&format!("[server] spawn: {}", command_line));

    let mut child = cmd.spawn()?;
    eprintln!("[server] child pid = {:?}", child.id());

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    {
        let mut guard = CHILD_PROCESS.lock().map_err(|e| anyhow::anyhow!("进程管理器 Mutex 已中毒: {}", e))?;
        *guard = Some(child);
    }

    // 附加 Job Object：确保父进程崩溃时子进程被 OS 回收
    #[cfg(windows)]
    {
        if let Some(guard) = CHILD_PROCESS.lock().ok().as_mut().and_then(|g| g.as_mut()) {
            job_guard::attach(guard.as_raw_handle());
        }
    }

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

    Ok(rx)
}

/// 监视启动阶段的日志与健康检查。
///
/// `rx` 必须按引用传入：如果按值接收，本函数返回 Ready 时 `rx` 就被析构，
/// 两个 reader 线程的 send 随即失败退出，子进程管道被关闭——
/// 结果是模型就绪后日志停更、运行期错误检测失效，非 Windows 平台上
/// 子进程还会因写入已关闭管道收到 SIGPIPE 而被杀死。
fn monitor_server(
    config: &ServerConfig,
    rx: &Receiver<String>,
    on_progress: &Arc<dyn Fn(ServerProgress) + Send + Sync>,
    on_ready: &Arc<dyn Fn() + Send + Sync>,
) -> MonitorResult {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .ok();
    let health_url = format!(
        "http://{}:{}/health",
        health_check_host(config),
        config.port
    );
    let models_url = format!(
        "http://{}:{}/v1/models",
        health_check_host(config),
        config.port
    );
    let api_key = config
        .api_key
        .as_ref()
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty());
    let deadline = Instant::now() + Duration::from_secs(600);
    let mut last_health_check = Instant::now() - Duration::from_secs(1);
    let mut max_progress = 0u32;

    loop {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(line) => {
                add_log(&line);
                let p = parse_progress(&line);
                if p > max_progress {
                    max_progress = p;
                }
                on_progress(ServerProgress {
                    progress: max_progress,
                    stage: stage_name(max_progress),
                    log: line.clone(),
                });

                if line.contains("server is listening") {
                    max_progress = max_progress.max(96);
                    on_progress(ServerProgress {
                        progress: max_progress,
                        stage: "正在确认模型 API...".into(),
                        log: line.clone(),
                    });
                }

                if let Some(err) = detect_error(&line) {
                    return MonitorResult::Error(err);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return MonitorResult::Exited,
        }

        if last_health_check.elapsed() >= Duration::from_millis(500) {
            last_health_check = Instant::now();
            if let Some(client) = &client {
                if let Ok(resp) = server_request(client, &health_url, api_key.as_deref()).send() {
                    if resp.status().is_success() {
                        if models_endpoint_ready(client, &models_url, api_key.as_deref()) {
                            eprintln!(
                                "[server] model API ready via /health and /v1/models ({})",
                                resp.status()
                            );
                            on_ready();
                            return MonitorResult::Ready;
                        }
                        max_progress = max_progress.max(98);
                        on_progress(ServerProgress {
                            progress: max_progress,
                            stage: "正在等待模型 API...".into(),
                            log: "[server] /health ok; waiting for /v1/models".into(),
                        });
                    }
                }
            }
        }

        if Instant::now() >= deadline {
            eprintln!("[server] health-check timed out after 600s");
            return MonitorResult::TimedOut;
        }

        if !is_server_running() {
            return MonitorResult::Exited;
        }
    }
}

fn exited_error() -> ServerError {
    ServerError {
        error_type: "unknown".into(),
        title: "启动失败".into(),
        details: "llama-server 进程在监听端口前异常退出。".into(),
        suggestions: vec![
            "检查模型文件路径是否正确，确认 GGUF 文件没有损坏".into(),
            "降低 GPU 卸载层数、上下文长度和 batch 后重试".into(),
            "如果仍然失败，请查看加载日志中的 [server] spawn 命令和最后几行错误".into(),
        ],
    }
}

pub fn start_server<F: Fn(ServerProgress) + Send + Sync + 'static>(
    config: &ServerConfig,
    on_progress: F,
    on_ready: impl Fn() + Send + Sync + 'static,
    on_error: impl Fn(ServerError) + Send + Sync + 'static,
) -> Result<()> {
    eprintln!(
        "[server] start_server called with: ngl={}, n_ctx={}, host={}, port={}",
        config.ngl,
        config.n_ctx,
        bind_host(config),
        config.port
    );

    stop_server().ok();
    // 启动（或切换）模型时清空跨模型累计的 token 用量，避免串号。
    clear_api_usage();

    let exe = resolve_exe_path(&config.executable_path);
    eprintln!("[server] resolved exe path: {}", exe);
    if !Path::new(&exe).exists() {
        let message = format!(
            "找不到 llama-server.exe（搜索路径：{}）。请在设置中指定正确路径，或将它放入 resources 目录。",
            exe
        );
        log_server_event("error", &message);
        return Err(anyhow::anyhow!("{}", message));
    }

    stop_stale_servers_for_exe(&exe);
    log_session_separator(&format!(
        "开始加载模型：{}（端口 {}，监听 {}）",
        config
            .model_alias
            .clone()
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| config.model_path.clone()),
        config.port,
        bind_host(config)
    ));
    if let Ok(mut last_config) = LAST_SERVER_CONFIG.lock() {
        *last_config = Some(config.clone());
    }

    if !wait_for_port_release(config, Duration::from_secs(2)) {
        let message = format!(
            "端口 {} 已被其它服务占用，请先关闭旧的 llama-server 或在设置中换一个端口。",
            config.port
        );
        log_server_event("error", &message);
        return Err(anyhow::anyhow!("{}", message));
    }

    let initial_config = config.clone();
    let on_progress: Arc<dyn Fn(ServerProgress) + Send + Sync> = Arc::new(on_progress);
    let on_ready: Arc<dyn Fn() + Send + Sync> = Arc::new(on_ready);
    let on_error: Arc<dyn Fn(ServerError) + Send + Sync> = Arc::new(on_error);
    let fired = Arc::new(AtomicBool::new(false));
    let generation = SERVER_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;

    std::thread::spawn(move || {
        let mut current_config = initial_config;
        let mut did_cpu_retry = false;

        loop {
            on_progress(ServerProgress {
                progress: 1,
                stage: if current_config.no_cuda {
                    "GPU 启动失败，正在使用 CPU 兼容模式重试...".into()
                } else {
                    "正在启动推理服务...".into()
                },
                log: if current_config.no_cuda {
                    "[server] retry with CPU compatibility mode".into()
                } else {
                    "[server] starting llama-server".into()
                },
            });

            let rx = match spawn_server_process(&exe, &current_config) {
                Ok(rx) => rx,
                Err(e) => {
                    if !fired.swap(true, Ordering::SeqCst) {
                        on_error(ServerError {
                            error_type: "spawn".into(),
                            title: "启动失败".into(),
                            details: e.to_string(),
                            suggestions: vec![
                                "检查 llama-server.exe 路径是否正确".into(),
                                "确认 resources 目录中的 llama.cpp 运行文件完整".into(),
                            ],
                        });
                    }
                    return;
                }
            };

            match monitor_server(&current_config, &rx, &on_progress, &on_ready) {
                MonitorResult::Ready => {
                    fired.store(true, Ordering::SeqCst);
                    eprintln!("[server] ready, entering post-ready watch loop (gen={})", generation);
                    log_server_event(
                        "info",
                        &format!("服务就绪，监听端口 {}。", current_config.port),
                    );
                    // 就绪后必须继续抽干 stdout/stderr：
                    // 1) 日志页需要持续更新；
                    // 2) 推理期的 CUDA OOM 等错误只能从这里发现；
                    // 3) 不读管道会让子进程写满缓冲后卡死（非 Windows 上则是 SIGPIPE 被杀）。
                    let mut pipes_closed = false;
                    let mut last_liveness_check = Instant::now();
                    loop {
                        if pipes_closed {
                            std::thread::sleep(Duration::from_millis(200));
                        } else {
                            match rx.recv_timeout(Duration::from_millis(200)) {
                                Ok(line) => {
                                    add_log(&line);
                                    if let Some(err) = detect_error(&line) {
                                        eprintln!(
                                            "[server] runtime error detected (gen={}): {}",
                                            generation, err.error_type
                                        );
                                        log_server_event(
                                            "error",
                                            &format!("运行期错误（{}）：{}", err.error_type, err.details),
                                        );
                                        on_error(err);
                                    }
                                }
                                Err(mpsc::RecvTimeoutError::Timeout) => {}
                                Err(mpsc::RecvTimeoutError::Disconnected) => {
                                    // 管道已关闭，改为纯轮询存活状态，避免空转。
                                    pipes_closed = true;
                                }
                            }
                        }

                        if last_liveness_check.elapsed() < Duration::from_secs(3) {
                            continue;
                        }
                        last_liveness_check = Instant::now();

                        if SERVER_GENERATION.load(Ordering::SeqCst) != generation {
                            eprintln!("[server] watcher gen={} superseded, exiting", generation);
                            return;
                        }
                        let crashed = {
                            let mut guard = match CHILD_PROCESS.lock() {
                                Ok(g) => g,
                                Err(_) => return,
                            };
                            match guard.as_mut() {
                                None => false,
                                Some(child) => matches!(child.try_wait(), Ok(Some(_)) | Err(_)),
                            }
                        };
                        if !crashed {
                            let still_held = CHILD_PROCESS
                                .lock()
                                .map(|g| g.is_some())
                                .unwrap_or(false);
                            if !still_held {
                                return;
                            }
                            continue;
                        }
                        eprintln!("[server] llama-server process exited unexpectedly (gen={})", generation);
                        add_log("[server] llama-server 进程意外退出。");
                        on_error(ServerError {
                            error_type: "crashed".into(),
                            title: "服务异常退出".into(),
                            details: "llama-server 在运行过程中意外退出。".into(),
                            suggestions: vec![
                                "检查日志页面查看最后的错误信息".into(),
                                "降低 GPU 卸载层数或上下文长度后重试".into(),
                                "确认显存和内存是否充足".into(),
                            ],
                        });
                        return;
                    }
                }
                MonitorResult::Error(err)
                    if should_retry_with_cpu(&err, &current_config) && !did_cpu_retry =>
                {
                    eprintln!(
                        "[server] launch failed with {}, retrying in CPU compatibility mode",
                        err.error_type
                    );
                    add_log(&format!(
                        "[server] {}，自动切换到 CPU 兼容模式重试",
                        err.title
                    ));
                    stop_server().ok();
                    current_config = compatible_cpu_config(&current_config);
                    did_cpu_retry = true;
                    continue;
                }
                MonitorResult::Error(err) => {
                    log_server_event("error", &format!("启动失败（{}）：{}", err.error_type, err.details));
                    if !fired.swap(true, Ordering::SeqCst) {
                        on_error(err);
                    }
                    return;
                }
                MonitorResult::Exited => {
                    // 静默退出也可能是 CUDA 问题，尝试 CPU 回退
                    if current_config.retry_cpu_fallback && !current_config.no_cuda && !did_cpu_retry {
                        eprintln!("[server] server exited silently, retrying in CPU compatibility mode");
                        add_log("[server] 服务静默退出，自动切换到 CPU 兼容模式重试");
                        stop_server().ok();
                        current_config = compatible_cpu_config(&current_config);
                        did_cpu_retry = true;
                        continue;
                    }
                    log_server_event("error", "llama-server 在监听端口前异常退出。");
                    if !fired.swap(true, Ordering::SeqCst) {
                        on_error(exited_error());
                    }
                    return;
                }
                MonitorResult::TimedOut => {
                    // 启动超时也可能是 CUDA 问题，尝试 CPU 回退
                    if current_config.retry_cpu_fallback && !current_config.no_cuda && !did_cpu_retry {
                        eprintln!("[server] server timed out, retrying in CPU compatibility mode");
                        add_log("[server] 启动超时，自动切换到 CPU 兼容模式重试");
                        stop_server().ok();
                        current_config = compatible_cpu_config(&current_config);
                        did_cpu_retry = true;
                        continue;
                    }
                    log_server_event("error", "llama-server 启动超过 10 分钟仍未就绪。");
                    if !fired.swap(true, Ordering::SeqCst) {
                        on_error(ServerError {
                            error_type: "timeout".into(),
                            title: "启动超时".into(),
                            details: "llama-server 启动超过 10 分钟仍未就绪。".into(),
                            suggestions: vec![
                                "换用更小的上下文长度后重试".into(),
                                "确认模型体积和当前内存、显存容量匹配".into(),
                            ],
                        });
                    }
                    return;
                }
            }
        }
    });

    Ok(())
}

pub fn stop_server() -> Result<()> {
    #[cfg(windows)]
    job_guard::terminate();

    let mut guard = CHILD_PROCESS.lock().map_err(|e| anyhow::anyhow!("进程管理器 Mutex 已中毒: {}", e))?;
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
        log_server_event("info", "已停止 llama-server。");
    }
    Ok(())
}

pub fn is_server_running() -> bool {
    // 不能用 expect：本函数被前端的状态轮询（get_server_status）反复调用，
    // 一旦锁中毒就会变成每次轮询都 panic，把一次局部故障放大成整个应用不可用。
    match CHILD_PROCESS.lock() {
        Ok(mut guard) => guard
            .as_mut()
            .is_some_and(|c| matches!(c.try_wait(), Ok(None))),
        Err(error) => {
            eprintln!("[server] CHILD_PROCESS Mutex 已中毒，按未运行处理: {}", error);
            false
        }
    }
}

pub fn active_server_api_key() -> Option<String> {
    LAST_SERVER_CONFIG
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().and_then(|c| c.api_key.clone()))
        .filter(|key| !key.trim().is_empty())
}

pub fn add_log(line: &str) {
    if let Ok(mut logs) = SERVER_LOGS.lock() {
        logs.push(line.to_string());
        if logs.len() > 2000 {
            logs.drain(0..1000);
        }
    }
    // 从 llama-server 的请求完成日志（slot print_timing）解析 token 用量。
    collect_api_usage(line);
    // llama-server 的原始输出同步进统一日志中枢，按内容分级。
    push_system_log(classify_llama_level(line), "llama", line);
}

/// 解析 llama-server 每条请求完成时的 `slot print_timing` 行中的 token 计数，
/// 累进 API_TOKEN_USAGE。
///
/// 格式（llama.cpp `server` 侧稳定输出）：
/// `slot print_timing: id  N | task M | prompt eval time = X ms / P tokens (...)`
/// `slot print_timing: id  N | task M |        eval time = Y ms / C tokens (...)`
/// `slot print_timing: id  N | task M |       total time = Z ms / T tokens`
///
/// 只统计 `prompt eval` 与 `eval` 两行（P=prompt，C=completion），跳过 total 行以免重复。
fn collect_api_usage(line: &str) {
    if !line.contains("slot print_timing") || !line.contains("tokens") {
        return;
    }
    let Some((prompt, completion)) = parse_print_timing(line) else {
        return;
    };
    let model_name = current_server_model_name();

    if let Ok(mut table) = API_TOKEN_USAGE.lock() {
        let entry = if let Some(entry) = table.iter_mut().find(|e| e.model_name == model_name) {
            entry
        } else {
            table.push(TokenUsageAgg {
                model_name: model_name.clone(),
                ..TokenUsageAgg::default()
            });
            table.last_mut().expect("刚 push，必存在")
        };
        if prompt > 0 {
            entry.prompt_tokens += prompt;
        }
        if completion > 0 {
            entry.completion_tokens += completion;
        }
        let added = prompt + completion;
        if added > 0 {
            entry.total_tokens += added;
            entry.response_count += 1;
        }
        entry.last_seen_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;
    }
}

/// 从单行 `slot print_timing` 里抽出 (prompt_tokens, completion_tokens)：
/// `prompt eval` 行返回 (P, 0)，`eval` 行返回 (0, C)，其它（如 total）返回 None。
fn parse_print_timing(line: &str) -> Option<(u64, u64)> {
    let is_prompt = line.contains("prompt eval time");
    let is_eval = line.contains("eval time") && !line.contains("prompt eval time");
    if !is_prompt && !is_eval {
        return None;
    }
    // 找 " / <N> tokens" 片段。
    let tokens_part = line
        .split('/')
        .nth(1)
        .and_then(|rest| rest.trim().split_whitespace().next())?;
    let count: u64 = tokens_part.parse().ok()?;
    if is_prompt {
        Some((count, 0))
    } else {
        Some((0, count))
    }
}

/// 当前服务关联的模型名（优先 alias，其次模型文件名），用于归并 token 统计。
fn current_server_model_name() -> String {
    let model_name = LAST_SERVER_CONFIG
        .lock()
        .ok()
        .and_then(|config| config.as_ref().map(|c| {
            c.model_alias
                .clone()
                .or_else(|| {
                    std::path::Path::new(&c.model_path)
                        .file_name()
                        .map(|name| name.to_string_lossy().to_string())
                })
        }))
        .flatten();
    model_name.unwrap_or_else(|| "llama-server".to_string())
}

/// 读取当前累计的 token 用量（供前端并入使用详情）。
pub fn api_token_usage() -> Vec<TokenUsageAgg> {
    API_TOKEN_USAGE
        .lock()
        .map(|table| table.clone())
        .unwrap_or_default()
}

/// 清空 token 用量累计（服务重启/切换模型时调用，避免跨模型串号）。
pub fn clear_api_usage() {
    if let Ok(mut table) = API_TOKEN_USAGE.lock() {
        table.clear();
    }
}

/// 按内容给 llama-server 输出行分级，纯启发式，只影响展示颜色与筛选。
fn classify_llama_level(line: &str) -> &'static str {
    let lower = line.to_ascii_lowercase();
    if lower.contains("error")
        || lower.contains("failed")
        || lower.contains("fatal")
        || lower.contains("abort")
        || lower.contains("exception")
    {
        "error"
    } else if lower.contains("warn") {
        "warn"
    } else {
        "info"
    }
}

/// 写入统一日志中枢。level 取 debug|info|warn|error，category 取 llama|server|api|app。
pub fn push_system_log(level: &str, category: &str, message: &str) {
    let timestamp = chrono::Utc::now().timestamp_millis().max(0) as u64;
    let seq = LOG_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    if let Ok(mut logs) = SYSTEM_LOGS.lock() {
        logs.push(SystemLogEntry {
            timestamp,
            seq,
            level: level.to_string(),
            category: category.to_string(),
            message: message.to_string(),
        });
        // 逐条淘汰最旧记录，避免整段丢失历史。
        if logs.len() > MAX_SYSTEM_LOGS {
            let overflow = logs.len() - MAX_SYSTEM_LOGS;
            logs.drain(0..overflow);
        }
    }
}

/// 记录一条服务生命周期 / 应用事件（server 分类）。
pub fn log_server_event(level: &str, message: &str) {
    push_system_log(level, "server", message);
}

/// 在日志中枢插入一条会话分隔标记，取代「加载即清空」的做法，
/// 这样上一次加载/运行的日志仍然可以回溯。
pub fn log_session_separator(label: &str) {
    push_system_log("info", "server", &format!("────── {} ──────", label));
}

pub fn get_logs() -> Vec<String> {
    SERVER_LOGS
        .lock()
        .map(|logs| logs.clone())
        .unwrap_or_default()
}

/// 读取统一日志中枢。since_ms 大于 0 时只返回该时间戳及之后的增量，供前端轮询。
/// 注意：使用 >= 而非 > 以避免同毫秒日志丢失，前端应根据 seq 字段去重。
pub fn get_system_logs(since_ms: u64) -> Vec<SystemLogEntry> {
    SYSTEM_LOGS
        .lock()
        .map(|logs| {
            if since_ms == 0 {
                logs.clone()
            } else {
                logs.iter()
                    .filter(|entry| entry.timestamp >= since_ms)
                    .cloned()
                    .collect()
            }
        })
        .unwrap_or_default()
}

pub fn clear_logs() {
    if let Ok(mut logs) = SERVER_LOGS.lock() {
        logs.clear();
    }
}

/// 清空统一日志中枢（仅用户手动触发）。
pub fn clear_system_logs() {
    if let Ok(mut logs) = SYSTEM_LOGS.lock() {
        logs.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_RUNTIME_ID: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn redacted_command_hides_api_key() {
        let exe = "llama-server.exe";
        let mut cmd = std::process::Command::new(exe);
        cmd.arg("--api-key").arg("sk-my-secret-key-12345");
        let redacted = super::build_redacted_command_line(exe, &cmd);
        assert!(!redacted.contains("sk-my-secret-key-12345"), "API key 不应出现在脱敏命令中");
        assert!(redacted.contains("***"), "脱敏命令应包含 ***");
    }

    #[test]
    fn redacted_command_preserves_normal_args() {
        let exe = "llama-server.exe";
        let mut cmd = std::process::Command::new(exe);
        cmd.arg("-m").arg("/models/test.gguf").arg("-c").arg("4096");
        let redacted = super::build_redacted_command_line(exe, &cmd);
        assert!(redacted.contains("test.gguf"));
        assert!(redacted.contains("4096"));
    }

    #[test]
    fn allowed_exe_names_pass_validation() {
        assert!(super::is_allowed_exe_name("llama-server.exe"));
        assert!(super::is_allowed_exe_name("llama-bench.exe"));
        assert!(!super::is_allowed_exe_name("cmd.exe"));
        assert!(!super::is_allowed_exe_name(""));
    }

    #[test]
    fn parse_listed_devices_reads_vulkan() {
        let output = "Available devices:\n  Vulkan0: AMD Radeon RX 7700 XT (12272 MiB, 11305 MiB free)\n";
        assert_eq!(super::parse_listed_devices(output), vec!["Vulkan0"]);
    }

    #[test]
    fn parse_listed_devices_reads_cuda() {
        let output = "Available devices:\n  CUDA0: NVIDIA GeForce RTX 4090 (24576 MiB, 24000 MiB free)\n";
        assert_eq!(super::parse_listed_devices(output), vec!["CUDA0"]);
    }

    #[test]
    fn parse_print_timing_extracts_tokens() {
        // prompt_eval 行返回 (P, 0)；eval 行返回 (0, C)；total 行返回 None。
        let prompt = "0.09.682.736 I slot print_timing: id  3 | task 0 | prompt eval time =      73.83 ms /    18 tokens (    4.10 ms per token,   243.79 tokens per second)";
        let eval = "0.09.682.741 I slot print_timing: id  3 | task 0 |        eval time =     197.04 ms /    16 tokens (   13.14 ms per token,    76.13 tokens per second)";
        let total = "0.09.682.742 I slot print_timing: id  3 | task 0 |       total time =     270.88 ms /    34 tokens";
        assert_eq!(super::parse_print_timing(prompt), Some((18, 0)));
        assert_eq!(super::parse_print_timing(eval), Some((0, 16)));
        assert_eq!(super::parse_print_timing(total), None);
        // 无关行/缺 tokens 的行返回 None。
        assert_eq!(super::parse_print_timing("llama_server: listening on http://0.0.0.0:8080"), None);
        assert_eq!(super::parse_print_timing("slot print_timing: prompt eval time = x"), None);
        assert_eq!(super::parse_print_timing(""), None);
    }

    #[test]
    fn pick_offload_device_replaces_cuda_on_vulkan_runtime() {
        assert_eq!(
            super::pick_offload_device(&["Vulkan0".to_string()], Some("CUDA0")).as_deref(),
            Some("Vulkan0")
        );
        assert_eq!(
            super::pick_offload_device(&["CUDA0".to_string()], None).as_deref(),
            Some("CUDA0")
        );
        assert_eq!(super::pick_offload_device(&[], None), None);
    }

    #[test]
    fn detect_error_identifies_cuda_failure() {
        let log = "CUDA error: an illegal memory access was encountered";
        let error = super::detect_error(log);
        assert!(error.is_some());
        assert_eq!(error.unwrap().error_type, "cuda");
    }

    #[test]
    fn detect_error_identifies_invalid_device() {
        let error = super::detect_error("error while handling argument \"--device\": invalid device: CUDA0");
        assert_eq!(error.unwrap().error_type, "device");
    }

    #[test]
    fn detect_error_identifies_vulkan_failure() {
        let error = super::detect_error("ggml-vulkan: failed to create device");
        assert_eq!(error.unwrap().error_type, "vulkan");
    }

    #[test]
    fn detect_error_returns_none_for_success() {
        let log = "llama_model_load: loaded model successfully";
        assert!(super::detect_error(log).is_none());
    }

    #[test]
    fn server_tools_exclude_agent_only_tools() {
        let help = "available tools: read_file, file_glob_search, grep_search, exec_shell_command, write_file, edit_file, apply_diff, get_datetime";
        let available = parse_available_server_tools(help).expect("parse tools");
        let selection = select_server_tools(
            Some("get_datetime,read_file,update_plan,read_skill"),
            Some(&available),
        );

        assert_eq!(selection.enabled, vec!["get_datetime", "read_file"]);
        assert_eq!(selection.ignored, vec!["update_plan", "read_skill"]);
    }

    #[test]
    fn server_tools_follow_the_current_runtime_help() {
        let help = "available tools: read_file, edit_file, get_datetime";
        let available = parse_available_server_tools(help).expect("parse tools");
        let selection =
            select_server_tools(Some("read_file,apply_diff,get_datetime"), Some(&available));

        assert_eq!(selection.enabled, vec!["read_file", "get_datetime"]);
        assert_eq!(selection.ignored, vec!["apply_diff"]);
    }

    #[test]
    fn server_tools_require_loopback_or_an_api_key() {
        assert!(server_tools_are_protected("127.0.0.1", None));
        assert!(server_tools_are_protected("::1", None));
        assert!(server_tools_are_protected("0.0.0.0", Some("secret")));
        assert!(!server_tools_are_protected("0.0.0.0", None));
        assert!(!server_tools_are_protected("192.168.1.20", Some("  ")));
    }

    #[test]
    fn external_bind_host_excludes_loopback_addresses() {
        assert!(is_external_bind_host("0.0.0.0"));
        assert!(is_external_bind_host("::"));
        assert!(is_external_bind_host("192.168.1.20"));
        assert!(!is_external_bind_host("127.0.0.1"));
        assert!(!is_external_bind_host("::1"));
        assert!(!is_external_bind_host("localhost"));
    }

    #[test]
    fn wildcard_bind_uses_detected_lan_address() {
        let lan_ip = "192.168.50.8".parse::<IpAddr>().expect("valid IP");
        assert_eq!(
            external_host_for_bind("0.0.0.0", Some(lan_ip)),
            Some("192.168.50.8".to_string())
        );
        assert_eq!(external_host_for_bind("0.0.0.0", None), None);
        assert_eq!(external_host_for_bind("127.0.0.1", Some(lan_ip)), None);
    }

    #[test]
    fn mtp_runtime_requires_matching_graph_and_driver() {
        let id = TEST_RUNTIME_ID.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "agent-llm-mtp-runtime-{}-{}",
            std::process::id(),
            id
        ));
        std::fs::create_dir_all(&dir).expect("create synthetic runtime");
        let exe = dir.join("llama-server.exe");
        std::fs::write(&exe, b"server").expect("write server");
        std::fs::write(dir.join("llama.dll"), b"QWEN35 MTP requires")
            .expect("write architecture library");

        assert!(!runtime_supports_mtp_architecture(
            exe.to_str().expect("runtime path"),
            "qwen35"
        ));

        std::fs::write(dir.join("llama-common.dll"), b"draft-mtp")
            .expect("write speculative driver");
        assert!(runtime_supports_mtp_architecture(
            exe.to_str().expect("runtime path"),
            "qwen35"
        ));
        assert!(!runtime_supports_mtp_architecture(
            exe.to_str().expect("runtime path"),
            "step35"
        ));

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn native_video_runtime_requires_ffmpeg_and_ffprobe() {
        let id = TEST_RUNTIME_ID.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "agent-llm-video-runtime-{}-{}",
            std::process::id(),
            id
        ));
        std::fs::create_dir_all(&dir).expect("create synthetic video runtime");
        let exe = dir.join(media_binary_file_name("llama-server"));
        std::fs::write(&exe, b"server").expect("write server");

        let missing = video_runtime_info_for_exe(&exe);
        assert!(!missing.native_video_ready);

        std::fs::write(dir.join(media_binary_file_name("ffmpeg")), b"ffmpeg")
            .expect("write ffmpeg");
        let partial = video_runtime_info_for_exe(&exe);
        assert!(partial.ffmpeg_available);
        assert!(!partial.ffprobe_available);
        assert!(!partial.native_video_ready);

        std::fs::write(dir.join(media_binary_file_name("ffprobe")), b"ffprobe")
            .expect("write ffprobe");
        let ready = video_runtime_info_for_exe(&exe);
        assert!(ready.ffmpeg_available);
        assert!(ready.ffprobe_available);
        assert!(ready.native_video_ready);

        std::fs::remove_dir_all(dir).ok();
    }
}
