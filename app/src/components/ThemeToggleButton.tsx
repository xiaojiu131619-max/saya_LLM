import { Moon, SunMedium } from 'lucide-react';
import type { ThemeType } from '@/types';

interface ThemeToggleButtonProps {
  theme: ThemeType;
  onClick: () => void;
  className?: string;
}

/**
 * 明暗主题切换按钮。
 *
 * 显示的是「点下去会切到哪个主题」的图标：浅色时显示月亮（切深色），
 * 深色时显示太阳（切浅色）。之前显示当前主题图标，和 aria-label/title
 * 的「切换浅色/深色主题」正好相反，看起来像图标错乱。
 */
export default function ThemeToggleButton({ theme, onClick, className = '' }: ThemeToggleButtonProps) {
  const dark = theme === 'dark';
  const label = dark ? '切换浅色主题' : '切换深色主题';

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={dark}
      className={`group relative flex h-8 w-8 flex-shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] transition-[transform,background-color,border-color,color] duration-150 [transition-timing-function:cubic-bezier(0.33,0,0.67,1)] hover:border-[var(--accent)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] active:scale-95 ${className}`}
    >
      <span
        className={`absolute inset-0 transition-opacity duration-150 ${
          dark ? 'opacity-100' : 'opacity-0'
        }`}
        style={{ background: 'radial-gradient(circle at 30% 30%, var(--accent-subtle), transparent 58%)' }}
        aria-hidden="true"
      />
      <span className="relative flex h-4 w-4 items-center justify-center" aria-hidden="true">
        <Moon
          className={`absolute h-4 w-4 transition-all duration-150 [transition-timing-function:cubic-bezier(0.33,0,0.67,1)] ${
            dark ? 'rotate-45 scale-50 opacity-0' : 'rotate-0 scale-100 opacity-100'
          }`}
        />
        <SunMedium
          className={`absolute h-4 w-4 transition-all duration-150 [transition-timing-function:cubic-bezier(0.33,0,0.67,1)] ${
            dark ? 'rotate-0 scale-100 opacity-100' : '-rotate-45 scale-50 opacity-0'
          }`}
        />
      </span>
    </button>
  );
}
