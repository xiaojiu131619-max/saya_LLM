// 显存预估校准：加载成功后用实测显存占用反推修正系数（EMA），
// 让 predictVramUsage 的固定 6% 安全余量变成有实测依据的倍数。
// 每个模型单独保存一份系数；没有该模型样本时回退全局系数，再回退默认 1.06。
// 纯前端 best-effort：localStorage 不可用、解析失败时全部回退默认值。

const STORAGE_KEY = 'agent-llm-vram-calib-v1';
const DEFAULT_RATIO = 1.06;
const MIN_RATIO = 0.85;
const MAX_RATIO = 1.4;
// 单次观测的 EMA 权重：样本越多，新观测影响越小。
const EMA_ALPHA = 0.25;
const MAX_SAMPLES = 60;
const MAX_MODELS = 40;

interface CalibrationState {
  ratio: number;
  samples: number;
}

// v2 结构：全局一份 + 按模型各一份。旧版顶层 { ratio, samples } 会自动迁移为全局。
interface CalibrationStore {
  version: 2;
  global: CalibrationState;
  byModel: Record<string, CalibrationState>;
}

function clampRatio(ratio: number) {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

function sanitize(raw: Partial<CalibrationState> | undefined): CalibrationState | null {
  if (!raw) return null;
  const ratio = Number(raw.ratio);
  const samples = Number(raw.samples);
  if (!Number.isFinite(ratio) || !Number.isFinite(samples) || samples < 0) {
    return null;
  }
  return { ratio: clampRatio(ratio), samples: Math.round(samples) };
}

function readStore(): CalibrationStore | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CalibrationStore> & Partial<CalibrationState>;
    if (parsed.version === 2) {
      const global = sanitize(parsed.global);
      if (!global) return null;
      const byModel: Record<string, CalibrationState> = {};
      for (const [modelId, value] of Object.entries(parsed.byModel ?? {})) {
        const entry = sanitize(value as Partial<CalibrationState>);
        if (entry) byModel[modelId] = entry;
      }
      return { version: 2, global, byModel };
    }
    // 旧版：顶层就是 { ratio, samples }，迁移为全局系数。
    const legacy = sanitize(parsed);
    return legacy ? { version: 2, global: legacy, byModel: {} } : null;
  } catch {
    return null;
  }
}

function writeStore(store: CalibrationStore) {
  try {
    // 按样本数保留最多 MAX_MODELS 个模型，避免 localStorage 无限膨胀。
    const entries = Object.entries(store.byModel)
      .sort((a, b) => b[1].samples - a[1].samples)
      .slice(0, MAX_MODELS);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 2,
      global: store.global,
      byModel: Object.fromEntries(entries),
    }));
  } catch {
    // 隐私模式/配额满时静默失败，不影响加载流程。
  }
}

function emptyState(): CalibrationState {
  return { ratio: DEFAULT_RATIO, samples: 0 };
}

/**
 * 当前校准系数：优先该模型的样本，其次全局样本，最后默认 1.06（旧实现的 6% 安全余量）。
 */
export function getVramCalibrationRatio(modelId?: string): number {
  const store = readStore();
  if (!store) return DEFAULT_RATIO;
  if (modelId) {
    const perModel = store.byModel[modelId];
    if (perModel && perModel.samples > 0) return perModel.ratio;
  }
  return store.global.samples > 0 ? store.global.ratio : DEFAULT_RATIO;
}

/**
 * 已收集的样本数，用于 UI 展示「已校准 ×N（N 次）」。
 */
export function getVramCalibrationSamples(modelId?: string): number {
  const store = readStore();
  if (!store) return 0;
  if (modelId) {
    const perModel = store.byModel[modelId];
    if (perModel && perModel.samples > 0) return perModel.samples;
  }
  return store.global.samples;
}

/**
 * 写入一次观测：predictedGb 为预测占用（不含余量），actualGb 为实测增量。
 * modelId 提供时按模型单独累计，同时合并进全局系数。
 * 实测增量为 0 或 NaN 时忽略（可能是后台其它进程在波动）。
 */
export function recordVramCalibration(predictedGb: number, actualGb: number, modelId?: string) {
  if (!Number.isFinite(predictedGb) || predictedGb <= 0) return;
  if (!Number.isFinite(actualGb) || actualGb <= 0) return;

  const observed = clampRatio(actualGb / predictedGb);
  const store = readStore() ?? { version: 2 as const, global: emptyState(), byModel: {} };

  const applyEma = (current: CalibrationState): CalibrationState => {
    const samples = Math.min(MAX_SAMPLES, current.samples + 1);
    const alpha = current.samples === 0 ? 1 : EMA_ALPHA;
    return { ratio: clampRatio(current.ratio * (1 - alpha) + observed * alpha), samples };
  };

  store.global = applyEma(store.global);
  if (modelId) {
    store.byModel[modelId] = applyEma(store.byModel[modelId] ?? emptyState());
  }
  writeStore(store);
}
