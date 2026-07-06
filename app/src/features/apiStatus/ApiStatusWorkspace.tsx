import { motion } from 'framer-motion';
import { Activity, ArrowLeft, BarChart3, Globe2 } from 'lucide-react';
import { useState, type ComponentType } from 'react';
import { useApp } from '@/context/AppContext';
import UsagePage from '@/pages/UsagePage';
import ApiStatusPage from '@/features/apiStatus/ApiStatusPage';
import ExternalApiSection from '@/features/apiStatus/ExternalApiSection';

type ApiStatusTab = 'status' | 'externalApi' | 'usage';

const apiTabs: Array<{ id: ApiStatusTab; label: string; icon: ComponentType<{ className?: string }> }> = [
  { id: 'status', label: 'API 状态', icon: Activity },
  { id: 'externalApi', label: '对外 API', icon: Globe2 },
  { id: 'usage', label: '使用详情', icon: BarChart3 },
];

export default function ApiStatusWorkspace() {
  const { dispatch } = useApp();
  const [activeTab, setActiveTab] = useState<ApiStatusTab>('status');

  const renderPanel = () => {
    switch (activeTab) {
      case 'externalApi':
        return <ExternalApiSection />;
      case 'usage':
        return <UsagePage />;
      default:
        return <ApiStatusPage />;
    }
  };

  return (
    <div className="paper-surface flex h-full min-h-0 overflow-hidden rounded-2xl border border-[#E2DFD6] bg-[#FBFAF6] text-[#403C32] shadow-sm dark:border-white/[0.08] dark:bg-[#11100E] dark:text-[#F3EBDD]">
      <aside className="hidden w-56 flex-shrink-0 border-r border-[#E2DFD6] bg-[#F1EFE8] p-3 dark:border-white/[0.08] dark:bg-[#15130F] md:block">
        <div className="px-2 py-3">
          <button
            onClick={() => dispatch({ type: 'SET_VIEW', payload: 'home' })}
            className="mb-4 flex h-9 w-9 items-center justify-center rounded-md text-[#4E4941] transition-colors hover:bg-[#E9E5DA] focus:outline-none focus:ring-2 focus:ring-[#D7663E]/40 dark:text-[#D8D0C3] dark:hover:bg-white/[0.08]"
            title="返回模型界面"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="text-base font-semibold">API 中心</div>
          <div className="mt-1 text-xs text-[#8C8576] dark:text-[#A9A095]">状态检测、对外接口与用量</div>
        </div>
        <nav className="mt-3 space-y-1">
          {apiTabs.map((tab) => {
            const Icon = tab.icon;
            const selected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-[#D7663E]/35 ${
                  selected ? 'bg-[#E4E0D6] text-[#D7663E] dark:bg-white/[0.08]' : 'text-[#625B50] hover:bg-[#E9E5DA] dark:text-[#CFC6B8] dark:hover:bg-white/[0.06]'
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
        <div className="flex flex-shrink-0 items-center gap-2 overflow-x-auto border-b border-[#E2DFD6] bg-[#FBFAF6] px-4 py-3 dark:border-white/[0.08] dark:bg-[#171512] md:hidden">
          {apiTabs.map((tab) => {
            const selected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`rounded-full px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[#D7663E]/35 ${
                  selected ? 'bg-[#E4E0D6] text-[#D7663E]' : 'text-[#625B50] dark:text-[#CFC6B8]'
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
