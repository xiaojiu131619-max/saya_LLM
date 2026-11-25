use std::path::Path;
use std::process::Command;
use tauri::State;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use crate::models::app_state::AppState;
use crate::models::hardware_info::SystemStatus;
use crate::services::auto_updater;
use crate::services::gpu_profile;
use crate::services::process_manager;

/// 后端调优建议：前端加载页与自动调参在 AMD / Vulkan 机器上消费。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendTuningAdvice {
    /// 内核后端（CUDA / Vulkan / HIP/ROCm / CPU）。
    pub backend: String,
    /// 显卡厂商（NVIDIA / AMD / Intel / 未知）。
    pub vendor: String,
    /// AMD 架构分档（RDNA2/3/4；非 AMD 为 null）。
    pub amd_arch: Option<String>,
    /// 本机 AMD 独显是否在 ROCm/HIP 官方支持列表内（无 AMD 卡为 false）。
    pub hip_capable: bool,
    /// 建议的物理批处理大小（-ub）。
    pub recommended_ubatch: u32,
    /// 建议的逻辑批处理大小（-b）。
    pub recommended_batch: u32,
    /// 建议的 KV 量化类型；null = 保持 f16。
    pub recommended_kv_quant: Option<String>,
    /// 中文建议说明（逐条，直接展示给用户）。
    pub notes: Vec<String>,
}

/// 按本机显卡与当前内核给出 AMD / Vulkan 调优建议。
///
/// 只读探测，不修改任何配置；NVIDIA 机器返回 CUDA 口径的建议（无特殊项）。
#[tauri::command]
pub fn get_backend_tuning_advice(state: State<'_, AppState>) -> BackendTuningAdvice {
    let profile = gpu_profile::current();
    let exe = {
        let config = state.config.lock().map(|config| config.clone()).unwrap_or_default();
        config
            .kernel_override_path
            .as_deref()
            .filter(|path| !path.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| process_manager::resolve_exe_path(&config.llama_server_path))
    };
    let backend = process_manager::detect_kernel_backend(&exe).label().to_string();
    let (hip_capable, _hip_gpu) = auto_updater::detect_hip_context_public();
    let is_amd = profile.vendor == "amd";
    let vulkan_kernel = process_manager::is_vulkan_kernel(&exe);
    let vram_total = state
        .gpu_monitor
        .lock()
        .ok()
        .and_then(|mut guard| guard.as_mut().and_then(|monitor| monitor.get_vram_total().ok()))
        .unwrap_or(0.0);

    let advice = if vulkan_kernel {
        process_manager::vulkan_tuning_advice(vram_total)
    } else {
        process_manager::vulkan_tuning_advice(0.0)
    };

    let mut notes: Vec<String> = Vec::new();
    if is_amd && vulkan_kernel {
        notes.push(format!(
            "检测到 AMD 显卡（{}），当前使用 Vulkan 内核。建议物理批处理 {}、逻辑批处理 {}，可降低计算缓冲的显存占用。",
            profile.name.as_deref().unwrap_or("AMD GPU"),
            advice.ubatch,
            advice.batch,
        ));
        if let Some(kv) = advice.kv_quant {
            notes.push(format!(
                "显存小于 12GB 时建议把 K/V 缓存量化到 {kv}：Vulkan 上解码 kernel 成熟，能省一半以上 KV 显存，速度损失很小。"
            ));
        }
        if hip_capable {
            notes.push("本机卡在 ROCm/HIP 官方支持列表内：可在「核心更新」下载 ROCm 内核实测，部分模型上快于 Vulkan；Vulkan 仍是默认推荐。".to_string());
        } else {
            notes.push("本机卡不在 ROCm/HIP 支持列表内（核显或较老架构），请使用 Vulkan 内核，不要下载 ROCm 包。".to_string());
        }
        notes.push("加载后若速度不理想，可在「模型加载 → 自动调参」让应用实测搜索 ubatch / KV / ngl 组合。".to_string());
    } else if is_amd && !vulkan_kernel {
        notes.push(format!(
            "检测到 AMD 显卡，但当前内核后端是 {backend}。请到「核心更新」下载 Vulkan 包（或本机支持时的 ROCm 包），CUDA 内核在 AMD 卡上无法使用 GPU。"
        ));
    }

    BackendTuningAdvice {
        backend,
        vendor: profile.vendor_label,
        amd_arch: profile.amd_arch.map(|arch| arch.label().to_string()),
        hip_capable,
        recommended_ubatch: advice.ubatch,
        recommended_batch: advice.batch,
        recommended_kv_quant: advice.kv_quant.map(str::to_string),
        notes,
    }
}

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
    // 用户常用目录：聊天附件（read_file_content / read_media_file 的唯一消费方）
    // 需要支持从桌面、文档、下载等位置拖拽文件，不再局限于模型目录。
    for folder in user_attachment_dirs() {
        if let Ok(canonical) = folder.canonicalize() {
            dirs.push(canonical);
        }
    }
    dirs
}

/// 用户主目录下的常用文件夹（附件白名单）。目录不存在时自然被 canonicalize 过滤。
fn user_attachment_dirs() -> Vec<std::path::PathBuf> {
    let base = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from);
    let Some(base) = base else {
        return Vec::new();
    };
    ["Desktop", "Documents", "Downloads", "Pictures", "Music", "Videos"]
        .iter()
        .map(|name| base.join(name))
        .collect()
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

pub(crate) fn infer_media_mime(p: &Path) -> Option<String> {
    let ext = p.extension()?.to_str()?.to_ascii_lowercase();
    let mime = match ext.as_str() {
        // 图片
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
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

pub(crate) fn base64_encode(bytes: &[u8]) -> String {
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
    #[serde(default)]
    pub runtime_devices: Vec<String>,
    #[serde(default)]
    pub runtime_backend: Option<String>,
    #[serde(default)]
    pub host_backend: Option<String>,
    #[serde(default)]
    pub gpu_name: Option<String>,
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

/// 从 `--version` 输出里取官方构建号，识别 "build 11115" 形式。
/// 只认同行里紧跟在独立的 "build" 词之后的纯数字，避免把 "0.4.1-dev" 里的片段
/// 或 commit 哈希附近的数字误当构建号。
fn parse_build_number(output: &str) -> Option<String> {
    for line in output.lines() {
        let lower = line.to_ascii_lowercase();
        let Some(pos) = lower.find("build") else {
            continue;
        };
        let after = &line[pos + "build".len()..];
        let digits: String = after
            .trim_start_matches(|ch: char| ch.is_whitespace() || ch == ':' || ch == '=')
            .chars()
            .take_while(|ch| ch.is_ascii_digit())
            .collect();
        if digits.len() >= 3 {
            return Some(digits);
        }
    }
    None
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

    // 官方构建的 --version 把版本写成 "version: 0.4.1-dev (build 11115, commit …)"，
    // 里面没有 "b11115" 这样的 token，上面那条匹配不到。旧实现随后只认 "version:"
    // 后面紧跟纯数字，于是整行都解析失败，最后回落到 update.log 里的旧版本号——
    // 手工安装或自编译内核时，界面会显示一个与实际内核完全不符的版本。
    // 这里直接找 "build <数字>" 形式。
    if let Some(build) = parse_build_number(output) {
        return Some(format!("b{build}"));
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

/// 构造一个「未探测」的内核信息结果（探测失败时的安全回退）。
fn empty_engine_info(exe_path: String) -> EngineInfo {
    let binary_exists = Path::new(&exe_path).exists();
    EngineInfo {
        binary_exists,
        cuda_graphs_enabled: false,
        cuda_version: None,
        cuda_matched: false,
        sm_architecture: None,
        llama_server_version: None,
        exe_path,
        runtime_devices: Vec::new(),
        runtime_backend: None,
        host_backend: None,
        gpu_name: None,
    }
}

/// 同步探测内核信息：会依次拉起 `--list-devices` / `--version` / `--help` 三个子进程。
///
/// `device_probe` 等 Rust 内部调用方直接使用这个同步入口；Tauri 命令走下面的
/// `kernel_info` 模块。同步命令会在 WebView2 的 UI 线程里等子进程退出，
/// 应用启动与模型加载页打开时会让整个界面和后续 IPC 一起卡住。
fn check_engine_info_blocking(exe_path: String) -> EngineInfo {
    let resolved = resolve_exe_path(&exe_path);
    let mut info = empty_engine_info(resolved.clone());

    if !info.binary_exists {
        return info;
    }

    let (host_backend, gpu_name) = auto_updater::detect_host_gpu_backend();
    info.host_backend = Some(host_backend);
    info.gpu_name = gpu_name;
    info.runtime_devices = process_manager::list_runtime_devices(&resolved);
    info.runtime_backend = if info
        .runtime_devices
        .iter()
        .any(|device| device.to_ascii_lowercase().starts_with("cuda"))
    {
        Some("CUDA".to_string())
    } else if info
        .runtime_devices
        .iter()
        .any(|device| device.to_ascii_lowercase().starts_with("vulkan"))
    {
        Some("Vulkan".to_string())
    } else if info.runtime_devices.is_empty() {
        None
    } else {
        Some(info.runtime_devices[0].clone())
    };

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

/// 保持原函数名与签名，供 `device_probe` 等 Rust 内部调用方复用。
pub fn check_engine_info(exe_path: String) -> EngineInfo {
    check_engine_info_blocking(exe_path)
}

/// Tauri 命令包装：把阻塞探测挪到异步运行时的阻塞线程池。
///
/// 命令名必须仍是 `check_engine_info`（前端 `invoke('check_engine_info')` 不变），
/// 因此放在子模块里与内部同步入口区分。
pub mod kernel_info {
    /// 探测线程异常退出（panic）时回退为「未探测到」的安全结果，避免整个命令失败。
    #[tauri::command]
    pub async fn check_engine_info(exe_path: String) -> super::EngineInfo {
        let fallback_path = exe_path.clone();
        match tauri::async_runtime::spawn_blocking(move || {
            super::check_engine_info_blocking(exe_path)
        })
        .await
        {
            Ok(info) => info,
            Err(error) => {
                eprintln!("[engine] 内核信息探测任务异常退出：{}", error);
                super::empty_engine_info(fallback_path)
            }
        }
    }
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

#[derive(serde::Serialize, Default)]
pub struct SystemAppearance {
    /// 跟随系统 accent color 失败时的兜底色（Win11 默认蓝）。
    pub accent_color: String,
    /// 跟随系统暗色/亮色失败时的兜底值。
    pub apps_use_light_theme: bool,
    /// 是否在 Win11 22H2+（mica 可用）。
    pub supports_mica: bool,
}

/// 读取 Windows 系统的 accent color 与亮/暗主题。
///
/// 实现要点：
/// - accent color 从 `HKCU\SOFTWARE\Microsoft\Windows\DWM\ColorizationColor` 读出，
///   格式是 0xAARRGGBB，需要去掉 alpha 再转成 #RRGGBB。
/// - apps_use_light_theme 从 `HKCU\...\Personalize\AppsUseLightTheme` 读出。
/// - 注册表读取仅在 Windows 平台有效，其他平台走兜底值。
/// - 不监听系统变化事件：Windows 改 accent/theme 时让用户重启 App 即可，事件钩子太重。
/// 检测视频链路所需的 ffmpeg / ffprobe 是否就绪（无需启动 llama-server）。
#[tauri::command]
pub fn check_video_runtime() -> process_manager::VideoRuntimeInfo {
    process_manager::check_video_runtime()
}

#[tauri::command]
pub fn get_system_appearance() -> SystemAppearance {    #[cfg(windows)]
    {
        let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);

        let accent_color = hkcu
            .open_subkey("SOFTWARE\\Microsoft\\Windows\\DWM")
            .ok()
            .and_then(|key| key.get_value::<u32, _>("ColorizationColor").ok())
            .map(|raw| {
                // 0xAARRGGBB -> #RRGGBB (drop alpha)
                let r = (raw >> 16) & 0xFF;
                let g = (raw >> 8) & 0xFF;
                let b = raw & 0xFF;
                format!("#{:02X}{:02X}{:02X}", r, g, b)
            })
            .unwrap_or_else(|| "#0078D4".to_string());

        let apps_use_light_theme = hkcu
            .open_subkey("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize")
            .ok()
            .and_then(|key| key.get_value::<u32, _>("AppsUseLightTheme").ok())
            .map(|v| v != 0)
            .unwrap_or(true);

        let supports_mica = detect_supports_mica();

        SystemAppearance {
            accent_color,
            apps_use_light_theme,
            supports_mica,
        }
    }

    #[cfg(not(windows))]
    {
        SystemAppearance {
            accent_color: "#0078D4".to_string(),
            apps_use_light_theme: true,
            supports_mica: false,
        }
    }
}

#[cfg(windows)]
fn detect_supports_mica() -> bool {
    // Use RtlGetVersion (ntdll) instead of GetVersionEx (which is subject to manifest shims).
    // Build >= 22621 means Win11 22H2+, mica is actually supported there.
    #[repr(C)]
    struct OsVersionInfo {
        os_version_info_size: u32,
        major_version: u32,
        minor_version: u32,
        build_number: u32,
        platform_id: u32,
        csd_version: [u16; 128],
    }

    extern "system" {
        fn RtlGetVersion(lp_version_information: *mut OsVersionInfo) -> i32;
    }

    unsafe {
        let mut info: OsVersionInfo = std::mem::zeroed();
        info.os_version_info_size = std::mem::size_of::<OsVersionInfo>() as u32;
        let status = RtlGetVersion(&mut info);
        if status < 0 {
            return false;
        }
        info.major_version == 10 && info.build_number >= 22621
    }
}

#[cfg(test)]
mod version_tests {
    use super::{parse_build_number, parse_llama_server_version};

    #[test]
    fn parses_official_build_form() {
        // 官方 CUDA / Vulkan 构建的真实输出：版本号写作 "build 11115"，没有 b11115 token。
        let vulkan = "0.00.000.835 I srv  llama_server: initializing ...\n\
                      version: 0.4.1-dev (build 11115, commit d5f66492e)\n\
                      built with Clang 20.1.8 for Windows x86_64";
        assert_eq!(parse_llama_server_version(vulkan).as_deref(), Some("b11115"));

        // 自编译/分支核心同样是这个形态。
        let prism = "version: 0.2.0-dev (build 10709, commit 9a9394a89)\n\
                     built with MSVC 19.44.35228.0 for Windows AMD64";
        assert_eq!(parse_llama_server_version(prism).as_deref(), Some("b10709"));
    }

    #[test]
    fn prefers_explicit_b_token_and_ignores_version_fragments() {
        // 有显式 bNNNNN token 时优先用它。
        assert_eq!(
            parse_llama_server_version("llama-server b4282 (abc123)").as_deref(),
            Some("b4282")
        );
        // "0.4.1-dev" 里的数字不能被当成构建号。
        assert_eq!(parse_build_number("version: 0.4.1-dev"), None);
        // build 号过短（占位或畸形）不接受。
        assert_eq!(parse_build_number("build 12"), None);
        // 无任何版本线索时不猜。
        assert_eq!(parse_llama_server_version("some unrelated text"), None);
    }
}
