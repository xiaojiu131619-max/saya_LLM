use tauri::{AppHandle, Emitter};

use crate::services::auto_updater;
use crate::services::process_manager;

#[tauri::command]
pub async fn check_for_update() -> Result<auto_updater::ReleaseInfo, String> {
    tokio::task::spawn_blocking(auto_updater::check_latest_release)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn list_recent_releases(
    count: Option<usize>,
) -> Result<Vec<auto_updater::ReleaseInfo>, String> {
    tokio::task::spawn_blocking(move || auto_updater::list_recent_releases(count.unwrap_or(5)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn download_and_update(
    app: AppHandle,
    url: String,
    version: String,
    use_mirror: Option<bool>,
    mirror_url: Option<String>,
) -> Result<String, String> {
    let app2 = app.clone();
    let url2 = url.clone();
    let version2 = version.clone();
    let mirror = use_mirror.unwrap_or(false);

    tokio::task::spawn_blocking(move || {
        if process_manager::is_server_running() {
            app2.emit(
                "updater:progress",
                serde_json::json!({ "message": "正在停止 llama-server..." }),
            )
            .ok();
            process_manager::stop_server().map_err(|e| e.to_string())?;
        }
        auto_updater::download_and_install(&url2, &version2, mirror, mirror_url.as_deref(), |msg| {
            app2.emit("updater:progress", serde_json::json!({ "message": msg }))
                .ok();
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn list_version_backups() -> Result<Vec<(String, String)>, String> {
    Ok(auto_updater::list_backups())
}

#[tauri::command]
pub fn rollback_to_version(version_dir: String) -> Result<(), String> {
    auto_updater::rollback_to(&version_dir)
}

#[tauri::command]
pub fn get_update_history() -> Vec<auto_updater::UpdateLogEntry> {
    auto_updater::get_update_log()
}
