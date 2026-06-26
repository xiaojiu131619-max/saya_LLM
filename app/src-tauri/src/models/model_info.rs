use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub name: String,
    pub file_name: String,
    pub file_path: String,
    pub file_size_gb: f64,
    pub architecture: Option<String>,
    pub params: Option<String>,
    pub quantization: Option<String>,
    pub is_moe: bool,
    pub expert_count: Option<u64>,
    pub context_length: Option<u64>,
    pub block_count: Option<u64>,
    pub embedding_length: Option<u64>,
    pub head_count: Option<u64>,
    pub head_count_kv: Option<u64>,
    pub key_length: Option<u64>,
    pub value_length: Option<u64>,
    pub mtp_support: bool,
    #[serde(default)]
    pub mmproj_path: Option<String>,
    #[serde(default)]
    pub mtp_draft_path: Option<String>,
    pub supports_reasoning: bool,
    pub gguf_metadata: Vec<(String, String)>,
}
