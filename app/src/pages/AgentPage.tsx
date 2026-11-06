import { useEffect, useState, type ComponentType } from 'react';
import { Bot, Infinity as InfinityIcon } from 'lucide-react';
import {
  canvasGetSummary,
  isDesktopRuntime,
  piAgentGetStatus,
  type CanvasSummary,
  type PiAgentStatus,
} from '@/lib/desktop';
import PiPanel from '@/pages/agent/PiPanel';
import CanvasPanel from '@/pages/agent/CanvasPanel';
import { useApp } from '@/context/AppContext';
import type { AgentTabId } from '@/types';

type AgentTab = AgentTabId;

/** 标签圆点的状态（决定颜色）。 */
type TabBadgeState = 'unknown' | 'disabled' | 'running' | 'ready' | 'missing';

const DOT_CLASS: Record<TabBadgeState, string> = {
  unknown: 'bg-[var(--text-tertiary)]',
  disabled: 'bg-[var(--text-tertiary)]',
  running: 'bg-[var(--state-success)]',
  ready: 'bg-[var(--state-success)]',
  missing: 'bg-[var(--state-danger)]',
};

const TABS: { id: AgentTab; label: string; icon: ComponentType<{ className?: string }>; hint: string }[] = [
  { id: 'pi', label: 'Pi', icon: Bot, hint: 'Pi 内核：RPC 直连、宿主工具代理、权限三档、会话隔离与技能路由；对话在 Chat 的 Pi 工作区' },
  { id: 'canvas', label: '画布', icon: InfinityIcon, hint: '无限画布 · 本地 ComfyUI 生图/视频工作台：启动网关与画布，在独立窗口里创作' },
];

/** 标签圆点的悬停提示。 */
function badgeTitle(id: AgentTab, badge: TabBadgeState): string {
  if (id === 'pi') return badge === 'running' ? 'Pi 内核在运行' : 'Pi 未启动';
  if (id === 'canvas') {
    if (badge === 'running') return '画布正在运行';
    if (badge === 'missing') return '画布模块或 Node 运行时未安装';
    return '画布未启动';
  }
  if (badge === 'running') return '运行中';
  if (badge === 'ready') return '已就绪';
  if (badge === 'missing') return '资源缺失 / 未安装';
  if (badge === 'disabled') return '已停用';
  return '状态未知';
}

/**
 * Agent（智能体）页：按钮切换界面。
 * - 「Pi」为 Pi 内核的设置 / 状态 / 日志页，对话在 Chat 的 Pi 工作区；
 * - 「画布」为本地 ComfyUI 无限画布的控制台（画布在独立窗口打开）。
 * - 官方 WebUI 入口在「设置中心 → WebUI 测试」（独立测试页）。
 */
export default function AgentPage() {
  const { state, dispatch } = useApp();
  // 受控标签：放在全局状态里，面板/对话页的按钮可直接跳转到 WebUI。
  const tab = state.agentTab;
  const setTab = (next: AgentTab) => dispatch({ type: 'SET_AGENT_TAB', payload: next });
  // 标签圆点用的轻量状态轮询：与各面板自己的详细轮询相互独立。
  const [piStatus, setPiStatus] = useState<PiAgentStatus | null>(null);
  const [canvasStatus, setCanvasStatus] = useState<CanvasSummary | null>(null);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const [nextPi, nextCanvas] = await Promise.all([
          piAgentGetStatus().catch(() => null),
          canvasGetSummary().catch(() => null),
        ]);
        if (disposed) return;
        if (nextPi) setPiStatus(nextPi);
        if (nextCanvas) setCanvasStatus(nextCanvas);
      } catch {
        // 静默
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 4000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  const badgeByTab: Record<AgentTab, TabBadgeState> = {
    // Pi：只看内核进程在不在跑。
    pi: piStatus?.running ? 'running' : 'disabled',
    // 画布：运行中绿点；缺模块或 Node 红点；其余灰点。
    canvas: canvasStatus?.running
      ? 'running'
      : canvasStatus && (!canvasStatus.pack_installed || !canvasStatus.node_ok)
        ? 'missing'
        : 'disabled',
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* 顶部按钮切换栏（粘性固定，面板各自滚动） */}
      <div className="flex-shrink-0 border-b border-[var(--border)] bg-[var(--app-bg)] px-6 pb-2.5 pt-3 dark:border-white/[0.08]">
        <div className="mx-auto max-w-6xl">
          <div
            role="tablist"
            aria-label="Agent 界面切换"
            className="grid grid-cols-2 gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1"
          >
            {TABS.map(({ id, label, icon: Icon, hint }) => {
              const active = tab === id;
              const badge = badgeByTab[id];
              return (
                <button
                  key={id}
                  role="tab"
                  aria-selected={active}
                  title={hint}
                  onClick={() => setTab(id)}
                  className={`flex min-w-0 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors ${
                    active
                      ? 'bg-[var(--accent)] text-[var(--text-on-accent)]'
                      : 'text-secondary-custom hover:bg-[var(--surface-muted)]'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5 flex-shrink-0" />
                  <span className="truncate">{label}</span>
                  <span
                    className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                      active ? 'bg-white/90' : DOT_CLASS[badge]
                    }`}
                    title={badgeTitle(id, badge)}
                  />
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* 活动面板：各自携带滚动容器与 PageHeader */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === 'pi' ? <PiPanel /> : <CanvasPanel />}
      </div>
    </div>
  );
}
