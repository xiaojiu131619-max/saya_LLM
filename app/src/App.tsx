import { useEffect } from 'react';
import { AppProvider, useApp } from '@/context/AppContext';
import WorkspaceShell from '@/features/workspace/WorkspaceShell';

function AppContent() {
  const { state } = useApp();

  useEffect(() => {
    document.documentElement.classList.toggle('dark', state.theme === 'dark');
  }, [state.theme]);

  return <WorkspaceShell />;
}

export default function App() {
  return (
    <AppProvider>
      <AppContent />
    </AppProvider>
  );
}
