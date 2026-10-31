import type { ChatSession, Message } from '@/types';
import type { SessionSearchHit } from '@/features/chat/ChatSidebar';

/**
 * 会话搜索：标题模糊匹配 + 对话内正文检索。
 *
 * 两件事分开做，但仍然是一次输入同时生效——用户在侧边栏只看到一个搜索框，
 * 不应该先去「切模式」再搜。
 *
 * 模糊匹配的做法是子序列匹配（subsequence）：搜索词的字按顺序出现在标题里就算命中，
 * 不要求连续。这对中文尤其有用（「本地服务」能命中「本地推理服务」），也顺带
 * 让英文缩写（「qr」命中「Qwen3 Reasoning」）可用。连续命中会加权，排序更符合直觉。
 *
 * 正文检索只取第一条命中消息，并截出前后一小段作为摘要——侧边栏的行高有限，
 * 展示整个匹配上下文反而看不出命中点。
 */

/** 命中摘要前后各取多少字。 */
const SNIPPET_PADDING = 18;
/** 摘要总长上限（含前后缀），超过就截断。 */
const SNIPPET_MAX = 64;

export interface SessionSearchResult {
  /** 过滤后的会话，顺序保持「最近更新在前」。 */
  sessions: ChatSession[];
  /** sessionId → 命中详情（只含有命中的会话）。 */
  hits: Map<string, SessionSearchHit>;
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 子序列模糊匹配。返回匹配得分（越高越相关），不匹配返回 null。
 *
 * 计分规则：
 * - 每命中一个字符 +1；
 * - 相邻字符连续命中额外 +2（连续更像「真的在搜这个词」）；
 * - 命中位置越靠前略微加权（标题开头的词通常是主语）。
 */
export function fuzzyScore(text: string, query: string): number | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  const haystack = text.toLowerCase();
  let score = 0;
  let cursor = 0;
  let lastIndex = -2;
  for (const ch of needle) {
    // 跳过空白：搜索词带空格时按「词序列」匹配，不强求空格也在标题里。
    if (ch === ' ') continue;
    const found = haystack.indexOf(ch, cursor);
    if (found < 0) return null;
    score += 1;
    if (found === lastIndex + 1) score += 2;
    score += Math.max(0, 3 - Math.floor(found / 8)) * 0.1;
    lastIndex = found;
    cursor = found + 1;
  }
  return score;
}

/** 会话里第一条正文命中的消息。 */
function firstMatchingMessage(messages: Message[], query: string): { message: Message; index: number } | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if ((message.content ?? '').toLowerCase().includes(needle)) return { message, index };
    if ((message.reasoningContent ?? '').toLowerCase().includes(needle)) return { message, index };
  }
  return null;
}

/** 从命中消息里截出命中点附近的摘要。 */
function buildSnippet(message: Message, query: string): string {
  const needle = query.trim();
  const raw = message.content || message.reasoningContent || '';
  const index = raw.toLowerCase().indexOf(needle.toLowerCase());
  const role = message.role === 'user' ? '你' : '模型';
  if (index < 0) {
    // 命中在思考内容里（content 没命中）：直接用思考内容开头。
    const fallback = (message.reasoningContent ?? '').replace(/\s+/g, ' ').trim();
    return `${role}（思考）：${fallback.slice(0, SNIPPET_MAX)}`;
  }
  const start = Math.max(0, index - SNIPPET_PADDING);
  const end = Math.min(raw.length, index + needle.length + SNIPPET_PADDING);
  const body = raw.slice(start, end).replace(/\s+/g, ' ').trim();
  const prefix = start > 0 ? '…' : '';
  const suffix = end < raw.length ? '…' : '';
  const text = `${prefix}${body}${suffix}`;
  const clipped = text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX - 1)}…` : text;
  return `${role}：${clipped}`;
}

/**
 * 执行搜索。空查询时原样返回（不做任何过滤，也不产生 hits）。
 */
export function searchSessions(sessions: ChatSession[], query: string): SessionSearchResult {
  const trimmed = query.trim();
  if (!trimmed) return { sessions, hits: new Map() };

  const scored: Array<{ session: ChatSession; score: number; hit: SessionSearchHit }> = [];
  for (const session of sessions) {
    const titleScore = fuzzyScore(session.title, trimmed);
    const bodyMatch = firstMatchingMessage(session.messages, trimmed);
    if (titleScore === null && !bodyMatch) continue;
    // 标题命中优先于正文命中：同样相关的两项里，用户更可能想找标题就是那个词的会话。
    const score = (titleScore ?? 0) + (bodyMatch ? 1 : 0) + (titleScore !== null ? 2 : 0);
    scored.push({
      session,
      score,
      hit: {
        sessionId: session.id,
        titleMatched: titleScore !== null,
        ...(bodyMatch ? { snippet: buildSnippet(bodyMatch.message, trimmed) } : {}),
      },
    });
  }

  // 同分时保持原来的「最近更新在前」顺序（stable sort）。
  scored.sort((a, b) => b.score - a.score);
  return {
    sessions: scored.map((item) => item.session),
    hits: new Map(scored.map((item) => [item.hit.sessionId, item.hit])),
  };
}

/** 会话内文本检索：返回命中消息 id 列表（会话内跳转 / 高亮用）。 */
export function matchMessageIds(messages: Message[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return messages
    .filter((message) =>
      (message.content ?? '').toLowerCase().includes(needle)
      || (message.reasoningContent ?? '').toLowerCase().includes(needle))
    .map((message) => message.id);
}

export { escapeRegExp };
