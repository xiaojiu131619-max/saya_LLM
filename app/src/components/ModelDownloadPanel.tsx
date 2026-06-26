import { useEffect, useMemo, useState } from 'react';
import { Download, ExternalLink, FolderOpen, Link2, Loader2, Search, X } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import {
  addDesktopModelDir,
  downloadDesktopModel,
  isDesktopRuntime,
  listenDesktopEvent,
  openExternalUrl,
  pickModelDirectory,
  scanDesktopModels,
  toFrontendModel,
  type ModelDownloadProgress,
} from '@/lib/desktop';

const HF_MIRROR_BASE = 'https://hf-mirror.com';
const HF_MODEL_SEARCH_URL = `${HF_MIRROR_BASE}/models?search=GGUF`;

function cleanRepoId(value: string) {
  return value
    .trim()
    .replace(/^https?:\/\/(?:www\.)?(?:huggingface\.co|hf-mirror\.com)\//i, '')
    .replace(/^models\//i, '')
    .replace(/^\/+|\/+$/g, '');
}

function encodePath(value: string) {
  return value
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function normalizeDownloadUrl(rawUrl: string, repoId: string, fileName: string) {
  const direct = rawUrl.trim();
  if (direct) {
    try {
      const url = new URL(direct);
      if (url.hostname === 'huggingface.co' || url.hostname.endsWith('.huggingface.co')) {
        url.hostname = 'hf-mirror.com';
      }
      return url.toString();
    } catch {
      return direct;
    }
  }

  const repo = cleanRepoId(repoId);
  const file = fileName.trim().replace(/^\/+/, '');
  if (!repo || !file) return '';
  return `${HF_MIRROR_BASE}/${encodePath(repo)}/resolve/main/${encodePath(file)}?download=true`;
}

function inferFileName(rawUrl: string, fileName: string) {
  const explicit = fileName.trim();
  if (explicit) return explicit.split('/').pop() ?? explicit;
  try {
    const url = new URL(rawUrl.trim());
    const last = url.pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : '';
  } catch {
    return '';
  }
}

function formatBytes(bytes?: number | null) {
  if (!bytes || bytes <= 0) return '未知大小';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index >= 3 ? 2 : 1)} ${units[index]}`;
}

export default function ModelDownloadPanel() {
  const { state, dispatch } = useApp();
  const [expanded, setExpanded] = useState(false);
  const [repoId, setRepoId] = useState('Qwen/Qwen2.5-7B-Instruct-GGUF');
  const [fileName, setFileName] = useState('');
  const [directUrl, setDirectUrl] = useState('');
  const [targetDir, setTargetDir] = useState('');
  const [isDownloading, setIsDownloading] = useState(false);
  const [progress, setProgress] = useState<ModelDownloadProgress | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!targetDir && state.modelDirs[0]) {
      setTargetDir(state.modelDirs[0]);
    }
  }, [state.modelDirs, targetDir]);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    void listenDesktopEvent<ModelDownloadProgress>('model-download:progress', (payload) => {
      setProgress(payload);
      setMessage(payload.message);
    }).then((unlisten) => {
      dispose = unlisten;
    });
    return () => dispose?.();
  }, []);

  const downloadUrl = useMemo(
    () => normalizeDownloadUrl(directUrl, repoId, fileName),
    [directUrl, repoId, fileName]
  );
  const resolvedFileName = useMemo(
    () => inferFileName(downloadUrl, fileName),
    [downloadUrl, fileName]
  );
  const canDownload = Boolean(downloadUrl.trim()) && !isDownloading;
  const percent = Math.max(0, Math.min(100, Number(progress?.percent ?? 0)));

  const chooseTargetDir = async () => {
    if (!isDesktopRuntime()) {
      setMessage('请在桌面版中选择模型目录。');
      return null;
    }
    const selected = await pickModelDirectory();
    if (!selected) return null;
    const dirs = await addDesktopModelDir(selected);
    dispatch({ type: 'SET_MODEL_DIRS', payload: dirs });
    setTargetDir(selected);
    return selected;
  };

  const refreshModels = async () => {
    const models = await scanDesktopModels(true);
    dispatch({ type: 'UPSERT_MODELS', payload: models.map(toFrontendModel) });
    dispatch({
      type: 'SET_APP_STATUS',
      payload: models.length > 0 ? `已发现 ${models.length} 个本地 GGUF 模型。` : '模型目录里暂未发现 GGUF 文件。',
    });
  };

  const handleDownload = async () => {
    if (!isDesktopRuntime()) {
      setMessage('模型联网下载需要在桌面版中使用。');
      return;
    }

    const url = downloadUrl.trim();
    if (!url) {
      setMessage('请填写模型链接或仓库信息。');
      return;
    }

    let dir = targetDir || state.modelDirs[0] || '';
    if (!dir) {
      const selected = await chooseTargetDir();
      if (!selected) return;
      dir = selected;
    }

    setIsDownloading(true);
    setProgress(null);
    setMessage('正在准备下载...');
    dispatch({ type: 'SET_APP_STATUS', payload: '正在下载 GGUF 模型...' });

    try {
      const result = await downloadDesktopModel({
        url,
        fileName: resolvedFileName || undefined,
        targetDir: dir,
      });
      setMessage(`下载完成：${result.file_name}`);
      dispatch({ type: 'SET_APP_STATUS', payload: `模型下载完成：${result.file_name}` });
      await refreshModels();
    } catch (error) {
      const text = String(error instanceof Error ? error.message : error);
      setMessage(`下载失败：${text}`);
      dispatch({ type: 'SET_APP_STATUS', payload: `模型下载失败：${text}` });
    } finally {
      setIsDownloading(false);
    }
  };

  const handleOpenMirror = () => {
    void openExternalUrl(HF_MODEL_SEARCH_URL).catch((error) => {
      setMessage(`打开 HF 镜像站失败：${String(error)}`);
    });
  };

  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-40 flex max-w-[calc(100vw-40px)] justify-end">
      {expanded ? (
        <div
          key="download-panel"
          className="anim-panel-in pointer-events-auto w-[min(420px,calc(100vw-40px))] rounded-md border border-[#DCD8CF] bg-[#FBFAF6]/95 p-3 shadow-[0_18px_48px_rgba(61,53,42,0.18)] backdrop-blur-md dark:border-white/[0.1] dark:bg-[#1E1B17]/95"
        >
            <div className="mb-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-base font-semibold text-[#2F2C26] dark:text-[#F3EBDD]">
                  <Download className="h-4 w-4 text-[#D06646]" />
                  下载模型
                </div>
                <div className="mt-1 truncate text-xs text-[#7D766B] dark:text-[#A9A095]">
                  HF 镜像站 · GGUF
                </div>
              </div>
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md border border-[#DCD8CF] bg-[#FAF9F5] text-[#7D766B] hover:bg-[#F1EEE7] dark:border-white/[0.08] dark:bg-white/[0.06]"
                title="收起"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="grid gap-2">
              <button
                type="button"
                onClick={handleOpenMirror}
                className="flex h-9 items-center justify-center gap-2 rounded-md border border-[#DCD8CF] bg-[#F8F6F1] px-3 text-sm font-medium text-[#2F2C26] hover:bg-[#F1EEE7] dark:border-white/[0.08] dark:bg-white/[0.06] dark:text-[#F3EBDD]"
              >
                <ExternalLink className="h-4 w-4 text-[#D06646]" />
                打开 HF 镜像站
              </button>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(120px,0.65fr)]">
                <label className="min-w-0">
                  <span className="mb-1 block text-xs text-[#7D766B] dark:text-[#A9A095]">仓库</span>
                  <input
                    value={repoId}
                    onChange={(event) => setRepoId(event.target.value)}
                    disabled={Boolean(directUrl.trim()) || isDownloading}
                    className="h-9 w-full rounded-md border border-[#DCD8CF] bg-white/80 px-2.5 text-sm text-[#2F2C26] outline-none placeholder:text-[#A09A90] focus:border-[#D06646] disabled:opacity-55 dark:border-white/[0.08] dark:bg-black/20 dark:text-[#F3EBDD]"
                    placeholder="组织/模型仓库"
                  />
                </label>
                <label className="min-w-0">
                  <span className="mb-1 block text-xs text-[#7D766B] dark:text-[#A9A095]">文件</span>
                  <input
                    value={fileName}
                    onChange={(event) => setFileName(event.target.value)}
                    disabled={isDownloading}
                    className="h-9 w-full rounded-md border border-[#DCD8CF] bg-white/80 px-2.5 text-sm text-[#2F2C26] outline-none placeholder:text-[#A09A90] focus:border-[#D06646] disabled:opacity-55 dark:border-white/[0.08] dark:bg-black/20 dark:text-[#F3EBDD]"
                    placeholder="*.gguf"
                  />
                </label>
              </div>

              <label className="min-w-0">
                <span className="mb-1 block text-xs text-[#7D766B] dark:text-[#A9A095]">直链</span>
                <div className="flex min-w-0 items-center gap-2 rounded-md border border-[#DCD8CF] bg-white/80 px-2.5 dark:border-white/[0.08] dark:bg-black/20">
                  <Link2 className="h-4 w-4 flex-shrink-0 text-[#8B8275]" />
                  <input
                    value={directUrl}
                    onChange={(event) => setDirectUrl(event.target.value)}
                    disabled={isDownloading}
                    className="h-9 min-w-0 flex-1 bg-transparent text-sm text-[#2F2C26] outline-none placeholder:text-[#A09A90] disabled:opacity-55 dark:text-[#F3EBDD]"
                    placeholder="https://hf-mirror.com/.../resolve/main/model.gguf"
                  />
                </div>
              </label>

              <div className="flex min-w-0 items-center gap-2">
                <div className="min-w-0 flex-1 rounded-md border border-[#E4E0D8] bg-[#FAF9F5] px-2.5 py-2 text-xs text-[#7D766B] dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[#A9A095]">
                  <div className="truncate">{targetDir || '未选择模型目录'}</div>
                </div>
                <button
                  type="button"
                  onClick={() => void chooseTargetDir()}
                  disabled={isDownloading}
                  className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md border border-[#DCD8CF] bg-[#FAF9F5] text-[#7D766B] hover:bg-[#F1EEE7] disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.06]"
                  title="选择目录"
                >
                  <FolderOpen className="h-4 w-4" />
                </button>
              </div>

              {(progress || message) && (
                <div className="rounded-md border border-[#E4E0D8] bg-[#FAF9F5] px-2.5 py-2 text-xs text-[#7D766B] dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[#A9A095]">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">{message ?? progress?.message}</span>
                    <span className="mono-font flex-shrink-0">
                      {progress?.totalBytes ? `${percent.toFixed(0)}%` : formatBytes(progress?.downloadedBytes)}
                    </span>
                  </div>
                  {progress?.totalBytes && (
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#E6E1D8] dark:bg-white/[0.08]">
                      <div
                        className="h-full rounded-full bg-[#D06646]"
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                  )}
                </div>
              )}

              <button
                type="button"
                onClick={() => void handleDownload()}
                disabled={!canDownload}
                className="flex h-10 items-center justify-center gap-2 rounded-md bg-[#D06646] px-3 text-sm font-semibold text-white hover:bg-[#BE593A] disabled:cursor-not-allowed disabled:opacity-55"
              >
                {isDownloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                {isDownloading ? '下载中' : '开始下载'}
              </button>
            </div>
        </div>
      ) : (
        <button
          key="download-button"
          type="button"
          onClick={() => setExpanded(true)}
          className="anim-fade-rise hover-rise pointer-events-auto flex h-12 items-center gap-2 rounded-md border border-[#DCD8CF] bg-[#FBFAF6]/95 px-4 text-sm font-semibold text-[#2F2C26] shadow-[0_12px_32px_rgba(61,53,42,0.18)] backdrop-blur-md hover:border-[#D06646]/40 dark:border-white/[0.1] dark:bg-[#1E1B17]/95 dark:text-[#F3EBDD]"
        >
          <Search className="h-4 w-4 text-[#D06646]" />
          下载模型
        </button>
      )}
    </div>
  );
}
