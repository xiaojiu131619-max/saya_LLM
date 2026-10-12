import { useEffect, useState } from 'react';
import { fast27bGetStatus, isDesktopRuntime, type Fast27bModelVariant, type Fast27bStatus } from '@/lib/desktop';

export type EngineStatusMap = {
  fast27b: Fast27bStatus | null;
  /** 最近一次成功取到状态的时间戳。引擎不暴露探活延迟，界面用它当「最近检测」。 */
  fetchedAt: number;
};

// ---- fast-27b 引擎的共享标识 -------------------------------------------------
// 引擎不是 GGUF 模型，进不了 state.models；会话与用量都挂在这个合成运行时模型 ID 下。
export const FAST27B_SERVICE_ID = 'engine:fast27b';
export const FAST27B_SERVICE_COLOR = '#0ea5e9';
export const FAST27B_SERVICE_LABEL = 'fast-27b';
export const FAST27B_DEFAULT_PORT = 8094;
export const FAST27B_DEFAULT_MODEL_ID = 'qwen3.8-27b';
export const FAST27B_DEFAULT_CONTEXT_WINDOW = 262144;
/** 引擎启动参数硬编码 --max-concurrency 1，界面上不可配置。 */
export const FAST27B_MAX_CONCURRENCY = 1;

const POLL_INTERVAL_MS = 3000;

/** 引擎失效码的中文标签（后端 fault_kind 的取值）。 */
const FAULT_KIND_LABELS: Record<string, string> = {
  worker_crash: 'worker 崩溃',
  requests_failing: '连续请求失败',
  over_pool: '题面超出设备池',
};

// ---- 模块级共享轮询 ---------------------------------------------------------
// 引擎状态现在被对话页、服务状态页、侧边栏服务卡同时消费。每次调用各起一个 interval
// 会重复打 fast27b_get_status——该命令在引擎运行时内含最长 2 秒的 /v1/models 阻塞探活。
// 因此改为单例轮询 + 订阅：多处调用只跑一个 interval，共享同一份快照。
let snapshot: EngineStatusMap = { fast27b: null, fetchedAt: 0 };
const listeners = new Set<() => void>();
let timer: number | null = null;

async function refresh() {
  try {
    const next = await fast27bGetStatus();
    snapshot = { fast27b: next, fetchedAt: Date.now() };
  } catch {
    // 静默重试：保留上一次快照，避免单次失败让界面闪回「未启动」。
  }
  listeners.forEach((notify) => notify());
}

function startPolling() {
  if (timer !== null) return;
  void refresh();
  timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
}

function stopPolling() {
  if (timer === null) return;
  window.clearInterval(timer);
  timer = null;
}

/** 手动触发一次引擎状态刷新（服务状态页「立即检测」按钮用）。 */
export function refreshEngineStatus(): Promise<void> {
  return refresh();
}

/**
 * fast-27b 引擎运行状态（桌面环境常驻轮询，3 秒一次，多处调用共享同一份快照）。
 * 与「当前对话后端」无关：服务状态页与侧边栏在主模型后端下同样需要它，
 * 用来判断引擎是否也已在跑。
 */
export function useEngineStatuses(): EngineStatusMap {
  const [statuses, setStatuses] = useState<EngineStatusMap>(snapshot);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    const notify = () => setStatuses(snapshot);
    listeners.add(notify);
    startPolling();
    notify();
    return () => {
      listeners.delete(notify);
      if (listeners.size === 0) stopPolling();
    };
  }, []);

  return statuses;
}

/**
 * 引擎的「服务」视图：把 Fast27bStatus 翻译成与主模型服务同构的一组字段，
 * 让服务状态页 / 侧边栏 / 对话页用同一套判定（不再各自解读 status）。
 * 未拿到快照时给出保守默认值（未运行、默认端口），界面不会因为缺数据而崩。
 */
export interface EngineServiceView {
  label: string;
  /** Swift 27B / Heretic 27B */
  modelLabel: string;
  /** 进程存活。 */
  running: boolean;
  /** 可对话：进程存活 + 引擎日志未报失效（不看 /v1/models 探活结果，避免探活抖动误禁输入）。 */
  serviceable: boolean;
  apiReachable: boolean;
  degraded: boolean;
  degradedReason: string | null;
  requiresRestart: boolean;
  rawFaultLine: string | null;
  faultAt: string | null;
  /** 故障码原文：worker_crash / requests_failing / over_pool。 */
  faultKind: string | null;
  /** 故障码的中文标签（界面展示用）。 */
  faultKindText: string | null;
  port: number;
  lan: boolean;
  modelId: string;
  contextWindow: number;
  apiKey: string;
  devicePoolTokens: number | null;
  devicePoolPages: number | null;
  capacityConfigured: string | null;
  pid: number | null;
  enabled: boolean;
  enginePath: string;
  modelPath: string;
  selectedModel: Fast27bModelVariant;
  engineExists: boolean;
  modelExists: boolean;
  draftTokens: number;
  defaultMaxTokens: number;
  bridgePort: number;
  dshBoundModel: string | null;
  dshWebUrl: string;
  /** 引擎可用的有效上下文上限：设备 KV 池优先（它才是真正卡住长上下文的那个数）。 */
  effectiveCtxTotal: number;
}

export function fast27bServiceView(status: Fast27bStatus | null): EngineServiceView {
  const poolTokens = status?.device_pool_tokens ?? null;
  const contextWindow = status?.context_window ?? FAST27B_DEFAULT_CONTEXT_WINDOW;
  const faultKind = status?.fault_kind ?? null;
  return {
    label: FAST27B_SERVICE_LABEL,
    modelLabel: status?.selected_model === 'swift' ? 'Swift 27B' : 'Heretic 27B',
    running: Boolean(status?.running),
    serviceable: Boolean(status?.running) && !status?.degraded,
    apiReachable: Boolean(status?.api_reachable),
    degraded: Boolean(status?.degraded),
    degradedReason: status?.degraded_reason ?? null,
    requiresRestart: Boolean(status?.requires_restart),
    rawFaultLine: status?.raw_fault_line ?? null,
    faultAt: status?.fault_at ?? null,
    faultKind,
    faultKindText: faultKind ? (FAULT_KIND_LABELS[faultKind] ?? faultKind) : null,
    port: status?.port ?? FAST27B_DEFAULT_PORT,
    lan: Boolean(status?.lan),
    modelId: status?.model_id ?? FAST27B_DEFAULT_MODEL_ID,
    contextWindow,
    apiKey: status?.api_key ?? '',
    devicePoolTokens: poolTokens,
    devicePoolPages: status?.device_pool_pages ?? null,
    capacityConfigured: status?.capacity_configured ?? null,
    pid: status?.pid ?? null,
    enabled: Boolean(status?.enabled),
    enginePath: status?.engine_path ?? '',
    modelPath: status?.model_path ?? '',
    selectedModel: status?.selected_model ?? 'heretic',
    engineExists: Boolean(status?.engine_exists),
    modelExists: Boolean(status?.model_exists),
    draftTokens: status?.draft_tokens ?? 0,
    defaultMaxTokens: status?.default_max_tokens ?? 0,
    bridgePort: status?.bridge_port ?? 0,
    dshBoundModel: status?.dsh_bound_model ?? null,
    dshWebUrl: status?.dsh_web_url ?? '',
    effectiveCtxTotal: poolTokens && poolTokens > 0 ? poolTokens : contextWindow,
  };
}
