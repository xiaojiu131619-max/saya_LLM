import { useState, type ReactNode } from 'react';
import { Play, Box, Layers, FolderSearch, Zap, Loader2, History, Eye, Brain, Wrench, Sparkles } from 'lucide-react';
import type { ModelInfo } from '@/types';
import { useApp } from '@/context/AppContext';
import { isDesktopRuntime, listenDesktopEvent, revealDesktopPath, startDesktopServer } from '@/lib/desktop';
import { getModelThemeGroup } from '@/lib/modelTheme';

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
    loaded: 'bg-[#34D399]',
    loading: 'bg-[#FBBF24]',
    error: 'bg-[#F87171]',
    standby: 'bg-[#BDB8AD]',
    downloading: 'bg-[#D06646]',
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
      <div
        style={{ animationDelay: `${Math.min(index * 10, 80)}ms` }}
        onClick={handleClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className={`anim-card-rise hover-rise model-glass-card group flex min-h-[48px] w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2 ${
          isHighlighted ? 'model-glass-card--active' : ''
        } ${model.status === 'loading' ? 'model-glass-card--loading' : ''}`}
      >
        <div className="relative flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[#EEEAE2]">
          <div
            className="absolute inset-0 rounded-full opacity-20"
            style={{ background: model.themeColorSolid }}
          />
          <span className="relative text-sm font-semibold" style={{ color: model.themeColorSolid }}>
            {themeGroup.icon}
          </span>
          <span
            className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[#FAF9F5] ${statusClass}`}
            title={statusLabel}
          />
        </div>

        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-[#2F2C26]">{model.name}</h3>
          <CompactPill>{model.params}</CompactPill>
          <CompactPill className="hidden sm:inline-flex">{model.quant}</CompactPill>
          <CompactPill className="hidden md:inline-flex">
            {model.modelType === 'moe' ? 'MoE' : '稠密'}
          </CompactPill>
          <span className="hidden lg:inline-flex">
            <CapabilityBadges model={model} dense />
          </span>
          {recentUsedAt && (
            <span
              className="hidden h-6 flex-shrink-0 items-center gap-1 rounded-md border border-[#E8C9BD] bg-[#FFF2EA]/80 px-2 text-[11px] leading-6 text-[#B76540] sm:inline-flex dark:border-[#E8C9BD]/30 dark:bg-[#3A241C]/80 dark:text-[#F0B18D]"
              title={recentTitle}
            >
              <History className="h-3 w-3" />
              最近使用
            </span>
          )}
          <CompactPill className="hidden lg:inline-flex">
            {model.avgTokensPerSec ? `${model.avgTokensPerSec.toFixed(1)} tok/s` : 'tok/s 暂无'}
          </CompactPill>
        </div>

        <div className="flex flex-shrink-0 items-center gap-1">
          {launchMemory && (
            <button
              onClick={(event) => void handleQuickLaunch(event)}
              disabled={!model.filePath || !isDesktopRuntime() || quickStarting}
              className="flex h-7 w-7 items-center justify-center rounded-lg border border-[#EACB71] bg-[#FFF7D7] text-[#B77800] transition-colors hover:bg-[#FFECA8] disabled:opacity-40"
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
              className="flex h-7 w-7 items-center justify-center rounded-lg border border-[#DCC6B9] bg-[#F8EDE7] transition-colors hover:bg-[#F2DED4]"
              title="开始对话"
            >
              <Play className="ml-0.5 h-3.5 w-3.5 text-[#D06646]" />
            </button>
          )}
          {model.filePath && (
            <button
              onClick={handleReveal}
              disabled={!isDesktopRuntime()}
              className="flex h-7 w-7 items-center justify-center rounded-lg border border-[#E2DED5] bg-[#F8F6F1] transition-colors hover:bg-[#EEEAE2] disabled:opacity-40"
              title="在资源管理器中显示"
            >
              <FolderSearch className="h-3.5 w-3.5 text-[#7D766B]" />
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      style={{ animationDelay: `${Math.min(index * 15, 80)}ms` }}
      onClick={handleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`anim-card-rise hover-rise-lg model-glass-card w-full cursor-pointer overflow-hidden rounded-xl ${
        isHighlighted ? 'model-glass-card--active' : ''
      } ${
        model.status === 'loading' ? 'model-glass-card--loading' : ''
      } ${
        isSingleColumn ? 'max-w-none self-stretch' : 'max-w-[360px] self-start'
      }`}
    >
      <div className={`border-b border-[#E5E1D8] ${isSingleColumn ? 'px-3 py-3' : 'p-4'}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div className={`relative flex flex-shrink-0 items-center justify-center rounded-full bg-[#EEEAE2] ${
              isSingleColumn ? 'h-10 w-10' : 'h-11 w-11'
            }`}>
              <div
                className="absolute inset-0 rounded-full opacity-20"
                style={{ background: model.themeColorSolid }}
              />
              <span className={`relative font-semibold ${isSingleColumn ? 'text-base' : 'text-lg'}`} style={{ color: model.themeColorSolid }}>
                {themeGroup.icon}
              </span>
            </div>
            <div className="min-w-0">
              <h3 className="truncate text-[15px] font-semibold text-[#2F2C26]">{model.name}</h3>
              <p className={`mt-1 text-xs leading-relaxed text-[#7D766B] ${isSingleColumn ? 'line-clamp-1' : 'line-clamp-2'}`}>
                {model.description}
              </p>
            </div>
          </div>
          <div className="flex flex-shrink-0 flex-col items-end gap-1">
            <div
              className="flex items-center gap-1.5 rounded-full border border-[#E2DED5] bg-[#F8F6F1]/80 px-2 py-1 dark:border-white/[0.08] dark:bg-white/[0.06]"
              title={statusLabel}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${statusClass}`} />
              <span className="text-[10px] font-medium text-[#7D766B]">{statusLabel}</span>
            </div>
            {recentUsedAt && (
              <div
                className="flex items-center gap-1 rounded-full border border-[#E8C9BD] bg-[#FFF2EA]/80 px-2 py-1 text-[10px] font-medium text-[#B76540] dark:border-[#E8C9BD]/30 dark:bg-[#3A241C]/80 dark:text-[#F0B18D]"
                title={recentTitle}
              >
                <History className="h-3 w-3" />
                <span>最近使用</span>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className={isSingleColumn ? 'px-3 py-3' : 'p-4'}>
        <div className={`grid grid-cols-2 gap-2 ${isSingleColumn ? 'hidden' : 'mb-4'}`}>
          <ModelMeta label="参数" value={model.params} />
          <ModelMeta label="量化" value={model.quant} />
          <ModelMeta label="大小" value={model.fileSize} />
          <ModelMeta label="上下文" value={formatCtx(model.ctxLength)} />
        </div>

        <div className={`flex flex-wrap items-center gap-2 ${isSingleColumn ? 'mb-3' : 'mb-3'}`}>
          <span className={`flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium ${
            model.modelType === 'moe'
              ? 'border-[#D9D3FF] bg-[#F2F0FF] text-[#6C5DD3]'
              : 'border-[#CFEADA] bg-[#EEF8F2] text-[#2C8B58]'
          }`}>
            {model.modelType === 'moe' ? <><Layers className="h-3 w-3" />MoE</> : <><Box className="h-3 w-3" />稠密</>}
          </span>
          {isSingleColumn && (
            <span className="rounded-md border border-[#E2DED5] bg-[#F8F6F1] px-2 py-1 text-[11px] text-[#7D766B]">
              {model.params}
            </span>
          )}
          {isSingleColumn && (
            <span className="rounded-md border border-[#E2DED5] bg-[#F8F6F1] px-2 py-1 text-[11px] text-[#7D766B]">
              {model.fileSize}
            </span>
          )}
          {!isSingleColumn && (
            <span className="rounded-md border border-[#E2DED5] bg-[#F8F6F1] px-2 py-1 text-[11px] text-[#7D766B]">
              {model.releaseDate}
            </span>
          )}
          <span className="rounded-md border border-[#E2DED5] bg-[#F8F6F1] px-2 py-1 text-[11px] text-[#7D766B]">
            {model.avgTokensPerSec ? `${model.avgTokensPerSec.toFixed(1)} tok/s` : 'tok/s 暂无'}
          </span>
        </div>

        <div className={`flex flex-wrap items-center gap-1 ${isSingleColumn ? 'mb-3' : 'mb-4'}`}>
          <CapabilityBadges model={model} dense={isSingleColumn} />
        </div>

        <div className={`flex items-center gap-2 ${isSingleColumn ? 'justify-end' : 'justify-between'}`}>
          <button className={`${isSingleColumn ? 'hidden' : 'rounded-md text-xs font-medium text-[#D06646] hover:underline'}`}>
            查看参数
          </button>
          <div className="flex flex-shrink-0 items-center gap-1">
            {launchMemory && (
              <button
                onClick={(event) => void handleQuickLaunch(event)}
                disabled={!model.filePath || !isDesktopRuntime() || quickStarting}
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#EACB71] bg-[#FFF7D7] text-[#B77800] transition-colors hover:bg-[#FFECA8] disabled:opacity-40"
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
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#DCC6B9] bg-[#F8EDE7] transition-colors hover:bg-[#F2DED4]"
                title="开始对话"
              >
                <Play className="ml-0.5 h-3.5 w-3.5 text-[#D06646]" />
              </button>
            )}
            {model.filePath && (
              <button
                onClick={handleReveal}
                disabled={!isDesktopRuntime()}
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#E2DED5] bg-[#F8F6F1] transition-colors hover:bg-[#EEEAE2] disabled:opacity-40"
                title="在资源管理器中显示"
              >
                <FolderSearch className="h-3.5 w-3.5 text-[#7D766B]" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ModelMeta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border border-[#E5E1D8] bg-[#F8F6F1] px-2.5 py-2">
      <div className="text-[10px] text-[#8D867A]">{label}</div>
      <div className="mono-font mt-0.5 truncate text-xs font-medium text-[#2F2C26]">{value}</div>
    </div>
  );
}

function CompactPill({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span className={`h-6 flex-shrink-0 items-center rounded-md border border-[#E2DED5] bg-[#F8F6F1] px-2 text-[11px] leading-6 text-[#7D766B] ${className}`}>
      {children}
    </span>
  );
}

type CapabilityKey = 'vision' | 'thinking' | 'tools' | 'reasoning' | 'mtp';

interface CapabilityDef {
  key: CapabilityKey;
  label: string;
  icon: typeof Eye;
  active: string;
  activeText: string;
  activeBorder: string;
}

const CAPABILITY_DEFS: CapabilityDef[] = [
  { key: 'vision',    label: '视觉', icon: Eye,      active: 'bg-[#E7F1F8]', activeText: 'text-[#2E6E9E]', activeBorder: 'border-[#BFD7E8]' },
  { key: 'thinking',  label: '思考', icon: Brain,    active: 'bg-[#F2EEFB]', activeText: 'text-[#6C5DD3]', activeBorder: 'border-[#D9D3FF]' },
  { key: 'tools',     label: '工具', icon: Wrench,   active: 'bg-[#EEF8F2]', activeText: 'text-[#2C8B58]', activeBorder: 'border-[#CFEADA]' },
  { key: 'reasoning', label: '推理', icon: Sparkles, active: 'bg-[#FFF2EA]', activeText: 'text-[#B76540]', activeBorder: 'border-[#E8C9BD]' },
  { key: 'mtp',       label: 'MTP',  icon: Sparkles, active: 'bg-[#EEF6FF]', activeText: 'text-[#2F6FB0]', activeBorder: 'border-[#C7DDF4]' },
];

function modelCapabilityFlags(model: ModelInfo): Record<CapabilityKey, boolean> {
  return {
    vision: !!model.supportsVision,
    thinking: !!model.supportsThinking,
    tools: !!model.supportsTools,
    reasoning: !!model.supportsReasoning,
    mtp: !!model.supportsMtp,
  };
}

function CapabilityBadges({ model, dense = false }: { model: ModelInfo; dense?: boolean }) {
  const flags = modelCapabilityFlags(model);
  const sizeClasses = dense
    ? 'h-5 px-1.5 text-[10px] gap-0.5'
    : 'h-6 px-2 text-[11px] gap-1';
  const iconSize = dense ? 'h-2.5 w-2.5' : 'h-3 w-3';

  return (
    <div className="flex flex-shrink-0 flex-wrap items-center gap-1">
      {CAPABILITY_DEFS.map((def) => {
        const Icon = def.icon;
        const on = flags[def.key];
        return (
          <span
            key={def.key}
            title={`${def.label}${on ? '：支持' : '：未检测到'}`}
            className={`inline-flex items-center rounded-md border transition-colors ${sizeClasses} ${
              on
                ? `${def.activeBorder} ${def.active} ${def.activeText} font-semibold dark:bg-white/[0.06]`
                : 'border-[#E5E1D8] bg-[#F4F1EA] text-[#B8B0A0] opacity-55 dark:border-white/[0.06] dark:bg-white/[0.03] dark:text-[#5C5447] dark:opacity-50'
            }`}
          >
            <Icon className={iconSize} />
            <span>{def.label}</span>
          </span>
        );
      })}
    </div>
  );
}
