use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HardwareInfo {
    pub gpu_name: String,
    pub total_vram: f64,
    pub used_vram: f64,
    pub utilization: f64,
    pub temperature: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemStatus {
    pub gpu_utilization: Option<f64>,
    pub vram_used: Option<f64>,
    pub vram_total: Option<f64>,
    pub memory_used: Option<f64>,
    pub memory_total: Option<f64>,
}
