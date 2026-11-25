import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ExternalLink,
  FileText,
  Folder,
  FolderUp,
  Globe2,
  Loader2,
  Play,
  SquareTerminal,
  X,
} from 'lucide-react';
import { useApp } from '@/context/AppContext';
import {
  piReadArtifact,
  workspaceListDir,
  workspaceOpenPath,
  workspaceRunCommand,
  type PiArtifactPayload,
  type WorkspaceCommandOutput,
  type WorkspaceEntry,
} from '@/lib/ipc/pi';
import { canvasGetConfig, canvasOpenWindow, type CanvasConfig } from '@/lib/ipc/canvas';
import { formatFileSize } from '@/features/chat/chatUtils';

/**
 * 对话右侧的工作展示区：文件预览 / 终端 / 内置浏览器 / 画布 / 对话参数。
 *
 * 工作区模式下，文件与终端都被限制在当前 Agent 工作区（真实本地文件夹）里；
 * Office 文件不在内置编辑器里硬改——用系统 Office 打开，或把任务交给 Pi
 * （docx / xlsx / pptx 技能会用 Python 脚本修改并回写）。
 */

type WorkTab = 'files' | 'terminal' | 'browser' | 'canvas' | 'settings';

const TABS: Array<{ id: WorkTab; label: string }> = [
  { id: 'files', label: '文件' },
  { id: 'terminal', label: '终端' },
  { id: 'browser', label: '浏览器' },
  { id: 'canvas', label: '画布' },
  { id: 'settings', label: '参数' },
];

const OFFICE_EXTENSIONS = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp']);

function fileExtension(name: string) {
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index + 1).toLowerCase() : '';
}

export default function ChatWorkPanel({
  workspacePath,
  workspaceName,
  onClose,
  settingsContent,
  initialTab,
}: {
  workspacePath?: string;
  workspaceName?: string;
  onClose: () => void;
  settingsContent: ReactNode;
  /** 外部直达的 tab（侧边栏「文件 / 浏览器」按钮）：变化时切过去。 */
  initialTab?: WorkTab;
}) {
  const { dispatch } = useApp();
  const [tab, setTab] = useState<WorkTab>(initialTab ?? (workspacePath ? 'files' : 'settings'));
  const [cwd, setCwd] = useState('.');
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [filesBusy, setFilesBusy] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ entry: WorkspaceEntry; payload: PiArtifactPayload } | null>(null);
  const [command, setCommand] = useState('');
  const [terminalBusy, setTerminalBusy] = useState(false);
  const [terminalHistory, setTerminalHistory] = useState<Array<{ command: string; result: WorkspaceCommandOutput }>>([]);
  const [browserUrl, setBrowserUrl] = useState('http://127.0.0.1:8080');
  const [canvasConfig, setCanvasConfig] = useState<CanvasConfig | null>(null);

  const loadEntries = useCallback(async (relPath: string) => {
    if (!workspacePath) return;
    setFilesBusy(true);
    setFileError(null);
    try {
      setEntries(await workspaceListDir(workspacePath, relPath));
      setCwd(relPath);
      setPreview(null);
    } catch (reason) {
      setFileError(reason instanceof Error ? reason.message : String(reason));
      setEntries([]);
    } finally {
      setFilesBusy(false);
    }
  }, [workspacePath]);

  useEffect(() => {
    void loadEntries('.');
  }, [loadEntries]);

  useEffect(() => {
    void canvasGetConfig().then(setCanvasConfig).catch(() => undefined);
  }, []);

  // 侧边栏直达按钮：外部指定 tab 时切换（含重复点同一个按钮再次拉起面板）。
  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);

  const openEntry = async (entry: WorkspaceEntry) => {
    if (!workspacePath) return;
    if (entry.kind === 'dir') {
      void loadEntries(entry.relPath);
      return;
    }
    setFileError(null);
    if (OFFICE_EXTENSIONS.has(fileExtension(entry.name))) {
      // Office 二进制不读成文本，直接给「系统打开 / 交给 Pi」两条路。
      setPreview({
        entry,
        payload: { kind: 'text', mimeType: 'application/octet-stream', size: entry.size, text: '' },
      });
      return;
    }
    try {
      const payload = await piReadArtifact(entry.relPath, workspacePath);
      if (!payload) throw new Error('无法读取文件');
      setPreview({ entry, payload });
    } catch (reason) {
      setFileError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const openWithSystem = async (entry: WorkspaceEntry) => {
    if (!workspacePath) return;
    try {
      await workspaceOpenPath(workspacePath, entry.relPath);
    } catch (reason) {
      setFileError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const askPiToModify = (entry: WorkspaceEntry) => {
    dispatch({
      type: 'SET_PI_PROMPT_DRAFT',
      payload: `请修改工作区里的文件「${entry.relPath}」：先读取确认内容和结构，再按我的要求修改并回写。要求：`,
    });
    onClose();
  };

  const runCommand = async () => {
    if (!workspacePath || !command.trim() || terminalBusy) return;
    setTerminalBusy(true);
    try {
      const result = await workspaceRunCommand(workspacePath, command);
      if (result) {
        setTerminalHistory((prev) => [{ command, result }, ...prev].slice(0, 20));
      }
      setCommand('');
    } catch (reason) {
      setTerminalHistory((prev) => [{
        command,
        result: {
          output: reason instanceof Error ? reason.message : String(reason),
          exitCode: -1,
          timedOut: false,
          truncated: false,
          elapsedMs: 0,
        },
      }, ...prev].slice(0, 20));
      setCommand('');
    } finally {
      setTerminalBusy(false);
    }
  };

  const breadcrumb = useMemo(() => {
    if (cwd === '.' || !cwd) return [] as string[];
    return cwd.split('/').filter(Boolean);
  }, [cwd]);

  const canvasUrl = canvasConfig ? `http://127.0.0.1:${canvasConfig.canvas_port}` : '';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-[length:var(--font-subtitle)] font-semibold tracking-[var(--tracking-tight)] text-[var(--text-primary)]">
            工作区
          </h2>
          <p className="mt-0.5 truncate text-[length:var(--font-caption)] text-[var(--text-secondary)]" title={workspacePath}>
            {workspaceName ?? '未选择工作区'}
          </p>
        </div>
        <button
          onClick={onClose}
          aria-label="关闭工作区"
          title="关闭工作区"
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[var(--radius-field)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--border)] dark:hover:bg-white/[0.08]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mb-2 flex flex-shrink-0 gap-1 rounded-[var(--radius-field)] border border-[var(--border)] p-0.5">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={`min-w-0 flex-1 rounded-[var(--radius-sm)] px-1.5 py-1 text-[length:var(--font-micro)] font-medium transition-colors ${
              tab === item.id
                ? 'bg-[var(--accent-subtle)] text-[var(--accent)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === 'settings' ? (
          <div className="h-full overflow-y-auto">{settingsContent}</div>
        ) : !workspacePath ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-[length:var(--font-caption)] leading-relaxed text-[var(--text-tertiary)]">
            切到 Agent 的 Pi 工作区，并在左侧选择一个本地文件夹后，这里才能读写文件、执行命令。
          </div>
        ) : tab === 'files' ? (
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex flex-shrink-0 items-center gap-1 border-b border-[var(--border-subtle)] pb-1.5">
              <button
                type="button"
                disabled={cwd === '.'}
                onClick={() => void loadEntries(cwd.split('/').slice(0, -1).join('/') || '.')}
                className="grid h-6 w-6 place-items-center rounded text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] disabled:opacity-40"
                title="上一级"
              >
                <FolderUp className="h-3.5 w-3.5" />
              </button>
              <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--font-micro)] text-[var(--text-tertiary)]">
                /{breadcrumb.join('/') || ''}
              </span>
              <button
                type="button"
                onClick={() => void loadEntries('.')}
                className="text-[length:var(--font-micro)] text-[var(--accent)] hover:underline"
              >
                根目录
              </button>
            </div>
            {fileError ? (
              <p className="mt-2 rounded border border-[var(--state-danger-border)] px-2 py-1 text-[length:var(--font-micro)] leading-relaxed text-[var(--state-danger)]">
                {fileError}
              </p>
            ) : null}
            <div className="min-h-0 flex-1 overflow-y-auto py-1">
              {filesBusy ? (
                <p className="py-6 text-center text-[length:var(--font-caption)] text-[var(--text-tertiary)]">
                  <Loader2 className="mx-auto mb-1 h-4 w-4 animate-spin" />
                  读取中…
                </p>
              ) : entries.length === 0 ? (
                <p className="py-6 text-center text-[length:var(--font-caption)] text-[var(--text-tertiary)]">空目录</p>
              ) : (
                entries.map((entry) => (
                  <button
                    key={entry.relPath}
                    type="button"
                    onClick={() => void openEntry(entry)}
                    className="flex w-full min-w-0 items-center gap-2 rounded-[var(--radius-field)] px-2 py-1.5 text-left transition-colors hover:bg-[var(--surface-muted)] dark:hover:bg-white/[0.06]"
                  >
                    {entry.kind === 'dir'
                      ? <Folder className="h-3.5 w-3.5 flex-shrink-0 text-[var(--accent)]" />
                      : <FileText className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-tertiary)]" />}
                    <span className="min-w-0 flex-1 truncate text-[length:var(--font-caption)] text-[var(--text-primary)]">{entry.name}</span>
                    <span className="flex-shrink-0 text-[length:var(--font-micro)] text-[var(--text-tertiary)]">
                      {entry.kind === 'dir' ? '目录' : formatFileSize(entry.size)}
                    </span>
                  </button>
                ))
              )}
            </div>

            {preview ? (
              <div className="flex max-h-[55%] min-h-0 flex-col border-t border-[var(--border)] pt-2">
                <div className="flex flex-shrink-0 items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-[length:var(--font-caption)] font-medium text-[var(--text-primary)]" title={preview.entry.relPath}>
                    {preview.entry.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => void openWithSystem(preview.entry)}
                    className="flex-shrink-0 rounded px-1.5 py-0.5 text-[length:var(--font-micro)] text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]"
                    title="用系统默认程序打开"
                  >
                    <ExternalLink className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => askPiToModify(preview.entry)}
                    className="flex-shrink-0 rounded px-1.5 py-0.5 text-[length:var(--font-micro)] text-[var(--accent)] hover:bg-[var(--accent-subtle)]"
                  >
                    交给 Pi
                  </button>
                </div>
                <div className="mt-1 min-h-0 flex-1 overflow-auto rounded border border-[var(--border-subtle)] bg-[var(--app-bg)]">
                  {preview.payload.kind === 'image' && preview.payload.dataUrl ? (
                    <img src={preview.payload.dataUrl} alt={preview.entry.name} className="max-h-full max-w-full object-contain" />
                  ) : preview.payload.kind === 'pdf' && preview.payload.dataUrl ? (
                    <iframe title={preview.entry.name} src={preview.payload.dataUrl} className="h-64 w-full" />
                  ) : OFFICE_EXTENSIONS.has(fileExtension(preview.entry.name)) ? (
                    <div className="space-y-2 p-3 text-[length:var(--font-caption)] leading-relaxed text-[var(--text-secondary)]">
                      <p>Office 文件不在内置编辑器里直接改，避免破坏格式。</p>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => void openWithSystem(preview.entry)}
                          className="rounded bg-[var(--accent)] px-2 py-1 text-[length:var(--font-micro)] font-semibold text-[var(--text-on-accent)]"
                        >
                          用系统 Office 打开
                        </button>
                        <button
                          type="button"
                          onClick={() => askPiToModify(preview.entry)}
                          className="rounded border border-[var(--border)] px-2 py-1 text-[length:var(--font-micro)] text-[var(--text-secondary)]"
                        >
                          让 Pi 修改
                        </button>
                      </div>
                    </div>
                  ) : (
                    <pre className="whitespace-pre-wrap break-words p-2 text-[length:var(--font-micro)] leading-relaxed text-[var(--text-secondary)]">
                      {preview.payload.text ?? '（空）'}
                    </pre>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        ) : tab === 'terminal' ? (
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex flex-shrink-0 items-center gap-1.5 rounded-t border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-2 py-1">
              <SquareTerminal className="h-3.5 w-3.5 text-[var(--accent)]" />
              <span className="truncate font-mono text-[length:var(--font-micro)] text-[var(--text-tertiary)]">PowerShell · {workspaceName}</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto rounded-b border border-t-0 border-[var(--border-subtle)] bg-[var(--app-bg)] p-2">
              {terminalHistory.length === 0 ? (
                <p className="text-[length:var(--font-micro)] leading-relaxed text-[var(--text-tertiary)]">
                  在工作区目录里执行命令。输出会保留最近 20 条；命令与 Pi 的工具调用互不影响。
                </p>
              ) : (
                terminalHistory.map((item, index) => (
                  <div key={`${item.command}-${index}`} className="mb-2">
                    <div className="break-all font-mono text-[length:var(--font-micro)] text-[var(--accent)]">PS&gt; {item.command}</div>
                    <pre className={`mt-0.5 whitespace-pre-wrap break-words font-mono text-[length:var(--font-micro)] leading-relaxed ${
                      item.result.exitCode === 0 ? 'text-[var(--text-secondary)]' : 'text-[var(--state-danger)]'
                    }`}>
                      {item.result.output || (item.result.timedOut ? '（超时）' : '（无输出）')}
                    </pre>
                  </div>
                ))
              )}
            </div>
            <div className="mt-1.5 flex flex-shrink-0 items-center gap-1.5">
              <input
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void runCommand();
                }}
                placeholder="输入命令，Enter 执行"
                className="min-w-0 flex-1 rounded-[var(--radius-field)] border border-[var(--border)] bg-[var(--app-bg)] px-2 py-1.5 font-mono text-[length:var(--font-micro)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              />
              <button
                type="button"
                onClick={() => void runCommand()}
                disabled={terminalBusy || !command.trim()}
                className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-[var(--radius-field)] bg-[var(--accent)] text-[var(--text-on-accent)] disabled:opacity-50"
                title="执行"
              >
                {terminalBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
        ) : tab === 'browser' ? (
          <div className="flex h-full min-h-0 flex-col">
            <div className="mb-1.5 flex flex-shrink-0 items-center gap-1.5">
              <Globe2 className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-tertiary)]" />
              <input
                value={browserUrl}
                onChange={(event) => setBrowserUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') setBrowserUrl((value) => value.trim());
                }}
                className="min-w-0 flex-1 rounded-[var(--radius-field)] border border-[var(--border)] bg-[var(--app-bg)] px-2 py-1.5 text-[length:var(--font-micro)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                placeholder="http://127.0.0.1:8080"
              />
            </div>
            <iframe
              title="内置浏览器"
              src={browserUrl}
              className="min-h-0 flex-1 rounded border border-[var(--border-subtle)] bg-white"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
            />
            <p className="mt-1 flex-shrink-0 text-[length:var(--font-micro)] leading-relaxed text-[var(--text-tertiary)]">
              部分站点会拒绝被内嵌（X-Frame-Options / CSP）；本机服务一般可正常显示。
            </p>
          </div>
        ) : (
          <div className="flex h-full min-h-0 flex-col">
            <div className="mb-1.5 flex flex-shrink-0 items-center justify-between gap-2">
              <span className="truncate font-mono text-[length:var(--font-micro)] text-[var(--text-tertiary)]">{canvasUrl || '画布未配置'}</span>
              <button
                type="button"
                onClick={() => void canvasOpenWindow().catch(() => undefined)}
                className="flex-shrink-0 rounded border border-[var(--border)] px-2 py-0.5 text-[length:var(--font-micro)] text-[var(--text-secondary)]"
              >
                独立窗口
              </button>
            </div>
            {canvasUrl ? (
              <iframe
                title="无限画布"
                src={canvasUrl}
                className="min-h-0 flex-1 rounded border border-[var(--border-subtle)] bg-white"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
              />
            ) : (
              <div className="flex flex-1 items-center justify-center text-[length:var(--font-caption)] text-[var(--text-tertiary)]">
                先在 Agent 的画布页启动画布。
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
