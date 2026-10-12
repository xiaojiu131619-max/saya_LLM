import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

interface PageHeaderProps {
  icon?: LucideIcon;
  eyebrow?: string;
  title: string;
  description: string;
  actions?: ReactNode;
  className?: string;
}

export default function PageHeader({ icon: Icon, eyebrow, title, description, actions, className = '' }: PageHeaderProps) {
  return (
    <div className={`workspace-page-header flex min-w-0 items-center gap-3 ${className}`}>
      <div className="min-w-0 flex-1">
        <div className="eyebrow mb-2 flex items-center gap-2">
          {Icon && <Icon className="h-3.5 w-3.5" />}
          {eyebrow ?? '工作台 / ' + title}
        </div>
        <h1 className="page-title">{title}</h1>
        <p className="mt-0.5 text-xs leading-5 text-secondary-custom">{description}</p>
      </div>
      {actions && <div className="flex flex-shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
