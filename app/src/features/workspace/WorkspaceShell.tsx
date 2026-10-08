import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauri } from '@tauri-apps/api/core';
import { Minus, Square, X } from 'lucide-react';
import { lazy, Suspense, type ReactNode } from 'react';
import { useApp } from '@/context/AppContext';
import type { ViewType } from '@/types';
import EnvCheckDialog from './EnvCheckDialog';

// 工作区按需懒加载：首屏只加载默认的模型工作区，
// 聊天页（含 highlight.js 等）与设置页在切换时再下载，缩短首屏可交互时间。
const ChatPage = lazy(() => import('@/pages/ChatPage'));
const SettingsWorkspace = lazy(() => import('@/features/settings/SettingsWorkspace'));
const ModelWorkspace = lazy(() => import('@/features/model/ModelWorkspace'));

type WorkspaceMode = 'model' | 'chat' | 'settings';

function workspaceMode(view: ViewType): WorkspaceMode {
  if (view === 'chat') return 'chat';
  // apiStatus / agent / embedding / fast27b 在模型工作区内嵌展示（与 llama 日志一致，保留侧边栏）。
  if (view === 'apiStatus' || view === 'home' || view === 'modelLoad' || view === 'llamaLogs' || view === 'agent' || view === 'embedding' || view === 'fast27b') return 'model';
  return 'settings';
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
      default:
        return <ModelWorkspace />;
    }
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[var(--app-bg)] text-[var(--text-primary)] dark:bg-[var(--app-bg)] dark:text-[var(--text-primary)]">
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--app-bg)] dark:bg-[var(--app-bg)]">
        <WindowTitleBar />
        <div className="min-h-0 flex-1 overflow-hidden">
          <Suspense fallback={<WorkspaceFallback />}>
            {renderWorkspace()}
          </Suspense>
        </div>
      </main>
      {/* 首次启动环境检测：组件自治（自动检测 + 未通过时弹窗），无需外部状态。 */}
      <EnvCheckDialog onClose={() => {}} />
    </div>
  );
}

function WorkspaceFallback() {
  return (
    <div className="flex h-full w-full items-center justify-center text-sm text-[var(--text-tertiary)] dark:text-[var(--text-tertiary)]">
      加载中…
    </div>
  );
}

function WindowTitleBar() {
  const appWindow = isTauri() ? getCurrentWindow() : null;
  const handleMinimize = () => {
    void appWindow?.minimize();
  };
  const handleToggleMaximize = () => {
    void appWindow?.toggleMaximize();
  };
  const handleClose = () => {
    void appWindow?.close();
  };

  return (
    <header
      data-tauri-drag-region
      onDoubleClick={appWindow ? handleToggleMaximize : undefined}
      className="titlebar flex h-10 flex-shrink-0 items-center pl-4 text-[var(--text-primary)] dark:text-[var(--text-primary)]"
    >
      <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-2">
        <div className="grid h-5 w-5 flex-shrink-0 place-items-center rounded-md bg-[var(--border)] text-[10px] font-semibold text-[var(--accent)] dark:bg-white/[0.07] dark:text-[var(--accent)]">
          晓
        </div>
        <div className="min-w-0 truncate text-xs font-semibold">Agent LLM</div>
      </div>
      {appWindow && <nav className="flex h-full flex-shrink-0 items-stretch">
        <WindowControlButton label="最小化" onClick={handleMinimize}>
          <Minus className="h-3.5 w-3.5" />
        </WindowControlButton>
        <WindowControlButton label="最大化或还原" onClick={handleToggleMaximize}>
          <Square className="h-3 w-3" />
        </WindowControlButton>
        <WindowControlButton label="关闭" tone="danger" onClick={handleClose}>
          <X className="h-4 w-4" />
        </WindowControlButton>
      </nav>}
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
          ? 'text-[var(--text-secondary)] hover:bg-[var(--state-danger)] hover:text-white dark:text-[var(--text-secondary)] dark:hover:bg-[var(--state-danger)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--border)] dark:text-[var(--text-secondary)] dark:hover:bg-white/[0.08]'
      }`}
    >
      {children}
    </button>
  );
}
