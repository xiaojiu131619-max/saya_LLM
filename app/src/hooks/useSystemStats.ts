import { useCallback, useEffect, useRef } from 'react';
import { useApp } from '@/context/AppContext';
import { getDesktopSystemStats, isDesktopRuntime } from '@/lib/desktop';

export function useSystemStats() {
  const { state, dispatch } = useApp();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const latestStatsRef = useRef(state.systemStats);

  useEffect(() => {
    latestStatsRef.current = state.systemStats;
  }, [state.systemStats]);

  const refreshStats = useCallback(async () => {
    const current = latestStatsRef.current;

    if (!isDesktopRuntime()) return;

    try {
      const desktopStats = await getDesktopSystemStats(current);
      if (desktopStats) {
        dispatch({ type: 'UPDATE_SYSTEM_STATS', payload: desktopStats });
      }
    } catch {
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
  }, [dispatch]);

  useEffect(() => {
    intervalRef.current = setInterval(() => {
      void refreshStats();
    }, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [refreshStats]);

  return state.systemStats;
}
