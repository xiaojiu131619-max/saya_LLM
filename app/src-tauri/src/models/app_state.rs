use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::services::gpu_monitor::GpuMonitor;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelPreset {
    pub ngl: u32,
    pub n_ctx: u32,
    pub batch_size: u32,
    pub flash_attn: bool,
    pub kv_offload: bool,
    pub mmap: bool,
    pub mlock: bool,
    pub cache_type_k: String,
    pub cache_type_v: String,
    pub ncmoe: u32,
    pub tools: Option<String>,
    pub mtp_enabled: Option<bool>,
    pub mtp_draft_n_max: Option<u32>,
    pub mtp_draft_p_min: Option<f32>,
    pub reasoning_budget: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TuneHistoryEntry {
    pub model_name: String,
    pub model_path: String,
    pub ngl: u32,
    pub ctx: u32,
    pub kv: String,
    pub ncmoe: u32,
    pub ts: f64,
    pub vram_percent: f64,
    pub sort_mode: String,
    pub timestamp: u64,
}

/// 单条模型运行记录：启动参数 + 本次运行的实测表现。
/// 单独存放在 model_records.json（与 config.json 同目录），
/// 供显存预测校准、推荐启动参数和自动调参做数据支持。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelRunRecord {
    pub model_id: String,
    pub model_name: String,
    /// "launch" = 启动记录；"benchmark" = 手动跑分；"autotune" = 自动调参采样。
    pub kind: String,
    pub timestamp: u64,
    pub ngl: Option<u32>,
    pub ctx: Option<u32>,
    pub kv: Option<String>,
    /// MoE CPU 卸载层数（--n-cpu-moe）。
    #[serde(default)]
    pub ncmoe: Option<u32>,
    pub flash_attn: Option<bool>,
    pub speculative: Option<String>,
    pub tokens_per_sec: Option<f64>,
    pub first_token_ms: Option<f64>,
    /// 实测显存增量（GB）。
    pub vram_gb: Option<f64>,
    /// 当时的显存预测值（GB），与 vram_gb 对比即可得到该模型的真实偏差。
    pub vram_predicted_gb: Option<f64>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppConfig {
    pub version: u32,
    pub model_dirs: Vec<PathBuf>,
    pub llama_server_path: String,
    pub default_port: u16,
    pub api_enabled: bool,
    pub api_host: String,
    pub api_key: Option<String>,
    pub theme: String,
    pub refresh_interval: u64,
    pub auto_scan_on_startup: bool,
    pub model_presets: HashMap<String, ModelPreset>,
    pub tools: Option<String>,
    pub last_model_path: Option<String>,
    pub tune_history: Vec<TuneHistoryEntry>,
    pub close_to_tray: bool,
    /// HTTP(S) 代理地址（如 http://127.0.0.1:7890）。
    /// 核心更新与 GitHub API 的请求默认不走系统代理，需在此显式配置。
    pub proxy_url: Option<String>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            version: 1,
            model_dirs: Vec::new(),
            llama_server_path: String::from("llama-server.exe"),
            default_port: 8080,
            api_enabled: false,
            api_host: String::from("127.0.0.1"),
            api_key: None,
            theme: String::from("dark"),
            refresh_interval: 2,
            auto_scan_on_startup: true,
            model_presets: HashMap::new(),
            tools: None,
            last_model_path: None,
            tune_history: Vec::new(),
            close_to_tray: true,
            proxy_url: None,
        }
    }
}

pub struct AppState {
    pub config: Mutex<AppConfig>,
    pub gpu_monitor: Mutex<Option<GpuMonitor>>,
}

impl AppState {
    pub fn new(config: AppConfig) -> Self {
        Self {
            config: Mutex::new(config),
            gpu_monitor: Mutex::new(None),
        }
    }
}
