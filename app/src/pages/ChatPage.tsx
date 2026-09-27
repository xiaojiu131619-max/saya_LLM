import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowDown,
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronDown,
  FileText,
  FileWarning,
  Info,
  MoreHorizontal,
  PanelRightClose,
  Plus,
  Power,
  SlidersHorizontal,
  Sparkles,
  Square,
  Tag,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { useApp } from '@/context/AppContext';
import { useSystemStats } from '@/hooks/useSystemStats';
import ChatBubble from '@/components/ChatBubble';
import ChatSidebar from '@/features/chat/ChatSidebar';
import { checkVideoRuntime, callMcpTool, effectiveRequestApiKey, isDesktopRuntime, listenDesktopFileDrops, readDesktopFileContent, readDesktopMedia, serverErrorHint, stopActiveChatCompletion, stopDesktopServer, streamChatCompletion, type ChatCompletionMessage, type VideoRuntimeInfo } from '@/lib/desktop';
import { modelVideoSupport } from '@/lib/modelCapabilities';
import { MAX_TOOL_ROUNDS, collectMcpToolSpecs, runChatToolLoop as runToolLoop, type ChatRoundRunner } from '@/features/chat/mcpTools';
import type { ChatMessageContentPart, ToolActivity } from '@/types';
import {
  CHAT_HISTORY_MODEL_ID,
  MAX_ATTACHMENT_BYTES,
  MAX_MEDIA_BYTES,
  attachmentToMultimodalPart,
  buildMultimodalUserMessage,
  classifyAttachment,
  compactModelName,
  createChatSession,
  dayLabel,
  downloadFile,
  estimateTextTokens,
  exportSessionAsJson,
  exportSessionAsMarkdown,
  fileExtension,
  fileNameFromPath,
  formatFileSize,
  type AttachmentKind,
  type MediaAttachment,
  type PendingAttachment,
  type TextAttachment,
} from '@/features/chat/chatUtils';
import type { ChatSession, Message } from '@/types';
import type { ReasoningMode } from '@/types';
import { toolLabel } from '@/lib/llamaTools';
import useMediaQuery from '@/hooks/useMediaQuery';

const REASONING_OPTIONS: Array<{ mode: ReasoningMode; label: string; description: string }> = [
  { mode: 'off', label: '关闭', description: '不请求 thinking 输出' },
  { mode: 'auto', label: '自动', description: '按模型能力自动启用' },
  { mode: 'think', label: '思考', description: '使用常规思考预算' },
  { mode: 'deep', label: '深思', description: '使用更高思考预算' },
];

const AUTO_SCROLL_MAGNET_PX = 56;
const SCROLL_RELEASE_DELTA_PX = 2;

function hasDraggedFiles(dataTransfer: DataTransfer) {
  return dataTransfer.files.length > 0 || Array.from(dataTransfer.types).some((type) => type === 'Files');
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      resolve(result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

function classifyAttachmentByName(name: string): AttachmentKind | null {
  const fakeFile = { name, type: '', size: 0 };
  return classifyAttachment(fakeFile);
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
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const messagesViewportRef = useRef<HTMLDivElement>(null);
  // 消息列表的内容容器（高度由虚拟列表的占位元素驱动）。用它的尺寸变化来贴底。
  const messagesContentRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const reasoningMenuRef = useRef<HTMLDivElement>(null);
  // 按会话保存中止句柄。曾经这里只有单个槽位，切到另一个会话再发送时
  // 前一个会话的 controller 引用会被覆盖并永久丢失，那条流既停不掉也无从追踪。
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const shouldStickToBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  // 最近一次程序滚动（scrollToIndex/跳底）的时间戳：滚动事件回调里用它区分
  // 「我们自己滚的」和「用户滚的」，避免测量修正把用户刚解除的吸附又打开。
  const programmaticScrollAtRef = useRef(0);
  // 最近一次由我们直接写入的 scrollTop 值。内容收缩会让写入值比上次小，
  // 用值比对（而非时间窗）排除这类伪「用户上滑」，同时不影响用户拖动滚动条。
  const programmaticScrollTopRef = useRef(-1);

  const activeModel = state.models.find((m) => m.id === state.activeModelId);
  const activeVideoSupport = modelVideoSupport(activeModel);
  // 视频候选模型的原生视频依赖 ffmpeg/ffprobe，提前检测一次并在提示里说明。
  const [videoRuntime, setVideoRuntime] = useState<VideoRuntimeInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    void checkVideoRuntime().then((info) => {
      if (!cancelled) setVideoRuntime(info);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  const attachmentNotice = useMemo(() => {
    if (!pendingAttachments.some((attachment) => attachment.kind === 'video')) return null;
    if (activeVideoSupport === 'candidate') {
      const ready = videoRuntime?.native_video_ready;
      return ready
        ? '当前模型属于视频候选：已检测到 ffmpeg/ffprobe，将以原生视频处理。'
        : videoRuntime
          ? '当前模型属于视频候选：未检测到 ffmpeg/ffprobe，将自动改用抽帧兼容；可安装 ffmpeg 或把 ffmpeg.exe/ffprobe.exe 放入 resources 目录。'
          : '当前模型属于视频候选：ffmpeg/ffprobe 就绪时使用原生视频，否则自动改用抽帧兼容。';
    }
    if (activeVideoSupport === 'frames') {
      return '当前模型未验证原生视频，将最多抽取 8 帧作为图片分析，不能保证动作和时间关系。';
    }
    if (activeVideoSupport === 'none') {
      return '当前模型不支持视频输入，请切换到已验证的视频模型。';
    }
    return null;
  }, [activeVideoSupport, pendingAttachments, videoRuntime]);
  const loadedModel = activeModel?.status === 'loaded'
    ? activeModel
    : state.models.find((model) => model.status === 'loaded');
  const sidebarModel = loadedModel ?? activeModel;
  const desktopReady = isDesktopRuntime();
  const systemStats = useSystemStats();
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
  const vramPercent = systemStats.vramTotal > 0
    ? Math.min(100, Math.max(0, (systemStats.vramUsed / systemStats.vramTotal) * 100))
    : undefined;
  const modelMessages = useMemo(() => activeSession?.messages ?? [], [activeSession]);
  const hasMessageRows = modelMessages.length > 0;
  // 本地会话累计水位：按消息顺序逐条粗估 token（气泡与服务状态面板共用这一口径）。
  const sessionCtxTotals = useMemo(() => {
    let acc = 0;
    return modelMessages.map((msg) => {
      acc += estimateTextTokens(msg.content) + estimateTextTokens(msg.reasoningContent ?? '');
      return acc;
    });
  }, [modelMessages]);
  // 水位基准：当前加载模型的上下文容量（-c）。
  const ctxCapacity = activeModel?.loadConfig.ctxLength || activeModel?.ctxLength || 0;
  // 侧边栏状态卡 ctx：与对话气泡同口径——当前会话的本地累计水位（粗估），
  // 容量取当前加载模型的 -c。日志口径归 API 页，两处不要混。
  const sessionCtxUsed = sessionCtxTotals.length > 0
    ? sessionCtxTotals[sessionCtxTotals.length - 1]
    : 0;
  const ctxPercent = ctxCapacity > 0 && sessionCtxUsed > 0
    ? Math.min(100, Math.max(0, (sessionCtxUsed / ctxCapacity) * 100))
    : undefined;
  const streamingMessage = modelMessages.find((message) => message.isStreaming);
  // 当前会话是否在生成——决定本会话的输入区状态。
  const isGenerating = Boolean(streamingMessage);
  // 是否有任意会话在生成——决定「停止生成」按钮是否出现、以及能否再发起新请求。
  // 只看当前会话会让用户切换会话后失去中止入口，并且能并发发起第二条流。
  const isAnyGenerating = useMemo(
    () =>
      Object.values(state.chatSessions).some((sessions) =>
        sessions.some((session) => session.messages.some((message) => message.isStreaming))
      ),
    [state.chatSessions]
  );
  const lastMessage = modelMessages[modelMessages.length - 1];
  const lastMessageContent = lastMessage?.content;
  const lastMessageReasoningContent = lastMessage?.reasoningContent;
  const lastMessageStreaming = lastMessage?.isStreaming;

  // 聊天消息虚拟化：仅渲染可见区域的消息，减少长对话 DOM 开销
  const virtualizer = useVirtualizer({
    count: modelMessages.length,
    getScrollElement: () => messagesViewportRef.current,
    estimateSize: () => 120,
    overscan: 5,
    // 流式输出时持续测量以跟踪高度变化
    measureElement: (el) => {
      const rowEl = el as HTMLElement;
      return rowEl.getBoundingClientRect().height;
    },
  });

  // 每次渲染读取当前总高：虚拟列表测量完变高的行会触发重渲染，这个值随之改变，
  // 从而驱动下面的贴底 layout effect 在绘制前重新对齐。必须在渲染期间读取才有意义，
  // 不能放进 effect 里取「上一次」的值。
  const totalSize = hasMessageRows ? virtualizer.getTotalSize() : 0;

  // 虚拟列表默认会在「条目变高且其起点在视口上方」时自行改写滚动位置，
  // 与我们的贴底逻辑叠加——同一次增高被修正两遍，表现为气泡被顶一下、整个画面抖动。
  // 贴底期间一律不交给库内处理，由我们的 pin 独占。
  // 未贴底（正在回看历史）时只补偿「完全位于视口上方」的条目：它们变高会把下方
  // 内容整体推走，补偿才能让正在读的位置保持不动。正在读的那条（跨视口顶边）以及
  // 底部仍在增长的流式条目一律不补偿，因此生成继续时视口不会自己移动。
  // 该选项只存在于 Virtualizer 实例上，不在构造参数里，故在此直接赋值。
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item) => {
    if (shouldStickToBottomRef.current) return false;
    const viewportTop = lastScrollTopRef.current;
    return item.start + item.size <= viewportTop;
  };

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

  // 「是否贴底」只由真实滚动位置决定（见 handleMessagesScroll），
  // 这里刻意不再用 IntersectionObserver：底部哨兵在带大内边距的容器里会长时间
  // 处于「可见」区间，把用户已经上滑离开的意图又改回贴底，于是生成一继续就把
  // 视口拽走。判定权收归滚动手势，避免与用户意图互相覆盖。

  // 思考框展开/收起 = 用户明确要停留阅读，立即脱离自动滚动；
  // 否则流式输出会在下一次内容变化时把视口重新拽到最底部，导致无法折叠。
  useEffect(() => {
    const release = () => {
      shouldStickToBottomRef.current = false;
    };
    window.addEventListener('agent-llm:thought-toggle', release);
    return () => window.removeEventListener('agent-llm:thought-toggle', release);
  }, []);

  useEffect(() => {
    const controllers = abortControllersRef.current;
    return () => {
      // 卸载时中止所有在途请求，避免流继续往已销毁的组件派发。
      controllers.forEach((controller) => controller.abort());
      controllers.clear();
    };
  }, []);

  // 内容变化后的贴底：只在用户确实处于底部时才跟随，并直接写 scrollTop。
  //
  // 时机是这里的关键。流式输出时列表总高由虚拟列表的占位元素决定，而占位高度要等
  // 虚拟列表把变高的行重新测量、触发一次 React 重渲染才会更新——所以「内容真的变高」
  // 发生在重渲染之后，只监听文字变化是不够的。因此把 totalSize 也作为依赖：重渲染一
  // 带上新的总高，这个 layout effect 就在浏览器绘制前运行，此时 scrollHeight 已是最终值，
  // 写入的贴底目标一步到位，中间态不会被看到。
  // 反之若用 setTimeout 推迟（原为 100ms 节流），写入落到绘制之后，内容已经长高、
  // 视口还停在原处，就会露出 30~40px 空档——用户看到的「每次新起一行都被顶一下」正是它。
  //
  // 未贴底时绝不触碰视口，只更新「回到底部」按钮的显隐。
  useLayoutEffect(() => {
    const viewport = messagesViewportRef.current;
    if (!viewport) return;
    if (shouldStickToBottomRef.current) {
      programmaticScrollAtRef.current = Date.now();
      viewport.scrollTop = viewport.scrollHeight;
      programmaticScrollTopRef.current = viewport.scrollTop;
      setShowJumpToBottom(false);
      return;
    }
    const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    setShowJumpToBottom(distanceToBottom > AUTO_SCROLL_MAGNET_PX);
  }, [modelMessages.length, lastMessageContent, lastMessageReasoningContent, lastMessageStreaming, totalSize]);

  // 兜底：内容容器尺寸变化时再补一次贴底。虚拟列表的测量与重渲染之间若有零星时序
  // 缝隙（例如首帧、字体回流），这一步能兜住；正常流式路径由上面的 layout effect 完成。
  // 用户上滑脱离后本回调不再触碰视口。
  // 依赖 hasMessageRows：空会话时内容容器还没渲染（走的是空状态分支），
  // 必须等它挂载后再观察。
  useEffect(() => {
    const viewport = messagesViewportRef.current;
    const content = messagesContentRef.current;
    if (!viewport || !content) return;
    const observer = new ResizeObserver(() => {
      if (!shouldStickToBottomRef.current) return;
      programmaticScrollAtRef.current = Date.now();
      viewport.scrollTop = viewport.scrollHeight;
      programmaticScrollTopRef.current = viewport.scrollTop;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [hasMessageRows]);

  // 切会话时一次性贴底（直接写 scrollTop，与流式路径同一套幂等语义）。
  useLayoutEffect(() => {
    shouldStickToBottomRef.current = true;
    lastScrollTopRef.current = 0;
    // 会话刚切换、内容还没渲染出来，旧会话的写入值不能拿去比对。
    programmaticScrollTopRef.current = -1;
    const viewport = messagesViewportRef.current;
    if (!viewport) return;
    programmaticScrollAtRef.current = Date.now();
    viewport.scrollTop = viewport.scrollHeight;
    programmaticScrollTopRef.current = viewport.scrollTop;
    setShowJumpToBottom(false);
  }, [activeSession?.id]);

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

  useEffect(() => {
    if (!reasoningMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (reasoningMenuOpen && target && !reasoningMenuRef.current?.contains(target)) {
        setReasoningMenuOpen(false);
      }
    };
    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [reasoningMenuOpen]);

  const handleMessagesScroll = () => {
    const viewport = messagesViewportRef.current;
    if (!viewport) return;
    const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    // 程序滚动（贴底 pin / 跳底）自己触发的 scroll 事件不能算作「用户向上滚」：
    // 内容收缩几像素（例如生成结束移除「输出中」）时我们写下的新 scrollTop 会比
    // 上一次小，若不排掉就会被误判成用户离开底部，凭空冒出「回到底部」按钮。
    // 只比对「是不是我们刚写下的那个值」：用户拖动滚动条会得到一个不同的偏移，
    // 依然能被正确识别为手动滚动（用时间窗会把流式期间的拖动也一起吞掉）。
    // -1 是「本会话还没有过程序滚动」的哨兵，此时不参与比对。
    if (programmaticScrollTopRef.current >= 0
      && Math.abs(viewport.scrollTop - programmaticScrollTopRef.current) <= SCROLL_RELEASE_DELTA_PX) {
      lastScrollTopRef.current = viewport.scrollTop;
      setShowJumpToBottom(distanceToBottom > AUTO_SCROLL_MAGNET_PX);
      return;
    }
    if (viewport.scrollTop < lastScrollTopRef.current - SCROLL_RELEASE_DELTA_PX) {
      // 用户向上滚：立刻脱离自动滚动，滚轮/触摸/键盘的释放监听与此处互为兜底。
      shouldStickToBottomRef.current = false;
    } else if (distanceToBottom <= AUTO_SCROLL_MAGNET_PX) {
      // 只有用户自己（或明确的跳底按钮）滚回底部附近才重新吸附；
      // 程序滚动后的 160ms 内不重新吸附，防止测量修正悄悄把用户拉回底部。
      if (Date.now() - programmaticScrollAtRef.current > 160 || shouldStickToBottomRef.current) {
        shouldStickToBottomRef.current = true;
      }
    }
    lastScrollTopRef.current = viewport.scrollTop;
    setShowJumpToBottom(distanceToBottom > AUTO_SCROLL_MAGNET_PX);
  };

  const jumpToBottom = useCallback(() => {
    shouldStickToBottomRef.current = true;
    programmaticScrollAtRef.current = Date.now();
    // 平滑滚动期间由库逐帧改 scrollTop，不归 pin 管：哨兵置 -1 让滚动事件
    // 走正常判定，用户此刻的任何手动滚动都仍然优先。
    programmaticScrollTopRef.current = -1;
    virtualizer.scrollToIndex(modelMessages.length - 1, { align: 'end', behavior: 'smooth' });
    setShowJumpToBottom(false);
  }, [modelMessages.length, virtualizer]);

  const jumpToMessage = useCallback((messageId: string) => {
    const index = modelMessages.findIndex((msg) => msg.id === messageId);
    if (index < 0) return;
    shouldStickToBottomRef.current = false;
    // 同上：跳转后即使生成在继续，也不能因为底部涨高就把视口拽回底部。
    programmaticScrollTopRef.current = -1;
    virtualizer.scrollToIndex(index, { align: 'center', behavior: 'smooth' });
    setShowJumpToBottom(true);
  }, [modelMessages, virtualizer]);

  const releaseAutoScroll = () => {
    shouldStickToBottomRef.current = false;
  };

  const processAttachmentFiles = async (files: File[]) => {
    if (files.length === 0) return;

    const nextAttachments: PendingAttachment[] = [];
    const errors: string[] = [];

    for (const file of files) {
      const kind = classifyAttachment(file);
      if (!kind) {
        errors.push(`${file.name} 不是支持的文本、代码、数据、图片、音频或视频文件。`);
        continue;
      }
      if (kind === 'text') {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          errors.push(`${file.name} 超过文本附件 ${formatFileSize(MAX_ATTACHMENT_BYTES)} 限制。`);
          continue;
        }
        try {
          const content = (await file.text()).split(String.fromCharCode(0)).join('');
          nextAttachments.push({
            id: `${file.name}-${file.lastModified}-${file.size}`,
            name: file.name,
            size: file.size,
            extension: fileExtension(file.name),
            kind: 'text',
            content,
          });
        } catch (error) {
          errors.push(`${file.name} ${String(error instanceof Error ? error.message : error)}`);
        }
        continue;
      }
      if (file.size > MAX_MEDIA_BYTES) {
        errors.push(`${file.name} 超过媒体附件 ${formatFileSize(MAX_MEDIA_BYTES)} 限制。`);
        continue;
      }
      const dataUrl = await readFileAsDataUrl(file);
      nextAttachments.push({
        id: `${file.name}-${file.lastModified}-${file.size}`,
        name: file.name,
        size: file.size,
        extension: fileExtension(file.name),
        kind,
        mimeType: file.type || undefined,
        dataUrl,
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
      const ext = fileExtension(name);
      const kind = classifyAttachmentByName(name);
      if (!kind) {
        errors.push(`${name} 不是支持的文本、代码、数据、图片、音频或视频文件。`);
        continue;
      }
      try {
        if (kind !== 'text') {
          const media = await readDesktopMedia(path);
          if (media.byte_size > MAX_MEDIA_BYTES) {
            errors.push(`${name} 超过媒体附件 ${formatFileSize(MAX_MEDIA_BYTES)} 限制。`);
            continue;
          }
          nextAttachments.push({
            id: `${path}-${Date.now()}-${nextAttachments.length}`,
            name,
            size: media.byte_size,
            extension: ext,
            kind,
            path,
            mimeType: media.mime_type,
            dataUrl: `data:${media.mime_type};base64,${media.data_base64}`,
          });
        } else {
          const content = (await readDesktopFileContent(path)).split(String.fromCharCode(0)).join('');
          const size = new Blob([content]).size;
          if (size > MAX_ATTACHMENT_BYTES) {
            errors.push(`${name} 超过文本附件 ${formatFileSize(MAX_ATTACHMENT_BYTES)} 限制。`);
            continue;
          }
          nextAttachments.push({
            id: `${path}-${Date.now()}-${nextAttachments.length}`,
            name,
            size,
            extension: ext,
            kind: 'text',
            content,
          });
        }
      } catch (error) {
        errors.push(`${name} ${String(error instanceof Error ? error.message : error)}`);
      }
    }

    setPendingAttachments((current) => [...current, ...nextAttachments]);
    setAttachmentError(errors.length > 0 ? errors.join(' ') : null);
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
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
      if (cancelled) { nextUnlisten?.(); return; }
      unlisten = nextUnlisten;
    });
    return () => {
      cancelled = true;
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
    // 用 isAnyGenerating 而非 isGenerating：否则切换会话后能并发发起第二条流，
    // 两条请求会抢同一个 llama-server slot。
    if ((!inputText.trim() && pendingAttachments.length === 0) || !activeModel || !canChat || isAnyGenerating) return;
    shouldStickToBottomRef.current = true;

    const textAttachments = pendingAttachments.filter((a): a is TextAttachment => a.kind === 'text');
    const mediaAttachments = pendingAttachments.filter((a): a is MediaAttachment => a.kind !== 'text');

    const mediaParts: ChatMessageContentPart[] = [];
    const sendErrors: string[] = [];
    for (const media of mediaAttachments) {
      let dataUrl = media.dataUrl;
      if (!dataUrl && media.path) {
        try {
          const payload = await readDesktopMedia(media.path);
          dataUrl = `data:${payload.mime_type};base64,${payload.data_base64}`;
        } catch (error) {
          sendErrors.push(`${media.name} ${String(error instanceof Error ? error.message : error)}`);
          continue;
        }
      }
      if (!dataUrl) {
        sendErrors.push(`${media.name} 无法找到媒体数据，请重新添加文件。`);
        continue;
      }
      mediaParts.push(attachmentToMultimodalPart(media, dataUrl));
    }
    if (sendErrors.length > 0) {
      setAttachmentError(sendErrors.join(' '));
      return;
    }
    // 媒体附件能力校验
    const imageParts = mediaAttachments.filter((a) => a.kind === 'image');
    const videoParts = mediaAttachments.filter((a) => a.kind === 'video');
    const audioParts = mediaAttachments.filter((a) => a.kind === 'audio');
    if (imageParts.length > 0 && !activeModel.supportsVision) {
      setAttachmentError('当前模型不支持图片输入（未检测到视觉 mmproj）。');
      return;
    }
    if (videoParts.length > 0 && !activeModel.supportsVision) {
      setAttachmentError('当前模型没有视觉 mmproj，无法处理视频或视频抽帧。');
      return;
    }
    if (videoParts.length > 0 && activeVideoSupport === 'none') {
      setAttachmentError('当前模型未检测到视频能力，请切换到已验证的视频模型。');
      return;
    }
    if (audioParts.length > 0 && !activeModel.supportsAudio) {
      setAttachmentError('当前模型不支持音频输入。');
      return;
    }
    const multimodal = buildMultimodalUserMessage(inputText.trim(), textAttachments, mediaParts);
    const displayContent = multimodal.kind === 'multimodal'
      ? (inputText.trim() || `${mediaAttachments.length} 个附件`)
      : (multimodal.text ?? '');

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
      content: displayContent,
      multimodalContent: multimodal.kind === 'multimodal' ? multimodal.content : undefined,
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
    abortControllersRef.current.set(sessionId, abortController);

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
    const updateAssistantContent = (content: string) => {
      dispatch({
        type: 'UPDATE_MESSAGE',
        payload: { modelId: sessionModelId, sessionId, messageId: assistantMsgId, content },
      });
      // 滚动统一由内容变化的 useLayoutEffect（100ms 节流）接管，避免每个 token 都 scrollToIndex。
    };
    const updateActivity = (activities: ToolActivity[]) => {
      dispatch({
        type: 'UPDATE_MESSAGE',
        payload: { modelId: sessionModelId, sessionId, messageId: assistantMsgId, toolActivity: activities },
      });
    };

    // MCP 工具清单：只纳入已连接服务器的工具；没有可用工具时请求不带 tools 字段。
    const toolSpecs = collectMcpToolSpecs(state.mcpServers);
    const conversation: ChatCompletionMessage[] = [...modelMessages, userMsg].map((msg) => ({
      role: msg.role,
      content: msg.multimodalContent ?? msg.content,
    }));
    const port = activeModel.serverPort ?? state.serverPort;
    const reasoningSupported = activeModel.tags.includes('Reasoning') || activeModel.loadConfig.reasoningBudget > 0;
    const runRound: ChatRoundRunner = (messages, handlers) => streamChatCompletion({
      port,
      modelName: activeModel.name,
      config: state.chatConfig,
      ctxTotal: activeModel.loadConfig.ctxLength,
      supportsReasoning: reasoningSupported,
      reasoningBudget: activeModel.loadConfig.reasoningBudget,
      videoSupport: activeVideoSupport,
      apiKey: effectiveRequestApiKey(state.apiConfig),
      signal: abortController.signal,
      ...(toolSpecs.specs.length > 0 ? { tools: toolSpecs.specs } : {}),
      messages,
      onToken: handlers.onToken,
      onReasoningDelta: handlers.onReasoningDelta,
    });

    try {
      const first = await runRound(conversation, {
        onToken: (token) => {
          streamedContent += token;
          updateAssistantContent(streamedContent);
        },
        onReasoningDelta: (reasoningContent) => {
          dispatch({
            type: 'UPDATE_MESSAGE',
            payload: { modelId: sessionModelId, sessionId, messageId: assistantMsgId, reasoningContent },
          });
        },
      });

      // 工具调用循环：模型请求工具 → 应用执行 → 结果回填 → 继续生成。
      let metrics = first;
      if (first.toolCalls.length > 0) {
        const contentRef = { value: streamedContent };
        const outcome = await runToolLoop({
          runRound: async (messages, handlers) => {
            const result = await runRound(messages, handlers);
            metrics = result;
            return result;
          },
          servers: state.mcpServers,
          conversation,
          initialContent: streamedContent,
          initialPromptTokens: first.promptTokens,
          initialCompletionTokens: first.completionTokens,
          initialMetrics: first,
          callTool: async (serverId, toolName, args) => {
            const payload = await callMcpTool(serverId, toolName, args);
            return { text: payload?.text ?? '', isError: payload?.isError };
          },
          signal: abortController.signal,
          onContent: (content) => {
            contentRef.value = content;
            updateAssistantContent(content);
          },
          onReasoningDelta: (reasoningContent) => {
            dispatch({
              type: 'UPDATE_MESSAGE',
              payload: { modelId: sessionModelId, sessionId, messageId: assistantMsgId, reasoningContent },
            });
          },
          onActivity: updateActivity,
        });

        streamedContent = contentRef.value;
        if (outcome.hitRoundLimit) {
          streamedContent += `\n\n（本轮工具调用已达 ${MAX_TOOL_ROUNDS} 轮上限，为避免失控已停止继续调用。）`;
          updateAssistantContent(streamedContent);
        }
        metrics = outcome.metrics;
      }

      const genTime = (performance.now() - startTime) / 1000;
      if (metrics.promptTokens > 0 || metrics.completionTokens > 0) {
        dispatch({
          type: 'ADD_USAGE',
          payload: {
            modelId: activeModel.id,
            modelName: activeModel.name,
            modelColor: activeModel.themeColorSolid,
            promptTokens: metrics.promptTokens,
            completionTokens: metrics.completionTokens,
            totalTokens: metrics.promptTokens + metrics.completionTokens,
            tokensPerSec: metrics.tokensPerSec,
            firstTokenDelay: metrics.firstTokenDelay,
            genTime,
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
        const message = `本地推理请求失败：${String(error instanceof Error ? error.message : error)}\n\n${serverErrorHint(error)}`;
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
      if (abortControllersRef.current.get(sessionId) === abortController) {
        abortControllersRef.current.delete(sessionId);
      }
    }
  };

  const handleEditAndResend = async (messageId: string, content: string) => {
    if (!activeSession || !activeModel || !canChat || isAnyGenerating) return;
    const messageIndex = modelMessages.findIndex((message) => message.id === messageId && message.role === 'user');
    if (messageIndex === -1) return;

    shouldStickToBottomRef.current = true;
    setStopMessage(null);
    setAttachmentError(null);

    const originalMultimodal = modelMessages[messageIndex].multimodalContent;
    const editedUserMessage = {
      ...modelMessages[messageIndex],
      content,
      timestamp: Date.now(),
      multimodalContent: originalMultimodal
        ? originalMultimodal.some((part) => part.type === 'text')
          ? originalMultimodal.map((part) =>
              part.type === 'text' ? { ...part, text: content } : part
            )
          : [{ type: 'text' as const, text: content }, ...originalMultimodal]
        : undefined,
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
    abortControllersRef.current.set(sessionId, abortController);

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
    const updateAssistantContent = (content: string) => {
      dispatch({
        type: 'UPDATE_MESSAGE',
        payload: { modelId: sessionModelId, sessionId, messageId: assistantMsgId, content },
      });
      // 滚动统一由内容变化的 useLayoutEffect（100ms 节流）接管，避免每个 token 都 scrollToIndex。
    };
    const updateActivity = (activities: ToolActivity[]) => {
      dispatch({
        type: 'UPDATE_MESSAGE',
        payload: { modelId: sessionModelId, sessionId, messageId: assistantMsgId, toolActivity: activities },
      });
    };

    const toolSpecs = collectMcpToolSpecs(state.mcpServers);
    const conversation: ChatCompletionMessage[] = nextHistory.map((message) => ({
      role: message.role,
      content: message.multimodalContent ?? message.content,
    }));
    const port = activeModel.serverPort ?? state.serverPort;
    const reasoningSupported = activeModel.tags.includes('Reasoning') || activeModel.loadConfig.reasoningBudget > 0;
    const runRound: ChatRoundRunner = (messages, handlers) => streamChatCompletion({
      port,
      modelName: activeModel.name,
      config: state.chatConfig,
      ctxTotal: activeModel.loadConfig.ctxLength,
      supportsReasoning: reasoningSupported,
      reasoningBudget: activeModel.loadConfig.reasoningBudget,
      videoSupport: activeVideoSupport,
      apiKey: effectiveRequestApiKey(state.apiConfig),
      signal: abortController.signal,
      ...(toolSpecs.specs.length > 0 ? { tools: toolSpecs.specs } : {}),
      messages,
      onToken: handlers.onToken,
      onReasoningDelta: handlers.onReasoningDelta,
    });

    try {
      const first = await runRound(conversation, {
        onToken: (token) => {
          streamedContent += token;
          updateAssistantContent(streamedContent);
        },
        onReasoningDelta: (reasoningContent) => {
          dispatch({
            type: 'UPDATE_MESSAGE',
            payload: { modelId: sessionModelId, sessionId, messageId: assistantMsgId, reasoningContent },
          });
        },
      });

      let metrics = first;
      if (first.toolCalls.length > 0) {
        const contentRef = { value: streamedContent };
        const outcome = await runToolLoop({
          runRound: async (messages, handlers) => {
            const result = await runRound(messages, handlers);
            metrics = result;
            return result;
          },
          servers: state.mcpServers,
          conversation,
          initialContent: streamedContent,
          initialPromptTokens: first.promptTokens,
          initialCompletionTokens: first.completionTokens,
          initialMetrics: first,
          callTool: async (serverId, toolName, args) => {
            const payload = await callMcpTool(serverId, toolName, args);
            return { text: payload?.text ?? '', isError: payload?.isError };
          },
          signal: abortController.signal,
          onContent: (content) => {
            contentRef.value = content;
            updateAssistantContent(content);
          },
          onReasoningDelta: (reasoningContent) => {
            dispatch({
              type: 'UPDATE_MESSAGE',
              payload: { modelId: sessionModelId, sessionId, messageId: assistantMsgId, reasoningContent },
            });
          },
          onActivity: updateActivity,
        });
        streamedContent = contentRef.value;
        if (outcome.hitRoundLimit) {
          streamedContent += `\n\n（本轮工具调用已达 ${MAX_TOOL_ROUNDS} 轮上限，为避免失控已停止继续调用。）`;
          updateAssistantContent(streamedContent);
        }
        metrics = outcome.metrics;
      }

      const genTime = (performance.now() - startTime) / 1000;
      if (metrics.promptTokens > 0 || metrics.completionTokens > 0) {
        dispatch({
          type: 'ADD_USAGE',
          payload: {
            modelId: activeModel.id,
            modelName: activeModel.name,
            modelColor: activeModel.themeColorSolid,
            promptTokens: metrics.promptTokens,
            completionTokens: metrics.completionTokens,
            totalTokens: metrics.promptTokens + metrics.completionTokens,
            tokensPerSec: metrics.tokensPerSec,
            firstTokenDelay: metrics.firstTokenDelay,
            genTime,
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
        const message = `重新发送失败：${String(error instanceof Error ? error.message : error)}\n\n${serverErrorHint(error)}`;
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
      if (abortControllersRef.current.get(sessionId) === abortController) {
        abortControllersRef.current.delete(sessionId);
      }
    }
  };

  const handleStopGeneration = () => {
    // 中止全部在途请求：用户可能已经切换过会话，
    // 只停当前会话会留下停不掉的后台流。
    abortControllersRef.current.forEach((controller) => controller.abort());
    abortControllersRef.current.clear();
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
    if (isAnyGenerating) return;
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

  const handleExportSession = (sessionId: string) => {
    const session = chatSessions.find((s) => s.id === sessionId);
    if (!session) return;

    // 弹出选择导出格式的对话框
    const format = prompt('选择导出格式：输入 md 导出为 Markdown，输入 json 导出为 JSON', 'md');
    if (!format) return;

    const safeTitle = session.title.replace(/[<>:"/\\|?*]/g, '_').slice(0, 50);
    const dateStr = new Date(session.createdAt).toISOString().slice(0, 10);

    if (format.toLowerCase() === 'json') {
      const content = exportSessionAsJson(session);
      downloadFile(content, `${safeTitle}-${dateStr}.json`, 'application/json');
    } else {
      const content = exportSessionAsMarkdown(session);
      downloadFile(content, `${safeTitle}-${dateStr}.md`, 'text/markdown');
    }
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
  const compactSidebar = useMediaQuery('(max-width: 959px)');
  // 超宽视口：消息列与输入框同步放宽到 max-w-4xl（896px）。
  const wideViewport = useMediaQuery('(min-width: 1600px)');
  const sidebarCollapsed = state.sidebarCollapsed || compactSidebar;
  const sidebarWidth = sidebarCollapsed ? 64 : 288;
  const currentReasoningOption = REASONING_OPTIONS.find((item) => item.mode === state.chatConfig.reasoningMode) ?? REASONING_OPTIONS[1];
  const enabledToolsText = state.chatConfig.enabledTools.length > 0
    ? state.chatConfig.enabledTools.map(toolLabel).join('、')
    : '未启用';
  const runtimeStatusText = isGenerating ? '生成中' : state.serverRunning ? '运行中' : '未加载';

  return (
    <div
      className="relative flex h-full min-h-0 overflow-hidden bg-[var(--app-bg)] text-[15.5px] text-[var(--text-primary)] dark:bg-[var(--app-bg)] dark:text-[var(--text-primary)]"
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
            className="pointer-events-none absolute inset-3 z-40 flex items-center justify-center border border-dashed border-[var(--accent)] bg-[var(--app-bg)]/80"
          >
            <div className="border-b border-[var(--border-subtle)] px-5 py-4 text-center">
              <FileText className="mx-auto mb-2 h-6 w-6 text-[var(--accent)]" />
              <div className="text-[15px] font-semibold text-[var(--text-primary)] dark:text-[var(--text-primary)]">松开即可上传到当前对话</div>
              <div className="mt-1 text-[13px] text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">支持文本、代码、JSON、Markdown、图片、音频、视频等文件</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <ChatSidebar
        activeModel={sidebarModel}
        canChat={canChat}
        collapsed={sidebarCollapsed}
        collapseLocked={compactSidebar}
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
        onExportSession={handleExportSession}
        onOpenGlobalSettings={() => {
          if (typeof window !== 'undefined') {
            window.sessionStorage.setItem('agent-llm-settings-return-view', 'chat');
          }
          dispatch({ type: 'SET_VIEW', payload: 'settings' });
        }}
        onOpenModelLoad={handleOpenModelLoad}
        onToggleTheme={() => dispatch({ type: 'TOGGLE_THEME' })}
        onToggleCollapse={() => dispatch({ type: 'TOGGLE_SIDEBAR' })}
        onSwitchToModel={() => dispatch({ type: 'SET_VIEW', payload: 'home' })}
        theme={state.theme}
        sidebarWidth={sidebarWidth}
        ctxPercent={ctxPercent}
        vramPercent={vramPercent}
      />

      <section className="relative grid min-w-0 flex-1 grid-rows-[54px_minmax(0,1fr)] overflow-hidden bg-[var(--app-bg)] dark:bg-[var(--app-bg)]">
        <header className="flex min-w-0 items-center justify-between border-b border-black/[0.055] px-5 dark:border-white/[0.055]">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold text-[var(--text-primary)] dark:text-[var(--text-primary)]">{activeTitle}</h1>
              <p className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-[var(--text-tertiary)] dark:text-[var(--text-secondary)]">
                <span className="truncate">{compactModelName(activeHeaderModelName)}</span>
                <span className="h-1 w-1 flex-shrink-0 rounded-full bg-[var(--text-tertiary)] dark:bg-white/30" />
                <span className="truncate">{canChat ? 'llama-server 已连接' : '历史对话可查看'}</span>
              </p>
            </div>
          </div>

          <div className="flex flex-shrink-0 items-center gap-1.5">
            <span
              className={`mr-1 hidden h-8 flex-shrink-0 items-center gap-1.5 whitespace-nowrap px-2 text-xs font-medium transition-colors sm:inline-flex ${
                isGenerating
                    ? 'text-[var(--state-warning)] dark:text-[var(--accent)]'
                    : canChat
                      ? 'text-[var(--state-success)] dark:text-[var(--state-success)]'
                      : 'text-[var(--text-tertiary)] dark:text-[var(--text-secondary)]'
              }`}
            >
              <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0" />
              {runtimeStatusText}
            </span>
            {isAnyGenerating && (
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
                className="h-full w-full max-w-sm border-l border-[var(--border)] bg-[var(--surface-muted)] p-5 shadow-xl dark:border-white/[0.08] dark:bg-[var(--app-bg)]"
                onClick={(event) => event.stopPropagation()}
              >
                <ChatSettingsPanel onClose={() => setShowSettings(false)} />
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="relative min-h-0 overflow-hidden">
            <ConversationQuickRail
              messages={modelMessages}
              activeMessageId={lastMessage?.id}
              onSelect={jumpToMessage}
            />
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
              className="h-full min-h-0 overflow-y-auto px-[clamp(18px,5vw,72px)] pb-[clamp(138px,19vh,208px)] pt-7"
            >
              {modelMessages.length === 0 ? (
                <div className="flex h-full items-center justify-center text-center">
                  <div className="max-w-md px-8 py-9">
                    <div className="mx-auto mb-4 text-sm font-semibold tracking-[0.22em] text-[var(--accent)] dark:text-[var(--accent)]">LOCAL LLM</div>
                    <h2 className="mb-2 text-xl font-semibold text-[var(--text-primary)] dark:text-[var(--text-primary)]">{activeTitle}</h2>
                    <p className="text-sm leading-relaxed text-[var(--text-tertiary)] dark:text-[var(--text-secondary)]">{emptyMessage}</p>
                  </div>
                </div>
              ) : (
                <div ref={messagesContentRef} style={{ position: 'relative', width: '100%', maxWidth: wideViewport ? 896 : 768, margin: '0 auto', minWidth: 0 }}>
                  <div style={{ height: virtualizer.getTotalSize() }} />
                  {virtualizer.getVirtualItems().map((virtualRow) => {
                    const msg = modelMessages[virtualRow.index];
                    return (
                      <div
                        key={msg.id}
                        data-index={virtualRow.index}
                        ref={virtualizer.measureElement}
                        id={`chat-message-${msg.id}`}
                        className="anim-fade-in"
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                      >
                        <ChatBubble
                          message={msg}
                          modelId={activeSessionModelId}
                          sessionId={activeSession?.id ?? ''}
                          sessionModelName={chatBubbleModelName}
                          sessionModelColor={activeSessionModelColor}
                          sessionCtx={{ used: sessionCtxTotals[virtualRow.index] ?? 0, total: ctxCapacity }}
                          onEditAndResend={canChat && !isAnyGenerating ? handleEditAndResend : undefined}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="pointer-events-none absolute bottom-[clamp(132px,18vh,198px)] left-1/2 z-30 -translate-x-1/2">
              <AnimatePresence>
                {showJumpToBottom && (
                  <motion.button
                    key="jump-to-bottom"
                    initial={{ opacity: 0, scale: 0.8, y: 6 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.8, y: 6 }}
                    transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                    onClick={jumpToBottom}
                    className="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full border border-black/[0.10] bg-[var(--surface)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--border)] hover:text-[var(--text-primary)] dark:border-white/[0.10] dark:bg-[var(--app-bg)] dark:text-[var(--text-secondary)] dark:hover:bg-[var(--surface-raised)] dark:hover:text-[var(--text-primary)]"
                    title="滚动到最底部"
                  >
                    <ArrowDown className="h-4 w-4" />
                  </motion.button>
                )}
              </AnimatePresence>
            </div>

            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-[var(--surface)] via-[var(--surface)]/95 to-transparent px-[clamp(12px,4vw,48px)] pb-4 pt-10 dark:from-[var(--app-bg)] dark:via-[var(--app-bg)]/95">
              <div className="pointer-events-auto mx-auto w-full max-w-3xl min-[1600px]:max-w-4xl min-w-0">
                {(pendingAttachments.length > 0 || attachmentError || attachmentNotice || stopMessage) && (
                  <div className="mb-2 space-y-2">
                    {pendingAttachments.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {pendingAttachments.map((file) => (
                          <div key={file.id} className="flex max-w-full min-w-0 items-center gap-2 rounded-md bg-black/[0.045] px-3 py-2 text-xs text-[var(--text-secondary)] dark:bg-white/[0.055] dark:text-[var(--text-secondary)]">
                            <FileText className="h-3.5 w-3.5 flex-shrink-0 text-[var(--accent)]" />
                            <span className="max-w-[220px] truncate text-[var(--text-primary)] dark:text-[var(--text-primary)]">{file.name}</span>
                            <span className="mono-font flex-shrink-0">{formatFileSize(file.size)}</span>
                            <button
                              onClick={() => removeAttachment(file.id)}
                              className="rounded-md p-0.5 transition-colors hover:bg-[var(--border)] dark:hover:bg-white/[0.08]"
                              title="移除附件"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    {attachmentError && (
                      <div className="flex items-center gap-2 text-xs text-[var(--state-danger)] dark:text-[var(--state-danger)]">
                        <FileWarning className="h-3.5 w-3.5 flex-shrink-0" />
                        <span>{attachmentError}</span>
                      </div>
                    )}
                    {attachmentNotice && !attachmentError && (
                      <div className="flex items-center gap-2 text-xs text-[var(--state-danger)] dark:text-[var(--accent)]">
                        <Info className="h-3.5 w-3.5 flex-shrink-0" />
                        <span>{attachmentNotice}</span>
                      </div>
                    )}
                    {stopMessage && (
                      <div className="text-xs text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">{stopMessage}</div>
                    )}
                  </div>
                )}

                {/* 注意：这里不能加 overflow-hidden——思考强度菜单从卡片内向上弹出，
                    裁剪会把菜单剪到只剩一项（其余项不可见且无法点击）。 */}
                <div className="min-h-[82px] rounded-[18px] border border-black/[0.11] bg-white transition-colors focus-within:border-black/25 dark:border-white/[0.14] dark:bg-[var(--surface)] dark:focus-within:border-white/25">
                  <textarea
                    ref={textareaRef}
                    value={inputText}
                    onChange={(event) => setInputText(event.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={inputPlaceholder}
                    disabled={!canChat}
                    rows={2}
                    spellCheck={false}
                    autoCorrect="off"
                    autoCapitalize="off"
                    className="chat-composer-input max-h-[180px] min-h-[58px] w-full resize-none bg-transparent px-4 pt-3.5 text-[15px] leading-6 text-[var(--text-primary)] outline-none [overflow-wrap:anywhere] placeholder:text-[var(--text-secondary)] disabled:opacity-60 dark:text-[var(--text-primary)] dark:placeholder:text-[var(--text-tertiary)]"
                  />
                  <div className="flex min-w-0 items-center gap-1.5 px-2.5 pb-2.5">
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      accept=".txt,.md,.markdown,.json,.jsonl,.csv,.tsv,.log,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.rs,.go,.java,.c,.cpp,.h,.hpp,.cs,.php,.rb,.swift,.kt,.kts,.sql,.toml,.yaml,.yml,.ini,.env,.bat,.ps1,.sh,.png,.jpg,.jpeg,.gif,.webp,.bmp,.tif,.tiff,.wav,.mp3,.m4a,.aac,.ogg,.flac,.opus,.mp4,.mov,.mkv,.webm,.avi,.m4v,.ogv,text/*,application/json,application/xml,image/*,audio/*,video/*"
                      className="hidden"
                      onChange={(event) => void handleAttachFiles(event)}
                    />
                    <InputToolButton icon={Plus} label="上传文件" onClick={() => fileInputRef.current?.click()} disabled={isGenerating} />
                    <div ref={reasoningMenuRef} className="relative flex-shrink-0">
                      <button
                        onClick={() => {
                          setReasoningMenuOpen((value) => !value);
                        }}
                        disabled={!canChat}
                        className={`flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors disabled:opacity-40 ${
                          state.chatConfig.reasoningMode === 'deep'
                            ? 'border-[var(--accent)]/55 bg-[var(--accent-subtle)] text-[var(--accent)] hover:bg-[var(--accent-subtle)] dark:border-[var(--accent)]/35 dark:bg-[var(--accent-subtle)] dark:text-[var(--accent)] dark:hover:bg-[var(--accent-subtle)]'
                            : 'border-transparent bg-transparent text-[var(--text-primary)] hover:bg-black/[0.055] dark:text-[var(--text-secondary)] dark:hover:bg-[var(--surface-raised)]'
                        }`}
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
                            className="absolute bottom-10 left-0 z-20 w-44 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--app-bg)] p-1 shadow-xl dark:border-white/[0.08] dark:bg-[var(--surface-raised)]"
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
                                    ? 'bg-[var(--surface-muted)] text-[var(--accent)] dark:bg-[var(--surface-raised)] dark:text-[var(--accent)]'
                                    : 'text-[var(--text-primary)] hover:bg-[var(--surface-muted)] dark:text-[var(--text-primary)] dark:hover:bg-white/[0.07]'
                                }`}
                              >
                                <div className="text-sm font-semibold">{item.label}</div>
                                <div className="mt-0.5 text-xs text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">{item.description}</div>
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
                    <span className="ml-auto hidden min-w-0 truncate px-2 text-xs text-[var(--text-secondary)] dark:text-[var(--text-secondary)] min-[960px]:block">
                      Enter 发送，Shift + Enter 换行
                    </span>
                    <button
                      onClick={isAnyGenerating ? handleStopGeneration : () => void handleSend()}
                      disabled={isAnyGenerating ? false : ((!inputText.trim() && pendingAttachments.length === 0) || !canChat)}
                      className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full transition-colors ${
                        isAnyGenerating
                          ? 'bg-red-500/10 text-red-600 hover:bg-red-500/15 dark:text-red-400'
                          : (inputText.trim() || pendingAttachments.length > 0) && canChat
                            ? 'bg-[var(--text-primary)] text-white hover:bg-black/85 dark:bg-[var(--accent)] dark:text-white dark:hover:bg-[var(--accent-hover)]'
                            : 'bg-[var(--border)] text-[var(--text-tertiary)] dark:bg-white/[0.08] dark:text-[var(--text-tertiary)]'
                      }`}
                      title={isAnyGenerating ? '停止生成' : '发送'}
                    >
                      {isAnyGenerating ? <Square className="h-4 w-4 fill-current" /> : <ArrowUp className="h-4 w-4" />}
                    </button>
                  </div>
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
            className="hidden min-h-0 flex-shrink-0 overflow-hidden border-l border-black/[0.06] bg-[var(--surface-muted)] dark:border-white/[0.06] dark:bg-[var(--app-bg)] xl:block"
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
      className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors disabled:opacity-35 ${
        tone === 'danger'
          ? 'text-[var(--state-danger)] hover:bg-[var(--state-danger-border)] dark:text-[var(--state-danger)] dark:hover:bg-[var(--surface-raised)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] dark:text-[var(--text-secondary)] dark:hover:bg-white/[0.08]'
      }`}
      title={label}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

function ConversationQuickRail({ messages, activeMessageId, onSelect }: {
  messages: Message[];
  activeMessageId?: string;
  onSelect: (messageId: string) => void;
}) {
  const turns = useMemo(() => {
    const grouped: Array<{
      id: string;
      messages: Message[];
      targetMessageId: string;
      questionPreview: string;
      answerPreview: string;
    }> = [];
    const messagePreview = (message: Message) => (
      (message.content || message.reasoningContent || '').replace(/\s+/g, ' ').trim()
    );

    messages.forEach((message) => {
      if (message.role === 'user' || grouped.length === 0) {
        grouped.push({
          id: message.id,
          messages: [message],
          targetMessageId: message.id,
          questionPreview: message.role === 'user' ? messagePreview(message) : '',
          answerPreview: message.role === 'assistant' ? messagePreview(message) : '',
        });
        return;
      }

      const currentTurn = grouped[grouped.length - 1];
      currentTurn.messages.push(message);
      if (!currentTurn.answerPreview) {
        currentTurn.answerPreview = messagePreview(message);
      }
    });

    return grouped;
  }, [messages]);
  const currentTurnId = useMemo(
    () => turns.find((turn) => turn.messages.some((message) => message.id === activeMessageId))?.id,
    [activeMessageId, turns]
  );
  const [hoveredTurnId, setHoveredTurnId] = useState<string | null>(null);

  if (turns.length === 0) return null;

  const hoveredIndex = turns.findIndex((turn) => turn.id === hoveredTurnId);
  const rowPitch = turns.length <= 8 ? 26 : turns.length <= 16 ? 22 : turns.length <= 28 ? 16 : turns.length <= 48 ? 11 : 7;
  const railHeight = Math.max(26, turns.length * rowPitch);
  const baseWidth = turns.length > 48 ? 5 : turns.length > 28 ? 6 : 8;

  return (
    <div className="pointer-events-none absolute bottom-[clamp(138px,19vh,208px)] left-2 top-6 z-20 hidden w-9 items-center md:flex">
      <div
        className="pointer-events-auto grid min-h-0 w-full overflow-visible"
        style={{
          height: `min(100%, ${railHeight}px)`,
          gridTemplateRows: `repeat(${turns.length}, minmax(0, 1fr))`,
        }}
        role="navigation"
        aria-label="对话问答刻度"
      >
      {turns.map((turn, index) => {
        const distance = hoveredIndex >= 0 ? Math.abs(index - hoveredIndex) : Number.POSITIVE_INFINITY;
        const hovered = turn.id === hoveredTurnId;
        const current = turn.id === currentTurnId;
        const influenced = hoveredIndex >= 0 && distance <= 3;
        const tickWidth = hovered ? 27 : distance === 1 ? 21 : distance === 2 ? 16 : distance === 3 ? 12 : baseWidth;
        const tickOpacity = hovered ? 1 : distance === 1 ? 0.82 : distance === 2 ? 0.64 : distance === 3 ? 0.48 : current ? 0.78 : 0.38;
        const questionPreview = turn.questionPreview || '未记录提问';
        const answerPreview = turn.answerPreview || (turn.messages.some((message) => message.isStreaming) ? '正在回答...' : '暂无回答');
        return (
          <button
            key={turn.id}
            type="button"
            onClick={() => onSelect(turn.targetMessageId)}
            onMouseEnter={() => setHoveredTurnId(turn.id)}
            onMouseLeave={() => setHoveredTurnId(null)}
            onFocus={() => setHoveredTurnId(turn.id)}
            onBlur={() => setHoveredTurnId(null)}
            className="relative flex min-h-0 w-full items-center justify-start rounded-sm pl-1"
            aria-label={`跳转到第 ${index + 1} 组问答。提问：${questionPreview.slice(0, 48)}。回答：${answerPreview.slice(0, 48)}`}
            aria-current={current ? 'true' : undefined}
          >
            <motion.span
              className={`block rounded-full ${
                hovered
                  ? 'bg-[var(--accent)] dark:bg-[var(--accent)]'
                  : influenced
                    ? 'bg-[var(--state-danger-border)] dark:bg-[var(--state-danger-border)]'
                    : current
                      ? 'bg-[var(--accent)] dark:bg-[var(--accent)]'
                    : 'bg-[var(--text-tertiary)] dark:bg-[var(--text-tertiary)]'
              }`}
              initial={false}
              animate={{
                width: tickWidth,
                height: hovered ? 3 : influenced && distance <= 2 ? 2 : 1.5,
                opacity: tickOpacity,
              }}
              transition={{ type: 'spring', stiffness: 520, damping: 36, mass: 0.32 }}
            />
            <AnimatePresence>
              {hovered && (
                <motion.span
                  key={`${turn.id}-preview`}
                  aria-hidden="true"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.12 }}
                  className={`pointer-events-none absolute left-10 z-40 w-[min(300px,calc(100vw-148px))] rounded-lg border border-[var(--border)] bg-[var(--app-bg)] p-3 text-left shadow-[0_8px_24px_rgba(61,53,42,0.16)] dark:border-white/[0.10] dark:bg-[var(--surface-raised)] ${
                    index === 0
                      ? 'top-0'
                      : index === turns.length - 1
                        ? 'bottom-0'
                        : 'top-1/2 -translate-y-1/2'
                  }`}
                >
                  <span className="mb-2 block text-[11px] font-semibold text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">
                    第 {index + 1} 组问答
                  </span>
                  <span className="flex items-start gap-2">
                    <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md bg-[var(--surface-muted)] text-[11px] font-semibold text-[var(--accent)] dark:bg-[var(--surface-raised)] dark:text-[var(--accent)]">问</span>
                    <span className="line-clamp-2 text-xs leading-5 text-[var(--text-primary)] dark:text-[var(--text-primary)]">{questionPreview}</span>
                  </span>
                  <span className="mt-2 flex items-start gap-2 border-t border-[var(--border)] pt-2 dark:border-white/[0.08]">
                    <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md bg-[var(--surface-muted)] text-[11px] font-semibold text-[var(--text-secondary)] dark:bg-white/[0.06] dark:text-[var(--text-secondary)]">答</span>
                    <span className="line-clamp-2 text-xs leading-5 text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">{answerPreview}</span>
                  </span>
                </motion.span>
              )}
            </AnimatePresence>
          </button>
        );
      })}
      </div>
    </div>
  );
}

function ChatSettingsPanel({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useApp();
  const [savingPreset, setSavingPreset] = useState(false);
  const [presetTitle, setPresetTitle] = useState('');
  const [presetMenuOpen, setPresetMenuOpen] = useState(false);
  const presetMenuRef = useRef<HTMLDivElement>(null);
  const currentPrompt = state.chatConfig.systemPrompt.trim();
  const activePreset = state.systemPromptPresets.find((preset) => preset.prompt === state.chatConfig.systemPrompt);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (presetMenuRef.current && !presetMenuRef.current.contains(e.target as Node)) {
        setPresetMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const applyPresetPrompt = (prompt: string) => {
    dispatch({ type: 'SET_CHAT_CONFIG', payload: { systemPrompt: prompt } });
    setPresetMenuOpen(false);
  };

  const cancelSavePreset = () => {
    setSavingPreset(false);
    setPresetTitle('');
  };

  const confirmSavePreset = () => {
    if (!currentPrompt) return;
    dispatch({
      type: 'SAVE_SYSTEM_PROMPT_PRESET',
      payload: { title: presetTitle, prompt: state.chatConfig.systemPrompt },
    });
    setPresetTitle('');
    setSavingPreset(false);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-4 flex items-center justify-between">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 truncate text-sm font-semibold text-[var(--text-primary)] dark:text-[var(--text-primary)]">
            <SlidersHorizontal className="h-4 w-4 flex-shrink-0 text-[var(--accent)]" />
            对话参数
          </h2>
          <p className="mt-1 truncate text-xs text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">当前会话 · 默认预设</p>
        </div>
        <button
          onClick={onClose}
          aria-label="关闭对话参数"
          title="关闭对话参数"
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors hover:bg-[var(--border)] dark:text-[var(--text-secondary)] dark:hover:bg-white/[0.08]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div>
          <div className="border-b border-black/[0.06] pb-5 dark:border-white/[0.06]">
            <div className="mb-2 flex items-center justify-between gap-2">
              <label className="text-sm font-medium text-[var(--text-primary)] dark:text-[var(--text-primary)]">系统提示词</label>
              {activePreset ? (
                <span className="flex min-w-0 items-center gap-1 text-xs text-[var(--accent)]" title={`使用标签「${activePreset.title}」`}>
                  <Tag className="h-3 w-3 flex-shrink-0" />
                  <span className="truncate">{activePreset.title}</span>
                </span>
              ) : (
                <span className="flex-shrink-0 text-xs text-[var(--text-tertiary)] dark:text-[var(--text-tertiary)]">
                  {state.chatConfig.systemPrompt.length > 0 ? `${state.chatConfig.systemPrompt.length} 字` : '未设置'}
                </span>
              )}
            </div>
            <textarea
              value={state.chatConfig.systemPrompt}
              onChange={(event) => dispatch({ type: 'SET_CHAT_CONFIG', payload: { systemPrompt: event.target.value } })}
              rows={7}
              placeholder="为当前对话设置角色、规则或输出格式"
              className="w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--app-bg)] px-3 py-2 text-sm leading-6 text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--accent)] dark:border-white/[0.08] dark:bg-[var(--app-bg)] dark:text-[var(--text-primary)] dark:placeholder:text-[var(--text-tertiary)]"
            />

            <div className="mt-3 flex min-w-0 items-center gap-2">
              <div ref={presetMenuRef} className="relative min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => setPresetMenuOpen((value) => !value)}
                  disabled={state.systemPromptPresets.length === 0}
                  aria-expanded={presetMenuOpen}
                  className="flex h-10 w-full min-w-0 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--app-bg)] px-3 text-sm transition-colors hover:bg-[var(--surface-muted)] disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/[0.08] dark:bg-[var(--app-bg)] dark:hover:bg-white/[0.05]"
                  title={state.systemPromptPresets.length === 0 ? '暂无预设，保存后可在此快速切换' : '选择已保存的预设'}
                >
                  <ChevronDown className="h-4 w-4 flex-shrink-0 text-[var(--text-secondary)] dark:text-[var(--text-secondary)]" />
                  <span className={`min-w-0 truncate ${activePreset ? 'font-medium text-[var(--text-primary)] dark:text-[var(--text-primary)]' : 'text-[var(--text-secondary)] dark:text-[var(--text-secondary)]'}`}>
                    {state.systemPromptPresets.length === 0
                      ? '暂无预设'
                      : activePreset
                        ? activePreset.title
                        : '选择预设'}
                  </span>
                  <span className="ml-auto flex-shrink-0 text-xs text-[var(--text-tertiary)] dark:text-[var(--text-tertiary)]">
                    {state.systemPromptPresets.length} 个
                  </span>
                </button>
                <AnimatePresence>
                  {presetMenuOpen && (
                    <motion.div
                      initial={{ opacity: 0, y: -4, scale: 0.98 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -4, scale: 0.98 }}
                      transition={{ duration: 0.14 }}
                      className="absolute left-0 top-full z-30 mt-1.5 max-h-64 w-full overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--app-bg)] p-1 shadow-xl dark:border-white/[0.08] dark:bg-[var(--surface-raised)]"
                    >
                      {state.systemPromptPresets.map((preset) => {
                        const selected = preset.prompt === state.chatConfig.systemPrompt;
                        return (
                          <button
                            key={preset.id}
                            type="button"
                            onClick={() => applyPresetPrompt(preset.prompt)}
                            title={preset.prompt}
                            className={`w-full rounded-lg px-3 py-2 text-left transition-colors ${
                              selected
                                ? 'bg-[var(--surface-muted)] text-[var(--accent)] dark:bg-white/[0.07] dark:text-[var(--accent)]'
                                : 'text-[var(--text-primary)] hover:bg-[var(--surface-muted)] dark:text-[var(--text-primary)] dark:hover:bg-white/[0.07]'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate text-sm font-semibold">{preset.title}</span>
                              {selected && <Check className="h-3.5 w-3.5 flex-shrink-0" />}
                            </div>
                            <div className="mt-0.5 truncate text-xs text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">
                              {preset.prompt || '（空）'}
                            </div>
                          </button>
                        );
                      })}
                      <div className="px-3 pb-1 pt-2 text-[11px] leading-4 text-[var(--text-tertiary)] dark:text-[var(--text-tertiary)]">
                        点击应用，同名保存会覆盖更新；删除请使用下方标签。
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
              {!savingPreset && (
                <button
                  type="button"
                  onClick={() => setSavingPreset(true)}
                  disabled={!currentPrompt}
                  className="h-10 flex-shrink-0 rounded-lg bg-[var(--text-primary)] px-3 text-sm font-medium text-[var(--app-bg)] transition-colors hover:bg-[var(--text-primary)] disabled:cursor-not-allowed disabled:bg-[var(--border)] disabled:text-[var(--text-secondary)] dark:bg-[var(--accent)] dark:text-[var(--app-bg)] dark:hover:bg-[var(--accent-hover)] dark:disabled:bg-white/[0.08] dark:disabled:text-[var(--text-tertiary)]"
                >
                  存为标签
                </button>
              )}
            </div>

            <AnimatePresence initial={false}>
              {savingPreset && (
                <motion.div
                  key="save-preset-row"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.16 }}
                  className="overflow-hidden"
                >
                  <div className="mt-2 flex min-w-0 gap-2">
                    <input
                      autoFocus
                      value={presetTitle}
                      onChange={(event) => setPresetTitle(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') confirmSavePreset();
                        else if (event.key === 'Escape') cancelSavePreset();
                      }}
                      placeholder="输入标签名称，留空自动编号"
                      className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--accent)] dark:border-white/[0.08] dark:bg-[var(--app-bg)] dark:text-[var(--text-primary)] dark:placeholder:text-[var(--text-tertiary)]"
                    />
                    <button
                      type="button"
                      onClick={confirmSavePreset}
                      disabled={!currentPrompt}
                      className="h-9 flex-shrink-0 rounded-lg bg-[var(--text-primary)] px-3 text-sm font-medium text-[var(--app-bg)] transition-colors hover:bg-[var(--text-primary)] disabled:cursor-not-allowed disabled:bg-[var(--border)] disabled:text-[var(--text-secondary)] dark:bg-[var(--accent)] dark:text-[var(--app-bg)] dark:hover:bg-[var(--accent-hover)] disabled:dark:bg-white/[0.08] disabled:dark:text-[var(--text-tertiary)]"
                    >
                      确认
                    </button>
                    <button
                      type="button"
                      onClick={cancelSavePreset}
                      className="h-9 flex-shrink-0 rounded-lg px-3 text-sm text-[var(--text-secondary)] transition-colors hover:bg-black/[0.05] dark:text-[var(--text-secondary)] dark:hover:bg-white/[0.08]"
                    >
                      取消
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {state.systemPromptPresets.length > 0 && (
              <div className="mt-4">
                <div className="mb-2 text-xs font-medium text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">预设标签 · 点击应用</div>
                <div className="flex flex-wrap gap-1.5">
                  {state.systemPromptPresets.map((preset) => {
                    const selected = preset.prompt === state.chatConfig.systemPrompt;
                    return (
                      <span
                        key={preset.id}
                        className={`group/tag inline-flex max-w-full items-center gap-1 rounded-full border py-1 pl-2.5 pr-1 transition-colors ${
                          selected
                            ? 'border-[var(--accent)]/55 bg-[var(--accent-subtle)] text-[var(--accent)] hover:bg-[var(--accent-subtle)] dark:border-[var(--accent)]/35 dark:bg-[var(--accent-subtle)] dark:text-[var(--accent)]'
                            : 'border-[var(--border)] bg-black/[0.025] text-[var(--text-primary)] hover:border-black/20 hover:bg-black/[0.05] dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-[var(--text-primary)] dark:hover:bg-white/[0.07]'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => applyPresetPrompt(preset.prompt)}
                          className="max-w-[160px] truncate text-xs"
                          title={selected ? `当前使用：${preset.title}` : `${preset.title}：${preset.prompt}`}
                        >
                          {preset.title}
                        </button>
                        <button
                          type="button"
                          onClick={() => dispatch({ type: 'DELETE_SYSTEM_PROMPT_PRESET', payload: { presetId: preset.id } })}
                          aria-label={`删除标签 ${preset.title}`}
                          title="删除该标签"
                          className="grid h-5 w-5 flex-shrink-0 place-items-center rounded-full text-current opacity-40 transition-all hover:bg-[var(--state-danger-border)] hover:text-[var(--state-danger)] hover:opacity-100 group-hover/tag:opacity-70 dark:hover:bg-[var(--surface-raised)] dark:hover:text-[var(--state-danger)]"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
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
      className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-[var(--text-primary)] transition-colors hover:bg-black/[0.055] disabled:opacity-40 dark:text-[var(--text-secondary)] dark:hover:bg-[var(--surface-raised)]"
      title={label}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

function ChatNumberSetting({ label, description, value, min, max, step, onChange }: {
  label: string;
  description?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  const safeValue = Math.min(max, Math.max(min, value));
  const percent = max === min ? 0 : ((safeValue - min) / (max - min)) * 100;
  return (
    <div className="border-b border-black/[0.06] py-4 last:border-b-0 dark:border-white/[0.06]">
      <div className="mb-3 flex items-center justify-between gap-3">
        <label className="text-sm font-medium text-[var(--text-primary)] dark:text-[var(--text-primary)]">{label}</label>
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
          className="mono-font w-24 rounded-lg border border-[var(--border)] bg-[var(--app-bg)] px-2 py-1 text-right text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)] dark:border-white/[0.08] dark:bg-[var(--app-bg)] dark:text-[var(--text-primary)]"
        />
      </div>
      {description && (
        <p className="mb-3 text-xs leading-5 text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">{description}</p>
      )}
      <input
        type="range"
        value={safeValue}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full accent-[var(--accent)] transition-[background] duration-200"
        style={{
          background: `linear-gradient(to right, var(--accent) ${percent}%, rgba(120,110,95,0.18) ${percent}%)`,
        }}
      />
    </div>
  );
}
