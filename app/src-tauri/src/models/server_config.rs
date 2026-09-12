use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    pub executable_path: String,
    pub model_path: String,
    #[serde(default)]
    pub model_alias: Option<String>,
    pub port: u16,
    #[serde(default = "default_host")]
    pub host: String,
    #[serde(default)]
    pub api_key: Option<String>,
    pub ngl: u32,
    pub n_ctx: u32,
    pub batch_size: u32,
    #[serde(default)]
    pub ubatch_size: u32,
    #[serde(default = "default_negative_one")]
    pub threads: i32,
    #[serde(default = "default_negative_one")]
    pub parallel: i32,
    pub flash_attn: bool,
    pub kv_offload: bool,
    #[serde(default)]
    pub kv_unified: bool,
    pub mmap: bool,
    pub mlock: bool,
    #[serde(default)]
    pub no_warmup: bool,
    pub cache_type_k: String,
    pub cache_type_v: String,
    #[serde(default)]
    pub cache_type_k_enabled: bool,
    #[serde(default)]
    pub cache_type_v_enabled: bool,
    #[serde(default)]
    pub rope_freq_base: Option<f64>,
    #[serde(default)]
    pub rope_freq_scale: Option<f64>,
    #[serde(default)]
    pub seed: Option<i64>,
    #[serde(default)]
    pub chat_template: Option<String>,
    #[serde(default)]
    pub mmproj_path: Option<String>,
    #[serde(default)]
    pub mtp_draft_path: Option<String>,
    /// DSpark 推测解码侧车路径（与 mtp/dflash 互斥使用，优先级 MTP > DSpark > DFlash）。
    #[serde(default)]
    pub dspark_draft_path: Option<String>,
    /// DFlash 推测解码侧车路径。
    #[serde(default)]
    pub dflash_draft_path: Option<String>,
    /// 推测解码草稿深度（--spec-draft-n-max，1..16）。None 表示不传，用内核默认。
    #[serde(default)]
    pub spec_draft_n_max: Option<u32>,
    #[serde(default)]
    pub spec_type: Option<String>,
    pub ncmoe: u32,
    pub tools: Option<String>,
    pub reasoning_budget: u32,
    /// 专用向量/重排模型：传 `--embeddings`（限定服务只提供向量用途）。
    /// 与 chat/VLM 互斥，由独立的向量模型进程使用。
    #[serde(default)]
    pub embedding: bool,
    /// `--pooling` 取值（none / mean / cls / last / rank）；None = 用模型默认。
    #[serde(default)]
    pub pooling: Option<String>,
    /// 启用重排端点 `--rerank`（配合 `--pooling rank` 的 reranker 模型）。
    #[serde(default)]
    pub rerank: bool,
    /// `--embd-normalize` 归一化方式（-1 = 不归一化）；None = 内核默认 2。
    #[serde(default)]
    pub embd_normalize: Option<i32>,
    /// Preferred llama.cpp device selector. Empty means auto.
    #[serde(default)]
    pub device: Option<String>,
    /// Preferred main GPU index for CUDA offload. None means auto.
    #[serde(default)]
    pub main_gpu: Option<u32>,
    /// Retry on CUDA error by forcing CPU-only mode
    #[serde(default, alias = "_retry_cpu")]
    pub retry_cpu_fallback: bool,
    /// Force disable CUDA (set when falling back to CPU)
    #[serde(default)]
    pub no_cuda: bool,
}

fn default_host() -> String {
    String::from("127.0.0.1")
}

fn default_negative_one() -> i32 {
    -1
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            executable_path: String::from("resources/llama-server.exe"),
            model_path: String::new(),
            model_alias: None,
            port: 8080,
            host: default_host(),
            api_key: None,
            ngl: 0,
            n_ctx: 32768,
            batch_size: 512,
            ubatch_size: 512,
            threads: -1,
            parallel: -1,
            flash_attn: true,
            kv_offload: true,
            kv_unified: true,
            mmap: true,
            mlock: false,
            no_warmup: false,
            cache_type_k: String::from("f16"),
            cache_type_v: String::from("f16"),
            cache_type_k_enabled: false,
            cache_type_v_enabled: false,
            rope_freq_base: None,
            rope_freq_scale: None,
            seed: None,
            chat_template: None,
            mmproj_path: None,
            mtp_draft_path: None,
            dspark_draft_path: None,
            dflash_draft_path: None,
            spec_draft_n_max: None,
            spec_type: None,
            ncmoe: 0,
            tools: None,
            reasoning_budget: 0,
            embedding: false,
            pooling: None,
            rerank: false,
            embd_normalize: None,
            device: None,
            main_gpu: Some(0),
            retry_cpu_fallback: false,
            no_cuda: false,
        }
    }
}
