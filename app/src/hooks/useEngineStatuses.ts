import { useEffect, useState } from 'react';
import { fast27bGetStatus, isDesktopRuntime, type Fast27bStatus } from '@/lib/desktop';
import type { ChatEngineId, WebUiEngineId } from '@/types';

export type EngineStatusMap = { fast27b: Fast27bStatus | null };

/**
 * 轮询 fast-27b 引擎运行状态（默认 3 秒一次）。
 * - engine 为 'main' 时不轮询（主服务状态由 AppContext.serverRunning 提供）；
 * - 只轮询当前选中的引擎，避免无谓的状态命令开销。
 * 对话页（chatEngine）与 Agent 页 WebUI 面板（webuiEngine）各按自己的后端选择调用，互不影响。
 */
export function useEngineStatuses(engine: ChatEngineId | WebUiEngineId, intervalMs = 3000): EngineStatusMap {
  const [statuses, setStatuses] = useState<EngineStatusMap>({ fast27b: null });

  useEffect(() => {
    if (engine === 'main' || !isDesktopRuntime()) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const next = await fast27bGetStatus();
        if (!disposed) setStatuses({ fast27b: next });
      } catch {
        // 静默：下个周期重试。
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), intervalMs);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [engine, intervalMs]);

  return statuses;
}
