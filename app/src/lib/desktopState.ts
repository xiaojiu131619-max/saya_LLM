import { fast27bGetMetrics, type Fast27bMetricsSnapshot } from './ipc/fast27b';
import { strataGetMetrics, strataGetStatus, type StrataMetricsSnapshot, type StrataStatus } from './ipc/strata';
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

let strataMetrics: StrataMetricsSnapshot | null = null;
const strataMetricsListeners = new Set<() => void>();
let strataMetricsTimer: number | null = null;
let strataMetricsRefresh: Promise<void> | null = null;

export function getStrataMetricsSnapshot(): StrataMetricsSnapshot | null {
  return strataMetrics;
}

export function refreshStrataMetrics(): Promise<void> {
  if (!isDesktopRuntime()) return Promise.resolve();
  if (strataMetricsRefresh) return strataMetricsRefresh;
  strataMetricsRefresh = (async () => {
    try {
      const next = await strataGetMetrics();
      if (next) {
        strataMetrics = next;
        strataMetricsListeners.forEach((notify) => notify());
      }
    } catch {
      // 瞬时读取失败时保留最近一次有效快照。
    } finally {
      strataMetricsRefresh = null;
    }
  })();
  return strataMetricsRefresh;
}

export function subscribeStrataMetrics(notify: () => void): () => void {
  if (!isDesktopRuntime()) return () => {};
  strataMetricsListeners.add(notify);
  if (strataMetricsTimer === null) {
    void refreshStrataMetrics();
    strataMetricsTimer = window.setInterval(() => void refreshStrataMetrics(), 1000);
  }
  return () => {
    strataMetricsListeners.delete(notify);
    if (strataMetricsListeners.size === 0 && strataMetricsTimer !== null) {
      window.clearInterval(strataMetricsTimer);
      strataMetricsTimer = null;
    }
  };
}

let strataStatus: StrataStatus | null = null;
const strataStatusListeners = new Set<() => void>();
let strataStatusTimer: number | null = null;
let strataStatusRefresh: Promise<void> | null = null;

/**
 * 智慧模型状态轮询间隔。
 *
 * `strata_get_status` 内含一次 `/health` 探活（最长 2 秒超时），不能像指标那样
 * 每秒拉——多处同时调用会把界面拖成幻灯片。3 秒与引擎状态条保持一致。
 */
const STRATA_POLL_INTERVAL_MS = 3000;

export function getStrataStatusSnapshot(): StrataStatus | null {
  return strataStatus;
}

export function refreshStrataStatus(): Promise<void> {
  if (!isDesktopRuntime()) return Promise.resolve();
  if (strataStatusRefresh) return strataStatusRefresh;
  strataStatusRefresh = (async () => {
    try {
      const next = await strataGetStatus();
      if (next) {
        strataStatus = next;
        strataStatusListeners.forEach((notify) => notify());
      }
    } catch {
      // 瞬时读取失败时保留最近一次有效快照，避免界面在「加载中」和「已停用」之间闪。
    } finally {
      strataStatusRefresh = null;
    }
  })();
  return strataStatusRefresh;
}

export function subscribeStrataStatus(notify: () => void): () => void {
  if (!isDesktopRuntime()) return () => {};
  strataStatusListeners.add(notify);
  if (strataStatusTimer === null) {
    void refreshStrataStatus();
    strataStatusTimer = window.setInterval(
      () => void refreshStrataStatus(),
      STRATA_POLL_INTERVAL_MS,
    );
  }
  return () => {
    strataStatusListeners.delete(notify);
    if (strataStatusListeners.size === 0 && strataStatusTimer !== null) {
      window.clearInterval(strataStatusTimer);
      strataStatusTimer = null;
    }
  };
}
