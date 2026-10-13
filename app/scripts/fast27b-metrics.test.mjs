import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/fast27bMetrics.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { fast27bPerformanceData, summarizeFast27bRequests } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const now = Date.UTC(2026, 9, 13, 12);
const metric = (id, overrides = {}) => ({
  id, request_id: 1, model: 'heretic', started_at: now - 2000, finished_at: now - 1000,
  outcome: 'success', prompt_tokens: 100, output_tokens: 40, ttft_ms: 200, total_ms: 1200,
  decode_tps: 40, prefill_tps: 500, cache_tokens: 25, draft_accepted: 12, draft_proposed: 20,
  error: null, ...overrides,
});

test('无请求保持无测量值，不制造速度或成功率', () => {
  const data = fast27bPerformanceData([], now, 24);
  assert.equal(data.summary.successRate, null);
  assert.equal(data.summary.decodeTps, null);
  assert.equal(data.trends.length, 24);
  assert.ok(data.trends.every((point) => point.successRate === null && point.decodeTps === null));
});
test('成功率排除取消，失败进入分母，成功性能均值不混入失败', () => {
  const summary = summarizeFast27bRequests([
    metric('ok'), metric('failed', { outcome: 'failed', decode_tps: 999 }),
    metric('cancelled', { outcome: 'cancelled', decode_tps: 999 }),
  ]);
  assert.equal(summary.successRate, 50);
  assert.equal(summary.completed, 2);
  assert.equal(summary.cancelled, 1);
  assert.equal(summary.decodeTps, 40);
  assert.equal(summary.outputTokens, 40);
});
test('缺失性能与真实零读数有区别', () => {
  const summary = summarizeFast27bRequests([metric('a', { ttft_ms: null, decode_tps: null }), metric('b', { ttft_ms: 0, decode_tps: 0 })]);
  assert.equal(summary.ttftMs, 0);
  assert.equal(summary.decodeTps, 0);
});
test('按草稿提议与题面 token 加权计算接受率和缓存率', () => {
  const summary = summarizeFast27bRequests([
    metric('a'), metric('b', { prompt_tokens: 300, cache_tokens: 225, draft_accepted: 4, draft_proposed: 80 }),
  ]);
  assert.equal(summary.cacheRate, 62.5);
  assert.equal(summary.draftRate, 16);
});
test('模型过滤、24小时滚动窗口与终态去重', () => {
  const rows = [metric('a'), metric('a'), metric('swift', { model: 'swift' }),
    metric('old', { finished_at: now - 25 * 3600000 }), metric('future', { finished_at: now + 1 })];
  const all = fast27bPerformanceData(rows, now, 24);
  assert.equal(all.requests.length, 2);
  assert.equal(all.groups[0].summary.succeeded, 1);
  assert.equal(all.groups[1].summary.succeeded, 1);
  assert.equal(fast27bPerformanceData(rows, now, 24, 'swift').requests.length, 1);
});
test('时间桶只聚合有样本的时段，当前桶包含刚结束请求', () => {
  const data = fast27bPerformanceData([
    metric('left', { finished_at: now - 3600000 }), metric('right', { finished_at: now }),
  ], now, 1);
  assert.equal(data.bucketMinutes, 5);
  assert.equal(data.trends[0].requests, 1);
  assert.equal(data.trends.at(-1).requests, 1);
  assert.ok(data.trends.slice(1, -1).every((point) => point.successRate === null));
});
test('只有取消请求的时段保持成功率未知', () => {
  const data = fast27bPerformanceData([metric('a', { outcome: 'cancelled' })], now, 6);
  assert.equal(data.summary.successRate, null);
  assert.equal(data.summary.cancelled, 1);
  assert.equal(data.trends.at(-1).successRate, null);
});
