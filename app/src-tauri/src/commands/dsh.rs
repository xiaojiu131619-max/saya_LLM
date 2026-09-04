//! Agent 页（dsh 智能体）命令面。
//!
//! Phase 1：安装辅助与环境检测
//! - `dsh_env_check`        Agent 页环境检测（Node / dsh 包 / 数据目录 / 端口 / 模型 API / Shell）
//! - `dsh_get_status`       安装 + 运行状态汇总
//! - `dsh_install_node`     托管安装 Node.js 便携版（可取消，进度走 `dsh:progress` 事件）
//! - `dsh_install_package`  托管安装固定版 `@deepseek-ai/dsh`（可取消，进度走 `dsh:progress` 事件）
//! - `dsh_uninstall`        卸载 dsh 包
//! - `dsh_cancel_install`   请求取消正在进行的安装
//!
//! Phase 2：进程管理与日志
//! - `dsh_start`            开启 dsh（spawn 旁路进程，事件：dsh:ready / dsh:stopped / dsh:error / dsh:log）
//! - `dsh_stop`             关闭 dsh（Job Object 整树回收）
//! - `dsh_get_logs`         读取 dsh 日志环形缓冲
//! - `dsh_clear_logs`       清空 dsh 日志
//!
//! 模型接入（dsh_bind_model）在 Phase 3 实现。

use std::path::PathBuf;

use tauri::{AppHandle, Emitter, State};

use crate::models::app_state::AppState;
use crate::models::dsh_types::DshStatus;
use crate::services::{dsh_installer, dsh_manager};

/// 从应用配置读取代理地址（与核心更新一致的取法）。
fn proxy_from_state(state: &State<'_, AppState>) -> Option<String> {
    state
        .config
        .lock()
        .ok()
        .and_then(|config| config.proxy_url.clone())
        .filter(|url| !url.trim().is_empty())
}

/// 从应用配置读取 dsh 配置段。
fn dsh_config_from_state(state: &State<'_, AppState>) -> crate::models::dsh_types::DshConfig {
    state.config.lock().map(|config| config.dsh.clone()).unwrap_or_default()
}

/// 构造一个同时「发 dsh:progress 事件 + 写 dsh 日志环形缓冲」的进度回调，
/// 保证下载/安装/检测动作既推进度条，也能在日志面板回看。
macro_rules! progress_sink {
    ($app:expr, $stage:expr) => {
        |msg: String| {
            $app.emit(
                "dsh:progress",
                serde_json::json!({ "stage": $stage, "message": msg }),
            )
            .ok();
            dsh_manager::add_dsh_log(&format!("[{}] {}", $stage, msg));
        }
    };
}

/// Agent 页环境检测（逐项上报进度）。
#[tauri::command]
pub async fn dsh_env_check(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Vec<crate::commands::env_check::EnvCheckItem>, String> {
    let dsh_port = dsh_config_from_state(&state).dsh_port;
    let app2 = app.clone();
    tokio::task::spawn_blocking(move || {
        let on_progress = progress_sink!(app2, "check");
        dsh_installer::run_dsh_env_check(dsh_port, &on_progress)
    })
    .await
    .map_err(|e| e.to_string())
}

/// dsh 安装 + 运行状态汇总。
#[tauri::command]
pub fn dsh_get_status(state: State<'_, AppState>) -> DshStatus {
    let mut status = dsh_installer::dsh_status();
    let dsh_port = dsh_config_from_state(&state).dsh_port;
    status.web_url = format!("http://127.0.0.1:{}", dsh_port);
    if !status.runtime.running {
        status.runtime.web_url = None;
    }
    status
}

/// 托管安装 Node.js 便携版（锁定的 LTS 版本；后台线程执行，进度走事件 + 日志）。
#[tauri::command]
pub async fn dsh_install_node(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    let dsh_config = dsh_config_from_state(&state);
    let proxy = proxy_from_state(&state);
    let app2 = app.clone();
    tokio::task::spawn_blocking(move || {
        let version = dsh_config.node_pinned_version.clone();
        let on_progress = progress_sink!(app2, "node");
        dsh_installer::install_node_portable(&version, proxy.as_deref(), &on_progress)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 托管安装固定版 `@deepseek-ai/dsh`（后台线程执行，进度走事件）。
#[tauri::command]
pub async fn dsh_install_package(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    let dsh_config = dsh_config_from_state(&state);
    let proxy = proxy_from_state(&state);
    let app2 = app.clone();
    tokio::task::spawn_blocking(move || {
        let node_version = {
            // npm 安装始终使用托管 Node（确定性工具链）；缺失时先自动装。
            let node = dsh_installer::resolve_node();
            if node.source == crate::models::dsh_types::DshNodeSource::Managed
                && node.path.is_some()
            {
                node.version.clone().unwrap_or_default()
            } else {
                let version = dsh_config.node_pinned_version.clone();
                let on_progress = progress_sink!(app2, "node");
                dsh_installer::install_node_portable(&version, proxy.as_deref(), &on_progress)?;
                version
            }
        };
        let package_version = dsh_config.pinned_version.clone();
        let on_progress = progress_sink!(app2, "package");
        dsh_installer::install_dsh_package(&node_version, &package_version, proxy.as_deref(), &on_progress)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 卸载 dsh 包（保留 DSH_HOME 与托管 Node）。
#[tauri::command]
pub fn dsh_uninstall() -> Result<(), String> {
    dsh_installer::uninstall_dsh_package()
}

/// 请求取消正在进行的 dsh 安装（下载/解压检查点处生效）。
#[tauri::command]
pub fn dsh_cancel_install() {
    dsh_installer::request_cancel();
}

/// 在资源管理器中打开 dsh 相关目录（数据管理/排障用；kind: "home" | "packages" | "runtimes"）。
#[tauri::command]
pub fn dsh_reveal_dir(kind: String) -> Result<(), String> {
    let dir = match kind.as_str() {
        "home" => dsh_installer::dsh_home_dir(),
        "packages" => dsh_installer::dsh_packages_dir(),
        "runtimes" => dsh_installer::runtimes_dir(),
        other => return Err(format!("未知的目录类型：{}", other)),
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    crate::commands::system::reveal_path(dir.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------
// Phase 2：进程启停与日志
// ---------------------------------------------------------------------------

/// 开启 dsh 旁路进程（spawn 后立即返回；就绪/退出经 dsh:ready / dsh:stopped / dsh:error 事件）。
#[tauri::command]
pub fn dsh_start(state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    let dsh_config = dsh_config_from_state(&state);
    let proxy = proxy_from_state(&state);

    let node = dsh_installer::resolve_node();
    let (node_path, args) = dsh_installer::compose_dsh_command_parts(&node, dsh_config.dsh_port)?;
    let bin_path = PathBuf::from(&args[0]);

    let options = dsh_manager::DshStartOptions {
        node_path,
        bin_path,
        dsh_port: dsh_config.dsh_port,
        dsh_home: dsh_installer::dsh_home_dir(),
        workspace_dir: dsh_config.workspace_dir.clone(),
        proxy_url: proxy,
    };

    let app_log = app.clone();
    let app_event = app.clone();
    let app_progress = app.clone();
    dsh_manager::start_dsh(
        &options,
        move |line| {
            app_log
                .emit("dsh:log", serde_json::json!({ "line": line }))
                .ok();
        },
        move |message| {
            app_progress
                .emit(
                    "dsh:progress",
                    serde_json::json!({ "stage": "start", "message": message }),
                )
                .ok();
        },
        move |event| match event {
            dsh_manager::DshRuntimeEvent::Ready(url) => {
                app_event.emit("dsh:ready", serde_json::json!({ "url": url })).ok();
            }
            dsh_manager::DshRuntimeEvent::Stopped(message) => {
                app_event.emit("dsh:stopped", serde_json::json!({ "message": message })).ok();
            }
            dsh_manager::DshRuntimeEvent::Error(message) => {
                app_event.emit("dsh:error", serde_json::json!({ "message": message })).ok();
            }
        },
    )
}

/// 关闭 dsh（Job Object 整树回收），并广播 dsh:stopped。
#[tauri::command]
pub fn dsh_stop(app: AppHandle) -> Result<(), String> {
    let result = dsh_manager::stop_dsh();
    app.emit(
        "dsh:stopped",
        serde_json::json!({ "message": "dsh 已停止。" }),
    )
    .ok();
    result
}

/// 读取 dsh 日志（环形缓冲全量）。
#[tauri::command]
pub fn dsh_get_logs() -> Vec<String> {
    dsh_manager::get_dsh_logs()
}

/// 清空 dsh 日志。
#[tauri::command]
pub fn dsh_clear_logs() {
    dsh_manager::clear_dsh_logs();
}
