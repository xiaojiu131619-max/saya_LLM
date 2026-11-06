import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/serviceUsage.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const {
  fast27bServiceUsage,
  llamaServiceUsage,
  fast27bModelDisplayName,
  formatUsageCount,
  formatUsageTps,
  formatUsageDuration,
} = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

const now = Date.UTC(2026, 9, 24, 11);
const metric = (id, overrides = {}) => ({
  id, request_id: 1, model: 'bonsai', started_at: now - 2000, finished_at: now - 1000,
  outcome: 'success', prompt_tokens: 100, output_tokens: 40, ttft_ms: 200, total_ms: 1200,
  decode_tps: 40, prefill_tps: 500, cache_tokens: 25, draft_accepted: 12, draft_proposed: 20,
  tool_calls: null, error: null, ...overrides,
});

test('格式化器：千分位、TPS 与中文时长', () => {
  assert.equal(formatUsageCount(1105739), '1,105,739');
  assert.equal(formatUsageCount(null), '—');
  assert.equal(formatUsageTps(59.54), '59.5');
  assert.equal(formatUsageTps(113.2), '113');
  assert.equal(formatUsageTps(null), '—');
  assert.equal(formatUsageDuration(881), '881ms');
  assert.equal(formatUsageDuration(1500), '1.5秒');
  assert.equal(formatUsageDuration(812500), '13分32.5秒');
  // 59.95 秒按 0.1 秒精度进位后必须是 1 分 0.0 秒，不能出现「1分60.0秒」。
  assert.equal(formatUsageDuration(59950), '1分0.0秒');
  assert.equal(formatUsageDuration(3599996), '1小时0分0秒');
  assert.equal(formatUsageDuration(null), '—');
});

test('fast27b：累计口径与截图同构（输入=缓存+未缓存、生成 TPS、端到端吞吐）', () => {
  const stats = fast27bServiceUsage({
    collected_at: now,
    active_requests: 1,
    requests: [
      metric('a', { cache_tokens: 25, ttft_ms: 200, decode_tps: 40, total_ms: 1200 }),
      metric('b', {
        prompt_tokens: 300, output_tokens: 160, cache_tokens: 225, ttft_ms: 600,
        decode_tps: 80, total_ms: 2800, started_at: now - 3000, finished_at: now,
      }),
    ],
  }, { title: 'Underdog Saluki 27B', subtitle: 'fast-27b 引擎' });
  assert.equal(stats.inputTokens, 400);
  assert.equal(stats.outputTokens, 200);
  // 生成时段 = Σ(output / decode_tps) = 1s + 2s ⇒ 200 / 3s
  assert.equal(stats.generationTps.toFixed(2), '66.67');
  // 端到端吞吐 = Σoutput / Σtotal = 200 / 4s
  assert.equal(stats.details.find((item) => item.label === '端到端吞吐').value, '50.0');
  assert.equal(stats.details.find((item) => item.label === '缓存读取').value, '250');
  assert.equal(stats.details.find((item) => item.label === '未缓存').value, '150');
  assert.equal(stats.details.find((item) => item.label === '首 Token 耗时').value, '400ms');
  assert.equal(stats.details.find((item) => item.label === '端到端耗时').value, '4.0秒');
  // 引擎日志不拆思考 token：推理口径明确显示缺失而非编造。
  assert.equal(stats.details.find((item) => item.label === '推理').value, null);
  assert.equal(stats.updatedAt, now);
  assert.equal(stats.activeRequests, 1);
  assert.equal(stats.initial, 'U');
});

test('fast27b：缺 decode/total 读数的请求不进入吞吐分子', () => {
  const stats = fast27bServiceUsage({
    collected_at: now,
    active_requests: 0,
    requests: [
      // 1000 token 但没有生成速率读数：不能只加 token 不加时长。
      metric('no-reading', { output_tokens: 1000, decode_tps: null, total_ms: null, ttft_ms: null }),
      // 唯一有读数的请求：100 token / 2s = 50 tok/s。
      metric('timed', { output_tokens: 100, decode_tps: 50, total_ms: 2000 }),
    ],
  }, { title: 'Underdog Saluki 27B', subtitle: 'fast-27b 引擎' });
  assert.equal(stats.outputTokens, 1100);
  assert.equal(stats.generationTps, 50);
  assert.equal(stats.details.find((item) => item.label === '端到端吞吐').value, '50.0');
});

test('fast27b：时间线三行（模型/工具/其他）与窗口裁剪', () => {
  const stats = fast27bServiceUsage({
    collected_at: now,
    active_requests: 0,
    requests: [
      metric('a'),
      metric('tool', { tool_calls: 3, finished_at: now - 500 }),
      metric('bad', { outcome: 'failed', error: '引擎 done 未报告有效完成原因' }),
      metric('gone', { finished_at: now - 25 * 3600000 }),
    ],
  }, { title: 'Ternary Bonsai 2 27B Heretic', subtitle: 'fast-27b 引擎' });
  const rows = Object.fromEntries(stats.timeline.rows.map((row) => [row.key, row.spans.length]));
  assert.equal(rows.model, 3, '成功请求全部进入「模型」行（含窗口外旧样本，窗口随之前推）');
  assert.equal(rows.tool, 1, '工具调用收尾的请求进入「工具」行');
  assert.equal(rows.other, 1, '失败/取消请求进入「其他」行');
  assert.equal(stats.timeline.windowStart <= now - 24 * 3600000, true);
  assert.equal(stats.timeline.windowEnd >= now, true);
});

test('fast27b：空快照与空历史返回 null，重复 id 去重', () => {
  assert.equal(fast27bServiceUsage(null, { title: 'x', subtitle: 'y' }), null);
  assert.equal(fast27bServiceUsage({ collected_at: now, active_requests: 0, requests: [] }, { title: 'x', subtitle: 'y' }), null);
  const stats = fast27bServiceUsage({
    collected_at: now, active_requests: 0, requests: [metric('a'), { ...metric('a') }],
  }, { title: 'x', subtitle: 'y' });
  assert.equal(stats.requestCount, 1);
  assert.equal(stats.inputTokens, 100);
});

test('fast27b：模型文件名转展示名', () => {
  assert.equal(
    fast27bModelDisplayName('D:\\LLM\\fast\\Underdog-Saluki-27B-1.0-IQ2-mix-ninfer-v3.ninfer', 'Saluki 27B'),
    'Underdog Saluki 27B 1.0 IQ2 mix',
  );
  assert.equal(fast27bModelDisplayName('', 'Saluki 27B'), 'Saluki 27B');
});

test('llama：主模型用量映射（均值口径），缓存与推理明确为无数据', () => {
  const stats = llamaServiceUsage({
    promptTokens: 1000, completionTokens: 500, totalTokens: 1500, responseCount: 4,
    totalTokensPerSec: 200, totalFirstTokenDelay: 2, totalGenTime: 20, lastUsedAt: now,
    dailyTokens: {},
  }, { title: 'Qwen3.6 32B', subtitle: 'Q4_K_M 中等' });
  assert.equal(stats.inputTokens, 1000);
  assert.equal(stats.outputTokens, 500);
  assert.equal(stats.generationTps, 50);
  assert.equal(stats.details.find((item) => item.label === '首 Token 耗时').value, '500ms');
  assert.equal(stats.details.find((item) => item.label === '端到端吞吐').value, '25.0');
  assert.equal(stats.details.find((item) => item.label === '端到端耗时').value, '20.0秒');
  assert.equal(stats.details.find((item) => item.label === '缓存读取').value, null);
  assert.equal(stats.timeline, null);
  assert.equal(stats.updatedAt, now);
});

test('llama：无用量或全零用量返回 null', () => {
  assert.equal(llamaServiceUsage(undefined, { title: 'x', subtitle: 'y' }), null);
  assert.equal(llamaServiceUsage({
    promptTokens: 0, completionTokens: 0, totalTokens: 0, responseCount: 0,
    totalTokensPerSec: 0, dailyTokens: {},
  }, { title: 'x', subtitle: 'y' }), null);
});
