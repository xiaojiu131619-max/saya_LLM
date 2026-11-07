use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceGpu {
    pub index: u32,
    pub name: String,
    pub vendor: String,
    pub total_vram_gb: f64,
    pub used_vram_gb: f64,
    pub utilization: f64,
    pub temperature: f64,
    pub driver_version: Option<String>,
    pub source: String,
    pub selected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceKernel {
    pub exe_path: String,
    pub exists: bool,
    pub version: Option<String>,
    pub runtime_backend: Option<String>,
    pub host_backend: Option<String>,
    pub runtime_devices: Vec<String>,
    pub cuda_version: Option<String>,
    pub sm_architecture: Option<String>,
    pub cuda_graphs_enabled: bool,
    pub features: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceModelDir {
    pub path: String,
    pub exists: bool,
    pub free_gb: Option<f64>,
    pub total_gb: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRecommendations {
    /// 自动调参使用的整卡显存预算（90%）。
    pub vram_budget_gb: f64,
    /// 90% 预算扣除当前已用显存后的可分配空间。
    pub vram_headroom_gb: f64,
    /// 建议的 CPU 线程数（物理核心）。
    pub recommended_threads: u32,
    /// 建议的单模型上下文；仍以用户设置为准。
    pub recommended_ctx: u32,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceProfile {
    pub hostname: String,
    pub os_name: String,
    pub os_version: String,
    pub arch: String,
    pub cpu_brand: String,
    pub physical_cores: u32,
    pub logical_cores: u32,
    pub memory_total_gb: f64,
    pub memory_available_gb: f64,
    pub gpus: Vec<DeviceGpu>,
    pub selected_gpu: u32,
    pub gpu_vendor: String,
    pub gpu_backend: String,
    pub cuda_version: Option<String>,
    pub amd_arch: Option<String>,
    pub kernel: DeviceKernel,
    pub model_dirs: Vec<DeviceModelDir>,
    pub recommendations: DeviceRecommendations,
}
