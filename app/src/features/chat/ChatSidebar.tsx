import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowLeftRight,
  Bot,
  CheckSquare,
  Download,
  Loader2,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  Sparkles,
  Trash2,
} from 'lucide-react';
import BrandLogo from '@/components/BrandLogo';
import ThemeToggleButton from '@/components/ThemeToggleButton';
import RuntimeStatusCard, { type StatusMetric } from '@/components/RuntimeStatusCard';
import { useResizableWidth } from '@/hooks/useResizableWidth';
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from '@/context/AppContext';
import { chatScopeProfile } from '@/features/chat/chatScope';
import type { ChatScope, ChatSession, ModelInfo, ThemeType } from '@/types';

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
  /** 两段式切换回调（主对话 ↔ Agent 工作区）。 */
  onSelectScope: (scope: ChatScope) => void;
  collapsed: boolean;
  collapseLocked?: boolean;
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
  onSelectScope,
  collapsed,
  collapseLocked = false,
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
  const modelStatusLabel = canChat ? '可用' : activeModel ? '已加载' : '未加载';
  const modelStatusDotClass = canChat ? 'bg-[var(--state-success)]' : activeModel ? 'bg-[var(--accent)]' : 'bg-[var(--text-tertiary)]';
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
    max: SIDEBAR_MAX_WIDTH,
  });
  const renderedWidth = collapsed ? 64 : resizer.width;
  // 内容按实际宽度重排而不是简单隐藏：窄侧边栏收起状态卡的细节文字，
  // 只留运行状态卡的核心读数（卡片自身的 2×2 / 1×4 由容器查询决定）。
  const narrow = !collapsed && renderedWidth < 260;

  // 会话右键菜单：坐标取指针位置，节点渲染到 body——侧边栏是 overflow-hidden 的，
  // 菜单若留在 DOM 树里会被裁成一条。任何点击 / Esc / 滚动都关闭。
  const [contextMenu, setContextMenu] = useState<{ session: ChatSession; x: number; y: number } | null>(null);
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

  return (
    <motion.aside
      initial={false}
      animate={{ width: renderedWidth }}
      // 拖拽期间必须瞬时跟随，否则手感和指针脱节；松手后才走原来的展开/收起过渡。
      transition={resizer.dragging ? { duration: 0 } : { duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className="relative hidden min-h-0 flex-shrink-0 flex-col overflow-hidden border-r border-[var(--border-subtle)] bg-[var(--surface-muted)] will-change-[width] dark:border-[var(--border-subtle)] dark:bg-[var(--surface-muted)] md:flex"
      style={collapsed ? undefined : { minWidth: SIDEBAR_MIN_WIDTH, maxWidth: SIDEBAR_MAX_WIDTH }}
    >
      {/* 拖拽分隔条：贴住右边缘，宽度 5px，视觉上只在悬停/拖拽时显形。
          不占用布局空间（absolute），因此不会挤压内容。 */}
      {!collapsed && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整侧边栏宽度"
          aria-valuenow={Math.round(renderedWidth)}
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={SIDEBAR_MAX_WIDTH}
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
        title={collapseLocked ? '窄窗口下侧边栏保持折叠' : collapsed ? '展开侧边栏' : '折叠侧边栏'}
        aria-label={collapseLocked ? '窄窗口下侧边栏保持折叠' : collapsed ? '展开侧边栏' : '折叠侧边栏'}
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
              ? collapsed
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
                    ? canChat
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
          onClick={selectionMode && selectedSessionIds.size > 0 ? onDeleteSelectedSessions : onSelectionMode}
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

      <div className={`min-h-0 flex-1 overflow-y-auto pb-3 transition-[padding] duration-200 ${collapsed ? 'px-2.5' : narrow ? 'px-1.5' : 'px-2'}`}>
        {!collapsed && (
          <>
            <AnimatePresence initial={false}>
              <motion.div {...expandedMotion} className="mb-2 px-2 text-[length:var(--font-eyebrow)] font-semibold tracking-[var(--tracking-eyebrow)] text-[var(--text-secondary)]">
                {sessionSearch.trim() ? `搜索结果 · ${sessionGroups.reduce((n, [, list]) => n + list.length, 0)} 个` : '会话'}
              </motion.div>
            </AnimatePresence>
            {sessionGroups.length === 0 ? (
              <div className="px-3 py-8 text-center text-[length:var(--font-caption)] text-[var(--text-tertiary)]">
                {sessionSearch.trim() ? '没有匹配的对话' : '暂无对话'}
              </div>
            ) : (
              <div className="space-y-4">
                {sessionGroups.map(([label, sessions]) => (
                  <div key={label}>
                    <AnimatePresence initial={false}>
                      <motion.div {...expandedMotion} className="mb-1 px-2 text-[length:var(--font-eyebrow)] font-semibold tracking-[var(--tracking-eyebrow)] text-[var(--accent)]">{label}</motion.div>
                    </AnimatePresence>
                    <div className="space-y-1">
                      {sessions.map((session) => (
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
                          onSelect={onSelectSession}
                          onDelete={onDeleteSession}
                          onExport={onExportSession}
                          onContextMenu={(event, target) => {
                            event.preventDefault();
                            setContextMenu({ session: target, x: event.clientX, y: event.clientY });
                          }}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <div className={`border-t border-black/[0.055] dark:border-white/[0.055] ${collapsed ? 'px-2.5 py-2' : narrow ? 'px-2 py-2.5' : 'px-3 py-3'}`}>
        <button
          type="button"
          onClick={onOpenModelLoad}
          className={`mb-2 min-w-0 rounded-[var(--radius-field)] bg-black/[0.035] text-left transition-colors hover:bg-black/[0.06] dark:bg-white/[0.035] dark:hover:bg-white/[0.065] ${
            collapsed ? 'flex h-12 w-full flex-col items-center justify-center gap-1 px-1 py-1 text-center' : narrow ? 'w-full px-2 py-2' : 'w-full px-3 py-2.5'
          }`}
          title={activeModel ? '打开模型加载界面' : '打开模型管理'}
        >
          {collapsed ? (
            <>
              <span className={`h-2.5 w-2.5 rounded-full ${modelStatusDotClass}`} />
              <span className="max-w-full truncate text-[length:var(--font-eyebrow)] font-semibold text-[var(--text-primary)]">{modelStatusLabel}</span>
            </>
          ) : (
            <>
              <div className="truncate text-[length:var(--font-caption)] font-semibold text-[var(--text-primary)]">{activeModel?.name ?? '未加载模型'}</div>
              {!narrow && (
                <div className="mt-1 flex items-center gap-2 text-[length:var(--font-eyebrow)] text-[var(--text-secondary)]">
                  <span className={`h-2 w-2 rounded-full ${modelStatusDotClass}`} />
                  {canChat ? '本地推理可用 · 点击查看参数' : activeModel ? '已加载 · 点击查看参数' : '点击前往模型管理'}
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
              onDeleteSession(contextMenu.session.id);
              setContextMenu(null);
            }}
            className="flex w-full items-center gap-2.5 rounded-[var(--radius-field)] px-2.5 py-2 text-left text-[length:var(--font-body)] text-[var(--state-danger)] transition-colors hover:bg-[var(--state-danger-bg)]"
          >
            <Trash2 className="h-4 w-4 flex-shrink-0" />
            删除会话
          </button>
        </div>,
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

function SessionRow({ session, selected, checked, collapsed, compact, selectionMode, hit, query, titleBusy, onSelect, onDelete, onExport, onContextMenu }: {
  session: ChatSession;
  selected: boolean;
  checked: boolean;
  collapsed: boolean;
  compact: boolean;
  selectionMode: boolean;
  hit?: SessionSearchHit;
  query: string;
  titleBusy: boolean;
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
           常驻时侧边栏 288px 下标题只剩约 170px，长标题会被砍成半句。 */
        <div className="absolute right-1 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
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
