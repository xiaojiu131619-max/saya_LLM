import { invoke } from '@tauri-apps/api/core';
import { isDesktopRuntime } from '../desktopRuntime';

/**
 * 对话服务 / 向量服务 / 服务日志的 IPC 传输层。
 *
 * 注意：`startDesktopServer` / `startEmbeddingServer` 不在这里——它们要先做
 * API Key 读取与「无鉴权不得对外开放」的判定，属于领域逻辑，留在 `lib/desktop`。
 */

export interface PingResult {
  reachable: boolean;
  latencyMs: number | null;
  statusCode: number | null;
  healthOk: boolean;
  modelsOk: boolean;
  models: string[];
  baseUrl?: string | null;
  externalBaseUrl?: string | null;
  bindHost?: string | null;
  apiKeyRequired?: boolean;
  protocolStandards?: string[];
  error: string | null;
}

export interface TokenUsageAgg {
  model_name: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  response_count: number;
  last_seen_ms: number;
}

export interface DesktopEmbeddingMediaInfo {
  vision: boolean;
  video: boolean;
  audio: boolean;
  /**
   * 服务端每次启动随机生成的媒体标记；图片/视频向量的 prompt_string 必须以它开头。
   * 已从 `/props` 动态获取。
   */
  mediaMarker: string | null;
}

export interface DesktopEmbeddingStatus {
  running: boolean;
  port: number | null;
  modelName: string | null;
  modelPath: string | null;
  rerank: boolean;
  pid: number | null;
  /** 是否挂了 mmproj（多模态向量：可编码图片 / 视频）。 */
  multimodal: boolean;
  media: DesktopEmbeddingMediaInfo | null;
}

export async function getDesktopServerStatus() {
  if (!isDesktopRuntime()) return false;
  return invoke<boolean>('get_server_status');
}

export async function getServerApiKey() {
  if (!isDesktopRuntime()) return null;
  return invoke<string | null>('get_server_api_key');
}

export async function getLanIpAddress() {
  if (!isDesktopRuntime()) return null;
  return invoke<string | null>('get_lan_ip_address');
}

export async function getDesktopServerLogs() {
  if (!isDesktopRuntime()) return [];
  return invoke<string[]>('get_server_logs');
}

/**
 * 只取最后 `count` 行服务日志。
 *
 * 服务状态卡每秒轮询一次，只需要尾部若干行就能解析出 token 读数；拉全量会让每秒
 * 都克隆并序列化整个数组（最多 2000 行）。要看完整日志请用 `getDesktopServerLogs`。
 */
export async function getDesktopServerLogsTail(count = 400) {
  if (!isDesktopRuntime()) return [];
  return invoke<string[]>('get_server_logs_tail', { count });
}

export async function clearDesktopServerLogs() {
  if (!isDesktopRuntime()) return;
  await invoke('clear_server_logs');
}

/** 读取自当前模型加载以来经 llama-server 的 token 累计（含对外 API / dsh 请求）。 */
export async function getApiTokenUsage() {
  if (!isDesktopRuntime()) return [];
  return invoke<TokenUsageAgg[]>('api_token_usage');
}

export async function stopDesktopServer() {
  if (!isDesktopRuntime()) return;
  await invoke('stop_server');
}

export async function getEmbeddingStatus() {
  if (!isDesktopRuntime()) return null;
  return invoke<DesktopEmbeddingStatus>('get_embedding_status');
}

export async function getEmbeddingLogs() {
  if (!isDesktopRuntime()) return [];
  return invoke<string[]>('get_embedding_logs');
}

export async function clearEmbeddingLogs() {
  if (!isDesktopRuntime()) return;
  await invoke('clear_embedding_logs');
}

export async function stopEmbeddingServer() {
  if (!isDesktopRuntime()) return;
  await invoke('stop_embedding_server');
}
