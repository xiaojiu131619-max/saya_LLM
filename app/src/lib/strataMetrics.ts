import type { StrataRequestMetric } from './ipc/strata';

/**
 * 智慧模型性能汇总与趋势。
 *
 * 与 NiNfer 的口径保持一致：速度、首字延迟只统计**完成**的请求，
 * 空白时段表示没有样本（不补零、不插值）。区别只有一处——智慧模型只有一个模型，
 * 没有 DFlash2 / MTP 两个槽位，所以不做按模型分组。
 */

export type StrataTimeRange = 1 | 6 | 24;

export interface StrataPerformanceSummary {
  completed: number;
  succeeded: number;
  cancelled: number;
  decodeTps: number | null;
  ttftMs: number | null;
  totalMs: number | null;
  outputTokens: number;
  cacheRate: number | null;
  draftRate: number | null;
}

export interface StrataTrendPoint {
  timestamp: number;
  requests: number;
  cancelled: number;
  decodeTps: number | null;
  ttftMs: number | null;
  totalMs: number | null;
}

function mean(values: Array<number | null>): number | null {
  const measured = values.filter(
    (value): value is number => value !== null && Number.isFinite(value) && value >= 0,
  );
  return measured.length ? measured.reduce((sum, value) => sum + value, 0) / measured.length : null;
}

export function summarizeStrataRequests(requests: StrataRequestMetric[]): StrataPerformanceSummary {
  const successful = requests.filter((request) => request.outcome === 'success');
  const cancelled = requests.length - successful.length;
  let promptTokens = 0;
  let cacheTokens = 0;
  let accepted = 0;
  let proposed = 0;
  for (const request of successful) {
    if (
      request.prompt_tokens !== null &&
      request.prompt_tokens > 0 &&
      request.cache_tokens !== null
    ) {
      promptTokens += request.prompt_tokens;
      cacheTokens += Math.min(request.cache_tokens, request.prompt_tokens);
    }
    if (request.draft_proposed !== null && request.draft_proposed > 0 && request.draft_accepted !== null) {
      proposed += request.draft_proposed;
      accepted += Math.min(request.draft_accepted, request.draft_proposed);
    }
  }
  return {
    completed: successful.length,
    succeeded: successful.length,
    cancelled,
    decodeTps: mean(successful.map((request) => request.decode_tps)),
    ttftMs: mean(successful.map((request) => request.ttft_ms)),
    totalMs: mean(successful.map((request) => request.total_ms)),
    outputTokens: successful.reduce((sum, request) => sum + (request.output_tokens ?? 0), 0),
    cacheRate: promptTokens ? (cacheTokens / promptTokens) * 100 : null,
    draftRate: proposed ? (accepted / proposed) * 100 : null,
  };
}

export function strataPerformanceData(
  requests: StrataRequestMetric[],
  now: number,
  hours: StrataTimeRange,
) {
  const windowMs = hours * 60 * 60 * 1000;
  const start = now - windowMs;
  const seen = new Set<string>();
  const filtered = requests
    .filter((request) => {
      if (request.finished_at < start || request.finished_at > now || seen.has(request.id)) return false;
      seen.add(request.id);
      return true;
    })
    .sort((a, b) => a.finished_at - b.finished_at);

  const bucketCount = hours === 1 ? 12 : 24;
  const bucketMs = windowMs / bucketCount;
  const buckets = Array.from({ length: bucketCount }, () => [] as StrataRequestMetric[]);
  for (const request of filtered) {
    const index = Math.min(bucketCount - 1, Math.floor((request.finished_at - start) / bucketMs));
    buckets[index].push(request);
  }
  const trends: StrataTrendPoint[] = buckets.map((bucket, index) => {
    const summary = summarizeStrataRequests(bucket);
    return {
      timestamp: start + index * bucketMs,
      requests: summary.completed,
      cancelled: summary.cancelled,
      decodeTps: summary.decodeTps,
      ttftMs: summary.ttftMs,
      totalMs: summary.totalMs,
    };
  });

  return {
    requests: filtered,
    summary: summarizeStrataRequests(filtered),
    trends,
    bucketMinutes: bucketMs / 60000,
  };
}

export function formatStrataLatency(value: number | null): string {
  if (value === null) return '—';
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
}

export function formatStrataRate(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(2)}%`;
}

/** 收尾原因的中文短标签（网关的 finish 值）。 */
export function finishLabel(finish: string | null): string {
  if (!finish) return '—';
  const map: Record<string, string> = {
    stop: '正常结束',
    length: '达到上限',
    cancelled: '已取消',
    cancel: '已取消',
    disconnect: '客户端断开',
    disconnected: '客户端断开',
    timeout: '超时',
    error: '引擎错误',
    tool_calls: '工具调用',
  };
  return map[finish] ?? finish;
}
