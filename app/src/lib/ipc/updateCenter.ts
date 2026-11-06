import { invoke } from '@tauri-apps/api/core';

import { isDesktopRuntime } from '../desktopRuntime';
import { listenDesktopEvent } from './system';

/**
 * 核心更新中心的 IPC 传输层。
 *
 * 后端把「该不该更新、该装哪个架构的包」都算好了，前端只负责展示与触发；
 * 不再有下载源、版本选择这类开关——只提供最新发行版。
 */

export type UpdateComponentId = 'pi' | 'llama' | 'strata' | 'ninfer' | 'ffmpeg';

export interface ComponentUpdate {
  id: UpdateComponentId;
  name: string;
  installedVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  /** 本机是否已安装（有版本戳，或在配置目录里找到可执行文件）。 */
  installed: boolean;
  /** 本机硬件是否支持（NiNfer 只支持 NVIDIA）。 */
  applicable: boolean;
  /** 人话说明：按哪张卡选了哪个包 / 为什么不可用。 */
  applicability: string;
  running: boolean;
  port: number | null;
  message: string | null;
}

export interface UpdateCenterProgress {
  component: string;
  message: string;
}

export async function updateCenterCheck(): Promise<ComponentUpdate[]> {
  if (!isDesktopRuntime()) return [];
  return invoke<ComponentUpdate[]>('update_center_check');
}

export async function updateCenterInstall(component: UpdateComponentId): Promise<string> {
  if (!isDesktopRuntime()) return '';
  return invoke<string>('update_center_install', { component });
}

export async function updateCenterCancel(): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invoke('update_center_cancel');
}

/** 读取 Windows 系统代理；未启用或读不到返回 null。 */
export async function detectSystemProxy(): Promise<string | null> {
  if (!isDesktopRuntime()) return null;
  return invoke<string | null>('detect_system_proxy');
}

export function onUpdateCenterProgress(
  callback: (payload: UpdateCenterProgress) => void,
) {
  return listenDesktopEvent<UpdateCenterProgress>('update-center:progress', callback);
}

/** 检查过程中逐个组件回传结果，界面可以边等边渲染。 */
export function onUpdateCenterComponent(
  callback: (payload: ComponentUpdate) => void,
) {
  return listenDesktopEvent<ComponentUpdate>('update-center:component', callback);
}
