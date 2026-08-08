use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PingResult {
    pub reachable: bool,
    pub latency_ms: Option<u64>,
    pub status_code: Option<u16>,
    pub health_ok: bool,
    pub models_ok: bool,
    pub models: Vec<String>,
    /// 本机健康检查使用的地址。
    pub base_url: Option<String>,
    /// 局域网客户端实际可使用的地址；仅当前进程对外监听时返回。
    pub external_base_url: Option<String>,
    pub bind_host: Option<String>,
    pub api_key_required: bool,
    pub protocol_standards: Vec<String>,
    pub error: Option<String>,
}

impl PingResult {
    pub fn unavailable(error: impl Into<String>) -> Self {
        Self {
            reachable: false,
            latency_ms: None,
            status_code: None,
            health_ok: false,
            models_ok: false,
            models: Vec::new(),
            base_url: None,
            external_base_url: None,
            bind_host: None,
            api_key_required: false,
            protocol_standards: Vec::new(),
            error: Some(error.into()),
        }
    }
}
