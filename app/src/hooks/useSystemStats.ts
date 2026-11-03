import { useEffect, useRef } from 'react';
import { useApp } from '@/context/AppContext';
import { getDesktopSystemStats, isDesktopRuntime } from '@/lib/desktop';

/** 连续失败多少次才把界面切成「不可用」，避免一次抖动就把读数清空。 */
const FAILURE_THRESHOLD = 3;

export function useSystemStats() {
  const { state, dispatch } = useApp();
  const latestStatsRef = useRef(state.systemStats);

  useEffect(() => {
    latestStatsRef.current = state.systemStats;
  }, [state.systemStats]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;

    /**
     * 递归 setTimeout 而不是 setInterval：1 秒一次调硬件接口，
     * 慢查询（GPU 驱动卡顿、WMI 阻塞）会让 interval 层层堆叠，
     * 而且旧响应可能后到并覆盖新响应。改成「上一轮结束后再排下一轮」，
     * 天然不会重叠。
     */
    const tick = async () => {
      if (disposed) return;
      try {
        const desktopStats = await getDesktopSystemStats(latestStatsRef.current);
        if (disposed) return;
        if (desktopStats) {
          failures = 0;
          dispatch({ type: 'UPDATE_SYSTEM_STATS', payload: desktopStats });
        }
      } catch {
        failures += 1;
        // 单次失败保留上一次读数：立刻改写 GPU 名称会让界面闪成「不可用」。
        if (failures >= FAILURE_THRESHOLD) {
          const current = latestStatsRef.current;
          dispatch({
            type: 'UPDATE_SYSTEM_STATS',
            payload: {
              ...current,
              gpuName: '硬件状态不可用',
              hostName: '本机',
              computeScores: [...current.computeScores.slice(1), 0],
            },
          });
        }
      } finally {
        if (!disposed) timer = setTimeout(() => void tick(), 1000);
      }
    };

    void tick();

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [dispatch]);

  return state.systemStats;
}
