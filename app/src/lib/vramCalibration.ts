import type { ModelInfo, ModelLoadConfig, SystemStats } from '@/types';
import type { ModelRunRecord, ModelVramMeasurement } from '@/lib/ipc/model';
import { predictVramUsage, type VramCalibrationInput } from '@/lib/vramEstimate';
import { assessVramMeasurement, modelVramSignature, vramMeasurementConfig } from '@/lib/vramMeasurement';

export interface VramCalibration extends VramCalibrationInput {
  samples: number;
  matched: boolean;
  rejected: number;
  legacy: number;
  confidence: 'none' | 'limited' | 'measured';
  effectiveParallel?: number;
}

const emptyCalibration = (rejected: number, legacy: number): VramCalibration => ({
  samples: 0, matched: false, rejected, legacy, confidence: 'none',
});

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** 旧记录只有加载前后总量、没有缓冲分项时，仍可用稳定采样差作为同参数实测总量。 */
function totalOnlyDelta(measurement: ModelVramMeasurement): number | null {
  const baseline = measurement.baseline_gb;
  const loaded = measurement.loaded_gb;
  const baselineSpread = measurement.baseline_spread_gb;
  const loadedSpread = measurement.loaded_spread_gb;
  if (!finite(baseline) || !finite(loaded) || !finite(baselineSpread) || !finite(loadedSpread)) return null;
  if (baseline < 0 || loaded < baseline || measurement.gpu_total_gb <= 0) return null;
  const tolerance = (used: number) => Math.max(0.1, used * 0.01);
  if (baselineSpread > tolerance(baseline) + 1e-9 || loadedSpread > tolerance(loaded) + 1e-9) return null;
  if (loaded > measurement.gpu_total_gb + 1e-9) return null;
  return loaded - baseline;
}

function robustValues(values: number[], tolerance: number) {
  const finite = values.filter(Number.isFinite);
  if (finite.length < 3) return finite;
  const center = median(finite);
  const mad = median(finite.map((value) => Math.abs(value - center)));
  return finite.filter((value) => Math.abs(value - center) <= Math.max(tolerance, mad * 3 * 1.4826));
}

function configFromMeasurement(model: ModelInfo, measurement: ModelVramMeasurement): ModelLoadConfig {
  const config = measurement.config;
  return {
    ...model.loadConfig,
    gpuLayers: config.gpu_layers,
    ctxLength: config.ctx_length,
    batchSize: config.batch_size,
    physicalBatchSize: config.ubatch_size,
    parallel: config.parallel,
    fastAttention: config.flash_attn,
    kvCache: config.kv_offload,
    kvUnified: config.kv_unified,
    cacheTypeKEnabled: true,
    cacheTypeK: config.cache_type_k,
    cacheTypeVEnabled: true,
    cacheTypeV: config.cache_type_v,
    moeCpuLayers: config.moe_cpu_layers,
    nCpuFfn: config.n_cpu_ffn ?? 0,
    moeCacheMib: config.moe_cache_mib ?? 0,
    swaFull: config.swa_full ?? false,
    mmprojOffload: config.mmproj_offload ?? true,
    kvUnifiedPerSlotEnabled: (config.kv_unified_per_slot ?? 0) > 0,
    kvUnifiedPerSlot: config.kv_unified_per_slot ?? 0,
    specDraftNubatch: config.spec_draft_n_ubatch ?? 0,
    speculativeDecoding: config.speculative as ModelLoadConfig['speculativeDecoding'],
    noWarmup: config.no_warmup ?? false,
    specDraftNMaxEnabled: config.draft_tokens != null,
    specDraftNMax: config.draft_tokens ?? model.loadConfig.specDraftNMax,
  };
}

function sameStructure(left: ModelVramMeasurement['config'], right: ModelVramMeasurement['config']) {
  return left.gpu_layers === right.gpu_layers
    && left.moe_cpu_layers === right.moe_cpu_layers
    && (left.n_cpu_ffn ?? 0) === (right.n_cpu_ffn ?? 0)
    && (left.moe_cache_mib ?? 0) === (right.moe_cache_mib ?? 0)
    && (left.swa_full ?? false) === (right.swa_full ?? false)
    && (left.mmproj_offload ?? true) === (right.mmproj_offload ?? true)
    && (left.kv_unified_per_slot ?? 0) === (right.kv_unified_per_slot ?? 0)
    && (left.spec_draft_n_ubatch ?? 0) === (right.spec_draft_n_ubatch ?? 0)
    && left.kv_offload === right.kv_offload && left.kv_unified === right.kv_unified
    && left.cache_type_k === right.cache_type_k && left.cache_type_v === right.cache_type_v
    && left.flash_attn === right.flash_attn
    && left.batch_size === right.batch_size && left.ubatch_size === right.ubatch_size
    && left.parallel === right.parallel && left.speculative === right.speculative
    && (left.no_warmup ?? false) === (right.no_warmup ?? false)
    && (left.draft_tokens ?? null) === (right.draft_tokens ?? null);
}

export function computeVramCalibration(
  model: ModelInfo,
  records: ModelRunRecord[],
  currentConfig: ModelLoadConfig = model.loadConfig,
  hardware?: Pick<SystemStats, 'gpuName' | 'vramTotal'> & { kernelVersion?: string | null },
): VramCalibration {
  let legacy = 0;
  let rejected = 0;
  const signature = modelVramSignature(model);
  const current = vramMeasurementConfig(currentConfig);
  const candidates: Array<{ record: ModelRunRecord; measurement: ModelVramMeasurement; prediction: ReturnType<typeof predictVramUsage> }> = [];
  for (const record of records) {
    if (record.model_id !== model.id || record.kind !== 'launch') { rejected += 1; continue; }
    const measurement = record.vram_measurement;
    // 旧记录未保存完整参数、GPU 与采样来源，保留展示，但无法证明属于当前校准条件。
    if (!measurement) { legacy += 1; continue; }
    if (measurement.version !== 1 || measurement.quality !== 'stable'
      || measurement.model_signature !== signature || !(measurement.gpu_total_gb > 0)
      || !measurement.kernel_version?.trim()
      || !(record.vram_gb != null && Number.isFinite(record.vram_gb) && record.vram_gb >= 0)
      || !sameStructure(measurement.config, current)
      || measurement.config.ctx_length !== current.ctx_length
      || !Number.isFinite(record.timestamp)) { rejected += 1; continue; }
    if (hardware && (!(hardware.vramTotal > 0) || !hardware.kernelVersion
      || measurement.kernel_version !== hardware.kernelVersion || measurement.gpu_name !== hardware.gpuName
      || Math.abs(measurement.gpu_total_gb - hardware.vramTotal) > 0.1)) { rejected += 1; continue; }
    const measuredConfig = configFromMeasurement(model, measurement);
    const summary = (used: number | null, spread: number | null) => used != null && spread != null
      ? { gpu_name: measurement.gpu_name, gpu_total_gb: measurement.gpu_total_gb, used_gb: used, spread_gb: spread } : null;
    const assessment = assessVramMeasurement({
      model, config: measuredConfig,
      baseline: summary(measurement.baseline_gb, measurement.baseline_spread_gb),
      loaded: summary(measurement.loaded_gb, measurement.loaded_spread_gb),
      buffers: measurement.buffers,
    });
    if (assessment.quality !== 'stable' || assessment.actualGb == null
      || Math.abs(assessment.actualGb - record.vram_gb) > 0.02) { rejected += 1; continue; }
    const prediction = predictVramUsage(model, measuredConfig, undefined, {
      kernelVersion: measurement.kernel_version, effectiveParallel: measurement.buffers.parallel,
    });
    if (prediction.rawKvGb == null) { rejected += 1; continue; }
    candidates.push({ record, measurement, prediction });
  }

  // 老启动记录可能只有加载前后总量（缓冲分项在旧版日志里缺失）。只要参数、GPU、
  // 内核与采样窗口都匹配，总量差仍可作为当前精确配置的实测校准。
  const totalOnly: Array<{ record: ModelRunRecord; measurement: ModelVramMeasurement; actualGb: number }> = [];
  if (!candidates.length) {
    for (const record of records) {
      if (record.model_id !== model.id || record.kind !== 'launch') continue;
      const measurement = record.vram_measurement;
      if (!measurement || measurement.version !== 1 || measurement.quality !== 'unverified') continue;
      const buffers = measurement.buffers;
      const hasDetailedBuffers = Boolean(buffers
        && finite(buffers.weights_gb) && finite(buffers.kv_gb) && finite(buffers.compute_gb)
        && finite(buffers.context) && finite(buffers.gpu_layers) && finite(buffers.parallel));
      // 只有「旧日志缺分项」导致的 unverified 才可退化为总量校准；完整缓冲却仍
      // unverified/adapted/contaminated 的记录必须拒绝。
      if (hasDetailedBuffers) continue;
      if (measurement.model_signature !== signature || !(measurement.gpu_total_gb > 0)
        || !measurement.kernel_version?.trim()
        || !sameStructure(measurement.config, current)
        || measurement.config.ctx_length !== current.ctx_length
        || !Number.isFinite(record.timestamp)) continue;
      if (hardware && (!(hardware.vramTotal > 0) || !hardware.kernelVersion
        || measurement.kernel_version !== hardware.kernelVersion || measurement.gpu_name !== hardware.gpuName
        || Math.abs(measurement.gpu_total_gb - hardware.vramTotal) > 0.1)) continue;
      const actualGb = totalOnlyDelta(measurement);
      if (actualGb == null) continue;
      totalOnly.push({ record, measurement, actualGb });
    }
  }
  if (!candidates.length && totalOnly.length) {
    totalOnly.sort((left, right) => right.record.timestamp - left.record.timestamp);
    const newest = totalOnly[0].measurement;
    const sameEnvironment = totalOnly.filter(({ measurement }) => measurement.gpu_name === newest.gpu_name
      && Math.abs(measurement.gpu_total_gb - newest.gpu_total_gb) < 0.1
      && measurement.kernel_version === newest.kernel_version
      && (measurement.buffers?.backend ?? null) === (newest.buffers?.backend ?? null));
    const exactGb = median(sameEnvironment.map(({ actualGb }) => actualGb));
    return {
      samples: sameEnvironment.length,
      matched: true,
      rejected: Math.max(0, rejected - sameEnvironment.length),
      legacy,
      confidence: 'limited',
      exactGb,
      effectiveParallel: newest.buffers?.parallel ?? (currentConfig.parallel > 0 ? currentConfig.parallel : undefined),
    };
  }
  if (!candidates.length) return emptyCalibration(rejected, legacy);
  // 在硬件读数尚未就绪时，同样不混合多个 GPU / 后端的运行记录。
  candidates.sort((left, right) => right.record.timestamp - left.record.timestamp);
  const newest = candidates[0].measurement;
  const sameEnvironment = candidates.filter(({ measurement }) => measurement.gpu_name === newest.gpu_name
    && Math.abs(measurement.gpu_total_gb - newest.gpu_total_gb) < 0.1
    && measurement.buffers.backend === newest.buffers.backend
    && measurement.kernel_version === newest.kernel_version
    && measurement.buffers.parallel === newest.buffers.parallel);
  rejected += candidates.length - sameEnvironment.length;
  const rawErrors = sameEnvironment.map(({ record, prediction }) => record.vram_gb! - prediction.analyticalGb - prediction.empiricalGb);
  const acceptedErrors = robustValues(rawErrors, 0.25);
  const selected = sameEnvironment.filter((_, index) => acceptedErrors.includes(rawErrors[index]));
  rejected += sameEnvironment.length - selected.length;
  if (!selected.length) return emptyCalibration(rejected, legacy);
  // 全部候选都已按当前完整参数、ctx、GPU、内核筛选；最近这组同参数实测可直接作为总显存。
  const exactGb = median(selected.map(({ record }) => record.vram_gb!));
  const confidence = selected.length >= 3 ? 'measured' as const : 'limited' as const;
  const effectiveParallel = newest.buffers.parallel ?? (currentConfig.parallel > 0 ? currentConfig.parallel : undefined);

  const ratios = (kind: 'weights' | 'kv' | 'compute', min: number, max: number) => {
    const values: number[] = [];
    for (const { measurement, prediction } of selected) {
      const actual = measurement.buffers[`${kind}_gb`];
      const raw = kind === 'weights' ? prediction.rawWeightsGpuGb : kind === 'kv' ? prediction.rawKvGb : prediction.rawComputeGb;
      if (actual == null || !Number.isFinite(actual) || raw == null || raw <= 0.01) continue;
      if (kind === 'kv' && measurement.config.ctx_length !== current.ctx_length) continue;
      // 内核缓冲只有与对应分项一致才用于该分项；不把 fit、侧车或模型结构错误硬压成系数。
      if (kind !== 'compute' && (model.mmprojPath || currentConfig.speculativeDecoding !== 'off')) continue;
      const ratio = actual / raw;
      const floor = kind === 'weights' && prediction.weightSource !== 'file' ? 0.9 : min;
      if (ratio >= floor && ratio <= max) values.push(ratio);
    }
    const clean = robustValues(values, 0.08);
    return clean.length >= 2 ? median(clean) : undefined;
  };
  const weightsRatio = ratios('weights', 0.7, 1.15);
  const kvRatio = ratios('kv', 0.5, 1.5);
  const computeRatio = ratios('compute', 0.25, 4);
  const offsets: number[] = [];
  for (const { record, measurement, prediction } of selected) {
    if (measurement.config.ctx_length !== current.ctx_length) continue;
    const subtotal = prediction.rawWeightsGpuGb * (weightsRatio ?? 1)
      + prediction.rawKvGb! * (kvRatio ?? 1)
      + prediction.rawComputeGb * (computeRatio ?? 1) + prediction.rawRuntimeGb;
    const offset = record.vram_gb! - subtotal;
    if (offset >= -prediction.rawRuntimeGb && offset <= 2) offsets.push(offset);
  }
  const cleanOffsets = robustValues(offsets, 0.2);
  const runtimeOffsetGb = cleanOffsets.length >= 2 ? median(cleanOffsets) : undefined;
  if (weightsRatio == null && kvRatio == null && computeRatio == null && runtimeOffsetGb == null) {
    return {
      samples: selected.length, matched: true, rejected, legacy, confidence, exactGb, effectiveParallel,
    };
  }
  const residuals = selected.map(({ record, prediction }) => {
    const subtotal = prediction.rawWeightsGpuGb * (weightsRatio ?? 1) + prediction.rawKvGb! * (kvRatio ?? 1)
      + prediction.rawComputeGb * (computeRatio ?? 1) + Math.max(0, prediction.rawRuntimeGb + (runtimeOffsetGb ?? 0));
    return Math.abs(record.vram_gb! - subtotal);
  });
  const uncertaintyGb = residuals.length > 1 ? median(residuals) * 1.4826 + Math.max(...residuals) * 0.25 : undefined;
  return {
    weightsRatio, kvRatio, computeRatio, runtimeOffsetGb, uncertaintyGb,
    samples: selected.length, matched: true, rejected, legacy, confidence,
    exactGb, effectiveParallel,
  };
}
