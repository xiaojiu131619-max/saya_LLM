import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Boxes, Layers } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import { checkDesktopEngine, getDesktopServerLogs, getDesktopVramSnapshot, getServerApiKey, isDesktopRuntime, listenDesktopEvent, startDesktopServer, stopDesktopServer } from '@/lib/desktop';
import type { AutoTuneConfig, AutoTuneProgress, AutoTuneResult, TuneRecord } from '@/lib/desktop';
import { cancelAutoTune, saveTuneResult, startAutoTune } from '@/lib/desktop';
import { computeVramCalibration } from '@/lib/vramCalibration';
import { predictVramUsage } from '@/lib/vramEstimate';
import { assessVramMeasurement, modelVramSignature, parseVramBuffers, summarizeVramSamples, vramMeasurementConfig, type VramSnapshot } from '@/lib/vramMeasurement';
import { saveModelRunRecord, getModelRunRecords, type ModelRunRecord } from '@/lib/desktop';
import type { ModelInfo, ModelLoadConfig } from '@/types';
import { RECOMMENDED_CTX_LENGTH, maxGpuLayers, recommendedGpuLayers, recommendedReasoningBudget } from '@/lib/modelDefaults';
import ModelLoadView from '@/features/model/ModelLoadView';
import { suggestedApiName } from '@/lib/modelIdentity';

function defaultModelLoadConfig(model: ModelInfo): ModelLoadConfig {
  return {
    ctxLength: RECOMMENDED_CTX_LENGTH,
    gpuLayers: recommendedGpuLayers(model.blockCount),
    batchSize: 512,
    physicalBatchSize: 512,
    threads: -1,
    parallel: -1,
    fastAttention: true,
    kvCache: true,
    kvUnified: true,
    mmap: true,
    mlock: false,
    noWarmup: false,
    cacheTypeKEnabled: false,
    cacheTypeK: 'f16',
    cacheTypeVEnabled: false,
    cacheTypeV: 'f16',
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
    moeCpuLayers: 0,
    reasoningBudget: recommendedReasoningBudget(model.tags.includes('Reasoning')),
  };
}

export default function ModelLoadPage() {
  const { state, dispatch } = useApp();
  const model = state.models.find((m) => m.id === state.selectedModelId);
  const [activeTab, setActiveTab] = useState<'params' | 'info'>('params');
  const [isLoading, setIsLoading] = useState(false);
  const [loadProgress, setLoadProgress] = useState<string | null>(null);
  const [loadProgressPercent, setLoadProgressPercent] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const cancelLoadRef = useRef<(() => void) | null>(null);
  const [autoTuneRunning, setAutoTuneRunning] = useState(false);
  const [autoTuneLog, setAutoTuneLog] = useState<string[]>([]);
  const [autoTuneApplied, setAutoTuneApplied] = useState(false);
  // API 调用名草稿：输入过程中不落库，失焦/回车才算「输入结束」并保存。
  const [apiNameDraft, setApiNameDraft] = useState<string | null>(null);
  const [logoMessage, setLogoMessage] = useState<string | null>(null);
  const modelId = model?.id;
  const [runRecords, setRunRecords] = useState<ModelRunRecord[]>([]);
  const [kernelVersion, setKernelVersion] = useState<string | null>(null);
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let cancelled = false;
    void checkDesktopEngine().then((info) => {
      if (!cancelled) setKernelVersion(info?.llama_server_version ?? null);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  const refreshRunRecords = useCallback(() => {
    if (!modelId) return;
    void getModelRunRecords(modelId).then((records) => setRunRecords(records)).catch(() => undefined);
  }, [modelId]);
  const gpuName = state.systemStats.gpuName;
  const vramTotal = state.systemStats.vramTotal;
  const calibration = useMemo(
    () => (model ? computeVramCalibration(model, runRecords, model.loadConfig, { gpuName, vramTotal, kernelVersion }) : null),
    [model, runRecords, gpuName, vramTotal, kernelVersion],
  );

  // 调参自动应用：事件监听闭包只建一次，通过 ref 拿到最新的应用函数与
  // 调参开始时的模型，避免中途切换模型后把参数套错对象。
  const autoTuneModelRef = useRef<ModelInfo | null>(null);
  const applyTuneRef = useRef<(record: TuneRecord, target?: ModelInfo) => void>(() => {});

  // 自动调参进度事件监听（组件生命周期内常驻）。
  useEffect(() => {
    if (!isDesktopRuntime()) return undefined;
    const unlisteners: Array<() => void> = [];
    void listenDesktopEvent<AutoTuneProgress>('autotune:progress', (progress) => {
      setAutoTuneLog((log) => [...log.slice(-59), progress.message]);
    }).then((unlisten) => unlisteners.push(unlisten));
    void listenDesktopEvent<AutoTuneResult>('autotune:done', (result) => {
      setAutoTuneRunning(false);
      setAutoTuneLog((log) => [...log, `调参完成，最佳：ngl=${result.best.ngl} ctx=${result.best.ctx} kv=${result.best.kv} ts=${result.best.ts.toFixed(1)}`]);
      // 调参结束自动应用最优参数（针对开始调参时的那个模型）。
      const tuned = autoTuneModelRef.current;
      if (tuned) applyTuneRef.current(result.best, tuned);
    }).then((unlisten) => unlisteners.push(unlisten));
    void listenDesktopEvent<{ error: string }>('autotune:error', (payload) => {
      setAutoTuneLog((log) => [...log, `自动调参失败：${payload.error}`]);
      setAutoTuneRunning(false);
    }).then((unlisten) => unlisteners.push(unlisten));
    void listenDesktopEvent<{ message?: string }>('autotune:cancelled', () => {
      setAutoTuneRunning(false);
      setAutoTuneLog((log) => [...log, '调参已停止。']);
    }).then((unlisten) => unlisteners.push(unlisten));
    return () => unlisteners.forEach((unlisten) => unlisten());
  }, []);

  // 进入页面时读取本模型的运行记录；应用调参结果后也会刷新。
  useEffect(() => {
    refreshRunRecords();
  }, [refreshRunRecords]);

  // 头像库：点击头像弹出内置 logo 库选择，不再支持上传图片。
  // 必须声明在下面 `if (!model)` 提前返回之前：Hook 调用顺序不能依赖条件，
  // 否则 model 从「无」变「有」时 Hook 数量变化，React 会直接抛错。
  const [logoLibraryOpen, setLogoLibraryOpen] = useState(false);

  if (!model) {
    return (
      <div className="flex h-full flex-1 items-center justify-center bg-[var(--app-bg)] dark:bg-[var(--app-bg)]">
        <p className="text-sm text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">未选择模型</p>
      </div>
    );
  }

  const handleChangeLogo = () => {
    setLogoLibraryOpen(true);
  };

  const handleSelectLibraryLogo = (customLogo: string) => {
    dispatch({ type: 'SET_MODEL_CUSTOM_LOGO', payload: { modelId: model.id, customLogo } });
    setLogoMessage('已更新模型头像。');
    setLogoLibraryOpen(false);
  };

  const handleClearLogo = () => {
    dispatch({ type: 'SET_MODEL_CUSTOM_LOGO', payload: { modelId: model.id, customLogo: undefined } });
    setLogoMessage('已恢复默认品牌图标。');
  };

  const updateConfig = (key: string, value: unknown) => {
    dispatch({
      type: 'UPDATE_MODEL_CONFIG',
      payload: { modelId: model.id, config: { [key]: value } },
    });
  };

  const handleLoad = async () => {
    if (isDesktopRuntime() && model.filePath) {
      const unlisteners: Array<() => void> = [];
      cancelLoadRef.current = null;
      setIsLoading(true);
      setLoadError(null);
      setLoadProgressPercent(4);
      setLoadProgress('正在启动 llama-server...');
      dispatch({ type: 'UPDATE_MODEL_STATUS', payload: { modelId: model.id, status: 'loading' } });

      const launchConfig = { ...model.loadConfig };
      const launchModel = { ...model, loadConfig: launchConfig };
      let cancelled = false;
      let rejectCancellation: (error: Error) => void = () => {};
      const cancellation = new Promise<never>((_, reject) => { rejectCancellation = reject; });
      void cancellation.catch(() => undefined);
      cancelLoadRef.current = () => {
        cancelled = true;
        rejectCancellation(new Error('__load_cancelled__'));
      };
      const assertLoading = () => {
        if (cancelled) throw new Error('__load_cancelled__');
      };
      const sampleVram = async () => {
        const samples: VramSnapshot[] = [];
        for (let index = 0; index < 3; index += 1) {
          assertLoading();
          const snapshot = await Promise.race([getDesktopVramSnapshot().catch(() => null), cancellation]);
          if (snapshot) samples.push(snapshot);
          if (index < 2) await Promise.race([new Promise((resolve) => setTimeout(resolve, 500)), cancellation]);
        }
        return summarizeVramSamples(samples);
      };
      try {
        setLoadProgress('正在卸载旧实例并采集显存基线…');
        await Promise.race([stopDesktopServer(), cancellation]);
        await Promise.race([new Promise((resolve) => setTimeout(resolve, 1200)), cancellation]);
        const engineInfo = checkDesktopEngine().catch(() => null);
        const baseline = await sampleVram();
        assertLoading();
        let resolveReady: () => void = () => {};
        let rejectReady: (error: Error) => void = () => {};
        const ready = new Promise<void>((resolve, reject) => {
          resolveReady = resolve;
          rejectReady = reject;
        });
        void ready.catch(() => undefined);
        await Promise.all([
          listenDesktopEvent<{ message?: string }>('server:ready', () => resolveReady()).then((unlisten) => unlisteners.push(unlisten)),
          listenDesktopEvent<{ title?: string; details?: string }>('server:error', (error) => {
            const title = error.title?.trim();
            const details = error.details?.trim();
            const message = title && details && !details.includes(title)
              ? `${title}：${details}`
              : details || title || 'llama-server 启动失败';
            rejectReady(new Error(message));
          }).then((unlisten) => unlisteners.push(unlisten)),
          listenDesktopEvent<{ progress: number; stage: string; log: string }>('server:progress', (progress) => {
            setLoadProgressPercent(Math.min(100, Math.max(0, progress.progress)));
            setLoadProgress(progress.stage);
          }).then((unlisten) => unlisteners.push(unlisten)),
        ]);
        assertLoading();
        setLoadProgress('正在启动 llama-server…');
        await Promise.race([startDesktopServer(launchModel, state.serverPort, 'resources/llama-server.exe', state.apiConfig, state.chatConfig.enabledTools), cancellation]);
        setLoadProgressPercent((current) => Math.max(current, 12));
        await Promise.race([ready, cancellation]);

        setLoadProgress('API 已就绪，正在记录显存采样…');
        const loaded = await sampleVram();
        const logs = await Promise.race([getDesktopServerLogs().catch(() => []), cancellation]);
        const buffers = parseVramBuffers(logs);
        const assessment = assessVramMeasurement({ model: launchModel, config: launchConfig, baseline, loaded, buffers });
        const engine = await Promise.race([engineInfo, cancellation]);
        const measuredKernelVersion = engine?.llama_server_version ?? null;
        setKernelVersion(measuredKernelVersion);
        const prediction = predictVramUsage(launchModel, launchConfig, undefined, {
          kernelVersion: measuredKernelVersion, effectiveParallel: buffers.parallel,
        });
        assertLoading();
        await saveModelRunRecord({
          model_id: model.id,
          model_name: model.name,
          kind: 'launch',
          timestamp: Math.floor(Date.now() / 1000),
          ngl: launchConfig.gpuLayers,
          ctx: launchConfig.ctxLength,
          kv: launchConfig.cacheTypeKEnabled ? launchConfig.cacheTypeK : 'f16',
          ncmoe: launchConfig.moeCpuLayers > 0 ? launchConfig.moeCpuLayers : null,
          flash_attn: launchConfig.fastAttention,
          speculative: launchConfig.speculativeDecoding,
          vram_gb: assessment.quality === 'stable' ? assessment.actualGb : null,
          vram_predicted_gb: prediction.totalGb,
          vram_measurement: {
            version: 1,
            model_signature: modelVramSignature(launchModel),
            gpu_name: loaded?.gpu_name ?? baseline?.gpu_name ?? '',
            gpu_total_gb: loaded?.gpu_total_gb ?? baseline?.gpu_total_gb ?? 0,
            kernel_version: measuredKernelVersion,
            config: vramMeasurementConfig(launchConfig),
            baseline_gb: baseline?.used_gb ?? null,
            loaded_gb: loaded?.used_gb ?? null,
            baseline_spread_gb: baseline?.spread_gb ?? null,
            loaded_spread_gb: loaded?.spread_gb ?? null,
            quality: assessment.quality,
            buffers,
          },
          note: assessment.note,
        }).catch(() => undefined);
        assertLoading();
        refreshRunRecords();

        if (state.apiConfig.enabled) {
          const activeApiKey = await getServerApiKey().catch(() => null);
          dispatch({
            type: 'SET_API_CONFIG',
            payload: {
              hasApiKey: Boolean(activeApiKey),
              apiKey: activeApiKey ?? undefined,
            },
          });
        }

        assertLoading();
        setLoadProgressPercent(100);
        if (launchConfig.rememberSettings) {
          dispatch({ type: 'REMEMBER_MODEL_LAUNCH_CONFIG', payload: { modelId: model.id, config: launchConfig } });
        }
        dispatch({ type: 'MARK_MODEL_RECENTLY_USED', payload: { modelId: model.id } });
        dispatch({ type: 'UPDATE_MODEL_STATUS', payload: { modelId: model.id, status: 'loaded' } });
        dispatch({ type: 'SET_ACTIVE_MODEL', payload: model.id });
        dispatch({ type: 'SET_SERVER_RUNNING', payload: true });
        dispatch({ type: 'SET_VIEW', payload: 'chat' });
      } catch (error) {
        if (error instanceof Error && error.message === '__load_cancelled__') {
          setLoadError('加载已停止。');
          dispatch({ type: 'UPDATE_MODEL_STATUS', payload: { modelId: model.id, status: 'standby' } });
          dispatch({ type: 'SET_SERVER_RUNNING', payload: false });
          return;
        }
        const message = String(error instanceof Error ? error.message : error);
        setLoadError(message);
        dispatch({ type: 'UPDATE_MODEL_STATUS', payload: { modelId: model.id, status: 'error' } });
      } finally {
        unlisteners.forEach((unlisten) => unlisten());
        cancelLoadRef.current = null;
        setIsLoading(false);
      }
      return;
    }

    setLoadError('只能在桌面版中加载带有真实 GGUF 文件路径的本地模型。');
    dispatch({ type: 'UPDATE_MODEL_STATUS', payload: { modelId: model.id, status: 'error' } });
  };

  const handleStopLoading = async () => {
    if (!isLoading) return;
    setLoadProgress('正在停止加载...');
    setLoadProgressPercent((current) => Math.max(current, 1));
    cancelLoadRef.current?.();
    try {
      await stopDesktopServer();
    } catch (error) {
      setLoadError(`停止失败：${String(error)}`);
      return;
    }
    dispatch({ type: 'UPDATE_MODEL_STATUS', payload: { modelId: model.id, status: 'standby' } });
    dispatch({ type: 'SET_SERVER_RUNNING', payload: false });
  };

  const startAutoTuneRun = async () => {
    if (!isDesktopRuntime() || autoTuneRunning || isLoading) return;
    setAutoTuneRunning(true);
    setAutoTuneLog([]);
    setAutoTuneApplied(false);
    autoTuneModelRef.current = model;
    try {
      const tuneConfig: AutoTuneConfig = {
        executable_path: 'resources/llama-server.exe',
        model_path: model.filePath ?? '',
        port: state.serverPort,
        // 自动调参以该值作为 ngl 起点（后端直接用 total_layers 当 -ngl 传），
        // 必须给含输出层的满档值，否则调参始终跑在少一层的最慢配置上。
        total_layers: maxGpuLayers(model.blockCount),
        expert_count: Math.max(0, model.expertCount ?? 0),
        max_ctx: Math.max(512, model.ctxLength || RECOMMENDED_CTX_LENGTH),
        batch_size: config.batchSize,
        flash_attn: config.fastAttention,
        kv_offload: config.kvCache,
        mmap: config.mmap,
        mlock: config.mlock,
        is_moe: model.modelType === 'moe',
        sort_mode: 'ts',
      };
      await startAutoTune(tuneConfig);
    } catch (error) {
      setAutoTuneLog((log) => [...log, `自动调参启动失败：${String(error)}`]);
      setAutoTuneRunning(false);
    }
  };

  const stopAutoTuneRun = async () => {
    if (!autoTuneRunning) return;
    setAutoTuneLog((log) => [...log, '正在停止调参...']);
    try {
      await cancelAutoTune();
    } catch {
      // 取消命令失败时等待后端事件兜底
    }
    setAutoTuneRunning(false);
  };

  const applyTuneRecord = (record: TuneRecord, target: ModelInfo = model) => {
    const next: Partial<ModelLoadConfig> = {
      gpuLayers: record.ngl,
      ctxLength: record.ctx,
      moeCpuLayers: record.ncmoe,
      cacheTypeKEnabled: record.kv !== 'f16',
      cacheTypeK: record.kv,
      cacheTypeVEnabled: record.kv !== 'f16',
      cacheTypeV: record.kv,
    };
    dispatch({
      type: 'UPDATE_MODEL_CONFIG',
      payload: { modelId: target.id, config: next },
    });
    setAutoTuneApplied(true);
    if (isDesktopRuntime()) {
      void saveTuneResult({
        model_name: target.name,
        model_path: target.filePath ?? '',
        ngl: record.ngl,
        ctx: record.ctx,
        kv: record.kv,
        ncmoe: record.ncmoe,
        ts: record.ts,
        vram_percent: record.vram_percent,
        sort_mode: 'ts',
        timestamp: Math.floor(Date.now() / 1000),
      }).catch(() => undefined);
      // 调参结果同时写入独立运行记录，供后续推荐与调参对比。
      void saveModelRunRecord({
        model_id: target.id,
        model_name: target.name,
        kind: 'autotune',
        timestamp: Math.floor(Date.now() / 1000),
        ngl: record.ngl,
        ctx: record.ctx,
        kv: record.kv,
        ncmoe: record.ncmoe > 0 ? record.ncmoe : null,
        tokens_per_sec: record.ts,
        note: `自动调参 · 显存 ${record.vram_percent.toFixed(0)}%`,
      }).catch(() => undefined);
      refreshRunRecords();
    }
  };
  applyTuneRef.current = applyTuneRecord;

  const config = model.loadConfig;
  const vramPrediction = predictVramUsage(
    model,
    config,
    calibration && calibration.samples > 0 ? calibration : undefined,
    { kernelVersion, effectiveParallel: calibration?.effectiveParallel },
  );

  // 向量 / 重排模型不走对话加载链路（--embeddings 与对话参数语义冲突）：
  // 单独引导到「向量服务」页，用独立端口与独立进程启动，可与对话/VLM 并行。
  if (model.modelTask === 'embedding' || model.modelTask === 'rerank') {
    const isRerank = model.modelTask === 'rerank';
    return (
      <div className="flex h-full flex-1 items-center justify-center overflow-y-auto bg-[var(--app-bg)] px-4 py-8">
        <div className="w-full max-w-xl rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-6 text-center dark:border-white/[0.08] dark:bg-white/[0.03]">
          <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-xl bg-[var(--accent-subtle)] text-[var(--accent)]">
            {isRerank ? <Layers className="h-6 w-6" /> : <Boxes className="h-6 w-6" />}
          </div>
          <h2 className="text-base font-semibold text-[var(--text-primary)]">
            {isRerank ? '这是一个重排（Rerank）模型' : '这是一个向量嵌入（Embedding）模型'}
          </h2>
          <p className="mx-auto mt-2 max-w-md text-xs leading-6 text-[var(--text-secondary)]">
            向量与重排模型不使用对话 / 补全加载参数（KV 量化、投机解码、工具模板对它无意义），
            而是在独立的「向量服务」里以 <span className="mono-font">--embeddings</span>
            {isRerank ? ' 与 ' : ' / '}<span className="mono-font">--rerank</span> 启动。
            它与对话 / VLM 模型使用不同端口，可同时运行，互不影响。
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-3 text-[11px] text-[var(--text-tertiary)]">
            <span>{model.architecture ?? '未知架构'}</span>
            <span>·</span>
            <span>{model.params} · {model.quant}</span>
            {model.poolingType && <><span>·</span><span className="mono-font">pooling {model.poolingType}</span></>}
          </div>
          <button
            type="button"
            onClick={() => dispatch({ type: 'SET_VIEW', payload: 'embedding' })}
            className="mt-5 inline-flex h-9 items-center gap-2 rounded-lg bg-[var(--accent)] px-4 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-hover)]"
          >
            <Boxes className="h-4 w-4" />
            前往向量服务
          </button>
        </div>
      </div>
    );
  }

  return (
    <ModelLoadView
      model={model}
      prediction={vramPrediction}
      calibration={calibration}
      systemStats={state.systemStats}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      isLoading={isLoading}
      loadMessage={loadProgress}
      loadError={loadError}
      loadPercent={loadProgressPercent}
      statusMessage={logoMessage}
      autoTuneRunning={autoTuneRunning}
      autoTuneLog={autoTuneLog}
      autoTuneApplied={autoTuneApplied}
      runRecords={runRecords}
      onClearLog={() => setAutoTuneLog([])}
      onChangeConfig={updateConfig}
      onLoad={() => void handleLoad()}
      onStop={() => void handleStopLoading()}
      onReset={() => dispatch({ type: 'UPDATE_MODEL_CONFIG', payload: { modelId: model.id, config: defaultModelLoadConfig(model) } })}
      onAutoTune={() => void startAutoTuneRun()}
      onStopAutoTune={() => void stopAutoTuneRun()}
      apiName={apiNameDraft ?? model.apiName ?? ''}
      apiNamePlaceholder={suggestedApiName(model)}
      onApiNameChange={setApiNameDraft}
      onApiNameCommit={() => {
        if (apiNameDraft == null) return;
        dispatch({ type: 'SET_MODEL_API_NAME', payload: { modelId: model.id, apiName: apiNameDraft.trim() } });
        setApiNameDraft(null);
      }}
      logoLibraryOpen={logoLibraryOpen}
      onChangeLogo={handleChangeLogo}
      onSelectLogo={handleSelectLibraryLogo}
      onClearLogo={handleClearLogo}
      onCloseLogo={() => setLogoLibraryOpen(false)}
    />
  );
}
