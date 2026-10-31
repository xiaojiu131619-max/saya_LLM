import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

interface SettingSectionProps {
  title: string;
  icon: LucideIcon;
  children: ReactNode;
  /** 入场动画延迟（秒）。仅影响观感，不影响可见性。 */
  delay?: number;
}

interface SettingRowProps {
  label: string;
  description?: string;
  children: ReactNode;
}

/**
 * 入场动画走 CSS（.anim-section-in），不再由 framer-motion 驱动。
 *
 * 原因：motion.div 的 initial={{opacity:0}} 会把内联 opacity:0 写死在元素上，
 * 一旦 JS 动画不推进（后台标签页 rAF 节流、无头环境、动画库异常），
 * 整块设置内容就永久停在不可见状态——内容是被「动画失败」带走的。
 *
 * 改成 CSS 后：元素默认就是可见的，动画只是从 opacity:0 淡入的装饰。
 * 动画没跑 = 少一段入场效果；动画被禁用 = 直接显示。功能与可见性解耦。
 */
export function SettingSection({ title, icon: Icon, children, delay = 0 }: SettingSectionProps) {
  return (
    <div
      className="workspace-setting-section anim-section-in border-b border-[var(--border-subtle)] py-5"
      style={delay > 0 ? { animationDelay: `${delay}s` } : undefined}
    >
      <div className="mb-3 flex items-center gap-2.5">
        <Icon className="h-4.5 w-4.5 text-[var(--accent)]" />
        <h2 className="text-[15px] font-semibold text-primary-custom">{title}</h2>
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

export function SettingRow({ label, description, children }: SettingRowProps) {
  return (
    <div className="flex items-center justify-between py-2">
      <div className="flex-1 min-w-0 mr-4">
        <div className="text-sm text-primary-custom">{label}</div>
        {description && (
          <div className="text-xs text-secondary-custom mt-0.5">{description}</div>
        )}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}
