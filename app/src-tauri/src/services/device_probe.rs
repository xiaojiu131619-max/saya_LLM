use nvml_wrapper::enum_wrappers::device::TemperatureSensor;
use nvml_wrapper::Nvml;
use sysinfo::{Disks, System};

use crate::models::app_state::AppConfig;
use crate::models::device_profile::*;
use crate::services::{auto_updater, gpu_monitor::GpuMonitor, gpu_profile, process_manager};

const GIB: f64 = 1024.0 * 1024.0 * 1024.0;

pub fn probe(config: &AppConfig, monitor: &mut Option<GpuMonitor>) -> DeviceProfile {
    let mut sys = System::new_all();
    sys.refresh_all();
    let cpu_brand = sys
        .cpus()
        .first()
        .map(|cpu| cpu.brand().trim().to_string())
        .filter(|brand| !brand.is_empty())
        .unwrap_or_else(|| "未知处理器".into());
    let logical_cores = sys.cpus().len().max(1) as u32;
    let physical_cores = sys
        .physical_core_count()
        .unwrap_or(logical_cores as usize)
        .max(1) as u32;
    let memory_total_gb = sys.total_memory() as f64 / GIB;
    let memory_available_gb = sys.available_memory() as f64 / GIB;

    let selected_gpu = monitor.as_ref().map(|m| m.selected_index()).unwrap_or(0);
    let hardware = monitor.as_mut().and_then(|m| m.refresh().ok());
    let gpu_names = monitor
        .as_ref()
        .map(|m| m.device_names())
        .unwrap_or_default();
    let profile = gpu_profile::current();
    let cuda_version = auto_updater::detect_cuda_version();
    let gpus = collect_gpus(
        &gpu_names,
        hardware.as_ref(),
        selected_gpu,
        profile.vendor.as_str(),
    );

    let exe = config
        .kernel_override_path
        .as_deref()
        .filter(|path| !path.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| process_manager::resolve_exe_path(&config.llama_server_path));
    let engine = crate::commands::system::check_engine_info(exe.clone());
    let features: Vec<String> = [
        ("--moe-cache-mib", "MoE 专家显存缓存"),
        ("--n-cpu-ffn", "稠密 FFN CPU 卸载"),
        ("--lazy-mode", "大张量按需读取"),
        ("--kv-unified-per-slot", "每路上下文上限"),
        ("--spec-draft-n-ubatch", "草稿物理批大小"),
        ("--swa-full", "SWA 完整缓存"),
        ("--cache-ram", "提示词缓存上限"),
        ("--mmproj-offload", "多模态投影卸载"),
    ]
    .iter()
    .filter_map(|(flag, label)| {
        process_manager::kernel_supports_feature(&engine.exe_path, flag)
            .then(|| (*label).to_string())
    })
    .collect();

    let model_dirs = collect_model_dirs(&config.model_dirs);
    let vram_total = hardware.as_ref().map(|h| h.total_vram).unwrap_or(0.0);
    let vram_used = hardware.as_ref().map(|h| h.used_vram).unwrap_or(0.0);
    let vram_budget = vram_total * 0.90;
    let mut notes = Vec::new();
    if vram_total > 0.0 {
        notes.push(format!(
            "自动调参使用整卡 90% 预算：{:.1} GB，当前可用约 {:.1} GB。",
            vram_budget,
            (vram_budget - vram_used).max(0.0)
        ));
    } else {
        notes.push("未读到显存遥测；自动调参会拒绝 GPU 候选，只能使用 CPU 配置。".into());
    }
    notes.push("自动调参固定使用你设置的上下文长度（ctx），不会为了跑通而偷偷缩短。".into());
    notes.push("显存预测会优先采用模型信息里同参数、同设备、同内核的启动记录。".into());
    if features.is_empty() {
        notes.push("当前内核未报告新参数能力；旧内核会自动跳过不支持的参数。".into());
    }

    DeviceProfile {
        hostname: System::host_name().unwrap_or_else(|| "本机".into()),
        os_name: System::name().unwrap_or_else(|| "Windows".into()),
        os_version: System::long_os_version()
            .or_else(System::os_version)
            .unwrap_or_else(|| "未读取".into()),
        arch: std::env::consts::ARCH.into(),
        cpu_brand,
        physical_cores,
        logical_cores,
        memory_total_gb,
        memory_available_gb,
        gpus,
        selected_gpu,
        gpu_vendor: if profile.vendor_label.is_empty() {
            "未知".into()
        } else {
            profile.vendor_label.clone()
        },
        gpu_backend: engine
            .runtime_backend
            .clone()
            .or_else(|| engine.host_backend.clone())
            .unwrap_or_else(|| "未检测".into()),
        cuda_version,
        amd_arch: profile.amd_arch.map(|arch| arch.label().to_string()),
        kernel: DeviceKernel {
            exe_path: engine.exe_path,
            exists: engine.binary_exists,
            version: engine.llama_server_version,
            runtime_backend: engine.runtime_backend,
            host_backend: engine.host_backend,
            runtime_devices: engine.runtime_devices,
            cuda_version: engine.cuda_version,
            sm_architecture: engine.sm_architecture,
            cuda_graphs_enabled: engine.cuda_graphs_enabled,
            features,
        },
        model_dirs,
        recommendations: DeviceRecommendations {
            vram_budget_gb: vram_budget,
            vram_headroom_gb: (vram_budget - vram_used).max(0.0),
            recommended_threads: physical_cores.min(32),
            recommended_ctx: 32_768,
            notes,
        },
    }
}

fn collect_gpus(
    names: &[String],
    hardware: Option<&crate::models::hardware_info::HardwareInfo>,
    selected: u32,
    vendor: &str,
) -> Vec<DeviceGpu> {
    if let Ok(nvml) = Nvml::init() {
        let driver = nvml.sys_driver_version().ok();
        let mut gpus = Vec::new();
        for index in 0..nvml.device_count().unwrap_or(0) {
            let Ok(device) = nvml.device_by_index(index) else {
                continue;
            };
            let name = device.name().unwrap_or_else(|_| format!("GPU {}", index));
            let memory = device.memory_info().ok();
            let utilization = device.utilization_rates().map(|u| u.gpu as f64).unwrap_or(0.0);
            let temperature = device
                .temperature(TemperatureSensor::Gpu)
                .map(|value| value as f64)
                .unwrap_or(0.0);
            gpus.push(DeviceGpu {
                index,
                name,
                vendor: vendor.to_string(),
                total_vram_gb: memory.as_ref().map(|m| m.total as f64 / GIB).unwrap_or(0.0),
                used_vram_gb: memory.as_ref().map(|m| m.used as f64 / GIB).unwrap_or(0.0),
                utilization,
                temperature,
                driver_version: driver.clone(),
                source: "NVML".into(),
                selected: index == selected,
            });
        }
        if !gpus.is_empty() {
            return gpus;
        }
    }

    if names.is_empty() {
        return Vec::new();
    }
    names
        .iter()
        .enumerate()
        .map(|(index, name)| {
            let is_selected = index as u32 == selected;
            DeviceGpu {
                index: index as u32,
                name: name.clone(),
                vendor: vendor.to_string(),
                total_vram_gb: if is_selected {
                    hardware.map(|h| h.total_vram).unwrap_or(0.0)
                } else {
                    0.0
                },
                used_vram_gb: if is_selected {
                    hardware.map(|h| h.used_vram).unwrap_or(0.0)
                } else {
                    0.0
                },
                utilization: if is_selected {
                    hardware.map(|h| h.utilization).unwrap_or(0.0)
                } else {
                    0.0
                },
                temperature: if is_selected {
                    hardware.map(|h| h.temperature).unwrap_or(0.0)
                } else {
                    0.0
                },
                driver_version: None,
                source: "DXGI/PDH".into(),
                selected: is_selected,
            }
        })
        .collect()
}

fn collect_model_dirs(paths: &[std::path::PathBuf]) -> Vec<DeviceModelDir> {
    let disks = Disks::new_with_refreshed_list();
    paths
        .iter()
        .map(|path| {
            let path_text = path.to_string_lossy().to_string();
            let exists = path.exists();
            let normalized = path_text.replace('/', "\\").to_ascii_lowercase();
            let disk = disks
                .list()
                .iter()
                .filter(|disk| {
                    let mount = disk.mount_point().to_string_lossy().to_ascii_lowercase();
                    !mount.is_empty() && normalized.starts_with(mount.trim_end_matches('\\'))
                })
                .max_by_key(|disk| disk.mount_point().as_os_str().len());
            DeviceModelDir {
                path: path_text,
                exists,
                free_gb: disk.map(|disk| disk.available_space() as f64 / GIB),
                total_gb: disk.map(|disk| disk.total_space() as f64 / GIB),
            }
        })
        .collect()
}
