/**
 * 引擎（NiNfer / Strata）用量的统一聚合。
 *
 * 使用统计要覆盖「所有 token」，不只是主模型与对外 API：两个引擎的真实请求
 * 记录来自它们各自的指标快照（/metrics 与引擎日志解析），本模块把两份结构
 * 对齐成一组成口径相同的累计值，交给 reducer 做快照式写入。
 *
 * 口径约定：
 * - 只统计 `success` 的请求（失败/取消的请求没有可信的 token 读数）；
 * - 速度用每条请求的 decode TPS，首字延迟用每条请求的 TTFT（转秒）；
 * - 生成耗时按 output / decode_tps 反推，缺读数的请求不计入；
 * - 按天分桶用请求完成时刻的**本地日期**，与主模型的 `todayKey()` 一致。
 */

/** 一次引擎请求里本模块需要的最小字段集（两份快照的超集）。 */
export interface EngineUsageRequest {
  id: string;
  finished_at: number;
  outcome: string;
  prompt_tokens: number | null;
  output_tokens: number | null;
  ttft_ms: number | null;
  decode_tps: number | null;
}

export interface EngineUsageTotals {
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 各请求 decode TPS 之和；界面用 / requestCount 求平均。 */
  totalTokensPerSec: number;
  /** 各请求 TTFT 之和（秒）。 */
  totalFirstTokenDelay: number;
  /** 各请求生成时长之和（秒）。 */
  totalGenTime: number;
  dailyTokens: Record<string, number>;
  /** 最新一条请求的完成时刻。 */
  updatedAt: number;
}

function localDayKey(timestamp: number) {
  // 与 AppContext 的 todayKey() 同为本地日期口径（不是 UTC，避免跨时区错桶）。
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function engineUsageTotals(requests: EngineUsageRequest[]): EngineUsageTotals {
  const seen = new Set<string>();
  const totals: EngineUsageTotals = {
    requestCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    totalTokensPerSec: 0,
    totalFirstTokenDelay: 0,
    totalGenTime: 0,
    dailyTokens: {},
    updatedAt: 0,
  };

  for (const request of requests) {
    if (seen.has(request.id)) continue;
    seen.add(request.id);
    if (request.outcome !== 'success') continue;
    const prompt = request.prompt_tokens ?? 0;
    const output = request.output_tokens ?? 0;
    totals.requestCount += 1;
    totals.promptTokens += prompt;
    totals.completionTokens += output;
    totals.totalTokens += prompt + output;
    if (request.decode_tps !== null && request.decode_tps > 0) {
      totals.totalTokensPerSec += request.decode_tps;
      // 生成时长由生成速率反推，避免把排队与首字延迟算进生成段。
      totals.totalGenTime += output / request.decode_tps;
    }
    if (request.ttft_ms !== null && request.ttft_ms >= 0) {
      totals.totalFirstTokenDelay += request.ttft_ms / 1000;
    }
    totals.updatedAt = Math.max(totals.updatedAt, request.finished_at);
    const day = localDayKey(request.finished_at);
    totals.dailyTokens[day] = (totals.dailyTokens[day] ?? 0) + prompt + output;
  }

  return totals;
}
