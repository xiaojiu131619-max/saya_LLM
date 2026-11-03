import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Send, ShieldAlert, Square, X } from 'lucide-react';
import {
  piAgentCancel,
  piAgentGetStatus,
  piAgentRun,
  piAgentSelectSkills,
  piTextDelta,
  piThinkingDelta,
  piToolStep,
  subscribePiAgent,
  type PiAgentStatus,
  type PiToolStep,
} from '@/lib/ipc/pi';
import { ensurePiForSession, hydratePiConfig, loadPiConfig } from '@/lib/piConfig';
import { isDesktopRuntime } from '@/lib/desktopRuntime';

/**
 * Pi 浮窗（`#/pi-float`）：Agent 页之外的常驻快聊入口。
 *
 * 独立小窗、置顶、不进任务栏；关闭只是隐藏，由宿主窗口复用。
 * 有意不写主界面的会话存储：浮窗是对当前 Pi 会话的快聊/速查，
 * 正式对话仍以 Chat 的 Pi 工作区为准。为避免打断正在跑的任务，
 * Pi 被其他会话占用时浮窗不发送，提示等任务收尾。
 *
 * 权限确认不在浮窗弹：主窗的全局 Pi runtime 也订阅 `pi:permission`，
 * 两边都弹会出现「一边确认后另一边挂着失效弹窗」的竞态；浮窗只提示
 * 去主界面确认。
 */

const FLOAT_SESSION = 'pi-float';

interface FloatEntry {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  steps: PiToolStep[];
}

export default function PiFloatApp() {
  const [status, setStatus] = useState<PiAgentStatus | null>(null);
  const [entries, setEntries] = useState<FloatEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permissionWaiting, setPermissionWaiting] = useState(false);
  const [thinkingChars, setThinkingChars] = useState(0);
  const runIdRef = useRef('');
  const seqRef = useRef(1);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await piAgentGetStatus());
    } catch {
      // 浮窗对轮询失败保持安静
    }
  }, []);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 3000);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);

  const appendToLast = useCallback((patch: Partial<FloatEntry>) => {
    setEntries((prev) => {
      if (prev.length === 0) return prev;
      const next = [...prev];
      const last = next[next.length - 1];
      next[next.length - 1] = { ...last, ...patch, text: patch.text ?? last.text, steps: patch.steps ?? last.steps };
      return next;
    });
  }, []);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    return subscribePiAgent({
      onEvent: (payload) => {
        if (!runIdRef.current || (payload.runId && payload.runId !== runIdRef.current)) return;
        const event = payload.event;
        const text = piTextDelta(event);
        if (text !== null) {
          setEntries((prev) => {
            if (prev.length === 0) return prev;
            const next = [...prev];
            const last = next[next.length - 1];
            next[next.length - 1] = { ...last, text: last.text + text };
            return next;
          });
          return;
        }
        if (piThinkingDelta(event) !== null) {
          setThinkingChars((chars) => chars + 1);
          return;
        }
        const step = piToolStep(event);
        if (step) {
          setEntries((prev) => {
            if (prev.length === 0) return prev;
            const next = [...prev];
            const last = next[next.length - 1];
            const steps = [...last.steps];
            const index = steps.findIndex((item) => item.id === step.id);
            if (index >= 0) steps[index] = { ...steps[index], ...step };
            else steps.push(step);
            next[next.length - 1] = { ...last, steps };
            return next;
          });
          return;
        }
        const type = String(event.type ?? '');
        if (type === 'agent_settled' || type === 'agent_end' || type === 'error') {
          setBusy(false);
          setPermissionWaiting(false);
          runIdRef.current = '';
          if (type === 'error') {
            setError(`Pi 错误：${String(event.message ?? event.error ?? '未知错误')}`);
          }
        }
      },
      onLog: () => {},
      onReady: (next) => setStatus(next),
      onStopped: () => {
        setStatus((prev) => (prev ? { ...prev, running: false, pid: null } : prev));
        setBusy(false);
        setPermissionWaiting(false);
      },
      onExit: () => {
        setStatus((prev) => (prev ? { ...prev, running: false, pid: null } : prev));
        setBusy(false);
        setPermissionWaiting(false);
      },
      onError: ({ message }) => {
        setError(message ?? 'Pi 运行出错');
        setBusy(false);
        setPermissionWaiting(false);
      },
      onPermission: () => setPermissionWaiting(true),
    });
  }, []);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [entries]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setError(null);
    setBusy(true);
    setThinkingChars(0);
    setEntries((prev) => [
      ...prev,
      { id: seqRef.current, role: 'user', text, steps: [] },
      { id: seqRef.current + 1, role: 'assistant', text: '', steps: [] },
    ]);
    seqRef.current += 2;
    setDraft('');
    try {
      const current = await piAgentGetStatus().catch(() => null);
      if (current?.running && current.session_id !== FLOAT_SESSION) {
        throw new Error(
          'Pi 正在被其他会话使用（可能是 Chat 的任务）。等它收尾后再用浮窗，或到 Chat 查看进度。',
        );
      }
      const started = await ensurePiForSession(FLOAT_SESSION);
      setStatus(started);
      const config = await hydratePiConfig(loadPiConfig());
      let skillContext = '';
      if (config.skillRoutingEnabled && config.skillsDir.trim()) {
        try {
          const selection = await piAgentSelectSkills(config.skillsDir, text, 2, 8000);
          skillContext = selection.context;
        } catch {
          // 路由失败按无技能发送
        }
      }
      const runId = await piAgentRun(text, skillContext);
      if (!runId) throw new Error('Pi 没有返回 run id。');
      runIdRef.current = runId;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
      appendToLast({ text: `（发送失败：${reason instanceof Error ? reason.message : String(reason)}）` });
    }
  }, [appendToLast, busy, draft]);

  const cancel = useCallback(async () => {
    try {
      await piAgentCancel();
    } catch {
      // Pi 可能已退出
    }
    setBusy(false);
  }, []);

  if (!isDesktopRuntime()) {
    return (
      <div className="flex h-screen items-center justify-center px-6 text-center text-[length:var(--font-caption)] text-[var(--text-tertiary)]">
        Pi 浮窗只在桌面版可用。
      </div>
    );
  }

  const running = status?.running ?? false;

  return (
    <div className="flex h-screen flex-col bg-[var(--app-bg)] text-[var(--text-primary)]">
      <header className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
        <span
          className={`h-2 w-2 flex-shrink-0 rounded-full ${
            running ? 'bg-[var(--state-success)]' : 'bg-[var(--text-tertiary)]'
          }`}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[length:var(--font-caption)] font-medium">Pi 浮窗</p>
          <p className="truncate text-[length:var(--font-micro)] text-[var(--text-tertiary)]">
            {running ? `运行中 · ${status?.model || '—'}` : '未启动 · 发送时自动拉起'}
          </p>
        </div>
        <button
          type="button"
          title="隐藏浮窗（任务栏与应用内可再次打开）"
          onClick={() => window.close()}
          className="rounded p-1 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-muted)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>

      <div ref={transcriptRef} className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-2.5">
        {entries.length === 0 ? (
          <p className="text-[length:var(--font-eyebrow)] leading-relaxed text-[var(--text-tertiary)]">
            对当前 Pi 会话的快聊入口：发送即自动启动/复用浮窗会话，文件与命令仍走宿主代理与权限档。
            对话不写入主界面历史；正式对话请用 Chat 的 Pi 工作区。
          </p>
        ) : null}
        {entries.map((entry) => (
          <div key={entry.id}>
            {entry.role === 'user' ? (
              <p className="ml-auto w-fit max-w-[85%] rounded-lg bg-[var(--surface-muted)] px-2.5 py-1.5 text-[length:var(--font-caption)]">
                {entry.text}
              </p>
            ) : (
              <div className="space-y-1.5">
                {entry.steps.length > 0 ? (
                  <div className="space-y-0.5">
                    {entry.steps.map((step) => (
                      <p
                        key={step.id}
                        className={`text-[length:var(--font-micro)] ${
                          step.state === 'error'
                            ? 'text-[var(--state-danger)]'
                            : step.state === 'running'
                              ? 'text-[var(--text-tertiary)]'
                              : 'text-[var(--state-success)]'
                        }`}
                      >
                        {step.state === 'running' ? '·' : step.ok ? '✓' : '✗'} {step.tool}
                      </p>
                    ))}
                  </div>
                ) : null}
                <p className="whitespace-pre-wrap break-words text-[length:var(--font-caption)] leading-relaxed">
                  {entry.text || (busy ? '…' : '')}
                </p>
              </div>
            )}
          </div>
        ))}
        {busy && thinkingChars > 0 ? (
          <p className="text-[length:var(--font-micro)] text-[var(--text-tertiary)]">思考中（{thinkingChars} 字）…</p>
        ) : null}
      </div>

      {error ? (
        <p className="border-t border-[var(--border)] px-3 py-1.5 text-[length:var(--font-micro)] leading-relaxed text-[var(--state-danger)]">
          {error}
        </p>
      ) : null}

      {permissionWaiting ? (
        <p className="flex items-center gap-1.5 border-t border-[var(--border)] px-3 py-1.5 text-[length:var(--font-micro)] leading-relaxed text-[var(--state-warning)]">
          <ShieldAlert className="h-3.5 w-3.5 flex-shrink-0" />
          Pi 在请求工具权限，请到主界面确认弹窗；确认后这里会继续。
        </p>
      ) : null}

      <div className="flex items-end gap-1.5 border-t border-[var(--border)] p-2">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          rows={2}
          placeholder={running ? '发消息给当前 Pi 会话…' : '输入任务（Enter 发送）'}
          className="min-h-0 flex-1 resize-none rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-[length:var(--font-caption)] outline-none focus:border-[var(--accent)]"
        />
        {busy ? (
          <button
            type="button"
            onClick={() => void cancel()}
            title="取消当前轮次"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)]"
          >
            <Square className="h-3.5 w-3.5" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void send()}
            disabled={!draft.trim()}
            title="发送"
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--accent)] text-[var(--text-on-accent)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>
    </div>
  );
}
