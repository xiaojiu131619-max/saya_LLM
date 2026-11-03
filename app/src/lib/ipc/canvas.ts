import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isDesktopRuntime } from '../desktopRuntime';

/**
 * 无限画布模块的 IPC 传输层。
 *
 * 画布是外挂的本地 Web 应用：Rust 侧负责下载/安装画布包、复用托管 Node、
 * 启动网关（8190）与静态服务（3210），前端只做状态展示和控制。
 */

export interface CanvasConfig {
  comfy_url: string;
  comfy_dir: string;
  /** 画布固定端口：项目数据按 origin 保存，不能静默回退。 */
  canvas_port: number;
  gateway_port: number;
  open_in_window: boolean;
}

export interface CanvasNodeStatus {
  source: 'system' | 'managed' | 'missing' | string;
  version: string | null;
  path: string | null;
  ok: boolean;
}

export interface CanvasPackStatus {
  installed: boolean;
  version: string | null;
  dir: string | null;
  source: string | null;
}

export interface CanvasStatus {
  config: CanvasConfig;
  node: CanvasNodeStatus;
  pack: CanvasPackStatus;
  running: boolean;
  canvas_url: string | null;
  gateway_url: string | null;
  canvas_port: number;
  gateway_port: number;
  comfy_url: string;
  comfy_reachable: boolean;
  gateway_ready: boolean;
  canvas_reachable: boolean;
  model_count: number;
  data_dir: string;
  log_path: string;
  error: string | null;
  last_error: string | null;
  logs: string[];
}

export interface CanvasSummary {
  running: boolean;
  pack_installed: boolean;
  node_ok: boolean;
}

export interface CanvasProgress {
  stage: 'node' | 'pack' | string;
  message: string;
}

const DEFAULT_CONFIG: CanvasConfig = {
  comfy_url: 'http://127.0.0.1:8188',
  comfy_dir: '',
  canvas_port: 3210,
  gateway_port: 8190,
  open_in_window: true,
};

export async function canvasGetConfig(): Promise<CanvasConfig> {
  if (!isDesktopRuntime()) return DEFAULT_CONFIG;
  return invoke<CanvasConfig>('canvas_get_config');
}

export async function canvasSaveConfig(config: CanvasConfig): Promise<CanvasConfig> {
  if (!isDesktopRuntime()) return config;
  return invoke<CanvasConfig>('canvas_save_config', { config });
}

export async function canvasGetStatus(): Promise<CanvasStatus | null> {
  if (!isDesktopRuntime()) return null;
  return invoke<CanvasStatus>('canvas_get_status');
}

export async function canvasGetSummary(): Promise<CanvasSummary | null> {
  if (!isDesktopRuntime()) return null;
  return invoke<CanvasSummary>('canvas_get_summary');
}

export async function canvasStart(): Promise<CanvasStatus> {
  if (!isDesktopRuntime()) throw new Error('画布只在桌面版可用。');
  return invoke<CanvasStatus>('canvas_start');
}

export async function canvasStop(): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invoke('canvas_stop');
}

export async function canvasOpenWindow(): Promise<void> {
  if (!isDesktopRuntime()) throw new Error('画布只在桌面版可用。');
  await invoke('canvas_open_window');
}

export async function canvasOpenBrowser(): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invoke('canvas_open_browser');
}

export async function canvasRevealDataDir(): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invoke('canvas_reveal_data_dir');
}

export async function canvasGetLogs(maxLines = 200): Promise<string[]> {
  if (!isDesktopRuntime()) return [];
  return invoke<string[]>('canvas_get_logs', { maxLines });
}

export async function canvasClearLogs(): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invoke('canvas_clear_logs');
}

export async function canvasInstallNode(): Promise<string> {
  if (!isDesktopRuntime()) throw new Error('画布只在桌面版可用。');
  return invoke<string>('canvas_install_node');
}

export async function canvasInstallPackFromZip(path: string): Promise<CanvasPackStatus> {
  if (!isDesktopRuntime()) throw new Error('画布只在桌面版可用。');
  return invoke<CanvasPackStatus>('canvas_install_pack_from_zip', { path });
}

export async function canvasInstallPackFromUrl(url: string, sha256: string): Promise<CanvasPackStatus> {
  if (!isDesktopRuntime()) throw new Error('画布只在桌面版可用。');
  return invoke<CanvasPackStatus>('canvas_install_pack_from_url', { url, sha256 });
}

export async function onCanvasInstallProgress(
  handler: (progress: CanvasProgress) => void,
): Promise<UnlistenFn> {
  if (!isDesktopRuntime()) return () => {};
  return listen<CanvasProgress>('canvas:install-progress', (event) => handler(event.payload));
}

export { DEFAULT_CONFIG as DEFAULT_CANVAS_CONFIG };
