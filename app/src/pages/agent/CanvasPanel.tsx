import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  ExternalLink,
  FolderOpen,
  HardDrive,
  Infinity as InfinityIcon,
  Info,
  Loader2,
  Monitor,
  Play,
  RefreshCw,
  Save,
  Square,
  Terminal,
  Wand2,
  type LucideIcon,
} from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import {
  DEFAULT_CANVAS_CONFIG,
  canvasClearLogs,
  canvasGetConfig,
  canvasGetStatus,
  canvasInstallNode,
  canvasInstallPackFromUrl,
  canvasInstallPackFromZip,
  canvasOpenBrowser,
  canvasOpenWindow,
  canvasRevealDataDir,
  canvasSaveConfig,
  canvasStart,
  canvasStop,
  onCanvasInstallProgress,
  type CanvasConfig,
  type CanvasStatus,
} from '@/lib/desktop';
import { isDesktopRuntime } from '@/lib/desktopRuntime';

/** 画布模块的发布信息。未发布时只保留本地 zip 安装路径。 */
const CANVAS_PACK_RELEASE = {
  version: '0.24.7',
  url: 'https://github.com/xiaojiu131619-max/saya_LLM/releases/download/canvas-v0.24.7/Agent_LLM_Canvas_v0.24.7.zip',
  sha256: '42a4311b6f1ccc1d44ef1d730a05ed6a40d9fff833c16aad2ecd6a181cdd44e8',
};

type BusyKind = 'start' | 'stop' | 'node' | 'pack' | 'save' | null;

function statusDot(ok: boolean, pending = false) {
  if (pending) return 'bg-[var(--state-warning)]';
  return ok ? 'bg-[var(--state-success)]' : 'bg-[var(--state-danger)]';
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[length:var(--font-eyebrow)] ${
        ok
          ? 'border-[var(--state-success-border)] bg-[var(--state-success-bg)] text-[var(--state-success)]'
          : 'border-[var(--state-danger-border)] bg-[var(--state-danger-bg)] text-[var(--state-danger)]'
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-[var(--state-success)]' : 'bg-[var(--state-danger)]'}`} />
      {label}
    </span>
  );
}

function SectionCard({
  title,
  icon: Icon,
  children,
  actions,
}: {
  title: string;
  icon: LucideIcon;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="mb-3 flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 text-[var(--accent)]" />
        <h2 className="text-sm font-semibold text-primary-custom">{title}</h2>
        <span className="flex-1" />
        {actions}
      </div>
      {children}
    </section>
  );
}

export default function CanvasPanel() {
  const desktop = isDesktopRuntime();
  const [status, setStatus] = useState<CanvasStatus | null>(null);
  const [config, setConfig] = useState<CanvasConfig>(DEFAULT_CANVAS_CONFIG);
  const [busy, setBusy] = useState<BusyKind>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'ok'; text: string } | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [packUrl, setPackUrl] = useState(CANVAS_PACK_RELEASE.url);
  const [packSha, setPackSha] = useState(CANVAS_PACK_RELEASE.sha256);
  const [showAdvancedPack, setShowAdvancedPack] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    if (!desktop) return;
    setRefreshing(true);
    try {
      const next = await canvasGetStatus();
      if (!mounted.current) return;
      if (next) {
        setStatus(next);
      }
    } catch (error) {
      if (mounted.current) setMessage({ tone: 'error', text: String(error) });
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }, [desktop]);

  useEffect(() => {
    mounted.current = true;
    if (!desktop) return;
    void (async () => {
      try {
        const [nextConfig, nextStatus] = await Promise.all([
          canvasGetConfig().catch(() => DEFAULT_CANVAS_CONFIG),
          canvasGetStatus().catch(() => null),
        ]);
        if (!mounted.current) return;
        setConfig(nextConfig);
        if (nextStatus) {
          setStatus(nextStatus);
          setConfig(nextStatus.config);
        }
      } catch (error) {
        if (mounted.current) setMessage({ tone: 'error', text: String(error) });
      }
    })();
    const timer = window.setInterval(() => {
      void refresh();
    }, 5000);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [desktop, refresh]);

  useEffect(() => {
    if (!desktop) return;
    let unlisten: (() => void) | null = null;
    void onCanvasInstallProgress((event) => {
      if (!mounted.current) return;
      setProgress(event.message);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, [desktop]);

  const running = Boolean(status?.running);
  const packReady = Boolean(status?.pack.installed);
  const nodeReady = Boolean(status?.node.ok);
  const comfyReady = Boolean(status?.comfy_reachable);
  const canStart = packReady && nodeReady && !running;
  const gatewayReady = Boolean(status?.gateway_ready);

  const nodeLabel = useMemo(() => {
    if (!status) return '未检测';
    if (!status.node.ok) return '未安装';
    const source = status.node.source === 'system' ? '系统' : '托管';
    return `${source} v${status.node.version ?? '?'}`;
  }, [status]);

  const packLabel = useMemo(() => {
    if (!status?.pack.installed) return '未安装';
    const version = status.pack.version ? `v${status.pack.version}` : '已安装';
    const source = status.pack.source === 'installed'
      ? ''
      : status.pack.source === 'resource'
        ? '（内置）'
        : '（本地）';
    return `${version}${source}`;
  }, [status]);

  const runAction = async (kind: BusyKind, action: () => Promise<void>) => {
    if (!desktop) {
      setMessage({ tone: 'error', text: '画布只在桌面版可用。' });
      return;
    }
    setBusy(kind);
    setMessage(null);
    setProgress(null);
    try {
      await action();
      await refresh();
    } catch (error) {
      setMessage({ tone: 'error', text: String(error) });
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const handleStart = () =>
    runAction('start', async () => {
      const next = await canvasStart();
      if (mounted.current) {
        setStatus(next);
        setConfig(next.config);
      }
      if (next.config.open_in_window) {
        await canvasOpenWindow().catch((error) => {
          if (mounted.current) setMessage({ tone: 'error', text: `画布已启动，但窗口打开失败：${String(error)}` });
        });
      } else {
        await canvasOpenBrowser().catch(() => {});
      }
    });

  const handleStop = () =>
    runAction('stop', async () => {
      await canvasStop();
    });

  const handleOpen = () =>
    runAction(null, async () => {
      await canvasOpenWindow();
    });

  const handleOpenBrowser = () =>
    runAction(null, async () => {
      await canvasOpenBrowser();
    });

  const handleInstallNode = () =>
    runAction('node', async () => {
      const version = await canvasInstallNode();
      if (mounted.current) setMessage({ tone: 'ok', text: `Node.js v${version} 已就绪。` });
    });

  const handleInstallPackLocal = () =>
    runAction('pack', async () => {
      const selected = await openFileDialog({
        multiple: false,
        directory: false,
        filters: [{ name: '画布模块压缩包', extensions: ['zip'] }],
      });
      if (!selected || typeof selected !== 'string') return;
      const next = await canvasInstallPackFromZip(selected);
      if (mounted.current) {
        setMessage({ tone: 'ok', text: `画布模块已安装${next.version ? `（v${next.version}）` : ''}。` });
      }
    });

  const handleDownloadPack = () =>
    runAction('pack', async () => {
      if (!packUrl.trim() || !packSha.trim()) {
        throw new Error('请先填写画布模块下载地址和 SHA256 校验值。');
      }
      const next = await canvasInstallPackFromUrl(packUrl.trim(), packSha.trim());
      if (mounted.current) {
        setMessage({ tone: 'ok', text: `画布模块已安装${next.version ? `（v${next.version}）` : ''}。` });
      }
    });

  const handleSaveConfig = () =>
    runAction('save', async () => {
      const saved = await canvasSaveConfig(config);
      if (mounted.current) {
        setConfig(saved);
        setMessage({
          tone: 'ok',
          text: running ? '设置已保存。画布正在运行，端口/ComfyUI 地址改动需要停止后重新启动才会生效。' : '设置已保存。',
        });
      }
    });

  const handleClearLogs = () =>
    runAction(null, async () => {
      await canvasClearLogs();
      await refresh();
    });

  const content = (
    <div className="mx-auto max-w-3xl space-y-4">
      {!desktop && (
        <div className="rounded-xl border border-[var(--state-warning-border)] bg-[var(--state-warning-bg)] p-3 text-xs text-[var(--state-warning)]">
          画布需要 Tauri 桌面版：Node 运行时、网关进程和独立窗口都由桌面端托管。
        </div>
      )}

      {/* 首次使用 / 环境准备 */}
      {desktop && (!packReady || !nodeReady) && (
        <SectionCard title="开始之前" icon={Wand2}>
          <div className="space-y-3 text-xs leading-6 text-secondary-custom">
            <p>
              无限画布是本地外挂模块：画布前端 + ComfyUI 网关由应用管理，Node 运行时复用项目已有的托管版本，
              不会要求你额外安装 Node。
            </p>
            <ol className="list-decimal space-y-1.5 pl-5">
              <li className={nodeReady ? 'text-primary-custom' : ''}>
                Node 运行时：{nodeLabel}
                {!nodeReady && (
                  <button
                    type="button"
                    onClick={() => void handleInstallNode()}
                    disabled={busy !== null}
                    className="ml-2 inline-flex items-center gap-1 rounded-md bg-[var(--accent)] px-2 py-0.5 text-[length:var(--font-eyebrow)] font-medium text-[var(--text-on-accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40"
                  >
                    {busy === 'node' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                    安装 Node（约 35 MB）
                  </button>
                )}
              </li>
              <li className={packReady ? 'text-primary-custom' : ''}>
                画布模块：{packLabel}
                {!packReady && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {CANVAS_PACK_RELEASE.url && CANVAS_PACK_RELEASE.sha256 && (
                      <button
                        type="button"
                        onClick={() => void handleDownloadPack()}
                        disabled={busy !== null}
                        className="inline-flex items-center gap-1 rounded-md bg-[var(--accent)] px-2 py-1 text-[length:var(--font-eyebrow)] font-medium text-[var(--text-on-accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40"
                      >
                        {busy === 'pack' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                        下载画布模块
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleInstallPackLocal()}
                      disabled={busy !== null}
                      className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-[length:var(--font-eyebrow)] text-secondary-custom hover:bg-[var(--surface-muted)] disabled:opacity-40"
                    >
                      <FolderOpen className="h-3 w-3" /> 从本地 zip 安装
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowAdvancedPack((value) => !value)}
                      className="text-[length:var(--font-eyebrow)] text-[var(--accent)] hover:underline"
                    >
                      {showAdvancedPack ? '收起下载地址' : '修改下载地址'}
                    </button>
                  </div>
                )}
              </li>
              <li className={comfyReady ? 'text-primary-custom' : ''}>
                ComfyUI：{comfyReady ? '已连接' : `未连接（当前 ${config.comfy_url}）`}。请先启动 ComfyUI，
                它负责真正执行工作流。
              </li>
            </ol>
            {!packReady && showAdvancedPack && (
              <div className="space-y-2 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3">
                <label className="block">
                  <span className="mb-1 block text-[length:var(--font-eyebrow)] text-secondary-custom">画布模块 zip 地址</span>
                  <input
                    value={packUrl}
                    onChange={(event) => setPackUrl(event.target.value)}
                    placeholder="https://.../Agent_LLM_Canvas_v0.24.6.zip"
                    className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-xs text-primary-custom outline-none focus:border-[var(--accent)]"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[length:var(--font-eyebrow)] text-secondary-custom">SHA256 校验值</span>
                  <input
                    value={packSha}
                    onChange={(event) => setPackSha(event.target.value)}
                    placeholder="64 位十六进制"
                    className="mono-font w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-xs text-primary-custom outline-none focus:border-[var(--accent)]"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => void handleDownloadPack()}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-1 rounded-md bg-[var(--accent)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-on-accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40"
                >
                  {busy === 'pack' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                  下载并安装
                </button>
              </div>
            )}
          </div>
        </SectionCard>
      )}

      {/* 状态 */}
      <SectionCard
        title="运行状态"
        icon={Monitor}
        actions={
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={busy !== null}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-[length:var(--font-eyebrow)] text-secondary-custom hover:bg-[var(--surface-muted)] disabled:opacity-40"
            >
              <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} /> 刷新
            </button>
          </div>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-primary-custom">Node 运行时</span>
              <StatusPill ok={nodeReady} label={nodeReady ? '可用' : '缺失'} />
            </div>
            <p className="mt-1 text-[length:var(--font-eyebrow)] text-secondary-custom">{nodeLabel}</p>
            {status?.node.path && (
              <p className="mono-font mt-1 truncate text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]" title={status.node.path}>
                {status.node.path}
              </p>
            )}
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-primary-custom">画布模块</span>
              <StatusPill ok={packReady} label={packReady ? '已安装' : '未安装'} />
            </div>
            <p className="mt-1 text-[length:var(--font-eyebrow)] text-secondary-custom">{packLabel}</p>
            {!packReady && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => void handleInstallNode()}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-[length:var(--font-eyebrow)] text-secondary-custom hover:bg-[var(--surface)] disabled:opacity-40"
                >
                  <Download className="h-3 w-3" /> 安装 Node
                </button>
                <button
                  type="button"
                  onClick={() => void handleInstallPackLocal()}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-[length:var(--font-eyebrow)] text-secondary-custom hover:bg-[var(--surface)] disabled:opacity-40"
                >
                  <FolderOpen className="h-3 w-3" /> 本地安装
                </button>
              </div>
            )}
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-primary-custom">ComfyUI</span>
              <StatusPill ok={comfyReady} label={comfyReady ? '已连接' : '未连接'} />
            </div>
            <p className="mono-font mt-1 truncate text-[length:var(--font-eyebrow)] text-secondary-custom" title={config.comfy_url}>
              {config.comfy_url}
            </p>
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-primary-custom">网关</span>
              <StatusPill ok={gatewayReady} label={gatewayReady ? '就绪' : running ? '异常' : '未启动'} />
            </div>
            <p className="mono-font mt-1 truncate text-[length:var(--font-eyebrow)] text-secondary-custom">
              {status?.gateway_url ?? `http://127.0.0.1:${config.gateway_port}/v1`}
            </p>
            <p className="mt-1 text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">
              可用模型 {status?.model_count ?? 0} 个
            </p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {running ? (
            <>
              <button
                type="button"
                onClick={() => void handleOpen()}
                disabled={busy !== null}
                className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--text-on-accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40"
              >
                <ExternalLink className="h-3.5 w-3.5" /> 打开画布
              </button>
              <button
                type="button"
                onClick={() => void handleOpenBrowser()}
                disabled={busy !== null}
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs text-secondary-custom hover:bg-[var(--surface-muted)] disabled:opacity-40"
              >
                <ExternalLink className="h-3.5 w-3.5" /> 在浏览器打开
              </button>
              <button
                type="button"
                onClick={() => void handleStop()}
                disabled={busy !== null}
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--state-danger-border)] px-2.5 py-1.5 text-xs text-[var(--state-danger)] hover:bg-[var(--state-danger-bg)] disabled:opacity-40"
              >
                {busy === 'stop' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />} 停止画布
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => void handleStart()}
              disabled={busy !== null || !canStart}
              title={!packReady ? '请先安装画布模块' : !nodeReady ? '请先安装 Node 运行时' : undefined}
              className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--text-on-accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40"
            >
              {busy === 'start' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} 启动画布
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              void canvasRevealDataDir().catch((error) => {
                if (mounted.current) setMessage({ tone: 'error', text: String(error) });
              });
            }}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs text-secondary-custom hover:bg-[var(--surface-muted)]"
            title={status?.data_dir}
          >
            <HardDrive className="h-3.5 w-3.5" /> 数据目录
          </button>
        </div>

        {status?.canvas_url && (
          <p className="mono-font mt-2 truncate text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]" title="画布地址（固定端口，保证项目数据不丢）">
            {status.canvas_url}
          </p>
        )}
      </SectionCard>

      {/* 设置 */}
      <SectionCard
        title="连接与端口"
        icon={Info}
        actions={
          <button
            type="button"
            onClick={() => void handleSaveConfig()}
            disabled={busy !== null}
            className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-[length:var(--font-eyebrow)] text-secondary-custom hover:bg-[var(--surface-muted)] disabled:opacity-40"
          >
            {busy === 'save' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />} 保存
          </button>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-[length:var(--font-eyebrow)] text-secondary-custom">ComfyUI 地址</span>
            <input
              value={config.comfy_url}
              onChange={(event) => setConfig((current) => ({ ...current, comfy_url: event.target.value }))}
              placeholder="http://127.0.0.1:8188"
              className="mono-font w-full rounded-md border border-[var(--border)] bg-[var(--surface-muted)] px-2 py-1.5 text-xs text-primary-custom outline-none focus:border-[var(--accent)]"
            />
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-[length:var(--font-eyebrow)] text-secondary-custom">ComfyUI 目录（可选，填包含 main.py 的根目录）</span>
            <input
              value={config.comfy_dir}
              onChange={(event) => setConfig((current) => ({ ...current, comfy_dir: event.target.value }))}
              placeholder="D:\ComfyUI_windows_portable\ComfyUI"
              className="mono-font w-full rounded-md border border-[var(--border)] bg-[var(--surface-muted)] px-2 py-1.5 text-xs text-primary-custom outline-none focus:border-[var(--accent)]"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[length:var(--font-eyebrow)] text-secondary-custom">
              画布端口（固定，不要随意改）
            </span>
            <input
              type="number"
              min={1024}
              max={65535}
              value={config.canvas_port}
              onChange={(event) => setConfig((current) => ({ ...current, canvas_port: Number(event.target.value) || current.canvas_port }))}
              className="mono-font w-full rounded-md border border-[var(--border)] bg-[var(--surface-muted)] px-2 py-1.5 text-xs text-primary-custom outline-none focus:border-[var(--accent)]"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[length:var(--font-eyebrow)] text-secondary-custom">网关端口</span>
            <input
              type="number"
              min={1024}
              max={65535}
              value={config.gateway_port}
              onChange={(event) => setConfig((current) => ({ ...current, gateway_port: Number(event.target.value) || current.gateway_port }))}
              className="mono-font w-full rounded-md border border-[var(--border)] bg-[var(--surface-muted)] px-2 py-1.5 text-xs text-primary-custom outline-none focus:border-[var(--accent)]"
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-secondary-custom sm:col-span-2">
            <input
              type="checkbox"
              checked={config.open_in_window}
              onChange={(event) => setConfig((current) => ({ ...current, open_in_window: event.target.checked }))}
              className="h-3.5 w-3.5 accent-[var(--accent)]"
            />
            启动后用应用内独立窗口打开（取消则用系统浏览器）
          </label>
        </div>
        <p className="mt-3 flex items-start gap-1.5 text-[length:var(--font-eyebrow)] leading-5 text-[var(--text-tertiary)]">
          <AlertCircle className="mt-0.5 h-3 w-3 flex-shrink-0" />
          画布项目按 origin 保存在浏览器存储里。改画布端口等于换 origin，旧项目会看不到；端口被占用时请先关闭占用程序，而不是直接换端口。
        </p>
      </SectionCard>

      {/* 工作流 */}
      <SectionCard title="工作流" icon={Wand2}>
        <div className="space-y-2 text-xs leading-6 text-secondary-custom">
          <p>
            画布内的「设置 → 添加工作流」可以扫描你 ComfyUI 的 <span className="mono-font">workflows</span> 目录，
            自动识别提示词、尺寸、采样器和图片输入。内置工作流随模块提供，但它们依赖对应模型；缺模型时画布会显示不可用。
          </p>
          {gatewayReady && (
            <p className="text-primary-custom">
              网关就绪，当前可用模型 {status?.model_count ?? 0} 个。打开画布后可在工作流列表里切换。
            </p>
          )}
          {!comfyReady && (
            <p className="rounded-md border border-[var(--state-warning-border)] bg-[var(--state-warning-bg)] px-2 py-1.5 text-[var(--state-warning)]">
              ComfyUI 未连接。画布可以打开，但提交任务会失败；请先启动 ComfyUI（默认 {config.comfy_url}）后重新启动画布网关。
            </p>
          )}
        </div>
      </SectionCard>

      {/* 进度 / 消息 */}
      {(progress || message) && (
        <div
          className={`rounded-xl border p-3 text-xs ${
            message?.tone === 'error'
              ? 'border-[var(--state-danger-border)] bg-[var(--state-danger-bg)] text-[var(--state-danger)]'
              : 'border-[var(--state-success-border)] bg-[var(--state-success-bg)] text-[var(--state-success)]'
          }`}
        >
          <div className="flex items-start gap-2">
            {message?.tone === 'error' ? <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" /> : <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />}
            <div className="min-w-0 flex-1">
              {progress && <p className="whitespace-pre-wrap break-words">{progress}</p>}
              {message && <p className={`whitespace-pre-wrap break-words ${progress ? 'mt-1' : ''}`}>{message.text}</p>}
            </div>
            <button
              type="button"
              onClick={() => {
                setMessage(null);
                setProgress(null);
              }}
              className="text-[length:var(--font-eyebrow)] opacity-70 hover:opacity-100"
            >
              关闭
            </button>
          </div>
        </div>
      )}

      {/* 日志 */}
      <SectionCard
        title="网关日志"
        icon={Terminal}
        actions={
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void refresh()}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-[length:var(--font-eyebrow)] text-secondary-custom hover:bg-[var(--surface-muted)]"
            >
              <RefreshCw className="h-3 w-3" /> 刷新
            </button>
            <button
              type="button"
              onClick={() => void handleClearLogs()}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-[length:var(--font-eyebrow)] text-secondary-custom hover:bg-[var(--surface-muted)]"
            >
              清空
            </button>
          </div>
        }
      >
        <pre className="mono-font max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-[length:var(--font-eyebrow)] leading-5 text-secondary-custom">
          {status?.logs.length ? status.logs.join('\n') : '暂无日志。启动画布后会显示网关输出。'}
        </pre>
        {status?.log_path && (
          <p className="mono-font mt-2 truncate text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]" title={status.log_path}>
            {status.log_path}
          </p>
        )}
      </SectionCard>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--app-bg)] px-4 py-2 dark:border-white/[0.08]">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-primary-custom">
          <InfinityIcon className="h-3.5 w-3.5 text-[var(--accent)]" /> 无限画布
        </span>
        <span
          className={`ml-1 h-1.5 w-1.5 rounded-full ${
            running ? statusDot(true) : packReady && nodeReady ? 'bg-[var(--text-tertiary)]' : statusDot(false)
          }`}
          title={running ? '画布运行中' : '画布未启动'}
        />
        <span className="flex-1" />
        <span className="text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">
          ComfyUI 生图 / 视频 · 本地回环
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        <PageHeader
          icon={InfinityIcon}
          eyebrow="Agent / 画布"
          title="无限画布"
          description="节点式本地创作台：文本、图片、视频与工作流落在无限画布上，通过本地网关调用 ComfyUI。"
          className="mb-4"
        />
        {content}
      </div>
    </div>
  );
}
