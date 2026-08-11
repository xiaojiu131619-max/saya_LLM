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
    <div className="markdown-body min-w-0 max-w-full text-[16px] leading-8 text-primary-custom">
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
    <div className="my-3 max-w-full overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] dark:border-white/[0.08] dark:bg-[var(--surface)]">
      <div className="flex items-center justify-between border-b border-[var(--border)] bg-[#ECE6DB] px-4 py-2 dark:border-white/[0.08] dark:bg-[var(--surface-hover)]">
        <span className="mono-font text-[12px] uppercase text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">{lang}</span>
        <button
          onClick={handleCopy}
          className={`flex items-center gap-1.5 text-[12px] transition-colors ${
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
      <pre className="grid max-w-full grid-cols-[auto_minmax(0,1fr)] gap-3 overflow-x-hidden p-4 text-[14px] leading-7">
        <span
          aria-hidden="true"
          className="mono-font select-none whitespace-pre text-right text-[var(--text-tertiary)] dark:text-[var(--text-tertiary)]"
        >
          {codeLines.map((_, index) => index + 1).join('\n')}
        </span>
        <code
          className="hljs mono-font min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[var(--text-primary)] dark:text-[var(--border)]"
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

  return (
    <div
      className="my-3 max-w-full overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface-muted)] dark:border-white/[0.08] dark:bg-white/[0.05]"
      style={{ overflowAnchor: 'none' }}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] dark:text-[var(--text-secondary)] dark:hover:bg-white/[0.08]"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Brain className="h-3.5 w-3.5 flex-shrink-0 text-[var(--accent)]" />
          <span className="truncate">思考内容</span>
          <span className="flex-shrink-0 rounded-full border border-[var(--border)] bg-[var(--app-bg)] px-1.5 py-px text-[11px] text-[var(--text-secondary)] dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-[var(--text-secondary)]">
            {lineCount} 行
          </span>
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 flex-shrink-0 transition-transform ${expanded ? 'rotate-180' : 'rotate-0'}`}
        />
      </button>

      {!expanded && (
        <div
          aria-hidden="true"
          className="relative overflow-hidden"
          style={{ height: 'calc(1.75rem * 2 + 0.75rem)' }}
        >
          <div className="absolute inset-x-0 bottom-0 whitespace-pre-wrap break-words px-3 pb-2 text-[15px] leading-7 text-[var(--text-secondary)] [overflow-wrap:anywhere] dark:text-[var(--text-secondary)]">
            {trimmed}
          </div>
        </div>
      )}

      {expanded && (
        <div className="whitespace-pre-wrap break-words px-3 pb-3 text-[15px] leading-8 text-[var(--text-secondary)] [overflow-wrap:anywhere] dark:text-[var(--text-secondary)]">
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

  lines.forEach((line, idx) => {
    const trimmed = line.trim();

    if (!trimmed) {
      flushList();
      return;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushList();
      const level = headingMatch[1].length;
      const sizes: Record<number, string> = { 1: 'text-xl', 2: 'text-lg', 3: 'text-base', 4: 'text-base', 5: 'text-sm', 6: 'text-sm' };
      const sizeClass = sizes[level] || 'text-sm';
      const HeadingTag = `h${Math.min(level, 6)}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      elements.push(<HeadingTag key={idx} className={`${sizeClass} font-semibold mt-4 mb-2 text-primary-custom`}>{renderInline(headingMatch[2])}</HeadingTag>);
      return;
    }

    const ulMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (ulMatch) {
      if (!inList || listType !== 'ul') flushList();
      inList = true;
      listType = 'ul';
      listItems.push(<li key={idx} className="break-words text-[16px] leading-8 text-primary-custom/90 [overflow-wrap:anywhere]">{renderInline(ulMatch[1])}</li>);
      return;
    }

    const olMatch = trimmed.match(/^\d+\.\s+(.+)$/);
    if (olMatch) {
      if (!inList || listType !== 'ol') flushList();
      inList = true;
      listType = 'ol';
      listItems.push(<li key={idx} className="break-words text-[16px] leading-8 text-primary-custom/90 [overflow-wrap:anywhere]">{renderInline(olMatch[1])}</li>);
      return;
    }

    if (trimmed.startsWith('>')) {
      flushList();
      elements.push(
        <blockquote key={idx} className="my-2 break-words border-l-2 border-[var(--accent)] pl-3 text-[16px] leading-8 text-secondary-custom italic [overflow-wrap:anywhere]">
          {renderInline(trimmed.slice(1).trim())}
        </blockquote>
      );
      return;
    }

    if (trimmed.match(/^---+$/)) {
      flushList();
      elements.push(<hr key={idx} className="my-4 border-white/10" />);
      return;
    }

    flushList();
    elements.push(<p key={idx} className="my-1.5 whitespace-pre-wrap break-words text-[16px] leading-8 text-primary-custom/90 [overflow-wrap:anywhere]">{renderInline(trimmed)}</p>);
  });

  flushList();

  return <>{elements}</>;
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
        <code key={match.index} className="mono-font rounded-md bg-[var(--state-danger-bg)] px-1.5 py-0.5 text-[14px] text-[var(--accent)] break-words [overflow-wrap:anywhere] dark:bg-[var(--surface-raised)] dark:text-[var(--accent)]">
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
