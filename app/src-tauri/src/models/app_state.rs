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

    /// BAT 启动器中的草稿方案。Heretic 不启用草稿头，Swift 使用 MTP。
    pub fn spec(self) -> &'static str {
        match self {
            Self::Heretic => "none",
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
            bridge_port: 8095,
            auto_open_dsh_web: true,
        }
    }
}

impl Fast27bConfig {
    pub fn selected_model(&self) -> Fast27bModel {
        self.selected_model.unwrap_or_else(|| {
            if self.model_path.to_ascii_lowercase().contains("swift") {
                Fast27bModel::Swift
            } else {
                Fast27bModel::Heretic
            }
        })
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
