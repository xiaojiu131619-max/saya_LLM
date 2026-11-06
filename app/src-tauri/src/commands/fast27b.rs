//! fast27b 引擎（三元量化 Bonsai-2-27B 离线包）启动通道命令面。
//!
//! - `fast27b_start`        启动引擎（spawn 旁路进程，事件：fast27b:ready / fast27b:stopped / fast27b:error / fast27b:log）
//! - `fast27b_stop`         停止引擎（Job Object 整树回收）
//! - `fast27b_get_status`   运行状态汇总（含 /v1/models 探活结果）
//! - `fast27b_get_metrics`  最近 24 小时、最多 5000 条真实请求性能历史（纯内存快照）
//! - `fast27b_get_logs`     读取 fast27b 日志环形缓冲
//! - `fast27b_clear_logs`   清空 fast27b 日志
//! - `fast27b_get_config` / `fast27b_save_config`  读取/保存 fast27b 配置段
//! - `fast27b_bridge_ensure/status/stop`  官方 webui 同源桥（NiNfer 无内置页面）
//! - `fast27b_bridge_ensure` / `fast27b_bridge_status` / `fast27b_bridge_stop`
//!                         官方 llama.cpp webui 同源桥（fast27b 没有网页界面，靠桥提供页面）

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::models::app_state::{AppState, Fast27bConfig, Fast27bModel};
use crate::services::backend_gate::{self, Backend};
use crate::services::{fast27b_manager, fast27b_metrics, webui_bridge};

/// 从应用配置读取 fast27b 配置段。
fn fast27b_config_from_state(state: &State<'_, AppState>) -> Fast27bConfig {
    state
        .config
        .lock()
        .map(|config| config.fast27b.clone())
        .unwrap_or_default()
}

fn options_from_config(config: &Fast27bConfig) -> fast27b_manager::Fast27bStartOptions {
    let model = config.selected_model();
    fast27b_manager::Fast27bStartOptions {
        engine_path: PathBuf::from(config.engine_path_for_launch()),
        // 旧版 Heretic / Underdog 路径会被自动替换为当前调优文件。
        model_path: PathBuf::from(config.model_path_for(model)),
        model_variant: model,
        port: config.port,
        lan: config.lan,
        api_key: config.api_key.clone(),
        // 与 build_args 的收口一致，避免上下文上限按未收口的配置计算。
        context_window: config.context_window.min(model.max_context_window()),
        draft_tokens: config.draft_tokens,
        default_max_tokens: config.default_max_tokens,
        default_thinking_budget: config.default_thinking_budget,
    }
}

/// 启动 fast27b 引擎（spawn 后立即返回；就绪/退出经 fast27b:ready / fast27b:stopped / fast27b:error 事件）。
#[tauri::command]
pub fn fast27b_start(state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    let config = fast27b_config_from_state(&state);
    let options = options_from_config(&config);
    config.validate_thinking_budget()?;
    // 先确认引擎与权重都在，再停别的后端：路径写错不该把主模型/Strata 一起带走。
    fast27b_manager::validate_options(&options)?;
    // 互斥闸门：先停掉主模型与 Strata，三个后端不能同时占显存。
    let stopped = backend_gate::ensure_exclusive(Backend::Fast27b, &app)?;
    if !stopped.is_empty() {
        app.emit(
            "backend:exclusive",
            serde_json::json!({ "target": "NiNfer", "stopped": stopped }),
        )
        .ok();
    }
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
    config.validate_thinking_budget()?;
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

/// 一键选择 Bonsai / Saluki；先校验目标资源再保存，运行中通过现有重启/就绪事件重载。
#[tauri::command]
pub async fn fast27b_select_model(
    state: State<'_, AppState>,
    app: AppHandle,
    model: Fast27bModel,
) -> Result<(), String> {
    let was_running = {
        let mut guard = state.config.lock().map_err(|error| error.to_string())?;
        let previous = guard.fast27b.clone();
        let selected = previous.with_selected_model(model);
        // 缺文件/无效预算不能先停旧引擎，未运行时同样拒绝保存不可启动的模型选择。
        fast27b_manager::validate_options(&options_from_config(&selected))?;
        let switched =
            previous.selected_model() != model || previous.model_path != selected.model_path;
        let running = switched && fast27b_manager::is_fast27b_running();
        let mut next = (*guard).clone();
        next.fast27b = selected;
        crate::commands::config::persist_config_public(&next)?;
        *guard = next;
        running
    };
    if was_running {
        // 锁已释放；复用 fast27b:progress/ready/stopped/error 流程，等待期间 UI 能继续刷新。
        fast27b_restart(state, app).await?;
    }
    Ok(())
}

/// 命令层停止 fast27b 引擎（Job Object 整树回收），并广播 fast27b:stopped。
///
/// `backend_gate` 与命令都走这里：网页桥必须跟着停，否则端口继续被占用并指向
/// 已死的上游；事件也只在真正停成功后才发，避免前端把「停失败」当已停止。
pub(crate) fn stop_fast27b_with_app(app: &AppHandle) -> Result<(), String> {
    let result = fast27b_manager::stop_fast27b();
    // 引擎停了，网页桥也没有上游了，一并回收（下次启动引擎会重新拉起）。
    webui_bridge::stop();
    if result.is_ok() {
        app.emit(
            "fast27b:stopped",
            serde_json::json!({ "message": "fast27b 已停止。" }),
        )
        .ok();
    }
    result
}

#[tauri::command]
pub fn fast27b_stop(app: AppHandle) -> Result<(), String> {
    stop_fast27b_with_app(&app)
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
    /// 配置的上下文窗口（用户保存值）。
    pub context_window: u32,
    /// 实际下发给引擎的上下文窗口：按所选模型的实测上限收口后的值。
    /// 开环后上下文与设备池解耦，这里通常等于用户保存值（两模型上限都是 262144）。
    pub context_window_effective: u32,
    /// 配置的 DFlash2 / MTP 草稿长度。
    pub draft_tokens: u32,
    /// 配置的引擎默认输出上限（`--default-max-tokens`）；0 = 未设，由引擎自身默认决定。
    pub default_max_tokens: u32,
    /// 默认思考预算（`--default-thinking-budget`）；0 = 省略预算参数，关闭预算限制。
    pub default_thinking_budget: u32,
    /// 官方 webui 同源桥端口（配置）。
    pub bridge_port: u16,
}

/// 读取 fast27b 运行状态 + 配置。
#[tauri::command]
pub fn fast27b_get_status(state: State<'_, AppState>) -> Fast27bStatus {
    let config = fast27b_config_from_state(&state);
    let mut runtime = fast27b_manager::runtime_status();
    // 未启动时也返回已保存的端口和局域网选项，不能把空运行态当成配置默认值。
    if !runtime.running {
        runtime.port = Some(config.port);
        runtime.lan = Some(config.lan);
    }
    let selected_model = config.selected_model();
    let resolved_model_path = config.model_path_for(selected_model);
    let resolved_engine_path = config.engine_path_for_launch();
    Fast27bStatus {
        runtime,
        enabled: config.enabled,
        engine_path: resolved_engine_path.clone(),
        model_path: resolved_model_path.clone(),
        selected_model,
        model_presets: [Fast27bModel::Bonsai, Fast27bModel::Saluki]
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
        engine_exists: !resolved_engine_path.trim().is_empty()
            && std::path::Path::new(&resolved_engine_path).exists(),
        model_exists: !resolved_model_path.trim().is_empty()
            && std::path::Path::new(&resolved_model_path).exists(),
        api_key: config.api_key.clone(),
        context_window: config.context_window,
        context_window_effective: config
            .context_window
            .min(config.selected_model().max_context_window()),
        draft_tokens: config.draft_tokens,
        default_max_tokens: config.default_max_tokens,
        default_thinking_budget: config.default_thinking_budget,
        bridge_port: config.bridge_port,
    }
}

/// 最近 24 小时、最多 5000 条真实请求性能历史；独立于网络探活与状态/配置锁。
#[tauri::command]
pub fn fast27b_get_metrics() -> fast27b_metrics::Fast27bMetricsSnapshot {
    fast27b_metrics::snapshot()
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
    config.validate_thinking_budget()?;
    let mut guard = state.config.lock().map_err(|e| e.to_string())?;
    let mut new_config = (*guard).clone();
    if fast27b_manager::is_fast27b_running()
        && (config.model_path_for(config.selected_model())
            != guard.fast27b.model_path_for(guard.fast27b.selected_model())
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
