/**
 * 对话统计的纯计算层：把服务端流式分片里散落的 usage / timings 汇总成
 * 气泡统计行（输出 tok / TTFT / tok/s / 生成耗时）所需的指标。
 *
 * 抽出来单独成模块的原因：这里的兜底口径直接决定界面数字对不对，
 * 必须能脱离传输层单测（见 `scripts/completion-metrics.test.mjs`）。
 */

/** 模型在流式响应中请求的一次工具调用。 */
export interface ChatToolCall {
  id: string;
  name: string;
  /** 已解析的参数对象；JSON 不合法时保留原文在 rawArguments。 */
  arguments: Record<string, unknown>;
  rawArguments: string;
  /** rawArguments 是否解析成了合法的 JSON 对象；false 时调用方必须回填错误，不能拿空参数真的执行。 */
  argumentsValid: boolean;
}

/** OpenAI 兼容服务返回的 usage 段（llama.cpp 需要 include_usage 才在流式末尾下发）。 */
export interface StreamUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** llama.cpp / NiNfer 在响应末尾附带的计时段（tok/s 的权威来源）。 */
export interface StreamTimings {
  prompt_n?: number;
  predicted_n?: number;
  prompt_ms?: number;
  predicted_ms?: number;
  prompt_per_second?: number;
  predicted_per_second?: number;
  tokens_per_second?: number;
}

export interface ChatCompletionMetrics {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  tokensPerSec?: number;
  firstTokenDelay: number;
  genTime: number;
  ctxUsed: number;
  ctxTotal: number;
  /** 本轮模型请求的工具调用（已按 index 合并分片）。空数组 = 没有工具调用。 */
  toolCalls: ChatToolCall[];
  /** 服务端 finish_reason（`stop` / `length` / `tool_calls`）；交付护栏用它识别硬截断。 */
  finishReason?: string;
}

export interface CompletionUsageSnapshot {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  tokensPerSec?: number;
  firstTokenDelay: number;
  genTime: number;
}

/** 服务端下发的计时段（每个流式分片都可能带，取到即覆盖）。 */
export function numeric(value: unknown) {
  const next = Number(value ?? 0);
  return Number.isFinite(next) && next > 0 ? next : undefined;
}

/** 从单个响应分片里累积 usage / timings；没有的部分保持上一次的值。 */
export function collectCompletionMetrics(
  current: Partial<ChatCompletionMetrics>,
  json: unknown,
): Partial<ChatCompletionMetrics> {
  if (typeof json !== 'object' || json === null) return current;
  const record = json as { usage?: StreamUsage; timings?: StreamTimings };
  const promptTokens = numeric(record.usage?.prompt_tokens) ?? numeric(record.timings?.prompt_n) ?? current.promptTokens;
  const completionTokens = numeric(record.usage?.completion_tokens) ?? numeric(record.timings?.predicted_n) ?? current.completionTokens;
  const totalTokens = numeric(record.usage?.total_tokens)
    ?? (promptTokens && completionTokens ? promptTokens + completionTokens : undefined)
    ?? current.totalTokens;
  const tokensPerSec = numeric(record.timings?.predicted_per_second)
    ?? numeric(record.timings?.tokens_per_second)
    ?? current.tokensPerSec;

  return {
    ...current,
    ...(promptTokens ? { promptTokens } : {}),
    ...(completionTokens ? { completionTokens } : {}),
    ...(totalTokens ? { totalTokens } : {}),
    ...(tokensPerSec ? { tokensPerSec } : {}),
  };
}

/**
 * 落定一轮请求的统计。
 *
 * 关键口径：服务端 usage / timings 优先；服务端没给（llama-server 流式默认不带
 * usage，除非请求里显式 include_usage）时，用本地流式 delta 计数兜底——
 * 否则正常完成的回复会显示成 `-- tok` / `-- tok/s`，只有被中止的才「有数」。
 */
export function finalizeCompletionMetrics(
  latestUsage: Partial<ChatCompletionMetrics>,
  requestStartedAt: number,
  firstTokenAt: number | null,
  ctxTotal = 0,
  onUsage?: (usage: CompletionUsageSnapshot) => void,
  streamedTokenCount = 0,
) {
  const finishedAt = performance.now();
  const genTime = Math.max(0, (finishedAt - requestStartedAt) / 1000);
  const firstTokenDelay = firstTokenAt ? Math.max(0, (firstTokenAt - requestStartedAt) / 1000) : 0;
  const promptTokens = Math.max(0, Math.round(latestUsage.promptTokens ?? 0));
  const completionTokens = Math.max(0, Math.round(latestUsage.completionTokens ?? streamedTokenCount));
  const totalTokens = Math.max(0, Math.round(latestUsage.totalTokens ?? promptTokens + completionTokens));
  // 服务端 timings 的 predicted_per_second 含投机解码收益，比本地面板除法更权威；
  // 缺了才退回「输出 token / 纯解码时长（总耗时减首字延迟）」。
  const fallbackTokensPerSec = completionTokens > 0 && genTime > firstTokenDelay
    ? completionTokens / Math.max(0.001, genTime - firstTokenDelay)
    : undefined;
  const tokensPerSec = latestUsage.tokensPerSec ?? fallbackTokensPerSec;

  const metrics: ChatCompletionMetrics = {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(tokensPerSec && tokensPerSec > 0 ? { tokensPerSec } : {}),
    firstTokenDelay,
    genTime,
    ctxUsed: promptTokens + completionTokens,
    ctxTotal,
    toolCalls: latestUsage.toolCalls ?? [],
  };

  if (totalTokens > 0) {
    onUsage?.({
      promptTokens,
      completionTokens,
      totalTokens,
      ...(tokensPerSec && tokensPerSec > 0 ? { tokensPerSec } : {}),
      firstTokenDelay,
      genTime,
    });
  }

  return metrics;
}
