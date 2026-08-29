import { useState, type ReactNode } from 'react';
import { Play, Box, FolderSearch, Zap, Loader2, History, Eye, Brain, Wrench, Sparkles, Mic, Film } from 'lucide-react';
import type { ModelInfo } from '@/types';
import { useApp } from '@/context/AppContext';
import { isDesktopRuntime, listenDesktopEvent, revealDesktopPath, startDesktopServer } from '@/lib/desktop';
import { modelVideoSupport, videoSupportTitle } from '@/lib/modelCapabilities';
import { getModelThemeGroup } from '@/lib/modelTheme';
import ModelFamilyLogo from '@/components/ModelFamilyLogo';

interface ModelCardProps {
  model: ModelInfo;
  index: number;
  isSingleColumn?: boolean;
  recentUsedAt?: number;
}

function formatCtx(ctxLength: number) {
  if (!ctxLength) return 'ctx 暂无';
  return `${ctxLength >= 1000 ? `${(ctxLength / 1000).toFixed(0)}K` : ctxLength} ctx`;
}

function formatLaunchMemoryTitle(config: ModelInfo['loadConfig']) {
  return `使用记忆参数快速启动 · ctx ${config.ctxLength.toLocaleString()} · ngl ${config.gpuLayers.toLocaleString()}`;
}

function formatRecentUsedAt(usedAt: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(usedAt));
}

export default function ModelCard({ model, index, isSingleColumn = false, recentUsedAt }: ModelCardProps) {
  const { state, dispatch } = useApp();
  const [hovered, setHovered] = useState(false);
  const [quickStarting, setQuickStarting] = useState(false);
  const themeGroup = getModelThemeGroup(model);
  const launchMemory = state.modelLaunchMemories[model.id];
  const isHighlighted = hovered || state.selectedModelId === model.id;
  const recentTitle = recentUsedAt ? `最近使用：${formatRecentUsedAt(recentUsedAt)}` : undefined;

  const handleClick = () => {
    dispatch({ type: 'SET_SELECTED_MODEL', payload: model.id });
    dispatch({ type: 'SET_VIEW', payload: 'modelLoad' });
  };

  const handleQuickChat = (e: React.MouseEvent) => {
    e.stopPropagation();
    dispatch({ type: 'MARK_MODEL_RECENTLY_USED', payload: { modelId: model.id } });
    dispatch({ type: 'SET_ACTIVE_MODEL', payload: model.id });
    dispatch({ type: 'SET_VIEW', payload: 'chat' });
  };

  const handleQuickLaunch = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!launchMemory) return;

    if (model.status === 'loaded') {
      dispatch({ type: 'MARK_MODEL_RECENTLY_USED', payload: { modelId: model.id } });
      dispatch({ type: 'SET_ACTIVE_MODEL', payload: model.id });
      dispatch({ type: 'SET_VIEW', payload: 'chat' });
      return;
    }

    if (!isDesktopRuntime() || !model.filePath || quickStarting) return;

    const rememberedModel = { ...model, loadConfig: launchMemory.config };
    const unlisteners: Array<() => void> = [];
    setQuickStarting(true);
    dispatch({ type: 'UPDATE_MODEL_STATUS', payload: { modelId: model.id, status: 'loading' } });
    dispatch({ type: 'UPDATE_MODEL_CONFIG', payload: { modelId: model.id, config: launchMemory.config } });
    dispatch({ type: 'SET_APP_STATUS', payload: `正在使用记忆参数快速启动 ${model.name}...` });

    try {
      const ready = new Promise<void>((resolve, reject) => {
        void listenDesktopEvent<{ message?: string }>('server:ready', () => resolve())
          .then((unlisten) => unlisteners.push(unlisten));
        void listenDesktopEvent<{ title?: string; details?: string }>('server:error', (error) => {
          reject(new Error(error.title || error.details || 'llama-server 启动失败'));
        }).then((unlisten) => unlisteners.push(unlisten));
      });

      await startDesktopServer(rememberedModel, state.serverPort, 'resources/llama-server.exe', state.apiConfig, state.chatConfig.enabledTools);
      await ready;

      dispatch({ type: 'REMEMBER_MODEL_LAUNCH_CONFIG', payload: { modelId: model.id, config: launchMemory.config } });
      dispatch({ type: 'MARK_MODEL_RECENTLY_USED', payload: { modelId: model.id } });
      dispatch({ type: 'UPDATE_MODEL_STATUS', payload: { modelId: model.id, status: 'loaded' } });
      dispatch({ type: 'SET_ACTIVE_MODEL', payload: model.id });
      dispatch({ type: 'SET_SERVER_RUNNING', payload: true });
      dispatch({ type: 'SET_APP_STATUS', payload: `已使用记忆参数启动 ${model.name}。` });
      dispatch({ type: 'SET_VIEW', payload: 'chat' });
    } catch (error) {
      dispatch({ type: 'UPDATE_MODEL_STATUS', payload: { modelId: model.id, status: 'error' } });
      dispatch({ type: 'SET_SERVER_RUNNING', payload: false });
      dispatch({ type: 'SET_APP_STATUS', payload: `快速启动失败：${String(error instanceof Error ? error.message : error)}` });
    } finally {
      unlisteners.forEach((unlisten) => unlisten());
      setQuickStarting(false);
    }
  };

  const handleReveal = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!model.filePath || !isDesktopRuntime()) return;
    await revealDesktopPath(model.filePath);
  };

  const statusClass = {
    loaded: 'bg-[var(--status-loaded)]',
    loading: 'bg-[var(--status-loading)]',
    error: 'bg-[var(--state-danger)]',
    standby: 'bg-[var(--status-standby)]',
    downloading: 'bg-[var(--accent)]',
  }[model.status];
  const statusLabel = {
    loaded: '已加载',
    loading: '加载中',
    error: '错误',
    standby: '待机',
    downloading: '下载中',
  }[model.status];

  if (isSingleColumn) {
    return (
      <article
        style={{ animationDelay: `${Math.min(index * 10, 80)}ms` }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className={`anim-card-rise model-glass-card group flex min-h-[52px] w-full items-center gap-2 px-3 py-2 ${
          isHighlighted ? 'model-glass-card--active' : ''
        } ${model.status === 'loading' ? 'model-glass-card--loading' : ''}`}
      >
        <button
          type="button"
          onClick={handleClick}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          aria-label={`打开 ${model.name} 的加载参数`}
        >
          <span className="relative flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[var(--surface-muted)]">
            <span
              className="absolute inset-0 rounded-full opacity-20"
              style={{ background: model.themeColorSolid }}
            />
            <ModelFamilyLogo
              family={model.family}
              architecture={model.architecture}
              name={model.name}
              size={16}
              customSrc={model.customLogo}
              tone={model.themeColorSolid}
              className="relative"
              fallback={<span className="relative text-sm font-semibold" style={{ color: model.themeColorSolid }}>{themeGroup.icon}</span>}
            />
            <span
              className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--surface)] ${statusClass}`}
              title={statusLabel}
            />
          </span>

          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--text-primary)] dark:text-[var(--text-primary)]">{model.name}</span>
            <CompactPill>{model.params}</CompactPill>
            <CompactPill className="hidden sm:inline-flex">{model.quant}</CompactPill>
            <CompactPill className="hidden md:inline-flex">
              {model.modelType === 'moe' ? 'MoE' : '稠密'}
            </CompactPill>
            <span className="hidden lg:inline-flex">
              <CapabilityBadges model={model} dense onlyActive />
            </span>
            {recentUsedAt && (
              <span
                className="hidden h-6 flex-shrink-0 items-center gap-1 rounded-md border border-[var(--state-danger-border)] bg-[var(--state-danger-bg)]/80 px-2 text-[11px] leading-6 text-[var(--state-warning)] sm:inline-flex dark:border-[var(--state-danger-border)]/30 dark:bg-[var(--surface-raised)]/80 dark:text-[var(--accent)]"
                title={recentTitle}
              >
                <History className="h-3 w-3" />
                最近使用
              </span>
            )}
            <CompactPill className="hidden lg:inline-flex">
              {model.avgTokensPerSec ? `${model.avgTokensPerSec.toFixed(1)} tok/s` : 'tok/s 暂无'}
            </CompactPill>
          </span>
        </button>

        <div className="flex flex-shrink-0 items-center gap-1">
          {launchMemory && (
            <button
              onClick={(event) => void handleQuickLaunch(event)}
              disabled={!model.filePath || !isDesktopRuntime() || quickStarting}
              className="flex h-9 w-9 items-center justify-center rounded-md border border-[var(--state-warning-border)] bg-[var(--state-warning-bg)] text-[var(--state-warning)] transition-colors hover:bg-[var(--state-warning-bg)] disabled:opacity-40"
              title={formatLaunchMemoryTitle(launchMemory.config)}
            >
              {quickStarting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Zap className="h-3.5 w-3.5 fill-current" />
              )}
            </button>
          )}
          {model.status === 'loaded' && (
            <button
              onClick={handleQuickChat}
              className="flex h-9 w-9 items-center justify-center rounded-md border border-[var(--state-danger-border)] bg-[var(--state-danger-bg)] transition-colors hover:bg-[var(--state-danger-border)]"
              title="开始对话"
            >
              <Play className="ml-0.5 h-3.5 w-3.5 text-[var(--accent)]" />
            </button>
          )}
          {model.filePath && (
            <button
              onClick={handleReveal}
              disabled={!isDesktopRuntime()}
              className="flex h-9 w-9 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--surface-muted)] transition-colors hover:bg-[var(--surface-muted)] disabled:opacity-40"
              title="在资源管理器中显示"
            >
              <FolderSearch className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
            </button>
          )}
        </div>
      </article>
    );
  }

  // 多列模式：Win10 磁贴风格。整块卡片可点进入参数页，信息按行紧凑排布。
  return (
    <article
      style={{ animationDelay: `${Math.min(index * 15, 80)}ms` }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          handleClick();
        }
      }}
      aria-label={`打开 ${model.name} 的加载参数`}
      className={`anim-card-rise model-tile flex w-full cursor-pointer flex-col ${
        isHighlighted ? 'model-glass-card--active' : ''
      } ${model.status === 'loading' ? 'model-glass-card--loading' : ''}`}
    >
      <div className="flex min-w-0 items-start gap-2.5 p-3 pb-2">
        <span
          className="relative flex h-10 w-10 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg"
          style={{ background: `${model.themeColorSolid}1f` }}
        >
          <ModelFamilyLogo
            family={model.family}
            architecture={model.architecture}
            name={model.name}
            size={20}
            customSrc={model.customLogo}
            tone={model.themeColorSolid}
            className="relative"
            fallback={<span className="relative text-base font-semibold" style={{ color: model.themeColorSolid }}>{themeGroup.icon}</span>}
          />
          <span
            className={`absolute bottom-0.5 right-0.5 h-2 w-2 rounded-full border border-[var(--surface)] ${statusClass}`}
            title={statusLabel}
          />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[13px] font-semibold leading-tight text-[var(--text-primary)] [overflow-wrap:anywhere] dark:text-[var(--text-primary)]">{model.name}</h3>
          <div
            className="mono-font mt-0.5 truncate text-[10px] text-[var(--text-tertiary)]"
            title={`${model.params} · ${model.quant} · ${model.fileSize}`}
          >
            {model.params} · {model.quant} · {model.fileSize}
          </div>
        </div>
        {recentUsedAt && (
          <span title={recentTitle} className="flex-shrink-0">
            <History className="h-3.5 w-3.5 text-[var(--accent)]" />
          </span>
        )}
      </div>

      <div className="px-3">
        <CapabilityBadges model={model} dense twoLine />
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 px-3 pb-2.5 pt-2.5">
        <span
          className="mono-font min-w-0 truncate text-[10px] text-[var(--text-secondary)]"
          title={`上下文 ${formatCtx(model.ctxLength)}${model.avgTokensPerSec ? ` · 历史 ${model.avgTokensPerSec.toFixed(1)} tok/s` : ''}`}
        >
          {formatCtx(model.ctxLength)}
          {model.avgTokensPerSec ? ` · ${model.avgTokensPerSec.toFixed(1)} tok/s` : ''}
        </span>
        <div className="flex flex-shrink-0 items-center gap-1">
          {model.status === 'loaded' && (
            <button
              onClick={handleQuickChat}
              className="flex h-7 w-7 items-center justify-center rounded-md border border-[var(--state-danger-border)] bg-[var(--state-danger-bg)] transition-colors hover:bg-[var(--state-danger-border)]"
              title="开始对话"
            >
              <Play className="ml-0.5 h-3 w-3 text-[var(--accent)]" />
            </button>
          )}
          {launchMemory && (
            <button
              onClick={(event) => void handleQuickLaunch(event)}
              disabled={!model.filePath || !isDesktopRuntime() || quickStarting}
              className="flex h-7 w-7 items-center justify-center rounded-md border border-[var(--state-warning-border)] bg-[var(--state-warning-bg)] text-[var(--state-warning)] transition-colors hover:bg-[var(--state-warning-bg)] disabled:opacity-40"
              title={formatLaunchMemoryTitle(launchMemory.config)}
            >
              {quickStarting ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Zap className="h-3 w-3 fill-current" />
              )}
            </button>
          )}
          {model.filePath && (
            <button
              onClick={handleReveal}
              disabled={!isDesktopRuntime()}
              className="flex h-7 w-7 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--surface-muted)] transition-colors hover:bg-[var(--border)] disabled:opacity-40"
              title="在资源管理器中显示"
            >
              <FolderSearch className="h-3 w-3 text-[var(--text-secondary)]" />
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

function CompactPill({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span className={`h-6 flex-shrink-0 items-center rounded-md border border-[var(--border)] bg-[var(--surface-muted)] px-2 text-[11px] leading-6 text-[var(--text-secondary)] ${className}`}>
      {children}
    </span>
  );
}

type CapabilityKey = 'vision' | 'audio' | 'video' | 'thinking' | 'tools' | 'mtp' | 'dspark' | 'dflash' | 'dynamic';
type CapabilityState = 'on' | 'partial' | 'off';

interface CapabilityDef {
  key: CapabilityKey;
  label: string;
  icon: typeof Eye;
  active: string;
  activeText: string;
  activeBorder: string;
}

const CAPABILITY_DEFS: CapabilityDef[] = [
  { key: 'vision',    label: '视觉', icon: Eye,      active: 'bg-[var(--accent-subtle)]', activeText: 'text-[var(--accent)]', activeBorder: 'border-[var(--border)]' },
  { key: 'audio',     label: '音频', icon: Mic,      active: 'bg-[var(--accent-subtle)]', activeText: 'text-[var(--accent)]', activeBorder: 'border-[var(--border)]' },
  { key: 'video',     label: '视频', icon: Film,     active: 'bg-[var(--state-warning-bg)]', activeText: 'text-[var(--state-warning)]', activeBorder: 'border-[var(--state-danger-border)]' },
  { key: 'thinking',  label: '思考', icon: Brain,    active: 'bg-[var(--accent-subtle)]', activeText: 'text-[var(--accent)]', activeBorder: 'border-[var(--accent-subtle)]' },
  { key: 'tools',     label: '工具', icon: Wrench,   active: 'bg-[var(--state-success-bg)]', activeText: 'text-[var(--state-success)]', activeBorder: 'border-[var(--state-success-border)]' },
  { key: 'mtp',       label: 'MTP',  icon: Sparkles, active: 'bg-[var(--accent-subtle)]', activeText: 'text-[var(--accent)]', activeBorder: 'border-[var(--border)]' },
  { key: 'dspark',    label: 'DSpark', icon: Sparkles, active: 'bg-[var(--accent-subtle)]', activeText: 'text-[var(--accent)]', activeBorder: 'border-[var(--border)]' },
  { key: 'dflash',    label: 'DFlash', icon: Sparkles, active: 'bg-[var(--accent-subtle)]', activeText: 'text-[var(--accent)]', activeBorder: 'border-[var(--border)]' },
  { key: 'dynamic',   label: 'UD量化', icon: Box,     active: 'bg-[var(--accent-subtle)]', activeText: 'text-[var(--accent)]', activeBorder: 'border-[var(--border)]' },
];

function modelCapabilityStates(model: ModelInfo): Record<CapabilityKey, CapabilityState> {
  // 思考与推理合并为单一"思考"标签：任一为 true 即显示
  const thinking = !!model.supportsThinking || !!model.supportsReasoning;
  const videoSupport = modelVideoSupport(model);
  return {
    vision: model.supportsVision ? 'on' : 'off',
    audio: model.supportsAudio ? 'on' : 'off',
    video: videoSupport === 'verified' ? 'on' : videoSupport === 'candidate' ? 'partial' : 'off',
    thinking: thinking ? 'on' : 'off',
    tools: model.supportsTools ? 'on' : 'off',
    mtp: model.supportsMtp ? 'on' : 'off',
    dspark: model.dsparkDraftPath ? 'on' : 'off',
    dflash: model.dflashDraftPath ? 'on' : 'off',
    dynamic: model.isDynamicQuant ? 'on' : 'off',
  };
}

function CapabilityBadges({ model, dense = false, onlyActive = false, twoLine = false }: { model: ModelInfo; dense?: boolean; onlyActive?: boolean; twoLine?: boolean }) {
  const states = modelCapabilityStates(model);
  const videoSupport = modelVideoSupport(model);
  const sizeClasses = dense
    ? 'h-5 px-1.5 text-[10px] gap-0.5'
    : 'h-6 px-2 text-[11px] gap-1';
  const iconSize = dense ? 'h-2.5 w-2.5' : 'h-3 w-3';
  const activeDefs = CAPABILITY_DEFS.filter((def) => states[def.key] === 'on' || states[def.key] === 'partial');
  const visibleDefs = onlyActive ? activeDefs : CAPABILITY_DEFS;

  // 多列两行展示全部激活标签；单列仍在过多时折叠为 "+N"
  const MAX_SHOWN = dense ? 3 : 4;
  const shouldFold = onlyActive && !twoLine && visibleDefs.length > MAX_SHOWN;
  const displayedDefs = shouldFold ? visibleDefs.slice(0, MAX_SHOWN - 1) : visibleDefs;
  const hiddenCount = shouldFold ? visibleDefs.length - (MAX_SHOWN - 1) : 0;
  const hiddenLabels = shouldFold ? visibleDefs.slice(MAX_SHOWN - 1).map((d) => d.label).join('、') : '';

  // 单列/onlyActive 模式下没有命中的能力时，直接不渲染（避免空占位文字挤压排版）。
  if (onlyActive && visibleDefs.length === 0) {
    return dense ? null : (
      <span className="text-[11px] text-[var(--text-tertiary)] dark:text-[var(--text-tertiary)]">无能力徽章</span>
    );
  }

  return (
    <div className={twoLine ? 'grid w-full grid-cols-5 gap-1 content-start' : 'flex flex-shrink-0 flex-wrap items-center gap-1'}>
      {displayedDefs.map((def) => {
        const Icon = def.icon;
        const state = states[def.key];
        const title = def.key === 'video'
          ? videoSupportTitle(videoSupport)
          : `${def.label}${state === 'on' ? '：支持' : '：未检测到'}`;
        const label = def.key === 'video' && state === 'partial' ? '视频候选' : def.label;
        return (
          <span
            key={def.key}
            title={title}
            className={`inline-flex items-center rounded-md border transition-colors ${sizeClasses} ${
              state === 'on'
                ? `${def.activeBorder} ${def.active} ${def.activeText} font-semibold dark:bg-white/[0.06]`
                : state === 'partial'
                  ? 'border-dashed border-[var(--state-danger-border)] bg-[var(--surface)] text-[var(--state-danger)] dark:border-[var(--state-danger-border)] dark:bg-[var(--state-danger-bg)] dark:text-[var(--accent)]'
                : 'border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text-tertiary)] opacity-55 dark:border-white/[0.06] dark:bg-white/[0.03] dark:text-[var(--text-secondary)] dark:opacity-50'
            }`}
          >
            <Icon className={iconSize} />
            <span>{label}</span>
          </span>
        );
      })}
      {shouldFold && (
        <span
          title={`更多能力：${hiddenLabels}`}
          className={`inline-flex items-center rounded-md border border-[var(--border)] bg-[var(--surface-muted)] font-medium text-[var(--text-secondary)] transition-colors ${sizeClasses}`}
        >
          +{hiddenCount}
        </span>
      )}
    </div>
  );
}
