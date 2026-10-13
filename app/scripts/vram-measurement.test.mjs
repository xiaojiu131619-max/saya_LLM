import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

// transpileModule 不解析别名；纯模块的运行时依赖递归替换成 data URL，无需构建或新增依赖。
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
const {
  modelVramSignature, vramMeasurementConfig, summarizeVramSamples, parseVramBuffers, assessVramMeasurement,
} = await import(pureModuleUrl(new URL('../src/lib/vramMeasurement.ts', import.meta.url)));

const config = {
  ctxLength: 4096, gpuLayers: 33, batchSize: 512, physicalBatchSize: 128,
  threads: -1, parallel: -1, fastAttention: true, kvCache: true, kvUnified: true,
  mmap: true, mlock: false, noWarmup: false,
  cacheTypeKEnabled: true, cacheTypeK: 'q8_0', cacheTypeVEnabled: false, cacheTypeV: 'q4_0',
  ropeFreqBaseEnabled: false, ropeFreqBase: 0, ropeFreqScaleEnabled: false, ropeFreqScale: 0,
  seedEnabled: false, seed: -1, speculativeDecoding: 'off', specDraftNMaxEnabled: false, specDraftNMax: 4,
  chatTemplate: '', rememberSettings: true, showAdvancedSettings: false,
  idleAutoUnload: false, idleAutoUnloadMinutes: 15, moeCpuLayers: 0, reasoningBudget: 0,
};
const model = {
  id: 'local:private', name: '模型', family: 'Qwen', params: '8B', quant: 'Q4_K_M',
  fileSize: '5 GB', fileSizeBytes: 5 * 1024 ** 3, modelType: 'dense', status: 'standby',
  themeColor: '#000', themeColorSolid: '#000', description: '', longDescription: '', tags: [],
  downloadCount: '', ctxLength: 32768, loadConfig: config, releaseDate: '', license: '',
  architecture: 'qwen3', blockCount: 32, embeddingLength: 4096, headCount: 32, headCountKv: 8,
  kvHeadsByLayer: Array(32).fill(8), keyLength: 128, valueLength: 128,
  filePath: 'D:\\用户\\私有模型.gguf', mmprojPath: 'D:\\用户\\私有侧车.gguf',
};
const snapshot = (used, overrides = {}) => ({ gpu_name: 'GPU A', gpu_total_gb: 24, used_gb: used, ...overrides });
const summary = (used, overrides = {}) => ({ ...snapshot(used), spread_gb: 0.02, ...overrides });
const emptyBuffers = { weights_gb: null, kv_gb: null, compute_gb: null, context: null, parallel: null, gpu_layers: null, backend: null };
const buffers = { weights_gb: 5, kv_gb: 0.5, compute_gb: 0.25, context: 4096, gpu_layers: 33, backend: 'CUDA', parallel: 4 };
const assess = (overrides = {}) => assessVramMeasurement({ model, config, baseline: summary(2), loaded: summary(8), buffers, ...overrides });

test('布局签名优先作锚点，联合指纹稳定且不含路径', () => {
  const withLayout = { ...model, memoryLayout: { signature: 'tensor-layout-v1' } };
  const layoutSignature = modelVramSignature(withLayout);
  assert.match(layoutSignature, /^layout-v1:[0-9a-f]{16}$/);
  assert.equal(layoutSignature, modelVramSignature({ ...withLayout, fileSizeBytes: model.fileSizeBytes + 1 }));
  assert.notEqual(layoutSignature, modelVramSignature({ ...withLayout, memoryLayout: { signature: 'tensor-layout-v2' } }));
  const signature = modelVramSignature(model);
  assert.match(signature, /^metadata-v1:[0-9a-f]{16}$/);
  assert.equal(signature, modelVramSignature(structuredClone(model)));
  assert.equal(signature, modelVramSignature({ ...model, filePath: '/other/model.gguf', id: 'other', name: '重命名', loadConfig: { ...config, ctxLength: 8192 } }));
  for (const value of [signature, layoutSignature]) {
    assert.equal(value.includes('用户'), false);
    assert.equal(value.includes('私有'), false);
    assert.equal(value.includes('D:'), false);
  }
});
test('布局已知时仍联合侧车路径、full/SWA/SSM 内存元数据', () => {
  const withLayout = { ...model, memoryLayout: { signature: 'tensor-layout-v1' } };
  const signature = modelVramSignature(withLayout);
  for (const override of [
    { mmprojPath: '/different/mmproj.gguf' }, { mtpDraftPath: '/draft.gguf' },
    { dsparkDraftPath: '/dspark.gguf' }, { dflashDraftPath: '/dflash.gguf' },
    { fullAttentionInterval: 4 }, { kvHeadsSumFull: 32 }, { kvHeadsSumSwa: 16 }, { keyLengthSwa: 256 },
    { ggufMetadata: [{ key: 'qwen3.ssm.state_size', value: '128' }] },
    { ggufMetadata: [{ key: 'qwen3.recurrent.state_size', value: '128' }] },
  ]) assert.notEqual(signature, modelVramSignature({ ...withLayout, ...override }));
  const metadata = [{ key: 'qwen3.ssm.state_size', value: '128' }, { key: 'qwen3.attention.sliding_window', value: '1024' }];
  assert.equal(modelVramSignature({ ...withLayout, ggufMetadata: metadata }), modelVramSignature({ ...withLayout, ggufMetadata: [...metadata].reverse() }));
  assert.notEqual(modelVramSignature({ ...withLayout, ggufMetadata: metadata }), modelVramSignature({ ...withLayout, ggufMetadata: [{ ...metadata[0], value: '256' }, metadata[1]] }));
});
test('结构元数据、KV 向量、头维度和侧车存在性改变指纹', () => {
  const signature = modelVramSignature(model);
  for (const override of [
    { architecture: 'qwen35moe' }, { fileSizeBytes: model.fileSizeBytes + 1 }, { blockCount: 31 },
    { kvHeadsByLayer: [0, ...Array(31).fill(8)] }, { keyLength: 256 }, { valueLength: 256 },
    { mmprojPath: undefined }, { mtpDraftPath: '/draft.gguf' }, { dsparkDraftPath: '/dspark.gguf' },
    { dflashDraftPath: '/dflash.gguf' }, { swaLayerPattern: Array(32).fill(true) },
  ]) assert.notEqual(signature, modelVramSignature({ ...model, ...override }));
});
test('精确记录加载配置，独立应用 K/V 使能', () => {
  assert.deepEqual(vramMeasurementConfig(config), {
    gpu_layers: 33, ctx_length: 4096, batch_size: 512, ubatch_size: 128, parallel: -1,
    flash_attn: true, kv_offload: true, kv_unified: true, cache_type_k: 'q8_0', cache_type_v: 'f16',
    moe_cpu_layers: 0, speculative: 'off', no_warmup: false, draft_tokens: null,
  });
  const exact = vramMeasurementConfig({ ...config, gpuLayers: -1, ctxLength: 8193, batchSize: 17,
    physicalBatchSize: 129, parallel: 3, fastAttention: false, kvCache: false, kvUnified: false,
    cacheTypeKEnabled: false, cacheTypeVEnabled: true, moeCpuLayers: 28, speculativeDecoding: 'dflash' });
  assert.deepEqual(exact, {
    gpu_layers: -1, ctx_length: 8193, batch_size: 17, ubatch_size: 129, parallel: 3,
    flash_attn: false, kv_offload: false, kv_unified: false, cache_type_k: 'f16', cache_type_v: 'q4_0',
    moe_cpu_layers: 28, speculative: 'dflash', no_warmup: false, draft_tokens: null,
  });
});
test('预热与草稿深度记录实际有效值，关闭推测解码时深度未知', () => {
  assert.equal(vramMeasurementConfig({ ...config, noWarmup: true }).no_warmup, true);
  for (const [requested, effective] of [[8, 8], [99, 16], [-1, 1], [0, 1], [2.6, 3]]) {
    assert.equal(vramMeasurementConfig({ ...config, speculativeDecoding: 'mtp', specDraftNMaxEnabled: true, specDraftNMax: requested }).draft_tokens, effective);
  }
  assert.equal(vramMeasurementConfig({ ...config, speculativeDecoding: 'off', specDraftNMaxEnabled: true, specDraftNMax: 8 }).draft_tokens, null);
  assert.equal(vramMeasurementConfig({ ...config, speculativeDecoding: 'mtp', specDraftNMaxEnabled: false, specDraftNMax: 8 }).draft_tokens, null);
});
test('采样至少三次，取中位数及全窗口跨度，不修改输入', () => {
  const samples = [snapshot(2), snapshot(1), snapshot(9), snapshot(3)];
  const saved = structuredClone(samples);
  assert.deepEqual(summarizeVramSamples(samples), { ...snapshot(2.5), spread_gb: 8 });
  assert.deepEqual(samples, saved);
  assert.equal(summarizeVramSamples([]), null);
  assert.equal(summarizeVramSamples(samples.slice(0, 2)), null);
});
test('缺失与非有限数据不补零，真实零保留', () => {
  const invalid = [snapshot(null), snapshot(NaN), snapshot(Infinity), snapshot(-1),
    snapshot(1, { gpu_total_gb: 0 }), snapshot(1, { gpu_name: '' }), {}, null];
  assert.equal(summarizeVramSamples([snapshot(0), snapshot(0), ...invalid]), null);
  assert.deepEqual(summarizeVramSamples([snapshot(0), snapshot(0), snapshot(0), ...invalid]), { ...snapshot(0), spread_gb: 0 });
});
test('混卡或容量变化不合并采样', () => {
  assert.equal(summarizeVramSamples([snapshot(1), snapshot(1), snapshot(1), snapshot(1, { gpu_name: 'GPU B' })]), null);
  assert.equal(summarizeVramSamples([snapshot(1), snapshot(1), snapshot(1, { gpu_total_gb: 16 })]), null);
});
test('解析带 ANSI 与时间前缀的原始 MiB 分项、ctx 和卸载层数', () => {
  assert.deepEqual(parseVramBuffers([
    '\x1b[32m[2026-10-13 12:00:00] load_tensors: offloaded 33/33 layers to GPU\x1b[0m',
    '00:00:01 load_tensors: CUDA0 model buffer size = 5120.00 MiB',
    '00:00:01 load_tensors: CPU_Mapped model buffer size = 1000.00 MiB',
    'llama_context: n_seq_max = 4\nllama_context: n_ctx = 4096\nllama_context: n_ctx_per_seq = 1024',
    '[01:02:03] llama_kv_cache: CUDA0 KV buffer size = 512 MiB',
    'llama_context: CUDA0 compute buffer size = 256.00 MiB',
  ]), buffers);
});
test('四种 GPU 后端统一 GB 单位，大小零为真实零', () => {
  for (const [device, backend] of [['CUDA0', 'CUDA'], ['Vulkan0', 'Vulkan'], ['ROCm0', 'ROCm'], ['Hip0', 'HIP']]) {
    assert.deepEqual(parseVramBuffers([
      `load_tensors: ${device} model buffer size = 1024 MiB`,
      `llama_kv_cache: ${device} KV buffer size = 0 MiB`,
      `llama_context: ${device} compute buffer size = 1.024e2 MiB`,
    ]), { ...emptyBuffers, weights_gb: 1, kv_gb: 0, compute_gb: 0.1, backend });
  }
});
test('CPU、CPU_Mapped、CPU_Host、CUDA_Host 不计入 GPU 分配', () => {
  for (const device of ['CPU', 'CPU0', 'CPU_Mapped', 'CPU_Host', 'CUDA_Host']) {
    const parsed = parseVramBuffers([
      `load_tensors: ${device} model buffer size = 10240 MiB`,
      `llama_kv_cache: ${device} KV buffer size = 1024 MiB`,
      `llama_context: ${device} compute buffer size = 2048 MiB`,
    ]);
    assert.equal(parsed.weights_gb, null);
    assert.equal(parsed.kv_gb, 0);
    assert.equal(parsed.compute_gb, null);
    assert.equal(parsed.backend, null);
  }
  assert.deepEqual(parseVramBuffers([
    'load_tensors: CUDA0 model buffer size = 5120 MiB', 'load_tensors: CUDA_Host model buffer size = 9000 MiB',
    'llama_kv_cache: CUDA0 KV buffer size = 512 MiB', 'llama_kv_cache: CPU0 KV buffer size = 1024 MiB',
    'llama_context: CUDA0 compute buffer size = 256 MiB', 'llama_context: CPU_Host compute buffer size = 3000 MiB',
  ]), { ...buffers, context: null, gpu_layers: null, parallel: null });
});
test('recurrent 归 KV，相同日志重复不会累加', () => {
  const lines = [
    'llama_kv_cache: CUDA0 KV buffer size = 512 MiB',
    'llama_memory_recurrent: CUDA0 recurrent buffer size = 256 MiB',
    'llama_context: CUDA0 compute buffer size = 128 MiB',
  ];
  assert.deepEqual(parseVramBuffers([...lines, ...lines]), { ...emptyBuffers, kv_gb: 0.75, compute_gb: 0.125, backend: 'CUDA' });
  assert.equal(parseVramBuffers([lines[1]]).kv_gb, 0.25);
  assert.equal(parseVramBuffers(['llama_memory_recurrent: CPU0 recurrent buffer size = 256 MiB']).kv_gb, 0);
});
test('fit 重试只保留最后缓冲集，包括最终未报告的分项', () => {
  const attempt = [
    'load_tensors: offloaded 33/33 layers to GPU', 'load_tensors: CUDA0 model buffer size = 5120 MiB',
    'llama_context: n_ctx = 8192', 'llama_kv_cache: CUDA0 KV buffer size = 1024 MiB',
    'llama_context: CUDA0 compute buffer size = 512 MiB',
  ];
  assert.deepEqual(parseVramBuffers([
    ...attempt, 'llama_params_fit: retrying with smaller context', ...attempt,
    'llama_params_fit_impl: trying n_gpu_layers = 20',
    'load_tensors: offloaded 20/33 layers to GPU', 'load_tensors: CUDA0 model buffer size = 3072 MiB',
    'llama_context: n_ctx = 4096', 'llama_kv_cache: CUDA0 KV buffer size = 512 MiB',
    'llama_context: CUDA0 compute buffer size = 256 MiB',
  ]), { ...buffers, weights_gb: 3, gpu_layers: 20, parallel: null });
  assert.deepEqual(parseVramBuffers([...attempt, 'srv load_model: retrying', 'load_tensors: CUDA0 model buffer size = 2048 MiB']),
    { ...emptyBuffers, weights_gb: 2, backend: 'CUDA' });
});
test('CPU fallback 明确零卸载后没有 GPU 权重，允许真实零', () => {
  assert.deepEqual(parseVramBuffers([
    'load_tensors: CUDA0 model buffer size = 5120 MiB', 'srv load_model: CPU fallback',
    'load_tensors: offloaded 0/33 layers to GPU', 'load_tensors: CPU_Mapped model buffer size = 5120 MiB',
    'llama_context: n_ctx = 4096', 'llama_kv_cache: CPU0 KV buffer size = 512 MiB',
    'llama_context: CPU compute buffer size = 256 MiB',
  ]), { ...emptyBuffers, weights_gb: 0, kv_gb: 0, compute_gb: 0, context: 4096, gpu_layers: 0 });
});
test('空日志、不完整日志和总 GPU 摘要不制造完整分项', () => {
  assert.deepEqual(parseVramBuffers([]), emptyBuffers);
  assert.deepEqual(parseVramBuffers(['llama_memory_breakdown: CUDA0 total = 4096 MiB, model = 2048 MiB, context = 2048 MiB']), emptyBuffers);
  assert.deepEqual(parseVramBuffers(['llama_context: n_ctx = 4096', 'llama_context: CUDA0 compute buffer size = 256 MiB']),
    { ...emptyBuffers, context: 4096, compute_gb: 0.25, backend: 'CUDA' });
  for (const size of ['NaN', 'Infinity', '-1']) assert.equal(parseVramBuffers([`load_tensors: CUDA0 model buffer size = ${size} MiB`]).weights_gb, null);
});
test('多 GPU 仅取 GPU0，GPU1 不填补 GPU0 的缺项', () => {
  assert.deepEqual(parseVramBuffers([
    'load_tensors: CUDA0 model buffer size = 5120 MiB', 'load_tensors: CUDA1 model buffer size = 10240 MiB',
    'llama_kv_cache: CUDA1 KV buffer size = 2048 MiB', 'llama_kv_cache: CUDA0 KV buffer size = 512 MiB',
    'llama_context: CUDA1 compute buffer size = 1024 MiB',
  ]), { ...emptyBuffers, weights_gb: 5, kv_gb: 0.5, backend: null });
  assert.deepEqual(parseVramBuffers(['load_tensors: CUDA1 model buffer size = 10240 MiB']), emptyBuffers);
});
test('多模型/草稿/mmproj 不无说明累加，多个上下文归属不明时分项未知', () => {
  for (const extra of [
    ['srv load_model: loading draft model', 'load_tensors: CUDA0 model buffer size = 1024 MiB'],
    ['clip_model_load: CUDA0 model buffer size = 1024 MiB'],
    ['load_tensors: CUDA0 model buffer size = 1024 MiB'],
  ]) {
    assert.equal(parseVramBuffers(['load_tensors: CUDA0 model buffer size = 5120 MiB', ...extra]).weights_gb, null);
  }
  const parsed = parseVramBuffers([
    'llama_context: constructing llama_context', 'llama_context: n_ctx = 4096',
    'llama_kv_cache: CUDA0 KV buffer size = 512 MiB', 'llama_context: CUDA0 compute buffer size = 256 MiB',
    'llama_context: constructing llama_context', 'llama_context: n_ctx = 512',
    'llama_kv_cache: CUDA0 KV buffer size = 128 MiB', 'llama_context: CUDA0 compute buffer size = 64 MiB',
  ]);
  assert.equal(parsed.context, null);
  assert.equal(parsed.kv_gb, null);
  assert.equal(parsed.compute_gb, null);
});
test('同上下文最终 KV/compute 行覆盖旧行，跨后端不混合', () => {
  assert.equal(parseVramBuffers(['llama_kv_cache: CUDA0 KV buffer size = 512 MiB', 'llama_kv_cache: CUDA0 KV buffer size = 256 MiB']).kv_gb, 0.25);
  assert.equal(parseVramBuffers(['llama_context: CUDA0 compute buffer size = 512 MiB', 'llama_context: CUDA0 compute buffer size = 256 MiB']).compute_gb, 0.25);
  const mixed = parseVramBuffers(['load_tensors: CUDA0 model buffer size = 5120 MiB', 'load_tensors: Vulkan0 model buffer size = 5120 MiB']);
  assert.equal(mixed.weights_gb, null);
  assert.equal(mixed.backend, null);
});
test('稳定采样需明确 GPU 参数与权重，缺项返回 unverified 且不输出实测', () => {
  assert.deepEqual(assess(), { quality: 'stable', actualGb: 6 });
  for (const incomplete of [emptyBuffers, ...['context', 'gpu_layers', 'backend', 'weights_gb'].map((key) => ({ ...buffers, [key]: null }))]) {
    const result = assess({ buffers: incomplete });
    assert.equal(result.quality, 'unverified');
    assert.equal(result.actualGb, null);
    assert.ok(result.note);
  }
  assert.equal(assess({ buffers: { ...buffers, context: 0 } }).quality, 'unverified');
  assert.equal(assess({ buffers: { ...buffers, weights_gb: NaN } }).quality, 'unverified');
  assert.equal(assess({ buffers: { ...buffers, backend: 'CPU' } }).quality, 'unverified');
  assert.deepEqual(assess({ buffers: { ...buffers, kv_gb: null, compute_gb: null } }), { quality: 'stable', actualGb: 6 });
});
test('多 GPU 保留 GPU0 展示分项，但不准入单卡校准', () => {
  const parsed = parseVramBuffers([
    'load_tensors: offloaded 33/33 layers to GPU', 'load_tensors: CUDA0 model buffer size = 5120 MiB',
    'llama_context: n_ctx = 4096', 'llama_kv_cache: CUDA0 KV buffer size = 512 MiB',
    'llama_context: CUDA0 compute buffer size = 256 MiB', 'load_tensors: CUDA1 model buffer size = 1024 MiB',
  ]);
  assert.deepEqual(parsed, { ...buffers, backend: null, parallel: null });
  assert.equal(assess({ buffers: parsed }).quality, 'unverified');
  assert.equal(assess({ buffers: parsed }).actualGb, null);
});
test('每个窗口稳定阈值为 max(0.1GB, 读数的1%)', () => {
  assert.equal(assess({ baseline: summary(2, { spread_gb: 0.1 }), loaded: summary(8, { spread_gb: 0.1 }) }).quality, 'stable');
  assert.equal(assess({ loaded: summary(8, { spread_gb: 0.10001 }) }).quality, 'contaminated');
  assert.equal(assess({ loaded: summary(20, { spread_gb: 0.2 }) }).quality, 'stable');
  assert.equal(assess({ loaded: summary(20, { spread_gb: 0.201 }) }).quality, 'contaminated');
  assert.equal(assess({ baseline: summary(2, { spread_gb: 0.4 }) }).quality, 'contaminated');
});
test('缺测、非有限值、非正容量和无 GPU 名称不输出实测', () => {
  for (const sample of [null, undefined, summary(null), summary(NaN), summary(Infinity), summary(-1),
    summary(2, { gpu_total_gb: 0 }), summary(2, { gpu_total_gb: NaN }), summary(2, { gpu_name: '' }),
    summary(2, { spread_gb: NaN }), summary(2, { spread_gb: null }), summary(2, { spread_gb: -1 })]) {
    for (const key of ['baseline', 'loaded']) {
      const result = assess({ [key]: sample });
      assert.equal(result.quality, 'unverified');
      assert.equal(result.actualGb, null);
      assert.ok(result.note);
    }
  }
});
test('GPU、容量、负增量、容量上限和时序漂移污染不进入校准', () => {
  for (const overrides of [
    { loaded: summary(8, { gpu_name: 'GPU B' }) }, { loaded: summary(8, { gpu_total_gb: 16 }) },
    { loaded: summary(1) }, { loaded: summary(25) }, { baseline: summary(25), loaded: summary(26) },
    { loaded: summary(8, { spread_gb: 0.5 }) },
  ]) {
    const result = assess(overrides);
    assert.equal(result.quality, 'contaminated');
    assert.equal(result.actualGb, null);
    assert.ok(result.note);
  }
});
test('观测 GPU 缓冲作下界，单一已知分项也可核实小增量', () => {
  assert.equal(assess({ loaded: summary(3) }).quality, 'contaminated');
  assert.equal(assess({ loaded: summary(3), buffers: { ...emptyBuffers, kv_gb: 2 } }).quality, 'contaminated');
  assert.equal(assess({ loaded: summary(7.65) }).quality, 'stable');
  assert.equal(assess({ loaded: summary(7.5) }).quality, 'contaminated');
});
test('大文件 ncmoe/部分卸载允许合法小增量，不应用文件30%下限', () => {
  const result = assess({
    model: { ...model, fileSizeBytes: 100 * 1024 ** 3, modelType: 'moe', expertCount: 256 },
    config: { ...config, gpuLayers: 2, moeCpuLayers: 32 }, loaded: summary(2.5),
    buffers: { ...buffers, weights_gb: 0.2, kv_gb: 0.1, compute_gb: 0.1, gpu_layers: 2 },
  });
  assert.deepEqual(result, { quality: 'stable', actualGb: 0.5 });
});
test('明确 ctx/ngl 差异为 adapted，含 fit 文本但参数相同仍为 stable', () => {
  for (const override of [{ context: 2048 }, { gpu_layers: 20 }]) {
    const result = assess({ buffers: { ...buffers, ...override } });
    assert.equal(result.quality, 'adapted');
    assert.equal(result.actualGb, 6);
    assert.match(result.note, /实际有效参数已适配/);
  }
  assert.equal(assess({ buffers: parseVramBuffers([
    'llama_params_fit: successfully fit params', 'load_tensors: offloaded 33/33 layers to GPU',
    'load_tensors: CUDA0 model buffer size = 5120 MiB', 'llama_context: n_seq_max = 4', 'llama_context: n_ctx = 4096',
  ]) }).quality, 'stable');
});
test('全卸载大哨兵按 blockCount+1 比较，未知层数不冒称适配', () => {
  assert.equal(assess({ config: { ...config, gpuLayers: 999 } }).quality, 'stable');
  assert.equal(assess({ config: { ...config, gpuLayers: -1 } }).quality, 'stable');
  assert.equal(assess({ model: { ...model, blockCount: undefined }, config: { ...config, gpuLayers: 999 } }).quality, 'stable');
  assert.equal(assess({ model: { ...model, blockCount: undefined }, config: { ...config, gpuLayers: 20 } }).quality, 'adapted');
  assert.equal(assess({ config: { ...config, gpuLayers: 999 }, buffers: { ...buffers, gpu_layers: 20 } }).quality, 'adapted');
});
test('有效并发优先读 n_seq_max，服务槽数可补充且 fit 重试不沿用旧值', () => {
  assert.equal(parseVramBuffers(['srv load_model: n_parallel = 8']).parallel, 8);
  assert.equal(parseVramBuffers(['srv load_model: n_parallel = 8', 'llama_context: n_seq_max = 4']).parallel, 4);
  assert.equal(parseVramBuffers(['llama_context: n_seq_max = 4', 'srv load_model: retrying', 'llama_context: n_ctx = 4096']).parallel, null);
  assert.equal(parseVramBuffers(['llama_context: n_seq_max = 0']).parallel, null);
});
test('正常 ctx 对齐与独立槽容量变化不当作内核参数适配', () => {
  assert.equal(assess({ config: { ...config, ctxLength: 8192, parallel: 3, kvUnified: false }, buffers: { ...buffers, context: 8448, parallel: 3 } }).quality, 'stable');
  assert.equal(assess({ config: { ...config, ctxLength: 8192, parallel: -1, kvUnified: false }, buffers: { ...buffers, context: 8448, parallel: 3 } }).quality, 'stable');
  assert.equal(assess({ config: { ...config, ctxLength: 4100 }, buffers: { ...buffers, context: 4352 } }).quality, 'stable');
  assert.equal(assess({ config: { ...config, parallel: 3 }, buffers: { ...buffers, parallel: 4 } }).quality, 'adapted');
});
test('自动并发缺日志保持未核实，明确 CPU 回退优先标有效参数变化', () => {
  assert.equal(assess({ buffers: { ...buffers, parallel: null } }).quality, 'unverified');
  const fallback = assess({ config: { ...config, ctxLength: 32768 }, buffers: { ...emptyBuffers, weights_gb: 0, kv_gb: 0, compute_gb: 0, context: 4096, gpu_layers: 0 } });
  assert.equal(fallback.quality, 'adapted');
  assert.match(fallback.note, /GPU 卸载层数/);
});

test('CPU ngl=0 的真实零增量允许，采样污染仍优先于参数适配', () => {
  assert.deepEqual(assess({ config: { ...config, gpuLayers: 0 }, loaded: summary(2),
    buffers: { ...buffers, weights_gb: 0, kv_gb: 0, compute_gb: 0, gpu_layers: 0 } }), { quality: 'stable', actualGb: 0 });
  assert.equal(assess({ config: { ...config, gpuLayers: 0 }, buffers: { ...buffers, gpu_layers: 0 } }).quality, 'stable');
  assert.equal(assess({ buffers: { ...buffers, context: 1024 }, loaded: summary(8, { spread_gb: 0.8 }) }).quality, 'contaminated');
  assert.equal(assess({ buffers: { ...buffers, context: 1024 }, baseline: null }).quality, 'unverified');
});
