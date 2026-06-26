use anyhow::Result;
use nvml_wrapper::enum_wrappers::device::TemperatureSensor;
use nvml_wrapper::Nvml;

pub struct GpuMonitor {
    nvml: Nvml,
    device_index: u32,
}

impl GpuMonitor {
    pub fn new() -> Result<Self> {
        let nvml = Nvml::init()?;
        Ok(Self {
            nvml,
            device_index: 0,
        })
    }

    pub fn device_count(&self) -> u32 {
        self.nvml.device_count().unwrap_or(0)
    }

    pub fn device_names(&self) -> Vec<String> {
        let count = self.device_count();
        (0..count)
            .filter_map(|i| self.nvml.device_by_index(i).ok()?.name().ok())
            .collect()
    }

    pub fn set_device(&mut self, index: u32) {
        self.device_index = index;
    }

    pub fn refresh(&mut self) -> Result<crate::models::hardware_info::HardwareInfo> {
        let device = self.nvml.device_by_index(self.device_index)?;
        let name = device.name()?;
        let mem = device.memory_info()?;
        let utilization = device.utilization_rates()?;
        let temp = device.temperature(TemperatureSensor::Gpu)?;

        Ok(crate::models::hardware_info::HardwareInfo {
            gpu_name: name,
            total_vram: mem.total as f64 / 1024.0 / 1024.0 / 1024.0,
            used_vram: mem.used as f64 / 1024.0 / 1024.0 / 1024.0,
            utilization: utilization.gpu as f64,
            temperature: temp as f64,
        })
    }

    pub fn get_utilization(&self) -> Result<f64> {
        let device = self.nvml.device_by_index(self.device_index)?;
        let utilization = device.utilization_rates()?;
        Ok(utilization.gpu as f64)
    }

    pub fn get_vram_used(&self) -> Result<f64> {
        let device = self.nvml.device_by_index(self.device_index)?;
        let mem = device.memory_info()?;
        Ok(mem.used as f64 / 1024.0 / 1024.0 / 1024.0)
    }

    pub fn get_vram_total(&self) -> Result<f64> {
        let device = self.nvml.device_by_index(self.device_index)?;
        let mem = device.memory_info()?;
        Ok(mem.total as f64 / 1024.0 / 1024.0 / 1024.0)
    }
}
