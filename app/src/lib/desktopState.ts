import { fast27bGetMetrics, type Fast27bMetricsSnapshot } from './ipc/fast27b';
import { isDesktopRuntime } from './desktopRuntime';

/**
 * 跨模块共享的模块级单例状态。
 *
 * 这些状态必须是「全应用一份」：一旦被复制成两份就会破坏语义——
 * `activeChatAbortController` 复制会导致「停止生成」只中止其中一条流，
 * 而 llama-server 固定单并发，两条流并存会互相挤显存、双双降速；
 * `lastPingReachable` 复制会让可达性翻转日志重复刷屏。
 *
 * 因此集中放在这里，传输层与领域层都只通过下面这组读写函数访问，
 * 不各自持有副本。
 */

let activeChatAbortController: AbortController | null = null;
let lastPingReachable: boolean | null = null;

/** 当前进行中的聊天流取消把手；没有进行中的流时为 null。 */
export function getActiveChatAbortController(): AbortController | null {
  return activeChatAbortController;
}

export function setActiveChatAbortController(controller: AbortController | null): void {
  activeChatAbortController = controller;
}

/** 上一次 ping 探测到的可达性；用于只在状态翻转时记日志。 */
export function getLastPingReachable(): boolean | null {
  return lastPingReachable;
}

export function setLastPingReachable(value: boolean | null): void {
  lastPingReachable = value;
}

let fast27bMetrics: Fast27bMetricsSnapshot | null = null;
const fast27bMetricsListeners = new Set<() => void>();
let fast27bMetricsTimer: number | null = null;
let fast27bMetricsRefresh: Promise<void> | null = null;

export function getFast27bMetricsSnapshot(): Fast27bMetricsSnapshot | null {
  return fast27bMetrics;
}

export function refreshFast27bMetrics(): Promise<void> {
  if (!isDesktopRuntime()) return Promise.resolve();
  if (fast27bMetricsRefresh) return fast27bMetricsRefresh;
  fast27bMetricsRefresh = (async () => {
    try {
      const next = await fast27bGetMetrics();
      if (next) {
        fast27bMetrics = next;
        fast27bMetricsListeners.forEach((notify) => notify());
      }
    } catch {
      // 瞬时读取失败时保留最近一次有效快照，不把图表清成零。
    } finally {
      fast27bMetricsRefresh = null;
    }
  })();
  return fast27bMetricsRefresh;
}

export function subscribeFast27bMetrics(notify: () => void): () => void {
  if (!isDesktopRuntime()) return () => {};
  fast27bMetricsListeners.add(notify);
  if (fast27bMetricsTimer === null) {
    void refreshFast27bMetrics();
    fast27bMetricsTimer = window.setInterval(() => void refreshFast27bMetrics(), 1000);
  }
  return () => {
    fast27bMetricsListeners.delete(notify);
    if (fast27bMetricsListeners.size === 0 && fast27bMetricsTimer !== null) {
      window.clearInterval(fast27bMetricsTimer);
      fast27bMetricsTimer = null;
    }
  };
}
