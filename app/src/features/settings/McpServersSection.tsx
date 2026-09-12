import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleSlash,
  Loader2,
  Plug,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  X,
} from 'lucide-react';
import { useApp } from '@/context/AppContext';
import {
  connectMcpServer,
  deleteMcpServer,
  disconnectMcpServer,
  getMcpStatuses,
  isDesktopRuntime,
  mcpTransportIsNetwork,
  mcpTransportLabel,
  saveMcpServer,
  validateMcpEndpoint,
} from '@/lib/desktop';
import type { McpEnvVar, McpServerConfig, McpServerEntry, McpServerStatus, McpTransport } from '@/types';

/** 新建服务器时的默认值（超时 60 秒，与后端默认一致）。 */
function emptyDraft(): McpServerConfig {
  return {
    id: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: '',
    enabled: true,
    transport: 'stdio',
    command: 'npx',
    args: [],
    env: [],
    cwd: null,
    headers: [],
    timeoutMs: 60_000,
  };
}

/** 传输方式的中文说明。 */
const TRANSPORT_OPTIONS: Array<{ value: McpTransport; label: string; hint: string }> = [
  { value: 'stdio', label: 'stdio', hint: '本机子进程，通过标准输入输出通信，全程不出本机。' },
  { value: 'http', label: 'Streamable HTTP', hint: 'POST 到远端端点，适用于新版 HTTP MCP 服务。' },
  { value: 'sse', label: 'HTTP + SSE', hint: '旧版 HTTP+SSE：GET 长连接接收结果，适用于较早的服务。' },
];

/** 把界面上的「每行一个参数」文本转成参数数组，忽略空行。 */
function parseArgsText(text: string) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function argsToText(args: string[]) {
  return args.join('\n');
}

function stateLabel(state: McpServerStatus['state']) {
  if (state === 'ready') return '已连接';
  if (state === 'starting') return '连接中';
  if (state === 'error') return '连接失败';
  return '未连接';
}

function stateClass(state: McpServerStatus['state']) {
  if (state === 'ready') return 'border-[var(--state-success-border)] bg-[var(--state-success-bg)] text-[var(--state-success)]';
  if (state === 'error') return 'border-[var(--state-danger-border)] bg-[var(--state-danger-bg)] text-[var(--state-danger)]';
  if (state === 'starting') return 'border-[var(--state-warning-border)] bg-[var(--state-warning-bg)] text-[var(--state-warning)]';
  return 'border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text-secondary)]';
}

export default function McpServersSection() {
  const { state, dispatch } = useApp();
  const [draft, setDraft] = useState<McpServerConfig | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const servers = state.mcpServers;

  const refreshStatuses = useCallback(async () => {
    if (!isDesktopRuntime()) return;
    try {
      const statuses = await getMcpStatuses();
      dispatch({ type: 'SET_MCP_STATUSES', payload: statuses });
    } catch {
      // 状态轮询失败保持上一次结果，不打断界面。
    }
  }, [dispatch]);

  // 状态轮询：已连接的服务器子进程可能自己退出，界面需要跟上。
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let disposed = false;
    let timer: number | null = null;
    const tick = async () => {
      if (disposed) return;
      await refreshStatuses();
      if (!disposed) timer = window.setTimeout(tick, 5000);
    };
    void tick();
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [refreshStatuses]);

  const connectedCount = useMemo(
    () => servers.filter((server) => server.state === 'ready').length,
    [servers]
  );
  const toolCount = useMemo(
    () => servers.reduce((total, server) => total + (server.tools?.length ?? 0), 0),
    [servers]
  );

  const handleSave = async () => {
    if (!draft) return;
    if (!draft.name.trim()) {
      setError('请填写服务器名称。');
      return;
    }
    if (!draft.command.trim()) {
      setError(mcpTransportIsNetwork(draft.transport) ? '请填写 MCP 端点地址。' : '请填写启动命令（例如 npx）。');
      return;
    }
    if (mcpTransportIsNetwork(draft.transport)) {
      const endpointError = validateMcpEndpoint(draft.command);
      if (endpointError) {
        setError(endpointError);
        return;
      }
    }
    setError(null);
    try {
      const next = await saveMcpServer({
        ...draft,
        name: draft.name.trim(),
        command: draft.command.trim(),
      });
      dispatch({ type: 'SET_MCP_SERVERS', payload: next });
      setMessage(`已保存「${draft.name.trim()}」。`);
      setDraft(null);
      await refreshStatuses();
    } catch (error) {
      setError(`保存失败：${String(error)}`);
    }
  };

  const handleDelete = async (server: McpServerEntry) => {
    if (!window.confirm(`确定删除 MCP 服务器「${server.name}」吗？正在运行的连接会一并断开。`)) return;
    setError(null);
    try {
      const next = await deleteMcpServer(server.id);
      dispatch({ type: 'SET_MCP_SERVERS', payload: next });
      setMessage(`已删除「${server.name}」。`);
      if (draft?.id === server.id) setDraft(null);
    } catch (error) {
      setError(`删除失败：${String(error)}`);
    }
  };

  const handleConnect = async (server: McpServerEntry) => {
    setBusyId(server.id);
    setError(null);
    setMessage(null);
    try {
      const status = await connectMcpServer(server.id);
      if (status) {
        dispatch({ type: 'SET_MCP_STATUSES', payload: [status] });
        setMessage(`「${server.name}」已连接，发现 ${status.tools.length} 个工具。`);
      }
    } catch (error) {
      setError(`「${server.name}」连接失败：${String(error)}`);
      await refreshStatuses();
    } finally {
      setBusyId(null);
    }
  };

  const handleDisconnect = async (server: McpServerEntry) => {
    setBusyId(server.id);
    setError(null);
    try {
      await disconnectMcpServer(server.id);
      dispatch({ type: 'SET_MCP_STATUSES', payload: [{ ...server, state: 'stopped', tools: [], pid: null }] });
      setMessage(`「${server.name}」已断开。`);
    } catch (error) {
      setError(`断开失败：${String(error)}`);
    } finally {
      setBusyId(null);
    }
  };

  const toggleAutoConnect = async (server: McpServerEntry) => {
    setError(null);
    try {
      const next = await saveMcpServer({ ...toConfig(server), enabled: !server.enabled });
      dispatch({ type: 'SET_MCP_SERVERS', payload: next });
      await refreshStatuses();
    } catch (error) {
      setError(`保存失败：${String(error)}`);
    }
  };

  return (
    <section className="border-b border-[var(--border-subtle)] py-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-2">
            <Plug className="h-4.5 w-4.5 text-[var(--accent)]" />
            <h2 className="text-[15px] font-semibold text-primary-custom">MCP 服务器</h2>
          </div>
          <p className="text-sm leading-6 text-secondary-custom">
            接入 Model Context Protocol 服务器，把它们的工具交给对话里的模型调用。
          </p>
          <p className="mt-1 text-xs leading-5 text-secondary-custom">
            {servers.length === 0
              ? '尚未配置服务器。'
              : `已配置 ${servers.length} 个 · 已连接 ${connectedCount} 个 · 共 ${toolCount} 个工具`}
          </p>
          <p className="mt-2 flex items-start gap-2 text-xs leading-5 text-[var(--state-warning)] dark:text-[var(--accent)]">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            MCP 服务器是以你的权限运行的本机程序，会读写文件或执行命令。只添加你信任的来源。
          </p>
        </div>
        <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setError(null);
              setMessage(null);
              setDraft(emptyDraft());
            }}
            className="flex h-9 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)] dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[var(--text-secondary)] dark:hover:bg-white/[0.09]"
          >
            <Plus className="h-4 w-4" />
            添加服务器
          </button>
          <button
            type="button"
            onClick={() => void refreshStatuses()}
            className="flex h-9 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)] dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[var(--text-secondary)] dark:hover:bg-white/[0.09]"
          >
            <RefreshCw className="h-4 w-4" />
            刷新状态
          </button>
        </div>
      </div>

      {message && <p className="mt-3 text-xs leading-5 text-[var(--state-success)]">{message}</p>}
      {error && (
        <p className="mt-3 flex items-start gap-2 text-xs leading-5 text-[var(--state-danger)]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </p>
      )}

      {/* 编辑表单 */}
      {draft && (
        <McpServerForm
          draft={draft}
          onChange={setDraft}
          onSave={() => void handleSave()}
          onCancel={() => {
            setDraft(null);
            setError(null);
          }}
          isNew={!servers.some((server) => server.id === draft.id)}
        />
      )}

      {/* 服务器列表 */}
      {servers.length > 0 && (
        <div className="mt-4 divide-y divide-[var(--border-subtle)]">
          {servers.map((server) => {
            const status = (server.state ?? 'stopped') as McpServerStatus['state'];
            const tools = server.tools ?? [];
            const expanded = expandedId === server.id;
            const busy = busyId === server.id;
            return (
              <div key={server.id} className="py-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <Server className="h-4 w-4 flex-shrink-0 text-[var(--accent)]" />
                      <span className="text-sm font-semibold text-primary-custom">{server.name}</span>
                      <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${stateClass(status)}`}>
                        {busy ? '处理中…' : stateLabel(status)}
                      </span>
                      <span className="rounded-md bg-black/[0.04] px-1.5 py-0.5 text-[11px] text-secondary-custom dark:bg-white/[0.06]">
                        {mcpTransportLabel(server.transport)}
                      </span>
                      {server.enabled && (
                        <span className="rounded-md bg-black/[0.04] px-1.5 py-0.5 text-[11px] text-secondary-custom dark:bg-white/[0.06]">
                          随对话自动连接
                        </span>
                      )}
                      {status === 'ready' && tools.length > 0 && (
                        <span className="rounded-md bg-black/[0.04] px-1.5 py-0.5 text-[11px] text-secondary-custom dark:bg-white/[0.06]">
                          {tools.length} 个工具
                        </span>
                      )}
                    </div>
                    <p className="mono-font mt-1 break-all text-xs leading-5 text-secondary-custom">
                      {mcpTransportIsNetwork(server.transport)
                        ? server.command
                        : `${server.command} ${parseArgsText(argsToText(server.args)).join(' ')}`}
                    </p>
                    {server.serverInfo && (
                      <p className="mt-1 text-xs text-[var(--text-tertiary)]">服务信息：{server.serverInfo}</p>
                    )}
                    {status === 'error' && server.error && (
                      <p className="mt-1 break-words text-xs leading-5 text-[var(--state-danger)]">{server.error}</p>
                    )}
                    {server.lastStderr && (
                      <p className="mono-font mt-1 break-all text-[11px] leading-5 text-[var(--text-tertiary)]">
                        stderr：{server.lastStderr}
                      </p>
                    )}
                  </div>

                  <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
                    {tools.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setExpandedId(expanded ? null : server.id)}
                        className="flex h-9 items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)] dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[var(--text-secondary)] dark:hover:bg-white/[0.09]"
                      >
                        {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        工具
                      </button>
                    )}
                    {status === 'ready' ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleDisconnect(server)}
                        className="flex h-9 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)] disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[var(--text-secondary)] dark:hover:bg-white/[0.09]"
                      >
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CircleSlash className="h-4 w-4" />}
                        断开
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleConnect(server)}
                        className="flex h-9 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)] disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[var(--text-secondary)] dark:hover:bg-white/[0.09]"
                      >
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
                        连接
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setError(null);
                        setDraft({ ...toConfig(server) });
                      }}
                      className="flex h-9 items-center rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)] dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[var(--text-secondary)] dark:hover:bg-white/[0.09]"
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDelete(server)}
                      aria-label={`删除 ${server.name}`}
                      title="删除该服务器"
                      className="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--state-danger)] transition-colors hover:bg-[var(--state-danger-border)]"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {status === 'ready' && (
                  <label className="mt-2 inline-flex cursor-pointer items-center gap-2 text-xs text-secondary-custom">
                    <input
                      type="checkbox"
                      checked={server.enabled}
                      onChange={() => void toggleAutoConnect(server)}
                      className="h-3.5 w-3.5 accent-[var(--accent)]"
                    />
                    下次启动时自动连接
                  </label>
                )}

                {expanded && tools.length > 0 && (
                  <div className="mt-3 space-y-2 border-l-2 border-[var(--border-subtle)] pl-3">
                    {tools.map((tool) => (
                      <div key={tool.qualifiedName} className="min-w-0">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <CircleCheck className="h-3.5 w-3.5 flex-shrink-0 text-[var(--accent)]" />
                          <span className="text-sm font-medium text-primary-custom">{tool.name}</span>
                          <span className="mono-font break-all rounded-md bg-black/[0.04] px-1.5 py-0.5 text-[11px] text-secondary-custom dark:bg-white/[0.06]">
                            {tool.qualifiedName}
                          </span>
                          {tool.destructive && (
                            <span className="rounded-full border border-[var(--state-warning-border)] bg-[var(--state-warning-bg)] px-2 py-0.5 text-[11px] font-medium text-[var(--state-warning)]">
                              可能修改数据
                            </span>
                          )}
                        </div>
                        {tool.description && (
                          <p className="mt-0.5 text-xs leading-5 text-secondary-custom">{tool.description}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** 从带运行状态的合并对象里取回纯配置（避免把 state/tools 写回 config.json）。 */
function toConfig(server: McpServerEntry): McpServerConfig {
  return {
    id: server.id,
    name: server.name,
    enabled: server.enabled,
    transport: server.transport ?? 'stdio',
    command: server.command,
    args: server.args ?? [],
    env: server.env ?? [],
    cwd: server.cwd ?? null,
    headers: server.headers ?? [],
    timeoutMs: server.timeoutMs ?? 60_000,
  };
}

function McpServerForm({
  draft,
  onChange,
  onSave,
  onCancel,
  isNew,
}: {
  draft: McpServerConfig;
  onChange: (next: McpServerConfig) => void;
  onSave: () => void;
  onCancel: () => void;
  isNew: boolean;
}) {
  const [argsText, setArgsText] = useState(() => argsToText(draft.args));
  const [envText, setEnvText] = useState(() =>
    (draft.env ?? []).map((item) => `${item.key}=${item.value}`).join('\n')
  );
  const [headersText, setHeadersText] = useState(() =>
    (draft.headers ?? []).map((item) => `${item.key}=${item.value}`).join('\n')
  );

  const transport: McpTransport = draft.transport ?? 'stdio';
  const isNetwork = mcpTransportIsNetwork(transport);
  const endpointError = isNetwork && draft.command.trim() ? validateMcpEndpoint(draft.command) : null;

  const commitArgs = (text: string) => {
    setArgsText(text);
    onChange({ ...draft, args: parseArgsText(text) });
  };

  const parseKeyValues = (text: string) =>
    parseArgsText(text)
      .map((line) => {
        const separator = line.indexOf('=');
        if (separator <= 0) return null;
        return { key: line.slice(0, separator).trim(), value: line.slice(separator + 1) };
      })
      .filter((item): item is McpEnvVar => Boolean(item && item.key));

  const commitEnv = (text: string) => {
    setEnvText(text);
    onChange({ ...draft, env: parseKeyValues(text) });
  };

  const commitHeaders = (text: string) => {
    setHeadersText(text);
    onChange({ ...draft, headers: parseKeyValues(text) });
  };

  const switchTransport = (next: McpTransport) => {
    // 切换传输时清掉上一类的输入，避免把命令残留在 URL 字段里（反之亦然）。
    onChange({ ...draft, transport: next, command: next === 'stdio' ? 'npx' : '' });
  };

  const fieldClass = 'w-full rounded-lg border border-[var(--border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--accent)] dark:border-white/[0.08] dark:bg-[var(--app-bg)] dark:text-[var(--text-primary)] dark:placeholder:text-[var(--text-tertiary)]';

  return (
    <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/60 p-4 dark:border-white/[0.08] dark:bg-white/[0.03]">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-primary-custom">
          {isNew ? '添加 MCP 服务器' : `编辑「${draft.name || '未命名'}」`}
        </h3>
        <button
          type="button"
          onClick={onCancel}
          aria-label="取消编辑"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors hover:bg-[var(--border)] dark:hover:bg-white/[0.08]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* 传输方式 */}
      <div className="mb-3">
        <span className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">传输方式</span>
        <div className="flex flex-wrap items-center gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-0.5 dark:border-white/[0.08] dark:bg-white/[0.04]">
          {TRANSPORT_OPTIONS.map((option) => {
            const active = transport === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => switchTransport(option.value)}
                aria-pressed={active}
                className={`flex h-8 items-center rounded-md px-3 text-xs font-medium transition-colors ${
                  active
                    ? 'bg-[var(--surface)] text-[var(--accent)] shadow-sm dark:bg-[var(--surface-raised)] dark:text-[var(--accent)]'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] dark:text-[var(--text-secondary)] dark:hover:text-[var(--text-primary)]'
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
        <span className="mt-1 block text-[11px] leading-4 text-[var(--text-tertiary)]">
          {TRANSPORT_OPTIONS.find((option) => option.value === transport)?.hint}
        </span>
        {isNetwork && (
          <span className="mt-1 flex items-start gap-1.5 text-[11px] leading-4 text-[var(--state-warning)]">
            <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" />
            网络传输会把对话内容与工具参数发送到该端点所属的第三方服务。
          </span>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="min-w-0">
          <span className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">名称</span>
          <input
            value={draft.name}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
            placeholder="例如 filesystem"
            className={fieldClass}
          />
          <span className="mt-1 block text-[11px] leading-4 text-[var(--text-tertiary)]">
            工具名会带上这个前缀：mcp__名称__工具名
          </span>
        </label>

        <label className="min-w-0">
          <span className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">
            {isNetwork ? '端点地址' : '启动命令'}
          </span>
          <input
            value={draft.command}
            onChange={(event) => onChange({ ...draft, command: event.target.value })}
            placeholder={isNetwork
              ? 'https://example.com/mcp'
              : 'npx / node / python / 绝对路径'}
            className={`${fieldClass} mono-font`}
          />
          {isNetwork ? (
            endpointError ? (
              <span className="mt-1 block text-[11px] leading-4 text-[var(--state-danger)]">{endpointError}</span>
            ) : (
              <span className="mt-1 block text-[11px] leading-4 text-[var(--text-tertiary)]">
                仅支持 http / https，且不允许指向本机或内网地址。
              </span>
            )
          ) : (
            <span className="mt-1 block text-[11px] leading-4 text-[var(--text-tertiary)]">
              参数逐项传递，不经过 shell。
            </span>
          )}
        </label>
      </div>

      {isNetwork ? (
        <label className="mt-3 block min-w-0">
          <span className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">
            请求头（每行 KEY=VALUE，可选）
          </span>
          <textarea
            value={headersText}
            onChange={(event) => commitHeaders(event.target.value)}
            rows={2}
            placeholder={'Authorization=Bearer sk-xxxx'}
            className={`${fieldClass} mono-font resize-y leading-6`}
          />
          <span className="mt-1 block text-[11px] leading-4 text-[var(--text-tertiary)]">
            需要鉴权的端点在此填 Token；不要写进 URL 里。
          </span>
        </label>
      ) : (
        <>
          <label className="mt-3 block min-w-0">
            <span className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">参数（每行一个）</span>
            <textarea
              value={argsText}
              onChange={(event) => commitArgs(event.target.value)}
              rows={3}
              placeholder={'-y\n@modelcontextprotocol/server-filesystem\nD:\\Projects'}
              className={`${fieldClass} mono-font resize-y leading-6`}
            />
          </label>

          <label className="mt-3 block min-w-0">
            <span className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">
              环境变量（每行 KEY=VALUE）
            </span>
            <textarea
              value={envText}
              onChange={(event) => commitEnv(event.target.value)}
              rows={2}
              placeholder="API_KEY=xxxx"
              className={`${fieldClass} mono-font resize-y leading-6`}
            />
          </label>
        </>
      )}

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {!isNetwork && (
          <label className="min-w-0">
            <span className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">工作目录（可选）</span>
            <input
              value={draft.cwd ?? ''}
              onChange={(event) => onChange({ ...draft, cwd: event.target.value || null })}
              placeholder="留空则继承应用目录"
              className={`${fieldClass} mono-font`}
            />
          </label>
        )}
        <label className="min-w-0">
          <span className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">请求超时（秒）</span>
          <input
            type="number"
            min={5}
            max={600}
            value={Math.round((draft.timeoutMs ?? 60_000) / 1000)}
            onChange={(event) => {
              const seconds = Number(event.target.value);
              if (!Number.isFinite(seconds)) return;
              onChange({ ...draft, timeoutMs: Math.min(600, Math.max(5, Math.round(seconds))) * 1000 });
            }}
            className={`${fieldClass} mono-font`}
          />
        </label>
      </div>

      <label className="mt-3 inline-flex cursor-pointer items-center gap-2 text-xs text-secondary-custom">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => onChange({ ...draft, enabled: event.target.checked })}
          className="h-3.5 w-3.5 accent-[var(--accent)]"
        />
        应用启动后自动连接（否则只在工具页手动连接）
      </label>

      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="h-9 rounded-lg px-3 text-sm text-[var(--text-secondary)] transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
        >
          取消
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={Boolean(endpointError)}
          className="h-9 rounded-lg bg-[var(--text-primary)] px-4 text-sm font-medium text-[var(--app-bg)] transition-colors hover:bg-[var(--text-primary)] disabled:opacity-50 dark:bg-[var(--accent)] dark:text-white dark:hover:bg-[var(--accent-hover)]"
        >
          保存
        </button>
      </div>
    </div>
  );
}
