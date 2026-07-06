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
            error: Some(error.into()),
        }
    }
}
