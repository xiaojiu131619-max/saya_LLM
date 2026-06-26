import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  CircleAlert,
  CircleCheck,
  Database,
  FilePlus2,
  Gauge,
  HardDrive,
  Layers,
  MemoryStick,
  MessageSquare,
  Server,
  Settings,
  WandSparkles,
  Wifi,
  WifiOff,
} from 'lucide-react';
import ThemeToggleButton from '@/components/ThemeToggleButton';
import { useApp } from '@/context/AppContext';
import { useSystemStats } from '@/hooks/useSystemStats';
import HomePage from '@/pages/HomePage';
import ModelLoadPage from '@/pages/ModelLoadPage';
import {
  addDesktopModelDir,
  isDesktopRuntime,
  listenDesktopFileDrops,
  loadDesktopModelFromPath,
  scanDesktopModels,
  toFrontendModel,
} from '@/lib/desktop';
import type { ChatSession, MessageStats, ModelInfo } from '@/types';

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
  const detailOpen = state.currentView === 'modelLoad';
  const selectedModel = state.models.find((model) => model.id === state.selectedModelId);
  const loadedModel = state.models.find((model) => model.status === 'loaded')
    ?? state.models.find((model) => model.id === state.activeModelId);
  const loadedUsage = loadedModel ? state.usageByModel[loadedModel.id] : undefined;
  const loadedStats = latestStatsForSessions(loadedModel ? state.chatSessions[loadedModel.id] : undefined);
  const tokensPerSec = loadedStats?.tokensPerSec
    ?? loadedModel?.avgTokensPerSec
    ?? averageTokensPerSec(loadedUsage);
  const linkState = state.serverRunning && loadedModel ? '已连接' : state.serverRunning ? '服务在线' : '未连接';
  const loadedCount = state.models.filter((model) => model.status === 'loaded').length;
  const localCount = state.models.filter((model) => model.source === 'local').length;
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
      unlisten = nextUnlisten;
    });
    return () => {
      unlisten?.();
    };
  }, [addDroppedModels]);

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
      className="paper-surface relative flex h-full min-h-0 overflow-hidden rounded-md border border-[#DCD8CF] bg-[#FBFAF6] text-[#2F2C26] shadow-sm dark:border-white/[0.08] dark:bg-[#11100E] dark:text-[#F3EBDD]"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDomDrop}
    >
      {(dropActive || dropBusy) && (
        <div
          className="anim-fade-in pointer-events-none absolute inset-3 z-50 flex items-center justify-center rounded-xl border border-dashed border-[#D06646] bg-[#FBFAF6]/95 dark:bg-[#15130F]/95"
        >
          <div className="rounded-xl border border-[#E2DFD6] bg-[#FBFAF6] px-5 py-4 text-center shadow-lg dark:border-white/[0.08] dark:bg-[#1C1A16]">
            <FilePlus2 className="mx-auto mb-2 h-6 w-6 text-[#D06646]" />
            <div className="text-sm font-semibold text-[#403C32]">
              {dropBusy ? '正在添加模型' : '松开即可添加 GGUF 模型'}
            </div>
            <div className="mt-1 text-xs text-[#8C8576]">会自动记住模型所在目录并读取模型表头</div>
          </div>
        </div>
      )}
      <aside className="hidden w-64 flex-shrink-0 flex-col border-r border-[#E3DFD6] bg-[#F2F0EA] p-2 dark:border-white/[0.08] dark:bg-[#15130F] md:flex">
        <div className="px-4 pb-4 pt-3">
          <div className="mb-4 flex items-center gap-3">
            <button
              onClick={() => dispatch({ type: 'SET_VIEW', payload: 'chat' })}
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[#E9E5DA] text-sm font-semibold text-[#847D6B] transition-colors hover:bg-[#DDD7CB] hover:text-[#D06646]"
              title="切换到 Chat"
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
              !detailOpen ? 'bg-[#E6E2D8] text-[#2F2C26]' : 'text-[#4E4941] hover:bg-[#EAE6DD]'
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
          <button
            onClick={() => dispatch({ type: 'SET_VIEW', payload: 'image' })}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-[#4E4941] transition-colors hover:bg-[#EAE6DD]"
            title="进入生图工作台"
          >
            <WandSparkles className="h-4 w-4 flex-shrink-0" />
            <span className="truncate">生图工作台</span>
          </button>
        </nav>

        <div className="mt-5 space-y-2 px-2">
          <ModelWorkspaceStat icon={HardDrive} label="真实模型" value={`${localCount} 个`} />
          <ModelWorkspaceStat icon={Layers} label="已加载" value={`${loadedCount} 个`} />
          <LoadedModelPanel model={loadedModel} running={state.serverRunning} />
          <ServiceStatusPanel
            running={state.serverRunning}
            port={state.serverPort}
            tokensPerSec={formatTokensPerSec(tokensPerSec)}
            ctxUsage={formatCtxUsage(loadedStats, loadedModel)}
            vramUsage={formatGbPair(systemStats.vramUsed, systemStats.vramTotal)}
            ramUsage={formatGbPair((systemStats.ramUsage / 100) * systemStats.ramTotal, systemStats.ramTotal)}
            linkState={linkState}
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
        {detailOpen && (
          <div className="flex flex-shrink-0 items-center gap-2 border-b border-[#E3DFD6] bg-[#FBFAF6] px-4 py-3 dark:border-white/[0.08] dark:bg-[#171512] md:hidden">
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
          key={detailOpen ? 'model-detail' : 'model-list'}
          className="anim-fade-rise min-h-0 flex-1 overflow-hidden"
        >
          {detailOpen ? <ModelLoadPage /> : <HomePage />}
        </div>
      </section>
    </div>
  );
}

function ModelWorkspaceStat({ icon: Icon, label, value }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-[#DCD8CF] bg-[#FAF9F5] px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="h-4 w-4 flex-shrink-0 text-[#7D766B]" />
        <span className="truncate text-xs text-[#7D766B]">{label}</span>
      </div>
      <span className="mono-font flex-shrink-0 text-xs font-semibold text-[#2F2C26]">{value}</span>
    </div>
  );
}

function LoadedModelPanel({ model, running }: { model?: ModelInfo; running: boolean }) {
  const Icon = running && model ? CircleCheck : CircleAlert;
  return (
    <div className="rounded-md border border-[#DCD8CF] bg-[#FAF9F5] px-3 py-2 dark:border-white/[0.08] dark:bg-white/[0.05]">
      <div className="mb-1.5 flex items-center justify-between gap-2 text-xs text-[#7D766B] dark:text-[#BDB4A7]">
        <span>已加载模型</span>
        <Icon className={`h-3.5 w-3.5 flex-shrink-0 ${running && model ? 'text-[#2C8B58]' : 'text-[#A49B8C]'}`} />
      </div>
      <div className="truncate text-sm font-semibold text-[#2F2C26] dark:text-[#F3EBDD]">
        {model?.name ?? '暂无运行模型'}
      </div>
      <div className="mt-1 truncate text-[11px] text-[#8D867A] dark:text-[#A9A095]">
        {model ? `${model.params} · ${model.quant}` : '加载后会显示名称与状态'}
      </div>
    </div>
  );
}

function ServiceStatusPanel({ running, port, tokensPerSec, ctxUsage, vramUsage, ramUsage, linkState }: {
  running: boolean;
  port: number;
  tokensPerSec: string;
  ctxUsage: string;
  vramUsage: string;
  ramUsage: string;
  linkState: string;
}) {
  const LinkIcon = running ? Wifi : WifiOff;
  return (
    <div className="rounded-md border border-[#DCD8CF] bg-[#FAF9F5] px-3 py-2 dark:border-white/[0.08] dark:bg-white/[0.05]">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-xs font-semibold text-[#2F2C26] dark:text-[#F3EBDD]">
          <Server className="h-3.5 w-3.5 flex-shrink-0 text-[#7D766B] dark:text-[#BDB4A7]" />
          <span className="truncate">服务状态</span>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${running ? 'bg-[#E7F1E4] text-[#4E7751] dark:bg-[#1F3224] dark:text-[#98D19C]' : 'bg-[#ECE7DC] text-[#817A6D] dark:bg-white/[0.06] dark:text-[#A9A095]'}`}>
          {running ? `:${port}` : '未运行'}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <ServiceMetric icon={Activity} label="ts" value={tokensPerSec} />
        <ServiceMetric icon={Gauge} label="ctx" value={ctxUsage} />
        <ServiceMetric icon={HardDrive} label="vram" value={vramUsage} />
        <ServiceMetric icon={MemoryStick} label="mem" value={ramUsage} />
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-[11px] text-[#8D867A] dark:text-[#A9A095]">
        <LinkIcon className={`h-3.5 w-3.5 flex-shrink-0 ${running ? 'text-[#2C8B58]' : 'text-[#A49B8C]'}`} />
        <span className="truncate">{linkState}</span>
      </div>
    </div>
  );
}

function ServiceMetric({ icon: Icon, label, value }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0 rounded-md border border-[#E4DFD5] bg-[#FBFAF6] px-2 py-1.5 dark:border-white/[0.08] dark:bg-[#15130F]">
      <div className="flex items-center gap-1 text-[10px] text-[#8D867A] dark:text-[#A9A095]">
        <Icon className="h-3 w-3 flex-shrink-0" />
        <span>{label}</span>
      </div>
      <div className="mono-font mt-0.5 truncate text-[11px] font-semibold text-[#2F2C26] dark:text-[#F3EBDD]">{value}</div>
    </div>
  );
}
