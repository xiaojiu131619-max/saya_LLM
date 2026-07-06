import { Terminal } from 'lucide-react';
import LogPanel from '@/components/LogPanel';

export default function LogsPage() {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[#FBFAF6] text-[#2F2C26] dark:bg-[#171512] dark:text-[#F3EBDD]">
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-4xl">
          <div className="mb-6">
            <h1 className="text-2xl font-bold text-primary-custom">运行日志</h1>
            <p className="mt-1 text-sm leading-6 text-secondary-custom">
              查看应用运行事件、错误详情，并按级别筛选或导出排障日志。
            </p>
          </div>

          <section className="glass-panel p-5">
            <div className="mb-4 flex items-center gap-2.5">
              <Terminal className="h-4.5 w-4.5 text-[#5A6CFF]" />
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
