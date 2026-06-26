use tauri::State;

use crate::models::app_state::AppState;
use crate::models::hardware_info::HardwareInfo;

#[tauri::command]
pub fn get_hardware_info(state: State<'_, AppState>) -> Result<HardwareInfo, String> {
    let mut guard = state.gpu_monitor.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        *guard = crate::services::gpu_monitor::GpuMonitor::new().ok();
    }
    let monitor = guard.as_mut().ok_or("GPU not available")?;
    monitor.refresh().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_gpus(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let mut guard = state.gpu_monitor.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        *guard = crate::services::gpu_monitor::GpuMonitor::new().ok();
    }
    let monitor = guard.as_ref().ok_or("GPU not available")?;
    Ok(monitor.device_names())
}

#[tauri::command]
pub fn set_gpu_device(state: State<'_, AppState>, index: u32) -> Result<(), String> {
    let mut guard = state.gpu_monitor.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        *guard = crate::services::gpu_monitor::GpuMonitor::new().ok();
    }
    if let Some(ref mut m) = *guard {
        m.set_device(index);
    }
    Ok(())
}
