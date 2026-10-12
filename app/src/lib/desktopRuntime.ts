import { isTauri } from '@tauri-apps/api/core';

/**
 * 是否运行在 Tauri 桌面壳内。
 *
 * 浏览器（vite dev）里没有 IPC 通道，所有 invoke / 事件订阅都必须先短路，
 * 否则会直接抛错。传输层（`lib/ipc`）与领域层（`lib/desktop`）共用这一处判定，
 * 避免各自复制一份实现导致口径漂移。
 */
export function isDesktopRuntime() {
  try {
    return isTauri();
  } catch {
    return false;
  }
}
