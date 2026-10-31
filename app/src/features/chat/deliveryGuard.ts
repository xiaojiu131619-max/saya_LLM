/**
 * 交付护栏的判定层（hub/docs/04 §3 L3 的 F2，降级为「只提示、不重发」）。
 *
 * 为什么需要这一层：这类破损在模型侧没有任何信号——HTTP 200、日志零告警，
 * 用户看到的只是空气泡、或者一个缺结束标签的产物。平台层是唯一能拦住的地方。
 *
 * 只判**客观破损**，不做跨轮比较：
 *   empty      正文为空（区分是否被思考吃光输出预算）
 *   truncated  代码围栏未闭合 / <svg> 无闭合标签 / finish_reason=length
 *   shell_loop 只调用了工具、没有正文，且同一工具连续 ≥3 次
 *
 * 与 hub 的刻意偏离：hub 的 EMPTY 阈值是"正文 < 400 字符"，本实现只在真正为空时判。
 * 聊天里「42」「粉红色」这类短答是正常交付，按 400 字判会把它们全部误报。
 * 同理不判 fixed_point / same_plan：日常重问同一问题得到同样答案是正常的，
 * 那两条是给 agent 自主循环用的判据，留着会频繁误报。
 */

export type DeliveryIssue = 'empty' | 'truncated' | 'shell_loop';

export interface DeliveryJudgeInput {
  /** 本轮最终累积的正文（不要用流中途的片段判）。 */
  content: string;
  /** 服务端 finish_reason；`length` 是硬截断的强信号。 */
  finishReason?: string | null;
  /** 思考段字符数：只有思考没有正文时，说明输出预算被思考吃光。 */
  reasoningChars?: number;
  /** 本轮工具调用名（按发生顺序）。 */
  toolNames?: string[];
}

export interface DeliveryVerdict {
  ok: boolean;
  issue: DeliveryIssue | null;
  /** 给用户看的一句话说明；ok 时为空串。 */
  detail: string;
}

/** 代码围栏计数为奇数（有一个没闭合），或 `<svg>` 没有对应的 `</svg>`。 */
export function hasUnclosedArtifact(text: string): boolean {
  const body = text ?? '';
  if ((body.match(/```/g) ?? []).length % 2 === 1) return true;
  const opens = (body.match(/<svg[\s>]/gi) ?? []).length;
  if (opens > 0) {
    const closes = (body.match(/<\/svg>/gi) ?? []).length;
    if (closes < opens) return true;
  }
  return false;
}

/** 末尾连续同名工具的调用次数。 */
function trailingSameTool(toolNames: string[]): { count: number; name: string } {
  if (toolNames.length === 0) return { count: 0, name: '' };
  const last = toolNames[toolNames.length - 1];
  let count = 0;
  for (let i = toolNames.length - 1; i >= 0; i--) {
    if (toolNames[i] !== last) break;
    count += 1;
  }
  return { count, name: last };
}

export function judgeDelivery(input: DeliveryJudgeInput): DeliveryVerdict {
  const content = (input.content ?? '').trim();

  // 1) 纯工具轮空壳：没有正文，同一工具连着调了 ≥3 次。
  if (!content) {
    const trail = trailingSameTool(input.toolNames ?? []);
    if (trail.count >= 3) {
      return {
        ok: false,
        issue: 'shell_loop',
        detail: `只调用了工具 ${trail.name}、没有给出正文`,
      };
    }

    // 2) 空交付：思考有内容 ⇒ 输出预算被思考吃光；否则就是没输出。
    const ateByThinking = (input.reasoningChars ?? 0) > 0;
    return {
      ok: false,
      issue: 'empty',
      detail: ateByThinking ? '思考占满了输出预算，正文一个字都没出' : '没有给出任何正文',
    };
  }

  // 3) 半截：产物标记没闭合。
  if (hasUnclosedArtifact(content)) {
    return {
      ok: false,
      issue: 'truncated',
      detail: '产物没写完（代码围栏或 <svg> 缺结束标记）',
    };
  }

  // 4) 硬截断：服务端明确说到了上限。
  if ((input.finishReason ?? '').toLowerCase() === 'length') {
    return { ok: false, issue: 'truncated', detail: '输出达到上限被截断' };
  }

  return { ok: true, issue: null, detail: '' };
}
