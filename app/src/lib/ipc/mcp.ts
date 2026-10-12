import { invoke } from '@tauri-apps/api/core';
import type { McpCallResult, McpServerConfig, McpServerStatus } from '@/types';
import { isDesktopRuntime } from '../desktopRuntime';

/**
 * MCP（Model Context Protocol）服务器管理的 IPC 传输层。
 * 纯展示/校验辅助函数（传输标签、端点预校验）不在这里，留在 `lib/desktop`。
 */

export async function listMcpServers() {
  if (!isDesktopRuntime()) return [];
  return invoke<McpServerConfig[]>('list_mcp_servers');
}

export async function saveMcpServer(server: McpServerConfig) {
  if (!isDesktopRuntime()) return [];
  return invoke<McpServerConfig[]>('save_mcp_server', { server });
}

export async function deleteMcpServer(serverId: string) {
  if (!isDesktopRuntime()) return [];
  return invoke<McpServerConfig[]>('delete_mcp_server', { serverId });
}

export async function getMcpStatuses() {
  if (!isDesktopRuntime()) return [];
  return invoke<McpServerStatus[]>('get_mcp_statuses');
}

export async function connectMcpServer(serverId: string) {
  if (!isDesktopRuntime()) return null;
  return invoke<McpServerStatus>('connect_mcp_server', { serverId });
}

export async function disconnectMcpServer(serverId: string) {
  if (!isDesktopRuntime()) return;
  await invoke('disconnect_mcp_server', { serverId });
}

/** 调用 MCP 工具；toolName 必须是 `mcp__<服务器名>__<工具名>` 形式的完整名。 */
export async function callMcpTool(serverId: string, toolName: string, args: Record<string, unknown>) {
  if (!isDesktopRuntime()) return null;
  return invoke<McpCallResult>('call_mcp_tool', { serverId, toolName, arguments: args });
}
