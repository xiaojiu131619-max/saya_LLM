import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ExternalLink,
  FileText,
  FolderOpen,
  GitBranch,
  Image as ImageIcon,
  Infinity as InfinityIcon,
  Loader2,
  Package,
} from 'lucide-react';
import type { AgentArtifact, MindMapNode } from '@/types';
import { fileExtension, formatFileSize } from '@/features/chat/chatUtils';
import { parseMindMap, type ParsedMindMap } from '@/features/chat/mindmap';
import MindMapPreview from './MindMapPreview';
import {
  canvasGetSummary,
  canvasOpenWindow,
  canvasStart,
  isDesktopRuntime,
  openExternalUrl,
  piReadArtifact,
  revealDesktopPath,
} from '@/lib/desktop';

/**
 * Pi 产物卡（气泡内在步骤面板之后渲染）。
 *
 * 约束：
 * - 消息里只存相对路径与元数据，图片在卡片可见时按需读取；
 * - 图片 data URL 只留在本组件内存，不写回 Message / localStorage；
 * - 文件类只给「打开位置」，不做任意类型预览；link 只允许 http/https。
 */

interface ArtifactPanelProps {
  artifacts: AgentArtifact[];
  /** Pi 会话工作区目录（来自 `PiAgentStatus.work_dir`），用于拼出可 reveal 的绝对路径。 */
  sandboxDir?: string;
  /** 图片异步加载后高度会变，通知虚拟列表重新测量。 */
  onResize?: () => void;
}

function joinSandboxPath(root: string | undefined, relPath: string | undefined): string | null {
  if (!root || !relPath) return null;
  const separator = root.includes('\\') ? '\\' : '/';
  const cleaned = relPath
    .split(/[\\/]+/)
    .filter(Boolean)
    .join(separator);
  if (!cleaned) return null;
  return `${root.replace(/[\\/]+$/, '')}${separator}${cleaned}`;
}

function kindLabel(artifact: AgentArtifact): string {
  if (artifact.kind === 'mindmap') return '思维导图';
  const extension = fileExtension(artifact.path || artifact.title || '');
  if (extension === 'pdf') return 'PDF';
  if (extension) return extension.toUpperCase();
  return '文件';
}

function readErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/不存在/.test(text)) return '文件已不存在';
  return text || '读取失败';
}

function useReveal(sandboxDir: string | undefined, artifact: AgentArtifact) {
  const [error, setError] = useState<string | null>(null);
  const absolutePath = joinSandboxPath(sandboxDir, artifact.path);

  const reveal = async () => {
    if (!absolutePath) return;
    setError(null);
    try {
      await revealDesktopPath(absolutePath);
    } catch (reason) {
      setError(readErrorText(reason));
    }
  };

  return { absolutePath, error, reveal };
}

/** 画布联动：打开（必要时启动）无限画布，用画布续作 Pi 生成的图。 */
function OpenInCanvasButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const summary = await canvasGetSummary();
      if (!summary?.running) {
        // 未运行：canvasStart 会按用户配置自动打开独立窗口或系统浏览器。
        await canvasStart();
      } else {
        await canvasOpenWindow();
      }
    } catch (reason) {
      setError(readErrorText(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex flex-shrink-0 items-center gap-1.5">
      <button
        type="button"
        onClick={() => void open()}
        disabled={busy || !isDesktopRuntime()}
        className="inline-flex items-center gap-1 rounded-[var(--radius-field)] border border-[var(--border)] px-2.5 py-1.5 text-[length:var(--font-caption)] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] disabled:opacity-45 disabled:cursor-not-allowed dark:hover:bg-white/[0.07]"
        title="打开（必要时启动）无限画布：产物图片已保存在 Pi 会话工作区的 canvas/ 目录，可在画布里导入续作"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <InfinityIcon className="h-3.5 w-3.5" />}
        画布续作
      </button>
      {error && (
        <span className="max-w-40 truncate text-[length:var(--font-caption)] text-[var(--state-danger)]" title={error}>
          {error}
        </span>
      )}
    </span>
  );
}

export default function ArtifactPanel({ artifacts, sandboxDir, onResize }: ArtifactPanelProps) {
  if (artifacts.length === 0) return null;
  return (
    <section className="min-w-0 space-y-2" aria-label="产物">
      <div className="flex items-center gap-1.5 text-[length:var(--font-caption)] font-medium text-[var(--text-secondary)]">
        <Package className="h-3.5 w-3.5 text-[var(--accent)]" />
        <span>产物</span>
        <span className="rounded-[var(--radius-sm)] bg-[var(--accent-subtle)] px-1.5 py-0.5 text-[length:var(--font-eyebrow)] text-[var(--accent)]">
          {artifacts.length}
        </span>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        {artifacts.map((artifact, index) => {
          const key = `${artifact.kind}-${artifact.path ?? artifact.url ?? artifact.title}-${artifact.mtime ?? ''}-${index}`;
          if (artifact.kind === 'image') {
            return <ImageArtifactCard key={key} artifact={artifact} sandboxDir={sandboxDir} onResize={onResize} />;
          }
          if (artifact.kind === 'link') {
            return <LinkArtifactCard key={key} artifact={artifact} />;
          }
          if (artifact.kind === 'mindmap') {
            return (
              <MindMapArtifactCard
                key={key}
                artifact={artifact}
                sandboxDir={sandboxDir}
                onResize={onResize}
              />
            );
          }
          if (fileExtension(artifact.path || artifact.title || '') === 'pdf') {
            return (
              <PdfArtifactCard
                key={key}
                artifact={artifact}
                sandboxDir={sandboxDir}
                onResize={onResize}
              />
            );
          }
          return <FileArtifactCard key={key} artifact={artifact} sandboxDir={sandboxDir} />;
        })}
      </div>
    </section>
  );
}

/** 普通文件：只给「打开位置」，不做任意类型预览。 */
function FileArtifactCard({ artifact, sandboxDir }: { artifact: AgentArtifact; sandboxDir?: string }) {
  const { absolutePath, error, reveal } = useReveal(sandboxDir, artifact);
  const Icon = artifact.kind === 'mindmap' ? GitBranch : FileText;

  return (
    <div className="min-w-0 overflow-hidden rounded-[var(--radius-field)] border border-[var(--border)] bg-[var(--surface)]">
      <div className="flex min-w-0 items-center gap-3 px-3 py-2.5">
        <span className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-[var(--radius-field)] bg-black/[0.045] text-[var(--accent)] dark:bg-white/[0.06]">
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[length:var(--font-body)] font-medium text-[var(--text-primary)]" title={artifact.title}>
            {artifact.title}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[length:var(--font-caption)] text-[var(--text-tertiary)]">
            <span>{kindLabel(artifact)}</span>
            {typeof artifact.size === 'number' && artifact.size >= 0 && (
              <span>{formatFileSize(artifact.size)}</span>
            )}
            {artifact.duplicate && (
              <span className="text-[var(--state-warning)]">同名文件取最新</span>
            )}
            {!artifact.path && <span className="text-[var(--state-danger)]">文件已不存在</span>}
          </div>
        </div>
        {absolutePath && (
          <button
            type="button"
            onClick={() => void reveal()}
            className="inline-flex flex-shrink-0 items-center gap-1 rounded-[var(--radius-field)] border border-[var(--border)] px-2.5 py-1.5 text-[length:var(--font-caption)] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] dark:hover:bg-white/[0.07]"
            title="在资源管理器中打开所在位置"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            打开位置
          </button>
        )}
      </div>
      {error && (
        <p className="border-t border-[var(--border)] px-3 py-1.5 text-[length:var(--font-caption)] text-[var(--state-danger)]">
          {error}
        </p>
      )}
    </div>
  );
}

/** PDF：宿主校验文件头后以 data URL 返回，内嵌 WebView 的 PDF 阅读器预览。 */
function PdfArtifactCard({
  artifact,
  sandboxDir,
  onResize,
}: {
  artifact: AgentArtifact;
  sandboxDir?: string;
  onResize?: () => void;
}) {
  const { absolutePath, error: revealError, reveal } = useReveal(sandboxDir, artifact);
  const unavailableMessage = !artifact.path
    ? '文件已不存在'
    : !isDesktopRuntime()
      ? '仅桌面版可预览 PDF。'
      : null;
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; dataUrl: string }
    | { status: 'error'; message: string }
  >(unavailableMessage ? { status: 'error', message: unavailableMessage } : { status: 'loading' });
  const onResizeRef = useRef(onResize);
  useEffect(() => {
    onResizeRef.current = onResize;
  }, [onResize]);

  useEffect(() => {
    if (unavailableMessage || !artifact.path) return;

    let cancelled = false;
    piReadArtifact(artifact.path, sandboxDir)
      .then((payload) => {
        if (cancelled) return;
        if (payload?.kind === 'pdf' && payload.dataUrl) {
          setState({ status: 'ready', dataUrl: payload.dataUrl });
        } else {
          setState({ status: 'error', message: '产物不是可预览的 PDF。' });
        }
      })
      .catch((reason) => {
        if (!cancelled) setState({ status: 'error', message: readErrorText(reason) });
      });

    return () => {
      cancelled = true;
    };
  }, [artifact.path, sandboxDir, unavailableMessage]);

  useEffect(() => {
    onResizeRef.current?.();
  }, [state.status]);

  return (
    <div className="min-w-0 overflow-hidden rounded-[var(--radius-field)] border border-[var(--border)] bg-[var(--surface)]">
      <div className="flex min-w-0 items-center gap-3 px-3 py-2.5">
        <span className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-[var(--radius-field)] bg-black/[0.045] text-[var(--accent)] dark:bg-white/[0.06]">
          <FileText className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[length:var(--font-body)] font-medium text-[var(--text-primary)]" title={artifact.title}>
            {artifact.title}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[length:var(--font-caption)] text-[var(--text-tertiary)]">
            <span>PDF</span>
            {typeof artifact.size === 'number' && artifact.size >= 0 && (
              <span>{formatFileSize(artifact.size)}</span>
            )}
            {artifact.magicOk === false && (
              <span className="text-[var(--state-danger)]">
                文件头不是 PDF（{artifact.magic ?? '无法识别'}）
              </span>
            )}
            {artifact.duplicate && (
              <span className="text-[var(--state-warning)]">同名文件取最新</span>
            )}
          </div>
        </div>
        {absolutePath && (
          <button
            type="button"
            onClick={() => void reveal()}
            className="inline-flex flex-shrink-0 items-center gap-1 rounded-[var(--radius-field)] border border-[var(--border)] px-2.5 py-1.5 text-[length:var(--font-caption)] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] dark:hover:bg-white/[0.07]"
            title="在资源管理器中打开所在位置"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            打开位置
          </button>
        )}
      </div>

      <div className="border-t border-[var(--border)]">
        {state.status === 'loading' && (
          <div className="flex items-center gap-2 px-3 py-4 text-[length:var(--font-caption)] text-[var(--text-tertiary)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            正在读取 PDF…
          </div>
        )}
        {state.status === 'error' && (
          <div className="flex items-center gap-2 px-3 py-3 text-[length:var(--font-caption)] text-[var(--state-danger)]">
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
            <span>{state.message}</span>
          </div>
        )}
        {state.status === 'ready' && (
          <>
            <iframe
              title={`PDF 预览：${artifact.title}`}
              src={state.dataUrl}
              className="h-[420px] w-full bg-[var(--surface-muted)]"
              onLoad={() => onResizeRef.current?.()}
            />
            <p className="border-t border-[var(--border)] px-3 py-1.5 text-[length:var(--font-caption)] text-[var(--text-tertiary)]">
              若预览空白，请点「打开位置」用系统 PDF 阅读器打开。
            </p>
          </>
        )}
      </div>
      {revealError && (
        <p className="border-t border-[var(--border)] px-3 py-1.5 text-[length:var(--font-caption)] text-[var(--state-danger)]">
          {revealError}
        </p>
      )}
    </div>
  );
}

/** 思维导图：优先用消息里的树，其次读取 .mmd / .mermaid / .mindmap 文件解析。 */
function MindMapArtifactCard({
  artifact,
  sandboxDir,
  onResize,
}: {
  artifact: AgentArtifact;
  sandboxDir?: string;
  onResize?: () => void;
}) {
  const { absolutePath, error: revealError, reveal } = useReveal(sandboxDir, artifact);
  const extension = fileExtension(artifact.path || artifact.title || '');
  const inline = useMemo<ParsedMindMap | null>(
    () =>
      artifact.mindmap
        ? {
            root: artifact.mindmap,
            format: 'json',
            nodeCount: countNodes(artifact.mindmap),
            truncated: false,
            error: '',
          }
        : null,
    [artifact.mindmap],
  );
  const unavailableMessage = !inline && !artifact.path
    ? '文件已不存在'
    : !inline && !isDesktopRuntime()
      ? '仅桌面版可读取思维导图文件。'
      : null;
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; parsed: ParsedMindMap }
    | { status: 'error'; message: string }
  >(
    inline
      ? { status: 'ready', parsed: inline }
      : unavailableMessage
        ? { status: 'error', message: unavailableMessage }
        : { status: 'loading' },
  );
  const onResizeRef = useRef(onResize);
  useEffect(() => {
    onResizeRef.current = onResize;
  }, [onResize]);

  useEffect(() => {
    if (inline || unavailableMessage || !artifact.path) return;

    let cancelled = false;
    piReadArtifact(artifact.path, sandboxDir)
      .then((payload) => {
        if (cancelled) return;
        if (payload?.kind !== 'text' || typeof payload.text !== 'string') {
          setState({ status: 'error', message: '思维导图文件不是可读取的文本。' });
          return;
        }
        const parsed = parseMindMap(payload.text, extension);
        if (!parsed.root) {
          setState({ status: 'error', message: parsed.error || '没有识别到导图结构。' });
          return;
        }
        setState({ status: 'ready', parsed });
      })
      .catch((reason) => {
        if (!cancelled) setState({ status: 'error', message: readErrorText(reason) });
      });

    return () => {
      cancelled = true;
    };
  }, [artifact.path, sandboxDir, extension, inline, unavailableMessage]);

  useEffect(() => {
    onResizeRef.current?.();
  }, [state.status]);

  const parsed = state.status === 'ready' ? state.parsed : null;

  return (
    <div className="min-w-0 overflow-hidden rounded-[var(--radius-field)] border border-[var(--border)] bg-[var(--surface)]">
      <div className="flex min-w-0 items-center gap-3 px-3 py-2.5">
        <span className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-[var(--radius-field)] bg-black/[0.045] text-[var(--accent)] dark:bg-white/[0.06]">
          <GitBranch className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[length:var(--font-body)] font-medium text-[var(--text-primary)]" title={artifact.title}>
            {artifact.title}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[length:var(--font-caption)] text-[var(--text-tertiary)]">
            <span>思维导图</span>
            {parsed && <span>{parsed.nodeCount} 个节点</span>}
            {parsed?.truncated && (
              <span className="text-[var(--state-warning)]">节点过多，已截断</span>
            )}
            {artifact.duplicate && (
              <span className="text-[var(--state-warning)]">同名文件取最新</span>
            )}
          </div>
        </div>
        {absolutePath && (
          <button
            type="button"
            onClick={() => void reveal()}
            className="inline-flex flex-shrink-0 items-center gap-1 rounded-[var(--radius-field)] border border-[var(--border)] px-2.5 py-1.5 text-[length:var(--font-caption)] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] dark:hover:bg-white/[0.07]"
            title="在资源管理器中打开所在位置"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            打开位置
          </button>
        )}
      </div>

      <div className="border-t border-[var(--border)]">
        {state.status === 'loading' && (
          <div className="flex items-center gap-2 px-3 py-4 text-[length:var(--font-caption)] text-[var(--text-tertiary)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            正在读取思维导图…
          </div>
        )}
        {state.status === 'error' && (
          <div className="flex items-center gap-2 px-3 py-3 text-[length:var(--font-caption)] text-[var(--state-danger)]">
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
            <span>{state.message}</span>
          </div>
        )}
        {parsed?.root && <MindMapPreview root={parsed.root} />}
      </div>
      {revealError && (
        <p className="border-t border-[var(--border)] px-3 py-1.5 text-[length:var(--font-caption)] text-[var(--state-danger)]">
          {revealError}
        </p>
      )}
    </div>
  );
}

function countNodes(node: MindMapNode): number {
  const children = node.children ?? [];
  return 1 + children.reduce((total, child) => total + countNodes(child), 0);
}

function LinkArtifactCard({ artifact }: { artifact: AgentArtifact }) {
  const [error, setError] = useState<string | null>(null);
  const url = artifact.url ?? '';
  const open = async () => {
    setError(null);
    try {
      await openExternalUrl(url);
    } catch (reason) {
      setError(readErrorText(reason));
    }
  };

  return (
    <div className="min-w-0 overflow-hidden rounded-[var(--radius-field)] border border-[var(--border)] bg-[var(--surface)]">
      <div className="flex min-w-0 items-center gap-3 px-3 py-2.5">
        <span className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-[var(--radius-field)] bg-black/[0.045] text-[var(--accent)] dark:bg-white/[0.06]">
          <ExternalLink className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[length:var(--font-body)] font-medium text-[var(--text-primary)]" title={artifact.title}>
            {artifact.title}
          </div>
          <div className="truncate text-[length:var(--font-caption)] text-[var(--text-tertiary)]" title={url}>
            {url}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void open()}
          className="inline-flex flex-shrink-0 items-center gap-1 rounded-[var(--radius-field)] border border-[var(--border)] px-2.5 py-1.5 text-[length:var(--font-caption)] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] dark:hover:bg-white/[0.07]"
          title="用默认浏览器打开链接"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          打开
        </button>
      </div>
      {error && (
        <p className="border-t border-[var(--border)] px-3 py-1.5 text-[length:var(--font-caption)] text-[var(--state-danger)]">
          {error}
        </p>
      )}
    </div>
  );
}

function ImageArtifactCard({
  artifact,
  sandboxDir,
  onResize,
}: {
  artifact: AgentArtifact;
  sandboxDir?: string;
  onResize?: () => void;
}) {
  const { absolutePath, error: revealError, reveal } = useReveal(sandboxDir, artifact);
  const unavailableMessage = !artifact.path
    ? '文件已不存在'
    : !isDesktopRuntime()
      ? '仅桌面版可读取产物图片。'
      : null;
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; dataUrl: string }
    | { status: 'error'; message: string }
  >(unavailableMessage ? { status: 'error', message: unavailableMessage } : { status: 'loading' });
  const onResizeRef = useRef(onResize);
  useEffect(() => {
    onResizeRef.current = onResize;
  }, [onResize]);

  useEffect(() => {
    if (unavailableMessage || !artifact.path) return;

    let cancelled = false;
    piReadArtifact(artifact.path, sandboxDir)
      .then((payload) => {
        if (cancelled) return;
        if (payload?.kind === 'image' && payload.dataUrl) {
          setState({ status: 'ready', dataUrl: payload.dataUrl });
        } else {
          setState({ status: 'error', message: '产物不是可显示的图片。' });
        }
      })
      .catch((reason) => {
        if (!cancelled) setState({ status: 'error', message: readErrorText(reason) });
      });

    return () => {
      cancelled = true;
    };
  }, [artifact.path, sandboxDir, unavailableMessage]);

  // 图片状态变化会改变卡片高度：通知虚拟列表重新测量，避免行重叠。
  useEffect(() => {
    onResizeRef.current?.();
  }, [state.status]);

  return (
    <div className="min-w-0 overflow-hidden rounded-[var(--radius-field)] border border-[var(--border)] bg-[var(--surface)]">
      <div className="flex min-w-0 items-center gap-3 px-3 py-2.5">
        <span className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-[var(--radius-field)] bg-black/[0.045] text-[var(--accent)] dark:bg-white/[0.06]">
          <ImageIcon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[length:var(--font-body)] font-medium text-[var(--text-primary)]" title={artifact.title}>
            {artifact.title}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[length:var(--font-caption)] text-[var(--text-tertiary)]">
            <span>图片</span>
            {typeof artifact.size === 'number' && artifact.size >= 0 && (
              <span>{formatFileSize(artifact.size)}</span>
            )}
            {artifact.duplicate && (
              <span className="text-[var(--state-warning)]">同名文件取最新</span>
            )}
          </div>
        </div>
        {absolutePath && (
          <OpenInCanvasButton />
        )}
        {absolutePath && (
          <button
            type="button"
            onClick={() => void reveal()}
            className="inline-flex flex-shrink-0 items-center gap-1 rounded-[var(--radius-field)] border border-[var(--border)] px-2.5 py-1.5 text-[length:var(--font-caption)] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] dark:hover:bg-white/[0.07]"
            title="在资源管理器中打开所在位置"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            打开位置
          </button>
        )}
      </div>

      <div className="border-t border-[var(--border)]">
        {state.status === 'loading' && (
          <div className="flex items-center gap-2 px-3 py-4 text-[length:var(--font-caption)] text-[var(--text-tertiary)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            正在读取图片…
          </div>
        )}
        {state.status === 'error' && (
          <div className="flex items-center gap-2 px-3 py-3 text-[length:var(--font-caption)] text-[var(--state-danger)]">
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
            <span>{state.message}</span>
          </div>
        )}
        {state.status === 'ready' && (
          <img
            src={state.dataUrl}
            alt={artifact.title}
            className="max-h-[320px] w-full bg-black/[0.03] object-contain dark:bg-white/[0.03]"
            onLoad={() => onResizeRef.current?.()}
          />
        )}
      </div>
      {revealError && (
        <p className="border-t border-[var(--border)] px-3 py-1.5 text-[length:var(--font-caption)] text-[var(--state-danger)]">
          {revealError}
        </p>
      )}
    </div>
  );
}
