import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Download,
  FolderOpen,
  History,
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
  piAgentInstall,
  piAgentInstallOnline,
  piAgentNpmVersions,
  piAgentRollback,
  piAgentSetPermissionMode,
  piAgentSkillsIndex,
  piAgentStop,
  piAgentVersionInfo,
  type PiNpmVersionsResult,
  type PiVersionInfo,
  type PiPermissionMode,
} from '@/lib/ipc/pi';
import { usePiRuntime } from '@/features/pi/PiRuntimeContext';
import {
  hydratePiConfig,
  loadPiConfig,
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

const PERMISSION_OPTIONS: { value: PiPermissionMode; label: string; hint: string }[] = [
  { value: 'plan', label: '只读', hint: '读/列目录放行；写、改、命令一律拒绝' },
  { value: 'auto', label: '守门', hint: '新建文件放行；覆盖/修改/命令逐条询问' },
  { value: 'full', label: '放行', hint: '工作区内文件操作放行；命令仍以当前用户权限执行，只挡危险命令' },
];

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
  const [skillCount, setSkillCount] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [versionInfo, setVersionInfo] = useState<PiVersionInfo | null>(null);
  const [npmVersions, setNpmVersions] = useState<PiNpmVersionsResult | null>(null);
  const [registryId, setRegistryId] = useState<string>('official');
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
      const [discover, currentLogs, hydrated, versions] = await Promise.all([
        piAgentDiscover().catch(() => null),
        piAgentGetLogs().catch(() => []),
        hydratePiConfig(loadPiConfig()),
        piAgentVersionInfo().catch(() => null),
      ]);
      setLogs(currentLogs ?? []);
      setVersionInfo(versions);
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
          hydrated.baseUrl === 'http://127.0.0.1:8080/v1'
            ? `http://127.0.0.1:${enginePort}/v1`
            : hydrated.baseUrl,
      };
      setConfig(next);
      savePiConfig(next);
    })();
  }, [activeModel?.name, desktop, enginePort]);

  const update = (patch: Partial<PiConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...patch };
      savePiConfig(next);
      return next;
    });
  };

  const refreshVersionInfo = useCallback(async () => {
    try {
      setVersionInfo(await piAgentVersionInfo());
    } catch {
      // 版本信息读取失败静默；安装动作会给出明确错误
    }
  }, []);

  const handleCheckVersions = async () => {
    setBusy('versions');
    setError(null);
    setMessage(null);
    try {
      const registry = versionInfo?.registries.find((option) => option.id === registryId);
      const result = await piAgentNpmVersions(registry?.url);
      setNpmVersions(result);
      setMessage(
        result
          ? `最新版本 v${result.latest}；已安装 ${result.installedVersion ?? '无'}。`
          : null,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const handleInstallOnline = async (version: string) => {
    setBusy('install-online');
    setError(null);
    setMessage(null);
    try {
      const registry = versionInfo?.registries.find((option) => option.id === registryId);
      const result = await piAgentInstallOnline(version, registry?.url, config.nodePath);
      if (!result) return;
      const discover = await piAgentDiscover().catch(() => null);
      if (discover) {
        update({
          cliPath: discover.cli_path || config.cliPath,
          agentDir: discover.agent_dir || config.agentDir,
          workDir: discover.work_dir || config.workDir,
          sessionDir: discover.session_dir || config.sessionDir,
          skillsDir: discover.skills_dir || config.skillsDir,
        });
      }
      await piRuntime.reloadConfig();
      await refreshVersionInfo();
      setNpmVersions(null);
      setMessage(
        `Pi ${result.version} 已在线安装（${(result.bytes / 1024 / 1024).toFixed(1)} MB）；上一版本可回滚。`,
      );
      await refreshLogs();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      await refreshLogs();
    } finally {
      setBusy(null);
    }
  };

  const handleRollback = async () => {
    setBusy('rollback');
    setError(null);
    setMessage(null);
    try {
      const result = await piAgentRollback();
      if (!result) return;
      const discover = await piAgentDiscover().catch(() => null);
      if (discover?.cli_path) update({ cliPath: discover.cli_path });
      await refreshVersionInfo();
      setMessage(`已回滚到 Pi ${result.version}。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
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

  const handleInstall = async () => {
    setBusy('install');
    setError(null);
    setMessage(null);
    try {
      const result = await piAgentInstall(config.cliPath.trim() || undefined);
      if (!result) return;
      const discover = await piAgentDiscover().catch(() => null);
      if (discover) {
        update({
          cliPath: discover.cli_path || config.cliPath,
          agentDir: discover.agent_dir || config.agentDir,
          workDir: discover.work_dir || config.workDir,
          sessionDir: discover.session_dir || config.sessionDir,
          skillsDir: discover.skills_dir || config.skillsDir,
        });
      }
      await piRuntime.reloadConfig();
      setMessage(
        `Pi ${result.version} 已安装到应用数据目录（${(result.bytes / 1024 / 1024).toFixed(1)} MB）。`,
      );
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
      await piRuntime.startSession(`settings-${Date.now()}`);
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

  const handlePermissionMode = async (mode: PiPermissionMode) => {
    update({ permissionMode: mode });
    if (!running) return;
    try {
      await piAgentSetPermissionMode(mode);
      await piRuntime.refreshStatus();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
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

  const handleIndexSkills = async () => {    if (!config.skillsDir.trim()) {
      setError('请先填写技能库目录。');
      return;
    }
    setBusy('skills');
    setError(null);
    try {
      const list = await piAgentSkillsIndex(config.skillsDir);
      setSkillCount(list.length);
      setMessage(`已索引 ${list.length} 个技能（只加载元数据，正文按任务注入）。`);
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

  const currentPermissionMode: PiPermissionMode =
    status?.permission_mode === 'plan' ||
    status?.permission_mode === 'auto' ||
    status?.permission_mode === 'full'
      ? status.permission_mode
      : config.permissionMode;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-6 pb-2 pt-3">
        <PageHeader
          icon={Bot}
          title="Pi 智能体"
          description="常用项只有模型端点与权限；路径与安装维护收在「高级设置」。对话在 Chat 的 Pi 工作区。"
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
                  权限 {PERMISSION_OPTIONS.find((option) => option.value === currentPermissionMode)?.label ?? '—'}
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

        {/* 模型端点：最常改的两项 + Key */}
        <Section
          icon={Bot}
          title="模型端点"
          description="Pi 通过 OpenAI 兼容接口访问模型；这里要和实际在跑的服务一致。"
        >
          <div className="grid gap-2 sm:grid-cols-2">
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
          {running ? (
            <p className="mt-3 text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">
              端点、模型或 API Key 改动后，下一次发送会自动用新配置重启 Pi。
            </p>
          ) : null}
        </Section>

        {/* 权限：三档按钮即可 */}
        <Section
          icon={ShieldCheck}
          title="权限"
          description="文件与命令统一按档判定；命令执行仍不是 OS 级沙箱。"
        >
          <div className="grid grid-cols-3 gap-1.5">
            {PERMISSION_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                title={option.hint}
                onClick={() => void handlePermissionMode(option.value)}
                className={`rounded-lg border px-2 py-1.5 text-[length:var(--font-eyebrow)] font-medium transition-colors ${
                  currentPermissionMode === option.value
                    ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--text-on-accent)]'
                    : 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">
            {PERMISSION_OPTIONS.find((option) => option.value === currentPermissionMode)?.hint ?? ''}
          </p>
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
                  Node / CLI 路径、目录、在线安装与回滚、技能库
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
                <button className={buttonClass} onClick={() => void handleInstall()} disabled={busy !== null}>
                  {busy === 'install' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <FolderOpen className="h-3.5 w-3.5" />
                  )}
                  安装到应用目录
                </button>
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
                <Field label="工作区根目录" hint="每个 Chat 会话使用其下的独立子目录">
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

              <div className="rounded-lg border border-[var(--border)] p-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[length:var(--font-eyebrow)] text-[var(--text-secondary)]">
                  <span className="font-medium text-[var(--text-primary)]">在线安装 / 升级</span>
                  <span>
                    已安装 {versionInfo?.installedVersion ?? '无'}
                    {versionInfo?.lock ? `（来源 ${versionInfo.lock.source}）` : ''}
                  </span>
                  {npmVersions ? <span>最新 {npmVersions.latest}</span> : null}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <select
                    className="rounded-lg border border-[var(--border)] bg-[var(--app-bg)] px-2 py-1.5 text-[length:var(--font-eyebrow)] text-[var(--text-primary)] outline-none"
                    value={registryId}
                    onChange={(event) => setRegistryId(event.target.value)}
                    title="npm registry 下载源"
                  >
                    {(versionInfo?.registries ?? [{ id: 'official', label: '官方 npm', url: '' }]).map(
                      (option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ),
                    )}
                  </select>
                  <button
                    className={buttonClass}
                    onClick={() => void handleCheckVersions()}
                    disabled={busy !== null}
                  >
                    {busy === 'versions' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    检查版本
                  </button>
                  <button
                    className={primaryButtonClass}
                    onClick={() => void handleInstallOnline(npmVersions?.latest ?? '')}
                    disabled={busy !== null || !npmVersions?.latest}
                    title={
                      npmVersions?.latest
                        ? `安装 v${npmVersions.latest}`
                        : '先「检查版本」再安装'
                    }
                  >
                    {busy === 'install-online' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                    安装 / 升级最新
                  </button>
                  <button
                    className={buttonClass}
                    onClick={() => void handleRollback()}
                    disabled={busy !== null || !versionInfo?.rollbackAvailable}
                    title={
                      versionInfo?.lock?.previousVersion
                        ? `回滚到 v${versionInfo.lock.previousVersion}`
                        : '回滚到升级前的版本'
                    }
                  >
                    {busy === 'rollback' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <History className="h-3.5 w-3.5" />
                    )}
                    回滚
                  </button>
                </div>
                {npmVersions && npmVersions.versions.length > 1 ? (
                  <div className="mt-2 flex flex-wrap items-center gap-1">
                    <span className="text-[length:var(--font-micro)] text-[var(--text-tertiary)]">其他版本：</span>
                    {npmVersions.versions.slice(0, 8).map((info) => (
                      <button
                        key={info.version}
                        className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[length:var(--font-micro)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)]"
                        onClick={() => void handleInstallOnline(info.version)}
                        disabled={busy !== null}
                        title={`安装 v${info.version}`}
                      >
                        v{info.version}
                      </button>
                    ))}
                  </div>
                ) : null}
                <p className="mt-2 text-[length:var(--font-micro)] leading-relaxed text-[var(--text-tertiary)]">
                  安装位置：`%APPDATA%\AgentLLM\pi\node_modules`；版本锁 `pi-version.json`。
                </p>
              </div>

              <div className="rounded-lg border border-[var(--border)] p-3">
                <div className="grid grid-cols-[1fr_auto] items-end gap-2">
                  <Field
                    label="技能库目录"
                    hint={
                      skillCount !== null
                        ? `已索引 ${skillCount} 个技能`
                        : '只加载元数据，正文按任务注入'
                    }
                  >
                    <input
                      className={inputClass}
                      value={config.skillsDir}
                      onChange={(event) => update({ skillsDir: event.target.value })}
                      placeholder="…\data\skills"
                    />
                  </Field>
                  <button className={buttonClass} onClick={() => void handleIndexSkills()} disabled={busy !== null}>
                    {busy === 'skills' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    索引技能
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => update({ skillRoutingEnabled: !config.skillRoutingEnabled })}
                  className={`mt-2 w-full rounded-lg border px-2.5 py-1.5 text-[length:var(--font-caption)] font-medium transition-colors ${
                    config.skillRoutingEnabled
                      ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--text-on-accent)]'
                      : 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]'
                  }`}
                >
                  技能路由：{config.skillRoutingEnabled ? '已开启' : '已关闭'}
                </button>
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
