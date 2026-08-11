import { motion } from 'framer-motion';
import { Activity, ArrowLeft, BarChart3, Terminal } from 'lucide-react';
import { useState, type ComponentType } from 'react';
import { useApp } from '@/context/AppContext';
import UsagePage from '@/pages/UsagePage';
import LogsPage from '@/pages/LogsPage';
import ApiStatusPage from '@/features/apiStatus/ApiStatusPage';

type ApiStatusTab = 'status' | 'usage' | 'logs';

const apiTabs: Array<{ id: ApiStatusTab; label: string; icon: ComponentType<{ className?: string }> }> = [
  { id: 'status', label: 'API 状态', icon: Activity },
  { id: 'usage', label: '使用详情', icon: BarChart3 },
  { id: 'logs', label: '应用日志', icon: Terminal },
];

export default function ApiStatusWorkspace() {
  const { dispatch } = useApp();
  const [activeTab, setActiveTab] = useState<ApiStatusTab>('status');

  const renderPanel = () => {
    switch (activeTab) {
      case 'usage':
        return <UsagePage />;
      case 'logs':
        return <LogsPage />;
      default:
        return <ApiStatusPage />;
    }
  };

  return (
    <div className="paper-surface flex h-full min-h-0 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--app-bg)] text-[var(--text-primary)] shadow-sm dark:border-white/[0.08] dark:bg-[var(--app-bg)] dark:text-[var(--text-primary)]">
      <aside className="hidden w-60 flex-shrink-0 border-r border-[var(--border)] bg-[var(--surface-muted)] p-3 dark:border-white/[0.08] dark:bg-[var(--app-bg)] md:block">
        <div className="px-2 py-3">
          <button
            onClick={() => dispatch({ type: 'SET_VIEW', payload: 'home' })}
            className="mb-4 flex h-9 w-9 items-center justify-center rounded-md text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40 dark:text-[var(--text-secondary)] dark:hover:bg-white/[0.08]"
            title="返回模型界面"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="text-base font-semibold">API 中心</div>
          <div className="mt-1 text-xs text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">状态检测、用量与服务日志</div>
        </div>
        <nav className="mt-3 space-y-1">
          {apiTabs.map((tab) => {
            const Icon = tab.icon;
            const selected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/35 ${
                  selected ? 'bg-[var(--border)] text-[var(--accent)] dark:bg-white/[0.08]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] dark:text-[var(--text-secondary)] dark:hover:bg-white/[0.06]'
                }`}
              >
                <Icon className="h-4 w-4 flex-shrink-0" />
                <span className="truncate">{tab.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-shrink-0 items-center gap-2 overflow-x-auto border-b border-[var(--border)] bg-[var(--app-bg)] px-4 py-3 dark:border-white/[0.08] dark:bg-[var(--app-bg)] md:hidden">
          {apiTabs.map((tab) => {
            const selected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`rounded-full px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/35 ${
                  selected ? 'bg-[var(--border)] text-[var(--accent)]' : 'text-[var(--text-secondary)] dark:text-[var(--text-secondary)]'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          className="min-h-0 flex-1"
        >
          {renderPanel()}
        </motion.div>
      </section>
    </div>
  );
}
