import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { Message } from '@/types';

/** 对话右缘的问答刻度：按「一问一答」分组，悬停预览、点击跳转到该组提问。 */
export default function ConversationQuickRail({ messages, activeMessageId, onSelect }: {
  messages: Message[];
  activeMessageId?: string;
  onSelect: (messageId: string) => void;
}) {
  const turns = useMemo(() => {
    const grouped: Array<{
      id: string;
      messages: Message[];
      targetMessageId: string;
      questionPreview: string;
      answerPreview: string;
    }> = [];
    const messagePreview = (message: Message) => (
      (message.content || message.reasoningContent || '').replace(/\s+/g, ' ').trim()
    );

    messages.forEach((message) => {
      if (message.role === 'user' || grouped.length === 0) {
        grouped.push({
          id: message.id,
          messages: [message],
          targetMessageId: message.id,
          questionPreview: message.role === 'user' ? messagePreview(message) : '',
          answerPreview: message.role === 'assistant' ? messagePreview(message) : '',
        });
        return;
      }

      const currentTurn = grouped[grouped.length - 1];
      currentTurn.messages.push(message);
      if (!currentTurn.answerPreview) {
        currentTurn.answerPreview = messagePreview(message);
      }
    });

    return grouped;
  }, [messages]);
  const currentTurnId = useMemo(
    () => turns.find((turn) => turn.messages.some((message) => message.id === activeMessageId))?.id,
    [activeMessageId, turns]
  );
  const [hoveredTurnId, setHoveredTurnId] = useState<string | null>(null);

  if (turns.length === 0) return null;

  const hoveredIndex = turns.findIndex((turn) => turn.id === hoveredTurnId);
  const rowPitch = turns.length <= 8 ? 26 : turns.length <= 16 ? 22 : turns.length <= 28 ? 16 : turns.length <= 48 ? 11 : 7;
  const railHeight = Math.max(26, turns.length * rowPitch);
  const baseWidth = turns.length > 48 ? 5 : turns.length > 28 ? 6 : 8;

  return (
    <div className="pointer-events-none absolute bottom-[clamp(130px,12.5vh,144px)] left-2 top-6 z-20 hidden w-9 items-center md:flex">
      <div
        className="pointer-events-auto grid min-h-0 w-full overflow-visible"
        style={{
          height: `min(100%, ${railHeight}px)`,
          gridTemplateRows: `repeat(${turns.length}, minmax(0, 1fr))`,
        }}
        role="navigation"
        aria-label="对话问答刻度"
      >
      {turns.map((turn, index) => {
        const distance = hoveredIndex >= 0 ? Math.abs(index - hoveredIndex) : Number.POSITIVE_INFINITY;
        const hovered = turn.id === hoveredTurnId;
        const current = turn.id === currentTurnId;
        const influenced = hoveredIndex >= 0 && distance <= 3;
        const tickWidth = hovered ? 27 : distance === 1 ? 21 : distance === 2 ? 16 : distance === 3 ? 12 : baseWidth;
        const tickOpacity = hovered ? 1 : distance === 1 ? 0.82 : distance === 2 ? 0.64 : distance === 3 ? 0.48 : current ? 0.78 : 0.38;
        const questionPreview = turn.questionPreview || '未记录提问';
        const answerPreview = turn.answerPreview || (turn.messages.some((message) => message.isStreaming) ? '正在回答...' : '暂无回答');
        return (
          <button
            key={turn.id}
            type="button"
            onClick={() => onSelect(turn.targetMessageId)}
            onMouseEnter={() => setHoveredTurnId(turn.id)}
            onMouseLeave={() => setHoveredTurnId(null)}
            onFocus={() => setHoveredTurnId(turn.id)}
            onBlur={() => setHoveredTurnId(null)}
            className="relative flex min-h-0 w-full items-center justify-start rounded-sm pl-1"
            aria-label={`跳转到第 ${index + 1} 组问答。提问：${questionPreview.slice(0, 48)}。回答：${answerPreview.slice(0, 48)}`}
            aria-current={current ? 'true' : undefined}
          >
            <motion.span
              className={`block rounded-full ${
                hovered
                  ? 'bg-[var(--accent)] dark:bg-[var(--accent)]'
                  : influenced
                    ? 'bg-[var(--state-danger-border)] dark:bg-[var(--state-danger-border)]'
                    : current
                      ? 'bg-[var(--accent)] dark:bg-[var(--accent)]'
                    : 'bg-[var(--text-tertiary)] dark:bg-[var(--text-tertiary)]'
              }`}
              initial={false}
              animate={{
                width: tickWidth,
                height: hovered ? 3 : influenced && distance <= 2 ? 2 : 1.5,
                opacity: tickOpacity,
              }}
              transition={{ type: 'spring', stiffness: 520, damping: 36, mass: 0.32 }}
            />
            <AnimatePresence>
              {hovered && (
                <motion.span
                  key={`${turn.id}-preview`}
                  aria-hidden="true"
                  initial={false}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className={`anim-enter-fade pointer-events-none absolute left-10 z-40 w-[min(300px,calc(100vw-148px))] rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--app-bg)] p-3 text-left shadow-[0_8px_24px_rgba(61,53,42,0.16)] dark:border-white/[0.10] dark:bg-[var(--surface-raised)] ${
                    index === 0
                      ? 'top-0'
                      : index === turns.length - 1
                        ? 'bottom-0'
                        : 'top-1/2 -translate-y-1/2'
                  }`}
                >
                  <span className="mb-2 block text-[length:var(--font-eyebrow)] font-semibold text-[var(--text-secondary)]">
                    第 {index + 1} 组问答
                  </span>
                  <span className="flex items-start gap-2">
                    <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--surface-muted)] text-[length:var(--font-eyebrow)] font-semibold text-[var(--accent)] dark:bg-[var(--surface-raised)]">问</span>
                    <span className="line-clamp-2 text-[length:var(--font-caption)] leading-5 text-[var(--text-primary)]">{questionPreview}</span>
                  </span>
                  <span className="mt-2 flex items-start gap-2 border-t border-[var(--border)] pt-2 dark:border-white/[0.08]">
                    <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--surface-muted)] text-[length:var(--font-eyebrow)] font-semibold text-[var(--text-secondary)] dark:bg-white/[0.06]">答</span>
                    <span className="line-clamp-2 text-[length:var(--font-caption)] leading-5 text-[var(--text-secondary)]">{answerPreview}</span>
                  </span>
                </motion.span>
              )}
            </AnimatePresence>
          </button>
        );
      })}
      </div>
    </div>
  );
}
