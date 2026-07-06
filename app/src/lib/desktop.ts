import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open } from '@tauri-apps/plugin-dialog';
import type { ChatGenerationConfig, ChatMessageContentPart, ExternalApiConfig, ModelInfo, ModelLoadConfig, ReasoningMode, SystemStats } from '@/types';
import { DEFAULT_REASONING_BUDGET, RECOMMENDED_CTX_LENGTH, recommendedGpuLayers, recommendedReasoningBudget } from '@/lib/modelDefaults';
import { logDebug, logInfo, logWarn } from '@/lib/appLog';

export interface DesktopModelInfo {
  name: string;
  file_name: string;
  file_path: string;
  file_size_gb: number;
  architecture: string | null;
  params: string | null;
  quantization: string | null;
  is_moe: boolean;
  expert_count: number | null;
  context_length: number | null;
  block_count: number | null;
  embedding_length: number | null;
  head_count: number | null;
  head_count_kv: number | null;
  key_length: number | null;
  value_length: number | null;
  mtp_support: boolean;
  mmproj_path: string | null;
  mtp_draft_path: string | null;
  supports_reasoning: boolean;
  gguf_tags: string[];
  has_tool_template: boolean;
  gguf_metadata: Array<[string, string]>;
}

export interface DesktopConfig {
  version: number;
  model_dirs: string[];
  llama_server_path: string;
  default_port: number;
  api_enabled?: boolean;
  api_host?: string;
  api_key?: string | null;
  theme: string;
  refresh_interval: number;
  auto_scan_on_startup: boolean;
  model_presets: Record<string, unknown>;
  tools: string | null;
  last_model_path: string | null;
  tune_history: unknown[];
  close_to_tray: boolean;
}

export interface PingResult {
  reachable: boolean;
  latencyMs: number | null;
  statusCode: number | null;
  healthOk: boolean;
  modelsOk: boolean;
  models: string[];
  error: string | null;
}

interface DesktopSystemStatus {
  gpu_utilization: number | null;
  vram_used: number | null;
  vram_total: number | null;
  memory_used: number | null;
  memory_total: number | null;
}

interface DesktopHardwareInfo {
  gpu_name: string;
  total_vram: number;
  used_vram: number;
  utilization: number;
  temperature: number;
}

export interface DesktopEngineInfo {
  binary_exists: boolean;
  cuda_graphs_enabled: boolean;
  cuda_version: string | null;
  cuda_matched: boolean;
  sm_architecture: string | null;
  llama_server_version: string | null;
  exe_path: string;
}

export interface DesktopFileDropEvent {
  type: 'enter' | 'over' | 'drop' | 'leave';
  paths?: string[];
  position?: { x: number; y: number };
}

export interface ModelDownloadRequest {
  url: string;
  fileName?: string;
  targetDir: string;
}

export interface ModelDownloadProgress {
  status: 'starting' | 'downloading' | 'finished';
  fileName: string;
  downloadedBytes: number;
  totalBytes?: number | null;
  percent?: number | null;
  message: string;
}

export interface DownloadedModelFile {
  path: string;
  file_name: string;
  size_bytes: number;
}

export interface LlamaReleaseInfo {
  tag_name: string;
  version: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
    size: number;
    backend: string;
    matches_host: boolean;
  }>;
  body: string;
  published_at: string;
  cuda_version: string | null;
  cuda_matched: boolean;
  host_backend: string;
  gpu_name: string | null;
}

export interface MediaPayload {
  mime_type: string;
  data_base64: string;
  byte_size: number;
}

export type ChatMessageContent = string | ChatMessageContentPart[];

export interface ChatCompletionMessage {
  role: 'system' | 'user' | 'assistant';
  content: ChatMessageContent;
}

interface ServerConfig {
  executable_path: string;
  model_path: string;
  port: number;
  host: string;
  api_key: string | null;
  ngl: number;
  n_ctx: number;
  batch_size: number;
  ubatch_size: number;
  threads: number;
  parallel: number;
  flash_attn: boolean;
  kv_offload: boolean;
  kv_unified: boolean;
  mmap: boolean;
  mlock: boolean;
  cache_type_k: string;
  cache_type_v: string;
  cache_type_k_enabled: boolean;
  cache_type_v_enabled: boolean;
  rope_freq_base: number | null;
  rope_freq_scale: number | null;
  seed: number | null;
  chat_template: string | null;
  mmproj_path: string | null;
  mtp_draft_path: string | null;
  spec_type: string | null;
  ncmoe: number;
  tools: string | null;
  reasoning_budget: number;
  device: string | null;
  main_gpu: number | null;
  retry_cpu_fallback: boolean;
  no_cuda: boolean;
}

interface StreamUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface StreamTimings {
  prompt_n?: number;
  predicted_n?: number;
  prompt_ms?: number;
  predicted_ms?: number;
  prompt_per_second?: number;
  predicted_per_second?: number;
  tokens_per_second?: number;
}

interface ChatCompletionChoice {
  delta?: {
    content?: string;
    reasoning_content?: string;
    reasoning?: string;
    thinking?: string;
  };
  message?: {
    content?: string;
    reasoning_content?: string;
    reasoning?: string;
    thinking?: string;
  };
  text?: string;
  content?: string;
  reasoning_content?: string;
  reasoning?: string;
  thinking?: string;
}

export interface ChatCompletionMetrics {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  tokensPerSec?: number;
  firstTokenDelay: number;
  genTime: number;
  ctxUsed: number;
  ctxTotal: number;
}

let activeChatAbortController: AbortController | null = null;

function createAbortError() {
  const error = new Error('已停止生成。');
  error.name = 'AbortError';
  return error;
}

function mergeAbortSignals(...signals: Array<AbortSignal | undefined>) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  signals.forEach((signal) => {
    if (!signal) return;
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
  });

  return controller.signal;
}

export function stopActiveChatCompletion() {
  activeChatAbortController?.abort();
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw createAbortError();
  }
}

const colorByFamily: Record<string, { soft: string; solid: string }> = {
  Qwen: { soft: 'rgba(103, 61, 184, 0.35)', solid: '#673DB8' },
  Llama: { soft: 'rgba(42, 128, 97, 0.35)', solid: '#2A8061' },
  Mistral: { soft: 'rgba(255, 154, 0, 0.35)', solid: '#FF9A00' },
  Yi: { soft: 'rgba(0, 150, 255, 0.35)', solid: '#0096FF' },
  Gemma: { soft: 'rgba(255, 99, 71, 0.35)', solid: '#FF6347' },
  DeepSeek: { soft: 'rgba(55, 60, 70, 0.35)', solid: '#373C46' },
  Phi: { soft: 'rgba(100, 120, 160, 0.35)', solid: '#6478A0' },
  Local: { soft: 'rgba(90, 108, 255, 0.28)', solid: '#5A6CFF' },
};

export function isDesktopRuntime() {
  try {
    return isTauri();
  } catch {
    return false;
  }
}

function hashString(value: string) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function modelFamily(raw: DesktopModelInfo) {
  const text = `${raw.name} ${raw.architecture ?? ''}`.toLowerCase();
  if (text.includes('qwen')) return 'Qwen';
  if (text.includes('llama')) return 'Llama';
  if (text.includes('mistral') || text.includes('mixtral')) return 'Mistral';
  if (text.includes('deepseek')) return 'DeepSeek';
  if (text.includes('gemma')) return 'Gemma';
  if (text.includes('phi')) return 'Phi';
  if (text.includes('yi-') || text.includes('yi_') || text.includes('  yi')) return 'Yi';
  return raw.architecture?.split('-')[0] || '本地';
}

interface ModelCapabilities {
  vision: boolean;
  audio: boolean;
  video: boolean;
  thinking: boolean;
  tools: boolean;
}

/**
 * 分层判定模型能力，按可靠性从高到低逐层叠加：
 *   1. 硬证据：mmproj 同目录文件、chat_template 工具语法、GGUF 自带 tags
 *   2. 架构白名单：稳定且无歧义的家族关系
 *   3. basename / 文件名兜底：用于覆盖未在 GGUF 头里声明的二次微调模型
 *
 * 视觉：必须有同目录 mmproj 文件，模型名/架构的 vl/vision 等只用来旁证（不会单独启用）
 * 音频：GGUF tags 含 audio*；或名字命中 Whisper/Voxtral/Ultravox/Gemma3n 等纯音频家族
 * 视频：GGUF tags 含 video；或名字命中 Omni/VideoLLaMA/Video-LLaVA 等支持视频帧的家族
 * 工具：chat_template 含工具调用语法（最权威）；或 GGUF tags 含 tool-use/function-calling；
 *      或架构属于已知支持工具的家族，且不是 base/embed/pretrain 模型
 * 思考：合并了原"思考"与"推理"。GGUF tags 含 reasoning/thinking/cot；
 *      或 supports_reasoning（来自 Rust 扫描器，含 R1/QwQ/Qwen3+/think/DeepSeek-R1 等）；
 *      或架构属于 qwen3/qwen35/gpt-oss 等默认支持的家族
 */
function inferModelCapabilities(raw: DesktopModelInfo): ModelCapabilities {
  const name = raw.name.toLowerCase();
  const arch = (raw.architecture ?? '').toLowerCase();
  const haystack = `${name} ${arch}`;
  const tags = new Set((raw.gguf_tags ?? []).map((t) => t.toLowerCase()));

  // === 视觉 ===
  // Rust 扫描器已经按同目录和名称相似度匹配 mmproj；前端不再用文件名白名单二次否决。
  const visionFromTags = ['vision', 'image-text-to-text', 'multimodal'].some((t) => tags.has(t));
  const visionArchitectures = [
    'qwen2-vl', 'qwen2.5-vl', 'qwen3-vl', 'qwen2vl', 'qwen25vl', 'qwen3vl',
    'llava', 'llava-next', 'llava_next',
    'phi3-v', 'phi-3-v', 'phi4-v', 'phi-4-v',
    'minicpmv', 'minicpm-v',
    'internvl', 'intern-vl', 'internvl2',
    'janus',
    'florence',
    'pixtral',
  ];
  const visionFromArch = visionArchitectures.some((a) => arch === a || arch.startsWith(a));
  const visionKeywords = ['-vl', '_vl', ' vl-', '-vision', 'vision-', 'llava', 'minicpm', 'deepseek-vl2', 'deepseek_vl2'];
  const visionFromName = visionKeywords.some((kw) => haystack.includes(kw));
  const hasMmproj = Boolean(raw.mmproj_path);
  const vision = hasMmproj || visionFromTags || visionFromArch || visionFromName;

  // === 音频 ===
  const audioFromTags = ['audio', 'audio-text-to-text', 'speech', 'asr', 'tts'].some((t) => tags.has(t));
  const audioKeywords = ['-audio', '_audio', ' audio-', 'whisper', 'voxtral', 'ultravox', 'gemma3n', 'gemma-3n'];
  const audio = audioFromTags || audioKeywords.some((kw) => haystack.includes(kw));

  // === 视频 ===
  const videoFromTags = ['video', 'video-text-to-text', 'video-llava', 'any-to-any'].some((t) => tags.has(t));
  const videoKeywords = ['omni', 'video-llava', 'video_llava', 'videollama', 'videochat', 'longva',
    'qwen2.5-omni', 'qwen2-omni', 'qwen3-omni', 'pllava', 'mimo-vl', 'nano-omni'];
  const video = videoFromTags || videoKeywords.some((kw) => haystack.includes(kw));

  // === 工具调用 ===
  // 1) 最权威：chat_template 里有工具语法
  // 2) GGUF tags 含工具相关条目
  // 3) 架构白名单兜底（必须不是 base/pretrain/embed）
  const toolsFromTemplate = Boolean(raw.has_tool_template);
  const toolsFromTags = ['tool-use', 'function-calling', 'tools', 'agent', 'agents'].some((t) => tags.has(t));
  const isBaseOnly = haystack.includes('-base') || haystack.includes('_base') || haystack.includes('-pretrain');
  const isEmbed = haystack.includes('embed') || haystack.includes('reranker');
  // 架构白名单：已知主流支持 function calling 的架构
  const toolArchitectures = [
    'qwen2', 'qwen3', 'qwen35', 'qwen35moe', 'qwen2moe',
    'llama', 'llama3', 'llama4',
    'mistral', 'mixtral',
    'gemma2', 'gemma3', 'gemma4', 'gemma-2', 'gemma-3', 'gemma-4',
    'glm4', 'glm-4', 'chatglm',
    'gpt-oss', 'gptoss',
    'deepseek2', 'deepseek3',
    'nemotron', 'nemotron_h_moe', 'nemotron-h',
    'command-r', 'cohere',
    'phi3', 'phi-3', 'phi4', 'phi-4',
    'yi',
  ];
  const toolsFromArch = toolArchitectures.some((a) => arch === a || arch.startsWith(a));
  const tools = !isBaseOnly && !isEmbed && (toolsFromTemplate || toolsFromTags || toolsFromArch);

  // === 思考（合并了原推理）===
  // 任何能输出思考内容/链式推理的模型都标
  const thinkingFromTags = ['reasoning', 'thinking', 'chain-of-thought', 'chain_of_thought', 'cot'].some((t) => tags.has(t));
  const thinkingArchitectures = ['qwen3', 'qwen35', 'qwen35moe', 'gpt-oss', 'gptoss'];
  const thinkingFromArch = thinkingArchitectures.some((a) => arch === a || arch.startsWith(a));
  const thinkingKeywords = ['thinking', '-think', '_think', 'qwq', 'reasoner', '-r1-', '-r1.', '_r1_', 'o1-', 'o3-'];
  const thinkingFromName = thinkingKeywords.some((kw) => haystack.includes(kw));
  const thinking = thinkingFromTags || Boolean(raw.supports_reasoning) || thinkingFromArch || thinkingFromName;

  return { vision, audio, video, thinking, tools };
}

function defaultLoadConfig(raw: DesktopModelInfo): ModelLoadConfig {
  return {
    ctxLength: RECOMMENDED_CTX_LENGTH,
    gpuLayers: recommendedGpuLayers(raw.block_count),
    batchSize: 512,
    physicalBatchSize: 512,
    threads: -1,
    parallel: -1,
    fastAttention: true,
    kvCache: true,
    kvUnified: true,
    mmap: true,
    mlock: false,
    cacheTypeKEnabled: false,
    cacheTypeK: 'f16',
    cacheTypeVEnabled: false,
    cacheTypeV: 'f16',
    ropeFreqBaseEnabled: false,
    ropeFreqBase: 0,
    ropeFreqScaleEnabled: false,
    ropeFreqScale: 0,
    seedEnabled: false,
    seed: -1,
    speculativeDecoding: raw.mtp_support || Boolean(raw.mtp_draft_path) ? 'mtp' : 'off',
    chatTemplate: '',
    rememberSettings: true,
    showAdvancedSettings: false,
    idleAutoUnload: false,
    idleAutoUnloadMinutes: 15,
    moeCpuLayers: 0,
    reasoningBudget: recommendedReasoningBudget(raw.supports_reasoning),
  };
}

export function toFrontendModel(raw: DesktopModelInfo): ModelInfo {
  const family = modelFamily(raw);
  const colors = colorByFamily[family] ?? colorByFamily.Local;
  const params = raw.params ?? '本地';
  const quant = raw.quantization ?? 'GGUF';
  const ctxLength = Math.max(0, Number(raw.context_length ?? 0));
  const capabilities = inferModelCapabilities(raw);

  return {
    id: `local-${hashString(raw.file_path)}`,
    name: raw.name,
    family,
    params,
    quant,
    fileSize: `${raw.file_size_gb.toFixed(2)} GB`,
    fileSizeBytes: Math.round(raw.file_size_gb * 1024 * 1024 * 1024),
    modelType: raw.is_moe ? 'moe' : 'dense',
    status: 'standby',
    themeColor: colors.soft,
    themeColorSolid: colors.solid,
    description: `本地 GGUF 模型 · ${raw.file_name}`,
    longDescription: [
      `文件路径：${raw.file_path}`,
      raw.architecture ? `架构：${raw.architecture}` : null,
      raw.block_count ? `层数：${raw.block_count}` : null,
      raw.expert_count ? `专家数：${raw.expert_count}` : null,
      raw.context_length ? `上下文：${raw.context_length}` : null,
      capabilities.vision && raw.mmproj_path ? `视觉投影：${raw.mmproj_path}` : null,
      raw.mtp_draft_path ? `MTP 草稿模型：${raw.mtp_draft_path}` : null,
      raw.supports_reasoning ? '支持思考输出（reasoning / thinking）。' : null,
    ].filter(Boolean).join('\n') || '已读取本地 GGUF 文件。详细表头信息见模型信息页。',
    tags: ['Local', 'GGUF', ...(capabilities.vision ? ['Vision'] : []), ...(raw.mtp_support || raw.mtp_draft_path ? ['MTP'] : []), ...(raw.supports_reasoning ? ['Reasoning'] : [])],
    downloadCount: '本地',
    ctxLength,
    loadConfig: defaultLoadConfig(raw),
    releaseDate: '本地',
    license: '本地文件',
    filePath: raw.file_path,
    source: 'local',
    architecture: raw.architecture ?? undefined,
    blockCount: raw.block_count ?? undefined,
    expertCount: raw.expert_count ?? undefined,
    embeddingLength: raw.embedding_length ?? undefined,
    headCount: raw.head_count ?? undefined,
    headCountKv: raw.head_count_kv ?? undefined,
    keyLength: raw.key_length ?? undefined,
    valueLength: raw.value_length ?? undefined,
    mmprojPath: raw.mmproj_path ?? undefined,
    mtpDraftPath: raw.mtp_draft_path ?? undefined,
    ggufMetadata: raw.gguf_metadata?.map(([key, value]) => ({ key, value })) ?? [],
    supportsVision: capabilities.vision,
    supportsAudio: capabilities.audio,
    supportsVideo: capabilities.video,
    supportsThinking: capabilities.thinking,
    supportsTools: capabilities.tools,
    supportsReasoning: capabilities.thinking,
    supportsMtp: raw.mtp_support || Boolean(raw.mtp_draft_path),
  };
}

export async function getDesktopConfig() {
  if (!isDesktopRuntime()) return null;
  return invoke<DesktopConfig>('get_config');
}

export async function saveDesktopConfig(config: DesktopConfig) {
  if (!isDesktopRuntime()) return;
  await invoke('save_config', { config });
}

export async function saveDesktopRuntimeSettings(settings: {
  defaultPort?: number;
  apiEnabled?: boolean;
  apiHost?: string;
  closeToTray?: boolean;
}) {
  if (!isDesktopRuntime()) return;
  const config = await getDesktopConfig();
  if (!config) return;
  await saveDesktopConfig({
    ...config,
    ...(settings.defaultPort ? { default_port: settings.defaultPort } : {}),
    ...(settings.apiEnabled !== undefined ? { api_enabled: settings.apiEnabled } : {}),
    ...(settings.apiHost !== undefined ? { api_host: settings.apiHost } : {}),
    ...(settings.closeToTray !== undefined ? { close_to_tray: settings.closeToTray } : {}),
    api_key: null,
  });
}

export async function setCloseToTray(enabled: boolean) {
  if (!isDesktopRuntime()) return enabled;
  return invoke<boolean>('set_close_to_tray', { enabled });
}

export async function getExternalApiKeyStatus() {
  if (!isDesktopRuntime()) return false;
  return invoke<boolean>('get_external_api_key_status');
}

export async function getExternalApiKeyForSession() {
  if (!isDesktopRuntime()) return null;
  return invoke<string | null>('get_external_api_key_for_session');
}

export async function createExternalApiKey(apiKey: string) {
  if (!isDesktopRuntime()) return;
  await invoke('create_external_api_key', { apiKey });
}

export async function deleteExternalApiKey() {
  if (!isDesktopRuntime()) return;
  await invoke('delete_external_api_key');
}

export async function scanDesktopModels(full = true) {
  if (!isDesktopRuntime()) return [];
  const command = full ? 'scan_models' : 'scan_fast';
  return invoke<DesktopModelInfo[]>(command);
}

export async function loadDesktopModelFromPath(path: string) {
  if (!isDesktopRuntime()) return null;
  return invoke<DesktopModelInfo>('load_model_from_path', { path });
}

export async function addDesktopModelDir(dir: string) {
  if (!isDesktopRuntime()) return [];
  return invoke<string[]>('add_model_dir', { dir });
}

export async function removeDesktopModelDir(dir: string) {
  if (!isDesktopRuntime()) return [];
  return invoke<string[]>('remove_model_dir', { dir });
}

export async function pickModelDirectory() {
  if (!isDesktopRuntime()) return null;
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === 'string' ? selected : null;
}

export async function getDesktopServerStatus() {
  if (!isDesktopRuntime()) return false;
  return invoke<boolean>('get_server_status');
}

export async function pingLocalApi() {
  if (!isDesktopRuntime()) return null;
  return invoke<PingResult>('ping_local_api');
}

export async function getDesktopServerLogs() {
  if (!isDesktopRuntime()) return [];
  return invoke<string[]>('get_server_logs');
}

export async function clearDesktopServerLogs() {
  if (!isDesktopRuntime()) return;
  await invoke('clear_server_logs');
}

export async function stopDesktopServer() {
  if (!isDesktopRuntime()) return;
  await invoke('stop_server');
}

export async function revealDesktopPath(path: string) {
  if (!isDesktopRuntime()) return;
  await invoke('reveal_path', { path });
}

export async function openExternalUrl(url: string) {
  if (!isDesktopRuntime()) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  await invoke('open_external_url', { url });
}

export async function downloadDesktopModel(request: ModelDownloadRequest) {
  if (!isDesktopRuntime()) {
    throw new Error('模型联网下载需要在桌面版中使用。');
  }
  return invoke<DownloadedModelFile>('download_model_file', { request });
}

export async function checkDesktopEngine(executablePath = 'resources/llama-server.exe') {
  if (!isDesktopRuntime()) return null;
  return invoke<DesktopEngineInfo>('check_engine_info', { exePath: executablePath });
}

export async function checkLatestLlamaRelease() {
  if (!isDesktopRuntime()) return null;
  return invoke<LlamaReleaseInfo>('check_for_update');
}

export async function updateLlamaKernel(url: string, version: string, useMirror = true, mirrorUrl?: string) {
  if (!isDesktopRuntime()) return '';
  return invoke<string>('download_and_update', { url, version, useMirror, mirrorUrl });
}

export async function clearDesktopModelCache() {
  if (!isDesktopRuntime()) return '';
  return invoke<string>('clear_model_cache');
}

export async function resetDesktopAppConfig() {
  if (!isDesktopRuntime()) return;
  await invoke('reset_app_config');
}

export async function getDesktopAppDataDir() {
  if (!isDesktopRuntime()) return null;
  return invoke<string>('get_app_data_dir');
}

export async function readDesktopFileContent(path: string) {
  if (!isDesktopRuntime()) {
    throw new Error('读取拖拽文件需要在桌面版中使用。');
  }
  return invoke<string>('read_file_content', { path });
}

export async function readDesktopMedia(path: string) {
  if (!isDesktopRuntime()) {
    throw new Error('读取媒体文件需要在桌面版中使用。');
  }
  return invoke<MediaPayload>('read_media_file', { path });
}

export function listenDesktopEvent<T>(event: string, callback: (payload: T) => void) {
  if (!isDesktopRuntime()) return Promise.resolve(() => {});
  return listen<T>(event, (message) => callback(message.payload));
}

export function listenDesktopFileDrops(callback: (payload: DesktopFileDropEvent) => void) {
  if (!isDesktopRuntime()) return Promise.resolve(() => {});
  return getCurrentWindow().onDragDropEvent((event) => {
    callback(event.payload as DesktopFileDropEvent);
  });
}

function apiHost(apiConfig?: ExternalApiConfig) {
  if (!apiConfig?.enabled) return '127.0.0.1';
  const host = apiConfig.host.trim();
  return host || '0.0.0.0';
}

function apiKey(apiConfig?: ExternalApiConfig) {
  const key = apiConfig?.apiKey?.trim();
  return key ? key : null;
}

function buildServerConfig(
  model: ModelInfo,
  port: number,
  executablePath: string,
  apiConfig?: ExternalApiConfig,
  tools?: string[]
): ServerConfig {
  if (!model.filePath) {
    throw new Error('这个模型没有本地 GGUF 文件路径，不能启动真实推理服务。');
  }

  const config = model.loadConfig;
  const gpuLayers = Math.max(0, config.gpuLayers);
  const ctxLength = Math.max(1, config.ctxLength);
  const moeCpuLayers = Math.max(0, config.moeCpuLayers);
  const reasoningBudget = Math.max(0, Math.round(Number(config.reasoningBudget ?? 0)));
  const ropeFreqBase = config.ropeFreqBaseEnabled && Number(config.ropeFreqBase) > 0
    ? Number(config.ropeFreqBase)
    : null;
  const ropeFreqScale = config.ropeFreqScaleEnabled && Number(config.ropeFreqScale) > 0
    ? Number(config.ropeFreqScale)
    : null;
  const seed = config.seedEnabled ? Math.round(Number(config.seed ?? -1)) : null;
  const chatTemplate = config.chatTemplate?.trim() || null;
  const enabledTools = Array.from(new Set((tools ?? []).map((tool) => tool.trim()).filter(Boolean)));

  const mtpEnabled = config.speculativeDecoding === 'mtp' && Boolean(model.mtpDraftPath);

  return {
    executable_path: executablePath || 'resources/llama-server.exe',
    model_path: model.filePath,
    port,
    host: apiHost(apiConfig),
    api_key: apiKey(apiConfig),
    ngl: gpuLayers,
    n_ctx: ctxLength,
    batch_size: config.batchSize,
    ubatch_size: config.physicalBatchSize,
    threads: config.threads,
    parallel: config.parallel,
    flash_attn: config.fastAttention,
    kv_offload: config.kvCache,
    kv_unified: config.kvUnified,
    mmap: config.mmap,
    mlock: config.mlock,
    cache_type_k: config.cacheTypeK,
    cache_type_v: config.cacheTypeV,
    cache_type_k_enabled: config.cacheTypeKEnabled,
    cache_type_v_enabled: config.cacheTypeVEnabled,
    rope_freq_base: ropeFreqBase,
    rope_freq_scale: ropeFreqScale,
    seed,
    chat_template: chatTemplate,
    mmproj_path: model.supportsVision && model.mmprojPath ? model.mmprojPath : null,
    mtp_draft_path: mtpEnabled ? (model.mtpDraftPath ?? null) : null,
    spec_type: mtpEnabled ? 'draft-mtp' : null,
    ncmoe: model.modelType === 'moe' ? moeCpuLayers : 0,
    tools: enabledTools.length > 0 ? enabledTools.join(',') : null,
    reasoning_budget: reasoningBudget,
    device: 'CUDA0',
    main_gpu: 0,
    retry_cpu_fallback: false,
    no_cuda: false,
  };
}

export async function startDesktopServer(
  model: ModelInfo,
  port: number,
  executablePath = 'resources/llama-server.exe',
  apiConfig?: ExternalApiConfig,
  tools?: string[]
) {
  if (!isDesktopRuntime()) return;
  await invoke('start_server', { config: buildServerConfig(model, port, executablePath, apiConfig, tools) });
}

export async function getDesktopSystemStats(previous: SystemStats): Promise<SystemStats | null> {
  if (!isDesktopRuntime()) return null;

  const [status, hardware] = await Promise.all([
    invoke<DesktopSystemStatus>('get_system_status'),
    invoke<DesktopHardwareInfo>('get_hardware_info').catch(() => null),
  ]);

  const ramTotal = status.memory_total ?? previous.ramTotal;
  const ramUsed = status.memory_used ?? (previous.ramUsage / 100) * previous.ramTotal;
  const vramTotal = status.vram_total ?? hardware?.total_vram ?? previous.vramTotal;
  const vramUsed = status.vram_used ?? hardware?.used_vram ?? previous.vramUsed;
  const gpuUsage = status.gpu_utilization ?? hardware?.utilization ?? previous.gpuUsage;
  const ramUsage = ramTotal > 0 ? (ramUsed / ramTotal) * 100 : previous.ramUsage;
  const newScores = [...previous.computeScores.slice(1), gpuUsage];

  return {
    gpuUsage: clamp(gpuUsage, 0, 100),
    vramUsed: Math.max(0, vramUsed),
    vramTotal: Math.max(0, vramTotal),
    ramUsage: clamp(ramUsage, 0, 100),
    ramTotal: Math.max(0, ramTotal),
    computeScores: newScores,
    gpuName: hardware?.gpu_name ?? previous.gpuName,
    hostName: previous.hostName === '未连接桌面运行环境' ? '本机' : previous.hostName,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function reasoningBudgetForMode(mode: ReasoningMode, modelBudget: number, supportsReasoning?: boolean) {
  if (mode === 'off') return 0;
  if (mode === 'think') return DEFAULT_REASONING_BUDGET;
  if (mode === 'deep') return DEFAULT_REASONING_BUDGET * 4;
  return supportsReasoning ? Math.max(modelBudget, DEFAULT_REASONING_BUDGET) : Math.max(0, modelBudget);
}

async function getServerModelId(port: number, headers: Record<string, string>, signal?: AbortSignal) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers, signal });
    if (!response.ok) return null;
    const json = await response.json();
    const id = json?.data?.[0]?.id;
    return typeof id === 'string' && id.trim() ? id.trim() : null;
  } catch {
    return null;
  }
}

export async function streamChatCompletion(options: {
  port: number;
  modelName: string;
  messages: ChatCompletionMessage[];
  config: ChatGenerationConfig;
  ctxTotal?: number;
  supportsReasoning?: boolean;
  reasoningBudget?: number;
  apiKey?: string;
  signal?: AbortSignal;
  onToken: (token: string) => void;
  onReasoningDelta?: (reasoningContent: string) => void;
  onUsage?: (usage: { promptTokens: number; completionTokens: number; totalTokens: number; tokensPerSec?: number; firstTokenDelay?: number; genTime?: number }) => void;
}): Promise<ChatCompletionMetrics> {
  // llama-server 支持 text / image_url / input_audio / input_video 四种 content part 类型。
  // 但内部存储用的是 OpenAI 通用 schema (audio_url / video_url)，这里做格式转换。
  const sanitizeContent = (content: ChatMessageContent): ChatMessageContent => {
    if (typeof content === 'string') return content;
    const transformed: ChatMessageContentPart[] = [];
    const errors: string[] = [];

    for (const part of content) {
      if (part.type === 'text' || part.type === 'image_url') {
        transformed.push(part);
      } else if (part.type === 'audio_url') {
        // llama-server 要求格式：{type: 'input_audio', input_audio: {data: '<base64>', format: 'wav'|'mp3'}}
        // data 必须是 raw base64（不带 data:audio/...;base64, 前缀）
        const url = part.audio_url?.url ?? '';
        const match = url.match(/^data:audio\/([\w-]+);base64,(.+)$/);
        if (!match) {
          errors.push('音频格式不正确');
          continue;
        }
        const mimeSubtype = match[1].toLowerCase();
        const rawBase64 = match[2];

        // llama-server 只接受 wav / mp3
        let format: 'wav' | 'mp3';
        if (mimeSubtype === 'wav' || mimeSubtype === 'wave' || mimeSubtype === 'x-wav') {
          format = 'wav';
        } else if (mimeSubtype === 'mpeg' || mimeSubtype === 'mp3') {
          format = 'mp3';
        } else {
          errors.push(`音频格式 ${mimeSubtype} 不支持（llama-server 仅支持 wav/mp3）`);
          continue;
        }

        transformed.push({
          type: 'input_audio',
          input_audio: { data: rawBase64, format },
        });
      } else if (part.type === 'video_url') {
        // llama-server 要求格式：{type: 'input_video', input_video: {data: '<base64>'}}
        // data 必须是 raw base64（不带 data:video/...;base64, 前缀）
        const url = part.video_url?.url ?? '';
        // 放宽 MIME 匹配：video/mp4, video/quicktime, video/x-m4v, video/webm 等都能匹配
        const match = url.match(/^data:video\/[a-zA-Z0-9.+-]+;base64,(.+)$/);
        if (!match) {
          logWarn('multimodal', `视频 dataUrl 格式不匹配正则: ${url.slice(0, 100)}...`);
          errors.push('视频格式不正确');
          continue;
        }
        const rawBase64 = match[1];
        logInfo('multimodal', `video_url → input_video 翻译成功，base64 长度: ${rawBase64.length}`);
        transformed.push({
          type: 'input_video',
          input_video: { data: rawBase64 },
        });
      }
      // 其他未知类型直接丢弃（静默）
    }

    if (errors.length > 0) {
      // 格式错误的附件转为占位文本
      transformed.push({ type: 'text', text: `[${errors.join('；')}]` });
    }
    if (transformed.length === 0) {
      return [{ type: 'text', text: '[此消息含不支持的媒体附件]' }];
    }
    return transformed;
  };

  const sanitizedMessages = options.messages.map((msg) => ({
    role: msg.role,
    content: sanitizeContent(msg.content),
  }));

  const messages: ChatCompletionMessage[] = options.config.systemPrompt.trim()
    ? [{ role: 'system', content: options.config.systemPrompt.trim() }, ...sanitizedMessages]
    : sanitizedMessages;

  // 调试：打印翻译后的消息结构，验证 audio_url/video_url 是否正确转成 input_audio/input_video
  const hasLegacyParts = messages.some(m => Array.isArray(m.content) && m.content.some((p: ChatMessageContentPart) => p.type === 'audio_url' || p.type === 'video_url'));
  if (hasLegacyParts) {
    logWarn('multimodal', '发现未翻译的 audio_url/video_url，翻译可能失败');
    logDebug('multimodal', '原始消息结构', options.messages);
  }
  const hasTranslatedParts = messages.some(m => Array.isArray(m.content) && m.content.some((p: ChatMessageContentPart) => p.type === 'input_audio' || p.type === 'input_video'));
  if (hasTranslatedParts) {
    logInfo('multimodal', '成功翻译 audio_url/video_url → input_audio/input_video');
    logDebug('multimodal', '翻译后消息结构', messages);
  }
  const requestStartedAt = performance.now();
  let firstTokenAt: number | null = null;
  let latestUsage: Partial<ChatCompletionMetrics> = {};
  let reasoningContent = '';
  const localAbortController = new AbortController();
  const abortSignal = mergeAbortSignals(localAbortController.signal, options.signal);
  activeChatAbortController = localAbortController;
  try {
    throwIfAborted(abortSignal);

  const reasoningMode = options.config.reasoningMode ?? 'auto';
  const reasoningBudget = Math.max(0, Math.round(Number(options.reasoningBudget ?? 0)));
  const effectiveReasoningBudget = reasoningBudgetForMode(reasoningMode, reasoningBudget, options.supportsReasoning);
  const supportsReasoning = reasoningMode !== 'off'
    && effectiveReasoningBudget > 0
    && Boolean(options.supportsReasoning || reasoningMode === 'think' || reasoningMode === 'deep');

  const chatUrl = `http://127.0.0.1:${options.port}/v1/chat/completions`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (options.apiKey?.trim()) {
    headers.Authorization = `Bearer ${options.apiKey.trim()}`;
  }
  const serverModelId = await getServerModelId(options.port, headers, abortSignal);
  throwIfAborted(abortSignal);
  const requestModelName = serverModelId ?? options.modelName;
  const maxCompletionTokens = Math.max(0, Math.round(Number(options.config.maxTokens ?? 0)));
  const reasoningTemplateKwargs = (() => {
    if (reasoningMode === 'off') return { enable_thinking: false };
    if (reasoningMode === 'think') return { enable_thinking: true, reasoning_effort: 'minimal' };
    if (reasoningMode === 'deep') return { enable_thinking: true, reasoning_effort: 'high' };
    return undefined;
  })();
  const requestBody = {
    model: requestModelName,
    messages,
    stream: true,
    temperature: options.config.temperature,
    top_p: options.config.topP,
    repeat_penalty: options.config.repeatPenalty,
    ...(maxCompletionTokens > 0 ? {
      max_tokens: maxCompletionTokens,
      n_predict: maxCompletionTokens,
    } : {}),
    ...(reasoningMode === 'off' ? {
      reasoning_budget: 0,
      thinking_budget_tokens: 0,
      ...(reasoningTemplateKwargs ? { chat_template_kwargs: reasoningTemplateKwargs } : {}),
    } : {}),
    ...(supportsReasoning ? {
      reasoning_budget: effectiveReasoningBudget,
      reasoning_format: 'deepseek',
      thinking_budget_tokens: effectiveReasoningBudget,
      ...(reasoningTemplateKwargs ? { chat_template_kwargs: reasoningTemplateKwargs } : {}),
    } : {}),
  };

  let response = await fetch(chatUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody),
    signal: abortSignal,
  });
  throwIfAborted(abortSignal);

  if (!response.ok) {
    // 首次失败：先把 body 读出来，否则后面 fetch 流就走不下去了。
    const firstError = await response.text();
    let retried = false;
    const retryModelId = serverModelId ?? await getServerModelId(options.port, headers, abortSignal);
    if (retryModelId && retryModelId !== requestModelName && [400, 404, 422].includes(response.status)) {
      response = await fetch(chatUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...requestBody, model: retryModelId }),
        signal: abortSignal,
      });
      retried = true;
    }
    if (!response.ok) {
      // 只有真的重试了才再次读 body，否则会触发 "body stream already read"。
      const retryError = retried ? await response.text() : '';
      throw new Error(`llama-server 返回 ${response.status}: ${retryError || firstError}`);
    }
  }

  if (!response.body) {
    throwIfAborted(abortSignal);
    const json = await response.json();
    const choice = json?.choices?.[0] as ChatCompletionChoice | undefined;
    const content = extractContentFromChoice(choice);
    const reasoning = extractReasoningFromChoice(choice);
    if (typeof reasoning === 'string' && reasoning.length > 0) {
      firstTokenAt = performance.now();
      reasoningContent = reasoning;
      options.onReasoningDelta?.(reasoningContent);
    }
    if (typeof content === 'string') {
      firstTokenAt = performance.now();
      options.onToken(content);
    }
    latestUsage = collectCompletionMetrics(latestUsage, json);
    return finalizeCompletionMetrics(latestUsage, requestStartedAt, firstTokenAt, options.ctxTotal, options.onUsage);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let rawBody = '';
  abortSignal.addEventListener('abort', () => {
    void reader.cancel().catch(() => {});
  }, { once: true });

  const processCompletionJson = (json: unknown) => {
    const record = json as { choices?: ChatCompletionChoice[] };
    const choice = record?.choices?.[0] as ChatCompletionChoice | undefined;
    let receivedContent = false;

    const reasoningToken = extractReasoningDelta(choice);
    if (reasoningToken) {
      firstTokenAt ??= performance.now();
      reasoningContent += reasoningToken;
      options.onReasoningDelta?.(reasoningContent);
      receivedContent = true;
    }

    const token = extractContentFromChoice(choice);
    if (token) {
      firstTokenAt ??= performance.now();
      options.onToken(token);
      receivedContent = true;
    }

    latestUsage = collectCompletionMetrics(latestUsage, json);
    return receivedContent;
  };

  const processStreamLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return false;

    const data = trimmed.startsWith('data:')
      ? trimmed.slice(5).trim()
      : trimmed.startsWith('{')
        ? trimmed
        : '';
    if (!data || data === '[DONE]') return false;

    try {
      return processCompletionJson(JSON.parse(data));
    } catch {
      // Ignore partial or non-JSON server-sent event lines.
      return false;
    }
  };

  while (true) {
    throwIfAborted(abortSignal);
    const { value, done } = await reader.read();
    throwIfAborted(abortSignal);
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    rawBody += chunk;
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      throwIfAborted(abortSignal);
      processStreamLine(line);
    }
  }

  throwIfAborted(abortSignal);
  const tail = `${buffer}${decoder.decode()}`.trim();
  if (tail) {
    for (const line of tail.split('\n')) {
      throwIfAborted(abortSignal);
      processStreamLine(line);
    }
  }

  if (!firstTokenAt && rawBody.trim()) {
    try {
      processCompletionJson(JSON.parse(rawBody));
    } catch {
      for (const line of rawBody.split('\n')) {
        processStreamLine(line);
      }
    }
  }

  if (!firstTokenAt && !reasoningContent) {
    const preview = rawBody.trim().slice(0, 300);
    throw new Error(preview
      ? `llama-server 响应中没有可显示内容：${preview}`
      : 'llama-server 没有返回可显示内容');
  }

  return finalizeCompletionMetrics(latestUsage, requestStartedAt, firstTokenAt, options.ctxTotal, options.onUsage);
  } finally {
    if (activeChatAbortController === localAbortController) {
      activeChatAbortController = null;
    }
  }
}

function extractReasoningDelta(choice: ChatCompletionChoice | undefined) {
  return choice?.delta?.reasoning_content
    ?? choice?.delta?.reasoning
    ?? choice?.delta?.thinking
    ?? choice?.message?.reasoning_content
    ?? choice?.reasoning_content
    ?? choice?.reasoning
    ?? choice?.thinking
    ?? '';
}

function extractReasoningFromChoice(choice: ChatCompletionChoice | undefined) {
  return choice?.message?.reasoning_content
    ?? choice?.message?.reasoning
    ?? choice?.message?.thinking
    ?? choice?.reasoning_content
    ?? choice?.reasoning
    ?? choice?.thinking
    ?? '';
}

function extractContentFromChoice(choice: ChatCompletionChoice | undefined) {
  return choice?.delta?.content
    ?? choice?.message?.content
    ?? choice?.content
    ?? choice?.text
    ?? '';
}

function numeric(value: unknown) {
  const next = Number(value ?? 0);
  return Number.isFinite(next) && next > 0 ? next : undefined;
}

function collectCompletionMetrics(current: Partial<ChatCompletionMetrics>, json: unknown): Partial<ChatCompletionMetrics> {
  if (typeof json !== 'object' || json === null) return current;
  const record = json as { usage?: StreamUsage; timings?: StreamTimings };
  const promptTokens = numeric(record.usage?.prompt_tokens) ?? numeric(record.timings?.prompt_n) ?? current.promptTokens;
  const completionTokens = numeric(record.usage?.completion_tokens) ?? numeric(record.timings?.predicted_n) ?? current.completionTokens;
  const totalTokens = numeric(record.usage?.total_tokens)
    ?? (promptTokens && completionTokens ? promptTokens + completionTokens : undefined)
    ?? current.totalTokens;
  const tokensPerSec = numeric(record.timings?.predicted_per_second)
    ?? numeric(record.timings?.tokens_per_second)
    ?? current.tokensPerSec;

  return {
    ...current,
    ...(promptTokens ? { promptTokens } : {}),
    ...(completionTokens ? { completionTokens } : {}),
    ...(totalTokens ? { totalTokens } : {}),
    ...(tokensPerSec ? { tokensPerSec } : {}),
  };
}

function finalizeCompletionMetrics(
  latestUsage: Partial<ChatCompletionMetrics>,
  requestStartedAt: number,
  firstTokenAt: number | null,
  ctxTotal = 0,
  onUsage?: (usage: { promptTokens: number; completionTokens: number; totalTokens: number; tokensPerSec?: number; firstTokenDelay?: number; genTime?: number }) => void
) {
  const finishedAt = performance.now();
  const genTime = Math.max(0, (finishedAt - requestStartedAt) / 1000);
  const firstTokenDelay = firstTokenAt ? Math.max(0, (firstTokenAt - requestStartedAt) / 1000) : 0;
  const promptTokens = Math.max(0, Math.round(latestUsage.promptTokens ?? 0));
  const completionTokens = Math.max(0, Math.round(latestUsage.completionTokens ?? 0));
  const totalTokens = Math.max(0, Math.round(latestUsage.totalTokens ?? promptTokens + completionTokens));
  const fallbackTokensPerSec = completionTokens > 0 && genTime > firstTokenDelay
    ? completionTokens / Math.max(0.001, genTime - firstTokenDelay)
    : undefined;
  const tokensPerSec = latestUsage.tokensPerSec ?? fallbackTokensPerSec;

  const metrics: ChatCompletionMetrics = {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(tokensPerSec && tokensPerSec > 0 ? { tokensPerSec } : {}),
    firstTokenDelay,
    genTime,
  // ctxUsed 反映「整个对话当前累计占用的上下文窗口大小」。
  // llama-server 返回的 prompt_tokens 是当次请求送入的全部历史消息 token 数，
  // 已包含截至该轮的完整对话上下文，因此用它作为 ctx 已用量；
  // 不能用 totalTokens（promptTokens + completionTokens），否则会把本次新生成的
  // 输出也算进"已用上下文"，导致同一条对话内各轮 ctx% 参差不齐、且普遍虚高。
  ctxUsed: promptTokens,
  ctxTotal,
  };

  if (totalTokens > 0) {
    onUsage?.({
      promptTokens,
      completionTokens,
      totalTokens,
      ...(tokensPerSec && tokensPerSec > 0 ? { tokensPerSec } : {}),
      firstTokenDelay,
      genTime,
    });
  }

  return metrics;
}
