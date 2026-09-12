use tauri::{AppHandle, Emitter, State};

use crate::models::app_state::AppState;
use crate::services::auto_updater;
use crate::services::ffmpeg_installer;
use crate::services::process_manager;

/// 从应用配置中读取代理地址（核心更新相关的所有 HTTP 请求共用）。
fn proxy_from_state(state: &State<'_, AppState>) -> Option<String> {
    state
        .config
        .lock()
        .ok()
        .and_then(|config| config.proxy_url.clone())
        .filter(|url| !url.trim().is_empty())
}

#[tauri::command]
pub async fn check_for_update(
    state: State<'_, AppState>,
) -> Result<auto_updater::ReleaseInfo, String> {
    let proxy = proxy_from_state(&state);
    tokio::task::spawn_blocking(move || auto_updater::check_latest_release(proxy.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn list_recent_releases(
    state: State<'_, AppState>,
    count: Option<usize>,
) -> Result<Vec<auto_updater::ReleaseInfo>, String> {
    let proxy = proxy_from_state(&state);
    tokio::task::spawn_blocking(move || {
        auto_updater::list_recent_releases(count.unwrap_or(5), proxy.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn download_and_update(
    state: State<'_, AppState>,
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
    let proxy = proxy_from_state(&state);

    tokio::task::spawn_blocking(move || {
        if process_manager::is_server_running() {
            app2.emit(
                "updater:progress",
                serde_json::json!({ "message": "正在停止 llama-server..." }),
            )
            .ok();
            process_manager::stop_server().map_err(|e| e.to_string())?;
        }
        auto_updater::download_and_install(
            &url2,
            &version2,
            mirror,
            mirror_url.as_deref(),
            proxy.as_deref(),
            |msg| {
                app2.emit("updater:progress", serde_json::json!({ "message": msg }))
                    .ok();
            },
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 请求取消正在进行的下载/安装；更新流程会在最近的检查点中止。
#[tauri::command]
pub fn cancel_kernel_update() {
    auto_updater::request_cancel();
}

/// 列出本机版本化核心目录（kernels/<版本>_<安装时间>/），按安装时间从新到旧。
#[tauri::command]
pub fn list_installed_kernels() -> Vec<auto_updater::InstalledKernel> {
    auto_updater::list_installed_kernels()
}

#[tauri::command]
pub fn get_update_history() -> Vec<auto_updater::UpdateLogEntry> {
    auto_updater::get_update_log()
}

/// 下载并安装 ffmpeg / ffprobe 到应用 resources 目录（视频与部分音频格式的可选运行时）。
/// 与内核更新共用代理设置、镜像加速偏好与取消标志。
#[tauri::command]
pub async fn install_ffmpeg(
    state: State<'_, AppState>,
    app: AppHandle,
    use_mirror: Option<bool>,
) -> Result<String, String> {
    let proxy = proxy_from_state(&state);
    let mirror = use_mirror.unwrap_or(true);
    tokio::task::spawn_blocking(move || {
        ffmpeg_installer::install(proxy.as_deref(), mirror, |message| {
            app.emit(
                "ffmpeg:progress",
                serde_json::json!({ "message": message }),
            )
            .ok();
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 取消正在进行的 ffmpeg 安装（与内核更新共用取消标志）。
#[tauri::command]
pub fn cancel_ffmpeg_install() {
    auto_updater::request_cancel();
}
