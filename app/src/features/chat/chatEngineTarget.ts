import type { ChatEngineId, ReasoningProfile } from '@/types';
import { FAST27B_SERVICE_COLOR, FAST27B_SERVICE_ID } from '@/hooks/useEngineStatuses';
import { STRATA_SERVICE_COLOR, STRATA_SERVICE_ID, type ChatEngineServiceView } from '@/hooks/useStrataStatus';

/**
 * NiNfer 引擎不在 GGUF 扫描范围内，没有对话模板可解析：按引擎启动参数
 * （--default-reasoning-effort high）固定成 minimal…high 四挡，界面意图照旧映射为
 * 思考→minimal、深思→high，与接入引擎之前的下发参数保持一致。
 */
export const ENGINE_REASONING_PROFILE: ReasoningProfile = {
  canDisable: true,
  efforts: ['minimal', 'low', 'medium', 'high'],
  knobs: ['enable_thinking', 'reasoning_effort'],
  source: 'name',
  summary: '引擎（NiNfer）：按服务端默认挡位 minimal…high，界面下发 minimal / high。',
};

// ---------------------------------------------------------------------------
// 自带对话的后端扩展：主模型之外，可选择 NiNfer 引擎。
// 引擎自带 OpenAI 兼容 API，把发送参数（端口 / Key / 模型名 / 上下文）整体替换
// 即可复用同一条对话链路；会话仍存全局桶，靠 runtimeModelId/modelName 快照区分。
// ---------------------------------------------------------------------------

/** 引擎对话目标（选中 NiNfer / 智慧模型后端后非空）。 */
export interface ChatEngineTarget {
  label: string;
  /** 会话快照 / 用量记录用的合成运行时模型 ID。 */
  runtimeModelId: string;
  displayName: string;
  color: string;
  port: number;
  apiKey: string;
  modelId: string;
  contextWindow: number;
  supportsReasoning: boolean;
  /** 进程存活。 */
  running: boolean;
  /** 可对话：进程存活 + 引擎日志未报失效（degraded 时不再放行新请求）。 */
  serviceable: boolean;
}

export function engineTargetFromService(
  engine: ChatEngineId,
  service: ChatEngineServiceView,
): ChatEngineTarget | null {
  // 'main' 不是"引擎档"：主模型走 activeModel。
  if (engine === 'main') return null;
  // 两个引擎各用一组合成 ID / 配色：会话与用量按 runtimeModelId 分开统计，
  // 混用会让「智慧模型的用量」串到 NiNfer 的统计卡上。
  const isStrata = engine === 'strata';
  return {
    label: service.label,
    runtimeModelId: isStrata ? STRATA_SERVICE_ID : FAST27B_SERVICE_ID,
    displayName: `${service.label} · ${service.modelLabel}`,
    color: isStrata ? STRATA_SERVICE_COLOR : FAST27B_SERVICE_COLOR,
    port: service.port,
    apiKey: service.apiKey,
    modelId: service.modelId,
    // 水位分母取有效上限：智慧模型用它 /health 回报的 max_context。
    contextWindow: service.effectiveCtxTotal,
    // 两个引擎都在服务端开思考：NiNfer 以 high 启动，strata 由 chat template 控制。
    supportsReasoning: true,
    running: service.running,
    serviceable: service.serviceable,
  };
}
