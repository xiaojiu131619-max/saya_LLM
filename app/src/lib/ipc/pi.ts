import { invoke } from '@tauri-apps/api/core';
import { isDesktopRuntime } from '../desktopRuntime';
import { listenDesktopEvent } from './system';

/**
 * Pi 智能体内核的 RPC 传输层（实验）。
 *
 * 与拾一的 HTTP/SSE 不同，Pi 是宿主拉起的常驻 Node 子进程，
 * stdin/stdout 走 JSONL。这里只暴露「启动 / 发任务 / 取消 / 事件」，
 * 权限与沙箱在下一阶段由宿主代理工具接管。
 */

export type PiPermissionMode = 'plan' | 'auto' | 'full';

export interface PiAgentStatus {
  running: boolean;
  pid: number | null;
  provider: string;
  model: string;
  work_dir: string;
  work_root: string;
  agent_dir: string;
  cli_path: string;
  permission_mode: string;
  session_id: string;
  message: string | null;
}

export interface PiPermissionRequest {
  id: string;
  tool: string;
  title: string;
  detail: string;
  mode: string;
}

export interface PiAgentDiscover {
  node_path: string;
  cli_path: string | null;
  agent_dir: string;
  work_dir: string;
  session_dir: string;
  skills_dir: string | null;
}

export interface PiAgentInstallResult {
  target: string;
  version: string;
  files: number;
  bytes: number;
}

export interface PiNpmVersionInfo {
  version: string;
  integrity: string;
  tarball: string;
}

export interface PiNpmVersionsResult {
  package: string;
  registry: string;
  installedVersion: string | null;
  latest: string;
  versions: PiNpmVersionInfo[];
  rollbackAvailable: boolean;
}

export interface PiRegistryOption {
  id: string;
  label: string;
  url: string;
}

export interface PiVersionLock {
  name: string;
  version: string;
  source: string;
  integrity?: string;
  previousVersion?: string;
  installedAt: number;
}

export interface PiVersionInfo {
  installedVersion: string | null;
  lock: PiVersionLock | null;
  rollbackAvailable: boolean;
  registries: PiRegistryOption[];
}

export interface PiAgentStartOptions {
  nodePath: string;
  cliPath: string;
  agentDir: string;
  workDir: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  permissionMode: PiPermissionMode;
  sessionId: string;
  sessionDir: string;
}

export interface PiSkillMeta {
  name: string;
  description: string;
  triggers: string[];
  notFor: string[];
  tools: string[];
  /** generate / query / delegated / generic。 */
  kind?: string;
  path: string;
  bodyChars: number;
}

export interface PiSelectedSkill {
  name: string;
  description: string;
  tools: string[];
  score: number;
  kind?: string;
  body: string;
}

export interface PiSkillSelection {
  skills: PiSelectedSkill[];
  context: string;
}

/** 会话工作区内按文件名解析出的产物位置。 */
export interface PiResolvedArtifact {
  name: string;
  relPath: string;
  size: number;
  mtime: number;
  exists: boolean;
  duplicate: boolean;
  /** 文件头嗅探出的真实格式（png / jpeg / pdf / zip …）；认不出时为空。 */
  magic?: string;
  /** 扩展名有已知签名且与文件头一致；没有签名要求时保持 true。 */
  magicOk: boolean;
}

/** 读取产物的结果：图片 / PDF 给 data URL，文本给正文。 */
export interface PiArtifactPayload {
  kind: 'image' | 'pdf' | 'text';
  mimeType: string;
  size: number;
  dataUrl?: string;
  text?: string;
}

export interface PiAgentEventPayload {
  runId: string;
  event: Record<string, unknown>;
}

export interface PiAgentLogPayload {
  line: string;
  stream?: string;
}

export async function piAgentDiscover() {
  if (!isDesktopRuntime()) return null;
  return invoke<PiAgentDiscover>('pi_agent_discover');
}

/** 把当前 Pi 运行时复制到应用数据目录，并写版本锁。 */
export async function piAgentInstall(source?: string) {
  if (!isDesktopRuntime()) return null;
  return invoke<PiAgentInstallResult>('pi_agent_install', {
    source: source?.trim() ? source : null,
  });
}

/** 拉取 npm registry 上 Pi 的可安装版本列表。 */
export async function piAgentNpmVersions(registry?: string) {
  if (!isDesktopRuntime()) return null;
  return invoke<PiNpmVersionsResult>('pi_agent_npm_versions', {
    registry: registry?.trim() ? registry : null,
  });
}

/** 从 npm 在线安装 / 升级指定版本的 Pi（含依赖树；npm 做 SRI 校验）。 */
export async function piAgentInstallOnline(
  version: string,
  registry?: string,
  nodePath?: string,
) {
  if (!isDesktopRuntime()) return null;
  return invoke<PiAgentInstallResult>('pi_agent_install_online', {
    version,
    registry: registry?.trim() ? registry : null,
    nodePath: nodePath?.trim() ? nodePath : null,
  });
}

/** 回滚到上一版本（升级时保留的备份）。 */
export async function piAgentRollback() {
  if (!isDesktopRuntime()) return null;
  return invoke<PiAgentInstallResult>('pi_agent_rollback');
}

/** 当前版本锁信息（安装来源、上一版本、回滚可用性、常用 registry）。 */
export async function piAgentVersionInfo() {
  if (!isDesktopRuntime()) return null;
  return invoke<PiVersionInfo>('pi_agent_version_info');
}

export async function piAgentGetStatus() {
  if (!isDesktopRuntime()) return null;
  return invoke<PiAgentStatus>('pi_agent_get_status');
}

/** 打开 / 聚焦 Pi 浮窗（常驻快聊入口；关闭即隐藏）。 */
export async function piFloatWindow() {
  if (!isDesktopRuntime()) return;
  await invoke('pi_float_window');
}

export async function piAgentStart(options: PiAgentStartOptions) {
  if (!isDesktopRuntime()) return null;
  return invoke<PiAgentStatus>('pi_agent_start', { options });
}

export async function piAgentRun(prompt: string, skillContext?: string) {
  if (!isDesktopRuntime()) return null;
  return invoke<string>('pi_agent_run', {
    prompt,
    skillContext: skillContext?.trim() ? skillContext : null,
  });
}

/** 只读技能索引（名称/描述/触发词/工具），用于界面显示数量与排查路由。 */
export async function piAgentSkillsIndex(skillsDir: string) {
  if (!isDesktopRuntime()) return [];
  return invoke<PiSkillMeta[]>('pi_agent_skills_index', { skillsDir });
}

/** 宿主雷达：按任务文本选 1–2 个技能，返回截断后的正文和可直接注入的 context。 */
export async function piAgentSelectSkills(
  skillsDir: string,
  text: string,
  topK = 2,
  maxChars = 8000,
) {
  if (!isDesktopRuntime()) return { skills: [], context: '' } satisfies PiSkillSelection;
  return invoke<PiSkillSelection>('pi_agent_select_skills', {
    skillsDir,
    text,
    topK,
    maxChars,
  });
}

export async function piAgentCancel() {
  if (!isDesktopRuntime()) return;
  await invoke('pi_agent_cancel');
}

/** 在会话工作区内解析产物；workDir 为空时用当前 Pi 会话。 */
export async function piResolveArtifacts(names: string[], workDir?: string) {
  if (!isDesktopRuntime()) return [];
  return invoke<PiResolvedArtifact[]>('pi_resolve_artifacts', {
    names,
    workDir: workDir?.trim() ? workDir : null,
  });
}

/** 读取会话工作区内的单个产物（图片 data URL / 文本正文）。 */
export async function piReadArtifact(relPath: string, workDir?: string) {
  if (!isDesktopRuntime()) return null;
  return invoke<PiArtifactPayload>('pi_read_artifact', {
    relPath,
    workDir: workDir?.trim() ? workDir : null,
  });
}

export async function piAgentStop() {
  if (!isDesktopRuntime()) return;
  await invoke('pi_agent_stop');
}

export async function piAgentGetLogs() {
  if (!isDesktopRuntime()) return [];
  return invoke<string[]>('pi_agent_get_logs');
}

export async function piAgentClearLogs() {
  if (!isDesktopRuntime()) return;
  await invoke('pi_agent_clear_logs');
}

/** 回答当前挂起的权限确认。 */
export async function piAgentPermissionAnswer(id: string, allow: boolean) {
  if (!isDesktopRuntime()) return;
  await invoke('pi_agent_permission_answer', { id, allow });
}

/** 运行中切换权限档。 */
export async function piAgentSetPermissionMode(mode: PiPermissionMode) {
  if (!isDesktopRuntime()) return null;
  return invoke<string>('pi_agent_set_permission_mode', { mode });
}

export interface PiAgentSubscriptions {
  onEvent: (payload: PiAgentEventPayload) => void;
  onLog: (payload: PiAgentLogPayload) => void;
  onReady: (status: PiAgentStatus) => void;
  onStopped: (payload: { message?: string }) => void;
  onExit: (payload: { message?: string }) => void;
  onError: (payload: { message?: string }) => void;
  onPermission: (request: PiPermissionRequest) => void;
}

/** 订阅 Pi 进程的 Tauri 事件。返回一个统一取消订阅的函数。 */
export function subscribePiAgent(subscriptions: PiAgentSubscriptions) {
  if (!isDesktopRuntime()) return () => {};

  const disposers: Array<Promise<() => void>> = [
    listenDesktopEvent<PiAgentEventPayload>('pi:event', subscriptions.onEvent),
    listenDesktopEvent<PiAgentLogPayload>('pi:log', subscriptions.onLog),
    listenDesktopEvent<PiAgentStatus>('pi:ready', subscriptions.onReady),
    listenDesktopEvent<{ message?: string }>('pi:stopped', subscriptions.onStopped),
    listenDesktopEvent<{ message?: string }>('pi:exit', subscriptions.onExit),
    listenDesktopEvent<{ message?: string }>('pi:error', subscriptions.onError),
    listenDesktopEvent<PiPermissionRequest>('pi:permission', subscriptions.onPermission),
  ];

  return () => {
    disposers.forEach((disposer) => void disposer.then((dispose) => dispose()));
  };
}

// Pi 事件 → 界面步骤的纯函数在 `lib/piEvents.ts`，这里只保留传输层。
