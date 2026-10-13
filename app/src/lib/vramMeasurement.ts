import type { ModelInfo, ModelLoadConfig } from '@/types';
import type { ModelVramMeasurement } from '@/lib/ipc/model';
import { maxGpuLayers } from './modelDefaults';

export interface VramSnapshot {
  gpu_name: string;
  gpu_total_gb: number;
  used_gb: number;
}

export interface VramSampleSummary extends VramSnapshot {
  spread_gb: number;
}

export interface VramMeasurementInput {
  model: ModelInfo;
  config: ModelLoadConfig;
  baseline: VramSampleSummary | null;
  loaded: VramSampleSummary | null;
  buffers: ModelVramMeasurement['buffers'];
}

export interface VramMeasurementAssessment {
  quality: ModelVramMeasurement['quality'];
  actualGb: number | null;
  note?: string;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const numeric = (value: unknown) => finite(value) ? value : null;
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const capacityTolerance = (total: number) => Math.max(0.01, total * 0.001);
const sampleTolerance = (used: number) => Math.max(0.1, used * 0.01);

/** 布局签名优先作锚点，联合 KV/SSM 与侧车；用户路径仅参与哈希。 */
export function modelVramSignature(model: ModelInfo): string {
  const signature = model.memoryLayout?.signature?.trim();
  const memoryMetadata = (model.ggufMetadata ?? [])
    .filter((entry) => /\.(?:ssm|recurrent)\.|(?:full_attention_interval|sliding_window|swa_layer_pattern|(?:key|value)_length(?:_swa)?|head_count(?:_kv)?)$/.test(entry.key))
    .map(({ key, value }) => [key, value])
    .sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
  const fingerprint = JSON.stringify([
    signature || [numeric(model.fileSizeBytes), numeric(model.splitCount), numeric(model.splitTotalSizeGb), model.modelType, model.quant],
    model.architecture ?? model.ggufMetadata?.find((entry) => entry.key === 'general.architecture')?.value ?? null,
    numeric(model.blockCount), numeric(model.expertCount),
    numeric(model.embeddingLength), numeric(model.headCount), numeric(model.headCountKv),
    model.kvHeadsByLayer?.map(numeric) ?? null, numeric(model.kvHeadsSum),
    model.swaLayerPattern ?? null, numeric(model.fullAttentionInterval),
    numeric(model.kvHeadsSumFull), numeric(model.kvHeadsSumSwa), numeric(model.slidingWindow),
    numeric(model.keyLength), numeric(model.valueLength), numeric(model.keyLengthSwa), numeric(model.valueLengthSwa),
    model.mmprojPath?.trim() || null, model.mtpDraftPath?.trim() || null,
    model.dsparkDraftPath?.trim() || null, model.dflashDraftPath?.trim() || null,
    Boolean(model.hasEmbeddedMtp), numeric(model.nextnPredictLayers), memoryMetadata,
  ]);
  // FNV-1a：同步、跨运行稳定，无浏览器/Node 依赖，也不暴露用户路径。
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < fingerprint.length; index += 1) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(fingerprint.charCodeAt(index))) * 0x100000001b3n);
  }
  return `${signature ? 'layout' : 'metadata'}-v1:${hash.toString(16).padStart(16, '0')}`;
}

/** 保存显式配置，不取整、不夹紧；K/V 使能分别决定实际缓存类型。 */
export function vramMeasurementConfig(config: ModelLoadConfig): ModelVramMeasurement['config'] {
  return {
    gpu_layers: config.gpuLayers,
    ctx_length: config.ctxLength,
    batch_size: config.batchSize,
    ubatch_size: config.physicalBatchSize,
    parallel: config.parallel,
    flash_attn: config.fastAttention,
    kv_offload: config.kvCache,
    kv_unified: config.kvUnified,
    cache_type_k: config.cacheTypeKEnabled ? config.cacheTypeK : 'f16',
    cache_type_v: config.cacheTypeVEnabled ? config.cacheTypeV : 'f16',
    moe_cpu_layers: config.moeCpuLayers,
    speculative: config.speculativeDecoding,
    no_warmup: config.noWarmup,
    draft_tokens: config.speculativeDecoding !== 'off' && config.specDraftNMaxEnabled
      ? Math.min(16, Math.max(1, Math.round(Number(config.specDraftNMax) || 1))) : null,
  };
}

function validSnapshot(sample: VramSnapshot | null | undefined): sample is VramSnapshot {
  return Boolean(sample && typeof sample.gpu_name === 'string' && sample.gpu_name.trim()
    && finite(sample.gpu_total_gb) && sample.gpu_total_gb > 0
    && finite(sample.used_gb) && sample.used_gb >= 0);
}

/** 缺测不补零；混入另一张卡或容量发生变化时，不能组成一个采样窗口。 */
export function summarizeVramSamples(samples: VramSnapshot[]): VramSampleSummary | null {
  const valid = samples.filter(validSnapshot);
  if (valid.length < 3) return null;
  const gpuName = valid[0].gpu_name.trim();
  const total = median(valid.map((sample) => sample.gpu_total_gb));
  if (valid.some((sample) => sample.gpu_name.trim() !== gpuName
    || Math.abs(sample.gpu_total_gb - total) > capacityTolerance(total))) return null;
  const used = valid.map((sample) => sample.used_gb);
  return {
    gpu_name: gpuName,
    gpu_total_gb: total,
    used_gb: median(used),
    spread_gb: Math.max(...used) - Math.min(...used),
  };
}

type BufferKind = 'model' | 'kv' | 'recurrent' | 'compute';
interface BufferSet {
  gpu: Map<BufferKind, number>;
  cpu: Set<BufferKind>;
  backends: Set<string>;
  context: number | null;
  parallel: number | null;
  serverParallel: number | null;
  gpuLayers: number | null;
  ambiguous: boolean;
}
const bufferSet = (): BufferSet => ({
  gpu: new Map(), cpu: new Set(), backends: new Set(), context: null,
  parallel: null, serverParallel: null, gpuLayers: null, ambiguous: false,
});
const ansiEscape = new RegExp(String.fromCharCode(27) + '\\[[0-?]*[ -/]*[@-~]', 'g');
const hasBuffers = (set: BufferSet) => set.gpu.size > 0 || set.cpu.size > 0;
const backendName = (name: string) => ({ cuda: 'CUDA', vulkan: 'Vulkan', rocm: 'ROCm', hip: 'HIP' })[name.toLowerCase()];

/**
 * 与单卡采样口径一致，只解析 GPU0。每次 fit 重试重新开始，重复行覆盖而非累加。
 * 无法分清归属的多模型/多上下文分项保留未知；CPU、锁页内存和总 GPU 摘要不算分项。
 */
export function parseVramBuffers(logs: string[]): ModelVramMeasurement['buffers'] {
  let models = [bufferSet()];
  let contexts = [bufferSet()];
  let model = models[0];
  let context = contexts[0];
  let projector = false;
  let multiGpu = false;
  for (const raw of logs) {
    for (const line of raw.replace(ansiEscape, '').split(/\r?\n/)) {
      if (/\bfitting params\b|\bllama_params_fit(?:_impl)?\b.*\b(?:trying|retrying|attempt)\b|\bretrying\b|\btrying again\b|\bCPU fallback\b/i.test(line)) {
        models = [bufferSet()];
        contexts = [bufferSet()];
        model = models[0];
        context = contexts[0];
        projector = false;
        multiGpu = false;
      }
      if (/\b(?:CUDA|Vulkan|ROCm|Hip)[1-9]\d*\b/i.test(line)) multiGpu = true;
      const isProjector = /\b(?:clip_model_load\w*|mtmd\w*|mmproj)\b/i.test(line);
      if (/\b(?:loading (?:main |draft |a )?model|loaded meta data)\b/i.test(line)
        || (isProjector && /\bmodel buffer size\b/i.test(line) && !projector)) {
        if (hasBuffers(model) || model.gpuLayers !== null) {
          model = bufferSet();
          models.push(model);
        }
        projector = isProjector;
      }
      const offloaded = /\boffloaded\s+(\d+)\s*\/\s*\d+\s+layers\b/i.exec(line);
      if (offloaded) {
        const layers = Number(offloaded[1]);
        // 没有 fit/模型边界却出现不同卸载数，旧缓冲不能冒充最终分配。
        if (model.gpuLayers !== null && model.gpuLayers !== layers && hasBuffers(model)) {
          model = bufferSet();
          models.push(model);
        }
        model.gpuLayers = layers;
      }
      const ctx = /\b(?:llama_context|llama_new_context_with_model)\s*:\s*n_ctx\s*=\s*(\d+)\b/i.exec(line);
      if (/\bllama_context\s*:\s*constructing\b/i.test(line) || (ctx && hasBuffers(context))) {
        if (hasBuffers(context) || context.context !== null || context.parallel !== null) {
          context = bufferSet();
          contexts.push(context);
        }
      }
      if (ctx) context.context = Number(ctx[1]);
      const seqMax = /\bllama_context\s*:\s*n_seq_max\s*=\s*(\d+)\b(?!\.)/i.exec(line);
      const serverParallel = /\bsrv\b.*?\bn_parallel\s*=\s*(\d+)\b(?!\.)/i.exec(line);
      if (seqMax || serverParallel) {
        const slots = Number((seqMax ?? serverParallel)![1]);
        const effective = Number.isSafeInteger(slots) && slots > 0 ? slots : null;
        if (seqMax) context.parallel = effective;
        else context.serverParallel = effective;
      }
      const buffer = /\b(\w+)\s+(model|KV|recurrent|compute)\s+buffer size\s*=\s*(\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s+MiB\b/i.exec(line);
      if (!buffer) continue;
      const kind = buffer[2].toLowerCase() as BufferKind;
      const size = Number(buffer[3]) / 1024;
      if (!finite(size) || size < 0) continue;
      const set = kind === 'model' ? model : context;
      const device = /^(CUDA|Vulkan|ROCm|Hip)(\d+)$/i.exec(buffer[1]);
      if (device && Number(device[2]) === 0) {
        const backend = backendName(device[1])!;
        if (set.backends.size && !set.backends.has(backend)) set.ambiguous = true;
        if (kind === 'model' && set.gpu.has(kind) && set.gpu.get(kind) !== size) set.ambiguous = true;
        set.backends.add(backend);
        set.gpu.set(kind, size);
      } else if (/^(?:CPU(?:\d+|_Mapped|_Host)?|(?:CUDA|Vulkan|ROCm|Hip)_Host)$/i.test(buffer[1])) {
        set.cpu.add(kind);
      }
    }
  }
  const loadedModels = models.filter((set) => hasBuffers(set) || set.gpuLayers !== null);
  const loadedContexts = contexts.filter((set) => hasBuffers(set) || set.context !== null
    || set.parallel !== null || set.serverParallel !== null);
  const singleModel = loadedModels.length === 1 ? loadedModels[0] : null;
  const singleContext = loadedContexts.length === 1 ? loadedContexts[0] : null;
  const backends = new Set([...loadedModels, ...loadedContexts].flatMap((set) => [...set.backends]));
  const weights = singleModel && !singleModel.ambiguous
    ? singleModel.gpu.get('model') ?? (singleModel.gpuLayers === 0 ? 0 : null) : null;
  let kv: number | null = null;
  let compute: number | null = null;
  if (singleContext && !singleContext.ambiguous) {
    const gpuKv = singleContext.gpu.get('kv');
    const recurrent = singleContext.gpu.get('recurrent');
    if (gpuKv !== undefined || recurrent !== undefined) kv = (gpuKv ?? 0) + (recurrent ?? 0);
    else if (singleContext.cpu.has('kv') || singleContext.cpu.has('recurrent')) kv = 0;
    compute = singleContext.gpu.get('compute')
      ?? (singleModel?.gpuLayers === 0 && singleContext.cpu.has('compute') ? 0 : null);
  }
  return {
    weights_gb: weights,
    kv_gb: kv,
    compute_gb: compute,
    context: singleContext?.context ?? null,
    parallel: singleContext?.parallel ?? singleContext?.serverParallel ?? null,
    gpu_layers: singleModel?.gpuLayers ?? null,
    backend: !multiGpu && backends.size === 1 ? [...backends][0] : null,
  };
}

/** 只依据采样和日志核实，不用文件体积推断低显存测量是否可信。 */
export function assessVramMeasurement({ model, config, baseline, loaded, buffers }: VramMeasurementInput): VramMeasurementAssessment {
  if (!validSnapshot(baseline) || !validSnapshot(loaded)
    || !finite(baseline.spread_gb) || baseline.spread_gb < 0
    || !finite(loaded.spread_gb) || loaded.spread_gb < 0) {
    return { quality: 'unverified', actualGb: null, note: '缺少有效的加载前后显存采样，尚未核实实测增量。' };
  }
  const contaminated = (note: string): VramMeasurementAssessment => ({ quality: 'contaminated', actualGb: null, note });
  const total = Math.min(baseline.gpu_total_gb, loaded.gpu_total_gb);
  if (baseline.gpu_name.trim() !== loaded.gpu_name.trim()
    || Math.abs(baseline.gpu_total_gb - loaded.gpu_total_gb) > capacityTolerance(total)) {
    return contaminated('加载前后 GPU 或显存容量发生变化，无法比较实测增量。');
  }
  if (baseline.spread_gb > sampleTolerance(baseline.used_gb) + 1e-9
    || loaded.spread_gb > sampleTolerance(loaded.used_gb) + 1e-9) {
    return contaminated('采样窗口内显存出现明显漂移，可能混入其他进程的分配或释放。');
  }
  const actualGb = loaded.used_gb - baseline.used_gb;
  if (actualGb < 0) return contaminated('加载后显存低于基线，可能存在旧实例释放或后台占用变化。');
  if (actualGb > total || baseline.used_gb > baseline.gpu_total_gb || loaded.used_gb > loaded.gpu_total_gb) {
    return contaminated('实测显存超过 GPU 容量，采样口径无法核实。');
  }
  const observed = [buffers.weights_gb, buffers.kv_gb, buffers.compute_gb]
    .filter((value): value is number => finite(value) && value >= 0);
  const lowerBound = observed.reduce((sum, value) => sum + value, 0);
  if (actualGb + Math.max(0.1, lowerBound * 0.02) < lowerBound) {
    return contaminated('实测增量小于日志中已分配的 GPU 缓冲，基线可能包含旧模型或采样尚未完成。');
  }
  const adapted: string[] = [];
  const effectiveParallel = config.parallel > 0 ? config.parallel : buffers.parallel;
  const paddedContext = Math.ceil(config.ctxLength / 256) * 256;
  const expectedContext = config.kvUnified ? paddedContext
    : finite(effectiveParallel) && effectiveParallel > 0
      ? effectiveParallel * Math.ceil(Math.floor(paddedContext / effectiveParallel) / 256) * 256
      : null;
  if (finite(buffers.context) && buffers.context > 0 && expectedContext != null && buffers.context !== expectedContext) {
    adapted.push(`上下文长度由 ${config.ctxLength} 变为 ${buffers.context}`);
  }
  if (config.parallel > 0 && finite(buffers.parallel) && buffers.parallel !== config.parallel) {
    adapted.push(`并发槽数由 ${config.parallel} 变为 ${buffers.parallel}`);
  }
  const fullLayers = maxGpuLayers(model.blockCount);
  const expectedLayers = fullLayers === 999 && (config.gpuLayers >= 999 || config.gpuLayers < 0)
    ? null : config.gpuLayers < 0 ? fullLayers : Math.min(config.gpuLayers, fullLayers);
  if (finite(buffers.gpu_layers) && finite(expectedLayers) && buffers.gpu_layers !== expectedLayers) {
    adapted.push(`GPU 卸载层数由 ${expectedLayers} 变为 ${buffers.gpu_layers}`);
  }
  if (adapted.length) {
    return { quality: 'adapted', actualGb, note: `${adapted.join('；')}，实际有效参数已适配，不用于原参数权重校准。` };
  }
  if (config.gpuLayers !== 0 && (!finite(buffers.context) || buffers.context <= 0
    || !finite(buffers.gpu_layers) || buffers.gpu_layers < 0
    || !['CUDA', 'Vulkan', 'ROCm', 'HIP'].includes(buffers.backend ?? '')
    || !finite(buffers.weights_gb) || buffers.weights_gb < 0
    || (config.parallel <= 0 && !(finite(buffers.parallel) && buffers.parallel > 0)))) {
    return { quality: 'unverified', actualGb: null, note: '日志缺少明确的上下文、GPU 卸载层数、单卡后端、权重缓冲或自动槽数，不能核实当前 GPU 加载。' };
  }
  return { quality: 'stable', actualGb };
}
