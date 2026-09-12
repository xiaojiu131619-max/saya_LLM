import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Bot,
  Boxes,
  ChevronRight,
  Database,
  MessageSquare,
  Server,
  Settings,
  Terminal,
  Wifi,
  WifiOff,
} from 'lucide-react';
import ThemeToggleButton from '@/components/ThemeToggleButton';
import { useApp } from '@/context/AppContext';
import { useSystemStats } from '@/hooks/useSystemStats';
import AgentPage from '@/pages/AgentPage';
import ApiStatusPage from '@/features/apiStatus/ApiStatusPage';
import EmbeddingWorkspace from '@/features/embedding/EmbeddingWorkspace';
import HomePage from '@/pages/HomePage';
import LlamaLogsPage from '@/pages/LlamaLogsPage';
import ModelLoadPage from '@/pages/ModelLoadPage';
import {
  getDesktopServerStatus,
  getDesktopServerLogs,
  isDesktopRuntime,
  stopDesktopServer,
} from '@/lib/desktop';
import type { ChatSession, MessageStats, ModelInfo } from '@/types';
import { estimateSessionCtxTokens, latestRuntimeStatsFromServerLogs, sessionBelongsToModel } from '@/features/chat/chatUtils';

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

function formatCtxUsage(sessionCtxUsed: number, total: number) {
  if (!total || total <= 0) return '--';
  // 与对话气泡同口径：本地会话累计水位（估算），百分比为主。
  const percent = Math.min(100, Math.max(0, (sessionCtxUsed / total) * 100));
  const percentText = percent.toFixed(percent >= 10 ? 0 : 1);
  return `${percentText}% · ≈${Math.round(sessionCtxUsed).toLocaleString()} / ${total.toLocaleString()}`;
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
  const [apiRuntimeStats, setApiRuntimeStats] = useState<MessageStats | undefined>();
  const detailOpen = state.currentView === 'modelLoad';
  const llamaLogsOpen = state.currentView === 'llamaLogs';
  // API 状态、Agent 与 llama 日志同级：保留左侧边栏，在右侧内容区展示。
  const apiStatusOpen = state.currentView === 'apiStatus';
  const agentOpen = state.currentView === 'agent';
  const embeddingOpen = state.currentView === 'embedding';
  const selectedModel = state.models.find((model) => model.id === state.selectedModelId);
  const loadedModel = state.models.find((model) => model.status === 'loaded')
    ?? state.models.find((model) => model.id === state.activeModelId);
  const loadedUsage = loadedModel ? state.usageByModel[loadedModel.id] : undefined;
  // 会话按模型过滤：所有会话都存在 'chat-workspace' 桶里，直接取桶会把别的
  // 模型的会话（及其 ctx 分母）串到当前模型的服务状态卡上。
  const allSessions = useMemo(() => Object.values(state.chatSessions).flat(), [state.chatSessions]);
  const loadedStats = apiRuntimeStats
    ?? latestStatsForSessions(allSessions.filter((session) => sessionBelongsToModel(session, loadedModel?.id)));
  const tokensPerSec = loadedStats?.tokensPerSec
    ?? loadedModel?.avgTokensPerSec
    ?? averageTokensPerSec(loadedUsage);
  // 本地会话水位：当前加载模型的活跃会话的累计 token 估算（与对话气泡同口径）。
  const loadedModelId = loadedModel?.id;
  const loadedModelSessions = loadedModelId
    ? allSessions.filter((session) => sessionBelongsToModel(session, loadedModelId))
    : [];
  const loadedActiveSessionId = loadedModelId ? state.activeChatSessionIds[loadedModelId] : undefined;
  const loadedActiveSession = (loadedActiveSessionId
    ? loadedModelSessions.find((session) => session.id === loadedActiveSessionId)
    : undefined)
    ?? loadedModelSessions.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const sessionCtxUsed = estimateSessionCtxTokens(loadedActiveSession?.messages ?? []);
  const sessionCtxCapacity = loadedModel?.loadConfig.ctxLength || loadedModel?.ctxLength || 0;
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

  return (
    <div
      className="relative flex h-full min-h-0 overflow-hidden bg-[var(--app-bg)] text-[var(--text-primary)] dark:bg-[var(--app-bg)] dark:text-[var(--text-primary)]"
    >
      <aside className="hidden min-h-0 w-60 max-[900px]:w-52 flex-shrink-0 flex-col overflow-y-auto border-r border-[var(--border)] bg-[var(--surface-muted)] p-2 dark:border-white/[0.08] dark:bg-[var(--surface-muted)] md:flex">
        <div className="px-4 pb-4 pt-3">
          <div className="mb-4 flex items-center gap-3">
            <button
              type="button"
              onClick={() => dispatch({ type: 'SET_VIEW', payload: 'chat' })}
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--surface-muted)] text-sm font-semibold text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--accent)]"
              title="切换到对话"
              aria-label="切换到对话"
            >
              {selectedModel?.family?.[0] || '晓'}
            </button>
            <div className="min-w-0">
              <div className="truncate text-base font-semibold">Agent LLM PC</div>
              <div className="truncate text-xs text-[var(--text-tertiary)]">本地模型加载中心</div>
            </div>
          </div>
        </div>

        <nav className="space-y-1 px-1">
          <button
            onClick={() => dispatch({ type: 'SET_VIEW', payload: 'home' })}
            className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
              !detailOpen && !llamaLogsOpen && !apiStatusOpen && !agentOpen && !embeddingOpen ? 'bg-[var(--border)] text-[var(--text-primary)]' : 'text-[var(--text-primary)] hover:bg-[var(--border)]'
            }`}
          >
            <Database className="h-4 w-4 flex-shrink-0" />
            <span className="truncate">模型列表</span>
          </button>
          <button
            onClick={() => dispatch({ type: 'SET_VIEW', payload: 'agent' })}
            className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
              agentOpen ? 'bg-[var(--border)] text-[var(--text-primary)]' : 'text-[var(--text-primary)] hover:bg-[var(--border)]'
            }`}
            title="Agent（智能体）· dsh 工作台"
          >
            <Bot className="h-4 w-4 flex-shrink-0" />
            <span className="truncate">Agent</span>
          </button>
          <button
            onClick={() => dispatch({ type: 'SET_VIEW', payload: 'embedding' })}
            className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
              embeddingOpen ? 'bg-[var(--border)] text-[var(--text-primary)]' : 'text-[var(--text-primary)] hover:bg-[var(--border)]'
            }`}
            title="向量服务 · Embedding / Rerank 模型（可与对话模型同时运行）"
          >
            <Boxes className="h-4 w-4 flex-shrink-0" />
            <span className="truncate">向量服务</span>
          </button>
          {detailOpen && (
            <button
              onClick={() => dispatch({ type: 'SET_VIEW', payload: 'home' })}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--border)]"
            >
              <ArrowLeft className="h-4 w-4 flex-shrink-0" />
              <span className="truncate">退出参数界面</span>
            </button>
          )}
        </nav>

        <div className="mt-5 px-3">
          <LoadedModelPanel model={loadedModel} running={state.serverRunning} onStop={handleStopServer} />
          <ServiceStatusPanel
            running={state.serverRunning}
            port={state.serverPort}
            tokensPerSec={formatTokensPerSec(tokensPerSec)}
            ctxUsage={formatCtxUsage(sessionCtxUsed, sessionCtxCapacity)}
            ctxPercent={sessionCtxCapacity > 0 ? Math.min(100, (sessionCtxUsed / sessionCtxCapacity) * 100) : undefined}
            vramUsage={formatGbPair(systemStats.vramUsed, systemStats.vramTotal)}
            ramUsage={formatGbPair((systemStats.ramUsage / 100) * systemStats.ramTotal, systemStats.ramTotal)}
            linkState={linkState}
            active={apiStatusOpen}
            onOpenDetails={() => dispatch({ type: 'SET_VIEW', payload: 'apiStatus' })}
          />
          <LlamaLogsCard
            running={state.serverRunning}
            active={llamaLogsOpen}
            onOpen={() => dispatch({ type: 'SET_VIEW', payload: 'llamaLogs' })}
          />
        </div>

        <div className="mx-3 mb-3 mt-auto border-t border-[var(--border-subtle)] pt-1">
          <button
            onClick={() => dispatch({ type: 'SET_VIEW', payload: 'chat' })}
            className="flex w-full items-center justify-between border-b border-[var(--border-subtle)] py-2.5 text-left transition-colors hover:bg-[var(--surface-muted)]/40"
            title="打开对话界面"
          >
            <div className="flex min-w-0 items-center gap-2">
              <MessageSquare className="h-3.5 w-3.5 flex-shrink-0 text-[var(--accent)]" />
              <div className="min-w-0">
                <div className="text-[11px] text-[var(--text-tertiary)]">切换到对话</div>
                <div className="truncate text-sm font-medium text-[var(--text-primary)]">
                  {selectedModel?.name ?? '尚未选择模型'}
                </div>
              </div>
            </div>
            <ChevronRight className="h-3.5 w-3.5 text-[var(--text-tertiary)]" />
          </button>
          <div className="flex items-center gap-1 py-1">
            <ThemeToggleButton theme={state.theme} onClick={() => dispatch({ type: 'TOGGLE_THEME' })} />
            <button
              onClick={openSettings}
              className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)]/40"
              title="打开软件设置"
            >
              <Settings className="h-4 w-4 flex-shrink-0" />
              <span className="truncate">软件设置</span>
            </button>
          </div>
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col bg-[var(--app-bg)] dark:bg-[var(--app-bg)]">
        {detailOpen && (
          <div className="flex flex-shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--app-bg)] px-4 py-3 dark:border-white/[0.08] dark:bg-[var(--app-bg)] md:hidden">
            <button
              onClick={() => dispatch({ type: 'SET_VIEW', payload: 'home' })}
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)]"
              title="退出参数界面"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">加载模型</div>
            <div className="truncate text-xs text-[var(--text-tertiary)]">
              {selectedModel?.name ?? '参数界面'}
            </div>
          </div>
          <div className="ml-auto">
            <ThemeToggleButton theme={state.theme} onClick={() => dispatch({ type: 'TOGGLE_THEME' })} />
          </div>
          </div>
        )}

        <div
          key={llamaLogsOpen ? 'llama-logs' : apiStatusOpen ? 'api-status' : agentOpen ? 'agent' : embeddingOpen ? 'embedding' : detailOpen ? 'model-detail' : 'model-list'}
          className="anim-fade-rise min-h-0 flex-1 overflow-hidden"
        >
          {llamaLogsOpen ? <LlamaLogsPage /> : apiStatusOpen ? <ApiStatusPage /> : agentOpen ? <AgentPage /> : embeddingOpen ? <EmbeddingWorkspace /> : detailOpen ? <ModelLoadPage /> : <HomePage />}
        </div>
      </section>
    </div>
  );
}

function LoadedModelPanel({ model, running, onStop }: { model?: ModelInfo; running: boolean; onStop: () => void }) {
  return (
    <div className="border-b border-[var(--border-subtle)] py-2.5">
      <div className="mb-1 flex items-center justify-between text-[11px] text-[var(--text-tertiary)]">
        <span>已加载模型</span>
        <span
          className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${running && model ? 'bg-[var(--state-success)]' : 'bg-[var(--text-tertiary)]'}`}
          title={running ? '运行中' : '未运行'}
        />
      </div>
      <div className="truncate text-sm font-semibold text-[var(--text-primary)]">
        {model?.name ?? '暂无运行模型'}
      </div>
      <div className="mt-0.5 truncate text-[11px] text-[var(--text-tertiary)]">
        {model ? `${model.params} · ${model.quant}` : '加载后会显示名称与状态'}
      </div>
      <button
        type="button"
        onClick={onStop}
        disabled={!running}
        className="mt-1.5 text-[11px] font-medium text-[var(--state-danger)] transition-colors hover:underline disabled:cursor-not-allowed disabled:text-[var(--text-tertiary)] disabled:no-underline"
        title="停止当前 llama-server 服务"
      >
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
      className={`flex w-full items-center justify-between border-b border-[var(--border-subtle)] py-2.5 text-left transition-colors hover:bg-[var(--surface-muted)]/40 ${
        active ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'
      }`}
      title="查看 llama-server 日志"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Terminal className={`h-3.5 w-3.5 flex-shrink-0 ${active ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'}`} />
        <span className="text-sm">llama 日志</span>
        <span
          className={`ml-1 h-1.5 w-1.5 rounded-full ${running ? 'bg-[var(--state-success)]' : 'bg-[var(--text-tertiary)]'}`}
          title={running ? '服务运行中' : '服务未运行'}
        />
      </div>
      <ChevronRight className="h-3.5 w-3.5 text-[var(--text-tertiary)]" />
    </button>
  );
}

function ServiceStatusPanel({ running, port, tokensPerSec, ctxUsage, ctxPercent, vramUsage, ramUsage, linkState, active, onOpenDetails }: {
  running: boolean;
  port: number;
  tokensPerSec: string;
  ctxUsage: string;
  ctxPercent?: number;
  vramUsage: string;
  ramUsage: string;
  linkState: string;
  active?: boolean;
  onOpenDetails: () => void;
}) {
  const LinkIcon = running ? Wifi : WifiOff;
  const ctxHas = ctxPercent !== undefined && Number.isFinite(ctxPercent) && ctxPercent >= 0;
  return (
    <button
      type="button"
      onClick={onOpenDetails}
      className={`block w-full border-b border-[var(--border-subtle)] py-2.5 text-left transition-colors hover:bg-[var(--surface-muted)]/40 ${
        active ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'
      }`}
      title="查看 API 状态详情"
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--text-tertiary)]">
          <Server className={`h-3.5 w-3.5 flex-shrink-0 ${active ? 'text-[var(--accent)]' : ''}`} />
          <span>服务状态</span>
        </div>
        <div className="flex items-center gap-1">
          <span className={`text-[10px] font-medium ${running ? 'text-[var(--state-success)]' : 'text-[var(--text-tertiary)]'}`}>
            {running ? `:${port}` : '未运行'}
          </span>
          <ChevronRight className="h-3.5 w-3.5 text-[var(--text-tertiary)]" />
        </div>
      </div>
      <div className="space-y-1 text-[11px]">
        <div className="flex items-baseline justify-between gap-2">
          <span className="flex-shrink-0 text-[var(--text-tertiary)]">速度</span>
          <span className="mono-font break-all text-right leading-4 text-[var(--text-primary)]" title={tokensPerSec}>{tokensPerSec}</span>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="flex-shrink-0 text-[var(--text-tertiary)]">上下文</span>
          <span className="mono-font break-all text-right leading-4 text-[var(--text-primary)]" title={ctxUsage}>{ctxUsage}</span>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="flex-shrink-0 text-[var(--text-tertiary)]">显存</span>
          <span className="mono-font break-all text-right leading-4 text-[var(--text-primary)]" title={vramUsage}>{vramUsage}</span>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="flex-shrink-0 text-[var(--text-tertiary)]">内存</span>
          <span className="mono-font break-all text-right leading-4 text-[var(--text-primary)]" title={ramUsage}>{ramUsage}</span>
        </div>
      </div>
      {ctxHas && (
        <div className="mt-1.5 flex items-center gap-2 text-[10px]">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--surface-muted)]">
            <div
              className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300"
              style={{ width: `${Math.min(100, ctxPercent!)}%` }}
            />
          </div>
          <span className="mono-font flex-shrink-0 text-[var(--text-tertiary)]">{Math.round(ctxPercent!)}% ctx</span>
        </div>
      )}
      <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-[var(--text-tertiary)]">
        <LinkIcon className={`h-3 w-3 flex-shrink-0 ${running ? 'text-[var(--state-success)]' : 'text-[var(--text-tertiary)]'}`} />
        <span className="break-words leading-4">{linkState}</span>
      </div>
    </button>
  );
}
