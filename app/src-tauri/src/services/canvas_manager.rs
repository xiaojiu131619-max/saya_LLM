//! 无限画布模块管理：画布包、Node 运行时、网关进程与静态服务。
//!
//! 设计约束（与画布参考项目不同，见 docs/plans）：
//! - 画布 origin 必须稳定：画布项目存在 localStorage / IndexedDB，端口变化等于项目丢失，
//!   所以画布端口不做 3000–3010 之类的静默回退，被占用时直接报中文错误。
//! - 网关端口可以变化：画布通过动态 `config.js` 获取地址，不绑定 origin。
//! - 只监听 127.0.0.1；网关默认无鉴权，不开放局域网。
//! - 网关自带更新与修复助手一律关闭，避免外挂模块被它自己改坏。

use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};

use crate::commands::config::get_app_data_root;
use crate::services::canvas_host::{self, CanvasHostHandle};
use crate::services::node_installer::{self, NodeInfo, NodeSource};
use crate::services::process_manager;

/// 画布默认端口。不要使用 3000：本项目 dev server 占用 3000，且上游回退端口会改变 origin。
pub const DEFAULT_CANVAS_PORT: u16 = 3210;
/// 网关默认端口（与参考项目一致）。
pub const DEFAULT_GATEWAY_PORT: u16 = 8190;
/// 首次安装 Node 时使用的版本（与运行时的合规检查一致，避免再装一份 22.x）。
const DEFAULT_NODE_VERSION: &str = "24.15.0";
const MAX_PACK_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const LOG_TAIL_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct CanvasConfig {
    pub comfy_url: String,
    pub comfy_dir: String,
    pub canvas_port: u16,
    pub gateway_port: u16,
    pub open_in_window: bool,
}

impl Default for CanvasConfig {
    fn default() -> Self {
        Self {
            comfy_url: "http://127.0.0.1:8188".to_string(),
            comfy_dir: String::new(),
            canvas_port: DEFAULT_CANVAS_PORT,
            gateway_port: DEFAULT_GATEWAY_PORT,
            open_in_window: true,
        }
    }
}

impl CanvasConfig {
    fn sanitized(mut self) -> Self {
        self.comfy_url = self.comfy_url.trim().trim_end_matches('/').to_string();
        if !(self.comfy_url.starts_with("http://") || self.comfy_url.starts_with("https://")) {
            self.comfy_url = CanvasConfig::default().comfy_url;
        }
        self.comfy_dir = self.comfy_dir.trim().to_string();
        self.canvas_port = normalize_port(self.canvas_port, DEFAULT_CANVAS_PORT);
        self.gateway_port = normalize_port(self.gateway_port, DEFAULT_GATEWAY_PORT);
        if self.canvas_port == self.gateway_port {
            self.gateway_port = DEFAULT_GATEWAY_PORT;
        }
        self
    }
}

fn normalize_port(value: u16, fallback: u16) -> u16 {
    if (1024..=65535).contains(&value) {
        value
    } else {
        fallback
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct CanvasNodeStatus {
    pub source: String,
    pub version: Option<String>,
    pub path: Option<String>,
    pub ok: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CanvasPackStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub dir: Option<String>,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CanvasStatus {
    pub config: CanvasConfig,
    pub node: CanvasNodeStatus,
    pub pack: CanvasPackStatus,
    pub running: bool,
    pub canvas_url: Option<String>,
    pub gateway_url: Option<String>,
    pub canvas_port: u16,
    pub gateway_port: u16,
    pub comfy_url: String,
    pub comfy_reachable: bool,
    pub gateway_ready: bool,
    pub canvas_reachable: bool,
    pub model_count: usize,
    pub data_dir: String,
    pub log_path: String,
    pub error: Option<String>,
    pub last_error: Option<String>,
    pub logs: Vec<String>,
}

struct CanvasRuntime {
    child: Child,
    host: CanvasHostHandle,
    canvas_port: u16,
    gateway_port: u16,
    comfy_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CanvasRuntimeFile {
    gateway_pid: u32,
    canvas_port: u16,
    gateway_port: u16,
    comfy_url: String,
    started_at: u64,
}

static RUNTIME: Lazy<Mutex<Option<CanvasRuntime>>> = Lazy::new(|| Mutex::new(None));
static LAST_ERROR: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));
static NODE_CACHE: Lazy<Mutex<Option<(Instant, CanvasNodeStatus)>>> =
    Lazy::new(|| Mutex::new(None));
const NODE_CACHE_TTL: Duration = Duration::from_secs(30);

fn runtime_file_path() -> PathBuf {
    canvas_root().join("runtime.json")
}

fn write_runtime_file(child: &Child, canvas_port: u16, gateway_port: u16, comfy_url: &str) {
    let record = CanvasRuntimeFile {
        gateway_pid: child.id(),
        canvas_port,
        gateway_port,
        comfy_url: comfy_url.to_string(),
        started_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_secs())
            .unwrap_or(0),
    };
    if let Ok(json) = serde_json::to_string_pretty(&record) {
        let _ = fs::write(runtime_file_path(), json);
    }
}

fn clear_runtime_file() {
    let _ = fs::remove_file(runtime_file_path());
}

fn process_is_our_gateway(pid: u32) -> bool {
    let system = sysinfo::System::new_all();
    let Some(process) = system.process(sysinfo::Pid::from_u32(pid)) else {
        return false;
    };
    let name = process.name().to_ascii_lowercase();
    let cmd = process.cmd().join(" ").to_ascii_lowercase();
    name.contains("node") && cmd.contains("canvas") && cmd.contains("server.js")
}

/// 清理上一次应用实例遗留的网关。Tauri dev 的热重启、任务管理器强杀都可能留下孤儿进程；
/// 只杀 PID 文件里记录、且当前仍是 node.exe 的进程，避免误伤用户其它 Node 程序。
pub fn stop_stale_runtime() {
    let Ok(text) = fs::read_to_string(runtime_file_path()) else {
        return;
    };
    let record = serde_json::from_str::<CanvasRuntimeFile>(&text).ok();
    if let Some(record) = record {
        if record.gateway_pid > 0 && process_is_our_gateway(record.gateway_pid) {
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                let _ = Command::new("taskkill")
                    .args(["/PID", &record.gateway_pid.to_string(), "/T", "/F"])
                    .creation_flags(0x0800_0000)
                    .output();
            }
            eprintln!(
                "[canvas] 清理残留网关 pid={} port={}",
                record.gateway_pid, record.gateway_port
            );
        }
    }
    clear_runtime_file();
}

fn set_last_error(message: Option<String>) {
    if let Ok(mut guard) = LAST_ERROR.lock() {
        *guard = message;
    }
}

fn last_error() -> Option<String> {
    LAST_ERROR.lock().ok().and_then(|guard| guard.clone())
}

pub fn canvas_root() -> PathBuf {
    get_app_data_root().join("canvas")
}

pub fn data_dir() -> PathBuf {
    canvas_root().join("data")
}

pub fn outputs_dir() -> PathBuf {
    canvas_root().join("outputs")
}

pub fn workflows_dir() -> PathBuf {
    canvas_root().join("workflows")
}

pub fn logs_dir() -> PathBuf {
    canvas_root().join("logs")
}

pub fn log_path() -> PathBuf {
    logs_dir().join("gateway.log")
}

pub fn config_path() -> PathBuf {
    canvas_root().join("config.json")
}

pub fn installed_pack_dir() -> PathBuf {
    canvas_root().join("pack")
}

pub fn load_config() -> CanvasConfig {
    let raw = fs::read_to_string(config_path()).ok();
    let config = raw
        .and_then(|text| serde_json::from_str::<CanvasConfig>(&text).ok())
        .unwrap_or_default();
    config.sanitized()
}

pub fn save_config(config: CanvasConfig) -> Result<CanvasConfig, String> {
    let config = config.sanitized();
    fs::create_dir_all(canvas_root()).map_err(|error| format!("创建画布数据目录失败：{error}"))?;
    let json = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    fs::write(config_path(), json).map_err(|error| format!("保存画布设置失败：{error}"))?;
    Ok(config)
}

fn node_status() -> (CanvasNodeStatus, NodeInfo) {
    let info = node_installer::resolve_node();
    let source = match info.source {
        NodeSource::System => "system",
        NodeSource::Managed => "managed",
        NodeSource::None => "missing",
    };
    let status = CanvasNodeStatus {
        source: source.to_string(),
        version: info.version.clone(),
        path: info.path.clone(),
        ok: info.source != NodeSource::None,
    };
    (status, info)
}

/// 轮询用缓存：`resolve_node` 会执行 `node --version`，Agent 标签每 4 秒轮询时不能反复起进程。
fn node_status_cached() -> CanvasNodeStatus {
    if let Ok(guard) = NODE_CACHE.lock() {
        if let Some((at, status)) = guard.as_ref() {
            if at.elapsed() < NODE_CACHE_TTL {
                return status.clone();
            }
        }
    }
    let (status, _) = node_status();
    if let Ok(mut guard) = NODE_CACHE.lock() {
        *guard = Some((Instant::now(), status.clone()));
    }
    status
}

fn clear_node_cache() {
    if let Ok(mut guard) = NODE_CACHE.lock() {
        *guard = None;
    }
}

fn pack_version(dir: &Path) -> Option<String> {
    fs::read_to_string(dir.join("VERSION"))
        .ok()
        .map(|value| value.trim().trim_start_matches('v').to_string())
        .filter(|value| !value.is_empty())
}

fn is_valid_pack(dir: &Path) -> bool {
    dir.join("web").join("index.html").is_file()
        && dir.join("gateway").join("src").join("server.js").is_file()
}

fn pack_candidates(app: Option<&AppHandle>) -> Vec<(PathBuf, &'static str)> {
    let mut candidates: Vec<(PathBuf, &'static str)> = Vec::new();
    if let Ok(dir) = std::env::var("AGENT_LLM_CANVAS_DIR") {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            candidates.push((PathBuf::from(trimmed), "env"));
        }
    }
    if let Some(app) = app {
        if let Ok(dir) = app.path().resolve("canvas", BaseDirectory::Resource) {
            candidates.push((dir, "resource"));
        }
    }
    candidates.push((installed_pack_dir(), "installed"));
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push((cwd.join("resources").join("canvas"), "cwd"));
        candidates.push((cwd.join("..").join("resources").join("canvas"), "cwd"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            // `bundle.resources` 里用 `../resources/canvas` 时，Tauri 会把它放到
            // `_up_/resources/canvas`（新版打包器的落点）；与 auto_updater 的
            // resource_dir() 口径一致。
            candidates.push((
                parent.join("_up_").join("resources").join("canvas"),
                "resource",
            ));
            candidates.push((parent.join("resources").join("canvas"), "exe"));
            candidates.push((parent.join("canvas"), "exe"));
        }
    }
    candidates
}

pub fn resolve_pack(app: Option<&AppHandle>) -> Option<(PathBuf, &'static str)> {
    // 画布改为随应用分发后，随包的包可能比用户机器上残留的旧包新。
    // 按版本取最高的有效包（而不是死守候选顺序），这样升级应用就能把旧画布带上来；
    // 用户自己装了更新的包时仍然是新的那个生效。
    let mut seen = HashSet::new();
    let mut best: Option<(PathBuf, &'static str, Vec<u32>)> = None;
    for (dir, source) in pack_candidates(app) {
        if !seen.insert(dir.clone()) {
            continue;
        }
        if !is_valid_pack(&dir) {
            continue;
        }
        // 环境变量是开发期显式覆盖，优先级最高。
        if source == "env" {
            return Some((dir, source));
        }
        let key = pack_version(&dir)
            .map(|version| version_key(&version))
            .unwrap_or_default();
        let replace = match &best {
            None => true,
            Some((_, _, current)) => key > *current,
        };
        if replace {
            best = Some((dir, source, key));
        }
    }
    best.map(|(dir, source, _)| (dir, source))
}

fn version_key(raw: &str) -> Vec<u32> {
    raw.split(|ch: char| !ch.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse::<u32>().ok())
        .take(4)
        .collect()
}

fn pack_status(app: Option<&AppHandle>) -> CanvasPackStatus {
    match resolve_pack(app) {
        Some((dir, source)) => CanvasPackStatus {
            installed: true,
            version: pack_version(&dir),
            dir: Some(dir.to_string_lossy().to_string()),
            source: Some(source.to_string()),
        },
        None => CanvasPackStatus {
            installed: false,
            version: None,
            dir: None,
            source: None,
        },
    }
}

fn copy_dir_contents(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target)
        .map_err(|error| format!("创建目录失败 {}：{error}", target.display()))?;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("读取目录失败 {}：{error}", source.display()))?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        let from = entry.path();
        let to = target.join(entry.file_name());
        if from.is_dir() {
            copy_dir_contents(&from, &to)?;
        } else {
            fs::copy(&from, &to)
                .map_err(|error| format!("复制文件失败 {}：{error}", from.display()))?;
        }
    }
    Ok(())
}

fn ensure_data_dirs(pack_dir: &Path) -> Result<(), String> {
    for dir in [data_dir(), outputs_dir(), logs_dir(), workflows_dir()] {
        fs::create_dir_all(&dir)
            .map_err(|error| format!("创建画布数据目录失败 {}：{error}", dir.display()))?;
    }
    // 首次启动把内置工作流复制到用户数据目录；之后升级不覆盖用户改动。
    let mut has_workflow = false;
    if let Ok(entries) = fs::read_dir(workflows_dir()) {
        has_workflow = entries.flatten().any(|entry| entry.path().is_file());
    }
    if !has_workflow {
        let source = pack_dir.join("gateway").join("workflows");
        if source.is_dir() {
            copy_dir_contents(&source, &workflows_dir())?;
        }
    }
    Ok(())
}

fn port_available(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn pick_gateway_port(preferred: u16) -> Result<u16, String> {
    for offset in 0..20u16 {
        let Some(port) = preferred.checked_add(offset) else {
            break;
        };
        if port == 0 {
            break;
        }
        if port_available(port) {
            return Ok(port);
        }
    }
    Err(format!(
        "网关端口 {preferred} 及其后 20 个端口都被占用，请在画布设置里换一个端口。"
    ))
}

fn http_client(timeout_ms: u64) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .connect_timeout(Duration::from_millis(timeout_ms.min(3000)))
        .build()
        .map_err(|error| format!("创建本地请求失败：{error}"))
}

fn http_get_text(url: &str, timeout_ms: u64) -> Result<String, String> {
    let client = http_client(timeout_ms)?;
    let response = client
        .get(url)
        .send()
        .map_err(|error| format!("请求 {url} 失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("请求 {url} 返回 {}", response.status()));
    }
    response.text().map_err(|error| error.to_string())
}

fn http_get_json(url: &str, timeout_ms: u64) -> Result<serde_json::Value, String> {
    let text = http_get_text(url, timeout_ms)?;
    serde_json::from_str(&text).map_err(|error| format!("解析 {url} 返回失败：{error}"))
}

fn probe_gateway(port: u16) -> bool {
    // /health 会等 ComfyUI 探测最多 1.5s；超时必须大于这个值，否则永远判为未就绪。
    http_get_json(&format!("http://127.0.0.1:{port}/health"), 4000)
        .map(|json| json.get("status").and_then(|value| value.as_str()) == Some("ok"))
        .unwrap_or(false)
}

fn probe_comfy(url: &str) -> bool {
    http_get_json(&format!("{}/system_stats", url.trim_end_matches('/')), 800).is_ok()
}

fn probe_canvas(port: u16) -> bool {
    http_get_text(&format!("http://127.0.0.1:{port}/config.js"), 800)
        .map(|text| text.contains("__RUNTIME_CONFIG__"))
        .unwrap_or(false)
}

fn model_count(port: u16) -> usize {
    http_get_json(&format!("http://127.0.0.1:{port}/v1/models"), 1200)
        .ok()
        .and_then(|json| {
            json.get("data")
                .and_then(|value| value.as_array())
                .map(|items| items.len())
        })
        .unwrap_or(0)
}

fn tail_logs(max_lines: usize) -> Vec<String> {
    let path = log_path();
    let Ok(metadata) = fs::metadata(&path) else {
        return Vec::new();
    };
    let size = metadata.len();
    let skip = size.saturating_sub(LOG_TAIL_BYTES);
    let Ok(mut file) = File::open(&path) else {
        return Vec::new();
    };
    if skip > 0 {
        use std::io::Seek;
        let _ = file.seek(std::io::SeekFrom::Start(skip));
    }
    let mut bytes = Vec::new();
    let _ = file.read_to_end(&mut bytes);
    let text = String::from_utf8_lossy(&bytes);
    let mut lines: Vec<String> = text
        .lines()
        .map(|line| line.trim_end_matches('\r').to_string())
        .collect();
    if lines.len() > max_lines {
        lines.drain(0..lines.len() - max_lines);
    }
    lines
}

fn append_log_header(node_version: Option<&str>, comfy_url: &str, gateway_port: u16) {
    let _ = fs::create_dir_all(logs_dir());
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path())
    {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_secs())
            .unwrap_or(0);
        let _ = writeln!(
            file,
            "\n===== [canvas] start {timestamp} | node={} | comfy={comfy_url} | gateway=127.0.0.1:{gateway_port} =====",
            node_version.unwrap_or("unknown")
        );
    }
}

fn build_gateway_command(
    node_path: &Path,
    pack_dir: &Path,
    config: &CanvasConfig,
    gateway_port: u16,
) -> Result<Command, String> {
    let gateway_dir = pack_dir.join("gateway");
    let server_js = gateway_dir.join("src").join("server.js");
    if !server_js.is_file() {
        return Err(format!("画布模块缺少网关入口：{}", server_js.display()));
    }
    if !gateway_dir.join("node_modules").join("express").is_dir() {
        return Err(format!(
            "画布模块缺少网关依赖（express）。请重新安装画布模块：{}",
            gateway_dir.display()
        ));
    }

    let mut command = Command::new(node_path);
    command
        .arg(server_js)
        .current_dir(&gateway_dir)
        .env("NODE_ENV", "production")
        .env("HOST", "127.0.0.1")
        .env("PORT", gateway_port.to_string())
        .env("COMFY_URL", &config.comfy_url)
        .env("WORKFLOW_DIR", workflows_dir())
        .env("DATA_DIR", data_dir())
        .env("OUTPUT_DIR", outputs_dir())
        .env("CANVAS_DIST", pack_dir.join("web"))
        .env(
            "CORS_ORIGINS",
            format!(
                "http://127.0.0.1:{},http://localhost:{}",
                config.canvas_port, config.canvas_port
            ),
        )
        // 外挂模块不允许自更新/自修复，否则会把打包内容改坏。
        .env("UPDATE_ENABLED", "0")
        // 启动时不做全量扫描：ComfyUI 未启动时扫描会拖住 /health，导致启动超时。
        // 画布打开后会自己触发 setup/scan。
        .env("SCAN_ON_START", "0")
        .env("LAUNCHER_CONTROL_URL", "")
        .env(
            "PUBLIC_BASE_URL",
            format!("http://127.0.0.1:{gateway_port}"),
        );
    if !config.comfy_dir.is_empty() {
        command.env("COMFYUI_DIR", &config.comfy_dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    Ok(command)
}

fn spawn_gateway(
    node_path: &Path,
    pack_dir: &Path,
    config: &CanvasConfig,
    gateway_port: u16,
) -> Result<Child, String> {
    append_log_header(node_path.to_str(), &config.comfy_url, gateway_port);
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path())
        .map_err(|error| format!("打开网关日志失败：{error}"))?;
    let stderr = log
        .try_clone()
        .map_err(|error| format!("复制网关日志句柄失败：{error}"))?;

    let mut command = build_gateway_command(node_path, pack_dir, config, gateway_port)?;
    command.stdout(Stdio::from(log)).stderr(Stdio::from(stderr));
    let child = command
        .spawn()
        .map_err(|error| format!("启动画布网关失败：{error}"))?;
    process_manager::attach_child_job(&child, "canvas");
    Ok(child)
}

fn wait_for_gateway(child: &mut Child, port: u16) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if probe_gateway(port) {
            return Ok(());
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!(
                "画布网关启动后退出（{status}）。\n{}",
                tail_logs(20).join("\n")
            ));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "画布网关 30 秒内没有就绪。\n{}",
                tail_logs(20).join("\n")
            ));
        }
        thread::sleep(Duration::from_millis(250));
    }
}

fn trigger_setup_scan(port: u16) {
    thread::spawn(move || {
        let url = format!("http://127.0.0.1:{port}/api/setup/scan");
        if let Ok(client) = http_client(5000) {
            let _ = client.post(&url).send();
        }
    });
}

/// 启动画布。调用前应先停止旧实例；重复启动会先走 stop。
pub fn start(app: &AppHandle) -> Result<(), String> {
    // 已有实例：先停掉，保证端口与配置一致。
    stop().ok();
    // 热重启/强杀可能留下上一次的网关，先按 PID 文件清理。
    stop_stale_runtime();

    let config = load_config();
    let Some((pack_dir, _source)) = resolve_pack(Some(app)) else {
        let message = "画布模块尚未安装。请先下载模块或选择本地模块压缩包。".to_string();
        set_last_error(Some(message.clone()));
        return Err(message);
    };
    start_with_pack(&pack_dir, &config)
}

/// 使用指定画布包启动；测试和本地 smoke 用，正式路径走 `start`。
pub fn start_with_pack(pack_dir: &Path, config: &CanvasConfig) -> Result<(), String> {
    let config = config.clone().sanitized();
    let (node, _) = node_status();
    if !node.ok {
        let message = "未找到可用的 Node.js 运行时。请先在画布面板里安装运行时。".to_string();
        set_last_error(Some(message.clone()));
        return Err(message);
    }
    let node_path = node
        .path
        .as_deref()
        .map(PathBuf::from)
        .ok_or_else(|| "Node.js 路径为空。".to_string())?;

    if !is_valid_pack(pack_dir) {
        let message = format!("画布模块不完整：{}", pack_dir.display());
        set_last_error(Some(message.clone()));
        return Err(message);
    }
    if !port_available(config.canvas_port) {
        let message = format!(
            "画布端口 {} 已被占用。画布项目按 origin 保存，换端口会看不到旧项目；请先关闭占用该端口的程序。",
            config.canvas_port
        );
        set_last_error(Some(message.clone()));
        return Err(message);
    }
    let gateway_port = pick_gateway_port(config.gateway_port)?;

    ensure_data_dirs(pack_dir)?;
    let mut child = spawn_gateway(&node_path, pack_dir, &config, gateway_port)?;
    write_runtime_file(&child, config.canvas_port, gateway_port, &config.comfy_url);
    if let Err(error) = wait_for_gateway(&mut child, gateway_port) {
        clear_runtime_file();
        set_last_error(Some(error.clone()));
        return Err(error);
    }
    // 启动扫描放到后台：/health 已经可用，扫描结果通过 /v1/models 的 revision 更新。
    trigger_setup_scan(gateway_port);

    let host = match canvas_host::start(pack_dir.join("web"), config.canvas_port, gateway_port) {
        Ok(host) => host,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            clear_runtime_file();
            set_last_error(Some(error.clone()));
            return Err(error);
        }
    };

    if let Ok(mut guard) = RUNTIME.lock() {
        *guard = Some(CanvasRuntime {
            child,
            host,
            canvas_port: config.canvas_port,
            gateway_port,
            comfy_url: config.comfy_url.clone(),
        });
    }
    set_last_error(None);
    Ok(())
}

/// 停止画布网关与静态服务，保留用户数据。
pub fn stop() -> Result<(), String> {
    let mut guard = RUNTIME
        .lock()
        .map_err(|_| "画布运行时锁已损坏。".to_string())?;
    if let Some(mut runtime) = guard.take() {
        runtime.host.stop();
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let _ = Command::new("taskkill")
                .args(["/PID", &runtime.child.id().to_string(), "/T", "/F"])
                .creation_flags(0x0800_0000)
                .output();
        }
        let _ = runtime.child.kill();
        let _ = runtime.child.wait();
    }
    clear_runtime_file();
    Ok(())
}

pub fn stop_on_exit() {
    let _ = stop();
}

pub(crate) fn runtime_ports() -> Option<(u16, u16, String)> {
    let mut guard = RUNTIME.lock().ok()?;
    let Some(runtime) = guard.as_mut() else {
        return None;
    };
    let alive = runtime
        .child
        .try_wait()
        .map(|status| status.is_none())
        .unwrap_or(false);
    if !alive {
        // 子进程已退出：销毁运行时，避免 UI 一直显示“运行中”。
        let _ = runtime.host.stop();
        *guard = None;
        return None;
    }
    Some((
        runtime.canvas_port,
        runtime.gateway_port,
        runtime.comfy_url.clone(),
    ))
}

#[derive(Debug, Clone, Serialize)]
pub struct CanvasSummary {
    pub running: bool,
    pub pack_installed: bool,
    pub node_ok: bool,
}

/// 轻量状态：给 Agent 标签圆点用，不探测 ComfyUI / 网关。
pub fn summary(app: Option<&AppHandle>) -> CanvasSummary {
    let pack = pack_status(app);
    let node = node_status_cached();
    CanvasSummary {
        running: runtime_ports().is_some(),
        pack_installed: pack.installed,
        node_ok: node.ok,
    }
}

pub fn status(app: Option<&AppHandle>) -> CanvasStatus {
    let config = load_config();
    let node = node_status_cached();
    let pack = pack_status(app);
    let running = runtime_ports();
    let is_running = running.is_some();
    let (canvas_port, gateway_port, comfy_url) = match running {
        Some((canvas_port, gateway_port, comfy_url)) => (canvas_port, gateway_port, comfy_url),
        None => (
            config.canvas_port,
            config.gateway_port,
            config.comfy_url.clone(),
        ),
    };
    let gateway_ready = is_running && probe_gateway(gateway_port);
    let canvas_reachable = is_running && probe_canvas(canvas_port);
    let comfy_reachable = probe_comfy(&comfy_url);
    let model_count = if gateway_ready {
        model_count(gateway_port)
    } else {
        0
    };

    CanvasStatus {
        config,
        node,
        pack,
        running: is_running,
        canvas_url: is_running.then(|| format!("http://127.0.0.1:{canvas_port}/")),
        gateway_url: is_running.then(|| format!("http://127.0.0.1:{gateway_port}/v1")),
        canvas_port,
        gateway_port,
        comfy_url,
        comfy_reachable,
        gateway_ready,
        canvas_reachable,
        model_count,
        data_dir: canvas_root().to_string_lossy().to_string(),
        log_path: log_path().to_string_lossy().to_string(),
        error: None,
        last_error: last_error(),
        logs: tail_logs(120),
    }
}

pub fn open_window(app: &AppHandle) -> Result<(), String> {
    let Some((canvas_port, _, _)) = runtime_ports() else {
        return Err("画布尚未启动。请先点“启动画布”。".to_string());
    };
    let url = format!("http://127.0.0.1:{canvas_port}/");
    let app_handle = app.clone();
    // 动态窗口必须在主线程创建；在命令线程直接 build 会留下一个 about:blank 后立刻消失的窗口。
    app.run_on_main_thread(move || {
        if let Some(window) = app_handle.get_webview_window("canvas") {
            if window
                .url()
                .map(|current| current.as_str() == "about:blank")
                .unwrap_or(false)
            {
                if let Ok(parsed) = tauri::Url::parse(&url) {
                    if let Err(error) = window.navigate(parsed) {
                        eprintln!("[canvas] existing window navigate failed: {error}");
                    }
                }
            }
            let _ = window.show();
            let _ = window.set_focus();
            return;
        }
        let parsed = match tauri::Url::parse(&url) {
            Ok(parsed) => parsed,
            Err(error) => {
                eprintln!("[canvas] invalid canvas url {url}: {error}");
                return;
            }
        };
        let builder = tauri::WebviewWindowBuilder::new(
            &app_handle,
            "canvas",
            tauri::WebviewUrl::External(parsed.clone()),
        )
        .title("无限画布")
        .inner_size(1440.0, 900.0)
        .min_inner_size(960.0, 600.0)
        .center()
        .disable_drag_drop_handler();
        match builder.build() {
            Ok(window) => {
                // 某些 WebView2 版本在 builder 里给外部 URL 时只创建 about:blank，这里显式导航一次。
                if let Err(error) = window.navigate(parsed) {
                    eprintln!("[canvas] navigate failed: {error}");
                }
                let _ = window.show();
                let _ = window.set_focus();
            }
            Err(error) => eprintln!("[canvas] create window failed: {error}"),
        }
    })
    .map_err(|error| format!("无法在主线程序列化画布窗口：{error}"))?;
    Ok(())
}

pub fn open_browser() -> Result<(), String> {
    let Some((canvas_port, _, _)) = runtime_ports() else {
        return Err("画布尚未启动。请先点“启动画布”。".to_string());
    };
    crate::commands::system::open_external_url(format!("http://127.0.0.1:{canvas_port}/"))
}

pub fn reveal_data_dir() -> Result<(), String> {
    let dir = canvas_root();
    fs::create_dir_all(&dir).map_err(|error| format!("创建画布数据目录失败：{error}"))?;
    crate::commands::system::reveal_path(dir.to_string_lossy().to_string())
}

pub fn clear_logs() -> Result<(), String> {
    fs::create_dir_all(logs_dir()).map_err(|error| error.to_string())?;
    fs::write(log_path(), b"").map_err(|error| format!("清空画布日志失败：{error}"))
}

pub fn read_logs(max_lines: usize) -> Vec<String> {
    tail_logs(max_lines)
}

/// 安装/更新 Node.js 运行时。已有合规 Node 时直接返回版本号。
pub fn install_node(
    proxy_url: Option<&str>,
    on_progress: &dyn Fn(String),
) -> Result<String, String> {
    let (node, info) = node_status();
    if node.ok {
        if let Some(version) = info.version {
            on_progress(format!("已有可用的 Node.js v{version}，无需安装。"));
            return Ok(version);
        }
    }
    on_progress(format!(
        "开始安装托管 Node.js v{DEFAULT_NODE_VERSION}（只需一次）..."
    ));
    let result = node_installer::install_node_portable(DEFAULT_NODE_VERSION, proxy_url, on_progress);
    if result.is_ok() {
        clear_node_cache();
    }
    result
}

fn extract_pack_zip(zip_path: &Path) -> Result<PathBuf, String> {
    let file = File::open(zip_path).map_err(|error| format!("打开画布模块失败：{error}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|error| format!("读取画布模块失败：{error}"))?;

    // 找到 web/index.html，兼容“压缩包内多一层目录”的打包方式。
    let mut prefix: Option<String> = None;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("读取压缩包条目失败：{error}"))?;
        let name = entry.name().replace('\\', "/");
        if let Some(stripped) = name.strip_suffix("web/index.html") {
            let candidate = stripped.trim_end_matches('/').to_string();
            prefix = Some(match prefix {
                Some(existing) if existing.len() <= candidate.len() => existing,
                _ => candidate,
            });
        }
    }
    let prefix = prefix.ok_or_else(|| {
        "压缩包不是画布模块：缺少 web/index.html。请选择由 build-canvas-pack.ps1 生成的 zip。"
            .to_string()
    })?;
    let prefix_with_slash = if prefix.is_empty() {
        String::new()
    } else {
        format!("{}/", prefix.trim_end_matches('/'))
    };

    let temp = canvas_root().join(format!(
        "pack-tmp-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_millis())
            .unwrap_or(0)
    ));
    if temp.exists() {
        fs::remove_dir_all(&temp).ok();
    }
    fs::create_dir_all(&temp).map_err(|error| format!("创建临时目录失败：{error}"))?;

    let mut total: u64 = 0;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("读取压缩包条目失败：{error}"))?;
        let raw_name = entry.name().replace('\\', "/");
        let Some(relative) = raw_name.strip_prefix(&prefix_with_slash) else {
            continue;
        };
        if relative.is_empty() {
            continue;
        }
        let Some(enclosed) = entry.enclosed_name() else {
            continue;
        };
        let normalized = enclosed
            .strip_prefix(prefix.trim_end_matches('/'))
            .unwrap_or(&enclosed)
            .to_path_buf();
        if normalized.as_os_str().is_empty() {
            continue;
        }
        let target = temp.join(&normalized);
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|error| format!("创建目录失败：{error}"))?;
            continue;
        }
        total = total.saturating_add(entry.size());
        if total > MAX_PACK_BYTES {
            let _ = fs::remove_dir_all(&temp);
            return Err("画布模块解压后超过 2GB，已中止。".to_string());
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("创建目录失败：{error}"))?;
        }
        let mut output = File::create(&target).map_err(|error| format!("写入文件失败：{error}"))?;
        std::io::copy(&mut entry, &mut output).map_err(|error| format!("解压文件失败：{error}"))?;
    }

    if !is_valid_pack(&temp) {
        let _ = fs::remove_dir_all(&temp);
        return Err(
            "画布模块内容不完整：缺少 web/index.html 或 gateway/src/server.js。".to_string(),
        );
    }
    Ok(temp)
}

fn replace_installed_pack(temp: &Path) -> Result<PathBuf, String> {
    let target = installed_pack_dir();
    if target.exists() {
        fs::remove_dir_all(&target).map_err(|error| format!("删除旧画布模块失败：{error}"))?;
    }
    fs::rename(temp, &target).map_err(|error| format!("安装画布模块失败：{error}"))?;
    Ok(target)
}

/// 从本地 zip 安装画布模块。
pub fn install_pack_from_zip(path: &Path) -> Result<CanvasPackStatus, String> {
    if !path.is_file() {
        return Err(format!("找不到画布模块文件：{}", path.display()));
    }
    let temp = extract_pack_zip(path)?;
    let target = replace_installed_pack(&temp)?;
    Ok(CanvasPackStatus {
        installed: true,
        version: pack_version(&target),
        dir: Some(target.to_string_lossy().to_string()),
        source: Some("installed".to_string()),
    })
}

fn validate_download_url(url: &str) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.starts_with("https://") {
        return Ok(());
    }
    // 只允许本机回环的 http，方便本地/内网测试；其它一律要求 https。
    if let Some(rest) = trimmed.strip_prefix("http://") {
        let host = rest.split('/').next().unwrap_or("");
        if host.starts_with("127.0.0.1")
            || host.starts_with("localhost")
            || host.starts_with("[::1]")
        {
            return Ok(());
        }
    }
    Err("画布模块下载地址必须是 https://，或本机回环的 http://。".to_string())
}

/// 从 URL 下载画布模块，校验 SHA256 后安装。
pub fn install_pack_from_url(
    url: &str,
    sha256: &str,
    proxy_url: Option<&str>,
    on_progress: &dyn Fn(String),
) -> Result<CanvasPackStatus, String> {
    validate_download_url(url)?;
    let expected = sha256.trim().to_ascii_lowercase();
    if expected.len() != 64 || !expected.chars().all(|value| value.is_ascii_hexdigit()) {
        return Err("画布模块校验值无效（需要 64 位 SHA256）。".to_string());
    }

    let downloads = canvas_root().join("downloads");
    fs::create_dir_all(&downloads).map_err(|error| format!("创建下载目录失败：{error}"))?;
    let zip_path = downloads.join(format!(
        "canvas-pack-{}.zip",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_secs())
            .unwrap_or(0)
    ));

    let mut builder = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(1800))
        .connect_timeout(Duration::from_secs(30));
    if let Some(proxy) = auto_updater_proxy(proxy_url)? {
        builder = builder.proxy(proxy);
    }
    let client = builder
        .build()
        .map_err(|error| format!("创建下载客户端失败：{error}"))?;
    on_progress("开始下载画布模块...".to_string());
    let mut response = client
        .get(url)
        .send()
        .map_err(|error| format!("下载画布模块失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("下载画布模块失败：HTTP {}", response.status()));
    }
    let total = response.content_length().unwrap_or(0);
    let mut file = File::create(&zip_path).map_err(|error| format!("创建下载文件失败：{error}"))?;
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|error| format!("读取下载数据失败：{error}"))?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|error| format!("写入下载文件失败：{error}"))?;
        hasher.update(&buffer[..read]);
        downloaded = downloaded.saturating_add(read as u64);
        if total > 0 {
            let percent = (downloaded as f64 / total as f64 * 100.0).round() as u32;
            on_progress(format!("下载画布模块... {percent}%"));
        }
    }
    drop(file);
    let actual = format!("{:x}", hasher.finalize());
    if actual != expected {
        let _ = fs::remove_file(&zip_path);
        return Err(format!(
            "画布模块校验失败：期望 {expected}，实际 {actual}。已删除下载文件。"
        ));
    }
    on_progress("校验通过，正在安装画布模块...".to_string());
    let status = install_pack_from_zip(&zip_path)?;
    let _ = fs::remove_file(&zip_path);
    Ok(status)
}

fn auto_updater_proxy(proxy_url: Option<&str>) -> Result<Option<reqwest::Proxy>, String> {
    match proxy_url.map(str::trim).filter(|value| !value.is_empty()) {
        Some(url) => reqwest::Proxy::all(url)
            .map(Some)
            .map_err(|error| format!("代理地址无效：{error}")),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        normalize_port, probe_canvas, probe_gateway, start_with_pack, stop, CanvasConfig,
        DEFAULT_CANVAS_PORT, DEFAULT_GATEWAY_PORT,
    };
    use std::path::PathBuf;
    use std::sync::Mutex;

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn default_ports_are_stable() {
        let config = CanvasConfig::default();
        assert_eq!(config.canvas_port, DEFAULT_CANVAS_PORT);
        assert_eq!(config.gateway_port, DEFAULT_GATEWAY_PORT);
    }

    #[test]
    fn invalid_ports_fall_back() {
        assert_eq!(normalize_port(0, 3210), 3210);
        assert_eq!(normalize_port(80, 3210), 3210);
        assert_eq!(normalize_port(3210, 3210), 3210);
    }

    #[test]
    fn sanitize_rejects_bad_comfy_url() {
        let config = CanvasConfig {
            comfy_url: "file:///etc/passwd".to_string(),
            ..CanvasConfig::default()
        }
        .sanitized();
        assert_eq!(config.comfy_url, "http://127.0.0.1:8188");
    }

    /// 本地 smoke：需要 `app/resources/canvas` 已构建、系统有合规 Node。
    /// 运行：cargo test canvas_smoke -- --ignored --nocapture
    #[test]
    #[ignore]
    fn canvas_smoke() {
        let _guard = TEST_LOCK.lock().expect("测试锁");
        let pack = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("resources")
            .join("canvas");
        if !pack.join("web").join("index.html").is_file() {
            eprintln!("跳过：未找到本地画布模块 {}", pack.display());
            return;
        }
        let config = CanvasConfig {
            canvas_port: 3211,
            gateway_port: 8191,
            ..CanvasConfig::default()
        };
        stop().ok();
        start_with_pack(&pack, &config).expect("画布应能启动");
        assert!(probe_gateway(8191), "网关 /health 应就绪");
        assert!(probe_canvas(3211), "画布 /config.js 应可访问");
        let html = super::http_get_text("http://127.0.0.1:3211/", 2000).expect("画布首页应可访问");
        assert!(html.contains("id=\"root\""), "画布首页应包含 root 容器");
        let config_js = super::http_get_text("http://127.0.0.1:3211/config.js", 2000)
            .expect("config.js 应可访问");
        assert!(config_js.contains("8191"), "config.js 应指向测试网关端口");
        stop().expect("画布应能停止");
    }

    /// 本地 smoke：先安装 build-canvas-pack.ps1 生成的 zip，再从安装目录启动。
    /// 运行：cargo test canvas_pack_install_smoke -- --ignored --nocapture
    #[test]
    #[ignore]
    fn canvas_pack_install_smoke() {
        let _guard = TEST_LOCK.lock().expect("测试锁");
        let zip = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("dist-canvas")
            .join("Agent_LLM_Canvas_v0.24.6.zip");
        if !zip.is_file() {
            eprintln!("跳过：未找到画布模块 zip {}", zip.display());
            return;
        }
        let installed = super::install_pack_from_zip(&zip).expect("画布模块应能安装");
        assert!(installed.installed);
        let pack_dir = super::installed_pack_dir();
        assert!(super::is_valid_pack(&pack_dir));
        let config = CanvasConfig {
            canvas_port: 3212,
            gateway_port: 8192,
            ..CanvasConfig::default()
        };
        stop().ok();
        start_with_pack(&pack_dir, &config).expect("安装后的画布模块应能启动");
        assert!(probe_gateway(8192), "安装后的网关应就绪");
        stop().expect("安装后的画布应能停止");
        let _ = std::fs::remove_dir_all(&pack_dir);
    }
}
