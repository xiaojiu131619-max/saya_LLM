import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, RotateCcw, Box, Boxes, Layers, BarChart3, Calendar, FileText, Hash, Cpu, Database, Gauge, HardDrive, History, Info, Square, ChevronRight, Settings2, Wand2 } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import { getServerApiKey, getDesktopSystemStats, isDesktopRuntime, listenDesktopEvent, startDesktopServer, stopDesktopServer } from '@/lib/desktop';
import type { AutoTuneConfig, AutoTuneProgress, AutoTuneResult, TuneRecord } from '@/lib/desktop';
import { cancelAutoTune, saveTuneResult, startAutoTune } from '@/lib/desktop';
import { computeVramCalibration } from '@/lib/vramCalibration';
import { predictVramUsage, type VramPrediction } from '@/lib/vramEstimate';
import { saveModelRunRecord, getModelRunRecords, type ModelRunRecord } from '@/lib/desktop';
import type { ModelInfo, ModelLoadConfig } from '@/types';
import type { LucideIcon } from 'lucide-react';
import { DEFAULT_GPU_LAYERS_WHEN_UNKNOWN, RECOMMENDED_CTX_LENGTH, recommendedGpuLayers, recommendedReasoningBudget } from '@/lib/modelDefaults';
import ModelFamilyLogo from '@/components/ModelFamilyLogo';
import { suggestedApiName } from '@/lib/modelIdentity';
import { MODEL_LOGO_LIBRARY, LOBEHUB_CUSTOM_PREFIX } from '@/lib/modelLogo';

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

function formatNumber(value?: number) {
  return value && value > 0 ? value.toLocaleString() : '未读取';
}

function fileNameFromPath(path: string) {
  const slash = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return slash >= 0 ? path.slice(slash + 1) : path;
}

function formatCtx(value: number) {
  if (!value) return '未读取';
  return value >= 1000 ? `${(value / 1000).toFixed(0)}K` : value.toLocaleString();
}

function formatPair(left?: number, right?: number) {
  if (!left && !right) return '未读取';
  return `${formatNumber(left)} / ${formatNumber(right)}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function truncateValue(value: string) {
  return value.length > 160 ? `${value.slice(0, 157)}...` : value;
}

function formatGb(value: number) {
  return `${value.toFixed(value >= 10 ? 1 : 2)} GB`;
}

function formatModelType(type: ModelInfo['modelType']) {
  return type === 'moe' ? 'MoE' : '稠密';
}

function formatTag(tag: string) {
  const labels: Record<string, string> = {
    Local: '本地',
    Reasoning: '推理',
    'Split GGUF': '分片 GGUF',
  };
  return labels[tag] ?? tag;
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
  // 显存校准从该模型的运行记录派生：每条带实测显存的启动记录都参与修正
  // 「计算暂存 + 运行时」经验项（详见 vramCalibration.ts）。启动成功写入
  // 新记录后 refreshRunRecords 会自动带出最新校准。
  const modelId = model?.id;
  const [runRecords, setRunRecords] = useState<ModelRunRecord[]>([]);
  const refreshRunRecords = useCallback(() => {
    if (!modelId) return;
    void getModelRunRecords(modelId).then((records) => setRunRecords(records)).catch(() => undefined);
  }, [modelId]);
  const calibration = useMemo(
    () => (model ? computeVramCalibration(model, runRecords, model.loadConfig) : null),
    [model, runRecords],
  );
  const calibrationRatio = calibration?.scratchRatio ?? calibration?.overallRatio ?? 1;
  const calibrationSamples = calibration?.samples ?? 0;
  // 分项校准只作用于「计算 + 运行」经验项；整体兜底校准缩放总预测，分项 pills 不缩放。
  const calibrationIsScratch = calibration?.scratchRatio != null;

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

  if (!model) {
    return (
      <div className="flex h-full flex-1 items-center justify-center bg-[var(--app-bg)] dark:bg-[var(--app-bg)]">
        <p className="text-sm text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">未选择模型</p>
      </div>
    );
  }

  // 头像库：点击头像弹出内置 logo 库选择，不再支持上传图片。
  const [logoLibraryOpen, setLogoLibraryOpen] = useState(false);
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

      try {
        // 显存校准基线：加载前实测 used，就绪后再读一次，差值即本模型真实占用。
        // 基线必须在旧实例卸载之后读取——先显式停掉仍在运行的 server 并等显存
        // 回落，否则上一次加载的占用会串进差值，实测被压成几 GB 的脏数据。
        let vramBaseline: number | null = null;
        if (isDesktopRuntime()) {
          await stopDesktopServer().catch(() => undefined);
          await new Promise((resolve) => setTimeout(resolve, 1200));
          vramBaseline = (await getDesktopSystemStats(state.systemStats).catch(() => null))?.vramUsed ?? null;
        }
        const ready = new Promise<void>((resolve, reject) => {
          void listenDesktopEvent<{ message?: string }>('server:ready', () => resolve())
            .then((unlisten) => unlisteners.push(unlisten));
          void listenDesktopEvent<{ title?: string; details?: string }>('server:error', (error) => {
            reject(new Error(error.title || error.details || 'llama-server 启动失败'));
          }).then((unlisten) => unlisteners.push(unlisten));
          void listenDesktopEvent<{ progress: number; stage: string; log: string }>('server:progress', (progress) => {
            setLoadProgressPercent(clamp(progress.progress, 0, 100));
            setLoadProgress(`${progress.progress}% · ${progress.stage}`);
          }).then((unlisten) => unlisteners.push(unlisten));
        });
        const cancelled = new Promise<never>((_, reject) => {
          cancelLoadRef.current = () => reject(new Error('__load_cancelled__'));
        });

        await startDesktopServer(model, state.serverPort, 'resources/llama-server.exe', state.apiConfig, state.chatConfig.enabledTools);
        setLoadProgressPercent((current) => Math.max(current, 12));
        await Promise.race([ready, cancelled]);

        if (isDesktopRuntime() && vramBaseline != null) {
          const after = await getDesktopSystemStats(state.systemStats).catch(() => null);
          const actualGb = after?.vramUsed != null ? after.vramUsed - vramBaseline : null;
          // 裸预测（不带校准）入档：校准由运行记录派生，档案里必须保存未修正的口径。
          const prediction = predictVramUsage(model, model.loadConfig, { scratchRatio: 1 });
          if (actualGb != null && actualGb > 0) {
            // 入库可信下限，与校准守卫同一口径（解析项一半 vs 文件体积三成取低者）：
            // 差值低于下限几乎必然是旧实例未卸载的串台读数，vram_gb 置空以免污染校准，
            // 记录本身保留供排障。
            const fileGb = Math.max(0, model.fileSizeBytes) / 1024 ** 3;
            const plausibleFloor = Math.min(prediction.analyticalGb * 0.5, fileGb * 0.3 + 0.5);
            const plausible = actualGb >= plausibleFloor;
            // 保存一条带实测数据的启动记录；写入后刷新记录，校准随即更新。
            await saveModelRunRecord({
              model_id: model.id,
              model_name: model.name,
              kind: 'launch',
              timestamp: Math.floor(Date.now() / 1000),
              ngl: model.loadConfig.gpuLayers,
              ctx: model.loadConfig.ctxLength,
              kv: model.loadConfig.cacheTypeKEnabled ? model.loadConfig.cacheTypeK : 'f16',
              ncmoe: model.loadConfig.moeCpuLayers > 0 ? model.loadConfig.moeCpuLayers : null,
              flash_attn: model.loadConfig.fastAttention,
              speculative: model.loadConfig.speculativeDecoding,
              vram_gb: plausible ? actualGb : null,
              vram_predicted_gb: prediction.totalGb,
              note: plausible ? undefined : `实测显存 ${actualGb.toFixed(2)} GB 低于可信下限，疑似差值串台，已忽略`,
            }).catch(() => undefined);
            refreshRunRecords();
          }
        }

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

        setLoadProgressPercent(100);
        if (model.loadConfig.rememberSettings) {
          dispatch({ type: 'REMEMBER_MODEL_LAUNCH_CONFIG', payload: { modelId: model.id, config: model.loadConfig } });
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
        total_layers: Math.max(0, model.blockCount ?? 0),
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
  const layerCount = Math.max(0, model.blockCount ?? 0);
  const ctxMax = Math.max(512, RECOMMENDED_CTX_LENGTH, model.ctxLength || 0, config.ctxLength || 0);
  // ctx 快捷定位节点：超过本模型容量上限的节点自动隐藏。
  const ctxTicks = [
    { value: 10240, label: '10K' },
    { value: 32768, label: '32K' },
    { value: 65536, label: '64K' },
    { value: 102400, label: '100K' },
    { value: 163840, label: '160K' },
    { value: 204800, label: '200K' },
  ].filter((tick) => tick.value <= ctxMax);
  // 预测带校准（有实测样本时修正经验项）。
  const vramPrediction = predictVramUsage(
    model,
    config,
    calibration && calibration.samples > 0 ? calibration : undefined,
  );
  const headerCards = [
    { icon: Cpu, label: '架构', value: model.architecture ?? '未读取' },
    { icon: Layers, label: '层数（block_count）', value: formatNumber(model.blockCount) },
    { icon: Hash, label: '上下文（context_length）', value: formatCtx(model.ctxLength) },
    { icon: Box, label: '专家数（expert_count）', value: formatNumber(model.expertCount) },
    { icon: Database, label: '嵌入维度（embedding）', value: formatNumber(model.embeddingLength) },
    { icon: Gauge, label: '注意力头（heads）', value: formatPair(model.headCount, model.headCountKv) },
    { icon: FileText, label: 'K/V 长度', value: formatPair(model.keyLength, model.valueLength) },
  ];

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
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-[var(--app-bg)] dark:bg-[var(--app-bg)]">
      <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        <div className="mx-auto max-w-[1180px] min-[1600px]:max-w-[1520px]">
          <ModelLoadTopBar
            model={model}
            prediction={vramPrediction}
            calibrationRatio={calibrationRatio}
            calibrationSamples={calibrationSamples}
            calibrationIsScratch={calibrationIsScratch}
            isLoading={isLoading}
            loadMessage={loadError ?? loadProgress}
            statusMessage={logoMessage}
            loadPercent={loadError ? 0 : loadProgressPercent}
            isError={Boolean(loadError)}
            onChangeLogo={handleChangeLogo}
            onReset={() => dispatch({ type: 'UPDATE_MODEL_CONFIG', payload: { modelId: model.id, config: defaultModelLoadConfig(model) } })}
            onLoad={() => void handleLoad()}
            onStop={() => void handleStopLoading()}
            onAutoTune={() => void startAutoTuneRun()}
            onStopAutoTune={() => void stopAutoTuneRun()}
            autoTuneRunning={autoTuneRunning}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            apiName={apiNameDraft ?? model.apiName ?? ''}
            apiNamePlaceholder={suggestedApiName(model)}
            onApiNameChange={setApiNameDraft}
            onApiNameCommit={() => {
              if (apiNameDraft == null) return;
              dispatch({
                type: 'SET_MODEL_API_NAME',
                payload: { modelId: model.id, apiName: apiNameDraft.trim() },
              });
              setApiNameDraft(null);
            }}
          />

          {logoLibraryOpen && (
            <LogoLibraryDialog
              selected={model.customLogo}
              onSelect={handleSelectLibraryLogo}
              onClear={handleClearLogo}
              onClose={() => setLogoLibraryOpen(false)}
            />
          )}

          {activeTab === 'params' ? (
            <div>
              <RunRecordsCard
                records={runRecords}
                running={autoTuneRunning}
                log={autoTuneLog}
                applied={autoTuneApplied}
                onClearLog={() => setAutoTuneLog([])}
              />
              <div className="grid items-start lg:grid-cols-2">
                <ParamSection title="推理与显存" icon={Cpu}>
                  <SliderParamRow
                    label="上下文长度"
                    description={model.ctxLength > 0 ? `模型最多支持 ${model.ctxLength.toLocaleString()} 个 token` : 'GGUF 未读取到 context_length'}
                    value={config.ctxLength}
                    onChange={(v) => updateConfig('ctxLength', v)}
                    min={512}
                    max={ctxMax}
                    step={512}
                    suffix="token"
                    ticks={ctxTicks}
                  />
                  <SliderParamRow
                    label="GPU 卸载"
                    description={layerCount > 0 ? `模型层数 ${layerCount.toLocaleString()}` : 'GGUF 未读取到 block_count，默认尽量使用 GPU'}
                    value={config.gpuLayers}
                    onChange={(v) => updateConfig('gpuLayers', v)}
                    min={0}
                    max={layerCount > 0 ? layerCount : DEFAULT_GPU_LAYERS_WHEN_UNKNOWN}
                    step={1}
                  />
                  <NumberParamRow
                    label="物理批处理大小（ubatch）"
                    description="--ubatch-size / -ub"
                    value={config.physicalBatchSize}
                    onChange={(v) => updateConfig('physicalBatchSize', v)}
                    min={1}
                    max={8192}
                    step={64}
                  />
                  <ToggleParamRow
                    label="将 KV 缓存卸载到 GPU 内存"
                    description="--kv-offload / --no-kv-offload"
                    checked={config.kvCache}
                    onChange={(v) => updateConfig('kvCache', v)}
                  />
                  <ToggleParamRow
                    label="快速注意力"
                    description="--flash-attn"
                    checked={config.fastAttention}
                    onChange={(v) => updateConfig('fastAttention', v)}
                  />
                </ParamSection>

                <ParamSection title="缓存与运行行为" icon={Database}>
                  <CacheTypeParamRow
                    label="K 缓存量化类型"
                    description="-ctk / --cache-type-k"
                    badge="实验"
                    enabled={config.cacheTypeKEnabled}
                    value={config.cacheTypeK}
                    onToggle={(v) => updateConfig('cacheTypeKEnabled', v)}
                    onChange={(v) => updateConfig('cacheTypeK', v)}
                  />
                  <CacheTypeParamRow
                    label="V 缓存量化类型"
                    description="-ctv / --cache-type-v"
                    badge="实验"
                    enabled={config.cacheTypeVEnabled}
                    value={config.cacheTypeV}
                    onToggle={(v) => updateConfig('cacheTypeVEnabled', v)}
                    onChange={(v) => updateConfig('cacheTypeV', v)}
                  />
                  {model.modelType === 'moe' && (
                    <SliderParamRow
                      label="强制 MoE 权重留在 CPU 的层数"
                      description="-ncmoe / --n-cpu-moe"
                      badge="实验"
                      value={config.moeCpuLayers}
                      onChange={(v) => updateConfig('moeCpuLayers', v)}
                      min={0}
                      max={layerCount}
                      step={1}
                    />
                  )}
                  <IdleAutoUnloadParamRow
                    checked={config.idleAutoUnload}
                    minutes={config.idleAutoUnloadMinutes}
                    onToggle={(v) => updateConfig('idleAutoUnload', v)}
                    onMinutesChange={(v) => updateConfig('idleAutoUnloadMinutes', v)}
                  />
                  <CheckboxParamRow
                    label={`记住 ${model.name} 的加载设置`}
                    checked={config.rememberSettings}
                    onChange={(v) => updateConfig('rememberSettings', v)}
                  />
                </ParamSection>
              </div>

              <div className="min-w-0 overflow-hidden border-b border-[var(--border-subtle)]">
                <button
                  type="button"
                  onClick={() => updateConfig('showAdvancedSettings', !config.showAdvancedSettings)}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-[var(--surface-muted)] dark:hover:bg-white/[0.04]"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Settings2 className="h-4 w-4 flex-shrink-0 text-[var(--accent)]" />
                    <span className="text-[13px] font-semibold text-[var(--text-primary)] dark:text-[var(--text-primary)]">高级参数</span>
                    <span className="hidden truncate text-[11px] text-[var(--text-secondary)] dark:text-[var(--text-secondary)] sm:inline">线程、批处理、RoPE、聊天模板等</span>
                  </span>
                  <ChevronRight className={`h-4 w-4 flex-shrink-0 text-[var(--text-secondary)] transition-transform duration-200 dark:text-[var(--text-secondary)] ${config.showAdvancedSettings ? 'rotate-90' : ''}`} />
                </button>
                {config.showAdvancedSettings && (
                  <div className="grid border-t border-[var(--border-subtle)] lg:grid-cols-2">
                      <div className="min-w-0 lg:border-r lg:border-[var(--border-subtle)]">
                      <NumberParamRow
                        label="CPU 线程池大小"
                        description="--threads；自动时不传该参数"
                        value={config.threads}
                        onChange={(v) => updateConfig('threads', v)}
                        min={-1}
                        max={256}
                        step={1}
                        autoLabel="自动"
                      />
                      <SliderParamRow
                        label="评估批处理大小"
                        description="--batch-size / -b"
                        value={config.batchSize}
                        onChange={(v) => updateConfig('batchSize', v)}
                        min={1}
                        max={8192}
                        step={64}
                      />
                      <NumberParamRow
                        label="最大并发预测数（parallel）"
                        description="--parallel / -np；自动时不传该参数"
                        badge="实验"
                        value={config.parallel}
                        onChange={(v) => updateConfig('parallel', v)}
                        min={-1}
                        max={128}
                        step={1}
                        autoLabel="自动"
                      />
                      <ToggleParamRow
                        label="统一 KV 缓存"
                        description="--kv-unified"
                        badge="实验"
                        checked={config.kvUnified}
                        onChange={(v) => updateConfig('kvUnified', v)}
                      />
                      <ToggleParamRow
                        label="保持模型在内存中"
                        description="--mlock"
                        checked={config.mlock}
                        onChange={(v) => updateConfig('mlock', v)}
                      />
                      <ToggleParamRow
                        label="跳过启动预热"
                        description="--no-warmup；超大模型首次验证时可显著缩短等待时间"
                        badge="实验"
                        checked={config.noWarmup}
                        onChange={(v) => updateConfig('noWarmup', v)}
                      />
                      <ToggleParamRow
                        label="尝试 mmap()"
                        description="--mmap / --no-mmap"
                        checked={config.mmap}
                        onChange={(v) => updateConfig('mmap', v)}
                      />
                    </div>
                    <div className="min-w-0">
                      <OptionalNumberParamRow
                        label="RoPE 频率基"
                        description="--rope-freq-base；关闭时从 GGUF 读取"
                        enabled={config.ropeFreqBaseEnabled}
                        value={config.ropeFreqBase}
                        onToggle={(enabled) => updateConfig('ropeFreqBaseEnabled', enabled)}
                        onChange={(v) => updateConfig('ropeFreqBase', v)}
                        step={1000}
                        autoLabel="自动"
                      />
                      <OptionalNumberParamRow
                        label="RoPE 频率比例"
                        description="--rope-freq-scale；关闭时从 GGUF 读取"
                        enabled={config.ropeFreqScaleEnabled}
                        value={config.ropeFreqScale}
                        onToggle={(enabled) => updateConfig('ropeFreqScaleEnabled', enabled)}
                        onChange={(v) => updateConfig('ropeFreqScale', v)}
                        step={0.01}
                        autoLabel="自动"
                      />
                      <ReadOnlyParamRow
                        label="专家数量"
                        description="从 GGUF expert_count 读取"
                        value={model.modelType === 'moe' ? formatNumber(model.expertCount) : '稠密模型'}
                      />
                      {model.supportsMtp || model.dsparkDraftPath || model.dflashDraftPath ? (
                        <>
                          <SpecDecodeParamRow
                            model={model}
                            value={config.speculativeDecoding}
                            onChange={(v) => updateConfig('speculativeDecoding', v)}
                          />
                          {config.speculativeDecoding !== 'off' ? (
                            <OptionalNumberParamRow
                              label="草稿深度"
                              description="--spec-draft-n-max（1–16）；关闭时使用 llama-server 内核默认"
                              enabled={config.specDraftNMaxEnabled}
                              value={config.specDraftNMax}
                              onToggle={(v) => updateConfig('specDraftNMaxEnabled', v)}
                              onChange={(v) => updateConfig('specDraftNMax', Math.min(16, Math.max(1, Math.round(v))))}
                              step={1}
                              autoLabel="内核默认"
                            />
                          ) : null}
                        </>
                      ) : (model.nextnPredictLayers ?? 0) > 0 ? (
                        <ReadOnlyParamRow
                          label="NextN / MTP 元数据"
                          description="GGUF 含 NextN 声明，但当前 llama.cpp 没有该架构的 MTP graph，或缺少可执行的 MTP tensor。"
                          value="当前不可用"
                        />
                      ) : null}
                      <TextParamRow
                        label="聊天模板"
                        description="留空时使用 GGUF 元数据（metadata）中的模板"
                        value={config.chatTemplate}
                        onChange={(v) => updateConfig('chatTemplate', v)}
                        placeholder="自动"
                      />
                      <OptionalNumberParamRow
                        label="种子"
                        description="--seed；关闭时使用随机种子"
                        enabled={config.seedEnabled}
                        value={config.seed}
                        onToggle={(enabled) => {
                          updateConfig('seedEnabled', enabled);
                          if (enabled && config.seed < 0) updateConfig('seed', 0);
                        }}
                        onChange={(v) => updateConfig('seed', v)}
                        step={1}
                        autoLabel="随机种子"
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="max-w-5xl">
              <div className="border-b border-[var(--border-subtle)] py-5">
                <h3 className="mb-2 text-sm font-semibold text-[var(--text-primary)] dark:text-[var(--text-primary)]">模型介绍</h3>
                <p className="text-sm leading-relaxed text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">{model.longDescription}</p>
              </div>

              <div className="grid grid-cols-2 lg:grid-cols-4">
                <InfoCard icon={Calendar} label="发布日期" value={model.releaseDate} />
                <InfoCard icon={FileText} label="许可协议" value={model.license} />
                <InfoCard icon={Box} label="参数量" value={model.params} />
                <InfoCard icon={Layers} label="上下文" value={formatCtx(model.ctxLength)} />
              </div>

              <div>
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold text-[var(--text-primary)] dark:text-[var(--text-primary)]">GGUF 表头摘要</h3>
                  <span className="text-xs text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">{model.ggufMetadata?.length ?? 0} 个字段</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
                  {headerCards.map((item) => (
                    <InfoCard key={item.label} icon={item.icon} label={item.label} value={item.value} />
                  ))}
                </div>
              </div>

              {model.benchmarks && (
                <div className="border-b border-[var(--border-subtle)] py-5">
                  <h3 className="mb-3 text-sm font-semibold text-[var(--text-primary)] dark:text-[var(--text-primary)]">基准测试</h3>
                  <div className="grid grid-cols-2 lg:grid-cols-4">
                    {Object.entries(model.benchmarks).map(([key, value]) => (
                      <div key={key} className="border-b border-[var(--border-subtle)] p-3 text-center last:border-b-0">
                        <div className="mb-1 text-xs text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">{key}</div>
                        <div className="mono-font text-lg font-semibold text-[var(--accent)]">{value}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="border-b border-[var(--border-subtle)] py-5">
                <h3 className="mb-2 text-sm font-semibold text-[var(--text-primary)] dark:text-[var(--text-primary)]">标签</h3>
                <div className="flex flex-wrap items-center gap-2">
                  {model.tags.map((tag) => (
                    <span key={tag} className="rounded-md bg-[var(--surface-muted)] px-2.5 py-1 text-xs font-medium text-[var(--accent)] dark:bg-[var(--surface-raised)] dark:text-[var(--accent)]">{formatTag(tag)}</span>
                  ))}
                </div>
              </div>

              <div>
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold text-[var(--text-primary)] dark:text-[var(--text-primary)]">GGUF 表头字段</h3>
                  <span className="text-xs text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">仅展示真实读取到的元数据（metadata）</span>
                </div>
                {model.ggufMetadata && model.ggufMetadata.length > 0 ? (
                  <div className="grid grid-cols-1 lg:grid-cols-2">
                    {model.ggufMetadata.map(({ key, value }) => (
                      <MetadataCard key={key} name={key} value={value} />
                    ))}
                  </div>
                ) : (
                  <div className="border-b border-[var(--border-subtle)] py-5 text-sm text-[var(--text-secondary)]">
                    未从该 GGUF 文件读取到可展示的表头元数据。
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const CACHE_TYPES = ['f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1'];

function rowBorderClass() {
  return 'border-b border-[var(--border-subtle)] last:border-b-0';
}

/**
 * 统一的开关滑块。两种尺寸：默认（h-6 w-11）与小号（h-5 w-9，用于复选场景）。
 * 圆点用 CSS transform 平滑左右滑动。
 */
function ToggleSwitch({ checked, onChange, disabled, size = 'md', ariaLabel }: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  size?: 'sm' | 'md';
  ariaLabel?: string;
}) {
  const dims = size === 'sm'
    ? { track: 'h-5 w-9', thumb: 'h-4 w-4', travel: 16 }
    : { track: 'h-6 w-11', thumb: 'h-5 w-5', travel: 20 };
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={`relative inline-flex ${dims.track} flex-shrink-0 items-center rounded-full border transition-colors duration-200 disabled:opacity-50 ${
        checked
          ? 'border-[var(--accent)] bg-[var(--accent)]'
          : 'border-[var(--border)] bg-[var(--border)] dark:border-white/[0.18] dark:bg-white/[0.10]'
      }`}
    >
      <span
        className={`inline-block ${dims.thumb} rounded-full bg-white shadow-sm transition-transform duration-200 ease-out`}
        style={{ transform: `translateX(${checked ? dims.travel : 2}px)` }}
      />
    </button>
  );
}

function ParamLabel({ label, description, badge }: { label: string; description?: string; badge?: string }) {
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-[var(--text-primary)] dark:text-[var(--text-primary)]">{label}</span>
        <Info className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-secondary)] dark:text-[var(--text-secondary)]" />
        {badge && (
          <span className="flex-shrink-0 rounded-md border border-[var(--border)] bg-[var(--surface-muted)] px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-normal text-[var(--text-secondary)] dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[var(--text-secondary)]">
            {badge}
          </span>
        )}
      </div>
      {description && <div className="mt-0.5 text-xs text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">{description}</div>}
    </div>
  );
}

const RUN_RECORD_KIND_LABEL: Record<ModelRunRecord['kind'], string> = {
  launch: '启动',
  benchmark: '跑分',
  autotune: '调参',
};

// 运行记录 + 自动调参合并卡：调参日志与启动/调参记录在同一个卡片里查看。
// 调参进行中自动展开；结束后最优参数会自动应用（见 applyTuneRecord）。
function RunRecordsCard({ records, running, log, applied, onClearLog }: {
  records: ModelRunRecord[];
  running: boolean;
  log: string[];
  applied: boolean;
  onClearLog: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const logViewportRef = useRef<HTMLDivElement | null>(null);
  const [logCollapsed, setLogCollapsed] = useState(false);

  // 调参开始时自动展开卡片；日志区跟随滚动到底部。
  useEffect(() => {
    if (running) setExpanded(true);
  }, [running]);
  useEffect(() => {
    if (!logCollapsed && logViewportRef.current) {
      logViewportRef.current.scrollTop = logViewportRef.current.scrollHeight;
    }
  }, [log.length, logCollapsed]);

  if (records.length === 0 && log.length === 0 && !running) return null;
  return (
    <div className="border-b border-[var(--border-subtle)] py-4">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full flex-wrap items-center gap-2 text-sm font-semibold text-[var(--text-primary)] dark:text-[var(--text-primary)]"
      >
        <ChevronRight className={`h-4 w-4 flex-shrink-0 text-[var(--text-tertiary)] transition-transform ${expanded ? 'rotate-90' : ''}`} />
        <History className="h-4 w-4 flex-shrink-0 text-[var(--accent)]" />
        运行记录
        {records.length > 0 && (
          <span className="text-xs font-normal text-[var(--text-tertiary)]">{records.length} 条 · 含调参与启动实测</span>
        )}
        {running && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent)] px-2 py-0.5 text-[11px] font-medium text-white shadow-sm">
            <span className="h-1.5 w-1.5 animate-ping rounded-full bg-white" />
            调参搜索中…
          </span>
        )}
        {!running && applied && (
          <span className="rounded-md bg-[var(--state-success-bg)] px-2 py-0.5 text-[11px] font-medium text-[var(--state-success)] dark:bg-[var(--state-success-bg)] dark:text-[var(--state-success)]">
            已自动应用调参结果
          </span>
        )}
      </button>
      {expanded && (
        <div className="mt-2 space-y-1.5">
          {log.length > 0 && (
            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2 text-xs text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">
                <span className="font-mono text-[11px]">调参日志（共 {log.length} 条）</span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setLogCollapsed((value) => !value)}
                    className="hover:text-[var(--text-primary)] dark:hover:text-white"
                  >
                    {logCollapsed ? '展开日志' : '收起日志'}
                  </button>
                  <span>·</span>
                  <button
                    type="button"
                    onClick={onClearLog}
                    disabled={running}
                    className="hover:text-[var(--text-primary)] disabled:opacity-40 dark:hover:text-white"
                  >
                    清空
                  </button>
                </div>
              </div>
              {!logCollapsed && (
                <div
                  ref={logViewportRef}
                  className="max-h-36 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--app-bg)] p-2.5 font-mono text-[11px] leading-relaxed text-[var(--text-secondary)] dark:border-white/[0.08] dark:bg-black/20 dark:text-[var(--text-secondary)]"
                >
                  {log.map((line, index) => (
                    <div key={index} className="break-words">{line}</div>
                  ))}
                </div>
              )}
            </div>
          )}
          {records.slice(0, 8).map((record) => {
            const deviation = record.vram_gb != null && record.vram_predicted_gb
              ? ((record.vram_gb - record.vram_predicted_gb) / record.vram_predicted_gb * 100)
              : null;
            return (
              <div
                key={`${record.timestamp}-${record.kind}`}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-md bg-[var(--surface-muted)] px-2.5 py-1.5 text-[11px] dark:bg-white/[0.04]"
              >
                <span className="rounded-sm bg-[var(--accent-subtle)] px-1 py-0.5 font-medium text-[var(--accent)] dark:bg-white/[0.06]">
                  {RUN_RECORD_KIND_LABEL[record.kind] ?? record.kind}
                </span>
                <span className="mono-font text-[var(--text-primary)]">
                  ngl={record.ngl ?? '--'} ctx={record.ctx?.toLocaleString() ?? '--'} kv={record.kv ?? 'f16'}
                  {record.ncmoe != null ? ` ncmoe=${record.ncmoe}` : ''}
                </span>
                {record.tokens_per_sec != null && (
                  <span className="mono-font text-[var(--text-secondary)]">{record.tokens_per_sec.toFixed(1)} tok/s</span>
                )}
                {record.vram_gb != null && (
                  <span className="mono-font text-[var(--text-secondary)]">
                    显存 {record.vram_gb.toFixed(1)} GB
                    {deviation != null && Number.isFinite(deviation) ? `（预测偏差 ${deviation > 0 ? '+' : ''}${deviation.toFixed(0)}%）` : ''}
                  </span>
                )}
                {record.note && (
                  <span
                    className="break-words text-[var(--state-warning)] dark:text-[var(--state-warning)]"
                    title={record.note}
                  >
                    {record.note}
                  </span>
                )}
                <span className="ml-auto text-[var(--text-tertiary)]">
                  {new Date(record.timestamp * 1000).toLocaleString('zh-CN', { hour12: false })}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ParamSection({ title, icon: Icon, children }: {
  title: string;
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 overflow-hidden border-b border-[var(--border-subtle)]">
      <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-1 py-2.5">
        <Icon className="h-4 w-4 text-[var(--accent)]" />
        <h3 className="text-[13px] font-semibold text-[var(--text-primary)] dark:text-[var(--text-primary)]">{title}</h3>
      </div>
      <div>{children}</div>
    </div>
  );
}

// 头像库弹窗：内置品牌 logo 网格，点选即用；不支持上传图片。
function LogoLibraryDialog({ selected, onSelect, onClear, onClose }: {
  selected?: string;
  onSelect: (customLogo: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const isUsingLibrary = Boolean(selected?.startsWith(LOBEHUB_CUSTOM_PREFIX));
  return (
    <div
      className="fixed inset-0 z-[80] grid place-items-center bg-black/40 p-6"
      onClick={onClose}
    >
      <div
        className="max-h-[80vh] w-[min(640px,92vw)] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl dark:border-white/[0.10] dark:bg-[#2b2b2b]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-3">
          <div>
            <div className="text-sm font-semibold text-primary-custom">选择头像</div>
            <div className="mt-0.5 text-xs text-secondary-custom">点击任意品牌图标即可应用；右键头像可恢复默认。</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-xs text-secondary-custom hover:bg-[var(--surface-muted)] hover:text-primary-custom dark:hover:bg-white/[0.08]"
          >
            关闭
          </button>
        </div>
        <div className="grid max-h-[56vh] grid-cols-4 gap-2 overflow-y-auto p-4 sm:grid-cols-6 md:grid-cols-8">
          {MODEL_LOGO_LIBRARY.map((entry) => {
            const value = `${LOBEHUB_CUSTOM_PREFIX}${entry.key}`;
            const active = selected === value;
            return (
              <button
                key={entry.key}
                type="button"
                onClick={() => onSelect(value)}
                className={`flex flex-col items-center gap-1.5 rounded-lg border px-2 py-2.5 transition-colors ${
                  active
                    ? 'border-[var(--accent)] bg-[var(--accent-subtle)]'
                    : 'border-[var(--border)] hover:bg-[var(--surface-muted)] dark:border-white/[0.08] dark:hover:bg-white/[0.06]'
                }`}
                title={entry.label}
              >
                <ModelFamilyLogo customSrc={value} size={24} tone="var(--accent)" fallback={entry.label[0]} />
                <span className="w-full truncate text-center text-[10px] text-secondary-custom">{entry.label}</span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center justify-between border-t border-[var(--border-subtle)] px-4 py-2.5">
          <span className="text-xs text-secondary-custom">当前：{selected ? (isUsingLibrary ? '品牌图标' : '自定义图片') : '默认品牌图标'}</span>
          <button
            type="button"
            onClick={() => { onClear(); onClose(); }}
            className="rounded-md border border-[var(--border)] px-2.5 py-1 text-xs text-secondary-custom transition-colors hover:bg-[var(--surface-muted)] hover:text-primary-custom dark:border-white/[0.08] dark:hover:bg-white/[0.06]"
          >
            恢复默认
          </button>
        </div>
      </div>
    </div>
  );
}

function ModelLoadTopBar({ model, prediction, calibrationRatio, calibrationSamples, calibrationIsScratch, isLoading, loadMessage, statusMessage, loadPercent, isError, onChangeLogo, onReset, onLoad, onStop, onAutoTune, onStopAutoTune, autoTuneRunning, activeTab, onTabChange, apiName, apiNamePlaceholder, onApiNameChange, onApiNameCommit }: {
  model: ModelInfo;
  prediction: VramPrediction;
  calibrationRatio: number;
  calibrationSamples: number;
  calibrationIsScratch: boolean;
  isLoading: boolean;
  loadMessage: string | null;
  statusMessage: string | null;
  loadPercent: number;
  isError: boolean;
  onChangeLogo: () => void;
  onReset: () => void;
  onLoad: () => void;
  onStop: () => void;
  onAutoTune: () => void;
  onStopAutoTune: () => void;
  autoTuneRunning: boolean;
  activeTab: 'params' | 'info';
  onTabChange: (tab: 'params' | 'info') => void;
  apiName: string;
  apiNamePlaceholder: string;
  onApiNameChange: (value: string) => void;
  onApiNameCommit: () => void;
}) {
  const safePercent = clamp(loadPercent, 0, 100);
  const offloadPercent = Math.round(prediction.offloadRatio * 100);
  const expertPercent = Math.round(prediction.expertGpuRatio * 100);
  // 分项 pills 与校准后的总预测保持同口径：分项校准只作用在「计算 + 运行」经验项上。
  const calibratedRatio = calibrationSamples > 0 && calibrationIsScratch ? calibrationRatio : 1;
  const progressText = loadMessage ?? statusMessage ?? (isLoading ? '正在准备加载...' : '显存预测会随参数实时更新');
  const tabs = [
    { id: 'params' as const, label: '加载参数', icon: Hash },
    { id: 'info' as const, label: '模型信息', icon: BarChart3 },
  ];

  return (
    <div className="model-load-summary sticky top-0 z-40 mb-1 overflow-hidden border-b border-[var(--border-subtle)] bg-[var(--app-bg)] px-1 py-2">
      <div className="model-load-summary-row flex flex-col gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <button
            type="button"
            onClick={onChangeLogo}
            className="grid h-8 w-8 flex-shrink-0 place-items-center overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface)] text-sm font-semibold dark:border-white/[0.08] dark:bg-white/[0.05]"
            style={{ color: model.themeColorSolid }}
            title="点击更换头像"
          >
            <ModelFamilyLogo
              family={model.family}
              architecture={model.architecture}
              name={model.name}
              size={16}
              customSrc={model.customLogo}
              tone={model.themeColorSolid}
              fallback={model.family[0]}
            />
          </button>
          <div className="min-w-0">
            {/* 名字与 API 调用名恒同一行：名字截断让位，输入框不收缩、有余量时自动加宽 */}
            <div className="flex min-w-0 items-center gap-x-2">
              <h1 className="min-w-0 truncate text-sm font-semibold text-[var(--text-primary)] dark:text-[var(--text-primary)]">{model.name}</h1>
              <input
                value={apiName}
                placeholder={apiNamePlaceholder}
                onChange={(event) => onApiNameChange(event.target.value)}
                onBlur={onApiNameCommit}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
                className="mono-font h-7 w-44 flex-shrink-0 flex-grow rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-xs text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--accent)] dark:border-white/[0.08] dark:bg-white/[0.05]"
                title="API 调用名：对外接口显示的模型名，输入结束（失焦/回车）自动保存，留空用默认名"
                aria-label="API 调用名"
              />
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">
              <span className="mono-font">{model.params}</span>
              <span>·</span>
              <span>{model.quant}</span>
              <span>·</span>
              <span>{model.fileSize}</span>
              <span className={`flex-shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium ${
                model.modelType === 'moe' ? 'bg-[var(--accent-subtle)] text-[var(--accent)] dark:bg-[var(--accent-subtle)] dark:text-[var(--accent)]' : 'bg-[var(--state-success-bg)] text-[var(--state-success)] dark:bg-[var(--state-success-bg)] dark:text-[var(--state-success)]'
              }`}>
                {formatModelType(model.modelType)}
              </span>
            </div>
          </div>
        </div>

        <div className="model-load-summary-metrics">
          <div className="flex items-center gap-2 border-l border-[var(--border-subtle)] px-2.5 py-1.5">
            <HardDrive className="h-4 w-4 flex-shrink-0 text-[var(--accent)]" />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-[10px] text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">
                <span>预计 GPU 显存</span>
                {calibrationSamples > 0 && (
                  <span
                    className="rounded-sm bg-[var(--accent-subtle)] px-1 text-[9px] font-medium text-[var(--accent)] dark:bg-[var(--accent-subtle)] dark:text-[var(--accent)]"
                    title={calibrationIsScratch
                      ? `已按 ${calibrationSamples} 次加载实测校准计算开销（暂存+运行时 ×${calibrationRatio.toFixed(2)}）`
                      : `已按 ${calibrationSamples} 次加载实测校准 GPU 权重（权重 ×${calibrationRatio.toFixed(2)}，KV 与计算开销按解析式保留）`}
                  >
                    实测校准 ×{calibrationRatio.toFixed(2)}
                  </span>
                )}
              </div>
              <div className="mono-font text-base font-semibold leading-tight text-[var(--accent)]">{formatGb(prediction.totalGb)}</div>
            </div>
          </div>

          <div className="model-load-summary-pills grid grid-cols-3 gap-1.5 sm:grid-cols-6 xl:flex xl:items-center">
            <PredictionPill label="权重" value={formatGb(prediction.weightsGpuGb)} />
            <PredictionPill label="KV" value={prediction.kvGb === null ? '缺表头' : formatGb(prediction.kvGb)} />
            <PredictionPill label="计算" value={formatGb(prediction.computeGb * calibratedRatio)} />
            <PredictionPill label="运行" value={formatGb(prediction.runtimeGb * calibratedRatio + prediction.safetyGb)} />
            <PredictionPill label="层" value={`${offloadPercent}%`} />
            <PredictionPill label="专家" value={model.modelType === 'moe' ? `${expertPercent}%` : '稠密'} />
          </div>
        </div>

        <div className="model-load-summary-actions flex flex-wrap items-center gap-2">
          <div className="flex w-fit items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--app-bg)] p-1 dark:border-white/[0.08] dark:bg-white/[0.04]">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => onTabChange(tab.id)}
                  className={`relative flex h-8 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors ${
                    activeTab === tab.id ? 'text-[var(--accent)] dark:text-[var(--accent)]' : 'text-[var(--text-primary)] hover:bg-[var(--surface-muted)] dark:text-[var(--text-secondary)] dark:hover:bg-white/[0.07]'
                  }`}
                >
                  {activeTab === tab.id && (
                    <span
                      className="absolute inset-0 rounded-md bg-[var(--surface-muted)] transition-colors dark:bg-white/[0.08]"
                    />
                  )}
                  <Icon className="relative z-10 h-4 w-4" />
                  <span className="relative z-10">{tab.label}</span>
                </button>
              );
            })}
          </div>
          {autoTuneRunning ? (
            <button
              onClick={onStopAutoTune}
              className="flex h-9 items-center gap-2 rounded-lg border border-[var(--state-danger-border)] bg-[var(--state-danger-bg)] px-3 text-sm text-[var(--state-danger)] transition-colors hover:bg-[var(--state-danger-border)] dark:border-[var(--state-danger-border)]/30 dark:bg-[var(--surface-raised)] dark:text-[var(--state-danger)] dark:hover:bg-[var(--state-danger-bg)]"
              title="停止自动调参（已测得的样本会保留）"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
              停止调参
            </button>
          ) : (
            <button
              onClick={onAutoTune}
              disabled={isLoading}
              className="flex h-9 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)] disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[var(--text-primary)] dark:hover:bg-white/[0.09]"
              title="实测搜索最优 ngl / ctx / KV 组合，结束后自动应用最优参数"
            >
              <Wand2 className="h-4 w-4 text-[var(--accent)]" />
              自动调参
            </button>
          )}
          <button
            onClick={onReset}
            disabled={isLoading}
            className="flex h-9 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)] disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[var(--text-primary)] dark:hover:bg-white/[0.09]"
          >
            <RotateCcw className="h-4 w-4 text-[var(--text-secondary)] dark:text-[var(--text-secondary)]" />
            重置
          </button>
          <button
            onClick={onLoad}
            disabled={isLoading}
            className="flex h-9 items-center gap-2 rounded-lg bg-[var(--accent)] px-4 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-60 dark:bg-[var(--accent)] dark:hover:bg-[var(--accent-hover)]"
          >
            <Play className="h-4 w-4" />
            {model.status === 'loaded' ? '重新加载' : '加载模型'}
          </button>
          {isLoading && (
            <button
              onClick={onStop}
              className="flex h-9 items-center gap-2 rounded-lg border border-[var(--state-danger-border)] bg-[var(--state-danger-bg)] px-3 text-sm text-[var(--state-danger)] transition-colors hover:bg-[var(--state-danger-border)] dark:border-[var(--state-danger-border)]/30 dark:bg-[var(--surface-raised)] dark:text-[var(--state-danger)] dark:hover:bg-[var(--state-danger-bg)]"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
              停止
            </button>
          )}
        </div>
      </div>

      <div className="mt-2 grid gap-1.5">
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <Info className={`h-3.5 w-3.5 flex-shrink-0 ${isError ? 'text-[var(--state-danger)] dark:text-[var(--state-danger)]' : 'text-[var(--text-secondary)] dark:text-[var(--text-secondary)]'}`} />
          <span className={`min-w-0 break-words ${isError ? 'text-[var(--state-danger)] dark:text-[var(--state-danger)]' : 'text-[var(--text-secondary)] dark:text-[var(--text-secondary)]'}`}>{progressText}</span>
          <span className="mono-font ml-auto flex-shrink-0 text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">{safePercent.toFixed(0)}%</span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-[var(--surface-muted)] dark:bg-white/[0.08]">
          <div
            className={`h-full rounded-full transition-[width] duration-300 ease-out ${isError ? 'bg-[var(--state-danger)]' : 'bg-[var(--accent)]'}`}
            style={{ width: `${safePercent}%` }}
          />
        </div>
        {prediction.missing.length > 0 && (
          <div className="break-words text-[11px] text-[var(--state-warning)] dark:text-[var(--state-warning)]">
            预测缺少表头: {Array.from(new Set(prediction.missing)).join(', ')}
          </div>
        )}
      </div>
    </div>
  );
}

function PredictionPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 border-l border-[var(--border-subtle)] px-2 py-1">
      <div className="truncate text-[10px] text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">{label}</div>
      <div className="mono-font truncate text-[11px] font-semibold text-[var(--text-primary)] dark:text-[var(--text-primary)]">{value}</div>
    </div>
  );
}

function SliderParamRow({ label, description, badge, value, onChange, min, max, step, suffix, ticks }: {
  label: string; description?: string; badge?: string; value: number; onChange: (v: number) => void; min: number; max: number; step: number; suffix?: string;
  /** 快捷定位节点：显示为滑杆下方的可点击标签。 */
  ticks?: Array<{ value: number; label: string }>;
}) {
  const safeMax = Math.max(min, max);
  const sliderValue = clamp(value, min, safeMax);
  const percent = safeMax === min ? 0 : ((sliderValue - min) / (safeMax - min)) * 100;
  const [draft, setDraft] = useState<string | null>(null);

  const displayValue = draft ?? value.toString();

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setDraft(raw);
    if (raw.trim() === '') return;
    const v = Number(raw);
    if (!Number.isNaN(v)) {
      onChange(clamp(Math.round(v), min, safeMax));
    }
  };

  const handleBlur = () => {
    if (draft === null) return;
    if (draft.trim() === '') {
      onChange(min);
    } else {
      const v = Number(draft);
      onChange(Number.isNaN(v) ? min : clamp(Math.round(v), min, safeMax));
    }
    setDraft(null);
  };

  return (
    <div className={`${rowBorderClass()} px-3 py-3`}>
      <div className="mb-2.5">
        <ParamLabel label={label} description={description} badge={badge} />
      </div>
      <div className="min-w-0">
        <div className="mb-1.5 flex items-center gap-3">
          <input
            type="range"
            min={min}
            max={safeMax}
            step={step}
            value={sliderValue}
            disabled={safeMax === min && min === 0}
            onChange={(e) => {
              setDraft(null);
              onChange(clamp(Number(e.target.value), min, safeMax));
            }}
            className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full accent-[var(--accent)] transition-[background] duration-200"
            style={{
              background: `linear-gradient(to right, var(--accent) ${percent}%, rgba(125,118,107,0.22) ${percent}%)`,
            }}
          />
          <div className="flex w-28 flex-shrink-0 items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--app-bg)] px-2 transition-colors focus-within:border-[var(--accent)] dark:border-white/[0.08] dark:bg-[var(--app-bg)]">
            <input
              type="number"
              value={displayValue}
              onChange={handleInputChange}
              onBlur={handleBlur}
              step={step}
              className="mono-font h-8 min-w-0 flex-1 bg-transparent text-right text-sm text-[var(--text-primary)] outline-none dark:text-[var(--text-primary)]"
            />
            {suffix && <span className="text-[11px] text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">{suffix}</span>}
          </div>
        </div>
        <div className="flex justify-between">
          <span className="mono-font text-[11px] text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">{min.toLocaleString()}</span>
          <span className="mono-font text-[11px] text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">{safeMax.toLocaleString()}</span>
        </div>
        {ticks && ticks.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] text-[var(--text-tertiary)]">快速定位</span>
            {ticks.map((tick) => (
              <button
                key={tick.value}
                type="button"
                onClick={() => {
                  setDraft(null);
                  onChange(clamp(tick.value, min, safeMax));
                }}
                className={`mono-font rounded border px-1.5 py-0.5 text-[10px] transition-colors ${
                  sliderValue === tick.value
                    ? 'border-[var(--accent)] bg-[var(--accent-subtle)] text-[var(--accent)]'
                    : 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] dark:border-white/[0.08] dark:hover:bg-white/[0.06]'
                }`}
              >
                {tick.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function IdleAutoUnloadParamRow({ checked, minutes, onToggle, onMinutesChange }: {
  checked: boolean; minutes: number; onToggle: (v: boolean) => void; onMinutesChange: (v: number) => void;
}) {
  const safeMinutes = Math.max(1, Math.min(1440, Math.round(Number(minutes || 15))));
  const handleMinuteChange = (next: string) => {
    const parsed = Number(next);
    if (!Number.isNaN(parsed)) onMinutesChange(Math.max(1, Math.min(1440, Math.round(parsed))));
  };

  return (
    <div className={`${rowBorderClass()} grid gap-3 px-3 py-3 lg:grid-cols-[minmax(160px,1fr)_auto] lg:items-center`}>
      <ParamLabel
        label="空闲时自动卸载"
        description="有消息输入或模型输出时会重新计时。"
      />
      <div className="flex flex-wrap items-center gap-2 lg:justify-end">
        <ToggleSwitch checked={checked} onChange={onToggle} ariaLabel="空闲时自动卸载" />
        <div className={`flex min-w-0 flex-wrap items-center gap-1.5 text-sm ${checked ? 'text-[var(--text-primary)] dark:text-[var(--text-primary)]' : 'text-[var(--text-secondary)] dark:text-[var(--text-secondary)]'}`}>
          <span>没有消息输入和输出的</span>
          <input
            type="number"
            value={safeMinutes}
            min={1}
            max={1440}
            step={1}
            disabled={!checked}
            onChange={(event) => handleMinuteChange(event.target.value)}
            className="mono-font h-8 w-16 rounded-md border border-[var(--border)] bg-[var(--app-bg)] px-2 text-right text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)] disabled:opacity-55 dark:border-white/[0.08] dark:bg-[var(--app-bg)] dark:text-[var(--text-primary)]"
          />
          <span>分钟后自动卸载</span>
        </div>
      </div>
    </div>
  );
}

function SpecDecodeParamRow({ model, value, onChange }: {
  model: ModelInfo;
  value: ModelLoadConfig['speculativeDecoding'];
  onChange: (v: ModelLoadConfig['speculativeDecoding']) => void;
}) {
  const mtpDescription = model.mtpDraftPath
    ? `使用兼容的独立 MTP head：${fileNameFromPath(model.mtpDraftPath)}`
    : `使用主 GGUF 内置的 ${model.nextnPredictLayers ?? 1} 个 NextN 层，不传 -md`;
  const description = value === 'mtp' ? mtpDescription
    : value === 'dspark' && model.dsparkDraftPath
      ? `使用 DSpark 侧车：${fileNameFromPath(model.dsparkDraftPath)}`
      : value === 'dflash' && model.dflashDraftPath
        ? `使用 DFlash 侧车：${fileNameFromPath(model.dflashDraftPath)}`
        : '关闭推测解码（默认，行为与 llama-server 内核一致）。';
  const options: Array<{ value: ModelLoadConfig['speculativeDecoding']; label: string; disabled?: boolean }> = [
    { value: 'off', label: '关闭' },
    { value: 'mtp', label: 'MTP', disabled: !model.supportsMtp },
    { value: 'dspark', label: 'DSpark', disabled: !model.dsparkDraftPath },
    { value: 'dflash', label: 'DFlash', disabled: !model.dflashDraftPath },
  ];

  return (
    <div className={`${rowBorderClass()} grid gap-3 px-3 py-3 lg:grid-cols-[minmax(160px,1fr)_auto] lg:items-center`}>
      <ParamLabel label="推测解码" description={description} badge="实验" />
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as ModelLoadConfig['speculativeDecoding'])}
        aria-label="推测解码模式"
        className="h-9 rounded-md border border-[var(--border)] bg-[var(--app-bg)] px-2 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)] dark:border-white/[0.08] dark:bg-[var(--app-bg)] dark:text-[var(--text-primary)]"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function ToggleParamRow({ label, description, badge, checked, onChange }: { label: string; description?: string; badge?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className={`${rowBorderClass()} grid gap-3 px-3 py-3 lg:grid-cols-[minmax(160px,1fr)_auto] lg:items-center`}>
      <ParamLabel label={label} description={description} badge={badge} />
      <div className="flex justify-end">
        <ToggleSwitch checked={checked} onChange={onChange} ariaLabel={label} />
      </div>
    </div>
  );
}

function NumberParamRow({ label, description, badge, value, onChange, min, max, step, autoLabel }: {
  label: string; description?: string; badge?: string; value: number; onChange: (v: number) => void; min: number; max: number; step: number; autoLabel?: string;
}) {
  const display = autoLabel && value < 0 ? autoLabel : value.toString();
  const handleChange = (next: string) => {
    const parsed = Number(next);
    if (!Number.isNaN(parsed)) onChange(clamp(Math.round(parsed), min, max));
  };

  return (
    <div className={`${rowBorderClass()} grid gap-3 px-3 py-3 lg:grid-cols-[minmax(160px,1fr)_auto] lg:items-center`}>
      <ParamLabel label={label} description={description} badge={badge} />
      <div className="flex items-center gap-2 lg:justify-end">
        {autoLabel && (
          <button
            type="button"
            onClick={() => onChange(-1)}
            className="rounded-md border border-[var(--border)] bg-[var(--surface-muted)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] transition-colors hover:bg-[var(--border)] dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[var(--text-secondary)] dark:hover:bg-white/[0.09]"
          >
            {autoLabel}
          </button>
        )}
        <input
          type="number"
          value={value < 0 && autoLabel ? '' : value}
          placeholder={display}
          min={min}
          max={max}
          step={step}
          onChange={(event) => handleChange(event.target.value)}
          className="mono-font h-9 w-28 rounded-md border border-[var(--border)] bg-[var(--app-bg)] px-2 text-right text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)] dark:border-white/[0.08] dark:bg-[var(--app-bg)] dark:text-[var(--text-primary)]"
        />
      </div>
    </div>
  );
}

function OptionalNumberParamRow({ label, description, enabled, value, onToggle, onChange, step, autoLabel }: {
  label: string; description?: string; enabled: boolean; value: number; onToggle: (v: boolean) => void; onChange: (v: number) => void; step: number; autoLabel: string;
}) {
  return (
    <div className={`${rowBorderClass()} grid gap-3 px-3 py-3 lg:grid-cols-[minmax(160px,1fr)_auto] lg:items-center`}>
      <ParamLabel label={label} description={description} />
      <div className="flex items-center gap-2 lg:justify-end">
        <ToggleSwitch size="sm" checked={enabled} onChange={onToggle} ariaLabel={label} />
        {enabled ? (
          <input
            type="number"
            value={value}
            step={step}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (!Number.isNaN(next)) onChange(next);
            }}
            className="mono-font h-9 w-28 rounded-md border border-[var(--border)] bg-[var(--app-bg)] px-2 text-right text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)] dark:border-white/[0.08] dark:bg-[var(--app-bg)] dark:text-[var(--text-primary)]"
          />
        ) : (
          <span className="min-w-28 text-right text-sm text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">{autoLabel}</span>
        )}
      </div>
    </div>
  );
}

function ReadOnlyParamRow({ label, description, value }: { label: string; description?: string; value: string }) {
  return (
    <div className={`${rowBorderClass()} grid gap-3 px-3 py-3 lg:grid-cols-[minmax(160px,1fr)_auto] lg:items-center`}>
      <ParamLabel label={label} description={description} />
      <span className="mono-font text-sm font-medium text-[var(--text-primary)] dark:text-[var(--text-primary)] lg:justify-self-end lg:text-right">{value}</span>
    </div>
  );
}

function TextParamRow({ label, description, value, onChange, placeholder }: {
  label: string; description?: string; value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <div className={`${rowBorderClass()} grid gap-3 px-3 py-3 lg:grid-cols-[minmax(220px,1fr)_minmax(220px,0.7fr)] lg:items-center`}>
      <ParamLabel label={label} description={description} />
      <div className="flex min-w-0 items-center gap-2">
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className="h-9 min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--app-bg)] px-2 text-sm text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--accent)] dark:border-white/[0.08] dark:bg-[var(--app-bg)] dark:text-[var(--text-primary)] dark:placeholder:text-[var(--text-tertiary)]"
        />
        <ChevronRight className="h-4 w-4 flex-shrink-0 text-[var(--text-secondary)] dark:text-[var(--text-secondary)]" />
      </div>
    </div>
  );
}

function CacheTypeParamRow({ label, description, badge, enabled, value, onToggle, onChange }: {
  label: string; description?: string; badge?: string; enabled: boolean; value: string; onToggle: (v: boolean) => void; onChange: (v: string) => void;
}) {
  return (
    <div className={`${rowBorderClass()} grid gap-3 px-3 py-3 lg:grid-cols-[minmax(160px,1fr)_auto] lg:items-center`}>
      <ParamLabel label={label} description={description} badge={badge} />
      <div className="flex items-center gap-2 lg:justify-end">
        <ToggleSwitch size="sm" checked={enabled} onChange={onToggle} ariaLabel={label} />
        {enabled ? (
          <select
            value={value}
            onChange={(event) => onChange(event.target.value)}
            className="h-9 w-28 rounded-md border border-[var(--border)] bg-[var(--app-bg)] px-2 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)] dark:border-white/[0.08] dark:bg-[var(--app-bg)] dark:text-[var(--text-primary)]"
          >
            {CACHE_TYPES.map((type) => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>
        ) : (
          <span className="min-w-28 text-right text-sm text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">默认 f16</span>
        )}
      </div>
    </div>
  );
}

function CheckboxParamRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className={`${rowBorderClass()} grid cursor-pointer gap-3 px-3 py-3 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)] dark:text-[var(--text-primary)] dark:hover:bg-white/[0.04] lg:grid-cols-[minmax(160px,1fr)_auto] lg:items-center`}>
      <span className="min-w-0 break-words font-medium">{label}</span>
      <div className="flex justify-end">
        <ToggleSwitch checked={checked} onChange={onChange} ariaLabel={label} />
      </div>
    </div>
  );
}

function InfoCard({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="border-b border-[var(--border-subtle)] py-4">
      <Icon className="mb-2 h-4 w-4 text-[var(--accent)]" />
      <div className="mb-0.5 text-xs text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">{label}</div>
      <div className="break-words text-sm font-medium text-[var(--text-primary)] dark:text-[var(--text-primary)]">{value}</div>
    </div>
  );
}

function MetadataCard({ name, value }: { name: string; value: string }) {
  const displayValue = truncateValue(value);

  return (
    <div className="min-w-0 border-b border-[var(--border-subtle)] py-4">
      <div className="mono-font truncate text-[11px] text-[var(--accent)]" title={name}>
        {name}
      </div>
      <div className="mt-2 break-words text-xs leading-relaxed text-[var(--text-secondary)] dark:text-[var(--text-secondary)]" title={value}>
        {displayValue}
      </div>
    </div>
  );
}
