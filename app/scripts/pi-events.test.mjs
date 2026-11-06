import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

// 不构建应用：直接把纯函数模块转译后在内存里导入（沿用 completion-metrics 的惯例）。
const source = readFileSync(new URL('../src/lib/piEvents.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { piToolStep, piFailureMessage, describePiFailure } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
);

test('工具成功：从 details 读取宿主 meta（画布产物 / 退出码）', () => {
  const step = piToolStep({
    type: 'tool_execution_end',
    toolCallId: 'call-1',
    toolName: 'canvas_run',
    result: {
      content: [{ type: 'text', text: '已生成并保存到工作区：canvas/out.png' }],
      details: { artifact: 'canvas/out.png', exitCode: 0, seed: 42 },
    },
    isError: false,
  });
  assert.equal(step.state, 'done');
  assert.equal(step.ok, true);
  assert.equal(step.canvasArtifact, 'canvas/out.png');
});

test('工具失败：必须认 isError，不能因为没看到 exit_code 就标成成功', () => {
  const step = piToolStep({
    type: 'tool_execution_end',
    toolCallId: 'call-2',
    toolName: 'write_file',
    args: { path: 'report.md' },
    result: {
      content: [{ type: 'text', text: 'ERROR: 用户拒绝了这次文件操作' }],
      details: { denied: true },
      isError: true,
    },
    isError: true,
  });
  assert.equal(step.state, 'error');
  assert.equal(step.ok, false);
  assert.equal(step.path, 'report.md');
});

test('命令非零退出：details.exitCode（camelCase）也算失败', () => {
  const step = piToolStep({
    type: 'tool_execution_end',
    toolCallId: 'call-3',
    toolName: 'run_command',
    result: {
      content: [{ type: 'text', text: 'command failed' }],
      details: { exitCode: 7 },
    },
  });
  assert.equal(step.state, 'error');
});

test('兼容 structuredContent 与旧字段 exit_code', () => {
  const step = piToolStep({
    type: 'tool_execution_end',
    toolCallId: 'call-4',
    toolName: 'run_command',
    result: { content: [], structuredContent: { exit_code: 1 } },
  });
  assert.equal(step.state, 'error');
});

test('失败原因：turn_end / message_end 的 stopReason=error 必须能被取到', () => {
  const detail = piFailureMessage({
    type: 'turn_end',
    message: {
      role: 'assistant',
      stopReason: 'error',
      errorMessage: '529: overloaded',
    },
  });
  assert.equal(detail, '529: overloaded');

  assert.equal(
    piFailureMessage({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'stop' },
    }),
    null,
  );
});

test('失败原因：agent_end.messages 只取 assistant', () => {
  const detail = piFailureMessage({
    type: 'agent_end',
    willRetry: false,
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', stopReason: 'error', errorMessage: 'connection error' },
    ],
  });
  assert.equal(detail, 'connection error');
});

test('连接失败 / 401 给出可操作提示', () => {
  assert.match(describePiFailure('fetch failed', 'http://127.0.0.1:8080/v1'), /连不上模型端点/);
  assert.match(describePiFailure('401 unauthorized', 'http://127.0.0.1:8080/v1'), /API Key/);
});
