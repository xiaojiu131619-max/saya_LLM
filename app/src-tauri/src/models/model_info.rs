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

/// 按 GGUF 张量表估算的层权重；expert_bytes 是 weight_bytes 的子集。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GgufLayerMemoryLayout {
    pub weight_bytes: u64,
    /// 仅 -ncmoe 匹配的路由专家权重，不含共享专家和路由器。
    pub expert_bytes: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GgufMemoryAccuracy {
    #[default]
    Exact,
    UpperBound,
}

/// 不含 GGUF 头的权重布局。已知类型使用真实 payload 字节，排除 alignment
/// padding 和 footer；未知量化采用相邻 offset/文件尾跨度，并标记 upper_bound。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GgufMemoryLayout {
    pub version: u32,
    pub layers: Vec<GgufLayerMemoryLayout>,
    /// token_embd 张量固定放在 CPU。
    pub input_bytes: u64,
    pub output_bytes: u64,
    /// 非 block、非输入/输出的张量保守按 GPU 权重估算。
    pub other_bytes: u64,
    pub total_bytes: u64,
    pub signature: String,
    #[serde(default)]
    pub accuracy: GgufMemoryAccuracy,
    /// 完整模型没有 output.weight，输出复用 token_embd.weight；GPU 输出副本由前端估算。
    #[serde(default)]
    pub tied_output: bool,
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
    /// 逐层 KV 头数，长度必须等于 block_count；0 表示 SSM/recurrent 层无 KV。
    #[serde(default)]
    pub kv_heads_by_layer: Option<Vec<u64>>,
    /// 逐层滑窗模式，true 表示 SWA；长度必须等于 block_count。
    #[serde(default)]
    pub swa_layer_pattern: Option<Vec<bool>>,
    /// GGUF 声明的全注意力层间隔，仅已知混合架构用于推导逐层 KV。
    #[serde(default)]
    pub full_attention_interval: Option<u64>,
    /// 混合架构逐层 KV 头数的求和（0 = 无 KV 的 SSM/recurrent 层）；
    /// 无有效逐层向量时为 None。旧缓存由 serde(default) 兜底为 None。
    #[serde(default)]
    pub kv_heads_sum: Option<u64>,
    /// gemma 系 SWA 分列求和：全注意力层（pattern=0）/ SWA 层（pattern≠0）。
    #[serde(default)]
    pub kv_heads_sum_full: Option<u64>,
    #[serde(default)]
    pub kv_heads_sum_swa: Option<u64>,
    /// 滑动窗口大小与 SWA 层 K/V 维度：SWA 层 KV 只按窗口分配，估算须单独走。
    #[serde(default)]
    pub sliding_window: Option<u64>,
    #[serde(default)]
    pub key_length_swa: Option<u64>,
    #[serde(default)]
    pub value_length_swa: Option<u64>,
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
    /// 模型任务类型：`chat`（对话/补全）、`embedding`（向量）、`rerank`（重排）。
    /// 由 GGUF 元数据（pooling_type / attention.causal / 架构）与文件名共同判定。
    #[serde(default)]
    pub model_task: String,
    /// GGUF 声明的默认池化方式（mean / cls / last / rank）；None = 未声明。
    #[serde(default)]
    pub pooling_type: Option<String>,
    /// GGUF 张量表推导的主模型 GPU 显存布局；旧缓存缺失时为 None。
    #[serde(default)]
    pub memory_layout: Option<GgufMemoryLayout>,
    pub gguf_metadata: Vec<(String, String)>,
}
