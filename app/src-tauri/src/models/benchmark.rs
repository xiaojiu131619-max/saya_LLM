use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BenchmarkConfig {
    pub port: u16,
    pub prompt_tokens: u32,
    pub max_tokens: u32,
    pub iterations: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BenchmarkIteration {
    pub iteration: u32,
    pub prompt_tokens: u32,
    pub prompt_per_second: f64,
    pub generated_tokens: u32,
    pub tokens_per_second: f64,
    pub time_to_first_token_ms: f64,
    pub total_time_ms: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BenchmarkResult {
    pub iterations: Vec<BenchmarkIteration>,
    pub avg_prompt_per_second: f64,
    pub avg_tokens_per_second: f64,
    pub avg_ttft_ms: f64,
    pub total_time_ms: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BenchmarkProgress {
    pub current: u32,
    pub total: u32,
    pub iteration: BenchmarkIteration,
}

// --- Auto-Tune ---

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum SortMode {
    #[serde(rename = "ts")]
    TsPriority,
    #[serde(rename = "ctx")]
    CtxPriority,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoTuneConfig {
    pub executable_path: String,
    pub model_path: String,
    pub port: u16,
    pub total_layers: u32,
    pub expert_count: u32,
    pub max_ctx: u64,
    pub batch_size: u32,
    pub flash_attn: bool,
    pub kv_offload: bool,
    pub mmap: bool,
    pub mlock: bool,
    pub is_moe: bool,
    pub sort_mode: SortMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TuneRecord {
    pub model_type: String,
    pub ngl: u32,
    pub ncmoe: u32,
    pub ctx: u32,
    pub kv: String,
    pub vram_used_gb: f64,
    pub vram_total_gb: f64,
    pub vram_percent: f64,
    pub ts: f64,
    pub first_token_ms: f64,
    pub fits: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoTuneProgress {
    pub phase: String,
    pub message: String,
    pub record: Option<TuneRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoTuneResult {
    pub best: TuneRecord,
    pub records: Vec<TuneRecord>,
}
