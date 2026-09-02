// 显存预估校准：从「运行记录」（AppData/model_records.json）派生，让实测数据修正预测。
//
// 原理：每条带实测显存（vram_gb）的启动记录都存有当时的启动参数（ngl / ctx / kv /
// ncmoe / flash_attn）。用模型表头 + 这组参数可以重新还原出当时的分项预测——
// 解析项（权重 + KV，解析式，本身可信）与经验项（计算暂存 + 运行时，启发式系数）。
// 于是 经验项实测 ≈ 实测显存 − 解析项预测，得到经验项的实测/预测比；
// 对多条样本做 EMA（新样本权重高）即得校准比 scratchRatio。
//
// 与旧版（localStorage 整体系数 EMA）的差别：
// - 数据源是磁盘运行记录：重置浏览器状态、换机后依然在，且天然带参数指纹；
// - 只修正经验项：改 ctx / ngl 时 KV 与权重按解析式走，不再被旧样本的暂存误差
//   按比例放大（旧版乘法系数会把这部分误差传染给准的项）；
// - 样本按参数指纹筛选：优先使用与当前参数一致的记录，样本不足再回退全量。
//
// 纯派生计算：不写任何存储；启动记录本身仍是写入点（ModelLoadPage 保存 launch 记录）。

import type { ModelInfo, ModelLoadConfig } from '@/types';
import type { ModelRunRecord } from '@/lib/desktop';
import { predictVramUsage, clampScratchRatio, clampOverallRatio, type VramCalibrationInput } from '@/lib/vramEstimate';
import { RECOMMENDED_CTX_LENGTH } from '@/lib/modelDefaults';

export interface VramCalibration extends VramCalibrationInput {
  /** 分项校准：经验项（计算暂存 + 运行时）的实测/预测比。仅 scratch 模式有值。 */
  scratchRatio?: number;
  /** 整体兜底校准：实测/预测总比值。仅 overall 模式有值。 */
  overallRatio?: number;
  /** 参与校准的样本数。 */
  samples: number;
  /** true = 样本与当前启动参数同指纹；false = 指纹匹配样本不足，回退了全量记录。 */
  matched: boolean;
}

const DEFAULT_CALIBRATION: VramCalibration = { samples: 0, matched: false };
// 顺序 EMA：样本按时间从旧到新折叠，最新一次实测权重最高（α）。
const EMA_ALPHA = 0.35;
/** 指纹匹配样本达到该数量才启用指纹筛选，否则回退全量（避免 1 条样本定调）。 */
const MIN_MATCHED_SAMPLES = 2;
/** 经验项预测小于该值（GB）时跳过样本：分母过小会把噪声放大成极端比率。 */
const MIN_EMPIRICAL_GB = 0.05;

/**
 * 从一条运行记录还原出与当时启动参数对应的「预测相关」加载配置。
 * 记录未保存的项（parallel / batch 等）按默认值近似：parallel 未保存，绝大多数
 * 会话为 1；对解析项（权重 + KV）与经验项的影响远小于参数本身的差异。
 */
function loadConfigFromRecord(record: ModelRunRecord, model: ModelInfo): ModelLoadConfig {
  const kv = typeof record.kv === 'string' ? record.kv : 'f16';
  const kvEnabled = kv !== 'f16';
  return {
    ctxLength: Math.max(1, Math.round(record.ctx ?? RECOMMENDED_CTX_LENGTH)),
    gpuLayers: Math.max(0, Math.round(record.ngl ?? model.blockCount ?? 0)),
    batchSize: 512,
    physicalBatchSize: 512,
    threads: -1,
    parallel: -1,
    fastAttention: record.flash_attn ?? true,
    kvCache: true,
    kvUnified: true,
    mmap: true,
    mlock: false,
    noWarmup: false,
    cacheTypeKEnabled: kvEnabled,
    cacheTypeK: kv,
    cacheTypeVEnabled: kvEnabled,
    cacheTypeV: kv,
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
    moeCpuLayers: Math.max(0, Math.round(record.ncmoe ?? 0)),
    reasoningBudget: 0,
  };
}

/** 参数指纹：除 ctx（允许同数量级浮动）外，影响显存结构的参数需一致。 */
function sameFingerprint(record: ModelRunRecord, config: ModelLoadConfig, isMoe: boolean) {
  const recordKv = typeof record.kv === 'string' ? record.kv : 'f16';
  const currentKv = config.cacheTypeKEnabled ? config.cacheTypeK : 'f16';
  const recordCtx = Math.max(1, record.ctx ?? 0);
  const ctxRatio = recordCtx > 0 && config.ctxLength > 0
    ? Math.max(recordCtx, config.ctxLength) / Math.min(recordCtx, config.ctxLength)
    : Infinity;
  return (record.ngl ?? -1) === config.gpuLayers
    && recordKv === currentKv
    && (record.flash_attn ?? true) === config.fastAttention
    && (record.ncmoe ?? 0) === (isMoe ? config.moeCpuLayers : 0)
    && ctxRatio <= 2;
}

/**
 * 用模型表头与该模型的历史启动记录计算校准。两级策略：
 * 1. 分项校准（优先）：能从实测增量中分离出经验项正值的样本，EMA 出经验项修正比；
 * 2. 整体兜底：没有任何分项可用样本、但存在总实测偏小的样本时（典型：MoE 权重
 *    公式与实际结构不符导致解析项虚高），用总实测/小计比只缩放 GPU 权重。
 */
export function computeVramCalibration(
  model: ModelInfo,
  records: ModelRunRecord[],
  currentConfig?: ModelLoadConfig,
): VramCalibration {
  const valid = records.filter(
    (record) => Number.isFinite(record.vram_gb) && (record.vram_gb ?? 0) > 0,
  );
  if (valid.length === 0) return DEFAULT_CALIBRATION;

  const fingerprint = currentConfig
    ? valid.filter((record) => sameFingerprint(record, currentConfig, model.modelType === 'moe'))
    : [];
  // 指纹样本足够时只用指纹样本（参数一致 → 经验项结构一致）；否则回退全量。
  const selected = fingerprint.length >= MIN_MATCHED_SAMPLES ? fingerprint : valid;
  const matched = fingerprint.length >= MIN_MATCHED_SAMPLES;

  // 分项路径样本：实测增量 > 解析项预测，才能分离出经验项实测。
  // 实测增量 <= 解析项预测 说明解析项本身虚高（或记录异常），只能进整体兜底。
  const scratchSamples: number[] = [];
  const overallSamples: number[] = [];
  // 记录已按时间从新到旧排列；EMA 让最新样本权重最高。
  // 样本可信下限：实测至少达到「解析项一半」与「文件体积三成 + 0.5GB」中的较低者。
  // 两个闸门各放行一类合法低实测——解析项本身虚高（混合架构权重公式偏差）与
  // -fit 自动卸载把大模型压进显卡（实测贴着容量上限）；低于下限的只可能是
  // 启动失败残值，或旧实例未卸载导致差值串台的坏测量（典型：20GB 模型实测 1GB）。
  const fileGb = Math.max(0, model.fileSizeBytes) / 1024 ** 3;
  for (const record of selected) {
    const config = loadConfigFromRecord(record, model);
    const prediction = predictVramUsage(model, config, { scratchRatio: 1 });
    const actualGb = record.vram_gb ?? 0;
    const plausibleFloor = Math.min(prediction.analyticalGb * 0.5, fileGb * 0.3 + 0.5);
    if (actualGb < plausibleFloor) continue;
    if (prediction.empiricalGb >= MIN_EMPIRICAL_GB) {
      const empiricalActual = actualGb - prediction.analyticalGb;
      if (empiricalActual > 0) {
        scratchSamples.push(clampScratchRatio(empiricalActual / prediction.empiricalGb));
        continue;
      }
    }
    // 整体兜底样本：比值相对「不含安全余量的小计」计算。若用含 6% 余量的
    // totalGb 做分母，再叠更薄的余量，校准后会系统性略低于实测、越校越小。
    const subtotalGb = prediction.analyticalGb + prediction.empiricalGb;
    if (subtotalGb > 1 && actualGb > 1) {
      overallSamples.push(clampOverallRatio(actualGb / subtotalGb));
    }
  }

  if (scratchSamples.length > 0) {
    let ratio: number | null = null;
    for (const observed of [...scratchSamples].reverse()) {
      ratio = ratio === null ? observed : ratio * (1 - EMA_ALPHA) + observed * EMA_ALPHA;
    }
    return { scratchRatio: clampScratchRatio(ratio!), samples: scratchSamples.length, matched };
  }

  if (overallSamples.length > 0) {
    let ratio: number | null = null;
    for (const observed of [...overallSamples].reverse()) {
      ratio = ratio === null ? observed : ratio * (1 - EMA_ALPHA) + observed * EMA_ALPHA;
    }
    return { overallRatio: clampOverallRatio(ratio!), samples: overallSamples.length, matched };
  }

  return DEFAULT_CALIBRATION;
}
