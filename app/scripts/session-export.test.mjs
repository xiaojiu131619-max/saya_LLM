import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

/** 会话导出文件名：本地日期、非法字符与控制字符处理。 */
const source = readFileSync(new URL('../src/lib/sessionExport.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { buildExportFilename } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

const localCreated = new Date(2026, 9, 15, 1, 30).getTime();

test('导出文件名：标题里的省略号合法，不按 .. 路径穿越拒绝', () => {
  assert.equal(
    buildExportFilename({ title: '帮我看看...', createdAt: localCreated }, 'markdown'),
    '帮我看看...-2026-10-15.md',
  );
});

test('导出文件名：清掉控制字符与 Windows 非法字符', () => {
  assert.equal(
    buildExportFilename({ title: 'a\u0001b<>c', createdAt: localCreated }, 'json'),
    'ab__c-2026-10-15.json',
  );
});

test('导出文件名：本地日期口径，非法 createdAt 不抛错', () => {
  // 本地 01:30 不能被 UTC 记到前一天。
  assert.equal(
    buildExportFilename({ title: '凌晨会话', createdAt: localCreated }, 'text'),
    '凌晨会话-2026-10-15.txt',
  );
  assert.match(
    buildExportFilename({ title: '坏时间', createdAt: Number.NaN }, 'text'),
    /^坏时间-\d{4}-\d{2}-\d{2}\.txt$/,
  );
});
