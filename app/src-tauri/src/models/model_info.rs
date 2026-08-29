use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoSupportLevel {
    /// 模型及 projector 已有明确的视频能力证据。
    Verified,
    /// projector 存在视频专用结构，但仍需运行时依赖与实际模型验证。
    Candidate,
    /// 只能把视频拆成图片帧走视觉兼容路径。
    Frames,
    #[default]
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub name: String,
    pub file_name: String,
    pub file_path: String,
    pub file_size_gb: f64,
    #[serde(default)]
    pub split_part: Option<u32>,
    #[serde(default)]
    pub split_count: Option<u32>,
    #[serde(default)]
    pub split_total_size_gb: Option<f64>,
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
    #[serde(default)]
    pub gguf_version: u32,
    /// True when draft-mtp is available either from the main GGUF or a compatible head.
    pub mtp_support: bool,
    #[serde(default)]
    pub nextn_predict_layers: u64,
    #[serde(default)]
    pub has_embedded_mtp: bool,
    #[serde(default)]
    pub mtp_architecture_supported: bool,
    #[serde(default)]
    pub mtp_tensor_count: u64,
    #[serde(default)]
    pub vocab_size: Option<u64>,
    #[serde(default)]
    pub tensor_count: u64,
    #[serde(default)]
    pub tensor_type_summary: Vec<(String, u64)>,
    #[serde(default)]
    pub rope_freq_base: Option<f64>,
    #[serde(default)]
    pub rope_dimension_count: Option<u64>,
    #[serde(default)]
    pub rope_scaling_type: Option<String>,
    #[serde(default)]
    pub rope_scaling_factor: Option<f64>,
    #[serde(default)]
    pub rope_scaling_original_context_length: Option<u64>,
    #[serde(default)]
    pub tokenizer_model: Option<String>,
    #[serde(default)]
    pub tokenizer_bos_id: Option<u64>,
    #[serde(default)]
    pub tokenizer_eos_id: Option<u64>,
    #[serde(default)]
    pub tokenizer_pad_id: Option<u64>,
    #[serde(default)]
    pub mmproj_path: Option<String>,
    #[serde(default)]
    pub mmproj_supports_vision: bool,
    #[serde(default)]
    pub mmproj_supports_audio: bool,
    #[serde(default)]
    pub mmproj_projector_type: Option<String>,
    #[serde(default)]
    pub mmproj_vision_projector_type: Option<String>,
    #[serde(default)]
    pub mmproj_audio_projector_type: Option<String>,
    #[serde(default)]
    pub video_support: VideoSupportLevel,
    #[serde(default)]
    pub mtp_draft_path: Option<String>,
    /// 同目录或 dspark/ 子目录发现的 DSpark 推测解码侧车。
    #[serde(default)]
    pub dspark_draft_path: Option<String>,
    /// 同目录或 dflash/ 子目录发现的 DFlash 推测解码侧车。
    #[serde(default)]
    pub dflash_draft_path: Option<String>,
    /// 文件名带 UD- 量化标记（unsloth Dynamic GGUF，按层位宽分配的预量化）。
    #[serde(default)]
    pub is_dynamic_quant: bool,
    pub supports_reasoning: bool,
    // 来自 GGUF 的 general.tags 数组（小写），用于权威能力推断
    #[serde(default)]
    pub gguf_tags: Vec<String>,
    // chat_template 是否含工具调用语法（tool_calls / function 等关键字）
    #[serde(default)]
    pub has_tool_template: bool,
    pub gguf_metadata: Vec<(String, String)>,
}
