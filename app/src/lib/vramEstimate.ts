import type { ModelInfo, ModelLoadConfig } from '@/types';

export interface VramPrediction {
  totalGb: number;
  weightsGpuGb: number;
  weightsCpuGb: number;
  kvGb: number | null;
  computeGb: number;
  runtimeGb: number;
  safetyGb: number;
  offloadRatio: number;
  expertGpuRatio: number;
  missing: string[];
  analyticalGb: number;
  empiricalGb: number;
  rawWeightsGpuGb: number;
  rawKvGb: number | null;
  rawComputeGb: number;
  rawRuntimeGb: number;
  weightSource: 'tensor' | 'tensor_upper_bound' | 'file';
}

export interface VramEstimateOptions {
  kernelVersion?: string | null;
  effectiveParallel?: number | null;
}

export interface VramCalibrationInput {
  weightsRatio?: number;
  kvRatio?: number;
  computeRatio?: number;
  runtimeOffsetGb?: number;
  uncertaintyGb?: number;
  scratchRatio?: number;
  overallRatio?: number;
}

export const SCRATCH_RATIO_MIN = 0.4;
export const SCRATCH_RATIO_MAX = 2.5;
export const OVERALL_RATIO_MIN = 0.5;
export const OVERALL_RATIO_MAX = 1.3;
export const clampScratchRatio = (ratio: number) => clamp(ratio, SCRATCH_RATIO_MIN, SCRATCH_RATIO_MAX);
export const clampOverallRatio = (ratio: number) => clamp(ratio, OVERALL_RATIO_MIN, OVERALL_RATIO_MAX);

export function cacheBytesPerValue(cacheType: string) {
  switch (cacheType.toLowerCase()) {
    case 'f32': return 4;
    case 'q8_0': return 34 / 32;
    case 'q5_0': return 22 / 32;
    case 'q5_1': return 24 / 32;
    case 'q4_0': case 'iq4_nl': return 18 / 32;
    case 'q4_1': return 20 / 32;
    default: return 2;
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function metadataNumber(model: ModelInfo, suffix: string) {
  const value = model.ggufMetadata?.find((entry) => entry.key === `${model.architecture}.${suffix}`)?.value;
  const number = Number(value);
  return value != null && Number.isFinite(number) && number > 0 ? number : null;
}

function validVector(values: number[] | undefined, count: number) {
  return values?.length === count && values.every((value) => Number.isFinite(value) && value >= 0);
}

function kvHeadsByLayer(model: ModelInfo, count: number): number[] | null {
  if (validVector(model.kvHeadsByLayer, count)) return model.kvHeadsByLayer!;
  const heads = model.headCountKv ?? model.headCount;
  if (model.kvHeadsSum != null) {
    // 旧缓存只保留数组求和，部分卸载时只能按层比例近似，刷新后使用完整向量。
    return Array(count).fill(model.kvHeadsSum / Math.max(1, count));
  }
  if (heads == null || heads < 0) return null;
  const interval = model.fullAttentionInterval ?? metadataNumber(model, 'attention.full_attention_interval') ?? metadataNumber(model, 'full_attention_interval');
  if (['qwen35', 'qwen35moe', 'qwen3next'].includes(model.architecture ?? '') && interval && interval >= 1) {
    return Array.from({ length: count }, (_, index) => index >= count - (model.nextnPredictLayers ?? 0)
      || (index + 1) % interval === 0 ? heads : 0);
  }
  return Array(count).fill(heads);
}

function rowBytes(width: number, cacheType: string) {
  const quantized = !['f16', 'bf16', 'f32'].includes(cacheType.toLowerCase());
  const paddedWidth = quantized ? Math.ceil(width / 32) * 32 : width;
  return paddedWidth * cacheBytesPerValue(cacheType);
}

export function predictVramUsage(
  model: ModelInfo,
  config: ModelLoadConfig,
  calibration?: VramCalibrationInput | null,
  options?: VramEstimateOptions,
): VramPrediction {
  const gib = 1024 ** 3;
  const modelGb = Math.max(0, model.fileSizeBytes) / gib;
  const layerCount = Math.max(0, Math.round(model.blockCount ?? 0));
  const ngl = config.gpuLayers < 0 ? layerCount + 1 : Math.max(0, Math.round(config.gpuLayers));
  const versionMatch = options?.kernelVersion?.match(/\bb(\d+)\b/i);
  const buildNumber = versionMatch ? Number(versionMatch[1]) : null;
  const outputFirst = buildNumber != null && buildNumber >= 11405;
  const offloadedLayers = Math.min(layerCount, outputFirst ? Math.max(0, ngl - 1) : ngl);
  const outputOffloaded = outputFirst ? ngl > 0 : ngl > layerCount;
  const gpuStart = layerCount - offloadedLayers;
  const offloadRatio = layerCount > 0 ? offloadedLayers / layerCount : ngl > 0 ? 1 : 0;
  const cpuExpertLayers = model.modelType === 'moe' ? clamp(Math.round(config.moeCpuLayers), 0, layerCount) : 0;
  const cpuExpertsOnGpuLayers = Math.max(0, cpuExpertLayers - gpuStart);
  const expertGpuRatio = layerCount > 0 ? (offloadedLayers - cpuExpertsOnGpuLayers) / layerCount : offloadRatio;
  const missing: string[] = [];
  if (buildNumber == null && ngl > 0 && ngl <= layerCount) missing.push('kernel_layer_order');
  if (!(model.fileSizeBytes > 0)) missing.push('file_size');
  const layout = model.memoryLayout;
  const tensorReady = layout?.version === 1 && layout.layers.length === layerCount && layerCount > 0
    && [layout.total_bytes, layout.input_bytes, layout.output_bytes, layout.other_bytes].every((value) => Number.isFinite(value) && value >= 0)
    && layout.total_bytes > 0 && layout.total_bytes <= Math.max(1, model.fileSizeBytes) * 1.05
    && layout.layers.every((layer) => Number.isFinite(layer.weight_bytes) && Number.isFinite(layer.expert_bytes)
      && layer.weight_bytes >= layer.expert_bytes && layer.expert_bytes >= 0)
    && Math.abs(layout.layers.reduce((sum, layer) => sum + layer.weight_bytes, 0)
      + layout.input_bytes + layout.output_bytes + layout.other_bytes - layout.total_bytes) <= 1;
  let rawWeightsGpuGb: number;
  let weightTotalGb = modelGb;
  if (tensorReady) {
    let gpuBytes = 0;
    for (let index = gpuStart; index < layerCount; index += 1) {
      const layer = layout!.layers[index];
      gpuBytes += layer.weight_bytes - (index < cpuExpertLayers ? layer.expert_bytes : 0);
    }
    const outputGpu = outputOffloaded || (buildNumber == null && ngl > 0);
    const tiedCopy = outputGpu && layout!.tied_output ? layout!.input_bytes : 0;
    if (outputGpu) gpuBytes += layout!.output_bytes + tiedCopy;
    if (ngl > 0) gpuBytes += layout!.other_bytes;
    rawWeightsGpuGb = gpuBytes / gib;
    weightTotalGb = (layout!.total_bytes + tiedCopy) / gib;
    if (layout!.accuracy === 'upper_bound') missing.push('tensor_upper_bound');
    if (ngl > 0 && layout!.other_bytes > 0) missing.push('other_tensor_placement');
  } else {
    missing.push('tensor_memory_layout');
    const repeatingShare = layerCount > 0 ? model.modelType === 'moe' ? 0.96 : 0.92 : 0.9;
    const expertShare = model.modelType === 'moe' && (model.expertCount ?? 0) > 1 ? 0.55 : 0;
    const repeatingRatio = (1 - expertShare) * offloadRatio + expertShare * expertGpuRatio;
    const outputRatio = outputOffloaded || (buildNumber == null && ngl > 0) ? 1 : 0;
    rawWeightsGpuGb = Math.min(modelGb, modelGb * (repeatingShare * repeatingRatio + (1 - repeatingShare) * outputRatio));
  }

  const embedding = model.embeddingLength && model.embeddingLength > 0 ? model.embeddingLength : 4096;
  if (!model.embeddingLength && ngl > 0) missing.push('embedding_length');
  const headCount = Math.max(1, model.headCount ?? model.headCountKv ?? 32);
  const heads = kvHeadsByLayer(model, layerCount);
  const keyLength = model.keyLength ?? (model.headCount ? Math.floor(embedding / model.headCount) : null);
  const valueLength = model.valueLength ?? keyLength;
  const ctx = Math.max(1, Math.round(config.ctxLength));
  const effectiveParallel = config.parallel > 0 ? config.parallel : options?.effectiveParallel;
  const parallel = effectiveParallel != null && effectiveParallel > 0 ? clamp(Math.round(effectiveParallel), 1, 128) : 1;
  const paddedContext = Math.ceil(ctx / 256) * 256;
  const contextPerStream = config.kvUnified ? paddedContext : Math.ceil(Math.floor(paddedContext / parallel) / 256) * 256;
  const contextCapacity = contextPerStream * (config.kvUnified ? 1 : parallel);
  if (!(effectiveParallel != null && effectiveParallel > 0) && ngl > 0 && (!config.kvUnified || model.slidingWindow || heads?.some((head) => head === 0))) missing.push('parallel_auto');
  if (ngl > 0 && ['qwen35', 'qwen35moe', 'qwen3next'].includes(model.architecture ?? '')
    && !validVector(model.kvHeadsByLayer, layerCount)) missing.push('hybrid_layer_layout');
  const batch = clamp(config.batchSize || 1, 1, Math.min(8192, ctx));
  const ubatch = clamp(config.physicalBatchSize || batch, 1, batch);
  const keyType = config.cacheTypeKEnabled ? config.cacheTypeK : 'f16';
  const valueType = config.cacheTypeVEnabled ? config.cacheTypeV : 'f16';
  let rawKvGb: number | null = 0;
  if (config.kvCache && ngl > 0 && offloadedLayers > 0) {
    if (layerCount <= 0 || !heads || !keyLength || !valueLength) {
      rawKvGb = null;
      if (layerCount <= 0) missing.push('block_count');
      if (!heads) missing.push('head_count_kv');
      if (!keyLength) missing.push('key_length');
      if (!valueLength) missing.push('value_length');
    } else {
      let kvBytes = 0;
      const swaPatternReady = model.swaLayerPattern?.length === layerCount;
      const aggregateSwa = !swaPatternReady && model.kvHeadsSumFull != null && model.kvHeadsSumSwa != null;
      for (let index = gpuStart; index < layerCount; index += 1) {
        if (heads[index] === 0) continue;
        const isSwa = swaPatternReady && model.swaLayerPattern![index];
        // -c 是全服务上下文，-np 将它分给槽位，不能再按并发数放大 KV。
        const tokens = contextCapacity;
        const swaTokens = model.slidingWindow
          ? Math.ceil(Math.min(contextPerStream, model.slidingWindow * (config.kvUnified ? parallel : 1) + ubatch) / 256) * 256 * (config.kvUnified ? 1 : parallel)
          : tokens;
        const swaKey = model.keyLengthSwa ?? keyLength;
        const swaValue = model.valueLengthSwa ?? model.keyLengthSwa ?? valueLength;
        if (aggregateSwa && model.slidingWindow) {
          const totalHeads = model.kvHeadsSumFull! + model.kvHeadsSumSwa!;
          const fullShare = totalHeads > 0 ? model.kvHeadsSumFull! / totalHeads : 1;
          kvBytes += heads[index] * (fullShare * tokens * (rowBytes(keyLength, keyType) + rowBytes(valueLength, valueType))
            + (1 - fullShare) * swaTokens * (rowBytes(swaKey, keyType) + rowBytes(swaValue, valueType)));
        } else {
          kvBytes += heads[index] * (isSwa ? swaTokens : tokens)
            * (rowBytes(isSwa ? swaKey : keyLength, keyType) + rowBytes(isSwa ? swaValue : valueLength, valueType));
        }
      }
      rawKvGb = kvBytes / gib;
      if (model.slidingWindow && !swaPatternReady && !aggregateSwa) missing.push('sliding_window_pattern');
      if (model.kvHeadsSum != null && !validVector(model.kvHeadsByLayer, layerCount) && offloadedLayers < layerCount) missing.push('kv_heads_by_layer');
    }
  }

  const graphFactor = clamp((layerCount || 32) / 32, 0.75, 3.5);
  const graphScratch = ubatch * embedding * 2 * (config.fastAttention ? 18 : 28) * graphFactor / gib;
  const attentionScratch = config.fastAttention ? 0 : ubatch * Math.min(ctx, 8192) * headCount * 2 / gib;
  const rawComputeGb = ngl > 0 ? Math.max(0.12, graphScratch + attentionScratch + Math.max(0, parallel - 1) * Math.min(0.18, graphScratch * 0.25)) : 0;
  const rawRuntimeGb = ngl > 0 ? 0.3 + Math.min(0.85, (layerCount || 32) * 0.006) + 0.04 * (parallel - 1) : 0;
  if (config.kvCache && ngl > 0 && heads?.some((head) => head === 0) && ['qwen35', 'qwen35moe', 'qwen3next'].includes(model.architecture ?? '')) {
    const stateSize = metadataNumber(model, 'ssm.state_size');
    const innerSize = metadataNumber(model, 'ssm.inner_size');
    const convolution = metadataNumber(model, 'ssm.conv_kernel');
    const groups = metadataNumber(model, 'ssm.group_count');
    if (stateSize && innerSize && convolution && groups) {
      const recurrentLayers = heads.slice(gpuStart).filter((head) => head === 0).length;
      const recurrentGb = recurrentLayers * parallel * 4 * (stateSize * innerSize + Math.max(0, convolution - 1) * (innerSize + 2 * groups * stateSize)) / gib;
      if (rawKvGb != null) rawKvGb += recurrentGb;
      if (config.speculativeDecoding !== 'off') missing.push('recurrent_rollback');
    } else {
      missing.push('recurrent_state');
    }
  }
  if (ngl > 0 && model.mmprojPath && (model.supportsVision || model.supportsAudio)) missing.push('projector_memory');
  if (ngl > 0 && config.speculativeDecoding !== 'off') missing.push('draft_memory');

  const ratio = (value: number | undefined, fallback: number, min: number, max: number) => value != null && Number.isFinite(value) && value > 0 ? clamp(value, min, max) : fallback;
  const weightsRatio = ratio(calibration?.weightsRatio ?? calibration?.overallRatio, 1, 0.5, 1.3);
  const kvRatio = ratio(calibration?.kvRatio, 1, 0.5, 1.5);
  const computeRatio = ratio(calibration?.computeRatio ?? calibration?.scratchRatio, 1, 0.25, 4);
  const weightsGpuGb = rawWeightsGpuGb * weightsRatio;
  const kvGb = rawKvGb == null ? null : rawKvGb * kvRatio;
  const computeGb = rawComputeGb * computeRatio;
  const runtimeOffset = calibration?.runtimeOffsetGb;
  const runtimeGb = ngl > 0 ? Math.max(0, rawRuntimeGb + (runtimeOffset != null && Number.isFinite(runtimeOffset) ? clamp(runtimeOffset, -rawRuntimeGb, 2) : 0)) : 0;
  const analyticalGb = rawWeightsGpuGb + (rawKvGb ?? 0);
  const empiricalGb = rawComputeGb + rawRuntimeGb;
  const subtotal = weightsGpuGb + (kvGb ?? 0) + computeGb + runtimeGb;
  const uncertainty = calibration?.uncertaintyGb;
  const safetyGb = subtotal > 0 ? Math.max(0.15, subtotal * 0.06, uncertainty != null && Number.isFinite(uncertainty) ? clamp(uncertainty, 0, 4) : 0) : 0;
  return {
    totalGb: subtotal + safetyGb,
    weightsGpuGb, weightsCpuGb: Math.max(0, weightTotalGb - weightsGpuGb), kvGb, computeGb, runtimeGb, safetyGb,
    offloadRatio, expertGpuRatio, missing: [...new Set(missing)], analyticalGb, empiricalGb,
    rawWeightsGpuGb, rawKvGb, rawComputeGb, rawRuntimeGb,
    weightSource: tensorReady ? layout!.accuracy === 'upper_bound' ? 'tensor_upper_bound' : 'tensor' : 'file',
  };
}
