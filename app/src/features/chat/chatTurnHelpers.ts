import { attachmentMediaMime } from '@/features/chat/chatUtils';
import { partialMetricsFromError } from '@/lib/desktop';

/** 贴底吸附的判定半径：距底部超过该值才显示「回到底部」按钮。 */
export const AUTO_SCROLL_MAGNET_PX = 56;
/** 程序滚动与用户滚动区分的容差（像素）。 */
export const SCROLL_RELEASE_DELTA_PX = 2;

/** 把媒体文件读成可发给多模态模型的 data URL。 */
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      if (comma < 0) { reject(new Error('读取媒体数据失败')); return; }
      resolve(`data:${attachmentMediaMime(file.name, file.type)};base64,${result.slice(comma + 1)}`);
    };
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

export function elapsedRequestStats(startTime: number, ctxTotal = 0) {
  return {
    ctxUsed: 0,
    ctxTotal,
    outputTokens: 0,
    firstTokenDelay: 0,
    tokensPerSec: 0,
    genTime: Math.max(0, (performance.now() - startTime) / 1000),
  };
}

export function elapsedMessageStats(timestamp: number, ctxTotal = 0) {
  return {
    ctxUsed: 0,
    ctxTotal,
    outputTokens: 0,
    firstTokenDelay: 0,
    tokensPerSec: 0,
    genTime: Math.max(0, (Date.now() - timestamp) / 1000),
  };
}

/** 终止 / 失败时落定的统计：真实耗时 + 中止前流式已产生的部分测量值（有什么写什么）。
 *  时钟与 elapsedRequestStats 一致（performance.now 基准的 startTime）。 */
export function terminatedMessageStats(error: unknown, startTime: number, ctxTotal = 0) {
  const stats = elapsedRequestStats(startTime, ctxTotal);
  const partial = partialMetricsFromError(error);
  if (!partial) return stats;
  return {
    ...stats,
    ...(Number(partial.completionTokens) > 0 ? { outputTokens: Math.round(Number(partial.completionTokens)) } : {}),
    ...(Number(partial.firstTokenDelay) > 0 ? { firstTokenDelay: Number(partial.firstTokenDelay) } : {}),
    ...(Number(partial.tokensPerSec) > 0 ? { tokensPerSec: Number(partial.tokensPerSec) } : {}),
  };
}

/**
 * 流式内容缓冲器：把「每个 token 一次 dispatch」合并成约 48ms 一次。
 *
 * 每次 `UPDATE_MESSAGE` 都会复制会话数组与消息数组，并触发全局 Context 更新
 * （会话排序、isAnyGenerating、Markdown 全文解析都会重算）。token 速率高时
 * 生成一屏文字就能触发上百次全量更新，长会话下开销随消息数量线性增长。
 *
 * 合并后视觉上仍是逐字出现（48ms ≈ 一帧多），但渲染次数下降一个数量级；
 * `commit()` 用于结束/中止时强制把最后一段内容落盘，避免尾部丢字。
 */
export function createStreamFlusher(flush: (content: string) => void, intervalMs = 48) {
  let pending: string | null = null;
  let timer: number | null = null;

  const commit = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    if (pending === null) return;
    const content = pending;
    pending = null;
    flush(content);
  };

  const push = (content: string) => {
    pending = content;
    if (timer !== null) return;
    timer = window.setTimeout(() => {
      timer = null;
      if (pending === null) return;
      const value = pending;
      pending = null;
      flush(value);
    }, intervalMs);
  };

  return { push, commit };
}
