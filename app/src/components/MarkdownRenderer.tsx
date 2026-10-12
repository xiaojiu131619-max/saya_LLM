import { memo, useMemo, useState } from 'react';
import { Brain, Check, ChevronDown, Copy } from 'lucide-react';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('c++', cpp);
hljs.registerLanguage('css', css);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('md', markdown);
hljs.registerLanguage('powershell', powershell);
hljs.registerLanguage('ps1', powershell);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('rs', rust);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('tsx', typescript);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('xml', xml);

interface MarkdownRendererProps {
  content: string;
}

function SegmentContentRenderer({ content }: { content: string }) {
  const parsedSegments = useMemo(() => parseContent(content), [content]);
  return (
    <>
      {parsedSegments.map((seg, i) => {
        if (seg.type === 'code') {
          return <MemoCodeBlock key={`code-${i}`} language={seg.lang} code={seg.content} />;
        }
        return <InlineMarkdown key={`text-${i}`} content={seg.content} />;
      })}
    </>
  );
}

export default function MarkdownRenderer({ content }: MarkdownRendererProps) {
  const reasoningSegments = useMemo(() => parseReasoningContent(content), [content]);

  return (
    <div className="markdown-body prose-body min-w-0 max-w-full text-primary-custom">
      {reasoningSegments.map((segment, segmentIndex) => {
        if (segment.type === 'thought') {
          return <ThoughtBlock key={`thought-${segmentIndex}`} content={segment.content} />;
        }
        return <SegmentContentRenderer key={`seg-${segmentIndex}`} content={segment.content} />;
      })}
    </div>
  );
}

function parseReasoningContent(content: string): Array<{ type: 'text' | 'thought'; content: string }> {
  const segments: Array<{ type: 'text' | 'thought'; content: string }> = [];
  const openTagRegex = /<think(?:ing)?>/i;
  let rest = content;

  while (rest.length > 0) {
    const openMatch = rest.match(openTagRegex);
    if (!openMatch || openMatch.index === undefined) {
      if (rest) segments.push({ type: 'text', content: rest });
      break;
    }

    const before = rest.slice(0, openMatch.index);
    if (before) segments.push({ type: 'text', content: before });

    const thoughtStart = openMatch.index + openMatch[0].length;
    const afterOpen = rest.slice(thoughtStart);
    const closeMatch = afterOpen.match(/<\/think(?:ing)?>/i);

    if (!closeMatch || closeMatch.index === undefined) {
      segments.push({ type: 'thought', content: afterOpen.trim() });
      break;
    }

    segments.push({ type: 'thought', content: afterOpen.slice(0, closeMatch.index).trim() });
    rest = afterOpen.slice(closeMatch.index + closeMatch[0].length);
  }

  if (segments.length === 0) {
    return [{ type: 'text', content }];
  }

  return segments.filter((segment) => segment.content.length > 0);
}

function parseContent(content: string): Array<{ type: 'text' | 'code'; lang?: string; content: string }> {
  const parts: Array<{ type: 'text' | 'code'; lang?: string; content: string }> = [];
  const codeRegex = /```(\w+)?\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = codeRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', content: content.slice(lastIndex, match.index) });
    }
    parts.push({ type: 'code', lang: match[1] || 'text', content: match[2].trim() });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    parts.push({ type: 'text', content: content.slice(lastIndex) });
  }

  if (parts.length === 0) {
    parts.push({ type: 'text', content });
  }

  return parts;
}

function CodeBlock({ language, code }: { language: string | undefined; code: string }) {
  const [copied, setCopied] = useState(false);
  const lang = language || 'text';
  const codeLines = code.split('\n');

  const highlighted = (() => {
    try {
      if (hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return hljs.highlightAuto(code).value;
    } catch {
      return escapeHtml(code);
    }
  })();

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="my-3 max-w-full overflow-hidden rounded-[var(--radius-field)] border border-[var(--border)] bg-[var(--surface-muted)] dark:border-white/[0.08] dark:bg-[var(--surface)]">
      <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface-muted)] px-4 py-2 dark:border-white/[0.08] dark:bg-[var(--surface-hover)]">
        <span className="mono-font text-[length:var(--font-eyebrow)] uppercase tracking-[var(--tracking-eyebrow)] text-[var(--text-secondary)]">{lang}</span>
        <button
          onClick={handleCopy}
          className={`flex items-center gap-1.5 text-[length:var(--font-caption)] transition-colors ${
            copied
              ? 'text-[var(--state-success)] dark:text-[var(--state-success)]'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] dark:text-[var(--text-secondary)] dark:hover:text-[var(--text-primary)]'
          }`}
        >
          {copied ? (
            <><Check className="h-3 w-3" />已复制</>
          ) : (
            <><Copy className="h-3 w-3" />复制</>
          )}
        </button>
      </div>
      <pre className="grid max-w-full grid-cols-[auto_minmax(0,1fr)] gap-3 overflow-x-hidden p-4 text-[length:var(--font-body)] leading-[var(--leading-code)]">
        <span
          aria-hidden="true"
          className="mono-font select-none whitespace-pre text-right text-[var(--text-tertiary)]"
        >
          {codeLines.map((_, index) => index + 1).join('\n')}
        </span>
        <code
          className="hljs mono-font min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[var(--text-primary)]"
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      </pre>
    </div>
  );
}

const MemoCodeBlock = memo(CodeBlock);

export function ThoughtBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const trimmed = content.trim();
  if (!trimmed) return null;

  const lines = trimmed.split('\n').filter((line) => line.trim().length > 0);
  const lineCount = lines.length;
  const wordCount = trimmed.length;

  return (
    <div
      className="my-3 max-w-full overflow-hidden rounded-[var(--radius-field)] border border-[var(--border)] bg-[var(--surface-muted)]/70 transition-all dark:border-white/[0.08] dark:bg-white/[0.03]"
      style={{ overflowAnchor: 'none' }}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => {
          setExpanded((value) => !value);
          // 广播给聊天页：用户正在操作思考框，立即脱离自动滚动，
          // 否则流式输出会把视口重新拽到最底部，导致无法停留阅读和折叠。
          window.dispatchEvent(new CustomEvent('agent-llm:thought-toggle'));
        }}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[length:var(--font-caption)] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] dark:hover:bg-white/[0.06]"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Brain className="h-3.5 w-3.5 flex-shrink-0 text-[var(--accent)]" />
          <span className="truncate">思考过程</span>
          <span className="flex-shrink-0 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--app-bg)] px-1.5 py-0.5 text-[length:var(--font-eyebrow)] text-[var(--text-secondary)] dark:border-white/[0.08] dark:bg-white/[0.04]">
            {lineCount} 行 · {wordCount} 字
          </span>
        </span>
        <span className="flex items-center gap-1 text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">
          <span>{expanded ? '收起' : '展开'}</span>
          <ChevronDown
            className={`h-3.5 w-3.5 flex-shrink-0 transition-transform duration-200 ${expanded ? 'rotate-180' : 'rotate-0'}`}
          />
        </span>
      </button>

      {!expanded && (
        <div
          aria-hidden="true"
          className="relative overflow-hidden border-t border-dashed border-[var(--border)] dark:border-white/[0.06]"
          style={{ maxHeight: '3.6rem' }}
        >
          <div className="whitespace-pre-wrap break-words px-3 py-2 font-mono text-[13px] leading-[var(--leading-code)] text-[var(--text-tertiary)] [overflow-wrap:anywhere] dark:text-[var(--text-secondary)]">
            {trimmed}
          </div>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-[var(--surface-muted)] to-transparent dark:from-[var(--surface-raised)]" />
        </div>
      )}

      {expanded && (
        <div className="border-t border-[var(--border)] px-3.5 py-3 font-mono text-[13px] leading-[var(--leading-code)] text-[var(--text-secondary)] [overflow-wrap:anywhere] dark:border-white/[0.06]">
          {trimmed}
        </div>
      )}
    </div>
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function InlineMarkdown({ content }: { content: string }) {
  const lines = content.split('\n');
  const elements: React.ReactNode[] = [];
  let inList = false;
  let listItems: React.ReactNode[] = [];
  let listType: 'ul' | 'ol' = 'ul';

  const flushList = () => {
    if (listItems.length > 0) {
      if (listType === 'ul') {
        elements.push(
          <ul key={`list-${elements.length}`} className="my-2 list-inside list-disc space-y-1">
            {listItems}
          </ul>
        );
      } else {
        elements.push(
          <ol key={`list-${elements.length}`} className="my-2 list-inside list-decimal space-y-1">
            {listItems}
          </ol>
        );
      }
      listItems = [];
      inList = false;
    }
  };

  // 用下标循环而不是 forEach：表格分支一次要吞掉表头 + 分隔行 + 若干数据行。
  let idx = 0;
  while (idx < lines.length) {
    const line = lines[idx];
    const trimmed = line.trim();

    if (!trimmed) {
      flushList();
      idx += 1;
      continue;
    }

    // GFM 表格：当前行以 | 开头，且下一行是形如 | --- | :---: | 的分隔行。
    if (trimmed.startsWith('|') && idx + 1 < lines.length && isTableSeparatorRow(lines[idx + 1])) {
      flushList();
      const headerCells = splitTableRow(trimmed);
      const alignCells = splitTableRow(lines[idx + 1]);
      const aligns = headerCells.map((_, i) => alignOf(alignCells[i] ?? ''));
      const rows: string[][] = [];
      idx += 2;
      while (idx < lines.length && lines[idx].trim().startsWith('|')) {
        rows.push(splitTableRow(lines[idx]));
        idx += 1;
      }
      elements.push(
        <MarkdownTable
          key={`table-${elements.length}`}
          header={headerCells}
          aligns={aligns}
          rows={rows}
        />
      );
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushList();
      const level = headingMatch[1].length;
      // 标题阶梯：靠字号与字距拉开层级（本机 Win10 无 Segoe UI Variable，不能靠可变字重）。
      const sizes: Record<number, string> = {
        1: 'text-[20px] font-bold',
        2: 'text-[17px] font-semibold',
        3: 'text-[length:var(--font-subtitle)] font-semibold',
        4: 'text-[length:var(--font-chat)] font-semibold',
        5: 'text-[length:var(--font-body)] font-semibold',
        6: 'text-[length:var(--font-body)] font-semibold',
      };
      const sizeClass = sizes[level] || 'text-[length:var(--font-body)] font-semibold';
      const HeadingTag = `h${Math.min(level, 6)}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      elements.push(<HeadingTag key={idx} className={`${sizeClass} mt-4 mb-2 tracking-[var(--tracking-tight)] text-primary-custom`}>{renderInline(headingMatch[2])}</HeadingTag>);
      idx += 1;
      continue;
    }

    const ulMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (ulMatch) {
      if (!inList || listType !== 'ul') flushList();
      inList = true;
      listType = 'ul';
      listItems.push(<li key={idx} className="prose-body break-words text-primary-custom/90 [overflow-wrap:anywhere]">{renderInline(ulMatch[1])}</li>);
      idx += 1;
      continue;
    }

    const olMatch = trimmed.match(/^\d+\.\s+(.+)$/);
    if (olMatch) {
      if (!inList || listType !== 'ol') flushList();
      inList = true;
      listType = 'ol';
      listItems.push(<li key={idx} className="prose-body break-words text-primary-custom/90 [overflow-wrap:anywhere]">{renderInline(olMatch[1])}</li>);
      idx += 1;
      continue;
    }

    if (trimmed.startsWith('>')) {
      flushList();
      elements.push(
        <blockquote key={idx} className="prose-body my-2 break-words border-l-2 border-[var(--accent)] pl-3 text-secondary-custom italic [overflow-wrap:anywhere]">
          {renderInline(trimmed.slice(1).trim())}
        </blockquote>
      );
      idx += 1;
      continue;
    }

    if (trimmed.match(/^---+$/)) {
      flushList();
      elements.push(<hr key={idx} className="my-4 border-[var(--border)]" />);
      idx += 1;
      continue;
    }

    flushList();
    elements.push(<p key={idx} className="prose-body my-1.5 whitespace-pre-wrap break-words text-primary-custom/90 [overflow-wrap:anywhere]">{renderInline(trimmed)}</p>);
    idx += 1;
  }

  flushList();

  return <>{elements}</>;
}

/** 分隔行（| --- | :---: |）判定：去掉首尾管道后每个格子都是 3 个以上的 -（允许对齐冒号）。 */
function isTableSeparatorRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('-')) return false;
  const cells = splitTableRow(trimmed);
  return cells.length > 0 && cells.every((cell) => /^[\s:]*-{3,}[\s:]*$/.test(cell));
}

/** 拆一行表格为单元格（去首尾管道后按 | 切分；单元格内的转义管道等边缘情况不作处理）。 */
function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function alignOf(separatorCell: string): 'left' | 'center' | 'right' {
  const left = separatorCell.startsWith(':');
  const right = separatorCell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  return 'left';
}

function MarkdownTable({
  header,
  aligns,
  rows,
}: {
  header: string[];
  aligns: Array<'left' | 'center' | 'right'>;
  rows: string[][];
}) {
  return (
    <div className="my-3 max-w-full overflow-x-auto rounded-[var(--radius-field)] border border-[var(--border)] dark:border-white/[0.08]">
      <table className="w-full border-collapse text-[length:var(--font-body)] leading-[var(--leading-code)] [font-variant-numeric:tabular-nums]">
        <thead>
          <tr className="bg-[var(--surface-muted)] dark:bg-[var(--surface-hover)]">
            {header.map((cell, i) => (
              <th
                key={i}
                className="border-b border-[var(--border)] px-3 py-2 text-left font-semibold text-primary-custom dark:border-white/[0.08]"
                style={{ textAlign: aligns[i] }}
              >
                {renderInline(cell)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} className="border-b border-[var(--border)] last:border-b-0 dark:border-white/[0.06]">
              {header.map((_, i) => (
                <td
                  key={i}
                  className="px-3 py-1.5 align-top text-primary-custom/90 [overflow-wrap:anywhere]"
                  style={{ textAlign: aligns[i] }}
                >
                  {renderInline(row[i] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const regex = /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|~~(.+?)~~|\[(.+?)\]\((.+?)\))/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(<span key={lastIndex}>{text.slice(lastIndex, match.index)}</span>);
    }

    if (match[2]) {
      parts.push(<strong key={match.index} className="italic font-bold">{match[2]}</strong>);
    } else if (match[3]) {
      parts.push(<strong key={match.index} className="font-bold text-primary-custom">{match[3]}</strong>);
    } else if (match[4]) {
      parts.push(<em key={match.index} className="italic">{match[4]}</em>);
    } else if (match[5]) {
      parts.push(
        <code key={match.index} className="mono-font rounded-[var(--radius-sm)] bg-[var(--surface-muted)] px-1.5 py-0.5 text-[length:var(--font-body)] text-[var(--accent)] break-words [overflow-wrap:anywhere] dark:bg-[var(--surface-raised)]">
          {match[5]}
        </code>
      );
    } else if (match[6]) {
      parts.push(<del key={match.index} className="line-through text-secondary-custom">{match[6]}</del>);
    } else if (match[7] && match[8]) {
      const safeHref = safeLinkHref(match[8]);
      if (!safeHref) {
        parts.push(<span key={match.index}>{match[7]}</span>);
        lastIndex = match.index + match[0].length;
        continue;
      }
      parts.push(
        <a key={match.index} href={safeHref} target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] hover:underline">
          {match[7]}
        </a>
      );
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(<span key={lastIndex}>{text.slice(lastIndex)}</span>);
  }

  if (parts.length === 0) {
    return text;
  }

  return <>{parts}</>;
}

function safeLinkHref(rawHref: string) {
  const href = rawHref.trim();
  if (!href) return null;

  try {
    const url = new URL(href, window.location.origin);
    if (['http:', 'https:', 'mailto:'].includes(url.protocol)) {
      return href;
    }
  } catch {
    return null;
  }

  return null;
}
