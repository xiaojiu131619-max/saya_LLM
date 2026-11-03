import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { Bot, Minus, Square, X } from 'lucide-react';
import { lazy, Suspense, type ReactNode } from 'react';
import { useApp } from '@/context/AppContext';
import BrandLogo from '@/components/BrandLogo';
import EnvCheckDialog from './EnvCheckDialog';
import { useAutoChatEngine } from '@/hooks/useAutoChatEngine';

/** 应用显示名（只改界面标题，仓库与 productName 不动）。 */
export const APP_DISPLAY_NAME = '拾壹';
/** 标题栏字标的首字（窗口小图标与侧边栏占位共用）。 */
export const APP_BRAND_MARK = '拾';

// 工作区按需懒加载：首屏只加载默认的模型工作区，
// 聊天页（含 highlight.js 等）与设置页在切换时再下载，缩短首屏可交互时间。
const ChatPage = lazy(() => import('@/pages/ChatPage'));
const SettingsWorkspace = lazy(() => import('@/features/settings/SettingsWorkspace'));
const ModelWorkspace = lazy(() => import('@/features/model/ModelWorkspace'));

export default function WorkspaceShell() {
  const { state } = useApp();
  // 对话后端全局自动选择：放在外壳层，切页面时不会重置，也不会因对话页卸载而停摆。
  useAutoChatEngine();

  // 三棵界面树各自独立：
  //   agent    Agent 工作区——模型 / 引擎 / 智能体的操作区
  //   chat     对话界面——自己的侧边栏与对话记忆区
  //   settings 设置中心
  // 换界面换的是整棵树，不是同一棵树里的某一页——两个界面因此不会再
  // 长得像同一页的两态。
  const renderWorkspace = () => {
    switch (state.workspace) {
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
      className="titlebar flex h-10 flex-shrink-0 items-center pl-3 text-[var(--text-primary)] dark:text-[var(--text-primary)]"
    >
      <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-2">
        {/* 品牌标识放在标题栏：拾壹字标 + 名称，替代原来的「晓 / Agent LLM」。 */}
        <BrandLogo size={18} variant="lockup" />
      </div>
      {appWindow && <nav className="flex h-full flex-shrink-0 items-stretch">
        <WindowControlButton
          label="Pi 浮窗"
          onClick={() => {
            void invoke('pi_float_window').catch(() => undefined);
          }}
        >
          <Bot className="h-3.5 w-3.5" />
        </WindowControlButton>
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
