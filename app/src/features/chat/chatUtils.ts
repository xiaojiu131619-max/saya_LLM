import type { ChatSession, ChatMessageContentPart, Message, MessageStats } from '@/types';

export const CHAT_HISTORY_MODEL_ID = 'chat-workspace';

/**
 * 会话是否属于指定模型：runtimeModelId 是发起对话时的实际模型快照；
 * modelId 多为 'chat-workspace' 桶 id（无模型语义），仅在恰好等于模型 id 时参与匹配。
 * ctx 的分母（容量）随模型不同，跨模型取 stats 会把别的模型的 ctx% 串到当前模型上。
 */
export function sessionBelongsToModel(session: ChatSession, modelId: string | undefined): boolean {
  if (!modelId) return false;
  return session.runtimeModelId === modelId
    || (session.modelId === modelId && modelId !== CHAT_HISTORY_MODEL_ID);
}

export const MAX_ATTACHMENT_BYTES = 1024 * 1024;
export const MAX_MEDIA_BYTES = 80 * 1024 * 1024;

export const TEXT_FILE_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonl', 'csv', 'tsv', 'log',
  'xml', 'html', 'css', 'js', 'jsx', 'ts', 'tsx', 'py', 'rs',
  'go', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'php', 'rb',
  'swift', 'kt', 'kts', 'sql', 'toml', 'yaml', 'yml', 'ini',
  'env', 'bat', 'ps1', 'sh',
]);

export type AttachmentKind = 'text' | 'image' | 'audio' | 'video';

export interface AttachmentBase {
  id: string;
  name: string;
  size: number;
  extension: string;
  kind: AttachmentKind;
}

export interface TextAttachment extends AttachmentBase {
  kind: 'text';
  content: string;
}

export interface MediaAttachment extends AttachmentBase {
  kind: 'image' | 'audio' | 'video';
  // 原始文件的本地路径（拖拽时由 Tauri 提供），用于走 Rust 读取后转 base64。
  path?: string;
  // 仅在使用浏览器文件输入时存在，是 File 对象引用。
  // 真正需要读字节时由调用方处理，不放进 state 序列化。
  mimeType?: string;
  // 预读取的 data URL（形如 data:image/png;base64,...）。
  // 用于浏览器 File 路径，避免反复读取。
  dataUrl?: string;
}

export type PendingAttachment = TextAttachment | MediaAttachment;

export function fileExtension(name: string) {
  const parts = name.toLowerCase().split('.');
  return parts.length > 1 ? parts.pop() ?? '' : '';
}

export function fileNameFromPath(path: string) {
  const slash = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return slash >= 0 ? path.slice(slash + 1) : path;
}

const IMAGE_MIME_PREFIX = 'image/';
const AUDIO_MIME_PREFIX = 'audio/';
const VIDEO_MIME_PREFIX = 'video/';

export function classifyAttachment(file: { name: string; type: string; size: number }): AttachmentKind | null {
  const type = (file.type || '').toLowerCase();
  const ext = fileExtension(file.name);

  if (type.startsWith(IMAGE_MIME_PREFIX)) return 'image';
  if (type.startsWith(AUDIO_MIME_PREFIX)) return 'audio';
  if (type.startsWith(VIDEO_MIME_PREFIX)) return 'video';

  // 浏览器有时拿不到 MIME，按扩展名补判一次。
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff'].includes(ext)) return 'image';
  if (['wav', 'mp3', 'm4a', 'aac', 'ogg', 'oga', 'flac', 'opus'].includes(ext)) return 'audio';
  if (['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'ogv'].includes(ext)) return 'video';

  if (type.startsWith('text/')
    || type.includes('json')
    || type.includes('xml')
    || TEXT_FILE_EXTENSIONS.has(ext)) {
    return 'text';
  }
  return null;
}

export function isSupportedTextFile(file: File) {
  const ext = fileExtension(file.name);
  return file.type.startsWith('text/')
    || file.type.includes('json')
    || file.type.includes('xml')
    || TEXT_FILE_EXTENSIONS.has(ext);
}

export function formatFileSize(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function buildPromptWithAttachments(prompt: string, attachments: PendingAttachment[]) {
  if (attachments.length === 0) return prompt;
  const textAttachments = attachments.filter((a): a is TextAttachment => a.kind === 'text');
  const mediaAttachments = attachments.filter((a): a is MediaAttachment => a.kind !== 'text');
  if (textAttachments.length === 0) return prompt;
  const blocks = textAttachments.map((file) => [
    `文件：${file.name}`,
    `大小：${formatFileSize(file.size)}`,
    '内容：',
    `\`\`\`${file.extension || 'text'}`,
    file.content,
    '```',
  ].join('\n'));
  const mediaNote = mediaAttachments.length > 0
    ? `\n\n已附 ${mediaAttachments.length} 个${mediaAttachments.length > 1 ? '多媒体文件' : '媒体文件'}，请结合内容理解。`
    : '';
  return `${prompt}${mediaNote}\n\n以下是用户附加的本地文件内容，请作为上下文使用：\n\n${blocks.join('\n\n')}`;
}

export type MultimodalContentPart = ChatMessageContentPart;

export function attachmentToMultimodalPart(media: MediaAttachment, dataUrl: string): MultimodalContentPart {
  if (media.kind === 'image') {
    return { type: 'image_url', image_url: { url: dataUrl } };
  }
  if (media.kind === 'audio') {
    return { type: 'audio_url', audio_url: { url: dataUrl } };
  }
  return { type: 'video_url', video_url: { url: dataUrl } };
}

export function buildMultimodalUserMessage(
  prompt: string,
  textAttachments: TextAttachment[],
  mediaParts: MultimodalContentPart[]
): { kind: 'plain' | 'multimodal'; text?: string; content?: MultimodalContentPart[] } {
  if (mediaParts.length === 0) {
    return { kind: 'plain', text: buildPromptWithAttachments(prompt, textAttachments) };
  }
  const textContent = buildPromptWithAttachments(prompt, textAttachments as PendingAttachment[]);
  const parts: MultimodalContentPart[] = [];
  if (textContent.trim()) parts.push({ type: 'text', text: textContent });
  parts.push(...mediaParts);
  return { kind: 'multimodal', content: parts };
}

export function createChatSession(
  modelId: string,
  title = '新对话',
  modelSnapshot?: Pick<ChatSession, 'runtimeModelId' | 'modelName' | 'modelColor'>
): ChatSession {
  const now = Date.now();
  const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `chat-${now}`;
  return {
    id: `chat-${id}`,
    modelId,
    ...modelSnapshot,
    title,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

/**
 * 导出聊天会话为 Markdown 文本
 */
export function exportSessionAsMarkdown(session: ChatSession): string {
  const lines: string[] = [];

  // 会话标题和元信息
  lines.push(`# ${session.title}`);
  lines.push('');
  lines.push(`> 创建时间：${new Date(session.createdAt).toLocaleString('zh-CN')}`);
  lines.push(`> 更新时间：${new Date(session.updatedAt).toLocaleString('zh-CN')}`);
  if (session.modelName) {
    lines.push(`> 模型：${session.modelName}`);
  }
  lines.push('');

  // 消息内容
  for (const msg of session.messages) {
    const time = new Date(msg.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const roleLabel = msg.role === 'user' ? '用户' : '模型';

    lines.push(`## ${roleLabel} (${time})`);
    lines.push('');

    // 思考内容（如果有）
    if (msg.reasoningContent) {
      lines.push('### 思考过程');
      lines.push('');
      lines.push('```thinking');
      lines.push(msg.reasoningContent.trim());
      lines.push('```');
      lines.push('');
    }

    // 消息正文
    if (msg.content.trim()) {
      lines.push(msg.content.trim());
      lines.push('');
    }

    // 多模态附件（如果有）
    if (msg.multimodalContent && msg.multimodalContent.length > 0) {
      const mediaParts = msg.multimodalContent.filter((p) => p.type !== 'text');
      if (mediaParts.length > 0) {
        lines.push('### 附件');
        lines.push('');
        for (const part of mediaParts) {
          if (part.type === 'image_url') {
            lines.push(`- 📷 图片（dataUrl，已省略）`);
          } else if (part.type === 'audio_url') {
            lines.push(`- 🎵 音频（dataUrl，已省略）`);
          } else if (part.type === 'video_url') {
            lines.push(`- 🎬 视频（dataUrl，已省略）`);
          }
        }
        lines.push('');
      }
    }

    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * 导出聊天会话为 JSON（包含完整消息数据，不含 base64 媒体）
 */
export function exportSessionAsJson(session: ChatSession): string {
  // 过滤掉 base64 媒体数据，只保留类型标记
  const sanitizedMessages = session.messages.map((msg) => ({
    id: msg.id,
    role: msg.role,
    content: msg.content,
    reasoningContent: msg.reasoningContent,
    timestamp: msg.timestamp,
    stats: msg.stats,
    multimodalContent: msg.multimodalContent?.map((part) => {
      if (part.type === 'image_url') {
        return { type: 'image_url', image_url: { url: '[base64 data omitted]' } };
      }
      if (part.type === 'audio_url') {
        return { type: 'audio_url', audio_url: { url: '[base64 data omitted]' } };
      }
      if (part.type === 'video_url') {
        return { type: 'video_url', video_url: { url: '[base64 data omitted]' } };
      }
      return part;
    }),
  }));

  const exportData = {
    title: session.title,
    modelId: session.modelId,
    modelName: session.modelName,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messages: sanitizedMessages,
  };

  return JSON.stringify(exportData, null, 2);
}

/**
 * 触发下载文件
 */
export function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // 延迟撤销 URL，确保下载已开始（部分浏览器/WebView2 需要）
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function dayLabel(timestamp: number) {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  if (sameDay(date, today)) return '今天';
  if (sameDay(date, yesterday)) return '昨天';
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

export function compactModelName(name?: string) {
  if (!name) return '未加载模型';
  return name.length > 28 ? `${name.slice(0, 27)}...` : name;
}

/**
 * 从一组会话中取最新一条带 stats 的消息统计（用于侧边栏/模型卡显示 ctx 已用）。
 */
export function latestStatsForSessions(sessions?: ChatSession[]): MessageStats | undefined {
  let latest: MessageStats | undefined;
  let latestAt = 0;
  for (const session of sessions ?? []) {
    for (const message of session.messages) {
      if (message.stats && message.timestamp >= latestAt) {
        latest = message.stats;
        latestAt = message.timestamp;
      }
    }
  }
  return latest;
}

/**
 * 计算 ctx 已用百分比（0-100），数据不足返回 undefined。
 */
export function ctxUsagePercent(stats: MessageStats | undefined): number | undefined {
  const used = stats?.ctxUsed ?? 0;
  const total = stats?.ctxTotal ?? 0;
  if (!Number.isFinite(used) || !Number.isFinite(total) || used <= 0 || total <= 0) return undefined;
  return Math.min(100, Math.max(0, (used / total) * 100));
}

// 粗估文本 token 数：CJK 字符按 1 token，其余按每 4 字符 1 token。
// 用于「本地会话累计水位」口径——服务器日志只有最近一轮，无法反映整段会话。
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u3000-\u9fff\uff00-\uffef]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

// 会话累计上下文占用：把会话中所有消息（含思考内容）粗估加总。
export function estimateSessionCtxTokens(messages: Message[]): number {
  return messages.reduce(
    (sum, msg) => sum + estimateTextTokens(msg.content) + estimateTextTokens(msg.reasoningContent ?? ''),
    0,
  );
}

// 本地会话水位展示：百分比为主，估算值/容量为补充。
export function formatSessionCtxUsage(sessionCtx: { used: number; total: number } | undefined) {
  if (!sessionCtx || sessionCtx.total <= 0) return 'ctx --';
  const { used, total } = sessionCtx;
  const percent = Math.min(100, Math.max(0, (used / total) * 100));
  const percentText = percent.toFixed(percent >= 10 ? 0 : 1);
  return `ctx ${percentText}%（≈${used.toLocaleString()} / ${total.toLocaleString()}）`;
}

export function latestRuntimeStatsFromServerLogs(logs: string[], ctxTotal: number): MessageStats | undefined {
  if (!Number.isFinite(ctxTotal) || ctxTotal <= 0) return undefined;

  let promptTokens = 0;
  let completionTokens = 0;
  let tokensPerSec = 0;

  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const line = logs[index];
    if (completionTokens <= 0 && !/prompt eval time/i.test(line)) {
      const evalMatch = line.match(/\beval time\s*=\s*[\d.]+\s*ms\s*\/\s*(\d+)\s*(?:runs|tokens?)\b.*?([\d.]+)\s*tokens per second/i);
      if (evalMatch) {
        completionTokens = Math.max(0, Math.round(Number(evalMatch[1]) || 0));
        tokensPerSec = Math.max(0, Number(evalMatch[2]) || 0);
      }
    }

    if (promptTokens <= 0) {
      const promptMatch = line.match(/prompt eval time\s*=\s*[\d.]+\s*ms\s*\/\s*(\d+)\s*tokens?\b/i)
        ?? line.match(/prompt processing progress.*?n_tokens\s*=\s*(\d+)/i);
      if (promptMatch) {
        promptTokens = Math.max(0, Math.round(Number(promptMatch[1]) || 0));
      }
    }

    if (promptTokens > 0 && (completionTokens > 0 || tokensPerSec > 0)) break;
  }

  if (promptTokens <= 0) return undefined;
  return {
    ctxUsed: promptTokens + completionTokens,
    ctxTotal,
    outputTokens: completionTokens,
    firstTokenDelay: 0,
    tokensPerSec,
    genTime: 0,
  };
}
