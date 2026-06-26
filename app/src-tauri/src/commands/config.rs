use std::path::PathBuf;

use tauri::State;

use crate::models::app_state::{AppConfig, AppState, ModelPreset, TuneHistoryEntry};

const EXTERNAL_API_SECRET_SERVICE: &str = "Agent LLM External API";
const EXTERNAL_API_SECRET_ACCOUNT: &str = "openai-compatible";

fn external_api_secret_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(EXTERNAL_API_SECRET_SERVICE, EXTERNAL_API_SECRET_ACCOUNT)
        .map_err(|e| e.to_string())
}

fn save_external_api_secret(api_key: &str) -> Result<(), String> {
    external_api_secret_entry()?
        .set_password(api_key.trim())
        .map_err(|e| e.to_string())
}

fn delete_external_api_secret() -> Result<(), String> {
    let entry = external_api_secret_entry()?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(_) => Ok(()),
    }
}

fn load_external_api_secret() -> Option<String> {
    external_api_secret_entry()
        .and_then(|entry| entry.get_password().map_err(|e| e.to_string()))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn get_app_data_root() -> PathBuf {
    let dir = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("AgentLLM");
    std::fs::create_dir_all(&dir).ok();
    dir
}

fn get_config_path() -> PathBuf {
    get_app_data_root().join("config.json")
}

#[tauri::command]
pub fn get_app_data_dir() -> Result<String, String> {
    Ok(get_app_data_root().to_string_lossy().to_string())
}

fn load_config_from_disk() -> (AppConfig, Option<String>) {
    let path = get_config_path();
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(mut config) = serde_json::from_str::<AppConfig>(&content) {
                // 取出历史明文 api_key：立即从内存配置中移除（避免经 get_config 暴露给前端），
                // 真正的 keyring 写入与磁盘改写延迟到启动后的后台线程执行，不阻塞窗口出现。
                let pending_key = config.api_key.take().and_then(|key| {
                    let trimmed = key.trim().to_string();
                    if trimmed.is_empty() {
                        None
                    } else {
                        Some(trimmed)
                    }
                });
                return (config, pending_key);
            }
        }
    }
    (AppConfig::default(), None)
}

fn persist_config(config: &AppConfig) -> Result<(), String> {
    let path = get_config_path();
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("写入配置失败 ({}): {}", path.display(), e))?;
    Ok(())
}

#[tauri::command]
pub fn get_config(state: State<'_, AppState>) -> Result<AppConfig, String> {
    let start = std::time::Instant::now();
    let config = state.config.lock().map_err(|e| e.to_string())?;
    let result = config.clone();
    eprintln!("[perf] get_config took {:?}", start.elapsed());
    Ok(result)
}

#[tauri::command]
pub fn save_config(state: State<'_, AppState>, config: AppConfig) -> Result<(), String> {
    let mut sanitized_config = config;
    if let Some(api_key) = sanitized_config.api_key.take() {
        let trimmed = api_key.trim();
        if trimmed.is_empty() {
            delete_external_api_secret()?;
        } else {
            save_external_api_secret(trimmed)?;
        }
    }
    let json = serde_json::to_string_pretty(&sanitized_config).map_err(|e| e.to_string())?;
    std::fs::write(get_config_path(), json).map_err(|e| e.to_string())?;
    let mut guard = state.config.lock().map_err(|e| e.to_string())?;
    *guard = sanitized_config;
    Ok(())
}

#[tauri::command]
pub fn get_external_api_key_for_session() -> Result<Option<String>, String> {
    Ok(load_external_api_secret())
}

#[tauri::command]
pub fn get_external_api_key_status() -> Result<bool, String> {
    Ok(load_external_api_secret().is_some())
}

#[tauri::command]
pub fn create_external_api_key(api_key: String) -> Result<(), String> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("API Key 不能为空".into());
    }
    save_external_api_secret(api_key)
}

#[tauri::command]
pub fn delete_external_api_key() -> Result<(), String> {
    delete_external_api_secret()
}

pub fn external_api_key_for_runtime() -> Option<String> {
    load_external_api_secret()
}

#[tauri::command]
pub fn add_model_dir(state: State<'_, AppState>, dir: String) -> Result<Vec<String>, String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    let mut new_config = (*config).clone();
    let path = PathBuf::from(&dir);
    if !new_config.model_dirs.contains(&path) {
        new_config.model_dirs.push(path);
    }
    persist_config(&new_config)?;
    *config = new_config;
    let dirs: Vec<String> = config
        .model_dirs
        .iter()
        .map(|d| d.to_string_lossy().to_string())
        .collect();
    Ok(dirs)
}

#[tauri::command]
pub fn remove_model_dir(state: State<'_, AppState>, dir: String) -> Result<Vec<String>, String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    let mut new_config = (*config).clone();
    new_config.model_dirs.retain(|d| d.to_string_lossy() != dir);
    persist_config(&new_config)?;
    *config = new_config;
    let dirs: Vec<String> = config
        .model_dirs
        .iter()
        .map(|d| d.to_string_lossy().to_string())
        .collect();
    Ok(dirs)
}

#[tauri::command]
pub fn save_model_preset(
    state: State<'_, AppState>,
    model_key: String,
    preset: ModelPreset,
) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    let mut new_config = (*config).clone();
    new_config.model_presets.insert(model_key, preset);
    persist_config(&new_config)?;
    *config = new_config;
    Ok(())
}

#[tauri::command]
pub fn delete_model_preset(state: State<'_, AppState>, model_key: String) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    let mut new_config = (*config).clone();
    new_config.model_presets.remove(&model_key);
    persist_config(&new_config)?;
    *config = new_config;
    Ok(())
}

pub fn init_config() -> (AppState, Option<String>) {
    let t0 = std::time::Instant::now();
    let (config, pending_key) = load_config_from_disk();
    eprintln!("[perf] load_config took {:?}", t0.elapsed());
    (AppState::new(config), pending_key)
}

/// 将历史明文 api_key 迁移到系统 keyring，并改写磁盘配置移除明文。
/// 该操作会访问凭据管理器（Windows 上有可观延迟），因此放到启动后的后台线程执行。
pub fn migrate_plaintext_api_key(state: &AppState, plaintext_key: String) {
    match save_external_api_secret(&plaintext_key) {
        Ok(()) => {
            if let Ok(config) = state.config.lock() {
                // 磁盘上的 api_key 已在内存中清空，这里持久化以移除明文残留。
                persist_config(&config).ok();
            }
        }
        Err(error) => {
            eprintln!("[config] failed to migrate api key to keyring: {}", error);
            // 迁移失败时把明文 key 写回内存配置，保证密钥不丢失，下次启动再尝试迁移。
            if let Ok(mut config) = state.config.lock() {
                config.api_key = Some(plaintext_key);
            }
        }
    }
}

#[tauri::command]
pub fn save_tune_result(state: State<'_, AppState>, entry: TuneHistoryEntry) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    let mut new_config = (*config).clone();
    new_config.tune_history.insert(0, entry);
    if new_config.tune_history.len() > 10 {
        new_config.tune_history.truncate(10);
    }
    persist_config(&new_config)?;
    *config = new_config;
    Ok(())
}

/// 重置应用配置：删除 config.json、清空模型目录扫描缓存、撤销对外 API Key。
/// 不动 llama.cpp 内核可执行文件、模型文件本身、生图供应商 keyring（由 clear_all_image_keys 处理）。
#[tauri::command]
pub fn reset_app_config(state: State<'_, AppState>) -> Result<(), String> {
    // 先撤销对外 API Key 的 keyring 凭据。
    delete_external_api_secret().ok();

    // 删除磁盘 config.json。
    let config_path = get_config_path();
    if config_path.exists() {
        std::fs::remove_file(&config_path)
            .map_err(|e| format!("删除配置文件失败 ({}): {}", config_path.display(), e))?;
    }

    // 内存中的 AppConfig 恢复成默认值。
    let mut guard = state.config.lock().map_err(|e| e.to_string())?;
    *guard = AppConfig::default();

    Ok(())
}
