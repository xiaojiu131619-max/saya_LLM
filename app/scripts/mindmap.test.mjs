import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/features/chat/mindmap.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { parseMindMap, cleanMermaidLabel } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('嵌套 JSON：label / name / title 与 children / topics 别名都能读', () => {
  const parsed = parseMindMap(JSON.stringify({
    label: '根',
    children: [
      { name: 'A', topics: [{ title: 'A1' }] },
      { title: 'B' },
    ],
  }));
  assert.equal(parsed.format, 'json');
  assert.equal(parsed.error, '');
  assert.equal(parsed.nodeCount, 4);
  assert.equal(parsed.root.label, '根');
  assert.equal(parsed.root.children[0].label, 'A');
  assert.equal(parsed.root.children[0].children[0].label, 'A1');
  assert.equal(parsed.root.children[1].label, 'B');
});

test('JSON 数组自动包一层根节点', () => {
  const parsed = parseMindMap('[{"label":"A"},{"label":"B"}]');
  assert.equal(parsed.root.label, '导图');
  assert.deepEqual(parsed.root.children.map((node) => node.label), ['A', 'B']);
});

test('JSON 里的 root 字段会被解包', () => {
  const parsed = parseMindMap('{"root":{"label":"中心"}}');
  assert.equal(parsed.root.label, '中心');
});

test('mermaid mindmap 按缩进还原层级', () => {
  const parsed = parseMindMap([
    'mindmap',
    '  root((中心主题))',
    '    分支A',
    '      叶子1',
    '    分支B',
  ].join('\n'), 'mmd');
  assert.equal(parsed.format, 'mermaid');
  assert.equal(parsed.root.label, '中心主题');
  assert.deepEqual(parsed.root.children.map((node) => node.label), ['分支A', '分支B']);
  assert.deepEqual(parsed.root.children[0].children.map((node) => node.label), ['叶子1']);
  assert.equal(parsed.nodeCount, 4);
});

test('cleanMermaidLabel 剥掉形状外壳与 class', () => {
  assert.equal(cleanMermaidLabel('root((中心主题))'), '中心主题');
  assert.equal(cleanMermaidLabel('A[方案]'), '方案');
  assert.equal(cleanMermaidLabel('B{{风险}}'), '风险');
  assert.equal(cleanMermaidLabel('C:::highlight'), 'C');
  assert.equal(cleanMermaidLabel('普通节点'), '普通节点');
});

test('Markdown 列表按缩进还原层级', () => {
  const parsed = parseMindMap([
    '- 根',
    '  - 子1',
    '    - 孙1',
    '  - 子2',
  ].join('\n'));
  assert.equal(parsed.format, 'outline');
  assert.equal(parsed.root.label, '根');
  assert.deepEqual(parsed.root.children.map((node) => node.label), ['子1', '子2']);
  assert.equal(parsed.root.children[0].children[0].label, '孙1');
});

test('Markdown 标题按 # 级别还原层级', () => {
  const parsed = parseMindMap([
    '# 一级',
    '## 二级 A',
    '### 三级',
    '## 二级 B',
  ].join('\n'));
  assert.equal(parsed.format, 'outline');
  assert.equal(parsed.root.label, '一级');
  assert.deepEqual(parsed.root.children.map((node) => node.label), ['二级 A', '二级 B']);
  assert.equal(parsed.root.children[0].children[0].label, '三级');
});

test('空内容与坏 JSON 返回中文错误，不抛异常', () => {
  assert.match(parseMindMap('  ').error, /空的/);
  assert.match(parseMindMap('{ bad json', 'json').error, /JSON 解析失败/);
  assert.equal(parseMindMap('{ bad json', 'json').root, null);
  assert.match(parseMindMap('普通的一行字\n第二行没有结构').error, /没有识别到导图结构/);
});

test('节点数超过 500 时截断并标记', () => {
  const children = Array.from({ length: 600 }, (_, index) => ({ label: `节点${index}` }));
  const parsed = parseMindMap(JSON.stringify({ label: '根', children }));
  assert.equal(parsed.nodeCount, 500);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.root.children.length, 499);
});
