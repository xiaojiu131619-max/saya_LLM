import { useRef, useState } from 'react';
import { Play, RotateCcw, Box, Layers, BarChart3, Calendar, FileText, Hash, Cpu, Database, Gauge, HardDrive, Info, Square, ChevronRight } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import { isDesktopRuntime, listenDesktopEvent, startDesktopServer, stopDesktopServer } from '@/lib/desktop';
import type { ModelInfo, ModelLoadConfig } from '@/types';
import type { LucideIcon } from 'lucide-react';
import { DEFAULT_GPU_LAYERS_WHEN_UNKNOWN, RECOMMENDED_CTX_LENGTH, recommendedGpuLayers, recommendedReasoningBudget } from '@/lib/modelDefaults';

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

  if (!model) {
    return (
      <div className="flex h-full flex-1 items-center justify-center bg-[#FBFAF6] dark:bg-[#171512]">
        <p className="text-sm text-[#7D766B] dark:text-[#A9A095]">未选择模型</p>
      </div>
    );
  }

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

  const config = model.loadConfig;
  const layerCount = Math.max(0, model.blockCount ?? 0);
  const ctxMax = Math.max(512, RECOMMENDED_CTX_LENGTH, model.ctxLength || 0, config.ctxLength || 0);
  const vramPrediction = predictVramUsage(model, config);
  const headerCards = [
    { icon: Cpu, label: '架构', value: model.architecture ?? '未读取' },
    { icon: Layers, label: '层数（block_count）', value: formatNumber(model.blockCount) },
    { icon: Hash, label: '上下文（context_length）', value: formatCtx(model.ctxLength) },
    { icon: Box, label: '专家数（expert_count）', value: formatNumber(model.expertCount) },
    { icon: Database, label: '嵌入维度（embedding）', value: formatNumber(model.embeddingLength) },
    { icon: Gauge, label: '注意力头（heads）', value: formatPair(model.headCount, model.headCountKv) },
    { icon: FileText, label: 'K/V 长度', value: formatPair(model.keyLength, model.valueLength) },
  ];
  const tabs = [
    { id: 'params' as const, label: '加载参数', icon: Hash },
    { id: 'info' as const, label: '模型信息', icon: BarChart3 },
  ];

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-[#FBFAF6] dark:bg-[#171512]">
      <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        <div className="mx-auto max-w-[1180px]">
          <ModelLoadTopBar
            model={model}
            prediction={vramPrediction}
            isLoading={isLoading}
            loadMessage={loadError ?? loadProgress}
            loadPercent={loadError ? 0 : loadProgressPercent}
            isError={Boolean(loadError)}
            onReset={() => dispatch({ type: 'UPDATE_MODEL_CONFIG', payload: { modelId: model.id, config: defaultModelLoadConfig(model) } })}
            onLoad={() => void handleLoad()}
            onStop={() => void handleStopLoading()}
          />

          <div className="mb-4 rounded-xl border border-[#DCD8CF] bg-[#FAF9F5] p-4 dark:border-white/[0.08] dark:bg-white/[0.03]">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <div
                  className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[#EEEAE2] text-sm font-semibold dark:bg-white/[0.06]"
                  style={{ color: model.themeColorSolid }}
                >
                  {model.family[0]}
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-[#2F2C26] dark:text-[#F3EBDD]">{model.family}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[#7D766B] dark:text-[#A9A095]">
                    <span className="mono-font">{model.params}</span>
                    <span>·</span>
                    <span>{model.quant}</span>
                    <span>·</span>
                    <span>{model.fileSize}</span>
                    <span className={`flex-shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium ${
                      model.modelType === 'moe' ? 'bg-[#F2F0FF] text-[#6C5DD3] dark:bg-[#262044] dark:text-[#BEB8FF]' : 'bg-[#EEF8F2] text-[#2C8B58] dark:bg-[#173024] dark:text-[#98D19C]'
                    }`}>
                      {formatModelType(model.modelType)}
                    </span>
                  </div>
                </div>
              </div>
              <div className="flex w-fit items-center gap-1 rounded-lg border border-[#DCD8CF] bg-[#FBFAF6] p-1 dark:border-white/[0.08] dark:bg-white/[0.04]">
                {tabs.map((tab) => {
                  const Icon = tab.icon;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={`relative flex h-8 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors ${
                        activeTab === tab.id ? 'text-[#D06646] dark:text-[#F0B18D]' : 'text-[#4E4941] hover:bg-[#F1EEE7] dark:text-[#D8D0C3] dark:hover:bg-white/[0.07]'
                      }`}
                    >
                      {activeTab === tab.id && (
                        <span
                          className="absolute inset-0 rounded-md bg-[#EDE8DE] transition-colors dark:bg-white/[0.08]"
                        />
                      )}
                      <Icon className="relative z-10 h-4 w-4" />
                      <span className="relative z-10">{tab.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {activeTab === 'params' ? (
            <div className="grid grid-cols-1 gap-4">
              <div className="min-w-0 overflow-hidden rounded-xl border border-[#DCD8CF] bg-[#FAF9F5] dark:border-white/[0.08] dark:bg-white/[0.03]">
                <IdleAutoUnloadParamRow
                  checked={config.idleAutoUnload}
                  minutes={config.idleAutoUnloadMinutes}
                  onToggle={(v) => updateConfig('idleAutoUnload', v)}
                  onMinutesChange={(v) => updateConfig('idleAutoUnloadMinutes', v)}
                />
                <SliderParamRow
                  label="上下文长度"
                  description={model.ctxLength > 0 ? `模型最多支持 ${model.ctxLength.toLocaleString()} 个 token` : 'GGUF 未读取到 context_length'}
                  value={config.ctxLength}
                  onChange={(v) => updateConfig('ctxLength', v)}
                  min={512}
                  max={ctxMax}
                  step={512}
                  suffix="token"
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
                <CheckboxParamRow
                  label={`记住 ${model.name} 的加载设置`}
                  checked={config.rememberSettings}
                  onChange={(v) => updateConfig('rememberSettings', v)}
                />
                <ToggleParamRow
                  label="显示高级设置"
                  checked={config.showAdvancedSettings}
                  onChange={(v) => updateConfig('showAdvancedSettings', v)}
                />
                {config.showAdvancedSettings && (
                  <div className="bg-[#F8F6F1] dark:bg-white/[0.03]">
                    <div className="border-b border-[#E3DFD6] px-3 py-2 text-xs font-semibold text-[#7D766B] dark:border-white/[0.08] dark:text-[#A9A095]">
                      高级参数
                    </div>
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
                    <SelectParamRow
                      label="推测解码"
                      description="当前基础页仅保留关闭状态"
                      value={config.speculativeDecoding}
                      onChange={(v) => updateConfig('speculativeDecoding', v)}
                      options={[{ value: 'off', label: '关闭' }]}
                    />
                    <TextParamRow
                      label="聊天模板"
                      description="留空时使用 GGUF 元数据（metadata）中的模板"
                      value={config.chatTemplate}
                      onChange={(v) => updateConfig('chatTemplate', v)}
                      placeholder="自动"
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
                      label="尝试 mmap()"
                      description="--mmap / --no-mmap"
                      checked={config.mmap}
                      onChange={(v) => updateConfig('mmap', v)}
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
                )}
              </div>
            </div>
          ) : (
            <div className="max-w-5xl space-y-4">
              <div className="rounded-xl border border-[#DCD8CF] bg-[#FAF9F5] p-5 dark:border-white/[0.08] dark:bg-white/[0.03]">
                <h3 className="mb-2 text-sm font-semibold text-[#2F2C26] dark:text-[#F3EBDD]">模型介绍</h3>
                <p className="text-sm leading-relaxed text-[#7D766B] dark:text-[#A9A095]">{model.longDescription}</p>
              </div>

              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <InfoCard icon={Calendar} label="发布日期" value={model.releaseDate} />
                <InfoCard icon={FileText} label="许可协议" value={model.license} />
                <InfoCard icon={Box} label="参数量" value={model.params} />
                <InfoCard icon={Layers} label="上下文" value={formatCtx(model.ctxLength)} />
              </div>

              <div>
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold text-[#2F2C26] dark:text-[#F3EBDD]">GGUF 表头摘要</h3>
                  <span className="text-xs text-[#7D766B] dark:text-[#A9A095]">{model.ggufMetadata?.length ?? 0} 个字段</span>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {headerCards.map((item) => (
                    <InfoCard key={item.label} icon={item.icon} label={item.label} value={item.value} />
                  ))}
                </div>
              </div>

              {model.benchmarks && (
                <div className="rounded-xl border border-[#DCD8CF] bg-[#FAF9F5] p-5 dark:border-white/[0.08] dark:bg-white/[0.03]">
                  <h3 className="mb-3 text-sm font-semibold text-[#2F2C26] dark:text-[#F3EBDD]">基准测试</h3>
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    {Object.entries(model.benchmarks).map(([key, value]) => (
                      <div key={key} className="rounded-lg border border-[#E3DFD6] bg-[#FBFAF6] p-3 text-center dark:border-white/[0.08] dark:bg-white/[0.04]">
                        <div className="mb-1 text-xs text-[#7D766B] dark:text-[#A9A095]">{key}</div>
                        <div className="mono-font text-lg font-semibold text-[#D06646]">{value}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="rounded-xl border border-[#DCD8CF] bg-[#FAF9F5] p-5 dark:border-white/[0.08] dark:bg-white/[0.03]">
                <h3 className="mb-2 text-sm font-semibold text-[#2F2C26] dark:text-[#F3EBDD]">标签</h3>
                <div className="flex flex-wrap items-center gap-2">
                  {model.tags.map((tag) => (
                    <span key={tag} className="rounded-md bg-[#F1E8E1] px-2.5 py-1 text-xs font-medium text-[#D06646] dark:bg-[#3A241C] dark:text-[#F0B18D]">{formatTag(tag)}</span>
                  ))}
                </div>
              </div>

              <div>
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold text-[#2F2C26] dark:text-[#F3EBDD]">GGUF 表头字段</h3>
                  <span className="text-xs text-[#7D766B] dark:text-[#A9A095]">仅展示真实读取到的元数据（metadata）</span>
                </div>
                {model.ggufMetadata && model.ggufMetadata.length > 0 ? (
                  <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                    {model.ggufMetadata.map(({ key, value }) => (
                      <MetadataCard key={key} name={key} value={value} />
                    ))}
                  </div>
                ) : (
                  <div className="rounded-xl border border-[#DCD8CF] bg-[#FAF9F5] p-5 text-sm text-[#7D766B] dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-[#A9A095]">
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

interface VramPrediction {
  totalGb: number;
  weightsGpuGb: number;
  weightsCpuGb: number;
  kvGb: number | null;
  computeGb: number;
  runtimeGb: number;
  safetyGb: number;
  offloadRatio: number;
  expertGpuRatio: number;
  missing: string[];
}

function cacheBytesPerValue(cacheType: string) {
  const normalized = cacheType.toLowerCase();
  if (normalized === 'f32') return 4;
  if (normalized === 'f16' || normalized === 'bf16') return 2;
  if (normalized === 'q8_0') return 1.0625;
  if (normalized === 'q5_0' || normalized === 'q5_1') return 0.75;
  if (normalized === 'q4_0' || normalized === 'q4_1' || normalized === 'iq4_nl') return 0.5625;
  return 2;
}

const CACHE_TYPES = ['f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1'];

function rowBorderClass() {
  return 'border-b border-[#E3DFD6] last:border-b-0 dark:border-white/[0.08]';
}

function ParamLabel({ label, description, badge }: { label: string; description?: string; badge?: string }) {
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-[#2F2C26] dark:text-[#F3EBDD]">{label}</span>
        <Info className="h-3.5 w-3.5 flex-shrink-0 text-[#8C8576] dark:text-[#A9A095]" />
        {badge && (
          <span className="flex-shrink-0 rounded-md border border-[#D8D2C5] bg-[#F1EEE7] px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-normal text-[#7D766B] dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[#A9A095]">
            {badge}
          </span>
        )}
      </div>
      {description && <div className="mt-0.5 text-xs text-[#7D766B] dark:text-[#A9A095]">{description}</div>}
    </div>
  );
}

function predictVramUsage(model: ModelInfo, config: ModelLoadConfig): VramPrediction {
  const gib = 1024 ** 3;
  const modelBytes = Math.max(0, model.fileSizeBytes);
  const modelGb = modelBytes / gib;
  const layerCount = Math.max(0, model.blockCount ?? 0);
  const offloadedLayers = layerCount > 0 ? clamp(config.gpuLayers, 0, layerCount) : Math.max(0, config.gpuLayers);
  const offloadRatio = layerCount > 0 ? clamp(offloadedLayers / layerCount, 0, 1) : offloadedLayers > 0 ? 1 : 0;
  const moeCpuLayers = model.modelType === 'moe' && layerCount > 0
    ? clamp(config.moeCpuLayers, 0, offloadedLayers)
    : 0;
  const expertGpuRatio = layerCount > 0 ? clamp((offloadedLayers - moeCpuLayers) / layerCount, 0, 1) : offloadRatio;
  const missing: string[] = [];
  if (model.fileSizeBytes <= 0) missing.push('file_size');

  const repeatingWeightShare = layerCount > 0 ? (model.modelType === 'moe' ? 0.96 : 0.92) : 0.9;
  const fixedWeightShare = 1 - repeatingWeightShare;
  const expertWeightShare = model.modelType === 'moe' && (model.expertCount ?? 0) > 1 ? 0.55 : 0;
  const denseWeightShare = 1 - expertWeightShare;
  const fixedGpuRatio = offloadedLayers >= layerCount && layerCount > 0
    ? 1
    : offloadedLayers > 0
      ? 0.35
      : 0;
  const repeatingGpuRatio = (denseWeightShare * offloadRatio) + (expertWeightShare * expertGpuRatio);
  const weightsGpuGb = Math.min(
    modelGb,
    modelGb * ((repeatingWeightShare * repeatingGpuRatio) + (fixedWeightShare * fixedGpuRatio))
  );
  const weightsCpuGb = Math.max(0, modelGb - weightsGpuGb);

  let kvGb: number | null = null;
  if (config.kvCache) {
    const kvHeads = model.headCountKv ?? model.headCount;
    const keyLength = model.keyLength;
    const valueLength = model.valueLength;
    if (layerCount > 0 && kvHeads && keyLength && valueLength) {
      const parallelSlots = config.parallel > 0 ? clamp(Math.round(config.parallel), 1, 128) : 1;
      const contextTokens = Math.max(1, config.ctxLength) * parallelSlots;
      const keyBytes = cacheBytesPerValue(config.cacheTypeKEnabled ? config.cacheTypeK : 'f16');
      const valueBytes = cacheBytesPerValue(config.cacheTypeVEnabled ? config.cacheTypeV : 'f16');
      const kvBytes = contextTokens
        * layerCount
        * kvHeads
        * ((keyLength * keyBytes) + (valueLength * valueBytes));
      kvGb = kvBytes / gib;
    } else {
      if (layerCount <= 0) missing.push('block_count');
      if (!kvHeads) missing.push('head_count_kv');
      if (!keyLength) missing.push('key_length');
      if (!valueLength) missing.push('value_length');
    }
  } else {
    kvGb = 0;
  }

  const embedding = model.embeddingLength && model.embeddingLength > 0 ? model.embeddingLength : 4096;
  if (!model.embeddingLength) missing.push('embedding_length');
  const batch = clamp(config.batchSize || 1, 1, 8192);
  const ubatch = clamp(config.physicalBatchSize || batch, 1, batch);
  const effectiveBatch = Math.max(1, Math.min(batch, ubatch));
  const ctxWindow = clamp(config.ctxLength || RECOMMENDED_CTX_LENGTH, 512, 262144);
  const parallelSlots = config.parallel > 0 ? clamp(Math.round(config.parallel), 1, 128) : 1;
  const headCount = Math.max(1, model.headCount ?? model.headCountKv ?? 32);
  const activationBytes = 2;
  const graphLayerFactor = clamp((layerCount || 32) / 32, 0.75, 3.5);
  const graphMultiplier = config.fastAttention ? 18 : 28;
  const graphScratchGb = (effectiveBatch * embedding * activationBytes * graphMultiplier * graphLayerFactor) / gib;
  const attentionScratchGb = config.fastAttention
    ? 0
    : (effectiveBatch * Math.min(ctxWindow, 8192) * headCount * activationBytes) / gib;
  const parallelScratchGb = Math.max(0, parallelSlots - 1) * Math.min(0.18, graphScratchGb * 0.25);
  const computeGb = weightsGpuGb > 0
    ? Math.max(0.12, graphScratchGb + attentionScratchGb + parallelScratchGb)
    : 0;
  const runtimeGb = weightsGpuGb > 0
    ? 0.3 + Math.min(0.85, (layerCount || 32) * 0.006) + (parallelSlots > 1 ? 0.04 * (parallelSlots - 1) : 0)
    : 0.05;
  const subtotalGb = weightsGpuGb + (kvGb ?? 0) + computeGb + runtimeGb;
  const safetyGb = subtotalGb > 0 ? Math.max(0.2, subtotalGb * 0.06) : 0;

  return {
    totalGb: subtotalGb + safetyGb,
    weightsGpuGb,
    weightsCpuGb,
    kvGb,
    computeGb,
    runtimeGb,
    safetyGb,
    offloadRatio,
    expertGpuRatio,
    missing,
  };
}

function ModelLoadTopBar({ model, prediction, isLoading, loadMessage, loadPercent, isError, onReset, onLoad, onStop }: {
  model: ModelInfo;
  prediction: VramPrediction;
  isLoading: boolean;
  loadMessage: string | null;
  loadPercent: number;
  isError: boolean;
  onReset: () => void;
  onLoad: () => void;
  onStop: () => void;
}) {
  const safePercent = clamp(loadPercent, 0, 100);
  const offloadPercent = Math.round(prediction.offloadRatio * 100);
  const expertPercent = Math.round(prediction.expertGpuRatio * 100);
  const progressText = loadMessage ?? (isLoading ? '正在准备加载...' : '显存预测会随参数实时更新');

  return (
    <div className="sticky top-0 z-40 mb-3 overflow-hidden rounded-xl border border-[#D8D2C5] bg-[#FBFAF6] px-3 py-2 shadow-[0_8px_22px_rgba(64,60,50,0.08)] dark:border-white/[0.08] dark:bg-[#1C1A16] dark:shadow-[0_8px_24px_rgba(0,0,0,0.28)]">
      <div className="flex flex-col gap-2 xl:flex-row xl:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div
            className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-md border border-[#DCD8CF] bg-[#FAF9F5] text-sm font-semibold dark:border-white/[0.08] dark:bg-white/[0.05]"
            style={{ color: model.themeColorSolid }}
          >
            {model.family[0]}
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold text-[#2F2C26] dark:text-[#F3EBDD]">{model.name}</h1>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-[#7D766B] dark:text-[#A9A095]">
              <span className="mono-font">{model.params}</span>
              <span>·</span>
              <span>{model.quant}</span>
              <span>·</span>
              <span>{model.fileSize}</span>
            </div>
          </div>
        </div>

        <div className="grid min-w-0 gap-1.5 sm:grid-cols-[auto_minmax(0,1fr)] xl:w-[560px] xl:flex-shrink-0">
          <div className="flex items-center gap-2 rounded-md border border-[#E2DCD1] bg-[#F4F0E8] px-2.5 py-1.5 dark:border-white/[0.08] dark:bg-white/[0.04]">
            <HardDrive className="h-4 w-4 flex-shrink-0 text-[#D06646]" />
            <div className="min-w-0">
              <div className="text-[10px] text-[#7D766B] dark:text-[#A9A095]">预计 GPU 显存</div>
              <div className="mono-font text-base font-semibold leading-tight text-[#D06646]">{formatGb(prediction.totalGb)}</div>
            </div>
          </div>

          <div className="grid min-w-0 grid-cols-3 gap-1.5 sm:grid-cols-6">
            <PredictionPill label="权重" value={formatGb(prediction.weightsGpuGb)} />
            <PredictionPill label="KV" value={prediction.kvGb === null ? '缺表头' : formatGb(prediction.kvGb)} />
            <PredictionPill label="计算" value={formatGb(prediction.computeGb)} />
            <PredictionPill label="运行" value={formatGb(prediction.runtimeGb + prediction.safetyGb)} />
            <PredictionPill label="层" value={`${offloadPercent}%`} />
            <PredictionPill label="专家" value={model.modelType === 'moe' ? `${expertPercent}%` : '稠密'} />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 xl:flex-shrink-0 xl:justify-end">
          <button
            onClick={onReset}
            disabled={isLoading}
            className="flex h-9 items-center gap-2 rounded-lg border border-[#DCD8CF] bg-[#FAF9F5] px-3 text-sm text-[#2F2C26] transition-colors hover:bg-[#F1EEE7] disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[#F3EBDD] dark:hover:bg-white/[0.09]"
          >
            <RotateCcw className="h-4 w-4 text-[#7D766B] dark:text-[#A9A095]" />
            重置
          </button>
          <button
            onClick={onLoad}
            disabled={isLoading}
            className="flex h-9 items-center gap-2 rounded-lg bg-[#D06646] px-4 text-sm font-medium text-white transition-colors hover:bg-[#BE593A] disabled:opacity-60 dark:bg-[#D7663E] dark:hover:bg-[#E27750]"
          >
            <Play className="h-4 w-4" />
            {model.status === 'loaded' ? '重新加载' : '加载模型'}
          </button>
          {isLoading && (
            <button
              onClick={onStop}
              className="flex h-9 items-center gap-2 rounded-lg border border-[#E8C9BD] bg-[#F8EDE7] px-3 text-sm text-[#C44E36] transition-colors hover:bg-[#F2DED4] dark:border-[#E8C9BD]/30 dark:bg-[#3A241C] dark:text-[#F0987C] dark:hover:bg-[#4A2D22]"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
              停止
            </button>
          )}
        </div>
      </div>

      <div className="mt-2 grid gap-1.5">
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <Info className={`h-3.5 w-3.5 flex-shrink-0 ${isError ? 'text-[#C44E36] dark:text-[#F0987C]' : 'text-[#8C8576] dark:text-[#A9A095]'}`} />
          <span className={`min-w-0 truncate ${isError ? 'text-[#C44E36] dark:text-[#F0987C]' : 'text-[#7D766B] dark:text-[#A9A095]'}`}>{progressText}</span>
          <span className="mono-font ml-auto flex-shrink-0 text-[#7D766B] dark:text-[#A9A095]">{safePercent.toFixed(0)}%</span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-[#E6E1D8] dark:bg-white/[0.08]">
          <div
            className={`h-full rounded-full transition-[width] duration-300 ease-out ${isError ? 'bg-[#C44E36]' : 'bg-[#D06646]'}`}
            style={{ width: `${safePercent}%` }}
          />
        </div>
        {prediction.missing.length > 0 && (
          <div className="truncate text-[11px] text-[#9A6700] dark:text-[#F3C66E]">
            预测缺少表头: {Array.from(new Set(prediction.missing)).join(', ')}
          </div>
        )}
      </div>
    </div>
  );
}

function PredictionPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border border-[#E3DFD6] bg-[#FBFAF6] px-2 py-1 dark:border-white/[0.08] dark:bg-white/[0.04]">
      <div className="truncate text-[10px] text-[#8C8576] dark:text-[#A9A095]">{label}</div>
      <div className="mono-font truncate text-[11px] font-semibold text-[#2F2C26] dark:text-[#F3EBDD]">{value}</div>
    </div>
  );
}

function SliderParamRow({ label, description, badge, value, onChange, min, max, step, suffix }: {
  label: string; description?: string; badge?: string; value: number; onChange: (v: number) => void; min: number; max: number; step: number; suffix?: string;
}) {
  const safeMax = Math.max(min, max);
  const sliderValue = clamp(value, min, safeMax);
  const percent = safeMax === min ? 0 : ((sliderValue - min) / (safeMax - min)) * 100;
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    if (!Number.isNaN(v)) onChange(clamp(v, min, safeMax));
  };

  return (
    <div className={`${rowBorderClass()} px-3 py-3`}>
      <div className="grid gap-3 lg:grid-cols-[minmax(220px,1fr)_minmax(260px,0.9fr)] lg:items-center">
        <ParamLabel label={label} description={description} badge={badge} />
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-3">
            <input
              type="range"
              min={min}
              max={safeMax}
              step={step}
              value={sliderValue}
              disabled={safeMax === min && min === 0}
              onChange={(e) => onChange(clamp(Number(e.target.value), min, safeMax))}
              className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full accent-[#D06646] transition-[background] duration-200"
              style={{
                background: `linear-gradient(to right, #D06646 ${percent}%, rgba(125,118,107,0.22) ${percent}%)`,
              }}
            />
            <div className="flex w-32 flex-shrink-0 items-center gap-1 rounded-md border border-[#DCD8CF] bg-[#FBFAF6] px-2 transition-colors focus-within:border-[#D06646] dark:border-white/[0.08] dark:bg-[#171512]">
              <input
                type="number"
                value={value}
                onChange={handleInputChange}
                step={step}
                className="mono-font h-8 min-w-0 flex-1 bg-transparent text-right text-sm text-[#2F2C26] outline-none dark:text-[#F3EBDD]"
              />
              {suffix && <span className="text-[11px] text-[#7D766B] dark:text-[#A9A095]">{suffix}</span>}
            </div>
          </div>
          <div className="flex justify-between">
            <span className="mono-font text-[11px] text-[#7D766B] dark:text-[#A9A095]">{min.toLocaleString()}</span>
            <span className="mono-font text-[11px] text-[#7D766B] dark:text-[#A9A095]">{safeMax.toLocaleString()}</span>
          </div>
        </div>
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
    <div className={`${rowBorderClass()} grid gap-3 px-3 py-3 lg:grid-cols-[minmax(220px,1fr)_minmax(300px,auto)] lg:items-center`}>
      <ParamLabel
        label="空闲时自动卸载"
        description="有消息输入或模型输出时会重新计时。"
      />
      <div className="flex flex-wrap items-center gap-2 lg:justify-end">
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          onClick={() => onToggle(!checked)}
          className={`flex h-6 w-11 flex-shrink-0 items-center rounded-full border p-0.5 transition-colors ${
            checked
              ? 'justify-end border-[#3B82F6] bg-[#3B82F6]'
              : 'justify-start border-[#C8C1B4] bg-[#D8D2C5] dark:border-white/[0.18] dark:bg-white/[0.10]'
          }`}
        >
          <span className="h-4.5 w-4.5 rounded-full bg-white shadow-sm" />
        </button>
        <div className={`flex min-w-0 items-center gap-1.5 text-sm ${checked ? 'text-[#2F2C26] dark:text-[#F3EBDD]' : 'text-[#8C8576] dark:text-[#A9A095]'}`}>
          <span className="whitespace-nowrap">没有消息输入和输出的</span>
          <input
            type="number"
            value={safeMinutes}
            min={1}
            max={1440}
            step={1}
            disabled={!checked}
            onChange={(event) => handleMinuteChange(event.target.value)}
            className="mono-font h-8 w-16 rounded-md border border-[#DCD8CF] bg-[#FBFAF6] px-2 text-right text-sm text-[#2F2C26] outline-none transition-colors focus:border-[#D06646] disabled:opacity-55 dark:border-white/[0.08] dark:bg-[#171512] dark:text-[#F3EBDD]"
          />
          <span className="whitespace-nowrap">分钟后自动卸载</span>
        </div>
      </div>
    </div>
  );
}

function ToggleParamRow({ label, description, badge, checked, onChange }: { label: string; description?: string; badge?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className={`${rowBorderClass()} grid gap-3 px-3 py-3 lg:grid-cols-[minmax(220px,1fr)_auto] lg:items-center`}>
      <ParamLabel label={label} description={description} badge={badge} />
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`flex h-6 w-11 flex-shrink-0 items-center rounded-full border p-0.5 transition-colors lg:justify-self-end ${
          checked
            ? 'justify-end border-[#3B82F6] bg-[#3B82F6]'
            : 'justify-start border-[#C8C1B4] bg-[#D8D2C5] dark:border-white/[0.18] dark:bg-white/[0.10]'
        }`}
      >
        <span className="h-4.5 w-4.5 rounded-full bg-white shadow-sm" />
      </button>
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
    <div className={`${rowBorderClass()} grid gap-3 px-3 py-3 lg:grid-cols-[minmax(220px,1fr)_auto] lg:items-center`}>
      <ParamLabel label={label} description={description} badge={badge} />
      <div className="flex items-center gap-2 lg:justify-end">
        {autoLabel && (
          <button
            type="button"
            onClick={() => onChange(-1)}
            className="rounded-md border border-[#DCD8CF] bg-[#F1EEE7] px-2.5 py-1.5 text-xs text-[#4E4941] transition-colors hover:bg-[#E8E2D7] dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[#D8D0C3] dark:hover:bg-white/[0.09]"
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
          className="mono-font h-9 w-28 rounded-md border border-[#DCD8CF] bg-[#FBFAF6] px-2 text-right text-sm text-[#2F2C26] outline-none transition-colors focus:border-[#D06646] dark:border-white/[0.08] dark:bg-[#171512] dark:text-[#F3EBDD]"
        />
      </div>
    </div>
  );
}

function OptionalNumberParamRow({ label, description, enabled, value, onToggle, onChange, step, autoLabel }: {
  label: string; description?: string; enabled: boolean; value: number; onToggle: (v: boolean) => void; onChange: (v: number) => void; step: number; autoLabel: string;
}) {
  return (
    <div className={`${rowBorderClass()} grid gap-3 px-3 py-3 lg:grid-cols-[minmax(220px,1fr)_auto] lg:items-center`}>
      <ParamLabel label={label} description={description} />
      <div className="flex items-center gap-2 lg:justify-end">
        <button
          type="button"
          role="checkbox"
          aria-checked={enabled}
          onClick={() => onToggle(!enabled)}
          className={`h-4 w-4 rounded-md border transition-colors ${enabled ? 'border-[#3B82F6] bg-[#3B82F6]' : 'border-[#AFA79A] bg-[#EEEAE2] dark:border-white/[0.18] dark:bg-white/[0.10]'}`}
        />
        {enabled ? (
          <input
            type="number"
            value={value}
            step={step}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (!Number.isNaN(next)) onChange(next);
            }}
            className="mono-font h-9 w-28 rounded-md border border-[#DCD8CF] bg-[#FBFAF6] px-2 text-right text-sm text-[#2F2C26] outline-none transition-colors focus:border-[#D06646] dark:border-white/[0.08] dark:bg-[#171512] dark:text-[#F3EBDD]"
          />
        ) : (
          <span className="min-w-28 text-right text-sm text-[#7D766B] dark:text-[#A9A095]">{autoLabel}</span>
        )}
      </div>
    </div>
  );
}

function ReadOnlyParamRow({ label, description, value }: { label: string; description?: string; value: string }) {
  return (
    <div className={`${rowBorderClass()} grid gap-3 px-3 py-3 lg:grid-cols-[minmax(220px,1fr)_auto] lg:items-center`}>
      <ParamLabel label={label} description={description} />
      <span className="mono-font text-sm font-medium text-[#2F2C26] dark:text-[#F3EBDD] lg:justify-self-end lg:text-right">{value}</span>
    </div>
  );
}

function SelectParamRow({ label, description, value, onChange, options }: {
  label: string; description?: string; value: string; onChange: (v: 'off') => void; options: Array<{ value: 'off'; label: string }>;
}) {
  return (
    <div className={`${rowBorderClass()} grid gap-3 px-3 py-3 lg:grid-cols-[minmax(220px,1fr)_auto] lg:items-center`}>
      <ParamLabel label={label} description={description} />
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as 'off')}
        className="h-9 w-28 rounded-md border border-[#DCD8CF] bg-[#FBFAF6] px-2 text-sm text-[#2F2C26] outline-none transition-colors focus:border-[#D06646] dark:border-white/[0.08] dark:bg-[#171512] dark:text-[#F3EBDD] lg:justify-self-end"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
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
          className="h-9 min-w-0 flex-1 rounded-md border border-[#DCD8CF] bg-[#FBFAF6] px-2 text-sm text-[#2F2C26] outline-none transition-colors placeholder:text-[#A39C8C] focus:border-[#D06646] dark:border-white/[0.08] dark:bg-[#171512] dark:text-[#F3EBDD] dark:placeholder:text-[#82786B]"
        />
        <ChevronRight className="h-4 w-4 flex-shrink-0 text-[#8C8576] dark:text-[#A9A095]" />
      </div>
    </div>
  );
}

function CacheTypeParamRow({ label, description, badge, enabled, value, onToggle, onChange }: {
  label: string; description?: string; badge?: string; enabled: boolean; value: string; onToggle: (v: boolean) => void; onChange: (v: string) => void;
}) {
  return (
    <div className={`${rowBorderClass()} grid gap-3 px-3 py-3 lg:grid-cols-[minmax(220px,1fr)_auto] lg:items-center`}>
      <ParamLabel label={label} description={description} badge={badge} />
      <div className="flex items-center gap-2 lg:justify-end">
        <button
          type="button"
          role="checkbox"
          aria-checked={enabled}
          onClick={() => onToggle(!enabled)}
          className={`h-4 w-4 rounded-md border transition-colors ${enabled ? 'border-[#3B82F6] bg-[#3B82F6]' : 'border-[#AFA79A] bg-[#EEEAE2] dark:border-white/[0.18] dark:bg-white/[0.10]'}`}
        />
        {enabled ? (
          <select
            value={value}
            onChange={(event) => onChange(event.target.value)}
            className="h-9 w-28 rounded-md border border-[#DCD8CF] bg-[#FBFAF6] px-2 text-sm text-[#2F2C26] outline-none transition-colors focus:border-[#D06646] dark:border-white/[0.08] dark:bg-[#171512] dark:text-[#F3EBDD]"
          >
            {CACHE_TYPES.map((type) => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>
        ) : (
          <span className="min-w-28 text-right text-sm text-[#7D766B] dark:text-[#A9A095]">默认 f16</span>
        )}
      </div>
    </div>
  );
}

function CheckboxParamRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={`${rowBorderClass()} grid cursor-pointer gap-3 px-3 py-3 text-sm text-[#2F2C26] transition-colors hover:bg-[#F8F6F1] dark:text-[#F3EBDD] dark:hover:bg-white/[0.04] lg:grid-cols-[minmax(220px,1fr)_auto] lg:items-center`}>
      <span className="min-w-0 truncate font-medium">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 accent-[#3B82F6] lg:justify-self-end"
      />
    </label>
  );
}

function InfoCard({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[#DCD8CF] bg-[#FAF9F5] p-4 dark:border-white/[0.08] dark:bg-white/[0.03]">
      <Icon className="mb-2 h-4 w-4 text-[#D06646]" />
      <div className="mb-0.5 text-xs text-[#7D766B] dark:text-[#A9A095]">{label}</div>
      <div className="break-words text-sm font-medium text-[#2F2C26] dark:text-[#F3EBDD]">{value}</div>
    </div>
  );
}

function MetadataCard({ name, value }: { name: string; value: string }) {
  const displayValue = truncateValue(value);

  return (
    <div className="min-w-0 rounded-xl border border-[#DCD8CF] bg-[#FAF9F5] p-4 dark:border-white/[0.08] dark:bg-white/[0.03]">
      <div className="mono-font truncate text-[11px] text-[#D06646]" title={name}>
        {name}
      </div>
      <div className="mt-2 break-words text-xs leading-relaxed text-[#7D766B] dark:text-[#A9A095]" title={value}>
        {displayValue}
      </div>
    </div>
  );
}
