import type { ExternalApiConfig, ModelInfo } from '@/types';
import type { ServerConfig } from './ipc/model';
import { filterLlamaCppServerTools } from './llamaTools';
import { resolveApiName } from './modelIdentity';

export function buildServerConfig(
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
  // llama.cpp 的 --spec-type 取值统一带 draft- 前缀（draft-dspark / draft-dflash），
  // 与内核能力校验使用的标记一致；模式键本身仍用 dspark/dflash。
  const specType = speculativeMode === 'mtp' ? 'draft-mtp'
    : speculativeMode === 'dspark' ? 'draft-dspark'
      : speculativeMode === 'dflash' ? 'draft-dflash'
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
    host: apiConfig?.enabled ? (apiConfig.host.trim() || '0.0.0.0') : '127.0.0.1',
    api_key: apiConfig?.apiKey?.trim() || null,
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
