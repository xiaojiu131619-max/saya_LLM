import { useRef, useState, type ReactNode } from 'react';
import { Play, Box, Boxes, FolderSearch, Zap, Loader2, History, Eye, Brain, Wrench, Sparkles, Mic, Film, Layers } from 'lucide-react';
import type { ModelInfo } from '@/types';
import { useApp } from '@/context/AppContext';
import { isDesktopRuntime, listenDesktopEvent, revealDesktopPath, startDesktopServer } from '@/lib/desktop';
import { modelVideoSupport, videoSupportTitle } from '@/lib/modelCapabilities';
import { getModelThemeGroup } from '@/lib/modelTheme';
import ModelFamilyLogo from '@/components/ModelFamilyLogo';
import ModelLineField from '@/components/ModelLineField';

interface ModelCardProps {
  model: ModelInfo;
  index: number;
  isSingleColumn?: boolean;
  recentUsedAt?: number;
  /** 卡片过多时关掉线场动效，只保留静态首帧（D-39）。 */
  allowLineFieldAnimation?: boolean;
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

export default function ModelCard({ model, index, isSingleColumn = false, recentUsedAt, allowLineFieldAnimation = true }: ModelCardProps) {
  const { state, dispatch } = useApp();
  const [quickStarting, setQuickStarting] = useState(false);
  const logoRef = useRef<HTMLSpanElement | null>(null);
  const themeGroup = getModelThemeGroup(model);
  const launchMemory = state.modelLaunchMemories[model.id];
  const isHighlighted = state.selectedModelId === model.id;
  const recentTitle = recentUsedAt ? `最近使用：${formatRecentUsedAt(recentUsedAt)}` : undefined;
  const isBusy = quickStarting || model.status === 'loading' || model.status === 'downloading';

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleClick();
    }
  };

  const handleClick = () => {
    dispatch({ type: 'SET_SELECTED_MODEL', payload: model.id });
    dispatch({ type: 'SET_VIEW', payload: 'modelLoad' });
  };

  const handleQuickChat = (e: React.MouseEvent) => {
    e.stopPropagation();
    dispatch({ type: 'MARK_MODEL_RECENTLY_USED', payload: { modelId: model.id } });
    dispatch({ type: 'ACTIVATE_MODEL', payload: model.id });
    dispatch({ type: 'SET_VIEW', payload: 'chat' });
  };

  const handleQuickLaunch = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!launchMemory) return;

    if (model.status === 'loaded') {
      dispatch({ type: 'MARK_MODEL_RECENTLY_USED', payload: { modelId: model.id } });
      dispatch({ type: 'ACTIVATE_MODEL', payload: model.id });
      dispatch({ type: 'SET_VIEW', payload: 'chat' });
      return;
    }

    if (!isDesktopRuntime() || !model.filePath || isBusy) return;

    const rememberedModel = { ...model, loadConfig: launchMemory.config };
    const unlisteners: Array<() => void> = [];
    setQuickStarting(true);
    dispatch({ type: 'UPDATE_MODEL_STATUS', payload: { modelId: model.id, status: 'loading' } });
    dispatch({ type: 'UPDATE_MODEL_CONFIG', payload: { modelId: model.id, config: launchMemory.config } });
    dispatch({ type: 'SET_APP_STATUS', payload: `正在使用记忆参数快速启动 ${model.name}...` });

    try {
      let resolveReady: () => void = () => {};
      let rejectReady: (error: Error) => void = () => {};
      const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      await Promise.all([
        listenDesktopEvent<{ message?: string }>('server:ready', () => resolveReady())
          .then((unlisten) => unlisteners.push(unlisten)),
        listenDesktopEvent<{ title?: string; details?: string }>('server:error', (error) => {
          rejectReady(new Error(error.title || error.details || 'llama-server 启动失败'));
        }).then((unlisten) => unlisteners.push(unlisten)),
      ]);

      await startDesktopServer(rememberedModel, state.serverPort, 'resources/llama-server.exe', state.apiConfig, state.chatConfig.enabledTools);
      await ready;

      dispatch({ type: 'REMEMBER_MODEL_LAUNCH_CONFIG', payload: { modelId: model.id, config: launchMemory.config } });
      dispatch({ type: 'MARK_MODEL_RECENTLY_USED', payload: { modelId: model.id } });
      dispatch({ type: 'ACTIVATE_MODEL', payload: model.id });
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
    // 单行紧凑布局：图标 + 名称 + 类型 + 大小 + 量化 + 能力标签 + 速度 + 最近使用 + 操作按钮，全部一行。
    // 整卡可点进入参数页，操作按钮自行 stopPropagation；名字过长时截断让位，其余信息项恒可见。
    return (
      <article
        style={{ animationDelay: `${Math.min(index * 10, 80)}ms` }}
        role="button"
        tabIndex={0}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        aria-label={`打开 ${model.name} 的加载参数`}
        className={`anim-card-rise model-glass-card group flex min-h-[52px] w-full cursor-pointer items-center gap-2 px-3 py-1.5 ${
          isHighlighted ? 'model-glass-card--active' : ''
        } ${model.status === 'loading' ? 'model-glass-card--loading' : ''}`}
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

        <span
          className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--text-primary)] dark:text-[var(--text-primary)]"
          title={model.name}
        >
          {model.name}
        </span>

        <CompactPill>
          {model.modelType === 'moe' ? 'MoE' : '稠密'}
        </CompactPill>
        <ModelTaskPill model={model} />
        <CompactPill title={`${model.params} · ${model.fileSize}`}>
          <span className="hidden sm:inline">{model.params} · </span>{model.fileSize}
        </CompactPill>
        <CompactPill className="hidden md:inline-flex">{model.quant}</CompactPill>

        <span className="hidden min-[1000px]:inline-flex">
          <CapabilityBadges model={model} dense onlyActive />
        </span>
        {model.avgTokensPerSec ? (
          <CompactPill title="历史平均生成速度" className="hidden lg:inline-block">
            {model.avgTokensPerSec.toFixed(1)} tok/s
          </CompactPill>
        ) : null}
        {recentUsedAt && (
          <span
            className="hidden h-6 flex-shrink-0 items-center gap-1 rounded-md border border-[var(--state-danger-border)] bg-[var(--state-danger-bg)]/80 px-2 text-[length:var(--font-eyebrow)] leading-6 text-[var(--state-warning)] dark:border-[var(--state-danger-border)]/30 dark:bg-[var(--surface-raised)]/80 dark:text-[var(--accent)]"
            title={recentTitle}
          >
            <History className="h-3 w-3" />
            最近使用
          </span>
        )}

        <span className="ml-auto flex flex-shrink-0 items-center gap-1">
          {launchMemory && model.status !== 'loaded' && (
            <button
              onClick={(event) => void handleQuickLaunch(event)}
              disabled={!model.filePath || !isDesktopRuntime() || isBusy}
              className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--state-warning-border)] bg-[var(--state-warning-bg)] text-[var(--state-warning)] transition-colors hover:bg-[var(--state-warning-bg)] disabled:opacity-40"
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
              className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--state-danger-border)] bg-[var(--state-danger-bg)] transition-colors hover:bg-[var(--state-danger-border)]"
              title="开始对话"
            >
              <Play className="ml-0.5 h-3.5 w-3.5 text-[var(--accent)]" />
            </button>
          )}
          {model.filePath && (
            <button
              onClick={handleReveal}
              disabled={!isDesktopRuntime()}
              className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--surface-muted)] transition-colors hover:bg-[var(--border)] disabled:opacity-40"
              title="在资源管理器中显示"
            >
              <FolderSearch className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
            </button>
          )}
        </span>
      </article>
    );
  }

  // 卡片模式：3:4 整卡线场 + 底部文字浮层 + 右上角快速启动角标。
  // 线场是卡片唯一的图形层，文字与操作全部压在它上面。
  const cardTint = model.themeColorSolid;
  const quickLabel = isBusy
    ? (quickStarting ? '启动中' : statusLabel)
    : model.status === 'loaded'
      ? '开始对话'
      : launchMemory
        ? '记忆启动'
        : '快速启动';
  const quickAction = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (isBusy) return;
    if (model.status === 'loaded') {
      handleQuickChat(event);
      return;
    }
    if (launchMemory) {
      void handleQuickLaunch(event);
      return;
    }
    handleClick();
  };
  return (
    <article
      style={{
        animationDelay: `${Math.min(index * 15, 80)}ms`,
        background: isHighlighted
          ? `color-mix(in srgb, ${cardTint} 14%, var(--surface))`
          : `color-mix(in srgb, ${cardTint} 7%, var(--surface))`,
      }}
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      aria-label={`打开 ${model.name} 的加载参数`}
      className={`anim-card-rise model-tile relative flex aspect-[3/4] min-w-0 w-full cursor-pointer flex-col overflow-hidden ${
        isHighlighted ? 'model-tile--selected' : ''
      } ${model.status === 'loaded' ? 'model-tile--loaded' : ''}`}
    >
      <ModelLineField
        target={logoRef}
        color={cardTint}
        allowAnimation={allowLineFieldAnimation}
      />

      <div className="relative z-[1] flex h-full flex-col p-3">
        <div className="flex items-start justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1">
            <span
              className={`model-tile-status model-tile-status--${model.status} inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] px-1.5 py-0.5 text-xs`}
              role="status"
            >
              {model.status === 'loading' ? (
                <Loader2 className="h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none" />
              ) : (
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusClass}`} aria-hidden="true" />
              )}
              {statusLabel}
            </span>
            {model.isDynamicQuant && (
              <span
                className="grid h-6 w-6 flex-shrink-0 place-items-center rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] text-[var(--accent)]"
                title="动态量化（UD）"
                aria-label="动态量化模型"
              >
                <Box className="h-3.5 w-3.5" />
              </span>
            )}
            {model.filePath && (
              <button
                type="button"
                onClick={handleReveal}
                disabled={!isDesktopRuntime()}
                className="grid h-6 w-6 flex-shrink-0 place-items-center rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-40"
                title="在资源管理器中显示"
                aria-label="在资源管理器中显示"
              >
                <FolderSearch className="h-3.5 w-3.5" />
              </button>
            )}
          </span>
        </div>

        <div className="flex-1" />

        <div className="relative mt-auto">
          {/* 文字浮层：用主题色向 surface 过渡的渐变压住线场，保证名称可读，又不遮住上方标志。 */}
          <div
            className="pointer-events-none absolute -inset-x-3 -bottom-3 h-24"
            style={{
              background: `linear-gradient(to top, color-mix(in srgb, ${cardTint} 14%, var(--surface)) 0%, color-mix(in srgb, ${cardTint} 10%, var(--surface)) 58%, transparent 100%)`,
            }}
          />
          {/* 下挂：名称 + 快速启动，卡片其余区域只留动态量化图标。 */}
          <div className="relative flex min-w-0 items-center gap-2">
            <h3
              className="line-clamp-2 min-w-0 flex-1 text-sm font-semibold leading-tight text-[var(--text-primary)] [overflow-wrap:anywhere]"
              title={model.name}
            >
              {model.name}
            </h3>
            {recentUsedAt && (
              <History className="h-3 w-3 shrink-0 text-[var(--accent)]" aria-label={recentTitle} />
            )}
            <button
              type="button"
              onClick={quickAction}
              disabled={isBusy || (!model.filePath && model.status !== 'loaded')}
              className={`grid h-9 w-9 flex-shrink-0 place-items-center rounded-[var(--radius-pill)] border transition-[transform,background-color,border-color] duration-150 ease-out hover:-translate-y-px active:scale-95 disabled:opacity-45 ${
                isBusy
                  ? 'border-[var(--surface-muted)] bg-[var(--surface-muted)] text-[var(--text-secondary)]'
                  : model.status === 'loaded'
                    ? 'border-transparent bg-[var(--accent)] text-[var(--text-on-accent)]'
                    : launchMemory
                      ? 'border-[var(--state-warning-border)] bg-[var(--state-warning-bg)] text-[var(--state-warning)]'
                      : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] hover:border-[var(--accent)]'
              }`}
              title={quickLabel}
              aria-label={quickLabel}
            >
              {isBusy ? (
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
              ) : model.status === 'loaded' ? (
                <Play className="h-4 w-4" />
              ) : launchMemory ? (
                <Zap className="h-4 w-4" />
              ) : (
                <Play className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* 只承担采样：真正的品牌标志由 60×30 线场用粗细不同的竖线画出。 */}
      <span
        ref={logoRef}
        className="pointer-events-none absolute left-1/2 top-1/2 h-px w-px -translate-x-1/2 -translate-y-1/2 overflow-hidden opacity-0"
        aria-hidden="true"
      >
        <ModelFamilyLogo
          family={model.family}
          architecture={model.architecture}
          name={model.name}
          size={48}
          customSrc={model.customLogo}
          tone={cardTint}
          fallback={<span className="text-xl font-semibold" style={{ color: cardTint }}>{themeGroup.icon}</span>}
        />
      </span>
    </article>
  );
}

function CompactPill({ children, className = '', title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={`inline-flex h-6 flex-shrink-0 items-center rounded-md border border-[var(--border)] bg-[var(--surface-muted)] px-2 text-[length:var(--font-eyebrow)] leading-6 text-[var(--text-secondary)] ${className}`}>
      {children}
    </span>
  );
}

function ModelTaskPill({ model }: { model: ModelInfo }) {
  const task = model.modelTask;
  if (!task || task === 'chat') return null;
  const isRerank = task === 'rerank';
  return (
    <span
      title={isRerank
        ? '重排模型：走独立向量服务（--rerank），可与对话 / VLM 模型同时运行'
        : '向量嵌入模型：走独立向量服务（--embeddings），可与对话 / VLM 模型同时运行'}
      className={`inline-flex h-6 flex-shrink-0 items-center gap-1 rounded-md border px-2 text-[length:var(--font-eyebrow)] font-semibold leading-6 ${
        isRerank
          ? 'border-[var(--accent-subtle)] bg-[var(--accent-subtle)] text-[var(--accent)]'
          : 'border-[var(--state-success-border)] bg-[var(--state-success-bg)] text-[var(--state-success)]'
      }`}
    >
      {isRerank ? <Layers className="h-3 w-3" /> : <Boxes className="h-3 w-3" />}
      {isRerank ? '重排' : '向量'}
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
  { key: 'video',     label: '视频', icon: Film,     active: 'bg-[var(--state-warning-bg)]', activeText: 'text-[var(--state-warning)]', activeBorder: 'border-[var(--state-warning-border)]' },
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
    ? 'h-5 px-1.5 text-[length:var(--font-micro)] gap-0.5'
    : 'h-6 px-2 text-[length:var(--font-eyebrow)] gap-1';
  const iconSize = dense ? 'h-2.5 w-2.5' : 'h-3 w-3';
  const activeDefs = CAPABILITY_DEFS.filter((def) => states[def.key] === 'on' || states[def.key] === 'partial');
  // 磁贴（twoLine）与单列都只展示激活的能力：灰色"未检测到"占位格在总览卡片里没有
  // 信息量，全量 9 个格子还会把标签文字挤压成竖排折行。
  const visibleDefs = onlyActive || twoLine ? activeDefs : CAPABILITY_DEFS;

  // 磁贴最多显示 5 个标签，给较长的“视频候选”和折叠计数留出空间。
  const MAX_SHOWN = dense && !twoLine ? 3 : twoLine ? 5 : 4;
  const shouldFold = visibleDefs.length > MAX_SHOWN;
  const displayedDefs = shouldFold ? visibleDefs.slice(0, MAX_SHOWN - 1) : visibleDefs;
  const hiddenCount = shouldFold ? visibleDefs.length - (MAX_SHOWN - 1) : 0;
  const hiddenLabels = shouldFold ? visibleDefs.slice(MAX_SHOWN - 1).map((d) => d.label).join('、') : '';

  // 只展示激活标签（单列 / 磁贴）时没有命中的能力，直接不渲染（避免空占位挤压排版）。
  if ((onlyActive || twoLine) && visibleDefs.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-shrink-0 flex-wrap items-center gap-1">
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
            className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-md border transition-colors ${sizeClasses} ${
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
