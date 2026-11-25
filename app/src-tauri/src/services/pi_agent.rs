//! Pi 智能体内核的 RPC 进程托管（实验阶段）。
//!
//! Pi 用 `--mode rpc` 跑一个常驻 Node 子进程，stdin/stdout 走 JSONL：
//! - 宿主 → Pi：`prompt` / `abort` 等命令；
//! - Pi → 宿主：`message_update` / `tool_execution_*` / `agent_settled` 等事件。
//!
//! 文件/命令由宿主代理：Pi 内置工具被禁用，扩展只把调用转给 `pi_tools`。
//! 命令执行不是 OS 级沙箱；详见 `pi_tools` 的安全边界说明。

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::thread;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::services::pi_tools::{self, PiPermissionMode};
use crate::services::process_manager;
use crate::services::storage_paths;

/// 前端下发的启动参数。路径由界面填写/自动探测，不写死。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiAgentStartOptions {
    pub node_path: String,
    pub cli_path: String,
    pub agent_dir: String,
    pub work_dir: String,
    pub provider: String,
    pub model: String,
    pub base_url: String,
    #[serde(default = "default_api_key")]
    pub api_key: String,
    #[serde(default = "default_permission_mode")]
    pub permission_mode: PiPermissionMode,
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub session_dir: String,
    /// 显式工作区目录：非空时直接作为 Pi 的沙箱与当前目录，
    /// 不再派生 `<workDir>/<session-id>`。Chat 里选中的工作区用它，
    /// 让同一个真实文件夹成为唯一的权限边界。
    #[serde(default)]
    pub workspace_dir: String,
    /// 模型上下文窗口；缺省 32768。用于写 models.json，避免 Pi 低估可用上下文。
    #[serde(default)]
    pub context_window: Option<u64>,
}

fn default_api_key() -> String {
    "local".to_string()
}

fn default_permission_mode() -> PiPermissionMode {
    PiPermissionMode::Auto
}

#[derive(Debug, Clone, Serialize)]
pub struct PiAgentStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub provider: String,
    pub model: String,
    pub work_dir: String,
    pub work_root: String,
    pub agent_dir: String,
    pub cli_path: String,
    pub permission_mode: String,
    pub session_id: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PiAgentDiscover {
    pub node_path: String,
    pub cli_path: Option<String>,
    pub agent_dir: String,
    pub work_dir: String,
    pub session_dir: String,
    pub skills_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiAgentInstallResult {
    pub target: String,
    pub version: String,
    pub files: usize,
    pub bytes: u64,
}

static PI_CHILD: Lazy<Mutex<Option<Child>>> = Lazy::new(|| Mutex::new(None));
static PI_STDIN: Lazy<Mutex<Option<ChildStdin>>> = Lazy::new(|| Mutex::new(None));
static PI_LOGS: Lazy<Mutex<Vec<String>>> = Lazy::new(|| Mutex::new(Vec::new()));
static PI_LAST_ERROR: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));
static PI_PROVIDER: Lazy<Mutex<String>> = Lazy::new(|| Mutex::new(String::new()));
static PI_MODEL: Lazy<Mutex<String>> = Lazy::new(|| Mutex::new(String::new()));
static PI_WORK_DIR: Lazy<Mutex<String>> = Lazy::new(|| Mutex::new(String::new()));
static PI_WORK_ROOT: Lazy<Mutex<String>> = Lazy::new(|| Mutex::new(String::new()));
static PI_AGENT_DIR: Lazy<Mutex<String>> = Lazy::new(|| Mutex::new(String::new()));
static PI_CLI_PATH: Lazy<Mutex<String>> = Lazy::new(|| Mutex::new(String::new()));
static PI_SESSION_ID: Lazy<Mutex<String>> = Lazy::new(|| Mutex::new(String::new()));
static PI_RUN_ID: Lazy<Mutex<String>> = Lazy::new(|| Mutex::new(String::new()));
/// 还没发出去的 prompt：Pi 还在跑上一轮时先排队，等 `agent_settled` 再按序发送。
/// 直接写 stdin 会被 Pi 以「Agent is already processing」拒收，气泡就会永久停在执行中。
static PI_PENDING_PROMPTS: Lazy<Mutex<VecDeque<serde_json::Value>>> =
    Lazy::new(|| Mutex::new(VecDeque::new()));
/// 串行化「判断空闲 → 写 stdin」这一步，避免两个并发任务同时发出。
static PI_PROMPT_GATE: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
/// 当前是否已有一轮在 Pi 里跑（直到 agent_settled 才复位）。
static PI_STREAMING: AtomicBool = AtomicBool::new(false);
/// 最近一次启动的 AppHandle：取消时用它把作废的排队任务通知前端。
static PI_APP: Lazy<Mutex<Option<AppHandle>>> = Lazy::new(|| Mutex::new(None));

/// 最近使用过的工作区（canonicalize 后）。Chat 切换会话后仍要能预览旧消息的产物，
/// 所以除了当前工作区，还要记住历史选区；上限防止无限增长。
static PI_WORK_HISTORY: Lazy<Mutex<Vec<PathBuf>>> = Lazy::new(|| Mutex::new(Vec::new()));
const WORK_HISTORY_CAP: usize = 20;

static PI_RUNNING: AtomicBool = AtomicBool::new(false);
static PI_PID: AtomicU32 = AtomicU32::new(0);
static PI_GENERATION: AtomicU32 = AtomicU32::new(0);
static PI_RUN_SEQ: AtomicU32 = AtomicU32::new(1);

const LOG_CAP: usize = 4000;

/// 供工具代理写入同一条运行日志。
pub fn add_log(line: &str) {
    push_log(line);
}

fn push_log(line: &str) {
    if let Ok(mut logs) = PI_LOGS.lock() {
        if logs.len() >= LOG_CAP {
            let drop = logs.len() - LOG_CAP + 1;
            logs.drain(..drop);
        }
        logs.push(line.to_string());
    }
}

fn set_last_error(message: Option<String>) {
    if let Ok(mut slot) = PI_LAST_ERROR.lock() {
        *slot = message;
    }
}

fn set_string(slot: &Mutex<String>, value: &str) {
    if let Ok(mut guard) = slot.lock() {
        *guard = value.to_string();
    }
}

fn get_string(slot: &Mutex<String>) -> String {
    slot.lock().map(|guard| guard.clone()).unwrap_or_default()
}

pub(crate) fn pi_data_root() -> PathBuf {
    storage_paths::app_data_root().join("pi")
}

/// 默认 agent / work 目录。
pub fn default_agent_dir() -> PathBuf {
    let dir = pi_data_root().join("agent");
    std::fs::create_dir_all(&dir).ok();
    dir
}

pub fn default_work_dir() -> PathBuf {
    let dir = pi_data_root().join("work");
    std::fs::create_dir_all(&dir).ok();
    dir
}

pub fn default_session_dir() -> PathBuf {
    let dir = pi_data_root().join("sessions");
    std::fs::create_dir_all(&dir).ok();
    dir
}

/// 会话 id → 安全目录名（只保留字母、数字、点、下划线、短横线）。
pub fn sanitize_session_name(session_id: &str) -> String {
    let cleaned: String = session_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "pi-session".to_string()
    } else {
        cleaned
    }
}

/// 当前 Pi 进程的会话工作区（未启动时为空）。
pub fn current_work_dir() -> Option<PathBuf> {
    let path = get_string(&PI_WORK_DIR);
    let path = path.trim();
    if path.is_empty() {
        None
    } else {
        Some(PathBuf::from(path))
    }
}

/// 启动时配置的工作区根目录。产物读取以它、当前工作区和历史选区为边界。
pub fn current_work_root() -> Option<PathBuf> {
    let path = get_string(&PI_WORK_ROOT);
    let path = path.trim();
    if path.is_empty() {
        None
    } else {
        Some(PathBuf::from(path))
    }
}

/// 记住一个实际用过的会话工作区（供产物读取跨会话定位旧消息的产物）。
fn remember_work_dir(dir: &Path) {
    let Ok(canonical) = dir.canonicalize() else {
        return;
    };
    if let Ok(mut list) = PI_WORK_HISTORY.lock() {
        if list.contains(&canonical) {
            return;
        }
        list.push(canonical);
        if list.len() > WORK_HISTORY_CAP {
            list.remove(0);
        }
    }
}

/// 最近使用过的工作区列表（已 canonicalize），产物读取的允许边界之一。
pub(crate) fn known_work_dirs() -> Vec<PathBuf> {
    PI_WORK_HISTORY
        .lock()
        .map(|list| list.clone())
        .unwrap_or_default()
}

/// 探测 Pi CLI 与 Node。
///
/// 顺序：环境变量 → 应用数据目录 → 资源目录 → 临时实验安装 → 全局 npm。
/// 这里保留临时目录只是为了让本轮实验开箱可用；正式分发时应把 Pi 装进
/// `%APPDATA%\AgentLLM\pi` 或 resources。
pub fn discover() -> PiAgentDiscover {
    let node_path = std::env::var("PI_AGENT_NODE")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "node".to_string());

    let mut candidates: Vec<(PathBuf, bool)> = Vec::new();
    if let Ok(path) = std::env::var("PI_AGENT_CLI") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            // 显式指定视为可信，允许自定义构建，不再校验包名。
            candidates.push((PathBuf::from(trimmed), false));
        }
    }
    candidates.push((
        pi_data_root()
            .join("node_modules")
            .join("@earendil-works")
            .join("pi-coding-agent")
            .join("dist")
            .join("bundle")
            .join("cli.js"),
        true,
    ));
    candidates.push((
        crate::services::auto_updater::resource_dir()
            .join("pi")
            .join("node_modules")
            .join("@earendil-works")
            .join("pi-coding-agent")
            .join("dist")
            .join("bundle")
            .join("cli.js"),
        true,
    ));
    // %TEMP% 只作开发期候选（本地 spike 残留）：发布版不从这里自动执行，
    // 否则同用户进程只要往 TEMP 写一份 cli.js，就能实现「写入即执行」。
    if cfg!(debug_assertions) {
        candidates.push((
            std::env::temp_dir()
                .join("opencode")
                .join("pi-spike")
                .join("node_modules")
                .join("@earendil-works")
                .join("pi-coding-agent")
                .join("dist")
                .join("bundle")
                .join("cli.js"),
            true,
        ));
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        candidates.push((
            PathBuf::from(appdata)
                .join("npm")
                .join("node_modules")
                .join("@earendil-works")
                .join("pi-coding-agent")
                .join("dist")
                .join("bundle")
                .join("cli.js"),
            true,
        ));
    }

    let cli_path = candidates
        .into_iter()
        .find(|(path, require_package)| {
            path.is_file() && (!require_package || discovered_cli_is_trusted(path))
        })
        .map(|(path, _)| path.display().to_string());

    PiAgentDiscover {
        node_path,
        cli_path,
        agent_dir: default_agent_dir().display().to_string(),
        work_dir: default_work_dir().display().to_string(),
        session_dir: default_session_dir().display().to_string(),
        skills_dir: crate::services::pi_skills::default_skills_dir(None)
            .map(|path| path.display().to_string()),
    }
}

/// 从指定 Node 安装目录找到 `node_modules` 根。
pub(crate) fn find_node_modules(path: &Path) -> Option<PathBuf> {
    let path = path.canonicalize().ok()?;
    let mut current: Option<&Path> = Some(path.as_path());
    while let Some(candidate) = current {
        if candidate.file_name().map(|name| name == "node_modules").unwrap_or(false) {
            return Some(candidate.to_path_buf());
        }
        current = candidate.parent();
    }
    None
}

pub(crate) fn read_pi_version(node_modules: &Path) -> Option<String> {
    let file = node_modules
        .join("@earendil-works")
        .join("pi-coding-agent")
        .join("package.json");
    let text = std::fs::read_to_string(file).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get("version")?.as_str().map(str::to_string)
}

/// 自动发现的 Pi CLI 是否来自可信包：向上找最近的 package.json，要求
/// `name` 为 `@earendil-works/pi-coding-agent` 且 `version` 非空。
/// 显式 `PI_AGENT_CLI` 不走该校验（用户自行指定，允许自定义构建）。
fn discovered_cli_is_trusted(cli: &Path) -> bool {
    let mut current = cli.parent();
    for _ in 0..6 {
        let Some(dir) = current else {
            return false;
        };
        let package = dir.join("package.json");
        if let Ok(text) = std::fs::read_to_string(&package) {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
                return false;
            };
            let name = value.get("name").and_then(|item| item.as_str());
            let version = value.get("version").and_then(|item| item.as_str());
            return name == Some("@earendil-works/pi-coding-agent")
                && version.map(|item| !item.trim().is_empty()).unwrap_or(false);
        }
        current = dir.parent();
    }
    false
}

fn copy_tree(source: &Path, target: &Path) -> Result<(usize, u64), String> {
    std::fs::create_dir_all(target)
        .map_err(|error| format!("创建安装目录失败：{error}"))?;
    let mut files = 0usize;
    let mut bytes = 0u64;
    let mut stack = vec![(source.to_path_buf(), target.to_path_buf())];
    while let Some((from, to)) = stack.pop() {
        let entries = std::fs::read_dir(&from)
            .map_err(|error| format!("读取 {} 失败：{error}", from.display()))?;
        for entry in entries.flatten() {
            let file_type = match entry.file_type() {
                Ok(value) => value,
                Err(_) => continue,
            };
            let next_to = to.join(entry.file_name());
            if file_type.is_dir() {
                std::fs::create_dir_all(&next_to)
                    .map_err(|error| format!("创建 {} 失败：{error}", next_to.display()))?;
                stack.push((entry.path(), next_to));
            } else if file_type.is_file() {
                std::fs::copy(entry.path(), &next_to)
                    .map_err(|error| format!("复制 {} 失败：{error}", entry.path().display()))?;
                files += 1;
                bytes += entry.metadata().map(|meta| meta.len()).unwrap_or(0);
            }
            // 符号链接跳过：避免把临时安装里的链接或环复制进应用数据目录。
        }
    }
    Ok((files, bytes))
}

/// 把当前可用的 Pi 运行时复制到 `%APPDATA%\AgentLLM\pi\node_modules`。
///
/// 这一步不是在线安装器：它把已经验证可用的 Node 包正式落到应用数据目录，
/// 并写 `pi-version.json` 作为版本锁定记录。后续 `discover()` 会优先使用它。
pub fn install(source: Option<&str>) -> Result<PiAgentInstallResult, String> {
    // Windows 下 rename 正在使用的 node_modules 会共享冲突；Pi 在跑时直接拒绝。
    if is_running() {
        return Err("Pi 正在运行：请先停止 Pi（或等当前任务收尾）再安装。".to_string());
    }
    // 复制安装与在线安装 / 回滚共用同一把安装锁，避免并发 rename 互相覆盖。
    let _install_guard = crate::services::pi_install::InstallGuard::try_acquire()
        .ok_or_else(|| "已有 Pi 安装 / 回滚正在进行中".to_string())?;
    let source_node_modules = source
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| find_node_modules(Path::new(value)))
        .or_else(|| {
            discover()
                .cli_path
                .as_deref()
                .and_then(|path| find_node_modules(Path::new(path)))
        })
        .or_else(|| find_node_modules(&pi_data_root()))
        .ok_or_else(|| {
            "未找到可安装的 Pi node_modules；请先配置 Pi CLI 路径或安装 @earendil-works/pi-coding-agent。"
                .to_string()
        })?;

    let target = pi_data_root().join("node_modules");
    let source = source_node_modules
        .canonicalize()
        .map_err(|error| format!("源目录不可用：{error}"))?;
    let target_canonical = target.canonicalize().ok();
    if target_canonical.as_deref() == Some(source.as_path()) {
        return Err("Pi 已经安装在应用数据目录。".to_string());
    }

    let version = read_pi_version(&source).unwrap_or_else(|| "unknown".to_string());
    let temp = pi_data_root().join(format!("node_modules.installing-{}", std::process::id()));
    if temp.exists() {
        let _ = std::fs::remove_dir_all(&temp);
    }
    let (files, bytes) = match copy_tree(&source, &temp) {
        Ok(stats) => stats,
        Err(error) => {
            // 复制失败必须清掉半成品临时目录，避免几十 MB 残留。
            let _ = std::fs::remove_dir_all(&temp);
            return Err(error);
        }
    };

    let backup = pi_data_root().join(format!(
        "node_modules.old-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0)
    ));
    if target.exists() {
        std::fs::rename(&target, &backup)
            .map_err(|error| format!("备份旧 Pi 安装失败：{error}"))?;
    }
    if let Err(error) = std::fs::rename(&temp, &target) {
        let _ = std::fs::remove_dir_all(&temp);
        if backup.exists() {
            if let Err(restore_error) = std::fs::rename(&backup, &target) {
                return Err(format!(
                    "安装 Pi 失败：{error}；恢复旧安装也失败：{restore_error}（旧安装保留在 {}）",
                    backup.display()
                ));
            }
            return Err(format!("安装 Pi 失败：{error}；已恢复旧安装。"));
        }
        return Err(format!("安装 Pi 失败：{error}；无上一版本可恢复。"));
    }
    let _ = std::fs::remove_dir_all(&backup);

    let lock = serde_json::json!({
        "name": "@earendil-works/pi-coding-agent",
        "version": version,
        "source": source.display().to_string(),
        "installedAt": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0)
    });
    std::fs::write(
        pi_data_root().join("pi-version.json"),
        serde_json::to_string_pretty(&lock).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("写入版本锁失败：{error}"))?;

    Ok(PiAgentInstallResult {
        target: target.display().to_string(),
        version,
        files,
        bytes,
    })
}

fn validate(options: &PiAgentStartOptions) -> Result<(), String> {    if options.node_path.trim().is_empty() {
        return Err("Node 路径不能为空".to_string());
    }
    let cli = Path::new(options.cli_path.trim());
    if !cli.is_file() {
        return Err(format!("Pi CLI 不存在：{}", cli.display()));
    }
    if options.agent_dir.trim().is_empty() {
        return Err("Agent 目录不能为空".to_string());
    }
    if options.work_dir.trim().is_empty() {
        return Err("工作目录不能为空".to_string());
    }
    if options.provider.trim().is_empty() {
        return Err("Provider 不能为空".to_string());
    }
    if options.model.trim().is_empty() {
        return Err("模型 ID 不能为空".to_string());
    }
    if !options.base_url.trim().starts_with("http") {
        return Err("引擎地址必须以 http:// 或 https:// 开头".to_string());
    }
    Ok(())
}

/// models.json 停止后的 apiKey 占位符（与设置页的密钥回显约定一致）。
const PI_API_KEY_PLACEHOLDER: &str = "{{SECRET_PI_API_KEY}}";

/// 把 models.json 里的明文 apiKey 擦成占位符。
///
/// Pi 只在启动时读一次 models.json，真实 Key 只需在「运行期间」落盘；
/// 停止 / 启动失败后就地擦除，避免引擎凭据长期明文留在磁盘上。崩溃残留的
/// 明文会在下一次启动写盘时被覆盖。解析失败保持原样，不做破坏性改写。
fn scrub_pi_models_api_key(agent_dir: &str) {
    let dir = agent_dir.trim();
    if dir.is_empty() {
        return;
    }
    let path = Path::new(dir).join("models.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return;
    };
    let Ok(mut models) = serde_json::from_str::<serde_json::Value>(&text) else {
        return;
    };
    let Some(providers) = models
        .get_mut("providers")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return;
    };
    let mut changed = false;
    for provider in providers.values_mut() {
        let needs_scrub = match provider.get("apiKey").and_then(serde_json::Value::as_str) {
            Some(key) => !key.is_empty() && key != "local" && key != PI_API_KEY_PLACEHOLDER,
            None => false,
        };
        if needs_scrub {
            provider["apiKey"] = serde_json::Value::String(PI_API_KEY_PLACEHOLDER.to_string());
            changed = true;
        }
    }
    if changed {
        let _ = std::fs::write(
            &path,
            serde_json::to_string_pretty(&models).unwrap_or_default(),
        );
    }
}

/// 写入 Pi 需要的 `models.json` / `settings.json`。
///
/// 这一步让用户不用手工改 Pi 配置；本轮只支持一个本地 OpenAI 兼容端点。
/// models.json 里的真实 apiKey 只在 Pi 运行期间落盘（Pi 启动时读一次）；
/// 停止或启动失败后会由 [`scrub_pi_models_api_key`] 擦成占位符。
fn write_pi_config(options: &PiAgentStartOptions) -> Result<(), String> {
    let agent_dir = Path::new(options.agent_dir.trim());
    let work_dir = Path::new(options.work_dir.trim());
    std::fs::create_dir_all(agent_dir)
        .map_err(|error| format!("创建 Agent 目录失败：{error}"))?;
    std::fs::create_dir_all(work_dir)
        .map_err(|error| format!("创建工作目录失败：{error}"))?;

    let provider = options.provider.trim();
    let model = options.model.trim();
    let api_key = if options.api_key.trim().is_empty() {
        "local"
    } else {
        options.api_key.trim()
    };

    let mut providers = serde_json::Map::new();
    let context_window = options
        .context_window
        .filter(|value| *value >= 2048)
        .unwrap_or(32768);
    let max_tokens = (context_window / 4).clamp(1024, 8192);
    providers.insert(
        provider.to_string(),
        serde_json::json!({
            "baseUrl": options.base_url.trim(),
            "api": "openai-completions",
            "apiKey": api_key,
            "models": [
                {
                    "id": model,
                    "name": model,
                    "contextWindow": context_window,
                    "maxTokens": max_tokens,
                    "input": ["text", "image"]
                }
            ]
        }),
    );
    let models = serde_json::json!({
        "$schema": "https://pi.dev/schemas/models.schema.json",
        "providers": providers
    });
    std::fs::write(
        agent_dir.join("models.json"),
        serde_json::to_string_pretty(&models).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("写入 models.json 失败：{error}"))?;

    let settings = serde_json::json!({
        "defaultProvider": provider,
        "defaultModel": model,
        "defaultThinkingLevel": "off",
        // 空数组 = 关闭所有 builtin 默认工具；扩展工具仍然可用。
        "defaultTools": [],
        "compaction": { "enabled": false }
    });
    std::fs::write(
        agent_dir.join("settings.json"),
        serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("写入 settings.json 失败：{error}"))?;
    Ok(())
}

/// 把宿主工具代理扩展写到 Agent 目录；Pi 用 `--extension` 显式加载它。
fn write_host_extension(agent_dir: &Path) -> Result<PathBuf, String> {
    let extensions = agent_dir.join("extensions");
    std::fs::create_dir_all(&extensions)
        .map_err(|error| format!("创建扩展目录失败：{error}"))?;
    let path = extensions.join("host-tools.ts");
    std::fs::write(&path, include_str!("pi_host_tools.ts"))
        .map_err(|error| format!("写入 host-tools.ts 失败：{error}"))?;
    Ok(path)
}

/// Pi 子进程是否在跑（在线安装 / 回滚的前置检查用）。
pub fn is_running() -> bool {
    PI_RUNNING.load(Ordering::SeqCst)
}

/// 停止并回收 Pi 进程树。
pub fn stop() {
    PI_GENERATION.fetch_add(1, Ordering::SeqCst);
    PI_RUNNING.store(false, Ordering::SeqCst);
    PI_STREAMING.store(false, Ordering::SeqCst);
    if let Ok(mut queue) = PI_PENDING_PROMPTS.lock() {
        queue.clear();
    }
    if let Ok(mut stdin) = PI_STDIN.lock() {
        *stdin = None;
    }
    if let Ok(mut child) = PI_CHILD.lock() {
        if let Some(mut child) = child.take() {
            process_manager::terminate_process_tree(&mut child, "pi-agent");
        }
    }
    pi_tools::stop_bridge();
    let agent_dir = PI_AGENT_DIR
        .lock()
        .map(|slot| slot.clone())
        .unwrap_or_default();
    scrub_pi_models_api_key(&agent_dir);
    PI_PID.store(0, Ordering::SeqCst);
}

pub fn stop_on_exit() {
    stop();
}

/// 打开 / 聚焦 Pi 浮窗（Agent 页之外的常驻快聊入口）。
///
/// 窗口关闭只是隐藏（下次打开复用，Pi 会话与配置不丢）；置顶 + 不进任务栏，
/// 方便边干活边问。内容走主窗口同源的 `#/pi-float` hash 路由，由前端按
/// hash 渲染独立视图。注意：`WebviewUrl::App` 带 hash 在发布态会落到
/// about:blank，所以这里用主窗口的运行时 origin 拼 External URL。
pub fn open_float_window(app: &AppHandle) -> Result<(), String> {
    let app_handle = app.clone();
    // 动态窗口必须在主线程创建（与画布窗口同因：命令线程 build 会得到
    // 一个 about:blank 后立刻消失的窗口）。
    app.run_on_main_thread(move || {
        if let Some(window) = app_handle.get_webview_window("pi-float") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
            return;
        }
        let Some(url) = app_handle
            .get_webview_window("main")
            .and_then(|main| main.url().ok())
            .map(|current| {
                let origin = current.origin().ascii_serialization();
                tauri::Url::parse(&format!("{origin}/#/pi-float")).ok()
            })
            .flatten()
        else {
            eprintln!("[pi] 无法确定应用 origin，Pi 浮窗未创建");
            return;
        };
        let builder = tauri::WebviewWindowBuilder::new(
            &app_handle,
            "pi-float",
            tauri::WebviewUrl::External(url.clone()),
        )
        .title("拾壹 · Pi 浮窗")
        .inner_size(360.0, 480.0)
        .min_inner_size(300.0, 360.0)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(true);
        match builder.build() {
            Ok(window) => {
                // 某些 WebView2 版本在 builder 里给外部 URL 时只创建
                // about:blank，显式导航一次兜底（与画布窗口同一坑）。
                if let Err(error) = window.navigate(url) {
                    eprintln!("[pi] float navigate failed: {error}");
                }
                // 关闭 = 隐藏，浮窗作为常驻入口反复开关。
                let hidden = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = hidden.hide();
                    }
                });
                let _ = window.show();
                let _ = window.set_focus();
            }
            Err(error) => eprintln!("[pi] create float window failed: {error}"),
        }
    })
    .map_err(|error| format!("无法在主线程序列化 Pi 浮窗：{error}"))?;
    Ok(())
}

/// 启动 Pi RPC 子进程。重复调用会先停掉旧进程。
pub fn start(app: AppHandle, options: PiAgentStartOptions) -> Result<PiAgentStatus, String> {
    validate(&options)?;
    stop();
    set_last_error(None);
    write_pi_config(&options)?;
    let extension_path = write_host_extension(Path::new(options.agent_dir.trim()))?;

    let node = options.node_path.trim();
    let cli = options.cli_path.trim();
    let work_root = PathBuf::from(options.work_dir.trim());
    let agent_dir = PathBuf::from(options.agent_dir.trim());
    let extension_arg = extension_path.display().to_string();
    let session_id = if options.session_id.trim().is_empty() {
        format!(
            "pi-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_millis())
                .unwrap_or(0)
        )
    } else {
        options.session_id.trim().to_string()
    };
    // 每个会话一个独立工作区：<根目录>/<session-id>。路径由宿主派生，
    // 前端只传根目录，避免两边各算一次导致不一致。
    // 显式 workspaceDir 时直接用它：Chat 的工作区就是一个真实文件夹，
    // 会话共享同一份文件，权限边界也以这个文件夹为准。
    let explicit_workspace = options.workspace_dir.trim();
    let work_dir = if explicit_workspace.is_empty() {
        work_root.join(sanitize_session_name(&session_id))
    } else {
        let dir = PathBuf::from(explicit_workspace);
        if dir.is_absolute() {
            dir
        } else {
            work_root.join(dir)
        }
    };
    std::fs::create_dir_all(&work_dir)
        .map_err(|error| format!("创建 Pi 工作区失败：{error}"))?;
    // 记录本次实际工作区：产物读取允许当前/历史选区，不再只认工作区根目录。
    remember_work_dir(&work_dir);
    let session_dir = if options.session_dir.trim().is_empty() {
        default_session_dir()
    } else {
        PathBuf::from(options.session_dir.trim())
    };
    std::fs::create_dir_all(&session_dir)
        .map_err(|error| format!("创建 Pi 会话目录失败：{error}"))?;
    let session_dir_arg = session_dir.display().to_string();

    let (bridge_url, bridge_token) =
        pi_tools::start_bridge(app.clone(), work_dir.clone(), options.permission_mode, {
            app.state::<crate::models::app_state::AppState>()
                .config
                .lock()
                .map(|config| config.mcp_servers.clone())
                .unwrap_or_default()
        })?;
    push_log("[pi] 工具桥已启动（127.0.0.1，随机 token）");

    let mut command = Command::new(node);
    command
        .arg(cli)
        .args([
            "--mode",
            "rpc",
            "--provider",
            options.provider.trim(),
            "--model",
            options.model.trim(),
            "--thinking",
            "off",
            "--no-context-files",
            "--no-builtin-tools",
            "--no-extensions",
            "--no-mcp",
        ])
        .arg("--session-id")
        .arg(&session_id)
        .arg("--session-dir")
        .arg(&session_dir_arg)
        .arg("--extension")
        .arg(&extension_arg)
        .current_dir(&work_dir)
        .env("PI_CODING_AGENT_DIR", &agent_dir)
        .env("PI_OFFLINE", "1")
        .env("PI_HOST_BRIDGE_URL", &bridge_url)
        .env("PI_HOST_BRIDGE_TOKEN", &bridge_token)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            pi_tools::stop_bridge();
            scrub_pi_models_api_key(&agent_dir.display().to_string());
            return Err(format!(
                "启动 Pi 失败：{error}（检查 Node 是否在 PATH 或路径是否正确）"
            ));
        }
    };
    process_manager::attach_child_job(&child, "pi-agent");

    let (stdin, stdout, stderr) = match (child.stdin.take(), child.stdout.take(), child.stderr.take()) {
        (Some(stdin), Some(stdout), Some(stderr)) => (stdin, stdout, stderr),
        _ => {
            process_manager::terminate_process_tree(&mut child, "pi-agent");
            pi_tools::stop_bridge();
            scrub_pi_models_api_key(&agent_dir.display().to_string());
            return Err("无法获取 Pi 标准流".to_string());
        }
    };
    let pid = child.id();

    set_string(&PI_PROVIDER, options.provider.trim());
    set_string(&PI_MODEL, options.model.trim());
    set_string(&PI_WORK_DIR, &work_dir.display().to_string());
    set_string(&PI_WORK_ROOT, &work_root.display().to_string());
    set_string(&PI_AGENT_DIR, &agent_dir.display().to_string());
    set_string(&PI_CLI_PATH, cli);
    set_string(&PI_SESSION_ID, &session_id);
    set_string(&PI_RUN_ID, "");
    PI_STREAMING.store(false, Ordering::SeqCst);
    if let Ok(mut queue) = PI_PENDING_PROMPTS.lock() {
        queue.clear();
    }
    if let Ok(mut slot) = PI_APP.lock() {
        *slot = Some(app.clone());
    }
    if let Ok(mut slot) = PI_STDIN.lock() {
        *slot = Some(stdin);
    }
    if let Ok(mut slot) = PI_CHILD.lock() {
        *slot = Some(child);
    }
    PI_RUNNING.store(true, Ordering::SeqCst);
    PI_PID.store(pid, Ordering::SeqCst);
    let generation = PI_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    push_log(&format!(
        "[pi] 已启动 pid={pid}，session={session_id}，cli={cli}"
    ));

    let app_out = app.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            if PI_GENERATION.load(Ordering::SeqCst) != generation {
                break;
            }
            let Ok(line) = line else { break };
            let line = line.trim().to_string();
            if line.is_empty() {
                continue;
            }
            push_log(&format!("[pi] {line}"));
            match serde_json::from_str::<serde_json::Value>(&line) {
                Ok(event) => {
                    // 事件归属哪一轮，以 Pi 的 RPC 应答为准：Pi 认下这条 prompt
                    // （type=response 且 id 是我们的 run id）之后，后续事件才算这一轮的。
                    //
                    // 之前在 run() 里就把全局 run id 换掉，于是「取消上一轮后马上再发」
                    // 时，上一轮迟迟不来的收尾事件会被打成新的一轮 —— 前端误判收尾、
                    // 把新一轮的空气泡结掉，真正输出整段丢失。
                    //
                    // 被拒收的 prompt 不能切换全局轮次标签；但应答本身要按它自己的 id
                    // 发出，前端才能把对应气泡收尾，而不是永久停在「执行中」。
                    let event_type = event
                        .get("type")
                        .and_then(|value| value.as_str())
                        .map(str::to_string);
                    let mut run_id = get_string(&PI_RUN_ID);
                    let mut rejected_prompt = false;
                    if event_type.as_deref() == Some("response") {
                        if let Some(id) = event.get("id").and_then(|value| value.as_str()) {
                            if id.starts_with("run-") {
                                let accepted = event
                                    .get("success")
                                    .and_then(serde_json::Value::as_bool)
                                    .unwrap_or(false);
                                if accepted {
                                    set_string(&PI_RUN_ID, id);
                                } else {
                                    rejected_prompt = true;
                                }
                                run_id = id.to_string();
                            }
                        }
                    }
                    app_out
                        .emit(
                            "pi:event",
                            serde_json::json!({ "runId": run_id, "event": event }),
                        )
                        .ok();
                    if rejected_prompt {
                        // prompt 被 Pi 拒收（例如上下文压缩中）：这一轮已经结束，
                        // 继续发排队任务，避免后续任务跟着卡死。
                        PI_STREAMING.store(false, Ordering::SeqCst);
                        push_log("[pi] prompt 被拒收，继续发送排队任务");
                        flush_pending_prompt(&app_out);
                    } else if event_type.as_deref() == Some("agent_settled") {
                        // Pi 真正收尾这一轮（含取消）；把之后排队的任务按序发出。
                        PI_STREAMING.store(false, Ordering::SeqCst);
                        flush_pending_prompt(&app_out);
                    }
                }
                Err(_) => {
                    app_out
                        .emit("pi:log", serde_json::json!({ "line": line, "stream": "stdout" }))
                        .ok();
                }
            }
        }
        if PI_GENERATION.load(Ordering::SeqCst) == generation {
            PI_STREAMING.store(false, Ordering::SeqCst);
            // 进程退出时排队的任务不可能再执行：按拒收回给前端，气泡能收尾。
            let dropped = drain_pending_prompts();
            for command in dropped {
                let id = pending_prompt_id(&command);
                if id.is_empty() {
                    continue;
                }
                app_out
                    .emit(
                        "pi:event",
                        serde_json::json!({
                            "runId": id.clone(),
                            "event": {
                                "type": "response",
                                "id": id,
                                "command": "prompt",
                                "success": false,
                                "error": "Pi 进程已退出，排队任务未执行"
                            }
                        }),
                    )
                    .ok();
            }
            PI_RUNNING.store(false, Ordering::SeqCst);
            PI_PID.store(0, Ordering::SeqCst);
            app_out
                .emit("pi:exit", serde_json::json!({ "message": "Pi 进程已退出" }))
                .ok();
        }
    });

    let app_err = app.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            push_log(&format!("[pi:stderr] {line}"));
            app_err
                .emit(
                    "pi:log",
                    serde_json::json!({ "line": line, "stream": "stderr" }),
                )
                .ok();
        }
    });

    let status = status();
    app.emit("pi:ready", &status).ok();
    Ok(status)
}

fn write_command(value: &serde_json::Value) -> Result<(), String> {
    let mut guard = PI_STDIN
        .lock()
        .map_err(|_| "Pi stdin 锁失败".to_string())?;
    let stdin = guard
        .as_mut()
        .ok_or_else(|| "Pi 未启动或 stdin 已关闭".to_string())?;
    let line = serde_json::to_string(value).map_err(|error| error.to_string())?;
    stdin
        .write_all(line.as_bytes())
        .map_err(|error| format!("写入 Pi 失败：{error}"))?;
    stdin
        .write_all(b"\n")
        .map_err(|error| format!("写入 Pi 失败：{error}"))?;
    stdin
        .flush()
        .map_err(|error| format!("刷新 Pi stdin 失败：{error}"))?;
    Ok(())
}

fn pending_prompt_id(command: &serde_json::Value) -> String {
    command
        .get("id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn drain_pending_prompts() -> Vec<serde_json::Value> {
    PI_PENDING_PROMPTS
        .lock()
        .map(|mut queue| queue.drain(..).collect())
        .unwrap_or_default()
}

/// Pi 收尾后把排队中的下一条 prompt 发出去。
///
/// 只在 Pi 空闲（`agent_settled` 之后）调用，从根上避免「一轮未结束又发 prompt」
/// 被 Pi 拒收，也避免上一轮的收尾事件被误算到新一轮头上。
fn flush_pending_prompt(app: &AppHandle) {
    let Ok(_gate) = PI_PROMPT_GATE.lock() else {
        return;
    };
    loop {
        let next = PI_PENDING_PROMPTS
            .lock()
            .ok()
            .and_then(|mut queue| queue.pop_front());
        let Some(command) = next else {
            return;
        };
        let id = pending_prompt_id(&command);
        // 真正发车时才切检查点轮次：排队的 prompt 不能提前抢走上一轮的文件改动。
        pi_tools::begin_change_set();
        PI_STREAMING.store(true, Ordering::SeqCst);
        match write_command(&command) {
            Ok(()) => {
                push_log(&format!("[pi] prompt {id} 已发送（排队任务）"));
                return;
            }
            Err(error) => {
                PI_STREAMING.store(false, Ordering::SeqCst);
                push_log(&format!("[pi] prompt {id} 发送失败：{error}"));
                app.emit(
                    "pi:event",
                    serde_json::json!({
                        "runId": id.clone(),
                        "event": {
                            "type": "response",
                            "id": id,
                            "command": "prompt",
                            "success": false,
                            "error": error
                        }
                    }),
                )
                .ok();
            }
        }
    }
}

/// 发一条任务。`skill_context` 是宿主雷达选中的技能正文；【长期记忆】块
/// 由宿主读取全局记忆后自动拼在前面。返回本轮 run_id。
///
/// 如果 Pi 还在跑上一轮，任务先进入宿主队列（返回的 run_id 不变），
/// 等这一轮 `agent_settled` 后再发送，避免被 Pi 以「正在处理」拒收。
pub fn run(prompt: &str, skill_context: Option<&str>, images: Option<&[serde_json::Value]>) -> Result<String, String> {
    if !PI_RUNNING.load(Ordering::SeqCst) {
        push_log(&format!(
            "[pi] run rejected: not running pid={} session={}",
            PI_PID.load(Ordering::SeqCst),
            get_string(&PI_SESSION_ID)
        ));
        return Err("Pi 未启动".to_string());
    }
    let text = prompt.trim();
    if text.is_empty() {
        return Err("任务不能为空".to_string());
    }
    let run_id = format!("run-{}", PI_RUN_SEQ.fetch_add(1, Ordering::SeqCst));
    // 注意：这里不要动 PI_RUN_ID。当前轮次要等 Pi 的 RPC 应答确认后才在 stdout
    // 线程里切换，否则上一轮未收尾的事件会被算到这一轮头上（见 stdout 线程注释）。
    let mut sections = String::new();
    let memory = crate::services::pi_memory::render_memory_context();
    if !memory.is_empty() {
        sections.push_str(&memory);
        sections.push_str("\n\n");
    }
    if let Some(skills) = skill_context.map(str::trim).filter(|value| !value.is_empty()) {
        sections.push_str(&format!(
            "【本轮技能说明】（宿主路由命中，必须按里面的规则做）\n{skills}\n\n"
        ));
    }
    sections.push_str(&format!("【用户任务】\n{text}"));
    let mut command = serde_json::json!({
        "id": run_id,
        "type": "prompt",
        "message": sections
    });
    if let Some(images) = images.filter(|list| !list.is_empty()) {
        command["images"] = serde_json::Value::Array(images.to_vec());
    }
    {
        let _gate = PI_PROMPT_GATE
            .lock()
            .map_err(|_| "Pi 任务队列锁失败".to_string())?;
        if PI_STREAMING.load(Ordering::SeqCst) {
            // Pi 还在跑上一轮：先排队，等 agent_settled 后再发。
            // 直接写 stdin 会被 Pi 拒收（要求 streamingBehavior），新气泡会卡住。
            PI_PENDING_PROMPTS
                .lock()
                .map_err(|_| "Pi 任务队列锁失败".to_string())?
                .push_back(command);
            push_log(&format!("[pi] prompt {run_id} 已排队（上一轮未收尾）"));
            return Ok(run_id);
        }
        pi_tools::begin_change_set();
        PI_STREAMING.store(true, Ordering::SeqCst);
        if let Err(error) = write_command(&command) {
            PI_STREAMING.store(false, Ordering::SeqCst);
            return Err(error);
        }
    }
    push_log(&format!(
        "[pi] prompt {run_id}: {}",
        text.chars().take(120).collect::<String>()
    ));
    Ok(run_id)
}

/// 取消当前轮次（Pi 的 `abort` 命令）。
pub fn cancel() -> Result<(), String> {
    if !PI_RUNNING.load(Ordering::SeqCst) {
        return Err("Pi 未启动".to_string());
    }
    // 取消 = 这一轮连同还没发出去的排队任务一起作废；否则用户点了停止，
    // 排队中的任务仍会在上一轮收尾后悄悄开跑。
    let dropped = drain_pending_prompts();
    if !dropped.is_empty() {
        if let Some(app) = PI_APP.lock().ok().and_then(|slot| slot.clone()) {
            for command in dropped {
                let id = pending_prompt_id(&command);
                if id.is_empty() {
                    continue;
                }
                app.emit(
                    "pi:event",
                    serde_json::json!({
                        "runId": id.clone(),
                        "event": {
                            "type": "response",
                            "id": id,
                            "command": "prompt",
                            "success": false,
                            "error": "任务已取消"
                        }
                    }),
                )
                .ok();
            }
        }
    }
    let abort = write_command(&serde_json::json!({ "type": "abort" }));
    // 挂起的权限确认也必须一起撤销：只发 abort 不会唤醒工具桥上等待
    // rx.recv_timeout 的线程，用户随后点「允许」仍会真的执行写文件/命令。
    // 即使 abort 写入失败（stdin 已关）也要先拒绝，避免桥被占满 120 秒。
    pi_tools::deny_all_pending();
    abort?;
    push_log("[pi] abort");
    Ok(())
}

/// 触发一次 Pi 原生上下文压缩（RPC `compact`）。
///
/// 由 Chat 输入栏的「压缩上下文」按钮调用；Pi 会用当前模型把较早的对话
/// 汇总成摘要，后续请求从摘要继续，而不是无限增长。压缩期间不应再发新任务。
pub fn compact(custom_instructions: Option<&str>) -> Result<(), String> {
    if !PI_RUNNING.load(Ordering::SeqCst) {
        return Err("Pi 未启动".to_string());
    }
    let id = format!("compact-{}", PI_RUN_SEQ.fetch_add(1, Ordering::SeqCst));
    let mut command = serde_json::json!({ "id": id, "type": "compact" });
    if let Some(text) = custom_instructions.map(str::trim).filter(|value| !value.is_empty()) {
        command["customInstructions"] = serde_json::Value::String(text.to_string());
    }
    write_command(&command)?;
    push_log("[pi] compact");
    Ok(())
}

pub fn status() -> PiAgentStatus {
    let running = PI_RUNNING.load(Ordering::SeqCst);
    let pid = PI_PID.load(Ordering::SeqCst);
    let last_error = PI_LAST_ERROR
        .lock()
        .ok()
        .and_then(|guard| guard.clone());
    PiAgentStatus {
        running,
        pid: if pid == 0 { None } else { Some(pid) },
        provider: get_string(&PI_PROVIDER),
        model: get_string(&PI_MODEL),
        work_dir: get_string(&PI_WORK_DIR),
        work_root: get_string(&PI_WORK_ROOT),
        agent_dir: get_string(&PI_AGENT_DIR),
        cli_path: get_string(&PI_CLI_PATH),
        permission_mode: pi_tools::current_mode().as_str().to_string(),
        session_id: get_string(&PI_SESSION_ID),
        message: last_error,
    }
}

pub fn get_logs() -> Vec<String> {
    PI_LOGS
        .lock()
        .map(|logs| logs.clone())
        .unwrap_or_default()
}

pub fn clear_logs() {
    if let Ok(mut logs) = PI_LOGS.lock() {
        logs.clear();
    }
}

pub fn set_error(message: impl Into<String>) {
    let message = message.into();
    push_log(&format!("[pi:error] {message}"));
    set_last_error(Some(message));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 自动发现候选必须校验包身份：非官方包名 / 缺 version 一律拒绝，
    /// 防止 TEMP 或 npm 目录里的同名假 cli.js 被宿主执行。
    #[test]
    fn discovered_cli_requires_matching_package() {
        let root = std::env::temp_dir().join(format!(
            "agent-llm-pi-discover-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&root);
        let package = root.join("@earendil-works").join("pi-coding-agent");
        let cli = package.join("dist").join("bundle").join("cli.js");
        std::fs::create_dir_all(cli.parent().unwrap()).unwrap();
        std::fs::write(&cli, "// cli").unwrap();

        std::fs::write(
            package.join("package.json"),
            r#"{"name":"not-pi","version":"9.9.9"}"#,
        )
        .unwrap();
        assert!(!discovered_cli_is_trusted(&cli), "包名不符必须拒绝");

        std::fs::write(
            package.join("package.json"),
            r#"{"name":"@earendil-works/pi-coding-agent","version":"1.2.3"}"#,
        )
        .unwrap();
        assert!(discovered_cli_is_trusted(&cli), "官方包必须通过");

        std::fs::write(
            package.join("package.json"),
            r#"{"name":"@earendil-works/pi-coding-agent"}"#,
        )
        .unwrap();
        assert!(!discovered_cli_is_trusted(&cli), "缺 version 必须拒绝");

        let _ = std::fs::remove_dir_all(&root);
    }
}
