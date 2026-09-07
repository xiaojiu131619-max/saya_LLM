use std::net::IpAddr;

use tauri::{AppHandle, Emitter};

use crate::models::ping_result::PingResult;
use crate::models::server_config::ServerConfig;
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

#[tauri::command]
pub fn start_server(app: AppHandle, config: ServerConfig) -> Result<(), String> {
    let config = normalize_server_access(config);
    let app2 = app.clone();
    let app3 = app.clone();
    process_manager::start_server(
        &config,
        move |progress| {
            app2.emit("server:progress", progress).ok();
        },
        move || {
            app3.emit("server:ready", serde_json::json!({"message": "服务就绪"}))
                .ok();
        },
        move |error| {
            app.emit("server:error", error).ok();
        },
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn stop_server(app: AppHandle) -> Result<(), String> {
    process_manager::stop_server().map_err(|e| e.to_string())?;
    app.emit("server:stopped", serde_json::json!({})).ok();
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
