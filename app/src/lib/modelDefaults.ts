export const RECOMMENDED_CTX_LENGTH = 32768;
export const DEFAULT_MAX_COMPLETION_TOKENS = 0;
export const DEFAULT_REASONING_BUDGET = 4096;
export const MAX_REASONING_BUDGET = 32768;
export const DEFAULT_GPU_LAYERS_WHEN_UNKNOWN = 999;

/**
 * llama.cpp 的 `-ngl` 把输出层也算作一层：内核自报的总层数是 `block_count + 1`。
 * 因此「全部卸载」的取值是 `block_count + 1`，而不是 `block_count`——用 block_count
 * 会恰好留下一层在 CPU，GPU 计算图被迫与这条 CPU 路径来回同步，生成速度成倍下降
 * （27B 三值量化实测：ngl=64 → 8.6 t/s，ngl=65 → 57.9 t/s）。
 */
export function maxGpuLayers(blockCount?: number | null) {
  const layers = Number(blockCount ?? 0);
  return layers > 0 ? layers + 1 : DEFAULT_GPU_LAYERS_WHEN_UNKNOWN;
}

/// 默认档位 = 全部卸载到 GPU（含输出层）。
export function recommendedGpuLayers(blockCount?: number | null) {
  return maxGpuLayers(blockCount);
}

export function recommendedReasoningBudget(supportsReasoning?: boolean | null) {
  return supportsReasoning ? DEFAULT_REASONING_BUDGET : 0;
}
