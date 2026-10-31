import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

// 沿用 fast27b-metrics.test.mjs 的内存转译惯例，不构建应用、不生成编译文件。
const source = readFileSync(new URL('../src/features/chat/deliveryGuard.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { hasUnclosedArtifact, judgeDelivery } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('空正文判 empty，并区分是否被思考吃光', () => {
  const plain = judgeDelivery({ content: '' });
  assert.equal(plain.ok, false);
  assert.equal(plain.issue, 'empty');
  assert.match(plain.detail, /没有给出任何正文/);

  const ate = judgeDelivery({ content: '   \n\t ', reasoningChars: 800 });
  assert.equal(ate.issue, 'empty');
  assert.match(ate.detail, /思考占满了输出预算/);
});

test('空白字符铺满也算空正文', () => {
  const verdict = judgeDelivery({ content: ' \n\n\t\r\n ' });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.issue, 'empty');
});

test('纯工具轮：无正文且同一工具连续 ≥3 次判 shell_loop', () => {
  const loop = judgeDelivery({
    content: '',
    toolNames: ['fs_read', 'conversation_read', 'conversation_read', 'conversation_read'],
  });
  assert.equal(loop.issue, 'shell_loop');
  assert.match(loop.detail, /conversation_read/);

  // 只调 2 次不算（可能只是正常的两步）
  assert.equal(judgeDelivery({ content: '', toolNames: ['x', 'x'] }).issue, 'empty');

  // 穿插了别的工具，末尾只连 2 次，也不算
  assert.equal(
    judgeDelivery({ content: '', toolNames: ['x', 'y', 'y'] }).issue,
    'empty',
  );

  // 有正文时工具调用不触发任何警告
  assert.equal(
    judgeDelivery({ content: '已经完成。', toolNames: ['x', 'x', 'x'] }).ok,
    true,
  );
});

test('代码围栏未闭合判 truncated', () => {
  assert.equal(judgeDelivery({ content: '```js\nconst a = 1;' }).issue, 'truncated');
  assert.equal(judgeDelivery({ content: '```js\nconst a = 1;\n```' }).ok, true);
  // 两对围栏也算闭合
  assert.equal(judgeDelivery({ content: '```\na\n```\n\n```\nb\n```' }).ok, true);
});

test('svg 缺结束标签判 truncated，闭合正常则通过', () => {
  assert.equal(judgeDelivery({ content: '<svg><rect/></svg>' }).ok, true);
  assert.equal(judgeDelivery({ content: '<svg><rect/>' }).issue, 'truncated');
  // 两个开一个关，仍然缺
  assert.equal(judgeDelivery({ content: '<svg></svg><svg></svg>' }).ok, true);
  assert.equal(judgeDelivery({ content: '<svg></svg><svg>' }).issue, 'truncated');
});

test('finish_reason=length 判 truncated，即使产物看起来闭合', () => {
  const verdict = judgeDelivery({ content: '这是一段正常的说明文字。', finishReason: 'length' });
  assert.equal(verdict.issue, 'truncated');
  assert.match(verdict.detail, /输出达到上限/);

  // 大小写不敏感
  assert.equal(judgeDelivery({ content: '正文', finishReason: 'LENGTH' }).issue, 'truncated');

  // stop 不触发
  assert.equal(judgeDelivery({ content: '正文', finishReason: 'stop' }).ok, true);
});

test('正常回答通过判定', () => {
  for (const content of ['42', '粉红色', '好的，已完成。', '```js\nconst a = 1;\n```']) {
    const verdict = judgeDelivery({ content, finishReason: 'stop' });
    assert.equal(verdict.ok, true, `内容 ${JSON.stringify(content)} 不应被判失败`);
    assert.equal(verdict.issue, null);
    assert.equal(verdict.detail, '');
  }
});

test('hasUnclosedArtifact 只看闭合，不看内容质量', () => {
  assert.equal(hasUnclosedArtifact(''), false);
  assert.equal(hasUnclosedArtifact('```'), true);
  assert.equal(hasUnclosedArtifact('```\n```'), false);
  assert.equal(hasUnclosedArtifact('<svg>'), true);
  assert.equal(hasUnclosedArtifact('<svg></svg>'), false);
});
