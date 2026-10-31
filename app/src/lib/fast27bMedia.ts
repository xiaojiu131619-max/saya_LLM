import type { ChatCompletionMessage } from './desktop';

export function prepareFast27bMessages(
  messages: ChatCompletionMessage[],
  capabilities: { resolved: boolean; vision: boolean },
): ChatCompletionMessage[] {
  return messages.map((message) => {
    if (typeof message.content === 'string') return { ...message };
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type === 'text') return part;
        if (part.type === 'audio_url' || part.type === 'input_audio') {
          throw new Error('NiNfer 不支持音频输入；视频仅分析画面，不识别声轨。');
        }
        if (part.type === 'input_video') {
          throw new Error('此历史视频使用 llama.cpp 专用格式，请在 NiNfer 对话中重新添加原始视频文件。');
        }
        if (!capabilities.resolved) {
          throw new Error('无法确认 NiNfer 的视觉能力，请检查引擎连接后重试。');
        }
        if (!capabilities.vision) {
          throw new Error('当前 NiNfer 引擎未启用视觉能力，无法读取照片或视频。');
        }
        const kind = part.type === 'image_url' ? 'image' : 'video';
        const url = part.type === 'image_url' ? part.image_url.url : part.video_url.url;
        if (!new RegExp(`^data:${kind}/[^;,]+;base64,[A-Za-z0-9+/]+={0,2}$`, 'i').test(url)) {
          throw new Error(`NiNfer 的${kind === 'image' ? '照片' : '视频'}需要有效的 base64 文件数据，请重新添加原始文件。`);
        }
        // Chat Completions 使用 video_url；input_video 只属于另一套 API，不能沿用 llama.cpp 转换。
        return part.type === 'image_url'
          ? { type: 'image_url' as const, image_url: { url } }
          : { type: 'video_url' as const, video_url: { url } };
      }),
    };
  });
}
