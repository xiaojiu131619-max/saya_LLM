import { useEffect, useRef, useState } from 'react';
import { Check, Download, Square } from 'lucide-react';
import {
  cancelFfmpegInstall,
  checkVideoRuntime,
  installFfmpeg,
  isDesktopRuntime,
  listenDesktopEvent,
  type VideoRuntimeInfo,
} from '@/lib/desktop';

/**
 * 把进度消息里的下载百分比抽出来，用于进度条；非下载阶段返回 null。
 * 与核心更新页同一口径（后端 `download_with_progress` 输出 `下载中: N% (...)`）。
 */
function parseProgressPercent(message: string | null) {
  if (!message) return null;
  const match = message.match(/下载中:\s*([\d.]+)%/);
  return match ? Number(match[1]) : null;
}

interface FfmpegInstallButtonProps {
  /** 安装成功后回调（供调用方重新检测环境/刷新状态）。 */
  onInstalled?: (version: string) => void;
  /** 紧凑模式：只渲染按钮 + 单行状态，适合放进列表项。 */
  compact?: boolean;
  /** 安装成功的提示文案（compact 模式下也以单行显示）。 */
  successMessage?: string;
}

/**
 * ffmpeg / ffprobe 一键安装按钮（可复用）。
 *
 * 下载 BtbN 静态 win64 构建并安装到应用 resources 目录 —— 装好后对话服务
 * （原生视频理解）与向量服务（图片/视频向量）都会自动找到它们。
 * 组件自带「已就绪」「下载中（可取消）」「安装完成」三态，安装后主动重新检测。
 */
export default function FfmpegInstallButton({
  onInstalled,
  compact = false,
  successMessage = 'ffmpeg 与 ffprobe 已安装，原生视频处理已可用。',
}: FfmpegInstallButtonProps) {
  const [runtime, setRuntime] = useState<VideoRuntimeInfo | null>(null);
  const [installing, setInstalling] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [doneMessage, setDoneMessage] = useState<string | null>(null);
  // 卸载/重挂时避免对已离开的组件 setState。
  const mountedRef = useRef(true);

  const refresh = async () => {
    const info = await checkVideoRuntime().catch(() => null);
    if (mountedRef.current) setRuntime(info);
  };

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const ready = Boolean(runtime?.native_video_ready);

  const handleInstall = async () => {
    if (!isDesktopRuntime() || installing) return;
    setInstalling(true);
    setDoneMessage(null);
    setMessage('正在准备下载 ffmpeg...');
    const unlisten = await listenDesktopEvent<{ message: string }>('ffmpeg:progress', (payload) => {
      if (mountedRef.current) setMessage(payload.message);
    });
    try {
      const result = await installFfmpeg(true);
      if (mountedRef.current) {
        setMessage(null);
        setDoneMessage(result || successMessage);
      }
      const info = await checkVideoRuntime().catch(() => null);
      if (mountedRef.current) setRuntime(info);
      if (info?.native_video_ready) onInstalled?.(info.ffmpeg_path ?? '');
    } catch (error) {
      const text = String(error);
      if (mountedRef.current) {
        setMessage(text.includes('取消') ? '安装已取消。' : `安装失败：${text}`);
      }
      await refresh();
    } finally {
      unlisten();
      if (mountedRef.current) setInstalling(false);
    }
  };

  const handleCancel = async () => {
    try {
      await cancelFfmpegInstall();
      setMessage('正在取消安装...');
    } catch (error) {
      setMessage(`取消失败：${String(error)}`);
    }
  };

  const progressPercent = parseProgressPercent(message);

  // 已就绪：显示版本信息 + 重新检测入口（compact 模式只显示一行状态）。
  if (ready && !installing) {
    return (
      <div className={compact ? 'flex items-center gap-2 text-xs' : 'space-y-1.5'}>
        <span className="inline-flex items-center gap-1.5 text-xs text-[var(--state-success)]">
          <Check className="h-3.5 w-3.5" />
          已安装
        </span>
        {!compact && (
          <p className="break-all font-mono text-xs leading-5 text-secondary-custom">
            {runtime?.ffmpeg_path ?? 'ffmpeg / ffprobe 已就绪'}
          </p>
        )}
        {doneMessage && <p className="text-xs text-[var(--state-success)]">{doneMessage}</p>}
      </div>
    );
  }

  return (
    <div className={compact ? 'flex items-center gap-2' : 'space-y-2'}>
      {installing ? (
        <button
          type="button"
          onClick={() => void handleCancel()}
          className="flex min-h-8 flex-shrink-0 items-center gap-1 rounded-md px-2 text-xs text-[var(--state-danger)] hover:bg-[var(--state-danger-border)] dark:hover:bg-[var(--surface-raised)]"
        >
          <Square className="h-3 w-3" />
          停止下载
        </button>
      ) : (
        <button
          type="button"
          onClick={() => void handleInstall()}
          className="flex min-h-8 flex-shrink-0 items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 text-xs font-medium text-white transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40"
        >
          <Download className="h-3.5 w-3.5" />
          一键安装 ffmpeg
        </button>
      )}

      {installing && (
        <div className="min-w-0 flex-1">
          <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--border)] dark:bg-white/10">
            <div
              className="h-full rounded-full bg-[var(--accent)] transition-all duration-300"
              style={{ width: `${progressPercent ?? 5}%` }}
            />
          </div>
          {!compact && (
            <p className="mt-1.5 truncate font-mono text-xs text-secondary-custom">
              {message ?? '正在下载...'}
            </p>
          )}
        </div>
      )}

      {!installing && message && (
        <span className="min-w-0 truncate text-xs text-secondary-custom" title={message}>
          {message}
        </span>
      )}
      {!installing && doneMessage && (
        <span className="min-w-0 text-xs text-[var(--state-success)]">{doneMessage}</span>
      )}
    </div>
  );
}
