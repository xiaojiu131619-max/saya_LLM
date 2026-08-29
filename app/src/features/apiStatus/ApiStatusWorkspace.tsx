import { motion } from 'framer-motion';
import { ArrowLeft } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import ApiStatusPage from '@/features/apiStatus/ApiStatusPage';

// API 中心只保留状态页本体：使用统计在设置中心，应用日志从界面移除。
export default function ApiStatusWorkspace() {
  const { dispatch } = useApp();

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-[var(--app-bg)] text-[var(--text-primary)] dark:bg-[var(--app-bg)] dark:text-[var(--text-primary)]">
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-shrink-0 items-center border-b border-[var(--border)] bg-[var(--app-bg)] px-4 py-2 dark:border-white/[0.08] dark:bg-[var(--app-bg)]">
          <button
            onClick={() => dispatch({ type: 'SET_VIEW', payload: 'home' })}
            className="flex h-9 items-center gap-2 rounded-md px-2 text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40 dark:text-[var(--text-secondary)] dark:hover:bg-white/[0.08]"
            title="返回模型界面"
          >
            <ArrowLeft className="h-4 w-4" />
            返回
          </button>
        </div>
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          className="min-h-0 flex-1"
        >
          <ApiStatusPage />
        </motion.div>
      </section>
    </div>
  );
}
