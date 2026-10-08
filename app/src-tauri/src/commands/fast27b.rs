//! fast27b 引擎（三元量化 Bonsai-2-27B 离线包）启动通道命令面。
//!
//! - `fast27b_start`        启动引擎（spawn 旁路进程，事件：fast27b:ready / fast27b:stopped / fast27b:error / fast27b:log）
//! - `fast27b_stop`         停止引擎（Job Object 整树回收）
//! - `fast27b_get_status`   运行状态汇总（含 /v1/models 探活结果）
//! - `fast27b_get_logs`     读取 fast27b 日志环形缓冲
//! - `fast27b_clear_logs`   清空 fast27b 日志
//! - `fast27b_get_config` / `fast27b_save_config`  读取/保存 fast27b 配置段
//! - `fast27b_bind_dsh`     把 fast27b 写为 dsh 默认提供方（与 llama 绑定共用 agent-llm-local 槽位）
//! - `fast27b_unbind_dsh`   解除 dsh 绑定
//! - `fast27b_bridge_ensure` / `fast27b_bridge_status` / `fast27b_bridge_stop`
//!                         官方 llama.cpp webui 同源桥（fast27b 没有网页界面，靠桥提供页面）

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::models::app_state::{AppState, Fast27bConfig, Fast27bModel};
use crate::services::dsh_config as dsh_config_service;
use crate::services::{dsh_manager, fast27b_manager, webui_bridge};

/// 从应用配置读取 fast27b 配置段。
fn fast27b_config_from_state(state: &State<'_, AppState>) -> Fast27bConfig {
    state
        .config
        .lock()
        .map(|config| config.fast27b.clone())
        .unwrap_or_default()
}

fn options_from_config(config: &Fast27bConfig) -> fast27b_manager::Fast27bStartOptions {
    fast27b_manager::Fast27bStartOptions {
        engine_path: PathBuf::from(&config.engine_path),
        model_path: PathBuf::from(&config.model_path),
        model_variant: config.selected_model(),
        port: config.port,
        lan: config.lan,
        api_key: config.api_key.clone(),
        context_window: config.context_window,
        draft_tokens: config.draft_tokens,
        default_max_tokens: config.default_max_tokens,
    }
}

/// 启动 fast27b 引擎（spawn 后立即返回；就绪/退出经 fast27b:ready / fast27b:stopped / fast27b:error 事件）。
#[tauri::command]
pub fn fast27b_start(state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    let config = fast27b_config_from_state(&state);
    let options = options_from_config(&config);
    // 引擎一起来就把官方 webui 的同源桥拉起来：用户随后点「打开 WebUI」直接可用。
    if let Err(err) = webui_bridge::ensure(
        config.bridge_port,
        config.port,
        &config.api_key,
        config.default_max_tokens,
    ) {
        log::warn!("[webui-bridge] 启动引擎时未能起桥：{err}");
    }

    let app_log = app.clone();
    let app_event = app.clone();
    let app_progress = app.clone();
    fast27b_manager::start_fast27b(
        &options,
        move |line| {
            app_log
                .emit("fast27b:log", serde_json::json!({ "line": line }))
                .ok();
        },
        move |message| {
            app_progress
                .emit(
                    "fast27b:progress",
                    serde_json::json!({ "stage": "start", "message": message }),
                )
                .ok();
        },
        move |event| match event {
            fast27b_manager::Fast27bRuntimeEvent::Ready(url) => {
                app_event
                    .emit("fast27b:ready", serde_json::json!({ "url": url }))
                    .ok();
            }
            fast27b_manager::Fast27bRuntimeEvent::Stopped(message) => {
                app_event
                    .emit("fast27b:stopped", serde_json::json!({ "message": message }))
                    .ok();
            }
            fast27b_manager::Fast27bRuntimeEvent::Error(message) => {
                app_event
                    .emit("fast27b:error", serde_json::json!({ "message": message }))
                    .ok();
            }
        },
    )
}

/// 重启 fast27b 引擎：引擎**已失效**（worker 崩溃 / 连续 503）时的唯一恢复手段。
///
/// 「引擎没退出」不等于「可用」：worker 崩溃后进程还在监听，`/v1/models` 照样返回 200，
/// 但每条对话都是 HTTP 503。这时必须整进程重启（同一套 argv），并把遗留实例一并回收，
/// 否则端口仍被占住、新实例起不来。
///
/// 重启要等权重加载（约 7 秒）+ 就绪探测，不能阻塞主线程：日志/进度/就绪事件照常经
/// `fast27b:log` / `fast27b:progress` / `fast27b:ready` / `fast27b:stopped` 上报。
#[tauri::command]
pub async fn fast27b_restart(state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    let config = fast27b_config_from_state(&state);
    let options = options_from_config(&config);
    // 引擎重启后桥的上游端口不变，但桥进程可能已随旧引擎退出：先确保桥在。
    if let Err(err) = webui_bridge::ensure(
        config.bridge_port,
        config.port,
        &config.api_key,
        config.default_max_tokens,
    ) {
        log::warn!("[webui-bridge] 重启引擎时未能起桥：{err}");
    }

    let app_log = app.clone();
    let app_event = app.clone();
    let app_progress = app.clone();
    tokio::task::spawn_blocking(move || {
        fast27b_manager::restart_fast27b(
            &options,
            move |line| {
                app_log
                    .emit("fast27b:log", serde_json::json!({ "line": line }))
                    .ok();
            },
            move |message| {
                app_progress
                    .emit(
                        "fast27b:progress",
                        serde_json::json!({ "stage": "restart", "message": message }),
                    )
                    .ok();
            },
            move |event| match event {
                fast27b_manager::Fast27bRuntimeEvent::Ready(url) => {
                    app_event
                        .emit("fast27b:ready", serde_json::json!({ "url": url }))
                        .ok();
                }
                fast27b_manager::Fast27bRuntimeEvent::Stopped(message) => {
                    app_event
                        .emit("fast27b:stopped", serde_json::json!({ "message": message }))
                        .ok();
                }
                fast27b_manager::Fast27bRuntimeEvent::Error(message) => {
                    app_event
                        .emit("fast27b:error", serde_json::json!({ "message": message }))
                        .ok();
                }
            },
        )
    })
    .await
    .map_err(|e| format!("fast27b 重启任务异常：{e}"))?
}

/// 停止 fast27b 引擎（Job Object 整树回收），并广播 fast27b:stopped。
#[tauri::command]
pub fn fast27b_stop(app: AppHandle) -> Result<(), String> {
    let result = fast27b_manager::stop_fast27b();
    // 引擎停了，网页桥也没有上游了，一并回收（下次启动引擎会重新拉起）。
    webui_bridge::stop();
    app.emit(
        "fast27b:stopped",
        serde_json::json!({ "message": "fast27b 已停止。" }),
    )
    .ok();
    result
}

/// 可选模型及其本地资源状态。
#[derive(Debug, Clone, Serialize)]
pub struct Fast27bModelPreset {
    pub id: Fast27bModel,
    pub label: String,
    pub model_path: String,
    pub exists: bool,
    pub spec: String,
}

/// fast27b 运行状态（runtime_status + 配置快照 + DLC 资源检测）。
#[derive(Debug, Clone, Serialize)]
pub struct Fast27bStatus {
    #[serde(flatten)]
    pub runtime: fast27b_manager::Fast27bRuntimeStatus,
    /// 是否启用该 DLC。
    pub enabled: bool,
    /// 引擎路径（配置）。
    pub engine_path: String,
    /// 模型路径（配置）。
    pub model_path: String,
    pub selected_model: Fast27bModel,
    pub model_presets: Vec<Fast27bModelPreset>,
    /// 引擎文件是否存在（DLC 就绪检测）。
    pub engine_exists: bool,
    /// 模型文件是否存在（DLC 就绪检测）。
    pub model_exists: bool,
    /// 配置的 API Key（明文；本地工具，用户明确要求可见）。
    pub api_key: String,
    /// 配置的上下文窗口。
    pub context_window: u32,
    /// 配置的 MTP 草稿长度。
    pub draft_tokens: u32,
    /// 配置的引擎默认输出上限（`--default-max-tokens`）；0 = 未设，由引擎自身默认决定。
    pub default_max_tokens: u32,
    /// 官方 webui 同源桥端口（配置）。
    pub bridge_port: u16,
    /// 就绪后自动打开 dsh Web。
    pub auto_open_dsh_web: bool,
    /// 当前 dsh 绑定（settings.yaml 实读；仅当指向 fast27b 端口时才算 fast27b 的绑定）。
    pub dsh_bound_model: Option<String>,
    /// dsh Web 地址（按 dsh 配置端口构造）。
    pub dsh_web_url: String,
}

/// 读取 fast27b 运行状态 + 配置 + dsh 绑定信息。
#[tauri::command]
pub fn fast27b_get_status(state: State<'_, AppState>) -> Fast27bStatus {
    let config = fast27b_config_from_state(&state);
    let mut runtime = fast27b_manager::runtime_status();
    // 未启动时也返回已保存的端口和局域网选项，不能把空运行态当成配置默认值。
    if !runtime.running {
        runtime.port = Some(config.port);
        runtime.lan = Some(config.lan);
    }
    let (bound_model, bound_base_url) = dsh_config_service::read_binding();
    // 绑定信息与 llama 共用 agent-llm-local 槽位：仅当 baseURL 指向 fast27b 端口时才算 fast27b 的绑定。
    let bound_is_fast27b = bound_base_url
        .as_ref()
        .map(|url| url.contains(&format!(":{}", config.port)))
        .unwrap_or(false);
    let dsh_port = state
        .config
        .lock()
        .map(|c| c.dsh.dsh_port)
        .unwrap_or(crate::models::dsh_types::DSH_DEFAULT_PORT);
    Fast27bStatus {
        runtime,
        enabled: config.enabled,
        engine_path: config.engine_path.clone(),
        model_path: config.model_path.clone(),
        selected_model: config.selected_model(),
        model_presets: [Fast27bModel::Heretic, Fast27bModel::Swift]
            .into_iter()
            .map(|id| {
                let model_path = config.model_path_for(id);
                Fast27bModelPreset {
                    id,
                    label: id.label().to_string(),
                    exists: std::path::Path::new(&model_path).is_file(),
                    model_path,
                    spec: id.spec().to_string(),
                }
            })
            .collect(),
        engine_exists: !config.engine_path.trim().is_empty()
            && std::path::Path::new(&config.engine_path).exists(),
        model_exists: !config.model_path.trim().is_empty()
            && std::path::Path::new(&config.model_path).exists(),
        api_key: config.api_key.clone(),
        context_window: config.context_window,
        draft_tokens: config.draft_tokens,
        default_max_tokens: config.default_max_tokens,
        bridge_port: config.bridge_port,
        auto_open_dsh_web: config.auto_open_dsh_web,
        dsh_bound_model: if bound_is_fast27b { bound_model } else { None },
        dsh_web_url: format!("http://127.0.0.1:{}", dsh_port),
    }
}

/// 读取 fast27b 日志（环形缓冲全量）。
#[tauri::command]
pub fn fast27b_get_logs() -> Vec<String> {
    fast27b_manager::get_fast27b_logs()
}

/// 清空 fast27b 日志。
#[tauri::command]
pub fn fast27b_clear_logs() {
    fast27b_manager::clear_fast27b_logs();
}

/// 保存 fast27b 配置段（路径/端口/局域网/Key/参数/自动打开开关）。
#[tauri::command]
pub fn fast27b_save_config(
    state: State<'_, AppState>,
    config: Fast27bConfig,
) -> Result<(), String> {
    let mut guard = state.config.lock().map_err(|e| e.to_string())?;
    let mut new_config = (*guard).clone();
    if fast27b_manager::is_fast27b_running()
        && (guard.fast27b.model_path != config.model_path
            || guard.fast27b.selected_model() != config.selected_model())
    {
        return Err("请先停止引擎，再切换模型或修改模型路径。".to_string());
    }
    new_config.fast27b = config;
    crate::commands::config::persist_config_public(&new_config)?;
    *guard = new_config;
    Ok(())
}

/// 只切换 fast27b DLC 的启用开关（不触碰引擎路径/端口等其他配置项）。
#[tauri::command]
pub fn fast27b_set_enabled(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    let mut guard = state.config.lock().map_err(|e| e.to_string())?;
    let mut new_config = (*guard).clone();
    new_config.fast27b.enabled = enabled;
    crate::commands::config::persist_config_public(&new_config)?;
    *guard = new_config;
    Ok(())
}

/// 起（或复用）fast27b 的官方 webui 同源桥，返回浏览器可打开的地址。
///
/// fast27b 引擎自身没有任何 HTML 页面，官方 llama.cpp webui 又只认同源相对路径，
/// 因此由应用在回环上提供一层薄转发（内嵌官方页面 + 抹平协议差异 + 流回放）。
#[tauri::command]
pub fn fast27b_bridge_ensure(
    state: State<'_, AppState>,
) -> Result<webui_bridge::BridgeInfo, String> {
    let config = fast27b_config_from_state(&state);
    if config.port == 0 {
        return Err("fast27b 端口未配置，无法确定桥的上游。".to_string());
    }
    webui_bridge::ensure(
        config.bridge_port,
        config.port,
        &config.api_key,
        config.default_max_tokens,
    )
}

/// 桥的运行状态（未起返回 null）。
#[tauri::command]
pub fn fast27b_bridge_status() -> Option<webui_bridge::BridgeInfo> {
    webui_bridge::info()
}

/// 停掉桥（引擎停止 / 应用退出时调用）。
#[tauri::command]
pub fn fast27b_bridge_stop() -> Result<(), String> {
    webui_bridge::stop();
    Ok(())
}

/// 把 fast27b 引擎一键接入 dsh：
/// 探活 → 真实小补全校验 →（运行中则先停止）→ 备份并写入 settings.yaml →（原在运行则）重启。
/// 与 llama 的 dsh_bind_model 共用 agent-llm-local 提供方槽位：绑定即替换 dsh 默认模型。
#[tauri::command]
pub async fn fast27b_bind_dsh(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<serde_json::Value, String> {
    let config = fast27b_config_from_state(&state);
    let base_url = format!("http://127.0.0.1:{}", config.port);
    let model_id = String::from("qwen3.8-27b");

    // 1. fast27b 必须在线（带鉴权探活），避免把一个死端点写进 dsh 默认模型。
    app.emit(
        "dsh:progress",
        serde_json::json!({ "stage": "bind", "message": "正在校验 fast27b 引擎 API..." }),
    )
    .ok();
    let probe_port = config.port;
    let probe_key = config.api_key.clone();
    let reachable = tokio::task::spawn_blocking(move || {
        fast27b_manager::probe_models_available(probe_port, &probe_key)
    })
    .await
    .map_err(|e| e.to_string())?;
    if !reachable {
        return Err("fast27b 引擎未运行或不可达：请先在本页启动引擎，再接入 dsh。".to_string());
    }

    // 2. 真实小补全校验（推理模型容忍仅 reasoning_content）。
    app.emit(
        "dsh:progress",
        serde_json::json!({ "stage": "bind", "message": "正在校验本地模型 API（真实小补全）..." }),
    )
    .ok();
    let verify_base = base_url.clone();
    let verify_model = model_id.clone();
    let verify_key = config.api_key.clone();
    tokio::task::spawn_blocking(move || {
        dsh_config_service::verify_model_completion(&verify_base, &verify_model, Some(&verify_key))
    })
    .await
    .map_err(|e| e.to_string())??;

    // 3. 停止 → 写入（备份）。
    let was_running = dsh_manager::is_dsh_running();
    if was_running {
        app.emit(
            "dsh:progress",
            serde_json::json!({ "stage": "bind", "message": "正在停止 dsh 以写入配置..." }),
        )
        .ok();
        dsh_manager::stop_dsh()?;
    }
    app
        .emit(
            "dsh:progress",
            serde_json::json!({ "stage": "bind", "message": "正在写入 dsh 配置（已自动备份 settings.yaml.bak）..." }),
        )
        .ok();
    let write_base = base_url.clone();
    let write_model = model_id.clone();
    let write_key = config.api_key.clone();
    let write_ctx = config.context_window;
    tokio::task::spawn_blocking(move || {
        dsh_config_service::write_provider(
            &write_base,
            &write_model,
            Some(&write_key),
            Some(write_ctx),
        )
    })
    .await
    .map_err(|e| e.to_string())??;

    // 4. 原本在运行则重启。
    if was_running {
        app.emit(
            "dsh:progress",
            serde_json::json!({ "stage": "bind", "message": "正在重新启动 dsh..." }),
        )
        .ok();
        crate::commands::dsh::spawn_dsh_with_events(&state, &app)?;
    }

    Ok(serde_json::json!({
        "model_id": model_id,
        "base_url": base_url,
        "provider": dsh_config_service::PROVIDER_ID,
    }))
}

/// 解除 dsh 绑定（移除 agent-llm-local 提供方与默认模型设置），原本在运行则重启。
/// 注意：该槽位与 llama 绑定共用，解除后 llama 侧也需要重新绑定。
#[tauri::command]
pub async fn fast27b_unbind_dsh(state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
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
    if was_running {
        app.emit(
            "dsh:progress",
            serde_json::json!({ "stage": "bind", "message": "正在重新启动 dsh..." }),
        )
        .ok();
        crate::commands::dsh::spawn_dsh_with_events(&state, &app)?;
    }
    Ok(())
}
