import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/completionMetrics.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { collectCompletionMetrics, finalizeCompletionMetrics } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
);

/** 固定 performance.now，让 genTime 可预期。 */
const atTime = (nowMs) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  Object.defineProperty(globalThis, 'performance', { value: { now: () => nowMs }, configurable: true, writable: true });
  return () => {
    if (original) Object.defineProperty(globalThis, 'performance', original);
    else delete globalThis.performance;
  };
};

test('流式服务端不下发 usage 时，用本地 delta 计数兜底，不显示 --', () => {
  const restore = atTime(2000);
  try {
    // 请求 0ms 开始，首字 400ms，结束 2000ms → 纯解码 1.6s，12 个 delta。
    const metrics = finalizeCompletionMetrics({}, 0, 400, 32768, undefined, 12);
    assert.equal(metrics.completionTokens, 12, '输出 tok 应取本地计数而不是 0');
    assert.equal(metrics.genTime, 2);
    assert.equal(metrics.firstTokenDelay, 0.4);
    assert.ok(metrics.tokensPerSec && metrics.tokensPerSec > 0, 'tok/s 应有值');
    assert.equal(metrics.tokensPerSec, 12 / 1.6);
    assert.equal(metrics.totalTokens, 12, 'prompt 未知时总量至少等于输出量');
    assert.equal(metrics.ctxTotal, 32768);
  } finally {
    restore();
  }
});

test('服务端 usage 与 timings 优先于本地计数', () => {
  const restore = atTime(3000);
  try {
    const usage = collectCompletionMetrics({}, {
      usage: { prompt_tokens: 100, completion_tokens: 380, total_tokens: 480 },
      timings: { predicted_per_second: 235.6, prompt_n: 100, predicted_n: 380 },
    });
    const metrics = finalizeCompletionMetrics(usage, 0, 500, 32768, undefined, 99);
    assert.equal(metrics.promptTokens, 100);
    assert.equal(metrics.completionTokens, 380, '服务端 usage 覆盖本地计数');
    assert.equal(metrics.totalTokens, 480);
    assert.equal(metrics.tokensPerSec, 235.6, 'timings 的 tok/s 优先于本地除法');
    assert.equal(metrics.ctxUsed, 480);
  } finally {
    restore();
  }
});

test('usage 全为 0 时视为缺失，退回本地计数', () => {
  const restore = atTime(1000);
  try {
    const usage = collectCompletionMetrics({}, { usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
    assert.equal(usage.completionTokens, undefined, '0 不算有效读数');
    const metrics = finalizeCompletionMetrics(usage, 0, 200, 8192, undefined, 7);
    assert.equal(metrics.completionTokens, 7);
    assert.ok(metrics.tokensPerSec > 0);
  } finally {
    restore();
  }
});

test('没有首字时刻时不编造 TTFT，也不编造速度', () => {
  const restore = atTime(1000);
  try {
    const metrics = finalizeCompletionMetrics({}, 0, null, 4096, undefined, 0);
    assert.equal(metrics.firstTokenDelay, 0);
    assert.equal(metrics.completionTokens, 0);
    assert.equal(metrics.tokensPerSec, undefined);
  } finally {
    restore();
  }
});

test('usage 回调只在有产量时触发，且带上同一份指标', () => {
  const restore = atTime(1500);
  try {
    const seen = [];
    finalizeCompletionMetrics({}, 0, 300, 4096, (usage) => seen.push(usage), 10);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].completionTokens, 10);
    assert.equal(seen[0].genTime, 1.5);

    const empty = [];
    finalizeCompletionMetrics({}, 0, null, 4096, (usage) => empty.push(usage), 0);
    assert.equal(empty.length, 0, '零产量不应写进用量统计');
  } finally {
    restore();
  }
});
