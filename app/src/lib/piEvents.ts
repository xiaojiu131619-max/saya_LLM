/**
 * Pi RPC 事件 → 界面步骤 / 失败原因的纯函数。
 *
 * 这里不碰 Tauri IPC，方便用 `node --test` 直接回归协议解析；
 * 传输层（invoke / 事件订阅）仍在 `lib/ipc/pi.ts`。
 */

export interface PiToolStep {
  id: string;
  tool: string;
  args: string;
  /** write_file / edit_file 的路径，用于产物卡。 */
  path?: string;
  /** canvas_run 等工具在结果 meta 里带回的会话工作区产物相对路径。 */
  canvasArtifact?: string;
  result?: string;
  ok?: boolean;
  state: 'running' | 'done' | 'error';
}

export interface PiUiState {
  assistantText: string;
  thinkingChars: number;
  steps: PiToolStep[];
  settled: boolean;
}

/** 从 Pi 的 RPC 事件里取增量文本。 */
export function piTextDelta(event: Record<string, unknown>): string | null {
  if (event.type !== 'message_update') return null;
  const assistant = event.assistantMessageEvent as Record<string, unknown> | undefined;
  if (!assistant || assistant.type !== 'text_delta') return null;
  return typeof assistant.delta === 'string' ? assistant.delta : null;
}

/**
 * 取本轮失败原因。
 *
 * Pi 不会发 `type: "error"` 事件：模型/网络失败体现在 `turn_end` / `message_end`
 * 的 `stopReason: "error"` 与 `errorMessage` 上，最终由 `agent_end` 收尾。
 * 之前只认 `type: "error"`，所以连不上模型时界面既不报错、也不显示内容，
 * 气泡直接收尾成空白——看起来就是「发消息没反应」。
 */
export function piFailureMessage(event: Record<string, unknown>): string | null {
  const type = event.type;
  if (type !== 'turn_end' && type !== 'message_end' && type !== 'agent_end') return null;
  const candidates: unknown[] = [];
  if (event.message) candidates.push(event.message);
  if (Array.isArray(event.messages)) candidates.push(...event.messages.slice().reverse());
  for (const item of candidates) {
    if (!item || typeof item !== 'object') continue;
    const message = item as Record<string, unknown>;
    if (message.role !== 'assistant') continue;
    if (message.stopReason !== 'error' && message.stopReason !== 'aborted') continue;
    const detail = typeof message.errorMessage === 'string' ? message.errorMessage.trim() : '';
    return detail || '模型请求失败';
  }
  return null;
}

/** 把 Pi 的原始错误翻译成能照着做的提示。 */
export function describePiFailure(detail: string, baseUrl: string): string {
  const lower = detail.toLowerCase();
  const authFailed =
    lower.includes('401') ||
    lower.includes('invalid api key') ||
    lower.includes('authentication_error') ||
    lower.includes('unauthorized');
  if (authFailed) {
    return [
      `模型服务拒绝了 API Key（401）：${baseUrl}`,
      '本机服务开启了鉴权时，Pi 必须使用同一把 Key：到 Agent 页「Pi」点「使用本机服务密钥」，然后重启 Pi。',
      `（Pi 原始错误：${detail}）`,
    ].join('\n');
  }
  const unreachable =
    lower.includes('connection error') ||
    lower.includes('fetch failed') ||
    lower.includes('econnrefused') ||
    lower.includes('timeout') ||
    lower.includes('connect');
  if (unreachable) {
    return [
      `Pi 连不上模型端点：${baseUrl}`,
      '先在本应用加载并启动主模型，或到 Agent 页的「Pi」设置里把「引擎地址」改成实际在跑的服务。',
      `（Pi 原始错误：${detail}）`,
    ].join('\n');
  }
  return `Pi 任务失败：${detail}`;
}

export function piThinkingDelta(event: Record<string, unknown>): string | null {
  if (event.type !== 'message_update') return null;
  const assistant = event.assistantMessageEvent as Record<string, unknown> | undefined;
  if (!assistant || assistant.type !== 'thinking_delta') return null;
  return typeof assistant.delta === 'string' ? assistant.delta : null;
}

function preview(value: unknown, limit = 600): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Pi 工具结果常见两种形态：`content[].text` 或 `structuredContent`。取人能读的那段。 */
function toolResultText(result: unknown): string {
  if (result === null || result === undefined) return '';
  if (typeof result === 'string') return preview(result);
  const record = result as Record<string, unknown>;
  const structured = record.structuredContent;
  if (typeof structured === 'string' && structured.trim()) {
    return preview(structured);
  }
  const content = record.content;
  if (Array.isArray(content)) {
    const texts = content
      .map((item) =>
        item && typeof item === 'object'
          ? (item as Record<string, unknown>).text
          : null,
      )
      .filter((text): text is string => typeof text === 'string' && text.length > 0);
    if (texts.length > 0) return preview(texts.join('\n'));
  }
  return preview(result);
}

/** 把 tool_execution_start / end 事件翻译成步骤更新。 */
export function piToolStep(event: Record<string, unknown>): PiToolStep | null {
  const type = event.type;
  if (type !== 'tool_execution_start' && type !== 'tool_execution_end') return null;
  const id = String(event.toolCallId ?? event.id ?? `${event.toolName ?? 'tool'}-${Date.now()}`);
  const tool = String(event.toolName ?? event.name ?? 'tool');
  const rawArgs = event.args ?? event.input ?? event.toolInput;
  const path =
    rawArgs && typeof rawArgs === 'object'
      ? (rawArgs as Record<string, unknown>).path
      : undefined;
  if (type === 'tool_execution_start') {
    return {
      id,
      tool,
      args: preview(rawArgs),
      path: typeof path === 'string' ? path : undefined,
      state: 'running',
    };
  }
  const result = event.result ?? event.output ?? event.toolResult;
  const resultRecord =
    result && typeof result === 'object'
      ? (result as Record<string, unknown>)
      : undefined;
  // 宿主扩展把 meta 放在 `details`；`structuredContent` 只对 MCP / 程序化工具存在。
  // 之前只读 structuredContent，画布产物与命令退出码永远取不到。
  const meta =
    (resultRecord?.details as Record<string, unknown> | undefined) ??
    (resultRecord?.structuredContent as Record<string, unknown> | undefined);
  const exitCode = meta?.exitCode ?? meta?.exit_code;
  const failed =
    event.isError === true ||
    resultRecord?.isError === true ||
    event.ok === false ||
    (typeof exitCode === 'number' && exitCode !== 0);
  const ok = !failed;
  const canvasArtifact =
    typeof meta?.artifact === 'string' ? meta.artifact : undefined;
  return {
    id,
    tool,
    args: '',
    path: typeof path === 'string' ? path : undefined,
    canvasArtifact,
    result: toolResultText(result),
    ok,
    state: ok ? 'done' : 'error',
  };
}
