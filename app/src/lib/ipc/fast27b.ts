import { invoke } from '@tauri-apps/api/core';
import { isDesktopRuntime } from '../desktopRuntime';

/**
 * fast27b 引擎（三元量化 Bonsai-2-27B 离线包）启动通道的 IPC 传输层。
 */

export type Fast27bModelVariant = 'heretic' | 'swift';

export interface Fast27bModelPreset {
  id: Fast27bModelVariant;
  label: string;
  model_path: string;
  exists: boolean;
  spec: string;
}

/** fast27b 运行状态（后端 runtime_status + 配置快照 + DLC 资源检测）。 */
export interface Fast27bStatus {
  running: boolean;
  /** 「可对话」：进程存活 + /v1/models 在线 + 引擎日志未报失效。 */
  api_ready: boolean;
  /** /v1/models 探活通过（接口在线；worker 崩溃后仍可能为 true，不可单独当判活依据）。 */
  api_reachable: boolean;
  /** 引擎日志判定为失效（worker_crash / requests_failing / over_pool）。 */
  degraded: boolean;
  /** 失效中文原因（含处置建议）。 */
  degraded_reason: string | null;
  /** 故障码：worker_crash / requests_failing / over_pool。 */
  fault_kind: string | null;
  /** 是否必须重启引擎才能恢复。 */
  requires_restart: boolean;
  /** 触发失效的引擎日志原始行（证据，英文原文）。 */
  raw_fault_line: string | null;
  /** 失效发生时刻（HH:MM:SS）。 */
  fault_at: string | null;
  /** 致命失效之后的成功请求数（>0 = 读数存疑）。 */
  completions_after_fault: number;
  /** 设备 KV 池 token 数（引擎启动行读数）。 */
  device_pool_tokens: number | null;
  /** 设备 KV 池页数（每页 64 token）。 */
  device_pool_pages: number | null;
  /** 设备池取值来源：auto / explicit。 */
  capacity_configured: string | null;
  /** 最近一次超池的题面 token 数。 */
  over_pool_prompt_tokens: number | null;
  /** 最近一次超池时的设备池 token 数。 */
  over_pool_pool_tokens: number | null;
  port: number | null;
  lan: boolean | null;
  model_id: string | null;
  pid: number | null;
  /** 是否启用该 DLC。 */
  enabled: boolean;
  engine_path: string;
  model_path: string;
  selected_model: Fast27bModelVariant;
  model_presets: Fast27bModelPreset[];
  /** 引擎文件是否存在（DLC 就绪检测）。 */
  engine_exists: boolean;
  /** 模型文件是否存在（DLC 就绪检测）。 */
  model_exists: boolean;
  api_key: string;
  context_window: number;
  draft_tokens: number;
  /** 引擎默认输出上限（--default-max-tokens）；0 = 未设，由引擎自身默认决定。 */
  default_max_tokens: number;
  /** 官方 webui 同源桥端口（配置）。 */
  bridge_port: number;
  auto_open_dsh_web: boolean;
  /** 当前 dsh 绑定（仅当指向 fast27b 端口时返回）。 */
  dsh_bound_model: string | null;
  /** dsh Web 地址。 */
  dsh_web_url: string;
}

/** fast27b 配置段（保存用）。 */
export interface Fast27bConfig {
  /** 是否启用该 DLC。 */
  enabled: boolean;
  engine_path: string;
  model_path: string;
  selected_model: Fast27bModelVariant;
  swift_model_path: string;
  heretic_model_path: string;
  port: number;
  lan: boolean;
  api_key: string;
  context_window: number;
  draft_tokens: number;
  /** 引擎默认输出上限（--default-max-tokens）；0 = 不传该参数，交回引擎自身默认。 */
  default_max_tokens: number;
  /** 官方 llama.cpp webui 同源桥端口（浏览器打开 fast27b 网页界面用；占用时自动顺延）。 */
  bridge_port: number;
  auto_open_dsh_web: boolean;
}

/** 同源桥信息：url 是浏览器里打开官方 webui 的地址。 */
export interface WebuiBridgeInfo {
  url: string;
  port: number;
  upstream_port: number;
}

export interface Fast27bBindResult {
  model_id: string;
  base_url: string;
  provider: string;
}

/** 起（或复用）fast27b 的官方 webui 同源桥。 */
export async function fast27bBridgeEnsure() {
  if (!isDesktopRuntime()) return null;
  return invoke<WebuiBridgeInfo>('fast27b_bridge_ensure');
}

/** 桥的运行状态（未起返回 null）。 */
export async function fast27bBridgeStatus() {
  if (!isDesktopRuntime()) return null;
  return invoke<WebuiBridgeInfo | null>('fast27b_bridge_status');
}

/** 停掉桥。 */
export async function fast27bBridgeStop() {
  if (!isDesktopRuntime()) return;
  await invoke('fast27b_bridge_stop');
}

export async function fast27bGetStatus() {
  if (!isDesktopRuntime()) return null;
  return invoke<Fast27bStatus>('fast27b_get_status');
}

export async function fast27bStart() {
  if (!isDesktopRuntime()) return;
  await invoke('fast27b_start');
}

/**
 * 重启 fast27b 引擎（引擎已失效时的恢复手段：worker 崩溃 / 连续 503 时唯一能恢复的操作）。
 * 同一套 argv 重新拉起，并回收同引擎路径的遗留实例（否则端口被占住起不来）。
 */
export async function fast27bRestart() {
  if (!isDesktopRuntime()) return;
  await invoke('fast27b_restart');
}

export async function fast27bStop() {
  if (!isDesktopRuntime()) return;
  await invoke('fast27b_stop');
}

export async function fast27bGetLogs() {
  if (!isDesktopRuntime()) return [];
  return invoke<string[]>('fast27b_get_logs');
}

export async function fast27bClearLogs() {
  if (!isDesktopRuntime()) return;
  await invoke('fast27b_clear_logs');
}

export async function fast27bSaveConfig(config: Fast27bConfig) {
  if (!isDesktopRuntime()) return;
  await invoke('fast27b_save_config', { config });
}

/** 只切换 fast27b DLC 的启用开关（不触碰其他配置项）。 */
export async function fast27bSetEnabled(enabled: boolean) {
  if (!isDesktopRuntime()) return;
  await invoke('fast27b_set_enabled', { enabled });
}

/** 把 fast27b 引擎一键接入 dsh（写入 provider 并设为默认模型）。 */
export async function fast27bBindDsh() {
  if (!isDesktopRuntime()) return null;
  return invoke<Fast27bBindResult>('fast27b_bind_dsh');
}

/** 解除 fast27b 的 dsh 绑定（与 llama 绑定共用同一提供方槽位）。 */
export async function fast27bUnbindDsh() {
  if (!isDesktopRuntime()) return;
  await invoke('fast27b_unbind_dsh');
}
