import { motion } from 'framer-motion';
import { ArrowLeft, BarChart3, Settings, Wrench } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import type { ViewType } from '@/types';
import SettingsPage from '@/pages/SettingsPage';
import ToolsPage from '@/pages/ToolsPage';
import UsagePage from '@/pages/UsagePage';

const settingsTabs: Array<{ id: ViewType; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'settings', label: '设置', icon: Settings },
  { id: 'tools', label: '工具', icon: Wrench },
  { id: 'usage', label: '使用详情', icon: BarChart3 },
];

export default function SettingsWorkspace() {
  const { state, dispatch } = useApp();
  const activeView = state.currentView === 'tools' || state.currentView === 'usage' ? state.currentView : 'settings';
  const returnToModel = () => {
    const storedView = typeof window !== 'undefined'
      ? window.sessionStorage.getItem('agent-llm-settings-return-view')
      : null;
    const targetView = storedView === 'modelLoad' || storedView === 'home' || storedView === 'chat' || storedView === 'image' ? storedView : 'home';
    if (typeof window !== 'undefined') {
      window.sessionStorage.removeItem('agent-llm-settings-return-view');
    }
    dispatch({ type: 'SET_VIEW', payload: targetView });
  };

  const renderPanel = () => {
    switch (activeView) {
      case 'usage':
        return <UsagePage />;
      case 'tools':
        return <ToolsPage />;
      default:
        return <SettingsPage />;
    }
  };

  return (
    <div className="paper-surface flex h-full min-h-0 overflow-hidden rounded-2xl border border-[#E2DFD6] bg-[#FBFAF6] text-[#403C32] shadow-sm dark:border-white/[0.08] dark:bg-[#11100E] dark:text-[#F3EBDD]">
      <aside className="hidden w-56 flex-shrink-0 border-r border-[#E2DFD6] bg-[#F1EFE8] p-3 dark:border-white/[0.08] dark:bg-[#15130F] md:block">
        <div className="px-2 py-3">
          <button
            onClick={returnToModel}
            className="mb-4 flex h-9 w-9 items-center justify-center rounded-md text-[#4E4941] transition-colors hover:bg-[#E9E5DA]"
            title="返回加载模型"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="text-base font-semibold">设置中心</div>
          <div className="mt-1 text-xs text-[#8C8576]">辅助功能和系统能力</div>
        </div>
        <nav className="mt-3 space-y-1">
          {settingsTabs.map((tab) => {
            const Icon = tab.icon;
            const selected = activeView === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => dispatch({ type: 'SET_VIEW', payload: tab.id })}
                className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors ${
                  selected ? 'bg-[#E4E0D6] text-[#D7663E]' : 'text-[#625B50] hover:bg-[#E9E5DA]'
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
          {settingsTabs.map((tab) => {
            const selected = activeView === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => dispatch({ type: 'SET_VIEW', payload: tab.id })}
                className={`rounded-full px-3 py-1.5 text-xs ${
                  selected ? 'bg-[#E4E0D6] text-[#D7663E]' : 'text-[#625B50]'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
        <motion.div
          key={activeView}
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
