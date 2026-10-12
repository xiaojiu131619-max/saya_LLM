import { invoke } from '@tauri-apps/api/core';
import { isDesktopRuntime } from '../desktopRuntime';

/**
 * 内核（llama.cpp）版本管理 / 引擎检测 / ffmpeg 安装的 IPC 传输层。
 */

export interface DesktopEngineInfo {
  binary_exists: boolean;
  cuda_graphs_enabled: boolean;
  cuda_version: string | null;
  cuda_matched: boolean;
  sm_architecture: string | null;
  llama_server_version: string | null;
  exe_path: string;
  runtime_devices?: string[];
  runtime_backend?: string | null;
  host_backend?: string | null;
  gpu_name?: string | null;
}

export interface LlamaReleaseInfo {
  tag_name: string;
  version: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
    size: number;
    backend: string;
    matches_host: boolean;
  }>;
  body: string;
  published_at: string;
  cuda_version: string | null;
  cuda_matched: boolean;
  host_backend: string;
  gpu_name: string | null;
  /** 本机 AMD 独显是否在 ROCm/HIP 官方支持列表内（无 AMD 卡为 false）。 */
  hip_capable: boolean;
  /** 本机 AMD 显卡名（有 AMD 卡才非空；配合 hip_capable 区分「支持 / 未验证」）。 */
  hip_gpu: string | null;
}

export interface InstalledKernelInfo {
  name: string;
  version: string;
  installed_at: string;
  is_active: boolean;
}

export async function checkDesktopEngine(executablePath = 'resources/llama-server.exe') {
  if (!isDesktopRuntime()) return null;
  return invoke<DesktopEngineInfo>('check_engine_info', { exePath: executablePath });
}

export async function listRecentLlamaReleases(count = 8) {
  if (!isDesktopRuntime()) return [];
  return invoke<LlamaReleaseInfo[]>('list_recent_releases', { count });
}

export async function listInstalledKernels() {
  if (!isDesktopRuntime()) return [];
  return invoke<InstalledKernelInfo[]>('list_installed_kernels');
}

export async function updateLlamaKernel(url: string, version: string, useMirror = true, mirrorUrl?: string) {
  if (!isDesktopRuntime()) return '';
  return invoke<string>('download_and_update', { url, version, useMirror, mirrorUrl });
}

export async function cancelKernelUpdate() {
  await invoke('cancel_kernel_update');
}

/**
 * 下载并安装 ffmpeg / ffprobe 到应用 resources 目录。
 * 部署到该目录后，对话服务与向量服务都能直接找到它们（原生视频处理）。
 * 进度通过 `ffmpeg:progress` 事件上报。
 */
export async function installFfmpeg(useMirror = true) {
  if (!isDesktopRuntime()) return '';
  return invoke<string>('install_ffmpeg', { useMirror });
}

export async function cancelFfmpegInstall() {
  if (!isDesktopRuntime()) return;
  await invoke('cancel_ffmpeg_install');
}
