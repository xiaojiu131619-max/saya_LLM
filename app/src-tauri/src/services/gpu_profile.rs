//! 显卡档案：更新中心判断「本机该装哪个发行包」的唯一依据。
//!
//! 现有探测能拿到：DXGI VendorId → 厂商、显卡型号名、nvidia-smi 的 CUDA 版本、
//! Blackwell 型号启发式、AMD 的 HIP 支持等级。缺的是 **AMD 架构**——官方发行包
//! 按 RDNA2 / RDNA3 / RDNA4 分档，只按「支持/未验证」分不出来。
//!
//! 这里补上架构归类，并把结论缓存一次：显卡热插拔不在本应用的考虑范围内，
//! 每次检查更新都去跑 DXGI + nvidia-smi 只会拖慢界面。

use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde::Serialize;

use crate::services::auto_updater;
use crate::services::gpu_monitor::{self, GpuVendor};

/// AMD 消费级架构分档。官方引擎包按它区分 HIP 构建。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AmdArch {
    Rdna2,
    Rdna3,
    Rdna4,
    Other,
}

impl AmdArch {
    pub fn label(self) -> &'static str {
        match self {
            AmdArch::Rdna2 => "RDNA2",
            AmdArch::Rdna3 => "RDNA3",
            AmdArch::Rdna4 => "RDNA4",
            AmdArch::Other => "未识别架构",
        }
    }
}

/// 按型号名归类 AMD 架构。
///
/// 只做名称匹配：Windows 上没有可靠的通用接口读 AMD 的 gfx 型号，PCI ID 表又会
/// 随新卡发行而过期。RX 9000 / 7000 / 6000 的命名是稳定的，其余一律 Other
/// （核显、Vega、Instinct、专业卡都走「不适用」而不是猜一个）。
pub fn classify_amd_arch(name: &str) -> AmdArch {
    let normalized = name.to_ascii_lowercase();
    if normalized.contains("graphics") || normalized.contains("vega") || normalized.contains("instinct") {
        return AmdArch::Other;
    }
    // 顺序重要：先判 9 系，避免 "rx 9070" 之类被更宽的前缀吃掉。
    if normalized.contains("rx 9") {
        return AmdArch::Rdna4;
    }
    if normalized.contains("rx 7") {
        return AmdArch::Rdna3;
    }
    if normalized.contains("rx 6") {
        return AmdArch::Rdna2;
    }
    AmdArch::Other
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuProfile {
    /// `nvidia` / `amd` / `intel` / `unknown`。
    pub vendor: String,
    pub vendor_label: String,
    pub name: Option<String>,
    /// 驱动支持的 CUDA 主版本（nvidia-smi 的 `CUDA Version`）。
    pub cuda_major: Option<u32>,
    pub is_blackwell: bool,
    pub amd_arch: Option<AmdArch>,
}

impl GpuProfile {
    pub fn is_nvidia(&self) -> bool {
        self.vendor == "nvidia"
    }

    pub fn is_amd(&self) -> bool {
        self.vendor == "amd"
    }
}

static CACHE: Lazy<Mutex<Option<GpuProfile>>> = Lazy::new(|| Mutex::new(None));

/// 取本机显卡档案；首次调用做探测，之后读缓存。
pub fn current() -> GpuProfile {
    if let Some(cached) = CACHE.lock().ok().and_then(|guard| guard.clone()) {
        return cached;
    }
    let detected = detect();
    if let Ok(mut guard) = CACHE.lock() {
        *guard = Some(detected.clone());
    }
    detected
}

fn detect() -> GpuProfile {
    // 多卡时取优先级最高的一张：独显优先，NVIDIA > AMD > Intel。
    let vendors = gpu_monitor::detect_display_vendors();
    let picked = vendors
        .iter()
        .max_by_key(|(vendor, _)| match vendor {
            GpuVendor::Nvidia => 3,
            GpuVendor::Amd => 2,
            GpuVendor::Intel => 1,
            GpuVendor::Other => 0,
        })
        .cloned();

    let (vendor, name) = match picked {
        Some((vendor, name)) => (vendor_key(vendor).to_string(), Some(name)),
        None => ("unknown".to_string(), None),
    };

    let cuda_major = if vendor == "nvidia" {
        auto_updater::detect_cuda_version().and_then(|raw| parse_cuda_major(&raw))
    } else {
        None
    };
    let is_blackwell = vendor == "nvidia" && auto_updater::is_blackwell_gpu(name.as_deref());
    let amd_arch = if vendor == "amd" {
        name.as_deref().map(classify_amd_arch)
    } else {
        None
    };

    GpuProfile {
        vendor_label: vendor_label(&vendor).to_string(),
        vendor,
        name,
        cuda_major,
        is_blackwell,
        amd_arch,
    }
}

fn vendor_key(vendor: GpuVendor) -> &'static str {
    match vendor {
        GpuVendor::Nvidia => "nvidia",
        GpuVendor::Amd => "amd",
        GpuVendor::Intel => "intel",
        GpuVendor::Other => "unknown",
    }
}

fn vendor_label(vendor: &str) -> &'static str {
    match vendor {
        "nvidia" => "NVIDIA",
        "amd" => "AMD",
        "intel" => "Intel",
        _ => "未知",
    }
}

fn parse_cuda_major(raw: &str) -> Option<u32> {
    raw.trim()
        .split('.')
        .next()
        .and_then(|major| major.trim().parse::<u32>().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_current_generation_amd_cards() {
        assert_eq!(classify_amd_arch("AMD Radeon RX 9070 XT"), AmdArch::Rdna4);
        assert_eq!(classify_amd_arch("AMD Radeon RX 7900 XTX"), AmdArch::Rdna3);
        assert_eq!(classify_amd_arch("AMD Radeon RX 6800 XT"), AmdArch::Rdna2);
    }

    #[test]
    fn leaves_igpu_and_older_cards_unclassified() {
        assert_eq!(classify_amd_arch("AMD Radeon(TM) Graphics"), AmdArch::Other);
        assert_eq!(classify_amd_arch("AMD Radeon RX 5700 XT"), AmdArch::Other);
        assert_eq!(classify_amd_arch("AMD Radeon Vega 8"), AmdArch::Other);
        assert_eq!(classify_amd_arch("AMD Instinct MI300X"), AmdArch::Other);
    }

    #[test]
    fn parses_cuda_major_from_driver_string() {
        assert_eq!(parse_cuda_major("12.4"), Some(12));
        assert_eq!(parse_cuda_major(" 13.0 "), Some(13));
        assert_eq!(parse_cuda_major("unknown"), None);
    }
}
