import { ArrowLeft, Database, Image as ImageIcon, MessageSquare, Settings, WandSparkles } from 'lucide-react';
import ThemeToggleButton from '@/components/ThemeToggleButton';
import { useApp } from '@/context/AppContext';
import ImagePage from '@/pages/ImagePage';

/**
 * 生图工作台：与「模型工作区」「对话工作区」并列的一级工作台。
 * 侧栏提供返回模型管理、跳转对话、进入设置中心等入口；主面板渲染 ImagePage。
 */
export default function ImageWorkspace() {
  const { state, dispatch } = useApp();

  const openSettings = () => {
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem('agent-llm-settings-return-view', state.currentView);
    }
    dispatch({ type: 'SET_VIEW', payload: 'settings' });
  };

  return (
    <div className="paper-surface relative flex h-full min-h-0 overflow-hidden rounded-md border border-[#DCD8CF] bg-[#FBFAF6] text-[#2F2C26] shadow-sm dark:border-white/[0.08] dark:bg-[#11100E] dark:text-[#F3EBDD]">
      <aside className="hidden w-64 flex-shrink-0 flex-col border-r border-[#E3DFD6] bg-[#F2F0EA] p-2 dark:border-white/[0.08] dark:bg-[#15130F] md:flex">
        <div className="px-4 pb-4 pt-3">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[#FFF2EA] text-[#D7663E] dark:bg-[#3A241C]/80 dark:text-[#F0B18D]">
              <WandSparkles className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="truncate text-base font-semibold">生图工作台</div>
              <div className="truncate text-xs text-[#8D867A]">连接图像供应商生成与编辑</div>
            </div>
          </div>
        </div>

        <nav className="space-y-1 px-1">
          <button
            onClick={() => dispatch({ type: 'SET_VIEW', payload: 'image' })}
            className="flex w-full items-center gap-2 rounded-md bg-[#E6E2D8] px-3 py-2 text-sm text-[#2F2C26] dark:bg-white/[0.07] dark:text-[#F3EBDD]"
          >
            <ImageIcon className="h-4 w-4 flex-shrink-0" />
            <span className="truncate">生图工作区</span>
          </button>
          <button
            onClick={() => dispatch({ type: 'SET_VIEW', payload: 'home' })}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-[#4E4941] transition-colors hover:bg-[#EAE6DD]"
          >
            <Database className="h-4 w-4 flex-shrink-0" />
            <span className="truncate">模型列表</span>
          </button>
          <button
            onClick={() => dispatch({ type: 'SET_VIEW', payload: 'chat' })}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-[#4E4941] transition-colors hover:bg-[#EAE6DD]"
          >
            <MessageSquare className="h-4 w-4 flex-shrink-0" />
            <span className="truncate">对话工作台</span>
          </button>
        </nav>

        <div className="mx-2 mb-3 mt-auto space-y-2">
          <div className="rounded-md border border-[#DCD8CF] bg-[#FAF9F5] px-3 py-2 dark:border-white/[0.08] dark:bg-white/[0.05]">
            <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-[#2F2C26] dark:text-[#F3EBDD]">
              <WandSparkles className="h-3.5 w-3.5 text-[#D06646]" />
              提示
            </div>
            <div className="text-[11px] leading-relaxed text-[#8D867A] dark:text-[#A9A095]">
              切换右上角供应商后，需先保存对应的 API Key，再开始生成图像。
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggleButton theme={state.theme} onClick={() => dispatch({ type: 'TOGGLE_THEME' })} />
            <button
              onClick={openSettings}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-[#DCD8CF] bg-[#FAF9F5] px-3 py-2 text-sm text-[#4E4941] transition-colors hover:bg-[#EAE6DD] dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[#D8D0C3] dark:hover:bg-white/[0.09]"
              title="打开设置"
            >
              <Settings className="h-4 w-4 flex-shrink-0" />
              <span className="truncate">设置</span>
            </button>
          </div>
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col bg-[#FBFAF6] dark:bg-[#171512]">
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-[#E3DFD6] bg-[#FBFAF6] px-4 py-3 dark:border-white/[0.08] dark:bg-[#171512] md:hidden">
          <button
            onClick={() => dispatch({ type: 'SET_VIEW', payload: 'home' })}
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md border border-[#DCD8CF] bg-[#FAF9F5] text-[#4E4941]"
            title="返回模型管理"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">生图工作台</div>
            <div className="truncate text-xs text-[#8D867A]">图像生成与编辑</div>
          </div>
          <div className="ml-auto">
            <ThemeToggleButton theme={state.theme} onClick={() => dispatch({ type: 'TOGGLE_THEME' })} />
          </div>
        </div>

        <div className="anim-fade-rise min-h-0 flex-1 overflow-hidden">
          <ImagePage />
        </div>
      </section>
    </div>
  );
}
