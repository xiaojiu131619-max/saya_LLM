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

/**
 * 一次启动实际下发的参数快照。
 *
 * CPU 兼容回退会把 ngl / ctx / batch / flash-attn 等改写掉，界面上的用户配置却仍是原值；
 * `cpuFallback` 为 true 时应提示「已降级」，并展示实际生效值。
 */
export interface DesktopServerLaunchSnapshot {
  requestedNgl: number;
  requestedNCtx: number;
  requestedBatchSize: number;
  ngl: number;
  nCtx: number;
  batchSize: number;
  /** 实际传入 --device 的设备；null 表示由内核自动选择。 */
  device: string | null;
  mainGpu: number | null;
  noCuda: boolean;
  flashAttn: boolean;
  kvOffload: boolean;
  /** true = GPU 启动失败后以 CPU 兼容模式运行，参数已被改写。 */
  cpuFallback: boolean;
}

export async function getDesktopServerStatus() {
  if (!isDesktopRuntime()) return false;
  return invoke<boolean>('get_server_status');
}

/** 读取当前服务实际生效的启动参数；服务未运行时返回 null。 */
export async function getDesktopServerLaunchSnapshot(): Promise<DesktopServerLaunchSnapshot | null> {
  if (!isDesktopRuntime()) return null;
  return invoke<DesktopServerLaunchSnapshot | null>('get_server_launch_snapshot');
}

/**
 * 对任意本地 OpenAI 兼容后端做一次 GET /v1/models 探测（仅回环地址）。
 * 「WebUI 测试」页用：主模型端口、NiNfer 同源桥、Strata 网关都适用。
 */
export async function probeLocalOpenAiApi(url: string, apiKey?: string | null): Promise<PingResult> {
  if (!isDesktopRuntime()) {
    return {
      reachable: false,
      latencyMs: null,
      statusCode: null,
      healthOk: false,
      modelsOk: false,
      models: [],
      error: '浏览器预览环境无法探测本地服务。',
    };
  }
  return invoke<PingResult>('probe_local_openai_api', { url, apiKey: apiKey ?? null });
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

/** 读取自当前模型加载以来经 llama-server 的 token 累计（含对外 API 请求）。 */
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
