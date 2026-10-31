import { useSyncExternalStore } from 'react';
import { getStrataMetricsSnapshot, subscribeStrataMetrics } from '@/lib/desktopState';

/** 智慧模型真实请求的指标快照（1 秒单例轮询，与 NiNfer 指标同一套共享方式）。 */
export function useStrataMetrics() {
  return useSyncExternalStore(subscribeStrataMetrics, getStrataMetricsSnapshot, () => null);
}
