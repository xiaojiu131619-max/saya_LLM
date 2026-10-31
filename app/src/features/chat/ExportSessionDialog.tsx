import { useEffect, useMemo, useState } from 'react';
import { Braces, Brain, Check, Download, FileText, Gauge, Type, Wrench, X } from 'lucide-react';
import type { ChatSession } from '@/types';
import {
  EXPORT_FORMATS,
  buildExportFilename,
  summarizeSession,
  type ExportFormat,
  type SessionExportOptions,
} from '@/lib/sessionExport';

const FORMAT_ICONS: Record<ExportFormat, typeof FileText> = {
  markdown: FileText,
  text: Type,
  json: Braces,
};

interface ExportSessionDialogProps {
  session: ChatSession | null;
  onClose: () => void;
  onExport: (options: SessionExportOptions) => void;
}

/**
 * 导出对话弹窗。
 *
 * 取代原来的原生 `prompt("输入 md 或 json")`：那个弹窗既没有格式说明，
 * 也不能选「要不要带思考过程 / 统计」，用户只能靠记忆敲两个字母。
 */
export default function ExportSessionDialog({ session, onClose, onExport }: ExportSessionDialogProps) {
  const [format, setFormat] = useState<ExportFormat>('markdown');
  const [includeReasoning, setIncludeReasoning] = useState(false);
  const [includeStats, setIncludeStats] = useState(true);
  const [includeTools, setIncludeTools] = useState(true);

  useEffect(() => {
    if (!session) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session, onClose]);

  const summary = useMemo(() => (session ? summarizeSession(session) : null), [session]);
  const filename = useMemo(() => (session ? buildExportFilename(session, format) : ''), [session, format]);
  const options: SessionExportOptions = { format, includeReasoning, includeStats, includeTools };

  if (!session || !summary) return null;

  const toggles: Array<{ key: 'includeReasoning' | 'includeStats' | 'includeTools'; label: string; hint: string; icon: typeof Brain; value: boolean; onChange: (value: boolean) => void }> = [
    {
      key: 'includeReasoning',
      label: '思考过程',
      hint: '模型的推理内容（体积较大）',
      icon: Brain,
      value: includeReasoning,
      onChange: setIncludeReasoning,
    },
    {
      key: 'includeStats',
      label: '统计数据',
      hint: '每轮 token、速度与上下文占比',
      icon: Gauge,
      value: includeStats,
      onChange: setIncludeStats,
    },
    {
      key: 'includeTools',
      label: '工具调用',
      hint: 'MCP 工具名与失败标记',
      icon: Wrench,
      value: includeTools,
      onChange: setIncludeTools,
    },
  ];

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="导出对话"
        onMouseDown={(event) => event.stopPropagation()}
        className="anim-enter-pop w-full max-w-xl overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--app-bg)] shadow-2xl dark:border-white/[0.1] dark:bg-[var(--surface)]"
      >
        {/* 头部 */}
        <div className="flex items-start justify-between gap-3 border-b border-[var(--border-subtle)] px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-[var(--radius-field)] bg-[var(--accent-subtle)] text-[var(--accent)]">
              <Download className="h-4.5 w-4.5" />
            </span>
            <div className="min-w-0">
              <h2 className="text-[length:var(--font-subtitle)] font-semibold text-[var(--text-primary)]">导出对话</h2>
              <p className="mt-0.5 line-clamp-1 text-[length:var(--font-caption)] text-[var(--text-secondary)]" title={session.title}>
                {session.title}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-[var(--radius-field)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] dark:hover:bg-white/[0.08]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[min(70vh,560px)] overflow-y-auto px-5 py-4">
          {/* 会话摘要 */}
          <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-[var(--radius-field)] bg-[var(--surface-muted)] px-3.5 py-2.5 text-[length:var(--font-caption)] text-[var(--text-secondary)]">
            <span><span className="mono-font font-semibold text-[var(--text-primary)]">{summary.messageCount}</span> 条消息</span>
            <span><span className="mono-font font-semibold text-[var(--text-primary)]">{summary.userCount}</span> 轮提问</span>
            {summary.outputTokens > 0 && (
              <span><span className="mono-font font-semibold text-[var(--text-primary)]">{summary.outputTokens.toLocaleString()}</span> 输出 token</span>
            )}
            {summary.attachmentCount > 0 && <span>{summary.attachmentCount} 个附件（不导出）</span>}
            <span className="ml-auto text-[var(--text-tertiary)]">{summary.createdAtText} · {session.modelName ?? '未记录模型'}</span>
          </div>

          {/* 格式 */}
          <div className="mb-1.5 text-[length:var(--font-eyebrow)] font-semibold tracking-[var(--tracking-eyebrow)] text-[var(--text-tertiary)]">导出格式</div>
          <div className="mb-4 grid gap-2 sm:grid-cols-3">
            {EXPORT_FORMATS.map((item) => {
              const Icon = FORMAT_ICONS[item.id];
              const active = format === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setFormat(item.id)}
                  aria-pressed={active}
                  className={`relative flex flex-col items-start gap-1.5 rounded-[var(--radius-field)] border px-3 py-2.5 text-left transition-colors ${
                    active
                      ? 'border-[var(--accent)] bg-[var(--accent-subtle)]'
                      : 'border-[var(--border)] bg-[var(--surface)] hover:border-[var(--accent)]/45 dark:border-white/[0.08]'
                  }`}
                >
                  <span className="flex w-full items-center gap-2">
                    <Icon className={`h-4 w-4 flex-shrink-0 ${active ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'}`} />
                    <span className={`text-[length:var(--font-body)] font-semibold ${active ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'}`}>
                      {item.label}
                    </span>
                    {active && <Check className="ml-auto h-3.5 w-3.5 flex-shrink-0 text-[var(--accent)]" />}
                  </span>
                  <span className="text-[length:var(--font-eyebrow)] leading-4 text-[var(--text-secondary)]">{item.hint}</span>
                </button>
              );
            })}
          </div>

          {/* 内容选项 */}
          <div className="mb-1.5 text-[length:var(--font-eyebrow)] font-semibold tracking-[var(--tracking-eyebrow)] text-[var(--text-tertiary)]">包含内容</div>
          <div className="mb-4 divide-y divide-[var(--border-subtle)] rounded-[var(--radius-field)] border border-[var(--border)] dark:border-white/[0.08]">
            {toggles.map((toggle) => {
              const Icon = toggle.icon;
              return (
                <button
                  key={toggle.key}
                  type="button"
                  role="switch"
                  aria-checked={toggle.value}
                  onClick={() => toggle.onChange(!toggle.value)}
                  className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-[var(--surface-muted)] dark:hover:bg-white/[0.05]"
                >
                  <Icon className="h-4 w-4 flex-shrink-0 text-[var(--text-secondary)]" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[length:var(--font-body)] text-[var(--text-primary)]">{toggle.label}</span>
                    <span className="mt-0.5 block text-[length:var(--font-eyebrow)] leading-4 text-[var(--text-tertiary)]">{toggle.hint}</span>
                  </span>
                  <span
                    aria-hidden="true"
                    className={`flex h-5 w-9 flex-shrink-0 items-center rounded-full border p-0.5 transition-colors ${
                      toggle.value
                        ? 'justify-end border-[var(--accent)] bg-[var(--accent)]'
                        : 'justify-start border-[var(--border)] bg-[var(--border)] dark:border-white/[0.18] dark:bg-white/[0.10]'
                    }`}
                  >
                    <span className="h-3.5 w-3.5 rounded-full bg-white shadow-sm" />
                  </span>
                </button>
              );
            })}
          </div>

          {/* 文件名预览 */}
          <div className="flex items-center gap-2 rounded-[var(--radius-field)] bg-[var(--surface-muted)] px-3.5 py-2.5">
            <span className="flex-shrink-0 text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">文件名</span>
            <span className="mono-font min-w-0 flex-1 truncate text-[length:var(--font-caption)] text-[var(--text-primary)]" title={filename}>
              {filename}
            </span>
          </div>
        </div>

        {/* 底部 */}
        <div className="flex items-center justify-end gap-2 border-t border-[var(--border-subtle)] bg-[var(--surface-muted)]/50 px-5 py-3.5">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-[var(--radius-field)] px-3.5 text-[length:var(--font-body)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--border)] dark:hover:bg-white/[0.08]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => onExport(options)}
            className="flex h-9 items-center gap-1.5 rounded-[var(--radius-field)] bg-[var(--accent)] px-4 text-[length:var(--font-body)] font-semibold text-[var(--text-on-accent)] transition-colors hover:bg-[var(--accent-hover)]"
          >
            <Download className="h-4 w-4" />
            导出
          </button>
        </div>
      </div>
    </div>
  );
}
