/**
 * API 服务页「数据模块」的中立数据层。
 *
 * 目标：界面与模型解耦——API 服务页不认识具体引擎，只消费这里的
 * ServiceUsageStats 视图模型；每个后端各自提供聚合函数把数据流进来：
 * - fast27bServiceUsage：聚合 NiNfer 引擎指标快照（对话、dsh 与外部 API 的真实请求）；
 * - llamaServiceUsage：聚合主模型（llama-server）按模型累计的用量。
 * 没有数据源或没有样本时返回 null，由界面渲染空态。
 */
import type { Fast27bMetricsSnapshot, Fast27bRequestMetric } from './ipc/fast27b';
import type { ModelUsageStats } from '@/types';

/** 运行时间分布里的一段时间（毫秒时间戳区间）。 */
export interface UsageTimelineSpan {
  start: number;
  end: number;
  /** 悬停说明。 */
  note?: string;
}

export type UsageTimelineRowKey = 'model' | 'tool' | 'other';

export interface UsageTimelineRow {
  key: UsageTimelineRowKey;
  label: string;
  spans: UsageTimelineSpan[];
}

export interface ServiceUsageDetail {
  label: string;
  /** null = 当前数据源没有该口径，界面显示「—」。 */
  value: string | null;
  /** 值的单位（Tokens / Token/秒）；耗时类读数已自带单位，无需重复。 */
  unit?: string;
}

export interface ServiceUsageStats {
  /** 头像首字母。 */
  initial: string;
  /** 模型名（主标题）。 */
  title: string;
  /** 来源副标题。 */
  subtitle: string;
  /** 统计截至时间（最新样本完成时间）；无样本为 null。 */
  updatedAt: number | null;
  /** 累计输入 token（含缓存读取）。 */
  inputTokens: number | null;
  /** 累计输出 token。 */
  outputTokens: number | null;
  /** 模型生成 TPS（只计生成时段的口径）。 */
  generationTps: number | null;
  /** 明细项，顺序即界面两列布局的行优先顺序。 */
  details: ServiceUsageDetail[];
  /** 运行时间分布；数据源没有逐请求时间线时为 null。 */
  timeline: { windowStart: number; windowEnd: number; rows: UsageTimelineRow[] } | null;
  /** 计入统计的成功请求数。 */
  requestCount: number;
  /** 进行中的请求数。 */
  activeRequests: number;
}

/** 千分位整数（与截图的 1,105,739 Tokens 同口径）。 */
export function formatUsageCount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString('zh-CN');
}

/** 「59.5」「113」：一位小数起步，速度过百后整数即可读。 */
export function formatUsageTps(tps: number | null): string {
  if (tps === null || !Number.isFinite(tps) || tps < 0) return '—';
  return tps >= 100 ? Math.round(tps).toLocaleString('zh-CN') : tps.toFixed(1);
}

/** 「881ms」「1.9秒」「13分32.5秒」；无数据返回「—」。 */
export function formatUsageDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  // 先按最终显示精度（0.1 秒）取整，再拆分单位；否则 59.95~59.999 秒会显示成
  // 「1分60.0秒」这种非法读数。
  const totalSeconds = Math.round(ms / 100) / 10;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}秒`;
  let hours = Math.floor(totalSeconds / 3600);
  let minutes = Math.floor((totalSeconds - hours * 3600) / 60);
  let seconds = Math.round((totalSeconds - hours * 3600 - minutes * 60) * 10) / 10;
  if (seconds >= 60) {
    seconds -= 60;
    minutes += 1;
  }
  if (minutes >= 60) {
    minutes -= 60;
    hours += 1;
  }
  if (hours > 0) return `${hours}小时${minutes}分${Math.round(seconds)}秒`;
  return `${minutes}分${seconds.toFixed(1)}秒`;
}

/** 统计明细的固定六项（与截图的数据模块同构）。 */
function buildDetails(values: {
  reasoningTokens: string | null;
  cacheReadTokens: string | null;
  uncachedTokens: string | null;
  ttftMs: string | null;
  e2eTps: string | null;
  e2eDuration: string | null;
}): ServiceUsageDetail[] {
  return [
    { label: '推理', value: values.reasoningTokens, unit: 'Tokens' },
    { label: '缓存读取', value: values.cacheReadTokens, unit: 'Tokens' },
    { label: '未缓存', value: values.uncachedTokens, unit: 'Tokens' },
    { label: '首 Token 耗时', value: values.ttftMs },
    { label: '端到端吞吐', value: values.e2eTps, unit: 'Token/秒' },
    { label: '端到端耗时', value: values.e2eDuration },
  ];
}

// ---------------------------------------------------------------------------
// NiNfer 引擎：聚合指标快照（后端已按 24 小时窗口与 5000 条上限裁剪）
// ---------------------------------------------------------------------------

/** 时间线最多渲染的区段数：5000 条全画会拖慢 DOM，400 段已足够看出分布。 */
const TIMELINE_SPAN_LIMIT = 400;
/** 时间线基础窗口（与指标历史的 24 小时一致；更早的样本会把窗口再向前推）。 */
const TIMELINE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 从 NiNfer 模型文件名取展示名：`Underdog-Saluki-27B-1.0-…-ninfer-v3` → `Underdog Saluki 27B 1.0 …`。 */
export function fast27bModelDisplayName(modelPath: string, fallback: string): string {
  const file = modelPath.split(/[\\/]/).pop() ?? '';
  const stem = file
    .replace(/\.ninfer$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s*ninfer\s*v\d+$/i, '')
    .trim();
  return stem || fallback;
}

function requestSpan(request: Fast27bRequestMetric): UsageTimelineSpan {
  const end = request.finished_at;
  const start = request.started_at > 0 && request.started_at < end
    ? request.started_at
    : request.total_ms !== null
      ? end - request.total_ms
      : end;
  const seconds = Math.max(0, (end - start) / 1000);
  const clock = new Date(start).toLocaleTimeString('zh-CN', { hour12: false });
  const outcome = request.outcome === 'success'
    ? '完成'
    : request.outcome === 'failed'
      ? '失败'
      : '已取消';
  return {
    start,
    end,
    note: `${clock} · ${outcome}${seconds > 0 ? ` · ${formatUsageDuration(seconds * 1000)}` : ''}`,
  };
}

/** 取最新的一段区段（画不下时丢最旧的，保留最近的活跃）。 */
function latestSpans(spans: UsageTimelineSpan[]): UsageTimelineSpan[] {
  if (spans.length <= TIMELINE_SPAN_LIMIT) return spans;
  return spans.slice(spans.length - TIMELINE_SPAN_LIMIT);
}

export function fast27bServiceUsage(
  snapshot: Fast27bMetricsSnapshot | null,
  naming: { title: string; subtitle: string },
): ServiceUsageStats | null {
  if (!snapshot) return null;
  const seen = new Set<string>();
  const successful: Fast27bRequestMetric[] = [];
  const aborted: Fast27bRequestMetric[] = [];
  for (const request of snapshot.requests) {
    if (seen.has(request.id)) continue;
    seen.add(request.id);
    if (request.outcome === 'success') successful.push(request);
    else aborted.push(request);
  }
  if (successful.length === 0 && aborted.length === 0) return null;

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheTokens = 0;
  let totalMs = 0;
  // TPS 的分子必须与分母来自同一批请求：缺 total_ms / decode_tps 的样本
  // 只计入 token 总量，不能同时进吞吐的分子。
  let timedOutputTokens = 0;
  let generationMs = 0;
  let generationTokens = 0;
  let ttftSum = 0;
  let ttftCount = 0;
  let updatedAt = 0;
  for (const request of [...successful, ...aborted]) {
    updatedAt = Math.max(updatedAt, request.finished_at);
  }
  for (const request of successful) {
    const prompt = request.prompt_tokens ?? 0;
    const output = request.output_tokens ?? 0;
    inputTokens += prompt;
    outputTokens += output;
    cacheTokens += Math.min(request.cache_tokens ?? 0, prompt);
    if (request.total_ms !== null) {
      totalMs += request.total_ms;
      timedOutputTokens += output;
    }
    // 生成时长由每条的 decode TPS 反推（output / tps）；缺读数的请求既不
    // 贡献时长也不贡献 token，否则吞吐会被无读数的大响应无限拉高。
    if (request.decode_tps !== null && request.decode_tps > 0) {
      generationMs += (output / request.decode_tps) * 1000;
      generationTokens += output;
    }
    if (request.ttft_ms !== null && request.ttft_ms >= 0) {
      ttftSum += request.ttft_ms;
      ttftCount += 1;
    }
  }

  const ttftMs = ttftCount > 0 ? ttftSum / ttftCount : null;
  const e2eTps = totalMs > 0 ? timedOutputTokens / (totalMs / 1000) : null;
  const generationTps = generationMs > 0 ? generationTokens / (generationMs / 1000) : null;

  const now = snapshot.collected_at > 0 ? snapshot.collected_at : Date.now();
  const modelSpans = successful.map(requestSpan);
  const toolSpans = successful
    .filter((request) => (request.tool_calls ?? 0) > 0)
    .map(requestSpan);
  const otherSpans = aborted.map(requestSpan);
  const allSpans = [...modelSpans, ...otherSpans];
  const windowStart = Math.min(
    now - TIMELINE_WINDOW_MS,
    ...allSpans.map((span) => span.start),
  );
  const windowEnd = Math.max(now, ...allSpans.map((span) => span.end));
  const timeline = {
    windowStart,
    windowEnd,
    rows: [
      { key: 'model' as const, label: '模型', spans: latestSpans(modelSpans) },
      { key: 'tool' as const, label: '工具', spans: latestSpans(toolSpans) },
      { key: 'other' as const, label: '其他', spans: latestSpans(otherSpans) },
    ],
  };

  return {
    initial: naming.title.charAt(0).toUpperCase(),
    title: naming.title,
    subtitle: naming.subtitle,
    updatedAt: updatedAt > 0 ? updatedAt : null,
    inputTokens,
    outputTokens,
    generationTps,
    details: buildDetails({
      // 引擎日志不区分思考与正文 token，推理口径暂缺。
      reasoningTokens: null,
      cacheReadTokens: cacheTokens > 0 ? formatUsageCount(cacheTokens) : null,
      uncachedTokens: inputTokens - cacheTokens > 0
        ? formatUsageCount(inputTokens - cacheTokens)
        : null,
      ttftMs: formatUsageDuration(ttftMs),
      e2eTps: e2eTps !== null ? formatUsageTps(e2eTps) : null,
      e2eDuration: formatUsageDuration(totalMs > 0 ? totalMs : null),
    }),
    timeline,
    requestCount: successful.length,
    activeRequests: snapshot.active_requests,
  };
}

// ---------------------------------------------------------------------------
// 主模型（llama-server）：聚合按模型累计的用量（与「使用详情」页同一数据源）
// ---------------------------------------------------------------------------

export function llamaServiceUsage(
  usage: ModelUsageStats | undefined,
  naming: { title: string; subtitle: string },
): ServiceUsageStats | null {
  if (!usage || (!usage.totalTokens && !usage.responseCount)) return null;
  const responses = Math.max(1, usage.responseCount);
  const generationTps = usage.totalTokensPerSec > 0
    ? usage.totalTokensPerSec / responses
    : null;
  // totalFirstTokenDelay / totalGenTime 的单位是秒（使用详情页同口径）。
  const ttftMs = usage.totalFirstTokenDelay && usage.totalFirstTokenDelay > 0
    ? (usage.totalFirstTokenDelay / responses) * 1000
    : null;
  const e2eTps = usage.totalGenTime && usage.totalGenTime > 0
    ? usage.completionTokens / usage.totalGenTime
    : null;
  return {
    initial: naming.title.charAt(0).toUpperCase(),
    title: naming.title,
    subtitle: naming.subtitle,
    updatedAt: usage.lastUsedAt ?? null,
    inputTokens: usage.promptTokens || null,
    outputTokens: usage.completionTokens || null,
    generationTps,
    details: buildDetails({
      // llama-server 的响应用量不含缓存与思考拆分。
      reasoningTokens: null,
      cacheReadTokens: null,
      uncachedTokens: null,
      ttftMs: formatUsageDuration(ttftMs),
      e2eTps: e2eTps !== null ? formatUsageTps(e2eTps) : null,
      e2eDuration: formatUsageDuration(
        usage.totalGenTime && usage.totalGenTime > 0 ? usage.totalGenTime * 1000 : null,
      ),
    }),
    timeline: null,
    requestCount: usage.responseCount,
    activeRequests: 0,
  };
}
