import { invoke } from '@tauri-apps/api/core';
import type { ChatGenerationConfig, ChatMessageContentPart, ExternalApiConfig, McpTransport, ModelInfo, ModelLoadConfig, ModelTask, ReasoningProfile, SystemStats, VideoSupportLevel } from '@/types';
import { RECOMMENDED_CTX_LENGTH, recommendedGpuLayers, recommendedReasoningBudget } from '@/lib/modelDefaults';
import {
  UNKNOWN_REASONING_PROFILE,
  chatTemplateFromMetadata,
  detectReasoningProfile,
  planReasoning,
  profileSupportsThinking,
} from '@/lib/reasoningGears';
import { logInfo } from '@/lib/appLog';
import { extractVideoFrames, prepareAudioForLlama } from '@/lib/mediaAdapters';
import { filterLlamaCppServerTools } from '@/lib/llamaTools';
import { resolveApiName } from '@/lib/modelIdentity';
import { isDesktopRuntime } from '@/lib/desktopRuntime';
import {
  getActiveChatAbortController,
  getLastPingReachable,
  setActiveChatAbortController,
  setLastPingReachable,
} from '@/lib/desktopState';
import { getDesktopVideoRuntimeInfo, getExternalApiKeyForSession, logDesktopEvent } from '@/lib/ipc';
import type { DesktopModelInfo, PingResult } from '@/lib/ipc';

// ---------------------------------------------------------------------------
// 传输层再导出
//
// 纯 invoke 包装已迁到 `lib/ipc/*`，单例状态已迁到 `lib/desktopState`。
// 这里统一再导出，调用方（页面 / 组件 / hooks）继续从 '@/lib/desktop' 导入，
// 导入路径与名字保持不变。
// ---------------------------------------------------------------------------
export * from './ipc';
export { isDesktopRuntime } from './desktopRuntime';

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

export type ChatMessageContent = string | ChatMessageContentPart[];

/** OpenAI 兼容的工具调用请求（回填给模型的 tools 字段）。 */
export interface ChatToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** 模型在流式响应中请求的一次工具调用。 */
export interface ChatToolCall {
  id: string;
  name: string;
  /** 已解析的参数对象；JSON 不合法时保留原文在 rawArguments。 */
  arguments: Record<string, unknown>;
  rawArguments: string;
  /** rawArguments 是否解析成了合法的 JSON 对象；false 时调用方必须回填错误，不能拿空参数真的执行。 */
  argumentsValid: boolean;
}

export interface ChatCompletionMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: ChatMessageContent;
  /** assistant 消息里模型请求的工具调用。 */
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  /** role = tool 时必须带上，对应发起调用的 tool_call id。 */
  tool_call_id?: string;
  name?: string;
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
  /** 向量/重排专用：传 --embeddings 限定服务只提供向量用途。 */
  embedding?: boolean;
  /** --pooling 取值（none/mean/cls/last/rank）；null = 用模型默认。 */
  pooling?: string | null;
  /** 启用重排端点 --rerank。 */
  rerank?: boolean;
  /** --embd-normalize 归一化方式；null = 内核默认 2。 */
  embd_normalize?: number | null;
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
    tool_calls?: RawToolCallDelta[];
  };
  message?: {
    content?: string;
    reasoning_content?: string;
    reasoning?: string;
    thinking?: string;
    tool_calls?: RawToolCallDelta[];
  };
  text?: string;
  content?: string;
  reasoning_content?: string;
  reasoning?: string;
  thinking?: string;
  finish_reason?: string;
}

/** 服务端增量下发的工具调用分片：name 只在首片出现，arguments 逐片拼接。 */
interface RawToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
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
  /** 本轮模型请求的工具调用（已按 index 合并分片）。空数组 = 没有工具调用。 */
  toolCalls: ChatToolCall[];
}

function createAbortError(partialMetrics?: Partial<ChatCompletionMetrics>) {
  const error = new Error('已停止生成。');
  error.name = 'AbortError';
  // 中止前流式过程已经产生的部分测量值（首字延迟 / 已生成 token / 速度 / 耗时），
  // 终止统计要「有什么写什么」，不能全归零。
  if (partialMetrics) {
    (error as Error & { partialMetrics?: Partial<ChatCompletionMetrics> }).partialMetrics = partialMetrics;
  }
  return error;
}

/** 从中止 / 中断错误里取回流式过程中已产生的部分测量值；没有则返回 null。 */
export function partialMetricsFromError(error: unknown): Partial<ChatCompletionMetrics> | null {
  const partial = (error as { partialMetrics?: Partial<ChatCompletionMetrics> } | null)?.partialMetrics;
  return partial ?? null;
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
  getActiveChatAbortController()?.abort();
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

/**
 * 判定模型任务类型。优先用后端读到的 GGUF 元数据（model_task / pooling_type），
 * 旧缓存或旧后端缺字段时按文件名兜底，与后端 detect_model_task 保持同一口径。
 */
function resolveModelTask(raw: DesktopModelInfo): ModelTask {
  if (raw.model_task === 'embedding' || raw.model_task === 'rerank') {
    return raw.model_task;
  }
  if (raw.model_task === 'chat') return 'chat';
  const pooling = (raw.pooling_type ?? '').toLowerCase();
  if (pooling === 'rank') return 'rerank';
  if (pooling === 'mean' || pooling === 'cls' || pooling === 'last') return 'embedding';
  const text = `${raw.name} ${raw.architecture ?? ''}`.toLowerCase();
  if (/rerank|ranker/.test(text)) return 'rerank';
  if (/embed|bge-|gte-|e5-|jina-?v|nomic-?embed|text-embedding|mxbai-embed/.test(text)) {
    return 'embedding';
  }
  return 'chat';
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

  // 向量 / 重排模型：不带思考、工具等自回归能力徽标。
  // 但多模态嵌入模型（挂了视觉投影）**要**保留视觉/视频能力——它正是靠这个
  // 编码图片与视频向量（例如 WeMM-Embedding）。
  const task = resolveModelTask(raw);
  if (task !== 'chat') {
    return { vision, audio, video, videoSupport, thinking: false, tools: false };
  }

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
  const modelTask = resolveModelTask(raw);
  const ggufMetadata = raw.gguf_metadata?.map(([key, value]) => ({ key, value })) ?? [];
  // 思考挡位：按 GGUF 对话模板原文自动识别该模型认哪些挡位（界面「思考强度」据此翻译）。
  const reasoningProfile = modelTask === 'chat'
    ? detectReasoningProfile({
      name: raw.name,
      architecture: raw.architecture,
      tags: capabilities.thinking ? ['Reasoning'] : [],
      chatTemplate: chatTemplateFromMetadata(ggufMetadata),
      supportsReasoning: capabilities.thinking,
    })
    : UNKNOWN_REASONING_PROFILE;

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
      modelTask === 'embedding' ? '任务类型：向量嵌入（Embedding）模型，走独立向量服务，可与对话/VLM 模型同时运行。' : null,
      modelTask === 'rerank' ? '任务类型：重排（Rerank）模型，走独立向量服务，可与对话/VLM 模型同时运行。' : null,
      raw.pooling_type ? `默认池化方式（pooling）：${raw.pooling_type}` : null,
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
      modelTask === 'chat' ? `思考挡位自动识别：${reasoningProfile.summary}` : null,
    ].filter(Boolean).join('\n') || '已读取本地 GGUF 文件。详细表头信息见模型信息页。',
    tags: [
      'Local',
      'GGUF',
      ...(raw.split_count ? ['Split GGUF'] : []),
      ...(modelTask === 'embedding' ? ['Embedding'] : []),
      ...(modelTask === 'rerank' ? ['Rerank'] : []),
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
    kvHeadsSum: raw.kv_heads_sum ?? undefined,
    kvHeadsSumFull: raw.kv_heads_sum_full ?? undefined,
    kvHeadsSumSwa: raw.kv_heads_sum_swa ?? undefined,
    slidingWindow: raw.sliding_window ?? undefined,
    keyLengthSwa: raw.key_length_swa ?? undefined,
    valueLengthSwa: raw.value_length_swa ?? undefined,
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
    ggufMetadata,
    supportsVision: capabilities.vision,
    supportsAudio: capabilities.audio,
    supportsVideo: capabilities.video,
    videoSupport: capabilities.videoSupport,
    supportsThinking: capabilities.thinking,
    supportsTools: capabilities.tools,
    supportsReasoning: capabilities.thinking,
    reasoningProfile,
    supportsMtp: raw.mtp_support || Boolean(raw.mtp_draft_path),
    modelTask,
    poolingType: raw.pooling_type ?? undefined,
    supportsEmbedding: modelTask === 'embedding' || modelTask === 'rerank',
    supportsRerank: modelTask === 'rerank',
  };
}

export async function pingLocalApi() {
  if (!isDesktopRuntime()) return null;
  const result = await invoke<PingResult>('ping_local_api');
  // 只在可达状态发生变化或探测失败时记录，避免每 2 秒刷屏。
  if (result.reachable !== getLastPingReachable()) {
    setLastPingReachable(result.reachable);
    if (result.reachable) {
      void logDesktopEvent('info', 'api', `接口恢复可达：${result.baseUrl ?? ''}（/health ${result.latencyMs ?? 0} ms）`);
    } else {
      void logDesktopEvent('warn', 'api', `接口不可达：${result.error ?? '未知原因'}`);
    }
  }
  return result;
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
    embedding: false,
    pooling: null,
    rerank: false,
    embd_normalize: null,
    device: cpuOnly ? 'none' : null,
    main_gpu: cpuOnly ? null : 0,
    retry_cpu_fallback: !cpuOnly,
    no_cuda: cpuOnly,
  };
}

/// 向量/重排模型的独立服务配置：只保留与显存/上下文相关的通用参数，
/// 追加 --embeddings / --pooling / --rerank / --embd-normalize。
/// 与对话配置分开构造，避免把 KV 量化、投机解码、工具模板等无关参数带过去。
///
/// mmproj 例外：多模态嵌入模型（如 WeMM）**必须**挂上视觉投影才能编码图片与视频，
/// 因此这里与对话侧一样传入 mmproj_path。
function buildEmbeddingServerConfig(
  model: ModelInfo,
  port: number,
  executablePath: string,
  apiConfig?: ExternalApiConfig,
  pooling?: string,
  embdNormalize?: number,
): ServerConfig {
  if (!model.filePath) {
    throw new Error('这个模型没有本地 GGUF 文件路径，不能启动向量服务。');
  }
  const config = model.loadConfig;
  const gpuLayers = Math.max(0, config.gpuLayers);
  const cpuOnly = gpuLayers === 0;
  const resolvedPooling = (pooling ?? model.poolingType ?? '').trim().toLowerCase();
  const isRerank = model.supportsRerank === true || resolvedPooling === 'rank';
  // 多模态嵌入：挂 mmproj 才能编码图片/视频。重排模型不需要投影。
  const hasMultimodalProjector = !isRerank && Boolean(model.mmprojPath)
    && Boolean(model.mmprojSupportsVision || model.mmprojSupportsAudio);
  return {
    executable_path: executablePath || 'resources/llama-server.exe',
    model_path: model.filePath ?? '',
    model_alias: resolveApiName(model),
    port,
    host: apiHost(apiConfig),
    api_key: apiKey(apiConfig),
    ngl: gpuLayers,
    // 向量模型不需要长上下文；沿用模型/用户配置的 ctx，但至少给到 512 保证可运行。
    n_ctx: Math.max(512, config.ctxLength),
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
    rope_freq_base: null,
    rope_freq_scale: null,
    seed: null,
    chat_template: null,
    mmproj_path: hasMultimodalProjector ? (model.mmprojPath ?? null) : null,
    mtp_draft_path: null,
    dspark_draft_path: null,
    dflash_draft_path: null,
    spec_draft_n_max: null,
    spec_type: null,
    ncmoe: 0,
    tools: null,
    reasoning_budget: 0,
    embedding: true,
    pooling: resolvedPooling && resolvedPooling !== 'unspecified' ? resolvedPooling : null,
    rerank: isRerank,
    embd_normalize: embdNormalize ?? null,
    device: cpuOnly ? 'none' : null,
    main_gpu: cpuOnly ? null : 0,
    retry_cpu_fallback: false,
    no_cuda: cpuOnly,
  };
}

/// 启动向量/重排模型服务（独立端口、独立进程）。可与对话/VLM 服务同时运行。
export async function startEmbeddingServer(
  model: ModelInfo,
  port: number,
  executablePath = 'resources/llama-server.exe',
  apiConfig?: ExternalApiConfig,
  pooling?: string,
  embdNormalize?: number,
) {
  if (!isDesktopRuntime()) return;
  // 对外开放时同样要求鉴权，与对话服务一致。
  let storedApiKey: string | null = null;
  if (apiConfig?.enabled) {
    storedApiKey = await getExternalApiKeyForSession().catch(() => null);
    if (apiConfig.hasApiKey && !storedApiKey) {
      throw new Error('无法读取已配置的 API Key，已阻止在无鉴权状态下开放向量接口。请重新申请 API Key。');
    }
  }
  const runtimeApiConfig = apiConfig
    ? { ...apiConfig, apiKey: storedApiKey ?? undefined }
    : undefined;
  await invoke('start_embedding_server', {
    config: buildEmbeddingServerConfig(model, port, executablePath, runtimeApiConfig, pooling, embdNormalize),
  });
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
  /** /props 的 chat_template_caps：当前模板是否认识 reasoning_effort（undefined = 服务端未报告）。 */
  supportsReasoningEffort?: boolean;
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
    // 工具回填轮次必须保留 assistant.tool_calls 与 tool.tool_call_id；
    // 只清洗多模态 content 会丢掉这两组协议字段，fast-27b/llama-server
    // 会因此无法把 MCP 执行结果接回同一次对话。
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.name ? { name: message.name } : {}),
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

/**
 * 读取 /props 的 chat_template_caps 里「模板是否认识 reasoning_effort」这一项。
 * 键名由服务端版本决定，这里按包含关系匹配，读不到就返回 undefined（表示服务端未报告）。
 */
function readSupportsReasoningEffort(caps: unknown): boolean | undefined {
  if (!caps || typeof caps !== 'object') return undefined;
  const entries = Object.entries(caps as Record<string, unknown>);
  const hit = entries.find(([key]) => key.toLowerCase().replace(/-/g, '_').includes('reasoning_effort'));
  return hit ? Boolean(hit[1]) : undefined;
}

/**
 * 就地向运行中的服务端复核一次模板能力（不抛错：读不到一律返回 undefined）。
 * 界面打开「思考强度」菜单时用它确认自动识别的挡位，服务端说模板不支持
 * reasoning_effort 时就退回思考预算展示。
 */
export async function fetchServerReasoningEffortCap(port: number, apiKey?: string): Promise<boolean | undefined> {
  try {
    const headers: Record<string, string> = {};
    if (apiKey?.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;
    const response = await fetch(`http://127.0.0.1:${port}/props`, { headers });
    if (!response.ok) return undefined;
    const json = await response.json() as { chat_template_caps?: unknown } | null;
    return readSupportsReasoningEffort(json?.chat_template_caps);
  } catch {
    return undefined;
  }
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
    const supportsReasoningEffort = readSupportsReasoningEffort(json?.chat_template_caps);
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
      supportsReasoningEffort,
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
  /** 模型的思考挡位档案（按对话模板自动识别）；不传表示未识别，只按预算请求。 */
  reasoningProfile?: ReasoningProfile;
  videoSupport?: VideoSupportLevel;
  apiKey?: string;
  signal?: AbortSignal;
  /** 工具清单（llama.cpp 原生工具由服务端 --tools 提供；这里传 MCP 工具）。 */
  tools?: ChatToolSpec[];
  /** 工具调用结果回填后，是否强制模型继续生成（tool_choice = auto 为默认）。 */
  onToken: (token: string) => void;
  onReasoningDelta?: (reasoningContent: string) => void;
  onUsage?: (usage: { promptTokens: number; completionTokens: number; totalTokens: number; tokensPerSec?: number; firstTokenDelay?: number; genTime?: number }) => void;
}): Promise<ChatCompletionMetrics> {
  const requestStartedAt = performance.now();
  let firstTokenAt: number | null = null;
  let latestUsage: Partial<ChatCompletionMetrics> = {};
  let reasoningContent = '';
  let latestToolCalls: ChatToolCall[] = [];
  const localAbortController = new AbortController();
  const { signal: abortSignal, cleanup: cleanupAbortListeners } = mergeAbortSignals(localAbortController.signal, options.signal);
  setActiveChatAbortController(localAbortController);
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
  const reasoningProfile = options.reasoningProfile ?? UNKNOWN_REASONING_PROFILE;
  let reasoningPlan = planReasoning(reasoningMode, reasoningProfile, reasoningBudget, options.supportsReasoning);

  // 运行中的服务端对模板能力有最终发言权：/props 报告模板不认识 reasoning_effort 时，
  // 静态识别出的挡位一律不下发，退回思考预算（避免把无效参数当成已生效的挡位）。
  if (reasoningPlan.effort && serverModalities.supportsReasoningEffort === false) {
    logInfo(
      'chat',
      `服务端报告当前对话模板不支持 reasoning_effort，「${reasoningPlan.gearLabel}」退回思考预算 ${reasoningPlan.budgetTokens}。`,
    );
    reasoningPlan = {
      ...reasoningPlan,
      effort: undefined,
      gearLabel: reasoningPlan.budgetTokens > 0 ? `预算 ${reasoningPlan.budgetTokens}` : reasoningPlan.gearLabel,
      requestLabel: `思考预算 ${reasoningPlan.budgetTokens}`,
    };
  }

  const effectiveReasoningBudget = reasoningPlan.budgetTokens;
  const supportsReasoning = reasoningMode !== 'off'
    && effectiveReasoningBudget > 0
    && (
      reasoningMode === 'think'
      || reasoningMode === 'deep'
      || profileSupportsThinking(reasoningProfile, options.supportsReasoning)
    );

  const chatUrl = `http://127.0.0.1:${options.port}/v1/chat/completions`;
  const serverModelId = await getServerModelId(options.port, headers, abortSignal);
  throwIfAborted(abortSignal);
  const requestModelName = serverModelId ?? options.modelName;
  const maxCompletionTokens = Math.max(0, Math.round(Number(options.config.maxTokens ?? 0)));
  /**
   * chat_template_kwargs 只带模型对话模板真正认识的变量：
   * enable_thinking（能否关闭/开启思考）与 reasoning_effort（有没有离散挡位）。
   * 模板不认的变量不发，避免把无效参数当成「挡位已生效」。
   */
  const reasoningTemplateKwargs = (() => {
    const kwargs: Record<string, unknown> = {};
    if (reasoningPlan.enableThinking !== undefined) kwargs.enable_thinking = reasoningPlan.enableThinking;
    if (reasoningPlan.effort) kwargs.reasoning_effort = reasoningPlan.effort;
    return Object.keys(kwargs).length > 0 ? kwargs : undefined;
  })();
  const requestBody = {
    model: requestModelName,
    messages,
    stream: true,
    temperature: options.config.temperature,
    top_p: options.config.topP,
    repeat_penalty: options.config.repeatPenalty,
    ...(options.tools && options.tools.length > 0 ? {
      tools: options.tools,
      tool_choice: 'auto',
    } : {}),
    ...(maxCompletionTokens > 0 ? {
      max_tokens: maxCompletionTokens,
      n_predict: maxCompletionTokens,
    } : {}),
    ...(reasoningPlan.enableThinking === false ? {
      reasoning_budget: 0,
      thinking_budget_tokens: 0,
      ...(reasoningTemplateKwargs ? { chat_template_kwargs: reasoningTemplateKwargs } : {}),
    } : {}),
    ...(supportsReasoning ? {
      reasoning_budget: effectiveReasoningBudget,
      reasoning_format: 'deepseek',
      thinking_budget_tokens: effectiveReasoningBudget,
      // 挡位同时走两个通道：native 字段（llama-server 会把它绑定进模板上下文）
      // 与 chat_template_kwargs（模板自定义路径 / 老内核只认后者）。
      ...(reasoningPlan.effort ? { reasoning_effort: reasoningPlan.effort } : {}),
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
    // 非流式响应的工具调用与流式路径同一套归并逻辑，不能漏。
    const toolDeltas = toolCallsFromChoice(choice);
    if (toolDeltas && toolDeltas.length > 0) {
      firstTokenAt ??= performance.now();
      latestToolCalls = mergeToolCallDeltas(latestToolCalls, toolDeltas);
    }
    latestUsage = collectCompletionMetrics(latestUsage, json);
    latestUsage.toolCalls = latestToolCalls;
    return finalizeCompletionMetrics(latestUsage, requestStartedAt, firstTokenAt, options.ctxTotal, options.onUsage);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let rawBody = '';
  // 流式 delta 计数：llama.cpp 每个内容 / 思考 delta ≈ 1 个 token，
  // 是服务端 usage 缺失（被中止时拿不到最终 usage）时的真实产量口径。
  let streamedTokenCount = 0;
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
      streamedTokenCount += 1;
      reasoningContent += reasoningToken;
      options.onReasoningDelta?.(reasoningContent);
      receivedContent = true;
    }

    const token = extractContentFromChoice(choice);
    if (token) {
      firstTokenAt ??= performance.now();
      streamedTokenCount += 1;
      options.onToken(token);
      receivedContent = true;
    }

    // 工具调用分片：不产生可显示文本，但同样算「收到了有效响应」。
    const toolDeltas = toolCallsFromChoice(choice);
    if (toolDeltas && toolDeltas.length > 0) {
      firstTokenAt ??= performance.now();
      latestToolCalls = mergeToolCallDeltas(latestToolCalls, toolDeltas);
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

  // 中止 / 流中断时已经产生的部分测量值：首字延迟、已生成 token 数、速度、耗时。
  // 终止统计要「有什么写什么」，不能全归零。
  const buildPartialMetrics = () => {
    const firstTokenDelay = firstTokenAt ? Math.max(0, (firstTokenAt - requestStartedAt) / 1000) : 0;
    const genTime = Math.max(0, (performance.now() - requestStartedAt) / 1000);
    const completionTokens = Math.max(0, Math.round(Number(latestUsage.completionTokens) || streamedTokenCount));
    const tokensPerSec = completionTokens > 0 && genTime > firstTokenDelay
      ? completionTokens / Math.max(0.001, genTime - firstTokenDelay)
      : 0;
    return { completionTokens, firstTokenDelay, tokensPerSec, genTime };
  };
  const throwAbortWithMetrics = (): void => {
    if (!abortSignal.aborted) return;
    throw createAbortError(buildPartialMetrics());
  };

  try {
    while (true) {
      throwAbortWithMetrics();
      const { value, done } = await reader.read();
      throwAbortWithMetrics();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      rawBody += chunk;
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        throwAbortWithMetrics();
        processStreamLine(line);
      }
    }

    throwAbortWithMetrics();
    // 注意：decoder.decode() 会 flush 不完整的 UTF-8 序列，可能产生替换字符（U+FFFD）。
    // 这只在流异常中断且最后一块数据截断在多字节字符中间时发生，概率极低。
    const tail = `${buffer}${decoder.decode()}`.trim();
    if (tail) {
      for (const line of tail.split('\n')) {
        throwAbortWithMetrics();
        processStreamLine(line);
      }
    }
  } catch (err) {
    if (abortSignal.aborted || (err as Error)?.name === 'AbortError') {
      throw createAbortError(buildPartialMetrics());
    }
    // 流中途断开（网络错误等）：同样带上已产生的部分测量值再抛出。
    (err as Error & { partialMetrics?: Partial<ChatCompletionMetrics> }).partialMetrics = buildPartialMetrics();
    throw err;
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

  latestUsage.toolCalls = latestToolCalls;
  return finalizeCompletionMetrics(latestUsage, requestStartedAt, firstTokenAt, options.ctxTotal, options.onUsage);
  } finally {
    cleanupAbortListeners();
    if (getActiveChatAbortController() === localAbortController) {
      setActiveChatAbortController(null);
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
    toolCalls: latestUsage.toolCalls ?? [],
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

/**
 * 合并服务端增量下发的工具调用分片。
 * 首片带 id 与函数名，后续分片只补 arguments 字符串，按 index 归并。
 */
function mergeToolCallDeltas(
  current: ChatToolCall[],
  deltas: RawToolCallDelta[] | undefined,
): ChatToolCall[] {
  if (!deltas || deltas.length === 0) return current;
  const next = current.map((call) => ({ ...call, arguments: { ...call.arguments } }));
  deltas.forEach((delta, position) => {
    const index = typeof delta.index === 'number' ? delta.index : position;
    while (next.length <= index) {
      next.push({ id: '', name: '', arguments: {}, rawArguments: '', argumentsValid: true });
    }
    const target = next[index];
    if (delta.id) target.id = delta.id;
    if (delta.function?.name) target.name = delta.function.name;
    if (delta.function?.arguments) target.rawArguments += delta.function.arguments;
  });
  // 每次归并都对完整 rawArguments 重新解析：流式分片过程中前缀必然不是合法 JSON，
  // 只有收完最后一片才能定论；最终 argumentsValid=false 的调用不许真的执行。
  return next.map((call) => {
    if (!call.rawArguments.trim()) return { ...call, argumentsValid: true };
    try {
      const parsed = JSON.parse(call.rawArguments);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ...call, arguments: parsed, argumentsValid: true };
      }
      return { ...call, argumentsValid: false };
    } catch {
      return { ...call, argumentsValid: false };
    }
  });
}

function toolCallsFromChoice(choice: ChatCompletionChoice | undefined): RawToolCallDelta[] | undefined {
  return choice?.delta?.tool_calls ?? choice?.message?.tool_calls;
}

/** 传输方式的中文标签（界面展示用）。 */
export function mcpTransportLabel(transport?: McpTransport): string {
  if (transport === 'http') return 'Streamable HTTP';
  if (transport === 'sse') return 'HTTP + SSE';
  return 'stdio（本机进程）';
}

/** 该传输是否走网络（决定界面显示 URL 还是命令，以及是否提示数据外发）。 */
export function mcpTransportIsNetwork(transport?: McpTransport): boolean {
  return transport === 'http' || transport === 'sse';
}

/**
 * 前端预校验 MCP 端点：仅 http/https，且拒绝本机与内网地址。
 * 与后端 mcp_endpoint 同一口径，用于在保存前给出即时提示（后端仍会再校验一次）。
 */
export function validateMcpEndpoint(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return '请填写 MCP 端点地址。';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return 'MCP 端点地址无法解析，请填写完整地址（含 https://）。';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `只支持 http / https 地址，当前是 ${parsed.protocol}`;
  }
  if (parsed.username || parsed.password) {
    return '地址里不要带用户名或密码，需要鉴权请改用请求头。';
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return '出于安全考虑，不允许把 MCP 端点指向本机（localhost）。';
  }
  // IPv4 / IPv6 字面量：拒绝回环、私有与保留网段。
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number);
    const blocked = a === 127 || a === 10 || a === 0
      || (a === 192 && b === 168)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 169 && b === 254)
      || (a === 100 && b >= 64 && b <= 127);
    if (blocked) {
      return `出于安全考虑，不允许把 MCP 端点指向本机或内网地址（${host}）。`;
    }
  }
  if (host.includes(':')) {
    const lower = host.toLowerCase();
    if (lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe8')) {
      return `出于安全考虑，不允许把 MCP 端点指向本机或内网地址（${host}）。`;
    }
  }
  return null;
}
