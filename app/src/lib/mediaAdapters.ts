export interface LlamaAudioPayload {
  data: string;
  format: 'wav' | 'mp3';
}

export interface VideoFramePayload {
  url: string;
  timestampSeconds: number;
}

const AUDIO_TARGET_SAMPLE_RATE = 16_000;
const MAX_ADAPTED_AUDIO_BYTES = 80 * 1024 * 1024;
const VIDEO_MAX_FRAMES = 8;
const VIDEO_MAX_EDGE = 1_280;
const MEDIA_CACHE_LIMIT = 4;

const audioCache = new Map<string, Promise<LlamaAudioPayload>>();
const videoCache = new Map<string, Promise<VideoFramePayload[]>>();

function cacheKey(dataUrl: string) {
  let hash = 2166136261;
  const step = Math.max(1, Math.floor(dataUrl.length / 2048));
  for (let index = 0; index < dataUrl.length; index += step) {
    hash ^= dataUrl.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${dataUrl.length}:${hash >>> 0}`;
}

function remember<T>(cache: Map<string, Promise<T>>, key: string, value: Promise<T>) {
  cache.set(key, value);
  while (cache.size > MEDIA_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (typeof oldest !== 'string') break;
    cache.delete(oldest);
  }
  value.catch(() => cache.delete(key));
  return value;
}

function parseBase64DataUrl(dataUrl: string) {
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || comma < 0) {
    throw new Error('媒体数据不是有效的 data URL。');
  }
  const header = dataUrl.slice(5, comma);
  if (!header.toLowerCase().includes(';base64')) {
    throw new Error('媒体 data URL 不是 base64 编码。');
  }
  const mimeType = header.split(';', 1)[0].toLowerCase();
  const data = dataUrl.slice(comma + 1);
  if (!data) throw new Error('媒体数据为空。');
  return { mimeType, data };
}

async function dataUrlToBlob(dataUrl: string) {
  const response = await fetch(dataUrl);
  if (!response.ok) throw new Error('无法读取媒体数据。');
  return response.blob();
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('无法编码 WAV 音频。'));
    reader.readAsDataURL(blob);
  });
}

function encodeMonoWav(buffer: AudioBuffer) {
  const samples = buffer.getChannelData(0);
  const dataSize = samples.length * 2;
  const bytes = new ArrayBuffer(44 + dataSize);
  const view = new DataView(bytes);

  const writeText = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeText(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, dataSize, true);

  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

async function convertAudioToWav(dataUrl: string): Promise<LlamaAudioPayload> {
  const AudioContextClass = window.AudioContext
    ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) {
    throw new Error('当前 WebView 不支持音频解码。');
  }

  const blob = await dataUrlToBlob(dataUrl);
  const audioContext = new AudioContextClass();
  try {
    const decoded = await audioContext.decodeAudioData(await blob.arrayBuffer());
    if (!Number.isFinite(decoded.duration) || decoded.duration <= 0) {
      throw new Error('音频时长无效。');
    }
    const outputLength = Math.max(1, Math.ceil(decoded.duration * AUDIO_TARGET_SAMPLE_RATE));
    const offline = new OfflineAudioContext(1, outputLength, AUDIO_TARGET_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const resampled = await offline.startRendering();
    const wav = encodeMonoWav(resampled);
    if (wav.size > MAX_ADAPTED_AUDIO_BYTES) {
      throw new Error('转码后的 WAV 超过 80 MB 限制。');
    }
    const wavDataUrl = await blobToDataUrl(wav);
    return {
      data: parseBase64DataUrl(wavDataUrl).data,
      format: 'wav',
    };
  } finally {
    await audioContext.close().catch(() => undefined);
  }
}

export function prepareAudioForLlama(dataUrl: string): Promise<LlamaAudioPayload> {
  const key = cacheKey(dataUrl);
  const cached = audioCache.get(key);
  if (cached) return cached;

  const task = (async () => {
    const parsed = parseBase64DataUrl(dataUrl);
    if (['audio/wav', 'audio/wave', 'audio/x-wav'].includes(parsed.mimeType)) {
      return { data: parsed.data, format: 'wav' as const };
    }
    if (['audio/mpeg', 'audio/mp3'].includes(parsed.mimeType)) {
      return { data: parsed.data, format: 'mp3' as const };
    }
    try {
      return await convertAudioToWav(dataUrl);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`无法把音频转换为 llama.cpp 支持的 WAV：${detail}`);
    }
  })();
  return remember(audioCache, key, task);
}

function waitForVideoEvent(video: HTMLVideoElement, eventName: string, timeoutMs = 15_000) {
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(new Error('视频解码超时。')), timeoutMs);
    const onSuccess = () => finish();
    const onError = () => finish(new Error('当前 WebView 无法解码这个视频格式。'));
    const finish = (error?: Error) => {
      window.clearTimeout(timeout);
      video.removeEventListener(eventName, onSuccess);
      video.removeEventListener('error', onError);
      if (error) reject(error);
      else resolve();
    };
    video.addEventListener(eventName, onSuccess, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
}

async function seekVideo(video: HTMLVideoElement, time: number) {
  if (Math.abs(video.currentTime - time) < 0.01 && video.readyState >= 2) return;
  const ready = waitForVideoEvent(video, 'seeked');
  video.currentTime = time;
  await ready;
}

async function resolveVideoDuration(video: HTMLVideoElement) {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;

  // MediaRecorder-generated WebM files may initially expose duration=Infinity.
  // Seeking beyond the stream end makes Chromium resolve the actual duration.
  const durationReady = waitForVideoEvent(video, 'timeupdate');
  video.currentTime = Number.MAX_SAFE_INTEGER;
  await durationReady;
  const duration = Number.isFinite(video.duration) && video.duration > 0
    ? video.duration
    : video.currentTime;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('无法解析视频时长。');
  }
  video.currentTime = 0;
  return duration;
}

function videoFrameCount(duration: number) {
  if (duration < 2) return 1;
  return Math.min(VIDEO_MAX_FRAMES, Math.max(2, Math.ceil(duration / 12)));
}

async function extractFrames(dataUrl: string): Promise<VideoFramePayload[]> {
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;

  try {
    const metadataReady = waitForVideoEvent(video, 'loadedmetadata');
    video.src = dataUrl;
    video.load();
    await metadataReady;

    const duration = await resolveVideoDuration(video);
    const { videoWidth, videoHeight } = video;
    if (videoWidth <= 0 || videoHeight <= 0) {
      throw new Error('视频画面尺寸无效。');
    }

    const scale = Math.min(1, VIDEO_MAX_EDGE / Math.max(videoWidth, videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(videoWidth * scale));
    canvas.height = Math.max(1, Math.round(videoHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建视频抽帧画布。');

    const count = videoFrameCount(duration);
    const frames: VideoFramePayload[] = [];
    for (let index = 0; index < count; index += 1) {
      const timestampSeconds = Math.min(
        Math.max(0, duration - 0.05),
        ((index + 0.5) / count) * duration,
      );
      await seekVideo(video, timestampSeconds);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push({
        url: canvas.toDataURL('image/jpeg', 0.84),
        timestampSeconds,
      });
    }
    return frames;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`无法为旧版 llama-server 提取视频帧：${detail} 建议使用 MP4（H.264）或 WebM。`);
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
}

export function extractVideoFrames(dataUrl: string): Promise<VideoFramePayload[]> {
  const key = cacheKey(dataUrl);
  const cached = videoCache.get(key);
  if (cached) return cached;
  return remember(videoCache, key, extractFrames(dataUrl));
}
