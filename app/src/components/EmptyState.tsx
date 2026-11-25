import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * 统一的空状态版式：图标 + 一句话主标题 + 一行说明 + 可选操作。
 *
 * 各页原先各自写「暂无 X」的灰字，字号、间距、对齐都不一样；这里只统一版式，
 * 不做插图，颜色全部取自既有令牌（`--surface-muted` / `--text-secondary` / `--text-tertiary`）。
 *
 * - `compact`：侧栏列表、设置面板、表格内的小块空态（左对齐，图标 28px）；
 * - 默认：整页 / 整块内容区的空态（居中，图标 44px）。
 */
export default function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  compact = false,
}: {
  icon?: LucideIcon;
  /** 一句话主标题，例如「暂无对话」。 */
  title: string;
  /** 补充说明：为什么空、下一步做什么。 */
  description?: string;
  /** 操作区（按钮或链接）。 */
  action?: ReactNode;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <div className="anim-enter-fade flex items-start gap-2.5 px-3 py-4 text-left">
        {Icon && (
          <span className="mt-0.5 grid h-7 w-7 flex-shrink-0 place-items-center rounded-[var(--radius-field)] bg-[var(--surface-muted)] text-[var(--text-tertiary)]">
            <Icon className="h-3.5 w-3.5" />
          </span>
        )}
        <div className="min-w-0">
          <div className="text-[length:var(--font-caption)] font-medium text-[var(--text-secondary)]">{title}</div>
          {description && (
            <div className="mt-0.5 text-[length:var(--font-eyebrow)] leading-[var(--leading-ui)] text-[var(--text-tertiary)]">
              {description}
            </div>
          )}
          {action && <div className="mt-2">{action}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="anim-enter-fade flex h-full items-center justify-center px-6 py-10 text-center">
      <div className="max-w-sm">
        {Icon && (
          <span className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-[var(--radius-field)] bg-[var(--surface-muted)] text-[var(--text-tertiary)]">
            <Icon className="h-5 w-5" />
          </span>
        )}
        <div className="text-[length:var(--font-body)] font-semibold text-[var(--text-primary)]">{title}</div>
        {description && (
          <p className="mt-1.5 text-[length:var(--font-caption)] leading-[var(--leading-ui)] text-[var(--text-tertiary)]">
            {description}
          </p>
        )}
        {action && <div className="mt-3 flex justify-center">{action}</div>}
      </div>
    </div>
  );
}
