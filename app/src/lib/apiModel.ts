import type { ModelInfo } from '@/types';

// 通过对外 API（/v1/models）添加的模型：按名称自动推断标签，
// 让模型一进入软件就带上 工具/思考/视觉/嵌入/重排 等标记。

const API_MODEL_TAG_RULES: Array<{ tag: string; pattern: RegExp }> = [
  { tag: 'Embedding', pattern: /embed|bge-|gte-|e5-|jina-?v3|text-embedding/i },
  { tag: 'Rerank', pattern: /rerank|ranker/i },
  { tag: 'Video', pattern: /video/i },
  { tag: 'Audio', pattern: /audio|omni|tts|asr|whisper|sensevoice/i },
  { tag: 'Vision', pattern: /-vl\b|_vl\b|-vl$|vision|llava|minicpm-v|internvl|qvq|mimo-vl|keye/i },
  { tag: 'Thinking', pattern: /qwq|reasoner|deepseek-r\d|_r1\b|-r1\b|r1-|thinking|think|o1|o3|gpt-oss/i },
];

// 这些家族的主流指令模型普遍支持函数调用；base/pretrain 后缀除外。
const API_MODEL_TOOL_FAMILIES = [
  'qwen', 'llama', 'mistral', 'ministral', 'mixtral', 'glm', 'chatglm', 'deepseek',
  'gemma', 'phi', 'command-r', 'nemotron', 'gpt-oss', 'yi-', 'hermes', 'granite',
];

export function inferApiModelTags(modelName: string): string[] {
  const name = modelName.toLowerCase();
  const tags: string[] = [];
  for (const rule of API_MODEL_TAG_RULES) {
    if (rule.pattern.test(name)) {
      tags.push(rule.tag);
    }
  }
  const isBaseOnly = /[-_]base\b|pretrain/.test(name);
  const isEmbedding = tags.includes('Embedding') || tags.includes('Rerank');
  if (!isBaseOnly && !isEmbedding && API_MODEL_TOOL_FAMILIES.some((family) => name.includes(family))) {
    tags.push('Tools');
  }
  return tags;
}

function hashString(value: string) {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

// 从能力标签推导 ModelCard 上的能力徽章开关。
function capabilitiesFromTags(tags: string[]) {
  return {
    supportsVision: tags.includes('Vision') || tags.includes('Video'),
    supportsAudio: tags.includes('Audio'),
    supportsVideo: tags.includes('Video'),
    videoSupport: (tags.includes('Video') ? 'candidate' : 'none') as ModelInfo['videoSupport'],
    supportsThinking: tags.includes('Thinking'),
    supportsTools: tags.includes('Tools'),
    supportsReasoning: tags.includes('Thinking'),
  };
}

export function createApiModel(alias: string, port: number): ModelInfo {
  const tags = ['API', ...inferApiModelTags(alias)];
  const displayName = alias.trim() || '未命名模型';
  return {
    id: `api-${hashString(displayName.toLowerCase())}`,
    name: displayName,
    family: 'API',
    params: 'API',
    quant: 'API',
    fileSize: '--',
    fileSizeBytes: 0,
    modelType: 'dense',
    status: 'standby',
    themeColor: '#3b82f655',
    themeColorSolid: '#3b82f6',
    description: `API 模型 · http://127.0.0.1:${port}/v1`,
    longDescription: [
      `模型来自本地 llama-server 的 /v1/models 列表（端口 ${port}）。`,
      `对外 API 调用名：${displayName}`,
      `自动识别标签：${tags.filter((tag) => tag !== 'API').join('、') || '无'}`,
    ].join('\n'),
    tags,
    downloadCount: 'API',
    ctxLength: 0,
    loadConfig: {
      ctxLength: 4096,
      gpuLayers: 999,
      batchSize: 512,
      physicalBatchSize: 512,
      threads: -1,
      parallel: -1,
      fastAttention: true,
      kvCache: true,
      kvUnified: true,
      mmap: true,
      mlock: false,
      noWarmup: false,
      cacheTypeKEnabled: false,
      cacheTypeK: 'f16',
      cacheTypeVEnabled: false,
      cacheTypeV: 'f16',
      ropeFreqBaseEnabled: false,
      ropeFreqBase: 0,
      ropeFreqScaleEnabled: false,
      ropeFreqScale: 0,
      seedEnabled: false,
      seed: -1,
      speculativeDecoding: 'off',
      specDraftNMaxEnabled: false,
      specDraftNMax: 4,
      chatTemplate: '',
      rememberSettings: true,
      showAdvancedSettings: false,
      idleAutoUnload: false,
      idleAutoUnloadMinutes: 15,
      moeCpuLayers: 0,
      reasoningBudget: 0,
    },
    releaseDate: 'API',
    license: 'API',
    source: 'api',
    apiName: displayName,
    ...capabilitiesFromTags(tags),
  };
}
