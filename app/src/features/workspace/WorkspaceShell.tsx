import { getCurrentWindow } from '@tauri-apps/api/window';
import { Minus, Square, X } from 'lucide-react';
import { lazy, Suspense, type ReactNode } from 'react';
import { useApp } from '@/context/AppContext';
import type { ViewType } from '@/types';

// 工作区按需懒加载：首屏只加载默认的模型工作区，
// 聊天页（含 highlight.js 等）与设置页在切换时再下载，缩短首屏可交互时间。
const ChatPage = lazy(() => import('@/pages/ChatPage'));
const SettingsWorkspace = lazy(() => import('@/features/settings/SettingsWorkspace'));
const ModelWorkspace = lazy(() => import('@/features/model/ModelWorkspace'));
const ImageWorkspace = lazy(() => import('@/features/image/ImageWorkspace'));

type WorkspaceMode = 'model' | 'chat' | 'settings' | 'image';

function workspaceMode(view: ViewType): WorkspaceMode {
  if (view === 'chat') return 'chat';
  if (view === 'image') return 'image';
  if (view === 'settings' || view === 'tools' || view === 'usage') return 'settings';
  return 'model';
}

export default function WorkspaceShell() {
  const { state } = useApp();
  const activeMode = workspaceMode(state.currentView);

  const renderWorkspace = () => {
    switch (activeMode) {
      case 'chat':
        return <ChatPage />;
      case 'settings':
        return <SettingsWorkspace />;
      case 'image':
        return <ImageWorkspace />;
      default:
        return <ModelWorkspace />;
    }
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#FBFAF6] text-[#2F2C26] dark:bg-[#0F0E0C] dark:text-[#F3EBDD]">
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-[#FBFAF6] dark:bg-[#0F0E0C]">
        <WindowTitleBar />
        <div className="min-h-0 flex-1 overflow-hidden p-2 pt-0">
          <Suspense fallback={<WorkspaceFallback />}>
            {renderWorkspace()}
          </Suspense>
        </div>
      </main>
    </div>
  );
}

function WorkspaceFallback() {
  return (
    <div className="flex h-full w-full items-center justify-center text-sm text-[#9A9082] dark:text-[#7A7264]">
      加载中…
    </div>
  );
}

function WindowTitleBar() {
  const appWindow = getCurrentWindow();
  const handleMinimize = () => {
    void appWindow.minimize();
  };
  const handleToggleMaximize = () => {
    void appWindow.toggleMaximize();
  };
  const handleClose = () => {
    void appWindow.close();
  };

  return (
    <header
      data-tauri-drag-region
      onDoubleClick={handleToggleMaximize}
      className="flex h-10 flex-shrink-0 items-center border-b border-[#D8D2C5] bg-[#F8F6F1]/95 pl-4 text-[#2F2C26] dark:border-white/[0.08] dark:bg-[#15130F]/95 dark:text-[#F3EBDD]"
    >
      <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-2">
        <div className="grid h-5 w-5 flex-shrink-0 place-items-center rounded-md bg-[#E8E3D8] text-[10px] font-semibold text-[#D7663E] dark:bg-white/[0.07] dark:text-[#F0B18D]">
          晓
        </div>
        <div className="min-w-0 truncate text-xs font-semibold">Agent LLM</div>
      </div>
      <nav className="flex h-full flex-shrink-0 items-stretch">
        <WindowControlButton label="最小化" onClick={handleMinimize}>
          <Minus className="h-3.5 w-3.5" />
        </WindowControlButton>
        <WindowControlButton label="最大化或还原" onClick={handleToggleMaximize}>
          <Square className="h-3 w-3" />
        </WindowControlButton>
        <WindowControlButton label="关闭" tone="danger" onClick={handleClose}>
          <X className="h-4 w-4" />
        </WindowControlButton>
      </nav>
    </header>
  );
}

function WindowControlButton({ label, tone = 'neutral', onClick, children }: {
  label: string;
  tone?: 'neutral' | 'danger';
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`grid w-11 place-items-center transition-colors ${
        tone === 'danger'
          ? 'text-[#625B50] hover:bg-[#C44E36] hover:text-white dark:text-[#D8D0C3] dark:hover:bg-[#C44E36]'
          : 'text-[#625B50] hover:bg-[#E8E3D8] dark:text-[#D8D0C3] dark:hover:bg-white/[0.08]'
      }`}
    >
      {children}
    </button>
  );
}
