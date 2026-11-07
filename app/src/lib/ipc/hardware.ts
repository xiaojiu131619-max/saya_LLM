import { invoke } from '@tauri-apps/api/core';

/**
 * 显卡监测的 IPC 传输层：NVML 优先，回退 DXGI/PDH。
 */

export interface HardwareInfo {
  gpu_name: string;
  total_vram: number;
  used_vram: number;
  utilization: number;
  temperature: number;
}

export function getHardwareInfo(): Promise<HardwareInfo> {
  return invoke<HardwareInfo>('get_hardware_info');
}

export function listGpus(): Promise<string[]> {
  return invoke<string[]>('list_gpus');
}

/** 后端调优建议（AMD / Vulkan 机器上给出 ubatch / KV / ROCm 建议）。 */
export interface BackendTuningAdvice {
  backend: string;
  vendor: string;
  amdArch: string | null;
  hipCapable: boolean;
  recommendedUbatch: number;
  recommendedBatch: number;
  recommendedKvQuant: string | null;
  notes: string[];
}

export function getBackendTuningAdvice(): Promise<BackendTuningAdvice> {
  return invoke<BackendTuningAdvice>('get_backend_tuning_advice');
}
