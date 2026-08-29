import { Component, useEffect, type ErrorInfo, type ReactNode } from 'react';
import { AppProvider, useApp } from '@/context/AppContext';
import WorkspaceShell from '@/features/workspace/WorkspaceShell';
import LlamaNativePreviewPage from '@/pages/LlamaNativePreviewPage';

function AppContent() {
  const { state } = useApp();
  const showLlamaNativePreview = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('preview') === 'llama-native';

  useEffect(() => {
    document.documentElement.classList.toggle('dark', state.theme === 'dark');
  }, [state.theme]);

  return showLlamaNativePreview ? <LlamaNativePreviewPage /> : <WorkspaceShell />;
}

class AppErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('界面渲染失败', error, info);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[var(--app-bg)] p-6 text-[var(--text-primary)] dark:bg-[var(--app-bg)] dark:text-[var(--text-primary)]">
        <div className="w-full max-w-md border-b border-[var(--border-subtle)] py-5 text-center">
          <h1 className="text-lg font-semibold">界面加载失败</h1>
          <p className="mt-2 text-sm text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">请重新加载界面；若问题持续，请查看服务日志。</p>
          <button type="button" onClick={() => window.location.reload()} className="mt-4 h-10 rounded-md bg-[var(--accent)] px-4 text-sm font-semibold text-white hover:bg-[var(--accent-hover)]">
            重新加载
          </button>
        </div>
      </div>
    );
  }
}

export default function App() {
  return (
    <AppProvider>
      <AppErrorBoundary>
        <AppContent />
      </AppErrorBoundary>
    </AppProvider>
  );
}
