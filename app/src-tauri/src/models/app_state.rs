use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelVramConfig {
    pub gpu_layers: u32,
    pub ctx_length: u32,
    pub batch_size: u32,
    pub ubatch_size: u32,
    pub parallel: i32,
    pub flash_attn: bool,
    pub kv_offload: bool,
    pub kv_unified: bool,
    pub cache_type_k: String,
    pub cache_type_v: String,
    pub moe_cpu_layers: u32,
    pub speculative: String,
    #[serde(default)]
    pub no_warmup: bool,
    #[serde(default)]
    pub draft_tokens: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelVramBuffers {
    pub weights_gb: Option<f64>,
    pub kv_gb: Option<f64>,
    pub compute_gb: Option<f64>,
    pub context: Option<u32>,
    pub gpu_layers: Option<u32>,
    pub backend: Option<String>,
    #[serde(default)]
    pub parallel: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelVramMeasurement {
    pub version: u32,
    pub model_signature: String,
    pub gpu_name: String,
    pub gpu_total_gb: f64,
    #[serde(default)]
    pub kernel_version: Option<String>,
    pub config: ModelVramConfig,
    pub baseline_gb: Option<f64>,
    pub loaded_gb: Option<f64>,
    pub baseline_spread_gb: Option<f64>,
    pub loaded_spread_gb: Option<f64>,
    pub quality: String,
    pub buffers: ModelVramBuffers,
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
    #[serde(default)]
    pub vram_measurement: Option<ModelVramMeasurement>,
    pub note: Option<String>,
}

#[cfg(test)]
mod vram_record_tests {
    use super::*;

    #[test]
    fn old_launch_record_without_measurement_remains_readable() {
        let record: ModelRunRecord = serde_json::from_str(
            r#"{"model_id":"test-model","model_name":"测试模型","kind":"launch","timestamp":1,"ngl":41,"ctx":32768,"kv":"f16","vram_gb":8.5}"#,
        ).unwrap();
        assert_eq!(record.vram_gb, Some(8.5));
        assert!(record.vram_measurement.is_none());
        assert!(record.ncmoe.is_none());
    }

    #[test]
    fn measurement_preserves_independent_cache_types_and_sampling_source() {
        let measurement: ModelVramMeasurement = serde_json::from_str(
            r#"{"version":1,"model_signature":"test-signature","gpu_name":"测试 GPU","gpu_total_gb":12.0,"kernel_version":"b11405","config":{"gpu_layers":41,"ctx_length":32768,"batch_size":512,"ubatch_size":128,"parallel":-1,"flash_attn":true,"kv_offload":true,"kv_unified":true,"cache_type_k":"q8_0","cache_type_v":"q4_1","moe_cpu_layers":20,"speculative":"off","no_warmup":false,"draft_tokens":null},"baseline_gb":1.0,"loaded_gb":9.0,"baseline_spread_gb":0.02,"loaded_spread_gb":0.03,"quality":"stable","buffers":{"weights_gb":6.0,"kv_gb":1.2,"compute_gb":0.3,"context":32768,"gpu_layers":41,"backend":"CUDA","parallel":4}}"#,
        ).unwrap();
        let restored: ModelVramMeasurement = serde_json::from_str(&serde_json::to_string(&measurement).unwrap()).unwrap();
        assert_eq!(restored.config.cache_type_k, "q8_0");
        assert_eq!(restored.config.cache_type_v, "q4_1");
        assert_eq!(restored.config.ubatch_size, 128);
        assert_eq!(restored.buffers.parallel, Some(4));
        assert_eq!(restored.kernel_version.as_deref(), Some("b11405"));
        assert_eq!(restored.baseline_gb, Some(1.0));
        assert_eq!(restored.loaded_gb, Some(9.0));
    }
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
    /// 首次启动环境检测是否已完成（无论是否全部通过）。
    /// false 时前端会运行一次环境检测并对未通过项弹出安装提示。
    pub env_check_done: bool,
    /// 用户指定的自编译核心可执行文件（llama-server.exe 的绝对路径）。
    /// 设置后加载模型与本页内核状态都优先使用该路径；None 表示使用内置版本化核心。
    #[serde(default)]
    pub kernel_override_path: Option<String>,
    /// 向量（Embedding）/ 重排模型的独立服务端口。
    /// 与 default_port（对话/VLM 服务）不同端口，才能同时运行两类模型；默认 8081。
    #[serde(default = "default_embedding_port")]
    pub embedding_port: u16,
    /// dsh（DeepSeek Harness）接入配置（v0.4 新增，serde default 平滑迁移）。
    pub dsh: crate::models::dsh_types::DshConfig,
    /// MCP（Model Context Protocol）服务器列表（v0.5 新增，serde default 平滑迁移）。
    /// 每个条目是一个本机 stdio 子进程；对话时其工具会并入 llama.cpp 的工具集。
    #[serde(default)]
    pub mcp_servers: Vec<crate::models::mcp_types::McpServerConfig>,
    /// fast-27b 引擎接入配置（serde default 平滑迁移）。
    #[serde(default)]
    pub fast27b: Fast27bConfig,
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
            env_check_done: false,
            kernel_override_path: None,
            embedding_port: default_embedding_port(),
            dsh: crate::models::dsh_types::DshConfig::default(),
            mcp_servers: Vec::new(),
            fast27b: Fast27bConfig::default(),
        }
    }
}

fn default_embedding_port() -> u16 {
    8081
}

/// fast-27b 的模型类型。旧配置未记录类型时，按模型文件名兼容识别。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Fast27bModel {
    Heretic,
    Swift,
}

impl Fast27bModel {
    pub fn label(self) -> &'static str {
        match self {
            Self::Heretic => "Heretic 27B",
            Self::Swift => "Swift 27B",
        }
    }

    /// BAT 启动器中的草稿方案：Heretic 使用 DFlash2，Swift 使用 MTP。
    pub fn spec(self) -> &'static str {
        match self {
            Self::Heretic => "dflash2",
            Self::Swift => "mtp",
        }
    }

    fn filenames(self) -> &'static [&'static str] {
        match self {
            Self::Heretic => &["Ternary-Bonsai-2-27B-Heretic.ninfer"],
            Self::Swift => &[
                "bonsai2_27b_swift_pq2.v3.ninfer",
                "bonsai2_27b_swift_pq2.ninfer",
            ],
        }
    }
}

/// fast-27b 引擎（Swift / Heretic 27B）接入配置。
/// 默认值与 D:\Projects\fast-llm 下的 BAT 启动器保持一致；api_key 为本地明文（仅本机/局域网使用）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Fast27bConfig {
    /// 是否启用（停用后页面显示停用态，禁止启动引擎）。
    pub enabled: bool,
    /// ninfer-serve-86.exe 绝对路径。
    pub engine_path: String,
    /// .ninfer 模型权重文件绝对路径。
    pub model_path: String,
    /// 模型类型；None 兼容只有 model_path 的旧配置。
    pub selected_model: Option<Fast27bModel>,
    /// 分别保存两个模型的自定义路径，切换时不覆盖另一个模型的路径。
    pub swift_model_path: String,
    pub heretic_model_path: String,
    /// 服务端口。
    pub port: u16,
    /// true = 0.0.0.0（对局域网开放）；false = 仅 127.0.0.1。
    pub lan: bool,
    /// API Key（OpenAI 兼容接口 Bearer 鉴权，本地明文存储）。
    pub api_key: String,
    /// 上下文窗口（--max-context）。
    pub context_window: u32,
    /// 推测解码草稿长度（--draft-tokens）。
    pub draft_tokens: u32,
    /// 引擎默认输出上限（--default-max-tokens）；0 = 不传，交回引擎自身默认值。
    pub default_max_tokens: u32,
    /// 默认思考预算（--default-thinking-budget）；0 = 省略预算参数，关闭预算限制。
    /// 思考与正文共用输出额度，非 0 输出上限时预算必须严格小于输出上限。
    pub default_thinking_budget: u32,
    /// 官方 llama.cpp webui 同源桥端口（引擎没有网页界面，桥负责提供页面并抹平协议差异）。
    pub bridge_port: u16,
    /// 引擎就绪后自动打开 dsh Web UI。
    pub auto_open_dsh_web: bool,
}

impl Default for Fast27bConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            engine_path: String::from(
                r"D:\Projects\fast-llm\engine\infer-engine-sm86-20261002\engine\ninfer-serve-86.exe",
            ),
            model_path: String::from(
                r"D:\Projects\fast-llm\model\Ternary-Bonsai-2-27B-Heretic.ninfer",
            ),
            selected_model: None,
            swift_model_path: String::new(),
            heretic_model_path: String::new(),
            port: 8094,
            lan: false,
            api_key: String::from("JuAX7OVIUYEeIQ1nYoNbWvlhqBQXKvZx"),
            context_window: 262144,
            draft_tokens: 4,
            default_max_tokens: 32768,
            default_thinking_budget: 8192,
            bridge_port: 8095,
            auto_open_dsh_web: true,
        }
    }
}

/// 校验思考预算与默认输出额度（不修改用户已保存的参数）。
pub(crate) fn validate_fast27b_thinking_budget(
    default_max_tokens: u32,
    default_thinking_budget: u32,
) -> Result<(), String> {
    if default_max_tokens != 0 && default_thinking_budget >= default_max_tokens {
        return Err(format!(
            "默认思考预算（{}）必须小于默认输出上限（{}），为正文保留输出额度；设为 0 可关闭思考预算限制。",
            default_thinking_budget, default_max_tokens
        ));
    }
    Ok(())
}

impl Fast27bConfig {
    pub fn validate_thinking_budget(&self) -> Result<(), String> {
        validate_fast27b_thinking_budget(self.default_max_tokens, self.default_thinking_budget)
    }

    pub fn selected_model(&self) -> Fast27bModel {
        self.selected_model.unwrap_or_else(|| {
            if self.model_path.to_ascii_lowercase().contains("swift") {
                Fast27bModel::Swift
            } else {
                Fast27bModel::Heretic
            }
        })
    }

    /// 一键切换的纯配置变换：保存离开的模型路径，复用目标路径，其他参数保持原值。
    pub fn with_selected_model(&self, model: Fast27bModel) -> Self {
        let target_path = self.model_path_for(model);
        let mut config = self.clone();
        match self.selected_model() {
            Fast27bModel::Heretic => config.heretic_model_path = self.model_path.clone(),
            Fast27bModel::Swift => config.swift_model_path = self.model_path.clone(),
        }
        config.selected_model = Some(model);
        config.model_path = target_path.clone();
        match model {
            Fast27bModel::Heretic => config.heretic_model_path = target_path,
            Fast27bModel::Swift => config.swift_model_path = target_path,
        }
        config
    }

    /// 当前路径及显式保存的路径优先；未配置的模型仅探测本地文件，不下载、不改参数。
    pub fn model_path_for(&self, model: Fast27bModel) -> String {
        if model == self.selected_model() {
            return self.model_path.clone();
        }
        let saved = match model {
            Fast27bModel::Heretic => &self.heretic_model_path,
            Fast27bModel::Swift => &self.swift_model_path,
        };
        if !saved.trim().is_empty() {
            return saved.clone();
        }
        let current = PathBuf::from(&self.model_path);
        let engine = PathBuf::from(&self.engine_path);
        let mut directories = Vec::new();
        if let Some(parent) = current.parent() {
            directories.push(parent.to_path_buf());
        }
        if let Some(root) = engine.parent().and_then(|parent| parent.parent()) {
            directories.push(root.join("model"));
        }
        // 本机已有的 fast-llm 模型库；仍优先使用当前配置旁的离线资源。
        directories.push(PathBuf::from(r"D:\Projects\fast-llm\model"));
        let candidates: Vec<_> = directories
            .iter()
            .flat_map(|directory| {
                model
                    .filenames()
                    .iter()
                    .map(move |name| directory.join(name))
            })
            .collect();
        candidates
            .iter()
            .find(|path| path.is_file())
            .or_else(|| candidates.first())
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod fast27b_config_tests {
    use super::*;

    #[test]
    fn old_config_preserves_paths_and_parameters() {
        let config: Fast27bConfig = serde_json::from_str(
            r#"{"model_path":"custom/Heretic.ninfer","context_window":65536,"draft_tokens":2,"default_max_tokens":4096}"#,
        ).unwrap();
        assert_eq!(config.selected_model(), Fast27bModel::Heretic);
        assert_eq!(
            config.model_path_for(Fast27bModel::Heretic),
            "custom/Heretic.ninfer"
        );
        assert_eq!(
            (
                config.context_window,
                config.draft_tokens,
                config.default_max_tokens
            ),
            (65536, 2, 4096)
        );
        assert_eq!(config.port, 8094);
        assert_eq!(config.default_thinking_budget, 8192);
        // 新字段默认补齐，旧 ctx/draft/output 不迁移、不覆写；启动前会给出预算冲突提示。
        assert!(config.validate_thinking_budget().is_err());
    }

    #[test]
    fn thinking_budget_defaults_roundtrip_and_validation() {
        let config = Fast27bConfig::default();
        assert_eq!(config.default_thinking_budget, 8192);
        assert!(config.validate_thinking_budget().is_ok());
        assert_eq!(Fast27bModel::Heretic.spec(), "dflash2");
        assert_eq!(Fast27bModel::Swift.spec(), "mtp");
        for (output, budget, valid) in [
            (32768, 8192, true),
            (8192, 8192, false),
            (4096, 8192, false),
            (1, 0, true),
            (0, 8192, true),
            (0, 0, true),
        ] {
            assert_eq!(
                validate_fast27b_thinking_budget(output, budget).is_ok(),
                valid
            );
        }
        let config: Fast27bConfig = serde_json::from_str(
            r#"{"context_window":65536,"draft_tokens":2,"default_max_tokens":4096,"default_thinking_budget":0}"#,
        ).unwrap();
        let roundtrip: Fast27bConfig =
            serde_json::from_str(&serde_json::to_string(&config).unwrap()).unwrap();
        assert_eq!(roundtrip.default_thinking_budget, 0);
        assert!(roundtrip.validate_thinking_budget().is_ok());
    }

    #[test]
    fn switching_keeps_both_custom_paths_and_explicit_variant() {
        let config = Fast27bConfig {
            model_path: "custom/renamed.ninfer".into(),
            selected_model: Some(Fast27bModel::Swift),
            swift_model_path: "custom/renamed.ninfer".into(),
            heretic_model_path: "custom/heretic-old.ninfer".into(),
            ..Fast27bConfig::default()
        };
        assert_eq!(config.selected_model(), Fast27bModel::Swift);
        assert_eq!(
            config.model_path_for(Fast27bModel::Swift),
            "custom/renamed.ninfer"
        );
        assert_eq!(
            config.model_path_for(Fast27bModel::Heretic),
            "custom/heretic-old.ninfer"
        );
        let roundtrip: Fast27bConfig =
            serde_json::from_str(&serde_json::to_string(&config).unwrap()).unwrap();
        assert_eq!(roundtrip.selected_model(), Fast27bModel::Swift);
    }

    #[test]
    fn selecting_model_only_changes_model_selection_and_remembers_both_paths() {
        let original = Fast27bConfig {
            model_path: "custom/heretic.ninfer".into(),
            swift_model_path: "custom/swift-renamed.ninfer".into(),
            context_window: 65536,
            draft_tokens: 2,
            default_max_tokens: 12000,
            default_thinking_budget: 4096,
            port: 9104,
            lan: true,
            bridge_port: 9105,
            auto_open_dsh_web: false,
            ..Fast27bConfig::default()
        };
        let switched = original.with_selected_model(Fast27bModel::Swift);
        assert_eq!(switched.selected_model(), Fast27bModel::Swift);
        assert_eq!(switched.model_path, "custom/swift-renamed.ninfer");
        assert_eq!(switched.heretic_model_path, original.model_path);
        assert_eq!(switched.swift_model_path, switched.model_path);
        let mut restored = switched.with_selected_model(Fast27bModel::Heretic);
        assert_eq!(restored.model_path, original.model_path);
        assert_eq!(restored.swift_model_path, "custom/swift-renamed.ninfer");
        // 将预期的选择/路径字段归回原值，所有其余保存参数必须逐字段完全相同。
        restored.selected_model = original.selected_model;
        restored.heretic_model_path = original.heretic_model_path.clone();
        assert_eq!(
            serde_json::to_value(&restored).unwrap(),
            serde_json::to_value(&original).unwrap()
        );
        let unchanged = switched.with_selected_model(Fast27bModel::Swift);
        assert_eq!(
            serde_json::to_value(&unchanged).unwrap(),
            serde_json::to_value(&switched).unwrap()
        );
    }

    #[test]
    fn old_swift_path_is_recognized() {
        let config = Fast27bConfig {
            model_path: "models/bonsai2_27b_swift_pq2.v3.ninfer".into(),
            ..Fast27bConfig::default()
        };
        assert_eq!(config.selected_model(), Fast27bModel::Swift);
    }
}

pub struct AppState {
    pub config: Mutex<AppConfig>,
    pub gpu_monitor: Mutex<Option<GpuMonitor>>,
    /// 自动调参取消标记：cancel_auto_tune 置位，调参循环在每个测量点之间检查。
    pub auto_tune_cancel: AtomicBool,
}

impl AppState {
    pub fn new(config: AppConfig) -> Self {
        Self {
            config: Mutex::new(config),
            gpu_monitor: Mutex::new(None),
            auto_tune_cancel: AtomicBool::new(false),
        }
    }
}
