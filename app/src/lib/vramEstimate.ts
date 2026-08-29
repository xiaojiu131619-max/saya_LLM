// 显存预估模型：从 ModelLoadPage.tsx 提出，供推荐参数、显存校准与 UI 展示复用。
// 公式与旧实现保持一致，仅把固定 6% 安全余量改为可校准系数。

import type { ModelInfo, ModelLoadConfig } from '@/types';
import { RECOMMENDED_CTX_LENGTH } from '@/lib/modelDefaults';
import { getVramCalibrationRatio } from '@/lib/vramCalibration';

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
}

export function cacheBytesPerValue(cacheType: string) {
  const normalized = cacheType.toLowerCase();
  if (normalized === 'f32') return 4;
  if (normalized === 'f16' || normalized === 'bf16') return 2;
  if (normalized === 'q8_0') return 1.0625;
  if (normalized === 'q5_0' || normalized === 'q5_1') return 0.75;
  if (normalized === 'q4_0' || normalized === 'q4_1' || normalized === 'iq4_nl') return 0.5625;
  return 2;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function predictVramUsage(
  model: ModelInfo,
  config: ModelLoadConfig,
  calibrationRatio = getVramCalibrationRatio(),
): VramPrediction {
  const gib = 1024 ** 3;
  const modelBytes = Math.max(0, model.fileSizeBytes);
  const modelGb = modelBytes / gib;
  const layerCount = Math.max(0, model.blockCount ?? 0);
  const offloadedLayers = layerCount > 0 ? clamp(config.gpuLayers, 0, layerCount) : Math.max(0, config.gpuLayers);
  const offloadRatio = layerCount > 0 ? clamp(offloadedLayers / layerCount, 0, 1) : offloadedLayers > 0 ? 1 : 0;
  const moeCpuLayers = model.modelType === 'moe' && layerCount > 0
    ? clamp(config.moeCpuLayers, 0, offloadedLayers)
    : 0;
  const expertGpuRatio = layerCount > 0 ? clamp((offloadedLayers - moeCpuLayers) / layerCount, 0, 1) : offloadRatio;
  const missing: string[] = [];
  if (model.fileSizeBytes <= 0) missing.push('file_size');

  const repeatingWeightShare = layerCount > 0 ? (model.modelType === 'moe' ? 0.96 : 0.92) : 0.9;
  const fixedWeightShare = 1 - repeatingWeightShare;
  const expertWeightShare = model.modelType === 'moe' && (model.expertCount ?? 0) > 1 ? 0.55 : 0;
  const denseWeightShare = 1 - expertWeightShare;
  const fixedGpuRatio = offloadedLayers >= layerCount && layerCount > 0
    ? 1
    : offloadedLayers > 0
      ? 0.35
      : 0;
  const repeatingGpuRatio = (denseWeightShare * offloadRatio) + (expertWeightShare * expertGpuRatio);
  const weightsGpuGb = Math.min(
    modelGb,
    modelGb * ((repeatingWeightShare * repeatingGpuRatio) + (fixedWeightShare * fixedGpuRatio))
  );
  const weightsCpuGb = Math.max(0, modelGb - weightsGpuGb);

  let kvGb: number | null = null;
  if (config.kvCache) {
    const kvHeads = model.headCountKv ?? model.headCount;
    const keyLength = model.keyLength;
    const valueLength = model.valueLength;
    if (layerCount > 0 && kvHeads && keyLength && valueLength) {
      const parallelSlots = config.parallel > 0 ? clamp(Math.round(config.parallel), 1, 128) : 1;
      const contextTokens = Math.max(1, config.ctxLength) * parallelSlots;
      const keyBytes = cacheBytesPerValue(config.cacheTypeKEnabled ? config.cacheTypeK : 'f16');
      const valueBytes = cacheBytesPerValue(config.cacheTypeVEnabled ? config.cacheTypeV : 'f16');
      const kvBytes = contextTokens
        * layerCount
        * kvHeads
        * ((keyLength * keyBytes) + (valueLength * valueBytes));
      kvGb = kvBytes / gib;
    } else {
      if (layerCount <= 0) missing.push('block_count');
      if (!kvHeads) missing.push('head_count_kv');
      if (!keyLength) missing.push('key_length');
      if (!valueLength) missing.push('value_length');
    }
  } else {
    kvGb = 0;
  }

  const embedding = model.embeddingLength && model.embeddingLength > 0 ? model.embeddingLength : 4096;
  if (!model.embeddingLength) missing.push('embedding_length');
  const batch = clamp(config.batchSize || 1, 1, 8192);
  const ubatch = clamp(config.physicalBatchSize || batch, 1, batch);
  const effectiveBatch = Math.max(1, Math.min(batch, ubatch));
  const ctxWindow = clamp(config.ctxLength || RECOMMENDED_CTX_LENGTH, 512, 262144);
  const parallelSlots = config.parallel > 0 ? clamp(Math.round(config.parallel), 1, 128) : 1;
  const headCount = Math.max(1, model.headCount ?? model.headCountKv ?? 32);
  const activationBytes = 2;
  const graphLayerFactor = clamp((layerCount || 32) / 32, 0.75, 3.5);
  const graphMultiplier = config.fastAttention ? 18 : 28;
  const graphScratchGb = (effectiveBatch * embedding * activationBytes * graphMultiplier * graphLayerFactor) / gib;
  const attentionScratchGb = config.fastAttention
    ? 0
    : (effectiveBatch * Math.min(ctxWindow, 8192) * headCount * activationBytes) / gib;
  const parallelScratchGb = Math.max(0, parallelSlots - 1) * Math.min(0.18, graphScratchGb * 0.25);
  const computeGb = weightsGpuGb > 0
    ? Math.max(0.12, graphScratchGb + attentionScratchGb + parallelScratchGb)
    : 0;
  const runtimeGb = weightsGpuGb > 0
    ? 0.3 + Math.min(0.85, (layerCount || 32) * 0.006) + (parallelSlots > 1 ? 0.04 * (parallelSlots - 1) : 0)
    : 0.05;
  const subtotalGb = weightsGpuGb + (kvGb ?? 0) + computeGb + runtimeGb;
  // 旧实现：safetyGb = max(0.2, subtotal×0.06)。现在用校准系数整体放大，
  // 并保留一个最小绝对余量，避免小模型被压到 0。
  const safetyGb = subtotalGb > 0 ? Math.max(0.15, subtotalGb * (calibrationRatio - 1)) : 0;
  const totalGb = subtotalGb > 0 ? subtotalGb * calibrationRatio : 0;

  return {
    totalGb,
    weightsGpuGb,
    weightsCpuGb,
    kvGb,
    computeGb,
    runtimeGb,
    safetyGb,
    offloadRatio,
    expertGpuRatio,
    missing,
  };
}
