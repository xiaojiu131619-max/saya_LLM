import type { Fast27bModelVariant, Fast27bRequestMetric } from './ipc/fast27b';

export type Fast27bTimeRange = 1 | 6 | 24;
export type Fast27bModelFilter = Fast27bModelVariant | 'all';

export interface Fast27bPerformanceSummary {
  completed: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  successRate: number | null;
  decodeTps: number | null;
  ttftMs: number | null;
  totalMs: number | null;
  outputTokens: number;
  cacheRate: number | null;
  draftRate: number | null;
}

export interface Fast27bTrendPoint {
  timestamp: number;
  requests: number;
  failed: number;
  cancelled: number;
  decodeTps: number | null;
  ttftMs: number | null;
  totalMs: number | null;
  successRate: number | null;
}

function mean(values: Array<number | null>): number | null {
  const measured = values.filter((value): value is number => value !== null && Number.isFinite(value) && value >= 0);
  return measured.length ? measured.reduce((sum, value) => sum + value, 0) / measured.length : null;
}

export function summarizeFast27bRequests(requests: Fast27bRequestMetric[]): Fast27bPerformanceSummary {
  const successful = requests.filter((request) => request.outcome === 'success');
  const failed = requests.filter((request) => request.outcome === 'failed').length;
  const cancelled = requests.filter((request) => request.outcome === 'cancelled').length;
  const completed = successful.length + failed;
  let promptTokens = 0;
  let cacheTokens = 0;
  let accepted = 0;
  let proposed = 0;
  for (const request of successful) {
    if (request.prompt_tokens !== null && request.prompt_tokens > 0 && request.cache_tokens !== null) {
      promptTokens += request.prompt_tokens;
      cacheTokens += Math.min(request.cache_tokens, request.prompt_tokens);
    }
    if (request.draft_proposed !== null && request.draft_proposed > 0 && request.draft_accepted !== null) {
      proposed += request.draft_proposed;
      accepted += Math.min(request.draft_accepted, request.draft_proposed);
    }
  }
  return {
    completed,
    succeeded: successful.length,
    failed,
    cancelled,
    successRate: completed ? successful.length / completed * 100 : null,
    decodeTps: mean(successful.map((request) => request.decode_tps)),
    ttftMs: mean(successful.map((request) => request.ttft_ms)),
    totalMs: mean(successful.map((request) => request.total_ms)),
    outputTokens: successful.reduce((sum, request) => sum + (request.output_tokens ?? 0), 0),
    cacheRate: promptTokens ? cacheTokens / promptTokens * 100 : null,
    draftRate: proposed ? accepted / proposed * 100 : null,
  };
}

export function fast27bPerformanceData(
  requests: Fast27bRequestMetric[],
  now: number,
  hours: Fast27bTimeRange,
  model: Fast27bModelFilter = 'all',
) {
  const windowMs = hours * 60 * 60 * 1000;
  const start = now - windowMs;
  const seen = new Set<string>();
  const filtered = requests.filter((request) => {
    if (request.finished_at < start || request.finished_at > now || seen.has(request.id)) return false;
    if (model !== 'all' && request.model !== model) return false;
    seen.add(request.id);
    return true;
  }).sort((a, b) => a.finished_at - b.finished_at);
  const bucketCount = hours === 1 ? 12 : 24;
  const bucketMs = windowMs / bucketCount;
  const buckets = Array.from({ length: bucketCount }, () => [] as Fast27bRequestMetric[]);
  for (const request of filtered) {
    const index = Math.min(bucketCount - 1, Math.floor((request.finished_at - start) / bucketMs));
    buckets[index].push(request);
  }
  const trends: Fast27bTrendPoint[] = buckets.map((bucket, index) => {
    const summary = summarizeFast27bRequests(bucket);
    return {
      timestamp: start + index * bucketMs,
      requests: summary.completed,
      failed: summary.failed,
      cancelled: summary.cancelled,
      decodeTps: summary.decodeTps,
      ttftMs: summary.ttftMs,
      totalMs: summary.totalMs,
      successRate: summary.successRate,
    };
  });
  return {
    requests: filtered,
    summary: summarizeFast27bRequests(filtered),
    groups: (['heretic', 'swift'] as const).map((variant) => ({
      model: variant,
      summary: summarizeFast27bRequests(filtered.filter((request) => request.model === variant)),
    })),
    trends,
    bucketMinutes: bucketMs / 60000,
  };
}

export function formatFast27bLatency(value: number | null): string {
  if (value === null) return '—';
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
}

export function formatFast27bRate(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(2)}%`;
}
