import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isDesktopRuntime } from '../desktopRuntime';

/**
 * 系统日志 / 环境检测 / 对外 API Key / 窗口事件订阅的 IPC 传输层。
 */

export interface SystemLogEntry {
  timestamp: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  category: 'llama' | 'server' | 'api' | 'app';
  message: string;
}

export interface DesktopFileDropEvent {
  type: 'enter' | 'over' | 'drop' | 'leave';
  paths?: string[];
  position?: { x: number; y: number };
}

export interface DesktopVideoRuntimeInfo {
  ffmpeg_available: boolean;
  ffprobe_available: boolean;
  native_video_ready: boolean;
  ffmpeg_path: string | null;
  ffprobe_path: string | null;
}

export interface VideoRuntimeInfo {
  ffmpeg_available: boolean;
  ffprobe_available: boolean;
  native_video_ready: boolean;
  ffmpeg_path?: string | null;
  ffprobe_path?: string | null;
}

// ============================================================
// 首次启动环境检测（镜像后端 commands/env_check.rs）
// ============================================================

export interface DesktopEnvCheckItem {
  id: string;
  /** ok = 通过；warning = 可选组件缺失；error = 必需组件未就绪。 */
  level: 'ok' | 'warning' | 'error';
  title: string;
  detail: string;
  install_hint: string | null;
  install_url: string | null;
  /** kernel-update = 跳转「核心更新」页。 */
  in_app_action: string | null;
}

export async function getDesktopSystemLogs(sinceMs = 0) {
  if (!isDesktopRuntime()) return [];
  return invoke<SystemLogEntry[]>('get_system_logs', { sinceMs });
}

export async function clearDesktopSystemLogs() {
  if (!isDesktopRuntime()) return;
  await invoke('clear_system_logs');
}

// 把应用侧事件汇入后端统一日志中枢。best-effort：失败不影响主流程。
export async function logDesktopEvent(level: SystemLogEntry['level'], category: SystemLogEntry['category'], message: string) {
  if (!isDesktopRuntime()) return;
  try {
    await invoke('log_app_event', { level, category, message });
  } catch {
    // 日志记录失败不应打断业务。
  }
}

export async function runDesktopEnvCheck() {
  if (!isDesktopRuntime()) return [];
  return invoke<DesktopEnvCheckItem[]>('run_env_check');
}

export async function getEnvCheckDone() {
  if (!isDesktopRuntime()) return true;
  return invoke<boolean>('get_env_check_done');
}

/** 关闭检测弹窗时调用：标记已完成，之后启动不再自动弹出。 */
export async function markEnvCheckDone() {
  if (!isDesktopRuntime()) return;
  await invoke('mark_env_check_done');
}

export async function getExternalApiKeyStatus() {
  if (!isDesktopRuntime()) return false;
  return invoke<boolean>('get_external_api_key_status');
}

export async function getExternalApiKeyForSession() {
  if (!isDesktopRuntime()) return null;
  return invoke<string | null>('get_external_api_key_for_session');
}

export async function createExternalApiKey(apiKey: string) {
  if (!isDesktopRuntime()) return;
  await invoke('create_external_api_key', { apiKey });
}

export async function deleteExternalApiKey() {
  if (!isDesktopRuntime()) return;
  await invoke('delete_external_api_key');
}

export async function revealDesktopPath(path: string) {
  if (!isDesktopRuntime()) return;
  await invoke('reveal_path', { path });
}

export async function openExternalUrl(url: string) {
  if (!isDesktopRuntime()) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  await invoke('open_external_url', { url });
}

export async function checkVideoRuntime() {
  if (!isDesktopRuntime()) return null;
  return invoke<VideoRuntimeInfo>('check_video_runtime');
}

export async function getDesktopVideoRuntimeInfo() {
  if (!isDesktopRuntime()) return null;
  return invoke<DesktopVideoRuntimeInfo>('get_video_runtime_info');
}

export function listenDesktopEvent<T>(event: string, callback: (payload: T) => void) {
  if (!isDesktopRuntime()) return Promise.resolve(() => {});
  return listen<T>(event, (message) => callback(message.payload));
}

export function listenDesktopFileDrops(callback: (payload: DesktopFileDropEvent) => void) {
  if (!isDesktopRuntime()) return Promise.resolve(() => {});
  return getCurrentWindow().onDragDropEvent((event) => {
    callback(event.payload as DesktopFileDropEvent);
  });
}
