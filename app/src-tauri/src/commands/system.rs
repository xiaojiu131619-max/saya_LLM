use std::path::Path;
use std::process::Command;
use tauri::State;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use crate::models::app_state::AppState;
use crate::models::hardware_info::SystemStatus;
use crate::services::auto_updater;
use crate::services::process_manager;

fn resolve_allowed_dirs(model_dirs: &[std::path::PathBuf]) -> Vec<std::path::PathBuf> {
    let mut dirs = Vec::new();
    // 模型目录
    for d in model_dirs {
        if let Ok(canonical) = d.canonicalize() {
            dirs.push(canonical);
        }
    }
    // 应用数据目录
    if let Some(data_dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf())) {
        dirs.push(data_dir);
    }
    // 临时目录
    if let Ok(tmp) = std::env::temp_dir().canonicalize() {
        dirs.push(tmp);
    }
    // 当前工作目录
    if let Ok(cwd) = std::env::current_dir().map(|p| p.canonicalize().unwrap_or(p)) {
        dirs.push(cwd);
    }
    dirs
}

fn is_path_in_allowed_dirs(path: &std::path::Path, model_dirs: &[std::path::PathBuf]) -> bool {
    let canonical = match path.canonicalize() {
        Ok(p) => p,
        Err(_) => return false,
    };
    let allowed = resolve_allowed_dirs(model_dirs);
    allowed.iter().any(|d| canonical.starts_with(d))
}

#[tauri::command]
pub fn read_file_content(state: State<'_, AppState>, path: String) -> Result<String, String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err("文件不存在".to_string());
    }
    let config = state.config.lock().map_err(|e| format!("配置锁定失败: {}", e))?;
    if !is_path_in_allowed_dirs(p, &config.model_dirs) {
        return Err("不允许读取该路径下的文件".to_string());
    }
    drop(config);
    let meta = std::fs::metadata(p).map_err(|e| format!("无法读取文件信息: {}", e))?;
    if meta.len() > MAX_TEXT_FILE_SIZE {
        return Err(format!(
            "文件过大 ({:.1}MB)，文本附件最大支持 10MB",
            meta.len() as f64 / 1024.0 / 1024.0
        ));
    }
    std::fs::read_to_string(p)
        .map_err(|_| "无法读取文件内容（可能是二进制文件，请改用图片/音频/视频附件）".to_string())
}

#[tauri::command]
pub fn read_media_file(state: State<'_, AppState>, path: String) -> Result<MediaPayload, String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err("文件不存在".to_string());
    }
    let config = state.config.lock().map_err(|e| format!("配置锁定失败: {}", e))?;
    if !is_path_in_allowed_dirs(p, &config.model_dirs) {
        return Err("不允许读取该路径下的文件".to_string());
    }
    drop(config);
    let meta = std::fs::metadata(p).map_err(|e| format!("无法读取文件信息: {}", e))?;
    if meta.len() > MAX_MEDIA_FILE_SIZE {
        return Err(format!(
            "媒体文件过大 ({:.1}MB)，最大支持 {:.0}MB",
            meta.len() as f64 / 1024.0 / 1024.0,
            MAX_MEDIA_FILE_SIZE as f64 / 1024.0 / 1024.0
        ));
    }
    let bytes = std::fs::read(p).map_err(|e| format!("无法读取文件内容: {}", e))?;
    let mime_type = infer_media_mime(p);
    let mime_type = match mime_type {
        Some(mime) => mime,
        None => {
            return Err(format!(
                "不支持的文件类型: {}（仅支持图片、音频、视频）",
                p.extension().and_then(|e| e.to_str()).unwrap_or("未知")
            ));
        }
    };
    let data_base64 = base64_encode(&bytes);
    Ok(MediaPayload {
        mime_type,
        data_base64,
        byte_size: meta.len(),
    })
}

const MAX_TEXT_FILE_SIZE: u64 = 10 * 1024 * 1024; // 10MB
const MAX_MEDIA_FILE_SIZE: u64 = 80 * 1024 * 1024; // 80MB，OpenAI multimodal base64 上限

#[derive(serde::Serialize)]
pub struct MediaPayload {
    pub mime_type: String,
    pub data_base64: String,
    pub byte_size: u64,
}

fn infer_media_mime(p: &Path) -> Option<String> {
    let ext = p.extension()?.to_str()?.to_ascii_lowercase();
    let mime = match ext.as_str() {
        // 图片
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        // 音频
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "ogg" | "oga" => "audio/ogg",
        "flac" => "audio/flac",
        "opus" => "audio/ogg",
        // 视频
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "mkv" | "webm" => "video/webm",
        "avi" => "video/x-msvideo",
        "m4v" => "video/mp4",
        "ogv" => "video/ogg",
        _ => return None,
    };
    Some(mime.to_string())
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let b0 = bytes[i];
        let b1 = bytes[i + 1];
        let b2 = bytes[i + 2];
        out.push(TABLE[(b0 >> 2) as usize] as char);
        out.push(TABLE[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        out.push(TABLE[(((b1 & 0x0F) << 2) | (b2 >> 6)) as usize] as char);
        out.push(TABLE[(b2 & 0x3F) as usize] as char);
        i += 3;
    }
    let rem = bytes.len() - i;
    if rem == 1 {
        let b0 = bytes[i];
        out.push(TABLE[(b0 >> 2) as usize] as char);
        out.push(TABLE[((b0 & 0x03) << 4) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rem == 2 {
        let b0 = bytes[i];
        let b1 = bytes[i + 1];
        out.push(TABLE[(b0 >> 2) as usize] as char);
        out.push(TABLE[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        out.push(TABLE[((b1 & 0x0F) << 2) as usize] as char);
        out.push('=');
    }
    out
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

/// 解析引擎可执行文件路径。
///
/// 直接复用 `process_manager` 的实现：那份带有「允许目录 + 白名单文件名」两道检查。
/// 这里曾有一份重复实现，它对绝对路径不做任何校验就原样返回，
/// 而 `check_engine_info` 的参数来自前端，等于允许执行任意本地程序。
fn resolve_exe_path(path: &str) -> String {
    process_manager::resolve_exe_path(path)
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
    for token in output
        .split(|ch: char| ch.is_whitespace() || matches!(ch, ',' | ';' | '(' | ')' | '[' | ']'))
    {
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

        info.llama_server_version = parse_llama_server_version(&combined)
            .or_else(|| auto_updater::get_current_version().and_then(|version| normalize_release_version(&version)));

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
        // 仅在已有 CUDA 证据时才根据 --help 选项确认 CUDA Graphs
        // （spec-type/reasoning-budget 在所有近期构建中都存在，包括纯 CPU 构建）
        let has_cuda_evidence = info.sm_architecture.is_some()
            || combined.contains("CUDA")
            || combined.contains("cuda");
        if has_cuda_evidence && (combined.contains("spec-type") || combined.contains("reasoning-budget")) {
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
