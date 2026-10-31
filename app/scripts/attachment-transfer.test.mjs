import assert from 'node:assert/strict';
import { File as NodeFile } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { after, afterEach, test } from 'node:test';
import ts from 'typescript';

// 沿用 fast27b-media.test.mjs 的内存转译惯例，不构建应用、不生成编译文件。
// 仅允许加载真实 chatUtils / attachmentTransfer；不得加载 IPC、剪贴板或模型模块。
// 此处 parseHtml 只是注入的归一化结果，不模拟 DOM；真实 template HTML 解析由浏览器回归验证。
const forbiddenCalls = { fetch: 0, document: 0, navigator: 0 };
const originalDescriptors = new Map();
function replaceGlobal(name, descriptor) {
  originalDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, ...descriptor });
}
replaceGlobal('fetch', { value() {
  forbiddenCalls.fetch += 1;
  throw new Error('附件迁移测试禁止网络请求');
} });
for (const name of ['document', 'navigator']) {
  replaceGlobal(name, { get() {
    forbiddenCalls[name] += 1;
    throw new Error(`附件迁移测试禁止访问 ${name}（DOM / 剪贴板）`);
  } });
}
if (typeof globalThis.File === 'undefined') replaceGlobal('File', { value: NodeFile });
afterEach(() => assert.deepEqual(forbiddenCalls, { fetch: 0, document: 0, navigator: 0 }));
after(() => {
  for (const [name, descriptor] of originalDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});

const transferUrl = new URL('../src/features/chat/attachmentTransfer.ts', import.meta.url);
const utilsUrl = new URL('../src/features/chat/chatUtils.ts', import.meta.url);
const allowedModules = new Set([transferUrl.href, utilsUrl.href]);
const modules = new Map();
const dataModule = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
function pureModuleUrl(url) {
  assert.ok(allowedModules.has(url.href), `禁止加载非纯模块：${url.href}`);
  if (modules.has(url.href)) return modules.get(url.href);
  const { outputText, diagnostics } = ts.transpileModule(readFileSync(url, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    reportDiagnostics: true, fileName: url.pathname,
  });
  assert.equal(diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error).length, 0);
  const compiled = outputText.replace(/\b(from\s*|import\s*)(['"])([^'"]+)\2/g, (_, prefix, quote, specifier) => {
    assert.ok(specifier.startsWith('.'), `禁止加载外部依赖：${specifier}`);
    const dependency = new URL(specifier, url);
    if (!dependency.pathname.endsWith('.ts')) dependency.pathname += '.ts';
    return `${prefix}${quote}${pureModuleUrl(dependency)}${quote}`;
  });
  const result = dataModule(compiled);
  modules.set(url.href, result);
  return result;
}
const { readAttachmentTransfer, hasTransferContent, insertTransferText } = await import(pureModuleUrl(transferUrl));
const { MAX_ATTACHMENT_BYTES } = await import(pureModuleUrl(utilsUrl));

const missingFileError = '来源应用未提供可读取的文件数据；请先保存到本机，再拖入文件或使用上传按钮。';
const imageLinkError = '来源应用只提供了图片链接，未取得图片文件；请复制图片本身、粘贴截图，或先保存后添加。';
const invalidImageError = '内嵌图片格式无效，请改为粘贴截图或添加原始图片文件。';
const textLimitError = '拖入或粘贴的文字超过 1 MiB 限制，请改为较小的文本文件。';
const imageData = 'data:image/png;base64,AQID';
function file(name = '样例.png', content = 'abc', overrides = {}) {
  return new File([content], name, { type: 'image/png', lastModified: 123, ...overrides });
}
function fileItem(value) {
  return Object.freeze({ kind: 'file', getAsFile: () => value });
}
function transfer({ files = [], items = [], types = [], plain = '', html = '', uri = '' } = {}) {
  const data = { 'text/plain': plain, 'text/html': html, 'text/uri-list': uri };
  const result = {
    files: Object.freeze([...files]),
    types: Object.freeze([...types]),
    getData(type) {
      assert.ok(Object.hasOwn(data, type), `意外读取数据格式：${type}`);
      return data[type];
    },
  };
  if (items !== undefined) result.items = Object.freeze([...items]);
  return Object.freeze(result);
}
function noHtml() { assert.fail('此分支不应调用 HTML 解析器'); }
function read(input, parseHtml = noHtml) { return readAttachmentTransfer(input, parseHtml); }
function htmlInput(overrides = {}) { return transfer({ html: '<div>来源 HTML</div>', types: ['text/html'], ...overrides }); }
function parsed(images = [], text = '') { return () => ({ images, text }); }

// hasTransferContent 只验证入口格式识别，不读取受保护文件或任何数据内容。
test('内存转译仅加载两个真实纯模块，文字上限保持 1 MiB', () => {
  assert.deepEqual(new Set(modules.keys()), allowedModules);
  assert.equal(MAX_ATTACHMENT_BYTES, 1024 * 1024);
});
test('空迁移和无关格式不声明可处理内容', () => {
  assert.equal(hasTransferContent(transfer()), false);
  assert.equal(hasTransferContent(transfer({ types: ['application/json', 'application/x-custom'] })), false);
});
for (const type of ['Files', 'FILES', 'text/plain', 'TEXT/PLAIN', 'text/html', 'TEXT/HTML', 'text/uri-list', 'TEXT/URI-LIST']) {
  test(`hasTransferContent 大小写不敏感识别 ${type}`, () => {
    assert.equal(hasTransferContent(transfer({ types: [type] })), true);
  });
}
test('实际 files 足以识别内容，不依赖 types，也不读取 getData', () => {
  const input = transfer({ files: [file()] });
  assert.equal(hasTransferContent({ ...input, getData: () => assert.fail('入口识别不得读取内容') }), true);
});

test('空迁移返回空结果而非错误', () => {
  assert.deepEqual(read(transfer()), { files: [], text: '', errors: [], hasFileItems: false });
});
test('files 和 items 相同引用及相同元数据去重，并保持实际 files 优先和顺序', () => {
  const first = file();
  const duplicate = file();
  const second = file('第二张.png');
  const input = transfer({ files: [first], items: [fileItem(first), fileItem(duplicate), fileItem(second), fileItem(second)], types: ['Files'] });
  const result = read(input);
  assert.deepEqual(result, { files: [first, second], text: '', errors: [], hasFileItems: true });
  assert.equal(result.files[0], first);
  assert.notEqual(result.files, input.files);
  assert.deepEqual(input.files, [first]);
  assert.equal(input.items.length, 4);
});
for (const [field, other] of [
  ['名称', () => file('另一张.png')],
  ['大小', () => file('样例.png', 'abcd')],
  ['MIME', () => file('样例.png', 'abc', { type: 'image/jpeg' })],
  ['修改时间', () => file('样例.png', 'abc', { lastModified: 124 })],
]) {
  test(`文件去重键保留${field}不同的文件`, () => {
    const first = file();
    const second = other();
    assert.deepEqual(read(transfer({ files: [first], items: [fileItem(second)] })).files, [first, second]);
  });
}
test('items-only 可以提取真实文件，忽略 string item 且不调用其 getAsFile', () => {
  const actual = file();
  const stringItem = { kind: 'string', getAsFile: () => assert.fail('不得将文本 item 读取为文件') };
  const input = transfer({ items: [stringItem, fileItem(actual), fileItem(actual)], types: ['Files'] });
  assert.equal(hasTransferContent(input), true);
  assert.deepEqual(read(input), { files: [actual], text: '', errors: [], hasFileItems: true });
});
test('items-only 无 types/files 时仍识别真实文件入口并可提取', () => {
  const actual = file();
  const input = transfer({ items: [fileItem(actual)] });
  assert.equal(hasTransferContent(input), true);
  assert.deepEqual(read(input), { files: [actual], text: '', errors: [], hasFileItems: true });
});
test('无 items 属性的迁移仍可读取实际文件', () => {
  const actual = file();
  const { items: _items, ...input } = transfer({ files: [actual] });
  assert.equal(hasTransferContent(input), true);
  assert.deepEqual(read(input).files, [actual]);
});
test('无 items 属性且无文件的迁移仍可识别文本与空内容', () => {
  for (const types of [[], ['text/plain']]) {
    const { items: _items, ...input } = transfer({ types });
    assert.equal(hasTransferContent(input), types.length > 0);
    assert.deepEqual(read(input), { files: [], text: '', errors: [], hasFileItems: false });
  }
});
test('file item 的 getAsFile 返回 null 时给出本地保存提示，不崩溃', () => {
  assert.deepEqual(read(transfer({ items: [fileItem(null)] })), { files: [], text: '', errors: [missingFileError], hasFileItems: true });
});
test('空 file item 不阻止后续可读文件，也不会误报缺文件', () => {
  const actual = file();
  assert.deepEqual(read(transfer({ items: [fileItem(null), fileItem(actual)] })), {
    files: [actual], text: '', errors: [], hasFileItems: true,
  });
});
for (const type of ['Files', 'fIlEs']) {
  test(`${type}-only 虚拟文件给出明确提示并保留文字`, () => {
    assert.deepEqual(read(transfer({ types: [type], plain: '虚拟文件说明' })), {
      files: [], text: '虚拟文件说明', errors: [missingFileError], hasFileItems: true,
    });
  });
}
test('普通 string item 不视为虚拟文件', () => {
  assert.deepEqual(read(transfer({ items: [{ kind: 'string' }], plain: '文本' })), {
    files: [], text: '文本', errors: [], hasFileItems: false,
  });
});

test('纯文本逐字保留空格、换行、中文和表情字符', () => {
  const text = '  中文\r\n第二行\n\u{1f600}  ';
  assert.deepEqual(read(transfer({ plain: text, types: ['text/plain'] })), {
    files: [], text, errors: [], hasFileItems: false,
  });
});
test('URI 列表忽略注释及空行，CRLF 归一化为 LF', () => {
  const uri = '# 来源注释\r\n\r\nhttps://example.invalid/a\r\n  \r\n# 另一条注释\nhttps://example.invalid/b\n';
  assert.deepEqual(read(transfer({ uri, types: ['text/uri-list'] })), {
    files: [], text: 'https://example.invalid/a\nhttps://example.invalid/b', errors: [], hasFileItems: false,
  });
});
test('仅有 URI 注释和空行时不插入任何文字', () => {
  assert.equal(read(transfer({ uri: '# 注释\r\n \r\n\n' })).text, '');
});
test('plain 文本优先于 URI 列表，包括仅空白的 plain 文本', () => {
  for (const plain of ['正文', '  \n']) {
    assert.equal(read(transfer({ plain, uri: 'https://example.invalid/a' })).text, plain);
  }
});
test('实际文件存在时不将 URI 文件路径或链接重复插入为文字', () => {
  const actual = file();
  assert.deepEqual(read(transfer({ files: [actual], uri: 'file:///虚拟/样例.png\nhttps://example.invalid/a' })), {
    files: [actual], text: '', errors: [], hasFileItems: true,
  });
});
test('HTML 只交给注入解析器一次，使用其归一化文本且不访问 DOM', () => {
  const html = '<p>甲</p><div>乙<br>丙</div>';
  const calls = [];
  const result = read(htmlInput({ html }), (source) => {
    calls.push(source);
    return { images: [], text: '甲\n乙\n丙' };
  });
  assert.deepEqual(calls, [html]);
  assert.deepEqual(result, { files: [], text: '甲\n乙\n丙', errors: [], hasFileItems: false });
});
test('HTML 图片仍会提取，但有 plain 文本时不覆盖为 HTML 或 URI 文字', () => {
  const result = read(htmlInput({ plain: '纯文本优先', uri: 'https://example.invalid/a' }), parsed([imageData], 'HTML 文字'));
  assert.equal(result.files.length, 1);
  assert.equal(result.text, '纯文本优先');
  assert.deepEqual(result.errors, []);
});
test('HTML 空文本且无图片时回退 URI；有 HTML 文字时优先于 URI', () => {
  const input = htmlInput({ uri: 'https://example.invalid/a' });
  assert.equal(read(input, parsed()).text, 'https://example.invalid/a');
  assert.equal(read(input, parsed([], 'HTML 正文')).text, 'HTML 正文');
});

for (const [extension, expectedExtension, mime] of [
  ['png', 'png', 'image/png'], ['jpg', 'jpg', 'image/jpeg'], ['jpeg', 'jpg', 'image/jpeg'],
  ['gif', 'gif', 'image/gif'], ['webp', 'webp', 'image/webp'], ['bmp', 'bmp', 'image/bmp'],
  ['tif', 'tif', 'image/tiff'], ['tiff', 'tiff', 'image/tiff'], ['JPEG', 'jpg', 'image/jpeg'],
]) {
  test(`内嵌 ${extension} base64 转真实 File，名称、MIME 和字节正确`, async () => {
    const result = read(htmlInput(), parsed([`data:image/${extension};base64,AQID`], '图片说明'));
    assert.equal(result.files.length, 1);
    const image = result.files[0];
    assert.ok(image instanceof File);
    assert.equal(image.name, `粘贴或拖入图片-1.${expectedExtension}`);
    assert.equal(image.type, mime);
    assert.equal(image.size, 3);
    assert.deepEqual([...new Uint8Array(await image.arrayBuffer())], [1, 2, 3]);
    assert.deepEqual({ text: result.text, errors: result.errors, hasFileItems: result.hasFileItems }, {
      text: '图片说明', errors: [], hasFileItems: false,
    });
  });
}
test('带补位的 base64 正确解码，不把 URI 作为图片说明', async () => {
  const result = read(htmlInput({ uri: 'https://example.invalid/image.png' }), parsed(['data:image/png;base64,AQ==']));
  assert.equal(result.text, '');
  assert.deepEqual([...new Uint8Array(await result.files[0].arrayBuffer())], [1]);
});
test('重复图像源只生成一个 File，独立图片保持来源顺序和编号', () => {
  const other = 'data:image/jpeg;base64,BAUG';
  const images = Object.freeze([imageData, imageData, other, imageData, other]);
  const result = read(htmlInput(), parsed(images));
  assert.deepEqual(result.files.map((image) => [image.name, image.type, image.size]), [
    ['粘贴或拖入图片-1.png', 'image/png', 3], ['粘贴或拖入图片-2.jpg', 'image/jpeg', 3],
  ]);
  assert.deepEqual(result.errors, []);
  assert.equal(images.length, 5);
});
for (const source of [
  'data:image/svg+xml;base64,AQID', 'data:text/plain;base64,AQID', 'data:image/png;base64,',
  'data:image/png;base64,%%%', 'data:image/png;base64,A QID', 'data:image/png,raw',
]) {
  test(`无效内嵌图片 ${source} 给出格式提示并保留说明`, () => {
    const result = read(htmlInput(), parsed([source], '保留图片说明'));
    assert.deepEqual(result, { files: [], text: '保留图片说明', errors: [invalidImageError], hasFileItems: false });
  });
}
test('形似 base64 但不能解码的图片转换失败被捕获，不影响其他图片', () => {
  const result = read(htmlInput(), parsed(['data:image/png;base64,A', imageData]));
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].name, '粘贴或拖入图片-2.png');
  assert.equal(result.errors.length, 1);
  assert.ok(result.errors[0].length > 0);
});
for (const source of ['https://example.invalid/a.png', 'http://example.invalid/a.png', '//example.invalid/a.png', 'blob:测试来源', 'file:///虚拟/图片.png', '']) {
  test(`非内嵌图片源 ${source || '空 src'} 只给出链接提示，不触发 fetch`, () => {
    const result = read(htmlInput(), parsed([source], '链接图片说明'));
    assert.deepEqual(result, { files: [], text: '链接图片说明', errors: [imageLinkError], hasFileItems: false });
    assert.equal(forbiddenCalls.fetch, 0);
  });
}
test('远程图片错误去重，混合有效及无效内嵌图片仍保留可用图片和文字', () => {
  const result = read(htmlInput(), parsed([
    'https://example.invalid/a.png', imageData, 'https://example.invalid/b.png',
    'data:image/png;base64,%%%', 'data:image/png;base64,%%%',
  ], '混合说明'));
  assert.equal(result.files.length, 1);
  assert.equal(result.text, '混合说明');
  assert.deepEqual(result.errors, [imageLinkError, invalidImageError]);
});
for (const origin of ['files', 'items']) {
  test(`优先 ${origin} 中的实际文件，不解析 HTML 或重复生成内嵌图，不误报远程图`, () => {
    const actual = file();
    const input = htmlInput({ [origin]: origin === 'files' ? [actual] : [fileItem(actual)], plain: '保留说明', uri: 'https://example.invalid/a' });
    assert.deepEqual(read(input), { files: [actual], text: '', errors: [], hasFileItems: true });
  });
}
test('虚拟 Files 可由 HTML 内嵌图补足，不再报未读取文件', () => {
  const result = read(htmlInput({ types: ['Files', 'text/html'], items: [fileItem(null)] }), parsed([imageData]));
  assert.equal(result.files.length, 1);
  assert.equal(result.hasFileItems, true);
  assert.deepEqual(result.errors, []);
});
test('虚拟 Files 加远程图片同时报告链接与不可读文件，保留 URI 回退', () => {
  assert.deepEqual(read(htmlInput({ types: ['Files'], uri: 'https://example.invalid/a' }), parsed(['https://example.invalid/a.png'])), {
    files: [], text: 'https://example.invalid/a', errors: [imageLinkError, missingFileError], hasFileItems: true,
  });
});

for (const [label, content] of [
  ['ASCII', 'a'.repeat(MAX_ATTACHMENT_BYTES)],
  ['UTF-8 中文', '中'.repeat(Math.floor(MAX_ATTACHMENT_BYTES / 3)) + 'a'],
]) {
  test(`恰好 1 MiB 的${label}文本允许，超过一个字节拒绝`, () => {
    assert.equal(new Blob([content]).size, MAX_ATTACHMENT_BYTES);
    assert.equal(read(transfer({ plain: content })).text, content);
    assert.deepEqual(read(transfer({ plain: `${content}a` })), {
      files: [], text: '', errors: [textLimitError], hasFileItems: false,
    });
  });
}
test('HTML 归一化文本同样受 1 MiB 限制，已提取图片不丢失', () => {
  const result = read(htmlInput(), parsed([imageData], '中'.repeat(Math.ceil(MAX_ATTACHMENT_BYTES / 3))));
  assert.equal(result.text, '');
  assert.equal(result.files.length, 1);
  assert.deepEqual(result.errors, [textLimitError]);
});
test('URI 回退文本同样受 1 MiB 限制', () => {
  const result = read(transfer({ uri: `https://example.invalid/${'a'.repeat(MAX_ATTACHMENT_BYTES)}` }));
  assert.equal(result.text, '');
  assert.deepEqual(result.errors, [textLimitError]);
});
test('超限 plain 不静默替换为较短 HTML 文字', () => {
  assert.deepEqual(read(htmlInput({ plain: 'a'.repeat(MAX_ATTACHMENT_BYTES + 1) }), parsed([], '较短 HTML 文字')), {
    files: [], text: '', errors: [textLimitError], hasFileItems: false,
  });
});
test('实际文件携带的超限同源 plain 被忽略，不误报文字超限', () => {
  const actual = file();
  assert.deepEqual(read(htmlInput({ files: [actual], plain: 'a'.repeat(MAX_ATTACHMENT_BYTES + 1) })), {
    files: [actual], text: '', errors: [], hasFileItems: true,
  });
});

for (const { label, value, text, selection, expected, caret } of [
  { label: '空输入直接插入', value: '', text: '新文', expected: '新文', caret: 2 },
  { label: '无选区追加前补换行', value: '原文', text: '新文', expected: '原文\n新文', caret: 5 },
  { label: '末尾已有换行不重复添加', value: '原文\n', text: '新文', expected: '原文\n新文', caret: 5 },
  { label: '保留文本自身换行', value: '原文', text: '\n新文\n', expected: '原文\n\n新文\n', caret: 7 },
  { label: '选区替换保留前后内容', value: '前旧文后', text: '新文', selection: { start: 1, end: 3 }, expected: '前新文后', caret: 3 },
  { label: '全选后替换', value: '全部旧文', text: '新文', selection: { start: 0, end: 4 }, expected: '新文', caret: 2 },
  { label: '光标位于开头', value: '原文', text: '新文', selection: { start: 0, end: 0 }, expected: '新文原文', caret: 2 },
  { label: '光标位于中间不加换行', value: '前后', text: '新文', selection: { start: 1, end: 1 }, expected: '前新文后', caret: 3 },
  { label: '显式末尾光标不自动补换行', value: '原文', text: '新文', selection: { start: 2, end: 2 }, expected: '原文新文', caret: 4 },
  { label: '空文本可以删除选区', value: '前旧文后', text: '', selection: { start: 1, end: 3 }, expected: '前后', caret: 1 },
  { label: 'UTF-16 光标与浏览器选区一致', value: '甲\u{1f600}乙', text: '\u{1f600}', selection: { start: 1, end: 3 }, expected: '甲\u{1f600}乙', caret: 3 },
]) {
  test(`insertTransferText ${label}`, () => {
    if (selection) Object.freeze(selection);
    assert.deepEqual(insertTransferText(value, text, selection), { value: expected, caret });
  });
}
