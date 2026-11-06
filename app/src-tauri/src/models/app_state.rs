use std::collections::HashMap;
use std::path::{Path, PathBuf};
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
    #[serde(default, serialize_with = "serialize_redacted_autotune")]
    pub autotune: Option<serde_json::Value>,
    pub note: Option<String>,
}

fn serialize_redacted_autotune<S: serde::Serializer>(value: &Option<serde_json::Value>, serializer: S) -> Result<S::Ok, S::Error> {
    fn redact(value: &mut serde_json::Value) {
        match value {
            serde_json::Value::Object(object) => {
                for (key, value) in object {
                    if matches!(key.as_str(), "api_key" | "apiKey") { *value = serde_json::Value::Null; }
                    else { redact(value); }
                }
            }
            serde_json::Value::Array(array) => { for value in array { redact(value); } }
            _ => {}
        }
    }
    let mut safe = value.clone();
    if let Some(value) = &mut safe { redact(value); }
    safe.serialize(serializer)
}

#[cfg(test)]
mod vram_record_tests {
    use super::*;

    #[test]
    fn autotune_experiment_serialization_redacts_api_keys_recursively() {
        let mut record: ModelRunRecord = serde_json::from_str(r#"{"model_id":"m","model_name":"测试","kind":"autotune","timestamp":1}"#).unwrap();
        record.autotune = Some(serde_json::json!({"version":1,"config":{"baseline":{"api_key":"secret"}},"load_config":{"apiKey":"also-secret"}}));
        let serialized = serde_json::to_value(record).unwrap();
        assert!(serialized["autotune"]["config"]["baseline"]["api_key"].is_null());
        assert!(serialized["autotune"]["load_config"]["apiKey"].is_null());
        assert!(!serialized.to_string().contains("secret"));
    }

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
    /// 用户显式选中的本机核心目录名（kernels/<目录>）；None = 自动选最新。
    #[serde(default)]
    pub selected_kernel: Option<String>,
    /// 向量（Embedding）/ 重排模型的独立服务端口。
    /// 与 default_port（对话/VLM 服务）不同端口，才能同时运行两类模型；默认 8081。
    #[serde(default = "default_embedding_port")]
    pub embedding_port: u16,
    /// MCP（Model Context Protocol）服务器列表（v0.5 新增，serde default 平滑迁移）。
    /// 每个条目是一个本机 stdio 子进程；对话时其工具会并入 llama.cpp 的工具集。
    #[serde(default)]
    pub mcp_servers: Vec<crate::models::mcp_types::McpServerConfig>,
    /// fast-27b 引擎接入配置（serde default 平滑迁移）。
    #[serde(default)]
    pub fast27b: Fast27bConfig,
    /// 智慧模型（Strata 引擎）接入配置（serde default 平滑迁移）。
    #[serde(default)]
    pub strata: StrataConfig,
    /// 引擎目录（llama.cpp 版本化内核安装位置）。None = 资源目录下的 kernels。
    #[serde(default)]
    pub engine_dir: Option<String>,
    /// 日志目录（llama / NiNfer / Strata 的日志文件根目录）。None = 应用数据目录。
    #[serde(default)]
    pub log_dir: Option<String>,
    /// 归档聊天记录目录（导出的会话归档）。None = 应用数据目录下的 archives。
    #[serde(default)]
    pub archive_dir: Option<String>,
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
            selected_kernel: None,
            embedding_port: default_embedding_port(),
            mcp_servers: Vec::new(),
            fast27b: Fast27bConfig::default(),
            strata: StrataConfig::default(),
            engine_dir: None,
            log_dir: None,
            archive_dir: None,
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
    /// 旧配置里的 `heretic` 按别名落到 Bonsai 槽位（模型已升级为 Swift-Bonsai-2）。
    #[serde(alias = "heretic")]
    Bonsai,
    /// 旧配置里的 `swift`（Swift PQ2 已清退）按别名落到 Saluki 槽位。
    #[serde(alias = "swift")]
    Saluki,
}

impl Fast27bModel {
    pub fn label(self) -> &'static str {
        match self {
            Self::Bonsai => "Bonsai 27B",
            Self::Saluki => "Saluki 27B",
        }
    }

    /// BAT 启动器中的草稿方案：Bonsai 使用 DFlash2，Saluki 使用 MTP。
    pub fn spec(self) -> &'static str {
        match self {
            Self::Bonsai => "dflash2",
            Self::Saluki => "mtp",
        }
    }

    /// 每请求逻辑上下文上限。
    ///
    /// 开环之后设备池不再等于上下文：真正的窗口由 `--kvmem-budget + --kvmem-gen-reserve`
    /// 决定（Bonsai 66,560 / Saluki 55,296），`--max-context` 只写到模型原生上限。
    /// 所以两个模型都走 262,144，具体窗口在启动参数里按模型收口。
    pub fn max_context_window(self) -> u32 {
        262144
    }

    /// 调优后的 KV 格式（bonsai.bat / saluki.bat 的实测档位）。
    pub fn kv_dtype(self) -> &'static str {
        match self {
            Self::Bonsai => "rk8v4",
            Self::Saluki => "int8",
        }
    }

    /// 设备 KV 池 B（`--kvmem-budget`）。
    pub fn kvmem_budget(self) -> u32 {
        match self {
            Self::Bonsai => 65536,
            Self::Saluki => 54272,
        }
    }

    /// 每轮追加工作区 R（`--kvmem-gen-reserve`）。
    pub fn kvmem_gen_reserve(self) -> u32 {
        1024
    }

    /// Host KV 载荷预算 MiB（`--kvmem-host-mib`）。
    pub fn kvmem_host_mib(self) -> u32 {
        8192
    }

    /// 常驻前缀 / 后缀 token（`--kvmem-sink-tokens` / `--kvmem-recent-tokens`）。
    pub fn kvmem_sink_tokens(self) -> u32 {
        512
    }

    pub fn kvmem_recent_tokens(self) -> u32 {
        64
    }

    /// 预填充分块（Bonsai balanced 1024，Saluki 512）。
    pub fn prefill_chunk(self) -> u32 {
        match self {
            Self::Bonsai => 1024,
            Self::Saluki => 512,
        }
    }

    /// 与 `--spec` 配套的 ngram 草稿宽度（`--ngram-draft-tokens`）。
    pub fn ngram_draft_tokens(self) -> u32 {
        match self {
            Self::Bonsai => 15,
            Self::Saluki => 0,
        }
    }

    /// 调优后的草稿宽度（Bonsai balanced k6，Saluki k2）。
    pub fn draft_tokens(self) -> u32 {
        match self {
            Self::Bonsai => 6,
            Self::Saluki => 2,
        }
    }

    /// Bonsai balanced 档启用 cuBLAS 宽预填；Saluki 的 bat 不开。
    pub fn prefill_cublas(self) -> bool {
        matches!(self, Self::Bonsai)
    }

    /// Bonsai balanced 档启用满输出头草稿；Saluki 不启用。
    pub fn full_draft_head(self) -> bool {
        matches!(self, Self::Bonsai)
    }

    /// OpenAI 端点的模型 id（`--model-id` 下发值 = `/v1/models` 回报值）。
    pub fn model_id(self) -> &'static str {
        match self {
            Self::Bonsai => "bonsai",
            Self::Saluki => "saluki",
        }
    }

    /// 默认推理力度（`--default-reasoning-effort`）。两份 bat 都固定 low。
    pub fn default_reasoning_effort(self) -> &'static str {
        "low"
    }

    /// 当前调优后的模型文件名（按优先级探测）。
    fn filenames(self) -> &'static [&'static str] {
        match self {
            Self::Bonsai => &["Swift-Bonsai-2-27B-PQ2-MTP-DFlash2-v3.ninfer"],
            Self::Saluki => &["Qwen3.8-27B-Saluki-Swift-1.5-mix2-mtp.ninfer"],
        }
    }

    /// 旧版模型文件名：已存在的旧路径会被自动替换为上面的当前文件名。
    fn legacy_filenames(self) -> &'static [&'static str] {
        match self {
            Self::Bonsai => &["Ternary-Bonsai-2-27B-Heretic.ninfer"],
            Self::Saluki => &[
                "Underdog-Saluki-27B-1.0-IQ2-mix-ninfer-v3.ninfer",
                "Underdog-Saluki-27B-1.0-IQ2-mix.ninfer",
            ],
        }
    }

    fn matches_filename(self, path: &Path, names: &'static [&'static str]) -> bool {
        path.file_name()
            .and_then(|name| name.to_str())
            .map(|name| {
                names
                    .iter()
                    .any(|candidate| candidate.eq_ignore_ascii_case(name))
            })
            .unwrap_or(false)
    }

    fn is_legacy_path(self, path: &Path) -> bool {
        self.matches_filename(path, self.legacy_filenames())
            // 已清退的 Swift PQ2 文件（旧 Saluki 槽位曾指向它）。
            // 只认 swift_pq2 这个已清退文件名；新的 Saluki 文件名里也含 "Swift"，不能误判。
            || (self == Self::Saluki
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(|name| name.to_ascii_lowercase().contains("swift_pq2"))
                    .unwrap_or(false))
    }
}

/// fast-27b 引擎（Bonsai / Saluki 27B）接入配置。
/// 默认值与 D:\Projects\fast-llm\run 下的 bonsai.bat / saluki.bat 保持一致；
/// api_key 为本地明文（仅本机/局域网使用）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Fast27bConfig {
    /// 是否启用（停用后页面显示停用态，禁止启动引擎）。
    pub enabled: bool,
    /// ninfer-serve.exe 绝对路径。
    pub engine_path: String,
    /// .ninfer 模型权重文件绝对路径。
    pub model_path: String,
    /// 模型类型；None 兼容只有 model_path 的旧配置。
    pub selected_model: Option<Fast27bModel>,
    /// 分别保存两个模型的自定义路径，切换时不覆盖另一个模型的路径。
    /// `swift_model_path` 是清退 Swift 前的旧字段名，读旧配置时自动落到 Saluki；
    /// `heretic_model_path` 是 Bonsai 升级前的旧字段名，读旧配置时自动落到 Bonsai。
    #[serde(alias = "swift_model_path")]
    pub saluki_model_path: String,
    #[serde(alias = "heretic_model_path")]
    pub bonsai_model_path: String,
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
}

impl Default for Fast27bConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            engine_path: String::from(r"D:\Projects\fast-llm\run\engine\ninfer-serve.exe"),
            model_path: String::from(
                r"D:\Projects\fast-llm\models\Swift-Bonsai-2-27B-PQ2-MTP-DFlash2-v3.ninfer",
            ),
            selected_model: None,
            saluki_model_path: String::new(),
            bonsai_model_path: String::new(),
            port: 8094,
            lan: false,
            // 本地 Bearer Key 每次全新配置随机生成；旧配置里已保存的 Key 不受影响。
            api_key: generate_local_api_key(),
            context_window: 262144,
            draft_tokens: 6,
            default_max_tokens: 10240,
            default_thinking_budget: 1024,
            bridge_port: 8095,
        }
    }
}

/// 智慧模型的两个调优变体：S（Gyro-S）与 M（Gyro-M）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StrataModel {
    S,
    M,
}

impl StrataModel {
    pub fn label(self) -> &'static str {
        match self {
            Self::S => "S 模型",
            Self::M => "M 模型",
        }
    }

    /// 界面上的短名称（胶囊按钮）。
    pub fn short_label(self) -> &'static str {
        match self {
            Self::S => "S",
            Self::M => "M",
        }
    }

    /// 模型展示名（`/health` 未回报时的兜底）。
    pub fn display_name(self) -> &'static str {
        match self {
            Self::S => "Qwen3.8-Flash-Next（Gyro-S）",
            Self::M => "Qwen3.8-Flash-Next（Gyro-M · ABL）",
        }
    }

    /// strata launch 生成的 run config 文件名（按优先级探测）。
    fn config_filenames(self) -> &'static [&'static str] {
        match self {
            Self::S => &["gyro-s-100k.json"],
            Self::M => &["gyro-m-abl-100k.json", "gyro-m-32k.json", "gyro-m-abl-32k.json"],
        }
    }
}

/// 智慧模型（Strata 引擎）接入配置。
///
/// 与 fast-27b 的区别：strata 的推理内核（`strata.exe`）不能直接对外提供 OpenAI 接口，
/// 必须由它自带的 Python 网关 `serve.server` 托管——网关拉起内核、做 chat template 与
/// 工具解析，再对外暴露 `/v1/chat/completions`。因此本配置同时记录「Python 解释器」
/// 「源码目录」与「启动配置」三项，而不是像 fast-27b 那样只记一个引擎路径。
///
/// 服务端参数（上下文、KV、专家驻留、mmap 等）全部写在 `config_path` 指向的
/// run config json 里，由 strata 自己的 `launch` 生成，应用不复制、不改写这些数值；
/// 应用只覆盖 `--host` / `--port` / `--api-key` 三项网络参数（实测 CLI 参数优先于
/// config 内的同名字段）。S/M 两个变体各自对应一份 run config，切换模型只切换路径。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct StrataConfig {
    /// 是否启用（停用后页面显示停用态，禁止启动引擎）。
    pub enabled: bool,
    /// Python 解释器绝对路径。
    /// strata 的网关是纯标准库 + 少量第三方包（jinja2 / yaml / regex / psutil /
    /// requests / numpy / PIL），缺失时网关直接启动失败，故必须显式指定而不能靠 PATH。
    pub python_path: String,
    /// strata 源码目录（`serve/` 与 `strata_control/` 所在处）。子进程以它为工作目录，
    /// `-m serve.server` 与 `component:strata-engine` 的组件解析都依赖这个 cwd。
    pub work_dir: String,
    /// 当前生效的启动配置（strata launch 生成的 run config json）。含 exe、args、
    /// tokenizer、model_name 与引擎日志路径；应用只读取不写入。
    pub config_path: String,
    /// 当前模型变体；None 兼容只有 config_path 的旧配置（按文件名识别）。
    pub selected_model: Option<StrataModel>,
    /// S / M 两个变体各自的 run config 路径，切换时不覆盖另一个模型的路径。
    pub s_config_path: String,
    pub m_config_path: String,
    /// 服务端口。默认 8082：避开主模型 8080、向量服务 8081、fast-27b 8094。
    pub port: u16,
    /// true = 0.0.0.0（对局域网开放）；false = 仅 127.0.0.1。
    pub lan: bool,
    /// API Key（OpenAI 兼容接口 Bearer 鉴权，本地明文存储）。
    pub api_key: String,
    /// 加载超时（秒）。首次加载 100K 上下文 + 90GiB MoE 实测约 18 分钟，
    /// 权重进了系统缓存后热启动约 30 秒；超时值必须按首次加载留足余量。
    pub ready_timeout_secs: u64,
    /// 附加给 `serve.server` 的参数（如 `--lazy` / `--parallel 2`），留空即用网关默认。
    /// 应用不做白名单过滤，也不替你补默认值——排障基线必须显式、可复现。
    pub extra_args: Vec<String>,
}

/// 本机 `%LOCALAPPDATA%` 下的默认路径；拿不到环境变量就留空，让界面提示用户手填。
/// 不在源码里写死用户名与盘符：仓库是公开的，且换机器后路径本来就不成立。
fn local_appdata_path(relative: &str) -> String {
    std::env::var("LOCALAPPDATA")
        .map(|base| format!("{base}\\{relative}"))
        .unwrap_or_default()
}

/// 为本地网关生成一个随机 Bearer Key（32 位十六进制）。
///
/// 只用于 127.0.0.1 / 局域网内的本地服务，不参与任何远端认证；用 `RandomState`
/// 的随机种子而不是硬编码常量，避免公开仓库里出现一个所有部署共用的固定 Key。
fn generate_local_api_key() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};

    let mut key = String::with_capacity(32);
    for index in 0..2u8 {
        let mut hasher = RandomState::new().build_hasher();
        // 同一线程的两次 RandomState 种子相同；混入序号，避免两半完全相同。
        hasher.write_u8(index);
        hasher.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0),
        );
        hasher.write_u32(std::process::id());
        key.push_str(&format!("{:016x}", hasher.finish()));
    }
    key
}

impl Default for StrataConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            python_path: local_appdata_path(r"Programs\Python\Python312\python.exe"),
            // strata 源码目录没有通用默认位置，必须由用户指定。
            work_dir: String::new(),
            config_path: local_appdata_path(r"Strata\launch\gyro-m-abl-100k.json"),
            selected_model: None,
            s_config_path: local_appdata_path(r"Strata\launch\gyro-s-100k.json"),
            m_config_path: local_appdata_path(r"Strata\launch\gyro-m-abl-100k.json"),
            port: 8082,
            lan: false,
            api_key: format!("strata-local-{}", generate_local_api_key()),
            ready_timeout_secs: 1800,
            extra_args: Vec::new(),
        }
    }
}

impl StrataConfig {
    /// 网关对外的 OpenAI 兼容基址。
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}/v1", self.port)
    }

    pub fn selected_model(&self) -> StrataModel {
        self.selected_model.unwrap_or_else(|| {
            if self.config_path.to_ascii_lowercase().contains("gyro-s") {
                StrataModel::S
            } else {
                StrataModel::M
            }
        })
    }

    /// 一键切换的纯配置变换：保存离开的模型路径，复用目标路径，其他参数保持原值。
    pub fn with_selected_model(&self, model: StrataModel) -> Self {
        let target_path = self.config_path_for(model);
        let mut config = self.clone();
        match self.selected_model() {
            StrataModel::S => config.s_config_path = self.config_path.clone(),
            StrataModel::M => config.m_config_path = self.config_path.clone(),
        }
        config.selected_model = Some(model);
        config.config_path = target_path.clone();
        match model {
            StrataModel::S => config.s_config_path = target_path,
            StrataModel::M => config.m_config_path = target_path,
        }
        config
    }

    /// 当前路径与显式保存的槽位优先；未配置的变体到 `%LOCALAPPDATA%\Strata\launch`
    /// 下按文件名探测，不新建配置、不改写引擎参数。
    pub fn config_path_for(&self, model: StrataModel) -> String {
        if model == self.selected_model() && !self.config_path.trim().is_empty() {
            return self.config_path.clone();
        }
        let saved = match model {
            StrataModel::S => &self.s_config_path,
            StrataModel::M => &self.m_config_path,
        };
        if !saved.trim().is_empty() {
            return saved.clone();
        }
        if let Some(directory) = Path::new(&self.config_path).parent() {
            for name in model.config_filenames() {
                let candidate = directory.join(name);
                if candidate.is_file() {
                    return candidate.to_string_lossy().to_string();
                }
            }
        }
        local_appdata_path(&format!(
            r"Strata\launch\{}",
            model.config_filenames().first().copied().unwrap_or_default()
        ))
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

    /// 启动用引擎路径：旧离线包 `ninfer-serve-86.exe` 不支持 KVMem 参数，
    /// 若同一机器上存在调优后的 `ninfer-serve.exe` 则自动切换；否则保持用户配置。
    pub fn engine_path_for_launch(&self) -> String {
        let saved = self.engine_path.trim();
        if saved.is_empty() {
            return String::new();
        }
        let saved_path = Path::new(saved);
        let is_legacy = saved_path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.eq_ignore_ascii_case("ninfer-serve-86.exe"))
            .unwrap_or(false);
        if saved_path.is_file() && !is_legacy {
            return saved.to_string();
        }

        let mut candidates = Vec::new();
        if let Some(parent) = saved_path.parent() {
            candidates.push(parent.join("ninfer-serve.exe"));
            if let Some(root) = parent.parent() {
                candidates.push(root.join("run").join("engine").join("ninfer-serve.exe"));
            }
        }
        candidates.push(PathBuf::from(r"D:\Projects\fast-llm\run\engine\ninfer-serve.exe"));
        candidates.push(PathBuf::from(
            r"D:\Projects\fast-llm\engine\infer-engine-sm86-20261019\engine\ninfer-serve.exe",
        ));
        if let Some(found) = candidates.iter().find(|path| path.is_file()) {
            return found.to_string_lossy().to_string();
        }
        saved.to_string()
    }

    pub fn selected_model(&self) -> Fast27bModel {
        self.selected_model.unwrap_or_else(|| {
            let path = self.model_path.to_ascii_lowercase();
            // `swift` 是已清退的 Swift PQ2 文件名，旧配置仍可能带着它；两者都算 Saluki 槽位。
            if path.contains("saluki") || path.contains("swift") {
                Fast27bModel::Saluki
            } else {
                Fast27bModel::Bonsai
            }
        })
    }

    /// 一键切换的纯配置变换：保存离开的模型路径，复用目标路径，其他参数保持原值。
    pub fn with_selected_model(&self, model: Fast27bModel) -> Self {
        let target_path = self.model_path_for(model);
        let mut config = self.clone();
        match self.selected_model() {
            Fast27bModel::Bonsai => config.bonsai_model_path = self.model_path.clone(),
            Fast27bModel::Saluki => config.saluki_model_path = self.model_path.clone(),
        }
        config.selected_model = Some(model);
        config.model_path = target_path.clone();
        match model {
            Fast27bModel::Bonsai => config.bonsai_model_path = target_path,
            Fast27bModel::Saluki => config.saluki_model_path = target_path,
        }
        // 草稿宽度跟随模型调优档位，避免切模型后沿用上一件的 k 值。
        config.draft_tokens = model.draft_tokens();
        config
    }

    /// 当前路径及显式保存的路径优先；旧版模型文件名会被自动替换为当前调优文件。
    ///
    /// 只有「已知旧文件名」才做替换：用户自己改过名的自定义路径原样保留，避免
    /// 静默改写排障基线。探测只读文件系统，不下载、不改参数。
    pub fn model_path_for(&self, model: Fast27bModel) -> String {
        let active = model == self.selected_model();
        let saved = if active {
            self.model_path.as_str()
        } else {
            match model {
                Fast27bModel::Bonsai => self.bonsai_model_path.as_str(),
                Fast27bModel::Saluki => self.saluki_model_path.as_str(),
            }
        };
        let saved_path = Path::new(saved);
        let saved_trimmed = saved.trim();
        if !saved_trimmed.is_empty() && !model.is_legacy_path(saved_path) {
            return saved_trimmed.to_string();
        }

        // 旧文件名：优先找同目录/常见模型库里的当前文件，找不到再退回旧路径。
        let current = PathBuf::from(&self.model_path);
        let engine = PathBuf::from(&self.engine_path);
        let mut directories = Vec::new();
        if let Some(parent) = current.parent() {
            directories.push(parent.to_path_buf());
        }
        if !saved_trimmed.is_empty() {
            if let Some(parent) = saved_path.parent() {
                directories.push(parent.to_path_buf());
            }
        }
        if let Some(root) = engine.parent().and_then(|parent| parent.parent()) {
            directories.push(root.join("models"));
            directories.push(root.join("model"));
        }
        // 本机已有的模型库；仍优先使用当前配置旁的离线资源。
        directories.push(PathBuf::from(r"D:\Projects\fast-llm\models"));
        directories.push(PathBuf::from(r"D:\Projects\fast-llm\model"));
        // 旧版离线资源目录（Bonsai 升级前放在这里）。
        directories.push(PathBuf::from(
            r"D:\Projects\Agent_LLM\app\resources\fast-llm\model",
        ));
        directories.push(PathBuf::from(r"D:\LLM"));

        let mut seen = Vec::new();
        let candidates: Vec<_> = directories
            .into_iter()
            .filter(|directory| {
                let key = directory.to_string_lossy().to_ascii_lowercase();
                if seen.contains(&key) {
                    false
                } else {
                    seen.push(key);
                    true
                }
            })
            .flat_map(|directory| {
                model
                    .filenames()
                    .iter()
                    .map(move |name| directory.join(name))
            })
            .collect();
        if let Some(found) = candidates.iter().find(|path| path.is_file()) {
            return found.to_string_lossy().to_string();
        }
        if !saved_trimmed.is_empty() && saved_path.is_file() {
            return saved_trimmed.to_string();
        }
        candidates
            .first()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_else(|| saved_trimmed.to_string())
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
        assert_eq!(config.selected_model(), Fast27bModel::Bonsai);
        assert_eq!(
            config.model_path_for(Fast27bModel::Bonsai),
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
        assert_eq!(config.default_thinking_budget, 1024);
        // 新字段默认补齐，旧 ctx/draft/output 不迁移、不覆写；1024 的默认预算小于 4096 输出上限。
        assert!(config.validate_thinking_budget().is_ok());
    }

    #[test]
    fn thinking_budget_defaults_roundtrip_and_validation() {
        let config = Fast27bConfig::default();
        assert_eq!(config.default_thinking_budget, 1024);
        assert_eq!(config.default_max_tokens, 10240);
        assert_eq!(config.draft_tokens, 6);
        assert!(config.validate_thinking_budget().is_ok());
        assert_eq!(Fast27bModel::Bonsai.spec(), "dflash2");
        assert_eq!(Fast27bModel::Saluki.spec(), "mtp");
        for (output, budget, valid) in [
            (10240, 1024, true),
            (1024, 1024, false),
            (512, 1024, false),
            (1, 0, true),
            (0, 1024, true),
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
            selected_model: Some(Fast27bModel::Saluki),
            saluki_model_path: "custom/renamed.ninfer".into(),
            bonsai_model_path: "custom/bonsai-old.ninfer".into(),
            ..Fast27bConfig::default()
        };
        assert_eq!(config.selected_model(), Fast27bModel::Saluki);
        assert_eq!(
            config.model_path_for(Fast27bModel::Saluki),
            "custom/renamed.ninfer"
        );
        assert_eq!(
            config.model_path_for(Fast27bModel::Bonsai),
            "custom/bonsai-old.ninfer"
        );
        let roundtrip: Fast27bConfig =
            serde_json::from_str(&serde_json::to_string(&config).unwrap()).unwrap();
        assert_eq!(roundtrip.selected_model(), Fast27bModel::Saluki);
    }

    #[test]
    fn selecting_model_only_changes_model_selection_and_remembers_both_paths() {
        let original = Fast27bConfig {
            model_path: "custom/bonsai.ninfer".into(),
            saluki_model_path: "custom/saluki-renamed.ninfer".into(),
            context_window: 65536,
            draft_tokens: 6,
            default_max_tokens: 12000,
            default_thinking_budget: 4096,
            port: 9104,
            lan: true,
            bridge_port: 9105,
            ..Fast27bConfig::default()
        };
        let switched = original.with_selected_model(Fast27bModel::Saluki);
        assert_eq!(switched.selected_model(), Fast27bModel::Saluki);
        assert_eq!(switched.model_path, "custom/saluki-renamed.ninfer");
        assert_eq!(switched.bonsai_model_path, original.model_path);
        assert_eq!(switched.saluki_model_path, switched.model_path);
        assert_eq!(switched.draft_tokens, Fast27bModel::Saluki.draft_tokens());
        let mut restored = switched.with_selected_model(Fast27bModel::Bonsai);
        assert_eq!(restored.model_path, original.model_path);
        assert_eq!(restored.saluki_model_path, "custom/saluki-renamed.ninfer");
        // 将预期的选择/路径字段归回原值，所有其余保存参数必须逐字段完全相同。
        restored.selected_model = original.selected_model;
        restored.bonsai_model_path = original.bonsai_model_path.clone();
        restored.draft_tokens = original.draft_tokens;
        assert_eq!(
            serde_json::to_value(&restored).unwrap(),
            serde_json::to_value(&original).unwrap()
        );
        let unchanged = switched.with_selected_model(Fast27bModel::Saluki);
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
        assert_eq!(config.selected_model(), Fast27bModel::Saluki);
    }

    #[test]
    fn legacy_heretic_config_loads_into_bonsai_slot() {
        // 旧 config.json 里的 "selected_model":"heretic" 与 "heretic_model_path" 必须能读进来：
        // 前者落到 Bonsai 变体，后者落到 bonsai_model_path 字段。
        let config: Fast27bConfig = serde_json::from_str(
            r#"{"selected_model":"heretic","heretic_model_path":"models/Ternary-Bonsai-2-27B-Heretic.ninfer","context_window":65536}"#,
        )
        .unwrap();
        assert_eq!(config.selected_model(), Fast27bModel::Bonsai);
        assert_eq!(
            config.bonsai_model_path,
            "models/Ternary-Bonsai-2-27B-Heretic.ninfer"
        );
        // 写回时使用新字段名，不再产出 heretic_model_path。
        let json = serde_json::to_string(&config).unwrap();
        assert!(json.contains("bonsai_model_path"));
        assert!(!json.contains("heretic_model_path"));
        assert!(json.contains("\"bonsai\""));
    }

    #[test]
    fn legacy_swift_config_loads_into_saluki_slot() {
        // 旧 config.json 里的 "selected_model":"swift" 与 "swift_model_path" 必须能读进来：
        // 前者落到 Saluki 变体，后者落到 saluki_model_path 字段。
        let config: Fast27bConfig = serde_json::from_str(
            r#"{"selected_model":"swift","swift_model_path":"models/bonsai2_27b_swift_pq2.v3.ninfer","context_window":65536}"#,
        )
        .unwrap();
        assert_eq!(config.selected_model(), Fast27bModel::Saluki);
        assert_eq!(
            config.saluki_model_path,
            "models/bonsai2_27b_swift_pq2.v3.ninfer"
        );
        // 写回时使用新字段名，不再产出 swift_model_path。
        let json = serde_json::to_string(&config).unwrap();
        assert!(json.contains("saluki_model_path"));
        assert!(!json.contains("swift_model_path"));
        assert!(json.contains("\"saluki\""));
    }

    #[test]
    fn stale_swift_slot_path_falls_back_to_saluki_probe() {
        // 用户的旧配置里 saluki 槽位还是已清退的 Swift 路径（文件不存在）：
        // 切到 Saluki 时不能把该路径原样交出去，否则启动校验报「未找到模型文件」。
        let config = Fast27bConfig {
            selected_model: Some(Fast27bModel::Bonsai),
            model_path: "custom/bonsai.ninfer".into(),
            saluki_model_path: r"D:\Projects\fast-llm\model\bonsai2_27b_swift_pq2.v3.ninfer".into(),
            ..Fast27bConfig::default()
        };
        let resolved = config.model_path_for(Fast27bModel::Saluki);
        assert_ne!(resolved.to_ascii_lowercase(), config.saluki_model_path.to_ascii_lowercase());
        assert!(
            resolved.to_ascii_lowercase().contains("saluki"),
            "应探测到 Saluki 文件，实际为 {resolved}"
        );
    }
}

#[cfg(test)]
mod strata_config_tests {
    use super::*;

    #[test]
    fn switching_s_and_m_keeps_both_run_configs() {
        let original = StrataConfig {
            config_path: r"C:\launch\gyro-m-abl-100k.json".into(),
            selected_model: Some(StrataModel::M),
            m_config_path: r"C:\launch\gyro-m-abl-100k.json".into(),
            s_config_path: r"C:\launch\gyro-s-100k.json".into(),
            port: 8082,
            ..StrataConfig::default()
        };
        let switched = original.with_selected_model(StrataModel::S);
        assert_eq!(switched.selected_model(), StrataModel::S);
        assert_eq!(switched.config_path, original.s_config_path);
        assert_eq!(switched.m_config_path, original.m_config_path);
        let restored = switched.with_selected_model(StrataModel::M);
        assert_eq!(restored.selected_model(), StrataModel::M);
        assert_eq!(restored.config_path, original.config_path);
        assert_eq!(restored.s_config_path, original.s_config_path);
        assert_eq!(
            serde_json::to_value(&restored).unwrap(),
            serde_json::to_value(&original).unwrap()
        );
    }

    #[test]
    fn legacy_strata_config_infers_model_from_run_config_name() {
        let config: StrataConfig =
            serde_json::from_str(r#"{"config_path":"C:\\launch\\gyro-s-100k.json"}"#).unwrap();
        assert_eq!(config.selected_model(), StrataModel::S);
        let config: StrataConfig =
            serde_json::from_str(r#"{"config_path":"C:\\launch\\gyro-m-abl-100k.json"}"#).unwrap();
        assert_eq!(config.selected_model(), StrataModel::M);
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
