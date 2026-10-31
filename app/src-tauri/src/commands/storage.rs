//! 「数据管理」里的目录配置命令：模型目录、引擎目录、日志目录、归档目录。
//!
//! 模型目录已有增删两个命令（config.rs），这里补齐另外三个可编辑目录，
//! 并提供一份「当前生效路径」快照供界面展示（未配置时展示默认位置）。
//!
//! 目录本身不做创建校验以外的限制：用户可能指向还不存在的盘符，
//! 此时保存成功、但写入方会在自己的 `create_dir_all` 里报错——这比在设置页
//! 直接拒绝保存更难懂，所以在保存时就创建目录并把失败原因回给界面。

use serde::Serialize;
use tauri::State;

use crate::models::app_state::AppState;
use crate::services::storage_paths;

/// 三个可配置目录的生效路径快照。
#[derive(Debug, Clone, Serialize)]
pub struct StoragePaths {
    /// 应用数据目录（config.json 所在处）。
    pub app_data_dir: String,
    /// 模型目录列表。
    pub model_dirs: Vec<String>,
    /// 引擎（llama.cpp 版本化内核）目录。
    pub engine_dir: String,
    /// 引擎目录是否为用户配置值（false = 默认位置）。
    pub engine_dir_custom: bool,
    /// 日志目录。
    pub log_dir: String,
    pub log_dir_custom: bool,
    /// 归档聊天记录目录。
    pub archive_dir: String,
    pub archive_dir_custom: bool,
    /// 默认位置（界面「恢复默认」用）。
    pub engine_dir_default: String,
    pub log_dir_default: String,
    pub archive_dir_default: String,
}

/// 把用户选择的目录规范化：绝对路径、去掉首尾空白、空值当未配置。
fn normalize_dir(path: Option<String>) -> Result<Option<String>, String> {
    let Some(raw) = path else { return Ok(None) };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let candidate = std::path::PathBuf::from(trimmed);
    if !candidate.is_absolute() {
        return Err(format!("请填写完整的绝对路径（当前：{trimmed}）。"));
    }
    std::fs::create_dir_all(&candidate)
        .map_err(|error| format!("无法创建目录 {}：{}", candidate.display(), error))?;
    Ok(Some(trimmed.to_string()))
}

/// 读取当前生效的目录配置。
#[tauri::command]
pub fn get_storage_paths(state: State<'_, AppState>) -> Result<StoragePaths, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?.clone();
    let model_dirs = config
        .model_dirs
        .iter()
        .map(|dir| dir.to_string_lossy().to_string())
        .collect();
    Ok(StoragePaths {
        app_data_dir: storage_paths::app_data_root().to_string_lossy().to_string(),
        model_dirs,
        engine_dir: storage_paths::engine_dir().to_string_lossy().to_string(),
        engine_dir_custom: config.engine_dir.is_some(),
        log_dir: storage_paths::log_dir().to_string_lossy().to_string(),
        log_dir_custom: config.log_dir.is_some(),
        archive_dir: storage_paths::archive_dir().to_string_lossy().to_string(),
        archive_dir_custom: config.archive_dir.is_some(),
        engine_dir_default: storage_paths::default_engine_dir()
            .to_string_lossy()
            .to_string(),
        log_dir_default: storage_paths::default_log_dir()
            .to_string_lossy()
            .to_string(),
        archive_dir_default: storage_paths::default_archive_dir()
            .to_string_lossy()
            .to_string(),
    })
}

/// `kind` 取值：engine / log / archive。
fn apply_dir_change(
    state: &State<'_, AppState>,
    kind: &str,
    value: Option<String>,
) -> Result<(), String> {
    let normalized = normalize_dir(value)?;
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    let mut next = (*config).clone();
    match kind {
        "engine" => next.engine_dir = normalized.clone(),
        "log" => next.log_dir = normalized.clone(),
        "archive" => next.archive_dir = normalized.clone(),
        other => return Err(format!("未知的目录类型：{other}")),
    }
    crate::commands::config::persist_config_public(&next)?;
    *config = next;
    drop(config);
    // 全局镜像同步：内核解析与各引擎日志落盘都直接读这里。
    match kind {
        "engine" => storage_paths::set_engine_dir(normalized),
        "log" => storage_paths::set_log_dir(normalized),
        "archive" => storage_paths::set_archive_dir(normalized),
        _ => {}
    }
    Ok(())
}

/// 保存某个目录（path 传 null / 空串表示恢复默认位置）。
#[tauri::command]
pub fn set_storage_dir(
    state: State<'_, AppState>,
    kind: String,
    path: Option<String>,
) -> Result<(), String> {
    apply_dir_change(&state, &kind, path)
}

/// 把一份会话归档写进归档目录，返回落盘的完整路径。
///
/// 文件名由前端给出（已做非法字符过滤），这里再校验一次：只允许单层文件名，
/// 不允许路径分隔符。`..` 只在**整名恰好是** `.` / `..` 时拒绝——
/// 会话标题里的省略号（「帮我看看...」）是正常字符，按子串拒绝会让归档中断。
#[tauri::command]
pub fn write_archive_file(file_name: String, content: String) -> Result<String, String> {
    let name = file_name.trim();
    if name.is_empty() {
        return Err("归档文件名不能为空。".to_string());
    }
    if name == "." || name == ".." {
        return Err("归档文件名不能是 . 或 ..。".to_string());
    }
    if name
        .chars()
        .any(|character| matches!(character, '/' | '\\' | ':') || character.is_control())
    {
        return Err("归档文件名不能包含路径分隔符或控制字符。".to_string());
    }
    let dir = storage_paths::archive_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("无法创建归档目录 {}：{}", dir.display(), error))?;
    let target = dir.join(name);
    // 兜底确认落点仍在归档目录内（不依赖上面字符检查的完整性）。
    if target.parent() != Some(dir.as_path()) {
        return Err("归档文件名不能指向归档目录之外。".to_string());
    }
    std::fs::write(&target, content)
        .map_err(|error| format!("写入归档文件失败（{}）：{}", target.display(), error))?;
    Ok(target.to_string_lossy().to_string())
}
