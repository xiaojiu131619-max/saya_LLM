//! 可配置的存储目录（引擎 / 日志 / 归档）。
//!
//! 这三类目录都可能在界面「数据管理」里被用户改到别的盘，而读取方
//! （内核解析、引擎日志落盘、会话归档）分布在拿不到 `AppState` 的模块里，
//! 因此沿用自编译内核路径那套做法：内存里放一份全局镜像，启动时从
//! config.json 读入，保存配置时同步更新。
//!
//! 未配置时一律回落到默认位置（resources/kernels、AgentLLM 数据目录），
//! 因此旧配置文件不需要迁移。

use once_cell::sync::Lazy;
use std::path::PathBuf;
use std::sync::Mutex;

static ENGINE_DIR: Lazy<Mutex<Option<PathBuf>>> = Lazy::new(|| Mutex::new(None));
static LOG_DIR: Lazy<Mutex<Option<PathBuf>>> = Lazy::new(|| Mutex::new(None));
static ARCHIVE_DIR: Lazy<Mutex<Option<PathBuf>>> = Lazy::new(|| Mutex::new(None));

fn normalize(path: Option<String>) -> Option<PathBuf> {
    path.as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn set(slot: &Mutex<Option<PathBuf>>, path: Option<String>) {
    if let Ok(mut guard) = slot.lock() {
        *guard = normalize(path);
    }
}

fn get(slot: &Mutex<Option<PathBuf>>) -> Option<PathBuf> {
    slot.lock().ok().and_then(|guard| guard.clone())
}

/// 应用数据根目录（`%APPDATA%\AgentLLM`），与 config.json 同处。
pub fn app_data_root() -> PathBuf {
    let dir = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("AgentLLM");
    std::fs::create_dir_all(&dir).ok();
    dir
}

/// 默认引擎（llama.cpp 版本化内核）目录：应用资源目录下的 kernels。
pub fn default_engine_dir() -> PathBuf {
    crate::services::auto_updater::resource_dir().join("kernels")
}

/// 默认日志目录：应用数据目录（引擎日志再各占一个子目录）。
pub fn default_log_dir() -> PathBuf {
    app_data_root()
}

/// 默认归档目录：应用数据目录下的 archives。
pub fn default_archive_dir() -> PathBuf {
    app_data_root().join("archives")
}

/// 引擎（内核）目录：用户配置优先，否则用默认位置。
pub fn engine_dir() -> PathBuf {
    let dir = get(&ENGINE_DIR).unwrap_or_else(default_engine_dir);
    std::fs::create_dir_all(&dir).ok();
    dir
}

/// 日志目录：用户配置优先，否则用应用数据目录。
pub fn log_dir() -> PathBuf {
    let dir = get(&LOG_DIR).unwrap_or_else(default_log_dir);
    std::fs::create_dir_all(&dir).ok();
    dir
}

/// 归档目录：用户配置优先，否则用 `AgentLLM/archives`。
pub fn archive_dir() -> PathBuf {
    let dir = get(&ARCHIVE_DIR).unwrap_or_else(default_archive_dir);
    std::fs::create_dir_all(&dir).ok();
    dir
}

pub fn set_engine_dir(path: Option<String>) {
    set(&ENGINE_DIR, path);
}

pub fn set_log_dir(path: Option<String>) {
    set(&LOG_DIR, path);
}

pub fn set_archive_dir(path: Option<String>) {
    set(&ARCHIVE_DIR, path);
}

/// 启动时把 config.json 里的三个目录同步进全局镜像（统一入口）。
pub fn apply_config(
    engine: Option<String>,
    log: Option<String>,
    archive: Option<String>,
) {
    set_engine_dir(engine);
    set_log_dir(log);
    set_archive_dir(archive);
}
