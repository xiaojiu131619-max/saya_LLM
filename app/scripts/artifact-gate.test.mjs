import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

// 沿用 delivery-guard.test.mjs 的内存转译惯例，不构建应用、不生成编译文件。
const source = readFileSync(new URL('../src/features/chat/artifactGate.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { artifactExpectation, judgeArtifactDelivery } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

const file = (name, extra = {}) => ({
  kind: 'file',
  title: name,
  path: `out/${name}`,
  size: 128,
  magicOk: true,
  ...extra,
});

test('普通问答不触发产物门', () => {
  for (const prompt of [
    '',
    '你好',
    'PDF 是什么格式？',
    '解释一下 PDF 和 DOCX 的区别',
    '为什么导出的 PDF 打不开',
    '怎么把表格做得更好看',
    '给我讲讲这个报告',
  ]) {
    assert.equal(artifactExpectation(prompt), null, `不应触发：${prompt}`);
    const verdict = judgeArtifactDelivery(prompt, []);
    assert.equal(verdict.gated, false);
    assert.equal(verdict.ok, true);
  }
});

test('任务类型白名单：明确的产出动作才推断类型', () => {
  const cases = [
    ['帮我生成一份 PDF 报告', 'pdf'],
    ['把报告导出成 PPT', 'slides'],
    ['做一个 Excel 表格', 'spreadsheet'],
    ['生成一张海报', 'image'],
    ['写一份调研报告', 'document'],
    ['画一个思维导图', 'mindmap'],
    ['整理成 mermaid 脑图', 'mindmap'],
    ['做 PPT', 'slides'],
    ['生成一个 SVG 图标', 'image'],
    ['结果写到 report.pdf', 'pdf'],
  ];
  for (const [prompt, id] of cases) {
    assert.equal(artifactExpectation(prompt)?.id, id, `prompt=${prompt}`);
  }
});

test('交付容器优先：报告 + PPT 按演示文稿校验', () => {
  assert.equal(artifactExpectation('把这份报告做成 PPT')?.id, 'slides');
  assert.equal(artifactExpectation('生成一份 PDF 版简历')?.id, 'pdf');
  // 「思维导图」只是 PPT 里的一页，交付物仍是 PPT。
  assert.equal(artifactExpectation('生成一份包含思维导图的 PPT')?.id, 'slides');
  // 明确写「导出成 X」时，以 X 为交付物，而不是句中先出现的类型词。
  assert.equal(artifactExpectation('把思维导图导出成 PNG')?.id, 'image');
  assert.equal(artifactExpectation('把 PDF 里的表格导出成 Excel')?.id, 'spreadsheet');
  assert.equal(artifactExpectation('把报告保存为 report.xlsx')?.id, 'spreadsheet');
});

test('没有写文件产物判 missing', () => {
  const verdict = judgeArtifactDelivery('生成一份 PDF', []);
  assert.equal(verdict.gated, true);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.issue, 'missing');
  assert.match(verdict.detail, /没有检测到写文件产物/);
});

test('类型不符判 wrong_type，链接不算产物', () => {
  const verdict = judgeArtifactDelivery('生成一份 PDF', [
    file('report.md'),
    { kind: 'link', title: '来源', url: 'https://example.com' },
  ]);
  assert.equal(verdict.issue, 'wrong_type');
  assert.match(verdict.detail, /要求PDF（pdf）/);
  assert.match(verdict.detail, /report\.md/);

  const onlyLink = judgeArtifactDelivery('生成一份 PDF', [
    { kind: 'link', title: '来源', url: 'https://example.com' },
  ]);
  assert.equal(onlyLink.issue, 'missing');
});

test('空文件判 empty_file', () => {
  const verdict = judgeArtifactDelivery('生成一份 PDF', [file('report.pdf', { size: 0 })]);
  assert.equal(verdict.issue, 'empty_file');
  assert.match(verdict.detail, /空文件/);
});

test('扩展名对但文件头不对判 magic_mismatch', () => {
  const verdict = judgeArtifactDelivery('生成一份 PDF', [
    file('report.pdf', { magic: null, magicOk: false }),
    file('notes.txt', { magicOk: true }),
  ]);
  assert.equal(verdict.issue, 'magic_mismatch');
  assert.match(verdict.detail, /文件头与扩展名不符/);
  assert.match(verdict.detail, /report\.pdf/);
});

test('magicOk 缺省视为通过，兼容旧消息', () => {
  const legacy = { kind: 'file', title: 'report.pdf', path: 'report.pdf', size: 128 };
  const verdict = judgeArtifactDelivery('生成一份 PDF', [legacy]);
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.matched, ['report.pdf']);
});

test('大小写扩展名与「标题无扩展名、路径有扩展名」都能匹配', () => {
  assert.equal(
    judgeArtifactDelivery('生成一份 PDF', [file('REPORT.PDF')]).ok,
    true,
  );
  const labeled = judgeArtifactDelivery('生成一份 PDF', [
    { kind: 'file', title: '月度报告', path: 'out/report.pdf', size: 10, magicOk: true },
  ]);
  assert.equal(labeled.ok, true);
  assert.deepEqual(labeled.matched, ['月度报告']);
});

test('校验通过时返回匹配到的产物标题', () => {
  const verdict = judgeArtifactDelivery('生成一份 PDF', [
    file('report.pdf', { magic: 'pdf' }),
    file('chart.png', { magic: 'png' }),
  ]);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.issue, null);
  assert.deepEqual(verdict.matched, ['report.pdf']);
});
