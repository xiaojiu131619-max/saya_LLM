interface ToggleSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  className?: string;
  label?: string;
  /** 关联外部可见标签的 id；提供后读屏会念出标签正文，而不是默认的「切换开关」。 */
  ariaLabelledby?: string;
  disabled?: boolean;
  /** md（默认）轨道高 32px，满足桌面触控目标；sm 保持 24px，用于紧凑工具条。 */
  size?: 'sm' | 'md';
}

/** 两种尺寸的轨道与滑钮：md 56×32、滑钮 24；sm 48×24、滑钮 20，行程都是 24px。 */
const SIZE_STYLES = {
  sm: { track: 'h-6 w-12', knob: 'h-5 w-5', inset: 'left-0.5 top-0.5' },
  md: { track: 'h-8 w-14', knob: 'h-6 w-6', inset: 'left-1 top-1' },
} as const;

export default function ToggleSwitch({
  checked,
  onChange,
  className = '',
  label = '切换开关',
  ariaLabelledby,
  disabled = false,
  size = 'md',
}: ToggleSwitchProps) {
  const styles = SIZE_STYLES[size];

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabelledby ? undefined : label}
      aria-labelledby={ariaLabelledby}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative flex-shrink-0 rounded-full transition-colors duration-[var(--duration-fast)] ease-[var(--curve-easy)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-45 ${
        checked ? 'bg-[var(--accent)]' : 'bg-[var(--status-standby)]'
      } ${styles.track} ${className}`}
    >
      <span
        aria-hidden="true"
        className={`absolute rounded-full bg-white shadow-md transition-transform duration-[var(--duration-normal)] ease-[var(--curve-easy)] ${
          styles.inset
        } ${styles.knob} ${checked ? 'translate-x-6' : 'translate-x-0'}`}
      />
    </button>
  );
}
