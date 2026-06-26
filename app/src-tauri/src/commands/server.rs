use tauri::{AppHandle, Emitter};

use crate::commands::config;
use crate::models::server_config::ServerConfig;
use crate::services::process_manager;

#[tauri::command]
pub fn start_server(app: AppHandle, mut config: ServerConfig) -> Result<(), String> {
    let app2 = app.clone();
    let app3 = app.clone();
    if config.api_key.is_none() {
        config.api_key = config::external_api_key_for_runtime();
    }

    process_manager::start_server(
        &config,
        move |progress| {
            app2.emit("server:progress", progress).ok();
        },
        move || {
            app3.emit("server:ready", serde_json::json!({"message": "服务就绪"}))
                .ok();
        },
        move |error| {
            app.emit("server:error", error).ok();
        },
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn stop_server(app: AppHandle) -> Result<(), String> {
    process_manager::stop_server().map_err(|e| e.to_string())?;
    app.emit("server:stopped", serde_json::json!({})).ok();
    Ok(())
}

#[tauri::command]
pub fn get_server_status() -> Result<bool, String> {
    Ok(process_manager::is_server_running())
}

#[tauri::command]
pub fn get_server_logs() -> Result<Vec<String>, String> {
    Ok(process_manager::get_logs())
}

#[tauri::command]
pub fn clear_server_logs() -> Result<(), String> {
    process_manager::clear_logs();
    Ok(())
}
