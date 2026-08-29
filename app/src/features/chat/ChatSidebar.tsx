import { AnimatePresence, motion } from 'framer-motion';
import {
  CheckSquare,
  Download,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  Trash2,
} from 'lucide-react';
import ThemeToggleButton from '@/components/ThemeToggleButton';
import type { ChatSession, ModelInfo, ThemeType } from '@/types';

interface ChatSidebarProps {
  activeModel?: ModelInfo;
  canChat: boolean;
  collapsed: boolean;
  collapseLocked?: boolean;
  selectionMode: boolean;
  selectedSessionIds: Set<string>;
  sessionSearch: string;
  sessionGroups: Array<[string, ChatSession[]]>;
  activeSessionId?: string;
  onSearchChange: (value: string) => void;
  onNewSession: () => void;
  onSelectionMode: () => void;
  onDeleteSelectedSessions: () => void;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onExportSession: (sessionId: string) => void;
  onOpenGlobalSettings: () => void;
  onOpenModelLoad: () => void;
  onToggleTheme: () => void;
  onToggleCollapse: () => void;
  onSwitchToModel: () => void;
  theme: ThemeType;
  sidebarWidth: number;
  ctxPercent?: number;
  vramPercent?: number;
}

export default function ChatSidebar({
  activeModel,
  canChat,
  collapsed,
  collapseLocked = false,
  selectionMode,
  selectedSessionIds,
  sessionSearch,
  sessionGroups,
  activeSessionId,
  onSearchChange,
  onNewSession,
  onSelectionMode,
  onDeleteSelectedSessions,
  onSelectSession,
  onDeleteSession,
  onExportSession,
  onOpenGlobalSettings,
  onOpenModelLoad,
  onToggleTheme,
  onToggleCollapse,
  onSwitchToModel,
  theme,
  sidebarWidth,
  ctxPercent,
  vramPercent,
}: ChatSidebarProps) {
  const expandedTransition = { duration: 0.18, ease: [0.16, 1, 0.3, 1] as const };
  const modelStatusLabel = canChat ? '可用' : activeModel ? '已加载' : '未加载';
  const modelStatusDotClass = canChat ? 'bg-[var(--state-success)]' : activeModel ? 'bg-[var(--accent)]' : 'bg-[var(--text-tertiary)]';
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
  return (
    <motion.aside
      initial={false}
      animate={{ width: sidebarWidth }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className="relative hidden min-h-0 flex-shrink-0 flex-col overflow-hidden border-r border-[var(--border-subtle)] bg-[var(--surface-muted)] will-change-[width] dark:border-[var(--border-subtle)] dark:bg-[var(--surface-muted)] md:flex"
    >
      <button
        onClick={onToggleCollapse}
        disabled={collapseLocked}
        className="absolute left-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-transparent text-[var(--text-tertiary)] transition-[background-color,color] duration-200 hover:bg-black/[0.07] disabled:cursor-default disabled:opacity-60 dark:text-[var(--text-secondary)] dark:hover:bg-[var(--surface-raised)]"
        title={collapseLocked ? '窄窗口下侧边栏保持折叠' : collapsed ? '展开侧边栏' : '折叠侧边栏'}
        aria-label={collapseLocked ? '窄窗口下侧边栏保持折叠' : collapsed ? '展开侧边栏' : '折叠侧边栏'}
      >
        {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
      </button>

      <div className="px-2.5 pb-3 pt-14">
        <div className={`flex min-w-0 items-center gap-3 ${collapsed ? 'pb-1' : 'pb-4'}`}>
          <button
            type="button"
            onClick={onSwitchToModel}
            className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-lg bg-black/[0.045] text-[14px] font-semibold text-[var(--text-primary)] transition-colors hover:bg-black/[0.075] dark:bg-white/[0.055] dark:text-[var(--accent)] dark:hover:bg-[var(--surface-raised)]"
            title="切换到模型管理"
            aria-label="切换到模型管理"
          >
            {collapsed ? (activeModel?.family?.[0]?.toUpperCase() || 'L') : (activeModel?.family?.slice(0, 2).toUpperCase() || 'LL')}
          </button>
          <AnimatePresence initial={false}>
            {!collapsed && (
              <motion.div {...expandedMotion} className="min-w-0">
                <div className="truncate text-sm font-semibold text-[var(--text-primary)] dark:text-[var(--text-primary)]">本地对话</div>
                <div className="truncate text-xs text-[var(--text-tertiary)] dark:text-[var(--text-secondary)]">
                  {canChat ? activeModel?.name ?? '模型已连接' : '模型未连接'}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <button
          onClick={onNewSession}
          className={`flex h-10 items-center gap-2 rounded-lg bg-black/[0.055] text-sm font-medium text-[var(--text-primary)] transition-[width,background-color,color] duration-200 hover:bg-black/[0.085] dark:bg-white/[0.065] dark:text-[var(--text-primary)] dark:hover:bg-[var(--surface-raised)] ${
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
            <motion.label {...expandedMotion} className="mt-2 flex h-9 items-center gap-2 rounded-lg px-3 text-[var(--text-tertiary)] transition-colors focus-within:bg-white dark:text-[var(--text-secondary)] dark:focus-within:bg-[var(--surface-raised)]">
              <Search className="h-4 w-4 flex-shrink-0" />
              <input
                value={sessionSearch}
                onChange={(event) => onSearchChange(event.target.value)}
                placeholder="搜索对话"
                aria-label="搜索对话"
                className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)] dark:text-[var(--text-primary)] dark:placeholder:text-[var(--text-tertiary)]"
              />
              <span className="rounded-md bg-black/[0.05] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--text-tertiary)] dark:bg-[var(--surface-raised)] dark:text-[var(--text-secondary)]">/</span>
            </motion.label>
          )}
        </AnimatePresence>

        <button
          type="button"
          onClick={selectionMode && selectedSessionIds.size > 0 ? onDeleteSelectedSessions : onSelectionMode}
          className={`flex items-center gap-2 rounded-lg text-xs font-medium transition-[width,background-color,color] duration-200 ${
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

      <div className={`min-h-0 flex-1 overflow-y-auto pb-3 transition-[padding] duration-200 ${collapsed ? 'px-2.5' : 'px-2'}`}>
        <AnimatePresence initial={false}>
          {!collapsed && <motion.div {...expandedMotion} className="mb-2 px-2 text-xs font-semibold text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">会话</motion.div>}
        </AnimatePresence>
        {sessionGroups.length === 0 ? (
          <div className={`text-center text-xs text-[var(--text-tertiary)] dark:text-[var(--text-tertiary)] ${collapsed ? 'mx-auto grid h-11 w-11 place-items-center px-0 py-0' : 'px-3 py-8'}`}>
            {collapsed ? '空' : '暂无对话'}
          </div>
        ) : (
          <div className={collapsed ? 'space-y-1.5' : 'space-y-4'}>
            {sessionGroups.map(([label, sessions]) => (
              <div key={label} className={collapsed ? 'space-y-1.5' : ''}>
                <AnimatePresence initial={false}>
                  {!collapsed && <motion.div {...expandedMotion} className="mb-1 px-2 text-xs font-semibold text-[var(--accent)] dark:text-[var(--accent)]">{label}</motion.div>}
                </AnimatePresence>
                <div className="space-y-1">
                  {sessions.map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      selected={session.id === activeSessionId}
                      checked={selectedSessionIds.has(session.id)}
                      collapsed={collapsed}
                      selectionMode={selectionMode}
                      onSelect={onSelectSession}
                      onDelete={onDeleteSession}
                      onExport={onExportSession}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={`border-t border-black/[0.055] dark:border-white/[0.055] ${collapsed ? 'px-2.5 py-2' : 'px-3 py-3'}`}>
        <button
          type="button"
          onClick={onOpenModelLoad}
          className={`mb-2 min-w-0 rounded-lg bg-black/[0.035] text-left transition-colors hover:bg-black/[0.06] dark:bg-white/[0.035] dark:hover:bg-white/[0.065] ${
            collapsed ? 'flex h-12 w-full flex-col items-center justify-center gap-1 px-1 py-1 text-center' : 'w-full px-3 py-2.5'
          }`}
          title={activeModel ? '打开模型加载界面' : '打开模型管理'}
        >
          {collapsed ? (
            <>
              <span className={`h-2.5 w-2.5 rounded-full ${modelStatusDotClass}`} />
              <span className="max-w-full truncate text-[11px] font-semibold text-[var(--text-primary)] dark:text-[var(--text-primary)]">{modelStatusLabel}</span>
            </>
          ) : (
            <>
              <div className="truncate text-xs font-semibold text-[var(--text-primary)] dark:text-[var(--text-primary)]">{activeModel?.name ?? '未加载模型'}</div>
              <div className="mt-1 flex items-center gap-2 text-[11px] text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">
                <span className={`h-2 w-2 rounded-full ${modelStatusDotClass}`} />
                {canChat ? '本地推理可用 · 点击查看参数' : activeModel ? '已加载 · 点击查看参数' : '点击前往模型管理'}
              </div>
              {(ctxPercent !== undefined || vramPercent !== undefined) && (
                <div className="mt-2 grid grid-cols-2 gap-1.5 text-[10px]">
                  <UsageChip label="ctx" percent={ctxPercent} />
                  <UsageChip label="显存" percent={vramPercent} />
                </div>
              )}
            </>
          )}
        </button>
        <div className={`flex items-center gap-2 transition-all duration-200 ${collapsed ? 'flex-col justify-center' : ''}`}>
          <ThemeToggleButton theme={theme} onClick={onToggleTheme} />
          <MiniToolButton icon={Settings} label="设置" onClick={onOpenGlobalSettings} />
          <AnimatePresence initial={false}>
            {!collapsed && <motion.span {...expandedMotion} className="ml-auto text-xs text-[var(--text-secondary)] dark:text-[var(--text-tertiary)]">Agent LLM</motion.span>}
          </AnimatePresence>
        </div>
      </div>
    </motion.aside>
  );
}

function SessionRow({ session, selected, checked, collapsed, selectionMode, onSelect, onDelete, onExport }: {
  session: ChatSession;
  selected: boolean;
  checked: boolean;
  collapsed: boolean;
  selectionMode: boolean;
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onExport: (sessionId: string) => void;
}) {
  return (
    <div
      className={`group flex items-center gap-2 rounded-lg text-left transition-[width,height,background-color,color] duration-200 ${
        selected ? 'bg-black/[0.065] dark:bg-[var(--surface-raised)]' : 'hover:bg-black/[0.045] dark:hover:bg-[var(--surface-raised)]'
      } ${collapsed ? 'mx-auto h-10 w-10 justify-center rounded-full' : 'min-h-9 w-full'}`}
    >
      <button
        type="button"
        onClick={() => onSelect(session.id)}
        className={`flex min-w-0 flex-1 items-center text-left ${collapsed ? 'h-full justify-center px-0' : 'min-h-9 px-2.5 py-1.5'}`}
        title={session.title}
        aria-current={selected ? 'page' : undefined}
      >
        {collapsed ? (
          <span className="block max-w-[2.7rem] truncate text-xs font-medium text-[var(--text-primary)] dark:text-[var(--text-primary)]">
            {session.title}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--text-primary)] dark:text-[var(--text-primary)]">
            {selectionMode && (
              <span className={`mr-2 inline-block h-3.5 w-3.5 align-[-2px] rounded border ${checked ? 'border-[var(--accent)] bg-[var(--accent)]' : 'border-[var(--text-tertiary)] dark:border-white/20'}`} />
            )}
            {session.title}
          </span>
        )}
      </button>
      {!selectionMode && !collapsed && (
        <div className="flex items-center gap-0.5 pr-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onExport(session.id);
            }}
            className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--border)] hover:text-[var(--accent)] dark:text-[var(--text-secondary)] dark:hover:bg-white/[0.08] dark:hover:text-[var(--accent)]"
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
            className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--border)] hover:text-[var(--state-danger)] dark:text-[var(--text-secondary)] dark:hover:bg-[var(--surface-raised)] dark:hover:text-[var(--state-danger)]"
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
      className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors hover:bg-black/[0.06] hover:text-[var(--accent)] dark:text-[var(--text-secondary)] dark:hover:bg-white/[0.07] dark:hover:text-[var(--accent)]"
      title={label}
      aria-label={label}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

function UsageChip({ label, percent }: { label: string; percent?: number }) {
  const has = percent !== undefined && Number.isFinite(percent) && percent >= 0;
  const value = has ? `${Math.round(percent!)}%` : '--';
  return (
    <div className="flex items-center gap-1.5 px-0.5 py-1">
      <span className="text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">{label}</span>
      <div className="ml-auto flex min-w-0 flex-1 items-center gap-1">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--surface-muted)] dark:bg-white/[0.10]">
          <div
            className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300"
            style={{ width: has ? `${Math.min(100, percent!)}%` : '0%' }}
          />
        </div>
        <span className="mono-font flex-shrink-0 font-semibold text-[var(--text-primary)] dark:text-[var(--text-primary)]">{value}</span>
      </div>
    </div>
  );
}
