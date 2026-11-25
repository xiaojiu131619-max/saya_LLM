import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { AUTO_SCROLL_MAGNET_PX, SCROLL_RELEASE_DELTA_PX } from '@/features/chat/chatTurnHelpers';

/**
 * 消息列表的「贴底吸附」滚动机制（拆自 ChatPage，逻辑保持逐行一致）。
 *
 * 这里只管吸附状态与视口写入；虚拟列表实例（useVirtualizer）留在调用方——
 * 它的返回值是可变实例，React Compiler 无法安全 memo，必须留在带 eslint-disable
 * 的组件里（见 ChatPage）。跳转入口（跳底 / 跳消息）也留在调用方，因为要
 * virtualizer.scrollToIndex，本 hook 向它暴露吸附状态 refs 与提示条状态。
 */
export function useStickyBottomScroll(options: {
  viewportRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  /** 虚拟列表总高：必须来自渲染期读取的 virtualizer.getTotalSize()。 */
  totalSize: number;
  hasMessageRows: boolean;
  /** 当前会话 id：切换会话时一次性贴底。 */
  activeSessionId?: string;
  messagesLength: number;
  lastContent?: string;
  lastReasoningContent?: string;
  lastStreaming?: boolean;
}) {
  const {
    viewportRef,
    contentRef,
    totalSize,
    hasMessageRows,
    activeSessionId,
    messagesLength,
    lastContent,
    lastReasoningContent,
    lastStreaming,
  } = options;
  const shouldStickToBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  // 最近一次程序滚动（scrollToIndex/跳底）的时间戳：滚动事件回调里用它区分
  // 「我们自己滚的」和「用户滚的」，避免测量修正把用户刚解除的吸附又打开。
  const programmaticScrollAtRef = useRef(0);
  // 最近一次由我们直接写入的 scrollTop 值。内容收缩会让写入值比上次小，
  // 用值比对（而非时间窗）排除这类伪「用户上滑」，同时不影响用户拖动滚动条。
  const programmaticScrollTopRef = useRef(-1);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  // 思考框展开/收起 = 用户明确要停留阅读，立即脱离自动滚动；
  // 否则流式输出会在下一次内容变化时把视口重新拽到最底部，导致无法折叠。
  useEffect(() => {
    const release = () => {
      shouldStickToBottomRef.current = false;
    };
    window.addEventListener('agent-llm:thought-toggle', release);
    return () => window.removeEventListener('agent-llm:thought-toggle', release);
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
    const viewport = viewportRef.current;
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
  }, [messagesLength, lastContent, lastReasoningContent, lastStreaming, totalSize, viewportRef]);

  // 兜底：内容容器尺寸变化时再补一次贴底。虚拟列表的测量与重渲染之间若有零星时序
  // 缝隙（例如首帧、字体回流），这一步能兜住；正常流式路径由上面的 layout effect 完成。
  // 用户上滑脱离后本回调不再触碰视口。
  // 依赖 hasMessageRows：空会话时内容容器还没渲染（走的是空状态分支），
  // 必须等它挂载后再观察。
  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const observer = new ResizeObserver(() => {
      if (!shouldStickToBottomRef.current) return;
      programmaticScrollAtRef.current = Date.now();
      viewport.scrollTop = viewport.scrollHeight;
      programmaticScrollTopRef.current = viewport.scrollTop;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [hasMessageRows, viewportRef, contentRef]);

  // 切会话时一次性贴底（直接写 scrollTop，与流式路径同一套幂等语义）。
  useLayoutEffect(() => {
    shouldStickToBottomRef.current = true;
    lastScrollTopRef.current = 0;
    // 会话刚切换、内容还没渲染出来，旧会话的写入值不能拿去比对。
    programmaticScrollTopRef.current = -1;
    const viewport = viewportRef.current;
    if (!viewport) return;
    programmaticScrollAtRef.current = Date.now();
    viewport.scrollTop = viewport.scrollHeight;
    programmaticScrollTopRef.current = viewport.scrollTop;
    setShowJumpToBottom(false);
  }, [activeSessionId, viewportRef]);

  const handleMessagesScroll = () => {
    const viewport = viewportRef.current;
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

  const releaseAutoScroll = () => {
    shouldStickToBottomRef.current = false;
  };

  return {
    shouldStickToBottomRef,
    lastScrollTopRef,
    programmaticScrollAtRef,
    programmaticScrollTopRef,
    showJumpToBottom,
    setShowJumpToBottom,
    handleMessagesScroll,
    releaseAutoScroll,
  };
}
