import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { isDesktopRuntime } from '../desktopRuntime';

/**
 * 「数据管理」的目录配置 IPC 传输层。
 *
 * 三个可编辑目录（引擎 / 日志 / 归档）与模型目录一样，实际生效值由后端
 * 全局镜像决定；这里只负责读写与系统目录选择框，不做路径推导。
 */

/** 可配置目录的种类，与后端 `set_storage_dir` 的 kind 参数对应。 */
export type StorageDirKind = 'engine' | 'log' | 'archive';

/** 当前生效的目录快照（含默认位置，供「恢复默认」展示）。 */
export interface StoragePaths {
  app_data_dir: string;
  model_dirs: string[];
  engine_dir: string;
  engine_dir_custom: boolean;
  log_dir: string;
  log_dir_custom: boolean;
  archive_dir: string;
  archive_dir_custom: boolean;
  engine_dir_default: string;
  log_dir_default: string;
  archive_dir_default: string;
}

export async function getStoragePaths(): Promise<StoragePaths | null> {
  if (!isDesktopRuntime()) return null;
  return invoke<StoragePaths>('get_storage_paths');
}

/** 保存某个目录；path 传 null 表示恢复默认位置。 */
export async function setStorageDir(kind: StorageDirKind, path: string | null) {
  if (!isDesktopRuntime()) return;
  await invoke('set_storage_dir', { kind, path });
}

/** 弹出系统目录选择框；取消返回 null。 */
export async function pickStorageDirectory(title: string) {
  if (!isDesktopRuntime()) return null;
  const selected = await open({ multiple: false, directory: true, title });
  return typeof selected === 'string' ? selected : null;
}

/** 把会话归档写进归档目录，返回落盘路径。 */
export async function writeArchiveFile(fileName: string, content: string) {
  if (!isDesktopRuntime()) return null;
  return invoke<string>('write_archive_file', { fileName, content });
}
