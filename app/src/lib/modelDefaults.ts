export const RECOMMENDED_CTX_LENGTH = 32768;
export const DEFAULT_MAX_COMPLETION_TOKENS = 0;
export const DEFAULT_REASONING_BUDGET = 4096;
export const MAX_REASONING_BUDGET = 32768;
export const DEFAULT_GPU_LAYERS_WHEN_UNKNOWN = 999;

export function recommendedGpuLayers(blockCount?: number | null) {
  const layers = Number(blockCount ?? 0);
  return layers > 0 ? Math.max(0, layers) : DEFAULT_GPU_LAYERS_WHEN_UNKNOWN;
}

export function recommendedReasoningBudget(supportsReasoning?: boolean | null) {
  return supportsReasoning ? DEFAULT_REASONING_BUDGET : 0;
}
