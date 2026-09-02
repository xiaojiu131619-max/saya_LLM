// 显存预估模型：从 ModelLoadPage.tsx 提出，供推荐参数、显存校准与 UI 展示复用。
// 公式与旧实现保持一致，仅把固定 6% 安全余量改为可校准系数。

import type { ModelInfo, ModelLoadConfig } from '@/types';
import { RECOMMENDED_CTX_LENGTH } from '@/lib/modelDefaults';

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
  /** 解析项小计：权重 + KV。来自表头的解析式，本身可信，校准不改动它。 */
  analyticalGb: number;
  /** 经验项小计：计算暂存 + 运行时。来自启发式系数，是校准的修正对象（未乘系数的原值）。 */
  empiricalGb: number;
}

/**
 * 校准输入，两种模式二选一生效（优先分项）：
 * - scratchRatio：分项校准，只修正经验项（计算暂存 + 运行时）。解析项（权重+KV）可信时使用。
 * - overallRatio：整体兜底校准，按实测/预测总比值缩放全部小计。用于解析项本身
 *   偏差过大（如 MoE 权重公式与实际结构不符）导致分项还原出负值的模型。
 */
export interface VramCalibrationInput {
  scratchRatio?: number;
  overallRatio?: number;
}

/** 经验项校准比率的合理区间：暂存项误差可能很大，但仍要防野值把预测带飞。 */
export const SCRATCH_RATIO_MIN = 0.4;
export const SCRATCH_RATIO_MAX = 2.5;
/** 整体兜底比率的合理区间：只用来缩放 GPU 权重（MoE 公式偏差 / -fit 压顶），
 *  不缩放 KV。下限 0.5 保证宁多勿少，上限仍防坏样本把预测带飞。 */
export const OVERALL_RATIO_MIN = 0.5;
export const OVERALL_RATIO_MAX = 1.3;

export function clampScratchRatio(ratio: number) {
  return Math.min(SCRATCH_RATIO_MAX, Math.max(SCRATCH_RATIO_MIN, ratio));
}

export function clampOverallRatio(ratio: number) {
  return Math.min(OVERALL_RATIO_MAX, Math.max(OVERALL_RATIO_MIN, ratio));
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
  calibration?: VramCalibrationInput | null,
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

  const embedding = model.embeddingLength && model.embeddingLength > 0 ? model.embeddingLength : 4096;
  if (!model.embeddingLength) missing.push('embedding_length');
  const headCount = Math.max(1, model.headCount ?? model.headCountKv ?? 32);

  let kvGb: number | null = null;
  if (config.kvCache) {
    // KV 头总数。混合架构（nemotron_h_moe / lfm2 / gemma4 等）的 head_count_kv 是
    // 逐层数组：非 0 = 该层 KV 头数，0 = Mamba 等无 KV 层，解析器已聚合为
    // kvHeadsSum（勿再乘层数）；标量形式按层展开；都缺才退回 headCount 整层近似。
    const kvHeadsTotal = model.kvHeadsSum != null
      ? model.kvHeadsSum
      : (model.headCountKv ?? model.headCount) != null
        ? (model.headCountKv ?? model.headCount)! * layerCount
        : null;
    // per-head 维度缺省时按 llama.cpp 口径退回 embedding/headCount。
    const keyLength = model.keyLength
      ?? (model.headCount ? Math.floor(embedding / model.headCount) : null);
    const valueLength = model.valueLength ?? keyLength;
    // gemma 系 SWA 分层：SWA 层的 KV 只按滑动窗口分配（且用独立的
    // key_length_swa），全注意力层才按全 ctx 计——两类的头数由解析器分列。
    const swaSplitReady = model.kvHeadsSumFull != null && model.kvHeadsSumSwa != null
      && model.slidingWindow != null && model.slidingWindow > 0
      && model.keyLengthSwa != null;
    if (layerCount > 0 && keyLength && valueLength && (swaSplitReady || kvHeadsTotal)) {
      const parallelSlots = config.parallel > 0 ? clamp(Math.round(config.parallel), 1, 128) : 1;
      const contextTokens = Math.max(1, config.ctxLength) * parallelSlots;
      const keyBytes = cacheBytesPerValue(config.cacheTypeKEnabled ? config.cacheTypeK : 'f16');
      const valueBytes = cacheBytesPerValue(config.cacheTypeVEnabled ? config.cacheTypeV : 'f16');
      const kvBytes = swaSplitReady
        ? contextTokens * model.kvHeadsSumFull! * ((keyLength * keyBytes) + (valueLength * valueBytes))
          + model.slidingWindow! * model.kvHeadsSumSwa! * ((model.keyLengthSwa! * keyBytes) + (model.valueLengthSwa ?? model.keyLengthSwa)! * valueBytes)
        : contextTokens
          * kvHeadsTotal!
          * ((keyLength * keyBytes) + (valueLength * valueBytes));
      kvGb = kvBytes / gib;
    } else {
      if (layerCount <= 0) missing.push('block_count');
      if (!kvHeadsTotal && !swaSplitReady) missing.push('head_count_kv');
      if (!keyLength) missing.push('key_length');
      if (!valueLength) missing.push('value_length');
    }
  } else {
    kvGb = 0;
  }

  const batch = clamp(config.batchSize || 1, 1, 8192);
  const ubatch = clamp(config.physicalBatchSize || batch, 1, batch);
  const effectiveBatch = Math.max(1, Math.min(batch, ubatch));
  const ctxWindow = clamp(config.ctxLength || RECOMMENDED_CTX_LENGTH, 512, 262144);
  const parallelSlots = config.parallel > 0 ? clamp(Math.round(config.parallel), 1, 128) : 1;
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
  const analyticalGb = weightsGpuGb + (kvGb ?? 0);
  const empiricalGb = computeGb + runtimeGb;
  const subtotalGb = analyticalGb + empiricalGb;
  // 校准语义分三种：
  // - 分项校准（scratchRatio）：只对经验项乘实测得出的修正比，解析项原样保留。
  //   改 ctx / ngl 时 KV 与权重按解析式走，不被旧样本的暂存误差按比例放大。
  // - 整体兜底（overallRatio）：分项还原不可靠（解析项虚高，典型 MoE 权重公式）时，
  //   只缩放 GPU 权重。KV 与计算暂存按解析式保留——否则 ctx 变大时会被旧样本
  //   的权重误差按比例压小，预测越校越小。
  // - 未传校准（默认）：整体 6% 安全余量。校准后也保留 6%，避免「实测/含余量预测」
  //   再叠 2% 余量导致系统性略低于实测。
  let totalGb: number;
  let safetyGb: number;
  const scratchRatio = calibration?.scratchRatio;
  const overallRatio = calibration?.overallRatio;
  if (subtotalGb <= 0) {
    totalGb = 0;
    safetyGb = 0;
  } else if (scratchRatio != null && Number.isFinite(scratchRatio) && scratchRatio > 0) {
    const empiricalCalibrated = empiricalGb * clampScratchRatio(scratchRatio);
    const calibratedSubtotal = analyticalGb + empiricalCalibrated;
    safetyGb = Math.max(0.15, calibratedSubtotal * 0.06);
    totalGb = calibratedSubtotal + safetyGb;
  } else if (overallRatio != null && Number.isFinite(overallRatio) && overallRatio > 0) {
    const weightsCalibrated = weightsGpuGb * clampOverallRatio(overallRatio);
    const calibratedSubtotal = weightsCalibrated + (kvGb ?? 0) + empiricalGb;
    safetyGb = Math.max(0.15, calibratedSubtotal * 0.06);
    totalGb = calibratedSubtotal + safetyGb;
  } else {
    safetyGb = Math.max(0.15, subtotalGb * 0.06);
    totalGb = subtotalGb + safetyGb;
  }

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
    analyticalGb,
    empiricalGb,
  };
}
