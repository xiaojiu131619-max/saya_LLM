import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Download,
  Gauge,
  Languages,
  Loader2,
  Pencil,
  RotateCcw,
  Trash2,
  Wrench,
  Zap,
} from 'lucide-react';
import type { Message, ToolActivity } from '@/types';
import { useApp } from '@/context/AppContext';
import MarkdownRenderer, { ThoughtBlock } from './MarkdownRenderer';
import { isDesktopRuntime, serverErrorHint, streamChatCompletion } from '@/lib/desktop';
import { modelVideoSupport } from '@/lib/modelCapabilities';
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
  onEditAndResend?: (messageId: string, content: string) => Promise<void> | void;
}

function formatMetric(value: number, suffix = '') {
  if (!Number.isFinite(value) || value <= 0) return '未返回';
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

export default function ChatBubble({ message, modelId, sessionId, sessionModelName, sessionModelColor, sessionCtx, onEditAndResend }: ChatBubbleProps) {
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
  const canRegenerate = Boolean(isDesktopRuntime() && activeModel?.filePath && state.serverRunning && !message.isStreaming);
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
    dispatch({ type: 'DELETE_MESSAGE', payload: { modelId, sessionId, messageId: message.id } });

    const assistantMsgId = crypto.randomUUID();
    const startedAt = Date.now();
    const startTime = performance.now();
    dispatch({
      type: 'ADD_MESSAGE',
      payload: {
        modelId,
        sessionId,
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
    try {
      const metrics = await streamChatCompletion({
        port: activeModel.serverPort ?? state.serverPort,
        modelName: activeModel.name,
        config: state.chatConfig,
        ctxTotal: activeModel.loadConfig.ctxLength,
        supportsReasoning: activeModel.tags.includes('Reasoning') || activeModel.loadConfig.reasoningBudget > 0,
        reasoningBudget: activeModel.loadConfig.reasoningBudget,
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
          dispatch({
            type: 'UPDATE_MESSAGE',
            payload: { modelId, sessionId, messageId: assistantMsgId, reasoningContent },
          });
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
            stats: elapsedRequestStats(startTime, activeModel.loadConfig.ctxLength),
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
        initial={{ opacity: 0, x: 16 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: 10 }}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
        className="group grid w-full justify-items-end gap-1.5 pb-7"
      >
        <div className="flex max-w-[80%] items-center gap-2 text-[12px] text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">
          <strong className="font-medium text-[var(--text-primary)] dark:text-[var(--text-secondary)]">你</strong>
          <span>{formatMessageTime(message.timestamp)}</span>
        </div>

        {editing ? (
          <div className="w-full max-w-[80%] rounded-[18px] border border-black/[0.08] bg-[var(--surface-muted)] p-2 shadow-none dark:border-white/[0.08] dark:bg-[var(--surface-raised)]">
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
              className="max-h-[220px] min-h-[92px] w-full resize-y rounded-xl border border-black/[0.10] bg-white px-3 py-2 text-[15px] leading-7 text-[var(--text-primary)] outline-none [overflow-wrap:anywhere] focus:border-black/25 dark:border-white/[0.10] dark:bg-[var(--app-bg)] dark:text-[var(--text-primary)] dark:focus:border-[var(--accent)]/45"
              autoFocus
            />
            <div className="mt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={cancelEdit}
                disabled={savingEdit}
                className="h-8 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.06] dark:text-[var(--text-secondary)]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void submitEdit(draftContent)}
                disabled={savingEdit || !draftContent.trim()}
                className="h-8 rounded-md bg-[var(--accent)] px-3 text-sm font-semibold text-white transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
              >
                {savingEdit ? '发送中' : '保存并发送'}
              </button>
            </div>
          </div>
        ) : (
          <div className="max-w-[78%] rounded-[16px] bg-black/[0.045] px-4 py-2.5 text-[15px] leading-7 text-[var(--text-primary)] dark:bg-white/[0.065] dark:text-[var(--text-primary)]">
            {message.content && (
              <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{message.content}</p>
            )}
            {message.multimodalContent && (
              <MultimodalAttachments parts={message.multimodalContent} />
            )}
          </div>
        )}

        <div className="flex items-center gap-0.5 text-[var(--text-tertiary)] opacity-55 transition-opacity group-hover:opacity-100 dark:text-[var(--text-secondary)]">
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
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      className="group grid w-full min-w-0 gap-2.5 pb-9 text-[var(--text-primary)] dark:text-[var(--text-primary)]"
    >
      <div className="flex min-w-0 items-center gap-2 text-[12px] text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">
        <strong className="truncate font-semibold text-[var(--text-primary)] dark:text-[var(--text-primary)]" style={displayModelColor ? { color: displayModelColor } : undefined}>{assistantName(displayModelName)}</strong>
        <span className="h-1 w-1 flex-shrink-0 rounded-full bg-[var(--text-tertiary)] dark:bg-white/25" />
        <span className="truncate">{formatMessageTime(message.timestamp)}</span>
      </div>

      {message.reasoningContent && !hasEmbeddedThinking && (
        <div className="max-w-[760px]">
          <ThoughtBlock content={message.reasoningContent} />
        </div>
      )}

      {message.toolActivity && message.toolActivity.length > 0 && (
        <ToolActivityPanel activities={message.toolActivity} />
      )}

      <div className="min-w-0 text-[15.5px] leading-[1.9] text-[var(--text-primary)] dark:text-[var(--text-primary)]">
        <MarkdownRenderer content={message.content} />
        {message.isStreaming && (
          <div className="mt-3 flex w-fit items-center gap-2 py-1 text-xs font-medium text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">
            <span className="relative flex h-4 w-4 items-center justify-center">
              <span className="absolute h-4 w-4 rounded-full border-2 border-[var(--border)] dark:border-white/[0.14]" />
              <motion.span
                className="absolute h-4 w-4 rounded-full border-2 border-transparent border-t-[var(--accent)] border-r-[var(--accent)] dark:border-t-[var(--accent)] dark:border-r-[var(--accent)]"
                animate={{ rotate: 360 }}
                transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
              />
            </span>
            <span>输出中</span>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-0.5 text-[var(--text-tertiary)] opacity-60 transition-opacity group-hover:opacity-100 dark:text-[var(--text-secondary)]">
        <ActionButton icon={copied ? Check : Copy} label={copied ? '已复制' : '复制'} onClick={() => void handleCopy()} />
        <ActionButton icon={RotateCcw} label="重新生成" onClick={() => void handleRegenerate()} disabled={!canRegenerate} />
        <ActionButton icon={Languages} label="翻译" disabled />
        <ActionButton icon={Download} label="导出" onClick={handleExport} />
        <ActionButton icon={Trash2} label="删除" onClick={handleDelete} danger />
      </div>

      {message.isStreaming && (
        <div className="flex max-w-full flex-wrap items-center gap-1.5 text-[12px] text-[var(--text-tertiary)] dark:text-[var(--text-secondary)]">
          <Metric icon={Clock} label={`已用 ${formatDuration(streamingElapsed)}`} />
        </div>
      )}

      {stats && !message.isStreaming && (
        <div className="flex max-w-full flex-wrap items-center gap-1.5 text-[12px] text-[var(--text-tertiary)] dark:text-[var(--text-secondary)]">
          {/* ctx 与侧边栏服务状态同口径：本地会话累计水位（估算）。 */}
          <Metric icon={Gauge} label={formatSessionCtxUsage(sessionCtx)} />
          <Metric icon={Zap} label={stats.outputTokens > 0 ? `${stats.outputTokens.toLocaleString()} tok` : 'tok 未返回'} />
          <Metric icon={Clock} label={stats.firstTokenDelay > 0 ? `${stats.firstTokenDelay.toFixed(2)}s TTFT` : 'TTFT 未返回'} />
          <Metric icon={Clock} label={`${formatMetric(stats.tokensPerSec, ' tok/s')}`} />
          <Metric icon={Clock} label={`生成耗时 ${formatSecondsShort(stats.genTime)}`} />
        </div>
      )}
    </motion.article>
  );
}

function ToolActivityPanel({ activities }: { activities: ToolActivity[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const pendingCount = activities.filter((item) => item.pending).length;

  return (
    <div className="max-w-[760px] rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/50 p-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">
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
                className={`flex w-full min-w-0 items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
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
                    <span className="mono-font text-xs font-semibold text-[var(--text-primary)] dark:text-[var(--text-primary)]">
                      {item.tool}
                    </span>
                    <span className="rounded-md bg-black/[0.05] px-1.5 py-0.5 text-[11px] text-[var(--text-secondary)] dark:bg-white/[0.07]">
                      {item.server}
                    </span>
                    {item.pending && (
                      <span className="text-[11px] text-[var(--accent)]">执行中…</span>
                    )}
                    {!item.pending && item.isError && (
                      <span className="text-[11px] font-medium text-[var(--state-danger)]">执行失败</span>
                    )}
                  </span>
                  <span className="mono-font mt-0.5 block truncate text-[11px] text-[var(--text-tertiary)]">
                    {formatToolArguments(item.arguments)}
                  </span>
                </span>
              </button>
              {expanded && hasDetail && (
                <pre className="mono-font mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/[0.04] px-3 py-2 text-[11.5px] leading-5 text-[var(--text-secondary)] dark:bg-black/30 dark:text-[var(--text-secondary)]">
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
      className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors disabled:opacity-35 ${
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
              className="max-w-full rounded-lg border border-[var(--border)] shadow-sm dark:border-white/[0.1]"
              style={{ maxHeight: '320px', width: 'auto' }}
            />
          );
        }
        if (part.type === 'audio_url' && part.audio_url) {
          return (
            <div key={idx} className="rounded-lg border border-[var(--border)] bg-[var(--app-bg)] p-3 dark:border-white/[0.1] dark:bg-[var(--surface-raised)]">
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
              className="max-w-full rounded-lg border border-[var(--border)] shadow-sm dark:border-white/[0.1]"
              style={{ maxHeight: '480px', width: 'auto' }}
            />
          );
        }
        return null;
      })}
    </div>
  );
}
