import { Terminal } from 'lucide-react';
import LogPanel from '@/components/LogPanel';
import PageHeader from '@/components/PageHeader';

export default function LogsPage() {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--app-bg)] text-[var(--text-primary)] dark:bg-[var(--app-bg)] dark:text-[var(--text-primary)]">
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-4xl">
          <PageHeader
            icon={Terminal}
            title="系统日志"
            description="按时间顺序查看服务生命周期、llama-server 输出、API 请求与应用事件，支持按级别、来源筛选或导出。"
            className="mb-6"
          />

          <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 dark:border-white/[0.08] dark:bg-white/[0.04]">
            <div className="mb-4 flex items-center gap-2.5">
              <Terminal className="h-4.5 w-4.5 text-[var(--accent)]" />
              <h2 className="text-[15px] font-semibold text-primary-custom">日志列表</h2>
            </div>
            <div className="h-[min(640px,calc(100vh-240px))] min-h-[360px] overflow-hidden">
              <LogPanel />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
