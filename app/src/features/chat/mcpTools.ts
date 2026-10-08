import type { McpServerEntry, ToolActivity } from '@/types';
import type { ChatCompletionMessage, ChatCompletionMetrics, ChatToolCall, ChatToolSpec } from '@/lib/desktop';

/** MCP 工具名格式：`mcp__<服务器名>__<工具名>`。 */
const MCP_TOOL_PREFIX = 'mcp__';

/** 单次对话内最多执行多少轮工具调用，防止模型来回调用不停。 */
export const MAX_TOOL_ROUNDS = 6;

/** 一次工具调用的展示信息（从完整工具名解析出服务器与工具）。 */
export interface ParsedToolName {
  server: string;
  tool: string;
}

export function parseMcpToolName(qualifiedName: string): ParsedToolName | null {
  if (!qualifiedName.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = qualifiedName.slice(MCP_TOOL_PREFIX.length);
  const separator = rest.indexOf('__');
  if (separator <= 0) return null;
  return {
    server: rest.slice(0, separator),
    tool: rest.slice(separator + 2),
  };
}

/**
 * 汇总当前可用的 MCP 工具，生成 llama.cpp 的 tools 字段。
 * 只纳入「已连接」服务器的工具——未连接的服务器其工具无法执行。
 */
export function collectMcpToolSpecs(servers: McpServerEntry[]): {
  specs: ChatToolSpec[];
  owners: Map<string, string>;
} {
  const specs: ChatToolSpec[] = [];
  const owners = new Map<string, string>();
  const seen = new Set<string>();

  for (const server of servers) {
    if (server.state !== 'ready') continue;
    for (const tool of server.tools ?? []) {
      if (seen.has(tool.qualifiedName)) continue;
      seen.add(tool.qualifiedName);
      specs.push({
        type: 'function',
        function: {
          name: tool.qualifiedName,
          description: tool.description || `${server.name} 提供的工具`,
          parameters: normalizeSchema(tool.inputSchema),
        },
      });
      owners.set(tool.qualifiedName, server.id);
    }
  }

  return { specs, owners };
}

/**
 * llama.cpp 要求 parameters 是一个 JSON Schema 对象。
 * 服务端偶尔返回 null / 非对象，这里兜底成「无参数」的 schema。
 */
function normalizeSchema(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
    const record = schema as Record<string, unknown>;
    if (record.type === 'object') return record;
    return { type: 'object', properties: {}, ...record };
  }
  return { type: 'object', properties: {} };
}

/**
 * 把工具调用结果回填成下一轮的对话消息。
 * assistant 侧必须带上原始 tool_calls（含 id），tool 侧用同一个 id 呼应。
 */
export function buildToolFollowUpMessages(
  assistantContent: string,
  calls: ChatToolCall[],
  results: Array<{ id: string; text: string; isError?: boolean }>,
): ChatCompletionMessage[] {
  return [
    {
      role: 'assistant',
      content: assistantContent,
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: call.rawArguments || JSON.stringify(call.arguments) },
      })),
    },
    ...results.map((result) => ({
      role: 'tool' as const,
      tool_call_id: result.id,
      content: result.isError
        ? `工具执行失败：${result.text}`
        : result.text || '（工具执行完成，没有返回内容）',
    })),
  ];
}

/** 把模型给出的参数整理成工具调用记录（供界面展示）。 */
export function toToolActivity(call: ChatToolCall): ToolActivity {
  const parsed = parseMcpToolName(call.name);
  return {
    id: call.id || call.name,
    server: parsed?.server ?? '未知服务器',
    tool: parsed?.tool ?? call.name,
    arguments: call.arguments,
    pending: true,
  };
}

/** 展示用：把参数对象压成一行摘要。 */
export function formatToolArguments(args: Record<string, unknown>): string {
  const entries = Object.entries(args ?? {});
  if (entries.length === 0) return '（无参数）';
  return entries
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join('，');
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '空';
  if (typeof value === 'string') return value.length > 60 ? `${value.slice(0, 60)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/** 展示用：截断工具返回文本，避免气泡被超长结果撑爆。 */
export function clampToolResult(text: string, limit = 600): string {
  const trimmed = (text ?? '').trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit)}…（已截断，共 ${trimmed.length} 字）`;
}

/** 一次对话请求的执行器：与 `streamChatCompletion` 的必填项对应。 */
export type ChatRoundRunner = (
  messages: ChatCompletionMessage[],
  handlers: {
    onToken: (token: string) => void;
    onReasoningDelta?: (reasoningContent: string) => void;
  },
) => Promise<ChatCompletionMetrics>;

export interface ToolLoopOutcome {
  /** 已累计的 prompt / completion token（含所有轮次）。 */
  promptTokens: number;
  completionTokens: number;
  /** 是否因为达到轮次上限而停止。 */
  hitRoundLimit: boolean;
  /** 工具调用记录（供界面展示）。 */
  activities: ToolActivity[];
  /** 最后一轮的完整指标（供界面展示耗时/速度等）。 */
  metrics: ChatCompletionMetrics;
}

/**
 * 驱动「模型请求工具 → 应用执行 → 结果回填 → 模型续写」的循环。
 *
 * 把循环抽出来是为了让首次发送与编辑重发走同一条实现，
 * 避免两处逻辑漂移（此前重发路径就漏掉过新增能力）。
 */
export async function runChatToolLoop(options: {
  runRound: ChatRoundRunner;
  servers: McpServerEntry[];
  conversation: ChatCompletionMessage[];
  /** 首轮已经生成的内容（继续调用时会被回填进 assistant 消息）。 */
  initialContent: string;
  /** 首轮的 token 统计（首轮由调用方已执行）。 */
  initialPromptTokens: number;
  initialCompletionTokens: number;
  /** 首轮的完整指标（用于展示耗时与速度）。 */
  initialMetrics: ChatCompletionMetrics;
  /** 首轮响应中模型请求的工具调用；工具循环从它开始执行。 */
  initialToolCalls: ChatToolCall[];
  /** 执行工具调用；由调用方注入以便注入 UI 提示。 */
  callTool: (serverId: string, toolName: string, args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>;
  signal: AbortSignal;
  /** 每轮生成的内容变化。 */
  onContent: (content: string) => void;
  onReasoningDelta?: (reasoningContent: string) => void;
  /** 工具记录变化（包含 pending 状态）。 */
  onActivity?: (activities: ToolActivity[]) => void;
}): Promise<ToolLoopOutcome> {
  const { specs, owners } = collectMcpToolSpecs(options.servers);
  const activities: ToolActivity[] = [];
  let promptTokens = options.initialPromptTokens;
  let completionTokens = options.initialCompletionTokens;
  // 首轮请求已经完成，必须把它返回的 tool_calls 作为下一步执行入口。
  // 若从空数组开始，循环会在第一次检查时直接退出，模型虽然返回了工具调用，
  // 应用却不会真正调用 MCP，也不会回填 tool 结果。
  let lastToolCalls: ChatToolCall[] = [...options.initialToolCalls];
  let content = options.initialContent;
  let lastMetrics = options.initialMetrics;

  const publish = () => options.onActivity?.([...activities]);

  // 没有任何已连接的 MCP 服务器时，工具清单为空，循环自然只跑 0 轮。
  void specs;

  let round = 0;
  while (round < MAX_TOOL_ROUNDS) {
    // 首轮调用来自 initialToolCalls；后续调用由上一轮结果驱动。
    if (lastToolCalls.length === 0) break;
    round += 1;

    const results: Array<{ id: string; text: string; isError?: boolean }> = [];
    for (const call of lastToolCalls) {
      const activity = toToolActivity(call);
      const index = activities.length;
      activities.push(activity);
      publish();

      const serverId = owners.get(call.name);
      let text = '';
      let isError = false;
      if (!serverId) {
        isError = true;
        text = `找不到提供 ${call.name} 的 MCP 服务器，请确认它仍在「工具」页处于已连接状态。`;
      } else if (!call.id) {
        isError = true;
        text = '模型返回的工具调用缺少 id，无法回填结果。';
      } else if (call.argumentsValid === false) {
        // 参数不是合法 JSON：不能拿空参数真的执行，把错误回填给模型让它重试。
        isError = true;
        text = `工具 ${call.name} 的参数不是合法 JSON，无法调用。模型给出的原文：${call.rawArguments.slice(0, 300)}`;
      } else {
        try {
          const payload = await options.callTool(serverId, call.name, call.arguments);
          text = payload.text ?? '';
          isError = Boolean(payload.isError);
        } catch (error) {
          isError = true;
          text = String(error instanceof Error ? error.message : error);
        }
      }
      if (options.signal.aborted) {
        // 用户中止：把这条记录落定，避免气泡里永远显示「执行中」。
        activities[index] = { ...activity, result: '（已中止，未执行）', isError: true, pending: false };
        publish();
        break;
      }

      activities[index] = { ...activity, result: clampToolResult(text), isError, pending: false };
      publish();
      results.push({ id: call.id || call.name, text, isError });
    }

    if (options.signal.aborted) break;

    options.conversation.push(...buildToolFollowUpMessages(content, lastToolCalls, results));
    content = '';
    options.onContent('');

    const next = await options.runRound(options.conversation, {
      onToken: (token) => {
        content += token;
        options.onContent(content);
      },
      onReasoningDelta: options.onReasoningDelta,
    });
    promptTokens += next.promptTokens;
    completionTokens += next.completionTokens;
    lastToolCalls = next.toolCalls;
    lastMetrics = next;
  }

  return {
    promptTokens,
    completionTokens,
    hitRoundLimit: round >= MAX_TOOL_ROUNDS && lastToolCalls.length > 0,
    activities,
    metrics: {
      ...lastMetrics,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    },
  };
}
