import { Check, Puzzle, X } from 'lucide-react';
import ToggleSwitch from '@/components/ToggleSwitch';

export interface EngineResourceCheck {
  /** 资源名称（如「引擎程序」）。 */
  label: string;
  /** 配置的绝对路径。 */
  path: string;
  /** 文件是否存在（后端就绪检测）。 */
  exists: boolean;
  /** false = 可选资源（如视觉投影器），缺失不算「未获取」。 */
  required: boolean;
  /** 缺失时的处理提示。 */
  missingHint?: string;
}

interface EngineCardProps {
  /** 引擎名称（如「fast-27b」）。 */
  title: string;
  /** 一句话说明。 */
  subtitle: string;
  /** 是否启用该引擎（停用后禁止启动，标签显示停用态）。 */
  enabled: boolean;
  /** 引擎是否正在运行。 */
  running: boolean;
  /** 启用/停用切换（由页面负责落盘保存配置）。 */
  onToggleEnabled: (next: boolean) => void | Promise<void>;
  /** 资源就绪检测列表。 */
  checks: EngineResourceCheck[];
}

type EngineState = 'disabled' | 'running' | 'ready' | 'missing';

export default function EngineCard({
  title,
  subtitle,
  enabled,
  running,
  onToggleEnabled,
  checks,
}: EngineCardProps) {
  const missing = checks.filter((item) => item.required && !item.exists);

  const state: EngineState = !enabled
    ? 'disabled'
    : running
      ? 'running'
      : missing.length === 0
        ? 'ready'
        : 'missing';

  const statePill = (() => {
    switch (state) {
      case 'disabled':
        return (
          <span className="rounded-full border border-[var(--border)] bg-[var(--surface-muted)] px-2 py-0.5 text-xs text-secondary-custom">
            已停用
          </span>
        );
      case 'running':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--state-success-border)] bg-[var(--state-success-bg)] px-2 py-0.5 text-xs text-[var(--state-success)]">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--state-success)] opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--state-success)]" />
            </span>
            运行中
          </span>
        );
      case 'ready':
        return (
          <span className="inline-flex items-center gap-1 rounded-full border border-[var(--state-success-border)] bg-[var(--state-success-bg)] px-2 py-0.5 text-xs text-[var(--state-success)]">
            <Check className="h-3 w-3" /> 已就绪 · 待启动
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 rounded-full border border-[var(--state-danger-border)] bg-[var(--state-danger-bg)] px-2 py-0.5 text-xs text-[var(--state-danger)]">
            <X className="h-3 w-3" /> 资源缺失（缺 {missing.map((item) => item.label).join('、')}）
          </span>
        );
    }
  })();

  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5">
            <Puzzle className="h-4 w-4 flex-shrink-0 text-[var(--accent)]" />
            <h2 className="text-sm font-semibold text-primary-custom">{title}</h2>
          </div>
          {statePill}
        </div>
        <ToggleSwitch checked={enabled} onChange={(checked) => void onToggleEnabled(checked)} label="启用此引擎" />
      </div>
      <p className="text-xs leading-6 text-secondary-custom">{subtitle}</p>

      {/* 资源就绪检测：按当前保存的配置路径核对引擎/模型文件 */}
      <ul className="mt-3 space-y-2">
        {checks.map((item) => (
          <li key={item.label} className="flex items-start gap-2 text-xs">
            {item.exists ? (
              <Check className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-[var(--state-success)]" />
            ) : (
              <X
                className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 ${
                  item.required ? 'text-[var(--state-danger)]' : 'text-[var(--text-tertiary)]'
                }`}
              />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium text-primary-custom">{item.label}</span>
                {!item.required && <span className="text-[10px] text-secondary-custom">可选</span>}
                {item.required && !item.exists && (
                  <span className="text-[10px] text-[var(--state-danger)]">缺失</span>
                )}
              </div>
              <p className="mono-font truncate leading-5 text-secondary-custom" title={item.path}>
                {item.path || '（未配置路径）'}
              </p>
              {item.required && !item.exists && item.missingHint && (
                <p className="leading-5 text-[var(--state-warning)]">{item.missingHint}</p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
