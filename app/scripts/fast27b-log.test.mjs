import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// 仅在内存中转译实际 fast27b 解析区，不引入上游 UI 模块、不生成构建产物。
const source = await readFile(new URL('../src/features/chat/chatUtils.ts', import.meta.url), 'utf8');
const start = source.indexOf('const ENGINE_REQ_STARTED =');
assert.ok(start >= 0, '应能找到 fast27b 日志解析区');
const { outputText, diagnostics } = ts.transpileModule(source.slice(start), {
  fileName: 'chatUtils.fast27b.ts',
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  reportDiagnostics: true,
});
assert.equal(diagnostics?.length ?? 0, 0, 'fast27b 解析区应能单独转译');
const { parseEngineLog, latestEngineRuntimeStats } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);

const started = '2026-10-13 12:00:00.000 INFO req#1 started | openai-chat stream | max output 32,768';
const realDone = 'req#1 done | prompt 3,360 | output 74 | cache 0 (0.0%) | TTFT 1.6s | total 1.9s | prefill 2.14k tok/s | decode 215.2 tok/s | dflash2 accepted 54/84 (64.3%)';
const expectedDone = {
  promptTokens: 3360,
  outputTokens: 74,
  firstTokenDelay: 1.6,
  genTime: 1.9,
  tokensPerSec: 215.2,
};
const doneLine = (timing, output = 936, extra = '') =>
  `req#1 done | prompt 3,360 | output ${output} | ${timing}${extra ? ` | ${extra}` : ''}`;

function approximately(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}：实际 ${actual}，预期 ${expected}`);
}

test('空日志与非请求日志不产生读数或在途请求', () => {
  assert.deepEqual(parseEngineLog([]), { inFlight: false, lastDone: null });
  assert.deepEqual(parseEngineLog(['capacity | KV 17,920 tokens', '普通日志']), {
    inFlight: false,
    lastDone: null,
  });
  assert.deepEqual(parseEngineLog([started]), { inFlight: true, lastDone: null });
});

test('真实秒单位日志读取 decode，保留千分位 token 数与原有接口', () => {
  assert.deepEqual(parseEngineLog([started, realDone]), {
    inFlight: false,
    lastDone: expectedDone,
  });
});

test('毫秒、秒及混合单位忽略大小写并支持紧邻字段名', () => {
  for (const timing of [
    'TTFT 164 ms | total 1100 ms',
    'TTFT164 ms | total1.1s',
    'TTFT 164MS | TOTAL 1.1S',
    'ttft 0.164s | total 1100mS',
    'TTFT 0.164 S | total 1.1 s',
  ]) {
    const { lastDone } = parseEngineLog([doneLine(timing)]);
    approximately(lastDone.firstTokenDelay, 0.164, timing);
    approximately(lastDone.genTime, 1.1, timing);
    approximately(lastDone.tokensPerSec, 1000, timing);
  }
});

test('分秒复合单位转换为秒，并保留显式 decode 优先级', () => {
  const { lastDone } = parseEngineLog([
    doneLine('TTFT 1.6s | total 1m 19.4s', 74, 'prefill 2.14k tok/s | decode 215.2 tok/s'),
  ]);
  approximately(lastDone.firstTokenDelay, 1.6, '首字延迟');
  approximately(lastDone.genTime, 79.4, '分秒总时长');
  assert.equal(lastDone.tokensPerSec, 215.2);

  const compound = parseEngineLog([doneLine('TTFT 1M 0.164S | TOTAL 1m 1.1s')]).lastDone;
  approximately(compound.firstTokenDelay, 60.164, '分秒首字延迟');
  approximately(compound.genTime, 61.1, '分秒总时长');
  approximately(compound.tokensPerSec, 1000, '分秒缺 decode 时的回退速度');
});

test('显式 decode 支持 k/K tok/s，数值为零时也不回退', () => {
  for (const [decode, speed] of [
    ['decode 2.14k tok/s', 2140],
    ['DECODE 1.5 K TOK/S', 1500],
    ['decode 0 tok/s', 0],
  ]) {
    const { lastDone } = parseEngineLog([
      doneLine('TTFT 164 ms | total 1.1s', 936, `prefill 9.9k tok/s | ${decode}`),
    ]);
    assert.equal(lastDone.tokensPerSec, speed, decode);
  }
});

test('没有 decode 才按 output / (total - TTFT) 回退，prefill 不影响速度', () => {
  const { lastDone } = parseEngineLog([
    doneLine('TTFT 1.6s | total 1.9s', 74, 'prefill 2.14k tok/s | dflash2 accepted 54/84 (64.3%)'),
  ]);
  approximately(lastDone.tokensPerSec, 74 / 0.3, '回退速度');
});

test('显式与回退速度都保留不足 16 token 或 100ms 的旧抑噪门槛', () => {
  for (const extra of ['', 'decode 215.2 tok/s']) {
    for (const [output, total, suppressed] of [
      [15, '1.1s', true],
      [16, '199 ms', true],
      [16, '200 ms', false],
      [0, '1.1s', true],
    ]) {
      const { lastDone } = parseEngineLog([doneLine(`TTFT 100 ms | total ${total}`, output, extra)]);
      assert.equal(lastDone.tokensPerSec, suppressed ? 0 : extra ? 215.2 : 160);
      assert.equal(lastDone.outputTokens, output);
    }
  }
});

test('生成阶段时长为零或为负时不产生速度读数', () => {
  for (const total of ['100 ms', '99 ms']) {
    const { lastDone } = parseEngineLog([
      doneLine(`TTFT 100 ms | total ${total}`, 74, 'decode 215.2 tok/s'),
    ]);
    assert.equal(lastDone.tokensPerSec, 0);
  }
});

test('准备失败、生成失败、传输失败以及两种取消拼写均结束 inFlight', () => {
  for (const terminal of [
    'req#1 failed during prepare | openai-chat stream | HTTP 503 | service unavailable',
    'req#1 failed during generation | openai-chat | HTTP 500 | internal error',
    'req#1 response failed during transport | HTTP 499 | client disconnected',
    'req#1 cancelled | openai-chat stream | client disconnected',
    'req#1 canceled | openai-chat stream | client disconnected',
    'req#1 response cancelled during transport | HTTP 499',
  ]) {
    assert.deepEqual(parseEngineLog([realDone, started, terminal]), {
      inFlight: false,
      lastDone: expectedDone,
    }, terminal);
    assert.equal(parseEngineLog([started, terminal, started]).inFlight, true, terminal);
  }
});

test('请求参数中的 failed/cancelled 不会被误读为终态', () => {
  assert.equal(parseEngineLog([
    'req#1 started | openai-chat stream | note failed cancelled canceled',
  ]).inFlight, true);
});

test('启动与 engine ready 边界结束旧 inFlight，保留最近成功读数', () => {
  for (const boundary of [
    '[fast27b] 启动：D:\\engine\\ninfer-serve.exe --port 8080',
    '[fast27b] 启动: D:\\engine\\ninfer-serve.exe --port 8080',
    '2026-10-13 12:01:00.000 INFO engine ready | bonsai2-27b-heretic | total 6.6s',
  ]) {
    assert.deepEqual(parseEngineLog([started, boundary]), { inFlight: false, lastDone: null });
    assert.deepEqual(parseEngineLog([realDone, started, boundary]), {
      inFlight: false,
      lastDone: expectedDone,
    });
    assert.deepEqual(parseEngineLog([realDone, started, boundary, started]), {
      inFlight: true,
      lastDone: expectedDone,
    });
  }
});

test('最近一次 done 替换读数，新 started 仅更新在途状态', () => {
  const logs = [realDone, doneLine('TTFT 100 ms | total 200 ms', 16)];
  const latest = { ...expectedDone, outputTokens: 16, firstTokenDelay: 0.1, genTime: 0.2, tokensPerSec: 160 };
  assert.deepEqual(parseEngineLog(logs), { inFlight: false, lastDone: latest });
  assert.deepEqual(parseEngineLog([...logs, started]), { inFlight: true, lastDone: latest });
});

test('侧栏共用 runtime stats 接口输出秒单位延迟与引擎 decode', () => {
  assert.deepEqual(latestEngineRuntimeStats([realDone], 32768), {
    ctxUsed: 3434,
    ctxTotal: 32768,
    outputTokens: 74,
    firstTokenDelay: 1.6,
    tokensPerSec: 215.2,
    genTime: 1.9,
  });
  assert.equal(latestEngineRuntimeStats([started], 32768), undefined);
  for (const ctxTotal of [0, -1, NaN, Infinity]) {
    assert.equal(latestEngineRuntimeStats([realDone], ctxTotal), undefined);
  }
});
