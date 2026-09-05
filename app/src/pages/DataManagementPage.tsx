import { useState } from 'react';
import { motion } from 'framer-motion';
import {
  AlertTriangle,
  Database,
  FolderOpen,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useApp } from '@/context/AppContext';
import ConfirmDialog from '@/components/ConfirmDialog';
import { SettingRow } from '@/components/SettingSection';
import PageHeader from '@/components/PageHeader';
import {
  clearDesktopModelCache,
  dshCleanupData,
  getDesktopAppDataDir,
  isDesktopRuntime,
  resetDesktopAppConfig,
  revealDesktopPath,
  stopDesktopServer,
} from '@/lib/desktop';

// 「数据管理」中可执行的清除动作种类。
type DataActionKind =
  | 'clear-frontend-state'
  | 'clear-model-cache'
  | 'clear-dsh-sessions'
  | 'clear-dsh-store'
  | 'reset-app-config'
  | 'factory-reset';

// 前端本地持久化的 localStorage key 清单：与 AppContext 中的常量保持一致。
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

export default function DataManagementPage() {
  const { state, dispatch } = useApp();
  // 当前要弹出确认对话框的清除类型；null 表示对话框关闭。
  const [pendingDataAction, setPendingDataAction] = useState<DataActionKind | null>(null);
  const [dataMessage, setDataMessage] = useState<string | null>(null);

  // 单项清除前端本地状态（localStorage）。完成后刷新页面以重新挂载默认状态。
  const handleClearFrontendState = async () => {
    clearFrontendLocalStorage();
    setDataMessage('已清除前端界面状态，应用即将刷新...');
    // 给用户一帧时间看到提示，再 reload。
    window.setTimeout(() => {
      window.location.reload();
    }, 200);
  };

  // 清除 GGUF 模型扫描缓存（…\AgentLLM\cache）。
  const handleClearModelCache = async () => {
    if (!isDesktopRuntime()) {
      setDataMessage('请在 Tauri 桌面版中清除模型扫描缓存。');
      return;
    }
    const result = await clearDesktopModelCache();
    setDataMessage(result || '模型扫描缓存已清除。下次进入模型页将重新扫描。');
  };

  // 重置后端配置 + 撤销对外 API Key + 刷新前端状态以反映默认值。
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

  // 一键出厂重置——把上面所有清除项都执行一遍。
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

  // 在系统文件管理器中打开 AppData\Roaming\AgentLLM 目录。
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

  // 根据当前 pendingDataAction 派发实际清除动作。
  const runPendingDataAction = async () => {
    switch (pendingDataAction) {
      case 'clear-frontend-state':
        await handleClearFrontendState();
        break;
      case 'clear-model-cache':
        await handleClearModelCache();
        break;
      case 'clear-dsh-sessions':
      case 'clear-dsh-store': {
        const kind = pendingDataAction === 'clear-dsh-sessions' ? 'sessions' : 'store';
        try {
          const message = await dshCleanupData(kind);
          setDataMessage(message ?? '清理完成。');
        } catch (error) {
          setDataMessage(`清理失败：${String(error)}`);
        }
        break;
      }
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

  // 弹窗配置表。把每种清除动作的标题、说明、清单、按钮文字、二次输入码集中在这里维护。
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
    'clear-dsh-sessions': {
      title: '清除 dsh 会话记录',
      description: '删除智能体（dsh）的历史会话数据。dsh 的设置、模型接入与凭据不受影响。',
      bullets: [
        'dsh 的全部历史会话与轨迹（dsh-home\\sessions）',
      ],
      footnote: 'dsh 正在运行时无法清理；模型接入配置（settings.yaml）不会被删除。',
      confirmLabel: '清除会话',
      tone: 'warning',
    },
    'clear-dsh-store': {
      title: '清理 dsh 安装仓库缓存',
      description: '删除安装 dsh 时的 pnpm 下载缓存（约 270 MB），释放磁盘空间。',
      bullets: [
        'pnpm 内容寻址缓存（AppData\\Roaming\\AgentLLM\\dsh\\pnpm-store）',
      ],
      footnote: '已安装的 dsh 本体不受影响；下次「重装 dsh」时需要重新下载。',
      confirmLabel: '清理缓存',
      tone: 'warning',
    },
    'reset-app-config': {
      title: '重置应用配置',
      description: '此操作会停止本地 llama-server 并把应用配置恢复为出厂默认值。',
      bullets: [
        '清空模型目录列表（不会删除目录中的模型文件）',
        '清空所有模型的预设参数（ngl、ctx、KV 等）与调参历史',
        '把端口、对外 API 开关、主题等恢复默认值',
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

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto mb-6 max-w-2xl">
          <PageHeader
            icon={Database}
            title="数据管理"
            description="备份、清除与重置本软件保存的本地数据；操作不可恢复的项都会先二次确认。"
          />
        </div>

        <div className="mx-auto max-w-2xl pb-12">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.05, ease: [0.16, 1, 0.3, 1] }}
            className="border-b border-[var(--border-subtle)] py-5"
          >
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
                label="清除 dsh 会话记录"
                description="删除智能体（dsh）的历史会话数据；dsh 设置与模型接入不受影响。"
              >
                <button
                  onClick={() => setPendingDataAction('clear-dsh-sessions')}
                  className="flex items-center gap-1 text-sm text-[var(--state-danger)] hover:underline"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  清除
                </button>
              </SettingRow>

              <div className="border-t border-[var(--border-subtle)]" />
              <SettingRow
                label="清理 dsh 安装仓库缓存"
                description="删除安装 dsh 时的 pnpm 下载缓存（约 270 MB）；已安装的 dsh 本体不受影响。"
              >
                <button
                  onClick={() => setPendingDataAction('clear-dsh-store')}
                  className="flex items-center gap-1 text-sm text-[var(--state-danger)] hover:underline"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  清理
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
