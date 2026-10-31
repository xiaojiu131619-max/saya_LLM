import { useSyncExternalStore } from 'react';
import { getStrataStatusSnapshot, subscribeStrataStatus } from '@/lib/desktopState';
import type { StrataStatus } from '@/lib/ipc/strata';

/**
 * 智慧模型状态（3 秒单例轮询）。
 *
 * 用单例订阅而不是各组件自己 `setInterval`：`strata_get_status` 内含一次 `/health`
 * 探活，多处各自轮询会把界面拖慢——这与 `useEngineStatuses` 踩过的坑是同一个。
 */
export function useStrataStatus() {
  return useSyncExternalStore(subscribeStrataStatus, getStrataStatusSnapshot, () => null);
}

// ---- 智慧模型的共享标识 -----------------------------------------------------
// 与 NiNfer 同一套约定：引擎不是 GGUF 模型，进不了 state.models，
// 会话与用量都挂在合成运行时 ID 下，避免与同名真实模型串统计。
export const STRATA_SERVICE_ID = 'engine:strata';
export const STRATA_SERVICE_COLOR = '#a855f7';
export const STRATA_SERVICE_LABEL = 'Strata';
export const STRATA_DEFAULT_PORT = 8082;
export const STRATA_DEFAULT_MODEL_ID = 'qwen3.8-flash-next-gyro-gyro-m';
export const STRATA_DEFAULT_CONTEXT_WINDOW = 102400;

/** 对话页只需要这一小组字段就能把请求指向某个引擎。 */
export interface ChatEngineServiceView {
  label: string;
  modelLabel: string;
  running: boolean;
  /** 可对话：进程存活且权重已加载。 */
  serviceable: boolean;
  port: number;
  apiKey: string;
  modelId: string;
  /** 上下文分母（智慧模型取 /health 回报的 max_context）。 */
  effectiveCtxTotal: number;
}

/**
 * 把 StrataStatus 翻译成对话页要的引擎视图。
 *
 * 这里的关键区别在 `serviceable`：NiNfer 加载几秒，而智慧模型要十几分钟。
 * 只看 `running` 会让用户在「接口已在线、权重还在灌」时发出请求然后干等，
 * 所以必须叠加 `model_loaded`。
 */
export function strataServiceView(status: StrataStatus | null): ChatEngineServiceView {
  const modelName = status?.model_name ?? STRATA_DEFAULT_MODEL_ID;
  return {
    label: STRATA_SERVICE_LABEL,
    modelLabel: 'Gyro-M',
    running: Boolean(status?.running),
    serviceable: Boolean(status?.running) && Boolean(status?.model_loaded),
    port: status?.port ?? STRATA_DEFAULT_PORT,
    apiKey: status?.api_key ?? '',
    modelId: modelName,
    effectiveCtxTotal: status?.max_context ?? STRATA_DEFAULT_CONTEXT_WINDOW,
  };
}
