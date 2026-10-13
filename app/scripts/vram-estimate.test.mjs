import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

// 与 vram-measurement.test.mjs 相同：仅转译纯模块，用 data URL 解析运行时别名。
const moduleUrls = new Map();
function pureModuleUrl(url) {
  if (moduleUrls.has(url.href)) return moduleUrls.get(url.href);
  const { outputText, diagnostics } = ts.transpileModule(readFileSync(url, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    reportDiagnostics: true,
    fileName: url.pathname,
  });
  assert.equal(diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error).length, 0);
  const compiled = outputText.replace(/\b(from\s*|import\s*)(['"])([^'"]+)\2/g, (match, prefix, quote, specifier) => {
    assert.ok(specifier.startsWith('.') || specifier.startsWith('@/'), `纯模块不能加载外部运行时依赖 ${specifier}`);
    const dependency = specifier.startsWith('@/')
      ? new URL(`../src/${specifier.slice(2)}.ts`, import.meta.url)
      : new URL(`${specifier}.ts`, url);
    return `${prefix}${quote}${pureModuleUrl(dependency)}${quote}`;
  });
  const result = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
  moduleUrls.set(url.href, result);
  return result;
}
const { predictVramUsage, cacheBytesPerValue } = await import(pureModuleUrl(new URL('../src/lib/vramEstimate.ts', import.meta.url)));
const { computeVramCalibration } = await import(pureModuleUrl(new URL('../src/lib/vramCalibration.ts', import.meta.url)));
const { modelVramSignature, vramMeasurementConfig, assessVramMeasurement, parseVramBuffers } = await import(pureModuleUrl(new URL('../src/lib/vramMeasurement.ts', import.meta.url)));

// 所有模型、GPU、日志、运行记录和路径均为合成数据，不访问模型文件或真实硬件。
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const MODERN_KERNEL = 'b11405';
const LEGACY_KERNEL = 'b10883';
const config = {
  ctxLength: 4096, gpuLayers: 5, batchSize: 512, physicalBatchSize: 128,
  threads: -1, parallel: 1, fastAttention: true, kvCache: true, kvUnified: true,
  mmap: true, mlock: false, noWarmup: false,
  cacheTypeKEnabled: false, cacheTypeK: 'q5_0', cacheTypeVEnabled: false, cacheTypeV: 'q4_1',
  ropeFreqBaseEnabled: false, ropeFreqBase: 0, ropeFreqScaleEnabled: false, ropeFreqScale: 0,
  seedEnabled: false, seed: -1, speculativeDecoding: 'off', specDraftNMaxEnabled: false, specDraftNMax: 4,
  chatTemplate: '', rememberSettings: true, showAdvancedSettings: false,
  idleAutoUnload: false, idleAutoUnloadMinutes: 15, moeCpuLayers: 0, reasoningBudget: 0,
};
function layout(weightsMiB = [128, 256, 512, 768], expertsMiB = [0, 0, 0, 0], overrides = {}) {
  const value = {
    version: 1,
    layers: weightsMiB.map((weight, index) => ({ weight_bytes: weight * MiB, expert_bytes: expertsMiB[index] * MiB })),
    input_bytes: 256 * MiB, output_bytes: 128 * MiB, other_bytes: 0,
    signature: 'synthetic-layout-dense-v1', accuracy: 'exact', tied_output: false,
    ...overrides,
  };
  value.total_bytes = value.input_bytes + value.output_bytes + value.other_bytes
    + value.layers.reduce((sum, layer) => sum + layer.weight_bytes, 0);
  return value;
}
function makeModel(overrides = {}) {
  const memoryLayout = overrides.memoryLayout ?? layout();
  return structuredClone({
    id: 'synthetic:dense', name: '合成四层模型', family: '合成模型', params: '合成', quant: 'Q4_K_M',
    fileSize: '合成体积', fileSizeBytes: memoryLayout.total_bytes + 16 * MiB,
    modelType: 'dense', status: 'standby', themeColor: '#000', themeColorSolid: '#000',
    description: '', longDescription: '', tags: [], downloadCount: '', ctxLength: 32768,
    loadConfig: config, releaseDate: '', license: '', source: 'local',
    architecture: 'llama', blockCount: 4, embeddingLength: 1024, headCount: 8, headCountKv: 4,
    kvHeadsByLayer: [4, 4, 4, 4], keyLength: 128, valueLength: 64,
    memoryLayout, filePath: '/synthetic/fixtures/model.gguf',
    ...overrides,
  });
}
const model = makeModel();
const hardware = { gpuName: '合成 GPU A', vramTotal: 24, kernelVersion: MODERN_KERNEL };
function near(actual, expected, message = '') {
  assert.ok(typeof actual === 'number' && Number.isFinite(actual), `${message} 应为有限数，实际为 ${actual}`);
  const tolerance = Math.max(1e-10, Math.abs(expected) * 1e-10);
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message} 期望 ${expected}，实际 ${actual}`);
}
function predict(target = model, changes = {}, kernelVersion = MODERN_KERNEL, calibration) {
  return predictVramUsage(target, { ...target.loadConfig, ...changes }, calibration, { kernelVersion });
}
function assertUnmatched(value) {
  assert.equal(value.matched, false);
  assert.equal(value.samples, 0);
  assert.equal(value.confidence, 'none');
  for (const key of ['weightsRatio', 'kvRatio', 'computeRatio', 'runtimeOffsetGb', 'uncertaintyGb']) {
    assert.equal(value[key], undefined, `未准入记录不能生成 ${key}`);
  }
}

// 固定、独立的卸载期望：重复层为 128/256/512/768 MiB，输出层为 128 MiB。
for (const [gpuLayers, expectedMiB, repeatedLayers] of [
  [0, 0, 0], [1, 128, 0], [2, 896, 1], [3, 1408, 2], [4, 1664, 3], [5, 1792, 4],
]) {
  test(`b11405 ngl=${gpuLayers} 按 output-first 与不均匀重复层布局计权重`, () => {
    const result = predict(model, { gpuLayers });
    assert.equal(result.weightSource, 'tensor');
    near(result.rawWeightsGpuGb, expectedMiB / 1024, 'GPU 权重');
    near(result.weightsCpuGb, (2048 - expectedMiB) / 1024, 'CPU 权重');
    near(result.offloadRatio, repeatedLayers / 4, '重复层卸载比例');
    assert.equal(result.missing.includes('kernel_layer_order'), false);
    if (gpuLayers === 1) near(result.rawKvGb, 0, '只卸载输出层不分配重复层 KV');
  });
}
for (const [gpuLayers, expectedMiB, repeatedLayers] of [[1, 768, 1], [4, 1664, 4], [5, 1792, 4]]) {
  test(`legacy b10883 ngl=${gpuLayers} 保留 output-last 规则`, () => {
    const result = predict(model, { gpuLayers }, LEGACY_KERNEL);
    near(result.rawWeightsGpuGb, expectedMiB / 1024, 'GPU 权重');
    near(result.offloadRatio, repeatedLayers / 4, '重复层卸载比例');
    assert.equal(result.missing.includes('kernel_layer_order'), false);
  });
}
test('kernelVersion 来自第 4 参数，新旧规则在 ngl=L 有不同 KV 层数', () => {
  const modern = predictVramUsage(model, { ...config, gpuLayers: 4 }, undefined, { kernelVersion: 'llama.cpp b11405 (synthetic)' });
  const legacy = predictVramUsage(model, { ...config, gpuLayers: 4 }, undefined, { kernelVersion: LEGACY_KERNEL });
  near(modern.rawKvGb, 12 * 4096 * (128 + 64) * 2 / GiB);
  near(legacy.rawKvGb, 16 * 4096 * (128 + 64) * 2 / GiB);
});
test('unknown 内核保守保留 ngl 个重复层及 output，并提示层序未知', () => {
  for (const options of [undefined, { kernelVersion: null }, { kernelVersion: '' }, { kernelVersion: 'synthetic-unknown' }]) {
    const result = predictVramUsage(model, { ...config, gpuLayers: 1 }, undefined, options);
    near(result.rawWeightsGpuGb, (768 + 128) / 1024);
    assert.ok(result.rawWeightsGpuGb >= predict(model, { gpuLayers: 1 }).rawWeightsGpuGb);
    assert.ok(result.rawWeightsGpuGb >= predict(model, { gpuLayers: 1 }, LEGACY_KERNEL).rawWeightsGpuGb);
    assert.ok(result.missing.includes('kernel_layer_order'));
  }
  near(predict(model, { gpuLayers: 4 }, null).rawWeightsGpuGb, 1792 / 1024);
  assert.equal(predict(model, { gpuLayers: 5 }, null).missing.includes('kernel_layer_order'), false);
});
test('全卸载哨兵 -1/999 与 L+1 相同，input embedding 留在 CPU', () => {
  for (const gpuLayers of [-1, 5, 999]) {
    const result = predict(model, { gpuLayers });
    near(result.rawWeightsGpuGb, 1792 / 1024);
    near(result.weightsCpuGb, 256 / 1024);
    near(result.weightsGpuGb + result.weightsCpuGb, 2, '张量权重总量不包含文件元数据');
    near(result.offloadRatio, 1);
  }
});
test('tied_output 创建 GPU 副本，同时保留 input 的 CPU 原件', () => {
  const tiedLayout = layout(undefined, undefined, { output_bytes: 0, tied_output: true, signature: 'synthetic-tied-v1' });
  const tied = makeModel({ memoryLayout: tiedLayout });
  const modernOutputOnly = predict(tied, { gpuLayers: 1 });
  near(modernOutputOnly.rawWeightsGpuGb, 256 / 1024, '输出副本');
  near(modernOutputOnly.weightsCpuGb, tiedLayout.total_bytes / GiB, '原始张量全部留在 CPU');
  near(predict(tied, { gpuLayers: 4 }, LEGACY_KERNEL).rawWeightsGpuGb, 1664 / 1024, '旧内核未卸载输出时不复制');
  for (const kernelVersion of [MODERN_KERNEL, LEGACY_KERNEL, null]) {
    const result = predict(tied, { gpuLayers: 5 }, kernelVersion);
    near(result.rawWeightsGpuGb, (1664 + 256) / 1024);
    near(result.weightsCpuGb, 256 / 1024);
    near(result.weightsGpuGb + result.weightsCpuGb, (tiedLayout.total_bytes + tiedLayout.input_bytes) / GiB);
  }
});

const moe = makeModel({
  id: 'synthetic:moe', modelType: 'moe', expertCount: 64,
  memoryLayout: layout([256, 512, 1024, 2048], [128, 256, 512, 1536], {
    input_bytes: 128 * MiB, output_bytes: 64 * MiB, signature: 'synthetic-moe-v1',
  }),
});
for (const [moeCpuLayers, expectedMiB, expertGpuRatio] of [[0, 3136, 0.5], [1, 3136, 0.5], [2, 3136, 0.5], [3, 2624, 0.25], [4, 1088, 0]]) {
  test(`ncmoe=${moeCpuLayers} 只减前 N 层与最后两个 GPU 重复层的 expert 交集`, () => {
    const result = predict(moe, { gpuLayers: 3, moeCpuLayers });
    near(result.rawWeightsGpuGb, expectedMiB / 1024);
    near(result.offloadRatio, 0.5);
    near(result.expertGpuRatio, expertGpuRatio);
  });
}
test('ncmoe 全部在 CPU 时，布局中未计入 expert_bytes 的 shared/dense 权重仍在 GPU', () => {
  const result = predict(moe, { gpuLayers: 5, moeCpuLayers: 4 });
  // 各层剩余 128/256/512/512 MiB，加输出 64 MiB；不按 expertCount 猜 shared 比例。
  near(result.rawWeightsGpuGb, (128 + 256 + 512 + 512 + 64) / 1024);
  near(predict({ ...moe, expertCount: 256 }, { gpuLayers: 5, moeCpuLayers: 4 }).rawWeightsGpuGb, result.rawWeightsGpuGb);
  near(predict(moe, { gpuLayers: 5, moeCpuLayers: 999 }).rawWeightsGpuGb, result.rawWeightsGpuGb);
  near(predict(moe, { gpuLayers: 2, moeCpuLayers: 4 }, LEGACY_KERNEL).rawWeightsGpuGb, (512 + 512) / 1024);
  near(predict(model, { moeCpuLayers: 4 }).rawWeightsGpuGb, 1792 / 1024, 'dense 模型不应用 ncmoe');
});

test('q5_0 与 q4_1 包含各自 block 元数据开销，K/V 类型分别启用', () => {
  near(cacheBytesPerValue('q5_0'), 22 / 32);
  near(cacheBytesPerValue('Q4_1'), 20 / 32);
  const headsTokens = 16 * 4096;
  const cases = [
    [{}, (128 * 2 + 64 * 2) * headsTokens],
    [{ cacheTypeKEnabled: true }, (128 * 22 / 32 + 64 * 2) * headsTokens],
    [{ cacheTypeVEnabled: true }, (128 * 2 + 64 * 20 / 32) * headsTokens],
    [{ cacheTypeKEnabled: true, cacheTypeVEnabled: true }, (128 * 22 / 32 + 64 * 20 / 32) * headsTokens],
  ];
  for (const [changes, expectedBytes] of cases) near(predict(model, changes).rawKvGb, expectedBytes / GiB, JSON.stringify(changes));
});
test('量化 K/V 行各自按 32 值补齐，非量化的另一列不跟随补齐', () => {
  const narrow = makeModel({ keyLength: 33, valueLength: 17 });
  near(predict(narrow, { cacheTypeKEnabled: true }).rawKvGb, 16 * 4096 * (64 * 22 / 32 + 17 * 2) / GiB);
  near(predict(narrow, { cacheTypeVEnabled: true }).rawKvGb, 16 * 4096 * (33 * 2 + 32 * 20 / 32) / GiB);
});
test('ctx 是总服务容量，unified 的 KV 不重复乘 parallel', () => {
  const one = predict(model, { ctxLength: 8192, parallel: 1 });
  const three = predict(model, { ctxLength: 8192, parallel: 3 });
  near(one.rawKvGb, 16 * 8192 * (128 + 64) * 2 / GiB);
  near(three.rawKvGb, one.rawKvGb);
});
test('non-unified ctx8192 P3 每槽补齐到 2816，KV 总容量为 8448', () => {
  const result = predict(model, { ctxLength: 8192, parallel: 3, kvUnified: false });
  near(result.rawKvGb, 16 * 8448 * (128 + 64) * 2 / GiB);
  assert.ok(result.rawKvGb > predict(model, { ctxLength: 8192, parallel: 3, kvUnified: true }).rawKvGb);
});
const swaModel = makeModel({
  id: 'synthetic:swa', architecture: 'gemma3', slidingWindow: 1024,
  swaLayerPattern: [false, true, false, true], keyLengthSwa: 64, valueLengthSwa: 32,
});
for (const [kvUnified, fullTokens, swaTokens] of [[true, 8192, 3328], [false, 8448, 3840]]) {
  test(`SWA ${kvUnified ? 'unified' : 'non-unified'} P3 分别按 full 与滑动窗口容量分配`, () => {
    // unified: pad256(min(8192, 1024*3+128))=3328。
    // non-unified: 3*pad256(min(2816, 1024+128))=3840。
    const result = predict(swaModel, { ctxLength: 8192, parallel: 3, kvUnified });
    const expectedBytes = 8 * fullTokens * (128 + 64) * 2 + 8 * swaTokens * (64 + 32) * 2;
    near(result.rawKvGb, expectedBytes / GiB);
    near(predict(swaModel, { ctxLength: 8192, parallel: 3, kvUnified, gpuLayers: 3 }).rawKvGb, expectedBytes / 2 / GiB, '只计算最后一层 full 和一层 SWA');
    assert.equal(result.missing.includes('sliding_window_pattern'), false);
    assert.equal(result.missing.includes('swa_capacity'), false);
    const aggregate = { ...swaModel, swaLayerPattern: undefined, kvHeadsSumFull: 8, kvHeadsSumSwa: 8 };
    near(predict(aggregate, { ctxLength: 8192, parallel: 3, kvUnified }).rawKvGb, expectedBytes / GiB, '旧聚合 full/SWA 头计数保留不同维度和容量');
  });
}
for (const [kvUnified, capacity] of [[true, 8192], [false, 8448]]) {
  test(`SWA ${kvUnified ? 'unified' : 'non-unified'} 窗口很大时不超过相应上下文容量`, () => {
    const largeWindow = { ...swaModel, slidingWindow: 16384 };
    const result = predict(largeWindow, { ctxLength: 8192, parallel: 3, kvUnified });
    near(result.rawKvGb, 8 * capacity * ((128 + 64) * 2 + (64 + 32) * 2) / GiB);
  });
}
for (const [kvUnified, fullTokens, expectedSwaTokens] of [[true, 8192, 3072], [false, 8448, 3840]]) {
  test(`SWA ${kvUnified ? 'unified' : 'non-unified'} 有效 U 受 batch 限制而非请求的 physicalBatch`, () => {
    const window1000 = { ...swaModel, slidingWindow: 1000 };
    const result = predict(window1000, { ctxLength: 8192, parallel: 3, kvUnified, batchSize: 64, physicalBatchSize: 512 });
    const expectedBytes = 8 * fullTokens * (128 + 64) * 2 + 8 * expectedSwaTokens * (64 + 32) * 2;
    near(result.rawKvGb, expectedBytes / GiB);
    near(predict(window1000, { ctxLength: 8192, parallel: 3, kvUnified, batchSize: 64, physicalBatchSize: 64 }).rawKvGb, result.rawKvGb);
  });
}
test('有效 U 同时受 ctx 限制，短上下文下 KV 与 compute 均使用有效值', () => {
  const wide = { ...swaModel, embeddingLength: 65536 };
  for (const kvUnified of [true, false]) {
    const requested = predict(wide, { ctxLength: 129, parallel: 3, kvUnified, batchSize: 512, physicalBatchSize: 512 });
    const effective = predict(wide, { ctxLength: 129, parallel: 3, kvUnified, batchSize: 129, physicalBatchSize: 129 });
    const capacity = kvUnified ? 256 : 768;
    near(requested.rawKvGb, 8 * capacity * ((128 + 64) * 2 + (64 + 32) * 2) / GiB);
    near(requested.rawComputeGb, effective.rawComputeGb, 'U=min(ctx,batch,physicalBatch)');
  }
});

test('CPU-only 与 kvOffload=false 不计 GPU KV，CPU-only 总量为真实零', () => {
  for (const kvCache of [true, false]) {
    const result = predict(model, { gpuLayers: 0, kvCache, parallel: 3 });
    for (const key of ['rawWeightsGpuGb', 'weightsGpuGb', 'rawKvGb', 'kvGb', 'rawComputeGb', 'computeGb', 'rawRuntimeGb', 'runtimeGb', 'safetyGb', 'totalGb']) {
      near(result[key], 0, key);
    }
    near(result.weightsCpuGb, 2);
  }
  const noGpuKv = predict(model, { kvCache: false });
  near(noGpuKv.rawKvGb, 0);
  near(noGpuKv.kvGb, 0);
  near(noGpuKv.rawWeightsGpuGb, 1792 / 1024);
});

const hybrid = makeModel({
  id: 'synthetic:hybrid', architecture: 'qwen35', kvHeadsByLayer: [0, 4, 0, 2], fullAttentionInterval: 2,
  ggufMetadata: [
    { key: 'qwen35.ssm.state_size', value: '8' }, { key: 'qwen35.ssm.inner_size', value: '64' },
    { key: 'qwen35.ssm.conv_kernel', value: '4' }, { key: 'qwen35.ssm.group_count', value: '2' },
  ],
});
// 两个状态数组：state_size * inner_size，以及 (conv_kernel-1) * (inner_size+2*groups*state_size)。
const recurrentBytesPerLayerPerStream = 4 * (8 * 64 + 3 * (64 + 2 * 2 * 8));
for (const [gpuLayers, fullHeads, recurrentLayers] of [[1, 0, 0], [2, 2, 0], [3, 2, 1], [4, 6, 1], [5, 6, 2]]) {
  test(`混合头向量 ngl=${gpuLayers} 只给 full 层分配 KV，recurrent 状态归 KV`, () => {
    const result = predict(hybrid, { gpuLayers, parallel: 3 });
    const fullKvBytes = fullHeads * 4096 * (128 + 64) * 2;
    const recurrentBytes = recurrentLayers * 3 * recurrentBytesPerLayerPerStream;
    near(result.rawKvGb, (fullKvBytes + recurrentBytes) / GiB);
    near(result.kvGb, result.rawKvGb);
    const withoutState = predict({ ...hybrid, ggufMetadata: [] }, { gpuLayers, parallel: 3 });
    near(withoutState.rawKvGb, fullKvBytes / GiB);
    near(result.rawRuntimeGb, withoutState.rawRuntimeGb, 'recurrent 不计入 runtime');
    near(result.rawComputeGb, withoutState.rawComputeGb, 'recurrent 不计入 compute');
    assert.equal(result.missing.includes('recurrent_state'), false);
    assert.equal(result.missing.includes('hybrid_layer_layout'), false);
  });
}
test('recurrent 按 parallel 保存状态，关闭 KV offload 后状态不留 GPU', () => {
  const one = predict(hybrid, { parallel: 1 });
  const three = predict(hybrid, { parallel: 3 });
  near(three.rawKvGb - one.rawKvGb, 2 * (3 - 1) * recurrentBytesPerLayerPerStream / GiB);
  near(predict(hybrid, { kvCache: false, parallel: 3 }).rawKvGb, 0);
  near(predict(hybrid, { gpuLayers: 0, parallel: 3 }).rawKvGb, 0);
});
test('实测日志 recurrent 与普通 KV 合并到同一分项', () => {
  const buffers = parseVramBuffers([
    'llama_kv_cache: CUDA0 KV buffer size = 9 MiB',
    'llama_memory_recurrent: CUDA0 recurrent buffer size = 0.5 MiB',
    'llama_context: CUDA0 compute buffer size = 128 MiB',
  ]);
  near(buffers.kv_gb, 9.5 / 1024);
  near(buffers.compute_gb, 128 / 1024);
});

const invalidLayouts = [
  ['版本不支持', (value) => { value.version = 2; }],
  ['重复层数量不符', (value) => { value.layers.pop(); }],
  ['总量为零', (value) => { value.total_bytes = 0; }],
  ['总量非有限', (value) => { value.total_bytes = Infinity; }],
  ['input 为负', (value) => { value.input_bytes = -1; }],
  ['output 为负', (value) => { value.output_bytes = -1; }],
  ['other 非有限', (value) => { value.other_bytes = NaN; }],
  ['层权重为负', (value) => { value.layers[0].weight_bytes = -1; }],
  ['层权重非有限', (value) => { value.layers[0].weight_bytes = NaN; }],
  ['expert 为负', (value) => { value.layers[0].expert_bytes = -1; }],
  ['expert 非有限', (value) => { value.layers[0].expert_bytes = Infinity; }],
  ['expert 超过该层权重', (value) => { value.layers[0].expert_bytes = value.layers[0].weight_bytes + 1; }],
  ['分项与总量不一致', (value) => { value.total_bytes += 2; }],
  ['张量总量超过文件容差', (value) => {
    for (const layer of value.layers) { layer.weight_bytes *= 2; layer.expert_bytes *= 2; }
    value.input_bytes *= 2; value.output_bytes *= 2; value.total_bytes *= 2;
  }],
];
for (const [name, corrupt] of invalidLayouts) {
  test(`invalid layout：${name} 时回退文件估计并标注缺失`, () => {
    const invalid = structuredClone(model.memoryLayout);
    corrupt(invalid);
    const result = predict({ ...model, memoryLayout: invalid }, { gpuLayers: 3 });
    const fallback = predict({ ...model, memoryLayout: undefined }, { gpuLayers: 3 });
    assert.equal(result.weightSource, 'file');
    assert.ok(result.missing.includes('tensor_memory_layout'));
    near(result.rawWeightsGpuGb, fallback.rawWeightsGpuGb);
    assert.ok(Number.isFinite(result.totalGb));
  });
}
test('upper_bound 布局保留逐层数值，但来源和缺失标记明确区别于 exact', () => {
  const upper = { ...model, memoryLayout: { ...model.memoryLayout, accuracy: 'upper_bound' } };
  const result = predict(upper, { gpuLayers: 3 });
  near(result.rawWeightsGpuGb, 1408 / 1024);
  assert.equal(result.weightSource, 'tensor_upper_bound');
  assert.ok(result.missing.includes('tensor_upper_bound'));
  assert.equal(result.missing.includes('tensor_memory_layout'), false);
});
test('unknown KV 仍保留其他分项，总量不制造 NaN 或把未知 KV 写成已知零', () => {
  const unknown = { ...model, headCount: undefined, headCountKv: undefined, kvHeadsByLayer: undefined };
  const result = predict(unknown);
  assert.equal(result.rawKvGb, null);
  assert.equal(result.kvGb, null);
  assert.ok(result.missing.includes('head_count_kv'));
  near(result.totalGb, result.weightsGpuGb + result.computeGb + result.runtimeGb + result.safetyGb);
});
test('总量等于权重、KV、compute、runtime 与余量；analytical/empirical 使用原始分项', () => {
  const calibration = { weightsRatio: 1.05, kvRatio: 0.75, computeRatio: 1.5, runtimeOffsetGb: 0.2, uncertaintyGb: 0.7 };
  const cases = [predict(model), predict(moe, { gpuLayers: 3, moeCpuLayers: 3 }), predict(hybrid, { parallel: 3 }), predict(model, {}, MODERN_KERNEL, calibration)];
  for (const result of cases) {
    const subtotal = result.weightsGpuGb + result.kvGb + result.computeGb + result.runtimeGb;
    near(result.totalGb, subtotal + result.safetyGb);
    near(result.analyticalGb, result.rawWeightsGpuGb + result.rawKvGb);
    near(result.empiricalGb, result.rawComputeGb + result.rawRuntimeGb);
    assert.ok(result.safetyGb >= 0.15);
    assert.ok(result.safetyGb >= subtotal * 0.06);
  }
  const calibrated = cases.at(-1);
  near(calibrated.weightsGpuGb, 1.75 * 1.05);
  near(calibrated.kvGb, 0.0234375 * 0.75);
  near(calibrated.computeGb, calibrated.rawComputeGb * 1.5);
  near(calibrated.runtimeGb, calibrated.rawRuntimeGb + 0.2);
  near(calibrated.safetyGb, 0.7, '实测不确定性提高余量');
});

// 校准固件的日志分项是固定观测值；不通过待测预测器生成权重或 KV 的期望。
function launchRecord(timestamp = 1, options = {}) {
  const target = options.model ?? model;
  const measuredConfig = options.config ?? target.loadConfig;
  const weights = options.weightsGb ?? 1.75;
  const kv = options.kvGb ?? 0.0234375;
  const compute = options.computeGb ?? 0.2;
  const runtime = options.runtimeGb ?? 0.5;
  const actualGb = weights + kv + compute + runtime;
  const environment = options.hardware ?? hardware;
  return {
    model_id: target.id, model_name: target.name, kind: 'launch', timestamp,
    ngl: measuredConfig.gpuLayers, ctx: measuredConfig.ctxLength, ncmoe: measuredConfig.moeCpuLayers,
    flash_attn: measuredConfig.fastAttention, speculative: measuredConfig.speculativeDecoding,
    vram_gb: actualGb, vram_predicted_gb: 99,
    vram_measurement: {
      version: 1, model_signature: modelVramSignature(target),
      gpu_name: environment.gpuName, gpu_total_gb: environment.vramTotal, kernel_version: environment.kernelVersion,
      config: vramMeasurementConfig(measuredConfig),
      baseline_gb: 2, loaded_gb: 2 + actualGb, baseline_spread_gb: 0.02, loaded_spread_gb: 0.03,
      quality: 'stable',
      buffers: {
        weights_gb: weights, kv_gb: kv, compute_gb: compute,
        context: measuredConfig.ctxLength,
        gpu_layers: measuredConfig.gpuLayers < 0 ? 5 : Math.min(measuredConfig.gpuLayers, 5), backend: 'CUDA',
        parallel: options.effectiveParallel ?? (measuredConfig.parallel > 0 ? measuredConfig.parallel : null),
      },
    },
  };
}
const stablePair = () => [launchRecord(1), launchRecord(2)];
const calibrate = (records, currentConfig = config, environment = hardware, target = model) => computeVramCalibration(target, records, currentConfig, environment);
function assessRecord(record, measuredConfig = config, target = model) {
  const measurement = record.vram_measurement;
  const summary = (used, spread) => ({ gpu_name: measurement.gpu_name, gpu_total_gb: measurement.gpu_total_gb, used_gb: used, spread_gb: spread });
  return assessVramMeasurement({
    model: target, config: measuredConfig,
    baseline: summary(measurement.baseline_gb, measurement.baseline_spread_gb),
    loaded: summary(measurement.loaded_gb, measurement.loaded_spread_gb), buffers: measurement.buffers,
  });
}

test('校准至少需要两条同参数、同 model/GPU/kernel 的 stable 完整记录', () => {
  assertUnmatched(calibrate([]));
  assertUnmatched(calibrate([launchRecord()]));
  const records = stablePair();
  const saved = structuredClone(records);
  for (const record of records) {
    const assessment = assessRecord(record);
    assert.equal(assessment.quality, 'stable', '合成记录自身必须通过实测核实');
    near(assessment.actualGb, record.vram_gb);
  }
  const value = calibrate(records);
  assert.equal(value.matched, true);
  assert.equal(value.samples, 2);
  assert.equal(value.confidence, 'limited');
  assert.equal(value.rejected, 0);
  assert.equal(value.legacy, 0);
  near(value.weightsRatio, 1);
  near(value.kvRatio, 1);
  const raw = predict(model);
  near(value.computeRatio, 0.2 / raw.rawComputeGb);
  near(value.runtimeOffsetGb, 0.5 - raw.rawRuntimeGb);
  near(value.uncertaintyGb, 0);
  const calibrated = predict(model, {}, MODERN_KERNEL, value);
  near(calibrated.weightsGpuGb, 1.75);
  near(calibrated.kvGb, 0.0234375);
  near(calibrated.computeGb, 0.2);
  near(calibrated.runtimeGb, 0.5);
  assert.deepEqual(records, saved, '读取校准记录不能修改输入');
});
test('三条同环境有效记录提升为 measured', () => {
  const value = calibrate([launchRecord(1), launchRecord(2), launchRecord(3)]);
  assert.equal(value.samples, 3);
  assert.equal(value.matched, true);
  assert.equal(value.confidence, 'measured');
});
test('旧记录缺 measurement 即使总量很低也不污染新校准', () => {
  const legacy = [1, 2].map((timestamp) => ({ model_id: model.id, model_name: model.name, kind: 'launch', timestamp, vram_gb: 0.01 }));
  const onlyLegacy = calibrate(legacy);
  assertUnmatched(onlyLegacy);
  assert.equal(onlyLegacy.legacy, 2);
  const value = calibrate([...legacy, ...stablePair()]);
  const clean = calibrate(stablePair());
  assert.equal(value.samples, 2);
  assert.equal(value.legacy, 2);
  for (const key of ['weightsRatio', 'kvRatio', 'computeRatio', 'runtimeOffsetGb', 'uncertaintyGb']) near(value[key], clean[key], key);
});
for (const quality of ['adapted', 'contaminated', 'unverified']) {
  test(`quality=${quality} 记录拒绝进入校准`, () => {
    const invalid = stablePair();
    for (const record of invalid) record.vram_measurement.quality = quality;
    const result = calibrate([...stablePair(), ...invalid]);
    assert.equal(result.samples, 2);
    assert.equal(result.rejected, 2);
    near(result.weightsRatio, 1);
    assertUnmatched(calibrate(invalid));
  });
}
for (const field of ['baseline_gb', 'loaded_gb', 'baseline_spread_gb', 'loaded_spread_gb']) {
  test(`stable 标签不能替代 ${field} 的实际采样`, () => {
    const invalid = stablePair();
    for (const record of invalid) record.vram_measurement[field] = null;
    const result = calibrate(invalid);
    assertUnmatched(result);
    assert.equal(result.rejected, 2);
  });
}
for (const [field, badValue] of [['baseline_spread_gb', 0.5], ['loaded_spread_gb', 0.5], ['loaded_gb', Infinity], ['baseline_gb', -1]]) {
  test(`校准重新核实采样：${field}=${badValue} 拒绝伪 stable`, () => {
    const invalid = stablePair();
    for (const record of invalid) record.vram_measurement[field] = badValue;
    assertUnmatched(calibrate(invalid));
  });
}
for (const field of ['weights_gb', 'context', 'gpu_layers', 'backend']) {
  test(`日志缺少明确 ${field} 缓冲证据不能进入校准`, () => {
    const invalid = stablePair();
    for (const record of invalid) record.vram_measurement.buffers[field] = null;
    const value = calibrate(invalid);
    assertUnmatched(value);
    assert.equal(value.rejected, 2);
  });
}
test('实际 ctx/ngl 已 adapted 或实测增量与 record 总量不符时，stable 标签无效', () => {
  for (const change of [
    (record) => { record.vram_measurement.buffers.context = 2048; },
    (record) => { record.vram_measurement.buffers.gpu_layers = 4; },
    (record) => { record.vram_gb += 0.2; },
    (record) => { record.vram_measurement.loaded_gb = 2.1; },
  ]) {
    const invalid = stablePair();
    invalid.forEach(change);
    assertUnmatched(calibrate(invalid));
  }
});

const configChanges = [
  ['ctx', { ctxLength: 8192 }], ['ngl', { gpuLayers: 4 }],
  ['batch', { batchSize: 1024 }], ['ubatch', { physicalBatchSize: 64 }],
  ['parallel', { parallel: 3 }], ['KV unified', { kvUnified: false }],
  ['KV offload', { kvCache: false }], ['Flash Attention', { fastAttention: false }],
  ['ncmoe', { moeCpuLayers: 1 }], ['K 独立类型', { cacheTypeKEnabled: true, cacheTypeK: 'q5_0' }],
  ['V 独立类型', { cacheTypeVEnabled: true, cacheTypeV: 'q4_1' }],
  ['no_warmup', { noWarmup: true }], ['draft 模式', { speculativeDecoding: 'mtp' }],
];
for (const [name, changes] of configChanges) {
  test(`${name} 变化隔离校准，旧参数记录不能影响当前系数`, () => {
    const currentConfig = { ...config, ...changes };
    const changed = [launchRecord(3, { config: currentConfig }), launchRecord(4, { config: currentConfig })];
    const value = calibrate([...stablePair(), ...changed]);
    assert.equal(value.samples, 2);
    assert.equal(value.rejected, 2);
    near(value.weightsRatio, 1);
    assertUnmatched(calibrate(stablePair(), currentConfig));
  });
}
test('关闭的 K/V 类型不改变实际 f16 配置，启用 K 不影响 V 的使能', () => {
  const disabled = { ...config, cacheTypeK: 'q8_0', cacheTypeV: 'q4_0' };
  const result = calibrate(stablePair(), disabled);
  assert.equal(result.samples, 2);
  near(result.kvRatio, 1);
  const kOnly = vramMeasurementConfig({ ...config, cacheTypeKEnabled: true });
  assert.equal(kOnly.cache_type_k, 'q5_0');
  assert.equal(kOnly.cache_type_v, 'f16');
});
test('活动 draft 深度变化隔离；关闭 draft 时无效深度不制造隔离', () => {
  const active = { ...config, speculativeDecoding: 'mtp', specDraftNMaxEnabled: true, specDraftNMax: 8 };
  const activeRecords = [launchRecord(1, { config: active }), launchRecord(2, { config: active })];
  const control = calibrate(activeRecords, active);
  assert.equal(control.matched, true);
  assert.equal(control.samples, 2);
  assert.equal(control.weightsRatio, undefined, 'draft 分配不得改写主模型权重比例');
  assert.equal(control.kvRatio, undefined);
  assertUnmatched(calibrate(activeRecords, { ...active, specDraftNMax: 12 }));
  assertUnmatched(calibrate(activeRecords, { ...active, specDraftNMaxEnabled: false }));
  const off = calibrate(stablePair(), { ...config, specDraftNMaxEnabled: true, specDraftNMax: 12 });
  assert.equal(off.samples, 2);
  near(off.weightsRatio, 1);
});
for (const [name, changes] of [
  ['张量 signature', { memoryLayout: { ...model.memoryLayout, signature: 'synthetic-layout-other-v1' } }],
  ['逐层 KV 头向量', { kvHeadsByLayer: [0, 4, 4, 4] }],
  ['K 维度', { keyLength: 256 }], ['V 维度', { valueLength: 128 }],
  ['recurrent 元数据', { ggufMetadata: [{ key: 'llama.ssm.state_size', value: '128' }] }],
  ['MTP 侧车', { mtpDraftPath: '/synthetic/fixtures/mtp.gguf' }],
  ['DSpark 侧车', { dsparkDraftPath: '/synthetic/fixtures/dspark.gguf' }],
  ['DFlash 侧车', { dflashDraftPath: '/synthetic/fixtures/dflash.gguf' }],
]) {
  test(`${name} 改变 model signature 后旧记录拒绝校准`, () => {
    const changed = makeModel(changes);
    assert.notEqual(modelVramSignature(changed), modelVramSignature(model));
    const value = calibrate(stablePair(), config, hardware, changed);
    assertUnmatched(value);
    assert.equal(value.rejected, 2);
  });
}
for (const [name, changes] of [
  ['GPU 名称', { gpuName: '合成 GPU B' }], ['GPU 容量', { vramTotal: 16 }],
  ['kernel', { kernelVersion: LEGACY_KERNEL }], ['未知 kernel', { kernelVersion: null }],
]) {
  test(`第 4 参数 hardware 的${name}变化隔离校准`, () => {
    const currentHardware = { ...hardware, ...changes };
    const value = calibrate(stablePair(), config, currentHardware);
    assertUnmatched(value);
    assert.equal(value.rejected, 2);
  });
}
test('自动并发按日志有效槽数预测，缺证据不校准且不混合不同槽数', () => {
  const automatic = { ...config, parallel: -1, kvUnified: false };
  const three = [1, 2].map((timestamp) => launchRecord(timestamp, { config: automatic, effectiveParallel: 3 }));
  for (const record of three) record.vram_measurement.buffers.context = 4608;
  const value = calibrate(three, automatic);
  assert.equal(value.samples, 2);
  assert.equal(value.effectiveParallel, 3);
  const actualParallel = predictVramUsage(model, automatic, value, { kernelVersion: MODERN_KERNEL, effectiveParallel: value.effectiveParallel });
  const explicitParallel = predictVramUsage(model, { ...automatic, parallel: 3 }, value, { kernelVersion: MODERN_KERNEL });
  near(actualParallel.totalGb, explicitParallel.totalGb);
  near(actualParallel.rawKvGb, 4 * 4 * 4608 * (128 + 64) * 2 / GiB);
  assert.equal(actualParallel.missing.includes('parallel_auto'), false);

  const missing = structuredClone(three);
  for (const record of missing) record.vram_measurement.buffers.parallel = null;
  assertUnmatched(calibrate(missing, automatic));

  const four = [3, 4].map((timestamp) => launchRecord(timestamp, { config: automatic, effectiveParallel: 4 }));
  const isolated = calibrate([...three, ...four], automatic);
  assert.equal(isolated.samples, 2);
  assert.equal(isolated.rejected, 2);
  assert.equal(isolated.effectiveParallel, 4);
  assertUnmatched(calibrate([three[0], four[0]], automatic));
});

test('无 hardware 时也不合并不同 GPU、容量、kernel 或 backend 的记录', () => {
  for (const changes of [
    { gpuName: '合成 GPU B' }, { vramTotal: 16 }, { kernelVersion: LEGACY_KERNEL }, { backend: 'Vulkan' },
  ]) {
    const alternateHardware = { ...hardware, ...changes };
    const alternate = [launchRecord(3, { hardware: alternateHardware, weightsGb: 1.925 }), launchRecord(4, { hardware: alternateHardware, weightsGb: 1.925 })];
    if (changes.backend) for (const record of alternate) record.vram_measurement.buffers.backend = changes.backend;
    const value = computeVramCalibration(model, [...stablePair(), ...alternate], config);
    assert.equal(value.samples, 2);
    assert.equal(value.rejected, 2);
    near(value.weightsRatio, 1.1, '只用最新同环境组，不平均两组 GPU 权重');
    const isolatedSingles = computeVramCalibration(model, [launchRecord(1), alternate[0]], config);
    assertUnmatched(isolatedSingles);
  }
});
test('另一 model、非 launch、无 kernel 和不支持的 measurement 版本拒绝准入', () => {
  for (const corrupt of [
    (record) => { record.model_id = 'synthetic:other-model'; },
    (record) => { record.kind = 'autotune'; },
    (record) => { record.vram_measurement.kernel_version = null; },
    (record) => { record.vram_measurement.model_signature = 'synthetic-invalid-signature'; },
    (record) => { record.vram_measurement.version = 2; },
  ]) {
    const invalid = stablePair();
    invalid.forEach(corrupt);
    const value = calibrate([...stablePair(), ...invalid]);
    assert.equal(value.samples, 2);
    assert.equal(value.rejected, 2);
    near(value.weightsRatio, 1);
  }
});
test('中位数/MAD 过滤分项低权重离群值，不能拉低正常权重比例', () => {
  // 总增量差小于 0.25 GiB，确保离群记录到达分项 MAD，而非被总误差预先排除。
  const ratios = [1.01, 1.02, 1.03, 0.91];
  const records = ratios.map((ratio, index) => launchRecord(index + 1, { weightsGb: 1.75 * ratio }));
  for (const record of records) assert.equal(assessRecord(record).quality, 'stable');
  const value = calibrate(records);
  assert.equal(value.matched, true);
  assert.equal(value.samples, 4);
  assert.equal(value.rejected, 0);
  near(value.weightsRatio, 1.02, '三个正常权重比例的中位数');
  near(predict(model, {}, MODERN_KERNEL, value).weightsGpuGb, 1.75 * 1.02);
});
test('总误差 MAD 拒绝合法 stable 但极端偏低的离群记录', () => {
  const low = launchRecord(4, { weightsGb: 0.2 });
  assert.equal(assessRecord(low).quality, 'stable', '测试总误差筛选，不能依赖 quality 提前拒绝');
  const value = calibrate([...stablePair(), launchRecord(3), low]);
  assert.equal(value.samples, 3);
  assert.equal(value.rejected, 1);
  near(value.weightsRatio, 1);
  near(predict(model, {}, MODERN_KERNEL, value).weightsGpuGb, 1.75);
});
test('exact 布局的显著低权重观测不能硬压成权重系数', () => {
  const records = [launchRecord(1, { weightsGb: 1.4 }), launchRecord(2, { weightsGb: 1.4 })];
  for (const record of records) assert.equal(assessRecord(record).quality, 'stable');
  const value = calibrate(records);
  assert.equal(value.matched, true, '其他可信分项仍可校准');
  assert.equal(value.weightsRatio, undefined);
  near(predict(model, {}, MODERN_KERNEL, value).weightsGpuGb, 1.75);
});
