import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Database,
  FilePlus2,
  Gauge,
  HardDrive,
  MemoryStick,
  MessageSquare,
  Power,
  Server,
  Settings,
  Terminal,
  Wifi,
  WifiOff,
} from 'lucide-react';
import ThemeToggleButton from '@/components/ThemeToggleButton';
import { useApp } from '@/context/AppContext';
import { useSystemStats } from '@/hooks/useSystemStats';
import HomePage from '@/pages/HomePage';
import LlamaLogsPage from '@/pages/LlamaLogsPage';
import ModelLoadPage from '@/pages/ModelLoadPage';
import {
  addDesktopModelDir,
  getDesktopServerStatus,
  getDesktopServerLogs,
  isDesktopRuntime,
  listenDesktopFileDrops,
  loadDesktopModelFromPath,
  scanDesktopModels,
  stopDesktopServer,
  toFrontendModel,
} from '@/lib/desktop';
import type { ChatSession, MessageStats, ModelInfo } from '@/types';
import { CHAT_HISTORY_MODEL_ID, latestRuntimeStatsFromServerLogs } from '@/features/chat/chatUtils';

function isGgufPath(path: string) {
  return path.toLowerCase().endsWith('.gguf');
}

function parentDirectory(path: string) {
  const slash = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return slash > 0 ? path.slice(0, slash) : '';
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function latestStatsForSessions(sessions?: ChatSession[]) {
  let latest: MessageStats | undefined;
  let latestAt = 0;
  for (const session of sessions ?? []) {
    for (const message of session.messages) {
      if (message.stats && message.timestamp >= latestAt) {
        latest = message.stats;
        latestAt = message.timestamp;
      }
    }
  }
  return latest;
}

function averageTokensPerSec(usage?: { responseCount: number; totalTokensPerSec: number }) {
  if (!usage || usage.responseCount <= 0 || usage.totalTokensPerSec <= 0) return undefined;
  return usage.totalTokensPerSec / usage.responseCount;
}

function formatTokensPerSec(value?: number) {
  return value && value > 0 ? `${value.toFixed(value >= 10 ? 1 : 2)} tok/s` : '--';
}

function formatCtxUsage(stats: MessageStats | undefined, model: ModelInfo | undefined) {
  const used = stats?.ctxUsed ?? 0;
  const total = stats?.ctxTotal || model?.loadConfig.ctxLength || model?.ctxLength || 0;
  if (!total) return '--';
  return `${used.toLocaleString()} / ${total.toLocaleString()}`;
}

function ctxPercentValue(stats: MessageStats | undefined, model: ModelInfo | undefined): number | undefined {
  const used = stats?.ctxUsed ?? 0;
  const total = stats?.ctxTotal || model?.loadConfig.ctxLength || model?.ctxLength || 0;
  if (!Number.isFinite(used) || !Number.isFinite(total) || used <= 0 || total <= 0) return undefined;
  return Math.min(100, Math.max(0, (used / total) * 100));
}

function formatGbPair(used: number, total: number) {
  if (!total || total <= 0) return '--';
  const usedText = used >= 10 ? used.toFixed(1) : used.toFixed(2);
  const totalText = total >= 10 ? total.toFixed(0) : total.toFixed(1);
  return `${usedText} / ${totalText} GB`;
}

export default function ModelWorkspace() {
  const { state, dispatch } = useApp();
  // 触发 systemStats 每秒轮询，便于服务状态卡显示实时显存/内存占用。
  const systemStats = useSystemStats();
  const [dropActive, setDropActive] = useState(false);
  const [dropBusy, setDropBusy] = useState(false);
  const [apiRuntimeStats, setApiRuntimeStats] = useState<MessageStats | undefined>();
  const detailOpen = state.currentView === 'modelLoad';
  const llamaLogsOpen = state.currentView === 'llamaLogs';
  const selectedModel = state.models.find((model) => model.id === state.selectedModelId);
  const loadedModel = state.models.find((model) => model.status === 'loaded')
    ?? state.models.find((model) => model.id === state.activeModelId);
  const loadedUsage = loadedModel ? state.usageByModel[loadedModel.id] : undefined;
  const loadedStats = apiRuntimeStats ?? latestStatsForSessions(state.chatSessions[CHAT_HISTORY_MODEL_ID]);
  const tokensPerSec = loadedStats?.tokensPerSec
    ?? loadedModel?.avgTokensPerSec
    ?? averageTokensPerSec(loadedUsage);
  const linkState = state.serverRunning && loadedModel ? '已连接' : state.serverRunning ? '服务在线' : '未连接';
  const handleStopServer = async () => {
    try {
      await stopDesktopServer();
      dispatch({ type: 'SET_SERVER_RUNNING', payload: false });
      if (loadedModel) {
        dispatch({ type: 'UPDATE_MODEL_STATUS', payload: { modelId: loadedModel.id, status: 'standby' } });
      }
      dispatch({ type: 'SET_APP_STATUS', payload: '模型服务已停止。' });
    } catch (error) {
      dispatch({ type: 'SET_APP_STATUS', payload: `停止模型服务失败：${String(error)}` });
    }
  };
  const openSettings = () => {
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem('agent-llm-settings-return-view', state.currentView);
    }
    dispatch({ type: 'SET_VIEW', payload: 'settings' });
  };

  const addDroppedModels = useCallback(async (paths: string[]) => {
    if (!isDesktopRuntime()) {
      dispatch({ type: 'SET_APP_STATUS', payload: '请在桌面版中拖拽 GGUF 文件。' });
      return;
    }

    const ggufPaths = paths.filter(isGgufPath);
    if (ggufPaths.length === 0) {
      dispatch({ type: 'SET_APP_STATUS', payload: '请拖拽 .gguf 模型文件到模型加载界面。' });
      return;
    }

    setDropBusy(true);
    dispatch({ type: 'SET_APP_STATUS', payload: '正在添加拖拽的 GGUF 模型...' });

    try {
      let latestDirs = state.modelDirs;
      const dirs = Array.from(new Set(ggufPaths.map(parentDirectory).filter(Boolean)));
      for (const dir of dirs) {
        latestDirs = await addDesktopModelDir(dir);
      }
      dispatch({ type: 'SET_MODEL_DIRS', payload: latestDirs });

      const parsed = (await Promise.all(
        ggufPaths.map((path) => loadDesktopModelFromPath(path).catch(() => null))
      )).filter(isPresent);
      const droppedModels = parsed.map((model) => toFrontendModel(model));
      if (droppedModels.length > 0) {
        dispatch({ type: 'UPSERT_MODELS', payload: droppedModels });
        dispatch({ type: 'SET_SELECTED_MODEL', payload: droppedModels[0].id });
        dispatch({ type: 'SET_VIEW', payload: 'modelLoad' });
      }

      const scanned = await scanDesktopModels(true).catch(() => []);
      if (scanned.length > 0) {
        dispatch({ type: 'UPSERT_MODELS', payload: scanned.map(toFrontendModel) });
      }

      dispatch({
        type: 'SET_APP_STATUS',
        payload: droppedModels.length > 0
          ? `已添加 ${droppedModels.length} 个拖拽模型，并记住模型目录。`
          : '已记住模型目录，请刷新模型列表。',
      });
    } catch (error) {
      dispatch({ type: 'SET_APP_STATUS', payload: `拖拽添加模型失败：${String(error)}` });
    } finally {
      setDropBusy(false);
    }
  }, [dispatch, state.modelDirs]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listenDesktopFileDrops((payload) => {
      if (payload.type === 'enter' || payload.type === 'over') {
        setDropActive(true);
        return;
      }
      if (payload.type === 'leave') {
        setDropActive(false);
        return;
      }
      if (payload.type === 'drop') {
        setDropActive(false);
        void addDroppedModels(payload.paths ?? []);
      }
    }).then((nextUnlisten) => {
      if (cancelled) { nextUnlisten?.(); return; }
      unlisten = nextUnlisten;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [addDroppedModels]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;

    let disposed = false;
    const refreshServerStatus = async () => {
      try {
        const running = await getDesktopServerStatus();
        if (!disposed && running !== state.serverRunning) {
          dispatch({ type: 'SET_SERVER_RUNNING', payload: running });
        }
      } catch {
        if (!disposed && state.serverRunning) {
          dispatch({ type: 'SET_SERVER_RUNNING', payload: false });
        }
      }
    };

    void refreshServerStatus();
    const timer = window.setInterval(() => void refreshServerStatus(), 2000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [dispatch, state.serverRunning]);

  const shouldFetchRuntimeStats = isDesktopRuntime() && state.serverRunning && !!loadedModel;

  useEffect(() => {
    if (!shouldFetchRuntimeStats) {
      return;
    }

    const ctxTotal = loadedModel!.loadConfig.ctxLength || loadedModel!.ctxLength || 0;
    let disposed = false;
    const refreshRuntimeStats = async () => {
      try {
        const lines = await getDesktopServerLogs();
        if (!disposed) setApiRuntimeStats(latestRuntimeStatsFromServerLogs(lines, ctxTotal));
      } catch {
        if (!disposed) setApiRuntimeStats(undefined);
      }
    };

    void refreshRuntimeStats();
    const timer = window.setInterval(() => void refreshRuntimeStats(), 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      setApiRuntimeStats(undefined);
    };
  }, [loadedModel, shouldFetchRuntimeStats]);

  const handleDragOver = (event: React.DragEvent) => {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDropActive(true);
  };

  const handleDragLeave = (event: React.DragEvent) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDropActive(false);
    }
  };

  const handleDomDrop = (event: React.DragEvent) => {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();
    setDropActive(false);
    const paths = Array.from(event.dataTransfer.files ?? [])
      .map((file) => (file as File & { path?: string }).path ?? '')
      .filter(Boolean);
    if (paths.length > 0) {
      void addDroppedModels(paths);
      return;
    }
    dispatch({ type: 'SET_APP_STATUS', payload: '未读取到文件路径，请在桌面版窗口内拖拽 .gguf 文件。' });
  };

  return (
    <div
      className="paper-surface relative flex h-full min-h-0 overflow-hidden rounded-lg border border-[#DCD8CF] bg-[#FBFAF6] text-[#2F2C26] shadow-sm dark:border-white/[0.08] dark:bg-[#10131A] dark:text-[#E2E8F2]"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDomDrop}
    >
      {(dropActive || dropBusy) && (
        <div
          className="anim-fade-in pointer-events-none absolute inset-3 z-50 flex items-center justify-center rounded-xl border border-dashed border-[#D06646] bg-[#FBFAF6]/95 dark:bg-[#12151C]/95"
        >
          <div className="rounded-xl border border-[#E2DFD6] bg-[#FBFAF6] px-5 py-4 text-center shadow-lg dark:border-white/[0.08] dark:bg-[#1A1E28]">
            <FilePlus2 className="mx-auto mb-2 h-6 w-6 text-[#D06646]" />
            <div className="text-sm font-semibold text-[#403C32]">
              {dropBusy ? '正在添加模型' : '松开即可添加 GGUF 模型'}
            </div>
            <div className="mt-1 text-xs text-[#8C8576]">会自动记住模型所在目录并读取模型表头</div>
          </div>
        </div>
      )}
      <aside className="hidden min-h-0 w-60 flex-shrink-0 flex-col overflow-y-auto border-r border-[#E3DFD6] bg-[#F2F0EA] p-2 dark:border-white/[0.08] dark:bg-[#12151C] md:flex">
        <div className="px-4 pb-4 pt-3">
          <div className="mb-4 flex items-center gap-3">
            <button
              type="button"
              onClick={() => dispatch({ type: 'SET_VIEW', payload: 'chat' })}
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[#E9E5DA] text-sm font-semibold text-[#847D6B] transition-colors hover:bg-[#DDD7CB] hover:text-[#D06646]"
              title="切换到对话"
              aria-label="切换到对话"
            >
              {selectedModel?.family?.[0] || '晓'}
            </button>
            <div className="min-w-0">
              <div className="truncate text-base font-semibold">Agent LLM PC</div>
              <div className="truncate text-xs text-[#8D867A]">本地模型加载中心</div>
            </div>
          </div>
        </div>

        <nav className="space-y-1 px-1">
          <button
            onClick={() => dispatch({ type: 'SET_VIEW', payload: 'home' })}
            className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
              !detailOpen && !llamaLogsOpen ? 'bg-[#E6E2D8] text-[#2F2C26]' : 'text-[#4E4941] hover:bg-[#EAE6DD]'
            }`}
          >
            <Database className="h-4 w-4 flex-shrink-0" />
            <span className="truncate">模型列表</span>
          </button>
          {detailOpen && (
            <button
              onClick={() => dispatch({ type: 'SET_VIEW', payload: 'home' })}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-[#4E4941] transition-colors hover:bg-[#EAE6DD]"
            >
              <ArrowLeft className="h-4 w-4 flex-shrink-0" />
              <span className="truncate">退出参数界面</span>
            </button>
          )}
        </nav>

        <div className="mt-5 space-y-2 px-2">
          <LoadedModelPanel model={loadedModel} running={state.serverRunning} onStop={handleStopServer} />
          <ServiceStatusPanel
            running={state.serverRunning}
            port={state.serverPort}
            tokensPerSec={formatTokensPerSec(tokensPerSec)}
            ctxUsage={formatCtxUsage(loadedStats, loadedModel)}
            ctxPercent={ctxPercentValue(loadedStats, loadedModel)}
            vramUsage={formatGbPair(systemStats.vramUsed, systemStats.vramTotal)}
            ramUsage={formatGbPair((systemStats.ramUsage / 100) * systemStats.ramTotal, systemStats.ramTotal)}
            linkState={linkState}
            onOpenDetails={() => dispatch({ type: 'SET_VIEW', payload: 'apiStatus' })}
          />
          <LlamaLogsCard
            running={state.serverRunning}
            active={llamaLogsOpen}
            onOpen={() => dispatch({ type: 'SET_VIEW', payload: 'llamaLogs' })}
          />
        </div>

        <div className="mx-2 mb-3 mt-auto space-y-2">
          <button
            onClick={() => dispatch({ type: 'SET_VIEW', payload: 'chat' })}
            className="w-full rounded-md border border-[#DCD8CF] bg-[#FAF9F5] p-3 text-left transition-colors hover:bg-[#F1EEE7]"
            title="打开对话界面"
          >
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-[#2F2C26]">
              <MessageSquare className="h-3.5 w-3.5 text-[#D06646]" />
              当前目标
            </div>
            <div className="truncate text-sm font-medium text-[#2F2C26]">
              {selectedModel?.name ?? '尚未选择模型'}
            </div>
            <div className="mt-1 truncate text-xs text-[#8D867A]">
              {selectedModel ? `${selectedModel.params} · ${selectedModel.quant}` : '从模型列表进入参数界面'}
            </div>
          </button>
          <div className="flex items-center gap-2">
            <ThemeToggleButton theme={state.theme} onClick={() => dispatch({ type: 'TOGGLE_THEME' })} />
            <button
              onClick={openSettings}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-[#DCD8CF] bg-[#FAF9F5] px-3 py-2 text-sm text-[#4E4941] transition-colors hover:bg-[#EAE6DD] dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[#B8C2D4] dark:hover:bg-white/[0.09]"
              title="打开设置"
            >
              <Settings className="h-4 w-4 flex-shrink-0" />
              <span className="truncate">设置</span>
            </button>
          </div>
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col bg-[#FBFAF6] dark:bg-[#141720]">
        {detailOpen && (
          <div className="flex flex-shrink-0 items-center gap-2 border-b border-[#E3DFD6] bg-[#FBFAF6] px-4 py-3 dark:border-white/[0.08] dark:bg-[#141720] md:hidden">
            <button
              onClick={() => dispatch({ type: 'SET_VIEW', payload: 'home' })}
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md border border-[#DCD8CF] bg-[#FAF9F5] text-[#4E4941]"
              title="退出参数界面"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">加载模型</div>
            <div className="truncate text-xs text-[#8D867A]">
              {selectedModel?.name ?? '参数界面'}
            </div>
          </div>
          <div className="ml-auto">
            <ThemeToggleButton theme={state.theme} onClick={() => dispatch({ type: 'TOGGLE_THEME' })} />
          </div>
          </div>
        )}

        <div
          key={llamaLogsOpen ? 'llama-logs' : detailOpen ? 'model-detail' : 'model-list'}
          className="anim-fade-rise min-h-0 flex-1 overflow-hidden"
        >
          {llamaLogsOpen ? <LlamaLogsPage /> : detailOpen ? <ModelLoadPage /> : <HomePage />}
        </div>
      </section>
    </div>
  );
}

function LoadedModelPanel({ model, running, onStop }: { model?: ModelInfo; running: boolean; onStop: () => void }) {
  const Icon = running && model ? CircleCheck : CircleAlert;
  return (
    <div className="rounded-md border border-[#DCD8CF] bg-[#FAF9F5] px-3 py-2 dark:border-white/[0.08] dark:bg-white/[0.05]">
      <div className="mb-1.5 flex items-center justify-between gap-2 text-xs text-[#7D766B] dark:text-[#A8B2C4]">
        <span>已加载模型</span>
        <Icon className={`h-3.5 w-3.5 flex-shrink-0 ${running && model ? 'text-[#2C8B58]' : 'text-[#A49B8C]'}`} />
      </div>
      <div className="truncate text-sm font-semibold text-[#2F2C26] dark:text-[#E2E8F2]">
        {model?.name ?? '暂无运行模型'}
      </div>
      <div className="mt-1 truncate text-[11px] text-[#8D867A] dark:text-[#8E99AD]">
        {model ? `${model.params} · ${model.quant}` : '加载后会显示名称与状态'}
      </div>
      <button
        type="button"
        onClick={onStop}
        disabled={!running}
        className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-[#E0D8CA] bg-[#F6E4DE] px-2 py-1.5 text-xs font-semibold text-[#B4563B] transition-colors hover:bg-[#F1D4CA] disabled:cursor-not-allowed disabled:bg-black/[0.03] disabled:text-[#A49B8C] dark:border-white/[0.08] dark:bg-[#1C2836] dark:text-[#5A96D0] dark:hover:bg-[#1E2A3A] dark:disabled:bg-white/[0.04] dark:disabled:text-[#7A7264]"
        title="停止当前 llama-server 服务"
      >
        <Power className="h-3.5 w-3.5" />
        停止运行
      </button>
    </div>
  );
}

function LlamaLogsCard({ running, active, onOpen }: { running: boolean; active: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`w-full rounded-md border px-3 py-2 text-left transition-colors focus:outline-none focus:ring-2 focus:ring-[#D7663E]/35 ${
        active
          ? 'border-[#D7663E]/40 bg-[#F6E4DE] hover:bg-[#F1D4CA] dark:border-[#6EA8DC]/40 dark:bg-[#1C2836] dark:hover:bg-[#1E2A3A]'
          : 'border-[#DCD8CF] bg-[#FAF9F5] hover:bg-[#F1EEE7] dark:border-white/[0.08] dark:bg-white/[0.05] dark:hover:bg-white/[0.08]'
      }`}
      title="查看 llama-server 日志"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-xs font-semibold text-[#2F2C26] dark:text-[#E2E8F2]">
          <Terminal className={`h-3.5 w-3.5 flex-shrink-0 ${active ? 'text-[#D7663E] dark:text-[#6EA8DC]' : 'text-[#7D766B] dark:text-[#A8B2C4]'}`} />
          <span className="truncate">llama 日志</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 rounded-full ${running ? 'bg-[#2C8B58]' : 'bg-[#A49B8C]'}`} />
          <ChevronRight className="h-3.5 w-3.5 text-[#A49B8C]" />
        </div>
      </div>
      <div className="mt-1 truncate text-[11px] text-[#8D867A] dark:text-[#8E99AD]">
        {running ? '推理内核输出 · 实时刷新' : '服务未运行 · 可查看历史输出'}
      </div>
    </button>
  );
}

function ServiceStatusPanel({ running, port, tokensPerSec, ctxUsage, ctxPercent, vramUsage, ramUsage, linkState, onOpenDetails }: {
  running: boolean;
  port: number;
  tokensPerSec: string;
  ctxUsage: string;
  ctxPercent?: number;
  vramUsage: string;
  ramUsage: string;
  linkState: string;
  onOpenDetails: () => void;
}) {
  const LinkIcon = running ? Wifi : WifiOff;
  const ctxHas = ctxPercent !== undefined && Number.isFinite(ctxPercent) && ctxPercent >= 0;
  return (
    <button
      type="button"
      onClick={onOpenDetails}
      className="w-full rounded-md border border-[#DCD8CF] bg-[#FAF9F5] px-3 py-2 text-left transition-colors hover:bg-[#F1EEE7] focus:outline-none focus:ring-2 focus:ring-[#D7663E]/35 dark:border-white/[0.08] dark:bg-white/[0.05] dark:hover:bg-white/[0.08]"
      title="查看 API 状态详情"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-xs font-semibold text-[#2F2C26] dark:text-[#E2E8F2]">
          <Server className="h-3.5 w-3.5 flex-shrink-0 text-[#7D766B] dark:text-[#A8B2C4]" />
          <span className="truncate">服务状态</span>
        </div>
        <div className="flex items-center gap-1">
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${running ? 'bg-[#E7F1E4] text-[#4E7751] dark:bg-[#1A2E28] dark:text-[#7EC8A0]' : 'bg-[#ECE7DC] text-[#817A6D] dark:bg-white/[0.06] dark:text-[#8E99AD]'}`}>
            {running ? `:${port}` : '未运行'}
          </span>
          <ChevronRight className="h-3.5 w-3.5 text-[#A49B8C]" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <ServiceMetric icon={Activity} label="速度" value={tokensPerSec} />
        <ServiceMetric icon={Gauge} label="上下文" value={ctxUsage} extra={
          ctxHas ? (
            <div className="mt-1 flex items-center gap-1">
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-[#E6E1D8] dark:bg-white/[0.10]">
                <div
                  className="h-full rounded-full bg-[#D7663E] transition-[width] duration-300"
                  style={{ width: `${Math.min(100, ctxPercent!)}%` }}
                />
              </div>
              <span className="mono-font flex-shrink-0 text-[10px] font-semibold text-[#403C32] dark:text-[#E2E8F2]">{Math.round(ctxPercent!)}%</span>
            </div>
          ) : undefined
        } />
        <ServiceMetric icon={HardDrive} label="显存" value={vramUsage} />
        <ServiceMetric icon={MemoryStick} label="内存" value={ramUsage} />
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-[11px] text-[#8D867A] dark:text-[#8E99AD]">
        <LinkIcon className={`h-3.5 w-3.5 flex-shrink-0 ${running ? 'text-[#2C8B58]' : 'text-[#A49B8C]'}`} />
        <span className="truncate">{linkState}</span>
      </div>
    </button>
  );
}

function ServiceMetric({ icon: Icon, label, value, extra }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  extra?: React.ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-md border border-[#E4DFD5] bg-[#FBFAF6] px-2 py-1.5 dark:border-white/[0.08] dark:bg-[#12151C]">
      <div className="flex items-center gap-1 text-[10px] text-[#8D867A] dark:text-[#8E99AD]">
        <Icon className="h-3 w-3 flex-shrink-0" />
        <span>{label}</span>
      </div>
      <div className="mono-font mt-0.5 truncate text-[11px] font-semibold text-[#2F2C26] dark:text-[#E2E8F2]">{value}</div>
      {extra}
    </div>
  );
}
