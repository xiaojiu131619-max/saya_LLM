import type { ChatCompletionMessage } from '@/lib/desktop';
import type { ChatMessageContentPart } from '@/types';

/**
 * 发送前的图片规范化。
 *
 * 引擎（NiNfer / llama-server）的图像解码器只吃标准 PNG/JPEG，
 * 而且一旦收到被截断或带异常 chunk 的数据，只会回一句
 * `png chunk extends past end of stream` —— 用户完全看不出该做什么。
 *
 * 这里统一让浏览器先解码再重编码：能解码的，输出干净的 JPEG（顺带降采样，
 * 避免超大图把请求撑爆）；解不了的（数据缺失、格式不支持）就在本地报清楚，
 * 不再把坏数据发给引擎。
 */

/** 最长边上限：视觉模型用不到更大的分辨率，还能显著减少 prefill。 */
const MAX_EDGE = 2048;
const JPEG_QUALITY = 0.92;
/** 缓存条数：重发 / 重试 / 多条历史会反复碰到同一张图。 */
const CACHE_LIMIT = 24;
const cache = new Map<string, string>();

/** 只处理浏览器能稳定解码的位图格式；其它格式原样交给引擎。 */
const NORMALIZABLE = /^data:image\/(png|jpe?g|webp|gif|bmp);base64,/i;

export async function normalizeImageUrl(url: string): Promise<string> {
  if (!NORMALIZABLE.test(url)) return url;
  // 非浏览器环境（回归测试直接跑 TS 模块）没有 canvas / createImageBitmap：
  // 原样返回，别让发送链路依赖 DOM。
  if (
    typeof document === 'undefined'
    || typeof createImageBitmap !== 'function'
    || typeof fetch !== 'function'
  ) {
    return url;
  }
  const cached = cache.get(url);
  if (cached) return cached;

  let bitmap: ImageBitmap;
  try {
    const blob = await (await fetch(url)).blob();
    bitmap = await createImageBitmap(blob);
  } catch {
    throw new Error(
      '图片数据不完整或格式无法识别（可能是文件被截断）。请撤回这条消息，重新添加原图后再发送。',
    );
  }

  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return url;
    // JPEG 没有透明通道：先铺白底，避免透明区域变成黑块。
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    const normalized = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    if (cache.size >= CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    cache.set(url, normalized);
    return normalized;
  } finally {
    bitmap.close();
  }
}

/** 把消息里的内嵌图片统一规范化；不改动原对象。 */
export async function normalizeMessagesImages(
  messages: ChatCompletionMessage[],
): Promise<ChatCompletionMessage[]> {
  return Promise.all(
    messages.map(async (message) => {
      if (typeof message.content === 'string') return message;
      const content: ChatMessageContentPart[] = await Promise.all(
        message.content.map(async (part) => {
          if (part.type !== 'image_url') return part;
          const url = part.image_url?.url ?? '';
          if (!url.startsWith('data:image/')) return part;
          return {
            ...part,
            image_url: { ...part.image_url, url: await normalizeImageUrl(url) },
          };
        }),
      );
      return { ...message, content };
    }),
  );
}
