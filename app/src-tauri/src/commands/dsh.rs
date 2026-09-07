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
use crate::services::dsh_config as dsh_config_service;
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
    let (dsh_port, llama_port) = {
        let config = dsh_config_from_state(&state);
        let llama_port = state.config.lock().map(|c| c.default_port).unwrap_or(8080);
        (config.dsh_port, llama_port)
    };
    let app2 = app.clone();
    tokio::task::spawn_blocking(move || {
        let on_progress = progress_sink!(app2, "check");
        dsh_installer::run_dsh_env_check(dsh_port, llama_port, &on_progress)
    })
    .await
    .map_err(|e| e.to_string())
}

/// dsh 安装 + 运行状态汇总（含 settings.yaml 实读的绑定信息）。
#[tauri::command]
pub fn dsh_get_status(state: State<'_, AppState>) -> DshStatus {
    let mut status = dsh_installer::dsh_status();
    let dsh_config = dsh_config_from_state(&state);
    let dsh_port = dsh_config.dsh_port;
    status.web_url = format!("http://127.0.0.1:{}", dsh_port);
    if !status.runtime.running {
        status.runtime.web_url = None;
    }
    let (bound_model, bound_base_url) = dsh_config_service::read_binding();
    status.bound_model = bound_model.or(dsh_config.bound_model);
    status.bound_base_url = bound_base_url.or(dsh_config.bound_base_url);
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

/// 解析 Node 与启动参数并拉起 dsh 旁路进程（dsh_start 与模型接入共用）。
fn spawn_dsh_with_events(state: &State<'_, AppState>, app: &AppHandle) -> Result<(), String> {
    let dsh_config = dsh_config_from_state(state);
    let proxy = proxy_from_state(state);

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

/// 开启 dsh 旁路进程（spawn 后立即返回；就绪/退出经 dsh:ready / dsh:stopped / dsh:error 事件）。
#[tauri::command]
pub fn dsh_start(state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    spawn_dsh_with_events(&state, &app)
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

/// dsh 数据清理（Phase 4 数据管理）：kind = "sessions"（会话记录）| "store"（pnpm 仓库缓存）。
#[tauri::command]
pub fn dsh_cleanup_data(kind: String) -> Result<String, String> {
    match kind.as_str() {
        "sessions" => {
            if dsh_manager::is_dsh_running() {
                return Err("dsh 正在运行：请先关闭 dsh 再清理会话记录。".to_string());
            }
            let sessions = dsh_installer::dsh_home_dir().join("sessions");
            if !sessions.exists() {
                return Ok("没有可清理的会话记录。".to_string());
            }
            std::fs::remove_dir_all(&sessions)
                .map_err(|e| format!("无法清理会话记录：{}", e))?;
            std::fs::create_dir_all(&sessions).map_err(|e| e.to_string())?;
            Ok("会话记录已清理。".to_string())
        }
        "store" => {
            let store = dsh_installer::pnpm_store_dir();
            if !store.exists() {
                return Ok("没有可清理的安装仓库缓存。".to_string());
            }
            std::fs::remove_dir_all(&store).map_err(|e| format!("无法清理仓库缓存：{}", e))?;
            Ok("安装仓库缓存已清理（约 270 MB）；下次安装/重装 dsh 会重新下载。".to_string())
        }
        other => Err(format!("未知的清理类型：{}", other)),
    }
}

// ---------------------------------------------------------------------------
// Phase 3：本地模型接入（F5）
// ---------------------------------------------------------------------------

/// 绑定结果。
#[derive(Debug, Clone, serde::Serialize)]
pub struct DshBindResult {
    /// 绑定的模型 id（llama-server 的 alias）。
    pub model_id: String,
    /// llama-server 根地址（不含 /v1）。
    pub base_url: String,
    /// dsh 内的提供方 ID。
    pub provider: String,
}

/// 把当前加载的本地模型一键接入 dsh：
/// 校验真实小补全 → （运行中则先停止）→ 备份并写入 settings.yaml → 持久化绑定 →（原在运行则）重启。
#[tauri::command]
pub async fn dsh_bind_model(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<DshBindResult, String> {
    let app_progress = app.clone();

    // 1. 本地模型必须在线：优先用应用内服务状态，外部启动的实例回退直连探测配置端口。
    let (base_url, model_id) = {
        let ping = tokio::task::spawn_blocking(crate::services::process_manager::ping_server)
            .await
            .map_err(|e| e.to_string())?;
        if ping.reachable && !ping.models.is_empty() {
            (
                ping.base_url.clone().unwrap_or_else(|| format!("http://127.0.0.1:{}", state.config.lock().map(|c| c.default_port).unwrap_or(8080))),
                ping.models[0].clone(),
            )
        } else {
            let port = state.config.lock().map(|c| c.default_port).unwrap_or(8080);
            let probe = tokio::task::spawn_blocking(move || dsh_config_service::probe_models_at(port))
                .await
                .map_err(|e| e.to_string())?;
            match probe {
                Ok(models) => (format!("http://127.0.0.1:{}", port), models[0].clone()),
                Err(_) => {
                    return Err(
                        "llama-server 未运行或没有可用模型：请先在「模型」页加载模型，再回到这里接入。"
                            .to_string(),
                    )
                }
            }
        }
    };
    let api_key = crate::services::process_manager::active_server_api_key();

    // 2. 真实小补全校验（推理模型容忍仅 reasoning_content）。
    app_progress
        .emit(
            "dsh:progress",
            serde_json::json!({ "stage": "bind", "message": "正在校验本地模型 API（真实小补全）..." }),
        )
        .ok();
    let verify_base = base_url.clone();
    let verify_model = model_id.clone();
    let verify_key = api_key.clone();
    tokio::task::spawn_blocking(move || {
        dsh_config_service::verify_model_completion(&verify_base, &verify_model, verify_key.as_deref())
    })
    .await
    .map_err(|e| e.to_string())??;

    // 3. 停止 → 写入（备份）→ 持久化绑定。
    let was_running = dsh_manager::is_dsh_running();
    if was_running {
        app_progress
            .emit(
                "dsh:progress",
                serde_json::json!({ "stage": "bind", "message": "正在停止 dsh 以写入配置..." }),
            )
            .ok();
        dsh_manager::stop_dsh()?;
    }
    app_progress
        .emit(
            "dsh:progress",
            serde_json::json!({ "stage": "bind", "message": "正在写入 dsh 配置（已自动备份 settings.yaml.bak）..." }),
        )
        .ok();
    let write_base = base_url.clone();
    let write_model = model_id.clone();
    let write_key = api_key.clone();
    // 从当前生效的 llama-server 配置取真实上下文，避免在 dsh 里写死固定值。
    // 仅当本次加载的模型可查到 n_ctx 时上报，否则省略由 dsh 按协议默认。
    let write_ctx = crate::services::process_manager::current_server_config()
        .map(|config| config.n_ctx)
        .filter(|ctx| *ctx > 0);
    tokio::task::spawn_blocking(move || {
        dsh_config_service::write_provider(&write_base, &write_model, write_key.as_deref(), write_ctx)
    })
    .await
    .map_err(|e| e.to_string())??;

    {
        crate::commands::config::persist_dsh_binding(
            &state,
            Some(model_id.clone()),
            Some(format!("{}/v1", base_url.trim_end_matches('/'))),
        )?;
    }

    // 4. 原本在运行则重启。
    if was_running {
        app_progress
            .emit(
                "dsh:progress",
                serde_json::json!({ "stage": "bind", "message": "正在重新启动 dsh..." }),
            )
            .ok();
        spawn_dsh_with_events(&state, &app)?;
    }

    Ok(DshBindResult {
        model_id,
        base_url,
        provider: dsh_config_service::PROVIDER_ID.to_string(),
    })
}

/// 解除接入：移除本应用的提供方与默认模型设置（其他配置原样保留），原本在运行则重启。
#[tauri::command]
pub async fn dsh_unbind_model(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let was_running = dsh_manager::is_dsh_running();
    if was_running {
        app.emit(
            "dsh:progress",
            serde_json::json!({ "stage": "bind", "message": "正在停止 dsh 以移除配置..." }),
        )
        .ok();
        dsh_manager::stop_dsh()?;
    }
    tokio::task::spawn_blocking(dsh_config_service::remove_provider)
        .await
        .map_err(|e| e.to_string())??;
    crate::commands::config::persist_dsh_binding(&state, None, None)?;
    if was_running {
        app.emit(
            "dsh:progress",
            serde_json::json!({ "stage": "bind", "message": "正在重新启动 dsh..." }),
        )
        .ok();
        spawn_dsh_with_events(&state, &app)?;
    }
    Ok(())
}
