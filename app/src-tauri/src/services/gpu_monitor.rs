use anyhow::{anyhow, Result};
use nvml_wrapper::enum_wrappers::device::TemperatureSensor;
use nvml_wrapper::Nvml;

use crate::models::hardware_info::HardwareInfo;
use crate::services::auto_updater::is_real_display_adapter;

/// 显卡监测：NVIDIA 走 NVML；Windows 上无 NVML 时回退 DXGI（总显存）+ PDH（已用显存 / 利用率）。
/// AMD / Intel 没有 NVML，原先会整条链路失败，前端显示「未连接」、推荐参数也读不到显存。
pub struct GpuMonitor {
    inner: GpuMonitorInner,
}

enum GpuMonitorInner {
    Nvml(NvmlMonitor),
    #[cfg(windows)]
    Windows(WindowsGpuMonitor),
}

struct NvmlMonitor {
    nvml: Nvml,
    device_index: u32,
}

impl GpuMonitor {
    pub fn new() -> Result<Self> {
        if let Ok(nvml) = NvmlMonitor::new() {
            if nvml.device_count() > 0 {
                eprintln!(
                    "[gpu] 使用 NVML 监测：{}",
                    nvml.device_names().join(" / ")
                );
                return Ok(Self {
                    inner: GpuMonitorInner::Nvml(nvml),
                });
            }
        }

        #[cfg(windows)]
        {
            if let Ok(windows) = WindowsGpuMonitor::new() {
                if windows.device_count() > 0 {
                    eprintln!(
                        "[gpu] 使用 DXGI/PDH 监测：{}",
                        windows.device_names().join(" / ")
                    );
                    return Ok(Self {
                        inner: GpuMonitorInner::Windows(windows),
                    });
                }
            }
        }

        Err(anyhow!("未检测到可用的显卡监测后端"))
    }

    pub fn device_count(&self) -> u32 {
        match &self.inner {
            GpuMonitorInner::Nvml(inner) => inner.device_count(),
            #[cfg(windows)]
            GpuMonitorInner::Windows(inner) => inner.device_count(),
        }
    }

    pub fn device_names(&self) -> Vec<String> {
        match &self.inner {
            GpuMonitorInner::Nvml(inner) => inner.device_names(),
            #[cfg(windows)]
            GpuMonitorInner::Windows(inner) => inner.device_names(),
        }
    }

    pub fn set_device(&mut self, index: u32) {
        match &mut self.inner {
            GpuMonitorInner::Nvml(inner) => inner.set_device(index),
            #[cfg(windows)]
            GpuMonitorInner::Windows(inner) => inner.set_device(index),
        }
    }

    pub fn refresh(&mut self) -> Result<HardwareInfo> {
        match &mut self.inner {
            GpuMonitorInner::Nvml(inner) => inner.refresh(),
            #[cfg(windows)]
            GpuMonitorInner::Windows(inner) => inner.refresh(),
        }
    }

    pub fn get_utilization(&self) -> Result<f64> {
        match &self.inner {
            GpuMonitorInner::Nvml(inner) => inner.get_utilization(),
            #[cfg(windows)]
            GpuMonitorInner::Windows(inner) => inner.get_utilization(),
        }
    }

    pub fn get_vram_used(&self) -> Result<f64> {
        match &self.inner {
            GpuMonitorInner::Nvml(inner) => inner.get_vram_used(),
            #[cfg(windows)]
            GpuMonitorInner::Windows(inner) => inner.get_vram_used(),
        }
    }

    pub fn get_vram_total(&self) -> Result<f64> {
        match &self.inner {
            GpuMonitorInner::Nvml(inner) => inner.get_vram_total(),
            #[cfg(windows)]
            GpuMonitorInner::Windows(inner) => inner.get_vram_total(),
        }
    }
}

impl NvmlMonitor {
    fn new() -> Result<Self> {
        let nvml = Nvml::init()?;
        Ok(Self {
            nvml,
            device_index: 0,
        })
    }

    fn device_count(&self) -> u32 {
        self.nvml.device_count().unwrap_or(0)
    }

    fn device_names(&self) -> Vec<String> {
        let count = self.device_count();
        (0..count)
            .filter_map(|i| self.nvml.device_by_index(i).ok()?.name().ok())
            .collect()
    }

    fn set_device(&mut self, index: u32) {
        self.device_index = index;
    }

    fn refresh(&mut self) -> Result<HardwareInfo> {
        let device = self.nvml.device_by_index(self.device_index)?;
        let name = device.name()?;
        let mem = device.memory_info()?;
        let utilization = device.utilization_rates()?;
        let temp = device.temperature(TemperatureSensor::Gpu)?;

        Ok(HardwareInfo {
            gpu_name: name,
            total_vram: mem.total as f64 / 1024.0 / 1024.0 / 1024.0,
            used_vram: mem.used as f64 / 1024.0 / 1024.0 / 1024.0,
            utilization: utilization.gpu as f64,
            temperature: temp as f64,
        })
    }

    fn get_utilization(&self) -> Result<f64> {
        let device = self.nvml.device_by_index(self.device_index)?;
        let utilization = device.utilization_rates()?;
        Ok(utilization.gpu as f64)
    }

    fn get_vram_used(&self) -> Result<f64> {
        let device = self.nvml.device_by_index(self.device_index)?;
        let mem = device.memory_info()?;
        Ok(mem.used as f64 / 1024.0 / 1024.0 / 1024.0)
    }

    fn get_vram_total(&self) -> Result<f64> {
        let device = self.nvml.device_by_index(self.device_index)?;
        let mem = device.memory_info()?;
        Ok(mem.total as f64 / 1024.0 / 1024.0 / 1024.0)
    }
}

/// 显卡厂商。用 PCI Vendor ID 判定（DXGI 直接给出），比显卡名称子串可靠：
/// OEM 定制名称、无品牌标识的核显、中文描述都能正确归类。
/// NVML 只有 NVIDIA 驱动才有，所以厂商判定必须能在没有 NVML 的机器上工作。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GpuVendor {
    Nvidia,
    Amd,
    Intel,
    Other,
}

impl GpuVendor {
    pub fn from_vendor_id(vendor_id: u32) -> Self {
        match vendor_id {
            0x10DE => GpuVendor::Nvidia,
            // 0x1002 = AMD/ATI；0x1022 是 AMD 的 CPU/芯片组 ID，个别核显会报这个。
            0x1002 | 0x1022 => GpuVendor::Amd,
            0x8086 | 0x8087 => GpuVendor::Intel,
            _ => GpuVendor::Other,
        }
    }

    /// 名称兜底：拿不到 VendorId 时（非 Windows、DXGI 失败）按名称判断。
    pub fn from_name(name: &str) -> Self {
        let lower = name.to_ascii_lowercase();
        if lower.contains("nvidia") || lower.contains("geforce") || lower.contains("quadro") {
            GpuVendor::Nvidia
        } else if lower.contains("amd")
            || lower.contains("radeon")
            || lower.contains("ati ")
            || lower.contains("advanced micro")
        {
            GpuVendor::Amd
        } else if lower.contains("intel") || lower.contains("arc ") || lower.contains("iris") {
            GpuVendor::Intel
        } else {
            GpuVendor::Other
        }
    }

    /// 该厂商在 llama.cpp 上优先使用的推理后端：
    /// NVIDIA → CUDA；AMD / Intel → Vulkan（Windows 上没有可用的 HIP/ROCm 通用路线）。
    pub fn preferred_backend(self) -> &'static str {
        match self {
            GpuVendor::Nvidia => "CUDA",
            GpuVendor::Amd | GpuVendor::Intel => "Vulkan",
            GpuVendor::Other => "Vulkan",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            GpuVendor::Nvidia => "NVIDIA",
            GpuVendor::Amd => "AMD",
            GpuVendor::Intel => "Intel",
            GpuVendor::Other => "其它",
        }
    }
}

#[cfg(windows)]
#[derive(Clone)]
struct DxgiAdapter {
    name: String,
    luid_key: String,
    dedicated_total_gb: f64,
    /// 共享系统内存（DXGI SharedSystemMemory）。核显/APU 的可用显存主要来自这里，
    /// 独显上这个值通常是系统内存的一半且很少真正用于推理，不能直接当显存算。
    shared_total_gb: f64,
    vendor_id: u32,
}

#[cfg(windows)]
impl DxgiAdapter {
    /// 该适配器"实际可用于推理的显存"。
    ///
    /// 独显直接用专用显存。核显（专用显存近似为 0）没有独立显存，只能动共享内存，
    /// 但共享内存是从系统 RAM 里划的、并非全部都能给 GPU 用，因此按保守比例折算——
    /// 宁可少算让用户保守设置 ngl，也不要高估导致加载即 OOM。
    fn usable_total_gb(&self) -> f64 {
        const IGPU_DEDICATED_THRESHOLD_GB: f64 = 0.5;
        /// 核显共享内存可按此比例用于推理（llama.cpp/Vulkan 常见可用比例）。
        const IGPU_SHARED_USABLE_RATIO: f64 = 0.5;
        if self.dedicated_total_gb > IGPU_DEDICATED_THRESHOLD_GB {
            self.dedicated_total_gb
        } else {
            (self.shared_total_gb * IGPU_SHARED_USABLE_RATIO).max(self.dedicated_total_gb)
        }
    }

    /// 是否以共享内存为主（核显 / APU），供 UI 与显存预测区分口径。
    fn uses_shared_memory(&self) -> bool {
        const IGPU_DEDICATED_THRESHOLD_GB: f64 = 0.5;
        self.dedicated_total_gb <= IGPU_DEDICATED_THRESHOLD_GB && self.shared_total_gb > 0.0
    }

    fn vendor(&self) -> GpuVendor {
        GpuVendor::from_vendor_id(self.vendor_id)
    }
}

#[cfg(windows)]
struct WindowsGpuMonitor {
    adapters: Vec<DxgiAdapter>,
    device_index: u32,
    query: windows::Win32::System::Performance::PDH_HQUERY,
    mem_counter: Option<windows::Win32::System::Performance::PDH_HCOUNTER>,
    util_counter: Option<windows::Win32::System::Performance::PDH_HCOUNTER>,
    /// 共享内存占用计数器。核显/APU 的显存占用几乎全在共享内存里，
    /// 只读 Dedicated Usage 会永远显示 0，导致显存预测与推荐参数失效。
    shared_mem_counter: Option<windows::Win32::System::Performance::PDH_HCOUNTER>,
}

#[cfg(windows)]
unsafe impl Send for WindowsGpuMonitor {}

#[cfg(windows)]
impl Drop for WindowsGpuMonitor {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::System::Performance::PdhCloseQuery(self.query);
        }
    }
}

#[cfg(windows)]
fn adapter_luid_key(high: i32, low: u32) -> String {
    format!("luid_0x{:08x}_0x{:08x}", high as u32, low)
}

#[cfg(windows)]
fn instance_matches_luid(instance: &str, luid_key: &str) -> bool {
    instance.to_ascii_lowercase().contains(&luid_key.to_ascii_lowercase())
}

#[cfg(windows)]
fn is_graphics_engine(instance: &str) -> bool {
    let name = instance.to_ascii_lowercase();
    name.contains("engtype_3d") || name.contains("engtype_compute") || name.contains("engtype_gfx")
}

#[cfg(windows)]
fn utf16_trim(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

#[cfg(windows)]
/// 枚举真实显示适配器（跳过软渲染、虚拟显示、无显存条目）。
///
/// 同时供显存监测与「本机有哪些 GPU / 该用哪个后端」的判定复用——
/// 厂商判定必须以 DXGI VendorId 为准，而不是显卡名称子串。
fn enumerate_display_adapters() -> Result<Vec<DxgiAdapter>> {
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE,
    };

    let adapters = unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1()
            .map_err(|error| anyhow!("CreateDXGIFactory1 失败：{error}"))?;
        let mut adapters = Vec::new();
        let mut index = 0u32;
        loop {
            match factory.EnumAdapters1(index) {
                Ok(adapter) => {
                    index += 1;
                    let desc = match adapter.GetDesc1() {
                        Ok(desc) => desc,
                        Err(_) => continue,
                    };
                    if (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32) != 0 {
                        continue;
                    }
                    let name = utf16_trim(&desc.Description);
                    if !is_real_display_adapter(&name) {
                        continue;
                    }
                    let dedicated_gb = desc.DedicatedVideoMemory as f64 / 1024.0 / 1024.0 / 1024.0;
                    let shared_gb = desc.SharedSystemMemory as f64 / 1024.0 / 1024.0 / 1024.0;
                    // 独显看专用显存；核显/APU 的专用显存为 0（或极小），只能靠共享内存，
                    // 早期在这里直接 continue 会把 AMD 核显整块丢掉——机器上明明有 GPU，
                    // 应用却报「未检测到显卡」。因此改为：专用与共享都拿不到才跳过。
                    if dedicated_gb <= 0.0 && shared_gb <= 0.0 {
                        continue;
                    }
                    adapters.push(DxgiAdapter {
                        name,
                        luid_key: adapter_luid_key(
                            desc.AdapterLuid.HighPart,
                            desc.AdapterLuid.LowPart,
                        ),
                        dedicated_total_gb: dedicated_gb,
                        shared_total_gb: shared_gb,
                        vendor_id: desc.VendorId,
                    });
                }
                Err(_) => break,
            }
        }
        adapters
    };

    Ok(adapters)
}

/// 本机显示适配器的厂商列表（按枚举顺序，独显优先由调用方决定）。
/// 拿不到时返回空 Vec，调用方回退到名称判定。
#[cfg(windows)]
pub fn detect_display_vendors() -> Vec<(GpuVendor, String)> {
    enumerate_display_adapters()
        .map(|adapters| {
            adapters
                .into_iter()
                .map(|adapter| (adapter.vendor(), adapter.name))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(not(windows))]
pub fn detect_display_vendors() -> Vec<(GpuVendor, String)> {
    Vec::new()
}

#[cfg(windows)]
impl WindowsGpuMonitor {
    fn new() -> Result<Self> {
        use windows::core::w;
        use windows::Win32::System::Performance::{
            PdhAddEnglishCounterW, PdhCollectQueryData, PdhOpenQueryW, PDH_HCOUNTER, PDH_HQUERY,
        };

        let adapters = enumerate_display_adapters()?;
        if adapters.is_empty() {
            return Err(anyhow!("DXGI 未枚举到可用的显示适配器"));
        }

        let mut query = PDH_HQUERY::default();
        unsafe {
            let status = PdhOpenQueryW(None, 0, &mut query);
            if status != 0 {
                return Err(anyhow!("PdhOpenQueryW 失败：0x{status:08x}"));
            }
        }

        let mut monitor = Self {
            adapters,
            device_index: 0,
            query,
            mem_counter: None,
            util_counter: None,
            shared_mem_counter: None,
        };

        unsafe {
            let mut mem_counter = PDH_HCOUNTER::default();
            if PdhAddEnglishCounterW(
                query,
                w!("\\GPU Adapter Memory(*)\\Dedicated Usage"),
                0,
                &mut mem_counter,
            ) == 0
            {
                monitor.mem_counter = Some(mem_counter);
            } else {
                eprintln!("[gpu] 无法添加 GPU Adapter Memory\\Dedicated Usage 计数器");
            }

            // 核显/APU 的显存占用走共享内存计数器；缺失时按 0 处理，不影响独显。
            let mut shared_counter = PDH_HCOUNTER::default();
            if PdhAddEnglishCounterW(
                query,
                w!("\\GPU Adapter Memory(*)\\Shared Usage"),
                0,
                &mut shared_counter,
            ) == 0
            {
                monitor.shared_mem_counter = Some(shared_counter);
            } else {
                eprintln!("[gpu] 无法添加 GPU Adapter Memory\\Shared Usage 计数器（核显显存占用将不可用）");
            }

            let mut util_counter = PDH_HCOUNTER::default();
            if PdhAddEnglishCounterW(
                query,
                w!("\\GPU Engine(*)\\Utilization Percentage"),
                0,
                &mut util_counter,
            ) == 0
            {
                monitor.util_counter = Some(util_counter);
            } else {
                eprintln!("[gpu] 无法添加 GPU Engine\\Utilization Percentage 计数器");
            }

            // 第一次 Collect 只建立基线；利用率要第二次才有有效差值。
            let _ = PdhCollectQueryData(query);
            std::thread::sleep(std::time::Duration::from_millis(120));
            let _ = PdhCollectQueryData(query);
        }

        // DXGI 可能枚举出同名幽灵适配器（无 PDH 实例）。只保留 Dedicated Usage
        // 对得上 LUID 的卡，再按已用显存 / 总显存选默认设备。
        monitor.retain_pdh_adapters();
        monitor.device_index = monitor.preferred_device_index();

        Ok(monitor)
    }

    fn retain_pdh_adapters(&mut self) {
        let Some(counter) = self.mem_counter else {
            return;
        };
        let items = formatted_counter_items(counter);
        if items.is_empty() {
            return;
        }
        let matched: Vec<DxgiAdapter> = self
            .adapters
            .iter()
            .filter(|adapter| {
                items
                    .iter()
                    .any(|(name, _)| instance_matches_luid(name, &adapter.luid_key))
            })
            .cloned()
            .collect();
        if !matched.is_empty() {
            self.adapters = matched;
        }
    }

    fn preferred_device_index(&self) -> u32 {
        self.adapters
            .iter()
            .enumerate()
            .max_by(|(_, left), (_, right)| {
                self.vram_used_for(left)
                    .partial_cmp(&self.vram_used_for(right))
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then(
                        left.dedicated_total_gb
                            .partial_cmp(&right.dedicated_total_gb)
                            .unwrap_or(std::cmp::Ordering::Equal),
                    )
            })
            .map(|(index, _)| index as u32)
            .unwrap_or(0)
    }

    fn device_count(&self) -> u32 {
        self.adapters.len() as u32
    }

    fn device_names(&self) -> Vec<String> {
        self.adapters.iter().map(|adapter| adapter.name.clone()).collect()
    }

    fn set_device(&mut self, index: u32) {
        if (index as usize) < self.adapters.len() {
            self.device_index = index;
        }
    }

    fn current(&self) -> Result<&DxgiAdapter> {
        self.adapters
            .get(self.device_index as usize)
            .ok_or_else(|| anyhow!("显卡索引越界"))
    }

    fn collect(&self) {
        unsafe {
            let _ = windows::Win32::System::Performance::PdhCollectQueryData(self.query);
        }
    }

    fn refresh(&mut self) -> Result<HardwareInfo> {
        self.collect();
        let adapter = self.current()?;
        Ok(HardwareInfo {
            gpu_name: adapter.name.clone(),
            total_vram: adapter.usable_total_gb(),
            used_vram: self.vram_used_for(adapter),
            utilization: self.utilization_for(adapter),
            temperature: 0.0,
        })
    }

    fn get_utilization(&self) -> Result<f64> {
        self.collect();
        Ok(self.utilization_for(self.current()?))
    }

    fn get_vram_used(&self) -> Result<f64> {
        self.collect();
        Ok(self.vram_used_for(self.current()?))
    }

    fn get_vram_total(&self) -> Result<f64> {
        Ok(self.current()?.usable_total_gb())
    }

    fn vram_used_for(&self, adapter: &DxgiAdapter) -> f64 {
        let dedicated = self.counter_bytes_for(self.mem_counter, adapter);
        // 核显的占用几乎全在共享内存，单独读专用显存会一直是 0；
        // 两者相加才是这块卡的实际占用（独显上共享占用通常可忽略）。
        let shared = self.counter_bytes_for(self.shared_mem_counter, adapter);
        (dedicated + shared).max(0.0)
    }

    fn counter_bytes_for(
        &self,
        counter: Option<windows::Win32::System::Performance::PDH_HCOUNTER>,
        adapter: &DxgiAdapter,
    ) -> f64 {
        let Some(counter) = counter else {
            return 0.0;
        };
        formatted_counter_items(counter)
            .into_iter()
            .filter(|(name, _)| instance_matches_luid(name, &adapter.luid_key))
            .map(|(_, bytes)| bytes.max(0.0))
            .sum::<f64>()
            / 1024.0
            / 1024.0
            / 1024.0
    }

    fn utilization_for(&self, adapter: &DxgiAdapter) -> f64 {
        let Some(counter) = self.util_counter else {
            return 0.0;
        };
        let total = formatted_counter_items(counter)
            .into_iter()
            .filter(|(name, _)| {
                instance_matches_luid(name, &adapter.luid_key) && is_graphics_engine(name)
            })
            .map(|(_, value)| value.max(0.0))
            .sum::<f64>();
        total.min(100.0)
    }
}

#[cfg(windows)]
fn formatted_counter_items(
    counter: windows::Win32::System::Performance::PDH_HCOUNTER,
) -> Vec<(String, f64)> {
    use windows::Win32::System::Performance::{
        PdhGetFormattedCounterArrayW, PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_MORE_DATA,
    };

    unsafe {
        let mut buf_size: u32 = 0;
        let mut item_count: u32 = 0;
        let status = PdhGetFormattedCounterArrayW(
            counter,
            PDH_FMT_DOUBLE,
            &mut buf_size,
            &mut item_count,
            None,
        );
        if status != PDH_MORE_DATA && buf_size == 0 {
            return Vec::new();
        }

        let mut buffer = vec![0u8; buf_size as usize];
        let items = buffer.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
        let status = PdhGetFormattedCounterArrayW(
            counter,
            PDH_FMT_DOUBLE,
            &mut buf_size,
            &mut item_count,
            Some(items),
        );
        if status != 0 || item_count == 0 {
            return Vec::new();
        }

        std::slice::from_raw_parts(items, item_count as usize)
            .iter()
            .filter_map(|item| {
                let name = item.szName.to_string().ok()?;
                let value = item.FmtValue.Anonymous.doubleValue;
                value.is_finite().then_some((name, value))
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    #[test]
    fn luid_key_matches_pdh_instance_name() {
        let key = super::adapter_luid_key(0, 0x0001_3c3e);
        assert_eq!(key, "luid_0x00000000_0x00013c3e");
        assert!(super::instance_matches_luid(
            "luid_0x00000000_0x00013c3e_phys_0",
            &key
        ));
        assert!(super::instance_matches_luid(
            "pid_1234_luid_0x00000000_0x00013c3e_phys_0_eng_0_engtype_3D",
            &key
        ));
        assert!(!super::instance_matches_luid(
            "luid_0x00000000_0x0000abcd_phys_0",
            &key
        ));
        assert!(super::is_graphics_engine(
            "pid_1_luid_0x00000000_0x00013c3e_phys_0_eng_0_engtype_3D"
        ));
        assert!(!super::is_graphics_engine(
            "pid_1_luid_0x00000000_0x00013c3e_phys_0_eng_0_engtype_Copy"
        ));
    }

    #[test]
    fn live_windows_gpu_monitor_reads_dedicated_memory() {
        let mut monitor = super::GpuMonitor::new().expect("应能初始化显卡监测");
        assert!(monitor.device_count() > 0, "应至少检测到一张显卡");
        let names = monitor.device_names();
        assert!(!names.is_empty());
        let info = monitor.refresh().expect("应能刷新硬件信息");
        assert!(
            info.total_vram > 0.5,
            "总显存应大于 0.5GB，实际 {:.3}GB，设备 {:?}",
            info.total_vram,
            names
        );
        assert!(
            info.used_vram >= 0.0,
            "已用显存不应为负，实际 {:.3}GB",
            info.used_vram
        );
        println!(
            "gpu={} total={:.2}GB used={:.2}GB util={:.1}% names={:?}",
            info.gpu_name, info.total_vram, info.used_vram, info.utilization, names
        );
    }

    #[test]
    fn vendor_id_maps_to_backend() {
        use super::GpuVendor;
        // PCI Vendor ID 判定：NVIDIA 0x10DE、AMD 0x1002、Intel 0x8086。
        assert_eq!(GpuVendor::from_vendor_id(0x10DE), GpuVendor::Nvidia);
        assert_eq!(GpuVendor::from_vendor_id(0x1002), GpuVendor::Amd);
        assert_eq!(GpuVendor::from_vendor_id(0x8086), GpuVendor::Intel);
        assert_eq!(GpuVendor::from_vendor_id(0x1234), GpuVendor::Other);

        // 后端归属：NVIDIA 走 CUDA；AMD / Intel 走 Vulkan。
        assert_eq!(GpuVendor::Nvidia.preferred_backend(), "CUDA");
        assert_eq!(GpuVendor::Amd.preferred_backend(), "Vulkan");
        assert_eq!(GpuVendor::Intel.preferred_backend(), "Vulkan");

        // 名称兜底（VendorId 拿不到时）：覆盖 OEM 定制名与核显。
        assert_eq!(GpuVendor::from_name("NVIDIA GeForce RTX 3080 Ti"), GpuVendor::Nvidia);
        assert_eq!(GpuVendor::from_name("AMD Radeon RX 7900 XTX"), GpuVendor::Amd);
        assert_eq!(GpuVendor::from_name("AMD Radeon(TM) Graphics"), GpuVendor::Amd);
        assert_eq!(GpuVendor::from_name("Intel(R) Iris(R) Xe Graphics"), GpuVendor::Intel);
        assert_eq!(GpuVendor::from_name("Intel(R) Arc(TM) A770 Graphics"), GpuVendor::Intel);
        assert_eq!(GpuVendor::from_name("GameViewer Virtual Display Adapter"), GpuVendor::Other);
    }

    #[test]
    fn igpu_falls_back_to_shared_memory() {
        #[cfg(windows)]
        {
            // 核显：专用显存为 0，可用显存必须来自共享内存（否则会报“未检测到显卡”，
            // 而且显存预测拿到 0 会让推荐参数完全失效）。
            let igpu = super::DxgiAdapter {
                name: "AMD Radeon(TM) Graphics".to_string(),
                luid_key: "luid_0x0_0x0".to_string(),
                dedicated_total_gb: 0.0,
                shared_total_gb: 16.0,
                vendor_id: 0x1002,
            };
            assert!(igpu.uses_shared_memory());
            assert_eq!(igpu.vendor(), super::GpuVendor::Amd);
            // 共享内存不能全额当显存算，必须按保守比例折算。
            let usable = igpu.usable_total_gb();
            assert!(usable > 0.0 && usable < 16.0, "共享内存应按比例折算，实际 {usable}");

            // 独显：用专用显存，不受共享内存影响。
            let dgpu = super::DxgiAdapter {
                name: "NVIDIA GeForce RTX 3080 Ti".to_string(),
                luid_key: "luid_0x0_0x1".to_string(),
                dedicated_total_gb: 12.0,
                shared_total_gb: 16.0,
                vendor_id: 0x10DE,
            };
            assert!(!dgpu.uses_shared_memory());
            assert_eq!(dgpu.usable_total_gb(), 12.0);
            assert_eq!(dgpu.vendor(), super::GpuVendor::Nvidia);
        }
    }
}
