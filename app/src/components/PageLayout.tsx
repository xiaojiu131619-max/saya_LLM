import type { ReactNode } from 'react';

interface PageLayoutProps {
  header: ReactNode;
  children: ReactNode;
  width?: 'list' | 'form';
}

/** 统一控制台页头与正文宽度，正文独立滚动。 */
export default function PageLayout({ header, children, width = 'list' }: PageLayoutProps) {
  const contentWidth = width === 'form' ? 'max-w-[960px]' : 'max-w-[1180px] min-[1600px]:max-w-[1520px]';
  return (
    <div className="page-layout flex h-full min-h-0 flex-col bg-[var(--app-bg)]">
      <header className="page-band flex-shrink-0 border-b border-[var(--border-subtle)] py-5">
        <div className={`mx-auto ${contentWidth}`}>{header}</div>
      </header>
      <div className="page-band min-h-0 flex-1 overflow-y-auto">
        <div className={`mx-auto ${contentWidth}`}>{children}</div>
      </div>
    </div>
  );
}
