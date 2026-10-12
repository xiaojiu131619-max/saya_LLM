import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { Effect, EffectState, getCurrentWindow } from '@tauri-apps/api/window';
import { isDesktopRuntime } from '../desktopRuntime';

/**
 * 配置 / 应用外壳相关的 IPC 传输层。
 *
 * 本文件只做 invoke 包装：判定运行时、调用命令、返回结果。
 * 不放任何领域计算（配置合并、参数推导等一律留在 `lib/desktop`）。
 */

export interface DesktopConfig {
  version: number;
  model_dirs: string[];
  llama_server_path: string;
  default_port: number;
  api_enabled?: boolean;
  api_host?: string;
  api_key?: string | null;
  theme: string;
  refresh_interval: number;
  auto_scan_on_startup: boolean;
  model_presets: Record<string, unknown>;
  tools: string | null;
  last_model_path: string | null;
  tune_history: unknown[];
  close_to_tray: boolean;
  /** 核心更新使用的 HTTP(S) 代理地址；未配置为 null。 */
  proxy_url: string | null;
  /** 首次启动环境检测是否已完成；旧配置文件缺失该字段时视为未完成。 */
  env_check_done?: boolean;
  /** 用户指定的自编译核心路径（llama-server.exe 绝对路径）；未设置为 null。 */
  kernel_override_path?: string | null;
  /** 向量（Embedding）/ 重排模型的独立服务端口；与 default_port 不同才能并行运行。 */
  embedding_port?: number;
}

export interface MediaPayload {
  mime_type: string;
  data_base64: string;
  byte_size: number;
}

/**
 * 读取 Windows 系统的 accent color 与亮/暗主题偏好。
 * 非 Tauri 运行时返回 null，前端可走 matchMedia fallback。
 */
export interface DesktopSystemAppearance {
  accent_color: string;
  apps_use_light_theme: boolean;
  supports_mica: boolean;
}

export async function setDesktopProxyUrl(proxyUrl: string | null) {
  if (!isDesktopRuntime()) return;
  await invoke('set_proxy_url', { proxyUrl });
}

export async function getKernelOverridePath() {
  if (!isDesktopRuntime()) return null;
  return invoke<string | null>('get_kernel_override_path');
}

export async function setKernelOverridePath(path: string | null) {
  if (!isDesktopRuntime()) return;
  await invoke('set_kernel_override_path', { path });
}

/** 弹出系统文件选择框，挑选自编译核心的 llama-server.exe；取消返回 null。 */
export async function pickKernelExe() {
  if (!isDesktopRuntime()) return null;
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: 'llama-server', extensions: ['exe'] }],
  });
  return typeof selected === 'string' ? selected : null;
}

export async function getDesktopConfig() {
  if (!isDesktopRuntime()) return null;
  return invoke<DesktopConfig>('get_config');
}

export async function saveDesktopConfig(config: DesktopConfig) {
  if (!isDesktopRuntime()) return;
  await invoke('save_config', { config });
}

export async function saveDesktopRuntimeSettings(settings: {
  defaultPort?: number;
  embeddingPort?: number;
  apiEnabled?: boolean;
  apiHost?: string;
  closeToTray?: boolean;
}) {
  if (!isDesktopRuntime()) return;
  const config = await getDesktopConfig();
  if (!config) return;
  await saveDesktopConfig({
    ...config,
    ...(settings.defaultPort ? { default_port: settings.defaultPort } : {}),
    ...(settings.embeddingPort ? { embedding_port: settings.embeddingPort } : {}),
    ...(settings.apiEnabled !== undefined ? { api_enabled: settings.apiEnabled } : {}),
    ...(settings.apiHost !== undefined ? { api_host: settings.apiHost } : {}),
    ...(settings.closeToTray !== undefined ? { close_to_tray: settings.closeToTray } : {}),
    api_key: null,
  });
}

export async function setCloseToTray(enabled: boolean) {
  if (!isDesktopRuntime()) return enabled;
  return invoke<boolean>('set_close_to_tray', { enabled });
}

export async function resetDesktopAppConfig() {
  if (!isDesktopRuntime()) return;
  await invoke('reset_app_config');
}

export async function getDesktopAppDataDir() {
  if (!isDesktopRuntime()) return null;
  return invoke<string>('get_app_data_dir');
}

export async function readDesktopFileContent(path: string) {
  if (!isDesktopRuntime()) {
    throw new Error('读取拖拽文件需要在桌面版中使用。');
  }
  return invoke<string>('read_file_content', { path });
}

export async function readDesktopMedia(path: string) {
  if (!isDesktopRuntime()) {
    throw new Error('读取媒体文件需要在桌面版中使用。');
  }
  return invoke<MediaPayload>('read_media_file', { path });
}

export async function getDesktopSystemAppearance(): Promise<DesktopSystemAppearance | null> {
  if (!isDesktopRuntime()) return null;
  try {
    return await invoke<DesktopSystemAppearance>('get_system_appearance');
  } catch {
    return null;
  }
}

/**
 * 切换窗口系统材质。
 * - mica：Win11 默认桌面材质，偏实、颜色变化弱（Win10 上不可用，等于无材质）
 * - acrylic：系统亚克力毛玻璃，能透出壁纸色，同时带系统级模糊
 * - Windows 10 上 Acrylic 可能不可用或无效果，自动回退 Blur（兼容性最好的模糊材质）
 */
export async function setDesktopWindowMaterial(material: 'mica' | 'acrylic') {
  if (!isDesktopRuntime()) return;
  try {
    await getCurrentWindow().setEffects({
      effects: [material === 'acrylic' ? Effect.Acrylic : Effect.Mica],
      state: EffectState.Active,
    });
  } catch (acrylicError) {
    if (material !== 'acrylic') return;
    try {
      await getCurrentWindow().setEffects({
        effects: [Effect.Blur],
        state: EffectState.Active,
      });
    } catch {
      console.error('[window] acrylic/blur 材质均设置失败', acrylicError);
    }
  }
}
