import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { ModelLoadConfig, ModelMemoryLayout, VideoSupportLevel } from '@/types';
import { isDesktopRuntime } from '../desktopRuntime';

/**
 * 模型扫描 / 目录 / 运行记录 / 自动调参的 IPC 传输层。
 * 只做 invoke 包装，模型元数据归一化（`toFrontendModel`）留在 `lib/desktop`。
 */

export interface DesktopModelInfo {
  name: string;
  file_name: string;
  file_path: string;
  file_size_gb: number;
  split_part?: number | null;
  split_count?: number | null;
  split_total_size_gb?: number | null;
  architecture: string | null;
  params: string | null;
  quantization: string | null;
  is_moe: boolean;
  expert_count: number | null;
  context_length: number | null;
  block_count: number | null;
  embedding_length: number | null;
  head_count: number | null;
  head_count_kv: number | null;
  /** 混合架构逐层 head_count_kv 数组的求和；标量形式时为 null。 */
  kv_heads_sum?: number | null;
  kv_heads_by_layer?: number[] | null;
  swa_layer_pattern?: boolean[] | null;
  full_attention_interval?: number | null;
  memory_layout?: ModelMemoryLayout | null;
  kv_heads_sum_full?: number | null;
  kv_heads_sum_swa?: number | null;
  sliding_window?: number | null;
  key_length_swa?: number | null;
  value_length_swa?: number | null;
  key_length: number | null;
  value_length: number | null;
  gguf_version?: number;
  mtp_support: boolean;
  nextn_predict_layers?: number;
  has_embedded_mtp?: boolean;
  mtp_architecture_supported?: boolean;
  mtp_tensor_count?: number;
  vocab_size?: number | null;
  tensor_count?: number;
  tensor_type_summary?: Array<[string, number]>;
  rope_freq_base?: number | null;
  rope_dimension_count?: number | null;
  rope_scaling_type?: string | null;
  rope_scaling_factor?: number | null;
  rope_scaling_original_context_length?: number | null;
  tokenizer_model?: string | null;
  tokenizer_bos_id?: number | null;
  tokenizer_eos_id?: number | null;
  tokenizer_pad_id?: number | null;
  mmproj_path: string | null;
  mmproj_supports_vision?: boolean;
  mmproj_supports_audio?: boolean;
  mmproj_projector_type?: string | null;
  mmproj_vision_projector_type?: string | null;
  mmproj_audio_projector_type?: string | null;
  video_support?: VideoSupportLevel;
  mtp_draft_path: string | null;
  dspark_draft_path: string | null;
  dflash_draft_path: string | null;
  is_dynamic_quant?: boolean;
  supports_reasoning: boolean;
  gguf_tags: string[];
  has_tool_template: boolean;
  /** 任务类型：chat / embedding / rerank（后端按 GGUF 元数据判定）。 */
  model_task?: string;
  /** GGUF 声明的默认池化方式（mean / cls / last / rank）。 */
  pooling_type?: string | null;
  gguf_metadata: Array<[string, string]>;
}

// ============================================================
// Auto-Tune（镜像后端 models/benchmark.rs）
// ============================================================

export type AutoTuneSortMode = 'ts' | 'ctx';

export interface ServerConfig {
  executable_path: string;
  model_path: string;
  model_alias: string | null;
  port: number;
  host: string;
  api_key: string | null;
  ngl: number;
  n_ctx: number;
  batch_size: number;
  ubatch_size: number;
  threads: number;
  parallel: number;
  flash_attn: boolean;
  kv_offload: boolean;
  kv_unified: boolean;
  mmap: boolean;
  mlock: boolean;
  no_warmup: boolean;
  cache_type_k: string;
  cache_type_v: string;
  cache_type_k_enabled: boolean;
  cache_type_v_enabled: boolean;
  rope_freq_base: number | null;
  rope_freq_scale: number | null;
  seed: number | null;
  chat_template: string | null;
  mmproj_path: string | null;
  mtp_draft_path: string | null;
  dspark_draft_path: string | null;
  dflash_draft_path: string | null;
  spec_draft_n_max: number | null;
  spec_type: string | null;
  ncmoe: number;
  tools: string | null;
  reasoning_budget: number;
  /** 向量/重排专用：传 --embeddings 限定服务只提供向量用途。 */
  embedding?: boolean;
  /** --pooling 取值（none/mean/cls/last/rank）；null = 用模型默认。 */
  pooling?: string | null;
  /** 启用重排端点 --rerank。 */
  rerank?: boolean;
  /** --embd-normalize 归一化方式；null = 内核默认 2。 */
  embd_normalize?: number | null;
  device: string | null;
  main_gpu: number | null;
  retry_cpu_fallback: boolean;
  no_cuda: boolean;
}


export interface AutoTuneConfig {
  run_id: string;
  model_id: string;
  baseline: ServerConfig;
  block_count: number;
  max_ctx: number;
  is_moe: boolean;
  sort_mode: AutoTuneSortMode;
}

export interface TuneRecord {
  model_type: string;
  ngl: number;
  ncmoe: number;
  ctx: number;
  kv: string;
  cache_type_k: string;
  cache_type_v: string;
  cache_type_k_enabled: boolean;
  cache_type_v_enabled: boolean;
  samples?: number;
  ts_stddev?: number;
  ttft_stddev_ms?: number;
  cold_ttft_ms?: number;
  warmup_ttft_ms?: number;
  measurement_phase?: string;
  vram_used_gb: number;
  vram_total_gb: number;
  vram_percent: number;
  ts: number;
  first_token_ms: number;
  fits: boolean;
  vram_available: boolean;
}

export interface AutoTuneProgress {
  run_id: string;
  model_id: string;
  phase: string;
  message: string;
  record?: TuneRecord | null;
}

export interface AutoTuneResult {
  run_id: string;
  model_id: string;
  best: TuneRecord;
  records: TuneRecord[];
  failures?: TuneFailure[];
}

export interface AutoTuneTerminalRecords {
  records: TuneRecord[];
  failures: TuneFailure[];
}
export interface TuneFailure {
  kind: 'oom' | 'unsupported' | 'fatal' | 'cancelled';
  message: string;
  server_error?: unknown;
  candidate?: unknown;
}
export interface AutoTuneError extends AutoTuneTerminalRecords { run_id: string; model_id: string; error: string }
export interface AutoTuneCancelled extends AutoTuneTerminalRecords { run_id: string; model_id: string; message: string }
export type AutoTuneStatusName = 'running' | 'stopping' | 'done' | 'error' | 'cancelled';
export interface AutoTuneStatus extends AutoTuneTerminalRecords {
  run_id: string;
  model_id: string;
  status: AutoTuneStatusName;
  result?: AutoTuneResult;
  error?: string;
}

export interface AutoTuneExperiment {
  version: 1;
  config: AutoTuneConfig;
  load_config: ModelLoadConfig;
  status: AutoTuneStatusName;
  records: TuneRecord[];
  best?: TuneRecord;
  failures?: TuneFailure[];
  error?: string;
}

export interface TuneHistoryEntry {
  model_name: string;
  model_path: string;
  ngl: number;
  ctx: number;
  kv: string;
  ncmoe: number;
  ts: number;
  vram_percent: number;
  sort_mode: string;
  timestamp: number;
}

// 模型运行记录：启动参数 + 实测表现，单独存放在 AppData 的 model_records.json，
// 供显存预测校准、推荐启动参数与自动调参做数据支持。
export interface ModelVramMeasurement {
  version: number;
  model_signature: string;
  gpu_name: string;
  gpu_total_gb: number;
  kernel_version?: string | null;
  config: {
    gpu_layers: number;
    ctx_length: number;
    batch_size: number;
    ubatch_size: number;
    parallel: number;
    flash_attn: boolean;
    kv_offload: boolean;
    kv_unified: boolean;
    cache_type_k: string;
    cache_type_v: string;
    moe_cpu_layers: number;
    speculative: string;
    no_warmup?: boolean;
    draft_tokens?: number | null;
  };
  baseline_gb: number | null;
  loaded_gb: number | null;
  baseline_spread_gb: number | null;
  loaded_spread_gb: number | null;
  quality: 'stable' | 'unverified' | 'adapted' | 'contaminated';
  buffers: {
    weights_gb: number | null;
    kv_gb: number | null;
    compute_gb: number | null;
    context: number | null;
    gpu_layers: number | null;
    backend: string | null;
    parallel?: number | null;
  };
}

export interface ModelRunRecord {
  model_id: string;
  model_name: string;
  kind: 'launch' | 'benchmark' | 'autotune';
  timestamp: number;
  ngl?: number | null;
  ctx?: number | null;
  kv?: string | null;
  ncmoe?: number | null;
  flash_attn?: boolean | null;
  speculative?: string | null;
  tokens_per_sec?: number | null;
  first_token_ms?: number | null;
  vram_gb?: number | null;
  vram_predicted_gb?: number | null;
  vram_measurement?: ModelVramMeasurement | null;
  autotune?: AutoTuneExperiment | null;
  note?: string | null;
}

export async function scanDesktopModels(full = true) {
  if (!isDesktopRuntime()) return [];
  const command = full ? 'scan_models' : 'scan_fast';
  return invoke<DesktopModelInfo[]>(command);
}

export async function loadDesktopModelFromPath(path: string) {
  if (!isDesktopRuntime()) return null;
  return invoke<DesktopModelInfo>('load_model_from_path', { path });
}

export async function addDesktopModelDir(dir: string) {
  if (!isDesktopRuntime()) return [];
  return invoke<string[]>('add_model_dir', { dir });
}

export async function removeDesktopModelDir(dir: string) {
  if (!isDesktopRuntime()) return [];
  return invoke<string[]>('remove_model_dir', { dir });
}

export async function pickModelDirectory() {
  if (!isDesktopRuntime()) return null;
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === 'string' ? selected : null;
}

export async function clearDesktopModelCache() {
  if (!isDesktopRuntime()) return '';
  return invoke<string>('clear_model_cache');
}

export async function startAutoTune(config: AutoTuneConfig) {
  if (!isDesktopRuntime()) return;
  await invoke('start_auto_tune', { config });
}

// 请求停止正在运行的自动调参：后端置位取消标记并停掉测量中的 llama-server，
// 调参任务会在当前测量点结束后发出 autotune:cancelled 事件。
export async function cancelAutoTune(runId: string) {
  if (!isDesktopRuntime()) return;
  await invoke('cancel_auto_tune', { runId });
}

export async function getAutoTuneStatus() {
  if (!isDesktopRuntime()) return null;
  return invoke<AutoTuneStatus | null>('get_auto_tune_status');
}

export async function saveTuneResult(entry: TuneHistoryEntry) {
  if (!isDesktopRuntime()) return;
  await invoke('save_tune_result', { entry });
}

export async function saveModelRunRecord(record: ModelRunRecord) {
  if (!isDesktopRuntime()) return;
  await invoke('save_model_run_record', { record });
}

export async function getModelRunRecords(modelId: string) {
  if (!isDesktopRuntime()) return [];
  return invoke<ModelRunRecord[]>('get_model_run_records', { modelId });
}

export async function clearModelRunRecords(modelId: string) {
  if (!isDesktopRuntime()) return;
  await invoke('clear_model_run_records', { modelId });
}
