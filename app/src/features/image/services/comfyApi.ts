import { invoke } from '@tauri-apps/api/core';
import { isDesktopRuntime } from '@/lib/desktop';
import type { ComfyImageRef, ComfyPrompt, ComfyPromptResponse, ComfyResourceOptions } from '@/features/image/state/imageTypes';

function normalizeBaseUrl(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return trimmed || 'http://127.0.0.1:8188';
}

function normalizePath(path: string) {
  return path.startsWith('/') ? path : `/${path}`;
}

function buildUrl(baseUrl: string, path: string) {
  return `${normalizeBaseUrl(baseUrl)}${normalizePath(path)}`;
}

async function readJsonResponse(response: Response) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `HTTP ${response.status}`);
  }
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function comfyGet<T>(baseUrl: string, path: string): Promise<T> {
  if (isDesktopRuntime()) {
    return await invoke<T>('comfy_get_json', {
      baseUrl: normalizeBaseUrl(baseUrl),
      path: normalizePath(path),
    });
  }
  const response = await fetch(buildUrl(baseUrl, path));
  return await readJsonResponse(response) as T;
}

async function comfyPost<T>(baseUrl: string, path: string, payload: unknown): Promise<T> {
  if (isDesktopRuntime()) {
    return await invoke<T>('comfy_post_json', {
      baseUrl: normalizeBaseUrl(baseUrl),
      path: normalizePath(path),
      payload,
    });
  }
  const response = await fetch(buildUrl(baseUrl, path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return await readJsonResponse(response) as T;
}

function optionList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const source = Array.isArray(value[0]) ? value[0] : value;
  return source.filter((item): item is string => typeof item === 'string');
}

function readRequiredOption(objectInfo: unknown, nodeType: string, inputName: string) {
  if (!objectInfo || typeof objectInfo !== 'object') return [];
  const nodeInfo = (objectInfo as Record<string, unknown>)[nodeType];
  if (!nodeInfo || typeof nodeInfo !== 'object') return [];
  const input = (nodeInfo as { input?: unknown }).input;
  if (!input || typeof input !== 'object') return [];
  const required = (input as { required?: unknown }).required;
  if (!required || typeof required !== 'object') return [];
  return optionList((required as Record<string, unknown>)[inputName]);
}

export async function getComfySystemStats(baseUrl: string) {
  return await comfyGet<unknown>(baseUrl, '/system_stats');
}

export async function getComfyObjectInfo(baseUrl: string) {
  return await comfyGet<unknown>(baseUrl, '/object_info');
}

export async function getComfyQueue(baseUrl: string) {
  return await comfyGet<unknown>(baseUrl, '/queue');
}

export async function submitComfyPrompt(baseUrl: string, prompt: ComfyPrompt, clientId: string) {
  return await comfyPost<ComfyPromptResponse>(baseUrl, '/prompt', {
    prompt,
    client_id: clientId,
  });
}

export async function getComfyHistory(baseUrl: string, promptId: string) {
  return await comfyGet<unknown>(baseUrl, `/history/${encodeURIComponent(promptId)}`);
}

export async function interruptComfy(baseUrl: string) {
  return await comfyPost<unknown>(baseUrl, '/interrupt', {});
}

export async function uploadComfyImage(baseUrl: string, file: File) {
  if (isDesktopRuntime()) {
    const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
    return await invoke<{ name?: string; subfolder?: string; type?: string }>('comfy_upload_image', {
      baseUrl: normalizeBaseUrl(baseUrl),
      filename: file.name,
      data: bytes,
      overwrite: true,
    });
  }

  const formData = new FormData();
  formData.append('image', file);
  formData.append('overwrite', 'true');
  const response = await fetch(buildUrl(baseUrl, '/upload/image'), {
    method: 'POST',
    body: formData,
  });
  return await readJsonResponse(response) as { name?: string; subfolder?: string; type?: string };
}

export function extractComfyResourceOptions(objectInfo: unknown): ComfyResourceOptions {
  const checkpoints = readRequiredOption(objectInfo, 'CheckpointLoaderSimple', 'ckpt_name');
  const loras = [
    ...readRequiredOption(objectInfo, 'LoraLoader', 'lora_name'),
    ...readRequiredOption(objectInfo, 'LoraLoaderModelOnly', 'lora_name'),
  ];
  const samplers = readRequiredOption(objectInfo, 'KSampler', 'sampler_name');
  const schedulers = readRequiredOption(objectInfo, 'KSampler', 'scheduler');

  return {
    checkpoints: Array.from(new Set(checkpoints)),
    loras: Array.from(new Set(loras)),
    samplers: Array.from(new Set(samplers)),
    schedulers: Array.from(new Set(schedulers)),
  };
}

export function buildComfyImageUrl(baseUrl: string, image: ComfyImageRef) {
  const url = new URL(buildUrl(baseUrl, '/view'));
  url.searchParams.set('filename', image.filename);
  if (image.subfolder) url.searchParams.set('subfolder', image.subfolder);
  if (image.type) url.searchParams.set('type', image.type);
  return url.toString();
}

function isImageRef(value: unknown): value is ComfyImageRef {
  return Boolean(value)
    && typeof value === 'object'
    && typeof (value as { filename?: unknown }).filename === 'string';
}

export function extractImagesFromHistory(history: unknown, promptId: string): ComfyImageRef[] {
  if (!history || typeof history !== 'object') return [];
  const historyRecord = history as Record<string, unknown>;
  const item = historyRecord[promptId] ?? history;
  if (!item || typeof item !== 'object') return [];
  const outputs = (item as { outputs?: unknown }).outputs;
  if (!outputs || typeof outputs !== 'object') return [];

  const images: ComfyImageRef[] = [];
  for (const output of Object.values(outputs as Record<string, unknown>)) {
    if (!output || typeof output !== 'object') continue;
    const outputImages = (output as { images?: unknown }).images;
    if (!Array.isArray(outputImages)) continue;
    images.push(...outputImages.filter(isImageRef));
  }
  return images;
}
