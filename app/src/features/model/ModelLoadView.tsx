import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Play, RotateCcw, Box, Layers, Calendar, FileText, Hash, Cpu, Database, Gauge, History, Info, Square, ChevronRight, Settings2, Wand2, LoaderCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ModelInfo, ModelLoadConfig, SystemStats } from '@/types';
import type { ModelRunRecord } from '@/lib/desktop';
import type { VramCalibration } from '@/lib/vramCalibration';
import type { VramPrediction } from '@/lib/vramEstimate';
import { RECOMMENDED_CTX_LENGTH, maxGpuLayers } from '@/lib/modelDefaults';
import ModelFamilyLogo from '@/components/ModelFamilyLogo';
import { MODEL_LOGO_LIBRARY, LOBEHUB_CUSTOM_PREFIX } from '@/lib/modelLogo';
import { getThemeDefaultColor } from '@/lib/modelTheme';

interface ModelLoadViewProps {
  model: ModelInfo;
  prediction: VramPrediction;
  calibration: VramCalibration | null;
  systemStats: SystemStats;
  activeTab: 'params' | 'info';
  onTabChange: (tab: 'params' | 'info') => void;
  isLoading: boolean;
  loadMessage: string | null;
  loadError: string | null;
  loadPercent: number;
  statusMessage: string | null;
  autoTuneRunning: boolean;
  autoTuneStopping: boolean;
  autoTuneApplying: boolean;
  autoTuneBlocked: boolean;
  autoTuneLog: string[];
  autoTuneApplied: boolean;
  runRecords: ModelRunRecord[];
  onClearLog: () => void;
  onChangeConfig: (key: keyof ModelLoadConfig, value: unknown) => void;
  onLoad: () => void;
  onStop: () => void;
  onReset: () => void;
  onAutoTune: () => void;
  onStopAutoTune: () => void;
  apiName: string;
  apiNamePlaceholder: string;
  onApiNameChange: (value: string) => void;
  onApiNameCommit: () => void;
  logoLibraryOpen: boolean;
  onChangeLogo: () => void;
  onSelectLogo: (value: string) => void;
  /** 在同一个面板里改模型主题色（合并了原「设置 → 模型主题」的调色能力）。 */
  onChangeColor: (color: string) => void;
  onClearLogo: () => void;
  onCloseLogo: () => void;
}

/** 预设主题色：一行常用色 + 系统强调色，点击即取；也能用取色器自由选。 */
const PRESET_MODEL_COLORS = [
  '#0078D4', // Fluent 蓝
  '#0EA5E9', // 天青
  '#10B981', // 绿
  '#84CC16', // 草绿
  '#F59E0B', // 琥珀
  '#F97316', // 橙
  '#EF4444', // 红
  '#EC4899', // 玫红
  '#A855F7', // 紫
  '#6366F1', // 靛蓝
  '#14B8A6', // 青
  '#78716C', // 石灰
];

/** 模型的默认主题色（用户没改过时用它，「恢复默认」也回到这里）。 */
function defaultModelColor(model: ModelInfo) {
  return getThemeDefaultColor(model);
}

/** 去掉已有的半透明后缀，取纯色（面板的色盘只接受 #RRGGBB）。 */
function solidHex(color: string | undefined, fallback = '#0078D4') {
  if (!color) return fallback;
  const match = color.trim().match(/^#([0-9a-f]{6})/i);
  return match ? `#${match[1]}` : fallback;
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

export default function ModelLoadView(props: ModelLoadViewProps) {
  const { model, activeTab, autoTuneRunning, autoTuneLog, autoTuneApplied, runRecords, onClearLog, onChangeConfig: updateConfig } = props;
  const config = model.loadConfig;
  const layerCount = Math.max(0, model.blockCount ?? 0);
  // 内核把输出层也算一层（总层数 = block_count + 1），滑块上限必须用后者，
  // 否则「拉满」也差一层没上 GPU，生成速度成倍下降。
  const gpuLayerMax = maxGpuLayers(model.blockCount);
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
  const headerCards = [
    { icon: Cpu, label: '架构', value: model.architecture ?? '未读取' },
    { icon: Layers, label: '层数（block_count）', value: formatNumber(model.blockCount) },
    { icon: Hash, label: '上下文（context_length）', value: formatCtx(model.ctxLength) },
    { icon: Box, label: '专家数（expert_count）', value: formatNumber(model.expertCount) },
    { icon: Database, label: '嵌入维度（embedding）', value: formatNumber(model.embeddingLength) },
    { icon: Gauge, label: '注意力头（heads）', value: formatPair(model.headCount, model.headCountKv) },
    { icon: FileText, label: 'K/V 长度', value: formatPair(model.keyLength, model.valueLength) },
  ];


  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-[var(--app-bg)]">
      <div className="flex-1 overflow-y-auto px-4 py-3 sm:px-6">
        <div className="model-load-page mx-auto">
          <ModelLoadCompactHeader {...props} />
          {props.logoLibraryOpen && (
            <LogoLibraryDialog
              selected={model.customLogo}
              color={model.themeColorSolid}
              colorDefault={defaultModelColor(model)}
              onSelect={props.onSelectLogo}
              onColorChange={props.onChangeColor}
              onClear={props.onClearLogo}
              onClose={props.onCloseLogo}
            />
          )}
          {activeTab === 'params' ? (
            <div>
              <div className="model-load-param-grid">
                <ParamSection title="推理与显存" icon={Cpu}>
                  <SliderParamRow
                    label="上下文长度"
                    description={model.ctxLength > 0 ? `模型最多支持 ${model.ctxLength.toLocaleString()} 个 token` : 'GGUF 未读取到 context_length'}
                    value={config.ctxLength}
                    onChange={(v) => updateConfig('ctxLength', v)}
                    min={512}
                    max={ctxMax}
                    step={512}
                    ticks={ctxTicks}
                  />
                  <SliderParamRow
                    label="GPU 卸载"
                    description={layerCount > 0
                      ? `模型层数 ${layerCount.toLocaleString()}；内核把输出层也算一层，拉满需 ${gpuLayerMax.toLocaleString()}（含输出层）`
                      : 'GGUF 未读取到 block_count，默认尽量使用 GPU'}
                    value={config.gpuLayers}
                    onChange={(v) => updateConfig('gpuLayers', v)}
                    min={0}
                    max={gpuLayerMax}
                    step={1}
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
                  <NumberParamRow
                    label="物理批处理大小（ubatch）"
                    description="--ubatch-size / -ub"
                    value={config.physicalBatchSize}
                    onChange={(v) => updateConfig('physicalBatchSize', v)}
                    min={1}
                    max={8192}
                    step={64}
                  />
                  <CacheTypeParamRow
                    label="K 缓存量化类型"
                    description="-ctk / --cache-type-k"
                    badge="实验"
                    enabled={config.cacheTypeKEnabled}
                    value={config.cacheTypeK}
                    onToggle={(v) => {
                      updateConfig('cacheTypeKEnabled', v);
                      // 开启即用 q8_0，关闭回落 f16：两种状态都有明确默认值。
                      updateConfig('cacheTypeK', v ? 'q8_0' : 'f16');
                    }}
                    onChange={(v) => updateConfig('cacheTypeK', v)}
                  />
                  <CacheTypeParamRow
                    label="V 缓存量化类型"
                    description="-ctv / --cache-type-v"
                    badge="实验"
                    enabled={config.cacheTypeVEnabled}
                    value={config.cacheTypeV}
                    onToggle={(v) => {
                      updateConfig('cacheTypeVEnabled', v);
                      // 开启即用 q8_0，关闭回落 f16。
                      updateConfig('cacheTypeV', v ? 'q8_0' : 'f16');
                    }}
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
                    label="记住该模型的加载设置"
                    checked={config.rememberSettings}
                    onChange={(v) => updateConfig('rememberSettings', v)}
                  />
                </ParamSection>
              </div>

              <div className="model-load-advanced min-w-0 border-b border-[var(--border-subtle)]">
                <button
                  type="button"
                  aria-expanded={config.showAdvancedSettings}
                  onClick={() => updateConfig('showAdvancedSettings', !config.showAdvancedSettings)}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-[var(--surface-muted)] dark:hover:bg-white/[0.04]"
                >
                  <span className="model-load-param-control">
                    <Settings2 className="h-4 w-4 flex-shrink-0 text-[var(--accent)]" />
                    <span className="text-[length:var(--font-body)] font-semibold text-[var(--text-primary)] dark:text-[var(--text-primary)]">高级参数</span>
                    <span className="hidden truncate text-[length:var(--font-eyebrow)] text-[var(--text-secondary)] dark:text-[var(--text-secondary)] sm:inline">线程、批处理、RoPE、聊天模板等</span>
                  </span>
                  <ChevronRight className={`h-4 w-4 flex-shrink-0 text-[var(--text-secondary)] transition-transform duration-200 dark:text-[var(--text-secondary)] ${config.showAdvancedSettings ? 'rotate-90' : ''}`} />
                </button>
                {config.showAdvancedSettings && (
                  <div className="model-load-advanced-grid border-t border-[var(--border-subtle)]">
                      <div className="model-load-param-column">
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
                    <div className="model-load-param-column">
                      <SliderParamRow
                        label="评估批处理大小"
                        description="--batch-size / -b"
                        value={config.batchSize}
                        onChange={(v) => updateConfig('batchSize', v)}
                        min={1}
                        max={8192}
                        step={64}
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
              {/* 运行记录跟模型信息一起看：参数页专注「怎么加载」，信息页负责「跑过什么」。 */}
              <RunRecordsCard
                records={runRecords}
                running={autoTuneRunning}
                log={autoTuneLog}
                applied={autoTuneApplied}
                onClearLog={onClearLog}
              />
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

function ModelLoadCompactHeader({ model, prediction, calibration, systemStats, activeTab, onTabChange, apiName, apiNamePlaceholder, onApiNameChange, onApiNameCommit, onChangeLogo, isLoading, loadMessage, loadError, loadPercent, statusMessage, autoTuneRunning, autoTuneStopping, autoTuneApplying, autoTuneBlocked, onLoad, onStop, onAutoTune, onStopAutoTune, onReset }: ModelLoadViewProps) {
  const calibrated = (calibration?.samples ?? 0) > 0;
  const calibrationTitle = calibrated
    ? `按 ${calibration?.samples} 次同模型、同设备和同参数实测分项校准；${calibration?.confidence === 'measured' ? '样本较稳定' : '样本有限'}${calibration?.rejected ? `；排除 ${calibration.rejected} 条不匹配或异常记录` : ''}`
    : calibration?.legacy ? `${calibration.legacy} 条旧记录缺少完整参数或采样来源，保留展示但不参与校准` : '尚无可用于校准的同参数实测记录';
  const estimateNotes: Record<string, string> = {
    tensor_memory_layout: '权重暂按文件体积近似，重新扫描后可读取张量分布',
    tensor_upper_bound: '未知量化张量按文件跨度计算保守上界',
    kernel_layer_order: '内核版本尚未确认，部分 GPU 卸载按保守层布局计算',
    other_tensor_placement: '未分类张量的设备归属按保守值计算',
    hybrid_layer_layout: '混合架构缺少完整逐层信息',
    parallel_auto: '并发数由内核自动决定，相关状态开销暂按单路估算',
    recurrent_state: '缺少循环状态尺寸，尚未计入该部分开销',
    recurrent_rollback: '循环状态的草稿回退缓存尚未计入',
    projector_memory: '投影模型开销尚未计入',
    draft_memory: '草稿模型开销尚未计入',
    swa_capacity: 'SWA 缓存容量暂按完整上下文保守估算',
    sliding_window_pattern: '缺少逐层滑动窗口分布',
    kv_heads_by_layer: '缺少逐层 KV 头分布，部分卸载按平均值近似',
    file_size: '缺少文件体积',
    embedding_length: '缺少嵌入维度',
    block_count: '缺少模型层数',
    head_count_kv: '缺少 KV 头数',
    key_length: '缺少 K 维度',
    value_length: '缺少 V 维度',
  };
  const estimateTitle = prediction.missing.map((key) => estimateNotes[key] ?? key).join('；');
  const sourceLabel = prediction.weightSource === 'tensor' ? '张量估算' : prediction.weightSource === 'tensor_upper_bound' ? '张量上界' : '近似估算';
  const parts = [
    { label: '权重', value: prediction.weightsGpuGb, color: 'var(--accent)' },
    { label: 'KV', value: prediction.kvGb, color: 'var(--state-success)' },
    { label: '计算', value: prediction.computeGb, color: 'var(--state-warning)' },
    { label: '运行', value: prediction.runtimeGb, color: 'var(--text-secondary)' },
    { label: '余量', value: prediction.safetyGb, color: 'var(--text-tertiary)' },
  ];
  const percent = clamp(loadPercent, 0, 100);
  const stopped = !isLoading && model.status !== 'error' && loadError === '加载已停止。';
  const failed = Boolean(loadError) && !stopped;
  const hasHardware = Number.isFinite(systemStats.vramTotal) && systemStats.vramTotal > 0;
  const exceeded = hasHardware && prediction.totalGb > systemStats.vramTotal;
  const buttonClass = 'inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 text-xs transition-colors hover:bg-[var(--surface-muted)] disabled:opacity-50';

  return (
    <header className="model-load-compact-head">
      <div className="model-load-compact-identity">
        <div className="flex min-w-0 items-center gap-2.5">
          <button type="button" onClick={onChangeLogo} aria-label="更换模型头像" title="点击更换头像" className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-md border border-[var(--border)] bg-[var(--surface)]" style={{ color: model.themeColorSolid }}>
            <ModelFamilyLogo family={model.family} architecture={model.architecture} name={model.name} size={18} customSrc={model.customLogo} tone={model.themeColorSolid} fallback={model.family[0]} />
          </button>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold text-[var(--text-primary)]" title={model.name}>{model.name}</h1>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[length:var(--font-eyebrow)] text-[var(--text-secondary)]">
              <span className="mono-font">{model.params}</span><span>·</span><span>{model.quant}</span><span>·</span><span className="mono-font">{model.fileSize}</span><span className="rounded bg-[var(--accent-subtle)] px-1.5 text-[var(--accent)]">{formatModelType(model.modelType)}</span>
            </div>
          </div>
        </div>
        <label className="flex min-w-0 items-center gap-2 text-[length:var(--font-eyebrow)] text-[var(--text-secondary)]">
          <span className="flex-shrink-0">API 名</span>
          <input aria-label="API 调用名" value={apiName} placeholder={apiNamePlaceholder} onChange={(event) => onApiNameChange(event.target.value)} onBlur={onApiNameCommit} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} className="mono-font h-7 min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)] focus:border-[var(--accent)]" title="输入结束后自动保存；留空使用默认调用名" />
        </label>
      </div>
      <div className="model-load-compact-memory">
        <div className="flex flex-shrink-0 items-baseline gap-2">
          <span className="text-[length:var(--font-eyebrow)] text-[var(--text-secondary)]">预计显存</span>
          <strong className="mono-font text-base font-semibold text-[var(--accent)]">{formatGb(prediction.totalGb)}</strong>
          <span className="text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]" title={`${sourceLabel}；${calibrationTitle}${estimateTitle ? `；${estimateTitle}` : ''}`}>{calibrated ? '实测校准' : sourceLabel}{prediction.missing.length > 0 ? ' · 含近似项' : ''}</span>
        </div>
        <div className="model-load-memory-chart">
          <div className="model-load-memory-bar" aria-hidden="true">{parts.map((part) => <span key={part.label} style={{ background: part.color, flexGrow: Math.max(0, part.value ?? 0), flexBasis: 0 }} />)}</div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[length:var(--font-eyebrow)] text-[var(--text-secondary)]">
            {parts.map((part) => <span key={part.label} className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full" style={{ background: part.color }} />{part.label}<span className="mono-font">{part.value == null ? '未知' : `${part.value.toFixed(2)}G`}</span></span>)}
          </div>
        </div>
        {hasHardware && <span className={`mono-font text-[length:var(--font-eyebrow)] ${exceeded ? 'text-[var(--state-warning)]' : 'text-[var(--text-tertiary)]'}`} title={`${systemStats.gpuName} · 所有进程总占用；预测不会自动改变参数`}>设备 {systemStats.vramUsed.toFixed(1)} / {systemStats.vramTotal.toFixed(1)} GB{exceeded ? ' · 预测超容量' : ''}</span>}
      </div>
      <div className="model-load-compact-toolbar">
        <div className="relative flex items-center gap-1 rounded-[var(--radius-pill)] border border-[var(--border)] bg-[var(--surface-muted)] p-0.5" role="tablist" aria-label="模型详情视图">
          {([{ id: 'params', label: '加载参数', icon: Settings2 }, { id: 'info', label: '模型信息', icon: FileText }] as const).map(({ id, label, icon: Icon }) => {
            const active = activeTab === id;
            return (
              <button
                type="button"
                key={id}
                role="tab"
                aria-selected={active}
                aria-pressed={active}
                onClick={() => onTabChange(id)}
                className={`relative inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-pill)] px-3 text-xs font-medium transition-colors ${active ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
              >
                {active && (
                  <motion.span
                    layoutId="model-load-tab-pill"
                    className="absolute inset-0 rounded-[var(--radius-pill)] border border-[var(--border)] bg-[var(--surface)]"
                    transition={{ type: 'tween', duration: 0.16, ease: [0.33, 0, 0.67, 1] }}
                  />
                )}
                <span className="relative z-[1] inline-flex items-center gap-1.5">
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </span>
              </button>
            );
          })}
        </div>
        <div className="model-load-compact-actions">
          <button type="button" onClick={autoTuneRunning ? onStopAutoTune : onAutoTune} disabled={autoTuneApplying || (!autoTuneRunning && (isLoading || autoTuneBlocked))} className={`${buttonClass} ${autoTuneRunning ? 'text-[var(--state-danger)]' : 'text-[var(--text-primary)]'}`} title="使用完整加载基线，实测搜索 ngl / ctx / ncmoe / 独立 K/V；整卡显存预算 90%，短负载实测不保证交互最优。停止失败时可再次点击重试。">{autoTuneRunning ? <Square className="h-3 w-3 fill-current" /> : <Wand2 className="h-3.5 w-3.5 text-[var(--accent)]" />}{autoTuneApplying ? '正在应用' : autoTuneStopping ? '停止中（可重试）' : autoTuneRunning ? '停止调参' : '自动调参'}</button>
          <button type="button" onClick={onReset} disabled={isLoading || autoTuneRunning} className={`${buttonClass} text-[var(--text-secondary)]`}><RotateCcw className="h-3.5 w-3.5" />重置</button>
          <button type="button" onClick={isLoading ? onStop : onLoad} disabled={autoTuneRunning} className={`inline-flex h-8 min-w-24 items-center justify-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors disabled:opacity-50 ${isLoading ? 'border border-[var(--state-danger-border)] bg-[var(--state-danger-bg)] text-[var(--state-danger)]' : 'bg-[var(--accent)] text-[var(--text-on-accent)] hover:bg-[var(--accent-hover)]'}`}>{isLoading ? <Square className="h-3 w-3 fill-current" /> : <Play className="h-3.5 w-3.5" />}{isLoading ? '停止加载' : model.status === 'loaded' ? '重新加载' : '加载模型'}</button>
        </div>
      </div>
      {isLoading && <div className="mt-2 text-xs text-[var(--text-secondary)]" role="status"><div className="flex items-center gap-2"><LoaderCircle className="h-3.5 w-3.5 animate-spin" /><span className="min-w-0 flex-1 break-words">{loadMessage ?? '正在准备加载…'}{percent >= 100 && !loadMessage?.includes('停止') && !loadMessage?.includes('API 已就绪') ? ' · 等待 API 就绪' : ''}</span><span className="mono-font flex-shrink-0">日志阶段 {percent.toFixed(0)}%</span></div><div role="progressbar" aria-label="日志阶段进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} title="由日志阶段映射，不代表文件读取比例" className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--surface-muted)]"><div className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300" style={{ width: `${percent}%` }} /></div></div>}
      {!isLoading && loadError && <p role={failed ? 'alert' : 'status'} className={`mt-2 whitespace-pre-wrap break-words text-xs ${failed ? 'text-[var(--state-danger)]' : 'text-[var(--text-secondary)]'}`}>{loadError}</p>}
      {statusMessage && <p role="status" className="mt-1.5 text-xs text-[var(--text-secondary)]">{statusMessage}</p>}
    </header>
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
          <span className="flex-shrink-0 rounded-md border border-[var(--border)] bg-[var(--surface-muted)] px-1.5 py-0.5 text-[length:var(--font-eyebrow)] font-medium uppercase tracking-normal text-[var(--text-secondary)] dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[var(--text-secondary)]">
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
  // 用「渲染期调整 state」替代原来 effect 内的同步 setState：行为不变，
  // 但不会再触发级联渲染（原写法会被 react-hooks/set-state-in-effect 拦下）。
  const [wasRunning, setWasRunning] = useState(running);
  if (running !== wasRunning) {
    setWasRunning(running);
    if (running) setExpanded(true);
  }
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
        aria-expanded={expanded}
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
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent)] px-2 py-0.5 text-[length:var(--font-eyebrow)] font-medium text-[var(--text-on-accent)] shadow-sm">
            <span className="h-1.5 w-1.5 animate-ping rounded-full bg-white" />
            调参搜索中…
          </span>
        )}
        {!running && applied && (
          <span className="rounded-md bg-[var(--state-success-bg)] px-2 py-0.5 text-[length:var(--font-eyebrow)] font-medium text-[var(--state-success)] dark:bg-[var(--state-success-bg)] dark:text-[var(--state-success)]">
            已自动应用调参结果
          </span>
        )}
      </button>
      {expanded && (
        <div className="mt-2 space-y-1.5">
          {log.length > 0 && (
            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2 text-xs text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">
                <span className="font-mono text-[length:var(--font-eyebrow)]">调参日志（共 {log.length} 条）</span>
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
                  className="max-h-36 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--app-bg)] p-2.5 font-mono text-[length:var(--font-eyebrow)] leading-relaxed text-[var(--text-secondary)] dark:border-white/[0.08] dark:bg-black/20 dark:text-[var(--text-secondary)]"
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
                className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-md bg-[var(--surface-muted)] px-2.5 py-1.5 text-[length:var(--font-eyebrow)] dark:bg-white/[0.04]"
              >
                <span className="rounded-sm bg-[var(--accent-subtle)] px-1 py-0.5 font-medium text-[var(--accent)] dark:bg-white/[0.06]">
                  {RUN_RECORD_KIND_LABEL[record.kind] ?? record.kind}
                </span>
                <span className="mono-font text-[var(--text-primary)]">
                  ngl={record.ngl ?? '--'} ctx={record.ctx?.toLocaleString() ?? '--'} {record.vram_measurement ? `K/V=${record.vram_measurement.config.cache_type_k}/${record.vram_measurement.config.cache_type_v}` : `kv=${record.kv ?? 'f16'}`}
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
                {record.kind === 'launch' && <span className="text-[var(--text-tertiary)]" title={record.vram_measurement?.kernel_version ?? '旧记录缺少采样来源，不参与校准'}>{record.vram_measurement ? ({ stable: '稳定采样', unverified: '未核实', adapted: '有效参数变化', contaminated: '采样异常' } as const)[record.vram_measurement.quality] : '旧记录'}</span>}
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
    <div className="model-load-param-section min-w-0 border-b border-[var(--border-subtle)]">
      <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-1 py-2.5">
        <Icon className="h-4 w-4 text-[var(--accent)]" />
        <h3 className="text-[length:var(--font-body)] font-semibold text-[var(--text-primary)] dark:text-[var(--text-primary)]">{title}</h3>
      </div>
      <div>{children}</div>
    </div>
  );
}

// 头像与主题色弹窗：左侧选头像（内置品牌 logo 网格，不支持上传图片），
// 右侧调主题色（预选色 + 取色器 + 恢复默认）。合并了原「设置 → 模型主题」的能力。
function LogoLibraryDialog({ selected, color, colorDefault, onSelect, onColorChange, onClear, onClose }: {
  selected?: string;
  color: string;
  colorDefault: string;
  onSelect: (customLogo: string) => void;
  onColorChange: (color: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const isUsingLibrary = Boolean(selected?.startsWith(LOBEHUB_CUSTOM_PREFIX));
  const currentColor = solidHex(color);
  const defaultColor = solidHex(colorDefault);
  return (
    <div
      className="fixed inset-0 z-[80] grid place-items-center bg-black/40 p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="模型头像与主题色"
    >
      <div
        className="max-h-[86vh] w-[min(760px,94vw)] overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] shadow-2xl dark:border-white/[0.10] dark:bg-[#2b2b2b]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-3">
          <div>
            <div className="text-[length:var(--font-body)] font-semibold text-[var(--text-primary)]">头像与主题色</div>
            <div className="mt-0.5 text-[length:var(--font-caption)] text-[var(--text-secondary)]">点图标即应用；主题色会同步到模型卡片、对话头像与使用统计。</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-[var(--radius-field)] px-2 py-1 text-[length:var(--font-caption)] text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]"
          >
            关闭
          </button>
        </div>

        <div className="grid max-h-[68vh] gap-0 overflow-y-auto min-[720px]:grid-cols-[minmax(0,1fr)_220px]">
          {/* 左：头像库 */}
          <div className="min-w-0 border-b border-[var(--border-subtle)] p-4 min-[720px]:border-b-0 min-[720px]:border-r">
            <div className="mb-2 text-[length:var(--font-caption)] font-medium text-[var(--text-secondary)]">头像</div>
            <div className="grid grid-cols-5 gap-2 sm:grid-cols-6 md:grid-cols-8">
              {MODEL_LOGO_LIBRARY.map((entry) => {
                const value = `${LOBEHUB_CUSTOM_PREFIX}${entry.key}`;
                const active = selected === value;
                return (
                  <button
                    key={entry.key}
                    type="button"
                    onClick={() => onSelect(value)}
                    className={`flex flex-col items-center gap-1.5 rounded-[var(--radius-field)] border px-1 py-2 transition-colors ${
                      active
                        ? 'border-[var(--accent)] bg-[var(--accent-subtle)]'
                        : 'border-[var(--border)] hover:bg-[var(--surface-muted)]'
                    }`}
                    title={entry.label}
                  >
                    <ModelFamilyLogo customSrc={value} size={22} tone={currentColor} fallback={entry.label[0]} />
                    <span className="w-full truncate text-center text-[length:var(--font-eyebrow)] text-[var(--text-secondary)]">{entry.label}</span>
                  </button>
                );
              })}
            </div>
            <div className="mt-3 flex items-center justify-between gap-2 border-t border-[var(--border-subtle)] pt-2.5">
              <span className="text-[length:var(--font-caption)] text-[var(--text-secondary)]">
                当前：{selected ? (isUsingLibrary ? '品牌图标' : '自定义图片') : '默认品牌图标'}
              </span>
              <button
                type="button"
                onClick={onClear}
                className="rounded-[var(--radius-field)] border border-[var(--border)] px-2.5 py-1 text-[length:var(--font-caption)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]"
              >
                恢复默认图标
              </button>
            </div>
          </div>

          {/* 右：主题色 */}
          <div className="p-4">
            <div className="mb-2 text-[length:var(--font-caption)] font-medium text-[var(--text-secondary)]">主题色</div>
            {/* 预览：用当前色画一个头像方块，颜色变化立刻可见 */}
            <div className="mb-3 flex items-center gap-2.5">
              <span
                className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-[var(--radius-field)]"
                style={{ background: `${currentColor}1f`, color: currentColor }}
              >
                <ModelFamilyLogo
                  family={undefined}
                  architecture={undefined}
                  name={undefined}
                  size={20}
                  customSrc={selected}
                  tone={currentColor}
                  fallback={<span className="text-[length:var(--font-caption)] font-semibold">Aa</span>}
                />
              </span>
              <div className="min-w-0">
                <div className="mono-font truncate text-[length:var(--font-caption)] text-[var(--text-primary)]">{currentColor.toUpperCase()}</div>
                <button
                  type="button"
                  onClick={() => onColorChange(defaultColor)}
                  className="text-[length:var(--font-eyebrow)] text-[var(--text-secondary)] underline-offset-2 hover:text-[var(--accent)] hover:underline"
                >
                  恢复默认色
                </button>
              </div>
              <label
                className="ml-auto grid h-9 w-9 flex-shrink-0 cursor-pointer place-items-center rounded-[var(--radius-field)] border border-[var(--border)]"
                title="打开取色器自由选色"
                style={{ background: `conic-gradient(from 0deg, #f87171, #fbbf24, #34d399, #38bdf8, #a78bfa, #f472b6, #f87171)` }}
              >
                <input
                  type="color"
                  aria-label="模型主题色"
                  value={currentColor}
                  onChange={(event) => onColorChange(event.target.value)}
                  className="h-0 w-0 opacity-0"
                />
                <span className="sr-only">选择主题色</span>
              </label>
            </div>

            <div className="mb-1.5 text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">预选色</div>
            <div className="grid grid-cols-6 gap-1.5">
              {PRESET_MODEL_COLORS.map((preset) => {
                const active = preset.toLowerCase() === currentColor.toLowerCase();
                return (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => onColorChange(preset)}
                    title={preset}
                    aria-pressed={active}
                    className={`h-7 w-full rounded-[var(--radius-sm)] border transition-transform hover:scale-105 ${
                      active ? 'border-[var(--text-primary)] ring-1 ring-[var(--text-primary)]/40' : 'border-black/[0.08] dark:border-white/[0.12]'
                    }`}
                    style={{ background: preset }}
                  />
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SliderParamRow({ label, description, badge, value, onChange, min, max, step, ticks }: {
  label: string; description?: string; badge?: string; value: number; onChange: (v: number) => void; min: number; max: number; step: number;
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
            aria-label={`${label}滑杆`}
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
          <div className="flex w-32 flex-shrink-0 items-center rounded-md border border-[var(--border)] bg-[var(--app-bg)] px-2 transition-colors focus-within:border-[var(--accent)] dark:border-white/[0.08] dark:bg-[var(--app-bg)]">
            <input
              type="number"
              aria-label={label}
              value={displayValue}
              onChange={handleInputChange}
              onBlur={handleBlur}
              step={step}
              className="mono-font h-8 min-w-0 flex-1 bg-transparent text-right text-sm text-[var(--text-primary)] outline-none dark:text-[var(--text-primary)]"
            />
          </div>
        </div>
        <div className="flex justify-between">
          <span className="mono-font text-[length:var(--font-eyebrow)] text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">{min.toLocaleString()}</span>
          <span className="mono-font text-[length:var(--font-eyebrow)] text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">{safeMax.toLocaleString()}</span>
        </div>
        {ticks && ticks.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="text-[length:var(--font-micro)] text-[var(--text-tertiary)]">快速定位</span>
            {ticks.map((tick) => (
              <button
                key={tick.value}
                type="button"
                onClick={() => {
                  setDraft(null);
                  onChange(clamp(tick.value, min, safeMax));
                }}
                className={`mono-font rounded border px-1.5 py-0.5 text-[length:var(--font-micro)] transition-colors ${
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
    <div className={`${rowBorderClass()} model-load-param-row model-load-param-row--idle`}>
      <ParamLabel
        label="空闲时自动卸载"
        description="有消息输入或模型输出时会重新计时。"
      />
      <div className="model-load-param-control flex-wrap">
        <ToggleSwitch checked={checked} onChange={onToggle} ariaLabel="空闲时自动卸载" />
        <div className={`flex min-w-0 flex-wrap items-center gap-1.5 text-sm ${checked ? 'text-[var(--text-primary)] dark:text-[var(--text-primary)]' : 'text-[var(--text-secondary)] dark:text-[var(--text-secondary)]'}`}>
          <span>没有消息输入和输出的</span>
          <input
            type="number"
            aria-label="自动卸载等待分钟数"
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
    <div className={`${rowBorderClass()} model-load-param-row`}>
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
    <div className={`${rowBorderClass()} model-load-param-row model-load-param-row--toggle`}>
      <ParamLabel label={label} description={description} badge={badge} />
      <div className="model-load-param-control justify-end">
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
    <div className={`${rowBorderClass()} model-load-param-row`}>
      <ParamLabel label={label} description={description} badge={badge} />
      <div className="model-load-param-control">
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
          aria-label={label}
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
    <div className={`${rowBorderClass()} model-load-param-row`}>
      <ParamLabel label={label} description={description} />
      <div className="model-load-param-control">
        <ToggleSwitch size="sm" checked={enabled} onChange={onToggle} ariaLabel={label} />
        {enabled ? (
          <input
            type="number"
            aria-label={label}
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
    <div className={`${rowBorderClass()} model-load-param-row`}>
      <ParamLabel label={label} description={description} />
      <span className="mono-font text-sm font-medium text-[var(--text-primary)] dark:text-[var(--text-primary)] text-right">{value}</span>
    </div>
  );
}

function TextParamRow({ label, description, value, onChange, placeholder }: {
  label: string; description?: string; value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <div className={`${rowBorderClass()} model-load-param-row model-load-param-row--text`}>
      <ParamLabel label={label} description={description} />
      <div className="model-load-param-control">
        <input
          value={value}
          aria-label={label}
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
    <div className={`${rowBorderClass()} model-load-param-row`}>
      <ParamLabel label={label} description={description} badge={badge} />
      <div className="model-load-param-control">
        <ToggleSwitch size="sm" checked={enabled} onChange={onToggle} ariaLabel={label} />
        {enabled ? (
          <select
            value={value}
            aria-label={label}
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
    <div className={`${rowBorderClass()} model-load-param-row model-load-param-row--toggle text-sm text-[var(--text-primary)]`}>
      <span className="min-w-0 break-words font-medium">{label}</span>
      <div className="model-load-param-control justify-end">
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
      <div className="mono-font truncate text-[length:var(--font-eyebrow)] text-[var(--accent)]" title={name}>
        {name}
      </div>
      <div className="mt-2 break-words text-xs leading-relaxed text-[var(--text-secondary)] dark:text-[var(--text-secondary)]" title={value}>
        {displayValue}
      </div>
    </div>
  );
}
