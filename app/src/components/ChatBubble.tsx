import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import {
  AlertTriangle,
  Bookmark,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Download,
  FilePen,
  FilePlus2,
  FileSearch,
  FileType2,
  FolderOpen,
  Gauge,
  Image as ImageIcon,
  Languages,
  Loader2,
  Pencil,
  Plug,
  RotateCcw,
  Sheet,
  Sparkles,
  SquareTerminal,
  Trash2,
  Wrench,
  XCircle,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { Message, ToolActivity } from '@/types';
import { useApp } from '@/context/AppContext';
import { judgeDelivery } from '@/features/chat/deliveryGuard';
import MarkdownRenderer, { ThoughtBlock } from './MarkdownRenderer';
import ArtifactPanel from './ArtifactPanel';
import ConfirmDialog from './ConfirmDialog';
import { isDesktopRuntime, partialMetricsFromError, piChangesRollback, serverErrorHint, streamChatCompletion } from '@/lib/desktop';
import { modelVideoSupport } from '@/lib/modelCapabilities';
import { reasoningProfileFromModel } from '@/lib/reasoningGears';
import { formatSessionCtxUsage } from '@/features/chat/chatUtils';
import { formatToolArguments } from '@/features/chat/mcpTools';

interface ChatBubbleProps {
  message: Message;
  modelId: string;
  sessionId: string;
  sessionModelName?: string;
  sessionModelColor?: string;
  /** 该条消息为止的本地会话累计水位（估算），与侧边栏服务状态同口径。 */
  sessionCtx?: { used: number; total: number };
  /** 会话内搜索词：命中处会高亮。空 = 不搜索。 */
  searchQuery?: string;
  /** 本条消息是否为当前搜索跳转的目标（给出更醒目的描边）。 */
  searchActive?: boolean;
  onEditAndResend?: (messageId: string, content: string) => Promise<void> | void;
  /** Pi 会话工作区目录：产物卡拼绝对路径用。 */
  artifactSandboxDir?: string;
  /** 产物图异步加载后通知外层重新测量行高。 */
  onContentResize?: () => void;
  /** 是否允许「重新生成」；Agent 工作区的轮次不走补全流，默认关闭。 */
  allowRegenerate?: boolean;
}

function formatMetric(value: number, suffix = '') {
  // 终止 / 异常的回复没有测速数据：统一用 -- 占位，与整行的占位口径一致。
  if (!Number.isFinite(value) || value <= 0) return `--${suffix}`;
  return `${value.toFixed(value >= 10 ? 1 : 2)}${suffix}`;
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0.0 秒';
  const totalSeconds = Math.floor(seconds);
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 1 : 2)} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const rest = totalSeconds % 60;
  return `${minutes} 分 ${String(rest).padStart(2, '0')} 秒`;
}

// 紧凑秒数格式：用于"生成耗时"等行内 Metric。
// <60s → "12.3s"；>=60s → "2m5s"。
function formatSecondsShort(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 1 : 2)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m${rest}s`;
}

function elapsedRequestStats(startTime: number, ctxTotal = 0) {
  return {
    ctxUsed: 0,
    ctxTotal,
    outputTokens: 0,
    firstTokenDelay: 0,
    tokensPerSec: 0,
    genTime: Math.max(0, (performance.now() - startTime) / 1000),
  };
}

/** 终止 / 失败时落定的统计：真实耗时 + 中止前流式已产生的部分测量值（有什么写什么）。 */
function terminatedRequestStats(error: unknown, startTime: number, ctxTotal = 0) {
  const stats = elapsedRequestStats(startTime, ctxTotal);
  const partial = partialMetricsFromError(error);
  if (!partial) return stats;
  return {
    ...stats,
    ...(Number(partial.completionTokens) > 0 ? { outputTokens: Math.round(Number(partial.completionTokens)) } : {}),
    ...(Number(partial.firstTokenDelay) > 0 ? { firstTokenDelay: Number(partial.firstTokenDelay) } : {}),
    ...(Number(partial.tokensPerSec) > 0 ? { tokensPerSec: Number(partial.tokensPerSec) } : {}),
  };
}

function formatMessageTime(timestamp: number) {
  return new Date(timestamp).toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function assistantName(modelName?: string) {
  if (!modelName) return '对话者';
  return modelName.length > 18 ? `${modelName.slice(0, 17)}...` : modelName;
}

function outputOnlyContent(content: string) {
  return content
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/<think(?:ing)?>[\s\S]*$/gi, '')
    .trim();
}

export default function ChatBubble({ message, modelId, sessionId, sessionModelName, sessionModelColor, sessionCtx, searchQuery, searchActive, onEditAndResend, artifactSandboxDir, onContentResize, allowRegenerate = true }: ChatBubbleProps) {
  const { state, dispatch } = useApp();
  const isUser = message.role === 'user';
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftContent, setDraftContent] = useState(message.content);
  const [savingEdit, setSavingEdit] = useState(false);
  const [timerNow, setTimerNow] = useState(message.timestamp);
  const ownerModel = state.models.find((m) => m.id === modelId);
  const runtimeModel = state.models.find((m) => m.id === state.activeModelId);
  const activeModel = ownerModel ?? runtimeModel;
  const displayModelName = message.modelName ?? sessionModelName ?? ownerModel?.name ?? '未记录模型';
  const displayModelColor = message.modelColor ?? sessionModelColor ?? ownerModel?.themeColorSolid;
  // 「重新生成」原位替换该条回答（REPLACE_MESSAGE），因此对历史轮次也安全：
  // 旧实现是 DELETE_MESSAGE + ADD_MESSAGE，会把这一轮挪到队尾，消息顺序和之后
  // 每轮发给模型的上下文都会错位；换成原位替换后，后续轮次保持在原有位置。
  const canRegenerate = Boolean(allowRegenerate && isDesktopRuntime() && activeModel?.filePath && state.serverRunning && !message.isStreaming);
  const hasEmbeddedThinking = /<\/?think(?:ing)?>/i.test(message.content);
  const exportContent = message.reasoningContent && !hasEmbeddedThinking
    ? `<think>\n${message.reasoningContent}\n</think>\n\n${message.content}`
    : message.content;
  const copyContent = isUser ? message.content : outputOnlyContent(message.content);

  useEffect(() => {
    if (!message.isStreaming) return;
    const timer = window.setInterval(() => setTimerNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [message.id, message.isStreaming]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(copyContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDelete = () => {
    dispatch({ type: 'DELETE_MESSAGE', payload: { modelId, sessionId, messageId: message.id } });
  };

  const startEdit = () => {
    setDraftContent(message.content);
    setEditing(true);
  };

  const cancelEdit = () => {
    setDraftContent(message.content);
    setEditing(false);
  };

  const submitEdit = async (content: string) => {
    const nextContent = content.trim();
    if (!nextContent || !onEditAndResend || savingEdit) return;
    // 乐观关闭编辑框：发送是长流程（含流式输出），若等 await 完成才关闭，
    // 编辑框会一直挂到本轮输出结束。这里先退出编辑态，立即进入正常输出对话。
    setSavingEdit(true);
    setEditing(false);
    try {
      await onEditAndResend(message.id, nextContent);
    } finally {
      setSavingEdit(false);
    }
  };

  /**
   * 消息操作行：←/→ 在「复制 / 编辑 / 重发 / 删除」之间移动，Home/End 跳首尾。
   * 按钮本身 Tab 可达；方向键让键盘用户不必反复 Tab 穿过整条消息。
   */
  const handleActionRowKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
    if (buttons.length === 0) return;
    event.preventDefault();
    const index = buttons.findIndex((button) => button === document.activeElement);
    let next = 0;
    if (event.key === 'End') next = buttons.length - 1;
    else if (event.key === 'ArrowRight') next = index < 0 ? 0 : (index + 1) % buttons.length;
    else if (event.key === 'ArrowLeft') next = index < 0 ? buttons.length - 1 : (index - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  const handleExport = () => {
    const blob = new Blob([exportContent], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `message-${message.id}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleRegenerate = async () => {
    if (!canRegenerate || !activeModel) return;

    const session = (state.chatSessions[modelId] || []).find((item) => item.id === sessionId);
    const msgs = session?.messages || [];
    const msgIndex = msgs.findIndex((m) => m.id === message.id);
    if (msgIndex <= 0) return;

    let userMsgIndex = -1;
    for (let i = msgIndex - 1; i >= 0; i -= 1) {
      if (msgs[i].role === 'user') {
        userMsgIndex = i;
        break;
      }
    }
    if (userMsgIndex === -1) return;

    const history = msgs.slice(0, userMsgIndex + 1);

    const assistantMsgId = crypto.randomUUID();
    const startedAt = Date.now();
    const startTime = performance.now();
    // 原位替换：保留这条回答在会话中的位置，后续轮次不会被挪动。
    dispatch({
      type: 'REPLACE_MESSAGE',
      payload: {
        modelId,
        sessionId,
        messageId: message.id,
        message: {
          id: assistantMsgId,
          role: 'assistant',
          content: '',
          reasoningContent: '',
          modelId: activeModel.id,
          modelName: activeModel.name,
          modelColor: activeModel.themeColorSolid,
          timestamp: startedAt,
          isStreaming: true,
        },
      },
    });

    let streamedContent = '';
    let reasoningChars = 0;
    try {
      const metrics = await streamChatCompletion({
        port: activeModel.serverPort ?? state.serverPort,
        modelName: activeModel.name,
        config: state.chatConfig,
        ctxTotal: activeModel.loadConfig.ctxLength,
        supportsReasoning: activeModel.tags.includes('Reasoning') || activeModel.loadConfig.reasoningBudget > 0,
        reasoningBudget: activeModel.loadConfig.reasoningBudget,
        reasoningProfile: activeModel.reasoningProfile ?? reasoningProfileFromModel(activeModel),
        videoSupport: modelVideoSupport(activeModel),
        apiKey: state.apiConfig.apiKey,
        messages: history.map((msg) => ({
          role: msg.role,
          content: msg.multimodalContent ?? msg.content,
        })),
        onToken: (token) => {
          streamedContent += token;
          dispatch({
            type: 'UPDATE_MESSAGE',
            payload: { modelId, sessionId, messageId: assistantMsgId, content: streamedContent },
          });
        },
        onReasoningDelta: (reasoningContent) => {
          reasoningChars = reasoningContent.length;
          dispatch({
            type: 'UPDATE_MESSAGE',
            payload: { modelId, sessionId, messageId: assistantMsgId, reasoningContent },
          });
        },
      });

      // 重新生成同样要过交付护栏：这条路径没有工具循环，工具名留空。
      const verdict = judgeDelivery({
        content: streamedContent,
        finishReason: metrics.finishReason,
        reasoningChars,
      });
      dispatch({
        type: 'UPDATE_MESSAGE',
        payload: {
          modelId,
          sessionId,
          messageId: assistantMsgId,
          warnings: verdict.ok ? [] : [verdict.detail],
        },
      });

      if (metrics.totalTokens > 0) {
        dispatch({
          type: 'ADD_USAGE',
          payload: {
            modelId: activeModel.id,
            modelName: activeModel.name,
            modelColor: activeModel.themeColorSolid,
            promptTokens: metrics.promptTokens,
            completionTokens: metrics.completionTokens,
            totalTokens: metrics.totalTokens,
            tokensPerSec: metrics.tokensPerSec,
            firstTokenDelay: metrics.firstTokenDelay,
            genTime: metrics.genTime,
          },
        });
      }
      dispatch({
        type: 'SET_MESSAGE_STREAMING',
        payload: {
          modelId,
          sessionId,
          messageId: assistantMsgId,
          streaming: false,
          stats: {
            ctxUsed: metrics.ctxUsed,
            ctxTotal: metrics.ctxTotal,
            outputTokens: metrics.completionTokens,
            firstTokenDelay: metrics.firstTokenDelay,
            tokensPerSec: metrics.tokensPerSec ?? 0,
            genTime: metrics.genTime,
          },
        },
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      if (aborted) {
        dispatch({
          type: 'SET_MESSAGE_STREAMING',
          payload: {
            modelId,
            sessionId,
            messageId: assistantMsgId,
            streaming: false,
            stats: terminatedRequestStats(error, startTime, activeModel.loadConfig.ctxLength),
          },
        });
        return;
      }
      const errorMessage = `重新生成失败：${String(error instanceof Error ? error.message : error)}\n\n${serverErrorHint(error)}`;
      dispatch({
        type: 'UPDATE_MESSAGE',
        payload: { modelId, sessionId, messageId: assistantMsgId, content: errorMessage, reasoningContent: '' },
      });
      dispatch({
        type: 'SET_MESSAGE_STREAMING',
        payload: {
          modelId,
          sessionId,
          messageId: assistantMsgId,
          streaming: false,
          stats: elapsedRequestStats(startTime, activeModel.loadConfig.ctxLength),
        },
      });
    }
  };

  const stats = message.stats;
  const streamingElapsed = message.isStreaming ? Math.max(0, (timerNow - message.timestamp) / 1000) : 0;

  if (isUser) {
    return (
      <motion.article
        initial={false}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: 10 }}
        className="anim-enter-fade group grid w-full min-w-0 grid-cols-[minmax(0,1fr)] justify-items-end gap-1.5 pb-8"
      >
        <div className="flex max-w-[80%] items-center gap-2 text-[length:var(--font-caption)] text-[var(--text-secondary)]">
          <strong className="font-medium text-[var(--text-primary)] dark:text-[var(--text-secondary)]">你</strong>
          <span>{formatMessageTime(message.timestamp)}</span>
        </div>

        {editing ? (
          <div className="w-full max-w-[80%] rounded-[var(--radius-panel)] border border-black/[0.08] bg-[var(--surface-muted)] p-2 shadow-none dark:border-white/[0.08] dark:bg-[var(--surface-raised)]">
            <textarea
              value={draftContent}
              onChange={(event) => setDraftContent(event.target.value)}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                  event.preventDefault();
                  void submitEdit(draftContent);
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  cancelEdit();
                }
              }}
              rows={Math.min(8, Math.max(3, draftContent.split('\n').length))}
              className="max-h-[220px] min-h-[92px] w-full resize-y rounded-[var(--radius-field)] border border-black/[0.10] bg-white px-3 py-2 text-[length:var(--font-chat)] leading-[1.6] text-[var(--text-primary)] outline-none [overflow-wrap:anywhere] focus:border-black/25 dark:border-white/[0.10] dark:bg-[var(--app-bg)] dark:text-[var(--text-primary)] dark:focus:border-[var(--accent)]/45"
              autoFocus
            />
            <div className="mt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={cancelEdit}
                disabled={savingEdit}
                className="h-8 rounded-[var(--radius-field)] border border-[var(--border)] bg-[var(--surface)] px-3 text-[length:var(--font-body)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.06]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void submitEdit(draftContent)}
                disabled={savingEdit || !draftContent.trim()}
                className="h-8 rounded-[var(--radius-field)] bg-[var(--accent)] px-3 text-[length:var(--font-body)] font-semibold text-[var(--text-on-accent)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
              >
                {savingEdit ? '发送中' : '保存并发送'}
              </button>
            </div>
          </div>
        ) : (
          <div className="max-w-[78%] rounded-[var(--radius-bubble)] bg-black/[0.045] px-4 py-2.5 text-[length:var(--font-chat)] leading-[1.6] text-[var(--text-primary)] dark:bg-white/[0.065]">
            {message.content && (
              <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{message.content}</p>
            )}
            {message.multimodalContent && (
              <MultimodalAttachments parts={message.multimodalContent} />
            )}
          </div>
        )}

        <div
          role="toolbar"
          aria-label="消息操作"
          onKeyDown={handleActionRowKeyDown}
          className="flex items-center gap-0.5 text-[var(--text-tertiary)] opacity-55 transition-opacity group-hover:opacity-100 dark:text-[var(--text-secondary)]"
        >
          <ActionButton icon={copied ? Check : Copy} label={copied ? '已复制' : '复制'} onClick={() => void handleCopy()} />
          <ActionButton icon={Pencil} label="编辑" onClick={startEdit} disabled={!onEditAndResend || message.isStreaming || savingEdit} />
          <ActionButton icon={RotateCcw} label="重发" onClick={() => void submitEdit(message.content)} disabled={!onEditAndResend || message.isStreaming || savingEdit} />
          <ActionButton icon={Trash2} label="删除" onClick={handleDelete} danger />
        </div>
      </motion.article>
    );
  }

  return (
    <motion.article
      initial={false}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      className="anim-enter-fade group grid w-full min-w-0 grid-cols-[minmax(0,1fr)] gap-2.5 pb-8 text-[var(--text-primary)]"
    >
      <div className="flex min-w-0 items-center gap-2 text-[length:var(--font-caption)] text-[var(--text-secondary)]">
        <strong className="truncate font-semibold text-[var(--text-primary)]" style={displayModelColor ? { color: displayModelColor } : undefined}>{assistantName(displayModelName)}</strong>
        <span className="h-1 w-1 flex-shrink-0 rounded-full bg-[var(--text-tertiary)] dark:bg-white/25" />
        <span className="truncate">{formatMessageTime(message.timestamp)}</span>
      </div>

      {message.reasoningContent && !hasEmbeddedThinking && (
        <ThoughtBlock content={message.reasoningContent} />
      )}

      {message.toolActivity && message.toolActivity.length > 0 && (
        <ToolActivityPanel activities={message.toolActivity} />
      )}

      {message.piTurnId !== undefined && (
        <PiStepsPanel message={message} busy={Boolean(message.isStreaming)} />
      )}

      {message.piChanges && message.piChanges.length > 0 && (
        <PiChangesPanel message={message} modelId={modelId} sessionId={sessionId} />
      )}

      {message.artifacts && message.artifacts.length > 0 && (
        <ArtifactPanel
          artifacts={message.artifacts}
          sandboxDir={artifactSandboxDir}
          onResize={onContentResize}
        />
      )}

      {/* 列宽跟随消息列（768/896px），字号与行高由 MarkdownRenderer 的 prose-body 决定；
          外层不再声明字号，否则会与内层打架（历史上这里写 15.5px 是死声明）。
          搜索命中时给整段加一层淡描边，并把命中字背景点亮（见 MarkdownRenderer 的 searchQuery）。 */}
      <div className={`min-w-0 text-[var(--text-primary)] ${searchActive ? 'rounded-[var(--radius-field)] ring-1 ring-[var(--accent)]/45 ring-offset-2 ring-offset-[var(--app-bg)]' : ''}`}>
        <MarkdownRenderer content={message.content} searchQuery={searchQuery} />
      </div>

      {!message.isStreaming && message.warnings && message.warnings.length > 0 && (
        <div className="flex items-start gap-1.5 text-[length:var(--font-eyebrow)] leading-relaxed text-[var(--state-warning)]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <div className="min-w-0">
            {message.warnings.map((w) => <p key={w}>{w}</p>)}
          </div>
        </div>
      )}

      <div
        role="toolbar"
        aria-label="消息操作"
        onKeyDown={handleActionRowKeyDown}
        className="flex flex-wrap items-center gap-0.5 text-[var(--text-tertiary)] opacity-60 transition-opacity group-hover:opacity-100 dark:text-[var(--text-secondary)]"
      >
        <ActionButton icon={copied ? Check : Copy} label={copied ? '已复制' : '复制'} onClick={() => void handleCopy()} />
        <ActionButton
          icon={RotateCcw}
          label="重新生成"
          onClick={() => void handleRegenerate()}
          disabled={!canRegenerate}
        />
        <ActionButton icon={Languages} label="翻译" disabled />
        <ActionButton icon={Download} label="导出" onClick={handleExport} />
        <ActionButton icon={Trash2} label="删除" onClick={handleDelete} danger />
      </div>

      {message.isStreaming ? (
        // 生成中的动画只留在这一行：点阵 + 「输出中」+ 实时耗时，与完成后的统计行同位，
        // 不再在正文下方另起一行转圈（两处重复指示会把视线从正文拉走）。
        <div className="flex max-w-full flex-wrap items-center gap-1.5 text-[length:var(--font-caption)] text-[var(--text-tertiary)] dark:text-[var(--text-secondary)]">
          <span className="inline-flex items-center gap-2 px-1 py-0.5 font-medium text-[var(--accent)]">
            <span className="work-dots" aria-hidden="true">
              {Array.from({ length: 9 }, (_, index) => (
                <i key={index} style={{ ['--i' as string]: index }} />
              ))}
            </span>
            <span>输出中</span>
          </span>
          <Metric icon={Clock} label={`已用 ${formatDuration(streamingElapsed)}`} />
        </div>
      ) : (
        <div className="flex max-w-full flex-wrap items-center gap-1.5 text-[length:var(--font-caption)] text-[var(--text-tertiary)] dark:text-[var(--text-secondary)]">
          {/* ctx 与侧边栏服务状态同口径：本地会话累计水位（估算）。 */}
          {/* 终止 / 出错的回复拿不到完整统计：整行保留，缺的值一律 -- 占位，不再隐藏整行。 */}
          <Metric icon={Gauge} label={formatSessionCtxUsage(sessionCtx)} />
          <Metric icon={Zap} label={stats && stats.outputTokens > 0 ? `${stats.outputTokens.toLocaleString()} tok` : '-- tok'} />
          <Metric icon={Clock} label={stats && stats.genTime > 0 ? `${stats.firstTokenDelay.toFixed(2)}s TTFT` : '--s TTFT'} />
          <Metric icon={Clock} label={`${formatMetric(stats ? stats.tokensPerSec : 0, ' tok/s')}`} />
          <Metric icon={Clock} label={stats && stats.genTime > 0 ? `生成耗时 ${formatSecondsShort(stats.genTime)}` : '生成耗时 --m--s'} />
        </div>
      )}
    </motion.article>
  );
}

/** 宿主/MCP 工具的展示名与图标：把工具名翻译成人话。 */
const PI_TOOL_META: Record<string, { label: string; icon: LucideIcon }> = {
  read_file: { label: '读取文件', icon: FileSearch },
  write_file: { label: '写入文件', icon: FilePen },
  edit_file: { label: '修改文件', icon: FilePen },
  make_docx: { label: '生成 Word', icon: FileType2 },
  make_xlsx: { label: '生成 Excel', icon: Sheet },
  read_docx: { label: '读取 Word', icon: FileSearch },
  read_xlsx: { label: '读取 Excel', icon: FileSearch },
  list_dir: { label: '列出目录', icon: FolderOpen },
  run_command: { label: '执行命令', icon: SquareTerminal },
  run_python: { label: '运行 Python', icon: Braces },
  save_memory: { label: '保存记忆', icon: Bookmark },
  canvas_status: { label: '画布状态', icon: ImageIcon },
  canvas_list_workflows: { label: '画布工作流', icon: ImageIcon },
  canvas_get_workflow: { label: '画布工作流', icon: ImageIcon },
  canvas_run: { label: '画布生图', icon: ImageIcon },
  canvas_cancel: { label: '取消生图', icon: ImageIcon },
};

function piToolMeta(tool?: string) {
  if (!tool) return null;
  if (tool.startsWith('mcp__')) {
    const server = tool.split('__')[1] ?? '';
    return { label: `${server} 工具`, icon: Plug };
  }
  return PI_TOOL_META[tool] ?? { label: tool, icon: Wrench };
}

/** Pi 执行步骤面板：技能 chips + 工具行（图标 / 路径 / 状态），默认折叠只显最近一步。 */
function PiStepsPanel({
  message,
  busy,
}: {
  message: Message;
  busy: boolean;
}) {
  const steps = message.piSteps ?? [];
  const state = message.piState ?? 'running';
  const [expanded, setExpanded] = useState(false);
  const [detailPoint, setDetailPoint] = useState<string | null>(null);
  const waiting = state === 'waiting_user';

  // 技能 chips 单独渲染；工具行（带 tool 元数据）与其余纯文本步骤分开。
  const skillSteps = steps.filter((step) => step.skills && step.skills.length > 0);
  const workSteps = steps.filter((step) => !step.skills || step.skills.length === 0);
  const toolRows = workSteps.filter((step) => step.tool);
  const plainSteps = workSteps.filter((step) => !step.tool);
  const visible = expanded ? workSteps : workSteps.slice(-1);

  return (
    <div className="min-w-0 max-w-full rounded-[var(--radius-field)] border border-[var(--border)] bg-[var(--surface-muted)]/50 p-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
      <div className="mb-2 flex items-center gap-2 text-[length:var(--font-caption)] font-medium text-[var(--text-secondary)]">
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--accent)]" /> : <Zap className="h-3.5 w-3.5 text-[var(--accent)]" />}
        <span className="min-w-0 flex-1">
          {waiting
            ? '等待权限确认'
            : busy
              ? 'Pi 执行中'
              : toolRows.length > 0
                ? `调用了 ${toolRows.length} 次工具`
                : workSteps.length > 0
                  ? `执行了 ${workSteps.length} 步`
                  : '等待 Pi'}
        </span>
        {skillSteps.map((step, index) => (
          <span key={`skills-${index}`} className="flex min-w-0 flex-wrap items-center gap-1">
            {(step.skills ?? []).map((skill) => (
              <span
                key={skill}
                className="inline-flex flex-shrink-0 items-center gap-0.5 rounded-full border border-[var(--accent)]/40 bg-[var(--accent-subtle)] px-1.5 py-0.5 text-[length:var(--font-eyebrow)] font-medium text-[var(--accent)]"
                title={`技能路由命中：${skill}`}
              >
                <Sparkles className="h-2.5 w-2.5" />
                {skill}
              </span>
            ))}
          </span>
        ))}
        {workSteps.length > 1 && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="inline-flex flex-shrink-0 items-center gap-1 text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)]"
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {expanded ? '收起' : `全部 ${workSteps.length} 步`}
          </button>
        )}
      </div>

      <div className="space-y-0.5">
        {visible.map((step, index) => {
          const key = `${step.ts}-${step.point}-${index}`;
          if (step.tool) {
            const meta = piToolMeta(step.tool);
            const Icon = meta?.icon ?? Wrench;
            const running = step.toolState === 'running';
            const failed = step.toolState === 'error';
            const showDetail = detailPoint === step.point;
            return (
              <div key={key} className="min-w-0">
                <button
                  type="button"
                  onClick={() => setDetailPoint(showDetail ? null : step.point)}
                  className={`flex w-full min-w-0 items-center gap-2 rounded-[var(--radius-sm)] px-1.5 py-1 text-left transition-colors ${
                    showDetail ? 'bg-black/[0.04] dark:bg-white/[0.06]' : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.04]'
                  }`}
                  title={`${meta?.label ?? step.tool}${step.path ? ` · ${step.path}` : ''}`}
                >
                  {running
                    ? <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-[var(--accent)]" />
                    : failed
                      ? <XCircle className="h-3.5 w-3.5 flex-shrink-0 text-[var(--state-danger)]" />
                      : <Icon className={`h-3.5 w-3.5 flex-shrink-0 ${failed ? 'text-[var(--state-danger)]' : 'text-[var(--accent)]'}`} />}
                  <span className={`min-w-0 flex-shrink-0 text-[length:var(--font-caption)] font-medium ${failed ? 'text-[var(--state-danger)]' : 'text-[var(--text-primary)]'}`}>
                    {meta?.label ?? step.tool}
                  </span>
                  {step.path && (
                    <span className="mono-font min-w-0 flex-1 truncate text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]" title={step.path}>
                      {step.path}
                    </span>
                  )}
                  {!step.path && <span className="min-w-0 flex-1" />}
                  {step.repeat && step.repeat > 1 && (
                    <span className="flex-shrink-0 text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">×{step.repeat}</span>
                  )}
                  {step.text.length > 60 && !step.path && (
                    <span className={`min-w-0 truncate text-[length:var(--font-eyebrow)] ${failed ? 'text-[var(--state-danger)]' : 'text-[var(--text-tertiary)]'}`}>
                      {step.text}
                    </span>
                  )}
                </button>
              </div>
            );
          }
          return (
            <div
              key={key}
              className={`flex min-w-0 items-start gap-2 px-1.5 py-0.5 text-[length:var(--font-caption)] leading-relaxed ${
                step.tone === 'ok'
                  ? 'text-[var(--state-success)]'
                  : step.tone === 'warn'
                    ? 'text-[var(--state-warning)]'
                    : step.tone === 'err'
                      ? 'text-[var(--state-danger)]'
                      : 'text-[var(--text-secondary)]'
              }`}
            >
              <span className="mt-[7px] h-1 w-1 flex-shrink-0 rounded-full bg-current opacity-60" />
              <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                {step.text}
                {step.repeat && step.repeat > 1 ? ` ×${step.repeat}` : ''}
              </span>
            </div>
          );
        })}
        {!expanded && plainSteps.length > 1 && workSteps.length > 1 && visible.some((step) => !step.tool) && (
          <p className="px-1.5 text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">
            展开查看全部 {workSteps.length} 步…
          </p>
        )}
      </div>
    </div>
  );
}

/** Pi 文件改动卡片：本轮落盘的文件、diff 审阅与检查点回滚（危险操作，二次确认）。 */
function PiChangesPanel({
  message,
  modelId,
  sessionId,
}: {
  message: Message;
  modelId: string;
  sessionId: string;
}) {
  const { dispatch } = useApp();
  const changes = useMemo(() => message.piChanges ?? [], [message.piChanges]);
  const rolledBack = message.piChangesRolledBack === true;
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rolling, setRolling] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // 同一路径多次编辑：op 取首条（对回滚语义重要），diff 按时间合并。
  const grouped = useMemo(() => {
    const map = new Map<string, { op: string; diffs: string[] }>();
    for (const change of changes) {
      const entry = map.get(change.path);
      if (entry) entry.diffs.push(change.diff);
      else map.set(change.path, { op: change.op, diffs: [change.diff] });
    }
    return [...map.entries()].map(([path, value]) => ({ path, ...value }));
  }, [changes]);
  const changeSetId = changes[0]?.changeSetId ?? '';

  const handleRollback = async () => {
    setRolling(true);
    setNotice(null);
    try {
      const summary = await piChangesRollback(changeSetId, grouped.map((item) => item.path));
      dispatch({
        type: 'UPDATE_MESSAGE',
        payload: { modelId, sessionId, messageId: message.id, piChangesRolledBack: true },
      });
      if (summary.skipped.length > 0) {
        setNotice(`有 ${summary.skipped.length} 个文件未能恢复（可能已不在工作区内）。`);
      }
    } catch (error) {
      setNotice(String(error));
    } finally {
      setRolling(false);
      setConfirmOpen(false);
    }
  };

  return (
    <div className="min-w-0 max-w-full rounded-[var(--radius-field)] border border-[var(--border)] bg-[var(--surface-muted)]/50 p-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
      <div className="mb-2 flex items-center gap-2 text-[length:var(--font-caption)] font-medium text-[var(--text-secondary)]">
        {rolledBack
          ? <RotateCcw className="h-3.5 w-3.5 text-[var(--text-tertiary)]" />
          : <Pencil className="h-3.5 w-3.5 text-[var(--accent)]" />}
        <span className="min-w-0 flex-1">
          {rolledBack ? '文件改动已回滚' : `改动了 ${grouped.length} 个文件`}
        </span>
        {!rolledBack && (
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={rolling}
            className="inline-flex flex-shrink-0 items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-[length:var(--font-eyebrow)] text-secondary-custom transition-colors hover:border-[var(--state-danger)] hover:text-[var(--state-danger)] disabled:opacity-45 disabled:cursor-not-allowed"
            title="把这些文件恢复到 Pi 改动之前的状态"
          >
            {rolling ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />} 回滚
          </button>
        )}
      </div>

      <div className="space-y-1">
        {grouped.map((item) => {
          const expanded = expandedPath === item.path;
          const created = item.op === 'created';
          return (
            <div key={item.path} className="min-w-0">
              <button
                type="button"
                onClick={() => setExpandedPath(expanded ? null : item.path)}
                className={`flex w-full min-w-0 items-start gap-2 rounded-[var(--radius-field)] px-2 py-1.5 text-left transition-colors ${
                  rolledBack ? 'opacity-60' : 'hover:bg-black/[0.04] dark:hover:bg-white/[0.06]'
                }`}
              >
                {created
                  ? <FilePlus2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-[var(--state-success)]" />
                  : <Pencil className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-[var(--text-tertiary)]" />}
                <span className="mono-font min-w-0 flex-1 truncate text-[length:var(--font-caption)] text-primary-custom" title={item.path}>
                  {item.path}
                </span>
                <span className="flex-shrink-0 text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">
                  {created ? '新建' : '修改'}
                </span>
                <ChevronDown
                  className={`mt-0.5 h-3 w-3 flex-shrink-0 text-[var(--text-tertiary)] transition-transform ${expanded ? '' : '-rotate-90'}`}
                />
              </button>
              {expanded && (
                <pre className="mono-font max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-[var(--radius-field)] border border-[var(--border)] bg-[var(--surface)] p-2.5 text-[length:var(--font-eyebrow)] leading-5 text-secondary-custom dark:bg-white/[0.03]">
                  {item.diffs.join('\n⋯⋯\n')}
                </pre>
              )}
            </div>
          );
        })}
      </div>

      {notice && (
        <p className="mt-2 rounded-md border border-[var(--state-warning-border)] bg-[var(--state-warning-bg)] px-2 py-1.5 text-[length:var(--font-eyebrow)] text-[var(--state-warning)]">
          {notice}
        </p>
      )}

      {/* 气泡在虚拟列表里，所在行带 transform: translateY(...)；transform 会成为
          position:fixed 后代的包含块，确认框若留在行内只会盖住一行、随列表滚动被裁切，
          行被虚拟滚动回收时还会直接被卸载。portal 到 body 才能盖住整个窗口。 */}
      {createPortal(
        <ConfirmDialog
          open={confirmOpen}
          title="回滚 Pi 的文件改动"
          description={`将把 ${grouped.length} 个文件恢复到 Pi 改动之前的状态。`}
          bullets={[
            'Pi 新建的文件会被删除',
            '这些文件在此期间你自己做的改动会被覆盖',
          ]}
          confirmLabel={rolling ? '回滚中…' : '回滚'}
          tone="danger"
          onConfirm={() => void handleRollback()}
          onCancel={() => setConfirmOpen(false)}
        />,
        document.body,
      )}
    </div>
  );
}

function ToolActivityPanel({ activities }: { activities: ToolActivity[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const pendingCount = activities.filter((item) => item.pending).length;

  return (
    <div className="min-w-0 max-w-full rounded-[var(--radius-field)] border border-[var(--border)] bg-[var(--surface-muted)]/50 p-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
      <div className="mb-2 flex items-center gap-2 text-[length:var(--font-caption)] font-medium text-[var(--text-secondary)]">
        {pendingCount > 0
          ? <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--accent)]" />
          : <Wrench className="h-3.5 w-3.5 text-[var(--accent)]" />}
        <span>
          {pendingCount > 0
            ? `正在调用工具（${activities.length - pendingCount}/${activities.length} 完成）`
            : `调用了 ${activities.length} 次工具`}
        </span>
      </div>

      <div className="space-y-1.5">
        {activities.map((item) => {
          const expanded = expandedId === item.id;
          const hasDetail = Boolean(item.result);
          return (
            <div key={item.id} className="min-w-0">
              <button
                type="button"
                onClick={() => hasDetail && setExpandedId(expanded ? null : item.id)}
                className={`flex w-full min-w-0 items-start gap-2 rounded-[var(--radius-field)] px-2 py-1.5 text-left transition-colors ${
                  hasDetail ? 'hover:bg-black/[0.04] dark:hover:bg-white/[0.06]' : 'cursor-default'
                }`}
              >
                {hasDetail && (
                  expanded
                    ? <ChevronDown className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-[var(--text-tertiary)]" />
                    : <ChevronRight className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-[var(--text-tertiary)]" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="mono-font min-w-0 max-w-full break-words text-[length:var(--font-caption)] font-semibold text-[var(--text-primary)] [overflow-wrap:anywhere]">
                      {item.tool}
                    </span>
                    <span className="min-w-0 max-w-full break-words rounded-[var(--radius-sm)] bg-black/[0.05] px-1.5 py-0.5 text-[length:var(--font-eyebrow)] text-[var(--text-secondary)] [overflow-wrap:anywhere] dark:bg-white/[0.07]">
                      {item.server}
                    </span>
                    {item.pending && (
                      <span className="text-[length:var(--font-eyebrow)] text-[var(--accent)]">执行中…</span>
                    )}
                    {!item.pending && item.isError && (
                      <span className="text-[length:var(--font-eyebrow)] font-medium text-[var(--state-danger)]">执行失败</span>
                    )}
                  </span>
                  <span className="mono-font mt-0.5 block truncate text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">
                    {formatToolArguments(item.arguments)}
                  </span>
                </span>
              </button>
              {expanded && hasDetail && (
                <pre className="mono-font mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-field)] bg-black/[0.04] px-3 py-2 text-[length:var(--font-caption)] leading-[var(--leading-code)] text-[var(--text-secondary)] dark:bg-black/30">
                  {item.result}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ActionButton({ icon: Icon, label, onClick, disabled, danger }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex h-8 w-8 items-center justify-center rounded-[var(--radius-field)] transition-colors disabled:opacity-35 ${
        danger ? 'hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400' : 'hover:bg-black/[0.055] hover:text-[var(--text-primary)] dark:hover:bg-[var(--surface-raised)] dark:hover:text-[var(--text-primary)]'
      }`}
      title={label}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

function Metric({ icon: Icon, label }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 px-1 py-0.5">
      <Icon className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-tertiary)] dark:text-[var(--text-secondary)]" />
      <span className="font-medium tracking-normal text-[var(--text-primary)] dark:text-[var(--text-secondary)]" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {label}
      </span>
    </span>
  );
}

function MultimodalAttachments({ parts }: { parts: Array<{ type: string; text?: string; image_url?: { url: string }; audio_url?: { url: string }; video_url?: { url: string } }> }) {
  const mediaItems = parts.filter((part) => part.type !== 'text');
  if (mediaItems.length === 0) return null;

  return (
    <div className={`${parts.some(p => p.type === 'text') ? 'mt-3' : ''} space-y-2`}>
      {mediaItems.map((part, idx) => {
        if (part.type === 'image_url' && part.image_url) {
          return (
            <img
              key={idx}
              src={part.image_url.url}
              alt="用户上传的图片"
              className="max-w-full rounded-[var(--radius-field)] border border-[var(--border)] shadow-sm dark:border-white/[0.1]"
              style={{ maxHeight: '320px', width: 'auto' }}
            />
          );
        }
        if (part.type === 'audio_url' && part.audio_url) {
          return (
            <div key={idx} className="rounded-[var(--radius-field)] border border-[var(--border)] bg-[var(--app-bg)] p-3 dark:border-white/[0.1] dark:bg-[var(--surface-raised)]">
              <audio
                controls
                src={part.audio_url.url}
                className="w-full max-w-md"
              />
            </div>
          );
        }
        if (part.type === 'video_url' && part.video_url) {
          return (
            <video
              key={idx}
              controls
              src={part.video_url.url}
              className="max-w-full rounded-[var(--radius-field)] border border-[var(--border)] shadow-sm dark:border-white/[0.1]"
              style={{ maxHeight: '480px', width: 'auto' }}
            />
          );
        }
        return null;
      })}
    </div>
  );
}
