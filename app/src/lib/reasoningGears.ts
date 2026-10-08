import type { ModelInfo, ReasoningEffortGear, ReasoningMode, ReasoningProfile } from '@/types';
import { DEFAULT_REASONING_BUDGET } from '@/lib/modelDefaults';

// ---------------------------------------------------------------------------
// 思考挡位（reasoning effort）的自动识别与翻译
//
// 界面只有四挡意图：关闭 / 自动 / 思考 / 深思；而不同模型的对话模板能接受的
// 参数并不一样：
//   * Qwen3 / Qwen3.5：只有 `enable_thinking` 开关，没有离散挡位，深浅只能靠
//     思考预算（llama.cpp 的 reasoning_budget / thinking_budget_tokens）区分。
//   * gpt-oss（harmony）等：模板用 `reasoning_effort` 变量，取值 low / medium / high。
//   * R1 / QwQ 类：模板没有任何开关，思考恒开，只能调预算。
// 因此这里先按「GGUF 里的 tokenizer.chat_template 原文」识别模型真正认哪些挡位，
// 缺模板时再按架构 / 名字兜底，最后把界面意图翻译成该模型支持的参数。
// llama.cpp 侧有对应的权威信号（/props 的 chat_template_caps.supports_reasoning_effort），
// 发送前会再校验一次，见 desktop.ts 的 streamChatCompletion。
// ---------------------------------------------------------------------------

/** 挡位按强度升序，用于把「思考 / 深思」映射到最低 / 最高可用挡位。 */
export const REASONING_EFFORT_GEARS: ReasoningEffortGear[] = ['minimal', 'low', 'medium', 'high', 'xhigh'];

export const REASONING_EFFORT_LABELS: Record<ReasoningEffortGear, string> = {
  minimal: '极简',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
};

/** 模板里承载挡位的变量名：llama.cpp 会把同一个值同时绑定到这两个变量。 */
const EFFORT_VARIABLES = ['reasoning_effort', 'reasoning_strength'];

/** 思考模板里可能出现的变量，命中即算识别到思考控制面。 */
const THINKING_KNOBS = [
  'enable_thinking',
  'reasoning_effort',
  'reasoning_strength',
  'reasoning_budget',
  'thinking_budget',
  'preserve_thinking',
  'clear_thinking',
];

/** 变量名附近的字面量窗口：挡位取值一般写在 `reasoning_effort == "high"` 这类判断里。 */
const EFFORT_WINDOW_BEFORE = 200;
const EFFORT_WINDOW_AFTER = 260;

/** 什么都识别不到时的兜底档案：只按模型默认行为请求。 */
export const UNKNOWN_REASONING_PROFILE: ReasoningProfile = {
  canDisable: false,
  efforts: [],
  knobs: [],
  source: 'none',
  summary: '未识别到思考挡位，按模型默认行为请求。',
};

export function reasoningEffortLabel(gear: ReasoningEffortGear) {
  return REASONING_EFFORT_LABELS[gear] ?? gear;
}

/**
 * 该模型是否具备可调的思考控制面：名字/标签识别到推理模型，或对话模板暴露了
 * enable_thinking / reasoning_effort 挡位。界面与发送链路必须用同一个判定，
 * 否则会出现「界面显示已切换挡位、请求里却没带参数」。
 */
export function profileSupportsThinking(profile: ReasoningProfile, supportsReasoning?: boolean | null) {
  return Boolean(supportsReasoning) || profile.canDisable || profile.efforts.length > 0;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 模板里是否真的用到了某个变量（用词边界排除 reasoning_effort_extra 这类更长名字）。 */
export function hasTemplateVariable(template: string, name: string) {
  return new RegExp(`\\b${escapeRegExp(name)}\\b`).test(template);
}

function templateWindows(template: string, name: string) {
  const windows: string[] = [];
  const lower = template.toLowerCase();
  const needle = name.toLowerCase();
  let from = 0;
  for (;;) {
    const at = lower.indexOf(needle, from);
    if (at < 0) break;
    windows.push(template.slice(Math.max(0, at - EFFORT_WINDOW_BEFORE), at + EFFORT_WINDOW_AFTER));
    from = at + needle.length;
  }
  return windows;
}

interface TemplateAnalysis {
  efforts: ReasoningEffortGear[];
  canDisable: boolean;
  knobs: string[];
  effortVariable: string | null;
  budgetVariable: string | null;
}

function analyzeChatTemplate(template: string): TemplateAnalysis {
  const knobs = THINKING_KNOBS.filter((knob) => hasTemplateVariable(template, knob));
  const effortVariable = EFFORT_VARIABLES.find((name) => hasTemplateVariable(template, name)) ?? null;

  const literals = new Set<string>();
  if (effortVariable) {
    for (const window of templateWindows(template, effortVariable)) {
      for (const match of window.matchAll(/["'](minimal|low|medium|high|xhigh|none|off)["']/gi)) {
        literals.add(match[1].toLowerCase());
      }
    }
  }

  const efforts = REASONING_EFFORT_GEARS.filter((gear) => literals.has(gear));
  // 模板引用了挡位变量但没写死可选值（直接把值拼进提示词，如 harmony）：
  // 按主流实现的 low / medium / high 三挡处理。
  const resolvedEfforts = effortVariable && efforts.length === 0 ? (['low', 'medium', 'high'] as ReasoningEffortGear[]) : efforts;

  return {
    efforts: resolvedEfforts,
    // none / off 也是「关掉思考」的合法取值，同样说明模板能关。
    canDisable: hasTemplateVariable(template, 'enable_thinking') || literals.has('none') || literals.has('off'),
    knobs,
    effortVariable,
    budgetVariable: knobs.includes('thinking_budget')
      ? 'thinking_budget'
      : knobs.includes('reasoning_budget')
        ? 'reasoning_budget'
        : null,
  };
}

function summarizeTemplate(analysis: TemplateAnalysis) {
  const switchText = analysis.canDisable
    ? '可用 enable_thinking 关闭/开启思考'
    : '模板没有关闭思考的开关';
  const gearText = analysis.efforts.length > 0
    ? `支持 reasoning_effort 挡位：${analysis.efforts.map(reasoningEffortLabel).join(' / ')}`
    : '没有 reasoning_effort 挡位，深浅由思考预算区分';
  return `${switchText}；${gearText}。`;
}

/**
 * 按名称 / 架构 / 标签兜底识别（GGUF 没有 chat template 或模板未暴露思考参数时）。
 */
function fallbackReasoningProfile(input: {
  name?: string | null;
  architecture?: string | null;
  tags?: string[] | null;
  supportsReasoning?: boolean | null;
}): ReasoningProfile {
  const haystack = `${input.name ?? ''} ${input.architecture ?? ''} ${(input.tags ?? []).join(' ')}`.toLowerCase();
  const supportsReasoning = Boolean(input.supportsReasoning) || /thinking|reasoning|think/.test(haystack);

  if (/gpt-?oss|gptoss|harmony/.test(haystack)) {
    return {
      canDisable: false,
      efforts: ['low', 'medium', 'high'],
      knobs: [],
      source: 'architecture',
      summary: '按架构兜底识别：支持 reasoning_effort 低 / 中 / 高挡位。',
    };
  }
  if (/qwen3|qwen35|qwq/.test(haystack)) {
    return {
      canDisable: true,
      efforts: [],
      knobs: ['enable_thinking'],
      source: 'architecture',
      summary: '按架构兜底识别：可用 enable_thinking 关闭/开启思考，深浅由思考预算区分。',
    };
  }
  if (supportsReasoning) {
    return {
      canDisable: false,
      efforts: [],
      knobs: [],
      source: 'name',
      summary: '按名字/标签兜底识别为推理模型：思考恒开，只能调整思考预算。',
    };
  }
  return UNKNOWN_REASONING_PROFILE;
}

/**
 * 自动识别模型支持的思考挡位。
 * chatTemplate 优先用用户在加载配置里覆盖的自定义模板，其次才是 GGUF 里的原文。
 */
export function detectReasoningProfile(input: {
  name?: string | null;
  architecture?: string | null;
  tags?: string[] | null;
  chatTemplate?: string | null;
  supportsReasoning?: boolean | null;
}): ReasoningProfile {
  const template = (input.chatTemplate ?? '').trim();
  if (template) {
    const analysis = analyzeChatTemplate(template);
    if (analysis.knobs.length > 0) {
      return {
        canDisable: analysis.canDisable,
        efforts: analysis.efforts,
        knobs: analysis.knobs,
        source: 'template',
        summary: summarizeTemplate(analysis),
      };
    }
    return {
      canDisable: false,
      efforts: [],
      knobs: [],
      source: 'template',
      summary: input.supportsReasoning
        ? '对话模板未暴露思考开关，按服务端默认思考行为。'
        : '对话模板未暴露思考相关参数。',
    };
  }
  return fallbackReasoningProfile(input);
}

export function chatTemplateFromMetadata(metadata?: Array<{ key: string; value: string }> | null) {
  return metadata?.find((entry) => entry.key === 'tokenizer.chat_template')?.value ?? '';
}

export function architectureFromMetadata(metadata?: Array<{ key: string; value: string }> | null) {
  return metadata?.find((entry) => entry.key === 'general.architecture')?.value ?? '';
}

/** 从模型对象直接生成挡位档案（界面与发送链路共用同一套识别结果）。 */
export function reasoningProfileFromModel(
  model: Pick<ModelInfo, 'name' | 'tags' | 'loadConfig' | 'ggufMetadata' | 'supportsReasoning'> | null | undefined,
): ReasoningProfile {
  if (!model) return UNKNOWN_REASONING_PROFILE;
  const customTemplate = model.loadConfig?.chatTemplate?.trim();
  return detectReasoningProfile({
    name: model.name,
    architecture: architectureFromMetadata(model.ggufMetadata),
    tags: model.tags,
    chatTemplate: customTemplate || chatTemplateFromMetadata(model.ggufMetadata),
    supportsReasoning: model.supportsReasoning,
  });
}

/** 一次请求最终要下发的思考参数。 */
export interface ReasoningPlan {
  mode: ReasoningMode;
  /** 模板认识 enable_thinking 时才带；undefined = 不发这个变量。 */
  enableThinking?: boolean;
  /** 模板认识 reasoning_effort 挡位时才带；undefined = 不发这个变量。 */
  effort?: ReasoningEffortGear;
  /** 实际发送的思考预算（reasoning_budget / thinking_budget_tokens）。 */
  budgetTokens: number;
  /** 该模型能否兑现这次意图（false = 界面要提示用户）。 */
  honored: boolean;
  /** 兑现后的挡位名，展示在按钮上。 */
  gearLabel: string;
  /** 实际请求参数的可读描述，展示在菜单里。 */
  requestLabel: string;
  /** 无法完全兑现时的原因说明。 */
  note?: string;
}

function budgetLabel(tokens: number) {
  return tokens >= 1024 && tokens % 1024 === 0 ? `${tokens / 1024}K` : String(tokens);
}

/**
 * 把界面四挡意图翻译成模型真正支持的挡位。
 * modelBudget 是模型加载配置里的思考预算（loadConfig.reasoningBudget）。
 */
export function planReasoning(
  mode: ReasoningMode,
  profile: ReasoningProfile,
  modelBudget = 0,
  supportsReasoning?: boolean,
): ReasoningPlan {
  const budget = Math.max(0, Math.round(Number(modelBudget) || 0));
  const canThink = profileSupportsThinking(profile, supportsReasoning);

  if (mode === 'off') {
    if (profile.canDisable) {
      return {
        mode,
        enableThinking: false,
        budgetTokens: 0,
        honored: true,
        gearLabel: '关闭',
        requestLabel: 'enable_thinking=false · 思考预算 0',
      };
    }
    return {
      mode,
      budgetTokens: 0,
      honored: false,
      gearLabel: '预算 0',
      requestLabel: '思考预算 0（模板无 enable_thinking 开关）',
      note: '该模型的对话模板没有关闭思考的开关，只能把思考预算压到 0，模型仍可能输出思考内容。',
    };
  }

  if (mode === 'auto') {
    // 与历史行为一致：自动挡只给足预算，挡位交给模型/服务端默认值。
    const autoBudget = canThink ? Math.max(budget, DEFAULT_REASONING_BUDGET) : budget;
    return {
      mode,
      budgetTokens: autoBudget,
      honored: true,
      gearLabel: '模型默认',
      requestLabel: autoBudget > 0 ? `不指定挡位 · 思考预算 ${budgetLabel(autoBudget)}` : '不指定挡位',
    };
  }

  const deep = mode === 'deep';
  const budgetTokens = deep ? DEFAULT_REASONING_BUDGET * 4 : DEFAULT_REASONING_BUDGET;

  if (profile.efforts.length > 0) {
    const effort = deep ? profile.efforts[profile.efforts.length - 1] : profile.efforts[0];
    return {
      mode,
      enableThinking: true,
      effort,
      budgetTokens,
      honored: true,
      gearLabel: `effort ${reasoningEffortLabel(effort)}`,
      requestLabel: `reasoning_effort=${effort} · 思考预算 ${budgetLabel(budgetTokens)}`,
    };
  }

  if (profile.canDisable) {
    return {
      mode,
      enableThinking: true,
      budgetTokens,
      honored: true,
      gearLabel: deep ? '高预算' : '标准预算',
      requestLabel: `enable_thinking=true · 思考预算 ${budgetLabel(budgetTokens)}`,
    };
  }

  return {
    mode,
    budgetTokens,
    honored: canThink,
    gearLabel: deep ? '高预算' : '标准预算',
    requestLabel: `思考预算 ${budgetLabel(budgetTokens)}`,
    note: canThink
      ? '该模型没有离散思考挡位，思考恒开，只能用思考预算控制深浅。'
      : '未识别到该模型的思考开关或挡位，请求会按普通生成参数发送。',
  };
}
