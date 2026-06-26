import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Check,
  Clock,
  Copy,
  Download,
  Gauge,
  Languages,
  Pencil,
  RotateCcw,
  Trash2,
  Zap,
} from 'lucide-react';
import type { Message } from '@/types';
import { useApp } from '@/context/AppContext';
import MarkdownRenderer, { ThoughtBlock } from './MarkdownRenderer';
import { isDesktopRuntime, streamChatCompletion } from '@/lib/desktop';

interface ChatBubbleProps {
  message: Message;
  modelId: string;
  sessionId: string;
  sessionModelName?: string;
  sessionModelColor?: string;
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

function formatCtxPercent(used: number, total: number) {
  if (!Number.isFinite(used) || !Number.isFinite(total) || used <= 0 || total <= 0) return 'ctx 未返回';
  const percent = Math.min(999, Math.max(0, (used / total) * 100));
  return `${percent.toFixed(percent >= 10 ? 0 : 1)}% ctx`;
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

export default function ChatBubble({ message, modelId, sessionId, sessionModelName, sessionModelColor, onEditAndResend }: ChatBubbleProps) {
  const { state, dispatch } = useApp();
  const isUser = message.role === 'user';
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftContent, setDraftContent] = useState(message.content);
  const [savingEdit, setSavingEdit] = useState(false);
  const [timerNow, setTimerNow] = useState(Date.now());
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
    setTimerNow(Date.now());
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
    setSavingEdit(true);
    try {
      await onEditAndResend(message.id, nextContent);
      setEditing(false);
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

    const assistantMsgId = `${message.id}-regenerated`;
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
        apiKey: state.apiConfig.apiKey,
        messages: history.map((msg) => ({
          role: msg.role,
          content: msg.content,
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
      const errorMessage = `重新生成失败：${String(error instanceof Error ? error.message : error)}\n\n请确认 llama-server 正在运行。`;
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
        className="grid w-full justify-items-end gap-2"
      >
        <div className="flex max-w-[min(620px,82%)] items-center gap-2 text-[13px] text-[#9B9485] dark:text-[#8E8578]">
          <strong className="font-semibold text-[#6F685A] dark:text-[#D8D0C3]">你</strong>
          <span>{formatMessageTime(message.timestamp)}</span>
        </div>

        {editing ? (
          <div className="w-full max-w-[min(640px,84%)] rounded-[16px_16px_4px_16px] border border-[#D8D2C5] bg-[#F7F4EC] p-2 shadow-[0_1px_3px_rgba(64,60,50,0.10)] dark:border-white/[0.1] dark:bg-[#2B2822]">
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
              className="max-h-[220px] min-h-[92px] w-full resize-y rounded-md border border-[#DCD8CF] bg-[#FBFAF6] px-3 py-2 text-[16px] leading-7 text-[#403C32] outline-none [overflow-wrap:anywhere] focus:border-[#D7663E] dark:border-white/[0.08] dark:bg-[#171512] dark:text-[#F3EBDD]"
              autoFocus
            />
            <div className="mt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={cancelEdit}
                disabled={savingEdit}
                className="h-8 rounded-md border border-[#DCD8CF] bg-[#FAF9F5] px-3 text-sm text-[#625C50] transition-colors hover:bg-[#F1EEE7] disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.06] dark:text-[#D8D0C3]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void submitEdit(draftContent)}
                disabled={savingEdit || !draftContent.trim()}
                className="h-8 rounded-md bg-[#D7663E] px-3 text-sm font-semibold text-white transition-colors hover:bg-[#C95732] disabled:opacity-50"
              >
                {savingEdit ? '发送中' : '保存并发送'}
              </button>
            </div>
          </div>
        ) : (
          <div className="max-w-[min(640px,84%)] rounded-[16px_16px_4px_16px] bg-[#E8E1D5] px-4 py-3 text-[16px] leading-8 text-[#403C32] shadow-[0_1px_3px_rgba(64,60,50,0.10)] dark:bg-[#2B2822] dark:text-[#F3EBDD] dark:shadow-[0_1px_3px_rgba(0,0,0,0.25)]">
            <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{message.content}</p>
          </div>
        )}

        <div className="flex items-center gap-1.5 text-[#625C50] dark:text-[#BDB4A7]">
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
      className="grid w-full min-w-0 gap-2 text-[#403C32] dark:text-[#F3EBDD]"
    >
      <div className="flex min-w-0 items-center gap-2 text-[13px] text-[#9B9485] dark:text-[#8E8578]">
        <strong className="truncate font-semibold text-[#403C32] dark:text-[#F3EBDD]" style={displayModelColor ? { color: displayModelColor } : undefined}>{assistantName(displayModelName)}</strong>
        <span className="h-1 w-1 flex-shrink-0 rounded-full bg-[#B8B1A3]" />
        <span className="truncate">{formatMessageTime(message.timestamp)}</span>
      </div>

      {message.reasoningContent && !hasEmbeddedThinking && (
        <div className="max-w-[760px]">
          <ThoughtBlock content={message.reasoningContent} />
        </div>
      )}

      <div className="max-w-[820px] min-w-0 text-[16px] leading-8 text-[#403C32] dark:text-[#F3EBDD]">
        <MarkdownRenderer content={message.content} />
        {message.isStreaming && (
          <div className="mt-2 flex items-center gap-1 py-1">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#8C8576] dark:bg-[#A9A095]" style={{ animationDelay: '0ms' }} />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#8C8576] dark:bg-[#A9A095]" style={{ animationDelay: '150ms' }} />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#8C8576] dark:bg-[#A9A095]" style={{ animationDelay: '300ms' }} />
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 text-[#625C50] dark:text-[#BDB4A7]">
        <ActionButton icon={copied ? Check : Copy} label={copied ? '已复制' : '复制'} onClick={() => void handleCopy()} />
        <ActionButton icon={RotateCcw} label="重新生成" onClick={() => void handleRegenerate()} disabled={!canRegenerate} />
        <ActionButton icon={Languages} label="翻译" disabled />
        <ActionButton icon={Download} label="导出" onClick={handleExport} />
        <ActionButton icon={Trash2} label="删除" onClick={handleDelete} danger />
      </div>

      {message.isStreaming && (
        <div className="flex max-w-full flex-wrap items-center gap-1.5 text-[13px] text-[#6F685A]">
          <Metric icon={Clock} label={`已用 ${formatDuration(streamingElapsed)}`} />
        </div>
      )}

      {stats && !message.isStreaming && (
        <div className="flex max-w-full flex-wrap items-center gap-1.5 text-[13px] text-[#6F685A]">
          <Metric icon={Gauge} label={formatCtxPercent(stats.ctxUsed, stats.ctxTotal)} />
          <Metric icon={Zap} label={stats.outputTokens > 0 ? `${stats.outputTokens.toLocaleString()} tok` : 'tok 未返回'} />
          <Metric icon={Clock} label={stats.firstTokenDelay > 0 ? `${stats.firstTokenDelay.toFixed(2)}s TTFT` : 'TTFT 未返回'} />
          <Metric icon={Clock} label={`${formatMetric(stats.tokensPerSec, ' tok/s')}`} />
          <Metric icon={Clock} label={`生成耗时 ${formatDuration(stats.genTime)}`} />
        </div>
      )}
    </motion.article>
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
      className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:opacity-35 ${
        danger ? 'hover:bg-[#F0DDD6] hover:text-[#C44E36] dark:hover:bg-[#3A241C] dark:hover:text-[#F0987C]' : 'hover:bg-[#ECE7DC] hover:text-[#403C32] dark:hover:bg-white/[0.08] dark:hover:text-[#F3EBDD]'
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
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[#DED8CB] bg-[#EEEAE1] px-2.5 py-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)] dark:border-white/[0.08] dark:bg-white/[0.07] dark:shadow-none">
      <Icon className="h-4 w-4 flex-shrink-0 text-[#9A9282] dark:text-[#A9A095]" />
      <span className="font-medium tracking-normal text-[#4F493F] dark:text-[#F3EBDD]" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {label}
      </span>
    </span>
  );
}
