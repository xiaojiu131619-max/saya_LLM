use std::path::Path;
use std::time::Instant;

use tauri::State;

use crate::models::app_state::AppState;
use crate::models::model_info::ModelInfo;
use crate::services::model_scanner::{parse_model_info_from_path, ModelScanner};

#[tauri::command]
pub fn scan_models(state: State<'_, AppState>) -> Result<Vec<ModelInfo>, String> {
    let start = Instant::now();
    let dirs = state
        .config
        .lock()
        .map_err(|e| e.to_string())?
        .model_dirs
        .clone();
    let result = ModelScanner::new(dirs).scan().map_err(|e| e.to_string());
    eprintln!("[scan] scan_models took {:?}", start.elapsed());
    result
}

#[tauri::command]
pub fn scan_fast(state: State<'_, AppState>) -> Result<Vec<ModelInfo>, String> {
    let start = Instant::now();
    let dirs = state
        .config
        .lock()
        .map_err(|e| e.to_string())?
        .model_dirs
        .clone();
    let result = ModelScanner::new(dirs)
        .scan_cache_only()
        .map_err(|e| e.to_string());
    eprintln!("[perf] scan_fast took {:?}", start.elapsed());
    result
}

#[tauri::command]
pub fn clear_model_cache(_state: State<'_, AppState>) -> Result<String, String> {
    let dir = crate::services::model_scanner::get_cache_dir_clone();
    let count = std::fs::read_dir(&dir)
        .map(|entries| entries.count())
        .unwrap_or(0);
    std::fs::remove_dir_all(&dir).ok();
    std::fs::create_dir_all(&dir).ok();
    Ok(format!("已清除 {} 个缓存文件", count))
}

/// Build a full ModelInfo for a single .gguf file path. Used by the "add from a
/// file path" flow, where the file may live outside any configured model
/// directory (so it won't show up in scan_models).
#[tauri::command]
pub fn load_model_from_path(path: String) -> Result<ModelInfo, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err("文件不存在".to_string());
    }
    let is_gguf = p
        .extension()
        .map(|e| e.eq_ignore_ascii_case("gguf"))
        .unwrap_or(false);
    if !is_gguf {
        return Err("不是有效的 .gguf 模型文件".to_string());
    }
    parse_model_info_from_path(p).ok_or_else(|| "无法解析模型文件".to_string())
}
