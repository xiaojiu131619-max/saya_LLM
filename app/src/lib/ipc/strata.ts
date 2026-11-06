import { invoke } from '@tauri-apps/api/core';
import { isDesktopRuntime } from '../desktopRuntime';

/**
 * 智慧模型（Strata 引擎）启动通道的 IPC 传输层。
 *
 * 与 fast27b 的关键差异：智慧模型的就绪判据是 `/health` 的 `loaded` 字段，
 * 不是「端口通了」。90GiB 专家权重加载十几分钟，这段时间接口已经在应答，
 * 但发对话会一直挂着——所以界面必须按 `model_loaded` 区分「接口在线」和「可对话」。
 */

/** 智慧模型变体：S（Gyro-S）与 M（Gyro-M）。 */
export type StrataModelVariant = 's' | 'm';

/** 变体及其 run config 状态。 */
export interface StrataModelPreset {
  id: StrataModelVariant;
  label: string;
  short_label: string;
  config_path: string;
  exists: boolean;
}

/** 智慧模型运行状态 + 配置回显 + 环境校验。 */
export interface StrataStatus {
  // 配置
  enabled: boolean;
  python_path: string;
  work_dir: string;
  config_path: string;
  selected_model: StrataModelVariant;
  model_presets: StrataModelPreset[];
  s_config_path: string;
  m_config_path: string;
  port: number;
  lan: boolean;
  api_key: string;
  ready_timeout_secs: number;
  extra_args: string[];
  /** OpenAI 兼容基址（http://127.0.0.1:<port>/v1）。 */
  base_url: string;
  // 环境校验
  python_exists: boolean;
  serve_exists: boolean;
  config_exists: boolean;
  // 运行态
  running: boolean;
  /** 「可对话」：进程存活 + 权重已加载。 */
  api_ready: boolean;
  /** `/health` 可访问（接口在线，权重可能仍在加载）。 */
  api_reachable: boolean;
  /** 权重是否已加载。 */
  model_loaded: boolean;
  model_name: string | null;
  max_context: number | null;
  pid: number | null;
  /** 网关自带的网页界面地址（strata 内置 WebUI，`/`）。 */
  webui_url: string;
}

/** 智慧模型配置段（保存用）。 */
export interface StrataConfig {
  enabled: boolean;
  python_path: string;
  work_dir: string;
  /** 当前生效的 run config；切换模型时由 strataSelectModel 同步。 */
  config_path: string;
  selected_model: StrataModelVariant;
  s_config_path: string;
  m_config_path: string;
  port: number;
  lan: boolean;
  api_key: string;
  ready_timeout_secs: number;
  extra_args: string[];
}

export async function strataGetStatus() {
  if (!isDesktopRuntime()) return null;
  return invoke<StrataStatus>('strata_get_status');
}

export async function strataGetConfig() {
  if (!isDesktopRuntime()) return null;
  return invoke<StrataConfig>('strata_get_config');
}

export async function strataSaveConfig(config: StrataConfig) {
  if (!isDesktopRuntime()) return;
  await invoke('strata_save_config', { config });
}

/** 一键切换 S / M 模型（只切换 run config；运行中会拒绝，需先停止）。 */
export async function strataSelectModel(model: StrataModelVariant) {
  if (!isDesktopRuntime()) return;
  await invoke('strata_select_model', { model });
}

export async function strataSetEnabled(enabled: boolean) {
  if (!isDesktopRuntime()) return;
  await invoke('strata_set_enabled', { enabled });
}

/** 启动智慧模型（spawn 后立即返回；加载进度与就绪经事件上报）。 */
export async function strataStart() {
  if (!isDesktopRuntime()) return;
  await invoke('strata_start');
}

export async function strataStop() {
  if (!isDesktopRuntime()) return;
  await invoke('strata_stop');
}

export async function strataRestart() {
  if (!isDesktopRuntime()) return;
  await invoke('strata_restart');
}

export async function strataGetLogs() {
  if (!isDesktopRuntime()) return [];
  return invoke<string[]>('strata_get_logs');
}

export async function strataClearLogs() {
  if (!isDesktopRuntime()) return;
  await invoke('strata_clear_logs');
}

/**
 * 一条真实请求的性能读数。
 *
 * 字段与 NiNfer 的 `Fast27bRequestMetric` 对齐（少 model、多 finish），
 * 面板因此能共用一套汇总与绘图逻辑。网关没报的读数保持 null，不推算。
 */
export interface StrataRequestMetric {
  id: string;
  request_id: number;
  started_at: number;
  finished_at: number;
  /** success = 正常收尾；cancelled = 用户/客户端中止；failed = 网关报错或超时。 */
  outcome: 'success' | 'cancelled' | 'failed';
  /** 收尾原因（stop / length / cancelled …）。 */
  finish: string | null;
  prompt_tokens: number | null;
  output_tokens: number | null;
  ttft_ms: number | null;
  total_ms: number | null;
  decode_tps: number | null;
  prefill_tps: number | null;
  cache_tokens: number | null;
  draft_accepted: number | null;
  draft_proposed: number | null;
}

export interface StrataMetricsSnapshot {
  collected_at: number;
  active_requests: number;
  requests: StrataRequestMetric[];
}

/** 最近 24 小时、最多 5000 条真实请求性能历史（来自网关 /metrics，本地增量累积）。 */
export async function strataGetMetrics() {
  if (!isDesktopRuntime()) return null;
  return invoke<StrataMetricsSnapshot>('strata_get_metrics');
}

export async function strataClearMetrics() {
  if (!isDesktopRuntime()) return;
  await invoke('strata_clear_metrics');
}
