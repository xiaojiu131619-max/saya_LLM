import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Effect, EffectState, getCurrentWindow } from '@tauri-apps/api/window';
import { open } from '@tauri-apps/plugin-dialog';
import type { ChatGenerationConfig, ChatMessageContentPart, ExternalApiConfig, ModelInfo, ModelLoadConfig, ReasoningMode, SystemStats, VideoSupportLevel } from '@/types';
import { DEFAULT_REASONING_BUDGET, RECOMMENDED_CTX_LENGTH, recommendedGpuLayers, recommendedReasoningBudget } from '@/lib/modelDefaults';
import { logInfo } from '@/lib/appLog';
import { extractVideoFrames, prepareAudioForLlama } from '@/lib/mediaAdapters';
import { filterLlamaCppServerTools } from '@/lib/llamaTools';
import { resolveApiName } from '@/lib/modelIdentity';

export interface DesktopModelInfo {
  name: string;
  file_name: string;
  file_path: string;
  file_size_gb: number;
  split_part?: number | null;
  split_count?: number | null;
  split_total_size_gb?: number | null;
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
  gguf_version?: number;
  mtp_support: boolean;
  nextn_predict_layers?: number;
  has_embedded_mtp?: boolean;
  mtp_architecture_supported?: boolean;
  mtp_tensor_count?: number;
  vocab_size?: number | null;
  tensor_count?: number;
  tensor_type_summary?: Array<[string, number]>;
  rope_freq_base?: number | null;
  rope_dimension_count?: number | null;
  rope_scaling_type?: string | null;
  rope_scaling_factor?: number | null;
  rope_scaling_original_context_length?: number | null;
  tokenizer_model?: string | null;
  tokenizer_bos_id?: number | null;
  tokenizer_eos_id?: number | null;
  tokenizer_pad_id?: number | null;
  mmproj_path: string | null;
  mmproj_supports_vision?: boolean;
  mmproj_supports_audio?: boolean;
  mmproj_projector_type?: string | null;
  mmproj_vision_projector_type?: string | null;
  mmproj_audio_projector_type?: string | null;
  video_support?: VideoSupportLevel;
  mtp_draft_path: string | null;
  dspark_draft_path: string | null;
  dflash_draft_path: string | null;
  is_dynamic_quant?: boolean;
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
  /** 核心更新使用的 HTTP(S) 代理地址；未配置为 null。 */
  proxy_url: string | null;
}

export async function setDesktopProxyUrl(proxyUrl: string | null) {
  if (!isDesktopRuntime()) return;
  await invoke('set_proxy_url', { proxyUrl });
}

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

export interface DesktopVideoRuntimeInfo {
  ffmpeg_available: boolean;
  ffprobe_available: boolean;
  native_video_ready: boolean;
  ffmpeg_path: string | null;
  ffprobe_path: string | null;
}

// ============================================================
// Auto-Tune（镜像后端 models/benchmark.rs）
// ============================================================

export type AutoTuneSortMode = 'ts' | 'ctx';

export interface AutoTuneConfig {
  executable_path: string;
  model_path: string;
  port: number;
  total_layers: number;
  expert_count: number;
  max_ctx: number;
  batch_size: number;
  flash_attn: boolean;
  kv_offload: boolean;
  mmap: boolean;
  mlock: boolean;
  is_moe: boolean;
  sort_mode: AutoTuneSortMode;
}

export interface TuneRecord {
  model_type: string;
  ngl: number;
  ncmoe: number;
  ctx: number;
  kv: string;
  vram_used_gb: number;
  vram_total_gb: number;
  vram_percent: number;
  ts: number;
  first_token_ms: number;
  fits: boolean;
}

export interface AutoTuneProgress {
  phase: string;
  message: string;
  record?: TuneRecord | null;
}

export interface AutoTuneResult {
  best: TuneRecord;
  records: TuneRecord[];
}

export interface TuneHistoryEntry {
  model_name: string;
  model_path: string;
  ngl: number;
  ctx: number;
  kv: string;
  ncmoe: number;
  ts: number;
  vram_percent: number;
  sort_mode: string;
  timestamp: number;
}

export async function startAutoTune(config: AutoTuneConfig) {
  if (!isDesktopRuntime()) return;
  await invoke('start_auto_tune', { config });
}

export async function saveTuneResult(entry: TuneHistoryEntry) {
  if (!isDesktopRuntime()) return;
  await invoke('save_tune_result', { entry });
}

// 模型运行记录：启动参数 + 实测表现，单独存放在 AppData 的 model_records.json，
// 供显存预测校准、推荐启动参数与自动调参做数据支持。
export interface ModelRunRecord {
  model_id: string;
  model_name: string;
  kind: 'launch' | 'benchmark' | 'autotune';
  timestamp: number;
  ngl?: number | null;
  ctx?: number | null;
  kv?: string | null;
  ncmoe?: number | null;
  flash_attn?: boolean | null;
  speculative?: string | null;
  tokens_per_sec?: number | null;
  first_token_ms?: number | null;
  vram_gb?: number | null;
  vram_predicted_gb?: number | null;
  note?: string | null;
}

export async function saveModelRunRecord(record: ModelRunRecord) {
  if (!isDesktopRuntime()) return;
  await invoke('save_model_run_record', { record });
}

export async function getModelRunRecords(modelId: string) {
  if (!isDesktopRuntime()) return [];
  return invoke<ModelRunRecord[]>('get_model_run_records', { modelId });
}

export async function clearModelRunRecords(modelId: string) {
  if (!isDesktopRuntime()) return;
  await invoke('clear_model_run_records', { modelId });
}

export type ChatMessageContent = string | ChatMessageContentPart[];

export interface ChatCompletionMessage {
  role: 'system' | 'user' | 'assistant';
  content: ChatMessageContent;
}

interface ServerConfig {
  executable_path: string;
  model_path: string;
  model_alias: string | null;
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
  no_warmup: boolean;
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
  dspark_draft_path: string | null;
  dflash_draft_path: string | null;
  spec_draft_n_max: number | null;
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

function mergeAbortSignals(...signals: Array<AbortSignal | undefined>): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  const cleanups: Array<() => void> = [];
  signals.forEach((signal) => {
    if (!signal) return;
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    cleanups.push(() => signal.removeEventListener('abort', abort));
  });

  return { signal: controller.signal, cleanup: () => cleanups.forEach((fn) => fn()) };
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
  Qwen: { soft: 'rgba(103, 61, 184, 0.35)', solid: 'var(--accent)' },
  Llama: { soft: 'rgba(42, 128, 97, 0.35)', solid: 'var(--state-success)' },
  Mistral: { soft: 'rgba(255, 154, 0, 0.35)', solid: 'var(--state-warning)' },
  Yi: { soft: 'rgba(0, 150, 255, 0.35)', solid: 'var(--accent)' },
  Gemma: { soft: 'rgba(255, 99, 71, 0.35)', solid: 'var(--state-danger)' },
  DeepSeek: { soft: 'rgba(55, 60, 70, 0.35)', solid: 'var(--accent)' },
  Phi: { soft: 'rgba(100, 120, 160, 0.35)', solid: 'var(--accent)' },
  Local: { soft: 'rgba(90, 108, 255, 0.28)', solid: 'var(--accent)' },
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
  videoSupport: VideoSupportLevel;
  thinking: boolean;
  tools: boolean;
}

function inferVideoSupport(raw: DesktopModelInfo, vision: boolean): VideoSupportLevel {
  if (!vision) return 'none';
  if (raw.video_support && raw.video_support !== 'none') return raw.video_support;

  // 兼容旧扫描缓存或旧后端：按同一套保守规则回退推断。
  const projector = (
    raw.mmproj_vision_projector_type
    ?? raw.mmproj_projector_type
    ?? ''
  ).toLowerCase();
  const nameParts = raw.name.toLowerCase().split(/[^a-z0-9]+/);
  const tags = new Set((raw.gguf_tags ?? []).map((tag) => tag.toLowerCase()));
  if (
    projector === 'nemotron_v2_vl'
    || nameParts.includes('video')
    || ['video', 'video-to-text', 'video-text-to-text', 'video-understanding'].some((tag) => tags.has(tag))
  ) {
    return 'verified';
  }
  if (['qwen2vl_merger', 'qwen2.5vl_merger', 'qwen25vl_merger', 'qwen3vl_merger'].includes(projector)) {
    return 'candidate';
  }
  return 'frames';
}

/**
 * 分层判定模型能力，按可靠性从高到低逐层叠加。
 */
function inferModelCapabilities(raw: DesktopModelInfo): ModelCapabilities {
  const name = raw.name.toLowerCase();
  const arch = (raw.architecture ?? '').toLowerCase();
  const haystack = `${name} ${arch}`;
  const tags = new Set((raw.gguf_tags ?? []).map((t) => t.toLowerCase()));

  // libmtmd 的通用元数据只提供 vision/audio；视频需要独立的证据等级。
  const hasMmproj = Boolean(raw.mmproj_path);
  const vision = hasMmproj && Boolean(raw.mmproj_supports_vision);
  const audio = hasMmproj && Boolean(raw.mmproj_supports_audio);
  const videoSupport = inferVideoSupport(raw, vision);
  const video = videoSupport === 'verified';

  // === 工具调用 ===
  // 1) 最权威：chat_template 里有工具语法
  const toolsFromTemplate = Boolean(raw.has_tool_template);
  const toolsFromTags = ['tool-use', 'function-calling', 'tools', 'agent', 'agents'].some((t) => tags.has(t));
  const isBaseOnly = haystack.includes('-base') || haystack.includes('_base') || haystack.includes('-pretrain');
  const isEmbed = haystack.includes('embed') || haystack.includes('reranker');
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
  const thinkingFromTags = ['reasoning', 'thinking', 'chain-of-thought', 'chain_of_thought', 'cot'].some((t) => tags.has(t));
  const thinkingArchitectures = ['qwen3', 'qwen35', 'qwen35moe', 'gpt-oss', 'gptoss'];
  const thinkingFromArch = thinkingArchitectures.some((a) => arch === a || arch.startsWith(a));
  const thinkingKeywords = ['thinking', '-think', '_think', 'qwq', 'reasoner', '-r1-', '-r1.', '_r1_', 'o1-', 'o3-'];
  const thinkingFromName = thinkingKeywords.some((kw) => haystack.includes(kw));
  const thinking = thinkingFromTags || Boolean(raw.supports_reasoning) || thinkingFromArch || thinkingFromName;

  return { vision, audio, video, videoSupport, thinking, tools };
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
    noWarmup: false,
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
    specDraftNMaxEnabled: false,
    specDraftNMax: 4,
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
      raw.split_count ? `分片 GGUF：第 ${raw.split_part ?? 1} / ${raw.split_count} 片` : null,
      raw.architecture ? `架构：${raw.architecture}` : null,
      raw.gguf_version ? `GGUF 版本：${raw.gguf_version}` : null,
      raw.tensor_count ? `Tensor 数量：${raw.tensor_count}` : null,
      raw.block_count ? `层数：${raw.block_count}` : null,
      raw.expert_count ? `专家数：${raw.expert_count}` : null,
      raw.context_length ? `上下文：${raw.context_length}` : null,
      capabilities.vision && raw.mmproj_path ? `视觉投影：${raw.mmproj_path}` : null,
      capabilities.audio && raw.mmproj_path ? `音频投影：${raw.mmproj_path}` : null,
      raw.has_embedded_mtp ? `内置 MTP：${raw.nextn_predict_layers ?? 0} 个 NextN 层，${raw.mtp_tensor_count ?? 0} 个相关 tensor` : null,
      !raw.has_embedded_mtp && (raw.nextn_predict_layers ?? 0) > 0 && !raw.mtp_architecture_supported
        ? '检测到 NextN 元数据，但当前 llama.cpp 尚未实现该架构的 MTP graph。'
        : null,
      raw.mtp_draft_path ? `MTP 草稿模型：${raw.mtp_draft_path}` : null,
      raw.dspark_draft_path ? `DSpark 侧车：${raw.dspark_draft_path}` : null,
      raw.dflash_draft_path ? `DFlash 侧车：${raw.dflash_draft_path}` : null,
      raw.is_dynamic_quant ? '动态量化（Dynamic GGUF）：按层分配位宽的预量化文件。' : null,
      raw.rope_scaling_type ? `RoPE 缩放：${raw.rope_scaling_type}${raw.rope_scaling_factor ? ` x${raw.rope_scaling_factor}` : ''}` : null,
      raw.tokenizer_model ? `Tokenizer：${raw.tokenizer_model}` : null,
      raw.supports_reasoning ? '支持思考输出（reasoning / thinking）。' : null,
    ].filter(Boolean).join('\n') || '已读取本地 GGUF 文件。详细表头信息见模型信息页。',
    tags: [
      'Local',
      'GGUF',
      ...(raw.split_count ? ['Split GGUF'] : []),
      ...(capabilities.vision ? ['Vision'] : []),
      ...(capabilities.audio ? ['Audio'] : []),
      ...(capabilities.video ? ['Video'] : []),
      ...(raw.mtp_support ? ['MTP'] : []),
      ...(raw.dspark_draft_path ? ['DSpark'] : []),
      ...(raw.dflash_draft_path ? ['DFlash'] : []),
      ...(raw.is_dynamic_quant ? ['Dynamic GGUF'] : []),
      ...(raw.supports_reasoning ? ['Reasoning'] : []),
    ],
    downloadCount: '本地',
    ctxLength,
    loadConfig: defaultLoadConfig(raw),
    releaseDate: '本地',
    license: '本地文件',
    filePath: raw.file_path,
    splitPart: raw.split_part ?? undefined,
    splitCount: raw.split_count ?? undefined,
    splitTotalSizeGb: raw.split_total_size_gb ?? undefined,
    source: 'local',
    architecture: raw.architecture ?? undefined,
    blockCount: raw.block_count ?? undefined,
    expertCount: raw.expert_count ?? undefined,
    embeddingLength: raw.embedding_length ?? undefined,
    headCount: raw.head_count ?? undefined,
    headCountKv: raw.head_count_kv ?? undefined,
    keyLength: raw.key_length ?? undefined,
    valueLength: raw.value_length ?? undefined,
    ggufVersion: raw.gguf_version || undefined,
    tensorCount: raw.tensor_count || undefined,
    mtpTensorCount: raw.mtp_tensor_count || undefined,
    nextnPredictLayers: raw.nextn_predict_layers || undefined,
    hasEmbeddedMtp: Boolean(raw.has_embedded_mtp),
    mtpArchitectureSupported: Boolean(raw.mtp_architecture_supported),
    vocabSize: raw.vocab_size ?? undefined,
    tensorTypeSummary: raw.tensor_type_summary ?? undefined,
    ropeFreqBase: raw.rope_freq_base ?? undefined,
    ropeDimensionCount: raw.rope_dimension_count ?? undefined,
    ropeScalingType: raw.rope_scaling_type ?? undefined,
    ropeScalingFactor: raw.rope_scaling_factor ?? undefined,
    ropeScalingOriginalContextLength: raw.rope_scaling_original_context_length ?? undefined,
    tokenizerModel: raw.tokenizer_model ?? undefined,
    tokenizerBosId: raw.tokenizer_bos_id ?? undefined,
    tokenizerEosId: raw.tokenizer_eos_id ?? undefined,
    tokenizerPadId: raw.tokenizer_pad_id ?? undefined,
    mmprojPath: raw.mmproj_path ?? undefined,
    mmprojSupportsVision: Boolean(raw.mmproj_supports_vision),
    mmprojSupportsAudio: Boolean(raw.mmproj_supports_audio),
    mmprojProjectorType: raw.mmproj_projector_type ?? undefined,
    mmprojVisionProjectorType: raw.mmproj_vision_projector_type ?? undefined,
    mmprojAudioProjectorType: raw.mmproj_audio_projector_type ?? undefined,
    mtpDraftPath: raw.mtp_draft_path ?? undefined,
    dsparkDraftPath: raw.dspark_draft_path ?? undefined,
    dflashDraftPath: raw.dflash_draft_path ?? undefined,
    isDynamicQuant: Boolean(raw.is_dynamic_quant),
    ggufMetadata: raw.gguf_metadata?.map(([key, value]) => ({ key, value })) ?? [],
    supportsVision: capabilities.vision,
    supportsAudio: capabilities.audio,
    supportsVideo: capabilities.video,
    videoSupport: capabilities.videoSupport,
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

export async function getServerApiKey() {
  if (!isDesktopRuntime()) return null;
  return invoke<string | null>('get_server_api_key');
}

export async function getLanIpAddress() {
  if (!isDesktopRuntime()) return null;
  return invoke<string | null>('get_lan_ip_address');
}

let lastPingReachable: boolean | null = null;

export async function pingLocalApi() {
  if (!isDesktopRuntime()) return null;
  const result = await invoke<PingResult>('ping_local_api');
  // 只在可达状态发生变化或探测失败时记录，避免每 2 秒刷屏。
  if (result.reachable !== lastPingReachable) {
    lastPingReachable = result.reachable;
    if (result.reachable) {
      void logDesktopEvent('info', 'api', `接口恢复可达：${result.baseUrl ?? ''}（/health ${result.latencyMs ?? 0} ms）`);
    } else {
      void logDesktopEvent('warn', 'api', `接口不可达：${result.error ?? '未知原因'}`);
    }
  }
  return result;
}

export async function getDesktopServerLogs() {
  if (!isDesktopRuntime()) return [];
  return invoke<string[]>('get_server_logs');
}

export async function clearDesktopServerLogs() {
  if (!isDesktopRuntime()) return;
  await invoke('clear_server_logs');
}

export interface SystemLogEntry {
  timestamp: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  category: 'llama' | 'server' | 'api' | 'app';
  message: string;
}

export async function getDesktopSystemLogs(sinceMs = 0) {
  if (!isDesktopRuntime()) return [];
  return invoke<SystemLogEntry[]>('get_system_logs', { sinceMs });
}

export async function clearDesktopSystemLogs() {
  if (!isDesktopRuntime()) return;
  await invoke('clear_system_logs');
}

// 把应用侧事件汇入后端统一日志中枢。best-effort：失败不影响主流程。
export async function logDesktopEvent(level: SystemLogEntry['level'], category: SystemLogEntry['category'], message: string) {
  if (!isDesktopRuntime()) return;
  try {
    await invoke('log_app_event', { level, category, message });
  } catch {
    // 日志记录失败不应打断业务。
  }
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

export async function checkDesktopEngine(executablePath = 'resources/llama-server.exe') {
  if (!isDesktopRuntime()) return null;
  return invoke<DesktopEngineInfo>('check_engine_info', { exePath: executablePath });
}

export async function listRecentLlamaReleases(count = 8) {
  if (!isDesktopRuntime()) return [];
  return invoke<LlamaReleaseInfo[]>('list_recent_releases', { count });
}

export interface VideoRuntimeInfo {
  ffmpeg_available: boolean;
  ffprobe_available: boolean;
  native_video_ready: boolean;
  ffmpeg_path?: string | null;
  ffprobe_path?: string | null;
}

export async function checkVideoRuntime() {
  if (!isDesktopRuntime()) return null;
  return invoke<VideoRuntimeInfo>('check_video_runtime');
}

export async function cancelKernelUpdate() {
  await invoke('cancel_kernel_update');
}

export interface InstalledKernelInfo {
  name: string;
  version: string;
  installed_at: string;
  is_active: boolean;
}

export async function listInstalledKernels() {
  if (!isDesktopRuntime()) return [];
  return invoke<InstalledKernelInfo[]>('list_installed_kernels');
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

export async function getDesktopVideoRuntimeInfo() {
  if (!isDesktopRuntime()) return null;
  return invoke<DesktopVideoRuntimeInfo>('get_video_runtime_info');
}

/**
 * 读取 Windows 系统的 accent color 与亮/暗主题偏好。
 * 非 Tauri 运行时返回 null，前端可走 matchMedia fallback。
 */
export interface DesktopSystemAppearance {
  accent_color: string;
  apps_use_light_theme: boolean;
  supports_mica: boolean;
}

export async function getDesktopSystemAppearance(): Promise<DesktopSystemAppearance | null> {
  if (!isDesktopRuntime()) return null;
  try {
    return await invoke<DesktopSystemAppearance>('get_system_appearance');
  } catch {
    return null;
  }
}

/**
 * 切换窗口系统材质。
 * - mica：Win11 默认桌面材质，偏实、颜色变化弱（Win10 上不可用，等于无材质）
 * - acrylic：系统亚克力毛玻璃，能透出壁纸色，同时带系统级模糊
 * - Windows 10 上 Acrylic 可能不可用或无效果，自动回退 Blur（兼容性最好的模糊材质）
 */
export async function setDesktopWindowMaterial(material: 'mica' | 'acrylic') {
  if (!isDesktopRuntime()) return;
  try {
    await getCurrentWindow().setEffects({
      effects: [material === 'acrylic' ? Effect.Acrylic : Effect.Mica],
      state: EffectState.Active,
    });
  } catch (acrylicError) {
    if (material !== 'acrylic') return;
    try {
      await getCurrentWindow().setEffects({
        effects: [Effect.Blur],
        state: EffectState.Active,
      });
    } catch {
      console.error('[window] acrylic/blur 材质均设置失败', acrylicError);
    }
  }
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

// 传给 llama-server 的 API Key：只要 keyring 里有就带上。
// 是否真正启用鉴权由「监听地址」决定——回环监听时后端 normalize_server_access
// 会强制丢弃 Key，所以这里无需再看 enabled，避免「已设置 Key 却没生效」的错觉。
function apiKey(apiConfig?: ExternalApiConfig) {
  const key = apiConfig?.apiKey?.trim();
  return key ? key : null;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === '' || normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

// 软件内对话始终走回环（127.0.0.1）。只有当服务真正对外开放（enabled 且监听地址
// 不是回环）并配置了 Key 时，服务端才会要求鉴权，这时才需要带上 Authorization。
// 回环监听时服务端无鉴权，再发一个可能过期的 Key 只会制造 401 噪音。
export function effectiveRequestApiKey(apiConfig?: ExternalApiConfig): string | undefined {
  if (!apiConfig?.enabled) return undefined;
  if (isLoopbackHost(apiConfig.host)) return undefined;
  const key = apiConfig.apiKey?.trim();
  return key ? key : undefined;
}

export function isServerAuthError(error: unknown): boolean {
  const text = String(error instanceof Error ? error.message : error);
  return text.includes('401') || text.includes('Invalid API Key') || text.includes('authentication_error');
}

export function serverErrorHint(error: unknown): string {
  if (isServerAuthError(error)) {
    return 'API Key 与当前运行的 llama-server 不匹配。如果你最近重新申请或撤销了 API Key，请重新加载模型使新 Key 生效。';
  }
  return '请确认模型已经加载完成，llama-server 正在运行。';
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
  const cpuOnly = gpuLayers === 0;
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
  const enabledTools = filterLlamaCppServerTools(tools ?? []);

  // 推测解码模式与模型实际能力的交集：用户选了但模型没有对应侧车/内置 MTP 时，
  // 显式回退为 off（不静默传一个没有文件的路径）。
  const requestedMode = config.speculativeDecoding;
  const speculativeMode = requestedMode === 'mtp' && !model.supportsMtp
    ? 'off'
    : requestedMode === 'dspark' && !model.dsparkDraftPath
      ? 'off'
      : requestedMode === 'dflash' && !model.dflashDraftPath
        ? 'off'
        : requestedMode;
  const mtpDraft = speculativeMode === 'mtp' ? (model.mtpDraftPath ?? null) : null;
  const dsparkDraft = speculativeMode === 'dspark' ? (model.dsparkDraftPath ?? null) : null;
  const dflashDraft = speculativeMode === 'dflash' ? (model.dflashDraftPath ?? null) : null;
  // 显式模式传新拼写（dspark/dflash）；MTP 沿用兼容拼写 draft-mtp。
  const specType = speculativeMode === 'mtp' ? 'draft-mtp'
    : speculativeMode === 'dspark' ? 'dspark'
      : speculativeMode === 'dflash' ? 'dflash'
        : null;
  // 草稿深度只在推测解码已启用且用户显式开启时传，None=不传（用内核默认）。
  // 模式为 off 时即使持久化里开着也忽略，避免在没有 --spec-type 的命令行上残留孤立参数。
  const specDraftNMax = speculativeMode !== 'off' && config.specDraftNMaxEnabled
    ? Math.min(16, Math.max(1, Math.round(Number(config.specDraftNMax) || 1)))
    : null;
  const hasMultimodalProjector = Boolean(
    model.mmprojPath && (model.supportsVision || model.supportsAudio)
  );

  return {
    executable_path: executablePath || 'resources/llama-server.exe',
    model_path: model.filePath ?? '',
    model_alias: resolveApiName(model),
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
    kv_offload: cpuOnly ? false : config.kvCache,
    kv_unified: config.kvUnified,
    mmap: config.mmap,
    mlock: config.mlock,
    no_warmup: config.noWarmup,
    cache_type_k: config.cacheTypeK,
    cache_type_v: config.cacheTypeV,
    cache_type_k_enabled: config.cacheTypeKEnabled,
    cache_type_v_enabled: config.cacheTypeVEnabled,
    rope_freq_base: ropeFreqBase,
    rope_freq_scale: ropeFreqScale,
    seed,
    chat_template: chatTemplate,
    mmproj_path: hasMultimodalProjector ? (model.mmprojPath ?? null) : null,
    mtp_draft_path: mtpDraft,
    dspark_draft_path: dsparkDraft,
    dflash_draft_path: dflashDraft,
    spec_draft_n_max: specDraftNMax,
    spec_type: specType,
    ncmoe: model.modelType === 'moe' ? moeCpuLayers : 0,
    tools: enabledTools.length > 0 ? enabledTools.join(',') : null,
    reasoning_budget: reasoningBudget,
    device: cpuOnly ? null : 'CUDA0',
    main_gpu: cpuOnly ? null : 0,
    retry_cpu_fallback: !cpuOnly,
    no_cuda: cpuOnly,
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
  let storedApiKey: string | null = null;
  if (apiConfig?.enabled) {
    try {
      storedApiKey = await getExternalApiKeyForSession();
    } catch (error) {
      throw new Error(`无法读取 API Key，已阻止在无鉴权状态下开放接口：${String(error)}`);
    }
  }
  if (apiConfig?.enabled && apiConfig.hasApiKey && !storedApiKey) {
    throw new Error('无法读取已配置的 API Key，已阻止在无鉴权状态下开放接口。请重新申请 API Key 后再加载模型。');
  }
  const runtimeApiConfig = apiConfig
    ? { ...apiConfig, apiKey: storedApiKey ?? undefined }
    : undefined;
  await invoke('start_server', { config: buildServerConfig(model, port, executablePath, runtimeApiConfig, tools) });
}

export async function getDesktopSystemStats(previous: SystemStats): Promise<SystemStats | null> {
  if (!isDesktopRuntime()) return null;

  const status = await invoke<DesktopSystemStatus>('get_system_status');
  const hardware = await invoke<DesktopHardwareInfo>('get_hardware_info').catch(() => null);

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
  } as SystemStats;
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

interface ServerModalities {
  resolved: boolean;
  vision: boolean;
  audio: boolean;
  video: boolean;
  reportedVideo: boolean;
  hasNativeVideoProtocol: boolean;
  videoFallbackReason?: string;
}

function messagesContainPart(messages: ChatCompletionMessage[], type: ChatMessageContentPart['type']) {
  return messages.some((message) =>
    Array.isArray(message.content) && message.content.some((part) => part.type === type)
  );
}

function validateMediaSupport(
  modalities: ServerModalities,
  hasAudio: boolean,
  hasVideo: boolean,
) {
  if (modalities.resolved && hasAudio && !modalities.audio) {
    throw new Error('当前 llama-server 没有加载支持音频的 mmproj。');
  }
  if (modalities.resolved && hasVideo && !modalities.vision) {
    throw new Error('当前 llama-server 没有加载支持视觉的 mmproj，无法处理视频。');
  }
}

async function sanitizeContentForLlama(
  content: ChatMessageContent,
  useNativeVideo: boolean,
): Promise<ChatMessageContent> {
  if (typeof content === 'string') return content;
  const transformed: ChatMessageContentPart[] = [];

  for (const part of content) {
    if (
      part.type === 'text'
      || part.type === 'image_url'
      || part.type === 'input_audio'
      || part.type === 'input_video'
    ) {
      transformed.push(part);
    } else if (part.type === 'audio_url') {
      const payload = await prepareAudioForLlama(part.audio_url?.url ?? '');
      transformed.push({
        type: 'input_audio',
        input_audio: payload,
      });
    } else if (part.type === 'video_url') {
      const url = part.video_url?.url ?? '';
      const comma = url.indexOf(',');
      const validDataUrl = url.startsWith('data:video/')
        && comma >= 0
        && url.slice(0, comma).toLowerCase().includes(';base64')
        && url.length > comma + 1;
      if (!validDataUrl) throw new Error('视频格式不正确，缺少 base64 data URL。');

      if (useNativeVideo) {
        transformed.push({
          type: 'input_video',
          input_video: { data: url.slice(comma + 1) },
        });
      } else {
        const frames = part.video_url.frames?.length
          ? part.video_url.frames
          : await extractVideoFrames(url);
        transformed.push({
          type: 'text',
          text: `[视频抽帧兼容：以下 ${frames.length} 帧按时间顺序提取；这不等同于原生视频理解]`,
        });
        frames.forEach((frame, index) => {
          const minutes = Math.floor(frame.timestampSeconds / 60);
          const seconds = (frame.timestampSeconds % 60).toFixed(1).padStart(4, '0');
          transformed.push({
            type: 'text',
            text: `[视频帧 ${index + 1}/${frames.length} · ${minutes}:${seconds}]`,
          });
          transformed.push({
            type: 'image_url',
            image_url: { url: frame.url },
          });
        });
      }
    }
  }

  return transformed.length > 0
    ? transformed
    : [{ type: 'text', text: '[此消息没有可发送的媒体内容]' }];
}

async function sanitizeMessagesForLlama(
  messages: ChatCompletionMessage[],
  useNativeVideo: boolean,
): Promise<ChatCompletionMessage[]> {
  return Promise.all(messages.map(async (message) => ({
    role: message.role,
    content: await sanitizeContentForLlama(message.content, useNativeVideo),
  })));
}

function logMultimodalMode(hasAudio: boolean, hasVideo: boolean, modalities: ServerModalities) {
  if (hasAudio) logInfo('multimodal', '音频已适配为 llama.cpp input_audio。');
  if (!hasVideo) return;
  const mode = modalities.video
    ? 'llama.cpp 原生 input_video'
    : `图像帧兼容模式（${modalities.videoFallbackReason ?? (
      modalities.hasNativeVideoProtocol ? '原生视频未就绪' : '旧版 server'
    )}）`;
  logInfo('multimodal', `视频使用${mode}。`);
}

async function getServerModalities(
  port: number,
  headers: Record<string, string>,
  hasVideo: boolean,
  videoSupport: VideoSupportLevel,
  signal?: AbortSignal,
): Promise<ServerModalities> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/props`, { headers, signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    const modalities = json?.modalities;
    const reportedVideo = Boolean(modalities?.video);
    const modelAllowsNativeVideo = videoSupport === 'verified' || videoSupport === 'candidate';
    let video = reportedVideo && modelAllowsNativeVideo;
    let videoFallbackReason: string | undefined;

    if (!modelAllowsNativeVideo) {
      videoFallbackReason = videoSupport === 'frames'
        ? '模型仅验证了视觉抽帧'
        : '模型未检测到视频能力';
    } else if (!reportedVideo) {
      videoFallbackReason = 'llama-server 未报告原生视频';
    }

    if (hasVideo && video && isDesktopRuntime()) {
      if (signal) throwIfAborted(signal);
      try {
        const runtime = await getDesktopVideoRuntimeInfo();
        if (signal) throwIfAborted(signal);
        if (!runtime?.native_video_ready) {
          video = false;
          videoFallbackReason = '缺少 ffmpeg/ffprobe';
        }
      } catch (error) {
        if (signal?.aborted) throw createAbortError();
        video = false;
        videoFallbackReason = `无法确认 ffmpeg/ffprobe：${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return {
      resolved: true,
      vision: Boolean(modalities?.vision),
      audio: Boolean(modalities?.audio),
      video,
      reportedVideo,
      hasNativeVideoProtocol: Boolean(
        modalities && Object.prototype.hasOwnProperty.call(modalities, 'video')
      ),
      videoFallbackReason,
    };
  } catch {
    if (signal?.aborted) throw createAbortError();
    return {
      resolved: false,
      vision: false,
      audio: false,
      video: false,
      reportedVideo: false,
      hasNativeVideoProtocol: false,
      videoFallbackReason: '无法读取 llama-server 能力',
    };
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
  videoSupport?: VideoSupportLevel;
  apiKey?: string;
  signal?: AbortSignal;
  onToken: (token: string) => void;
  onReasoningDelta?: (reasoningContent: string) => void;
  onUsage?: (usage: { promptTokens: number; completionTokens: number; totalTokens: number; tokensPerSec?: number; firstTokenDelay?: number; genTime?: number }) => void;
}): Promise<ChatCompletionMetrics> {
  const requestStartedAt = performance.now();
  let firstTokenAt: number | null = null;
  let latestUsage: Partial<ChatCompletionMetrics> = {};
  let reasoningContent = '';
  const localAbortController = new AbortController();
  const { signal: abortSignal, cleanup: cleanupAbortListeners } = mergeAbortSignals(localAbortController.signal, options.signal);
  activeChatAbortController = localAbortController;
  try {
    throwIfAborted(abortSignal);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (options.apiKey?.trim()) {
    headers.Authorization = `Bearer ${options.apiKey.trim()}`;
  }
  const hasAudio = messagesContainPart(options.messages, 'audio_url');
  const hasVideo = messagesContainPart(options.messages, 'video_url');
  const serverModalities = await getServerModalities(
    options.port,
    headers,
    hasVideo,
    options.videoSupport ?? 'none',
    abortSignal,
  );
  validateMediaSupport(serverModalities, hasAudio, hasVideo);

  const buildMessages = async (useNativeVideo: boolean): Promise<ChatCompletionMessage[]> => {
    const sanitizedMessages = await sanitizeMessagesForLlama(options.messages, useNativeVideo);
    return options.config.systemPrompt.trim()
      ? [{ role: 'system', content: options.config.systemPrompt.trim() }, ...sanitizedMessages]
      : sanitizedMessages;
  };

  const messages = await buildMessages(serverModalities.video);
  logMultimodalMode(hasAudio, hasVideo, serverModalities);

  const reasoningMode = options.config.reasoningMode ?? 'auto';
  const reasoningBudget = Math.max(0, Math.round(Number(options.reasoningBudget ?? 0)));
  const effectiveReasoningBudget = reasoningBudgetForMode(reasoningMode, reasoningBudget, options.supportsReasoning);
  const supportsReasoning = reasoningMode !== 'off'
    && effectiveReasoningBudget > 0
    && Boolean(options.supportsReasoning || reasoningMode === 'think' || reasoningMode === 'deep');

  const chatUrl = `http://127.0.0.1:${options.port}/v1/chat/completions`;
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

  let activeRequestBody = requestBody;
  const apiStartedAt = performance.now();
  let response = await fetch(chatUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(activeRequestBody),
    signal: abortSignal,
  });
  throwIfAborted(abortSignal);
  void logDesktopEvent(
    'info',
    'api',
    `POST ${chatUrl} → ${response.status}（${Math.round(performance.now() - apiStartedAt)} ms，模型 ${requestModelName}）`,
  );

  if (!response.ok) {
    let firstError = await response.text();
    let retried = false;
    if (hasVideo && serverModalities.video) {
      logInfo('multimodal', '原生视频请求失败，自动改用图像帧兼容模式重试。');
      activeRequestBody = {
        ...requestBody,
        messages: await buildMessages(false),
      };
      response = await fetch(chatUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(activeRequestBody),
        signal: abortSignal,
      });
      retried = true;
      if (!response.ok) firstError = await response.clone().text();
    }
    const retryModelId = serverModelId ?? await getServerModelId(options.port, headers, abortSignal);
    if (retryModelId && retryModelId !== requestModelName && [400, 404, 422].includes(response.status)) {
      response = await fetch(chatUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...activeRequestBody, model: retryModelId }),
        signal: abortSignal,
      });
      retried = true;
    }
    if (!response.ok) {
      const retryError = retried ? (await response.text()).slice(0, 500) : '';
      const errorBody = `${retryError || firstError}`;
      const truncated = errorBody.length > 500 ? errorBody.slice(0, 500) + '…（响应已截断）' : errorBody;
      void logDesktopEvent('error', 'api', `POST ${chatUrl} 失败：HTTP ${response.status}，响应体：${truncated || '（空）'}`);
      throw new Error(`llama-server 返回 ${response.status}: ${truncated}`);
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
  // 注意：decoder.decode() 会 flush 不完整的 UTF-8 序列，可能产生替换字符（U+FFFD）。
  // 这只在流异常中断且最后一块数据截断在多字节字符中间时发生，概率极低。
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
    cleanupAbortListeners();
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
    ctxUsed: promptTokens + completionTokens,
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
