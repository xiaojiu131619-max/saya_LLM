import { useEffect } from 'react';
import { useApp } from '@/context/AppContext';
import { useFast27bMetrics } from '@/hooks/useFast27bMetrics';
import { useStrataMetrics } from '@/hooks/useStrataMetrics';
import {
  FAST27B_SERVICE_COLOR,
  FAST27B_SERVICE_ID,
  FAST27B_SERVICE_LABEL,
} from '@/hooks/useEngineStatuses';
import {
  STRATA_SERVICE_COLOR,
  STRATA_SERVICE_ID,
  STRATA_SERVICE_LABEL,
} from '@/hooks/useStrataStatus';
import { engineUsageTotals } from '@/lib/engineUsage';

/**
 * 把 NiNfer / Strata 引擎的真实 token 用量同步进全局使用统计。
 *
 * 使用统计要覆盖「所有 token」：主模型走 ADD_USAGE（每次请求增量），
 * 对外 API 走 SET_API_USAGE（日志快照差量），两个引擎则各有自己的指标快照
 * ——这里把它们折算成 SET_ENGINE_USAGE 快照，挂在合成 runtime 模型 ID 下。
 *
 * 只在统计页需要时才订阅（本 hook 由使用统计页调用），避免每个页面都起
 * 两个每秒一次的 IPC 轮询。
 */
export function useEngineUsageSync() {
  const { dispatch } = useApp();
  const fast27bMetrics = useFast27bMetrics();
  const strataMetrics = useStrataMetrics();

  useEffect(() => {
    if (!fast27bMetrics) return;
    const totals = engineUsageTotals(fast27bMetrics.requests);
    dispatch({
      type: 'SET_ENGINE_USAGE',
      payload: {
        modelId: FAST27B_SERVICE_ID,
        modelName: `${FAST27B_SERVICE_LABEL} 引擎`,
        modelColor: FAST27B_SERVICE_COLOR,
        promptTokens: totals.promptTokens,
        completionTokens: totals.completionTokens,
        totalTokens: totals.totalTokens,
        responseCount: totals.requestCount,
        totalTokensPerSec: totals.totalTokensPerSec,
        totalFirstTokenDelay: totals.totalFirstTokenDelay,
        totalGenTime: totals.totalGenTime,
        dailyTokens: totals.dailyTokens,
        lastUsedAt: totals.updatedAt,
      },
    });
  }, [dispatch, fast27bMetrics]);

  useEffect(() => {
    if (!strataMetrics) return;
    const totals = engineUsageTotals(strataMetrics.requests);
    dispatch({
      type: 'SET_ENGINE_USAGE',
      payload: {
        modelId: STRATA_SERVICE_ID,
        modelName: `${STRATA_SERVICE_LABEL} 引擎`,
        modelColor: STRATA_SERVICE_COLOR,
        promptTokens: totals.promptTokens,
        completionTokens: totals.completionTokens,
        totalTokens: totals.totalTokens,
        responseCount: totals.requestCount,
        totalTokensPerSec: totals.totalTokensPerSec,
        totalFirstTokenDelay: totals.totalFirstTokenDelay,
        totalGenTime: totals.totalGenTime,
        dailyTokens: totals.dailyTokens,
        lastUsedAt: totals.updatedAt,
      },
    });
  }, [dispatch, strataMetrics]);
}
