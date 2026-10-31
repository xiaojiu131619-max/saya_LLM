import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

/**
 * 会话搜索与引擎用量的回归测试。
 *
 * 两个模块都是纯函数，用 TypeScript 现场转译后直接测：
 * - `sessionSearch`：标题子序列模糊匹配 + 对话内正文检索 + 摘要截断；
 * - `engineUsage`：引擎请求快照折算成与主模型同口径的累计值。
 */

const load = (path) => {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
};

const { fuzzyScore, searchSessions, matchMessageIds } = await load('../src/features/chat/sessionSearch.ts');
const { engineUsageTotals } = await load('../src/lib/engineUsage.ts');

const msg = (id, role, content, extra = {}) => ({ id, role, content, timestamp: 1, ...extra });

const session = (id, title, messages, updatedAt = 1) => ({
  id, title, modelId: 'chat-workspace', createdAt: 1, updatedAt, messages,
});

// ---------------------------------------------------------------------------
// 模糊匹配
// ---------------------------------------------------------------------------

test('模糊匹配：连续命中得分高于分散命中', () => {
  const contiguous = fuzzyScore('本地推理服务排障', '推理服务');
  // 「推 / 理 / 服 / 务」按顺序出现但彼此隔开，仍是合法子序列，得分应更低。
  const scattered = fuzzyScore('推排理障服务', '推理服务');
  assert.ok(contiguous !== null && scattered !== null);
  assert.ok(contiguous > scattered, `连续命中应更高：${contiguous} vs ${scattered}`);
});

test('模糊匹配：子序列即可命中（无「推…理…服…务」这种字面连续）', () => {
  assert.notEqual(fuzzyScore('本地推理服务排障', '推理排障'), null);
  assert.notEqual(fuzzyScore('Qwen3 Reasoning', 'qr'), null);
});

test('模糊匹配：缺字或顺序不对则不命中', () => {
  assert.equal(fuzzyScore('本地推理服务排障', '显卡'), null);
  // 「障排」顺序与标题相反
  assert.equal(fuzzyScore('本地推理服务排障', '障排'), null);
});

test('模糊匹配：空查询返回 0 而不是 null', () => {
  assert.equal(fuzzyScore('任意标题', '   '), 0);
});

// ---------------------------------------------------------------------------
// 会话搜索
// ---------------------------------------------------------------------------

test('空查询：原样返回且不产生命中信息', () => {
  const sessions = [session('a', '标题一', []), session('b', '标题二', [])];
  const result = searchSessions(sessions, '   ');
  assert.equal(result.sessions.length, 2);
  assert.equal(result.hits.size, 0);
});

test('标题命中：标记 titleMatched，且不产生正文摘要', () => {
  const sessions = [
    session('a', '本地推理服务排障', [msg('m1', 'user', '你好')]),
    session('b', '写一段自我介绍', [msg('m2', 'user', '你好')]),
  ];
  const result = searchSessions(sessions, '推理');
  assert.deepEqual(result.sessions.map((s) => s.id), ['a']);
  const hit = result.hits.get('a');
  assert.equal(hit.titleMatched, true);
  assert.equal(hit.snippet, undefined);
});

test('正文命中：标题不含查询词也返回，并给出带角色前缀的摘要', () => {
  const sessions = [
    session('a', '随便一个标题', [msg('m1', 'user', '帮我看看 llama-server 的显存占用为什么这么高')]),
    session('b', '另一条', [msg('m2', 'assistant', '无关内容')]),
  ];
  const result = searchSessions(sessions, '显存占用');
  assert.deepEqual(result.sessions.map((s) => s.id), ['a']);
  const hit = result.hits.get('a');
  assert.equal(hit.titleMatched, false);
  assert.ok(hit.snippet.startsWith('你：'), `摘要应以角色开头：${hit.snippet}`);
  assert.ok(hit.snippet.includes('显存占用'));
});

test('正文命中：优先取第一条命中消息（不是最后一条）', () => {
  const sessions = [session('a', '标题', [
    msg('m1', 'user', '第一个提到 KV cache 的问题'),
    msg('m2', 'assistant', '第二个也提到 KV cache 的回答'),
  ])];
  const hit = searchSessions(sessions, 'KV cache').hits.get('a');
  assert.ok(hit.snippet.startsWith('你：'), `应命中第一条（user）：${hit.snippet}`);
});

test('正文命中：长文本摘要被截断且带省略号', () => {
  const long = `${'前置内容'.repeat(40)}关键词在这里${'后置内容'.repeat(40)}`;
  const sessions = [session('a', '标题', [msg('m1', 'user', long)])];
  const hit = searchSessions(sessions, '关键词').hits.get('a');
  const body = hit.snippet.slice(2); // 去掉「你：」
  assert.ok(body.length <= 64, `摘要长度应受限：${body.length}`);
  assert.ok(body.includes('关键词'));
});

test('思考内容命中：正文不含查询词时给出思考摘要', () => {
  const sessions = [session('a', '标题', [
    msg('m1', 'assistant', '正文没有那个词', { reasoningContent: '我在思考关于量化的细节' }),
  ])];
  const hit = searchSessions(sessions, '量化').hits.get('a');
  assert.ok(hit.snippet.includes('思考'), `应标明命中在思考内容：${hit.snippet}`);
});

test('排序：标题命中优先于仅正文命中；同档保持原有顺序', () => {
  const sessions = [
    session('body-only', '无关标题', [msg('m1', 'user', '里面有量化这个词')], 100),
    session('title-hit', '量化工具', [], 90),
    session('body-only-2', '另一个无关标题', [msg('m2', 'user', '也有量化')], 80),
  ];
  const result = searchSessions(sessions, '量化');
  assert.equal(result.sessions[0].id, 'title-hit');
  // 两个仅正文命中的保持「最近更新在前」的相对顺序
  assert.deepEqual(result.sessions.slice(1).map((s) => s.id), ['body-only', 'body-only-2']);
});

// ---------------------------------------------------------------------------
// 会话内命中（跳转用）
// ---------------------------------------------------------------------------

test('会话内命中：返回所有含查询词的消息 id（正文与思考都算）', () => {
  const messages = [
    msg('m1', 'user', '提到 ngl 一次'),
    msg('m2', 'assistant', '没提'),
    msg('m3', 'assistant', '又提到 NGL（大小写不敏感）'),
    msg('m4', 'assistant', '正文没有', { reasoningContent: '思考里提 ngl' }),
  ];
  assert.deepEqual(matchMessageIds(messages, 'ngl'), ['m1', 'm3', 'm4']);
});

test('会话内命中：空查询返回空数组', () => {
  assert.deepEqual(matchMessageIds([msg('m1', 'user', 'x')], '  '), []);
});

// ---------------------------------------------------------------------------
// 引擎用量
// ---------------------------------------------------------------------------

const request = (id, overrides = {}) => ({
  id,
  finished_at: Date.UTC(2026, 9, 30, 4, 0, 0),
  outcome: 'success',
  prompt_tokens: 100,
  output_tokens: 40,
  ttft_ms: 200,
  decode_tps: 40,
  ...overrides,
});

test('引擎用量：只统计 success 请求的 token', () => {
  const totals = engineUsageTotals([
    request('a'),
    request('b', { outcome: 'failed' }),
    request('c', { outcome: 'cancelled' }),
  ]);
  assert.equal(totals.requestCount, 1);
  assert.equal(totals.promptTokens, 100);
  assert.equal(totals.completionTokens, 40);
  assert.equal(totals.totalTokens, 140);
});

test('引擎用量：同 id 重复只计一次（快照里可能有重复）', () => {
  const totals = engineUsageTotals([request('a'), request('a')]);
  assert.equal(totals.requestCount, 1);
  assert.equal(totals.totalTokens, 140);
});

test('引擎用量：速度、首字延迟、生成时长按每请求累计', () => {
  const totals = engineUsageTotals([request('a'), request('b', { output_tokens: 80, decode_tps: 20, ttft_ms: 600 })]);
  // 40 + 20 = 60 tok/s 之和（界面各自求平均）
  assert.equal(totals.totalTokensPerSec, 60);
  // 200ms + 600ms = 0.8s（转秒）
  assert.ok(Math.abs(totals.totalFirstTokenDelay - 0.8) < 1e-9);
  // 生成时长 = 40/40 + 80/20 = 1 + 4 = 5s
  assert.ok(Math.abs(totals.totalGenTime - 5) < 1e-9);
});

test('引擎用量：缺 decode 读数的请求不计入生成时长与速度', () => {
  const totals = engineUsageTotals([request('a', { decode_tps: null })]);
  assert.equal(totals.totalTokensPerSec, 0);
  assert.equal(totals.totalGenTime, 0);
  // token 仍然计入
  assert.equal(totals.totalTokens, 140);
});

test('引擎用量：按本地日期分桶，一天汇总一条', () => {
  const day = new Date(2026, 9, 30, 12, 0, 0).getTime();
  const totals = engineUsageTotals([
    request('a', { finished_at: day }),
    request('b', { finished_at: day + 3600_000 }),
  ]);
  const keys = Object.keys(totals.dailyTokens);
  assert.equal(keys.length, 1);
  assert.equal(keys[0], '2026-10-30');
  assert.equal(totals.dailyTokens['2026-10-30'], 280);
});

test('引擎用量：updatedAt 取最新一条完成时刻', () => {
  const totals = engineUsageTotals([
    request('a', { finished_at: 1000 }),
    request('b', { finished_at: 9000 }),
  ]);
  assert.equal(totals.updatedAt, 9000);
});

test('引擎用量：空快照全为零', () => {
  const totals = engineUsageTotals([]);
  assert.equal(totals.requestCount, 0);
  assert.equal(totals.totalTokens, 0);
  assert.deepEqual(totals.dailyTokens, {});
  assert.equal(totals.updatedAt, 0);
});
