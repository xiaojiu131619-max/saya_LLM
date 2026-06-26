import { Moon, SunMedium } from 'lucide-react';
import type { ThemeType } from '@/types';

interface ThemeToggleButtonProps {
  theme: ThemeType;
  onClick: () => void;
  className?: string;
}

function playThemeRipple(button: HTMLButtonElement, theme: ThemeType) {
  if (typeof document === 'undefined') return;
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reducedMotion) return;

  const rect = button.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const radius = Math.hypot(
    Math.max(x, window.innerWidth - x),
    Math.max(y, window.innerHeight - y)
  );
  const nextColor = theme === 'dark' ? '#FBFAF6' : '#11100E';
  const ripple = document.createElement('div');

  Object.assign(ripple.style, {
    position: 'fixed',
    left: `${x}px`,
    top: `${y}px`,
    width: `${radius * 2}px`,
    height: `${radius * 2}px`,
    borderRadius: '9999px',
    background: nextColor,
    pointerEvents: 'none',
    transform: 'translate(-50%, -50%) scale(0)',
    transformOrigin: 'center',
    zIndex: '2147483647',
    opacity: '0.98',
  });

  document.body.appendChild(ripple);
  const animation = ripple.animate(
    [
      { transform: 'translate(-50%, -50%) scale(0)', opacity: 0.98 },
      { transform: 'translate(-50%, -50%) scale(1)', opacity: 0.98, offset: 0.72 },
      { transform: 'translate(-50%, -50%) scale(1)', opacity: 0 },
    ],
    { duration: 620, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }
  );
  animation.onfinish = () => ripple.remove();
  animation.oncancel = () => ripple.remove();
}

export default function ThemeToggleButton({ theme, onClick, className = '' }: ThemeToggleButtonProps) {
  const dark = theme === 'dark';
  const label = dark ? '切换浅色主题' : '切换深色主题';

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    playThemeRipple(event.currentTarget, theme);
    window.setTimeout(onClick, 70);
  };

  return (
    <button
      onClick={handleClick}
      className={`group relative flex h-8 w-8 flex-shrink-0 items-center justify-center overflow-hidden rounded-md border transition-[transform,colors] duration-200 hover:-translate-y-px active:scale-95 ${
        dark
          ? 'border-[#4D463D] bg-[#2E2A24] text-[#F3EBDD]'
          : 'border-[#DCD7CC] bg-[#FAF8F2] text-[#625B50]'
      } ${className}`}
      title={label}
      aria-label={label}
    >
      <span
        className={`absolute inset-0 transition-opacity duration-300 ${
          dark
            ? 'bg-[radial-gradient(circle_at_30%_30%,rgba(255,243,208,0.14),transparent_55%)] opacity-100'
            : 'bg-[radial-gradient(circle_at_30%_30%,rgba(208,102,70,0.08),transparent_55%)] opacity-0'
        }`}
      />
      <span className="absolute inset-0 m-auto flex h-4 w-4 items-center justify-center">
        <Moon
          className={`absolute h-4 w-4 text-[#F3EBDD] transition-all duration-200 ${
            dark ? 'rotate-0 scale-100 opacity-100' : 'rotate-45 scale-50 opacity-0'
          }`}
        />
        <SunMedium
          className={`absolute h-4 w-4 text-[#8A8174] transition-all duration-200 ${
            dark ? '-rotate-45 scale-50 opacity-0' : 'rotate-0 scale-100 opacity-100'
          }`}
        />
      </span>
      <span
        className={`absolute inset-[3px] rounded-[5px] border transition-[opacity,border-color] duration-300 ${
          dark
            ? 'border-[rgba(238,221,186,0.18)] opacity-55'
            : 'border-[rgba(220,215,204,0.9)] opacity-85'
        }`}
      />
    </button>
  );
}
