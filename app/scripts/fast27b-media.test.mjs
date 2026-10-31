import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

// 与 autotune.test.mjs 一致：仅内存转译，不构建应用、不生成编译文件。
// 业务模块（包括 desktop、reasoningGears、mediaAdapters、desktopState）全部真实加载。
// 只隔离原生 I/O 入口；意外 invoke/解码/网络请求必须失败，绝不加载模型或使用 GPU。
const dataModule = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const nativeIo = new Map([
  ['@tauri-apps/api/core', dataModule(`
    export const isTauri = () => false;
    export const invoke = async () => { throw new Error('测试禁止原生 IPC / GPU'); };
  `)],
  ['@tauri-apps/plugin-dialog', dataModule(`
    export const open = async () => { throw new Error('测试禁止打开本地文件'); };
  `)],
  ['@tauri-apps/api/event', dataModule(`
    export const listen = async () => { throw new Error('测试禁止原生事件订阅'); };
  `)],
  ['@tauri-apps/api/window', dataModule(`
    export const Effect = {};
    export const EffectState = {};
    export const getCurrentWindow = () => { throw new Error('测试禁止原生窗口 I/O'); };
  `)],
]);
const modules = new Map();
function pureModuleUrl(url) {
  if (modules.has(url.href)) return modules.get(url.href);
  const { outputText, diagnostics } = ts.transpileModule(readFileSync(url, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    reportDiagnostics: true, fileName: url.pathname,
  });
  assert.equal(diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error).length, 0);
  const compiled = outputText.replace(/\b(from\s*|import\s*)(['"])([^'"]+)\2/g, (_, prefix, quote, specifier) => {
    if (nativeIo.has(specifier)) return `${prefix}${quote}${nativeIo.get(specifier)}${quote}`;
    assert.ok(specifier.startsWith('.') || specifier.startsWith('@/'), `未隔离的依赖：${specifier}`);
    const dependency = specifier.startsWith('@/')
      ? new URL(`../src/${specifier.slice(2)}`, import.meta.url) : new URL(specifier, url);
    if (!dependency.pathname.endsWith('.ts')) {
      dependency.pathname += dependency.pathname.endsWith('/ipc') ? '/index.ts' : '.ts';
    }
    return `${prefix}${quote}${pureModuleUrl(dependency)}${quote}`;
  });
  const result = dataModule(compiled);
  modules.set(url.href, result);
  return result;
}
const { prepareFast27bMessages } = await import(pureModuleUrl(new URL('../src/lib/fast27bMedia.ts', import.meta.url)));
const {
  attachmentBackendError, attachmentMediaMime, classifyAttachment,
  attachmentToMultimodalPart, buildPromptWithAttachments, buildMultimodalUserMessage,
} = await import(pureModuleUrl(new URL('../src/features/chat/chatUtils.ts', import.meta.url)));
const { streamChatCompletion } = await import(pureModuleUrl(new URL('../src/lib/desktop.ts', import.meta.url)));
const { getActiveChatAbortController } = await import(pureModuleUrl(new URL('../src/lib/desktopState.ts', import.meta.url)));

const ready = { resolved: true, vision: true };
const imageUrl = 'data:image/png;base64,AQID';
const videoUrl = 'data:video/mp4;base64,BAUG';
const image = { type: 'image_url', image_url: { url: imageUrl } };
const video = { type: 'video_url', video_url: { url: videoUrl } };
const frames = [{ timestampSeconds: 0, url: 'data:image/png;base64,BwgJ' }];
const videoWithFrames = { type: 'video_url', video_url: { url: videoUrl, frames } };
const textFile = { id: 'text-1', kind: 'text', name: '样例.txt', size: 6, extension: 'txt', content: '合成文本' };
const tools = [{ type: 'function', function: { name: 'mcp__demo', description: '测试工具', parameters: { type: 'object', properties: {} } } }];
const toolMessages = [
  { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'mcp__demo', arguments: '{"x":1}' } }] },
  { role: 'tool', content: '工具结果', tool_call_id: 'call-1', name: 'mcp__demo' },
];
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

test('fast 文本、照片和 video_url 保持原生格式，工具字段保留且输入不变', () => {
  const messages = deepFreeze([
    { role: 'user', content: '纯文本' },
    { role: 'user', content: [{ type: 'text', text: '描述附件' }, image, video] },
    ...structuredClone(toolMessages),
  ]);
  const before = structuredClone(messages);
  const result = prepareFast27bMessages(messages, ready);
  assert.deepEqual(result, before);
  assert.deepEqual(messages, before);
  assert.notEqual(result, messages);
  result.forEach((message, index) => assert.notEqual(message, messages[index]));
});

test('fast 丢弃视频缓存 frames 和图片附加字段，绝不转 input_video 或图像帧', () => {
  const messages = deepFreeze([{ role: 'user', content: [
    { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } },
    videoWithFrames,
  ] }]);
  const before = structuredClone(messages);
  const result = prepareFast27bMessages(messages, ready);
  assert.deepEqual(result, [{ role: 'user', content: [image, video] }]);
  assert.equal(JSON.stringify(result).includes('frames'), false);
  assert.deepEqual(messages, before);
});

for (const capabilities of [{ resolved: false, vision: false }, { resolved: true, vision: false }]) {
  test(`能力 ${JSON.stringify(capabilities)} 拒绝照片和视频，但文本附件与工具消息正常`, () => {
    for (const part of [image, video]) {
      assert.throws(() => prepareFast27bMessages([{ role: 'user', content: [part] }], capabilities),
        capabilities.resolved ? /未启用视觉/ : /无法确认.*视觉能力/);
    }
    const content = buildMultimodalUserMessage('阅读', [textFile], []);
    const messages = [
      { role: 'user', content: content.text },
      { role: 'user', content: [{ type: 'text', text: '文本分段' }] },
      ...toolMessages,
    ];
    assert.deepEqual(prepareFast27bMessages(messages, capabilities), messages);
  });
}
for (const part of [
  { type: 'audio_url', audio_url: { url: 'data:audio/wav;base64,AQID' } },
  { type: 'input_audio', input_audio: { data: 'AQID', format: 'wav' } },
  { type: 'input_video', input_video: { data: 'AQID' } },
]) {
  test(`fast 拒绝历史 ${part.type}（包括更早的历史消息），不静默忽略`, () => {
    const messages = deepFreeze([{ role: 'user', content: [part] }, { role: 'user', content: '继续' }]);
    const before = structuredClone(messages);
    assert.throws(() => prepareFast27bMessages(messages, ready), part.type === 'input_video' ? /历史视频.*重新添加原始视频/ : /不支持音频.*不识别声轨/);
    assert.deepEqual(messages, before);
  });
}
for (const [kind, invalidUrls] of [
  ['image_url', ['https://example.invalid/a.png', 'file:///a.png', 'data:video/mp4;base64,AQID', 'data:image/png;base64,', 'data:image/png;base64,%%%']],
  ['video_url', ['https://example.invalid/a.mp4', 'data:image/png;base64,AQID', 'data:video/mp4,AAAA', 'data:video/mp4;base64,', 'data:video/mp4;base64,A A']],
]) {
  test(`${kind} 拒绝远端 URL、错误 MIME、空数据或非法 base64，不发外部请求`, () => {
    for (const url of invalidUrls) {
      assert.throws(() => prepareFast27bMessages([{ role: 'user', content: [{ type: kind, [kind]: { url } }] }], ready), /有效的 base64 文件数据/);
    }
  });
}

test('附件后端限制仅 fast 音频，照片/视频/文本与 main 原行为保留', () => {
  for (const kind of ['text', 'image', 'video', 'audio']) {
    assert.equal(attachmentBackendError(kind, 'main'), null);
    if (kind === 'audio') assert.match(attachmentBackendError(kind, 'fast27b'), /不支持音频/);
    else assert.equal(attachmentBackendError(kind, 'fast27b'), null);
  }
});

test('MIME 保留有效媒体类型；空值和通用 MIME 按大小写不敏感扩展名回退', () => {
  const groups = [
    ['image/png', ['png']], ['image/jpeg', ['jpg', 'jpeg']], ['image/gif', ['gif']],
    ['image/webp', ['webp']], ['image/bmp', ['bmp']], ['image/tiff', ['tif', 'tiff']],
    ['audio/wav', ['wav']], ['audio/mpeg', ['mp3']], ['audio/mp4', ['m4a']],
    ['audio/aac', ['aac']], ['audio/ogg', ['ogg', 'oga', 'opus']], ['audio/flac', ['flac']],
    ['video/mp4', ['mp4', 'm4v']], ['video/quicktime', ['mov']], ['video/x-matroska', ['mkv']],
    ['video/webm', ['webm']], ['video/x-msvideo', ['avi']], ['video/ogg', ['ogv']],
  ];
  for (const [mime, extensions] of groups) {
    for (const extension of extensions) {
      for (const type of ['', 'application/octet-stream']) {
        const name = `合成.${extension.toUpperCase()}`;
        assert.equal(attachmentMediaMime(name, type), mime, name);
        assert.equal(classifyAttachment({ name, type, size: 1 }), mime.split('/')[0]);
      }
    }
  }
  assert.equal(attachmentMediaMime('照片.png', 'IMAGE/WEBP'), 'IMAGE/WEBP');
  assert.equal(attachmentMediaMime('未知.bin', ''), 'application/octet-stream');
});

test('附件分类覆盖 MIME 优先、文本代码扩展名和不支持的二进制', () => {
  for (const [name, type, expected] of [
    ['未知.bin', 'image/png', 'image'], ['未知.bin', 'audio/wav', 'audio'],
    ['未知.bin', 'VIDEO/MP4', 'video'], ['样例.json', '', 'text'],
    ['代码.TS', 'application/octet-stream', 'text'], ['无扩展名', 'text/plain', 'text'],
    ['无扩展名', 'application/json', 'text'], ['无扩展名', 'application/xml', 'text'],
    ['未知.bin', '', null],
  ]) assert.equal(classifyAttachment({ name, type, size: 1 }), expected, name);
});

test('文本拼接只拼文本内容，媒体转原生 part，空提示与纯文本路线不变', () => {
  const media = { id: 'video-1', kind: 'video', name: '合成.mp4', size: 1, extension: 'mp4' };
  const attachments = deepFreeze([structuredClone(textFile), media]);
  const before = structuredClone(attachments);
  const prompt = buildPromptWithAttachments('阅读', attachments);
  assert.match(prompt, /^阅读\n\n已附 1 个媒体文件/);
  assert.match(prompt, /文件：样例.txt\n大小：6 B\n内容：\n```txt\n合成文本\n```/);
  assert.equal(prompt.includes('文件：合成.mp4'), false);
  assert.equal(buildPromptWithAttachments('原样', []), '原样');
  assert.equal(buildPromptWithAttachments('原样', [media]), '原样');
  assert.deepEqual(attachmentToMultimodalPart(media, videoUrl), video);
  assert.deepEqual(attachmentToMultimodalPart({ ...media, kind: 'image' }, imageUrl), image);
  assert.equal(attachmentToMultimodalPart({ ...media, kind: 'audio' }, 'data:audio/wav;base64,AQID').type, 'audio_url');
  assert.deepEqual(buildMultimodalUserMessage('  ', [], [video]), { kind: 'multimodal', content: [video] });
  assert.deepEqual(buildMultimodalUserMessage('阅读', [textFile], []), { kind: 'plain', text: buildPromptWithAttachments('阅读', [textFile]) });
  const result = buildMultimodalUserMessage('阅读', [textFile], [image, video]);
  assert.deepEqual(result.content.slice(1), [image, video]);
  assert.match(result.content[0].text, /合成文本/);
  assert.deepEqual(attachments, before);
});

const props = (modalities = { vision: true, audio: false, video: false }) => ({ modalities });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function sse(events = [{ choices: [{ delta: { content: '合成回答' } }] }, { usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }]) {
  const bytes = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
  // 故意分割 UTF-8 与 SSE 行，实际 reader/decoder/归并逻辑不可 mock。
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
}
function mockServer(t, { serverProps = props(), models, complete = () => sse() } = {}) {
  const requests = [];
  let modelQueries = 0;
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'http://127.0.0.1:1', '测试只能使用虚拟本地端口');
    const request = { path: url.pathname, init, body: init.body ? JSON.parse(init.body) : undefined };
    requests.push(request);
    if (url.pathname === '/props') {
      if (serverProps instanceof Error) throw serverProps;
      return serverProps instanceof Response ? serverProps.clone() : json(serverProps);
    }
    if (url.pathname === '/v1/models') {
      modelQueries += 1;
      return models ? models(modelQueries) : json({ data: [{ id: '实际模型' }] });
    }
    assert.equal(url.pathname, '/v1/chat/completions');
    assert.equal(init.method, 'POST');
    return complete(request, requests.filter((item) => item.body).length);
  });
  return { requests, posts: () => requests.filter((request) => request.body) };
}
function options(overrides = {}) {
  return {
    port: 1, modelName: '旧模型', mediaBackend: 'fast27b',
    messages: [{ role: 'user', content: [image, videoWithFrames] }],
    config: { systemPrompt: ' 合成系统提示 ', temperature: 0.7, topP: 0.9, repeatPenalty: 1.05, maxTokens: 32, reasoningMode: 'off' },
    reasoningProfile: { canDisable: true, efforts: [] },
    onToken() {}, ...overrides,
  };
}

// 所有测试都仅 mock fetch；即使某分支漏 mock，也不能访问实际 8094 或外网。
// 每个测试结束后 t.mock 会恢复到此拒绝实现，而不是恢复真实网络。
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('测试禁止真实网络 / GPU 请求'); };
process.once('exit', () => { globalThis.fetch = originalFetch; });

test('真实 stream fast 路线：原生照片/video_url、无 frames、显式参数与 SSE 回调正常', async (t) => {
  const server = mockServer(t);
  const tokens = [];
  const usage = [];
  const request = options({ onToken: (token) => tokens.push(token), onUsage: (value) => usage.push(value) });
  deepFreeze(request.messages);
  const before = structuredClone(request.messages);
  const result = await streamChatCompletion(request);
  assert.deepEqual(server.requests.map((item) => item.path), ['/props', '/v1/models', '/v1/chat/completions']);
  const body = server.posts()[0].body;
  assert.deepEqual(body.messages, [{ role: 'system', content: '合成系统提示' }, { role: 'user', content: [image, video] }]);
  assert.equal(body.model, '实际模型');
  assert.equal(body.max_tokens, 32);
  assert.equal(body.n_predict, 32);
  assert.equal(body.reasoning_budget, 0);
  assert.equal(body.thinking_budget_tokens, 0);
  assert.equal(body.chat_template_kwargs.enable_thinking, false);
  assert.equal(body.temperature, request.config.temperature);
  assert.equal(body.top_p, request.config.topP);
  assert.equal(body.repeat_penalty, request.config.repeatPenalty);
  assert.equal(JSON.stringify(body).includes('frames'), false);
  assert.equal(tokens.join(''), '合成回答');
  assert.equal(result.promptTokens, 12);
  assert.equal(result.completionTokens, 3);
  assert.equal(usage.at(-1).totalTokens, 15);
  assert.deepEqual(request.messages, before);
  assert.equal(getActiveChatAbortController(), null);
});

for (const [label, serverProps, expected] of [
  ['props 断网', new Error('模拟 I/O 故障'), /无法确认.*视觉能力/],
  ['props 非 2xx', json({}, 503), /无法确认.*视觉能力/],
  ['视觉关闭', props({ vision: false, audio: false, video: false }), /未启用视觉/],
]) {
  test(`真实 stream ${label}：媒体在 POST 前拒绝，文本仍成功且清理活动状态`, async (t) => {
    const server = mockServer(t, { serverProps });
    for (const part of [image, video]) {
      await assert.rejects(streamChatCompletion(options({ messages: [{ role: 'user', content: [part] }] })), expected);
      assert.equal(server.posts().length, 0);
      assert.equal(getActiveChatAbortController(), null);
    }
    await streamChatCompletion(options({ messages: [{ role: 'user', content: buildPromptWithAttachments('阅读', [textFile]) }] }));
    assert.equal(server.posts().length, 1);
    assert.match(server.posts()[0].body.messages[1].content, /合成文本/);
    assert.equal(getActiveChatAbortController(), null);
  });
}

test('真实 stream fast 即使 props 报告音频支持仍拒绝音频和历史 input_video', async (t) => {
  const server = mockServer(t, { serverProps: props({ vision: true, audio: true, video: true }) });
  for (const [part, error] of [
    [{ type: 'audio_url', audio_url: { url: 'data:audio/wav;base64,AQID' } }, /不支持音频/],
    [{ type: 'input_audio', input_audio: { data: 'AQID', format: 'wav' } }, /不支持音频/],
    [{ type: 'input_video', input_video: { data: 'AQID' } }, /历史视频/],
  ]) await assert.rejects(streamChatCompletion(options({ messages: [{ role: 'user', content: [part] }] })), error);
  assert.equal(server.posts().length, 0);
  assert.equal(getActiveChatAbortController(), null);
});

for (const mediaBackend of ['fast27b', 'llama']) {
  test(`真实 stream ${mediaBackend}：MCP 工具声明、历史回填字段和工具调用 SSE 分片保留`, async (t) => {
    const server = mockServer(t, { complete: () => sse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-2', type: 'function', function: { name: 'mcp__demo', arguments: '{"x":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '2}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } },
    ]) });
    const messages = deepFreeze(structuredClone(toolMessages));
    const result = await streamChatCompletion(options({ mediaBackend, messages, tools }));
    assert.deepEqual(server.posts()[0].body.messages.slice(1), toolMessages);
    assert.deepEqual(server.posts()[0].body.tools, tools);
    assert.equal(server.posts()[0].body.tool_choice, 'auto');
    assert.deepEqual(result.toolCalls, [{ id: 'call-2', name: 'mcp__demo', arguments: { x: 2 }, rawArguments: '{"x":2}', argumentsValid: true }]);
    assert.deepEqual(messages, toolMessages);
    assert.equal(getActiveChatAbortController(), null);
  });
}

test('真实 stream llama 默认路线仍使用原生 input_video，不受 fast 清洗器影响', async (t) => {
  const server = mockServer(t, { serverProps: props({ vision: true, audio: true, video: true }) });
  const request = options({ videoSupport: 'verified', messages: [{ role: 'user', content: [image, videoWithFrames] }] });
  delete request.mediaBackend;
  await streamChatCompletion(request);
  assert.deepEqual(server.posts()[0].body.messages[1].content, [image, { type: 'input_video', input_video: { data: 'BAUG' } }]);
});

test('真实 stream llama 原生视频失败后仅一次抽帧重试，保留 MCP 与所有生成参数', async (t) => {
  const server = mockServer(t, {
    serverProps: props({ vision: true, audio: false, video: true }),
    complete: (_, count) => count === 1 ? json({ error: 'native video failed' }, 400) : sse(),
  });
  const messages = deepFreeze([{ role: 'user', content: [videoWithFrames] }, ...structuredClone(toolMessages)]);
  const before = structuredClone(messages);
  await streamChatCompletion(options({ mediaBackend: 'llama', videoSupport: 'verified', messages, tools }));
  const posts = server.posts();
  assert.equal(posts.length, 2);
  assert.equal(posts[0].body.messages[1].content[0].type, 'input_video');
  const fallback = posts[1].body.messages[1].content;
  assert.match(fallback[0].text, /视频抽帧兼容/);
  assert.deepEqual(fallback.at(-1), { type: 'image_url', image_url: { url: frames[0].url } });
  assert.deepEqual(posts[1].body.messages.slice(2), toolMessages);
  assert.deepEqual({ ...posts[1].body, messages: [] }, { ...posts[0].body, messages: [] });
  assert.deepEqual(messages, before);
});

for (const mediaBackend of ['fast27b', 'llama']) {
  test(`真实 stream ${mediaBackend}：模型 ID 刷新重试保留媒体协议、MCP 和参数`, async (t) => {
    const server = mockServer(t, {
      models: (count) => count === 1 ? json({}, 503) : json({ data: [{ id: '刷新模型' }] }),
      complete: (_, count) => count === 1 ? json({ error: 'model not found' }, 404) : sse(),
    });
    await streamChatCompletion(options({ mediaBackend, messages: [{ role: 'user', content: [videoWithFrames] }, ...toolMessages], tools }));
    const posts = server.posts();
    assert.equal(posts.length, 2);
    assert.equal(posts[0].body.model, '旧模型');
    assert.equal(posts[1].body.model, '刷新模型');
    assert.deepEqual({ ...posts[1].body, model: '' }, { ...posts[0].body, model: '' });
    const content = posts[1].body.messages[1].content;
    if (mediaBackend === 'fast27b') assert.deepEqual(content, [video]);
    else assert.match(content[0].text, /视频抽帧兼容/);
    assert.deepEqual(posts[1].body.messages.slice(2), toolMessages);
  });
}
for (const [status, errorBody, expected] of [
  [400, 'invalid video_url', /NiNfer 返回 400/],
  [413, 'request too large', /附件请求过大/],
  [422, 'media_budget_exceeded', /超过引擎预算/],
  [400, 'context_length_exceeded', /超过引擎预算/],
]) {
  test(`真实 stream fast HTTP ${status}/${errorBody} 不回退 llama 或偷偷发帧`, async (t) => {
    const server = mockServer(t, {
      serverProps: props({ vision: true, audio: false, video: true }),
      complete: () => new Response(errorBody, { status }),
    });
    await assert.rejects(streamChatCompletion(options({ videoSupport: 'verified' })), expected);
    assert.equal(server.posts().length, 1);
    assert.deepEqual(server.posts()[0].body.messages[1].content, [image, video]);
    assert.equal(getActiveChatAbortController(), null);
  });
}
