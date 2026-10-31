use std::net::IpAddr;

use tauri::{AppHandle, Emitter};

use crate::models::ping_result::PingResult;
use crate::models::server_config::ServerConfig;
use crate::services::backend_gate::{self, Backend};
use crate::services::embedding_manager;
use crate::services::process_manager;

fn is_loopback_host(host: &str) -> bool {
    let normalized = host.trim().trim_start_matches('[').trim_end_matches(']');
    normalized.is_empty()
        || normalized.eq_ignore_ascii_case("localhost")
        || normalized
            .parse::<IpAddr>()
            .map(|address| address.is_loopback())
            .unwrap_or(false)
}

fn normalize_server_access(mut config: ServerConfig) -> ServerConfig {
    if is_loopback_host(&config.host) {
        config.api_key = None;
    }
    config
}

type NormalLoad = (std::sync::Arc<std::sync::atomic::AtomicBool>, std::thread::JoinHandle<()>, std::sync::Arc<std::sync::Mutex<Option<crate::services::benchmark::LifecycleGuard>>>);
static NORMAL_LOAD: once_cell::sync::Lazy<std::sync::Mutex<Option<NormalLoad>>> = once_cell::sync::Lazy::new(|| std::sync::Mutex::new(None));

fn join_normal_load((cancel, worker, _): NormalLoad) {
    cancel.store(true, std::sync::atomic::Ordering::SeqCst);
    let _ = worker.join();
}

#[tauri::command]
pub fn start_server(app: AppHandle, config: ServerConfig) -> Result<(), String> {
    let mut loading = NORMAL_LOAD.lock().map_err(|_| "加载任务锁不可用")?;
    // 先取消并等待上一次普通加载：它自己握着 NORMAL_LOAD 里的 LifecycleGuard，
    // 不先收掉就直接 acquire_lifecycle 只会永远撞上「正在加载」。
    if let Some(previous) = loading.take() { join_normal_load(previous); }
    let guard = crate::services::benchmark::acquire_lifecycle()?;
    // 互斥闸门放在生命周期到手之后：拿不到所有权时不能先把别的后端停掉。
    let stopped = backend_gate::ensure_exclusive(Backend::Main, &app)?;
    if !stopped.is_empty() {
        app.emit(
            "backend:exclusive",
            serde_json::json!({ "target": "主模型", "stopped": stopped }),
        )
        .ok();
    }
    let config = normalize_server_access(config);
    let lifecycle = std::sync::Arc::new(std::sync::Mutex::new(Some(guard)));
    let ready_lifecycle = lifecycle.clone();
    let error_lifecycle = lifecycle.clone();
    let app2 = app.clone();
    let app3 = app.clone();
    let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let worker = process_manager::start_server_internal(
        &config,
        move |progress| {
            app2.emit("server:progress", progress).ok();
        },
        move || {
            if let Ok(mut guard) = ready_lifecycle.lock() { guard.take(); }
            app3.emit("server:ready", serde_json::json!({"message": "服务就绪"}))
                .ok();
        },
        move |error| {
            if let Ok(mut guard) = error_lifecycle.lock() { guard.take(); }
            app.emit("server:error", error).ok();
        },
        Some(cancel.clone()),
    ).map_err(|e| e.to_string())?;
    *loading = Some((cancel, worker, lifecycle));
    Ok(())
}

/// 命令层停止主模型：取消加载、回收生命周期、停进程并广播 `server:stopped`。
///
/// `backend_gate` 也走这里，保证「被别的后端顶掉」与用户手动停止是同一条路径，
/// 前端不会停留在 `serverRunning: true`。
pub(crate) fn stop_server_with_app(app: &AppHandle) -> Result<(), String> {
    let mut loading = NORMAL_LOAD.lock().map_err(|_| "加载任务锁不可用")?;
    // 普通加载可以停止，但不能绕过调参/更新所有权。
    let load_guard = loading.as_ref().and_then(|(_, _, shared)| shared.lock().ok().and_then(|mut g| g.take()));
    let _guard = match load_guard { Some(guard) => guard, None => crate::services::benchmark::acquire_lifecycle()? };
    if let Some(load) = loading.take() { join_normal_load(load); }
    process_manager::stop_server().map_err(|e| e.to_string())?;
    app.emit("server:stopped", serde_json::json!({})).ok();
    Ok(())
}

#[tauri::command]
pub fn stop_server(app: AppHandle) -> Result<(), String> {
    stop_server_with_app(&app)
}

#[tauri::command]
pub fn get_server_status() -> Result<bool, String> {
    Ok(process_manager::is_server_running())
}

#[tauri::command]
pub fn get_server_api_key() -> Result<Option<String>, String> {
    Ok(process_manager::active_server_api_key())
}

#[tauri::command]
pub fn get_lan_ip_address() -> Result<Option<String>, String> {
    Ok(process_manager::lan_ip_address())
}

#[tauri::command]
pub fn get_video_runtime_info() -> Result<process_manager::VideoRuntimeInfo, String> {
    Ok(process_manager::get_video_runtime_info())
}

#[tauri::command]
pub async fn ping_local_api() -> Result<PingResult, String> {
    tauri::async_runtime::spawn_blocking(process_manager::ping_server)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_server_logs() -> Result<Vec<String>, String> {
    Ok(process_manager::get_logs())
}

/// 只返回最后 `count` 行服务日志。
///
/// 服务状态轮询（1Hz）只需要尾部若干行就能解析出 token 读数，拉全量会让每秒都
/// 克隆并序列化整个数组。要看完整日志用 `get_server_logs`。
#[tauri::command]
pub fn get_server_logs_tail(count: usize) -> Result<Vec<String>, String> {
    Ok(process_manager::get_logs_tail(count))
}

#[tauri::command]
pub fn clear_server_logs() -> Result<(), String> {
    process_manager::clear_logs();
    Ok(())
}

/// 读取自当前模型加载以来累计的 token 用量（qllama-server `slot print_timing` 解析）。
/// 供前端把经 llama-server 的全部请求（含对外 API / dsh）并入使用详情。
#[tauri::command]
pub fn api_token_usage() -> Vec<process_manager::TokenUsageAgg> {
    process_manager::api_token_usage()
}

/// 读取统一日志中枢。since_ms 大于 0 时返回该时间戳之后的增量，供前端轮询。
#[tauri::command]
pub fn get_system_logs(since_ms: Option<u64>) -> Result<Vec<process_manager::SystemLogEntry>, String> {
    Ok(process_manager::get_system_logs(since_ms.unwrap_or(0)))
}

#[tauri::command]
pub fn clear_system_logs() -> Result<(), String> {
    process_manager::clear_system_logs();
    Ok(())
}

/// 供前端把应用侧事件（尤其是 API 请求/响应）汇入统一日志中枢。
#[tauri::command]
pub fn log_app_event(level: String, category: String, message: String) -> Result<(), String> {
    let normalized_level = match level.as_str() {
        "debug" | "info" | "warn" | "error" => level,
        _ => "info".to_string(),
    };
    let normalized_category = match category.as_str() {
        "llama" | "server" | "api" | "app" => category,
        _ => "app".to_string(),
    };
    process_manager::push_system_log(&normalized_level, &normalized_category, &message);
    Ok(())
}

// ---------------------------------------------------------------------------
// 向量（Embedding）/ 重排模型旁车服务：与对话/VLM 服务并行运行
// ---------------------------------------------------------------------------

/// 找不到内核时的统一中文错误文案（命令层把它 emit 到 embedding:error 并返回）。
fn embedding_exe_missing_message(executable_path: &str) -> String {
    format!(
        "找不到 llama-server.exe（搜索路径：{}），无法启动向量服务。",
        executable_path
    )
}

/// 解析向量服务要使用的 llama-server.exe。
/// 抽成独立函数，让命令层只负责 emit 事件；
/// 注意 `resolve_exe_path` 会回落到自编译核心/版本化核心，故本函数是否失败取决于
/// 整机是否真的没有可用内核，不适合写成依赖环境的单测（见下方对文案的测试）。
fn resolve_embedding_exe(executable_path: &str) -> Result<String, String> {
    let exe = process_manager::resolve_exe_path(executable_path);
    if exe.is_empty() {
        return Err(embedding_exe_missing_message(executable_path));
    }
    Ok(exe)
}

/// 启动向量模型服务（独立端口、独立进程）。与 start_server 互不干扰，
/// 因此对话/VLM 模型与向量模型可以同时运行。
#[tauri::command]
pub fn start_embedding_server(app: AppHandle, config: ServerConfig) -> Result<(), String> {
    let _guard = crate::services::benchmark::acquire_lifecycle()?;
    let config = normalize_server_access(config);
    let exe = match resolve_embedding_exe(&config.executable_path) {
        Ok(exe) => exe,
        Err(message) => {
            app.emit(
                "embedding:error",
                embedding_manager::EmbeddingError {
                    error_type: "exe".into(),
                    title: "启动失败".into(),
                    details: message.clone(),
                    suggestions: vec![
                        "确认 resources 目录中的 llama.cpp 运行文件完整".into(),
                        "到「核心更新」页重新下载内核".into(),
                    ],
                },
            )
            .ok();
            return Err(message);
        }
    };

    let app_progress = app.clone();
    let app_ready = app.clone();
    let app_error = app.clone();
    embedding_manager::start_embedding_server(
        &config,
        exe,
        move |progress| {
            app_progress.emit("embedding:progress", progress).ok();
        },
        move || {
            app_ready
                .emit("embedding:ready", serde_json::json!({"message": "向量服务就绪"}))
                .ok();
        },
        move |error| {
            app_error.emit("embedding:error", error).ok();
        },
    )
}

#[tauri::command]
pub fn stop_embedding_server(app: AppHandle) -> Result<(), String> {
    embedding_manager::stop_embedding_server()?;
    app.emit("embedding:stopped", serde_json::json!({})).ok();
    Ok(())
}

#[tauri::command]
pub fn get_embedding_status() -> embedding_manager::EmbeddingStatus {
    embedding_manager::embedding_status()
}

#[tauri::command]
pub fn get_embedding_logs() -> Vec<String> {
    embedding_manager::get_embedding_logs()
}

#[tauri::command]
pub fn clear_embedding_logs() {
    embedding_manager::clear_embedding_logs();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stopping_loading_waits_for_worker_exit_without_reacquiring_lifecycle() {
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = cancel.clone();
        let exited = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let done = exited.clone();
        let worker = std::thread::spawn(move || {
            while !flag.load(std::sync::atomic::Ordering::SeqCst) { std::thread::yield_now(); }
            done.store(true, std::sync::atomic::Ordering::SeqCst);
        });
        join_normal_load((cancel, worker, std::sync::Arc::new(std::sync::Mutex::new(None))));
        assert!(exited.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn loopback_server_never_requires_api_key() {
        for host in ["", "localhost", "127.0.0.1", "::1", "[::1]"] {
            let config = ServerConfig {
                host: host.to_string(),
                api_key: Some("secret".to_string()),
                ..ServerConfig::default()
            };
            assert_eq!(normalize_server_access(config).api_key, None);
        }
    }

    #[test]
    fn external_server_keeps_explicit_api_key() {
        let config = ServerConfig {
            host: "0.0.0.0".to_string(),
            api_key: Some("secret".to_string()),
            ..ServerConfig::default()
        };
        assert_eq!(
            normalize_server_access(config).api_key.as_deref(),
            Some("secret")
        );
    }

    #[test]
    fn embedding_exe_missing_message_is_actionable() {
        // 内核缺失时的文案必须中文可读、回显搜索路径，且提及向量服务，
        // 避免前端只看到一个空错误。
        let message = embedding_exe_missing_message("resources/llama-server.exe");
        assert!(message.contains("找不到 llama-server.exe"), "实际错误：{}", message);
        assert!(message.contains("resources/llama-server.exe"), "应回显搜索路径：{}", message);
        assert!(message.contains("向量服务"), "应点明是向量服务：{}", message);
    }
}
