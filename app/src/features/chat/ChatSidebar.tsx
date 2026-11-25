import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowLeftRight,
  Bot,
  CheckSquare,
  ChevronDown,
  Download,
  FolderOpen,
  FolderPlus,
  Globe2,
  Loader2,
  MessageSquare,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  Sparkles,
  Trash2,
} from 'lucide-react';
import BrandLogo from '@/components/BrandLogo';
import ConfirmDialog from '@/components/ConfirmDialog';
import EmptyState from '@/components/EmptyState';
import ThemeToggleButton from '@/components/ThemeToggleButton';
import RuntimeStatusCard, { type StatusMetric } from '@/components/RuntimeStatusCard';
import { useResizableWidth } from '@/hooks/useResizableWidth';
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from '@/context/AppContext';
import { useVirtualizer } from '@tanstack/react-virtual';
import { chatScopeProfile } from '@/features/chat/chatScope';
import type { ChatScope, ChatSession, ModelInfo, ThemeType } from '@/types';

/** 窄窗口抽屉的固定宽度：比内联的 208px 宽一点，抽屉浮在内容上不占布局，可读性优先。 */
const DRAWER_WIDTH = 280;

/** 会话总数超过该阈值才启用虚拟列表；小列表保留原有动画与分组间距。 */
const VIRTUALIZE_SESSION_THRESHOLD = 40;

/** 会话行的搜索结果（模糊命中 + 对话内文本命中）。 */
export interface SessionSearchHit {
  sessionId: string;
  /** 标题命中时的高亮区间（用于标题着色）。 */
  titleMatched: boolean;
  /** 命中处的一句上下文摘要；只有正文命中时才有。 */
  snippet?: string;
}

interface ChatSidebarProps {
  activeModel?: ModelInfo;
  canChat: boolean;
  /** 当前对话归属：主对话 / Agent 工作区。 */
  scope: ChatScope;
  /** Agent 工作区列表（仅 Pi 工作区显示切换栏）。 */
  workspaces?: Array<{ id: string; name: string; path: string }>;
  activeWorkspaceId?: string;
  onSelectWorkspace?: (workspaceId: string) => void;
  onPickWorkspace?: () => void;
  onOpenSkills?: () => void;
  /** 从侧边栏直达右侧工作面板的某个 tab（文件 / 浏览器）。 */
  onOpenWorkPanel?: (tab: 'files' | 'browser') => void;
  /**
   * 引擎后端身份（主对话切到 NiNfer / Strata 时非空）。
   * 身份区跟随引擎显示；不传则按 GGUF 模型显示。
   */
  engineIdentity?: { label: string; displayName: string; serviceable: boolean } | null;
  /** 引擎模式下点身份卡的去处（对应引擎专页）。 */
  onOpenEnginePage?: () => void;
  /** 两段式切换回调（主对话 ↔ Agent 工作区）。 */
  onSelectScope: (scope: ChatScope) => void;
  collapsed: boolean;
  collapseLocked?: boolean;
  /** 窄窗口抽屉模式：固定宽度、无拖拽手柄，由外部容器负责定位与遮罩。 */
  drawer?: boolean;
  /** 展开态允许的最大宽度（默认 SIDEBAR_MAX_WIDTH）。窄窗口下由调用方压到 208px。 */
  maxWidth?: number;
  selectionMode: boolean;
  selectedSessionIds: Set<string>;
  sessionSearch: string;
  sessionGroups: Array<[string, ChatSession[]]>;
  activeSessionId?: string;
  /** 搜索结果表：sessionId → 命中信息（有搜索词时才有值）。 */
  searchHits?: Map<string, SessionSearchHit>;
  onSearchChange: (value: string) => void;
  onNewSession: () => void;
  onSelectionMode: () => void;
  onDeleteSelectedSessions: () => void;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onExportSession: (sessionId: string) => void;
  /** 用模型重新总结会话标题（右键菜单项）。 */
  onRegenerateTitle: (sessionId: string) => void;
  /** 正在生成标题的会话，用于在行内与菜单里显示转圈。 */
  titleBusyIds: Set<string>;
  onOpenGlobalSettings: () => void;
  onOpenModelLoad: () => void;
  onToggleTheme: () => void;
  onToggleCollapse: () => void;
  onResize: (width: number) => void;
  theme: ThemeType;
  sidebarWidth: number;
  ctxPercent?: number;
  vramPercent?: number;
  ramPercent?: number;
  gpuPercent?: number;
}

export default function ChatSidebar({
  activeModel,
  canChat,
  scope,
  workspaces = [],
  activeWorkspaceId,
  onSelectWorkspace,
  onPickWorkspace,
  onOpenSkills,
  onOpenWorkPanel,
  engineIdentity = null,
  onOpenEnginePage,
  onSelectScope,
  collapsed,
  collapseLocked = false,
  drawer = false,
  maxWidth = SIDEBAR_MAX_WIDTH,
  selectionMode,
  selectedSessionIds,
  sessionSearch,
  sessionGroups,
  activeSessionId,
  searchHits,
  onSearchChange,
  onNewSession,
  onSelectionMode,
  onDeleteSelectedSessions,
  onSelectSession,
  onDeleteSession,
  onExportSession,
  onRegenerateTitle,
  titleBusyIds,
  onOpenGlobalSettings,
  onOpenModelLoad,
  onToggleTheme,
  onToggleCollapse,
  onResize,
  theme,
  sidebarWidth,
  ctxPercent,
  vramPercent,
  ramPercent,
  gpuPercent,
}: ChatSidebarProps) {
  const expandedTransition = { duration: 0.18, ease: [0.16, 1, 0.3, 1] as const };
  // 引擎模式下身份区跟随后端走：显示引擎名与启动状态，点击进引擎专页。
  const engineMode = Boolean(engineIdentity);
  const modelStatusLabel = canChat
    ? '可用'
    : engineIdentity
      ? '未启动'
      : activeModel
        ? '已加载'
        : '未加载';
  const modelStatusDotClass = canChat
    ? 'bg-[var(--state-success)]'
    : engineIdentity
      ? 'bg-[var(--text-tertiary)]'
      : activeModel
        ? 'bg-[var(--accent)]'
        : 'bg-[var(--text-tertiary)]';
  const scopeProfile = chatScopeProfile(scope);
  const nextScope: ChatScope = scope === 'main' ? 'pi' : 'main';
  const scopeSwitchLabel = scope === 'main' ? '切换到 Pi 工作区' : '切换到主对话';
  const selectionActionLabel = selectionMode
    ? selectedSessionIds.size > 0
      ? `删除已选的 ${selectedSessionIds.size} 个对话`
      : '取消多选'
    : '多选删除';
  const expandedMotion = {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition: expandedTransition,
  };

  // 折叠时固定为图标栏宽度；展开时可拖拽。
  const resizer = useResizableWidth({
    value: sidebarWidth,
    onChange: onResize,
    min: SIDEBAR_MIN_WIDTH,
    max: maxWidth,
  });
  const renderedWidth = drawer ? DRAWER_WIDTH : collapsed ? 64 : resizer.width;
  // 内容按实际宽度重排而不是简单隐藏：窄侧边栏收起状态卡的细节文字，
  // 只留运行状态卡的核心读数（卡片自身的 2×2 / 1×4 由容器查询决定）。
  const narrow = !collapsed && renderedWidth < 260;

  // 会话右键菜单：坐标取指针位置，节点渲染到 body——侧边栏是 overflow-hidden 的，
  // 菜单若留在 DOM 树里会被裁成一条。任何点击 / Esc / 滚动都关闭。
  const [contextMenu, setContextMenu] = useState<{ session: ChatSession; x: number; y: number } | null>(null);
  // 工作区下拉（仅 Pi 工作区使用）：列出已绑定文件夹 + 新建入口。
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  // 抽屉模式下把焦点移进侧栏：Esc 与 Tab 才能立刻作用在抽屉内，而不是留在页头按钮上。
  const asideRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (drawer) asideRef.current?.focus();
  }, [drawer]);
  // 批量删除仍需二次确认（一次影响多条，误触代价大）；单条删除改为「立即删除 + 撤销条」，
  // 少一步打断，误删也能一键恢复。
  const [pendingBulkDeleteCount, setPendingBulkDeleteCount] = useState<number | null>(null);
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [contextMenu]);

  // 状态卡四项（固定顺序：ctx → 显存 → 内存 → GPU）。
  // 无数据的项也保留格子并显示 `--`，四项位置不会因为某项缺失而跳动。
  const statusMetrics: StatusMetric[] = [
    { label: 'ctx', percent: ctxPercent, detail: '当前会话水位 / 后端上下文容量', color: 'var(--state-success)' },
    { label: '显存', percent: vramPercent, detail: '整卡已用 / 总量', color: 'var(--status-loading)' },
    { label: '内存', percent: ramPercent, detail: '系统内存占用', color: 'var(--accent)' },
    { label: 'GPU', percent: gpuPercent, detail: 'GPU 利用率', color: 'var(--status-loaded)' },
  ];

  // 会话列表虚拟化：会话超过阈值时启用。分组标题也作为一行参与虚拟化，
  // 否则滚动到中段时标题会错位；小列表保留原有动画与分组间距。
  type FlatSessionRow = { kind: 'header'; label: string } | { kind: 'session'; session: ChatSession };
  const flatRows = useMemo<FlatSessionRow[]>(() => {
    const rows: FlatSessionRow[] = [];
    for (const [label, sessions] of sessionGroups) {
      rows.push({ kind: 'header', label });
      for (const session of sessions) rows.push({ kind: 'session', session });
    }
    return rows;
  }, [sessionGroups]);
  const virtualizeSessions = !collapsed && flatRows.length > VIRTUALIZE_SESSION_THRESHOLD;
  const sessionListRef = useRef<HTMLDivElement>(null);
  // 与 ChatPage 的消息列表同一处理：@tanstack/react-virtual 返回带可变方法的实例，
  // React Compiler 无法安全 memo，eslint 报 incompatible-library。这是库的用法限制，
  // 不是可绕开的写法问题；副作用仅限于本组件跳过记忆化编译。
  // eslint-disable-next-line react-hooks/incompatible-library -- 库返回可变实例，编译器无法安全 memo
  const sessionVirtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => sessionListRef.current,
    estimateSize: (index) => (flatRows[index]?.kind === 'header' ? 30 : 46),
    overscan: 8,
  });
  // 搜索词变化后回到顶部，避免停在上一次结果的中段。
  useEffect(() => {
    if (virtualizeSessions) sessionListRef.current?.scrollTo({ top: 0 });
  }, [sessionSearch, virtualizeSessions]);

  const renderSessionRow = (session: ChatSession, flatIndex?: number) => (
    <SessionRow
      key={session.id}
      session={session}
      selected={session.id === activeSessionId}
      checked={selectedSessionIds.has(session.id)}
      collapsed={false}
      compact={narrow}
      selectionMode={selectionMode}
      hit={searchHits?.get(session.id)}
      query={sessionSearch}
      titleBusy={titleBusyIds.has(session.id)}
      dataIndex={flatIndex}
      onSelect={onSelectSession}
      onDelete={() => onDeleteSession(session.id)}
      onExport={onExportSession}
      onContextMenu={(event, target) => {
        event.preventDefault();
        setContextMenu({ session: target, x: event.clientX, y: event.clientY });
      }}
    />
  );

  /** 从某个扁平索引出发，沿方向找下一个会话行（跳过分组标题）。 */
  const findSessionFlatIndex = (start: number, step: 1 | -1) => {
    for (let index = start; index >= 0 && index < flatRows.length; index += step) {
      if (flatRows[index].kind === 'session') return index;
    }
    return -1;
  };

  /** 虚拟列表里滚动到某一行后再聚焦（该行可能还没渲染）。 */
  const focusSessionRowAt = (flatIndex: number) => {
    const button = sessionListRef.current?.querySelector<HTMLButtonElement>(`[data-session-index="${flatIndex}"]`);
    if (!button) return false;
    button.focus({ preventScroll: false });
    return true;
  };

  const handleSessionListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-session-row]'));
    if (buttons.length === 0) return;
    event.preventDefault();
    const step: 1 | -1 = event.key === 'ArrowDown' ? 1 : -1;
    const activeIndex = buttons.findIndex((button) => button === document.activeElement);

    if (virtualizeSessions) {
      const currentFlat = activeIndex >= 0 ? Number(buttons[activeIndex].dataset.sessionIndex ?? '-1') : -1;
      let targetFlat: number;
      if (event.key === 'Home') targetFlat = findSessionFlatIndex(0, 1);
      else if (event.key === 'End') targetFlat = findSessionFlatIndex(flatRows.length - 1, -1);
      else if (currentFlat < 0) targetFlat = findSessionFlatIndex(0, 1);
      else targetFlat = findSessionFlatIndex(currentFlat + step, step);
      if (targetFlat < 0) return;
      // 目标可能在虚拟窗口之外：先滚过去，下一帧再聚焦。
      if (!focusSessionRowAt(targetFlat)) {
        sessionVirtualizer.scrollToIndex(targetFlat, { align: step > 0 ? 'end' : 'start' });
        window.requestAnimationFrame(() => focusSessionRowAt(targetFlat));
      }
      return;
    }

    let targetIndex = 0;
    if (event.key === 'Home') targetIndex = 0;
    else if (event.key === 'End') targetIndex = buttons.length - 1;
    else if (activeIndex < 0) targetIndex = step > 0 ? 0 : buttons.length - 1;
    else targetIndex = Math.min(buttons.length - 1, Math.max(0, activeIndex + step));
    const target = buttons[targetIndex];
    target?.focus();
    target?.scrollIntoView({ block: 'nearest' });
  };

  // 虚拟列表的分组标题：滚动到中段时分组头已经滚出视口，
  // 这里用一条吸顶覆盖层显示「当前看到的会话属于哪一组」。
  // 第一个可见行本身就是分组标题时不叠加，避免两层文字重叠。
  const virtualItems = virtualizeSessions ? sessionVirtualizer.getVirtualItems() : [];
  const firstVisible = virtualItems.find((item) => item.end > (sessionVirtualizer.scrollOffset ?? 0));
  let activeGroupLabel = '';
  if (virtualizeSessions && firstVisible && flatRows[firstVisible.index]?.kind !== 'header') {
    for (let index = firstVisible.index; index >= 0; index -= 1) {
      const row = flatRows[index];
      if (row.kind === 'header') {
        activeGroupLabel = row.label;
        break;
      }
    }
  }

  return (
    <motion.aside
      ref={asideRef}
      tabIndex={drawer ? -1 : undefined}
      initial={drawer ? { x: -16, opacity: 0 } : false}
      animate={{ width: renderedWidth, x: 0, opacity: 1 }}
      // 拖拽期间必须瞬时跟随，否则手感和指针脱节；松手后才走原来的展开/收起过渡。
      transition={resizer.dragging ? { duration: 0 } : { duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className={
        drawer
          ? 'relative flex h-full min-h-0 flex-col overflow-hidden border-r border-[var(--border-subtle)] bg-[var(--surface-muted)] shadow-2xl focus:outline-none'
          : 'relative hidden min-h-0 flex-shrink-0 flex-col overflow-hidden border-r border-[var(--border-subtle)] bg-[var(--surface-muted)] will-change-[width] dark:border-[var(--border-subtle)] dark:bg-[var(--surface-muted)] md:flex'
      }
      style={collapsed ? undefined : { minWidth: drawer ? DRAWER_WIDTH : SIDEBAR_MIN_WIDTH, maxWidth: drawer ? DRAWER_WIDTH : maxWidth }}
    >
      {/* 拖拽分隔条：贴住右边缘，宽度 5px，视觉上只在悬停/拖拽时显形。
          不占用布局空间（absolute），因此不会挤压内容。 */}
      {!collapsed && !drawer && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整侧边栏宽度"
          aria-valuenow={Math.round(renderedWidth)}
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={Math.round(maxWidth)}
          title="拖动调整侧边栏宽度（双击恢复默认）"
          onDoubleClick={() => onResize(288)}
          className={`absolute inset-y-0 right-0 z-20 w-[5px] cursor-col-resize touch-none transition-colors ${
            resizer.dragging ? 'bg-[var(--accent)]/55' : 'hover:bg-[var(--accent)]/35'
          }`}
          {...resizer.handleProps}
        />
      )}

      <button
        onClick={onToggleCollapse}
        disabled={collapseLocked}
        className="absolute left-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-transparent text-[var(--text-tertiary)] transition-[background-color,color] duration-200 hover:bg-black/[0.07] disabled:cursor-default disabled:opacity-60 dark:text-[var(--text-secondary)] dark:hover:bg-[var(--surface-raised)]"
        title={drawer ? '关闭会话列表' : collapseLocked ? '窄窗口下侧边栏保持折叠' : collapsed ? '展开侧边栏' : '折叠侧边栏'}
        aria-label={drawer ? '关闭会话列表' : collapseLocked ? '窄窗口下侧边栏保持折叠' : collapsed ? '展开侧边栏' : '折叠侧边栏'}
      >
        {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
      </button>

      <div className={`pb-3 pt-14 ${narrow ? 'px-2' : 'px-2.5'}`}>
        <div className={`flex min-w-0 items-center gap-3 ${collapsed ? 'pb-1' : 'pb-4'}`}>
          {/* 这颗头像就是对话归属开关：主对话显示模型头像，Pi 工作区显示 Pi 图标。
              点一下在 Chat 与 Pi 两个会话空间之间切换，不再另做胶囊分段。 */}
          <button
            type="button"
            onClick={() => onSelectScope(nextScope)}
            className={`relative grid h-10 w-10 flex-shrink-0 place-items-center rounded-[var(--radius-field)] text-[length:var(--font-body)] font-semibold transition-colors ${
              scope === 'main'
                ? 'bg-black/[0.045] text-[var(--text-primary)] hover:bg-black/[0.075] dark:bg-white/[0.055] dark:text-[var(--accent)] dark:hover:bg-[var(--surface-raised)]'
                : 'bg-[var(--accent-subtle)] text-[var(--accent)] hover:bg-[var(--accent)]/15'
            }`}
            title={`${scopeSwitchLabel}（当前：${scopeProfile.label}）`}
            aria-label={scopeSwitchLabel}
          >
            {scope === 'main'
              ? engineIdentity
                ? engineIdentity.label.slice(0, collapsed ? 1 : 2).toUpperCase()
                : collapsed
                  ? (activeModel?.family?.[0]?.toUpperCase() ?? <BrandLogo size={18} />)
                  : (activeModel?.family?.slice(0, 2).toUpperCase() ?? <BrandLogo size={20} />)
              : <Bot className="h-[18px] w-[18px]" />}
            <span
              aria-hidden="true"
              className="absolute -bottom-0.5 -right-0.5 grid h-4 w-4 place-items-center rounded-full border border-[var(--surface-muted)] bg-[var(--surface)] text-[var(--text-tertiary)] shadow-sm"
            >
              <ArrowLeftRight className="h-2.5 w-2.5" />
            </span>
          </button>
          <AnimatePresence initial={false}>
            {!collapsed && (
              <motion.div {...expandedMotion} className="min-w-0 flex-1">
                <div className="truncate text-[length:var(--font-body)] font-semibold text-[var(--text-primary)]">
                  {scopeProfile.label}
                </div>
                <div className="truncate text-[length:var(--font-caption)] text-[var(--text-tertiary)]">
                  {scope === 'main'
                    ? engineIdentity
                      ? canChat
                        ? engineIdentity.displayName
                        : `${engineIdentity.label} 引擎未启动`
                      : canChat
                        ? activeModel?.name ?? '模型已连接'
                        : '模型未连接'
                    : 'Pi 内核 · 独立会话'}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <button
          onClick={onNewSession}
          className={`flex h-9 items-center gap-2 rounded-[var(--radius-field)] bg-black/[0.055] text-[length:var(--font-body)] font-medium text-[var(--text-primary)] transition-[width,background-color,color] duration-200 hover:bg-black/[0.085] dark:bg-white/[0.065] dark:hover:bg-[var(--surface-raised)] ${
            collapsed ? 'w-10 justify-center px-0' : 'w-full justify-start px-3'
          }`}
          title="新建对话"
        >
          <MessageSquarePlus className="h-4 w-4" />
          <AnimatePresence initial={false}>
            {!collapsed && <motion.span {...expandedMotion}>新建对话</motion.span>}
          </AnimatePresence>
        </button>

        {/* 工作区：Agent 对话的真实本地文件夹。只有这个文件夹内的文件/命令
            享有 Pi 的高权限，切换工作区即切换目录与权限档。 */}
        {scope === 'pi' && !collapsed && (
          <div className="relative mt-1.5">
            <button
              type="button"
              onClick={() => setWorkspaceMenuOpen((value) => !value)}
              className="flex h-9 w-full min-w-0 items-center gap-2 rounded-[var(--radius-field)] px-3 text-left text-[length:var(--font-caption)] text-[var(--text-secondary)] transition-colors hover:bg-black/[0.06] dark:hover:bg-white/[0.07]"
              title="切换 Agent 工作区"
              aria-expanded={workspaceMenuOpen}
            >
              <FolderOpen className="h-4 w-4 flex-shrink-0 text-[var(--accent)]" />
              <span className="min-w-0 flex-1 truncate">
                {workspaces.find((item) => item.id === activeWorkspaceId)?.name ?? '未选择工作区'}
              </span>
              <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-tertiary)]" />
            </button>
            <AnimatePresence>
              {workspaceMenuOpen && (
                <motion.div
                  initial={false}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -4, scale: 0.98 }}
                  className="anim-enter-pop absolute left-0 top-full z-40 mt-1 w-full min-w-[220px] overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--app-bg)] p-1 shadow-xl dark:border-white/[0.08] dark:bg-[var(--surface-raised)]"
                >
                  {workspaces.length === 0 ? (
                    <div className="px-3 py-2 text-[length:var(--font-eyebrow)] leading-relaxed text-[var(--text-tertiary)]">
                      还没有工作区。选择一个本地文件夹后，Pi 才能读写其中的文件。
                    </div>
                  ) : (
                    workspaces.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => {
                          setWorkspaceMenuOpen(false);
                          onSelectWorkspace?.(item.id);
                        }}
                        className={`flex w-full min-w-0 flex-col items-start gap-0.5 rounded-[var(--radius-field)] px-2.5 py-1.5 text-left transition-colors ${
                          item.id === activeWorkspaceId
                            ? 'bg-[var(--accent-subtle)] text-[var(--accent)]'
                            : 'text-[var(--text-primary)] hover:bg-[var(--surface-muted)] dark:hover:bg-white/[0.07]'
                        }`}
                      >
                        <span className="w-full truncate text-[length:var(--font-caption)] font-medium">{item.name}</span>
                        <span className="w-full truncate text-[length:var(--font-micro)] text-[var(--text-tertiary)]" title={item.path}>
                          {item.path}
                        </span>
                      </button>
                    ))
                  )}
                  <div className="my-1 border-t border-[var(--border-subtle)]" />
                  <button
                    type="button"
                    onClick={() => {
                      setWorkspaceMenuOpen(false);
                      onPickWorkspace?.();
                    }}
                    className="flex w-full items-center gap-2 rounded-[var(--radius-field)] px-2.5 py-1.5 text-left text-[length:var(--font-caption)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] dark:hover:bg-white/[0.07]"
                  >
                    <FolderPlus className="h-3.5 w-3.5" />
                    选择本地文件夹…
                  </button>
                  {onOpenSkills ? (
                    <button
                      type="button"
                      onClick={() => {
                        setWorkspaceMenuOpen(false);
                        onOpenSkills();
                      }}
                      className="flex w-full items-center gap-2 rounded-[var(--radius-field)] px-2.5 py-1.5 text-left text-[length:var(--font-caption)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] dark:hover:bg-white/[0.07]"
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      技能树
                    </button>
                  ) : null}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {/* 工作区直达按钮：文件浏览与内置浏览器。Pi 工作区下才有意义。 */}
        {scope === 'pi' && !collapsed && onOpenWorkPanel && (
          <div className="mt-1.5 grid grid-cols-2 gap-1.5">
            <button
              type="button"
              onClick={() => onOpenWorkPanel('files')}
              disabled={!activeWorkspaceId}
              className="flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-[var(--radius-field)] border border-[var(--border)] text-[length:var(--font-caption)] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-45"
              title="浏览工作区文件与文件夹（在右侧工作区面板打开）"
              aria-label="浏览工作区文件"
            >
              <FolderOpen className="h-3.5 w-3.5 flex-shrink-0" />
              文件
            </button>
            <button
              type="button"
              onClick={() => onOpenWorkPanel('browser')}
              className="flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-[var(--radius-field)] border border-[var(--border)] text-[length:var(--font-caption)] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
              title="打开内置浏览器（在右侧工作区面板打开）"
              aria-label="打开内置浏览器"
            >
              <Globe2 className="h-3.5 w-3.5 flex-shrink-0" />
              浏览器
            </button>
          </div>
        )}

        <AnimatePresence initial={false}>
          {!collapsed && (
            <motion.label {...expandedMotion} className="mt-2 flex h-9 items-center gap-2 rounded-[var(--radius-field)] px-3 text-[var(--text-tertiary)] transition-colors focus-within:bg-white dark:text-[var(--text-secondary)] dark:focus-within:bg-[var(--surface-raised)]">
              <Search className="h-4 w-4 flex-shrink-0" />
              <input
                value={sessionSearch}
                onChange={(event) => onSearchChange(event.target.value)}
                placeholder={narrow ? '搜索' : '搜索对话与内容'}
                aria-label="搜索对话与对话内文本"
                title="支持标题模糊匹配，也搜索对话正文；正文命中的会话会显示上下文摘要"
                className="min-w-0 flex-1 bg-transparent text-[length:var(--font-body)] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)] dark:placeholder:text-[var(--text-tertiary)]"
              />
              {!narrow && (
                <span className="rounded-[var(--radius-sm)] bg-black/[0.05] px-1.5 py-0.5 text-[length:var(--font-eyebrow)] font-semibold text-[var(--text-tertiary)] dark:bg-[var(--surface-raised)] dark:text-[var(--text-secondary)]">/</span>
              )}
            </motion.label>
          )}
        </AnimatePresence>

        <button
          type="button"
          onClick={selectionMode && selectedSessionIds.size > 0
            ? () => setPendingBulkDeleteCount(selectedSessionIds.size)
            : onSelectionMode}
          className={`flex items-center gap-2 rounded-[var(--radius-field)] text-[length:var(--font-caption)] font-medium transition-[width,background-color,color] duration-200 ${
            selectionMode
              ? 'bg-[var(--state-danger-border)] text-[var(--state-danger)] hover:bg-[var(--state-danger-border)] dark:bg-[var(--surface-raised)] dark:text-[var(--state-danger)] dark:hover:bg-[var(--state-danger-bg)]'
              : 'text-[var(--text-secondary)] hover:bg-[var(--border)] dark:text-[var(--text-secondary)] dark:hover:bg-white/[0.08]'
          } ${collapsed ? 'h-10 w-10 justify-center rounded-full px-0' : 'mt-1 h-9 w-full justify-start px-3'}`}
          title={selectionActionLabel}
          aria-label={selectionActionLabel}
        >
          <CheckSquare className="h-3.5 w-3.5" />
          <AnimatePresence initial={false}>
            {!collapsed && (
              <motion.span {...expandedMotion}>
                {selectionMode ? (selectedSessionIds.size > 0 ? `删除 ${selectedSessionIds.size} 个` : '取消多选') : '多选删除'}
              </motion.span>
            )}
          </AnimatePresence>
        </button>
      </div>

      {collapsed ? (
        // 折叠态不渲染列表；保留 flex 占位，让底部状态区仍贴在底部。
        <div className="min-h-0 flex-1" />
      ) : virtualizeSessions ? (
        <div className={`flex min-h-0 flex-1 flex-col ${narrow ? 'px-1.5' : 'px-2'}`}>
          <div className="flex-shrink-0 px-2 pb-1 text-[length:var(--font-eyebrow)] font-semibold tracking-[var(--tracking-eyebrow)] text-[var(--text-secondary)]">
            {sessionSearch.trim() ? `搜索结果 · ${flatRows.length} 条` : '会话'}
          </div>
          <div className="relative min-h-0 flex-1">
            <div ref={sessionListRef} onKeyDown={handleSessionListKeyDown} className="h-full overflow-y-auto pb-3">
              <div style={{ height: `${sessionVirtualizer.getTotalSize()}px`, position: 'relative' }}>
                {virtualItems.map((item) => {
                  const row = flatRows[item.index];
                  return (
                    <div
                      key={item.key}
                      data-index={item.index}
                      ref={sessionVirtualizer.measureElement}
                      style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}
                    >
                      {row.kind === 'header' ? (
                        <div className="px-2 pb-1 pt-3 text-[length:var(--font-eyebrow)] font-semibold tracking-[var(--tracking-eyebrow)] text-[var(--accent)]">{row.label}</div>
                      ) : (
                        <div className="pb-1">{renderSessionRow(row.session, item.index)}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            {activeGroupLabel && (
              <div className="pointer-events-none absolute inset-x-0 top-0 z-10 bg-[var(--surface-muted)] px-2 py-1 text-[length:var(--font-eyebrow)] font-semibold tracking-[var(--tracking-eyebrow)] text-[var(--accent)]">
                {activeGroupLabel}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div onKeyDown={handleSessionListKeyDown} className={`min-h-0 flex-1 overflow-y-auto pb-3 transition-[padding] duration-200 ${narrow ? 'px-1.5' : 'px-2'}`}>
          <AnimatePresence initial={false}>
            <motion.div {...expandedMotion} className="mb-2 px-2 text-[length:var(--font-eyebrow)] font-semibold tracking-[var(--tracking-eyebrow)] text-[var(--text-secondary)]">
              {sessionSearch.trim() ? `搜索结果 · ${sessionGroups.reduce((n, [, list]) => n + list.length, 0)} 个` : '会话'}
            </motion.div>
          </AnimatePresence>
          {sessionGroups.length === 0 ? (
            <EmptyState
              compact
              icon={sessionSearch.trim() ? Search : MessageSquare}
              title={sessionSearch.trim() ? '没有匹配的对话' : '暂无对话'}
              description={sessionSearch.trim()
                ? '换个关键词，或清空搜索查看全部会话。'
                : '点上方「新建对话」开始第一轮；历史会话会按日期分组。'}
            />
          ) : (
            <div className="space-y-4">
              {sessionGroups.map(([label, sessions]) => (
                <div key={label}>
                  <AnimatePresence initial={false}>
                    <motion.div {...expandedMotion} className="mb-1 px-2 text-[length:var(--font-eyebrow)] font-semibold tracking-[var(--tracking-eyebrow)] text-[var(--accent)]">{label}</motion.div>
                  </AnimatePresence>
                  <div className="space-y-1">{sessions.map(renderSessionRow)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className={`border-t border-black/[0.055] dark:border-white/[0.055] ${collapsed ? 'px-2.5 py-2' : narrow ? 'px-2 py-2.5' : 'px-3 py-3'}`}>
        <button
          type="button"
          onClick={engineMode && onOpenEnginePage ? onOpenEnginePage : onOpenModelLoad}
          className={`mb-2 min-w-0 rounded-[var(--radius-field)] bg-black/[0.035] text-left transition-colors hover:bg-black/[0.06] dark:bg-white/[0.035] dark:hover:bg-white/[0.065] ${
            collapsed ? 'flex h-12 w-full flex-col items-center justify-center gap-1 px-1 py-1 text-center' : narrow ? 'w-full px-2 py-2' : 'w-full px-3 py-2.5'
          }`}
          title={engineMode
            ? `打开 ${engineIdentity?.label} 页`
            : activeModel
              ? '打开模型加载界面'
              : '打开模型管理'}
        >
          {collapsed ? (
            <>
              <span className={`h-2.5 w-2.5 rounded-full ${modelStatusDotClass}`} />
              <span className="max-w-full truncate text-[length:var(--font-eyebrow)] font-semibold text-[var(--text-primary)]">{modelStatusLabel}</span>
            </>
          ) : (
            <>
              <div className="truncate text-[length:var(--font-caption)] font-semibold text-[var(--text-primary)]">
                {engineMode
                  ? (canChat ? engineIdentity?.displayName : `${engineIdentity?.label} 引擎未启动`)
                  : (activeModel?.name ?? '未加载模型')}
              </div>
              {!narrow && (
                <div className="mt-1 flex items-center gap-2 text-[length:var(--font-eyebrow)] text-[var(--text-secondary)]">
                  <span className={`h-2 w-2 rounded-full ${modelStatusDotClass}`} />
                  {engineMode
                    ? (canChat ? '引擎就绪 · 点击前往引擎页' : '点击前往引擎页')
                    : canChat
                      ? '本地推理可用 · 点击查看参数'
                      : activeModel
                        ? '已加载 · 点击查看参数'
                        : '点击前往模型管理'}
                </div>
              )}
              <RuntimeStatusCard metrics={statusMetrics} />            </>
          )}
        </button>
        <div className={`flex items-center gap-2 transition-all duration-200 ${collapsed ? 'flex-col justify-center' : ''}`}>
          <ThemeToggleButton theme={theme} onClick={onToggleTheme} />
          <MiniToolButton icon={Settings} label="软件设置" onClick={onOpenGlobalSettings} />
          <AnimatePresence initial={false}>
            {!collapsed && !narrow && <motion.span {...expandedMotion} className="ml-auto text-[length:var(--font-caption)] text-[var(--text-secondary)] dark:text-[var(--text-tertiary)]">拾壹</motion.span>}
          </AnimatePresence>
        </div>
      </div>

      {/* 右键菜单：portal 到 body，避免被侧边栏的 overflow-hidden 裁切。 */}
      {contextMenu && createPortal(
        <div
          role="menu"
          aria-label={`会话操作：${contextMenu.session.title}`}
          onMouseDown={(event) => event.stopPropagation()}
          className="fixed z-[100] w-60 overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-1 shadow-xl dark:border-white/[0.1] dark:bg-[var(--surface-raised)]"
          style={{
            left: Math.min(contextMenu.x, Math.max(8, window.innerWidth - 248)),
            top: Math.min(contextMenu.y, Math.max(8, window.innerHeight - 168)),
          }}
        >
          <div className="truncate px-2.5 pb-1.5 pt-1 text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">
            {contextMenu.session.title}
          </div>
          <button
            type="button"
            role="menuitem"
            disabled={titleBusyIds.has(contextMenu.session.id)}
            onClick={() => {
              onRegenerateTitle(contextMenu.session.id);
              setContextMenu(null);
            }}
            className="flex w-full items-center gap-2.5 rounded-[var(--radius-field)] px-2.5 py-2 text-left text-[length:var(--font-body)] text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)] disabled:opacity-60 dark:hover:bg-white/[0.07]"
          >
            {titleBusyIds.has(contextMenu.session.id)
              ? <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin text-[var(--accent)]" />
              : <Sparkles className="h-4 w-4 flex-shrink-0 text-[var(--accent)]" />}
            {titleBusyIds.has(contextMenu.session.id) ? '正在生成标题…' : '用模型重新生成标题'}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onExportSession(contextMenu.session.id);
              setContextMenu(null);
            }}
            className="flex w-full items-center gap-2.5 rounded-[var(--radius-field)] px-2.5 py-2 text-left text-[length:var(--font-body)] text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)] dark:hover:bg-white/[0.07]"
          >
            <Download className="h-4 w-4 flex-shrink-0 text-[var(--text-secondary)]" />
            导出会话
          </button>
          <div className="my-1 h-px bg-[var(--border-subtle)]" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setContextMenu(null);
              // 与行内删除一致：立即删除，主界面给出撤销入口。
              onDeleteSession(contextMenu.session.id);
            }}
            className="flex w-full items-center gap-2.5 rounded-[var(--radius-field)] px-2.5 py-2 text-left text-[length:var(--font-body)] text-[var(--state-danger)] transition-colors hover:bg-[var(--state-danger-bg)]"
          >
            <Trash2 className="h-4 w-4 flex-shrink-0" />
            删除会话
          </button>
        </div>,
        document.body
      )}

      {/* 批量删除确认：portal 到 body，避免被侧栏的 overflow-hidden 与宽度动画裁切。
          单条删除不再弹确认，改为删除后在主界面提供「撤销」。 */}
      {pendingBulkDeleteCount !== null && createPortal(
        <ConfirmDialog
          open
          tone="danger"
          title="删除已选对话"
          description={`确定删除已选的 ${pendingBulkDeleteCount} 个对话吗？删除后 8 秒内可在界面底部撤销。`}
          confirmLabel="删除"
          onCancel={() => setPendingBulkDeleteCount(null)}
          onConfirm={() => {
            setPendingBulkDeleteCount(null);
            onDeleteSelectedSessions();
          }}
        />,
        document.body
      )}
    </motion.aside>
  );
}

/** 把命中的文本片段着色：标题里命中的字用强调色，其余照旧。 */
function HighlightedText({ text, query }: { text: string; query: string }) {
  const needle = query.trim();
  if (!needle) return <>{text}</>;
  const index = text.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <mark className="rounded-[2px] bg-[var(--accent)]/22 px-0.5 text-[var(--accent)]">
        {text.slice(index, index + needle.length)}
      </mark>
      {text.slice(index + needle.length)}
    </>
  );
}

function SessionRow({ session, selected, checked, collapsed, compact, selectionMode, hit, query, titleBusy, dataIndex, onSelect, onDelete, onExport, onContextMenu }: {
  session: ChatSession;
  selected: boolean;
  checked: boolean;
  collapsed: boolean;
  compact: boolean;
  selectionMode: boolean;
  hit?: SessionSearchHit;
  query: string;
  titleBusy: boolean;
  /** 虚拟列表里的扁平索引（方向键跨出渲染窗口时用它滚动定位）。 */
  dataIndex?: number;
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onExport: (sessionId: string) => void;
  onContextMenu: (event: React.MouseEvent, session: ChatSession) => void;
}) {
  return (
    <div
      onContextMenu={(event) => onContextMenu(event, session)}
      className={`group relative flex items-center gap-2 rounded-[var(--radius-field)] text-left transition-[width,height,background-color,color] duration-200 ${
        selected ? 'bg-black/[0.065] dark:bg-[var(--surface-raised)]' : 'hover:bg-black/[0.045] dark:hover:bg-[var(--surface-raised)]'
      } ${collapsed ? 'mx-auto h-10 w-10 justify-center rounded-full' : 'min-h-9 w-full'}`}
    >
      <button
        type="button"
        onClick={() => onSelect(session.id)}
        data-session-row="true"
        data-session-index={dataIndex}
        className={`flex min-w-0 flex-1 items-center text-left ${collapsed ? 'h-full justify-center px-0' : compact ? 'min-h-9 px-2 py-1' : 'min-h-9 px-2.5 py-1.5'}`}
        title={hit?.snippet ? `${session.title}\n命中：${hit.snippet}` : session.title}
        aria-current={selected ? 'page' : undefined}
      >
        {collapsed ? (
          <span className="block max-w-[2.7rem] truncate text-[length:var(--font-caption)] font-medium text-[var(--text-primary)]">
            {session.title}
          </span>
        ) : (
          <span className="min-w-0 flex-1">
            {/* 标题按两行折行显示：单行 truncate 会把长标题砍成「写一段 2…」这种看不出内容的残句。
                多选勾选框独立成 flex 子项（而不是塞进折行标题里），避免行内元素被折行容器拆到下一行。 */}
            <span className="flex min-w-0 items-start gap-2">
              {selectionMode && (
                <span className={`mt-[4px] h-3.5 w-3.5 flex-shrink-0 rounded border ${checked ? 'border-[var(--accent)] bg-[var(--accent)]' : 'border-[var(--text-tertiary)] dark:border-white/20'}`} />
              )}
              <span className={`min-w-0 flex-1 ${selectionMode ? '' : 'session-title-mask'}`}>
                <span className="line-clamp-2 break-words text-[length:var(--font-chat)] font-medium text-[var(--text-primary)]">
                  {/* 标题命中时给命中字着色；仅正文命中时标题保持原样，靠下面的摘要表明为什么命中。 */}
                  {hit?.titleMatched ? <HighlightedText text={session.title} query={query} /> : session.title}
                </span>
                {hit?.snippet && (
                  <span className="mt-0.5 block truncate text-[length:var(--font-eyebrow)] leading-4 text-[var(--text-secondary)]">
                    {hit.snippet}
                  </span>
                )}
                {titleBusy && (
                  <span className="mt-0.5 flex items-center gap-1 text-[length:var(--font-eyebrow)] leading-4 text-[var(--accent)]">
                    <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin" />
                    正在总结标题…
                  </span>
                )}
              </span>
            </span>
          </span>
        )}
      </button>
      {!selectionMode && !collapsed && (
        /* 导出/删除按钮浮在行右侧（absolute），不再常驻占用标题宽度：
           常驻时侧边栏 288px 下标题只剩约 170px，长标题会被砍成半句。
           opacity:0 不影响命中测试，必须同时加 pointer-events-none：
           否则按钮不可见却能点到，触摸屏或鼠标快速划过右缘会误删会话。
           悬停整行或用键盘聚焦到行内时再恢复可点击。 */
        <div className="pointer-events-none absolute right-1 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onExport(session.id);
            }}
            className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-[var(--radius-field)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--border)] hover:text-[var(--accent)] dark:hover:bg-white/[0.08] dark:hover:text-[var(--accent)]"
            title="导出会话"
            aria-label={`导出会话：${session.title}`}
          >
            <Download className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onDelete(session.id);
            }}
            className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-[var(--radius-field)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--border)] hover:text-[var(--state-danger)] dark:hover:bg-[var(--surface-raised)] dark:hover:text-[var(--state-danger)]"
            title="删除会话"
            aria-label={`删除会话：${session.title}`}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}

function MiniToolButton({ icon: Icon, label, onClick }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[var(--radius-field)] text-[var(--text-secondary)] transition-colors hover:bg-black/[0.06] hover:text-[var(--accent)] dark:hover:bg-white/[0.07] dark:hover:text-[var(--accent)]"
      title={label}
      aria-label={label}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}
