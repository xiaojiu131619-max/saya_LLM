import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  Info,
  Pause,
  Play,
  RefreshCw,
  Square,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import { isDesktopRuntime } from '@/lib/desktop';
import { listenDesktopEvent } from '@/lib/desktop';
import {
  dshCancelInstall,
  dshClearLogs,
  dshEnvCheck,
  dshGetLogs,
  dshGetStatus,
  dshInstallNode,
  dshInstallPackage,
  dshRevealDir,
  dshStart,
  dshStop,
  dshUninstall,
  openExternalUrl,
  type DshEnvCheckItem,
  type DshInstallStatus,
} from '@/lib/desktop';

type InstallStage = 'idle' | 'node' | 'package';
type LogTone = 'error' | 'warn' | 'accent' | 'default';

const LEVEL_STYLES: Record<DshEnvCheckItem['level'], { dot: string; text: string; label: string }> = {
  ok: {
    dot: 'bg-[var(--state-success)]',
    text: 'text-[var(--state-success)]',
    label: '通过',
  },
  warning: {
    dot: 'bg-[var(--state-warning)]',
    text: 'text-[var(--state-warning)]',
    label: '提醒',
  },
  error: {
    dot: 'bg-[var(--state-danger)]',
    text: 'text-[var(--state-danger)]',
    label: '未就绪',
  },
};

const TONE_CLASS: Record<LogTone, string> = {
  error: 'text-[var(--state-danger)]',
  warn: 'text-[var(--state-warning)]',
  accent: 'text-[var(--state-success)]',
  default: 'text-[var(--text-secondary)]',
};

function classifyLogLine(line: string): LogTone {
  const lower = line.toLowerCase();
  if (lower.includes('error') || lower.includes('failed') || lower.includes('失败') || lower.includes('panic')) {
    return 'error';
  }
  if (lower.includes('warn') || lower.includes('warning') || lower.includes('占用')) return 'warn';
  if (line.startsWith('[dsh]') || lower.includes('dsh web: http')) return 'accent';
  return 'default';
}

function nodeSourceLabel(status: DshInstallStatus) {
  switch (status.node.source) {
    case 'system':
      return `系统 Node v${status.node.version ?? '?'}`;
    case 'managed':
      return `托管 Node v${status.node.version ?? '?'}`;
    default:
      return '未找到可用 Node';
  }
}

export default function AgentPage() {
  const autoCheckedRef = useRef(false);
  const busyRef = useRef(false);
  const logViewportRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<DshInstallStatus | null>(null);
  const [checks, setChecks] = useState<DshEnvCheckItem[]>([]);
  const [checking, setChecking] = useState(false);
  const [stage, setStage] = useState<InstallStage>('idle');
  const [progressMessage, setProgressMessage] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [runtimeMessage, setRuntimeMessage] = useState<string | null>(null);
  const [safetyOpen, setSafetyOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [dshLogs, setDshLogs] = useState<string[]>([]);
  const [dshLive, setDshLive] = useState(true);
  const [logCopied, setLogCopied] = useState(false);

  const installing = stage !== 'idle';
  const running = status?.runtime.running ?? false;
  const webUrl = status?.runtime.web_url ?? null;

  const refreshStatusAndChecks = async () => {
    if (!isDesktopRuntime()) return;
    setChecking(true);
    try {
      const [nextStatus, nextChecks] = await Promise.all([dshGetStatus(), dshEnvCheck()]);
      setStatus(nextStatus);
      setChecks(nextChecks);
    } catch (error) {
      setActionMessage(`检测失败：${String(error)}`);
    } finally {
      setChecking(false);
      setProgressMessage(null);
    }
  };

  const refreshStatusOnly = async () => {
    if (!isDesktopRuntime()) return;
    try {
      setStatus(await dshGetStatus());
    } catch {
      // 静默：轮询失败不打扰用户，下个周期重试。
    }
  };

  useEffect(() => {
    if (autoCheckedRef.current) return;
    autoCheckedRef.current = true;
    void refreshStatusAndChecks();
  }, []);

  // 运行状态轮询：反映 dsh 进程的真实存活与 Web 地址。
  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshStatusOnly();
    }, 3000);
    return () => window.clearInterval(timer);
  }, []);

  // 日志：1 秒轮询（与 llama 日志页同范式），可暂停。
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const next = await dshGetLogs();
        if (!disposed) setDshLogs(next);
      } catch {
        // 静默重试
      }
    };
    void refresh();
    const timer = window.setInterval(() => {
      if (dshLive) void refresh();
    }, 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [dshLive]);

  // dsh 生命周期事件：即时反馈并刷新状态。
  useEffect(() => {
    const unlisten = listenDesktopEvent<{ url?: string; message?: string }>('dsh:ready', (payload) => {
      setRuntimeMessage(`dsh 已就绪：${payload.url ?? ''}`);
      setProgressMessage(null);
      void refreshStatusOnly();
    });
    const unlistenStopped = listenDesktopEvent<{ message?: string }>('dsh:stopped', (payload) => {
      setRuntimeMessage(payload.message ?? 'dsh 已停止。');
      setProgressMessage(null);
      void refreshStatusOnly();
    });
    const unlistenError = listenDesktopEvent<{ message?: string }>('dsh:error', (payload) => {
      setRuntimeMessage(payload.message ?? 'dsh 运行出错。');
      setProgressMessage(null);
      void refreshStatusOnly();
    });
    return () => {
      void unlisten.then((dispose) => dispose());
      void unlistenStopped.then((dispose) => dispose());
      void unlistenError.then((dispose) => dispose());
    };
  }, []);

  useEffect(() => {
    const el = logViewportRef.current;
    if (el && dshLive) el.scrollTop = el.scrollHeight;
  }, [dshLogs, dshLive]);

  const handleInstallNode = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setStage('node');
    setActionMessage(null);
    setProgressMessage('正在安装 Node.js 运行时...');
    try {
      const version = await dshInstallNode();
      setActionMessage(`Node.js v${version} 已就绪。`);
      await refreshStatusAndChecks();
    } catch (error) {
      setActionMessage(`Node.js 安装失败：${String(error)}`);
    } finally {
      setStage('idle');
      setProgressMessage(null);
      busyRef.current = false;
    }
  };

  const handleInstallPackage = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setStage('package');
    setActionMessage(null);
    setProgressMessage('正在安装 dsh 智能体框架（依赖约 270 MB，请耐心等待）...');
    try {
      const version = await dshInstallPackage();
      setActionMessage(`dsh v${version} 安装完成。`);
      await refreshStatusAndChecks();
    } catch (error) {
      setActionMessage(`dsh 安装失败：${String(error)}`);
    } finally {
      setStage('idle');
      setProgressMessage(null);
      busyRef.current = false;
    }
  };

  const handleUninstall = async () => {
    if (installing || running) return;
    try {
      await dshUninstall();
      setActionMessage('dsh 包已卸载（dsh 数据目录与托管 Node 保留）。');
    } catch (error) {
      setActionMessage(`卸载失败：${String(error)}`);
    }
    await refreshStatusAndChecks();
  };

  const handleStart = async () => {
    setStarting(true);
    setRuntimeMessage(null);
    try {
      await dshStart();
      setRuntimeMessage('dsh 正在启动，就绪后可点击「打开界面」...');
    } catch (error) {
      setRuntimeMessage(`启动失败：${String(error)}`);
    } finally {
      setStarting(false);
      await refreshStatusOnly();
    }
  };

  const handleStop = async () => {
    if (!window.confirm('确定要关闭 dsh 吗？未完成的会话上下文会被中断。')) return;
    setStopping(true);
    try {
      await dshStop();
      setRuntimeMessage('dsh 已停止。');
    } catch (error) {
      setRuntimeMessage(`关闭失败：${String(error)}`);
    } finally {
      setStopping(false);
      await refreshStatusOnly();
    }
  };

  const handleOpenUi = async () => {
    const url = webUrl ?? status?.web_url;
    if (!url) return;
    await openExternalUrl(url);
  };

  const runInAppAction = async (action: string) => {
    if (action === 'dsh-install-node') {
      await handleInstallNode();
      return;
    }
    if (action === 'dsh-install-package') {
      await handleInstallPackage();
    }
  };

  const handleCopyLogs = async () => {
    await navigator.clipboard.writeText(dshLogs.join('\n'));
    setLogCopied(true);
    window.setTimeout(() => setLogCopied(false), 1500);
  };

  const handleExportLogs = () => {
    const blob = new Blob([dshLogs.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dsh-${new Date().toISOString().slice(0, 10)}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleClearLogs = () => {
    if (window.confirm('确定要清空 dsh 日志吗？')) {
      void dshClearLogs().finally(() => setDshLogs([]));
    }
  };

  const packageState = (() => {
    if (!status) return null;
    if (!status.package.installed) {
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-[var(--state-danger-border)] bg-[var(--state-danger-bg)] px-2 py-0.5 text-xs text-[var(--state-danger)]">
          <AlertTriangle className="h-3 w-3" /> 未安装 dsh
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-[var(--state-success-border)] bg-[var(--state-success-bg)] px-2 py-0.5 text-xs text-[var(--state-success)]">
        <Check className="h-3 w-3" /> 已安装 v{status.package.version ?? '?'}
      </span>
    );
  })();

  const runningBadge = (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${
        running
          ? 'border-[var(--state-success-border)] bg-[var(--state-success-bg)] text-[var(--state-success)]'
          : 'border-[var(--border)] bg-[var(--surface-muted)] text-secondary-custom'
      }`}
    >
      <span className="relative flex h-2 w-2">
        {running && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--state-success)] opacity-60" />
        )}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${running ? 'bg-[var(--state-success)]' : 'bg-[var(--text-tertiary)]'}`} />
      </span>
      {running ? '运行中' : '已停止'}
    </span>
  );

  const renderedLogs = useMemo(() => dshLogs.slice(-600), [dshLogs]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto mb-6 max-w-2xl">
          <PageHeader
            icon={Bot}
            title="Agent（智能体）"
            description="接入 DeepSeek Harness（dsh）：环境检测、托管安装与本地模型智能体工作台"
          />
        </div>

        <div className="mx-auto max-w-2xl space-y-4 pb-8">
          {/* 安全提示：默认折叠，展开查看完整说明 */}
          <div className="rounded-xl border border-[var(--state-warning-border)] bg-[var(--state-warning-bg)]">
            <button
              onClick={() => setSafetyOpen((open) => !open)}
              className="flex w-full items-center gap-2 px-4 py-3 text-left"
            >
              <CircleAlert className="h-4 w-4 flex-shrink-0 text-[var(--state-warning)]" />
              <span className="flex-1 text-sm text-primary-custom">
                dsh 为上游开发者预览版（实验性）：可以执行模型生成的命令与代码，请在了解风险后开启
              </span>
              {safetyOpen ? (
                <ChevronUp className="h-4 w-4 flex-shrink-0 text-secondary-custom" />
              ) : (
                <ChevronDown className="h-4 w-4 flex-shrink-0 text-secondary-custom" />
              )}
            </button>
            {safetyOpen && (
              <div className="border-t border-[var(--state-warning-border)] px-4 py-3 text-xs leading-6 text-secondary-custom">
                <p>· dsh 由 DeepSeek AI 开源（MIT），当前处于开发者预览阶段：未做安全审计、版本迭代快、可能出现破坏性变更。</p>
                <p>· Agent 任务可以读写工作区文件、执行命令、委派子代理。请只在信任的模型与任务上使用，并善用 dsh 内置的审批与权限预设。</p>
                <p>· Agent LLM 仅做托管：dsh 进程只在您点击「开启」后运行，默认只连接本机模型（127.0.0.1），不会静默自启；退出应用时自动关闭。</p>
              </div>
            )}
          </div>

          {/* 状态卡：安装 + 运行 */}
          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-primary-custom">运行时与状态</h2>
              <div className="flex items-center gap-2">
                {runningBadge}
                {packageState}
              </div>
            </div>
            {status ? (
              <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
                <div className="flex justify-between gap-3 sm:block">
                  <dt className="text-secondary-custom">Node.js</dt>
                  <dd className="text-primary-custom">{nodeSourceLabel(status)}</dd>
                </div>
                <div className="flex justify-between gap-3 sm:block">
                  <dt className="text-secondary-custom">dsh 包</dt>
                  <dd className="text-primary-custom">
                    {status.package.installed ? `v${status.package.version ?? '?'}` : '未安装'}
                  </dd>
                </div>
                <div className="flex justify-between gap-3 sm:block">
                  <dt className="text-secondary-custom">Web UI 地址</dt>
                  <dd className="mono-font truncate text-primary-custom">
                    {running ? webUrl ?? status.web_url : status.web_url}
                  </dd>
                </div>
                <div className="flex justify-between gap-3 sm:block">
                  <dt className="text-secondary-custom">dsh 数据目录（DSH_HOME）</dt>
                  <dd className="truncate text-primary-custom" title={status.home_dir}>{status.home_dir}</dd>
                </div>
              </dl>
            ) : (
              <p className="text-xs text-secondary-custom">正在读取安装状态...</p>
            )}

            <div className="mt-3 flex flex-wrap gap-2">
              {running ? (
                <button
                  onClick={handleStop}
                  disabled={stopping}
                  className="flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40"
                >
                  {stopping ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
                  关闭 dsh
                </button>
              ) : (
                <button
                  onClick={handleStart}
                  disabled={starting || installing || !status?.package.installed || !isDesktopRuntime()}
                  title={
                    !status?.package.installed
                      ? '请先安装 dsh'
                      : '开启 dsh 旁路进程（Web UI 就绪后可打开界面）'
                  }
                  className="flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40"
                >
                  {starting ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                  开启 dsh
                </button>
              )}
              <button
                onClick={() => void handleOpenUi()}
                disabled={!running || !webUrl}
                title={running ? `在默认浏览器打开 ${webUrl ?? ''}` : 'dsh 未运行'}
                className="flex items-center gap-1.5 rounded-md border border-[var(--border)] px-3 py-1.5 text-xs text-secondary-custom transition-colors hover:bg-[var(--surface-muted)] disabled:opacity-40"
              >
                <ExternalLink className="h-3.5 w-3.5" /> 打开界面
              </button>
              <button
                onClick={handleInstallPackage}
                disabled={installing || !isDesktopRuntime()}
                className="flex items-center gap-1.5 rounded-md border border-[var(--border)] px-3 py-1.5 text-xs text-secondary-custom transition-colors hover:bg-[var(--surface-muted)] disabled:opacity-40"
              >
                <Download className="h-3.5 w-3.5" /> {status?.package.installed ? '重装 dsh' : '安装 dsh'}
              </button>
              <button
                onClick={handleUninstall}
                disabled={installing || running || !isDesktopRuntime() || !status?.package.installed}
                className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs text-secondary-custom transition-colors hover:bg-[var(--surface-muted)] disabled:opacity-40"
              >
                卸载
              </button>
              <button
                onClick={() => void dshRevealDir('home')}
                className="flex items-center gap-1 rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs text-secondary-custom transition-colors hover:bg-[var(--surface-muted)]"
                title="在资源管理器中打开 dsh 数据目录"
              >
                <FolderOpen className="h-3.5 w-3.5" /> 数据目录
              </button>
            </div>

            {progressMessage && (
              <div className="mt-3 flex items-center gap-2 rounded-lg bg-[var(--surface-muted)] px-3 py-2 text-xs">
                <RefreshCw className="h-3.5 w-3.5 animate-spin text-[var(--accent)]" />
                <span className="flex-1 text-secondary-custom">{progressMessage}</span>
                {(stage === 'node' || stage === 'package') && (
                  <button
                    onClick={() => void dshCancelInstall()}
                    className="flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-secondary-custom transition-colors hover:bg-[var(--surface)]"
                  >
                    <X className="h-3 w-3" /> 取消
                  </button>
                )}
              </div>
            )}
            {runtimeMessage && (
              <p className="mt-3 flex items-center gap-1.5 text-xs text-secondary-custom">
                <Info className="h-3.5 w-3.5 flex-shrink-0" /> {runtimeMessage}
              </p>
            )}
            {!installing && actionMessage && (
              <p className="mt-3 flex items-center gap-1.5 text-xs text-secondary-custom">
                <Info className="h-3.5 w-3.5 flex-shrink-0" /> {actionMessage}
              </p>
            )}
          </section>

          {/* 环境检测 */}
          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-primary-custom">环境检测</h2>
              <button
                onClick={() => void refreshStatusAndChecks()}
                disabled={checking}
                className="flex items-center gap-1 rounded-md border border-[var(--border)] px-2.5 py-1 text-xs text-secondary-custom transition-colors hover:bg-[var(--surface-muted)] disabled:opacity-40"
              >
                <RefreshCw className={`h-3 w-3 ${checking ? 'animate-spin' : ''}`} /> 重新检测
              </button>
            </div>
            {checks.length === 0 ? (
              <p className="text-xs text-secondary-custom">{checking ? '正在检测...' : '尚未检测。'}</p>
            ) : (
              <ul className="space-y-2.5">
                {checks.map((item) => {
                  const style = LEVEL_STYLES[item.level] ?? LEVEL_STYLES.warning;
                  return (
                    <li key={item.id} className="text-xs">
                      <div className="flex items-center gap-2">
                        <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${style.dot}`} />
                        <span className="font-medium text-primary-custom">{item.title}</span>
                        <span className={style.text}>（{style.label}）</span>
                      </div>
                      <p className="ml-3.5 mt-0.5 leading-5 text-secondary-custom">{item.detail}</p>
                      {item.level === 'error' && item.install_hint && (
                        <p className="ml-3.5 mt-0.5 leading-5 text-[var(--state-warning)]">{item.install_hint}</p>
                      )}
                      {item.level === 'error' && item.in_app_action && (
                        <button
                          onClick={() => void runInAppAction(item.in_app_action!)}
                          disabled={installing}
                          className="ml-3.5 mt-1.5 rounded-md border border-[var(--accent)]/40 px-2.5 py-1 text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/10 disabled:opacity-40"
                        >
                          去修复
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* dsh 运行日志 */}
          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <h2 className="flex-1 text-sm font-semibold text-primary-custom">dsh 运行日志</h2>
              <span className="rounded-full border border-[var(--border)] bg-[var(--surface-muted)] px-2 py-0.5 text-[10px] text-secondary-custom">
                {dshLogs.length} 行
              </span>
              <button
                type="button"
                onClick={() => setDshLive((v) => !v)}
                className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors ${
                  dshLive
                    ? 'border-[var(--state-success-border)] bg-[var(--state-success-bg)] text-[var(--state-success)]'
                    : 'border-[var(--border)] text-secondary-custom hover:bg-[var(--surface-muted)]'
                }`}
                title={dshLive ? '暂停自动刷新' : '恢复自动刷新'}
              >
                {dshLive ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                {dshLive ? '实时' : '已暂停'}
              </button>
              <button
                type="button"
                onClick={() => void handleCopyLogs()}
                disabled={dshLogs.length === 0}
                className="flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-xs text-secondary-custom transition-colors hover:bg-[var(--surface-muted)] disabled:opacity-40"
              >
                {logCopied ? <Check className="h-3 w-3 text-[var(--state-success)]" /> : <Copy className="h-3 w-3" />}
                {logCopied ? '已复制' : '复制'}
              </button>
              <button
                type="button"
                onClick={handleExportLogs}
                disabled={dshLogs.length === 0}
                className="flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-xs text-secondary-custom transition-colors hover:bg-[var(--surface-muted)] disabled:opacity-40"
              >
                <Download className="h-3 w-3" /> 导出
              </button>
              <button
                type="button"
                onClick={handleClearLogs}
                disabled={dshLogs.length === 0}
                className="flex items-center gap-1 rounded-md border border-[var(--state-danger-border)] px-2 py-1 text-xs text-[var(--state-danger)] transition-colors hover:bg-[var(--state-danger-bg)] disabled:opacity-40"
              >
                <Trash2 className="h-3 w-3" /> 清空
              </button>
            </div>
            <div className="mono-font h-64 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--app-bg)] px-3 py-2 text-[11px] leading-[1.7]">
              {renderedLogs.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center text-secondary-custom">
                  <Terminal className="mb-2 h-7 w-7 opacity-40" />
                  <p className="text-xs">暂无 dsh 输出；开启 dsh 后日志会实时显示在这里</p>
                </div>
              ) : (
                renderedLogs.map((line, index) => {
                  const tone = classifyLogLine(line);
                  return (
                    <div key={`${dshLogs.length - renderedLogs.length + index}`} className="whitespace-pre-wrap break-all">
                      <span className={`min-w-0 ${TONE_CLASS[tone]}`}>{line || ' '}</span>
                    </div>
                  );
                })
              )}
            </div>
          </section>

          {/* Phase 3 占位：本地模型接入 */}
          <section className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface)] p-4">
            <h2 className="mb-1.5 text-sm font-semibold text-primary-custom">本地模型接入</h2>
            <p className="text-xs leading-6 text-secondary-custom">
              「把当前加载的本地模型一键接入 dsh」将在 v0.4 下一阶段提供。当前可在 dsh
              Web UI 的「设置 → 模型」中手动添加 OpenAI 兼容提供方，指向 llama-server 的 /v1 端点。
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
