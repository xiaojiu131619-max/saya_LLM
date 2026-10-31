import type { ChatSession, Message } from '@/types';

/**
 * 会话导出：三种格式 + 可选内容项。
 *
 * 与 `chatUtils` 里的 `exportSessionAsMarkdown/Json` 共存的原因：
 * 那两个函数被「数据管理」的全量备份直接复用（结构稳定，改了会动备份格式），
 * 这里服务于导出弹窗——用户可以自己选要不要带思考过程与统计。
 */

export type ExportFormat = 'markdown' | 'json' | 'text';

function pad2(value: number) {
  return String(value).padStart(2, '0');
}

/** 本地日期键（YYYY-MM-DD）；不用 toISOString，避免 UTC 把凌晨的会话记到前一天。 */
function localDayKey(date: Date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export interface SessionExportOptions {
  format: ExportFormat;
  /** 是否带上模型的思考过程（reasoningContent）。 */
  includeReasoning: boolean;
  /** 是否带上每轮的 token / 速度等统计。 */
  includeStats: boolean;
  /** 是否带上工具调用记录。 */
  includeTools: boolean;
}

export interface ExportFormatMeta {
  id: ExportFormat;
  label: string;
  hint: string;
  ext: string;
  mime: string;
}

export const EXPORT_FORMATS: ExportFormatMeta[] = [
  {
    id: 'markdown',
    label: 'Markdown',
    hint: '带标题层级与元信息，适合归档、发文档',
    ext: 'md',
    mime: 'text/markdown',
  },
  {
    id: 'text',
    label: '纯文本',
    hint: '只有问答正文，适合再喂给别的模型',
    ext: 'txt',
    mime: 'text/plain',
  },
  {
    id: 'json',
    label: 'JSON',
    hint: '结构化字段，适合二次处理或脚本读取',
    ext: 'json',
    mime: 'application/json',
  },
];

/**
 * 文件名：标题清洗 + 日期，避免 Windows 不允许的字符。
 * 控制字符（< 0x20）单独按码点过滤——写进正则字面量会触发 no-control-regex，
 * 而文件名里混入换行 / 制表符同样会让保存失败。
 */
export function buildExportFilename(session: ChatSession, format: ExportFormat): string {
  const safeTitle = Array.from(session.title || '对话')
    .filter((char) => char.charCodeAt(0) >= 0x20)
    .join('')
    .replace(/[<>:"/\\|?*]/g, '_')
    .trim()
    .slice(0, 50) || '对话';
  // 用本地日期（与界面显示一致）；非法历史时间回退到今天，避免 toISOString 抛错。
  const created = new Date(session.createdAt);
  const date = localDayKey(Number.isFinite(created.getTime()) ? created : new Date());
  const meta = EXPORT_FORMATS.find((item) => item.id === format);
  return `${safeTitle}-${date}.${meta?.ext ?? 'txt'}`;
}

function statsLine(message: Message): string | null {
  const stats = message.stats;
  if (!stats) return null;
  const parts: string[] = [];
  if (stats.outputTokens > 0) parts.push(`${stats.outputTokens} tok`);
  if (stats.tokensPerSec > 0) parts.push(`${stats.tokensPerSec.toFixed(1)} tok/s`);
  if (stats.firstTokenDelay > 0) parts.push(`${stats.firstTokenDelay.toFixed(2)}s 首字`);
  if (stats.genTime > 0) parts.push(`${stats.genTime.toFixed(1)}s 生成`);
  if (stats.ctxTotal > 0) parts.push(`ctx ${Math.round((stats.ctxUsed / stats.ctxTotal) * 100)}%`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function toolLine(message: Message): string | null {
  const activities = message.toolActivity ?? [];
  if (activities.length === 0) return null;
  return activities
    .map((activity) => `${activity.tool}${activity.isError ? '（失败）' : ''}`)
    .join('、');
}

function roleLabel(role: Message['role']): string {
  return role === 'user' ? '用户' : '模型';
}

function buildMarkdown(session: ChatSession, options: SessionExportOptions): string {
  const lines: string[] = [];
  lines.push(`# ${session.title}`);
  lines.push('');
  lines.push(`- 创建：${new Date(session.createdAt).toLocaleString('zh-CN')}`);
  lines.push(`- 消息数：${session.messages.length}`);
  if (session.modelName) lines.push(`- 模型：${session.modelName}`);
  lines.push('');

  for (const message of session.messages) {
    const time = new Date(message.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    lines.push(`## ${roleLabel(message.role)}（${time}）`);
    lines.push('');

    if (options.includeReasoning && message.reasoningContent?.trim()) {
      lines.push('<details><summary>思考过程</summary>');
      lines.push('');
      lines.push('```thinking');
      lines.push(message.reasoningContent.trim());
      lines.push('```');
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }

    if (message.content.trim()) {
      lines.push(message.content.trim());
      lines.push('');
    }

    const attachmentCount = (message.multimodalContent ?? []).filter((part) => part.type !== 'text').length;
    if (attachmentCount > 0) {
      lines.push(`> 附件 ${attachmentCount} 个（媒体内容未导出）`);
      lines.push('');
    }

    if (options.includeTools) {
      const tools = toolLine(message);
      if (tools) {
        lines.push(`> 工具调用：${tools}`);
        lines.push('');
      }
    }

    if (options.includeStats) {
      const stats = statsLine(message);
      if (stats) {
        lines.push(`> 统计：${stats}`);
        lines.push('');
      }
    }
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function buildPlainText(session: ChatSession, options: SessionExportOptions): string {
  const blocks: string[] = [];
  for (const message of session.messages) {
    const head = `${roleLabel(message.role)}：`;
    const body = message.content.trim();
    let block = `${head}${body}`;
    if (options.includeReasoning && message.reasoningContent?.trim()) {
      block += `\n（思考）${message.reasoningContent.trim()}`;
    }
    if (options.includeTools) {
      const tools = toolLine(message);
      if (tools) block += `\n（工具调用：${tools}）`;
    }
    blocks.push(block);
  }
  const header = [
    session.title,
    session.modelName ? `模型：${session.modelName}` : '',
    `创建：${new Date(session.createdAt).toLocaleString('zh-CN')}`,
  ].filter(Boolean).join('\n');
  return `${header}\n\n${blocks.join('\n\n')}\n`;
}

function buildJson(session: ChatSession, options: SessionExportOptions): string {
  const messages = session.messages.map((message) => {
    const entry: Record<string, unknown> = {
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
    };
    if (options.includeReasoning && message.reasoningContent) entry.reasoningContent = message.reasoningContent;
    if (options.includeStats && message.stats) entry.stats = message.stats;
    if (options.includeTools && message.toolActivity?.length) entry.toolActivity = message.toolActivity;
    // base64 媒体只留类型，避免导出的 JSON 变成几十兆。
    const mediaParts = (message.multimodalContent ?? []).filter((part) => part.type !== 'text');
    if (mediaParts.length > 0) {
      entry.attachments = mediaParts.map((part) => ({ type: part.type, note: '媒体内容未导出' }));
    }
    return entry;
  });

  return JSON.stringify({
    title: session.title,
    modelName: session.modelName,
    modelId: session.modelId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    exportedAt: new Date().toISOString(),
    messages,
  }, null, 2);
}

export function buildExportContent(session: ChatSession, options: SessionExportOptions): string {
  if (options.format === 'json') return buildJson(session, options);
  if (options.format === 'text') return buildPlainText(session, options);
  return buildMarkdown(session, options);
}

/** 弹窗里展示的会话摘要。 */
export function summarizeSession(session: ChatSession) {
  const userCount = session.messages.filter((message) => message.role === 'user').length;
  const attachmentCount = session.messages.reduce(
    (total, message) => total + (message.multimodalContent ?? []).filter((part) => part.type !== 'text').length,
    0,
  );
  const outputTokens = session.messages.reduce((total, message) => total + (message.stats?.outputTokens ?? 0), 0);
  return {
    messageCount: session.messages.length,
    userCount,
    attachmentCount,
    outputTokens,
    createdAtText: new Date(session.createdAt).toLocaleDateString('zh-CN'),
  };
}
