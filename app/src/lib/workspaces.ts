import { open } from '@tauri-apps/plugin-dialog';
import { isDesktopRuntime } from '@/lib/desktopRuntime';
import type { PiPermissionMode } from '@/lib/ipc/pi';

/**
 * Agent 工作区：一个真实本地文件夹。
 *
 * - 只有工作区文件夹里的文件/命令享有 Pi 的高权限（沙箱边界）；
 * - 每个 Chat 会话绑定一个工作区，切换工作区即切换文件目录；
 * - 权限档随工作区记忆：不同项目可以有不同的放行尺度。
 *
 * 只存元数据，不复制/移动用户文件；目录由用户自己选择。
 */
export interface AgentWorkspace {
  id: string;
  name: string;
  /** 真实本地文件夹绝对路径。 */
  path: string;
  createdAt: number;
  /** 该工作区默认的 Pi 权限档。 */
  permissionMode: PiPermissionMode;
}

const STORAGE_KEY = 'agent-workspaces-v1';
const ACTIVE_KEY = 'agent-active-workspace-v1';
/** 工作区列表变更事件：侧边栏与主界面共享同一份 localStorage。 */
export const AGENT_WORKSPACES_CHANGED = 'agent-workspaces-changed';

function newId() {
  return `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function loadAgentWorkspaces(): AgentWorkspace[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        id: typeof item.id === 'string' ? item.id : newId(),
        name: typeof item.name === 'string' ? item.name : '工作区',
        path: typeof item.path === 'string' ? item.path : '',
        createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
        permissionMode:
          item.permissionMode === 'plan' || item.permissionMode === 'full'
            ? item.permissionMode
            : 'auto' as PiPermissionMode,
      }))
      .filter((item) => item.path.trim().length > 0);
  } catch {
    return [];
  }
}

export function saveAgentWorkspaces(list: AgentWorkspace[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    window.dispatchEvent(new Event(AGENT_WORKSPACES_CHANGED));
  } catch {
    // 配额不足时静默：不影响当前运行
  }
}

export function loadActiveAgentWorkspaceId(): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(ACTIVE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveActiveAgentWorkspaceId(id: string) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    // 忽略
  }
}

/** 用文件夹路径生成一个可读名称（只取最后一级目录）。 */
export function workspaceNameFromPath(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]+/);
  return parts[parts.length - 1] || '工作区';
}

/** 添加一个工作区；同路径已存在时直接返回已有的。 */
export function addAgentWorkspace(path: string, name?: string): AgentWorkspace {
  const trimmed = path.trim();
  const list = loadAgentWorkspaces();
  const existing = list.find(
    (item) => item.path.replace(/[\\/]+$/, '').toLowerCase() === trimmed.replace(/[\\/]+$/, '').toLowerCase(),
  );
  if (existing) return existing;
  const workspace: AgentWorkspace = {
    id: newId(),
    name: name?.trim() || workspaceNameFromPath(trimmed),
    path: trimmed,
    createdAt: Date.now(),
    permissionMode: 'auto',
  };
  saveAgentWorkspaces([workspace, ...list]);
  return workspace;
}

export function updateAgentWorkspace(id: string, patch: Partial<AgentWorkspace>) {
  const list = loadAgentWorkspaces();
  saveAgentWorkspaces(list.map((item) => (item.id === id ? { ...item, ...patch } : item)));
}

export function removeAgentWorkspace(id: string) {
  saveAgentWorkspaces(loadAgentWorkspaces().filter((item) => item.id !== id));
}

/** 弹出系统目录选择框。取消返回 null。 */
export async function pickAgentWorkspaceFolder(): Promise<AgentWorkspace | null> {
  if (!isDesktopRuntime()) return null;
  const selected = await open({ multiple: false, directory: true, title: '选择 Agent 工作区文件夹' });
  if (typeof selected !== 'string' || !selected.trim()) return null;
  return addAgentWorkspace(selected);
}

/**
 * 启动时补一个默认工作区：优先用 Pi 的默认工作目录，
 * 这样开箱即用，不必先让用户挑文件夹。
 */
export function ensureDefaultAgentWorkspace(defaultPath: string): AgentWorkspace | null {
  if (!defaultPath.trim()) return null;
  const list = loadAgentWorkspaces();
  if (list.length > 0) return list[0];
  return addAgentWorkspace(defaultPath, '默认工作区');
}
