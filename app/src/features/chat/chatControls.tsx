/** 聊天页共用的小控件：图标按钮与数字滑杆设置行。 */

export function IconButton({ icon: Icon, label, onClick, disabled, tone = 'neutral' }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'neutral' | 'danger';
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex h-9 w-9 items-center justify-center rounded-[var(--radius-field)] transition-colors disabled:opacity-35 ${
        tone === 'danger'
          ? 'text-[var(--state-danger)] hover:bg-[var(--state-danger-border)] dark:text-[var(--state-danger)] dark:hover:bg-[var(--surface-raised)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] dark:text-[var(--text-secondary)] dark:hover:bg-white/[0.08]'
      }`}
      title={label}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

export function InputToolButton({ icon: Icon, label, onClick, disabled }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-[var(--text-primary)] transition-colors hover:bg-black/[0.055] disabled:opacity-40 dark:text-[var(--text-secondary)] dark:hover:bg-[var(--surface-raised)]"
      title={label}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

export function ChatNumberSetting({ label, description, value, min, max, step, onChange }: {
  label: string;
  description?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  const safeValue = Math.min(max, Math.max(min, value));
  const percent = max === min ? 0 : ((safeValue - min) / (max - min)) * 100;
  return (
    <div className="border-b border-black/[0.06] py-4 last:border-b-0 dark:border-white/[0.06]">
      <div className="mb-3 flex items-center justify-between gap-3">
        <label className="text-[length:var(--font-body)] font-medium text-[var(--text-primary)]">{label}</label>
        <input
          type="number"
          value={safeValue}
          min={min}
          max={max}
          step={step}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next)));
          }}
          className="mono-font w-24 rounded-[var(--radius-field)] border border-[var(--border)] bg-[var(--app-bg)] px-2 py-1 text-right text-[length:var(--font-body)] text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)] dark:border-white/[0.08]"
        />
      </div>
      {description && (
        <p className="mb-3 text-[length:var(--font-caption)] leading-5 text-[var(--text-secondary)]">{description}</p>
      )}
      <input
        type="range"
        value={safeValue}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full accent-[var(--accent)] transition-[background] duration-200"
        style={{
          background: `linear-gradient(to right, var(--accent) ${percent}%, rgba(120,110,95,0.18) ${percent}%)`,
        }}
      />
    </div>
  );
}
