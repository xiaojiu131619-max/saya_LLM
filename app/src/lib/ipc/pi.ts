import { invoke } from '@tauri-apps/api/core';
import { isDesktopRuntime } from '../desktopRuntime';
import type { PiFileChange } from '@/types';
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
  /** 显式工作区目录：非空时直接作为 Pi 沙箱与当前目录（Chat 选中的工作区）。 */
  workspaceDir?: string;
  /** 模型上下文窗口（写进 models.json）；缺省 32768。 */
  contextWindow?: number;
}

export interface PiSkillLink {
  /** 对方技能名。 */
  name: string;
  /** complement（配套）/ depends（依赖）/ delegate（委托）。 */
  kind: string;
  /** outbound（from 方）/ inbound（to 方）。 */
  direction: string;
  note?: string;
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
  /** 技能树分类路径（如 ["媒体生成","图像"]）；未收录时为空。 */
  categoryPath?: string[];
  /** 顶层分支声明序（_tree.json 顺序）；未收录为很大数，UI 据此给分支排序。 */
  categoryOrder?: number;
  /** 关联技能（_tree.json 的 links，双向展开）。 */
  related?: PiSkillLink[];
}

export interface PiSelectedSkill {
  name: string;
  description: string;
  tools: string[];
  score: number;
  kind?: string;
  body: string;
  categoryPath?: string[];
}

export interface PiSkillSelection {
  skills: PiSelectedSkill[];
  context: string;
  /** 两级路由晋级的顶层分支名；未启用（无 _tree.json）时为空。 */
  branches?: string[];
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

/** 聚焦主窗口：浮窗的权限提示用「回到主界面」按钮直接跳到确认弹窗。 */
export async function piFocusMainWindow() {
  if (!isDesktopRuntime()) return;
  await invoke('show_main_window');
}

export async function piAgentStart(options: PiAgentStartOptions) {
  if (!isDesktopRuntime()) return null;
  return invoke<PiAgentStatus>('pi_agent_start', { options });
}

export interface PiImageInput {
  type: 'image';
  /** base64（不含 data URL 前缀）。 */
  data: string;
  mimeType: string;
}

export async function piAgentRun(
  prompt: string,
  skillContext?: string,
  images?: PiImageInput[],
) {
  if (!isDesktopRuntime()) return null;
  return invoke<string>('pi_agent_run', {
    prompt,
    skillContext: skillContext?.trim() ? skillContext : null,
    images: images && images.length > 0 ? images : null,
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

/** 手动触发 Pi 原生上下文压缩。 */
export async function piAgentCompact(customInstructions?: string) {
  if (!isDesktopRuntime()) return;
  await invoke('pi_agent_compact', {
    customInstructions: customInstructions?.trim() ? customInstructions : null,
  });
}

/** 检查点回滚结果摘要（后端 RollbackSummary）。 */
export interface PiRollbackSummary {
  changeSetId: string;
  restored: number;
  removed: number;
  skipped: string[];
}

/**
 * 把一组文件恢复到 Pi 改动之前的原状。只在用户二次确认后调用。
 * 注意与 piAgentRollback（Pi npm 安装回滚）无关。
 */
export async function piChangesRollback(changeSetId: string, paths: string[]): Promise<PiRollbackSummary> {
  if (!isDesktopRuntime()) throw new Error('检查点回滚只在桌面版可用。');
  return invoke<PiRollbackSummary>('pi_changes_rollback', { changeSetId, paths });
}

/** 工作区文件树的一项。 */
export interface WorkspaceEntry {
  name: string;
  relPath: string;
  kind: 'dir' | 'file';
  size: number;
  modified: number;
}

export interface WorkspaceCommandOutput {
  output: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
  elapsedMs: number;
}

export async function workspaceListDir(workDir: string, relPath = '.') {
  if (!isDesktopRuntime()) return [] as WorkspaceEntry[];
  return invoke<WorkspaceEntry[]>('workspace_list_dir', {
    workDir,
    relPath: relPath.trim() || '.',
  });
}

export async function workspaceRunCommand(workDir: string, command: string, timeout = 60) {
  if (!isDesktopRuntime()) return null;
  return invoke<WorkspaceCommandOutput>('workspace_run_command', {
    workDir,
    command,
    timeout,
  });
}

export async function workspaceOpenPath(workDir: string, relPath: string) {
  if (!isDesktopRuntime()) return;
  await invoke('workspace_open_path', { workDir, relPath });
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

/** 权限请求超时：后端已按「拒绝」处理，前端据此关掉弹窗并说明原因。 */
export interface PiPermissionExpired {
  id: string;
  tool: string;
}

export interface PiAgentSubscriptions {
  onEvent: (payload: PiAgentEventPayload) => void;
  onLog: (payload: PiAgentLogPayload) => void;
  onReady: (status: PiAgentStatus) => void;
  onStopped: (payload: { message?: string }) => void;
  onExit: (payload: { message?: string }) => void;
  onError: (payload: { message?: string }) => void;
  onPermission: (request: PiPermissionRequest) => void;
  onPermissionExpired: (payload: PiPermissionExpired) => void;
  /** write_file / edit_file 每次成功落盘后的一条改动（检查点卡片）。 */
  onFileChanges: (change: PiFileChange) => void;
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
    listenDesktopEvent<PiPermissionExpired>(
      'pi:permission_expired',
      subscriptions.onPermissionExpired,
    ),
    listenDesktopEvent<PiFileChange>('pi:file-changes', subscriptions.onFileChanges),
  ];

  return () => {
    disposers.forEach((disposer) => void disposer.then((dispose) => dispose()));
  };
}

// Pi 事件 → 界面步骤的纯函数在 `lib/piEvents.ts`，这里只保留传输层。
