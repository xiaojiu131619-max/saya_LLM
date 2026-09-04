import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Download,
  FolderOpen,
  Info,
  RefreshCw,
  X,
} from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import { isDesktopRuntime } from '@/lib/desktop';
import { listenDesktopEvent } from '@/lib/desktop';
import {
  dshCancelInstall,
  dshEnvCheck,
  dshGetStatus,
  dshInstallNode,
  dshInstallPackage,
  dshRevealDir,
  dshUninstall,
  type DshEnvCheckItem,
  type DshInstallStatus,
} from '@/lib/desktop';

type InstallStage = 'idle' | 'node' | 'package';

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
  const [status, setStatus] = useState<DshInstallStatus | null>(null);
  const [checks, setChecks] = useState<DshEnvCheckItem[]>([]);
  const [checking, setChecking] = useState(false);
  const [stage, setStage] = useState<InstallStage>('idle');
  const [progressMessage, setProgressMessage] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [safetyOpen, setSafetyOpen] = useState(false);

  const installing = stage !== 'idle';

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
    }
  };

  useEffect(() => {
    if (autoCheckedRef.current) return;
    autoCheckedRef.current = true;
    void refreshStatusAndChecks();
  }, []);

  useEffect(() => {
    const unlisten = listenDesktopEvent<{ stage: string; message: string }>('dsh:progress', (payload) => {
      setProgressMessage(payload.message);
    });
    return () => {
      void unlisten.then((dispose) => dispose());
    };
  }, []);

  const handleInstallNode = async () => {
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
    }
  };

  const handleInstallPackage = async () => {
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
    }
  };

  const handleUninstall = async () => {
    if (installing) return;
    try {
      await dshUninstall();
      setActionMessage('dsh 包已卸载（dsh 数据目录与托管 Node 保留）。');
    } catch (error) {
      setActionMessage(`卸载失败：${String(error)}`);
    }
    await refreshStatusAndChecks();
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
                <p>· Agent LLM 仅做托管：dsh 进程只在您点击「开启」后运行，默认只连接本机模型（127.0.0.1），不会静默自启。</p>
              </div>
            )}
          </div>

          {/* 安装状态卡 */}
          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-primary-custom">运行时与安装</h2>
              {packageState}
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
                  <dt className="text-secondary-custom">dsh 数据目录（DSH_HOME）</dt>
                  <dd className="truncate text-primary-custom" title={status.home_dir}>{status.home_dir}</dd>
                </div>
                <div className="flex justify-between gap-3 sm:block">
                  <dt className="text-secondary-custom">dsh 包目录</dt>
                  <dd className="truncate text-primary-custom" title={status.packages_dir}>{status.packages_dir}</dd>
                </div>
              </dl>
            ) : (
              <p className="text-xs text-secondary-custom">正在读取安装状态...</p>
            )}

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                onClick={handleInstallNode}
                disabled={installing || !isDesktopRuntime()}
                className="flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40"
              >
                <Download className="h-3.5 w-3.5" /> 安装 Node 运行时
              </button>
              <button
                onClick={handleInstallPackage}
                disabled={installing || !isDesktopRuntime()}
                className="flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40"
              >
                <Download className="h-3.5 w-3.5" /> 安装 dsh
              </button>
              <button
                onClick={handleUninstall}
                disabled={installing || !isDesktopRuntime() || !status?.package.installed}
                className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs text-secondary-custom transition-colors hover:bg-[var(--surface-muted)] disabled:opacity-40"
              >
                卸载 dsh
              </button>
              <button
                onClick={() => void dshRevealDir('home')}
                className="flex items-center gap-1 rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs text-secondary-custom transition-colors hover:bg-[var(--surface-muted)]"
                title="在资源管理器中打开 dsh 数据目录"
              >
                <FolderOpen className="h-3.5 w-3.5" /> 打开数据目录
              </button>
            </div>

            {installing && progressMessage && (
              <div className="mt-3 flex items-center gap-2 rounded-lg bg-[var(--surface-muted)] px-3 py-2 text-xs">
                <RefreshCw className="h-3.5 w-3.5 animate-spin text-[var(--accent)]" />
                <span className="flex-1 text-secondary-custom">{progressMessage}</span>
                <button
                  onClick={() => void dshCancelInstall()}
                  className="flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-secondary-custom transition-colors hover:bg-[var(--surface)]"
                >
                  <X className="h-3 w-3" /> 取消
                </button>
              </div>
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

          {/* Phase 2/3 占位：进程启停与模型接入 */}
          <section className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface)] p-4">
            <h2 className="mb-1.5 text-sm font-semibold text-primary-custom">开启 dsh 与本地模型接入</h2>
            <p className="text-xs leading-6 text-secondary-custom">
              dsh 进程启停、运行日志与「把当前加载的本地模型一键接入 dsh」将在 v0.4
              后续阶段提供。当前可先完成上方运行时安装与环境检测。
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
