import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Boxes,
  BrainCircuit,
  CheckCircle2,
  Cpu,
  Download,
  Film,
  Loader2,
  RefreshCw,
  Square,
  Stethoscope,
} from 'lucide-react';

import PageHeader from '@/components/PageHeader';
import { SettingSection } from '@/components/SettingSection';
import EnvCheckDialog from '@/features/workspace/EnvCheckDialog';
import {
  canvasGetStatus,
  checkDesktopEngine,
  isDesktopRuntime,
  onUpdateCenterComponent,
  onUpdateCenterProgress,
  updateCenterCancel,
  updateCenterCheck,
  updateCenterInstall,
  type CanvasStatus,
  type ComponentUpdate,
  type DesktopEngineInfo,
  type UpdateComponentId,
} from '@/lib/desktop';

/**
 * 核心更新。
 *
 * 只有两列：
 * - 左：环境检测（六个组件的当前状态）+ 内核状态。**不显示安装路径**——
 *   路径属于数据管理，放在更新页只会让人以为要手动维护。
 * - 右：更新列表，只提供最新发行版。装哪个架构的包由后端按本机显卡判定，
 *   界面把判定结论写出来（「已按 RTX 3080 Ti 选择 cuda12」），不提供版本选择。
 *
 * 画布不在更新列表里：它随应用一起打包分发，不单独在线更新。
 */

const ICONS: Record<UpdateComponentId, typeof Cpu> = {
  pi: BrainCircuit,
  llama: Cpu,
  strata: Boxes,
  ninfer: Cpu,
  ffmpeg: Film,
};

/** 列表固定顺序：逐项结果先到后到都不影响行的位置。 */
const UPDATE_ORDER: UpdateComponentId[] = ['pi', 'llama', 'strata', 'ninfer', 'ffmpeg'];

/** 把逐项到达的检查结果合并进列表（同 id 覆盖）。 */
function mergeComponent(list: ComponentUpdate[], update: ComponentUpdate) {
  const next = list.filter((item) => item.id !== update.id);
  next.push(update);
  return next.sort(
    (a, b) => UPDATE_ORDER.indexOf(a.id) - UPDATE_ORDER.indexOf(b.id),
  );
}

function parsePercent(message: string | null): number | null {
  if (!message) return null;
  const match = message.match(/(\d{1,3})%/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null;
}

function statusTone(ok: boolean, pending: boolean) {
  if (pending) return 'bg-[var(--state-warning)]';
  return ok ? 'bg-[var(--state-success)]' : 'bg-[var(--text-tertiary)]';
}

function VersionText({ value }: { value: string | null }) {
  if (!value) {
    return <span className="text-[length:var(--font-caption)] text-[var(--text-tertiary)]">未安装</span>;
  }
  return (
    <span className="mono-font max-w-[14rem] truncate text-[length:var(--font-caption)] text-[var(--text-secondary)]" title={value}>
      {value}
    </span>
  );
}

/** 版本展示：日期型（ffmpeg 滚动构建）与构建号（b12091）原样显示，只有数字版本加 v。 */
function formatVersion(value: string | null): string {
  if (!value) return '—';
  const trimmed = value.trim();
  if (!trimmed) return '—';
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed;
  const bare = trimmed.replace(/^v(?=\d)/i, '');
  if (/^\d/.test(bare)) return `v${bare}`;
  return bare;
}

export default function KernelUpdatePage() {
  const [items, setItems] = useState<ComponentUpdate[]>([]);
  const [canvas, setCanvas] = useState<CanvasStatus | null>(null);
  const [engine, setEngine] = useState<DesktopEngineInfo | null>(null);
  const [checking, setChecking] = useState(false);
  // 每个组件各自的状态：一个在更新不该把别的按钮一起锁死。
  const [busy, setBusy] = useState<Partial<Record<UpdateComponentId, boolean>>>({});
  const [progress, setProgress] = useState<Partial<Record<UpdateComponentId, string | null>>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [envOpen, setEnvOpen] = useState(false);
  const busyRef = useRef<Set<UpdateComponentId>>(new Set());

  // 本机状态（画布 / 内核）是本地调用，不该被网络检查拖住：
  // 早先三个请求用 Promise.all 绑在一起，GitHub 慢的时候整页空白。
  const refreshLocal = useCallback(async () => {
    try {
      const [canvasStatus, engineInfo] = await Promise.all([
        canvasGetStatus(),
        checkDesktopEngine(),
      ]);
      setCanvas(canvasStatus);
      setEngine(engineInfo);
    } catch {
      // 本地状态读不到不影响更新列表。
    }
  }, []);

  const refreshUpdates = useCallback(async () => {
    setChecking(true);
    setError(null);
    // 清空旧结果：逐项结果会先到，最后的整体返回值再兜底覆盖。
    setItems([]);
    try {
      setItems(await updateCenterCheck());
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setChecking(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    await Promise.all([refreshLocal(), refreshUpdates()]);
  }, [refreshLocal, refreshUpdates]);

  useEffect(() => {
    // 放到下一个 tick：refresh 会同步置 checking，直接在 effect 体内调用会触发
    // react-hooks/set-state-in-effect（级联渲染）。
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onUpdateCenterProgress((payload) => {
      if (disposed) return;
      const id = payload.component as UpdateComponentId;
      if (!id) return;
      setProgress((prev) => ({ ...prev, [id]: payload.message }));
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // 后端并行检查、逐项回传：哪个组件先返回就先显示，不必等整轮结束。
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onUpdateCenterComponent((payload) => {
      if (disposed) return;
      setItems((prev) => mergeComponent(prev, payload));
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const handleUpdate = useCallback(
    async (id: UpdateComponentId) => {
      if (busyRef.current.has(id)) return;
      busyRef.current.add(id);
      setBusy((prev) => ({ ...prev, [id]: true }));
      setProgress((prev) => ({ ...prev, [id]: null }));
      setMessage(null);
      setError(null);
      try {
        const result = await updateCenterInstall(id);
        // 只改自己这一行：不重跑整轮网络检查，也不让别的行闪一下。
        setItems((prev) =>
          prev.map((item) =>
            item.id === id
              ? {
                  ...item,
                  installed: true,
                  installedVersion: item.latestVersion ?? item.installedVersion,
                  updateAvailable: false,
                  message: null,
                }
              : item,
          ),
        );
        setMessage(result || '更新完成。');
      } catch (cause) {
        const text = String(cause instanceof Error ? cause.message : cause);
        setItems((prev) =>
          prev.map((item) => (item.id === id ? { ...item, message: text } : item)),
        );
        setError(text);
      } finally {
        busyRef.current.delete(id);
        setBusy((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        setProgress((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }
    },
    [],
  );

  const handleCancel = useCallback(async () => {
    try {
      await updateCenterCancel();
      // 取消标志是全局的：所有在跑的下载都会停，这里把每个活动行都标上。
      setProgress((prev) => {
        const next: Partial<Record<UpdateComponentId, string | null>> = { ...prev };
        for (const id of busyRef.current) next[id] = '正在取消...';
        return next;
      });
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }, []);

  const leftRows = useMemo(() => {
    const canvasRow = {
      key: 'canvas',
      name: '无限画布',
      version: canvas?.pack.version ?? null,
      running: Boolean(canvas?.running),
      ready: Boolean(canvas?.pack.installed),
      note: canvas?.pack.installed ? '随应用分发' : '未随应用安装',
    };
    const others = items.map((item) => ({
      key: item.id,
      name: item.name,
      version: item.installedVersion,
      running: item.running,
      ready: item.applicable && (item.installed || Boolean(item.installedVersion)),
      note: !item.applicable
        ? '本机不支持'
        : item.running
          ? '运行中'
          : item.installed
            ? '已安装'
            : '未安装',
    }));
    return [canvasRow, ...others];
  }, [canvas, items]);

  const kernelLabel = engine?.llama_server_version
    ? `llama.cpp ${engine.llama_server_version}`
    : '未检测到内核';
  const backendLabel = engine?.runtime_backend ?? engine?.host_backend ?? '未知';
  const activeCount = Object.values(busy).filter(Boolean).length;

  if (!isDesktopRuntime()) {
    return (
      <div className="mx-auto w-full max-w-5xl px-6 py-8">
        <PageHeader title="核心更新" description="桌面版专属功能。" />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8">
      <PageHeader
        title="核心更新"
        description="按本机显卡选择发行包，只提供最新版本。"
        actions={
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={checking}
            className="inline-flex h-9 items-center gap-2 rounded-[var(--radius-field)] border border-[var(--border)] px-3 text-[length:var(--font-caption)] font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--accent)] disabled:opacity-60"
          >
            {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            检查更新
          </button>
        }
      />

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* 左列：环境检测 + 内核状态 */}
        <div>
          <SettingSection title="环境检测" icon={Stethoscope}>
            <div className="flex items-center justify-between rounded-[var(--radius-field)] bg-[var(--surface-muted)] px-3 py-2">
              <span className="text-[length:var(--font-caption)] text-[var(--text-secondary)]">
                逐项检查运行库、显卡与可选组件
              </span>
              <button
                type="button"
                onClick={() => setEnvOpen(true)}
                className="inline-flex h-8 items-center rounded-[var(--radius-field)] bg-[var(--accent)] px-3 text-[length:var(--font-caption)] font-medium text-[var(--text-on-accent)] transition-colors hover:bg-[var(--accent-hover)]"
              >
                运行检测
              </button>
            </div>

            <div className="divide-y divide-[var(--border-subtle)]">
              {leftRows.map((row) => (
                <div key={row.key} className="flex items-center gap-3 py-2.5">
                  <span className={`h-2 w-2 flex-shrink-0 rounded-full ${statusTone(row.ready, checking)}`} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[length:var(--font-body)] text-[var(--text-primary)]">{row.name}</div>
                    <div className="truncate text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">{row.note}</div>
                  </div>
                  <VersionText value={row.version} />
                </div>
              ))}
            </div>
          </SettingSection>

          <SettingSection title="内核状态" icon={Cpu} delay={0.08}>
            <div className="flex items-center justify-between py-1">
              <span className="text-[length:var(--font-body)] text-[var(--text-primary)]">当前内核</span>
              <span className="mono-font text-[length:var(--font-caption)] text-[var(--text-secondary)]">{kernelLabel}</span>
            </div>
            <div className="flex items-center justify-between py-1">
              <span className="text-[length:var(--font-body)] text-[var(--text-primary)]">运行时后端</span>
              <span className="text-[length:var(--font-caption)] text-[var(--text-secondary)]">{backendLabel}</span>
            </div>
          </SettingSection>
        </div>

        {/* 右列：更新列表（只列最新发行版） */}
        <div>
          <SettingSection title="更新列表" icon={Download}>
            {items.length === 0 && checking ? (
              <p className="flex items-center gap-2 text-[length:var(--font-caption)] text-[var(--text-secondary)]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                正在检查更新...
              </p>
            ) : null}
            {items.length > 0 && checking ? (
              <p className="mb-2 flex items-center gap-2 text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">
                <Loader2 className="h-3 w-3 animate-spin" />
                已检查 {items.length}/{UPDATE_ORDER.length}，其余组件仍在检查...
              </p>
            ) : null}
            {items.length === 0 && !checking ? (
              <p className="text-[length:var(--font-caption)] text-[var(--text-tertiary)]">
                暂无更新信息，点右上角「检查更新」重试。
              </p>
            ) : null}

            <div className="space-y-3">
              {items.map((item) => {
                const Icon = ICONS[item.id];
                const active = Boolean(busy[item.id]);
                const percent = active ? parsePercent(progress[item.id] ?? null) : null;
                // 只锁住自己：别的组件在更新时，这一行照样能点。
                const disabled = !item.applicable || !item.updateAvailable || active;
                return (
                  <div
                    key={item.id}
                    className="rounded-[var(--radius-field)] border border-[var(--border-subtle)] px-3 py-3"
                  >
                    <div className="flex items-start gap-3">
                      <Icon className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--accent)]" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[length:var(--font-body)] font-medium text-[var(--text-primary)]">
                            {item.name}
                          </span>
                          {item.running ? (
                            <span className="rounded-full bg-[var(--surface-muted)] px-1.5 py-0.5 text-[length:var(--font-micro)] text-[var(--text-secondary)]">
                              运行中
                            </span>
                          ) : null}
                          {!item.applicable ? (
                            <span className="rounded-full bg-[var(--surface-muted)] px-1.5 py-0.5 text-[length:var(--font-micro)] text-[var(--state-warning)]">
                              不可用
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[length:var(--font-caption)] text-[var(--text-secondary)]">
                          <span className="mono-font max-w-[10rem] truncate" title={item.installedVersion ?? undefined}>
                            {formatVersion(item.installedVersion)}
                          </span>
                          <span className="text-[var(--text-tertiary)]">→</span>
                          <span className="mono-font max-w-[10rem] truncate text-[var(--text-primary)]" title={item.latestVersion ?? undefined}>
                            {formatVersion(item.latestVersion)}
                          </span>
                        </div>
                        <p className="mt-1 text-[length:var(--font-eyebrow)] leading-relaxed text-[var(--text-tertiary)]">
                          {item.applicability}
                        </p>
                        {item.message ? (
                          <p className="mt-1 flex items-start gap-1 text-[length:var(--font-eyebrow)] leading-relaxed text-[var(--state-warning)]">
                            <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" />
                            <span className="min-w-0 break-words">{item.message}</span>
                          </p>
                        ) : null}
                        {active ? (
                          <div className="mt-2">
                            <div className="h-1 overflow-hidden rounded-full bg-[var(--surface-muted)]">
                              <div
                                className="h-full rounded-full bg-[var(--accent)] transition-[width]"
                                style={{ width: `${percent ?? 100}%`, opacity: percent === null ? 0.4 : 1 }}
                              />
                            </div>
                            <p className="mt-1 break-words text-[length:var(--font-eyebrow)] text-[var(--text-secondary)]">
                              {progress[item.id] ?? '准备中...'}
                            </p>
                          </div>
                        ) : null}
                      </div>

                      <div className="flex flex-shrink-0 items-center gap-1.5">
                        {active ? (
                          <button
                            type="button"
                            onClick={() => void handleCancel()}
                            className="inline-flex h-8 items-center gap-1 rounded-[var(--radius-field)] border border-[var(--border)] px-2.5 text-[length:var(--font-caption)] text-[var(--text-primary)] transition-colors hover:border-[var(--state-danger)]"
                          >
                            <Square className="h-3 w-3" />
                            {activeCount > 1 ? '取消全部' : '取消'}
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={disabled}
                            onClick={() => void handleUpdate(item.id)}
                            className="inline-flex h-8 items-center gap-1 rounded-[var(--radius-field)] bg-[var(--accent)] px-3 text-[length:var(--font-caption)] font-medium text-[var(--text-on-accent)] transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-45"
                          >
                            {!item.latestVersion || item.message ? (
                              <AlertTriangle className="h-3.5 w-3.5" />
                            ) : item.updateAvailable ? (
                              <Download className="h-3.5 w-3.5" />
                            ) : (
                              <CheckCircle2 className="h-3.5 w-3.5" />
                            )}
                            {!item.latestVersion || item.message
                              ? '检查失败'
                              : item.updateAvailable
                                ? '更新'
                                : '已最新'}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {message ? (
              <p className="flex items-start gap-1.5 text-[length:var(--font-caption)] text-[var(--state-success)]">
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                <span className="min-w-0 break-words">{message}</span>
              </p>
            ) : null}
            {error ? (
              <p className="flex items-start gap-1.5 text-[length:var(--font-caption)] text-[var(--state-danger)]">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                <span className="min-w-0 break-words">{error}</span>
              </p>
            ) : null}
          </SettingSection>
        </div>
      </div>

      <EnvCheckDialog manualOpen={envOpen} onClose={() => setEnvOpen(false)} />
    </div>
  );
}
