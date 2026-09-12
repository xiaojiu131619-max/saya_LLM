//! MCP（Model Context Protocol）服务器管理命令。
//!
//! 配置持久化在 `config.json` 的 `mcp_servers` 段；连接与工具调用由
//! `services::mcp_client` 负责（本机 stdio 子进程 + JSON-RPC 2.0）。

use serde_json::Value;
use tauri::State;

use crate::models::app_state::AppState;
use crate::models::mcp_types::{McpCallResult, McpServerConfig, McpServerStatus};
use crate::services::{mcp_client, mcp_endpoint, process_manager};

/// 读取全部 MCP 服务器配置。
#[tauri::command]
pub fn list_mcp_servers(state: State<'_, AppState>) -> Result<Vec<McpServerConfig>, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;
    Ok(config.mcp_servers.clone())
}

/// 新增或更新一个 MCP 服务器配置（按 id 覆盖）。
#[tauri::command]
pub fn save_mcp_server(
    state: State<'_, AppState>,
    server: McpServerConfig,
) -> Result<Vec<McpServerConfig>, String> {
    let id = server.id.trim().to_string();
    if id.is_empty() {
        return Err("MCP 服务器缺少 id，无法保存。".to_string());
    }
    if server.name.trim().is_empty() {
        return Err("请填写 MCP 服务器名称。".to_string());
    }

    let mut sanitized = server;
    sanitized.id = id.clone();
    sanitized.name = sanitized.name.trim().to_string();
    sanitized.command = sanitized.command.trim().to_string();
    sanitized.timeout_ms = sanitized.timeout_ms.clamp(5_000, 600_000);
    // 传输相关字段统一校验：stdio 要命令，http/sse 要合法的公网地址。
    mcp_endpoint::validate_server_transport(&sanitized)?;

    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    let mut new_config = (*config).clone();
    // 先记录旧配置：连接相关字段变了的话，持久化后要断开旧连接（旧进程/旧端点还在用旧参数）。
    let old = new_config
        .mcp_servers
        .iter()
        .find(|item| item.id == id)
        .cloned();
    let needs_reconnect = old
        .as_ref()
        .map(|old| old.connection_differs(&sanitized))
        .unwrap_or(false);
    match new_config.mcp_servers.iter_mut().find(|item| item.id == id) {
        Some(existing) => *existing = sanitized,
        None => new_config.mcp_servers.push(sanitized),
    }
    crate::commands::config::persist_config_public(&new_config)?;
    *config = new_config;
    if needs_reconnect {
        let _ = mcp_client::disconnect(&id);
    }
    Ok(config.mcp_servers.clone())
}

/// 删除一个 MCP 服务器配置；若它正在运行会一并断开。
#[tauri::command]
pub fn delete_mcp_server(
    state: State<'_, AppState>,
    server_id: String,
) -> Result<Vec<McpServerConfig>, String> {
    let _ = mcp_client::disconnect(&server_id);
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    let mut new_config = (*config).clone();
    new_config.mcp_servers.retain(|item| item.id != server_id);
    crate::commands::config::persist_config_public(&new_config)?;
    *config = new_config;
    Ok(config.mcp_servers.clone())
}

/// 读取所有配置项的运行状态（未配置的 id 会被忽略）。
#[tauri::command]
pub fn get_mcp_statuses(state: State<'_, AppState>) -> Result<Vec<McpServerStatus>, String> {
    let servers = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        config.mcp_servers.clone()
    };
    Ok(servers.iter().map(mcp_client::status).collect())
}

/// 连接一个 MCP 服务器并完成工具发现。
#[tauri::command]
pub fn connect_mcp_server(
    state: State<'_, AppState>,
    server_id: String,
) -> Result<McpServerStatus, String> {
    let server = find_server(&state, &server_id)?;
    mcp_client::connect(&server)
}

/// 断开一个 MCP 服务器（连同它的子进程树）。
#[tauri::command]
pub fn disconnect_mcp_server(server_id: String) -> Result<(), String> {
    mcp_client::disconnect(&server_id)
}

/// 调用 MCP 工具。`qualified_name` 形如 `mcp__<服务器名>__<工具名>`。
#[tauri::command]
pub fn call_mcp_tool(
    state: State<'_, AppState>,
    server_id: String,
    tool_name: String,
    arguments: Option<Value>,
) -> Result<McpCallResult, String> {
    let server = find_server(&state, &server_id)?;
    let args = match arguments {
        Some(Value::Object(map)) => Value::Object(map),
        Some(Value::Null) | None => Value::Object(serde_json::Map::new()),
        Some(other) => {
            return Err(format!(
                "工具参数必须是 JSON 对象，收到：{}",
                other
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| other.to_string())
            ))
        }
    };
    mcp_client::call_tool(&server, &tool_name, args)
}

fn find_server(state: &State<'_, AppState>, server_id: &str) -> Result<McpServerConfig, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;
    config
        .mcp_servers
        .iter()
        .find(|item| item.id == server_id)
        .cloned()
        .ok_or_else(|| format!("找不到 id 为 {server_id} 的 MCP 服务器配置。"))
}

/// 应用退出时断开全部 MCP 连接。
pub fn disconnect_all_on_exit() {
    mcp_client::disconnect_all();
    process_manager::log_server_event("info", "已断开全部 MCP 服务器连接。");
}
