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
      <div className="flex h-screen w-screen items-center justify-center bg-[#FBFAF6] p-6 text-[#2F2C26] dark:bg-[#0D0F14] dark:text-[#E2E8F2]">
        <div className="w-full max-w-md rounded-lg border border-[#DCD8CF] bg-[#FAF9F5] p-5 text-center dark:border-white/[0.1] dark:bg-[#1A1E28]">
          <h1 className="text-lg font-semibold">界面加载失败</h1>
          <p className="mt-2 text-sm text-[#716A5E] dark:text-[#8E99AD]">请重新加载界面；若问题持续，请查看服务日志。</p>
          <button type="button" onClick={() => window.location.reload()} className="mt-4 h-10 rounded-md bg-[#D7663E] px-4 text-sm font-semibold text-white hover:bg-[#C45732]">
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
