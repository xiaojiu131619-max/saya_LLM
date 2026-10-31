import { AutoTuneTaskManager, autoTuneBusy } from './autoTuneTask';
import { cancelAutoTune, getAutoTuneStatus, saveModelRunRecord, saveTuneResult, startAutoTune } from './ipc/model';
import type { AutoTuneCancelled, AutoTuneError, AutoTuneProgress, AutoTuneResult } from './ipc/model';
import { listenDesktopEvent } from './ipc/system';
import { isDesktopRuntime } from './desktopRuntime';

export const autoTuneManager = new AutoTuneTaskManager({
  start: startAutoTune,
  cancel: cancelAutoTune,
  status: getAutoTuneStatus,
  save: async (authorization, experiment) => {
    const best = experiment.best;
    await saveModelRunRecord({
      model_id: authorization.config.model_id, model_name: authorization.modelName,
      kind: 'autotune', timestamp: Math.floor(Date.now() / 1000),
      ngl: best?.ngl, ctx: best?.ctx, kv: best?.kv, ncmoe: best?.ncmoe,
      tokens_per_sec: best?.ts, first_token_ms: best?.first_token_ms,
      autotune: experiment,
      note: `自动调参${experiment.status === 'done' ? '完成' : experiment.status === 'cancelled' ? '已停止' : '失败'} · 短负载实测，不保证交互最优${best ? best.vram_available ? ` · 显存 ${(best.vram_percent * 100).toFixed(0)}%` : ' · 显存未知，无法验证 90% 预算' : ''}`,
    });
    recordsListeners.forEach((listener) => listener(authorization.config.model_id));
    if (best) await saveTuneResult({
      model_name: authorization.modelName, model_path: authorization.modelPath,
      ngl: best.ngl, ctx: best.ctx, kv: best.kv, ncmoe: best.ncmoe,
      ts: best.ts, vram_percent: best.vram_percent, sort_mode: authorization.config.sort_mode,
      timestamp: Math.floor(Date.now() / 1000),
    });
  },
});
const recordsListeners = new Set<(modelId: string) => void>();
export function subscribeAutoTuneRecords(listener: (modelId: string) => void) {
  recordsListeners.add(listener);
  return () => { recordsListeners.delete(listener); };
}

let initialized: Promise<void> | null = null;
/** 应用进程生命周期内只安装一组监听，页面卸载不释放。全部注册后才允许 start。 */
export function ensureAutoTuneRuntime(): Promise<void> {
  if (!isDesktopRuntime()) return Promise.resolve();
  if (initialized) return initialized;
  initialized = (async () => {
    const unlisteners: Array<() => void> = [];
    try {
      unlisteners.push(await listenDesktopEvent<AutoTuneProgress>('autotune:progress', (value) => autoTuneManager.progress(value)));
      unlisteners.push(await listenDesktopEvent<AutoTuneResult>('autotune:done', (value) => autoTuneManager.done(value)));
      unlisteners.push(await listenDesktopEvent<AutoTuneError>('autotune:error', (value) => autoTuneManager.fail(value.run_id, value.model_id, value.error, value)));
      unlisteners.push(await listenDesktopEvent<AutoTuneCancelled>('autotune:cancelled', (value) => autoTuneManager.cancelled(value.run_id, value.model_id, value.message, value)));
      await autoTuneManager.restore(getAutoTuneStatus);
    } catch (error) {
      unlisteners.forEach((unlisten) => unlisten());
      initialized = null;
      throw error;
    }
  })();
  return initialized;
}

export function assertNoAutoTune() {
  if (autoTuneBusy(autoTuneManager.getSnapshot())) throw new Error('自动调参仍在运行或停止中，请先在模型参数页停止调参并等待终态。');
}
