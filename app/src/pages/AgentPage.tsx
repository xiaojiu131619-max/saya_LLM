import { useEffect, useState, type ComponentType } from 'react';
import { Bot, Globe } from 'lucide-react';
import { isDesktopRuntime } from '@/lib/desktop';
import {
  dshGetStatus,
  fast27bGetStatus,
  type DshInstallStatus,
  type Fast27bStatus,
} from '@/lib/desktop';
import DshAgentPanel from '@/pages/agent/DshAgentPanel';
import AgentWebUiPanel from '@/pages/agent/AgentWebUiPanel';
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
  { id: 'dsh', label: 'dsh 智能体', icon: Bot, hint: '主框架 · DeepSeek Harness（dsh）工作台' },
  { id: 'webui', label: 'WebUI', icon: Globe, hint: '官方 llama.cpp 网页界面入口：主模型直接开引擎页面，fast-27b 由应用的同源桥提供同一套官方页面' },
];

/** 标签圆点的悬停提示：WebUI 标签不看「资源齐备」而看「该后端服务在不在跑」。 */
function badgeTitle(id: AgentTab, badge: TabBadgeState): string {
  if (id === 'webui') return badge === 'running' ? '后端服务在运行' : '后端服务未运行';
  if (badge === 'running') return '运行中';
  if (badge === 'ready') return '已就绪';
  if (badge === 'missing') return '资源缺失 / 未安装';
  if (badge === 'disabled') return '已停用';
  return '状态未知';
}

function dshBadgeState(status: DshInstallStatus | null): TabBadgeState {
  if (!status) return 'unknown';
  if (status.runtime.running) return 'running';
  return status.package.installed ? 'ready' : 'missing';
}

/**
 * Agent（智能体）页：按钮切换界面。
 * - 「dsh 智能体」为主框架标签；
 * - 「WebUI」为主模型 / fast-27b 的官方 llama.cpp 网页界面入口。
 */
export default function AgentPage() {
  const { state, dispatch } = useApp();
  // 受控标签：放在全局状态里，面板/对话页的按钮可直接跳转到 WebUI。
  const tab = state.agentTab;
  const setTab = (next: AgentTab) => dispatch({ type: 'SET_AGENT_TAB', payload: next });
  // 标签圆点用的轻量状态轮询：与各面板自己的详细轮询相互独立。
  const [dshStatus, setDshStatus] = useState<DshInstallStatus | null>(null);
  const [fast27bStatus, setFast27bStatus] = useState<Fast27bStatus | null>(null);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const next = await dshGetStatus();
        if (!disposed) setDshStatus(next);
      } catch {
        // 静默：徽标轮询失败不打扰用户。
      }
      try {
        const next = await fast27bGetStatus();
        if (!disposed) setFast27bStatus(next);
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
    dsh: dshBadgeState(dshStatus),
    // WebUI：只随 WebUI 标签自己的「后端」选择（主模型看 serverRunning，引擎看引擎在不在跑）。
    webui: state.webuiEngine === 'main'
      ? (state.serverRunning ? 'running' : 'missing')
      : (fast27bStatus?.running ? 'running' : 'missing'),
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* 顶部按钮切换栏（粘性固定，面板各自滚动） */}
      <div className="flex-shrink-0 border-b border-[var(--border)] bg-[var(--app-bg)] px-6 pb-3 pt-4 dark:border-white/[0.08]">
        <div className="mx-auto max-w-2xl">
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
                  className={`flex min-w-0 items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium transition-colors ${
                    active
                      ? 'bg-[var(--accent)] text-white'
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
        {tab === 'dsh' ? <DshAgentPanel /> : <AgentWebUiPanel />}
      </div>
    </div>
  );
}
