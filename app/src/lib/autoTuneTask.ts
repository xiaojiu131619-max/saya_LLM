import type { ModelInfo, ModelLoadConfig } from '@/types';
import { modelVramSignature } from './vramMeasurement';
import type { AutoTuneConfig, AutoTuneExperiment, AutoTuneProgress, AutoTuneResult, AutoTuneStatus, AutoTuneStatusName, AutoTuneTerminalRecords, TuneFailure, TuneRecord } from './ipc/model';

export interface AutoTuneTask {
  runId: string;
  modelId: string;
  modelName: string;
  status: AutoTuneStatusName;
  log: string[];
  records: TuneRecord[];
  failures?: TuneFailure[];
  result?: AutoTuneResult;
  authorized: boolean;
  application: 'none' | 'pending' | 'applied' | 'conflict';
}
export interface AutoTuneAuthorization {
  config: AutoTuneConfig;
  modelName: string;
  modelPath: string;
  modelSignature: string;
  loadConfig: ModelLoadConfig;
}
interface Dependencies {
  start: (config: AutoTuneConfig) => Promise<void>;
  cancel: (runId: string) => Promise<void>;
  status?: () => Promise<AutoTuneStatus | null>;
  save: (authorization: AutoTuneAuthorization, experiment: AutoTuneExperiment) => Promise<void>;
}

/**
 * 参与加载/推理的配置项。
 *
 * `rememberSettings` / `showAdvancedSettings` / `idleAutoUnload*` 只是界面偏好，
 * 调参期间切换它们不该把结果判成「配置已变化」而丢弃。其余字段都会改变
 * 服务端行为，必须继续纳入一致性判断。
 */
const AUTO_TUNE_RELEVANT_KEYS: Array<keyof ModelLoadConfig> = [
  'ctxLength', 'gpuLayers', 'batchSize', 'physicalBatchSize', 'threads', 'parallel',
  'fastAttention', 'kvCache', 'kvUnified', 'mmap', 'mlock', 'noWarmup',
  'cacheTypeKEnabled', 'cacheTypeK', 'cacheTypeVEnabled', 'cacheTypeV',
  'ropeFreqBaseEnabled', 'ropeFreqBase', 'ropeFreqScaleEnabled', 'ropeFreqScale',
  'seedEnabled', 'seed', 'speculativeDecoding', 'specDraftNMaxEnabled', 'specDraftNMax',
  'chatTemplate', 'moeCpuLayers', 'reasoningBudget',
];

export function sameLoadConfig(left: ModelLoadConfig, right: ModelLoadConfig): boolean {
  return AUTO_TUNE_RELEVANT_KEYS.every((key) => left[key] === right[key]);
}
export function tuneRecordPatch(record: TuneRecord): Partial<ModelLoadConfig> {
  return {
    gpuLayers: record.ngl, ctxLength: record.ctx, moeCpuLayers: record.ncmoe,
    cacheTypeK: record.cache_type_k, cacheTypeV: record.cache_type_v,
    cacheTypeKEnabled: record.cache_type_k_enabled, cacheTypeVEnabled: record.cache_type_v_enabled,
  };
}
export function canApplyAutoTune(model: ModelInfo | undefined, authorization: AutoTuneAuthorization): boolean {
  return Boolean(model && model.id === authorization.config.model_id && model.filePath === authorization.modelPath
    && modelVramSignature(model) === authorization.modelSignature
    && sameLoadConfig(model.loadConfig, authorization.loadConfig));
}
export function autoTuneBusy(task: AutoTuneTask | null): boolean {
  return task?.status === 'running' || task?.status === 'stopping' || task?.application === 'pending';
}

// API key 只留在本次内存授权中；连失败详情引用到的密钥原文也不能写入实验记录。
export function sanitizedExperiment(authorization: AutoTuneAuthorization, task: AutoTuneTask, error?: string): AutoTuneExperiment {
  const secret = authorization.config.baseline.api_key;
  const scrub = (value: unknown): unknown => {
    if (typeof value === 'string') return secret ? value.split(secret).join('[已隐去密钥]') : value;
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, /api_?key|authorization|access_?token/i.test(key) ? null : scrub(item),
    ]));
    return value;
  };
  return scrub({
    version: 1, config: authorization.config, load_config: authorization.loadConfig,
    status: task.status, records: task.result?.records ?? task.records,
    best: task.result?.best, failures: task.result?.failures ?? task.failures, error,
  }) as AutoTuneExperiment;
}

/** 页面仅订阅此领域对象。授权永不从后端 status 或持久化数据反推。 */
export class AutoTuneTaskManager {
  private task: AutoTuneTask | null = null;
  private authorization: AutoTuneAuthorization | null = null;
  private listeners = new Set<() => void>();
  private revision = 0;
  private applicationDispatched = false;
  private applicationHandler?: (authorization: AutoTuneAuthorization, result: AutoTuneResult) => void;
  private saves: Promise<void> = Promise.resolve();
  private restoreBuffers = new Set<Array<() => void>>();
  private bufferTerminal(replay: () => void) {
    this.restoreBuffers.forEach((events) => events.push(replay));
  }
  private dependencies: Dependencies;
  constructor(dependencies: Dependencies) { this.dependencies = dependencies; }
  getSnapshot = () => this.task;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(task: AutoTuneTask) {
    this.task = task;
    this.revision += 1;
    this.listeners.forEach((listener) => listener());
  }
  private matches(runId: string, modelId: string) {
    return this.task?.runId === runId && this.task.modelId === modelId && (this.task.status === 'running' || this.task.status === 'stopping');
  }
  private append(message: string) { return [...(this.task?.log ?? []).slice(-119), message]; }
  setApplicationHandler(handler?: (authorization: AutoTuneAuthorization, result: AutoTuneResult) => void) {
    this.applicationHandler = handler;
    this.applyPending();
  }
  private applyPending() {
    if (!this.applicationDispatched && this.task?.application === 'pending' && this.authorization && this.task.result && this.applicationHandler) {
      this.applicationDispatched = true;
      this.applicationHandler(this.authorization, this.task.result);
    }
  }
  reportApplication(runId: string, applied: boolean) {
    if (!this.task || this.task.runId !== runId || this.task.application !== 'pending') return;
    this.publish({ ...this.task, application: applied ? 'applied' : 'conflict', log: this.append(applied
      ? '已自动应用最佳搜索参数；其他基线参数保持不变。'
      : '目标模型已移除、身份变化或加载配置已修改，未覆盖当前参数。') });
  }
  async start(authorization: AutoTuneAuthorization) {
    if (autoTuneBusy(this.task)) throw new Error('已有自动调参任务，必须等待终态后才能重启。');
    this.applicationDispatched = false;
    this.authorization = structuredClone(authorization);
    this.publish({ runId: authorization.config.run_id, modelId: authorization.config.model_id,
      modelName: authorization.modelName, status: 'running', authorized: true, application: 'none', records: [],
      log: [`正在调参：${authorization.modelName}。搜索 ctx / ngl / ncmoe / 独立 K/V，整卡显存预算 90%；其他参数使用开始时的完整基线。`,
        `基线：ctx=${authorization.config.baseline.n_ctx} ngl=${authorization.config.baseline.ngl} K/V=${authorization.config.baseline.cache_type_k_enabled ? authorization.config.baseline.cache_type_k : 'f16'}/${authorization.config.baseline.cache_type_v_enabled ? authorization.config.baseline.cache_type_v : 'f16'}。短负载实测不保证长对话或交互最优。`] });
    const request = structuredClone(authorization.config);
    request.baseline.api_key = null;
    try { await this.dependencies.start(request); }
    catch (error) { this.fail(authorization.config.run_id, authorization.config.model_id, `启动失败：${String(error)}`); throw error; }
  }
  async cancel() {
    const task = this.task;
    if (!task || (task.status !== 'running' && task.status !== 'stopping')) return;
    if (task.status !== 'stopping') this.publish({ ...task, status: 'stopping', log: this.append('正在停止调参，等待后端确认终态…') });
    try {
      await this.dependencies.cancel(task.runId);
      await this.reconcileCancellation(task.runId, task.modelId);
    } catch (error) {
      if (this.matches(task.runId, task.modelId)) this.publish({ ...this.task!, log: this.append(`停止请求失败，可重试停止：${String(error)}`) });
      await this.reconcileCancellation(task.runId, task.modelId);
      throw error;
    }
  }
  private async reconcileCancellation(runId: string, modelId: string) {
    const getStatus = this.dependencies.status;
    if (!getStatus || !this.matches(runId, modelId)) return;
    try {
      await this.restore(async () => {
        const status = await getStatus();
        if (!status && this.matches(runId, modelId)) {
          this.cancelled(runId, modelId, '后端确认已无调参任务，停止状态已对账。');
        }
        return status;
      });
    } catch (error) {
      if (this.matches(runId, modelId)) this.publish({ ...this.task!, log: this.append(`停止状态对账失败，可重试停止：${String(error)}`) });
    }
  }
  progress(progress: AutoTuneProgress) {
    if (!this.matches(progress.run_id, progress.model_id)) return;
    const task = this.task!;
    const record = progress.record;
    const records = record && !task.records.some((item) => JSON.stringify(item) === JSON.stringify(record)) ? [...task.records, record] : task.records;
    this.publish({ ...task, records, log: this.append(progress.message) });
  }
  done(result: AutoTuneResult) {
    this.bufferTerminal(() => this.done(result));
    if (!this.matches(result.run_id, result.model_id)) return;
    const stopping = this.task!.status === 'stopping';
    this.publish({ ...this.task!, status: 'done', result, records: result.records,
      application: this.authorization && !stopping ? 'pending' : 'none',
      log: this.append(stopping ? '任务已结束；已请求停止，不自动应用结果。' : `调参完成：ctx=${result.best.ctx} ngl=${result.best.ngl} K/V=${result.best.cache_type_k}/${result.best.cache_type_v}，${result.best.ts.toFixed(1)} tok/s，${result.best.vram_available ? `显存 ${(result.best.vram_percent * 100).toFixed(0)}%` : '显存未知，无法验证 90% 预算'}。`) });
    this.persist();
    this.applyPending();
  }
  fail(runId: string, modelId: string, error: string, terminal?: AutoTuneTerminalRecords) {
    this.bufferTerminal(() => this.fail(runId, modelId, error, terminal));
    if (!this.matches(runId, modelId)) return;
    this.publish({ ...this.task!, records: terminal?.records ?? this.task!.records, failures: terminal?.failures ?? this.task!.failures, status: 'error', log: this.append(`自动调参失败：${error}`) });
    this.persist(error);
  }
  cancelled(runId: string, modelId: string, message: string, terminal?: AutoTuneTerminalRecords) {
    this.bufferTerminal(() => this.cancelled(runId, modelId, message, terminal));
    if (!this.matches(runId, modelId)) return;
    this.publish({ ...this.task!, records: terminal?.records ?? this.task!.records, failures: terminal?.failures ?? this.task!.failures, status: 'cancelled', log: this.append(message || '调参已停止。') });
    this.persist();
  }
  private persist(error?: string) {
    if (!this.authorization || !this.task?.authorized) return;
    const authorization = structuredClone(this.authorization);
    const task = this.task;
    const experiment = sanitizedExperiment(authorization, task, error);
    this.saves = this.saves.then(() => this.dependencies.save(authorization, experiment)).catch((failure) => {
      if (this.task?.runId === task.runId) this.publish({ ...this.task, log: this.append(`实验记录保存失败：${String(failure)}`) });
    });
  }
  waitForSaves() { return this.saves; }
  clearLog() { if (this.task && !autoTuneBusy(this.task)) this.publish({ ...this.task, log: [] }); }
  async restore(getStatus: () => Promise<AutoTuneStatus | null>) {
    const revision = this.revision;
    const events: Array<() => void> = [];
    this.restoreBuffers.add(events);
    try {
      const status = await getStatus();
      if (!status || revision !== this.revision) return;
      if (this.task?.runId === status.run_id && this.task.modelId === status.model_id) {
        if (!autoTuneBusy(this.task)) return;
        if (status.status === 'done' && status.result) this.done(status.result);
        else if (status.status === 'cancelled') this.cancelled(status.run_id, status.model_id, '调参已停止。', status);
        else if (status.status === 'error') this.fail(status.run_id, status.model_id, status.error ?? '未知错误', status);
        else if (status.status === 'running' || status.status === 'stopping') this.publish({ ...this.task, status: this.task.status === 'stopping' ? 'stopping' : status.status, records: status.records, failures: status.failures });
        return;
      }
      if (autoTuneBusy(this.task)) return;
      this.authorization = null;
      this.publish({ runId: status.run_id, modelId: status.model_id, modelName: status.model_id,
        status: status.status, records: status.result?.records ?? status.records, failures: status.failures, result: status.result,
        authorized: false, application: 'none', log: ['已恢复后端任务状态；缺少本次手动启动授权与配置快照，不会自动应用旧任务结果。'] });
    } finally {
      this.restoreBuffers.delete(events);
      events.forEach((replay) => replay());
    }
  }
}
