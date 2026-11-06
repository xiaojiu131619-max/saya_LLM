import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  AlertTriangle,
  Archive,
  Database,
  FolderOpen,
  FolderPlus,
  FolderX,
  HardDrive,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useApp } from '@/context/AppContext';
import ConfirmDialog from '@/components/ConfirmDialog';
import { SettingRow } from '@/components/SettingSection';
import PageHeader from '@/components/PageHeader';
import {
  addDesktopModelDir,
  clearDesktopModelCache,
  clearModelRunRecords,
  getKernelOverridePath,
  getStoragePaths,
  isDesktopRuntime,
  pickKernelExe,
  pickModelDirectory,
  pickStorageDirectory,
  removeDesktopModelDir,
  resetDesktopAppConfig,
  revealDesktopPath,
  scanDesktopModels,
  setKernelOverridePath,
  setStorageDir,
  stopActiveChatCompletion,
  stopDesktopServer,
  toFrontendModel,
  writeArchiveFile,
  type StorageDirKind,
  type StoragePaths,
} from '@/lib/desktop';
import { exportSessionAsJson, exportSessionAsMarkdown } from '@/features/chat/chatUtils';

/** 「数据管理」中被确认过的动作种类。 */
type DataActionKind =
  | 'clear-chat-history'
  | 'clear-usage'
  | 'clear-model-cache'
  | 'reset-ui-prefs'
  | 'reset-app-config'
  | 'factory-reset';

/** 前端本地持久化的 localStorage key 清单：与 AppContext 中的常量保持一致。 */
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

/** 目录配置行：显示生效路径 + 「修改 / 恢复默认 / 打开」。 */
function DirRow({ label, description, value, custom, defaultValue, onPick, onReset, onOpen }: {
  label: string;
  description: string;
  value: string;
  custom: boolean;
  defaultValue: string;
  onPick: () => void;
  onReset: () => void;
  onOpen: () => void;
}) {
  return (
    <div className="min-w-0 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-[length:var(--font-body)] text-[var(--text-primary)]">{label}</span>
            <span className={`flex-shrink-0 rounded-full border px-1.5 py-0.5 text-[length:var(--font-eyebrow)] ${
              custom
                ? 'border-[var(--accent)]/40 bg-[var(--accent-subtle)] text-[var(--accent)]'
                : 'border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text-tertiary)]'
            }`}>
              {custom ? '自定义' : '默认'}
            </span>
          </div>
          <p className="mt-0.5 text-[length:var(--font-caption)] leading-5 text-[var(--text-secondary)]">{description}</p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onOpen}
            className="flex h-8 items-center gap-1 rounded-[var(--radius-field)] px-2 text-[length:var(--font-caption)] text-[var(--accent)] transition-colors hover:bg-[var(--accent-subtle)]"
            title="在资源管理器中打开"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            打开
          </button>
          <button
            type="button"
            onClick={onPick}
            className="flex h-8 items-center gap-1 rounded-[var(--radius-field)] px-2 text-[length:var(--font-caption)] text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)]"
          >
            <FolderPlus className="h-3.5 w-3.5" />
            修改
          </button>
          {custom && (
            <button
              type="button"
              onClick={onReset}
              className="flex h-8 items-center gap-1 rounded-[var(--radius-field)] px-2 text-[length:var(--font-caption)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)]"
              title={`恢复默认：${defaultValue}`}
            >
              恢复默认
            </button>
          )}
        </div>
      </div>
      <div className="mono-font mt-1.5 break-all rounded-[var(--radius-field)] bg-[var(--surface-muted)] px-2.5 py-1.5 text-[length:var(--font-caption)] text-[var(--text-secondary)]">
        {value || '—'}
      </div>
    </div>
  );
}

export default function DataManagementPage() {
  const { state, dispatch } = useApp();
  const [pendingDataAction, setPendingDataAction] = useState<DataActionKind | null>(null);
  const [dataMessage, setDataMessage] = useState<string | null>(null);
  const [paths, setPaths] = useState<StoragePaths | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);

  const chatSessionCount = Object.values(state.chatSessions).reduce((sum, sessions) => sum + sessions.length, 0);
  const chatMessageCount = Object.values(state.chatSessions)
    .reduce((sum, sessions) => sum + sessions.reduce((n, session) => n + session.messages.length, 0), 0);

  const refreshPaths = useCallback(async () => {
    try {
      const next = await getStoragePaths();
      if (next) setPaths(next);
    } catch (error) {
      setDataMessage(`读取目录配置失败：${String(error)}`);
    }
  }, []);

  useEffect(() => {
    // 起点在定时回调里发起：effect 体内同步触发 setState 会级联渲染（lint 也会拦）。
    const timer = window.setTimeout(() => void refreshPaths(), 0);
    return () => window.clearTimeout(timer);
  }, [refreshPaths]);

  // 目录修改：选目录 → 保存 → 重新拉取生效路径。
  const handlePickDir = async (kind: StorageDirKind, title: string) => {
    if (!isDesktopRuntime()) {
      setDataMessage('请在 Tauri 桌面版中修改目录。');
      return;
    }
    const selected = await pickStorageDirectory(title);
    if (!selected) return;
    try {
      await setStorageDir(kind, selected);
      await refreshPaths();
      setDataMessage(`${title}已更新为：${selected}`);
    } catch (error) {
      setDataMessage(`${title}保存失败：${String(error)}`);
    }
  };

  const handleResetDir = async (kind: StorageDirKind, title: string) => {
    try {
      await setStorageDir(kind, null);
      await refreshPaths();
      setDataMessage(`${title}已恢复默认位置。`);
    } catch (error) {
      setDataMessage(`${title}恢复失败：${String(error)}`);
    }
  };

  const handleOpenPath = async (path: string) => {
    if (!isDesktopRuntime()) {
      setDataMessage('请在 Tauri 桌面版中打开目录。');
      return;
    }
    try {
      await revealDesktopPath(path);
    } catch (error) {
      setDataMessage(`打开目录失败：${String(error)}`);
    }
  };

  // ---- 模型目录（增删后立即重扫，让模型列表与磁盘一致）----
  const refreshLocalModels = async () => {
    if (!isDesktopRuntime()) return;
    try {
      const models = (await scanDesktopModels(true)).map(toFrontendModel);
      dispatch({ type: 'UPSERT_MODELS', payload: models });
      dispatch({ type: 'PRUNE_USAGE', payload: models.map((model) => model.id) });
      const keepIds = new Set(models.map((model) => model.id));
      void Promise.all(
        Object.keys(state.usageByModel)
          .filter((id) => !keepIds.has(id) && !id.startsWith('api-') && !id.startsWith('engine:'))
          .map((id) => clearModelRunRecords(id).catch(() => undefined)),
      );
      setDataMessage(models.length > 0 ? `已重新扫描，发现 ${models.length} 个本地 GGUF 模型。` : '模型目录里暂未发现 GGUF 文件。');
    } catch (error) {
      setDataMessage(`扫描失败：${String(error)}`);
    }
  };

  const handleAddModelDir = async () => {
    const selected = await pickModelDirectory();
    if (!selected) return;
    try {
      const dirs = await addDesktopModelDir(selected);
      dispatch({ type: 'SET_MODEL_DIRS', payload: dirs });
      await refreshPaths();
      await refreshLocalModels();
    } catch (error) {
      setDataMessage(`添加模型目录失败：${String(error)}`);
    }
  };

  const handleRemoveModelDir = async (dir: string) => {
    try {
      const dirs = await removeDesktopModelDir(dir);
      dispatch({ type: 'SET_MODEL_DIRS', payload: dirs });
      await refreshPaths();
      await refreshLocalModels();
    } catch (error) {
      setDataMessage(`移除模型目录失败：${String(error)}`);
    }
  };

  // ---- 归档聊天记录 ----
  const handleArchiveAllSessions = async () => {
    if (chatSessionCount === 0) {
      setDataMessage('当前没有可归档的对话。');
      return;
    }
    if (!isDesktopRuntime()) {
      setDataMessage('归档到文件夹需要在桌面版中使用。');
      return;
    }
    setArchiveBusy(true);
    try {
      const sessions = Object.values(state.chatSessions).flat();
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      let written = 0;
      for (const session of sessions) {
        // 同名会话很常见（标题来自首条消息），文件名必须带会话标识才不会互相覆盖。
        // 同时去掉首尾的点与空格：Windows 对 `.`/`..` 和尾随空格的处理会让写入失败。
        const safeTitle = session.title
          .replace(/[<>:"/\\|?*]/g, '_')
          .replace(/^[. ]+|[. ]+$/g, '')
          .slice(0, 50) || '未命名对话';
        const idPart = session.id.replace(/[^A-Za-z0-9_-]/g, '').slice(-8) || String(written + 1);
        const payload = JSON.stringify(
          { exportedAt: Date.now(), markdown: exportSessionAsMarkdown(session), session: JSON.parse(exportSessionAsJson(session)) },
          null,
          2,
        );
        await writeArchiveFile(`${safeTitle}-${stamp}-${idPart}.json`, payload);
        written += 1;
      }
      setDataMessage(`已把 ${written} 个对话归档到归档目录。`);
    } catch (error) {
      setDataMessage(`归档失败：${String(error)}`);
    } finally {
      setArchiveBusy(false);
    }
  };

  // ---- 清除类动作 ----
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
    window.setTimeout(() => window.location.reload(), 200);
  };

  const handleResetAppConfig = async () => {
    if (!isDesktopRuntime()) {
      setDataMessage('请在 Tauri 桌面版中重置应用配置。');
      return;
    }
    if (state.serverRunning) {
      await stopDesktopServer();
      dispatch({ type: 'SET_SERVER_RUNNING', payload: false });
    }
    await resetDesktopAppConfig();
    setDataMessage('应用配置已重置为默认值，应用即将刷新...');
    window.setTimeout(() => window.location.reload(), 200);
  };

  const runPendingDataAction = async () => {
    switch (pendingDataAction) {
      case 'clear-chat-history':
        // 先中止在途生成：请求还在跑的话会把结果写回已删除的会话，并继续占用 GPU。
        stopActiveChatCompletion();
        dispatch({ type: 'CLEAR_ALL_CHAT_HISTORY' });
        setDataMessage('已清空全部对话历史，模型与目录配置未变动。');
        break;
      case 'clear-usage':
        dispatch({ type: 'RESET_USAGE' });
        setDataMessage('使用统计已清零（含 NiNfer / Strata 引擎用量）。');
        break;
      case 'clear-model-cache':
        try {
          const result = await clearDesktopModelCache();
          setDataMessage(result || '模型扫描缓存已清除。下次进入模型页将重新扫描。');
        } catch (error) {
          setDataMessage(`清除缓存失败：${String(error)}`);
        }
        break;
      case 'reset-ui-prefs':
        dispatch({ type: 'RESET_UI_PREFS' });
        setDataMessage('界面偏好已恢复默认值。');
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

  const dataDialogConfig: Record<DataActionKind, {
    title: string;
    description: string;
    bullets?: string[];
    footnote?: string;
    confirmLabel: string;
    confirmPhrase?: string;
    tone: 'warning' | 'danger';
  }> = {
    'clear-chat-history': {
      title: '清空全部对话历史？',
      description: `将删除本机保存的 ${chatSessionCount} 个会话、共 ${chatMessageCount} 条消息。`,
      bullets: ['所有模型的对话会话与消息记录', '正在使用的会话会被重置为空'],
      footnote: '此操作不可撤销。模型文件、目录配置、MCP 配置与使用统计均不受影响。',
      confirmLabel: '清空历史',
      tone: 'danger',
    },
    'clear-usage': {
      title: '清零使用统计？',
      description: '按模型累计的 token、耗时与速度都会被清除，用量图表回到空白状态。',
      bullets: ['主模型与对外 API 的累计用量', 'NiNfer / Strata 引擎的累计用量', '最近使用排序记录'],
      footnote: '不影响任何模型加载参数、对话记录或服务端口设置。',
      confirmLabel: '清零统计',
      tone: 'warning',
    },
    'clear-model-cache': {
      title: '清除模型扫描缓存？',
      description: '下次进入模型页时将重新解析 .gguf 文件元数据；模型文件本身不会被删除。',
      footnote: '仅清空扫描缓存目录中的解析结果。',
      confirmLabel: '清除缓存',
      tone: 'warning',
    },
    'reset-ui-prefs': {
      title: '恢复界面默认值？',
      description: '主题、强调色同步、毛玻璃、动画、发送快捷键、排序、列数与侧边栏宽度会回到出厂值。',
      bullets: ['外观与交互偏好', '侧边栏展开状态与宽度'],
      footnote: '对话历史、模型目录、MCP 配置与服务端口保持不变。',
      confirmLabel: '恢复默认',
      tone: 'warning',
    },
    'reset-app-config': {
      title: '重置应用配置？',
      description: '会停止本地 llama-server，并把 config.json 恢复为出厂默认值（含三个可配置目录）。',
      bullets: ['清空模型目录列表（不删除目录里的模型文件）', '清空各模型的预设参数与调参历史', '端口、对外 API 开关、主题恢复默认', '撤销对外 OpenAI 兼容 API 的 Key'],
      footnote: 'llama.cpp 内核可执行文件与模型扫描缓存不在此操作范围。',
      confirmLabel: '重置配置',
      confirmPhrase: '重置配置',
      tone: 'danger',
    },
    'factory-reset': {
      title: '出厂重置（清除全部本地数据）',
      description: '一次性清除前述所有本地数据并刷新窗口。模型文件、llama.cpp 内核与日志文件不会被删除。',
      bullets: ['后端配置 config.json 与模型扫描缓存', '系统凭据管理器中的对外 API Key', '前端保存的聊天记录、使用统计与界面偏好', '正在运行的 llama-server 进程'],
      footnote: '此操作不可恢复。强烈建议在排错无果时再使用。',
      confirmLabel: '执行出厂重置',
      confirmPhrase: '我确认清除',
      tone: 'danger',
    },
  };

  const activeDialogConfig = pendingDataAction ? dataDialogConfig[pendingDataAction] : null;
  const appDataDir = paths?.app_data_dir ?? '';

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto mb-6 max-w-3xl">
          <PageHeader
            icon={Database}
            title="数据管理"
            description="管理模型/引擎/日志/归档目录，以及清除或重置本软件保存的本地数据。危险操作都会先二次确认。"
          />
        </div>

        <div className="mx-auto max-w-3xl space-y-5 pb-12">
          {/* 一、目录设置 */}
          <motion.section
            initial={false}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-4"
          >
            <div className="mb-1 flex items-center gap-2">
              <HardDrive className="h-4 w-4 text-[var(--accent)]" />
              <h2 className="text-[length:var(--font-subtitle)] font-semibold text-[var(--text-primary)]">目录设置</h2>
            </div>
            <p className="mb-2 text-[length:var(--font-caption)] leading-5 text-[var(--text-secondary)]">
              三类可配置目录都会立即生效：引擎目录决定内核安装位置，日志目录决定各处日志落盘位置，归档目录用于存放导出的对话记录。
            </p>

            <div className="divide-y divide-[var(--border-subtle)]">
              {/* 模型目录（可多选，来自配置） */}
              <div className="py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-[length:var(--font-body)] text-[var(--text-primary)]">模型目录</div>
                    <p className="mt-0.5 text-[length:var(--font-caption)] leading-5 text-[var(--text-secondary)]">
                      扫描 GGUF 模型的位置，可添加多个；移除只影响扫描，不删除磁盘上的文件。
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleAddModelDir()}
                    className="flex h-8 flex-shrink-0 items-center gap-1 rounded-[var(--radius-field)] px-2 text-[length:var(--font-caption)] text-[var(--accent)] transition-colors hover:bg-[var(--accent-subtle)]"
                  >
                    <FolderPlus className="h-3.5 w-3.5" />
                    添加目录
                  </button>
                </div>
                <div className="mt-2 space-y-1.5">
                  {state.modelDirs.length === 0 ? (
                    <p className="text-[length:var(--font-caption)] text-[var(--text-tertiary)]">尚未配置模型目录。</p>
                  ) : state.modelDirs.map((dir) => (
                    <div key={dir} className="flex items-center gap-2 rounded-[var(--radius-field)] bg-[var(--surface-muted)] px-2.5 py-1.5">
                      <span className="mono-font min-w-0 flex-1 truncate text-[length:var(--font-caption)] text-[var(--text-secondary)]" title={dir}>{dir}</span>
                      <button
                        type="button"
                        onClick={() => void handleOpenPath(dir)}
                        className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-[var(--radius-field)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
                        title="打开目录"
                      >
                        <FolderOpen className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleRemoveModelDir(dir)}
                        className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-[var(--radius-field)] text-[var(--state-danger)] hover:bg-[var(--state-danger-bg)]"
                        title="移除该目录（不删除文件）"
                      >
                        <FolderX className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* 引擎目录 */}
              {paths ? (
                <DirRow
                  label="引擎目录"
                  description="llama.cpp 版本化内核的安装位置（更新下来的核心放这里）。改动后新装的内核生效，已装内核不会自动搬迁。"
                  value={paths.engine_dir}
                  custom={paths.engine_dir_custom}
                  defaultValue={paths.engine_dir_default}
                  onPick={() => void handlePickDir('engine', '引擎目录')}
                  onReset={() => void handleResetDir('engine', '引擎目录')}
                  onOpen={() => void handleOpenPath(paths.engine_dir)}
                />
              ) : null}

              {/* 日志目录 */}
              {paths ? (
                <DirRow
                  label="日志目录"
                  description="llama-server / NiNfer / Strata 的日志文件根目录（各自再有子目录）。改动后新写入的日志跟随新位置。"
                  value={paths.log_dir}
                  custom={paths.log_dir_custom}
                  defaultValue={paths.log_dir_default}
                  onPick={() => void handlePickDir('log', '日志目录')}
                  onReset={() => void handleResetDir('log', '日志目录')}
                  onOpen={() => void handleOpenPath(paths.log_dir)}
                />
              ) : null}

              {/* 归档目录 */}
              {paths ? (
                <DirRow
                  label="归档聊天记录文件夹"
                  description="导出 / 归档对话时写入的目录。下方「归档全部对话」会把每个会话写成一份 JSON（含 Markdown 正文）。"
                  value={paths.archive_dir}
                  custom={paths.archive_dir_custom}
                  defaultValue={paths.archive_dir_default}
                  onPick={() => void handlePickDir('archive', '归档目录')}
                  onReset={() => void handleResetDir('archive', '归档目录')}
                  onOpen={() => void handleOpenPath(paths.archive_dir)}
                />
              ) : null}

              {/* 自编译内核：从「核心更新」页迁来。它属于数据/路径维护，不属于更新动作。 */}
              <KernelOverrideCard />

              {/* 非桌面运行时（浏览器预览）拿不到后端目录配置：明确说明，而不是静默少三行。 */}
              {!paths && (
                <div className="py-3 text-[length:var(--font-caption)] leading-5 text-[var(--text-tertiary)]">
                  引擎 / 日志 / 归档三类目录需要在桌面版中读取与修改（浏览器预览没有后端配置）。
                </div>
              )}
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] pt-3">
              <button
                type="button"
                onClick={() => void handleArchiveAllSessions()}
                disabled={archiveBusy || chatSessionCount === 0}
                className="flex h-8 items-center gap-1.5 rounded-[var(--radius-field)] border border-[var(--border)] px-2.5 text-[length:var(--font-caption)] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)] disabled:opacity-40"
              >
                <Archive className="h-3.5 w-3.5" />
                {archiveBusy ? '正在归档…' : `归档全部对话（${chatSessionCount}）`}
              </button>
              <button
                type="button"
                onClick={() => void refreshPaths()}
                className="flex h-8 items-center gap-1.5 rounded-[var(--radius-field)] px-2 text-[length:var(--font-caption)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)]"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                刷新
              </button>
              {appDataDir && (
                <button
                  type="button"
                  onClick={() => void handleOpenPath(appDataDir)}
                  className="flex h-8 items-center gap-1.5 rounded-[var(--radius-field)] px-2 text-[length:var(--font-caption)] text-[var(--accent)] transition-colors hover:bg-[var(--accent-subtle)]"
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  打开应用数据目录
                </button>
              )}
            </div>
          </motion.section>

          {/* 二、数据清除 */}
          <motion.section
            initial={false}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-4"
          >
            <div className="mb-2 flex items-center gap-2">
              <Trash2 className="h-4 w-4 text-[var(--state-danger)]" />
              <h2 className="text-[length:var(--font-subtitle)] font-semibold text-[var(--text-primary)]">数据清除</h2>
            </div>
            <div className="mb-3 flex items-start gap-2 rounded-[var(--radius-field)] border border-[var(--state-danger)]/25 bg-[var(--state-danger)]/8 px-3 py-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-[var(--state-danger)]" />
              <p className="text-[length:var(--font-caption)] leading-5 text-[var(--text-secondary)]">
                以下操作会删除本地数据且<span className="font-medium text-[var(--text-primary)]">无法恢复</span>。
                模型文件、内核与日志文件不会被删除。
              </p>
            </div>

            <div className="divide-y divide-[var(--border-subtle)]">
              <SettingRow
                label="对话历史"
                description={chatSessionCount > 0 ? `当前 ${chatSessionCount} 个会话、${chatMessageCount} 条消息，全部存放在本机。` : '暂无本地对话记录。'}
              >
                <button
                  type="button"
                  onClick={() => setPendingDataAction('clear-chat-history')}
                  disabled={chatSessionCount === 0}
                  className="flex h-8 items-center rounded-[var(--radius-field)] px-2.5 text-[length:var(--font-caption)] font-medium text-[var(--state-danger)] transition-colors hover:bg-[var(--state-danger-bg)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  清空历史
                </button>
              </SettingRow>
              <SettingRow label="使用统计" description="按模型累计的 token、耗时与速度，含 NiNfer / Strata 引擎用量。清零不改动任何运行参数。">
                <button
                  type="button"
                  onClick={() => setPendingDataAction('clear-usage')}
                  className="flex h-8 items-center rounded-[var(--radius-field)] px-2.5 text-[length:var(--font-caption)] font-medium text-[var(--state-danger)] transition-colors hover:bg-[var(--state-danger-bg)]"
                >
                  清零统计
                </button>
              </SettingRow>
              <SettingRow label="模型扫描缓存" description="GGUF 元数据解析结果；清除后下次进入模型页会重新解析。">
                <button
                  type="button"
                  onClick={() => setPendingDataAction('clear-model-cache')}
                  className="flex h-8 items-center rounded-[var(--radius-field)] px-2.5 text-[length:var(--font-caption)] font-medium text-[var(--state-danger)] transition-colors hover:bg-[var(--state-danger-bg)]"
                >
                  清除缓存
                </button>
              </SettingRow>
              <SettingRow label="界面偏好" description="主题、强调色、毛玻璃、动画、快捷键、排序、列数与侧边栏宽度恢复出厂值。">
                <button
                  type="button"
                  onClick={() => setPendingDataAction('reset-ui-prefs')}
                  className="flex h-8 items-center rounded-[var(--radius-field)] px-2.5 text-[length:var(--font-caption)] font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent-subtle)]"
                >
                  恢复默认
                </button>
              </SettingRow>
              <SettingRow label="应用配置" description="config.json 恢复默认（含模型目录、三个可配置目录、端口、对外 API Key）。">
                <button
                  type="button"
                  onClick={() => setPendingDataAction('reset-app-config')}
                  className="flex h-8 items-center rounded-[var(--radius-field)] px-2.5 text-[length:var(--font-caption)] font-medium text-[var(--state-danger)] transition-colors hover:bg-[var(--state-danger-bg)]"
                >
                  重置配置
                </button>
              </SettingRow>
              <SettingRow label="出厂重置" description="清除上述全部本地数据并刷新应用。不可恢复，仅在排错无果时使用。">
                <button
                  type="button"
                  onClick={() => setPendingDataAction('factory-reset')}
                  className="flex h-8 items-center gap-1 rounded-[var(--radius-field)] bg-[var(--state-danger)]/10 px-2.5 text-[length:var(--font-caption)] font-medium text-[var(--state-danger)] transition-colors hover:bg-[var(--state-danger)]/18"
                >
                  <AlertTriangle className="h-3.5 w-3.5" />
                  出厂重置
                </button>
              </SettingRow>
            </div>

            {dataMessage && (
              <p className="mt-3 break-words text-[length:var(--font-caption)] leading-5 text-[var(--text-secondary)]" role="status">{dataMessage}</p>
            )}
          </motion.section>
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

/**
 * 自编译内核：指定一个自己编译的 llama-server.exe 覆盖随包内核。
 *
 * 之前放在「核心更新」页，和「更新」混在一起容易让人以为它是更新目标；
 * 它其实是路径配置，归数据管理更合适。保存后 `process_manager` 解析可执行文件时
 * 会优先用它，直到「恢复内置」清掉。
 */
function KernelOverrideCard() {
  const [path, setPath] = useState('');
  const [draft, setDraft] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    void getKernelOverridePath()
      .then((value) => {
        const next = value ?? '';
        setPath(next);
        setDraft(next);
      })
      .catch(() => undefined);
  }, []);

  const handleBrowse = async () => {
    try {
      const picked = await pickKernelExe();
      if (picked) setDraft(picked);
    } catch (error) {
      setMessage(String(error instanceof Error ? error.message : error));
    }
  };

  const handleSave = async () => {
    const value = draft.trim();
    setBusy(true);
    setMessage(null);
    try {
      await setKernelOverridePath(value || null);
      setPath(value);
      setMessage(value ? '已启用自编译内核。' : '已恢复内置内核。');
    } catch (error) {
      setMessage(`保存失败：${String(error instanceof Error ? error.message : error)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleClear = async () => {
    setDraft('');
    setBusy(true);
    setMessage(null);
    try {
      await setKernelOverridePath(null);
      setPath('');
      setMessage('已恢复内置内核。');
    } catch (error) {
      setMessage(`恢复失败：${String(error instanceof Error ? error.message : error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-t border-[var(--border-subtle)] pt-3">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <div className="text-sm text-primary-custom">自编译内核</div>
          <div className="mt-0.5 text-xs text-secondary-custom">
            指定自己编译的 llama-server.exe；留空则使用随包内核。
          </div>
        </div>
        <span
          className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[length:var(--font-micro)] ${
            path ? 'bg-[var(--accent)]/12 text-[var(--accent)]' : 'bg-[var(--surface-muted)] text-[var(--text-secondary)]'
          }`}
        >
          {path ? '已启用' : '未启用'}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="例如 D:\\build\\llama.cpp\\llama-server.exe"
          className="mono-font h-9 min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--app-bg)] px-3 text-xs text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--accent)] dark:border-white/[0.08] dark:bg-black/20"
          aria-label="自编译内核路径"
        />
        <button
          type="button"
          onClick={() => void handleBrowse()}
          className="h-9 rounded-md border border-[var(--border)] px-3 text-xs text-[var(--text-primary)] transition-colors hover:border-[var(--accent)]"
        >
          浏览
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void handleSave()}
          className="h-9 rounded-md bg-[var(--accent)] px-3 text-xs font-medium text-[var(--text-on-accent)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-60"
        >
          保存
        </button>
        {path ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleClear()}
            className="h-9 rounded-md border border-[var(--border)] px-3 text-xs text-[var(--text-primary)] transition-colors hover:border-[var(--state-danger)] disabled:opacity-60"
          >
            恢复内置
          </button>
        ) : null}
      </div>

      {message ? (
        <p className="mt-1.5 break-words text-[length:var(--font-eyebrow)] text-[var(--text-secondary)]">{message}</p>
      ) : null}
    </div>
  );
}
