import { AnimatePresence, motion } from 'framer-motion';
import {
  CheckSquare,
  Image,
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
  onOpenGlobalSettings: () => void;
  onOpenImage: () => void;
  onOpenModelLoad: () => void;
  onToggleTheme: () => void;
  onToggleCollapse: () => void;
  onSwitchToModel: () => void;
  theme: ThemeType;
  sidebarWidth: number;
}

export default function ChatSidebar({
  activeModel,
  canChat,
  collapsed,
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
  onOpenGlobalSettings,
  onOpenImage,
  onOpenModelLoad,
  onToggleTheme,
  onToggleCollapse,
  onSwitchToModel,
  theme,
  sidebarWidth,
}: ChatSidebarProps) {
  const expandedTransition = { duration: 0.18, ease: [0.16, 1, 0.3, 1] as const };
  const modelStatusLabel = canChat ? '可用' : activeModel ? '已加载' : '未加载';
  const modelStatusDotClass = canChat ? 'bg-[#6EA56D]' : activeModel ? 'bg-[#D7663E]' : 'bg-[#B8B1A3]';
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
      className="relative hidden min-h-0 flex-shrink-0 flex-col overflow-hidden border-r border-[#E2DFD6] bg-[#F1EFE8] will-change-[width] dark:border-white/[0.08] dark:bg-[#15130F] md:flex"
    >
      <button
        onClick={onToggleCollapse}
        className="absolute left-4 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-md border border-[#DDD8CC] bg-[#FAF8F2] text-[#716A5E] shadow-sm transition-[background-color,color] duration-200 hover:bg-[#E7E2D6] dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[#D8D0C3] dark:hover:bg-white/[0.09]"
        title={collapsed ? '展开侧边栏' : '折叠侧边栏'}
        aria-label={collapsed ? '展开侧边栏' : '折叠侧边栏'}
      >
        {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
      </button>

      <div className="px-3 pb-3 pt-14">
        <div className={`flex min-w-0 items-center gap-3 ${collapsed ? 'pb-1' : 'pb-4'}`}>
          <button
            onClick={onSwitchToModel}
            className="grid h-11 w-11 flex-shrink-0 place-items-center rounded-xl border border-[#DDD7CB] bg-[#FAF8F2] text-[15px] font-semibold text-[#D7663E] transition-colors hover:bg-[#E7E2D6] dark:border-white/[0.08] dark:bg-white/[0.05] dark:hover:bg-white/[0.09]"
            title="切换到加载模型"
          >
            {collapsed ? (activeModel?.family?.[0]?.toUpperCase() || 'L') : (activeModel?.family?.slice(0, 2).toUpperCase() || 'LL')}
          </button>
          <AnimatePresence initial={false}>
            {!collapsed && (
              <motion.div {...expandedMotion} className="min-w-0">
                <div className="truncate text-sm font-semibold text-[#403C32] dark:text-[#F3EBDD]">llm chat</div>
                <div className="truncate text-xs text-[#969083] dark:text-[#A9A095]">
                  {canChat ? activeModel?.name ?? '模型已连接' : '模型未连接'}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <button
          onClick={onNewSession}
          className={`flex h-11 items-center gap-2 rounded-lg bg-[#403C32] text-sm font-semibold text-[#FBFAF6] transition-[width,background-color,color] duration-200 hover:bg-[#2F2C25] dark:bg-[#F0B18D] dark:text-[#171512] dark:hover:bg-[#F6C6A9] ${
            collapsed ? 'w-11 justify-center rounded-xl px-0' : 'w-full justify-start px-3'
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
            <motion.label {...expandedMotion} className="mt-3 flex h-10 items-center gap-2 rounded-lg border border-[#DDD8CC] bg-[#FAF8F2] px-3 text-[#8B8578] dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[#A9A095]">
              <Search className="h-4 w-4 flex-shrink-0" />
              <input
                value={sessionSearch}
                onChange={(event) => onSearchChange(event.target.value)}
                placeholder="搜索对话"
                className="min-w-0 flex-1 bg-transparent text-sm text-[#403C32] outline-none placeholder:text-[#A39C8C] dark:text-[#F3EBDD] dark:placeholder:text-[#82786B]"
              />
            </motion.label>
          )}
        </AnimatePresence>

        <button
          onClick={selectionMode && selectedSessionIds.size > 0 ? onDeleteSelectedSessions : onSelectionMode}
          className={`flex items-center gap-2 rounded-lg text-xs font-medium transition-[width,background-color,color] duration-200 ${
            selectionMode
              ? 'bg-[#F0DDD6] text-[#C44E36] hover:bg-[#E9D0C7] dark:bg-[#3A241C] dark:text-[#F0987C] dark:hover:bg-[#4A2D22]'
              : 'text-[#716A5E] hover:bg-[#E7E2D6] dark:text-[#D8D0C3] dark:hover:bg-white/[0.08]'
          } ${collapsed ? 'h-10 w-11 justify-center rounded-xl px-0' : 'mt-2 h-9 w-full justify-start px-3'}`}
          title={selectionMode ? '取消多选' : '多选删除'}
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

      <div className={`min-h-0 flex-1 overflow-y-auto pb-3 transition-[padding] duration-200 ${collapsed ? 'px-2' : 'px-2'}`}>
        <AnimatePresence initial={false}>
          {!collapsed && <motion.div {...expandedMotion} className="mb-2 px-2 text-xs font-semibold text-[#8C8576] dark:text-[#A9A095]">会话</motion.div>}
        </AnimatePresence>
        {sessionGroups.length === 0 ? (
          <div className={`rounded-lg border border-dashed border-[#DCD7CC] text-center text-xs text-[#A19A8B] dark:border-white/[0.08] dark:text-[#82786B] ${collapsed ? 'mx-auto grid h-11 w-11 place-items-center px-0 py-0' : 'px-3 py-8'}`}>
            {collapsed ? '空' : '暂无对话'}
          </div>
        ) : (
          <div className={collapsed ? 'space-y-1.5' : 'space-y-4'}>
            {sessionGroups.map(([label, sessions]) => (
              <div key={label} className={collapsed ? 'space-y-1.5' : ''}>
                <AnimatePresence initial={false}>
                  {!collapsed && <motion.div {...expandedMotion} className="mb-1 px-2 text-xs font-semibold text-[#D7663E] dark:text-[#F0B18D]">{label}</motion.div>}
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
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={`border-t border-[#E2DFD6] dark:border-white/[0.08] ${collapsed ? 'px-3 py-2' : 'px-4 py-3'}`}>
        <button
          type="button"
          onClick={onOpenModelLoad}
          className={`mb-3 min-w-0 rounded-lg border border-[#DDD8CC] bg-[#FAF8F2] text-left transition-colors hover:bg-[#E7E2D6] dark:border-white/[0.08] dark:bg-white/[0.05] dark:hover:bg-white/[0.09] ${
            collapsed ? 'flex h-12 w-full flex-col items-center justify-center gap-1 px-1 py-1 text-center' : 'w-full px-3 py-2.5'
          }`}
          title={activeModel ? '打开模型加载界面' : '打开模型管理'}
        >
          {collapsed ? (
            <>
              <span className={`h-2.5 w-2.5 rounded-full ${modelStatusDotClass}`} />
              <span className="max-w-full truncate text-[11px] font-semibold text-[#403C32] dark:text-[#F3EBDD]">{modelStatusLabel}</span>
            </>
          ) : (
            <>
              <div className="truncate text-xs font-semibold text-[#403C32] dark:text-[#F3EBDD]">{activeModel?.name ?? '未加载模型'}</div>
              <div className="mt-1 flex items-center gap-2 text-[11px] text-[#8C8576] dark:text-[#A9A095]">
                <span className={`h-2 w-2 rounded-full ${modelStatusDotClass}`} />
                {canChat ? '本地推理可用 · 点击查看参数' : activeModel ? '已加载 · 点击查看参数' : '点击前往模型管理'}
              </div>
            </>
          )}
        </button>
        <div className={`flex items-center gap-2 transition-all duration-200 ${collapsed ? 'flex-col justify-center' : ''}`}>
          <ThemeToggleButton theme={theme} onClick={onToggleTheme} />
          <MiniToolButton icon={Image} label="生图" onClick={onOpenImage} />
          <MiniToolButton icon={Settings} label="设置" onClick={onOpenGlobalSettings} />
          <AnimatePresence initial={false}>
            {!collapsed && <motion.span {...expandedMotion} className="ml-auto text-xs text-[#8C8576] dark:text-[#82786B]">Agent LLM</motion.span>}
          </AnimatePresence>
        </div>
      </div>
    </motion.aside>
  );
}

function SessionRow({ session, selected, checked, collapsed, selectionMode, onSelect, onDelete }: {
  session: ChatSession;
  selected: boolean;
  checked: boolean;
  collapsed: boolean;
  selectionMode: boolean;
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
}) {
  return (
    <button
      onClick={() => onSelect(session.id)}
      className={`group flex items-center gap-2 rounded-lg text-left transition-[width,height,background-color,color] duration-200 ${
        selected ? 'bg-[#E4E0D6] dark:bg-white/[0.09]' : 'hover:bg-[#E9E5DA] dark:hover:bg-white/[0.06]'
      } ${collapsed ? 'mx-auto h-10 w-11 justify-center rounded-xl px-0 py-0' : 'min-h-[42px] w-full px-2.5 py-2'}`}
      title={session.title}
    >
      {collapsed ? (
          <span className="block max-w-[2.7rem] truncate text-xs font-medium text-[#39362E] dark:text-[#F3EBDD]">
          {session.title}
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-[#39362E] dark:text-[#F3EBDD]">
          {selectionMode && (
            <span className={`mr-2 inline-block h-3.5 w-3.5 align-[-2px] rounded border ${checked ? 'border-[#D7663E] bg-[#D7663E]' : 'border-[#BBB3A2] dark:border-white/20'}`} />
          )}
          {session.title}
        </span>
      )}
      {!selectionMode && !collapsed && (
        <span
          role="button"
          tabIndex={0}
          onClick={(event) => {
            event.stopPropagation();
            onDelete(session.id);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              event.stopPropagation();
              onDelete(session.id);
            }
          }}
          className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-lg text-[#8A8374] opacity-0 transition-colors hover:bg-[#D8D2C5] hover:text-[#C44E36] group-hover:opacity-100 dark:text-[#A9A095] dark:hover:bg-[#3A241C] dark:hover:text-[#F0987C]"
          title="删除会话"
        >
          <Trash2 className="h-4 w-4" />
        </span>
      )}
    </button>
  );
}

function MiniToolButton({ icon: Icon, label, onClick }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-[#DCD7CC] bg-[#FAF8F2] text-[#625B50] transition-colors hover:bg-[#EAE5DA] hover:text-[#D7663E] dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[#D8D0C3] dark:hover:bg-white/[0.09] dark:hover:text-[#F0B18D]"
      title={label}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}
