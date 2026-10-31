import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const modules = new Map();
function pureModuleUrl(url) {
  if (modules.has(url.href)) return modules.get(url.href);
  const { outputText, diagnostics } = ts.transpileModule(readFileSync(url, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    reportDiagnostics: true, fileName: url.pathname,
  });
  assert.equal(diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error).length, 0);
  const compiled = outputText.replace(/\b(from\s*|import\s*)(['"])([^'"]+)\2/g, (_, prefix, quote, specifier) => {
    assert.ok(specifier.startsWith('.') || specifier.startsWith('@/'));
    const dependency = specifier.startsWith('@/')
      ? new URL(`../src/${specifier.slice(2)}.ts`, import.meta.url) : new URL(`${specifier}.ts`, url);
    return `${prefix}${quote}${pureModuleUrl(dependency)}${quote}`;
  });
  const result = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
  modules.set(url.href, result);
  return result;
}
const { AutoTuneTaskManager, autoTuneBusy, canApplyAutoTune, sameLoadConfig, tuneRecordPatch } = await import(pureModuleUrl(new URL('../src/lib/autoTuneTask.ts', import.meta.url)));
const { buildServerConfig } = await import(pureModuleUrl(new URL('../src/lib/serverConfig.ts', import.meta.url)));
const { modelVramSignature } = await import(pureModuleUrl(new URL('../src/lib/vramMeasurement.ts', import.meta.url)));
const loadConfig = {
  ctxLength: 4096, gpuLayers: 33, batchSize: 512, physicalBatchSize: 128, threads: -1, parallel: -1,
  fastAttention: true, kvCache: true, kvUnified: true, mmap: true, mlock: false, noWarmup: false,
  cacheTypeKEnabled: false, cacheTypeK: 'q8_0', cacheTypeVEnabled: true, cacheTypeV: 'q4_0',
  ropeFreqBaseEnabled: false, ropeFreqBase: 0, ropeFreqScaleEnabled: false, ropeFreqScale: 0,
  seedEnabled: false, seed: -1, speculativeDecoding: 'dspark', specDraftNMaxEnabled: true, specDraftNMax: 7,
  chatTemplate: '模板', rememberSettings: true, showAdvancedSettings: false,
  idleAutoUnload: false, idleAutoUnloadMinutes: 15, moeCpuLayers: 3, reasoningBudget: 42,
};
const model = {
  id: 'model-a', name: '模型A', family: 'Qwen', params: '8B', filePath: 'D:/models/a.gguf',
  modelType: 'moe', architecture: 'qwen3', blockCount: 32, ctxLength: 32768, loadConfig,
  mmprojPath: 'D:/models/mmproj.gguf', supportsVision: true, dsparkDraftPath: 'D:/models/dspark.gguf',
  mtpDraftPath: 'D:/models/mtp.gguf', dflashDraftPath: 'D:/models/dflash.gguf',
};
const baseline = buildServerConfig(model, 8080, 'llama-server.exe', { enabled: true, host: '127.0.0.1', apiKey: 'secret-test-key' }, []);
const authorization = (run = 'run-a') => ({
  config: { run_id: run, model_id: model.id, baseline: structuredClone(baseline), block_count: 32, max_ctx: 32768, is_moe: true, sort_mode: 'ts' },
  modelName: model.name, modelPath: model.filePath, modelSignature: modelVramSignature(model), loadConfig: structuredClone(loadConfig),
});
const record = {
  model_type: 'moe', ngl: 29, ncmoe: 4, ctx: 8192, kv: 'q8_0/q4_0', cache_type_k: 'q8_0', cache_type_v: 'q4_0',
  cache_type_k_enabled: true, cache_type_v_enabled: true, vram_used_gb: 8, vram_total_gb: 12, vram_percent: 2 / 3,
  vram_available: true, ts: 12.5, first_token_ms: 300, fits: true,
};
const result = (run = 'run-a') => ({ run_id: run, model_id: model.id, best: record, records: [record], failures: [] });
function setup(overrides = {}) {
  const saves = [];
  const manager = new AutoTuneTaskManager({ start: async () => {}, cancel: async () => {}, save: async (_, experiment) => { saves.push(experiment); }, ...overrides });
  return { manager, saves };
}

test('调参一致性只看推理字段，界面偏好变更不算冲突', () => {
  assert.equal(sameLoadConfig(loadConfig, {
    ...loadConfig,
    rememberSettings: false,
    showAdvancedSettings: true,
    idleAutoUnload: true,
    idleAutoUnloadMinutes: 1,
  }), true);
  assert.equal(sameLoadConfig(loadConfig, { ...loadConfig, ctxLength: 2048 }), false);
});

test('服务基线保留用户完整配置与独立 K/V 开关，不修改输入', () => {
  assert.equal(baseline.n_ctx, 4096);
  assert.equal(baseline.parallel, -1);
  assert.equal(baseline.batch_size, 512);
  assert.equal(baseline.ubatch_size, 128);
  assert.equal(baseline.reasoning_budget, 42);
  assert.equal(baseline.cache_type_k_enabled, false);
  assert.equal(baseline.cache_type_v_enabled, true);
  assert.equal(baseline.spec_draft_n_max, 7);
  assert.equal(baseline.dspark_draft_path, model.dsparkDraftPath);
  assert.equal(baseline.mmproj_path, model.mmprojPath);
  assert.equal(loadConfig.ctxLength, 4096);
});
test('测量 IPC 清空克隆配置密钥，原授权和内存脱敏密钥不变', async () => {
  const auth = authorization();
  let request;
  const { manager, saves } = setup({ start: async (value) => { request = value; } });
  await manager.start(auth);
  assert.equal(request.baseline.api_key, null);
  assert.equal(auth.config.baseline.api_key, 'secret-test-key');
  assert.notEqual(request, auth.config);
  assert.notEqual(request.baseline, auth.config.baseline);
  manager.fail('run-a', model.id, 'secret-test-key');
  await manager.waitForSaves();
  assert.equal(JSON.stringify(saves[0]).includes('secret-test-key'), false);
});
test('仅在原模型身份、侧车签名、完整加载配置均不变时允许应用', () => {
  const auth = authorization();
  assert.equal(canApplyAutoTune(model, auth), true);
  assert.equal(canApplyAutoTune(undefined, auth), false);
  assert.equal(canApplyAutoTune({ ...model, filePath: 'other.gguf' }, auth), false);
  for (const key of ['mmprojPath', 'mtpDraftPath', 'dsparkDraftPath', 'dflashDraftPath']) {
    assert.equal(canApplyAutoTune({ ...model, [key]: 'changed.gguf' }, auth), false, key);
  }
  assert.equal(canApplyAutoTune({ ...model, loadConfig: { ...loadConfig, threads: 8 } }, auth), false);
  assert.equal(canApplyAutoTune({ ...model, name: '改名' }, auth), true);
  const next = { ...loadConfig, ...tuneRecordPatch(record) };
  assert.equal(next.parallel, -1);
  assert.equal(next.reasoningBudget, 42);
  assert.equal(next.ctxLength, record.ctx);
  assert.equal(next.cacheTypeKEnabled, true);
});
test('run_id/model_id 隔离乱序事件，重复终态仅应用与保存一次', async () => {
  const { manager, saves } = setup();
  let applications = 0;
  manager.setApplicationHandler((auth, value) => { applications += 1; manager.reportApplication(value.run_id, canApplyAutoTune(model, auth)); });
  await manager.start(authorization());
  manager.progress({ run_id: 'old', model_id: model.id, message: '旧事件' });
  manager.done({ ...result(), model_id: 'wrong' });
  assert.equal(manager.getSnapshot().status, 'running');
  manager.done(result());
  manager.done(result());
  manager.fail('run-a', model.id, '迟到错误');
  await manager.waitForSaves();
  assert.equal(applications, 1);
  assert.equal(saves.length, 1);
  assert.equal(manager.getSnapshot().application, 'applied');
});
test('取消失败可重试，stopping 保持忙碌，done 不能自动应用', async () => {
  let cancels = 0;
  const { manager, saves } = setup({ cancel: async () => { cancels += 1; if (cancels === 1) throw new Error('网络错误'); } });
  let applications = 0;
  manager.setApplicationHandler(() => { applications += 1; });
  await manager.start(authorization());
  await assert.rejects(manager.cancel(), /网络错误/);
  assert.equal(autoTuneBusy(manager.getSnapshot()), true);
  await assert.rejects(manager.start(authorization('run-b')), /等待终态/);
  await manager.cancel();
  manager.done(result());
  await manager.waitForSaves();
  assert.equal(cancels, 2);
  assert.equal(applications, 0);
  assert.equal(saves.length, 1);
  assert.equal(manager.getSnapshot().application, 'none');
});
test('失败与取消终态合并全量记录并脱敏保存，清空日志不清数据', async () => {
  for (const status of ['error', 'cancelled']) {
    const { manager, saves } = setup();
    await manager.start(authorization());
    const terminal = { records: [record], failures: [{ kind: 'fatal', message: 'secret-test-key', server_error: { api_key: 'secret-test-key' } }] };
    if (status === 'error') manager.fail('run-a', model.id, 'secret-test-key', terminal);
    else manager.cancelled('run-a', model.id, '已停止', terminal);
    await manager.waitForSaves();
    assert.equal(saves[0].records.length, 1);
    assert.equal(saves[0].failures.length, 1);
    assert.equal(saves[0].config.baseline.api_key, null);
    assert.equal(JSON.stringify(saves[0]).includes('secret-test-key'), false);
    manager.clearLog();
    assert.equal(manager.getSnapshot().records.length, 1);
  }
});
test('status 恢复不产生手动授权或自动应用，过期异步恢复不得覆盖新任务', async () => {
  const { manager, saves } = setup();
  let applications = 0;
  manager.setApplicationHandler(() => { applications += 1; });
  await manager.restore(async () => ({ run_id: 'old', model_id: model.id, status: 'done', result: result('old'), records: [record], failures: [] }));
  assert.equal(manager.getSnapshot().authorized, false);
  assert.equal(applications, 0);
  assert.equal(saves.length, 0);
  let release;
  const pending = manager.restore(() => new Promise((resolve) => { release = resolve; }));
  await manager.start(authorization());
  release({ run_id: 'old', model_id: model.id, status: 'running', records: [], failures: [] });
  await pending;
  assert.equal(manager.getSnapshot().runId, 'run-a');
});
test('页面订阅重挂载不重复应用，处理器晚绑定仍应用一次', async () => {
  const { manager } = setup();
  let notifications = 0;
  const unsubscribe = manager.subscribe(() => { notifications += 1; });
  await manager.start(authorization());
  unsubscribe();
  manager.done(result());
  let applications = 0;
  const handler = () => { applications += 1; };
  manager.setApplicationHandler(handler);
  manager.setApplicationHandler(undefined);
  manager.setApplicationHandler(handler);
  assert.equal(applications, 1);
  assert.equal(notifications, 1);
  assert.equal(autoTuneBusy(manager.getSnapshot()), true);
  manager.reportApplication('run-a', false);
  assert.equal(manager.getSnapshot().application, 'conflict');
  assert.equal(autoTuneBusy(manager.getSnapshot()), false);
});
test('显存遥测未知不展示 0%，且不声称验证预算', async () => {
  const { manager } = setup();
  await manager.start(authorization());
  const best = { ...record, vram_available: false, vram_percent: 0 };
  manager.done({ ...result(), best, records: [best] });
  const log = manager.getSnapshot().log.join('\n');
  assert.match(log, /显存未知，无法验证 90% 预算/);
  assert.equal(log.includes('显存 0%'), false);
});

for (const terminalStatus of ['done', 'error', 'cancelled']) {
  test(`首次 restore 返回旧 running 前收到 ${terminalStatus}，重放终态且无自动应用授权`, async () => {
    const { manager, saves } = setup();
    let applications = 0;
    manager.setApplicationHandler(() => { applications += 1; });
    let release;
    const restoring = manager.restore(() => new Promise((resolve) => { release = resolve; }));
    const terminal = { records: [record], failures: [{ kind: 'cancelled', message: '终态详情' }] };
    if (terminalStatus === 'done') manager.done(result());
    else if (terminalStatus === 'error') manager.fail('run-a', model.id, '测量失败', terminal);
    else manager.cancelled('run-a', model.id, '已停止', terminal);
    assert.equal(manager.getSnapshot(), null);
    release({ run_id: 'run-a', model_id: model.id, status: 'running', records: [], failures: [] });
    await restoring;
    await manager.waitForSaves();
    assert.equal(manager.getSnapshot().status, terminalStatus);
    assert.equal(autoTuneBusy(manager.getSnapshot()), false);
    assert.equal(manager.getSnapshot().records.length, 1);
    assert.equal(manager.getSnapshot().authorized, false);
    assert.equal(manager.getSnapshot().application, 'none');
    assert.equal(applications, 0);
    assert.equal(saves.length, 0);
  });
}

for (const status of [null, 'done', 'error', 'cancelled']) {
  test(`cancel 拒绝后按 ${status ?? '无活动任务'} 对账，不永久 stopping 或自动应用`, async () => {
    let queries = 0;
    let applications = 0;
    const { manager, saves } = setup({
      cancel: async () => { throw new Error('无活动任务'); },
      status: async () => {
        queries += 1;
        return status === null ? null : {
          run_id: 'run-a', model_id: model.id, status,
          result: status === 'done' ? result() : undefined,
          records: [record], failures: [], error: '测量失败',
        };
      },
    });
    manager.setApplicationHandler(() => { applications += 1; });
    await manager.start(authorization());
    await assert.rejects(manager.cancel(), /无活动任务/);
    await manager.waitForSaves();
    assert.equal(queries, 1);
    assert.equal(manager.getSnapshot().status, status ?? 'cancelled');
    assert.equal(autoTuneBusy(manager.getSnapshot()), false);
    assert.equal(applications, 0);
    assert.equal(saves.length, 1);
  });
}

test('cancel 成功但缺终态事件时也主动对账', async () => {
  const { manager } = setup({ status: async () => null });
  await manager.start(authorization());
  await manager.cancel();
  assert.equal(manager.getSnapshot().status, 'cancelled');
  assert.equal(autoTuneBusy(manager.getSnapshot()), false);
});
test('cancel 拒绝且后端仍 running 时保留 stopping，稍后 done 不自动应用', async () => {
  const { manager } = setup({
    cancel: async () => { throw new Error('停止失败'); },
    status: async () => ({ run_id: 'run-a', model_id: model.id, status: 'running', records: [], failures: [] }),
  });
  let applications = 0;
  manager.setApplicationHandler(() => { applications += 1; });
  await manager.start(authorization());
  await assert.rejects(manager.cancel(), /停止失败/);
  assert.equal(manager.getSnapshot().status, 'stopping');
  manager.done(result());
  assert.equal(applications, 0);
  assert.equal(autoTuneBusy(manager.getSnapshot()), false);
});
