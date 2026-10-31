import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const sourceUrl = new URL('../src/lib/modelState.ts', import.meta.url);
const { outputText, diagnostics } = ts.transpileModule(readFileSync(sourceUrl, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  reportDiagnostics: true,
  fileName: sourceUrl.pathname,
});
assert.equal(diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error).length, 0);
const moduleUrl = `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`;
const { activateMainModel, clearMainLoadedModels, isIndependentModel } = await import(moduleUrl);

const models = [
  { id: 'old', status: 'loaded', modelTask: 'chat' },
  { id: 'new', status: 'standby', modelTask: 'chat' },
  { id: 'embedding', status: 'loaded', modelTask: 'embedding' },
  { id: 'rerank', status: 'loaded', modelTask: 'rerank' },
];

test('激活主模型时只保留一个主模型为 loaded', () => {
  const next = activateMainModel(models, 'new');
  assert.deepEqual(next.map(({ id, status }) => ({ id, status })), [
    { id: 'old', status: 'standby' },
    { id: 'new', status: 'loaded' },
    { id: 'embedding', status: 'loaded' },
    { id: 'rerank', status: 'loaded' },
  ]);
});

test('停止主服务只清理主模型，不影响独立向量和重排模型', () => {
  const next = clearMainLoadedModels(models);
  assert.deepEqual(next.map(({ id, status }) => ({ id, status })), [
    { id: 'old', status: 'standby' },
    { id: 'new', status: 'standby' },
    { id: 'embedding', status: 'loaded' },
    { id: 'rerank', status: 'loaded' },
  ]);
});

test('未知模型或独立模型不能接管主服务状态', () => {
  assert.strictEqual(activateMainModel(models, 'missing'), models);
  assert.strictEqual(activateMainModel(models, 'embedding'), models);
  assert.equal(isIndependentModel(models[2]), true);
});
