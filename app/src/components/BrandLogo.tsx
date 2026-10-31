import type { CSSProperties } from 'react';

/**
 * 应用品牌标识「拾壹」。
 *
 * 只用字符与 CSS 绘制（不引图片资源）：一个圆角方块里放「拾壹」的几何字标，
 * 底色跟随强调色，因此用户改主题色时 logo 一起变。
 *
 * 两种形态：
 * - `mark`：只有方块字标（标题栏、侧边栏窄栏用）；
 * - `lockup`：方块 + 文字「拾壹」（标题栏与设置页用）。
 */
export default function BrandLogo({
  size = 20,
  variant = 'mark',
  className = '',
  style,
}: {
  size?: number;
  variant?: 'mark' | 'lockup';
  className?: string;
  style?: CSSProperties;
}) {
  const mark = (
    <span
      aria-hidden="true"
      className="relative grid flex-shrink-0 place-items-center overflow-hidden rounded-[7px] bg-[var(--text-primary)] text-[var(--app-bg)] dark:bg-[var(--accent)] dark:text-[var(--text-on-accent)]"
      style={{ width: size, height: size, ...style }}
    >
      {/* 右下角一道斜切高光：字标在小尺寸下靠这块形状区分，不靠笔画细节。 */}
      <span
        className="pointer-events-none absolute -bottom-1/2 -right-1/2 h-full w-full rotate-45 bg-white/25 dark:bg-black/15"
        aria-hidden="true"
      />
      <span
        className="relative font-semibold leading-none tracking-[-0.06em]"
        style={{ fontSize: Math.max(9, Math.round(size * 0.5)) }}
      >
        拾
      </span>
    </span>
  );

  if (variant === 'mark') {
    return <span className={`inline-flex items-center ${className}`}>{mark}</span>;
  }

  return (
    <span className={`inline-flex min-w-0 items-center gap-2 ${className}`}>
      {mark}
      <span className="truncate text-[length:var(--font-body)] font-semibold tracking-[var(--tracking-tight)] text-[var(--text-primary)]">
        拾壹
      </span>
    </span>
  );
}
