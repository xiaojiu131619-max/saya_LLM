import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Wrench } from 'lucide-react';
import { piAgentSkillsIndex, type PiSkillMeta } from '@/lib/ipc/pi';
import { connectMcpServer, disconnectMcpServer, getMcpStatuses, listMcpServers } from '@/lib/ipc/mcp';
import type { McpServerEntry, McpServerStatus } from '@/types';
import { useMenuKeyboard } from '@/hooks/useMenuKeyboard';

/**
 * 输入栏的「技能与 MCP」浮窗：技能树入口 + MCP 服务就地连接/断开。
 * 打开时才拉取技能数与服务状态；连接变化后由调用方重启 Pi 让下一轮带上新工具。
 */
export default function McpToolMenu({ skillsDir, piRunning, isAnyGenerating, restartPi, notify, onOpenSkillsTree }: {
  /** Pi 的技能目录（skillsDir）；为空时不读技能数。 */
  skillsDir?: string;
  piRunning: boolean;
  isAnyGenerating: boolean;
  /** MCP 连接变化后的 Pi 重启（停掉空闲实例，下一轮发送自动带新工具重启）。 */
  restartPi: () => Promise<void>;
  notify: (message: string) => void;
  onOpenSkillsTree: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [skillCount, setSkillCount] = useState<number | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerEntry[]>([]);
  const [mcpStatuses, setMcpStatuses] = useState<McpServerStatus[]>([]);
  const [mcpBusy, setMcpBusy] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useMenuKeyboard({ open, menuRef, triggerRef, onClose: () => setOpen(false) });

  // 点外部关闭：与思考/权限菜单保持一致。
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && !menuRef.current?.contains(target)) setOpen(false);
    };
    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const dir = skillsDir?.trim();
      const [skills, servers, statuses] = await Promise.all([
        dir ? piAgentSkillsIndex(dir).catch(() => [] as PiSkillMeta[]) : Promise.resolve([] as PiSkillMeta[]),
        listMcpServers().catch(() => [] as McpServerEntry[]),
        getMcpStatuses().catch(() => [] as McpServerStatus[]),
      ]);
      if (cancelled) return;
      setSkillCount(skills.length);
      setMcpServers(servers);
      setMcpStatuses(statuses);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, skillsDir]);

  const toggleMcpServer = async (server: McpServerEntry) => {
    const status = mcpStatuses.find((item) => item.id === server.id);
    const connected = status && status.state !== 'stopped' && status.state !== 'error';
    setMcpBusy(server.id);
    try {
      if (connected) await disconnectMcpServer(server.id);
      else await connectMcpServer(server.id);
      setMcpStatuses(await getMcpStatuses());
      // Pi 的工具清单在启动时固定：连接/断开后停掉空闲实例，下一轮发送自动带新工具重启。
      if (piRunning && !isAnyGenerating) {
        await restartPi();
        notify('MCP 工具已更新；下一轮发送会自动重启 Pi 并加载新工具。');
      }
    } catch (reason) {
      notify(`MCP 操作失败：${String(reason instanceof Error ? reason.message : reason)}`);
    } finally {
      setMcpBusy(null);
    }
  };

  return (
    <div ref={menuRef} className="relative flex-shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-[var(--text-primary)] transition-colors hover:bg-black/[0.055] disabled:opacity-40 dark:text-[var(--text-secondary)] dark:hover:bg-[var(--surface-raised)]"
        title="技能与 MCP"
      >
        <Wrench className="h-4 w-4" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={false}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            role="menu"
            aria-label="技能与 MCP"
            className="anim-enter-pop absolute bottom-11 left-0 z-30 w-80 overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--app-bg)] shadow-xl dark:border-white/[0.08] dark:bg-[var(--surface-raised)]"
          >
            <div className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
              <div className="min-w-0">
                <div className="text-[length:var(--font-caption)] font-semibold text-[var(--text-primary)]">技能</div>
                <div className="text-[length:var(--font-micro)] text-[var(--text-tertiary)]">
                  {skillCount === null ? '读取中…' : `${skillCount} 个技能 · 宿主路由 1–2 个`}
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onOpenSkillsTree();
                }}
                className="flex-shrink-0 rounded-[var(--radius-field)] px-2 py-1 text-[length:var(--font-eyebrow)] font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent-subtle)]"
              >
                技能树
              </button>
            </div>
            <div className="max-h-64 overflow-y-auto p-1">
              <div className="px-2 pb-1 pt-1.5 text-[length:var(--font-eyebrow)] font-semibold text-[var(--text-secondary)]">MCP 服务</div>
              {mcpServers.length === 0 ? (
                <div className="px-2 py-2 text-[length:var(--font-eyebrow)] leading-relaxed text-[var(--text-tertiary)]">
                  还没有 MCP 服务。可在「设置中心 → 工具」添加；连接后会出现在这里。
                </div>
              ) : (
                mcpServers.map((server) => {
                  const status = mcpStatuses.find((item) => item.id === server.id);
                  const connected = Boolean(status && status.state !== 'stopped' && status.state !== 'error');
                  return (
                    <div key={server.id} className="flex items-center gap-2 rounded-[var(--radius-field)] px-2 py-1.5 hover:bg-[var(--surface-muted)] dark:hover:bg-white/[0.06]">
                      <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${connected ? 'bg-[var(--state-success)]' : 'bg-[var(--text-tertiary)]'}`} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[length:var(--font-caption)] text-[var(--text-primary)]">{server.name}</div>
                        <div className="truncate text-[length:var(--font-micro)] text-[var(--text-tertiary)]">
                          {connected ? `${status?.tools?.length ?? 0} 个工具` : status?.error ? '连接失败' : '未连接'}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void toggleMcpServer(server)}
                        disabled={mcpBusy === server.id}
                        className="flex-shrink-0 rounded-[var(--radius-field)] border border-[var(--border)] px-2 py-0.5 text-[length:var(--font-micro)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] disabled:opacity-50"
                      >
                        {mcpBusy === server.id ? '…' : connected ? '断开' : '连接'}
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
