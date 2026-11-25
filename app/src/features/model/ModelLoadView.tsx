import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { Play, RotateCcw, Box, Layers, Calendar, FileText, Hash, Cpu, Database, Gauge, History, Info, Square, ChevronRight, Settings2, Wand2, LoaderCircle, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ModelInfo, ModelLoadConfig, SystemStats } from '@/types';
import type { ModelRunRecord } from '@/lib/desktop';
import type { TuneRecord } from '@/lib/ipc/model';
import { AUTO_TUNE_POINT_BUDGET, tuneRecordPatch, type AutoTuneTask } from '@/lib/autoTuneTask';
import type { BackendTuningAdvice } from '@/lib/ipc/hardware';
import type { VramCalibration } from '@/lib/vramCalibration';
import type { VramPrediction } from '@/lib/vramEstimate';
import { RECOMMENDED_CTX_LENGTH, maxGpuLayers } from '@/lib/modelDefaults';
import ModelFamilyLogo from '@/components/ModelFamilyLogo';
import { MODEL_LOGO_LIBRARY, LOBEHUB_CUSTOM_PREFIX } from '@/lib/modelLogo';
import { getThemeDefaultColor } from '@/lib/modelTheme';

interface ModelLoadViewProps {
  model: ModelInfo;
  prediction: VramPrediction;
  /** 不含同参数实测总量覆盖的纯估算，用于和实测并列展示偏差。 */
  analyticalPrediction: VramPrediction;
  calibration: VramCalibration | null;
  systemStats: SystemStats;
  activeTab: 'params' | 'info';
  onTabChange: (tab: 'params' | 'info') => void;
  isLoading: boolean;
  loadMessage: string | null;
  loadError: string | null;
  loadPercent: number;
  statusMessage: string | null;
  /** 本次启动实际生效参数与请求参数不一致时的说明（CPU 兼容回退等）；null 表示无降级。 */
  launchNotice: string | null;
  autoTuneRunning: boolean;
  autoTuneStopping: boolean;
  autoTuneApplying: boolean;
  autoTuneBlocked: boolean;
  /** 当前模型自己的调参任务快照；其他模型的任务不在这里显示进度。 */
  autoTuneTask: AutoTuneTask | null;
  autoTuneLog: string[];
  autoTuneApplied: boolean;
  runRecords: ModelRunRecord[];
  onClearLog: () => void;
  /** 撤销某次调参：恢复记录里的调参前完整加载配置。 */
  onRestoreConfig: (config: ModelLoadConfig) => void;
  /** 再次应用某次调参记录里的最佳参数（只写回调参涉及的字段）。 */
  onApplyTuneRecord: (record: TuneRecord) => void;
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
  /** AMD / Vulkan 调优建议；非 AMD 机器或数据未就绪时为 null。 */
  tuningAdvice?: BackendTuningAdvice | null;
  /** 一键应用调优建议（批处理 + KV 量化）。 */
  onApplyTuningAdvice: () => void;
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

function formatElapsed(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function autoTunePhaseLabel(phase?: string) {
  switch (phase) {
    case 'coarse': return '显存边界搜索';
    case 'tune': return '参数优化';
    case 'refine': return '复测最优候选';
    case 'candidate_failed': return '候选失败，继续搜索';
    default: return '设备探测';
  }
}

/**
 * 显存预估 missing 项里，哪些属于「已按近似值计入」。
 * 不在集合里的项表示尚未计入，实际占用可能比预计更高。
 */
const APPROXIMATE_ESTIMATE_KEYS = new Set([
  'tensor_memory_layout', 'tensor_upper_bound', 'kernel_layer_order', 'other_tensor_placement',
  'hybrid_layer_layout', 'parallel_auto', 'dense_ffn_offload', 'swa_capacity',
  'sliding_window_pattern', 'kv_heads_by_layer',
]);

/**
 * 草稿 / 投影显存是否已有可用的近似值：只有读到文件大小（或内置 MTP 层数）
 * 才算「近似计入」，否则该项主要是未计入的权重体积。
 */
function estimateEntryApproximate(key: string, model: ModelInfo) {
  if (key === 'draft_memory') {
    const mode = model.loadConfig.speculativeDecoding;
    const sizeGb = mode === 'dspark' ? model.dsparkDraftSizeGb
      : mode === 'dflash' ? model.dflashDraftSizeGb
        : mode === 'mtp' ? model.mtpDraftSizeGb : 0;
    return (sizeGb ?? 0) > 0
      || (mode === 'mtp' && Boolean(model.hasEmbeddedMtp) && (model.nextnPredictLayers ?? 0) > 0);
  }
  return APPROXIMATE_ESTIMATE_KEYS.has(key);
}

const SPEC_MODE_LABEL: Record<string, string> = {
  off: '关闭',
  mtp: 'MTP',
  dspark: 'DSpark',
  dflash: 'DFlash',
};

const TUNE_FAILURE_LABEL: Record<string, string> = {
  oom: '显存不足',
  unsupported: '内核不支持',
  fatal: '启动/测量失败',
  cancelled: '已取消',
};

/** 调参最佳结果与调参前配置的差异，只列真正变化的字段。 */
function tuneRecordDiff(loadConfig: ModelLoadConfig, record: TuneRecord) {
  const kvBefore = `${loadConfig.cacheTypeKEnabled ? loadConfig.cacheTypeK : 'f16'}/${loadConfig.cacheTypeVEnabled ? loadConfig.cacheTypeV : 'f16'}`;
  const kvAfter = record.cache_type_k_enabled || record.cache_type_v_enabled
    ? `${record.cache_type_k}/${record.cache_type_v}` : 'f16/f16';
  const rows = [
    { label: '上下文（ctx）', before: String(loadConfig.ctxLength), after: String(record.ctx) },
    { label: 'GPU 卸载（ngl）', before: String(loadConfig.gpuLayers), after: String(record.ngl) },
    { label: 'CPU MoE 层', before: String(loadConfig.moeCpuLayers), after: String(record.ncmoe) },
    { label: 'CPU FFN 层', before: String(loadConfig.nCpuFfn), after: String(record.n_cpu_ffn ?? 0) },
    { label: 'MoE 显存缓存', before: `${loadConfig.moeCacheMib} MiB`, after: `${record.moe_cache_mib ?? 0} MiB` },
    { label: 'KV 缓存', before: kvBefore, after: kvAfter },
    { label: '推测解码', before: SPEC_MODE_LABEL[loadConfig.speculativeDecoding] ?? loadConfig.speculativeDecoding, after: SPEC_MODE_LABEL[record.speculative ?? 'off'] ?? (record.speculative || 'off') },
    // 旧记录缺少 threads 时不会写回，也就不在差异里展示。
    ...(record.threads != null ? [{ label: '线程', before: String(loadConfig.threads), after: String(record.threads) }] : []),
  ];
  return rows.filter((row) => row.before !== row.after);
}

/**
 * 每个加载参数的中文用途详解。
 *
 * 界面上只放简短描述，完整的取舍、适用场景和风险放在悬停提示里，
 * 避免在参数行里堆长文，同时保证参数含义不依赖用户去读 llama.cpp 文档。
 * 新增参数时在这里补一条；未命中的标签仍保留原来的信息图标。
 */
const PARAM_TOOLTIPS: Record<string, string> = {
  '上下文长度': '模型一次能记住的词元（token）总数，决定长文档、长对话和代码分析的上限。调大后键值缓存（KV）会线性增长、加载更慢；显存不足时可能直接加载失败。日常对话 32K 通常够用，长文档再按需提高。',
  'GPU 卸载': '把模型的前 N 层（内核把输出层也算一层）放到显卡上计算。值越高生成越快、显存占用越大；拉满一般是模型层数 + 1。显存不够时优先降它，或配合下面的混合专家（MoE）/ 前馈网络（FFN）处理器卸载。',
  '将 KV 缓存卸载到 GPU 内存': '把对话历史对应的键值缓存（KV）也放到显存。开启后每生成一个词元不必反复从内存搬运，速度更快；关闭可省显存，但长上下文会明显变慢。',
  '快速注意力': '启用快速注意力（Flash Attention）。支持 NVIDIA CUDA / Vulkan 的显卡上能显著降低注意力计算的显存和耗时；如果遇到花屏、答非所问或驱动兼容问题，再尝试关闭对比。',
  '物理批处理大小（ubatch）': '一次真正送进计算图的词元数，影响预填充阶段的显存峰值。调小更省显存但提示词处理更慢；调大速度更快但容易显存不足，通常 256–512 比较稳。',
  'K 缓存量化类型': '压缩注意力键缓存（K）的精度来省显存。q8_0 基本无损、最推荐；q5/q4 更省但可能影响长上下文质量。只在显存紧张时开启，键缓存和值缓存可以分别设置。',
  'V 缓存量化类型': '压缩注意力值缓存（V）的精度来省显存。q8_0 通常安全；更激进的量化可能让长文生成质量下降。显存够就保持 f16。',
  '强制 MoE 权重留在 CPU 的层数': '混合专家（MoE）模型每层有很多专家，把前 N 层的专家权重留在处理器内存、不占显存。能显著降低显存占用，但被留在处理器的专家计算更慢；0 表示全部按显卡卸载处理。',
  'MoE 专家 GPU 缓存': '给留在处理器内存的混合专家（MoE）权重在显存里开一块缓存，重复命中的专家不必每次都走内存。0 关闭；1–4 GB 往往能明显提速，但会直接占用显存。',
  '稠密 FFN 留在 CPU 的层数': '仅稠密模型：把前 N 层的前馈网络（FFN）权重留在处理器内存，降低显存占用。值越大越省显存、生成越慢；0 表示不做额外处理器卸载。显存预测暂未精确计入这部分。',
  '空闲时自动卸载': '应用层计时器：一段时间没有输入或输出就自动停止模型、释放显存，适合多模型轮换或把显卡让给游戏 / 绘图。有新的消息或生成活动会重新计时。',
  '记住该模型的加载设置': '开启后，本模型的这些参数会保存到本地，下次打开或快速启动时沿用；关闭则每次回到默认值，适合临时试参。',
  'CPU 线程池大小': '生成阶段使用的处理器线程数。-1 交给内核按核心数自动决定；手动设置时通常取物理核心数，设太高会和系统或其他进程抢处理器，反而变慢。',
  '最大并发预测数（parallel）': '同时服务多少个请求槽位。单人多半保持自动或 1；多人 / 接口并发时调大，但每个槽位都要占键值缓存和解码资源，显存会明显增加。',
  '统一 KV 缓存': '所有并发槽共享一块键值缓存（KV）池，长请求可以借用空闲槽的容量，减少显存浪费；关闭后每个槽固定分配，隔离性更好但更容易浪费。',
  '保持模型在内存中': '用内存锁定（mlock）把模型锁在物理内存，避免被系统换出到页面文件。内存充足时能减少卡顿；内存紧张时开启可能拖慢整个系统。',
  '跳过启动预热': '启动时不做空跑预热，模型加载更快；代价是第一条真实请求要承担初始化和显存分配的开销，可能明显更慢。超大模型排障时可临时开启。',
  '尝试 mmap()': '用内存映射（mmap）读取模型文件，通常加载更快、内存占用更低；遇到页面文件频繁读取、机械盘或网络盘卡顿时可关闭。新内核会把它翻译成加载模式参数。',
  '大张量按需读取': '对逐层词嵌入等超大张量按需从磁盘读取。内核默认只对超过 4 GB 的张量启用；开启后更省内存但首次使用更慢；关闭则全部常驻。需要开启内存映射。',
  'SWA 完整缓存': '滑动窗口注意力（SWA）模型默认只为窗口范围分配键值缓存。开启后按完整上下文分配，长文更稳、更少遗忘，但显存占用会明显增加。',
  '每路上下文上限': '统一键值缓存模式下限制单个并发槽最多用多少上下文，防止一个长请求占满整块共享池。关闭表示由内核按上下文长度和并发数自行分配。',
  '提示词缓存上限': '提示词缓存占用的系统内存上限，单位 MiB。缓存重复前缀能加快多轮对话；0 关闭，-1 不限制，默认 8192。开太大可能挤占其他程序内存。',
  '评估批处理大小': '逻辑批处理上限，影响一次能并行处理多少词元。调大能加快长提示词预填充，但会增加计算显存；一般 512–2048，且不要超过上下文长度。',
  'RoPE 频率基': '覆盖模型自带的旋转位置编码（RoPE）基频。只在模型说明明确要求或做超长上下文扩展时填写；乱改会让模型输出退化。关闭时从 GGUF 读取。',
  'RoPE 频率比例': '按 1/N 扩展旋转位置编码（RoPE）上下文。用于模型训练时使用了特定缩放、或你需要把上下文拉到训练长度之外；没有明确依据时保持自动。',
  '专家数量': '从 GGUF 元数据读取的混合专家数量，只用于判断模型结构和估算显存，不是启动参数，无法在这里修改。',
  '推测解码': '用一个更小的草稿模型或内置多词元预测（MTP）层先猜多个词元，再由主模型验证，命中时生成更快。需要模型自带 MTP 或匹配的 DSpark / DFlash 侧车；不匹配或显存不足时会变慢甚至启动失败。',
  '草稿深度': '每一步最多让草稿模型猜多少个词元。调大命中时收益更高，但被主模型拒绝时会浪费更多计算；1–16 之间按模型和任务试，关闭则用内核默认。',
  '草稿上下文批大小': '草稿模型一次处理的物理批大小。调小能省草稿上下文显存，但草稿生成更慢；0 表示跟随主模型的物理批大小。',
  '多模态投影 GPU 卸载': '把视觉 / 音频多模态投影模型放到显卡。开启编码图片、视频更快；关闭后投影留在处理器内存，能省显存但多模态输入会明显变慢。',
  '聊天模板': '覆盖 GGUF 内置的 Jinja 对话模板。只有模型模板缺失、格式不对或你要自定义系统提示词结构时才填；填错会导致角色错乱或工具调用失效。',
  '种子': '固定随机数种子，让相同提示词和参数下的输出更可复现。关闭时每次随机；注意显卡、并发和采样参数变化仍可能带来差异。',
  'NextN / MTP 元数据': 'GGUF 声明了 NextN / 多词元预测（MTP）层，但当前内核没有对应架构图或缺少可执行张量，因此不能启用内置多词元预测。换支持该架构的内核或改用独立草稿模型。',
};

/** 调参结果会写回的字段 → 面向用户的中文名。 */
const TUNE_FIELD_LABELS: Record<string, string> = {
  gpuLayers: 'GPU 卸载（ngl）',
  ctxLength: '上下文长度',
  moeCpuLayers: 'MoE CPU 层（ncmoe）',
  nCpuFfn: 'FFN 卸载（ncffn）',
  moeCacheMib: 'MoE 缓存（MiB）',
  speculativeDecoding: '推测解码',
  specDraftNMaxEnabled: '草稿深度开关',
  specDraftNMax: '草稿深度',
  specDraftNubatch: '草稿 ubatch',
  threads: 'CPU 线程',
  cacheTypeK: 'K 缓存类型',
  cacheTypeV: 'V 缓存类型',
  cacheTypeKEnabled: 'K 缓存量化',
  cacheTypeVEnabled: 'V 缓存量化',
};

function formatTuneValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? '开' : '关';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '—';
  if (value === 'off') return '关闭';
  if (value === undefined || value === null || value === '') return '—';
  return String(value);
}

/**
 * 「调参前配置 → 最佳候选」的逐项差异。
 *
 * 自动应用后当前参数已经等于最佳结果，界面上再也看不出改了什么；
 * 调参前配置随实验记录落盘，所以这里用 `experiment.load_config` 作基线。
 */
function tuneChangeRows(before: ModelLoadConfig, best: TuneRecord): Array<{ label: string; from: string; to: string }> {
  const patch = tuneRecordPatch(best);
  const rows: Array<{ label: string; from: string; to: string }> = [];
  for (const key of Object.keys(patch) as Array<keyof ModelLoadConfig>) {
    const prev: unknown = before[key];
    const next: unknown = patch[key];
    if (prev === next) continue;
    rows.push({ label: TUNE_FIELD_LABELS[key] ?? key, from: formatTuneValue(prev), to: formatTuneValue(next) });
  }
  return rows;
}

function tuningCandidateLabel(record: TuneRecord): string {
  const parts = [`ngl ${record.ngl}`];
  if (record.ncmoe > 0) parts.push(`ncmoe ${record.ncmoe}`);
  if (record.n_cpu_ffn) parts.push(`ffn ${record.n_cpu_ffn}`);
  if (record.moe_cache_mib) parts.push(`MoE缓存 ${record.moe_cache_mib}MiB`);
  parts.push(`ctx ${record.ctx}`);
  if (record.cache_type_k_enabled || record.cache_type_v_enabled) parts.push(`KV ${record.cache_type_k}/${record.cache_type_v}`);
  if (record.speculative && record.speculative !== 'off') parts.push(record.speculative);
  return parts.join(' · ');
}

/**
 * 调参进行中的候选实测列表：参数页直接显示每点的 tok/s（含标准差）、显存与最佳项。
 *
 * 之前只有「模型信息」页签能看到这些数据，从默认的参数页启动调参后只能等按钮文字变化。
 * 排序用「中位数 − 标准差」与后端一致，避免把抖动当最佳。
 */
function TuningCandidateList({ records }: { records: TuneRecord[] }) {
  const scored = records.map((record) => ({
    record,
    score: record.ts - Math.max(0, record.ts_stddev ?? 0),
  }));
  let bestIndex = -1;
  scored.forEach((item, index) => {
    if (!item.record.fits) return;
    if (bestIndex < 0 || item.score > scored[bestIndex].score) bestIndex = index;
  });
  return (
    <div className="anim-enter-fade mt-1.5 max-h-24 overflow-y-auto rounded-[var(--radius-field)] border border-[var(--border-subtle)]">
      <table className="w-full text-[length:var(--font-eyebrow)]">
        <thead className="sticky top-0 bg-[var(--surface-muted)] text-[var(--text-tertiary)]">
          <tr>
            <th className="px-2 py-1 text-left font-medium">候选参数</th>
            <th className="w-24 px-2 py-1 text-right font-medium">tok/s</th>
            <th className="w-20 px-2 py-1 text-right font-medium">显存</th>
            <th className="w-16 px-2 py-1 text-right font-medium">结果</th>
          </tr>
        </thead>
        <tbody>
          {scored.map((item, index) => (
            <tr key={`${item.record.ngl}-${item.record.ctx}-${index}`} className={index === bestIndex ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'}>
              <td className="max-w-0 truncate px-2 py-1 font-mono" title={tuningCandidateLabel(item.record)}>{tuningCandidateLabel(item.record)}</td>
              <td className="px-2 py-1 text-right font-mono">
                {item.record.fits
                  ? `${item.record.ts.toFixed(1)}${item.record.ts_stddev ? ` ±${item.record.ts_stddev.toFixed(1)}` : ''}`
                  : '—'}
              </td>
              <td className="px-2 py-1 text-right font-mono">{item.record.vram_used_gb > 0 ? `${item.record.vram_used_gb.toFixed(1)}G` : '—'}</td>
              <td className="px-2 py-1 text-right">{index === bestIndex ? '最佳' : item.record.fits ? '' : '不可用'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ModelLoadView(props: ModelLoadViewProps) {
  const { model, activeTab, autoTuneRunning, autoTuneLog, autoTuneApplied, runRecords, onClearLog, onChangeConfig: updateConfig } = props;
  const config = model.loadConfig;
  // 运行记录按时间从新到旧；取最近一次调参结果，供参数页给出可撤销的回执。
  const latestAutoTuneExperiment = runRecords.find((record) => record.kind === 'autotune' && record.autotune)?.autotune ?? null;
  const latestAutoTuneBest = latestAutoTuneExperiment?.best;
  // 调参前后逐项差异：调参前配置保存在实验记录里，因此重启后仍能看「改了什么」。
  const latestTuneChanges = latestAutoTuneExperiment?.best
    ? tuneChangeRows(latestAutoTuneExperiment.load_config, latestAutoTuneExperiment.best)
    : [];
  // 撤销后当前参数不再等于最佳结果，回执横幅随之消失，避免继续声称「已应用」。
  const latestAutoTuneApplied = Boolean(latestAutoTuneBest
    && config.gpuLayers === latestAutoTuneBest.ngl
    && config.ctxLength === latestAutoTuneBest.ctx
    && config.cacheTypeKEnabled === latestAutoTuneBest.cache_type_k_enabled
    && config.cacheTypeK === latestAutoTuneBest.cache_type_k
    && config.cacheTypeVEnabled === latestAutoTuneBest.cache_type_v_enabled
    && config.cacheTypeV === latestAutoTuneBest.cache_type_v);
  const layerCount = Math.max(0, model.blockCount ?? 0);
  const hasMultimodalProjector = Boolean(model.mmprojPath && (model.supportsVision || model.supportsAudio));
  const kvPerSlotDefault = Math.max(
    512,
    Math.floor(config.ctxLength / Math.max(1, config.parallel > 0 ? config.parallel : 1)),
  );
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
          {props.tuningAdvice && props.tuningAdvice.notes.length > 0 && activeTab === 'params' && (
            <div className="accent-soft mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[var(--radius-field)] px-4 py-3">
              <Sparkles className="h-4 w-4 flex-shrink-0 text-[var(--accent)]" />
              <span className="min-w-0 flex-1 text-[length:var(--font-caption)] leading-[var(--leading-ui)] text-[var(--text-secondary)]">
                {props.tuningAdvice.notes.join(' ')}
              </span>
              <span className="mono-font flex-shrink-0 text-[length:var(--font-micro)] text-[var(--text-tertiary)]">
                建议 -ub {props.tuningAdvice.recommendedUbatch} · -b {props.tuningAdvice.recommendedBatch}
                {props.tuningAdvice.recommendedKvQuant ? ` · KV ${props.tuningAdvice.recommendedKvQuant}` : ''}
              </span>
              <button
                type="button"
                onClick={props.onApplyTuningAdvice}
                className="flex flex-shrink-0 items-center gap-1 rounded-[var(--radius-field)] border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-[length:var(--font-caption)] font-semibold text-[var(--accent)] transition-colors hover:bg-[var(--surface-muted)]"
              >
                <Wand2 className="h-3.5 w-3.5" />
                应用建议
              </button>
            </div>
          )}
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
              {autoTuneApplied && latestAutoTuneApplied && latestAutoTuneBest && (
                <div className="accent-soft mt-3 rounded-[var(--radius-field)] px-4 py-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <Sparkles className="h-4 w-4 flex-shrink-0 text-[var(--accent)]" />
                    <span className="min-w-0 flex-1 text-[length:var(--font-caption)] leading-[var(--leading-ui)] text-[var(--text-secondary)]">
                      自动调参已完成并应用最佳参数：ctx {latestAutoTuneBest.ctx.toLocaleString()} · ngl {latestAutoTuneBest.ngl} · K/V {latestAutoTuneBest.kv} · {latestAutoTuneBest.ts.toFixed(1)} tok/s。调参前的参数已随运行记录保存。
                    </span>
                    <button
                      type="button"
                      onClick={() => props.onTabChange('info')}
                      className="flex flex-shrink-0 items-center gap-1 rounded-[var(--radius-field)] border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-[length:var(--font-caption)] font-semibold text-[var(--accent)] transition-colors hover:bg-[var(--surface-muted)]"
                    >
                      查看明细与撤销
                    </button>
                  </div>
                  {/* 变更明细：说清「哪些参数从多少改到多少」，而不是只报「已应用」。 */}
                  {latestTuneChanges.length > 0 && (
                    <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-t border-[var(--border-subtle)] pt-1.5 text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">
                      <span className="font-medium text-[var(--text-secondary)]">本次变更</span>
                      {latestTuneChanges.map((row) => (
                        <span key={row.label} className="mono-font">{row.label} {row.from} → {row.to}</span>
                      ))}
                    </div>
                  )}
                </div>
              )}
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
                    description="关闭后键值缓存留在内存，省显存但生成变慢（--kv-offload / --no-kv-offload）"
                    checked={config.kvCache}
                    onChange={(v) => updateConfig('kvCache', v)}
                  />
                  <ToggleParamRow
                    label="快速注意力"
                    description="降低注意力显存与耗时；兼容问题时可关闭（--flash-attn）"
                    checked={config.fastAttention}
                    onChange={(v) => updateConfig('fastAttention', v)}
                  />
                  <ToggleParamRow
                    label="CPU 兼容重试"
                    description="GPU 加载失败或显存不足时自动改用 CPU 模式重启。默认关闭；开启后会改写 ngl、ctx、batch 等参数，自动调参不使用该回退"
                    checked={config.retryCpuFallback}
                    onChange={(v) => updateConfig('retryCpuFallback', v)}
                  />
                </ParamSection>

                <ParamSection title="缓存与运行行为" icon={Database}>
                  <NumberParamRow
                    label="物理批处理大小（ubatch）"
                    description="一次送进计算图的词元数；调小省显存（--ubatch-size）"
                    value={config.physicalBatchSize}
                    onChange={(v) => updateConfig('physicalBatchSize', v)}
                    min={1}
                    max={8192}
                    step={64}
                  />
                  <CacheTypeParamRow
                    label="K 缓存量化类型"
                    description="压缩键缓存精度省显存；q8_0 基本无损（--cache-type-k）"
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
                    description="压缩值缓存精度省显存；q8_0 通常安全（--cache-type-v）"
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
                  {model.modelType === 'moe' ? (
                    <>
                      <SliderParamRow
                        label="强制 MoE 权重留在 CPU 的层数"
                        description="前 N 层专家留在内存，降低显存占用（--n-cpu-moe）"
                        badge="实验"
                        value={config.moeCpuLayers}
                        onChange={(v) => updateConfig('moeCpuLayers', v)}
                        min={0}
                        max={layerCount}
                        step={1}
                      />
                      <OptionalNumberParamRow
                        label="MoE 专家 GPU 缓存"
                        description="把内存中的专家按需缓存在显存，0 关闭（--moe-cache-mib）"
                        badge="实验"
                        enabled={config.moeCacheMib > 0}
                        value={config.moeCacheMib > 0 ? config.moeCacheMib : 2048}
                        onToggle={(v) => updateConfig('moeCacheMib', v ? 2048 : 0)}
                        onChange={(v) => updateConfig('moeCacheMib', Math.max(0, Math.round(v)))}
                        step={256}
                        autoLabel="关闭"
                      />
                    </>
                  ) : (
                    <SliderParamRow
                      label="稠密 FFN 留在 CPU 的层数"
                      description="前 N 层前馈网络留在内存；0 关闭（--n-cpu-ffn）"
                      badge="实验"
                      value={config.nCpuFfn}
                      onChange={(v) => updateConfig('nCpuFfn', v)}
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
                        description="处理器线程数；自动时由内核决定（--threads）"
                        value={config.threads}
                        onChange={(v) => updateConfig('threads', v)}
                        min={-1}
                        max={256}
                        step={1}
                        autoLabel="自动"
                      />
                      <NumberParamRow
                        label="最大并发预测数（parallel）"
                        description="同时服务的请求槽位；自动时由内核决定（--parallel）"
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
                        description="所有并发槽共享键值缓存，减少浪费（--kv-unified）"
                        badge="实验"
                        checked={config.kvUnified}
                        onChange={(v) => updateConfig('kvUnified', v)}
                      />
                      <ToggleParamRow
                        label="保持模型在内存中"
                        description="锁定模型在物理内存，避免换出（--mlock）"
                        checked={config.mlock}
                        onChange={(v) => updateConfig('mlock', v)}
                      />
                      <ToggleParamRow
                        label="跳过启动预热"
                        description="跳过启动预热；首次验证更快（--no-warmup）"
                        badge="实验"
                        checked={config.noWarmup}
                        onChange={(v) => updateConfig('noWarmup', v)}
                      />
                      <ToggleParamRow
                        label="尝试 mmap()"
                        description="用内存映射读取模型文件（--mmap / --no-mmap）"
                        checked={config.mmap}
                        onChange={(v) => updateConfig('mmap', v)}
                      />
                      <SelectParamRow
                        label="大张量按需读取"
                        description="超大张量按需从磁盘读取；需内存映射（--lazy-mode）"
                        badge="实验"
                        value={config.lazyMode}
                        options={[
                          { value: 'auto', label: '内核默认' },
                          { value: 'on', label: '开启' },
                          { value: 'off', label: '关闭' },
                        ]}
                        onChange={(v) => updateConfig('lazyMode', v as ModelLoadConfig['lazyMode'])}
                      />
                      <ToggleParamRow
                        label="SWA 完整缓存"
                        description="滑动窗口注意力使用完整缓存，更稳但更占显存（--swa-full）"
                        badge="实验"
                        checked={config.swaFull}
                        onChange={(v) => updateConfig('swaFull', v)}
                      />
                      {config.kvUnified && (
                        <OptionalNumberParamRow
                          label="每路上下文上限"
                          description="限制每路并发槽的上下文；关闭时由内核分配（--kv-unified-per-slot）"
                          badge="实验"
                          enabled={config.kvUnifiedPerSlotEnabled}
                          value={config.kvUnifiedPerSlot > 0 ? config.kvUnifiedPerSlot : kvPerSlotDefault}
                          onToggle={(v) => {
                            updateConfig('kvUnifiedPerSlotEnabled', v);
                            if (v && config.kvUnifiedPerSlot <= 0) updateConfig('kvUnifiedPerSlot', kvPerSlotDefault);
                          }}
                          onChange={(v) => updateConfig('kvUnifiedPerSlot', Math.max(0, Math.round(v)))}
                          step={512}
                          autoLabel="内核默认"
                        />
                      )}
                      <OptionalNumberParamRow
                        label="提示词缓存上限"
                        description="提示词缓存内存上限，单位 MiB；0 关闭，-1 不限（--cache-ram）"
                        badge="实验"
                        enabled={config.cacheRamEnabled}
                        value={config.cacheRamMb}
                        onToggle={(v) => {
                          updateConfig('cacheRamEnabled', v);
                          if (v && !(config.cacheRamMb > 0)) updateConfig('cacheRamMb', 8192);
                        }}
                        onChange={(v) => updateConfig('cacheRamMb', Math.max(-1, Math.round(v)))}
                        step={256}
                        autoLabel="内核默认"
                      />
                    </div>
                    <div className="model-load-param-column">
                      <SliderParamRow
                        label="评估批处理大小"
                        description="逻辑批处理上限；调大更快但更占显存（--batch-size）"
                        value={config.batchSize}
                        onChange={(v) => updateConfig('batchSize', v)}
                        min={1}
                        max={8192}
                        step={64}
                      />
                      <OptionalNumberParamRow
                        label="RoPE 频率基"
                        description="覆盖旋转位置编码基频；关闭时读 GGUF（--rope-freq-base）"
                        enabled={config.ropeFreqBaseEnabled}
                        value={config.ropeFreqBase}
                        onToggle={(enabled) => updateConfig('ropeFreqBaseEnabled', enabled)}
                        onChange={(v) => updateConfig('ropeFreqBase', v)}
                        step={1000}
                        autoLabel="自动"
                      />
                      <OptionalNumberParamRow
                        label="RoPE 频率比例"
                        description="扩展旋转位置编码上下文；关闭时读 GGUF（--rope-freq-scale）"
                        enabled={config.ropeFreqScaleEnabled}
                        value={config.ropeFreqScale}
                        onToggle={(enabled) => updateConfig('ropeFreqScaleEnabled', enabled)}
                        onChange={(v) => updateConfig('ropeFreqScale', v)}
                        step={0.01}
                        autoLabel="自动"
                      />
                      <ReadOnlyParamRow
                        label="专家数量"
                        description="从 GGUF 元数据读取，仅用于估算"
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
                              description="每次草稿词元数，范围 1–16；关闭用内核默认（--spec-draft-n-max）"
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
                          description="GGUF 含 NextN 声明，但当前内核暂不支持"
                          value="当前不可用"
                        />
                      ) : null}
                      {config.speculativeDecoding !== 'off' && (
                        <NumberParamRow
                          label="草稿上下文批大小"
                          description="草稿物理批大小；0 跟随主模型（--spec-draft-n-ubatch）"
                          badge="实验"
                          value={config.specDraftNubatch}
                          onChange={(v) => updateConfig('specDraftNubatch', v)}
                          min={0}
                          max={8192}
                          step={64}
                        />
                      )}
                      {hasMultimodalProjector && (
                        <ToggleParamRow
                          label="多模态投影 GPU 卸载"
                          description="关闭后投影留在系统内存，省显存但编码变慢（--no-mmproj-offload）"
                          checked={config.mmprojOffload}
                          onChange={(v) => updateConfig('mmprojOffload', v)}
                        />
                      )}
                      <TextParamRow
                        label="聊天模板"
                        description="留空时使用 GGUF 元数据里的对话模板"
                        value={config.chatTemplate}
                        onChange={(v) => updateConfig('chatTemplate', v)}
                        placeholder="自动"
                      />
                      <OptionalNumberParamRow
                        label="种子"
                        description="固定随机种子以便复现；关闭时随机（--seed）"
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
                applied={autoTuneApplied && latestAutoTuneApplied}
                onClearLog={onClearLog}
                modelId={model.id}
                modelPath={model.filePath ?? ''}
                onRestoreConfig={props.onRestoreConfig}
                onApplyTuneRecord={props.onApplyTuneRecord}
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

function ModelLoadCompactHeader({ model, prediction, analyticalPrediction, calibration, systemStats, activeTab, onTabChange, apiName, apiNamePlaceholder, onApiNameChange, onApiNameCommit, onChangeLogo, isLoading, loadMessage, loadError, loadPercent, statusMessage, launchNotice, autoTuneRunning, autoTuneStopping, autoTuneApplying, autoTuneBlocked, autoTuneTask, onLoad, onStop, onAutoTune, onStopAutoTune, onReset }: ModelLoadViewProps) {
  const calibrated = (calibration?.samples ?? 0) > 0;
  const calibrationTitle = calibrated
    ? `按 ${calibration?.samples} 次同模型、同设备、同参数实测分项校准${calibration?.exactGb != null ? `；同参数启动实测总量 ${calibration.exactGb.toFixed(2)} GB` : ''}；${calibration?.confidence === 'measured' ? '样本较稳定' : '样本有限'}${calibration?.rejected ? `；排除 ${calibration.rejected} 条不匹配或异常记录` : ''}`
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
    dense_ffn_offload: '稠密 FFN 卸载按层权重比例近似计入，精确值以启动记录为准',
    draft_memory: '草稿模型 / MTP 开销按文件大小与近似 KV 计入，精确值以启动记录为准',
    projector_memory: '投影模型文件大小未知，尚未计入',
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
  const [estimateOpen, setEstimateOpen] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const tuningActive = Boolean(autoTuneTask && (autoTuneTask.status === 'running' || autoTuneTask.status === 'stopping'));
  useEffect(() => {
    if (!tuningActive) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [tuningActive]);
  const tuningPoints = autoTuneTask
    ? Math.max(autoTuneTask.pointsStarted ?? 0, autoTuneTask.records.length + (autoTuneTask.failures?.length ?? 0))
    : 0;
  const measuredGb = calibration && calibration.samples > 0 ? calibration.exactGb ?? null : null;
  const estimateDeviation = measuredGb != null && analyticalPrediction.totalGb > 0
    ? ((measuredGb - analyticalPrediction.totalGb) / analyticalPrediction.totalGb) * 100
    : null;

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
          <button
            type="button"
            aria-expanded={estimateOpen}
            onClick={() => setEstimateOpen((value) => !value)}
            title={`${sourceLabel}；${calibrationTitle}${estimateTitle ? `；${estimateTitle}` : ''}（点击查看分项与缺失项）`}
            className="rounded text-left text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)] underline-offset-2 transition-colors hover:text-[var(--accent)] hover:underline"
          >
            {calibrated ? '实测校准' : sourceLabel}{prediction.missing.length > 0 ? ` · ${prediction.missing.length} 项近似/缺失` : ''}
          </button>
        </div>
        <div className="model-load-memory-chart">
          <div className="model-load-memory-bar" aria-hidden="true">{parts.map((part) => <span key={part.label} style={{ background: part.color, flexGrow: Math.max(0, part.value ?? 0), flexBasis: 0 }} />)}</div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[length:var(--font-eyebrow)] text-[var(--text-secondary)]">
            {parts.map((part) => <span key={part.label} className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full" style={{ background: part.color }} />{part.label}<span className="mono-font">{part.value == null ? '未知' : `${part.value.toFixed(2)}G`}</span></span>)}
          </div>
        </div>
        {hasHardware && <span className={`mono-font text-[length:var(--font-eyebrow)] ${exceeded ? 'text-[var(--state-warning)]' : 'text-[var(--text-tertiary)]'}`} title={`${systemStats.gpuName} · 所有进程总占用；预测不会自动改变参数`}>设备 {systemStats.vramUsed.toFixed(1)} / {systemStats.vramTotal.toFixed(1)} GB{exceeded ? ' · 预测超容量' : ''}</span>}
        {estimateOpen && (
          <div className="basis-full rounded-[var(--radius-field)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[length:var(--font-eyebrow)] leading-relaxed text-[var(--text-secondary)]">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <span>权重来源：{sourceLabel}</span>
              <span>同参数实测：{measuredGb != null ? `${measuredGb.toFixed(2)} GB（${calibration?.samples} 次）` : '暂无'}</span>
              <span>纯估算：{formatGb(analyticalPrediction.totalGb)}{estimateDeviation != null ? ` · 偏差 ${estimateDeviation > 0 ? '+' : ''}${estimateDeviation.toFixed(0)}%` : ''}</span>
            </div>
            {prediction.missing.length === 0 ? (
              <p className="mt-1.5">没有已知的近似项或缺失项。</p>
            ) : (
              <ul className="mt-1.5 grid gap-1 sm:grid-cols-2">
                {prediction.missing.map((key) => (
                  <li key={key} className="flex min-w-0 items-start gap-1.5">
                    <span className={`mt-0.5 flex-shrink-0 rounded px-1 font-medium ${estimateEntryApproximate(key, model) ? 'bg-[var(--state-warning-bg)] text-[var(--state-warning)]' : 'bg-[var(--state-danger-bg)] text-[var(--state-danger)]'}`}>
                      {estimateEntryApproximate(key, model) ? '近似计入' : '未计入'}
                    </span>
                    <span className="min-w-0">{estimateNotes[key] ?? key}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-1.5 text-[var(--text-tertiary)]">「未计入」表示估算值可能低于实际占用；以启动后运行记录里的同参数实测为准。</p>
          </div>
        )}
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
          <button type="button" onClick={autoTuneRunning ? onStopAutoTune : onAutoTune} disabled={autoTuneApplying || (!autoTuneRunning && (isLoading || autoTuneBlocked))} className={`${buttonClass} ${autoTuneRunning ? 'text-[var(--state-danger)]' : 'text-[var(--text-primary)]'}`} title={autoTuneBlocked && !autoTuneRunning ? '请先停止正在运行的模型服务，再开始自动调参。' : '固定当前 ctx，先找显存边界，再比较推测解码、MoE 缓存、FFN 卸载、KV 与线程；批处理保持当前值。整卡显存预算 90%，短负载实测不保证交互最优。停止失败时可再次点击重试。'}>{autoTuneRunning ? <Square className="h-3 w-3 fill-current" /> : <Wand2 className="h-3.5 w-3.5 text-[var(--accent)]" />}{autoTuneApplying ? '正在应用' : autoTuneStopping ? '停止中（可重试）' : autoTuneRunning ? '停止调参' : '自动调参'}</button>
          <button type="button" onClick={onReset} disabled={isLoading || autoTuneRunning} className={`${buttonClass} text-[var(--text-secondary)]`}><RotateCcw className="h-3.5 w-3.5" />重置</button>
          <button type="button" onClick={isLoading ? onStop : onLoad} disabled={autoTuneRunning} className={`inline-flex h-8 min-w-24 items-center justify-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors disabled:opacity-50 ${isLoading ? 'border border-[var(--state-danger-border)] bg-[var(--state-danger-bg)] text-[var(--state-danger)]' : 'bg-[var(--accent)] text-[var(--text-on-accent)] hover:bg-[var(--accent-hover)]'}`}>{isLoading ? <Square className="h-3 w-3 fill-current" /> : <Play className="h-3.5 w-3.5" />}{isLoading ? '停止加载' : model.status === 'loaded' ? '重新加载' : '加载模型'}</button>
        </div>
      </div>
      {isLoading && <div className="mt-2 text-xs text-[var(--text-secondary)]" role="status"><div className="flex items-center gap-2"><LoaderCircle className="h-3.5 w-3.5 animate-spin" /><span className="min-w-0 flex-1 break-words">{loadMessage ?? '正在准备加载…'}{percent >= 100 && !loadMessage?.includes('停止') && !loadMessage?.includes('API 已就绪') ? ' · 等待 API 就绪' : ''}</span><span className="mono-font flex-shrink-0">日志阶段 {percent.toFixed(0)}%</span></div><div role="progressbar" aria-label="日志阶段进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} title="由日志阶段映射，不代表文件读取比例" className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--surface-muted)]"><div className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300" style={{ width: `${percent}%` }} /></div></div>}
      {!isLoading && loadError && <p role={failed ? 'alert' : 'status'} className={`mt-2 whitespace-pre-wrap break-words text-xs ${failed ? 'text-[var(--state-danger)]' : 'text-[var(--text-secondary)]'}`}>{loadError}</p>}
      {statusMessage && <p role="status" className="mt-1.5 text-xs text-[var(--text-secondary)]">{statusMessage}</p>}
      {launchNotice && (
        <p role="status" className="anim-enter-rise mt-2 flex items-start gap-1.5 rounded-[var(--radius-field)] border border-[var(--state-warning-border)] bg-[var(--state-warning-bg)] px-3 py-2 text-xs leading-[var(--leading-ui)] text-[var(--state-warning)]">
          <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span className="min-w-0 break-words">{launchNotice}</span>
        </p>
      )}
      {tuningActive && autoTuneTask && (
        <div className="mt-1.5">
          <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[length:var(--font-eyebrow)] text-[var(--text-secondary)]">
            {autoTuneTask.status === 'stopping'
              ? <span className="inline-flex flex-shrink-0 items-center gap-1.5 text-[var(--state-warning)]"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />停止中：当前测量点结束后停止</span>
              : <span className="inline-flex flex-shrink-0 items-center gap-1.5"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />自动调参中</span>}
            <span className="mono-font flex-shrink-0 text-[var(--text-primary)]">第 {tuningPoints} / 最多 {AUTO_TUNE_POINT_BUDGET} 点</span>
            <span className="flex-shrink-0">{autoTunePhaseLabel(autoTuneTask.phase)}</span>
            {autoTuneTask.startedAt ? <span className="mono-font flex-shrink-0">已用 {formatElapsed(clock - autoTuneTask.startedAt)}</span> : null}
            <span className="min-w-0 flex-1 truncate" title={autoTuneTask.log[autoTuneTask.log.length - 1]}>{autoTuneTask.log[autoTuneTask.log.length - 1]}</span>
            <button type="button" onClick={() => onTabChange('info')} className="flex-shrink-0 font-medium text-[var(--accent)] hover:underline">运行记录</button>
          </div>
          {/* 候选实测：参数页就能看到每点的 tok/s、显存与最佳项，不必切到「模型信息」。 */}
          {autoTuneTask.records.length > 0 && <TuningCandidateList records={autoTuneTask.records} />}
        </div>
      )}
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
  const tooltip = PARAM_TOOLTIPS[label];
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const tooltipId = useId();
  const hoverTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number; placement: 'top' | 'bottom'; ready: boolean }>({
    top: 0, left: 0, placement: 'bottom', ready: false,
  });

  const clearHoverTimer = () => {
    if (hoverTimerRef.current != null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };
  const openNow = () => {
    clearHoverTimer();
    setOpen(true);
  };
  // 悬停整行标签时留一点延迟，避免鼠标扫过参数区时连续弹窗。
  const scheduleOpen = () => {
    if (!tooltip) return;
    clearHoverTimer();
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = null;
      setOpen(true);
    }, 220);
  };
  const close = () => {
    clearHoverTimer();
    setOpen(false);
  };

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const tip = tooltipRef.current;
    if (!trigger || !tip) return;
    const rect = trigger.getBoundingClientRect();
    const margin = 12;
    const width = tip.offsetWidth;
    const height = tip.offsetHeight;
    const left = Math.max(margin, Math.min(window.innerWidth - width - margin, rect.left + rect.width / 2 - width / 2));
    const below = rect.bottom + 8;
    const above = rect.top - 8;
    const canShowBelow = below + height <= window.innerHeight - margin;
    const canShowAbove = above - height >= margin;
    const placement: 'top' | 'bottom' = canShowBelow || !canShowAbove ? 'bottom' : 'top';
    const top = placement === 'bottom'
      ? Math.min(below, Math.max(margin, window.innerHeight - height - margin))
      : Math.max(margin, above);
    setPosition({ top, left, placement, ready: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeTooltip = () => {
      if (hoverTimerRef.current != null) {
        window.clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }
      setOpen(false);
    };
    const onResize = () => closeTooltip();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeTooltip();
    };
    window.addEventListener('scroll', closeTooltip, true);
    window.addEventListener('resize', onResize);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('scroll', closeTooltip, true);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  useEffect(() => () => {
    if (hoverTimerRef.current != null) window.clearTimeout(hoverTimerRef.current);
  }, []);

  return (
    <div className="min-w-0" onMouseEnter={scheduleOpen} onMouseLeave={close}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-[var(--text-primary)] dark:text-[var(--text-primary)]">{label}</span>
        {tooltip ? (
          <button
            ref={triggerRef}
            type="button"
            aria-label={`查看「${label}」的用途说明`}
            aria-describedby={open ? tooltipId : undefined}
            onFocus={openNow}
            onBlur={close}
            className="relative flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--accent)] focus-visible:bg-[var(--surface-muted)] focus-visible:text-[var(--accent)] dark:text-[var(--text-secondary)] dark:hover:bg-white/[0.06]"
          >
            <Info className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : (
          <Info className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-secondary)] dark:text-[var(--text-secondary)]" />
        )}
        {badge && (
          <span className="flex-shrink-0 rounded-md border border-[var(--border)] bg-[var(--surface-muted)] px-1.5 py-0.5 text-[length:var(--font-eyebrow)] font-medium uppercase tracking-normal text-[var(--text-secondary)] dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[var(--text-secondary)]">
            {badge}
          </span>
        )}
      </div>
      {description && <div className="mt-0.5 text-xs text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">{description}</div>}
      {open && tooltip && createPortal(
        <div
          ref={tooltipRef}
          id={tooltipId}
          role="tooltip"
          className={`pointer-events-none fixed z-[120] w-[min(360px,calc(100vw-24px))] rounded-[var(--radius-field)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-[length:var(--font-caption)] leading-relaxed text-[var(--text-secondary)] shadow-[var(--shadow-flyout)] transition-opacity duration-100 ${position.ready ? 'opacity-100' : 'opacity-0'}`}
          style={{
            top: position.top,
            left: position.left,
            transform: position.placement === 'top' ? 'translateY(-100%)' : undefined,
          }}
        >
          <div className="mb-1 font-semibold text-[var(--text-primary)]">{label}</div>
          {tooltip}
        </div>,
        document.body,
      )}
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
function RunRecordsCard({ records, running, log, applied, onClearLog, modelId, modelPath, onRestoreConfig, onApplyTuneRecord }: {
  records: ModelRunRecord[];
  running: boolean;
  log: string[];
  applied: boolean;
  onClearLog: () => void;
  modelId: string;
  modelPath: string;
  onRestoreConfig: (config: ModelLoadConfig) => void;
  onApplyTuneRecord: (record: TuneRecord) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const logViewportRef = useRef<HTMLDivElement | null>(null);
  const [logCollapsed, setLogCollapsed] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [openDetails, setOpenDetails] = useState<string[]>([]);
  const toggleDetail = (key: string) => {
    setOpenDetails((keys) => keys.includes(key) ? keys.filter((item) => item !== key) : [...keys, key]);
  };
  const visibleRecords = records.slice(0, showAll ? 30 : 8);

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
          {visibleRecords.map((record) => {
            const measurement = record.vram_measurement;
            const derivedActual = measurement?.baseline_gb != null && measurement.loaded_gb != null
              && Number.isFinite(measurement.baseline_gb) && Number.isFinite(measurement.loaded_gb)
              && measurement.loaded_gb >= measurement.baseline_gb
              ? measurement.loaded_gb - measurement.baseline_gb
              : null;
            const actualGb = record.vram_gb ?? derivedActual;
            const deviation = actualGb != null && record.vram_predicted_gb
              ? ((actualGb - record.vram_predicted_gb) / record.vram_predicted_gb * 100)
              : null;
            const qualityLabel = measurement
              ? measurement.quality === 'unverified' && derivedActual != null
                ? '旧记录·总量可用'
                : ({ stable: '稳定采样', unverified: '未核实', adapted: '有效参数变化', contaminated: '采样异常' } as const)[measurement.quality]
              : '旧记录';
            const key = `${record.timestamp}-${record.kind}`;
            const experiment = record.kind === 'autotune' ? record.autotune ?? null : null;
            const best = experiment?.best ?? null;
            const detailOpen = openDetails.includes(key);
            const canControl = Boolean(experiment && record.model_id === modelId
              && experiment.config.model_id === modelId
              && (!modelPath || experiment.config.baseline.model_path === modelPath));
            const diff = experiment && best ? tuneRecordDiff(experiment.load_config, best) : [];
            return (
              <div key={key}>
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-md bg-[var(--surface-muted)] px-2.5 py-1.5 text-[length:var(--font-eyebrow)] dark:bg-white/[0.04]">
                  <span className="rounded-sm bg-[var(--accent-subtle)] px-1 py-0.5 font-medium text-[var(--accent)] dark:bg-white/[0.06]">
                    {RUN_RECORD_KIND_LABEL[record.kind] ?? record.kind}
                  </span>
                  <span className="mono-font text-[var(--text-primary)]">
                    ngl={record.ngl ?? '--'} ctx={record.ctx?.toLocaleString() ?? '--'} {record.vram_measurement ? `K/V=${record.vram_measurement.config.cache_type_k}/${record.vram_measurement.config.cache_type_v}` : `kv=${record.kv ?? 'f16'}`}
                    {record.ncmoe != null ? ` ncmoe=${record.ncmoe}` : ''}
                    {record.ncffn != null ? ` ncffn=${record.ncffn}` : ''}
                    {record.moe_cache_mib != null ? ` moe缓存=${record.moe_cache_mib}MiB` : ''}
                    {record.speculative && record.speculative !== 'off' ? ` 推测=${record.speculative}` : ''}
                  </span>
                  {record.tokens_per_sec != null && (
                    <span className="mono-font text-[var(--text-secondary)]">{record.tokens_per_sec.toFixed(1)} tok/s</span>
                  )}
                  {actualGb != null && (
                    <span className="mono-font text-[var(--text-secondary)]">
                      显存 {actualGb.toFixed(1)} GB
                      {deviation != null && Number.isFinite(deviation) ? `（预测偏差 ${deviation > 0 ? '+' : ''}${deviation.toFixed(0)}%）` : ''}
                    </span>
                  )}
                  {record.kind === 'launch' && <span className="text-[var(--text-tertiary)]" title={record.vram_measurement?.kernel_version ?? '旧记录缺少采样来源，不参与校准'}>{qualityLabel}</span>}
                  {record.note && (
                    <span
                      className="break-words text-[var(--state-warning)] dark:text-[var(--state-warning)]"
                      title={record.note}
                    >
                      {record.note}
                    </span>
                  )}
                  {experiment && (
                    <button
                      type="button"
                      aria-expanded={detailOpen}
                      onClick={() => toggleDetail(key)}
                      className="rounded px-1 font-medium text-[var(--accent)] transition-colors hover:bg-[var(--surface-hover)]"
                    >
                      {detailOpen ? '收起明细' : '查看明细'}
                    </button>
                  )}
                  <span className="ml-auto text-[var(--text-tertiary)]">
                    {new Date(record.timestamp * 1000).toLocaleString('zh-CN', { hour12: false })}
                  </span>
                </div>
                {experiment && detailOpen && (
                  <div className="mt-1 space-y-1.5 rounded-md border border-[var(--border)] bg-[var(--app-bg)] px-2.5 py-2 text-[length:var(--font-eyebrow)] text-[var(--text-secondary)]">
                    <div className="mono-font break-words text-[var(--text-primary)]">
                      调参前：ctx={experiment.load_config.ctxLength.toLocaleString()} ngl={experiment.load_config.gpuLayers}
                      {' '}K/V={experiment.load_config.cacheTypeKEnabled ? experiment.load_config.cacheTypeK : 'f16'}/{experiment.load_config.cacheTypeVEnabled ? experiment.load_config.cacheTypeV : 'f16'}
                      {' '}batch={experiment.load_config.batchSize}/{experiment.load_config.physicalBatchSize}
                      {' '}threads={experiment.load_config.threads}
                    </div>
                    {best ? (
                      <>
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                          <span className="font-medium text-[var(--text-primary)]">最佳参数变化：</span>
                          {diff.length === 0 ? <span>与调参前一致。</span> : diff.map((row) => (
                            <span key={row.label}>{row.label} <span className="mono-font text-[var(--accent)]">{row.before} → {row.after}</span></span>
                          ))}
                        </div>
                        <div className="flex flex-wrap items-center gap-2 pt-0.5">
                          {canControl ? (
                            <>
                              <button
                                type="button"
                                onClick={() => onRestoreConfig(experiment.load_config)}
                                className="rounded-md border border-[var(--border)] px-2 py-1 font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover)]"
                              >
                                撤销本次调参（恢复调参前参数）
                              </button>
                              <button
                                type="button"
                                onClick={() => onApplyTuneRecord(best)}
                                className="rounded-md border border-[var(--border)] px-2 py-1 font-medium text-[var(--accent)] transition-colors hover:bg-[var(--surface-hover)]"
                              >
                                再次应用此结果
                              </button>
                            </>
                          ) : (
                            <span className="text-[var(--text-tertiary)]">该记录所属模型与当前文件不一致，仅可查看，不能应用。</span>
                          )}
                        </div>
                      </>
                    ) : (
                      <div className="text-[var(--text-tertiary)]">本次没有通过复测的最佳参数{experiment.error ? `：${experiment.error}` : '。'}</div>
                    )}
                    {(experiment.records ?? []).length > 0 && (
                      <div className="max-h-56 overflow-auto rounded border border-[var(--border-subtle)]">
                        <table className="w-full min-w-[540px] text-left">
                          <thead className="sticky top-0 bg-[var(--surface-muted)] text-[var(--text-tertiary)]">
                            <tr>
                              {['#', 'ctx', 'ngl', 'ncmoe', 'K/V', '批处理', 'tok/s', '显存', '结果'].map((label, index) => (
                                <th key={label} className={`px-1.5 py-1 font-medium ${index >= 6 ? 'text-right' : ''}`}>{label}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {(experiment.records ?? []).slice(0, 30).map((candidate, index) => (
                              <tr key={index} className="border-t border-[var(--border-subtle)] transition-colors hover:bg-[var(--surface-hover)]">
                                <td className="mono-font px-1.5 py-1 text-[var(--text-tertiary)]">{index + 1}</td>
                                <td className="mono-font px-1.5 py-1">{candidate.ctx.toLocaleString()}</td>
                                <td className="mono-font px-1.5 py-1">{candidate.ngl}</td>
                                <td className="mono-font px-1.5 py-1">{candidate.ncmoe}</td>
                                <td className="mono-font px-1.5 py-1">{candidate.cache_type_k_enabled || candidate.cache_type_v_enabled ? `${candidate.cache_type_k}/${candidate.cache_type_v}` : 'f16/f16'}</td>
                                <td className="mono-font px-1.5 py-1">{candidate.batch_size ?? '--'}/{candidate.ubatch_size ?? '--'}</td>
                                <td className="mono-font px-1.5 py-1 text-right">{candidate.ts.toFixed(1)}</td>
                                <td className="mono-font px-1.5 py-1 text-right">{candidate.vram_available ? `${(candidate.vram_percent * 100).toFixed(0)}%` : '未知'}</td>
                                <td className={`px-1.5 py-1 ${candidate.fits ? 'text-[var(--text-secondary)]' : 'text-[var(--state-danger)]'}`}>
                                  {candidate.fits ? candidate.measurement_phase === 'refined_hot' ? '复测通过' : '通过' : '超预算'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {(experiment.failures ?? []).length > 0 && (
                      <div className="space-y-0.5">
                        <div className="font-medium text-[var(--text-primary)]">失败候选（{(experiment.failures ?? []).length} 条）</div>
                        {(experiment.failures ?? []).slice(0, 8).map((failure, index) => (
                          <div key={index} className="truncate" title={failure.message}>
                            <span className="text-[var(--state-warning)]">{TUNE_FAILURE_LABEL[failure.kind] ?? failure.kind}</span>
                            {' · '}{failure.message}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {records.length > 8 && (
            <button
              type="button"
              onClick={() => setShowAll((value) => !value)}
              className="w-full rounded-md border border-[var(--border)] px-2.5 py-1.5 text-[length:var(--font-eyebrow)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)]"
            >
              {showAll ? '只显示最近 8 条' : `查看全部（共 ${records.length} 条${records.length > 30 ? '，最多展示 30 条' : ''}）`}
            </button>
          )}
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

function SelectParamRow({ label, description, badge, value, options, onChange }: {
  label: string;
  description?: string;
  badge?: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
}) {
  return (
    <div className={`${rowBorderClass()} model-load-param-row`}>
      <ParamLabel label={label} description={description} badge={badge} />
      <div className="model-load-param-control justify-end">
        <select
          value={value}
          aria-label={label}
          onChange={(event) => onChange(event.target.value)}
          className="h-9 min-w-0 rounded-md border border-[var(--border)] bg-[var(--app-bg)] px-2 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)] dark:border-white/[0.08] dark:bg-[var(--app-bg)] dark:text-[var(--text-primary)]"
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
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
    ? `使用兼容的独立多词元预测头：${fileNameFromPath(model.mtpDraftPath)}`
    : `使用主模型内置的 ${model.nextnPredictLayers ?? 1} 个预测层，不额外挂草稿文件`;
  const description = value === 'mtp' ? mtpDescription
    : value === 'dspark' && model.dsparkDraftPath
      ? `使用 DSpark 草稿侧车：${fileNameFromPath(model.dsparkDraftPath)}`
      : value === 'dflash' && model.dflashDraftPath
        ? `使用 DFlash 草稿侧车：${fileNameFromPath(model.dflashDraftPath)}`
        : '关闭推测解码（默认，行为与内核一致）。';
  const options: Array<{ value: ModelLoadConfig['speculativeDecoding']; label: string; disabled?: boolean }> = [
    { value: 'off', label: '关闭' },
    { value: 'mtp', label: '内置多词元预测（MTP）', disabled: !model.supportsMtp },
    { value: 'dspark', label: 'DSpark 草稿侧车', disabled: !model.dsparkDraftPath },
    { value: 'dflash', label: 'DFlash 草稿侧车', disabled: !model.dflashDraftPath },
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

function OptionalNumberParamRow({ label, description, badge, enabled, value, onToggle, onChange, step, autoLabel }: {
  label: string; description?: string; badge?: string; enabled: boolean; value: number; onToggle: (v: boolean) => void; onChange: (v: number) => void; step: number; autoLabel: string;
}) {
  return (
    <div className={`${rowBorderClass()} model-load-param-row`}>
      <ParamLabel label={label} description={description} badge={badge} />
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
      <ParamLabel label={label} />
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
