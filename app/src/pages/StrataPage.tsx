import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Brain,
  Check,
  CheckCircle2,
  CircleSlash,
  Copy,
  ExternalLink,
  Globe,
  Gauge,
  Loader2,
  Play,
  RotateCw,
  ScrollText,
  Settings2,
  Square,
  TriangleAlert,
  X,
} from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import ToggleSwitch from '@/components/ToggleSwitch';
import WorkingBadge from '@/components/WorkingBadge';
import StrataPerformance from '@/features/strata/StrataPerformance';
// 与 NiNfer 统计面板共用同一套卡片/图表样式：同一设计语言，两份 CSS 迟早会漂移。
import '@/features/fast27b/fast27b.css';
import { useApp } from '@/context/AppContext';
import { useStrataStatus } from '@/hooks/useStrataStatus';
import { refreshStrataStatus } from '@/lib/desktopState';
import { isDesktopRuntime, openExternalUrl, dshGetStatus, dshStart } from '@/lib/desktop';
import { listenDesktopEvent } from '@/lib/ipc/system';
import {
  strataBindDsh,
  strataClearLogs,
  strataGetLogs,
  strataGetMetrics,
  strataRestart,
  strataSaveConfig,
  strataSetEnabled,
  strataStart,
  strataStop,
  strataUnbindDsh,
  type StrataMetricsSnapshot,
  type StrataStatus,
} from '@/lib/ipc/strata';

type TabId = 'overview' | 'performance' | 'logs' | 'settings';

const TABS: Array<{ id: TabId; label: string; icon: typeof Brain }> = [
  { id: 'overview', label: '概览', icon: Activity },
  { id: 'performance', label: '性能', icon: Gauge },
  { id: 'logs', label: '日志', icon: ScrollText },
  { id: 'settings', label: '设置', icon: Settings2 },
];

/** 轮询等待 dsh Web 就绪；超时返回 null（与 NiNfer 页同款，40 秒）。 */
async function waitForDshReady(
  timeoutMs = 40000,
): Promise<{ running: boolean; webUrl: string | null } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = await dshGetStatus();
      if (status?.runtime.running && status.runtime.web_url) {
        return { running: true, webUrl: status.runtime.web_url };
      }
    } catch {
      // 轮询失败继续等
    }
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
  }
  return null;
}

const PRIMARY_BUTTON =
  'inline-flex items-center justify-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-2 text-xs font-medium text-[var(--text-on-accent)] transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-40';
const SECONDARY_BUTTON =
  'inline-flex items-center justify-center gap-1.5 rounded-md border border-[var(--border)] px-3 py-2 text-xs text-secondary-custom transition-colors hover:bg-[var(--surface-muted)] disabled:cursor-not-allowed disabled:opacity-40';
const PANEL = 'rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-5';
const INPUT =
  'w-full rounded-md border border-[var(--border)] bg-[var(--surface-muted)] px-2.5 py-1.5 text-xs text-primary-custom outline-none focus:border-[var(--accent)] disabled:opacity-50';

export default function StrataPage() {
  const { dispatch } = useApp();
  const status = useStrataStatus();
  const desktop = isDesktopRuntime();
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [progressMessage, setProgressMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [binding, setBinding] = useState(false);
  const [openingDsh, setOpeningDsh] = useState(false);
  const [metrics, setMetrics] = useState<StrataMetricsSnapshot | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [logsLive, setLogsLive] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  // 加载起点：只在进入「加载中」时定一次，计时交给 WorkingBadge 自己走。
  const [loadStartedAt, setLoadStartedAt] = useState<number | null>(null);

  // 可编辑配置：从 status 初始化一次，之后由用户接管（避免轮询把输入框冲掉）。
  const editorsReady = useRef(false);
  const [pythonPath, setPythonPath] = useState('');
  const [workDir, setWorkDir] = useState('');
  const [configPath, setConfigPath] = useState('');
  const [port, setPort] = useState('8082');
  const [lan, setLan] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [timeoutSecs, setTimeoutSecs] = useState('1800');
  const [extraArgs, setExtraArgs] = useState('');
  const [dirty, setDirty] = useState(false);

  const running = status?.running ?? false;
  const apiReady = status?.api_ready ?? false;
  const apiReachable = status?.api_reachable ?? false;
  const modelLoaded = status?.model_loaded ?? false;
  const enabled = status?.enabled ?? true;
  const busy = starting || stopping || restarting || saving;
  const boundModel = status?.dsh_bound_model ?? null;

  const applyToEditors = useCallback((next: StrataStatus) => {
    setPythonPath(next.python_path);
    setWorkDir(next.work_dir);
    setConfigPath(next.config_path);
    setPort(String(next.port));
    setLan(next.lan);
    setApiKey(next.api_key);
    setTimeoutSecs(String(next.ready_timeout_secs));
    setExtraArgs(next.extra_args.join('\n'));
    setDirty(false);
  }, []);

  useEffect(() => {
    if (!status || editorsReady.current) return;
    // 延后一拍写入：避免在渲染阶段改 state 触发重渲染循环。
    const timer = window.setTimeout(() => {
      editorsReady.current = true;
      applyToEditors(status);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [status, applyToEditors]);

  // 加载计时：running 且尚未可对话时记下起点，让「十几分钟」这件事看得见。
  const loading = running && !apiReady;
  useEffect(() => {
    // 起点在定时回调里落状态：effect 体内同步 setState 会触发级联渲染。
    const start = loading ? Date.now() : null;
    const timer = window.setTimeout(() => setLoadStartedAt(start), 0);
    return () => window.clearTimeout(timer);
  }, [loading]);

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    const disposers: Array<() => void> = [];
    // listen 是异步的：组件在 Promise 完成前卸载时，disposer 还没进数组，
    // 直接 return 会让监听器永久留在全局（每进一次页面多 4 个）。
    const track = (pending: Promise<() => void>) => {
      void pending
        .then((dispose) => {
          if (disposed) dispose();
          else disposers.push(dispose);
        })
        .catch(() => {
          // 事件通道不可用（浏览器预览）时忽略，轮询仍能兜底。
        });
    };
    track(listenDesktopEvent<{ url?: string }>('strata:ready', (payload) => {
      setProgressMessage(null);
      setErrorMessage(null);
      setStarting(false);
      setRestarting(false);
      if (payload?.url) setProgressMessage(`Strata 已就绪：${payload.url}`);
      void refreshStrataStatus();
    }));
    track(listenDesktopEvent<{ message?: string }>('strata:stopped', (payload) => {
      setStarting(false);
      setRestarting(false);
      setStopping(false);
      setProgressMessage(null);
      if (payload?.message) setProgressMessage(payload.message);
      void refreshStrataStatus();
    }));
    track(listenDesktopEvent<{ message?: string }>('strata:error', (payload) => {
      setStarting(false);
      setRestarting(false);
      setErrorMessage(payload?.message ?? 'Strata 发生未知错误。');
      void refreshStrataStatus();
    }));
    track(listenDesktopEvent<{ message?: string }>('strata:progress', (payload) => {
      if (payload?.message) setProgressMessage(payload.message);
    }));
    return () => {
      disposed = true;
      disposers.forEach((dispose) => dispose());
    };
  }, [desktop]);

  // 日志：1 秒轮询（与 dsh / llama / fast27b 日志同范式），可暂停。
  useEffect(() => {
    if (!desktop || activeTab !== 'logs') return;
    let disposed = false;
    const refresh = async () => {
      try {
        const next = await strataGetLogs();
        if (!disposed) setLogs(next);
      } catch {
        // 静默重试：日志读取失败不该弹提示。
      }
    };
    void refresh();
    const timer = window.setInterval(() => {
      if (logsLive) void refresh();
    }, 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [desktop, activeTab, logsLive]);

  // 请求统计：2 秒一次（与 NiNfer 面板同频）。采集本身在 Rust 侧的后台线程里，
  // 这里只是读一份内存快照，页面不在性能页时概览的紧凑面板也要用它。
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const next = await strataGetMetrics();
        if (!disposed) setMetrics(next);
      } catch {
        // 静默重试：统计读不到不该弹提示。
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [desktop]);

  /** 确保 dsh 在跑（不在跑则拉起并等待就绪）；返回就绪后的 Web 地址。 */
  const ensureDshRunning = async (): Promise<string> => {
    const before = await dshGetStatus();
    if (before?.runtime.running && before.runtime.web_url) {
      return before.runtime.web_url;
    }
    if (before && !before.package.installed) {
      throw new Error('dsh 尚未安装：请先到 Agent 页完成安装');
    }
    await dshStart();
    const ready = await waitForDshReady();
    if (!ready?.webUrl) {
      throw new Error('dsh 在 40 秒内未就绪：请到 Agent（智能体）页查看 dsh 运行日志');
    }
    return ready.webUrl;
  };

  const handleBind = async () => {
    setBinding(true);
    setActionMessage(null);
    setProgressMessage('正在把 Strata 接入 dsh…');
    try {
      const result = await strataBindDsh();
      if (result) {
        setActionMessage(
          `已接入模型 ${result.model_id}（${result.provider}），已设为 dsh 默认模型。`,
        );
      }
      void refreshStrataStatus();
    } catch (error) {
      setActionMessage(`接入失败：${String(error)}`);
    } finally {
      setBinding(false);
      setProgressMessage(null);
    }
  };

  const handleUnbind = async () => {
    setBinding(true);
    setActionMessage(null);
    setProgressMessage('正在解除接入…');
    try {
      await strataUnbindDsh();
      setActionMessage('已解除接入：dsh 配置已回滚（备份保留在 settings.yaml.bak）。');
      void refreshStrataStatus();
    } catch (error) {
      setActionMessage(`解除失败：${String(error)}`);
    } finally {
      setBinding(false);
      setProgressMessage(null);
    }
  };

  const handleOpenDshWeb = async () => {
    setOpeningDsh(true);
    setActionMessage(null);
    setProgressMessage('正在确认 dsh Web 状态…');
    try {
      const webUrl = await ensureDshRunning();
      setProgressMessage(null);
      await openExternalUrl(webUrl);
    } catch (error) {
      setProgressMessage(null);
      setActionMessage(`打开 dsh Web 失败：${String(error)}`);
    } finally {
      setOpeningDsh(false);
    }
  };

  /** 打开应用内 WebUI 标签（strata 网关自带网页界面，不需要同源桥）。 */
  const openWebui = () => {
    dispatch({ type: 'SET_WEBUI_ENGINE', payload: 'strata' });
    dispatch({ type: 'SET_AGENT_TAB', payload: 'webui' });
    dispatch({ type: 'SET_VIEW', payload: 'agent' });
  };

  const handleCopy = async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      setCopied(null);
    }
  };

  const handleStart = async () => {
    setStarting(true);
    setErrorMessage(null);
    setProgressMessage('正在启动 Strata 网关…');
    try {
      await strataStart();
      void refreshStrataStatus();
    } catch (error) {
      setErrorMessage(String(error));
      setProgressMessage(null);
    } finally {
      setStarting(false);
    }
  };

  const handleStop = async () => {
    setStopping(true);
    try {
      await strataStop();
      void refreshStrataStatus();
    } catch (error) {
      setErrorMessage(String(error));
    } finally {
      setStopping(false);
    }
  };

  const handleRestart = async () => {
    setRestarting(true);
    setErrorMessage(null);
    setProgressMessage('正在重启 Strata…');
    try {
      await strataRestart();
      void refreshStrataStatus();
    } catch (error) {
      setErrorMessage(String(error));
      setProgressMessage(null);
    } finally {
      setRestarting(false);
    }
  };

  const handleToggleEnabled = async (next: boolean) => {
    try {
      // 只切开关，不带整份配置：拿 3 秒前的 status 快照回写会把刚保存的
      // 路径 / 端口 / Key 静默覆盖回旧值。
      await strataSetEnabled(next);
      await refreshStrataStatus();
    } catch (error) {
      setErrorMessage(String(error));
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setErrorMessage(null);
    try {
      await strataSaveConfig({
        enabled,
        python_path: pythonPath.trim(),
        work_dir: workDir.trim(),
        config_path: configPath.trim(),
        port: Number(port) || 0,
        lan,
        api_key: apiKey.trim(),
        ready_timeout_secs: Number(timeoutSecs) || 0,
        extra_args: extraArgs
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      });
      setDirty(false);
      void refreshStrataStatus();
    } catch (error) {
      setErrorMessage(String(error));
    } finally {
      setSaving(false);
    }
  };

  const envIssues = useMemo(() => {
    if (!status) return [];
    const issues: string[] = [];
    if (!status.python_exists) {
      issues.push(`Python 解释器不存在：${status.python_path}`);
    }
    if (!status.serve_exists) {
      issues.push(`源码目录下没找到 serve/server.py：${status.work_dir}`);
    }
    if (!status.config_exists) {
      issues.push(`启动配置不存在：${status.config_path}`);
    }
    return issues;
  }, [status]);

  const stateBadge = (() => {
    if (!enabled) {
      return { tone: 'muted' as const, label: '已停用', icon: CircleSlash };
    }
    if (!running) {
      return { tone: 'muted' as const, label: '未运行', icon: CircleSlash };
    }
    if (apiReady) {
      return { tone: 'ok' as const, label: '可对话', icon: CheckCircle2 };
    }
    return { tone: 'wait' as const, label: '加载中', icon: Loader2 };
  })();

  const badgeClass =
    stateBadge.tone === 'ok'
      ? 'border-[var(--state-success-border)] text-[var(--state-success)]'
      : stateBadge.tone === 'wait'
        ? 'border-[var(--state-warning-border)] text-[var(--state-warning)]'
        : 'border-[var(--border)] text-[var(--text-tertiary)]';

  return (
    <div className="h-full min-h-0 overflow-y-auto px-4 py-5 sm:px-6">
      <div className="mx-auto max-w-5xl space-y-4 pb-6">
        <PageHeader
          icon={Brain}
          title="Strata"
          description="Qwen3.8-Flash-Next 90GiB MoE 引擎，慢加载、强推理，与 NiNfer 互补。"
          className="mb-4"
        />

        <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Strata 视图">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`strata-tab-${id}`}
              aria-selected={activeTab === id}
              onClick={() => setActiveTab(id)}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors ${
                activeTab === id
                  ? 'bg-[var(--surface-selected)] text-primary-custom'
                  : 'text-secondary-custom hover:bg-[var(--surface-hover)]'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>

        {errorMessage && (
          <div className="flex items-start gap-2 rounded-md border border-[var(--state-danger-border)] bg-[var(--state-danger-bg)] px-3 py-2 text-xs text-[var(--state-danger)]">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            <span className="min-w-0 break-words">{errorMessage}</span>
          </div>
        )}

        {activeTab === 'overview' && (
          <div className="space-y-4">
            <section aria-label="运行状态" className={PANEL}>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${badgeClass}`}
                  >
                    <stateBadge.icon
                      className={`h-3 w-3 ${stateBadge.tone === 'wait' ? 'animate-spin' : ''}`}
                    />
                    {stateBadge.label}
                  </span>
                  {running && !modelLoaded && apiReachable && (
                    <span className="text-xs text-[var(--text-tertiary)]">
                      接口已在线，权重仍在加载
                    </span>
                  )}
                </div>
                <fieldset
                  disabled={busy || !desktop || !status}
                  className="flex items-center gap-2 text-xs text-secondary-custom disabled:opacity-50"
                >
                  <span>{enabled ? '已启用' : '已停用'}</span>
                  <ToggleSwitch
                    checked={enabled}
                    onChange={(next) => void handleToggleEnabled(next)}
                    label="启用 Strata"
                  />
                </fieldset>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[length:var(--font-subtitle)] font-semibold text-primary-custom">
                    {status?.model_name ?? 'Qwen3.8-Flash-Next（Gyro-M）'}
                  </div>
                  <div className="mt-0.5 text-xs text-[var(--text-tertiary)]">
                    {status?.max_context
                      ? `上下文 ${status.max_context.toLocaleString()} token`
                      : '上下文由启动配置决定'}
                    {status?.pid ? ` · PID ${status.pid}` : ''}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {!running ? (
                    <button
                      type="button"
                      onClick={() => void handleStart()}
                      disabled={busy || !enabled || envIssues.length > 0 || !desktop}
                      className={PRIMARY_BUTTON}
                      title={
                        envIssues.length > 0
                          ? '请先在「设置」里补齐 Python / 源码目录 / 启动配置'
                          : '启动智慧模型'
                      }
                    >
                      {starting ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Play className="h-3.5 w-3.5" />
                      )}
                      {starting ? '正在启动…' : '启动'}
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => void handleStop()}
                        disabled={busy}
                        className={SECONDARY_BUTTON}
                      >
                        {stopping ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Square className="h-3.5 w-3.5" />
                        )}
                        {stopping ? '正在停止…' : '停止'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleRestart()}
                        disabled={busy}
                        className={SECONDARY_BUTTON}
                      >
                        <RotateCw
                          className={`h-3.5 w-3.5 ${restarting ? 'animate-spin' : ''}`}
                        />
                        {restarting ? '正在重启…' : '重启'}
                      </button>
                    </>
                  )}
                </div>
              </div>

              {loading && (
                <div className="mt-4 rounded-md border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-xs text-secondary-custom">
                  <WorkingBadge
                    label="正在加载权重"
                    startedAt={loadStartedAt}
                    className="font-medium text-primary-custom"
                  />
                  <div className="mt-1.5 leading-5 text-[var(--text-tertiary)]">
                    {progressMessage
                      ?? '首次加载 90GiB 专家权重需要十几分钟，之后热启动约半分钟。这段时间可以先做别的。'}
                  </div>
                </div>
              )}

              {!loading && progressMessage && (
                <div className="mt-4 rounded-md border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-xs text-secondary-custom">
                  {progressMessage}
                </div>
              )}

              {envIssues.length > 0 && (
                <div className="mt-4 space-y-1 rounded-md border border-[var(--state-warning-border)] bg-[var(--state-warning-bg)] px-3 py-2 text-xs text-[var(--state-warning)]">
                  {envIssues.map((issue) => (
                    <div key={issue} className="break-words">
                      {issue}
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section
              aria-label="接入与对话"
              className="grid divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] md:grid-cols-2 md:divide-x md:divide-y-0"
            >
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <h2 className="text-xs font-semibold text-primary-custom">DSH</h2>
                  <p
                    className="mt-1 truncate text-[length:var(--font-eyebrow)] text-secondary-custom"
                    title={boundModel ?? '接入后设为默认模型'}
                  >
                    {boundModel ? `已接入 · ${boundModel}` : '智能体默认模型'}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void (boundModel ? handleUnbind() : handleBind())}
                    disabled={binding || !desktop || (!boundModel && (!apiReady || !enabled))}
                    className={SECONDARY_BUTTON}
                    title="接入会替换 DSH 当前默认模型，与模型页、NiNfer 共用同一提供方槽位"
                  >
                    {binding ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : boundModel ? (
                      <X className="h-3.5 w-3.5" />
                    ) : (
                      <Check className="h-3.5 w-3.5" />
                    )}
                    {boundModel ? '解除' : '接入 DSH'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleOpenDshWeb()}
                    disabled={openingDsh || !desktop}
                    className={SECONDARY_BUTTON}
                    title="打开 DSH 网页；未运行时会先自动启动"
                  >
                    {openingDsh ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ExternalLink className="h-3.5 w-3.5" />
                    )}
                    打开
                  </button>
                </div>
              </div>
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div>
                  <h2 className="text-xs font-semibold text-primary-custom">WebUI</h2>
                  <p className="mt-1 text-[length:var(--font-eyebrow)] text-secondary-custom">
                    直接与当前模型对话
                  </p>
                </div>
                <button
                  type="button"
                  onClick={openWebui}
                  disabled={!apiReady || !desktop}
                  className={SECONDARY_BUTTON}
                  title={
                    apiReady
                      ? '打开应用内 WebUI（strata 网关自带的网页界面）'
                      : '请先启动引擎并等权重加载完成'
                  }
                >
                  <Globe className="h-3.5 w-3.5" />
                  打开 WebUI
                </button>
              </div>
            </section>

            {actionMessage && (
              <div
                role="status"
                className="rounded-md border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-xs text-secondary-custom"
              >
                {actionMessage}
              </div>
            )}

            <section aria-label="接入信息" className={PANEL}>
              <div className="mb-3 text-xs font-medium text-secondary-custom">接入信息</div>
              <dl className="grid gap-2 sm:grid-cols-2">
                {[
                  { key: 'base_url', label: 'Base URL', value: status?.base_url ?? '—', mono: true },
                  { key: 'model', label: '模型 ID', value: status?.model_name ?? '—', mono: true },
                  { key: 'port', label: '端口', value: status ? String(status.port) : '—', mono: true },
                  { key: 'api_key', label: 'API Key', value: status?.api_key ?? '—', mono: true },
                ].map((item) => (
                  <div
                    key={item.key}
                    className="flex min-w-0 items-center justify-between gap-2 rounded-md border border-[var(--border)] bg-[var(--surface-muted)] px-2.5 py-1.5"
                  >
                    <div className="min-w-0">
                      <dt className="text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">{item.label}</dt>
                      <dd
                        className={`truncate text-xs text-primary-custom ${item.mono ? 'font-mono' : ''}`}
                        title={item.value}
                      >
                        {item.value}
                      </dd>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleCopy(item.value, item.key)}
                      disabled={!status || item.value === '—'}
                      className="flex-shrink-0 rounded p-1 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-30"
                      title="复制"
                    >
                      {copied === item.key ? (
                        <CheckCircle2 className="h-3.5 w-3.5" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                ))}
              </dl>
              <p className="mt-3 text-[length:var(--font-eyebrow)] leading-5 text-[var(--text-tertiary)]">
                Strata 是 OpenAI 兼容后端，可直接在对话页切到它；上下文、KV 精度与专家驻留预算写在启动配置里，
                由 strata 自己的 launch 决定，本应用不改这些数值。
              </p>
            </section>

            <StrataPerformance metrics={metrics} desktop={desktop} compact />
          </div>
        )}

        {activeTab === 'performance' && (
          <div id="strata-panel-performance" role="tabpanel" aria-labelledby="strata-tab-performance">
            <StrataPerformance metrics={metrics} desktop={desktop} />
          </div>
        )}

        {activeTab === 'logs' && (
          <section aria-label="运行日志" className={PANEL}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs font-medium text-secondary-custom">
                运行日志（{logs.length} 行）
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setLogsLive((current) => !current)}
                  className={SECONDARY_BUTTON}
                >
                  {logsLive ? '暂停刷新' : '继续刷新'}
                </button>
                <button
                  type="button"
                  onClick={() => void strataClearLogs().then(() => setLogs([]))}
                  className={SECONDARY_BUTTON}
                >
                  清空
                </button>
              </div>
            </div>
            <pre className="fat-log max-h-[28rem] overflow-auto rounded-md border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-[length:var(--font-eyebrow)] leading-5 text-[var(--text-secondary)]">
              {logs.length > 0 ? logs.join('\n') : '暂无日志。启动智慧模型后这里会显示网关与引擎的输出。'}
            </pre>
          </section>
        )}

        {activeTab === 'settings' && (
          <section aria-label="配置" className={PANEL}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs font-medium text-secondary-custom">启动配置</div>
              {dirty && (
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={busy || !desktop}
                  className={PRIMARY_BUTTON}
                >
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  {saving ? '正在保存…' : '保存配置'}
                </button>
              )}
            </div>

            <div className="space-y-3">
              {[
                {
                  label: 'Python 解释器',
                  hint: 'strata 网关是 Python 程序，需 jinja2 / yaml / regex / psutil / requests / numpy / PIL。',
                  value: pythonPath,
                  set: setPythonPath,
                  ok: status?.python_exists,
                },
                {
                  label: '源码目录',
                  hint: 'strata 仓库根（含 serve 与 strata_control 的那一层），作为子进程工作目录。',
                  value: workDir,
                  set: setWorkDir,
                  ok: status?.serve_exists,
                },
                {
                  label: '启动配置（run config）',
                  hint: '由 strata launch 生成，记录 exe、引擎参数与模型名；本应用只读取。',
                  value: configPath,
                  set: setConfigPath,
                  ok: status?.config_exists,
                },
              ].map((field) => (
                <label key={field.label} className="block">
                  <div className="mb-1 flex items-center gap-1.5 text-xs text-secondary-custom">
                    <span>{field.label}</span>
                    {field.ok === true && (
                      <CheckCircle2 className="h-3 w-3 text-[var(--state-success)]" />
                    )}
                    {field.ok === false && (
                      <TriangleAlert className="h-3 w-3 text-[var(--state-warning)]" />
                    )}
                  </div>
                  <input
                    value={field.value}
                    onChange={(event) => {
                      field.set(event.target.value);
                      setDirty(true);
                    }}
                    disabled={running}
                    className={INPUT}
                    spellCheck={false}
                  />
                  <div className="mt-1 text-[length:var(--font-eyebrow)] leading-4 text-[var(--text-tertiary)]">
                    {field.hint}
                  </div>
                </label>
              ))}

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <div className="mb-1 text-xs text-secondary-custom">端口</div>
                  <input
                    value={port}
                    onChange={(event) => {
                      setPort(event.target.value);
                      setDirty(true);
                    }}
                    disabled={running}
                    className={INPUT}
                    inputMode="numeric"
                  />
                  <div className="mt-1 text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">
                    默认 8082，避开主模型 8080 与 NiNfer 8094。
                  </div>
                </label>
                <label className="block">
                  <div className="mb-1 text-xs text-secondary-custom">加载超时（秒）</div>
                  <input
                    value={timeoutSecs}
                    onChange={(event) => {
                      setTimeoutSecs(event.target.value);
                      setDirty(true);
                    }}
                    disabled={running}
                    className={INPUT}
                    inputMode="numeric"
                  />
                  <div className="mt-1 text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">
                    按首次加载留余量：90GiB 权重实测约 18 分钟。
                  </div>
                </label>
              </div>

              <label className="block">
                <div className="mb-1 text-xs text-secondary-custom">API Key</div>
                <input
                  value={apiKey}
                  onChange={(event) => {
                    setApiKey(event.target.value);
                    setDirty(true);
                  }}
                  disabled={running}
                  className={INPUT}
                  spellCheck={false}
                />
              </label>

              <label className="block">
                <div className="mb-1 text-xs text-secondary-custom">附加参数（每行一个）</div>
                <textarea
                  value={extraArgs}
                  onChange={(event) => {
                    setExtraArgs(event.target.value);
                    setDirty(true);
                  }}
                  disabled={running}
                  rows={3}
                  className={`${INPUT} font-mono`}
                  placeholder="--lazy"
                  spellCheck={false}
                />
                <div className="mt-1 text-[length:var(--font-eyebrow)] leading-4 text-[var(--text-tertiary)]">
                  原样透传给 serve.server，不补默认值也不做白名单过滤——排障基线必须显式可复现。
                </div>
              </label>

              <fieldset
                disabled={running}
                className="flex items-center gap-2 border-t border-[var(--border)] pt-3 text-xs text-secondary-custom disabled:opacity-50"
              >
                <ToggleSwitch
                  checked={lan}
                  onChange={(next) => {
                    setLan(next);
                    setDirty(true);
                  }}
                  label="允许局域网访问"
                />
                <span>{lan ? '监听 0.0.0.0（局域网可访问）' : '仅本机 127.0.0.1'}</span>
              </fieldset>

              {running && (
                <div className="rounded-md border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-[length:var(--font-eyebrow)] leading-5 text-[var(--text-tertiary)]">
                  运行中不可改解释器、源码目录、启动配置、端口与附加参数——这些是进程的出生参数，
                  改了也只能等下次启动生效。需要修改请先停止。
                </div>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
