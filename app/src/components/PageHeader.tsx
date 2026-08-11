import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

interface PageHeaderProps {
  icon: LucideIcon;
  title: string;
  description: string;
  actions?: ReactNode;
  className?: string;
}

export default function PageHeader({ icon: Icon, title, description, actions, className = '' }: PageHeaderProps) {
  return (
    <div className={`flex min-w-0 items-center gap-3 ${className}`}>
      <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--accent)] shadow-[0_1px_0_rgba(255,255,255,0.65)] dark:border-white/[0.08] dark:bg-white/[0.04] dark:shadow-none">
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-xl font-bold leading-tight text-primary-custom">{title}</h1>
        <p className="mt-0.5 text-xs leading-5 text-secondary-custom">{description}</p>
      </div>
      {actions && <div className="flex flex-shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
