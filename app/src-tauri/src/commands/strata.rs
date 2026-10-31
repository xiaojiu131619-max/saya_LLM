//! 智慧模型（Strata 引擎）启动通道命令面。
//!
//! - `strata_start`        启动网关（spawn 旁路进程，事件：strata:ready / strata:stopped / strata:error / strata:log / strata:progress）
//! - `strata_stop`         停止网关（Job Object 整树回收，连带 strata.exe 内核）
//! - `strata_restart`      重启网关
//! - `strata_get_status`   运行状态 + 配置回显 + 三项环境校验
//! - `strata_get_logs`     读取日志环形缓冲
//! - `strata_clear_logs`   清空日志
//! - `strata_get_config` / `strata_save_config` / `strata_set_enabled`
//!
//! 与 fast27b 的差别：智慧模型的就绪判据是 `/health` 的 `loaded` 字段，
//! 不是「端口通了」——90GiB 专家权重的加载要十几分钟，这段时间接口已经在应答。

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::models::app_state::{AppState, StrataConfig};
use crate::services::backend_gate::{self, Backend};
use crate::services::strata_manager;
use crate::services::strata_metrics;

/// 从应用配置读取智慧模型配置段。
fn strata_config_from_state(state: &State<'_, AppState>) -> StrataConfig {
    state
        .config
        .lock()
        .map(|config| config.strata.clone())
        .unwrap_or_default()
}

fn options_from_config(config: &StrataConfig) -> strata_manager::StrataStartOptions {
    strata_manager::StrataStartOptions {
        python_path: PathBuf::from(&config.python_path),
        work_dir: PathBuf::from(&config.work_dir),
        config_path: PathBuf::from(&config.config_path),
        port: config.port,
        lan: config.lan,
        api_key: config.api_key.clone(),
        ready_timeout_secs: config.ready_timeout_secs,
        extra_args: config.extra_args.clone(),
    }
}

/// 把三个输入路径的存在性一并检查出来：
/// 网关能不能起，取决于解释器、源码目录与 run config 三者同时就位。
fn env_checks(config: &StrataConfig) -> (bool, bool, bool) {
    let python_exists = !config.python_path.trim().is_empty()
        && Path::new(&config.python_path).is_file();
    let serve_exists = !config.work_dir.trim().is_empty()
        && Path::new(&config.work_dir).join("serve").join("server.py").is_file();
    let config_exists = !config.config_path.trim().is_empty()
        && Path::new(&config.config_path).is_file();
    (python_exists, serve_exists, config_exists)
}

/// 运行状态 + 配置回显 + 环境校验。
#[derive(Debug, Serialize)]
pub struct StrataStatus {
    // 配置
    pub enabled: bool,
    pub python_path: String,
    pub work_dir: String,
    pub config_path: String,
    pub port: u16,
    pub lan: bool,
    pub api_key: String,
    pub ready_timeout_secs: u64,
    pub extra_args: Vec<String>,
    /// OpenAI 兼容基址（http://127.0.0.1:<port>/v1）。
    pub base_url: String,
    // 环境校验
    pub python_exists: bool,
    pub serve_exists: bool,
    pub config_exists: bool,
    // 运行态
    pub running: bool,
    /// 「可对话」：进程存活 + 权重已加载。
    pub api_ready: bool,
    /// `/health` 可访问（接口在线，权重可能仍在加载）。
    pub api_reachable: bool,
    /// 权重是否已加载（`/health` 的 loaded）。
    pub model_loaded: bool,
    pub model_name: Option<String>,
    pub max_context: Option<u64>,
    pub pid: Option<u32>,
    /// 当前 dsh 绑定（settings.yaml 实读；仅当指向本引擎端口时才有值）。
    pub dsh_bound_model: Option<String>,
    /// dsh Web 地址（按 dsh 配置端口构造）。
    pub dsh_web_url: String,
    /// 网关自带的网页界面地址（`/`，strata 内置 WebUI）。
    pub webui_url: String,
}

/// 读取智慧模型运行状态。
#[tauri::command]
pub async fn strata_get_status(state: State<'_, AppState>) -> Result<StrataStatus, String> {
    let config = strata_config_from_state(&state);
    // runtime_status 内含最长 2 秒的 /health 探活；同步命令会卡住 IPC，
    // 让日志滚动与按钮点击一起卡顿。放到阻塞线程池里做。
    let runtime = tokio::task::spawn_blocking(strata_manager::runtime_status)
        .await
        .unwrap_or_default();
    let (python_exists, serve_exists, config_exists) = env_checks(&config);
    // 绑定信息与 llama / fast27b 共用同一个提供方槽位，只有 baseURL 指向本引擎端口时
    // 才算「智慧模型已接入 dsh」；否则会把别人的绑定误显示成自己的。
    let (bound_model, bound_base_url) =
        crate::services::dsh_config::read_binding();
    let bound_is_strata = bound_base_url
        .as_ref()
        .map(|url| url.contains(&format!(":{}", config.port)))
        .unwrap_or(false);
    let dsh_port = state
        .config
        .lock()
        .map(|config| config.dsh.dsh_port)
        .unwrap_or(3080);
    Ok(StrataStatus {
        enabled: config.enabled,
        python_path: config.python_path.clone(),
        work_dir: config.work_dir.clone(),
        config_path: config.config_path.clone(),
        port: config.port,
        lan: config.lan,
        api_key: config.api_key.clone(),
        ready_timeout_secs: config.ready_timeout_secs,
        extra_args: config.extra_args.clone(),
        base_url: config.base_url(),
        python_exists,
        serve_exists,
        config_exists,
        running: runtime.running,
        api_ready: runtime.api_ready,
        api_reachable: runtime.api_reachable,
        model_loaded: runtime.model_loaded,
        model_name: runtime.model_name,
        max_context: runtime.max_context,
        pid: runtime.pid,
        dsh_bound_model: if bound_is_strata { bound_model } else { None },
        dsh_web_url: format!("http://127.0.0.1:{}", dsh_port),
        webui_url: format!("http://127.0.0.1:{}/", config.port),
    })
}

/// 启动智慧模型（spawn 后立即返回；加载进度经 strata:progress，就绪经 strata:ready）。
#[tauri::command]
pub fn strata_start(state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    let config = strata_config_from_state(&state);
    if !config.enabled {
        return Err("Strata 已停用，请先在页面上启用。".to_string());
    }
    let options = options_from_config(&config);
    // 先校验出生参数，再停别的后端：路径写错不该把正在跑的主模型/NiNfer 一起带走。
    strata_manager::validate_options(&options)?;
    // 互斥闸门：先停掉主模型与 NiNfer，避免两套权重同时抢显存。
    let stopped = backend_gate::ensure_exclusive(Backend::Strata, &app)?;
    if !stopped.is_empty() {
        app.emit(
            "backend:exclusive",
            serde_json::json!({ "target": "Strata", "stopped": stopped }),
        )
        .ok();
    }

    let app_log = app.clone();
    let app_event = app.clone();
    let app_progress = app.clone();
    strata_manager::start_strata(
        &options,
        move |line| {
            app_log
                .emit("strata:log", serde_json::json!({ "line": line }))
                .ok();
        },
        move |message| {
            app_progress
                .emit(
                    "strata:progress",
                    serde_json::json!({ "stage": "start", "message": message }),
                )
                .ok();
        },
        move |event| match event {
            strata_manager::StrataRuntimeEvent::Ready(url) => {
                app_event
                    .emit("strata:ready", serde_json::json!({ "url": url }))
                    .ok();
            }
            strata_manager::StrataRuntimeEvent::Stopped(message) => {
                app_event
                    .emit("strata:stopped", serde_json::json!({ "message": message }))
                    .ok();
            }
            strata_manager::StrataRuntimeEvent::Error(message) => {
                app_event
                    .emit("strata:error", serde_json::json!({ "message": message }))
                    .ok();
            }
        },
    )
}

/// 命令层停止智慧模型（整树终止：Python 网关 + strata.exe 内核）。
/// `backend_gate` 与命令共用，保证被别的后端顶掉时前端也能收到 stopped。
pub(crate) fn stop_strata_with_app(app: &AppHandle) -> Result<(), String> {
    let result = strata_manager::stop_strata();
    if result.is_ok() {
        app.emit(
            "strata:stopped",
            serde_json::json!({ "message": "Strata 已停止。" }),
        )
        .ok();
    }
    result
}

#[tauri::command]
pub fn strata_stop(app: AppHandle) -> Result<(), String> {
    stop_strata_with_app(&app)
}

/// 重启智慧模型。权重重新加载期间不能阻塞主线程，进度照常经事件上报。
#[tauri::command]
pub fn strata_restart(state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    let config = strata_config_from_state(&state);
    if !config.enabled {
        return Err("Strata 已停用，请先在页面上启用。".to_string());
    }
    let options = options_from_config(&config);
    strata_manager::validate_options(&options)?;
    // 重启同样要过互斥闸门：休停期间用户可能已经把主模型或 NiNfer 拉起来了。
    let stopped = backend_gate::ensure_exclusive(Backend::Strata, &app)?;
    if !stopped.is_empty() {
        app.emit(
            "backend:exclusive",
            serde_json::json!({ "target": "Strata", "stopped": stopped }),
        )
        .ok();
    }

    let app_log = app.clone();
    let app_event = app.clone();
    let app_progress = app.clone();
    strata_manager::restart_strata(
        &options,
        move |line| {
            app_log
                .emit("strata:log", serde_json::json!({ "line": line }))
                .ok();
        },
        move |message| {
            app_progress
                .emit(
                    "strata:progress",
                    serde_json::json!({ "stage": "restart", "message": message }),
                )
                .ok();
        },
        move |event| match event {
            strata_manager::StrataRuntimeEvent::Ready(url) => {
                app_event
                    .emit("strata:ready", serde_json::json!({ "url": url }))
                    .ok();
            }
            strata_manager::StrataRuntimeEvent::Stopped(message) => {
                app_event
                    .emit("strata:stopped", serde_json::json!({ "message": message }))
                    .ok();
            }
            strata_manager::StrataRuntimeEvent::Error(message) => {
                app_event
                    .emit("strata:error", serde_json::json!({ "message": message }))
                    .ok();
            }
        },
    )
}

/// 读取智慧模型日志（环形缓冲全量）。
#[tauri::command]
pub fn strata_get_logs() -> Vec<String> {
    strata_manager::get_strata_logs()
}

/// 最近 24 小时、最多 5000 条真实请求性能历史。
///
/// 数据来自网关 `/metrics` 的请求历史，由采集成线程增量收进本地环形缓冲；
/// 网关重启会清空它自己的历史，本地已收敛的部分不受影响。
#[tauri::command]
pub fn strata_get_metrics() -> strata_metrics::StrataMetricsSnapshot {
    strata_metrics::snapshot()
}

/// 清空本地请求统计（不影响网关自己的记录）。
#[tauri::command]
pub fn strata_clear_metrics() {
    strata_metrics::clear();
}

/// 把智慧模型接入 dsh（写入共享提供方槽位并设为默认模型）。
///
/// 与 fast27b 同一套流程，区别在模型 ID：fast-27b 的 ID 来自配置，
/// 智慧模型的 ID 由 run config 决定，只能从网关 `/v1/models` 实读。
#[tauri::command]
pub async fn strata_bind_dsh(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<serde_json::Value, String> {
    let config = strata_config_from_state(&state);
    let base_url = format!("http://127.0.0.1:{}", config.port);
    let api_key = config.api_key.clone();
    let port = config.port;
    let context_window = strata_manager::runtime_status()
        .max_context
        .and_then(|value| u32::try_from(value).ok());

    app.emit(
        "dsh:progress",
        serde_json::json!({ "stage": "bind", "message": "正在校验 Strata 引擎 API..." }),
    )
    .ok();
    let probe_key = api_key.clone();
    let models = tokio::task::spawn_blocking(move || strata_manager::probe_model_ids(port, &probe_key))
        .await
        .map_err(|e| e.to_string())?;
    let model_id = models.into_iter().next().ok_or_else(|| {
        "Strata 引擎未运行或不可达：请先在本页启动引擎、等权重加载完成，再接入 dsh。".to_string()
    })?;

    // 真实小补全：dsh 拿到 200 但内容为空同样不可用（思考模型只回 reasoning_content 也算通过）。
    app.emit(
        "dsh:progress",
        serde_json::json!({ "stage": "bind", "message": "正在校验本地模型 API（真实小补全）..." }),
    )
    .ok();
    let verify_base = base_url.clone();
    let verify_model = model_id.clone();
    let verify_key = api_key.clone();
    tokio::task::spawn_blocking(move || {
        crate::services::dsh_config::verify_model_completion(
            &verify_base,
            &verify_model,
            Some(&verify_key),
        )
    })
    .await
    .map_err(|e| e.to_string())??;

    // 停止 → 写入（自动备份 settings.yaml.bak）→ 原本在跑则重启。
    let was_running = crate::services::dsh_manager::is_dsh_running();
    if was_running {
        app.emit(
            "dsh:progress",
            serde_json::json!({ "stage": "bind", "message": "正在停止 dsh 以写入配置..." }),
        )
        .ok();
        crate::services::dsh_manager::stop_dsh()?;
    }
    app.emit(
        "dsh:progress",
        serde_json::json!({ "stage": "bind", "message": "正在写入 dsh 配置（已自动备份 settings.yaml.bak）..." }),
    )
    .ok();
    let write_base = base_url.clone();
    let write_model = model_id.clone();
    let write_key = api_key.clone();
    tokio::task::spawn_blocking(move || {
        crate::services::dsh_config::write_provider(
            &write_base,
            &write_model,
            Some(&write_key),
            context_window,
        )
    })
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

    Ok(serde_json::json!({
        "model_id": model_id,
        "base_url": base_url,
        "provider": crate::services::dsh_config::PROVIDER_ID,
    }))
}

/// 解除 dsh 绑定（移除共享提供方槽位与默认模型设置），原本在运行则重启。
/// 该槽位与 llama / fast-27b 共用，解除后它们需要各自重新接入。
#[tauri::command]
pub async fn strata_unbind_dsh(state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    let was_running = crate::services::dsh_manager::is_dsh_running();
    if was_running {
        app.emit(
            "dsh:progress",
            serde_json::json!({ "stage": "bind", "message": "正在停止 dsh 以移除配置..." }),
        )
        .ok();
        crate::services::dsh_manager::stop_dsh()?;
    }
    tokio::task::spawn_blocking(crate::services::dsh_config::remove_provider)
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

/// 清空智慧模型日志。
#[tauri::command]
pub fn strata_clear_logs() {
    strata_manager::clear_strata_logs();
}

/// 读取智慧模型配置段。
#[tauri::command]
pub fn strata_get_config(state: State<'_, AppState>) -> StrataConfig {
    strata_config_from_state(&state)
}

/// 保存智慧模型配置段。
///
/// 运行中不允许改「解释器 / 源码目录 / 启动配置 / 端口」这四项——它们是进程的
/// 出生参数，改了也只能等下次启动才生效，静默接受会让人以为改动已经反映到当前实例。
#[tauri::command]
pub fn strata_save_config(
    state: State<'_, AppState>,
    config: StrataConfig,
) -> Result<(), String> {
    if config.port == 0 {
        return Err("端口不能为 0。".to_string());
    }
    if config.ready_timeout_secs == 0 {
        return Err("加载超时不能为 0。".to_string());
    }
    if config.api_key.trim().is_empty() {
        return Err("API Key 不能为空（本地服务也用它做 Bearer 鉴权）。".to_string());
    }
    let mut guard = state.config.lock().map_err(|e| e.to_string())?;
    let mut new_config = (*guard).clone();
    let running = strata_manager::is_strata_running();
    // 端口 / 监听地址 / API Key 都是网关的出生参数：运行中改配置不会影响已起的
    // 实例，但状态回显会拿新值去探测与鉴权，表现为「界面显示可用、请求全部 401」。
    let birth_arg_changed = guard.strata.python_path != config.python_path
        || guard.strata.work_dir != config.work_dir
        || guard.strata.config_path != config.config_path
        || guard.strata.port != config.port
        || guard.strata.lan != config.lan
        || guard.strata.api_key != config.api_key
        || guard.strata.extra_args != config.extra_args;
    if running && birth_arg_changed {
        return Err(
            "请先停止 Strata，再修改解释器、源码目录、启动配置、端口、局域网开关、API Key 或附加参数。"
                .to_string(),
        );
    }
    new_config.strata = config;
    crate::commands::config::persist_config_public(&new_config)?;
    *guard = new_config;
    Ok(())
}

/// 只切换启用开关（不触碰其他配置项）。
#[tauri::command]
pub fn strata_set_enabled(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    let mut guard = state.config.lock().map_err(|e| e.to_string())?;
    let mut new_config = (*guard).clone();
    new_config.strata.enabled = enabled;
    crate::commands::config::persist_config_public(&new_config)?;
    *guard = new_config;
    Ok(())
}
