import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open } from '@tauri-apps/plugin-dialog';
import type { ChatGenerationConfig, ExternalApiConfig, Message, ModelInfo, ModelLoadConfig, ReasoningMode, SystemStats } from '@/types';
import { DEFAULT_REASONING_BUDGET, RECOMMENDED_CTX_LENGTH, recommendedGpuLayers, recommendedReasoningBudget } from '@/lib/modelDefaults';

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

export interface ImageApiKeyStatus {
  providerId: string;
  hasKey: boolean;
}

export interface ImageInputPayload {
  name: string;
  mimeType: string;
  dataBase64: string;
}

export interface ImageGenerateRequest {
  providerId: string;
  baseUrl: string;
  model: string;
  prompt: string;
  negativePrompt?: string;
  mode?: 'generate' | 'edit';
  size?: string;
  n?: number;
  quality?: string;
  style?: string;
  responseFormat?: string;
  seed?: number | null;
  steps?: number | null;
  guidanceScale?: number | null;
  aspectRatio?: string;
  workflowJson?: string;
  images?: ImageInputPayload[];
}

export interface GeneratedImage {
  url?: string | null;
  b64Json?: string | null;
  mimeType?: string | null;
  revisedPrompt?: string | null;
}

export interface ImageGenerateResponse {
  providerId: string;
  model: string;
  images: GeneratedImage[];
  text?: string | null;
  usage?: unknown;
  raw: unknown;
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
  thinking: boolean;
  tools: boolean;
  reasoning: boolean;
}

/**
 * 基于模型名称、架构等元信息推断四种能力。
 *
 * 视觉：模型名/架构里出现 vl/vision/clip/llava/internvl 等多模态线索。
 * 思考：能切换 think 模式的模型（Qwen3 系列、Hunyuan think 等），通过 supports_reasoning 透传。
 * 工具：现代 instruct/chat 模型默认具备 function calling 能力（Qwen2.5+/Llama3+/Mistral 系列等）。
 * 推理：R1 / QwQ / o1 类专门用作链式推理输出的模型；这是「思考」的更窄子集。
 */
function inferModelCapabilities(raw: DesktopModelInfo): ModelCapabilities {
  const name = raw.name.toLowerCase();
  const arch = (raw.architecture ?? '').toLowerCase();
  const haystack = `${name} ${arch}`;

  // 视觉：常见多模态命名约定
  const visionKeywords = ['-vl', '_vl', ' vl-', 'vision', 'clip', 'llava', 'internvl', 'minicpm-v', 'minicpm_v', 'cogvlm', 'omni', 'qwen2-vl', 'qwen2.5-vl', 'qwen3-vl'];
  const vision = Boolean(raw.mmproj_path) || visionKeywords.some((kw) => haystack.includes(kw));

  // 推理：R1 / QwQ 等专用推理模型（更窄的子集）
  const reasoningKeywords = ['deepseek-r1', 'deepseek_r1', '-r1-', '-r1.', '_r1_', '/r1-', 'qwq', 'o1-', 'o3-', 'reasoner'];
  const reasoning = reasoningKeywords.some((kw) => haystack.includes(kw));

  // 思考：能开 think 模式的模型；R1/QwQ 永远是思考模型；Qwen3 / Hunyuan-A13B-Think 等也算
  // raw.supports_reasoning 来自 Rust 扫描器，已经覆盖了主流 think/reasoning 模型
  const thinkingKeywords = ['thinking', 'think', 'qwen3', 'qwen-3', 'hunyuan-a'];
  const thinking = reasoning || raw.supports_reasoning || thinkingKeywords.some((kw) => haystack.includes(kw));

  // 工具：保守地认定主流 instruct/chat 系列支持 function calling
  // 规避：纯 base/embed/coder-1.5 等专用小模型；明确包含 instruct/chat 或属于 Qwen2.5+/Llama3+/Mistral 系列时启用
  const toolFamilies = ['qwen2.5', 'qwen-2.5', 'qwen3', 'qwen-3', 'llama-3', 'llama3', 'mistral', 'mixtral', 'hermes', 'firefunction', 'functionary', 'command-r', 'gpt-oss'];
  const hasToolFamily = toolFamilies.some((kw) => haystack.includes(kw));
  const hasInstructTag = haystack.includes('instruct') || haystack.includes('chat') || haystack.includes('-it-') || haystack.endsWith('-it');
  const isBaseOnly = haystack.includes('-base') || haystack.includes('_base') || haystack.includes('-pretrain');
  const tools = !isBaseOnly && (hasToolFamily || (hasInstructTag && !haystack.includes('embed')));

  return { vision, thinking, tools, reasoning };
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
    speculativeDecoding: 'off',
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
      raw.mmproj_path ? `视觉投影：${raw.mmproj_path}` : null,
      raw.mtp_draft_path ? `MTP 草稿模型：${raw.mtp_draft_path}` : null,
      raw.supports_reasoning ? '支持思考输出（reasoning / thinking）。' : null,
    ].filter(Boolean).join('\n') || '已读取本地 GGUF 文件。详细表头信息见模型信息页。',
    tags: ['Local', 'GGUF', ...(raw.mmproj_path ? ['Vision'] : []), ...(raw.mtp_support || raw.mtp_draft_path ? ['MTP'] : []), ...(raw.supports_reasoning ? ['Reasoning'] : [])],
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
    supportsThinking: capabilities.thinking,
    supportsTools: capabilities.tools,
    supportsReasoning: capabilities.reasoning,
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
}) {
  if (!isDesktopRuntime()) return;
  const config = await getDesktopConfig();
  if (!config) return;
  await saveDesktopConfig({
    ...config,
    ...(settings.defaultPort ? { default_port: settings.defaultPort } : {}),
    ...(settings.apiEnabled !== undefined ? { api_enabled: settings.apiEnabled } : {}),
    ...(settings.apiHost !== undefined ? { api_host: settings.apiHost } : {}),
    api_key: null,
  });
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

export async function getImageApiKeyStatus(providerId: string) {
  if (!isDesktopRuntime()) return { providerId, hasKey: false };
  return invoke<ImageApiKeyStatus>('get_image_api_key_status', { providerId });
}

export async function saveImageApiKey(providerId: string, apiKey: string) {
  if (!isDesktopRuntime()) return;
  await invoke('save_image_api_key', { providerId, apiKey });
}

export async function deleteImageApiKey(providerId: string) {
  if (!isDesktopRuntime()) return;
  await invoke('delete_image_api_key', { providerId });
}

export async function clearAllImageApiKeys() {
  if (!isDesktopRuntime()) return 0;
  return invoke<number>('clear_all_image_keys');
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

export async function generateImage(request: ImageGenerateRequest) {
  if (!isDesktopRuntime()) {
    throw new Error('生图 API 调用需要在桌面版中使用。');
  }
  return invoke<ImageGenerateResponse>('generate_image', { request });
}

export async function readDesktopFileContent(path: string) {
  if (!isDesktopRuntime()) {
    throw new Error('读取拖拽文件需要在桌面版中使用。');
  }
  return invoke<string>('read_file_content', { path });
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
    mmproj_path: model.mmprojPath ?? null,
    mtp_draft_path: model.mtpDraftPath ?? null,
    spec_type: model.mtpDraftPath ? 'draft-mtp' : null,
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
  messages: Pick<Message, 'role' | 'content'>[];
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
  const messages = options.config.systemPrompt.trim()
    ? [{ role: 'system' as const, content: options.config.systemPrompt.trim() }, ...options.messages]
    : options.messages;
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
    const firstError = await response.text();
    const retryModelId = serverModelId ?? await getServerModelId(options.port, headers, abortSignal);
    if (retryModelId && retryModelId !== requestModelName && [400, 404, 422].includes(response.status)) {
      response = await fetch(chatUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...requestBody, model: retryModelId }),
        signal: abortSignal,
      });
    }
    if (!response.ok) {
      const retryError = await response.text();
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
    ctxUsed: totalTokens,
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
