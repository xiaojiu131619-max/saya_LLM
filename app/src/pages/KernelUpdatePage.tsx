import { useEffect, useRef, useState } from 'react';
import {
  RefreshCw,
  Download,
  Check,
  AlertTriangle,
  Cpu,
  Package,
  Globe,
  Info,
  Loader2,
  Power,
  Square,
  HardDrive,
} from 'lucide-react';
import { useApp } from '@/context/AppContext';
import PageHeader from '@/components/PageHeader';
import { SettingRow, SettingSection } from '@/components/SettingSection';
import {
  cancelKernelUpdate,
  checkDesktopEngine,
  getDesktopConfig,
  isDesktopRuntime,
  listenDesktopEvent,
  listInstalledKernels,
  listRecentLlamaReleases,
  setDesktopProxyUrl,
  stopDesktopServer,
  updateLlamaKernel,
  type DesktopEngineInfo,
  type InstalledKernelInfo,
  type LlamaReleaseInfo,
} from '@/lib/desktop';

// 内核下载源偏好：mirror=内置 GitHub 镜像加速，direct=直连 GitHub 官方。
type KernelDownloadSource = 'mirror' | 'direct';
const KERNEL_SOURCE_STORAGE_KEY = 'agent-llm-kernel-download-source';

function loadKernelDownloadSource(): KernelDownloadSource {
  if (typeof window === 'undefined') return 'mirror';
  const stored = window.localStorage.getItem(KERNEL_SOURCE_STORAGE_KEY);
  if (stored === 'direct' || stored === 'mirror') {
    return stored;
  }
  return 'mirror';
}

function kernelSourceDescription(source: KernelDownloadSource) {
  if (source === 'direct') return '直连 GitHub 官方发布包，适合 GitHub 访问稳定的网络。';
  return '使用内置 GitHub 镜像加速源自动尝试，失败后回退 GitHub 官方。';
}

const backendLabelMap: Record<string, string> = {
  CUDA: 'CUDA',
  Vulkan: 'Vulkan',
  CPU: 'CPU',
};

function formatBytes(bytes: number) {
  if (!bytes) return '未知大小';
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

function pickMatchedAsset(info: LlamaReleaseInfo) {
  return info.assets.find((asset) => asset.matches_host) ?? info.assets[0] ?? null;
}

function releaseMatchDescription(info: LlamaReleaseInfo) {
  const asset = pickMatchedAsset(info);
  if (!asset) return '没有适合本机的 Windows x64 发布包';
  const backend = backendLabelMap[asset.backend] ?? asset.backend;
  return `${backend} · ${formatBytes(asset.size)} · ${asset.matches_host ? '已匹配本机' : '手动确认'}`;
}

// 从进度消息中提取下载百分比，用于进度条；非下载阶段返回 null。
function parseProgressPercent(message: string | null) {
  if (!message) return null;
  const match = message.match(/下载中:\s*([\d.]+)%/);
  return match ? Number(match[1]) : null;
}

export default function KernelUpdatePage() {
  const { state, dispatch } = useApp();
  const autoCheckedRef = useRef(false);
  const [engineInfo, setEngineInfo] = useState<DesktopEngineInfo | null>(null);
  const [releaseList, setReleaseList] = useState<LlamaReleaseInfo[]>([]);
  const [installedKernels, setInstalledKernels] = useState<InstalledKernelInfo[]>([]);
  // 正在更新/下载的版本号；null 表示空闲。
  const [updatingVersion, setUpdatingVersion] = useState<string | null>(null);
  const [currentKernelMessage, setCurrentKernelMessage] = useState<string | null>(null);
  const [engineMessage, setEngineMessage] = useState<string | null>(null);
  const [listMessage, setListMessage] = useState<string | null>(null);
  const [kernelDownloadSource, setKernelDownloadSource] = useState<KernelDownloadSource>(loadKernelDownloadSource);
  // 下载代理（如本机梯子的 http://127.0.0.1:7890）。空 = 直连。
  const [proxyInput, setProxyInput] = useState('');
  const [proxyMessage, setProxyMessage] = useState<string | null>(null);

  const updating = updatingVersion !== null;
  const progressPercent = parseProgressPercent(engineMessage);
  const latestRelease = releaseList[0] ?? null;

  // 版本对比：当前内核与最新 release 都已知时给出直观结论。
  // 内核存在但 --version 解析不出 bXXXX 版本号（如自编译构建）时，
  // 显示「版本未知」而不是误报「未安装内核」。
  const versionState = (() => {
    if (!engineInfo?.binary_exists) return 'missing' as const;
    const latest = latestRelease?.version ?? null;
    if (!latest) return 'unknown' as const;
    const current = engineInfo.llama_server_version;
    if (!current) return 'unknown-version' as const;
    return current === latest ? 'up-to-date' as const : 'outdated' as const;
  })();

  const handleKernelSourceChange = (source: KernelDownloadSource) => {
    setKernelDownloadSource(source);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(KERNEL_SOURCE_STORAGE_KEY, source);
    }
  };

  const refreshEngine = async () => {
    const info = await checkDesktopEngine();
    setEngineInfo(info);
    if (info?.binary_exists) {
      const version = info.llama_server_version ? `当前版本：${info.llama_server_version}` : '已检测到 llama.cpp 内核';
      const runtime = info.runtime_backend
        ? ` · 运行时 ${info.runtime_backend}${info.runtime_devices?.length ? `（${info.runtime_devices.join(' / ')}）` : ''}`
        : '';
      const host = info.host_backend
        ? ` · 本机 ${info.host_backend}${info.gpu_name ? ` / ${info.gpu_name}` : ''}`
        : '';
      setCurrentKernelMessage(`${version}${runtime}${host}`);
    } else {
      setCurrentKernelMessage('未安装 llama.cpp 内核，请在下方选择版本下载。');
    }
  };

  const refreshInstalledKernels = async () => {
    setInstalledKernels(await listInstalledKernels());
  };

  const handleCheckEngine = async () => {
    if (!isDesktopRuntime()) {
      setCurrentKernelMessage('请在 Tauri 桌面版中检查 llama.cpp 内核。');
      return;
    }
    setCurrentKernelMessage('正在检查当前 llama.cpp 内核...');
    await refreshEngine();
  };

  const handleRefreshReleases = async () => {
    if (!isDesktopRuntime()) {
      setListMessage('请在 Tauri 桌面版中检查更新。');
      return;
    }
    setListMessage('正在读取 ggml-org/llama.cpp 最近发布列表...');
    try {
      const releases = await listRecentLlamaReleases(8);
      setReleaseList(releases);
      setListMessage(releases.length > 0 ? `已获取 ${releases.length} 个版本。` : '未发现可用 release。');
    } catch (error) {
      setListMessage(`读取发布列表失败：${String(error)}`);
    }
  };

  const handleStopServer = async () => {
    if (!isDesktopRuntime()) return;
    await stopDesktopServer();
    dispatch({ type: 'SET_SERVER_RUNNING', payload: false });
    setEngineMessage('llama-server 已停止，可以更新内核。');
  };

  // 从指定 release 下载并安装：自动匹配本机发布包，下载中可随时取消。
  const handleUpdateFromRelease = async (release: LlamaReleaseInfo) => {
    const asset = pickMatchedAsset(release);
    if (!asset) {
      setEngineMessage(`${release.version} 没有适合本机的发布包，无法更新。`);
      return;
    }
    setUpdatingVersion(release.version);
    setEngineMessage(`正在更新到 ${release.version} · ${asset.name}...`);
    const unlisten = await listenDesktopEvent<{ message: string }>('updater:progress', (payload) => {
      setEngineMessage(payload.message);
    });
    try {
      const useMirror = kernelDownloadSource === 'mirror';
      const result = await updateLlamaKernel(asset.browser_download_url, release.version, useMirror);
      setEngineMessage(result || `llama.cpp 内核已更新到 ${release.version}。`);
      await refreshEngine();
      await refreshInstalledKernels();
    } catch (error) {
      const text = String(error);
      setEngineMessage(text.includes('取消') ? '更新已取消，本机核心保持不变。' : `更新失败：${text}`);
      await refreshEngine().catch(() => undefined);
    } finally {
      unlisten();
      setUpdatingVersion(null);
    }
  };

  // 请求取消当前下载；Rust 端会在下一个数据块检查点中止并清理临时文件。
  const handleCancelUpdate = async () => {
    try {
      await cancelKernelUpdate();
      setEngineMessage('正在取消下载...');
    } catch (error) {
      setEngineMessage(`取消失败：${String(error)}`);
    }
  };

  const handleSaveProxy = async () => {
    const value = proxyInput.trim();
    try {
      await setDesktopProxyUrl(value || null);
      setProxyMessage(value
        ? '代理已保存，立即对检查更新与下载生效。'
        : '代理已清除，恢复直连下载。');
    } catch (error) {
      setProxyMessage(`代理保存失败：${String(error)}`);
    }
  };

  const handleLoadProxy = async () => {
    try {
      const config = await getDesktopConfig();
      setProxyInput(config?.proxy_url ?? '');
    } catch {
      // 读取失败时保持空输入，不影响其他功能。
    }
  };

  // 进入页面自动检查：当前内核 + 发布列表 + 本机已安装核心一次到位。
  useEffect(() => {
    if (autoCheckedRef.current || typeof window === 'undefined') return;
    autoCheckedRef.current = true;

    void handleLoadProxy();
    void (async () => {
      if (!isDesktopRuntime()) return;
      setCurrentKernelMessage('正在自动检查当前 llama.cpp 内核...');
      setListMessage('正在自动读取最近发布列表...');
      await refreshEngine();
      await refreshInstalledKernels();
      try {
        const releases = await listRecentLlamaReleases(8);
        setReleaseList(releases);
        setListMessage(releases.length > 0 ? `已获取 ${releases.length} 个版本。` : '未发现可用 release。');
      } catch (error) {
        setListMessage(`自动读取发布列表失败：${String(error)}`);
      }
    })();
  }, []);

  const versionBadge = (() => {
    switch (versionState) {
      case 'up-to-date':
        return (
          <span className="inline-flex items-center gap-1 rounded-full border border-[var(--state-success-border)] bg-[var(--state-success-bg)] px-2 py-0.5 text-xs text-[var(--state-success)]">
            <Check className="h-3 w-3" /> 已是最新
          </span>
        );
      case 'outdated':
        return (
          <span className="inline-flex items-center gap-1 rounded-full border border-[var(--state-warning-border)] bg-[var(--state-warning-bg)] px-2 py-0.5 text-xs text-[var(--state-warning)]">
            <AlertTriangle className="h-3 w-3" /> 有可用更新
          </span>
        );
      case 'missing':
        return (
          <span className="inline-flex items-center gap-1 rounded-full border border-[var(--state-danger-border)] bg-[var(--state-danger-bg)] px-2 py-0.5 text-xs text-[var(--state-danger)]">
            <AlertTriangle className="h-3 w-3" /> 未安装内核
          </span>
        );
      case 'unknown-version':
        return (
          <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface-muted)] px-2 py-0.5 text-xs text-secondary-custom">
            <Info className="h-3 w-3" /> 已安装 · 版本未知
          </span>
        );
      default:
        return null;
    }
  })();

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto mb-6 max-w-2xl">
          <PageHeader icon={Download} title="核心更新" description="检查、下载与升级 llama.cpp 推理内核，本机保留最近两个版本" />
        </div>

        <div className="mx-auto max-w-2xl pb-12">
          {state.serverRunning && (
            <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-[var(--state-warning-border)] bg-[var(--state-warning-bg)] px-3 py-2.5">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--state-warning)]" />
                <p className="text-xs leading-5 text-secondary-custom">
                  llama-server 正在运行（端口 {state.serverPort}）。更新内核前需要先停止服务，否则下载的文件可能无法替换。
                </p>
              </div>
              <button
                onClick={() => void handleStopServer()}
                className="flex min-h-8 flex-shrink-0 items-center gap-1 rounded-md px-2 text-xs text-[var(--state-danger)] hover:bg-[var(--state-danger-border)] dark:hover:bg-[var(--surface-raised)]"
              >
                <Power className="h-3.5 w-3.5" />
                停止服务
              </button>
            </div>
          )}

          <SettingSection title="内核状态" icon={Cpu} delay={0}>
            <SettingRow
              label="当前内核"
              description={currentKernelMessage ?? (engineInfo?.llama_server_version ? `当前版本：${engineInfo.llama_server_version}` : engineInfo?.exe_path ?? 'resources/llama-server.exe')}
            >
              <div className="flex items-center gap-3">
                {versionBadge}
                <button
                  onClick={() => void handleCheckEngine()}
                  disabled={updating}
                  className="flex min-h-9 items-center gap-1 rounded-md px-2 text-sm text-[var(--accent)] hover:bg-[var(--surface-muted)] disabled:opacity-40 dark:hover:bg-[var(--surface-raised)]"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  检查
                </button>
              </div>
            </SettingRow>
            {engineInfo?.binary_exists && engineInfo.exe_path && (
              <>
                <div className="border-t border-[var(--border-subtle)]" />
                <SettingRow
                  label="内核文件"
                  description={engineInfo.exe_path}
                >
                  <span />
                </SettingRow>
              </>
            )}
          </SettingSection>

          <SettingSection title="可更新版本" icon={Globe} delay={0.06}>
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-secondary-custom">
                {listMessage ?? '读取 ggml-org/llama.cpp 最近发布列表'}
                {latestRelease?.host_backend ? ` · 本机优先 ${latestRelease.host_backend}${latestRelease.gpu_name ? `（${latestRelease.gpu_name}）` : ''}` : ''}
              </p>
              <button
                onClick={() => void handleRefreshReleases()}
                disabled={updating}
                className="flex min-h-9 flex-shrink-0 items-center gap-1 rounded-md px-2 text-sm text-[var(--accent)] hover:bg-[var(--surface-muted)] disabled:opacity-40 dark:hover:bg-[var(--surface-raised)]"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                刷新列表
              </button>
            </div>
            {releaseList.length > 0 && (
              <div className="space-y-1">
                {releaseList.map((release, index) => {
                  const isUpdatingThis = updatingVersion === release.version;
                  const isLatest = index === 0;
                  return (
                    <div
                      key={release.tag_name}
                      className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 ${
                        isUpdatingThis
                          ? 'border-[var(--accent)]/40 bg-[var(--accent)]/5'
                          : 'border-transparent bg-[var(--surface-muted)] dark:border-white/[0.06] dark:bg-white/[0.03]'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-primary-custom">{release.version}</span>
                          {isLatest && (
                            <span className="rounded-full bg-[var(--accent)]/10 px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent)]">
                              最新
                            </span>
                          )}
                          {versionState === 'up-to-date' && isLatest && engineInfo?.binary_exists && (
                            <Check className="h-3.5 w-3.5 text-[var(--state-success)]" />
                          )}
                        </div>
                        <div className="mt-0.5 truncate text-xs text-secondary-custom">
                          {release.published_at.slice(0, 10)} · {releaseMatchDescription(release)}
                        </div>
                      </div>
                      <button
                        onClick={() => void handleUpdateFromRelease(release)}
                        disabled={updating || state.serverRunning || release.assets.length === 0}
                        className="flex min-h-8 flex-shrink-0 items-center gap-1 rounded-md bg-[var(--accent)] px-2.5 text-xs font-medium text-white transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40"
                      >
                        {isUpdatingThis
                          ? <Loader2 className="h-3 w-3 animate-spin" />
                          : <Download className="h-3 w-3" />}
                        {isUpdatingThis ? '更新中' : '更新'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </SettingSection>

          {updating && (
            <SettingSection title="下载进度" icon={Download} delay={0.1}>
              <div className="space-y-2.5">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--border)] dark:bg-white/10">
                  <div
                    className="h-full rounded-full bg-[var(--accent)] transition-all duration-300"
                    style={{ width: `${progressPercent ?? 5}%` }}
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <p className="min-w-0 truncate font-mono text-xs text-secondary-custom">{engineMessage}</p>
                  <button
                    onClick={() => void handleCancelUpdate()}
                    className="flex min-h-8 flex-shrink-0 items-center gap-1 rounded-md px-2 text-xs text-[var(--state-danger)] hover:bg-[var(--state-danger-border)] dark:hover:bg-[var(--surface-raised)]"
                  >
                    <Square className="h-3 w-3" />
                    停止下载
                  </button>
                </div>
              </div>
            </SettingSection>
          )}

          <SettingSection title="下载设置" icon={Package} delay={0.12}>
            <SettingRow
              label="下载源"
              description={kernelSourceDescription(kernelDownloadSource)}
            >
              <select
                aria-label="内核下载源"
                value={kernelDownloadSource}
                onChange={(event) => handleKernelSourceChange(event.target.value as KernelDownloadSource)}
                disabled={updating}
                className="form-input max-w-[260px] bg-transparent px-3 py-2 text-xs text-primary-custom disabled:opacity-50"
              >
                <option value="mirror">镜像加速（推荐）</option>
                <option value="direct">直连 GitHub 官方</option>
              </select>
            </SettingRow>
            <div className="border-t border-[var(--border-subtle)]" />
            <SettingRow
              label="下载代理"
              description="核心下载不走系统代理；挂了梯子但下载仍慢时，填入本机代理端口（如 http://127.0.0.1:7890）。留空为直连。"
            >
              <div className="flex items-center gap-2">
                <input
                  value={proxyInput}
                  onChange={(event) => setProxyInput(event.target.value)}
                  placeholder="http://127.0.0.1:7890"
                  className="mono-font h-9 w-56 rounded-md border border-[var(--border)] bg-[var(--app-bg)] px-3 text-xs text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--accent)] dark:border-white/[0.08] dark:bg-black/20"
                  aria-label="下载代理地址"
                />
                <button
                  onClick={() => void handleSaveProxy()}
                  disabled={updating}
                  className="flex h-9 flex-shrink-0 items-center rounded-md bg-[var(--accent)] px-3 text-xs font-medium text-white transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40"
                >
                  保存
                </button>
              </div>
            </SettingRow>
            {proxyMessage && (
              <p className="break-words text-xs text-secondary-custom">{proxyMessage}</p>
            )}
            <div className="border-t border-[var(--border-subtle)]" />
            <SettingRow
              label="版本保留策略"
              description="每次更新新建独立目录存放新核心；本机始终保留最近两个版本（最新的 + 更新前一个），更早的自动清理。"
            >
              <span />
            </SettingRow>
          </SettingSection>

          {installedKernels.length > 0 && (
            <SettingSection title="本机核心目录" icon={HardDrive} delay={0.16}>
              <div className="space-y-1">
                {installedKernels.map((kernel) => (
                  <div
                    key={kernel.name}
                    className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 bg-[var(--surface-muted)] dark:bg-white/[0.03]"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-primary-custom">{kernel.version}</span>
                        {kernel.is_active && (
                          <span className="rounded-full bg-[var(--state-success-bg)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--state-success)]">
                            使用中
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 truncate font-mono text-xs text-secondary-custom">
                        kernels/{kernel.name}
                      </div>
                    </div>
                    <span className="flex-shrink-0 text-xs text-secondary-custom">{kernel.installed_at}</span>
                  </div>
                ))}
              </div>
            </SettingSection>
          )}

          {!updating && engineMessage && (
            <p className="mt-4 px-1 text-xs text-secondary-custom">{engineMessage}</p>
          )}
        </div>
      </div>
    </div>
  );
}
