import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  FolderPlus,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  FolderX,
  Power,
  Palette,
  Database,
  AlertTriangle,
  Trash2,
  FolderOpen,
  Monitor,
  SlidersHorizontal,
  Sun,
  Moon,
  MonitorSmartphone,
} from 'lucide-react';
import { useApp } from '@/context/AppContext';
import ToggleSwitch from '@/components/ToggleSwitch';
import ConfirmDialog from '@/components/ConfirmDialog';
import { SettingRow, SettingSection } from '@/components/SettingSection';
import PageHeader from '@/components/PageHeader';
import type { ModelInfo, ThemeMode } from '@/types';
import { getModelThemeGroup } from '@/lib/modelTheme';
import { resolveApiName } from '@/lib/modelIdentity';
import {
  addDesktopModelDir,
  clearDesktopModelCache,
  clearModelRunRecords,
  getDesktopAppDataDir,
  getDesktopServerStatus,
  isDesktopRuntime,
  pickModelDirectory,
  removeDesktopModelDir,
  resetDesktopAppConfig,
  revealDesktopPath,
  scanDesktopModels,
  setCloseToTray,
  stopDesktopServer,
  toFrontendModel,
} from '@/lib/desktop';

// 「数据管理」中可执行的清除动作种类。
type DataActionKind =
  | 'clear-frontend-state'
  | 'clear-model-cache'
  | 'reset-app-config'
  | 'factory-reset';

// 前端本地持久化的 localStorage key 清单：与 AppContext / SettingsPage 中的常量保持一致。
const FRONTEND_STORAGE_KEYS = [
  'agent-llm-local-state-v1',
  'agent-llm-kernel-download-source',
] as const;

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

// 主题模式三选段控件：浅色 / 深色 / 跟随系统。
function ThemeModeSelector({ value, onChange }: { value: ThemeMode; onChange: (mode: ThemeMode) => void }) {
  const options: Array<{ value: ThemeMode; label: string; icon: typeof Sun }> = [
    { value: 'light', label: '浅色', icon: Sun },
    { value: 'dark', label: '深色', icon: Moon },
    { value: 'system', label: '跟随系统', icon: MonitorSmartphone },
  ];
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-0.5 dark:border-white/[0.08] dark:bg-white/[0.04]">
      {options.map((option) => {
        const Icon = option.icon;
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={active}
            className={`flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors ${
              active
                ? 'bg-[var(--surface)] text-[var(--accent)] shadow-sm dark:bg-[var(--surface-raised)] dark:text-[var(--accent)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] dark:text-[var(--text-secondary)] dark:hover:text-[var(--text-primary)]'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export default function SettingsPage() {
  const { state, dispatch } = useApp();
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [serviceMessage, setServiceMessage] = useState<string | null>(null);
  const [themeGroupsCollapsed, setThemeGroupsCollapsed] = useState(false);
  // 数据管理：当前要弹出确认对话框的清除类型；null 表示对话框关闭。
  const [pendingDataAction, setPendingDataAction] = useState<DataActionKind | null>(null);
  const [dataMessage, setDataMessage] = useState<string | null>(null);

  const refreshLocalModels = async () => {
    if (!isDesktopRuntime()) {
      setScanMessage('请在 Tauri 桌面版中使用本地模型扫描。');
      return;
    }

    setScanMessage('正在扫描 GGUF 模型...');
    try {
      const models = (await scanDesktopModels(true)).map(toFrontendModel);
      dispatch({ type: 'UPSERT_MODELS', payload: models });
      dispatch({ type: 'PRUNE_USAGE', payload: models.map((model) => model.id) });
      // 已删除模型的独立运行记录也一并清掉。
      const keepIds = new Set(models.map((model) => model.id));
      void Promise.all(
        Object.keys(state.usageByModel)
          .filter((id) => !keepIds.has(id) && !id.startsWith('api-'))
          .map((id) => clearModelRunRecords(id).catch(() => undefined)),
      );
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

  const handleCloseToTrayChange = async (enabled: boolean) => {
    dispatch({ type: 'SET_CLOSE_TO_TRAY', payload: enabled });
    if (!isDesktopRuntime()) {
      setServiceMessage('请在 Tauri 桌面版中设置托盘模式。');
      return;
    }
    try {
      await setCloseToTray(enabled);
      setServiceMessage(enabled ? '已开启托盘模式，关闭窗口时将隐藏到系统托盘。' : '已关闭托盘模式，关闭窗口时将直接退出应用。');
    } catch (error) {
      setServiceMessage(`托盘模式设置失败：${String(error)}`);
    }
  };

  const handleCopyApiExample = async () => {

    const auth = state.apiConfig.hasApiKey ? ` \\\n  -H "Authorization: Bearer <API_KEY>"` : '';
    const command = [
      `curl http://127.0.0.1:${state.serverPort}/v1/chat/completions \\`,
      '  -H "Content-Type: application/json" \\',
      `${auth}${auth ? ' \\' : ''}`,
      `  -d "{\\"model\\": \\"${resolveApiName(state.models.find((model) => model.id === state.activeModelId))}\\", \\"messages\\": [{\\"role\\": \\"user\\", \\"content\\": \\"你好\\"}], \\"stream\\": false}"`,
    ].filter(Boolean).join('\n');
    await navigator.clipboard.writeText(command);
    setServiceMessage('已复制 OpenAI 兼容 API 调用示例。');
  };
  void handleCopyApiExample;

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
        '系统 keyring 中的对外 API Key',
        '前端 localStorage 中的聊天记录、使用统计与界面偏好',
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
        <div className="mx-auto mb-6 max-w-2xl">
          <PageHeader icon={SlidersHorizontal} title="设置" description="配置 Agent LLM 启动器和模型运行参数" />
        </div>

        <div className="mx-auto max-w-2xl pb-12">
          <SettingSection title="界面与外观" icon={Palette} delay={0}>
            <SettingRow
              label="主题模式"
              description={state.themeMode === 'system' ? '跟随 Windows 亮/暗设置自动切换' : `当前固定为${state.themeMode === 'dark' ? '深色' : '浅色'}主题`}
            >
              <ThemeModeSelector
                value={state.themeMode}
                onChange={(mode) => dispatch({ type: 'SET_THEME_MODE', payload: mode })}
              />
            </SettingRow>
            <div className="border-t border-[var(--border-subtle)]" />
            <SettingRow
              label="自动同步系统主题色"
              description={state.syncSystemAccent ? '强调色跟随 Windows 个性化设置的主题色' : '使用 Fluent 默认蓝色作为强调色'}
            >
              <ToggleSwitch
                checked={state.syncSystemAccent}
                onChange={(v) => dispatch({ type: 'SET_SYNC_SYSTEM_ACCENT', payload: v })}
                label="自动同步系统主题色"
              />
            </SettingRow>
            <div className="border-t border-[var(--border-subtle)]" />
            <SettingRow
              label="毛玻璃效果"
              description={'开启后使用系统亚克力毛玻璃：能透出桌面壁纸的颜色变化，并保留一层半透明霜化，保证文字可读。系统开启「减少透明度」时自动退回不透明。'}
            >
              <ToggleSwitch
                checked={state.acrylicMode}
                onChange={(v) => dispatch({ type: 'SET_ACRYLIC_MODE', payload: v })}
                label="毛玻璃效果"
              />
            </SettingRow>
          </SettingSection>

          <SettingSection title="本地模型运行" icon={FolderPlus} delay={0}>
            <SettingRow
              label="模型目录"
              description={state.modelDirs.length > 0 ? `已配置 ${state.modelDirs.length} 个模型目录` : '选择包含 .gguf 文件的本地目录'}
            >
              <button
                onClick={handleAddModelDir}
                className="flex min-h-9 items-center gap-1 rounded-md px-2 text-sm text-[var(--accent)] hover:bg-[var(--surface-muted)] dark:hover:bg-[var(--surface-raised)]"
              >
                选择目录 <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </SettingRow>
            {state.modelDirs.length > 0 && (
              <>
                <div className="border-t border-[var(--border-subtle)]" />
                <div className="space-y-2">
                  {state.modelDirs.map((dir) => (
                    <div key={dir} className="flex items-center justify-between gap-3 text-xs text-secondary-custom">
                      <span className="truncate">{dir}</span>
                      <button
                        onClick={() => void handleRemoveModelDir(dir)}
                        className="flex min-h-8 flex-shrink-0 items-center gap-1 rounded-md px-2 text-[var(--state-danger)] hover:bg-[var(--state-danger-border)] dark:hover:bg-[var(--surface-raised)]"
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
                <div className="border-t border-[var(--border-subtle)]" />
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
                  className="flex min-h-9 items-center gap-1 rounded-md px-2 text-sm text-[var(--accent)] hover:bg-[var(--surface-muted)] dark:hover:bg-[var(--surface-raised)]"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  刷新
                </button>
                <button
                  onClick={() => void handleStopServer()}
                  disabled={!state.serverRunning}
                  className="flex min-h-9 items-center gap-1 rounded-md px-2 text-sm text-[var(--state-danger)] hover:bg-[var(--state-danger-border)] disabled:opacity-40 dark:hover:bg-[var(--surface-raised)]"
                >
                  停止
                </button>
              </div>
            </SettingRow>
          </SettingSection>

          <SettingSection title="窗口与托盘" icon={Monitor} delay={0.1}>
            <SettingRow
              label="托盘模式"
              description={state.closeToTray ? '关闭窗口时隐藏到系统托盘，后台保持运行' : '关闭窗口时直接退出应用'}
            >
              <ToggleSwitch
                checked={state.closeToTray}
                onChange={(v) => void handleCloseToTrayChange(v)}
                label="托盘模式"
              />
            </SettingRow>
          </SettingSection>

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
                      {index > 0 && <div className="mb-3 border-t border-[var(--border-subtle)]" />}
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
                          aria-label={`${group.label} 主题颜色`}
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
            className="border-b border-[var(--border-subtle)] py-5"
          >
            <div className="flex items-center gap-2.5 mb-2">
              <Database className="w-4.5 h-4.5 text-[var(--state-danger)]" />
              <h2 className="text-[15px] font-semibold text-primary-custom">数据管理</h2>
            </div>
            <div className="flex items-start gap-2 mb-4 px-3 py-2 rounded-lg bg-[var(--state-danger)]/10 border border-[var(--state-danger)]/20">
              <AlertTriangle className="w-4 h-4 text-[var(--state-danger)] mt-0.5 flex-shrink-0" />
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
                  className="flex min-h-9 items-center gap-1 rounded-md px-2 text-sm text-[var(--accent)] hover:bg-[var(--surface-muted)] dark:hover:bg-[var(--surface-raised)]"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  打开
                </button>
              </SettingRow>

              <div className="border-t border-[var(--border-subtle)]" />
              <SettingRow
                label="清除界面状态与聊天记录"
                description="清空聊天会话、使用统计、模型加载记忆与界面偏好。清除后窗口会自动刷新。"
              >
                <button
                  onClick={() => setPendingDataAction('clear-frontend-state')}
                  className="flex items-center gap-1 text-sm text-[var(--state-danger)] hover:underline"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  清除
                </button>
              </SettingRow>

              <div className="border-t border-[var(--border-subtle)]" />
              <SettingRow
                label="清除模型扫描缓存"
                description="删除 GGUF 元数据缓存目录；下次进入模型页将重新解析。模型文件本身不会被删除。"
              >
                <button
                  onClick={() => setPendingDataAction('clear-model-cache')}
                  className="flex items-center gap-1 text-sm text-[var(--state-danger)] hover:underline"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  清除
                </button>
              </SettingRow>

              <div className="border-t border-[var(--border-subtle)]" />
              <SettingRow
                label="重置应用配置"
                description="把 config.json 恢复为默认值，并撤销对外 API Key；预设参数、调参历史一并清除。"
              >
                <button
                  onClick={() => setPendingDataAction('reset-app-config')}
                  className="flex items-center gap-1 text-sm text-[var(--state-danger)] hover:underline"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  重置
                </button>
              </SettingRow>

              <div className="border-t border-[var(--border-subtle)]" />
              <SettingRow
                label="出厂重置"
                description="清除上述全部本地数据并刷新应用。此操作不可恢复，仅在排障无果时使用。"
              >
                <button
                  onClick={() => setPendingDataAction('factory-reset')}
                  className="flex items-center gap-1 text-sm px-3 py-1.5 rounded-lg bg-[var(--state-danger)]/10 text-[var(--state-danger)] hover:bg-[var(--state-danger)]/15 transition-colors"
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
            className="border-b border-[var(--border-subtle)] py-6"
          >
            <div className="text-center">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-lg bg-[var(--accent)]">
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
