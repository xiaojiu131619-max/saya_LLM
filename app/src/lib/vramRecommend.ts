// 硬件感知的默认推荐参数：基于实测显存（vramTotal/vramUsed）与模型 KV 元数据，
// 反推「显存装得下的最大 GPU 层数」与「余量内能撑起的上下文长度」。
// 无硬件数据（浏览器模式）时返回 null，由调用方回退到旧的静态推荐。

import type { ModelInfo, ModelLoadConfig, SystemStats } from '@/types';
import { RECOMMENDED_CTX_LENGTH, recommendedGpuLayers } from '@/lib/modelDefaults';
import { predictVramUsage } from '@/lib/vramEstimate';

const VRAM_HEADROOM = 0.90; // 与后端 Auto-Tune 的 VRAM_LIMIT 一致：最多用到 90% 显存
const MIN_CTX_STEP = 512;

export interface HardwareRecommendation {
  gpuLayers: number;
  ctxLength: number;
  vramTotalGb: number;
  vramUsedGb: number;
  predictedTotalGb: number;
}

function hasUsableVram(stats?: SystemStats | null): stats is SystemStats {
  return Boolean(
    stats
    && Number.isFinite(stats.vramTotal)
    && stats.vramTotal > 0
    && Number.isFinite(stats.vramUsed)
    && stats.vramUsed >= 0,
  );
}

/**
 * 在给定显存预算下反推最大可卸载层数：ngl 从 0 线性递增，用 predictVramUsage
 * 估算每档总占用，取第一个超过预算的档位的前一档。层数未知（≤0）时无法扫描，
 * 回退到静态 recommendedGpuLayers。
 */
function scanMaxGpuLayers(
  model: ModelInfo,
  config: Pick<ModelLoadConfig, 'ctxLength' | 'batchSize' | 'physicalBatchSize' | 'fastAttention' | 'kvCache' | 'kvUnified' | 'cacheTypeKEnabled' | 'cacheTypeK' | 'cacheTypeVEnabled' | 'cacheTypeV' | 'parallel' | 'moeCpuLayers'>,
  budgetGb: number,
): number {
  const layerCount = Math.max(0, model.blockCount ?? 0);
  if (layerCount <= 0) {
    return recommendedGpuLayers(model.blockCount);
  }

  let best = 0;
  for (let ngl = 0; ngl <= layerCount; ngl += 1) {
    const prediction = predictVramUsage(
      model,
      { ...config, gpuLayers: ngl } as ModelLoadConfig,
      1.0, // 推荐时不叠加校准系数，避免校准偏差连锁放大；保守预算已留 10% 余量
    );
    if (prediction.totalGb <= budgetGb) {
      best = ngl;
    } else {
      break;
    }
  }
  return best;
}

/**
 * 基于实测显存生成推荐。ctx 在 ngl 确定后逐步抬高（步进 512），
 * 上限取模型 context_length 与 RECOMMENDED_CTX_LENGTH 的较小者，且不低于 512。
 */
export function recommendForHardware(
  model: ModelInfo,
  stats?: SystemStats | null,
): HardwareRecommendation | null {
  if (!hasUsableVram(stats)) return null;

  const budgetGb = stats.vramTotal * VRAM_HEADROOM - stats.vramUsed;
  if (budgetGb <= 0) return null;

  const baseConfig: Pick<ModelLoadConfig, 'ctxLength' | 'batchSize' | 'physicalBatchSize' | 'fastAttention' | 'kvCache' | 'kvUnified' | 'cacheTypeKEnabled' | 'cacheTypeK' | 'cacheTypeVEnabled' | 'cacheTypeV' | 'parallel' | 'moeCpuLayers'> = {
    ctxLength: 512,
    batchSize: 512,
    physicalBatchSize: 512,
    fastAttention: true,
    kvCache: true,
    kvUnified: true,
    cacheTypeKEnabled: false,
    cacheTypeK: 'f16',
    cacheTypeVEnabled: false,
    cacheTypeV: 'f16',
    parallel: -1,
    moeCpuLayers: 0,
  };

  const gpuLayers = scanMaxGpuLayers(model, baseConfig, budgetGb);

  // 确定 ngl 后，在剩余预算内抬高 ctx。
  const modelCtx = Math.max(0, model.ctxLength ?? 0);
  const ctxCap = modelCtx > 0 ? Math.min(modelCtx, RECOMMENDED_CTX_LENGTH) : RECOMMENDED_CTX_LENGTH;
  let ctxLength = 512;
  for (let ctx = 1024; ctx <= ctxCap; ctx += MIN_CTX_STEP) {
    const prediction = predictVramUsage(
      model,
      { ...baseConfig, gpuLayers, ctxLength: ctx } as ModelLoadConfig,
      1.0,
    );
    if (prediction.totalGb <= budgetGb) {
      ctxLength = ctx;
    } else {
      break;
    }
  }

  const finalPrediction = predictVramUsage(
    model,
    { ...baseConfig, gpuLayers, ctxLength } as ModelLoadConfig,
    1.0,
  );

  return {
    gpuLayers,
    ctxLength,
    vramTotalGb: stats.vramTotal,
    vramUsedGb: stats.vramUsed,
    predictedTotalGb: finalPrediction.totalGb,
  };
}
