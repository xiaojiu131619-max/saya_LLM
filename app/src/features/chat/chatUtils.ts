import type { ChatSession } from '@/types';

export const CHAT_HISTORY_MODEL_ID = 'chat-workspace';

export const MAX_ATTACHMENT_BYTES = 1024 * 1024;

export const TEXT_FILE_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonl', 'csv', 'tsv', 'log',
  'xml', 'html', 'css', 'js', 'jsx', 'ts', 'tsx', 'py', 'rs',
  'go', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'php', 'rb',
  'swift', 'kt', 'kts', 'sql', 'toml', 'yaml', 'yml', 'ini',
  'env', 'bat', 'ps1', 'sh',
]);

export interface PendingAttachment {
  id: string;
  name: string;
  size: number;
  extension: string;
  content: string;
}

export function fileExtension(name: string) {
  const parts = name.toLowerCase().split('.');
  return parts.length > 1 ? parts.pop() ?? '' : '';
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
  const blocks = attachments.map((file) => [
    `文件：${file.name}`,
    `大小：${formatFileSize(file.size)}`,
    '内容：',
    `\`\`\`${file.extension || 'text'}`,
    file.content,
    '```',
  ].join('\n'));
  return `${prompt}\n\n以下是用户附加的本地文件内容，请作为上下文使用：\n\n${blocks.join('\n\n')}`;
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
