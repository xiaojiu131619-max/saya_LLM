import { useSyncExternalStore } from 'react';
import { getFast27bMetricsSnapshot, subscribeFast27bMetrics } from '@/lib/desktopState';

export function useFast27bMetrics() {
  return useSyncExternalStore(subscribeFast27bMetrics, getFast27bMetricsSnapshot, () => null);
}
