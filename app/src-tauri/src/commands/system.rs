use std::path::Path;
use std::process::Command;
use tauri::State;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use crate::models::app_state::AppState;
use crate::models::hardware_info::SystemStatus;
use crate::services::auto_updater;

const MAX_FILE_SIZE: u64 = 10 * 1024 * 1024; // 10MB

#[tauri::command]
pub fn read_file_content(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err("文件不存在".to_string());
    }
    let meta = std::fs::metadata(p).map_err(|e| format!("无法读取文件信息: {}", e))?;
    if meta.len() > MAX_FILE_SIZE {
        return Err(format!(
            "文件过大 ({:.1}MB)，最大支持 10MB",
            meta.len() as f64 / 1024.0 / 1024.0
        ));
    }
    std::fs::read_to_string(p).map_err(|_| "无法读取文件内容（可能是二进制文件）".to_string())
}

#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err("路径不存在".to_string());
    }

    #[cfg(windows)]
    {
        let target = if p.is_file() {
            format!("/select,{}", p.to_string_lossy())
        } else {
            p.to_string_lossy().to_string()
        };
        Command::new("explorer.exe")
            .arg(target)
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| format!("无法在资源管理器中打开路径: {}", e))?;
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        let target = if p.is_file() {
            p.parent().unwrap_or(p)
        } else {
            p
        };
        Command::new("open")
            .arg(target)
            .spawn()
            .map_err(|e| format!("无法打开路径: {}", e))?;
        Ok(())
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let target = if p.is_file() {
            p.parent().unwrap_or(p)
        } else {
            p
        };
        Command::new("xdg-open")
            .arg(target)
            .spawn()
            .map_err(|e| format!("无法打开路径: {}", e))?;
        Ok(())
    }
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err("只能打开 http 或 https 链接".to_string());
    }

    #[cfg(windows)]
    {
        Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", trimmed])
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| format!("无法打开链接: {}", e))?;
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(trimmed)
            .spawn()
            .map_err(|e| format!("无法打开链接: {}", e))?;
        Ok(())
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(trimmed)
            .spawn()
            .map_err(|e| format!("无法打开链接: {}", e))?;
        Ok(())
    }
}

#[derive(serde::Serialize)]
pub struct EngineInfo {
    pub binary_exists: bool,
    pub cuda_graphs_enabled: bool,
    pub cuda_version: Option<String>,
    pub cuda_matched: bool,
    pub sm_architecture: Option<String>,
    pub llama_server_version: Option<String>,
    pub exe_path: String,
}

fn resolve_exe_path(path: &str) -> String {
    let requested = Path::new(path);
    if requested.is_absolute() && requested.exists() {
        return path.to_string();
    }
    let fname = requested
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path);
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if let Some(grandparent) = dir.parent() {
                candidates.push(
                    grandparent
                        .join("_up_")
                        .join("resources")
                        .join(fname)
                        .to_string_lossy()
                        .to_string(),
                );
                candidates.push(
                    grandparent
                        .join("resources")
                        .join(fname)
                        .to_string_lossy()
                        .to_string(),
                );
            }
            candidates.push(
                dir.join("_up_")
                    .join("resources")
                    .join(fname)
                    .to_string_lossy()
                    .to_string(),
            );
            candidates.push(
                dir.join("resources")
                    .join(fname)
                    .to_string_lossy()
                    .to_string(),
            );
            candidates.push(dir.join(fname).to_string_lossy().to_string());
            candidates.push(dir.join(path).to_string_lossy().to_string());
        }
    }
    candidates.push(format!("_up_/resources/{}", fname));
    candidates.push(format!("resources/{}", fname));
    candidates.push(format!("../{}", path));
    candidates.push(format!("./{}", path));
    candidates.push(format!("./{}", fname));
    candidates.push(format!("../resources/{}", fname));
    candidates.push(format!("../../resources/{}", fname));
    candidates.push(path.to_string());
    candidates.push(fname.to_string());
    for c in &candidates {
        if Path::new(c).exists() {
            return c.to_string();
        }
    }
    path.to_string()
}

fn normalize_release_version(value: &str) -> Option<String> {
    let trimmed = value.trim().trim_start_matches('v');
    if trimmed.len() < 2 {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    if !lower.starts_with('b') {
        return None;
    }
    let digits = lower.trim_start_matches('b');
    if digits.is_empty() || !digits.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    Some(format!("b{}", digits))
}

fn parse_llama_server_version(output: &str) -> Option<String> {
    for token in output.split(|ch: char| ch.is_whitespace() || matches!(ch, ',' | ';' | '(' | ')' | '[' | ']')) {
        if let Some(version) = normalize_release_version(token) {
            if version != "b0" {
                return Some(version);
            }
        }
    }

    for line in output.lines() {
        let line_trimmed = line.trim();
        if line_trimmed.starts_with("version:") {
            let ver_part = line_trimmed.strip_prefix("version:").unwrap_or("").trim();
            let build_num = ver_part.split_whitespace().next().unwrap_or("");
            if build_num.chars().all(|ch| ch.is_ascii_digit()) && build_num != "0" {
                return Some(format!("b{}", build_num));
            }
        }
    }

    output
        .lines()
        .find(|line| line.contains("llama.cpp"))
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
}

#[tauri::command]
pub fn check_engine_info(exe_path: String) -> EngineInfo {
    let resolved = resolve_exe_path(&exe_path);
    let binary_exists = Path::new(&resolved).exists();
    let mut info = EngineInfo {
        binary_exists,
        cuda_graphs_enabled: false,
        cuda_version: None,
        cuda_matched: false,
        sm_architecture: None,
        llama_server_version: None,
        exe_path: resolved.clone(),
    };

    if !binary_exists {
        return info;
    }

    let output = Command::new(&resolved)
        .arg("--version")
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output();

    if let Ok(out) = output {
        let stdout = String::from_utf8_lossy(&out.stdout);
        let stderr = String::from_utf8_lossy(&out.stderr);
        let combined = format!("{}\n{}", stdout, stderr);

        info.llama_server_version = auto_updater::get_current_version()
            .and_then(|version| normalize_release_version(&version))
            .or_else(|| parse_llama_server_version(&combined));

        // Fallback: first non-empty line
        if info.llama_server_version.is_none() && !combined.trim().is_empty() {
            info.llama_server_version = Some(
                combined
                    .lines()
                    .next()
                    .unwrap_or("unknown")
                    .trim()
                    .to_string(),
            );
        }

        // Extract SM architecture (e.g., "sm_86")
        for line in combined.lines() {
            if let Some(pos) = line.find("sm_") {
                let rest = &line[pos..];
                let arch = rest.split_whitespace().next().unwrap_or("").to_string();
                if !arch.is_empty() {
                    info.sm_architecture = Some(arch.clone());
                    info.cuda_matched = true;
                    break;
                }
            }
        }

        // Detect CUDA Graphs:
        // llama.cpp with CUDA Graphs enabled prints "CUDA graph" or just has CUDA init output
        // The most reliable signal: if "CUDA" appears in output, it's a CUDA build
        // Since the build has GGML_CUDA_GRAPHS=ON in CMake cache, CUDA init means graphs are enabled
        let has_cuda = combined.contains("CUDA") || combined.contains("cuda");
        let has_sm = info.sm_architecture.is_some();
        let has_graph = combined.contains("graph") || combined.contains("Graph");
        // A CUDA-enabled build with SM info = CUDA graphs enabled
        info.cuda_graphs_enabled =
            has_cuda && (has_sm || has_graph || info.llama_server_version.is_some());
    }

    // Also check --help for advanced options that confirm a recent build
    let help_out = Command::new(&resolved)
        .arg("--help")
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output();
    if let Ok(out) = help_out {
        let combined = format!(
            "{}\n{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        if combined.contains("spec-type") || combined.contains("reasoning-budget") {
            info.cuda_graphs_enabled = true;
        }
    }

    info
}

fn get_or_init_gpu_monitor(
    gpu_monitor: &std::sync::Mutex<Option<crate::services::gpu_monitor::GpuMonitor>>,
) -> Option<()> {
    let mut guard = gpu_monitor.lock().ok()?;
    if guard.is_none() {
        *guard = crate::services::gpu_monitor::GpuMonitor::new().ok();
    }
    Some(())
}

#[tauri::command]
pub fn get_system_status(state: State<'_, AppState>) -> Result<SystemStatus, String> {
    get_or_init_gpu_monitor(&state.gpu_monitor);

    let mut mem = crate::services::memory_monitor::MemoryMonitor::new();

    let (gpu_util, vram_used, vram_total) = {
        let mut guard = state.gpu_monitor.lock().map_err(|e| e.to_string())?;
        if let Some(ref mut gpu) = *guard {
            (
                gpu.get_utilization().ok(),
                gpu.get_vram_used().ok(),
                gpu.get_vram_total().ok(),
            )
        } else {
            (None, None, None)
        }
    };

    Ok(SystemStatus {
        gpu_utilization: gpu_util,
        vram_used,
        vram_total,
        memory_used: Some(mem.get_used_memory()),
        memory_total: Some(mem.get_total_memory()),
    })
}
