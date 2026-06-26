import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowUp,
  CheckCircle2,
  FileText,
  FileWarning,
  MoreHorizontal,
  PanelRightClose,
  Plus,
  Power,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { useApp } from '@/context/AppContext';
import ChatBubble from '@/components/ChatBubble';
import ChatSidebar from '@/features/chat/ChatSidebar';
import { isDesktopRuntime, listenDesktopFileDrops, readDesktopFileContent, stopActiveChatCompletion, stopDesktopServer, streamChatCompletion } from '@/lib/desktop';
import {
  CHAT_HISTORY_MODEL_ID,
  MAX_ATTACHMENT_BYTES,
  buildPromptWithAttachments,
  compactModelName,
  createChatSession,
  dayLabel,
  fileExtension,
  formatFileSize,
  isSupportedTextFile,
  type PendingAttachment,
} from '@/features/chat/chatUtils';
import type { ChatSession } from '@/types';
import type { ReasoningMode } from '@/types';
import { toolLabel } from '@/lib/llamaTools';

const REASONING_OPTIONS: Array<{ mode: ReasoningMode; label: string; description: string }> = [
  { mode: 'off', label: '关闭', description: '不请求 thinking 输出' },
  { mode: 'auto', label: '自动', description: '按模型能力自动启用' },
  { mode: 'think', label: '思考', description: '使用常规思考预算' },
  { mode: 'deep', label: '深思', description: '使用更高思考预算' },
];

const AUTO_SCROLL_MAGNET_PX = 96;
const SCROLL_RELEASE_DELTA_PX = 4;

function hasDraggedFiles(dataTransfer: DataTransfer) {
  return dataTransfer.files.length > 0 || Array.from(dataTransfer.types).some((type) => type === 'Files');
}

function fileNameFromPath(path: string) {
  const slash = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return slash >= 0 ? path.slice(slash + 1) : path;
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

function elapsedMessageStats(timestamp: number, ctxTotal = 0) {
  return {
    ctxUsed: 0,
    ctxTotal,
    outputTokens: 0,
    firstTokenDelay: 0,
    tokensPerSec: 0,
    genTime: Math.max(0, (Date.now() - timestamp) / 1000),
  };
}

export default function ChatPage() {
  const { state, dispatch } = useApp();
  const [inputText, setInputText] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [sessionSearch, setSessionSearch] = useState('');
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set());
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [stopMessage, setStopMessage] = useState<string | null>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [reasoningMenuOpen, setReasoningMenuOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesViewportRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);

  const activeModel = state.models.find((m) => m.id === state.activeModelId);
  const loadedModel = activeModel?.status === 'loaded'
    ? activeModel
    : state.models.find((model) => model.status === 'loaded');
  const sidebarModel = loadedModel ?? activeModel;
  const desktopReady = isDesktopRuntime();
  const canChat = Boolean(desktopReady && activeModel?.filePath && state.serverRunning);
  const chatSessions = useMemo(
    () => Object.values(state.chatSessions).flat().sort((a, b) => b.updatedAt - a.updatedAt),
    [state.chatSessions]
  );
  const activeSessionId = state.activeChatSessionIds[CHAT_HISTORY_MODEL_ID] || chatSessions[0]?.id;
  const activeSession = chatSessions.find((session) => session.id === activeSessionId) ?? chatSessions[0];
  const activeSessionModelId = activeSession?.modelId ?? CHAT_HISTORY_MODEL_ID;
  const activeSessionOwnerModel = state.models.find((model) =>
    model.id === activeSession?.runtimeModelId || model.id === activeSessionModelId
  );
  const activeSessionModelName = activeSession?.modelName ?? activeSessionOwnerModel?.name;
  const activeSessionModelColor = activeSession?.modelColor ?? activeSessionOwnerModel?.themeColorSolid;
  const activeModelSnapshot = activeModel
    ? { runtimeModelId: activeModel.id, modelName: activeModel.name, modelColor: activeModel.themeColorSolid }
    : undefined;
  const modelMessages = useMemo(() => activeSession?.messages ?? [], [activeSession]);
  const streamingMessage = modelMessages.find((message) => message.isStreaming);
  const isGenerating = Boolean(streamingMessage);
  const lastMessage = modelMessages[modelMessages.length - 1];
  const lastMessageContent = lastMessage?.content;
  const lastMessageReasoningContent = lastMessage?.reasoningContent;
  const lastMessageStreaming = lastMessage?.isStreaming;

  const filteredSessions = useMemo(() => {
    const query = sessionSearch.trim().toLowerCase();
    return query
      ? chatSessions.filter((session) => session.title.toLowerCase().includes(query))
      : chatSessions;
  }, [chatSessions, sessionSearch]);

  const sessionGroups = useMemo(() => {
    const groups = new Map<string, ChatSession[]>();
    filteredSessions.forEach((session) => {
      const label = dayLabel(session.updatedAt);
      groups.set(label, [...(groups.get(label) ?? []), session]);
    });
    return Array.from(groups.entries());
  }, [filteredSessions]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    if (!shouldStickToBottomRef.current) return;
    requestAnimationFrame(() => {
      const viewport = messagesViewportRef.current;
      if (!viewport) return;

      viewport.scrollTo({ top: viewport.scrollHeight, behavior });
      lastScrollTopRef.current = viewport.scrollTop;

      requestAnimationFrame(() => {
        if (!shouldStickToBottomRef.current) return;
        viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'auto' });
        lastScrollTopRef.current = viewport.scrollTop;
      });
    });
  }, []);

  useLayoutEffect(() => {
    scrollToBottom('auto');
  }, [modelMessages.length, lastMessageContent, lastMessageReasoningContent, lastMessageStreaming, scrollToBottom]);

  useLayoutEffect(() => {
    shouldStickToBottomRef.current = true;
    lastScrollTopRef.current = 0;
    scrollToBottom('auto');
  }, [activeSession?.id, scrollToBottom]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 168)}px`;
  }, [inputText]);

  useEffect(() => {
    const preventWindowDrop = (event: DragEvent) => {
      if (!event.dataTransfer || !hasDraggedFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = isGenerating ? 'none' : 'copy';
    };

    window.addEventListener('dragover', preventWindowDrop);
    window.addEventListener('drop', preventWindowDrop);
    return () => {
      window.removeEventListener('dragover', preventWindowDrop);
      window.removeEventListener('drop', preventWindowDrop);
    };
  }, [isGenerating]);

  const handleMessagesScroll = () => {
    const viewport = messagesViewportRef.current;
    if (!viewport) return;
    const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    if (distanceToBottom <= AUTO_SCROLL_MAGNET_PX) {
      shouldStickToBottomRef.current = true;
    } else if (viewport.scrollTop < lastScrollTopRef.current - SCROLL_RELEASE_DELTA_PX) {
      shouldStickToBottomRef.current = false;
    }
    lastScrollTopRef.current = viewport.scrollTop;
  };

  const releaseAutoScroll = () => {
    shouldStickToBottomRef.current = false;
  };

  const processAttachmentFiles = async (files: File[]) => {
    if (files.length === 0) return;

    const nextAttachments: PendingAttachment[] = [];
    const errors: string[] = [];

    for (const file of files) {
      if (!isSupportedTextFile(file)) {
        errors.push(`${file.name} 不是可直接读取的文本/代码/数据文件。`);
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        errors.push(`${file.name} 超过 ${formatFileSize(MAX_ATTACHMENT_BYTES)} 限制。`);
        continue;
      }

      const content = (await file.text()).split(String.fromCharCode(0)).join('');
      nextAttachments.push({
        id: `${file.name}-${file.lastModified}-${file.size}`,
        name: file.name,
        size: file.size,
        extension: fileExtension(file.name),
        content,
      });
    }

    setPendingAttachments((current) => [...current, ...nextAttachments]);
    setAttachmentError(errors.length > 0 ? errors.join(' ') : null);
  };

  const processAttachmentPaths = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return;

    const nextAttachments: PendingAttachment[] = [];
    const errors: string[] = [];

    for (const path of paths) {
      const name = fileNameFromPath(path);
      try {
        const content = (await readDesktopFileContent(path)).split(String.fromCharCode(0)).join('');
        nextAttachments.push({
          id: `${path}-${Date.now()}-${nextAttachments.length}`,
          name,
          size: new Blob([content]).size,
          extension: fileExtension(name),
          content,
        });
      } catch (error) {
        errors.push(`${name} ${String(error instanceof Error ? error.message : error)}`);
      }
    }

    setPendingAttachments((current) => [...current, ...nextAttachments]);
    setAttachmentError(errors.length > 0 ? errors.join(' ') : null);
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenDesktopFileDrops((payload) => {
      if (payload.type === 'enter' || payload.type === 'over') {
        if (!isGenerating) setDraggingFiles(true);
        return;
      }
      if (payload.type === 'leave') {
        setDraggingFiles(false);
        return;
      }
      if (payload.type === 'drop') {
        setDraggingFiles(false);
        if (isGenerating) {
          setAttachmentError('请等待当前输出结束后再添加文件。');
          return;
        }
        void processAttachmentPaths(payload.paths ?? []);
      }
    }).then((nextUnlisten) => {
      unlisten = nextUnlisten;
    });
    return () => {
      unlisten?.();
    };
  }, [isGenerating, processAttachmentPaths]);

  const handleAttachFiles = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    await processAttachmentFiles(files);
  };

  const handleDragOver = (event: React.DragEvent) => {
    if (!hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = !isGenerating ? 'copy' : 'none';
    setDraggingFiles(true);
  };

  const handleDragEnter = (event: React.DragEvent) => {
    if (!hasDraggedFiles(event.dataTransfer) || isGenerating) return;
    event.preventDefault();
    setDraggingFiles(true);
  };

  const handleDragLeave = (event: React.DragEvent) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDraggingFiles(false);
    }
  };

  const handleDrop = async (event: React.DragEvent) => {
    if (!hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    setDraggingFiles(false);
    if (isGenerating) {
      setAttachmentError('请等待当前输出结束后再添加文件。');
      return;
    }
    const paths = Array.from(event.dataTransfer.files ?? [])
      .map((file) => (file as File & { path?: string }).path ?? '')
      .filter(Boolean);
    if (paths.length > 0) {
      await processAttachmentPaths(paths);
      return;
    }
    await processAttachmentFiles(Array.from(event.dataTransfer.files ?? []));
  };

  const removeAttachment = (id: string) => {
    setPendingAttachments((current) => current.filter((file) => file.id !== id));
    setAttachmentError(null);
  };

  const handleSend = async () => {
    if ((!inputText.trim() && pendingAttachments.length === 0) || !activeModel || !canChat || isGenerating) return;
    shouldStickToBottomRef.current = true;
    const prompt = buildPromptWithAttachments(inputText.trim(), pendingAttachments);
    const session = activeSession ?? createChatSession(CHAT_HISTORY_MODEL_ID, '新对话', activeModelSnapshot);
    if (!activeSession) {
      dispatch({ type: 'CREATE_CHAT_SESSION', payload: { session } });
    } else if (activeModelSnapshot && !activeSession.modelName && modelMessages.length === 0) {
      dispatch({
        type: 'SET_CHAT_SESSION_MODEL',
        payload: {
          modelId: activeSession.modelId,
          sessionId: activeSession.id,
          ...activeModelSnapshot,
        },
      });
    }
    const sessionId = session.id;
    const sessionModelId = session.modelId;

    const userMsg = {
      id: `msg-${Date.now()}-user`,
      role: 'user' as const,
      content: prompt,
      timestamp: Date.now(),
    };

    dispatch({ type: 'ADD_MESSAGE', payload: { modelId: sessionModelId, sessionId, message: userMsg } });
    setInputText('');
    setPendingAttachments([]);
    setAttachmentError(null);
    setStopMessage(null);

    const assistantMsgId = `msg-${Date.now()}-assistant`;
    const startTime = performance.now();
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

      dispatch({
        type: 'ADD_MESSAGE',
        payload: {
          modelId: sessionModelId,
          sessionId,
        message: {
          id: assistantMsgId,
          role: 'assistant',
          content: '',
          reasoningContent: '',
          modelId: activeModel.id,
          modelName: activeModel.name,
          modelColor: activeModel.themeColorSolid,
          timestamp: Date.now(),
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
        signal: abortController.signal,
        messages: [...modelMessages, userMsg].map((msg) => ({
          role: msg.role,
          content: msg.content,
        })),
        onToken: (token) => {
          streamedContent += token;
          dispatch({
            type: 'UPDATE_MESSAGE',
            payload: { modelId: sessionModelId, sessionId, messageId: assistantMsgId, content: streamedContent },
          });
          scrollToBottom('auto');
        },
        onReasoningDelta: (reasoningContent) => {
          dispatch({
            type: 'UPDATE_MESSAGE',
            payload: { modelId: sessionModelId, sessionId, messageId: assistantMsgId, reasoningContent },
          });
          scrollToBottom('auto');
        },
      });

      const genTime = (performance.now() - startTime) / 1000;
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
          modelId: sessionModelId,
          sessionId,
          messageId: assistantMsgId,
          streaming: false,
          stats: {
            ctxUsed: metrics.ctxUsed,
            ctxTotal: metrics.ctxTotal,
            outputTokens: metrics.completionTokens,
            firstTokenDelay: metrics.firstTokenDelay,
            tokensPerSec: metrics.tokensPerSec ?? 0,
            genTime: metrics.genTime || genTime,
          },
        },
      });

      void genTime;
    } catch (error) {
      if (abortController.signal.aborted) {
        setStopMessage('已停止生成。');
        dispatch({
          type: 'SET_MESSAGE_STREAMING',
          payload: {
            modelId: sessionModelId,
            sessionId,
            messageId: assistantMsgId,
            streaming: false,
            stats: elapsedRequestStats(startTime, activeModel.loadConfig.ctxLength),
          },
        });
      } else {
        const message = `本地推理请求失败：${String(error instanceof Error ? error.message : error)}\n\n请确认模型已经加载完成，llama-server 正在运行。`;
        dispatch({
          type: 'UPDATE_MESSAGE',
          payload: { modelId: sessionModelId, sessionId, messageId: assistantMsgId, content: message, reasoningContent: '' },
        });
        dispatch({
          type: 'SET_MESSAGE_STREAMING',
          payload: {
            modelId: sessionModelId,
            sessionId,
            messageId: assistantMsgId,
            streaming: false,
            stats: elapsedRequestStats(startTime, activeModel.loadConfig.ctxLength),
          },
        });
      }
    } finally {
      if (abortControllerRef.current === abortController) {
        abortControllerRef.current = null;
      }
    }
  };

  const handleEditAndResend = async (messageId: string, content: string) => {
    if (!activeSession || !activeModel || !canChat || isGenerating) return;
    const messageIndex = modelMessages.findIndex((message) => message.id === messageId && message.role === 'user');
    if (messageIndex === -1) return;

    shouldStickToBottomRef.current = true;
    setStopMessage(null);
    setAttachmentError(null);

    const editedUserMessage = {
      ...modelMessages[messageIndex],
      content,
      timestamp: Date.now(),
    };
    const nextHistory = [
      ...modelMessages.slice(0, messageIndex),
      editedUserMessage,
    ];
    const sessionId = activeSession.id;
    const sessionModelId = activeSession.modelId;

    dispatch({
      type: 'REPLACE_MESSAGE_AND_TRUNCATE_AFTER',
      payload: {
        modelId: sessionModelId,
        sessionId,
        messageId,
        message: editedUserMessage,
      },
    });

    const assistantMsgId = `msg-${Date.now()}-assistant`;
    const startTime = performance.now();
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    dispatch({
      type: 'ADD_MESSAGE',
      payload: {
        modelId: sessionModelId,
        sessionId,
        message: {
          id: assistantMsgId,
          role: 'assistant',
          content: '',
          reasoningContent: '',
          modelId: activeModel.id,
          modelName: activeModel.name,
          modelColor: activeModel.themeColorSolid,
          timestamp: Date.now(),
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
        signal: abortController.signal,
        messages: nextHistory.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        onToken: (token) => {
          streamedContent += token;
          dispatch({
            type: 'UPDATE_MESSAGE',
            payload: { modelId: sessionModelId, sessionId, messageId: assistantMsgId, content: streamedContent },
          });
          scrollToBottom('auto');
        },
        onReasoningDelta: (reasoningContent) => {
          dispatch({
            type: 'UPDATE_MESSAGE',
            payload: { modelId: sessionModelId, sessionId, messageId: assistantMsgId, reasoningContent },
          });
          scrollToBottom('auto');
        },
      });

      const genTime = (performance.now() - startTime) / 1000;
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
          modelId: sessionModelId,
          sessionId,
          messageId: assistantMsgId,
          streaming: false,
          stats: {
            ctxUsed: metrics.ctxUsed,
            ctxTotal: metrics.ctxTotal,
            outputTokens: metrics.completionTokens,
            firstTokenDelay: metrics.firstTokenDelay,
            tokensPerSec: metrics.tokensPerSec ?? 0,
            genTime: metrics.genTime || genTime,
          },
        },
      });
    } catch (error) {
      if (abortController.signal.aborted) {
        setStopMessage('已停止生成。');
        dispatch({
          type: 'SET_MESSAGE_STREAMING',
          payload: {
            modelId: sessionModelId,
            sessionId,
            messageId: assistantMsgId,
            streaming: false,
            stats: elapsedRequestStats(startTime, activeModel.loadConfig.ctxLength),
          },
        });
      } else {
        const message = `重新发送失败：${String(error instanceof Error ? error.message : error)}\n\n请确认模型已经加载完成，llama-server 正在运行。`;
        dispatch({
          type: 'UPDATE_MESSAGE',
          payload: { modelId: sessionModelId, sessionId, messageId: assistantMsgId, content: message, reasoningContent: '' },
        });
        dispatch({
          type: 'SET_MESSAGE_STREAMING',
          payload: {
            modelId: sessionModelId,
            sessionId,
            messageId: assistantMsgId,
            streaming: false,
            stats: elapsedRequestStats(startTime, activeModel.loadConfig.ctxLength),
          },
        });
      }
    } finally {
      if (abortControllerRef.current === abortController) {
        abortControllerRef.current = null;
      }
    }
  };

  const handleStopGeneration = () => {
    abortControllerRef.current?.abort();
    stopActiveChatCompletion();
    if (activeSession && streamingMessage) {
      dispatch({
        type: 'SET_MESSAGE_STREAMING',
        payload: {
          modelId: activeSession.modelId,
          sessionId: activeSession.id,
          messageId: streamingMessage.id,
          streaming: false,
          stats: elapsedMessageStats(streamingMessage.timestamp, activeModel?.loadConfig.ctxLength ?? 0),
        },
      });
    }
    setStopMessage('已停止生成。');
  };

  const handleUnloadModel = async () => {
    if (!activeModel || !isDesktopRuntime()) return;
    handleStopGeneration();
    try {
      await stopDesktopServer();
      dispatch({ type: 'SET_SERVER_RUNNING', payload: false });
      dispatch({ type: 'UPDATE_MODEL_STATUS', payload: { modelId: activeModel.id, status: 'standby' } });
      dispatch({ type: 'SET_APP_STATUS', payload: `${activeModel.name} 已卸载。` });
      setStopMessage('模型已卸载。');
    } catch (error) {
      setStopMessage(`卸载失败：${String(error)}`);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (isGenerating) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  };

  const handleNewSession = () => {
    dispatch({ type: 'CREATE_CHAT_SESSION', payload: { session: createChatSession(CHAT_HISTORY_MODEL_ID, '新对话', activeModelSnapshot) } });
  };

  const handleSelectSession = (sessionId: string) => {
    if (selectionMode) {
      setSelectedSessionIds((current) => {
        const next = new Set(current);
        if (next.has(sessionId)) next.delete(sessionId);
        else next.add(sessionId);
        return next;
      });
      return;
    }
    dispatch({ type: 'SET_ACTIVE_CHAT_SESSION', payload: { modelId: CHAT_HISTORY_MODEL_ID, sessionId } });
  };

  const handleDeleteSession = (sessionId: string) => {
    const ownerModelId = chatSessions.find((session) => session.id === sessionId)?.modelId;
    if (!ownerModelId) return;
    dispatch({ type: 'DELETE_CHAT_SESSION', payload: { modelId: ownerModelId, sessionId } });
    if (activeSessionId === sessionId) {
      const nextSession = chatSessions.find((session) => session.id !== sessionId);
      dispatch({ type: 'SET_ACTIVE_CHAT_SESSION', payload: { modelId: CHAT_HISTORY_MODEL_ID, sessionId: nextSession?.id ?? '' } });
    }
    setSelectedSessionIds((current) => {
      const next = new Set(current);
      next.delete(sessionId);
      return next;
    });
  };

  const handleSelectionMode = () => {
    setSelectionMode((value) => !value);
    setSelectedSessionIds(new Set());
  };

  const handleDeleteSelectedSessions = () => {
    if (selectedSessionIds.size === 0) return;
    selectedSessionIds.forEach((sessionId) => {
      const ownerModelId = chatSessions.find((session) => session.id === sessionId)?.modelId;
      if (ownerModelId) {
        dispatch({ type: 'DELETE_CHAT_SESSION', payload: { modelId: ownerModelId, sessionId } });
      }
    });
    const nextSession = chatSessions.find((session) => !selectedSessionIds.has(session.id));
    dispatch({ type: 'SET_ACTIVE_CHAT_SESSION', payload: { modelId: CHAT_HISTORY_MODEL_ID, sessionId: nextSession?.id ?? '' } });
    setSelectedSessionIds(new Set());
    setSelectionMode(false);
  };

  const handleOpenToolsSettings = () => {
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem('agent-llm-settings-return-view', 'chat');
    }
    dispatch({ type: 'SET_VIEW', payload: 'tools' });
  };

  const handleClearContext = () => {
    if (!activeSession) return;
    dispatch({ type: 'CLEAR_MESSAGES', payload: { modelId: activeSession.modelId, sessionId: activeSession.id } });
    setInputText('');
    setPendingAttachments([]);
    setAttachmentError(null);
    setStopMessage('当前对话上下文已清除。');
    shouldStickToBottomRef.current = true;
  };

  const handleOpenModelLoad = () => {
    if (!sidebarModel) {
      dispatch({ type: 'SET_SELECTED_MODEL', payload: null });
      dispatch({ type: 'SET_VIEW', payload: 'home' });
      return;
    }
    dispatch({ type: 'SET_SELECTED_MODEL', payload: sidebarModel.id });
    dispatch({ type: 'SET_VIEW', payload: 'modelLoad' });
  };

  const inputPlaceholder = activeModel
    ? canChat
      ? '输入消息...'
      : '请先从模型管理加载本地模型'
    : '加载模型后可继续发送，历史对话仍可查看';

  const emptyMessage = activeModel
    ? canChat
      ? `${activeModel.params} ${activeModel.modelType === 'moe' ? 'MoE' : '稠密'} 模型 · ${activeModel.quant} · llama-server 已连接`
      : '请先从模型管理加载模型，连接真实 llama-server 后再开始对话'
    : '历史对话会独立保存。加载本地 GGUF 模型后即可继续发送。';

  const activeTitle = activeSession?.title || '新对话';
  const activeHeaderModelName = activeSessionModelName
    ?? (activeSession && modelMessages.length > 0 ? '未记录模型' : activeModel?.name);
  const chatBubbleModelName = activeSessionModelName ?? '未记录模型';
  const sidebarWidth = state.sidebarCollapsed ? 76 : 292;
  const currentReasoningOption = REASONING_OPTIONS.find((item) => item.mode === state.chatConfig.reasoningMode) ?? REASONING_OPTIONS[1];
  const enabledToolsText = state.chatConfig.enabledTools.length > 0
    ? state.chatConfig.enabledTools.map(toolLabel).join('、')
    : '未启用';
  const runtimeStatusText = isGenerating ? '生成中' : state.serverRunning ? '运行中' : '未加载';

  return (
    <div
      className="relative flex h-full min-h-0 overflow-hidden rounded-2xl border border-black/[0.06] bg-[#F6F2EA] text-[15.5px] text-[#26231D] shadow-sm dark:border-white/[0.08] dark:bg-[#11100E] dark:text-[#F3EBDD]"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={(event) => void handleDrop(event)}
    >
      <AnimatePresence>
        {draggingFiles && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="pointer-events-none absolute inset-3 z-40 flex items-center justify-center rounded-2xl border border-dashed border-[#D7663E] bg-[#FBFAF6]/95 dark:bg-[#15130F]/95"
          >
            <div className="rounded-xl border border-[#E2DFD6] bg-[#FBFAF6] px-5 py-4 text-center shadow-lg dark:border-white/10 dark:bg-[#1C1A16]">
              <FileText className="mx-auto mb-2 h-6 w-6 text-[#D7663E]" />
              <div className="text-[15px] font-semibold text-[#403C32] dark:text-[#F3EBDD]">松开即可上传到当前对话</div>
              <div className="mt-1 text-[13px] text-[#8C8576] dark:text-[#A9A095]">支持文本、代码、JSON、CSV、Markdown 等文件</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <ChatSidebar
        activeModel={sidebarModel}
        canChat={canChat}
        collapsed={state.sidebarCollapsed}
        selectionMode={selectionMode}
        selectedSessionIds={selectedSessionIds}
        sessionSearch={sessionSearch}
        sessionGroups={sessionGroups}
        activeSessionId={activeSession?.id}
        onSearchChange={setSessionSearch}
        onNewSession={handleNewSession}
        onSelectionMode={handleSelectionMode}
        onDeleteSelectedSessions={handleDeleteSelectedSessions}
        onSelectSession={handleSelectSession}
        onDeleteSession={handleDeleteSession}
        onOpenGlobalSettings={() => {
          if (typeof window !== 'undefined') {
            window.sessionStorage.setItem('agent-llm-settings-return-view', 'chat');
          }
          dispatch({ type: 'SET_VIEW', payload: 'settings' });
        }}
        onOpenImage={() => dispatch({ type: 'SET_VIEW', payload: 'image' })}
        onOpenModelLoad={handleOpenModelLoad}
        onToggleTheme={() => dispatch({ type: 'TOGGLE_THEME' })}
        onToggleCollapse={() => dispatch({ type: 'TOGGLE_SIDEBAR' })}
        onSwitchToModel={() => dispatch({ type: 'SET_VIEW', payload: 'home' })}
        theme={state.theme}
        sidebarWidth={sidebarWidth}
      />

      <section className="relative grid min-w-0 flex-1 grid-rows-[64px_minmax(0,1fr)] overflow-hidden bg-[#FFFDF8] dark:bg-[#24211D]">
        <header className="flex min-w-0 items-center justify-between border-b border-[#E4E0D6] px-5 dark:border-white/[0.08]">
          <div className="flex min-w-0 items-center gap-3">
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold text-[#403C32] dark:text-[#F3EBDD]">{activeTitle}</h1>
              <p className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-[#969083] dark:text-[#A9A095]">
                <span className="truncate">{compactModelName(activeHeaderModelName)}</span>
                <span className="h-1 w-1 flex-shrink-0 rounded-full bg-[#B8B1A3] dark:bg-white/30" />
                <span className="truncate">{canChat ? 'llama-server 已连接' : '历史对话可查看'}</span>
              </p>
            </div>
          </div>

          <div className="flex min-w-0 items-center gap-1.5">
            <span
              className={`mr-1 hidden h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors sm:inline-flex ${
                isGenerating
                    ? 'bg-[#F5E2D6] text-[#B76540] dark:bg-[#3A241C] dark:text-[#F0B18D]'
                    : canChat
                      ? 'bg-[#E7F1E4] text-[#4E7751] dark:bg-[#1F3224] dark:text-[#98D19C]'
                      : 'bg-[#ECE7DC] text-[#817A6D] dark:bg-white/[0.06] dark:text-[#A9A095]'
              }`}
            >
              <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0" />
              {runtimeStatusText}
            </span>
            {isGenerating && (
              <IconButton icon={Square} label="停止生成" tone="danger" onClick={handleStopGeneration} />
            )}
            <IconButton icon={Power} label="卸载模型" tone="danger" onClick={() => void handleUnloadModel()} disabled={!activeModel || !state.serverRunning} />
            <IconButton
              icon={showSettings ? PanelRightClose : MoreHorizontal}
              label={showSettings ? '收起对话参数' : '更多 / 对话参数'}
              onClick={() => setShowSettings((value) => !value)}
            />
          </div>
        </header>

        <AnimatePresence>
          {showSettings && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 z-30 flex justify-end overflow-hidden bg-black/20 dark:bg-black/55 xl:hidden"
              onClick={() => setShowSettings(false)}
            >
              <motion.div
                initial={{ x: 28, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: 28, opacity: 0 }}
                transition={{ duration: 0.18 }}
                className="h-full w-full max-w-sm rounded-l-2xl border-l border-[#DED9CC] bg-[#FBFAF6] p-5 shadow-2xl dark:border-white/[0.08] dark:bg-[#171512]"
                onClick={(event) => event.stopPropagation()}
              >
                <ChatSettingsPanel onClose={() => setShowSettings(false)} />
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        <div
          ref={messagesViewportRef}
          onScroll={handleMessagesScroll}
          onWheel={(event) => {
            if (event.deltaY < 0) releaseAutoScroll();
          }}
          onTouchMove={releaseAutoScroll}
          onKeyDown={(event) => {
            if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) releaseAutoScroll();
          }}
          tabIndex={-1}
          className="min-h-0 overflow-y-auto px-[clamp(22px,6vw,88px)] pb-[clamp(180px,24vh,280px)] pt-8"
        >
          {modelMessages.length === 0 ? (
            <div className="flex h-full items-center justify-center text-center">
              <div className="max-w-md px-8 py-9">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-[#E3DED2] bg-[#F1EDE4] text-lg text-[#D7663E] dark:border-white/[0.08] dark:bg-white/[0.06]">LL</div>
                <h2 className="mb-2 text-xl font-semibold text-[#403C32] dark:text-[#F3EBDD]">{activeTitle}</h2>
                <p className="text-sm leading-relaxed text-[#817A6D] dark:text-[#A9A095]">{emptyMessage}</p>
              </div>
            </div>
          ) : (
            <div className="mx-auto grid w-full max-w-[860px] min-w-0 gap-7">
              <AnimatePresence initial={false}>
                {modelMessages.map((msg) => (
                  <ChatBubble
                    key={msg.id}
                    message={msg}
                    modelId={activeSessionModelId}
                    sessionId={activeSession?.id ?? ''}
                    sessionModelName={chatBubbleModelName}
                    sessionModelColor={activeSessionModelColor}
                    onEditAndResend={canChat && !isGenerating ? handleEditAndResend : undefined}
                  />
                ))}
              </AnimatePresence>
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 px-[clamp(16px,5vw,56px)] pb-5 pt-6">
          <div className="pointer-events-auto mx-auto w-full max-w-[860px] min-w-0">
            {(pendingAttachments.length > 0 || attachmentError || stopMessage) && (
              <div className="mb-2 space-y-2">
                {pendingAttachments.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {pendingAttachments.map((file) => (
                      <div key={file.id} className="flex max-w-full min-w-0 items-center gap-2 rounded-lg border border-[#DED9CC] bg-[#F7F4EC] px-3 py-2 text-xs text-[#756E61] shadow-sm dark:border-white/[0.08] dark:bg-[#2D2923] dark:text-[#A9A095]">
                        <FileText className="h-3.5 w-3.5 flex-shrink-0 text-[#D7663E]" />
                        <span className="max-w-[220px] truncate text-[#403C32] dark:text-[#F3EBDD]">{file.name}</span>
                        <span className="mono-font flex-shrink-0">{formatFileSize(file.size)}</span>
                        <button
                          onClick={() => removeAttachment(file.id)}
                          className="rounded-md p-0.5 transition-colors hover:bg-[#E7E2D6] dark:hover:bg-white/[0.08]"
                          title="移除附件"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {attachmentError && (
                  <div className="flex items-center gap-2 text-xs text-[#C44E36] dark:text-[#F0987C]">
                    <FileWarning className="h-3.5 w-3.5 flex-shrink-0" />
                    <span>{attachmentError}</span>
                  </div>
                )}
                {stopMessage && (
                  <div className="text-xs text-[#8C8576] dark:text-[#A9A095]">{stopMessage}</div>
                )}
              </div>
            )}

            <div className="min-h-[104px] rounded-xl border border-[#DCD7CC] bg-[#F7F4EC] shadow-[0_10px_28px_rgba(64,60,50,0.10)] dark:border-white/[0.09] dark:bg-[#2D2923] dark:shadow-[0_10px_28px_rgba(0,0,0,0.26)]">
              <textarea
                ref={textareaRef}
                value={inputText}
                onChange={(event) => setInputText(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={inputPlaceholder}
                disabled={!canChat}
                rows={2}
                className="max-h-[180px] min-h-[64px] w-full resize-none bg-transparent px-4 pt-4 text-sm leading-6 text-[#403C32] outline-none [overflow-wrap:anywhere] placeholder:text-[#A69E8D] disabled:opacity-60 dark:text-[#F3EBDD] dark:placeholder:text-[#82786B]"
              />
              <div className="flex min-w-0 items-center gap-2 px-4 pb-3">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".txt,.md,.markdown,.json,.jsonl,.csv,.tsv,.log,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.rs,.go,.java,.c,.cpp,.h,.hpp,.cs,.php,.rb,.swift,.kt,.kts,.sql,.toml,.yaml,.yml,.ini,.env,.bat,.ps1,.sh,text/*,application/json,application/xml"
                  className="hidden"
                  onChange={(event) => void handleAttachFiles(event)}
                />
                <InputToolButton icon={Plus} label="上传文件" onClick={() => fileInputRef.current?.click()} disabled={isGenerating} />
                <div className="relative flex-shrink-0">
                  <button
                    onClick={() => setReasoningMenuOpen((value) => !value)}
                    disabled={!canChat}
                    className="flex h-9 items-center gap-1.5 rounded-lg border border-[#E1DCD0] bg-[#FBFAF6] px-2.5 text-xs font-medium text-[#716A5E] transition-colors hover:bg-[#E8E3D8] disabled:opacity-40 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[#D8D0C3] dark:hover:bg-white/[0.09]"
                    title="思考强度"
                  >
                    <Sparkles className="h-4 w-4" />
                    <span>{currentReasoningOption.label}</span>
                  </button>
                  <AnimatePresence>
                    {reasoningMenuOpen && (
                      <motion.div
                        initial={{ opacity: 0, y: 6, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 6, scale: 0.98 }}
                        transition={{ duration: 0.14 }}
                        className="absolute bottom-10 left-0 z-20 w-44 overflow-hidden rounded-xl border border-[#DDD8CC] bg-[#FBFAF6] p-1 shadow-xl dark:border-white/[0.08] dark:bg-[#211E19]"
                      >
                        {REASONING_OPTIONS.map((item) => (
                          <button
                            key={item.mode}
                            onClick={() => {
                              dispatch({ type: 'SET_CHAT_CONFIG', payload: { reasoningMode: item.mode } });
                              setReasoningMenuOpen(false);
                            }}
                            className={`w-full rounded-lg px-3 py-2 text-left transition-colors ${
                              state.chatConfig.reasoningMode === item.mode
                                ? 'bg-[#F1E7DE] text-[#D7663E] dark:bg-[#3A241C] dark:text-[#F0B18D]'
                                : 'text-[#403C32] hover:bg-[#F1EEE7] dark:text-[#F3EBDD] dark:hover:bg-white/[0.07]'
                            }`}
                          >
                            <div className="text-sm font-semibold">{item.label}</div>
                            <div className="mt-0.5 text-xs text-[#8C8576] dark:text-[#A9A095]">{item.description}</div>
                          </button>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
                <InputToolButton
                  icon={Wrench}
                  label={`工具设置：${enabledToolsText}`}
                  onClick={handleOpenToolsSettings}
                />
                <InputToolButton icon={Trash2} label="清除上下文" onClick={handleClearContext} disabled={!activeSession || isGenerating} />
                <span className="ml-auto hidden min-w-0 truncate px-2 text-xs text-[#8F887A] dark:text-[#82786B] sm:block">
                  Enter 发送，Shift + Enter 换行
                </span>
                <button
                  onClick={isGenerating ? handleStopGeneration : () => void handleSend()}
                  disabled={isGenerating ? false : ((!inputText.trim() && pendingAttachments.length === 0) || !canChat)}
                  className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full transition-colors ${
                    isGenerating
                      ? 'bg-[#403C32] text-white hover:bg-[#2F2C25] dark:bg-[#F0B18D] dark:text-[#171512] dark:hover:bg-[#F6C6A9]'
                      : (inputText.trim() || pendingAttachments.length > 0) && canChat
                        ? 'bg-[#E5A088] text-white hover:bg-[#D98E74] dark:bg-[#D7663E] dark:text-white dark:hover:bg-[#E27750]'
                        : 'bg-[#E6E1D6] text-[#9A9282] dark:bg-white/[0.06] dark:text-[#82786B]'
                  }`}
                  title={isGenerating ? '停止生成' : '发送'}
                >
                  {isGenerating ? <Square className="h-4 w-4 fill-current" /> : <ArrowUp className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <AnimatePresence initial={false}>
        {showSettings && (
          <motion.aside
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 344, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="hidden min-h-0 flex-shrink-0 overflow-hidden border-l border-[#E2DFD6] bg-[#F1EFE8] dark:border-white/[0.08] dark:bg-[#15130F] xl:block"
          >
            <div className="h-full w-[344px] p-5">
              <ChatSettingsPanel onClose={() => setShowSettings(false)} />
            </div>
          </motion.aside>
        )}
      </AnimatePresence>
    </div>
  );
}

function IconButton({ icon: Icon, label, onClick, disabled, tone = 'neutral' }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'neutral' | 'danger';
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex h-10 w-10 items-center justify-center rounded-lg transition-colors disabled:opacity-35 ${
        tone === 'danger'
          ? 'text-[#C44E36] hover:bg-[#F0DDD6] dark:text-[#F0987C] dark:hover:bg-[#3A241C]'
          : 'text-[#6F685A] hover:bg-[#EEEAE1] dark:text-[#D8D0C3] dark:hover:bg-white/[0.08]'
      }`}
      title={label}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

function ChatSettingsPanel({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useApp();
  const [presetTitle, setPresetTitle] = useState('');
  const currentPrompt = state.chatConfig.systemPrompt.trim();

  const handleSavePreset = () => {
    dispatch({
      type: 'SAVE_SYSTEM_PROMPT_PRESET',
      payload: {
        title: presetTitle,
        prompt: state.chatConfig.systemPrompt,
      },
    });
    setPresetTitle('');
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-5 flex items-center justify-between border-b border-[#E2DFD6] pb-4 dark:border-white/[0.08]">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 truncate text-sm font-semibold text-[#403C32] dark:text-[#F3EBDD]">
            <SlidersHorizontal className="h-4 w-4 flex-shrink-0 text-[#D7663E]" />
            对话参数
          </h2>
          <p className="mt-1 truncate text-xs text-[#8C8576] dark:text-[#A9A095]">当前会话 · 默认预设</p>
        </div>
        <button
          onClick={onClose}
          aria-label="关闭对话参数"
          title="关闭对话参数"
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-[#756E61] transition-colors hover:bg-[#E7E2D6] dark:text-[#D8D0C3] dark:hover:bg-white/[0.08]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-4">
          <div className="rounded-xl border border-[#E1DDD2] bg-[#F7F4EC] p-4 dark:border-white/[0.08] dark:bg-white/[0.04]">
            <label className="mb-2 block text-sm font-medium text-[#403C32] dark:text-[#F3EBDD]">系统提示词</label>
            <textarea
              value={state.chatConfig.systemPrompt}
              onChange={(event) => dispatch({ type: 'SET_CHAT_CONFIG', payload: { systemPrompt: event.target.value } })}
              rows={7}
              placeholder="为当前对话设置角色、规则或输出格式"
              className="w-full resize-none rounded-lg border border-[#DDD8CC] bg-[#FBFAF6] px-3 py-2 text-sm leading-6 text-[#403C32] outline-none transition-colors placeholder:text-[#A39C8C] focus:border-[#D7663E] dark:border-white/[0.08] dark:bg-[#171512] dark:text-[#F3EBDD] dark:placeholder:text-[#82786B]"
            />
            <div className="mt-3 flex min-w-0 gap-2">
              <input
                value={presetTitle}
                onChange={(event) => setPresetTitle(event.target.value)}
                placeholder="预设名称"
                className="min-w-0 flex-1 rounded-lg border border-[#DDD8CC] bg-[#FBFAF6] px-3 py-2 text-sm text-[#403C32] outline-none transition-colors placeholder:text-[#A39C8C] focus:border-[#D7663E] dark:border-white/[0.08] dark:bg-[#171512] dark:text-[#F3EBDD] dark:placeholder:text-[#82786B]"
              />
              <button
                type="button"
                onClick={handleSavePreset}
                disabled={!currentPrompt}
                className="h-10 flex-shrink-0 rounded-lg bg-[#403C32] px-3 text-sm font-medium text-[#FBFAF6] transition-colors hover:bg-[#2F2C25] disabled:cursor-not-allowed disabled:bg-[#D8D2C5] disabled:text-[#8C8576] dark:bg-[#F0B18D] dark:text-[#171512] dark:hover:bg-[#F6C6A9] dark:disabled:bg-white/[0.08] dark:disabled:text-[#82786B]"
              >
                保存
              </button>
            </div>
            {state.systemPromptPresets.length > 0 && (
              <div className="mt-3 space-y-2">
                <div className="text-xs font-medium text-[#8C8576] dark:text-[#A9A095]">提示词预设</div>
                <div className="grid gap-2">
                  {state.systemPromptPresets.map((preset) => {
                    const selected = preset.prompt === state.chatConfig.systemPrompt;
                    return (
                      <div
                        key={preset.id}
                          className={`flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2 transition-colors ${
                          selected
                            ? 'border-[#E4B59E] bg-[#F8EDE7] dark:border-[#73432F] dark:bg-[#3A241C]'
                            : 'border-[#E1DDD2] bg-[#FBFAF6] dark:border-white/[0.08] dark:bg-[#171512]'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => dispatch({ type: 'SET_CHAT_CONFIG', payload: { systemPrompt: preset.prompt } })}
                          className="min-w-0 flex-1 text-left"
                          title={preset.prompt}
                        >
                          <div className="truncate text-sm font-medium text-[#403C32] dark:text-[#F3EBDD]">{preset.title}</div>
                          <div className="mt-0.5 truncate text-xs text-[#8C8576] dark:text-[#A9A095]">{preset.prompt}</div>
                        </button>
                        <button
                          type="button"
                          onClick={() => dispatch({ type: 'DELETE_SYSTEM_PROMPT_PRESET', payload: { presetId: preset.id } })}
                          className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-md text-[#8A8374] transition-colors hover:bg-[#F0DDD6] hover:text-[#C44E36] dark:text-[#A9A095] dark:hover:bg-[#3A241C] dark:hover:text-[#F0987C]"
                          title="删除预设"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <ChatNumberSetting
            label="温度"
            value={state.chatConfig.temperature}
            min={0}
            max={2}
            step={0.05}
            onChange={(value) => dispatch({ type: 'SET_CHAT_CONFIG', payload: { temperature: value } })}
          />
          <ChatNumberSetting
            label="Top P"
            value={state.chatConfig.topP}
            min={0.01}
            max={1}
            step={0.01}
            onChange={(value) => dispatch({ type: 'SET_CHAT_CONFIG', payload: { topP: value } })}
          />
          <ChatNumberSetting
            label="重复惩罚"
            value={state.chatConfig.repeatPenalty}
            min={1}
            max={2}
            step={0.01}
            onChange={(value) => dispatch({ type: 'SET_CHAT_CONFIG', payload: { repeatPenalty: value } })}
          />
          <ChatNumberSetting
            label="最大输出 Token（0 不限制）"
            value={state.chatConfig.maxTokens}
            min={0}
            max={8192}
            step={16}
            onChange={(value) => dispatch({ type: 'SET_CHAT_CONFIG', payload: { maxTokens: Math.round(value) } })}
          />
        </div>
      </div>
    </div>
  );
}

function InputToolButton({ icon: Icon, label, onClick, disabled }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-[#716A5E] transition-colors hover:bg-[#E8E3D8] disabled:opacity-40 dark:text-[#D8D0C3] dark:hover:bg-white/[0.08]"
      title={label}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

function ChatNumberSetting({ label, value, min, max, step, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  const safeValue = Math.min(max, Math.max(min, value));
  const percent = max === min ? 0 : ((safeValue - min) / (max - min)) * 100;
  return (
    <div className="rounded-xl border border-[#E1DDD2] bg-[#F7F4EC] p-4 dark:border-white/[0.08] dark:bg-white/[0.04]">
      <div className="mb-3 flex items-center justify-between gap-3">
        <label className="text-sm font-medium text-[#403C32] dark:text-[#F3EBDD]">{label}</label>
        <input
          type="number"
          value={safeValue}
          min={min}
          max={max}
          step={step}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next)));
          }}
          className="mono-font w-24 rounded-lg border border-[#DDD8CC] bg-[#FBFAF6] px-2 py-1 text-right text-sm text-[#403C32] outline-none transition-colors focus:border-[#D7663E] dark:border-white/[0.08] dark:bg-[#171512] dark:text-[#F3EBDD]"
        />
      </div>
      <input
        type="range"
        value={safeValue}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full accent-[#D7663E] transition-[background] duration-200"
        style={{
          background: `linear-gradient(to right, #D7663E ${percent}%, rgba(120,110,95,0.18) ${percent}%)`,
        }}
      />
    </div>
  );
}
