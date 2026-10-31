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
    pub run_id: String,
    pub model_id: String,
    pub baseline: crate::models::server_config::ServerConfig,
    /// MoE CPU 专家卸载按重复层数计，不是每层专家数。
    pub block_count: u32,
    pub max_ctx: u64,
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
    pub cache_type_k: String,
    pub cache_type_v: String,
    pub cache_type_k_enabled: bool,
    pub cache_type_v_enabled: bool,
    pub samples: u32,
    pub ts_stddev: f64,
    pub ttft_stddev_ms: f64,
    pub cold_ttft_ms: f64,
    pub warmup_ttft_ms: f64,
    pub measurement_phase: String,
    pub vram_available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoTuneProgress {
    pub run_id: String,
    pub model_id: String,
    pub phase: String,
    pub message: String,
    pub record: Option<TuneRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoTuneResult {
    pub run_id: String,
    pub model_id: String,
    pub best: TuneRecord,
    pub records: Vec<TuneRecord>,
    pub failures: Vec<TuneFailure>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FailureKind {
    Oom,
    Unsupported,
    Fatal,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TuneFailure {
    pub kind: FailureKind,
    pub message: String,
    /// 原始结构化 ServerError，保留 error_type/title/details/suggestions。
    pub server_error: Option<serde_json::Value>,
    pub candidate: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoTuneStatus {
    pub run_id: String,
    pub model_id: String,
    pub status: String,
    pub result: Option<AutoTuneResult>,
    pub error: Option<String>,
    pub records: Vec<TuneRecord>,
    pub failures: Vec<TuneFailure>,
}
