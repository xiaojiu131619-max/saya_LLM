import { invoke } from '@tauri-apps/api/core';
import { isDesktopRuntime } from '../desktopRuntime';

/**
 * dsh（DeepSeek Harness）智能体接入的 IPC 传输层（v0.4，Agent 页）。
 */

/** Agent 页环境检测项（与首启检测同构，复用后端 EnvCheckItem）。 */
export interface DshEnvCheckItem {
  id: string;
  level: 'ok' | 'warning' | 'error';
  title: string;
  detail: string;
  install_hint: string | null;
  install_url: string | null;
  in_app_action: string | null;
}

export interface DshNodeInfo {
  source: 'system' | 'managed' | 'none';
  version: string | null;
  path: string | null;
}

export interface DshPackageInfo {
  installed: boolean;
  version: string | null;
  bin_path: string | null;
}

export interface DshRuntimeStatus {
  running: boolean;
  web_url: string | null;
  pid: number | null;
}

export interface DshInstallStatus {
  node: DshNodeInfo;
  package: DshPackageInfo;
  home_dir: string;
  packages_dir: string;
  web_url: string;
  runtime: DshRuntimeStatus;
  /** 已绑定的本地模型 id（settings.yaml 实读）。 */
  bound_model: string | null;
  /** 已绑定的 llama-server 端点（含 /v1）。 */
  bound_base_url: string | null;
}

export interface DshBindResult {
  model_id: string;
  base_url: string;
  provider: string;
}

export async function dshEnvCheck() {
  if (!isDesktopRuntime()) return [];
  return invoke<DshEnvCheckItem[]>('dsh_env_check');
}

export async function dshGetStatus() {
  if (!isDesktopRuntime()) return null;
  return invoke<DshInstallStatus>('dsh_get_status');
}

export async function dshInstallNode() {
  if (!isDesktopRuntime()) return '';
  return invoke<string>('dsh_install_node');
}

export async function dshInstallPackage() {
  if (!isDesktopRuntime()) return '';
  return invoke<string>('dsh_install_package');
}

export async function dshUninstall() {
  if (!isDesktopRuntime()) return;
  await invoke('dsh_uninstall');
}

export async function dshCancelInstall() {
  if (!isDesktopRuntime()) return;
  await invoke('dsh_cancel_install');
}

export async function dshRevealDir(kind: 'home' | 'packages' | 'runtimes') {
  if (!isDesktopRuntime()) return;
  await invoke('dsh_reveal_dir', { kind });
}

export async function dshStart() {
  if (!isDesktopRuntime()) return;
  await invoke('dsh_start');
}

export async function dshStop() {
  if (!isDesktopRuntime()) return;
  await invoke('dsh_stop');
}

export async function dshGetLogs() {
  if (!isDesktopRuntime()) return [];
  return invoke<string[]>('dsh_get_logs');
}

export async function dshClearLogs() {
  if (!isDesktopRuntime()) return;
  await invoke('dsh_clear_logs');
}

/** 把当前加载的本地模型一键接入 dsh（写入 provider 并设为默认模型）。 */
export async function dshBindModel() {
  if (!isDesktopRuntime()) return null;
  return invoke<DshBindResult>('dsh_bind_model');
}

/** 解除接入（移除本应用的提供方与默认模型设置）。 */
export async function dshUnbindModel() {
  if (!isDesktopRuntime()) return;
  await invoke('dsh_unbind_model');
}

/** dsh 数据清理：sessions = 会话记录；store = pnpm 安装仓库缓存。 */
export async function dshCleanupData(kind: 'sessions' | 'store') {
  if (!isDesktopRuntime()) return null;
  return invoke<string>('dsh_cleanup_data', { kind });
}
