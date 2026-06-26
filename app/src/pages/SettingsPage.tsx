import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  FolderPlus,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  FolderX,
  Power,
  Palette,
  Globe2,
  KeyRound,
  Copy,
  Database,
  AlertTriangle,
  Trash2,
  FolderOpen,
} from 'lucide-react';
import { useApp } from '@/context/AppContext';
import ToggleSwitch from '@/components/ToggleSwitch';
import ConfirmDialog from '@/components/ConfirmDialog';
import type { LucideIcon } from 'lucide-react';
import type { ModelInfo } from '@/types';
import { getModelThemeGroup } from '@/lib/modelTheme';
import {
  checkDesktopEngine,
  checkLatestLlamaRelease,
  addDesktopModelDir,
  clearAllImageApiKeys,
  clearDesktopModelCache,
  createExternalApiKey,
  deleteExternalApiKey,
  getDesktopAppDataDir,
  getDesktopServerStatus,
  isDesktopRuntime,
  listenDesktopEvent,
  pickModelDirectory,
  removeDesktopModelDir,
  resetDesktopAppConfig,
  revealDesktopPath,
  saveDesktopRuntimeSettings,
  scanDesktopModels,
  stopDesktopServer,
  toFrontendModel,
  updateLlamaKernel,
  type DesktopEngineInfo,
  type LlamaReleaseInfo,
} from '@/lib/desktop';

interface SettingSectionProps {
  title: string;
  icon: LucideIcon;
  children: React.ReactNode;
  delay?: number;
}

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

function kernelMirrorUrl(_source: KernelDownloadSource) {
  return undefined;
}

function kernelSourceDescription(source: KernelDownloadSource) {
  if (source === 'direct') return '直连 GitHub 官方发布包，适合 GitHub 访问稳定的网络。';
  return '使用内置 GitHub 镜像加速源自动尝试，失败后回退 GitHub 官方。';
}

// 「数据管理」中可执行的清除动作种类。
type DataActionKind =
  | 'clear-frontend-state'
  | 'clear-model-cache'
  | 'clear-image-keys'
  | 'reset-app-config'
  | 'factory-reset';

// 前端本地持久化的 localStorage key 清单：与 AppContext / ImagePage / SettingsPage 中的常量保持一致。
const FRONTEND_STORAGE_KEYS = [
  'agent-llm-local-state-v1',
  'agent-llm-image-settings-v1',
  'agent-llm-kernel-download-source',
] as const;

const backendLabelMap: Record<string, string> = {
  CUDA: 'CUDA',
  Vulkan: 'Vulkan',
  CPU: 'CPU',
};

function clearFrontendLocalStorage() {
  if (typeof window === 'undefined') return;
  for (const key of FRONTEND_STORAGE_KEYS) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // localStorage 在隐私模式下可能不可写；尽量清；失败也继续。
    }
  }
}

function SettingSection({ title, icon: Icon, children, delay = 0 }: SettingSectionProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay, ease: [0.16, 1, 0.3, 1] }}
      className="glass-panel p-5"
    >
      <div className="flex items-center gap-2.5 mb-4">
        <Icon className="w-4.5 h-4.5 text-[#5A6CFF]" />
        <h2 className="text-[15px] font-semibold text-primary-custom">{title}</h2>
      </div>
      <div className="space-y-4">{children}</div>
    </motion.div>
  );
}

interface SettingRowProps {
  label: string;
  description?: string;
  children: React.ReactNode;
}

function SettingRow({ label, description, children }: SettingRowProps) {
  return (
    <div className="flex items-center justify-between py-2">
      <div className="flex-1 min-w-0 mr-4">
        <div className="text-sm text-primary-custom">{label}</div>
        {description && (
          <div className="text-xs text-secondary-custom mt-0.5">{description}</div>
        )}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

function formatBytes(bytes: number) {
  if (!bytes) return '未知大小';
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

type LlamaReleaseAsset = LlamaReleaseInfo['assets'][number];

function formatAssetOption(asset: LlamaReleaseAsset) {
  const matchLabel = asset.matches_host ? '已匹配本机' : '手动选择';
  return `${matchLabel} · ${asset.backend} · ${formatBytes(asset.size)} · ${asset.name}`;
}

function pickMatchedAsset(info: LlamaReleaseInfo | null) {
  return info?.assets.find((asset) => asset.matches_host) ?? info?.assets[0] ?? null;
}

function matchedBackendDescription(info: LlamaReleaseInfo | null, asset?: LlamaReleaseAsset | null) {
  if (!info) return '正在读取硬件与发布包信息...';
  const backend = backendLabelMap[info.host_backend] ?? info.host_backend;
  const gpu = info.gpu_name ? ` · ${info.gpu_name}` : '';
  const cuda = info.host_backend === 'CUDA' && info.cuda_version ? ` · CUDA ${info.cuda_version}` : '';
  const picked = asset ? ` · 已选择 ${asset.backend}` : '';
  return `本机匹配：${backend}${gpu}${cuda}${picked}`;
}

function clampPort(value: number) {
  if (!Number.isFinite(value)) return 8080;
  return Math.min(65535, Math.max(1, Math.round(value)));
}

function generateApiKey() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `allm-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export default function SettingsPage() {
  const { state, dispatch } = useApp();
  const kernelSectionRef = useRef<HTMLDivElement | null>(null);
  const autoCheckedKernelRef = useRef(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [serviceMessage, setServiceMessage] = useState<string | null>(null);
  const [engineInfo, setEngineInfo] = useState<DesktopEngineInfo | null>(null);
  const [releaseInfo, setReleaseInfo] = useState<LlamaReleaseInfo | null>(null);
  const [selectedAssetUrl, setSelectedAssetUrl] = useState('');
  // 「当前内核」行的描述：仅由 handleCheckEngine 写入，不被检查更新/下载进度污染。
  const [currentKernelMessage, setCurrentKernelMessage] = useState<string | null>(null);
  // 共享的引擎/更新动作提示（用于检查更新、下载进度、错误等）。
  const [engineMessage, setEngineMessage] = useState<string | null>(null);
  const [themeGroupsCollapsed, setThemeGroupsCollapsed] = useState(false);
  const [newApiKey, setNewApiKey] = useState<string | null>(null);
  const [kernelDownloadSource, setKernelDownloadSource] = useState<KernelDownloadSource>(loadKernelDownloadSource);
  // 数据管理：当前要弹出确认对话框的清除类型；null 表示对话框关闭。
  const [pendingDataAction, setPendingDataAction] = useState<DataActionKind | null>(null);
  const [dataMessage, setDataMessage] = useState<string | null>(null);

  const handleKernelSourceChange = (source: KernelDownloadSource) => {
    setKernelDownloadSource(source);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(KERNEL_SOURCE_STORAGE_KEY, source);
    }
  };

  const refreshLocalModels = async () => {
    if (!isDesktopRuntime()) {
      setScanMessage('请在 Tauri 桌面版中使用本地模型扫描。');
      return;
    }

    setScanMessage('正在扫描 GGUF 模型...');
    try {
      const models = await scanDesktopModels(true);
      dispatch({ type: 'UPSERT_MODELS', payload: models.map(toFrontendModel) });
      const message = models.length > 0 ? `已发现 ${models.length} 个本地 GGUF 模型。` : '没有发现 GGUF 文件。';
      dispatch({ type: 'SET_APP_STATUS', payload: message });
      setScanMessage(message);
    } catch (error) {
      setScanMessage(`扫描失败：${String(error)}`);
    }
  };

  const handleAddModelDir = async () => {
    if (!isDesktopRuntime()) {
      setScanMessage('请在 Tauri 桌面版中选择本地目录。');
      return;
    }

    const selected = await pickModelDirectory();
    if (!selected) return;

    const dirs = await addDesktopModelDir(selected);
    dispatch({ type: 'SET_MODEL_DIRS', payload: dirs });
    await refreshLocalModels();
  };

  const handleRemoveModelDir = async (dir: string) => {
    if (!isDesktopRuntime()) {
      setScanMessage('请在 Tauri 桌面版中管理本地目录。');
      return;
    }

    const dirs = await removeDesktopModelDir(dir);
    dispatch({ type: 'SET_MODEL_DIRS', payload: dirs });
    await refreshLocalModels();
  };

  const handleStopServer = async () => {
    if (!isDesktopRuntime()) {
      setServiceMessage('请在 Tauri 桌面版中管理本地服务。');
      return;
    }

    await stopDesktopServer();
    dispatch({ type: 'SET_SERVER_RUNNING', payload: false });
    setServiceMessage('llama-server 已停止。');
  };

  const handleRefreshServerStatus = async () => {
    if (!isDesktopRuntime()) {
      setServiceMessage('请在 Tauri 桌面版中读取服务状态。');
      return;
    }

    const running = await getDesktopServerStatus();
    dispatch({ type: 'SET_SERVER_RUNNING', payload: running });
    setServiceMessage(running ? 'llama-server 正在运行。' : 'llama-server 未运行。');
  };

  const persistRuntimeSettings = async (port = state.serverPort, apiConfig = state.apiConfig) => {
    if (!isDesktopRuntime()) {
      setServiceMessage('请在 Tauri 桌面版中保存 API 设置。');
      return;
    }

    try {
      await saveDesktopRuntimeSettings({
        defaultPort: clampPort(port),
        apiEnabled: apiConfig.enabled,
        apiHost: apiConfig.host || '0.0.0.0',
      });
      setServiceMessage('API 设置已保存，下一次加载模型时生效。');
    } catch (error) {
      setServiceMessage(`API 设置保存失败：${String(error)}`);
    }
  };

  const updateApiConfig = (patch: Partial<typeof state.apiConfig>, persist = false) => {
    const next = { ...state.apiConfig, ...patch };
    dispatch({ type: 'SET_API_CONFIG', payload: patch });
    if (persist) void persistRuntimeSettings(state.serverPort, next);
  };

  const handleApiEnabledChange = (enabled: boolean) => {
    const host = enabled && (!state.apiConfig.host || state.apiConfig.host === '127.0.0.1')
      ? '0.0.0.0'
      : state.apiConfig.host || '0.0.0.0';
    updateApiConfig({ enabled, host }, true);
  };

  const handlePortChange = (value: string) => {
    const next = Number(value);
    if (!Number.isFinite(next)) return;
    dispatch({ type: 'SET_SERVER_PORT', payload: clampPort(next) });
  };

  const handleGenerateApiKey = () => {
    const nextKey = generateApiKey();
    if (!isDesktopRuntime()) {
      setServiceMessage('请在 Tauri 桌面版中申请 API Key。');
      return;
    }
    void createExternalApiKey(nextKey)
      .then(() => {
        setNewApiKey(nextKey);
        const nextApiConfig = { ...state.apiConfig, hasApiKey: true, apiKey: nextKey };
        dispatch({ type: 'SET_API_CONFIG', payload: { hasApiKey: true, apiKey: nextKey } });
        setServiceMessage('新的 API Key 已生成。请现在复制保存；关闭此提示后将无法再次查看。');
        void persistRuntimeSettings(state.serverPort, nextApiConfig);
      })
      .catch((error) => {
        setServiceMessage(`API Key 生成失败：${String(error)}`);
      });
  };

  const handleDeleteApiKey = () => {
    if (!isDesktopRuntime()) {
      setServiceMessage('请在 Tauri 桌面版中撤销 API Key。');
      return;
    }
    void deleteExternalApiKey()
      .then(() => {
        setNewApiKey(null);
        dispatch({ type: 'SET_API_CONFIG', payload: { hasApiKey: false, apiKey: undefined } });
        setServiceMessage('API Key 已撤销。下一次加载模型时将不再要求外部请求鉴权。');
        void persistRuntimeSettings(state.serverPort, { ...state.apiConfig, hasApiKey: false, apiKey: undefined });
      })
      .catch((error) => {
        setServiceMessage(`API Key 撤销失败：${String(error)}`);
      });
  };

  const handleCopyApiExample = async () => {
    const auth = state.apiConfig.hasApiKey ? ` \\\n  -H "Authorization: Bearer <API_KEY>"` : '';
    const command = [
      `curl http://127.0.0.1:${state.serverPort}/v1/chat/completions \\`,
      '  -H "Content-Type: application/json" \\',
      `${auth}${auth ? ' \\' : ''}`,
      `  -d "{\\"model\\": \\"${state.models.find((model) => model.id === state.activeModelId)?.name ?? 'local-model'}\\", \\"messages\\": [{\\"role\\": \\"user\\", \\"content\\": \\"你好\\"}], \\"stream\\": false}"`,
    ].filter(Boolean).join('\n');
    await navigator.clipboard.writeText(command);
    setServiceMessage('已复制 OpenAI 兼容 API 调用示例。');
  };

  const handleCopyNewApiKey = async () => {
    if (!newApiKey) return;
    await navigator.clipboard.writeText(newApiKey);
    setServiceMessage('已复制新的 API Key。请妥善保存；之后只能重新申请。');
  };

  const handleCheckEngine = async () => {
    if (!isDesktopRuntime()) {
      setCurrentKernelMessage('请在 Tauri 桌面版中检查 llama.cpp 内核。');
      return;
    }
    setCurrentKernelMessage('正在检查当前 llama.cpp 内核...');
    const info = await checkDesktopEngine();
    setEngineInfo(info);
    if (!info?.binary_exists) {
      setCurrentKernelMessage('未安装 llama.cpp 内核，请先检查更新并下载核心。');
      return;
    }
    setCurrentKernelMessage(info.llama_server_version ? `当前版本：${info.llama_server_version}` : '未能读取当前版本。');
  };

  const handleCheckLatest = async () => {
    if (!isDesktopRuntime()) {
      setEngineMessage('请在 Tauri 桌面版中检查更新。');
      return;
    }
    setEngineMessage('正在检查 ggml-org/llama.cpp 最新 release 并匹配本机核心...');
    const info = await checkLatestLlamaRelease();
    setReleaseInfo(info);
    const recommendedAsset = pickMatchedAsset(info);
    setSelectedAssetUrl(recommendedAsset?.browser_download_url ?? '');
    setEngineMessage(info
      ? `最新版本：${info.version} · ${matchedBackendDescription(info, recommendedAsset)}`
      : '未发现可用 release。');
  };

  const handleUpdateKernel = async () => {
    if (state.serverRunning) {
      setEngineMessage('请先停止 llama-server，再更新 llama.cpp 内核。');
      return;
    }
    const asset = releaseInfo?.assets.find((item) => item.browser_download_url === selectedAssetUrl) ?? releaseInfo?.assets[0];
    if (!asset || !releaseInfo) {
      setEngineMessage('请先检查最新 release。');
      return;
    }
    setEngineMessage(`正在更新 ${releaseInfo.version} · ${asset.name}...`);
    const unlisten = await listenDesktopEvent<{ message: string }>('updater:progress', (payload) => {
      setEngineMessage(payload.message);
    });
    try {
      const useMirror = kernelDownloadSource === 'mirror';
      const result = await updateLlamaKernel(
        asset.browser_download_url,
        releaseInfo.version,
        useMirror,
        kernelMirrorUrl(kernelDownloadSource)
      );
      setEngineMessage(result || 'llama.cpp 内核更新完成。');
      await handleCheckEngine();
    } catch (error) {
      setEngineMessage(`更新失败：${String(error)}`);
    } finally {
      unlisten();
    }
  };

  // 数据管理：单项清除前端本地状态（localStorage）。完成后刷新页面以重新挂载默认状态。
  const handleClearFrontendState = async () => {
    clearFrontendLocalStorage();
    setDataMessage('已清除前端界面状态，应用即将刷新...');
    // 给用户一帧时间看到提示，再 reload。
    window.setTimeout(() => {
      window.location.reload();
    }, 200);
  };

  // 数据管理：清除 GGUF 模型扫描缓存（…\AgentLLM\cache）。
  const handleClearModelCache = async () => {
    if (!isDesktopRuntime()) {
      setDataMessage('请在 Tauri 桌面版中清除模型扫描缓存。');
      return;
    }
    const result = await clearDesktopModelCache();
    setDataMessage(result || '模型扫描缓存已清除。下次进入模型页将重新扫描。');
  };

  // 数据管理：清除所有生图供应商保存在系统 keyring 中的 API Key。
  const handleClearImageKeys = async () => {
    if (!isDesktopRuntime()) {
      setDataMessage('请在 Tauri 桌面版中清除生图密钥。');
      return;
    }
    const count = await clearAllImageApiKeys();
    setDataMessage(`已清除 ${count} 个生图供应商的保存密钥。`);
  };

  // 数据管理：重置后端配置 + 撤销对外 API Key + 刷新前端状态以反映默认值。
  const handleResetAppConfig = async () => {
    if (!isDesktopRuntime()) {
      setDataMessage('请在 Tauri 桌面版中重置应用配置。');
      return;
    }
    // 先停止 llama-server，避免重置后继续占用端口。
    if (state.serverRunning) {
      await stopDesktopServer();
      dispatch({ type: 'SET_SERVER_RUNNING', payload: false });
    }
    await resetDesktopAppConfig();
    setDataMessage('应用配置已重置为默认值，应用即将刷新...');
    window.setTimeout(() => {
      window.location.reload();
    }, 200);
  };

  // 数据管理：一键出厂重置——把上面所有清除项都执行一遍。
  const handleFactoryReset = async () => {
    if (!isDesktopRuntime()) {
      setDataMessage('请在 Tauri 桌面版中执行出厂重置。');
      return;
    }
    if (state.serverRunning) {
      await stopDesktopServer();
      dispatch({ type: 'SET_SERVER_RUNNING', payload: false });
    }
    await clearDesktopModelCache();
    await clearAllImageApiKeys();
    await resetDesktopAppConfig();
    clearFrontendLocalStorage();
    setDataMessage('已执行出厂重置，应用即将刷新...');
    window.setTimeout(() => {
      window.location.reload();
    }, 200);
  };

  // 数据管理：在系统文件管理器中打开 AppData\Roaming\AgentLLM 目录。
  const handleOpenAppDataDir = async () => {
    if (!isDesktopRuntime()) {
      setDataMessage('请在 Tauri 桌面版中打开数据目录。');
      return;
    }
    const path = await getDesktopAppDataDir();
    if (!path) {
      setDataMessage('未能获取数据目录路径。');
      return;
    }
    try {
      await revealDesktopPath(path);
    } catch (error) {
      setDataMessage(`打开数据目录失败：${String(error)}`);
    }
  };

  // 数据管理：根据当前 pendingDataAction 派发实际清除动作。
  const runPendingDataAction = async () => {
    switch (pendingDataAction) {
      case 'clear-frontend-state':
        await handleClearFrontendState();
        break;
      case 'clear-model-cache':
        await handleClearModelCache();
        break;
      case 'clear-image-keys':
        await handleClearImageKeys();
        break;
      case 'reset-app-config':
        await handleResetAppConfig();
        break;
      case 'factory-reset':
        await handleFactoryReset();
        break;
      default:
        break;
    }
    setPendingDataAction(null);
  };

  const selectedAsset = releaseInfo?.assets.find((item) => item.browser_download_url === selectedAssetUrl);
  const externalApiAddress = state.apiConfig.enabled
    ? `http://<本机局域网IP>:${state.serverPort}/v1/chat/completions`
    : `http://127.0.0.1:${state.serverPort}/v1/chat/completions`;

  useEffect(() => {
    if (autoCheckedKernelRef.current || typeof window === 'undefined') return;

    autoCheckedKernelRef.current = true;
    const shouldFocusKernel = window.sessionStorage.getItem('agent-llm-focus-kernel-update') === '1';
    if (shouldFocusKernel) {
      window.sessionStorage.removeItem('agent-llm-focus-kernel-update');
      window.requestAnimationFrame(() => {
        kernelSectionRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      });
    }

    void (async () => {
      if (!isDesktopRuntime()) return;
      setCurrentKernelMessage('正在自动检查当前 llama.cpp 内核...');
      setEngineMessage('正在自动匹配适合本机的核心发布包...');
      const info = await checkDesktopEngine();
      setEngineInfo(info);
      if (info?.binary_exists) {
        setCurrentKernelMessage(info.llama_server_version ? `当前版本：${info.llama_server_version}` : '已检测到 llama.cpp 内核。');
      } else {
        setCurrentKernelMessage('未安装 llama.cpp 内核，请下载匹配本机的核心。');
      }
      try {
        const release = await checkLatestLlamaRelease();
        setReleaseInfo(release);
        const recommendedAsset = pickMatchedAsset(release);
        setSelectedAssetUrl(recommendedAsset?.browser_download_url ?? '');
        setEngineMessage(release
          ? `已找到 ${release.version} · ${matchedBackendDescription(release, recommendedAsset)}`
          : '未发现可用 release。');
      } catch (error) {
        setEngineMessage(`自动匹配核心失败：${String(error)}`);
      }
    })();
  }, []);

  // 数据管理：弹窗配置表。把每种清除动作的标题、说明、清单、按钮文字、二次输入码集中在这里维护。
  const dataDialogConfig: Record<DataActionKind, {
    title: string;
    description: React.ReactNode;
    bullets?: string[];
    footnote?: React.ReactNode;
    confirmLabel: string;
    confirmPhrase?: string;
    tone: 'warning' | 'danger';
  }> = {
    'clear-frontend-state': {
      title: '清除界面状态与聊天记录',
      description: '此操作会清空本应用浏览端保存在 WebView2 localStorage 中的全部数据，并自动刷新窗口以应用更改。',
      bullets: [
        '所有模型的聊天会话与消息历史',
        '使用统计、最近使用记录、模型加载参数记忆',
        '主题、侧边栏、排序与网格列数等界面偏好',
        '生图页面的供应商与参数设置',
        '内核下载源偏好',
      ],
      footnote: '后端配置（config.json）、模型扫描缓存、系统 keyring 中的 API Key 不受影响。',
      confirmLabel: '清除并刷新',
      tone: 'warning',
    },
    'clear-model-cache': {
      title: '清除模型扫描缓存',
      description: (
        <>下次进入模型页时，将重新解析 <span className="font-mono">.gguf</span> 文件的元数据。模型文件本身不会被删除。</>
      ),
      footnote: '仅清空 AppData\\Roaming\\AgentLLM\\cache 目录中的扫描结果。',
      confirmLabel: '清除缓存',
      tone: 'warning',
    },
    'clear-image-keys': {
      title: '清除全部生图供应商密钥',
      description: '此操作会从 Windows 凭据管理器中删除所有已保存的生图供应商 API Key，恢复后需要重新输入才能继续生图。',
      bullets: [
        'SiliconFlow',
        'NewAPI（OpenAI / Gemini 兼容）',
        'ComfyUI 本地 / 局域网（如已设置鉴权）',
      ],
      footnote: '对外 OpenAI 兼容 API 的 Key 不在此操作范围；如需撤销，请使用「对外 API」区块的撤销按钮。',
      confirmLabel: '全部清除',
      tone: 'danger',
    },
    'reset-app-config': {
      title: '重置应用配置',
      description: '此操作会停止本地 llama-server 并把应用配置恢复为出厂默认值。',
      bullets: [
        '清空模型目录列表（不会删除目录中的模型文件）',
        '清空所有模型的预设参数（ngl、ctx、KV 等）与调参历史',
        '把端口、API 监听地址、主题等恢复默认值',
        '撤销对外 OpenAI 兼容 API 的 Key',
      ],
      footnote: 'llama.cpp 内核可执行文件、生图供应商 keyring、模型扫描缓存不在此操作范围。',
      confirmLabel: '重置配置',
      confirmPhrase: '重置配置',
      tone: 'danger',
    },
    'factory-reset': {
      title: '出厂重置（清除全部本地数据）',
      description: '此操作会一次性清除前述所有本地数据，并自动刷新窗口。模型文件、llama.cpp 内核、WebView2 系统缓存与日志不会被删除。',
      bullets: [
        '后端配置 config.json 与模型扫描缓存',
        '系统 keyring 中的对外 API Key 与所有生图供应商密钥',
        '前端 localStorage 中的聊天记录、使用统计、界面偏好与生图设置',
        '正在运行的 llama-server 进程',
      ],
      footnote: '此操作不可恢复。强烈建议在出错排障无果时再使用。',
      confirmLabel: '执行出厂重置',
      confirmPhrase: '我确认清除',
      tone: 'danger',
    },
  };

  const activeDialogConfig = pendingDataAction ? dataDialogConfig[pendingDataAction] : null;

  const themeGroups = useMemo(() => {
    const groups = new Map<string, {
      key: string;
      label: string;
      icon: string;
      color: string;
      models: ModelInfo[];
    }>();

    state.models.forEach((model) => {
      const group = getModelThemeGroup(model);
      const current = groups.get(group.key);
      if (current) {
        current.models.push(model);
      } else {
        groups.set(group.key, {
          key: group.key,
          label: group.label,
          icon: group.icon,
          color: model.themeColorSolid,
          models: [model],
        });
      }
    });

    return Array.from(groups.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [state.models]);

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-primary-custom mb-1">设置</h1>
          <p className="text-sm text-secondary-custom">配置 Agent LLM 启动器和模型运行参数</p>
        </div>

        <div className="max-w-2xl space-y-4 pb-12">
          <SettingSection title="本地模型运行" icon={FolderPlus} delay={0}>
            <SettingRow
              label="模型目录"
              description={state.modelDirs.length > 0 ? state.modelDirs.join(' | ') : '选择包含 .gguf 文件的本地目录'}
            >
              <button
                onClick={handleAddModelDir}
                className="flex items-center gap-1 text-sm text-[#5A6CFF] hover:underline"
              >
                选择目录 <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </SettingRow>
            {state.modelDirs.length > 0 && (
              <>
                <div className="border-t border-white/5 dark:border-white/5" />
                <div className="space-y-2">
                  {state.modelDirs.map((dir) => (
                    <div key={dir} className="flex items-center justify-between gap-3 text-xs text-secondary-custom">
                      <span className="truncate">{dir}</span>
                      <button
                        onClick={() => void handleRemoveModelDir(dir)}
                        className="flex items-center gap-1 text-[#F87171] hover:underline flex-shrink-0"
                      >
                        <FolderX className="w-3.5 h-3.5" />
                        移除
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
            {scanMessage && (
              <>
                <div className="border-t border-white/5 dark:border-white/5" />
                <p className="text-xs text-secondary-custom">{scanMessage}</p>
              </>
            )}
          </SettingSection>

          <SettingSection title="服务控制" icon={Power} delay={0.1}>
            <SettingRow
              label="llama-server"
              description={serviceMessage ?? (state.serverRunning ? `运行中，端口 ${state.serverPort}` : '未运行')}
            >
              <div className="flex items-center gap-3">
                <button
                  onClick={() => void handleRefreshServerStatus()}
                  className="flex items-center gap-1 text-sm text-[#5A6CFF] hover:underline"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  刷新
                </button>
                <button
                  onClick={() => void handleStopServer()}
                  disabled={!state.serverRunning}
                  className="flex items-center gap-1 text-sm text-[#F87171] hover:underline disabled:opacity-40"
                >
                  停止
                </button>
              </div>
            </SettingRow>
          </SettingSection>

          <SettingSection title="对外 API" icon={Globe2} delay={0.11}>
            <SettingRow
              label="释放 OpenAI 兼容 API"
              description={state.apiConfig.enabled ? `下一次加载模型时监听 ${state.apiConfig.host || '0.0.0.0'}:${state.serverPort}` : '关闭时仅本机 127.0.0.1 可访问'}
            >
              <ToggleSwitch
                checked={state.apiConfig.enabled}
                onChange={handleApiEnabledChange}
                label="释放 OpenAI 兼容 API"
              />
            </SettingRow>
            <div className="border-t border-white/5 dark:border-white/5" />
            <SettingRow
              label="API 端口"
              description={state.serverRunning ? '修改后需要重新加载模型才会生效' : '用于 llama-server --port'}
            >
              <input
                type="number"
                min={1}
                max={65535}
                value={state.serverPort}
                onChange={(event) => handlePortChange(event.target.value)}
                onBlur={() => void persistRuntimeSettings()}
                className="w-28 rounded-lg bg-black/5 dark:bg-white/5 px-3 py-2 text-right text-sm mono-font text-primary-custom outline-none focus:ring-1 focus:ring-[#5A6CFF]/50"
              />
            </SettingRow>
            <SettingRow
              label="监听地址"
              description="0.0.0.0 表示允许局域网访问；127.0.0.1 表示仅本机访问"
            >
              <select
                value={state.apiConfig.host}
                onChange={(event) => updateApiConfig({ host: event.target.value }, true)}
                className="w-36 glass-panel px-3 py-2 text-sm text-primary-custom bg-transparent outline-none"
              >
                <option value="0.0.0.0">0.0.0.0</option>
                <option value="127.0.0.1">127.0.0.1</option>
              </select>
            </SettingRow>
            <SettingRow
              label="API Key"
              description={state.apiConfig.hasApiKey ? '已设置。明文只在创建后显示一次；忘记后请重新申请。' : '未设置，不建议在局域网开放时留空'}
            >
              <div className="flex items-center gap-2">
                <button
                  onClick={handleGenerateApiKey}
                  className="px-3 py-2 rounded-lg bg-[#5A6CFF]/10 text-sm text-[#5A6CFF] hover:bg-[#5A6CFF]/15 transition-colors"
                >
                  {state.apiConfig.hasApiKey ? '重新申请' : '生成'}
                </button>
                {state.apiConfig.hasApiKey && (
                  <button
                    onClick={handleDeleteApiKey}
                    className="px-3 py-2 rounded-lg bg-[#F87171]/10 text-sm text-[#F87171] hover:bg-[#F87171]/15 transition-colors"
                  >
                    撤销
                  </button>
                )}
              </div>
            </SettingRow>
            {newApiKey && (
              <div className="rounded-xl border border-[#5A6CFF]/20 bg-[#5A6CFF]/[0.06] p-3">
                <div className="mb-2 flex items-center gap-2 text-xs font-medium text-primary-custom">
                  <KeyRound className="h-3.5 w-3.5 text-[#5A6CFF]" />
                  新 API Key 仅显示一次
                </div>
                <div className="flex min-w-0 items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-lg bg-black/5 px-3 py-2 text-xs text-primary-custom dark:bg-white/5">
                    {newApiKey}
                  </code>
                  <button
                    onClick={() => void handleCopyNewApiKey()}
                    className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-[#5A6CFF]/10 text-[#5A6CFF] hover:bg-[#5A6CFF]/15"
                    title="复制 API Key"
                  >
                    <Copy className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setNewApiKey(null)}
                    className="px-3 py-2 text-xs text-secondary-custom hover:text-primary-custom"
                  >
                    隐藏
                  </button>
                </div>
              </div>
            )}
            <div className="rounded-xl bg-black/[0.04] dark:bg-white/[0.04] p-3">
              <div className="flex items-center justify-between gap-3 mb-2">
                <div className="min-w-0">
                  <div className="text-xs text-secondary-custom">接口地址</div>
                  <div className="text-xs mono-font text-primary-custom truncate">{externalApiAddress}</div>
                </div>
                <button
                  onClick={() => void handleCopyApiExample()}
                  className="w-9 h-9 rounded-lg bg-black/5 dark:bg-white/5 flex items-center justify-center text-secondary-custom hover:text-primary-custom transition-colors flex-shrink-0"
                  title="复制 curl 示例"
                >
                  <Copy className="w-4 h-4" />
                </button>
              </div>
              <p className="text-[11px] text-secondary-custom leading-relaxed">
                对外 API 使用 llama-server 原生 OpenAI 兼容接口。防火墙需要放行端口，修改设置后请重新加载模型。
              </p>
            </div>
          </SettingSection>

          <div ref={kernelSectionRef}>
          <SettingSection title="llama.cpp 内核" icon={Power} delay={0.12}>
            <SettingRow
              label="当前内核"
              description={currentKernelMessage ?? (engineInfo?.llama_server_version ? `当前版本：${engineInfo.llama_server_version}` : engineInfo?.exe_path ?? 'resources/llama-server.exe')}
            >
              <button
                onClick={() => void handleCheckEngine()}
                className="flex items-center gap-1 text-sm text-[#5A6CFF] hover:underline"
              >
                检查
              </button>
            </SettingRow>
            <div className="border-t border-white/5 dark:border-white/5" />
            <SettingRow
              label="最新 release"
              description={engineMessage ?? (releaseInfo ? `${releaseInfo.version} · ${releaseInfo.published_at.slice(0, 10)}` : '读取 ggml-org/llama.cpp 发布包')}
            >
              <div className="flex items-center gap-3">
                <button
                  onClick={() => void handleCheckLatest()}
                  className="flex items-center gap-1 text-sm text-[#5A6CFF] hover:underline"
                >
                  检查更新
                </button>
                <button
                  onClick={() => void handleUpdateKernel()}
                  disabled={state.serverRunning || !releaseInfo?.assets.length || !selectedAssetUrl}
                  className="flex items-center gap-1 text-sm text-[#34D399] hover:underline disabled:opacity-40"
                >
                  更新
                </button>
              </div>
            </SettingRow>
            <div className="border-t border-white/5 dark:border-white/5" />
            <SettingRow
              label="下载源"
              description={kernelSourceDescription(kernelDownloadSource)}
            >
              <select
                value={kernelDownloadSource}
                onChange={(event) => handleKernelSourceChange(event.target.value as KernelDownloadSource)}
                className="max-w-[260px] glass-panel px-3 py-2 text-xs text-primary-custom bg-transparent outline-none"
              >
                <option value="mirror">镜像加速（推荐）</option>
                <option value="direct">直连 GitHub 官方</option>
              </select>
            </SettingRow>
            {releaseInfo && (
              <>
                <div className="border-t border-white/5 dark:border-white/5" />
                <SettingRow
                  label="发布包"
                  description={
                    releaseInfo.assets.length > 0
                      ? `${matchedBackendDescription(releaseInfo, selectedAsset)} · ${selectedAsset ? `${selectedAsset.matches_host ? '自动匹配' : '手动选择'} · ${formatBytes(selectedAsset.size)}` : '未选择'}`
                      : '没有找到可用的 Windows x64 发布包'
                  }
                >
                  <select
                    value={selectedAssetUrl}
                    onChange={(event) => setSelectedAssetUrl(event.target.value)}
                    disabled={releaseInfo.assets.length === 0}
                    className="max-w-[260px] glass-panel px-3 py-2 text-xs text-primary-custom bg-transparent outline-none disabled:opacity-50"
                  >
                    {releaseInfo.assets.length === 0 ? (
                      <option value="">无可用发布包</option>
                    ) : (
                      releaseInfo.assets.map((asset) => (
                        <option key={asset.browser_download_url} value={asset.browser_download_url}>
                          {formatAssetOption(asset)}
                        </option>
                      ))
                    )}
                  </select>
                </SettingRow>
              </>
            )}
          </SettingSection>
          </div>

          {themeGroups.length > 0 && (
            <SettingSection title="模型主题分组" icon={Palette} delay={0.14}>
              <button
                onClick={() => setThemeGroupsCollapsed((value) => !value)}
                className="w-full flex items-center justify-between gap-3 rounded-xl px-3 py-2 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              >
                <span className="text-sm text-primary-custom">{themeGroups.length} 个主题组</span>
                <ChevronDown
                  className={`w-4 h-4 text-secondary-custom transition-transform ${themeGroupsCollapsed ? '-rotate-90' : 'rotate-0'}`}
                />
              </button>

              {!themeGroupsCollapsed && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="space-y-3 overflow-hidden"
                >
                  {themeGroups.map((group, index) => (
                    <div key={group.key}>
                      {index > 0 && <div className="border-t border-white/5 dark:border-white/5 mb-3" />}
                      <div className="flex items-center justify-between gap-4 py-2">
                        <div className="flex items-center gap-3 min-w-0">
                          <div
                            className="w-10 h-10 rounded-xl flex items-center justify-center text-base font-bold text-white flex-shrink-0"
                            style={{ background: group.color }}
                          >
                            {group.icon}
                          </div>
                          <div className="min-w-0">
                            <div className="text-sm text-primary-custom">{group.label}</div>
                            <div className="text-xs text-secondary-custom truncate">
                              {group.models.length} 个模型 · {group.models.map((model) => model.name).join(' / ')}
                            </div>
                          </div>
                        </div>
                        <input
                          type="color"
                          value={group.color}
                          onChange={(event) => dispatch({
                            type: 'SET_MODEL_GROUP_THEME_COLOR',
                            payload: { groupKey: group.key, color: event.target.value },
                          })}
                          className="w-10 h-8 rounded-lg bg-transparent cursor-pointer flex-shrink-0"
                        />
                      </div>
                    </div>
                  ))}
                </motion.div>
              )}
            </SettingSection>
          )}

          {/* 数据管理 */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.15, ease: [0.16, 1, 0.3, 1] }}
            className="glass-panel p-5 border border-[#F87171]/25"
          >
            <div className="flex items-center gap-2.5 mb-2">
              <Database className="w-4.5 h-4.5 text-[#F87171]" />
              <h2 className="text-[15px] font-semibold text-primary-custom">数据管理</h2>
            </div>
            <div className="flex items-start gap-2 mb-4 px-3 py-2 rounded-lg bg-[#F87171]/10 border border-[#F87171]/20">
              <AlertTriangle className="w-4 h-4 text-[#F87171] mt-0.5 flex-shrink-0" />
              <p className="text-xs text-secondary-custom leading-relaxed">
                以下操作会删除本地数据，且 <span className="text-primary-custom font-medium">无法恢复</span>。
                操作前请确认无需保留聊天记录、API Key 与配置。模型文件、llama.cpp 内核与 WebView2 缓存不会被删除。
              </p>
            </div>

            <div className="space-y-1">
              <SettingRow
                label="数据目录"
                description="在系统资源管理器中打开 AppData\\Roaming\\AgentLLM，便于手动备份或检查文件。"
              >
                <button
                  onClick={() => void handleOpenAppDataDir()}
                  className="flex items-center gap-1 text-sm text-[#5A6CFF] hover:underline"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  打开
                </button>
              </SettingRow>

              <div className="border-t border-white/5 dark:border-white/5" />
              <SettingRow
                label="清除界面状态与聊天记录"
                description="清空聊天会话、使用统计、模型加载记忆、生图与界面偏好。清除后窗口会自动刷新。"
              >
                <button
                  onClick={() => setPendingDataAction('clear-frontend-state')}
                  className="flex items-center gap-1 text-sm text-[#F87171] hover:underline"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  清除
                </button>
              </SettingRow>

              <div className="border-t border-white/5 dark:border-white/5" />
              <SettingRow
                label="清除模型扫描缓存"
                description="删除 GGUF 元数据缓存目录；下次进入模型页将重新解析。模型文件本身不会被删除。"
              >
                <button
                  onClick={() => setPendingDataAction('clear-model-cache')}
                  className="flex items-center gap-1 text-sm text-[#F87171] hover:underline"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  清除
                </button>
              </SettingRow>

              <div className="border-t border-white/5 dark:border-white/5" />
              <SettingRow
                label="清除全部生图供应商密钥"
                description="从 Windows 凭据管理器中删除所有已保存的生图 API Key。"
              >
                <button
                  onClick={() => setPendingDataAction('clear-image-keys')}
                  className="flex items-center gap-1 text-sm text-[#F87171] hover:underline"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  清除
                </button>
              </SettingRow>

              <div className="border-t border-white/5 dark:border-white/5" />
              <SettingRow
                label="重置应用配置"
                description="把 config.json 恢复为默认值，并撤销对外 API Key；预设参数、调参历史一并清除。"
              >
                <button
                  onClick={() => setPendingDataAction('reset-app-config')}
                  className="flex items-center gap-1 text-sm text-[#F87171] hover:underline"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  重置
                </button>
              </SettingRow>

              <div className="border-t border-white/5 dark:border-white/5" />
              <SettingRow
                label="出厂重置"
                description="清除上述全部本地数据并刷新应用。此操作不可恢复，仅在排障无果时使用。"
              >
                <button
                  onClick={() => setPendingDataAction('factory-reset')}
                  className="flex items-center gap-1 text-sm px-3 py-1.5 rounded-lg bg-[#F87171]/10 text-[#F87171] hover:bg-[#F87171]/15 transition-colors"
                >
                  <AlertTriangle className="w-3.5 h-3.5" />
                  出厂重置
                </button>
              </SettingRow>
            </div>

            {dataMessage && (
              <p className="mt-3 text-xs text-secondary-custom">{dataMessage}</p>
            )}
          </motion.div>

          {/* About */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.15, ease: [0.16, 1, 0.3, 1] }}
            className="glass-panel p-5"
          >
            <div className="text-center">
              <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-[#5A6CFF] to-[#8B5CF6] flex items-center justify-center mx-auto mb-3">
                <span className="text-xl font-bold text-white">L</span>
              </div>
              <h3 className="text-base font-semibold text-primary-custom mb-1">Agent LLM</h3>
              <p className="text-xs text-secondary-custom mb-3">v0.1.0 · 本地大模型管理启动器</p>
              <div className="flex items-center justify-center gap-4 text-xs text-secondary-custom">
                <span>React 19</span>
                <span>·</span>
                <span>Tailwind CSS</span>
                <span>·</span>
                <span>llama.cpp</span>
              </div>
            </div>
          </motion.div>
        </div>
      </div>

      <ConfirmDialog
        open={pendingDataAction !== null}
        title={activeDialogConfig?.title ?? ''}
        description={activeDialogConfig?.description}
        bullets={activeDialogConfig?.bullets}
        footnote={activeDialogConfig?.footnote}
        confirmLabel={activeDialogConfig?.confirmLabel ?? '确认'}
        confirmPhrase={activeDialogConfig?.confirmPhrase}
        tone={activeDialogConfig?.tone ?? 'danger'}
        onConfirm={runPendingDataAction}
        onCancel={() => setPendingDataAction(null)}
      />
    </div>
  );
}
