//! 无限画布相关的 Tauri 命令。
//!
//! 前端只通过这些命令操作画布模块；所有耗时操作（Node 安装、模块下载/解压）
//! 都放到阻塞线程里，并通过 `canvas:install-progress` 事件回报进度。

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::models::app_state::AppState;
use crate::services::canvas_manager::{
    self, CanvasConfig, CanvasPackStatus, CanvasStatus, CanvasSummary,
};

#[derive(Clone, Serialize)]
struct CanvasProgress {
    stage: String,
    message: String,
}

fn emit_progress(app: &AppHandle, stage: &str, message: impl Into<String>) {
    let _ = app.emit(
        "canvas:install-progress",
        CanvasProgress {
            stage: stage.to_string(),
            message: message.into(),
        },
    );
}

fn proxy_url(state: &State<'_, AppState>) -> Option<String> {
    state
        .config
        .lock()
        .ok()
        .and_then(|config| config.proxy_url.clone())
}

#[tauri::command]
pub fn canvas_get_config() -> CanvasConfig {
    canvas_manager::load_config()
}

#[tauri::command]
pub fn canvas_save_config(config: CanvasConfig) -> Result<CanvasConfig, String> {
    canvas_manager::save_config(config)
}

#[tauri::command]
pub async fn canvas_get_status(app: AppHandle) -> Result<CanvasStatus, String> {
    tauri::async_runtime::spawn_blocking(move || canvas_manager::status(Some(&app)))
        .await
        .map_err(|error| format!("读取画布状态失败：{error}"))
}

#[tauri::command]
pub fn canvas_get_summary(app: AppHandle) -> CanvasSummary {
    canvas_manager::summary(Some(&app))
}

/// 网关已安装的工作流列表（只读）：画布标签页「交给 Pi」入口用。
/// 与 Pi 工具桥的 canvas_list_workflows 同一实现，这里是给前端 UI 的通道。
#[tauri::command]
pub async fn canvas_list_workflows() -> Result<Vec<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let value = crate::services::canvas_agent::list_workflows()?;
        let workflows = value
            .get("workflows")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok(workflows)
    })
    .await
    .map_err(|error| format!("读取画布工作流失败：{error}"))?
}

#[tauri::command]
pub async fn canvas_start(app: AppHandle) -> Result<CanvasStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        canvas_manager::start(&app)?;
        Ok(canvas_manager::status(Some(&app)))
    })
    .await
    .map_err(|error| format!("启动画布失败：{error}"))?
}

#[tauri::command]
pub fn canvas_stop(app: AppHandle) -> Result<(), String> {
    canvas_manager::stop()?;
    // 停止后画布窗口只剩报错页，直接关掉；下次启动会重新创建。
    if let Some(window) = app.get_webview_window("canvas") {
        let _ = window.close();
    }
    Ok(())
}

#[tauri::command]
pub async fn canvas_open_window(app: AppHandle) -> Result<(), String> {
    // 窗口创建必须回到主线程；放在阻塞线程里执行，避免同步命令把 Tauri 的命令队列卡住。
    tauri::async_runtime::spawn_blocking(move || canvas_manager::open_window(&app))
        .await
        .map_err(|error| format!("打开画布窗口失败：{error}"))?
}

#[tauri::command]
pub fn canvas_open_browser() -> Result<(), String> {
    canvas_manager::open_browser()
}

#[tauri::command]
pub fn canvas_reveal_data_dir() -> Result<(), String> {
    canvas_manager::reveal_data_dir()
}

#[tauri::command]
pub fn canvas_get_logs(max_lines: Option<usize>) -> Vec<String> {
    canvas_manager::read_logs(max_lines.unwrap_or(200).clamp(1, 2000))
}

#[tauri::command]
pub fn canvas_clear_logs() -> Result<(), String> {
    canvas_manager::clear_logs()
}

#[tauri::command]
pub async fn canvas_install_node(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let proxy = proxy_url(&state);
    tauri::async_runtime::spawn_blocking(move || {
        emit_progress(&app, "node", "开始准备 Node.js 运行时...");
        let on_progress = |message: String| emit_progress(&app, "node", message);
        let result = canvas_manager::install_node(proxy.as_deref(), &on_progress);
        match &result {
            Ok(version) => emit_progress(&app, "node", format!("Node.js v{version} 已就绪。")),
            Err(error) => emit_progress(&app, "node", format!("安装失败：{error}")),
        }
        result
    })
    .await
    .map_err(|error| format!("安装 Node.js 失败：{error}"))?
}

#[tauri::command]
pub async fn canvas_install_pack_from_zip(
    app: AppHandle,
    path: String,
) -> Result<CanvasPackStatus, String> {
    let zip_path = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || {
        emit_progress(&app, "pack", "正在安装本地画布模块...");
        let result = canvas_manager::install_pack_from_zip(&zip_path);
        match &result {
            Ok(status) => emit_progress(
                &app,
                "pack",
                format!(
                    "画布模块已安装{}。",
                    status
                        .version
                        .as_deref()
                        .map(|version| format!("（v{version}）"))
                        .unwrap_or_default()
                ),
            ),
            Err(error) => emit_progress(&app, "pack", format!("安装失败：{error}")),
        }
        result
    })
    .await
    .map_err(|error| format!("安装画布模块失败：{error}"))?
}

#[tauri::command]
pub async fn canvas_install_pack_from_url(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
    sha256: String,
) -> Result<CanvasPackStatus, String> {
    let proxy = proxy_url(&state);
    tauri::async_runtime::spawn_blocking(move || {
        emit_progress(&app, "pack", "开始下载画布模块...");
        let on_progress = |message: String| emit_progress(&app, "pack", message);
        let result =
            canvas_manager::install_pack_from_url(&url, &sha256, proxy.as_deref(), &on_progress);
        match &result {
            Ok(status) => emit_progress(
                &app,
                "pack",
                format!(
                    "画布模块已安装{}。",
                    status
                        .version
                        .as_deref()
                        .map(|version| format!("（v{version}）"))
                        .unwrap_or_default()
                ),
            ),
            Err(error) => emit_progress(&app, "pack", format!("下载失败：{error}")),
        }
        result
    })
    .await
    .map_err(|error| format!("下载画布模块失败：{error}"))?
}
