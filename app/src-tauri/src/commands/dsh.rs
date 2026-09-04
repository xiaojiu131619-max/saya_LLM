//! Agent 页（dsh 智能体）命令面 —— Phase 1：安装辅助与环境检测。
//!
//! 命令清单（计划书第 6 章）：
//! - `dsh_env_check`        Agent 页环境检测（Node / dsh 包 / 数据目录 / 端口 / 模型 API / Shell）
//! - `dsh_get_status`       安装状态汇总（Node 来源与版本、dsh 包版本、目录）
//! - `dsh_install_node`     托管安装 Node.js 便携版（可取消，进度走 `dsh:progress` 事件）
//! - `dsh_install_package`  托管安装固定版 `@deepseek-ai/dsh`（可取消，进度走 `dsh:progress` 事件）
//! - `dsh_uninstall`        卸载 dsh 包
//! - `dsh_cancel_install`   请求取消正在进行的安装
//!
//! 进程启停（dsh_start / dsh_stop / 日志）与模型接入（dsh_bind_model）在
//! Phase 2 / Phase 3 实现。

use tauri::{AppHandle, Emitter, State};

use crate::models::app_state::AppState;
use crate::models::dsh_types::DshStatus;
use crate::services::dsh_installer;

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

/// Agent 页环境检测。
#[tauri::command]
pub fn dsh_env_check(state: State<'_, AppState>) -> Vec<crate::commands::env_check::EnvCheckItem> {
    let dsh_port = dsh_config_from_state(&state).dsh_port;
    dsh_installer::run_dsh_env_check(dsh_port)
}

/// dsh 安装状态汇总。
#[tauri::command]
pub fn dsh_get_status(_state: State<'_, AppState>) -> DshStatus {
    dsh_installer::dsh_status()
}

/// 托管安装 Node.js 便携版（锁定的 LTS 版本；后台线程执行，进度走事件）。
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
        dsh_installer::install_node_portable(&version, proxy.as_deref(), &|msg| {
            app2.emit("dsh:progress", serde_json::json!({ "stage": "node", "message": msg })).ok();
        })
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
                dsh_installer::install_node_portable(&version, proxy.as_deref(), &|msg| {
                    app2
                        .emit("dsh:progress", serde_json::json!({ "stage": "node", "message": msg }))
                        .ok();
                })?;
                version
            }
        };
        let package_version = dsh_config.pinned_version.clone();
        dsh_installer::install_dsh_package(&node_version, &package_version, proxy.as_deref(), &|msg| {
            app2
                .emit("dsh:progress", serde_json::json!({ "stage": "package", "message": msg }))
                .ok();
        })
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
