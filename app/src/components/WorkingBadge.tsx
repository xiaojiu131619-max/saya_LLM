import { useEffect, useState } from 'react';

/** 把毫秒差格式化成截图里的样子：4 分 33.3 秒 / 33.3 秒 / 1 时 02 分。 */
function formatWorkElapsed(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  if (total < 60) return `${total.toFixed(1)} 秒`;
  if (total < 3600) {
    const minutes = Math.floor(total / 60);
    return `${minutes} 分 ${(total - minutes * 60).toFixed(1)} 秒`;
  }
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total - hours * 3600) / 60);
  return `${hours} 时 ${String(minutes).padStart(2, '0')} 分`;
}

interface WorkingBadgeProps {
  /** 状态词，默认「工作中」。 */
  label?: string;
  /** 起始时间戳（ms）。给了才显示计时；不给就只有点阵 + 状态词。 */
  startedAt?: number | null;
  /** 计时刷新间隔（ms）：默认 100ms，一位小数不抖。 */
  tickMs?: number;
  className?: string;
  /** 计时数字的颜色（默认与文字同色，稍淡）。 */
  elapsedClassName?: string;
}

/**
 * 点阵「工作中」徽章：3×3 小方点依次亮起 + 计时。
 * 纯 CSS 动画，`prefers-reduced-motion` 下自动静止，不引入动画库。
 */
export default function WorkingBadge({
  label = '工作中',
  startedAt = null,
  tickMs = 100,
  className = '',
  elapsedClassName = 'text-[var(--text-tertiary)]',
}: WorkingBadgeProps) {
  const [now, setNow] = useState(() => Date.now());

  // 只在「有起点」时订阅时钟：now 的初值就是挂载时刻，够用；
  // 起点变化时 now 可能略早于起点，formatWorkElapsed 会把负值压成 0。
  useEffect(() => {
    if (startedAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), tickMs);
    return () => window.clearInterval(timer);
  }, [startedAt, tickMs]);

  const elapsed = startedAt === null ? null : formatWorkElapsed(now - startedAt);

  return (
    <span className={`inline-flex min-w-0 items-center gap-2 ${className}`}>
      <span className="work-dots" aria-hidden="true">
        {Array.from({ length: 9 }, (_, index) => (
          <i key={index} style={{ ['--i' as string]: index }} />
        ))}
      </span>
      <span className="truncate whitespace-nowrap">{label}</span>
      {elapsed && (
        <span className={`mono-font whitespace-nowrap tabular-nums ${elapsedClassName}`}>{elapsed}</span>
      )}
    </span>
  );
}
