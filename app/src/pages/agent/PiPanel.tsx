import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FolderOpen,
  Loader2,
  Play,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  Square,
  Terminal,
} from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import ToggleSwitch from '@/components/ToggleSwitch';
import { useApp } from '@/context/AppContext';
import { getServerApiKey, isDesktopRuntime, revealDesktopPath } from '@/lib/desktop';
import {
  piAgentClearLogs,
  piAgentDiscover,
  piAgentGetLogs,
  piAgentStop,
} from '@/lib/ipc/pi';
import { usePiRuntime } from '@/features/pi/PiRuntimeContext';
import { resolveAutoPiEndpoint, type PiAutoEndpoint } from '@/lib/piEndpoint';
import {
  hydratePiConfig,
  loadPiConfig,
  PI_AUTO_SESSION_ID,
  savePiConfig,
  type PiConfig,
} from '@/lib/piConfig';

/**
 * Agent 页「Pi」标签：Pi 内核的设置 / 状态 / 日志页。
 *
 * 只把高频项放在第一屏：运行状态、模型端点、权限。
 * Node / CLI / 目录 / 安装升级 / 技能库都属于一次性维护，收进「高级设置」，
 * 避免用户在一堆路径输入框里找不到「为什么连不上模型」。
 *
 * 对话在 Chat 的 Pi 工作区；这里不维护会话与聊天，避免两个界面争抢同一个子进程。
 */

const PERMISSION_LABELS: Record<string, string> = {
  plan: '只读',
  auto: '守门',
  full: '放行',
};

const inputClass =
  'w-full rounded-lg border border-[var(--border)] bg-[var(--app-bg)] px-2.5 py-1.5 text-[length:var(--font-caption)] text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)]';
const buttonClass =
  'inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-[length:var(--font-eyebrow)] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] disabled:cursor-not-allowed disabled:opacity-50';
const primaryButtonClass =
  'inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-2.5 py-1.5 text-[length:var(--font-eyebrow)] font-semibold text-[var(--text-on-accent)] transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50';

function Section({
  icon: Icon,
  title,
  description,
  children,
  actions,
}: {
  icon: typeof Bot;
  title: string;
  description?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <Icon className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--text-tertiary)]" />
          <div className="min-w-0">
            <h3 className="text-[length:var(--font-body)] font-medium text-[var(--text-primary)]">{title}</h3>
            {description ? (
              <p className="mt-0.5 text-[length:var(--font-eyebrow)] leading-relaxed text-[var(--text-tertiary)]">
                {description}
              </p>
            ) : null}
          </div>
        </div>
        {actions ? <div className="flex flex-shrink-0 items-start gap-1.5">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[length:var(--font-eyebrow)] font-medium text-[var(--text-secondary)]">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">{hint}</span> : null}
    </label>
  );
}

export default function PiPanel() {
  const desktop = isDesktopRuntime();
  const { state } = useApp();
  const activeModel = state.models.find((model) => model.id === state.activeModelId);
  const enginePort = activeModel?.serverPort ?? state.serverPort ?? 8080;

  const [config, setConfig] = useState<PiConfig>(() => loadPiConfig());
  const piRuntime = usePiRuntime();
  const status = piRuntime.status;
  const [logs, setLogs] = useState<string[]>([]);
  const [logsOpen, setLogsOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detected, setDetected] = useState<PiAutoEndpoint | null>(null);
  const initializedRef = useRef(false);

  const running = status?.running ?? false;
  // 本机端点 + 主模型没启动 = Pi 一发送就会连不上。提前说清楚，别让用户猜。
  const localEndpoint = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/i.test(config.baseUrl);
  const endpointProbablyDown = localEndpoint && !state.serverRunning;

  const refreshLogs = useCallback(async () => {
    if (!desktop) return;
    try {
      setLogs(await piAgentGetLogs());
    } catch {
      // 日志读取失败静默
    }
  }, [desktop]);

  useEffect(() => {
    if (!desktop || initializedRef.current) return;
    initializedRef.current = true;
    void (async () => {
      const [discover, currentLogs, hydrated] = await Promise.all([
        piAgentDiscover().catch(() => null),
        piAgentGetLogs().catch(() => []),
        hydratePiConfig(loadPiConfig()),
      ]);
      setLogs(currentLogs ?? []);
      const next: PiConfig = {
        ...hydrated,
        nodePath: hydrated.nodePath || discover?.node_path || 'node',
        cliPath: hydrated.cliPath || discover?.cli_path || '',
        agentDir: hydrated.agentDir || discover?.agent_dir || '',
        workDir: hydrated.workDir || discover?.work_dir || '',
        sessionDir: hydrated.sessionDir || discover?.session_dir || '',
        skillsDir: hydrated.skillsDir || discover?.skills_dir || '',
        model: hydrated.model || activeModel?.name || '',
        baseUrl:
          !hydrated.autoEndpoint && hydrated.baseUrl === 'http://127.0.0.1:8080/v1'
            ? `http://127.0.0.1:${enginePort}/v1`
            : hydrated.baseUrl,
      };
      setConfig(next);
      savePiConfig(next);
      setDetected(await resolveAutoPiEndpoint().catch(() => null));
    })();
  }, [activeModel?.name, desktop, enginePort]);

  const update = (patch: Partial<PiConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...patch };
      savePiConfig(next);
      return next;
    });
  };

  const handleDiscover = async () => {
    setBusy('discover');
    setError(null);
    try {
      const discover = await piAgentDiscover();
      if (!discover) return;
      update({
        nodePath: discover.node_path || config.nodePath,
        cliPath: discover.cli_path || config.cliPath,
        agentDir: discover.agent_dir || config.agentDir,
        workDir: discover.work_dir || config.workDir,
        sessionDir: discover.session_dir || config.sessionDir,
        skillsDir: discover.skills_dir || config.skillsDir,
      });
      setMessage('已重新探测 Pi CLI 与目录。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const handleStart = async () => {
    setBusy('start');
    setError(null);
    setMessage(null);
    savePiConfig(config);
    if (!config.cliPath.trim()) {
      setError('请先填写 Pi CLI 路径（cli.js），可在「高级设置」里填或点「重新探测」。');
      setBusy(null);
      return;
    }
    try {
      // 固定会话 id：每次点「启动」都新建会话，会在 <工作区根> 下堆出一堆
      // settings-<时间戳> 目录，并让 Pi 被反复重启。
      await piRuntime.startSession(PI_AUTO_SESSION_ID);
      await piRuntime.refreshStatus();
      setMessage('Pi 已启动。Chat 发送时会切换到对应会话。');
      await refreshLogs();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const handleStop = async () => {
    setBusy('stop');
    setError(null);
    try {
      await piAgentStop();
      await piRuntime.refreshStatus();
      setMessage('Pi 已停止。');
      await refreshLogs();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  /** 把宿主当前服务的 API Key 填进 Pi：开放局域网时服务会开启鉴权，Key 不一致就是 401。 */
  const handleUseServerKey = async () => {
    setBusy('server-key');
    setError(null);
    setMessage(null);
    try {
      const key = (await getServerApiKey())?.trim();
      if (!key) {
        setMessage('本机服务当前没有启用 API Key（回环监听无鉴权），保持 local 即可。');
        return;
      }
      update({ apiKey: key });
      setMessage('已填入本机服务的 API Key；停止并重新启动 Pi 后生效。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const handleClearLogs = async () => {
    try {
      await piAgentClearLogs();
      setLogs([]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  if (!desktop) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <p className="text-[length:var(--font-caption)] text-[var(--text-tertiary)]">
          Pi 需要本机 Node 子进程，仅在桌面版可用。
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-6 pb-2 pt-3">
        <PageHeader
          icon={Bot}
          title="Pi 智能体"
          description="模型端点默认自动对接正在运行的引擎；运行日志与路径收在「高级设置」。对话在 Chat 的 Pi 工作区。"
        />
      </div>

      <div className="mx-auto w-full max-w-6xl space-y-4 px-6 pb-6">
        {/* 运行状态 */}
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span
                  className={`h-2 w-2 flex-shrink-0 rounded-full ${
                    running ? 'bg-[var(--state-success)]' : 'bg-[var(--text-tertiary)]'
                  }`}
                />
                <h2 className="text-[length:var(--font-body)] font-medium text-[var(--text-primary)]">
                  {running ? 'Pi 运行中' : 'Pi 未启动'}
                </h2>
                {status?.pid ? (
                  <span className="mono-font text-[length:var(--font-micro)] text-[var(--text-tertiary)]">
                    PID {status.pid}
                  </span>
                ) : null}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[length:var(--font-eyebrow)] text-[var(--text-secondary)]">
                <span className="truncate">模型 {status?.model || config.model || '—'}</span>
                <span className="truncate">会话 {status?.session_id || '—'}</span>
                <span className="truncate">
                  权限 {PERMISSION_LABELS[status?.permission_mode ?? config.permissionMode] ?? '—'}
                </span>
              </div>
              <p className="mt-1.5 truncate text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]" title={status?.work_dir}>
                工作区 {status?.work_dir || '—'}
              </p>
            </div>
            <div className="flex flex-shrink-0 gap-1.5">
              {running ? (
                <button className={buttonClass} onClick={() => void handleStop()} disabled={busy !== null}>
                  {busy === 'stop' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
                  停止
                </button>
              ) : (
                <button className={primaryButtonClass} onClick={() => void handleStart()} disabled={busy !== null}>
                  {busy === 'start' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                  启动
                </button>
              )}
            </div>
          </div>
          {message ? (
            <p className="mt-2 flex items-center gap-1.5 text-[length:var(--font-eyebrow)] text-[var(--state-success)]">
              <CheckCircle2 className="h-3.5 w-3.5" />
              {message}
            </p>
          ) : null}
          {error ? <p className="mt-2 text-[length:var(--font-eyebrow)] text-[var(--state-danger)]">{error}</p> : null}

          {/* 随应用启动：一个开关决定 Pi 是否跟着应用启停 */}
          <div className="mt-3 flex items-start justify-between gap-3 border-t border-[var(--border-subtle)] pt-3">
            <div className="min-w-0">
              <p className="text-[length:var(--font-body)] font-medium text-[var(--text-primary)]">随应用启动</p>
              <p className="mt-0.5 text-[length:var(--font-eyebrow)] leading-relaxed text-[var(--text-tertiary)]">
                开启：启动软件时自动拉起 Pi，关闭软件时一并停止。关闭：不再自动启动，需要时点上面的「启动」。
              </p>
            </div>
            <ToggleSwitch
              checked={config.autoStart}
              onChange={(checked) => update({ autoStart: checked })}
              label="随应用启动 Pi"
            />
          </div>
        </section>

        {/* 模型端点：默认自动对接正在运行的引擎，不需要用户填地址/模型 ID */}
        <Section
          icon={Bot}
          title="模型端点"
          description="默认自动对接正在运行的引擎：NiNfer 优先，Strata 次之，llama 兜底；切换引擎后下一次发送自动跟上。"
        >
          <div className="flex items-start justify-between gap-3 rounded-lg border border-[var(--border-subtle)] px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-[length:var(--font-body)] font-medium text-[var(--text-primary)]">自动对接</p>
              <p className="mt-0.5 text-[length:var(--font-eyebrow)] leading-relaxed text-[var(--text-tertiary)]">
                检测到运行中的引擎后自动填基址、模型与 Key；本机回环的鉴权 Key 也由宿主直接读取。
              </p>
            </div>
            <ToggleSwitch
              checked={config.autoEndpoint}
              onChange={(checked) => update({ autoEndpoint: checked })}
              label="自动对接模型端点"
            />
          </div>

          {config.autoEndpoint ? (
            <div className="mt-3 rounded-lg border border-[var(--border-subtle)] px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[length:var(--font-eyebrow)] text-[var(--text-secondary)]">
                <span>
                  当前引擎
                  <span className="ml-1 font-medium text-[var(--text-primary)]">
                    {detected?.label ?? '未检测到'}
                  </span>
                </span>
                <span className="truncate">模型 {detected?.model ?? status?.model ?? '启动前自动读取 /v1/models'}</span>
                <button
                  type="button"
                  className="text-[var(--accent)] hover:underline"
                  onClick={() => void resolveAutoPiEndpoint().then(setDetected).catch(() => setDetected(null))}
                >
                  重新检测
                </button>
              </div>
              <p className="mt-1.5 truncate font-mono text-[length:var(--font-micro)] text-[var(--text-tertiary)]" title={detected?.baseUrl}>
                {detected?.baseUrl ?? '先加载模型，或启动 NiNfer / Strata'}
              </p>
            </div>
          ) : (
            <>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <Field label="模型 ID" hint="留空时发送前自动读 /v1/models 取第一个">
                  <input
                    className={inputClass}
                    value={config.model}
                    onChange={(event) => update({ model: event.target.value })}
                    placeholder={activeModel?.name ?? ''}
                  />
                </Field>
                <Field label="引擎地址" hint="OpenAI 兼容端点，一般以 /v1 结尾">
                  <input
                    className={inputClass}
                    value={config.baseUrl}
                    onChange={(event) => update({ baseUrl: event.target.value })}
                  />
                </Field>
              </div>
              <div className="mt-2 flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <Field label="API Key" hint="本机服务开启鉴权时必须与服务一致；没开鉴权保持 local">
                    <input
                      className={inputClass}
                      value={config.apiKey}
                      onChange={(event) => update({ apiKey: event.target.value })}
                    />
                  </Field>
                </div>
                <button
                  className={buttonClass}
                  onClick={() => void handleUseServerKey()}
                  disabled={busy !== null}
                  title="读取宿主当前服务的 API Key 并填入"
                >
                  {busy === 'server-key' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ShieldCheck className="h-3.5 w-3.5" />
                  )}
                  使用本机服务密钥
                </button>
              </div>
              {endpointProbablyDown ? (
                <p className="mt-3 rounded-lg border border-[var(--state-warning)] px-2.5 py-2 text-[length:var(--font-eyebrow)] leading-relaxed text-[var(--state-warning)]">
                  主模型还没启动：Pi 现在发送会连不上 {config.baseUrl}。先回模型页加载模型，或把引擎地址改成实际在跑的服务。
                </p>
              ) : null}
            </>
          )}
          {running ? (
            <p className="mt-3 text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">
              引擎或模型变化后，下一次发送会自动用新端点重启 Pi。
            </p>
          ) : null}
        </Section>

        {/* 高级设置：一次性维护项全部收进来 */}
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <button
            type="button"
            onClick={() => setAdvancedOpen((value) => !value)}
            aria-expanded={advancedOpen}
            className="flex w-full items-center justify-between gap-3 text-left"
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <Terminal className="h-4 w-4 flex-shrink-0 text-[var(--text-tertiary)]" />
              <span className="min-w-0">
                <span className="block text-[length:var(--font-body)] font-medium text-[var(--text-primary)]">高级设置</span>
                <span className="block text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">
                  Node / CLI 路径、目录与重新探测
                </span>
              </span>
            </span>
            {advancedOpen ? (
              <ChevronUp className="h-4 w-4 flex-shrink-0 text-[var(--text-tertiary)]" />
            ) : (
              <ChevronDown className="h-4 w-4 flex-shrink-0 text-[var(--text-tertiary)]" />
            )}
          </button>

          {advancedOpen ? (
            <div className="mt-4 space-y-4">
              <div className="flex flex-wrap gap-1.5">
                <button className={buttonClass} onClick={() => void handleDiscover()} disabled={busy !== null}>
                  <RefreshCw className="h-3.5 w-3.5" />
                  重新探测
                </button>
                <span className="inline-flex items-center text-[length:var(--font-micro)] text-[var(--text-tertiary)]">
                  安装与升级在「设置中心 → 核心更新」里统一处理。
                </span>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <Field label="Node 路径" hint="留 node 表示走 PATH">
                  <input
                    className={inputClass}
                    value={config.nodePath}
                    onChange={(event) => update({ nodePath: event.target.value })}
                    placeholder="node"
                  />
                </Field>
                <Field label="Pi CLI（cli.js）" hint="...\pi-coding-agent\dist\bundle\cli.js">
                  <input
                    className={inputClass}
                    value={config.cliPath}
                    onChange={(event) => update({ cliPath: event.target.value })}
                  />
                </Field>
                <Field label="Agent 配置目录" hint="models.json / settings.json 落点">
                  <input
                    className={inputClass}
                    value={config.agentDir}
                    onChange={(event) => update({ agentDir: event.target.value })}
                  />
                </Field>
                <Field label="工作区根目录" hint="Chat 选中工作区时直接使用该文件夹；未选时按会话派生">
                  <input
                    className={inputClass}
                    value={config.workDir}
                    onChange={(event) => update({ workDir: event.target.value })}
                  />
                </Field>
                <Field label="会话目录" hint="Pi 自己的 session 文件落点">
                  <input
                    className={inputClass}
                    value={config.sessionDir}
                    onChange={(event) => update({ sessionDir: event.target.value })}
                  />
                </Field>
              </div>

            </div>
          ) : null}
        </section>

        {/* 运行日志 */}
        <Section
          icon={ScrollText}
          title="运行日志"
          description="Pi 的 stdout / stderr，排障用。"
          actions={
            <div className="flex gap-1.5">
              <button className={buttonClass} onClick={() => void refreshLogs()}>
                <RefreshCw className="h-3.5 w-3.5" />
                刷新
              </button>
              <button className={buttonClass} onClick={() => void handleClearLogs()}>
                清空
              </button>
              <button className={buttonClass} onClick={() => setLogsOpen((value) => !value)}>
                {logsOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                {logsOpen ? '收起' : '展开'}
              </button>
            </div>
          }
        >
          <p className="text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">已录制 {logs.length} 行。</p>
          {logsOpen ? (
            <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[var(--app-bg)] p-2.5 text-[length:var(--font-micro)] leading-relaxed text-[var(--text-secondary)]">
              {logs.length > 0 ? logs.join('\n') : '（暂无日志）'}
            </pre>
          ) : null}
        </Section>

        {status?.work_dir ? (
          <div className="flex justify-end">
            <button
              className={buttonClass}
              onClick={() => void revealDesktopPath(status.work_dir).catch((reason) => {
                setError(reason instanceof Error ? reason.message : String(reason));
              })}
            >
              <FolderOpen className="h-3.5 w-3.5" />
              打开当前会话工作区
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
