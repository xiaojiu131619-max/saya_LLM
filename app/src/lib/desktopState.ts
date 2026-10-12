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
