import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { VideoSupportLevel } from '@/types';
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

export interface AutoTuneConfig {
  executable_path: string;
  model_path: string;
  port: number;
  total_layers: number;
  expert_count: number;
  max_ctx: number;
  batch_size: number;
  flash_attn: boolean;
  kv_offload: boolean;
  mmap: boolean;
  mlock: boolean;
  is_moe: boolean;
  sort_mode: AutoTuneSortMode;
}

export interface TuneRecord {
  model_type: string;
  ngl: number;
  ncmoe: number;
  ctx: number;
  kv: string;
  vram_used_gb: number;
  vram_total_gb: number;
  vram_percent: number;
  ts: number;
  first_token_ms: number;
  fits: boolean;
}

export interface AutoTuneProgress {
  phase: string;
  message: string;
  record?: TuneRecord | null;
}

export interface AutoTuneResult {
  best: TuneRecord;
  records: TuneRecord[];
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
export async function cancelAutoTune() {
  if (!isDesktopRuntime()) return;
  await invoke('cancel_auto_tune');
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
