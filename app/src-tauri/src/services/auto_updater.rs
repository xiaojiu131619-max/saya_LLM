use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};

static UPDATE_LOG: Lazy<PathBuf> = Lazy::new(|| resource_dir().join("update.log"));

/// 用户请求取消当前更新任务的全局标志。
/// 下载循环与各安装阶段都会检查它，命中后尽快返回错误并清理现场。
static UPDATE_CANCELLED: AtomicBool = AtomicBool::new(false);

pub fn request_cancel() {
    UPDATE_CANCELLED.store(true, Ordering::SeqCst);
}

fn ensure_not_cancelled() -> Result<(), String> {
    if UPDATE_CANCELLED.load(Ordering::SeqCst) {
        return Err("更新已被用户取消。".to_string());
    }
    Ok(())
}

fn resource_dir() -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_default();
    let dir = exe.parent().unwrap_or(&exe);
    let bundled = dir.join("_up_").join("resources");
    let resources = if bundled.exists() || dir.join("_up_").exists() {
        bundled
    } else {
        dir.join("resources")
    };
    fs::create_dir_all(&resources).ok();
    resources
}

/// 版本化核心根目录：每次更新安装到 `kernels/<版本>_<安装时间>/`，
/// 始终保留最近两个（最新 + 上一个），更早的在安装成功后自动清理。
fn kernels_dir() -> PathBuf {
    let k = resource_dir().join("kernels");
    fs::create_dir_all(&k).ok();
    k
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledKernel {
    pub name: String,
    pub version: String,
    pub installed_at: String,
    pub is_active: bool,
}

/// 从目录名 `<版本>_<YYYYmmdd>_<HHMMSS>` 解析出安装时间（用于排序）。
/// 不能直接按目录名整体排序：版本号 `b1000` 会排在 `b999` 前面。
fn kernel_dir_timestamp(name: &str) -> Option<String> {
    let parts: Vec<&str> = name.split('_').collect();
    if parts.len() < 3 {
        return None;
    }
    let (date, time) = (parts[parts.len() - 2], parts[parts.len() - 1]);
    let ts = format!("{}_{}", date, time);
    if ts.len() != 15 || !ts.chars().all(|c| c.is_ascii_digit() || c == '_') {
        return None;
    }
    Some(ts)
}

fn parse_kernel_version(name: &str) -> String {
    let parts: Vec<&str> = name.split('_').collect();
    if parts.len() > 2 {
        parts[..parts.len() - 2].join("_")
    } else {
        name.to_string()
    }
}

/// 当前生效的核心目录：kernels 下安装时间最新的一个。
pub fn active_kernel_dir() -> Option<PathBuf> {
    let mut best: Option<(String, PathBuf)> = None;
    if let Ok(entries) = fs::read_dir(kernels_dir()) {
        for entry in entries.flatten() {
            if !entry.path().is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(ts) = kernel_dir_timestamp(&name) {
                if best.as_ref().map_or(true, |(best_ts, _)| ts > *best_ts) {
                    best = Some((ts, entry.path()));
                }
            }
        }
    }
    best.map(|(_, path)| path)
}

/// 当前生效核心的 llama-server.exe 完整路径；没有版本化目录时返回 None（回退旧版平铺布局）。
pub fn active_kernel_exe() -> Option<PathBuf> {
    active_kernel_dir().map(|dir| dir.join(exe_name()))
}

/// 列出本机已安装的版本化核心，按安装时间从新到旧。
pub fn list_installed_kernels() -> Vec<InstalledKernel> {
    let active = active_kernel_dir();
    let mut kernels: Vec<(String, InstalledKernel)> = Vec::new();
    if let Ok(entries) = fs::read_dir(kernels_dir()) {
        for entry in entries.flatten() {
            if !entry.path().is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(ts) = kernel_dir_timestamp(&name) {
                // 目录名里的时间是本地时间，展示时格式化为可读样式。
                let installed_at = chrono::NaiveDateTime::parse_from_str(&ts, "%Y%m%d_%H%M%S")
                    .map(|t| t.format("%Y-%m-%d %H:%M").to_string())
                    .unwrap_or_else(|_| ts.clone());
                kernels.push((
                    ts,
                    InstalledKernel {
                        is_active: active.as_ref().map_or(false, |a| *a == entry.path()),
                        version: parse_kernel_version(&name),
                        name,
                        installed_at,
                    },
                ));
            }
        }
    }
    kernels.sort_by(|a, b| b.0.cmp(&a.0));
    kernels.into_iter().map(|(_, k)| k).collect()
}

/// 安装成功后清理：按安装时间只保留最近 keep 个核心目录。
fn cleanup_old_kernels(keep: usize) {
    let sorted = list_installed_kernels();
    for kernel in sorted.into_iter().skip(keep) {
        let _ = fs::remove_dir_all(kernels_dir().join(&kernel.name));
    }
}

/// 旧版平铺布局（exe/DLL 直接放在 resources 根目录）迁移为版本化目录。
/// 仅在 kernels 目录为空且平铺核心存在时执行一次；迁移失败则保留平铺布局不动。
fn migrate_legacy_runtime(resources: &Path) {
    if !resources.join(exe_name()).exists() || active_kernel_dir().is_some() {
        return;
    }
    let version = detect_installed_version(resources).unwrap_or_else(|| "legacy".to_string());
    let dir = kernels_dir().join(format!(
        "{}_{}",
        safe_version_name(&version),
        chrono::Local::now().format("%Y%m%d_%H%M%S")
    ));
    match copy_runtime_files(resources, &dir) {
        Ok(_) => {
            clear_runtime_files(resources).ok();
            eprintln!("[updater] legacy runtime migrated to {}", dir.display());
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&dir);
            eprintln!("[updater] legacy runtime migration failed: {}", error);
        }
    }
}

fn parse_nvcc_cuda_version(output: &std::process::Output) -> Option<String> {
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    for line in combined.lines() {
        if line.contains("release") {
            if let Some(pos) = line.find("release") {
                let rest = &line[pos + 7..];
                let version = rest
                    .trim()
                    .split(',')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if !version.is_empty() {
                    return Some(version);
                }
            }
        }
    }
    None
}

fn parse_nvidia_smi_cuda_version(output: &std::process::Output) -> Option<String> {
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if let Some(pos) = combined.find("CUDA Version:") {
        let rest = combined[pos + "CUDA Version:".len()..].trim();
        let version: String = rest
            .chars()
            .take_while(|ch| ch.is_ascii_digit() || *ch == '.')
            .collect();
        if !version.is_empty() {
            return Some(version);
        }
    }
    None
}

/// Detect installed NVIDIA CUDA support from driver first, then toolkit.
/// Returns version string like "13.3", "12.4", etc.
pub fn detect_cuda_version() -> Option<String> {
    if let Ok(output) = Command::new("nvidia-smi").output() {
        if let Some(version) = parse_nvidia_smi_cuda_version(&output) {
            return Some(version);
        }
    }
    Command::new("nvcc")
        .arg("--version")
        .output()
        .ok()
        .and_then(|output| parse_nvcc_cuda_version(&output))
}

fn command_text(command: &mut Command) -> Option<String> {
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000);
    }
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Some(combined)
}

pub(crate) fn detect_nvidia_gpu_names() -> Vec<String> {
    let mut command = Command::new("nvidia-smi");
    command.args(["--query-gpu=name", "--format=csv,noheader"]);
    command_text(&mut command)
        .map(|text| {
            text.lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn detect_video_controller_names() -> Vec<String> {
    #[cfg(windows)]
    {
        let mut command = Command::new("powershell");
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name",
        ]);
        return command_text(&mut command)
            .map(|text| {
                text.lines()
                    .map(str::trim)
                    .filter(|line| !line.is_empty())
                    .map(ToString::to_string)
                    .collect()
            })
            .unwrap_or_default();
    }

    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

pub(crate) fn is_real_display_adapter(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    !lower.is_empty()
        && !lower.contains("microsoft basic")
        && !lower.contains("remote")
        && !lower.contains("virtual")
        && !lower.contains("parsec")
}

pub(crate) fn detect_host_gpu_backend() -> (String, Option<String>) {
    let nvidia_names = detect_nvidia_gpu_names();
    if let Some(name) = nvidia_names.first() {
        return ("CUDA".to_string(), Some(name.clone()));
    }

    let controllers = detect_video_controller_names();
    if let Some(name) = controllers
        .iter()
        .find(|name| is_real_display_adapter(name) && name.to_ascii_lowercase().contains("nvidia"))
    {
        return ("CUDA".to_string(), Some(name.clone()));
    }

    if let Some(name) = controllers.iter().find(|name| {
        let lower = name.to_ascii_lowercase();
        is_real_display_adapter(name)
            && (lower.contains("amd")
                || lower.contains("radeon")
                || lower.contains("intel")
                || lower.contains("arc"))
    }) {
        return ("Vulkan".to_string(), Some(name.clone()));
    }

    if let Some(name) = controllers
        .iter()
        .find(|name| is_real_display_adapter(name))
    {
        return ("Vulkan".to_string(), Some(name.clone()));
    }

    ("CPU".to_string(), None)
}

fn parse_cuda_version(value: &str) -> Option<(u32, u32)> {
    let mut parts = value.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().ok()?;
    Some((major, minor))
}

/// NVIDIA RTX 50 系列（Blackwell, compute capability 12.0 / sm_120）
/// 需要 CUDA 12.8+ 的 llama.cpp 构建才有原生 kernel，否则会出现
/// `no kernel image is available for execution on the device` 或 PTX JIT 慢速回退。
pub fn is_blackwell_gpu(name: Option<&str>) -> bool {
    let Some(raw) = name else {
        return false;
    };
    let lower = raw.to_ascii_lowercase();
    if lower.contains("blackwell") {
        return true;
    }
    // 匹配 "RTX 50xx" / "RTX50xx"（覆盖 5090 / 5080 / 5070 Ti / 5070 / 5060 Ti / 5060，
    // 以及 Laptop / D 后缀变体）。刻意不把 sm_120 的 datacenter 卡（B100/B200 等）纳入，
    // 那类卡目前不是本应用的目标用户。
    // 排除 RTX 5000（Ada/Turing 专业卡，非 Blackwell）。
    let bytes = lower.as_bytes();
    let mut i = 0;
    while i + 4 < bytes.len() {
        if &bytes[i..i + 3] == b"rtx" {
            let mut j = i + 3;
            while j < bytes.len() && bytes[j] == b' ' {
                j += 1;
            }
            // 匹配 5060/5070/5080/5090，排除 5000（Ada/Turing）
            if j + 1 < bytes.len()
                && bytes[j] == b'5'
                && matches!(bytes[j + 1], b'6' | b'7' | b'8' | b'9')
            {
                return true;
            }
        }
        i += 1;
    }
    false
}

/// 判断 asset 的 CUDA 版本是否能覆盖 sm_120 kernel。
/// llama.cpp 官方从 CUDA 12.8 起才把 sm_120 加入默认编译目标，CUDA 13.x 同样满足。
fn cuda_asset_supports_blackwell(name: &str) -> bool {
    match cuda_asset_version(name) {
        Some((major, minor)) => (major, minor) >= (12, 8),
        None => false,
    }
}

fn cuda_asset_version(name: &str) -> Option<(u32, u32)> {
    let marker = "cuda-";
    let start = name.find(marker)? + marker.len();
    let suffix = &name[start..];
    let version: String = suffix
        .chars()
        .take_while(|ch| ch.is_ascii_digit() || *ch == '.')
        .collect();
    parse_cuda_version(version.trim_matches('.'))
}

fn cuda_version_from_url(url: &str) -> Option<String> {
    let file_name = url.rsplit('/').next().unwrap_or(url);
    let (major, minor) = cuda_asset_version(file_name)?;
    Some(format!("{}.{}", major, minor))
}

fn cuda_asset_score(name: &str, cuda_version: Option<&str>, blackwell: bool) -> (u8, u32, u32) {
    let Some((asset_major, asset_minor)) = cuda_asset_version(name) else {
        return (3, 0, 0);
    };
    // Blackwell (sm_120) 只在 CUDA 12.8+ 有原生 kernel。低于 12.8 的 asset 装上去
    // 只会走 PTX JIT 或 no-kernel-image 崩溃，因此单独降级到 tier 3——保留可选性
    // （用户仍能手动挑选），但排在所有合规 asset 之后。
    let blackwell_penalty = blackwell && (asset_major, asset_minor) < (12, 8);
    let Some((cuda_major, cuda_minor)) = cuda_version.and_then(parse_cuda_version) else {
        let base = if blackwell_penalty { 3 } else { 1 };
        return (base, u32::MAX - asset_major, u32::MAX - asset_minor);
    };

    let base_tier = if asset_major == cuda_major {
        0
    } else if asset_major > cuda_major {
        1
    } else {
        2
    };
    let tier = if blackwell_penalty { 3 } else { base_tier };
    let distance = if asset_major == cuda_major {
        asset_minor.abs_diff(cuda_minor)
    } else if asset_major > cuda_major {
        asset_major - cuda_major
    } else {
        cuda_major - asset_major
    };
    (tier, distance, u32::MAX - asset_minor)
}

fn cuda_asset_matches(name: &str, cuda_version: Option<&str>, blackwell: bool) -> bool {
    let Some((asset_major, _)) = cuda_asset_version(name) else {
        return false;
    };
    let Some((cuda_major, _)) = cuda_version.and_then(parse_cuda_version) else {
        return false;
    };
    if asset_major != cuda_major {
        return false;
    }
    // Blackwell 只有 12.8+ 的 asset 才算真正 host-matched。
    if blackwell && !cuda_asset_supports_blackwell(name) {
        return false;
    }
    true
}

fn asset_backend(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    if lower.contains("cuda") {
        "CUDA"
    } else if lower.contains("hip") || lower.contains("radeon") {
        "HIP"
    } else if lower.contains("vulkan") || lower.contains("kompute") {
        "Vulkan"
    } else if lower.contains("openvino") {
        "OpenVINO"
    } else if lower.contains("opencl") {
        "OpenCL"
    } else if lower.contains("sycl") {
        "SYCL"
    } else if lower.contains("cpu") || lower.contains("avx") || lower.contains("noavx") {
        "CPU"
    } else {
        "通用"
    }
}

fn is_windows_x64_package(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.contains("win")
        && lower.contains("x64")
        && lower.ends_with(".zip")
        && !lower.starts_with("cudart-")
}

fn is_cudart_package(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.starts_with("cudart-")
        && lower.contains("win")
        && lower.contains("cuda")
        && lower.contains("x64")
        && lower.ends_with(".zip")
}

fn host_matched_asset(
    name: &str,
    cuda_version: Option<&str>,
    host_backend: &str,
    blackwell: bool,
) -> bool {
    let lower = name.to_ascii_lowercase();
    match host_backend {
        "CUDA" => {
            lower.contains("cuda")
                && cuda_version
                    .map(|version| cuda_asset_matches(name, Some(version), blackwell))
                    .unwrap_or(true)
        }
        "Vulkan" => lower.contains("vulkan") || lower.contains("kompute"),
        "CPU" => lower.contains("cpu") || lower.contains("avx") || lower.contains("noavx"),
        _ => false,
    }
}

fn package_asset_score(
    name: &str,
    cuda_version: Option<&str>,
    host_backend: &str,
    blackwell: bool,
) -> (u8, u32, u32, String) {
    let lower = name.to_ascii_lowercase();
    match host_backend {
        "CUDA" => {
            if lower.contains("cuda") {
                if cuda_version.is_none() {
                    return (0, 0, 0, lower);
                }
                let (tier, distance, minor_score) = cuda_asset_score(name, cuda_version, blackwell);
                return (tier, distance, minor_score, lower);
            }
            if lower.contains("vulkan") {
                return (4, 0, 0, lower);
            }
            if lower.contains("cpu") || lower.contains("avx") || lower.contains("noavx") {
                return (5, 0, 0, lower);
            }
        }
        "Vulkan" => {
            if lower.contains("vulkan") {
                return (0, 0, 0, lower);
            }
            if lower.contains("cpu") || lower.contains("avx") || lower.contains("noavx") {
                return (4, 0, 0, lower);
            }
            if lower.contains("cuda") {
                return (6, 0, 0, lower);
            }
        }
        "CPU" => {
            if lower.contains("cpu") || lower.contains("avx") || lower.contains("noavx") {
                return (0, 0, 0, lower);
            }
            if lower.contains("vulkan") {
                return (5, 0, 0, lower);
            }
            if lower.contains("cuda") {
                return (6, 0, 0, lower);
            }
        }
        _ => {}
    }
    (9, 0, 0, lower)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateLogEntry {
    pub version: String,
    pub date: String,
    pub action: String, // "updated" | "rolled_back"
    pub from_version: Option<String>,
    #[serde(default)]
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UpdateLog {
    pub entries: Vec<UpdateLogEntry>,
    pub current_version: Option<String>,
}

fn load_log() -> UpdateLog {
    if let Ok(content) = fs::read_to_string(UPDATE_LOG.as_path()) {
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        UpdateLog::default()
    }
}

fn save_log(log: &UpdateLog) {
    if let Ok(json) = serde_json::to_string_pretty(log) {
        fs::write(UPDATE_LOG.as_path(), json).ok();
    }
}

#[allow(dead_code)]
pub fn get_current_version() -> Option<String> {
    load_log().current_version
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReleaseInfo {
    pub tag_name: String,
    pub version: String,
    pub assets: Vec<AssetInfo>,
    pub body: String,
    pub published_at: String,
    pub cuda_version: Option<String>,
    pub cuda_matched: bool,
    pub host_backend: String,
    pub gpu_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetInfo {
    pub name: String,
    pub browser_download_url: String,
    pub size: u64,
    pub backend: String,
    pub matches_host: bool,
}

/// 校验并构造代理配置：仅接受 http/https 代理地址（本机代理如 http://127.0.0.1:7890 是主要用途）。
pub fn build_proxy(proxy_url: Option<&str>) -> Result<Option<reqwest::Proxy>, String> {
    let Some(url) = proxy_url.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let parsed = reqwest::Url::parse(url).map_err(|_| format!("代理地址格式不正确：{}", url))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("代理地址仅支持 http/https 协议".to_string());
    }
    if parsed.host_str().map_or(true, |host| host.is_empty()) {
        return Err("代理地址缺少主机名".to_string());
    }
    let proxy = reqwest::Proxy::all(parsed.as_str()).map_err(|e| format!("代理配置无效: {}", e))?;
    Ok(Some(proxy))
}

fn build_client(proxy_url: Option<&str>, timeout_secs: u64, connect_timeout_secs: u64) -> Result<reqwest::blocking::Client, String> {
    let mut builder = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .connect_timeout(std::time::Duration::from_secs(connect_timeout_secs));
    if let Some(proxy) = build_proxy(proxy_url)? {
        builder = builder.proxy(proxy);
    }
    builder.build().map_err(|e| e.to_string())
}

fn github_api_json(path: &str, proxy_url: Option<&str>) -> Result<serde_json::Value, String> {
    // 单条 release 的 JSON 可达数百 KB（上千个资产），
    // 读取整个响应必须留足时间，否则会在流中断时报“解码失败”。
    let client = build_client(proxy_url, 60, 30)?;
    let url = format!("https://api.github.com/repos/ggml-org/llama.cpp/{}", path);
    // 网络抖动或偶发中断重试一次；未认证限流（403）不重试。
    let mut last_error = String::new();
    for attempt in 0..2 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
        let resp = match client
            .get(&url)
            .header("User-Agent", "AgentLLM/0.2.0")
            .header("Accept", "application/vnd.github+json")
            .send()
        {
            Ok(resp) => resp,
            Err(e) => {
                last_error = e.to_string();
                continue;
            }
        };
        if resp.status() == 403 {
            last_error = "GitHub API 限流，请稍后再试".to_string();
            continue;
        }
        if !resp.status().is_success() {
            last_error = format!("请求失败: {}", resp.status());
            continue;
        }
        let body = match resp.bytes() {
            Ok(bytes) => bytes,
            Err(error) => {
                last_error = format!("读取更新源响应失败: {}", error);
                continue;
            }
        };
        match serde_json::from_slice(&body) {
            Ok(json) => return Ok(json),
            Err(error) => {
                last_error = format!("更新源响应解析失败: {}", error);
                continue;
            }
        }
    }
    Err(last_error)
}

/// 从一条 release JSON 中提取 Windows x64 安装包资产，按本机硬件打分排序，
/// 并报告是否存在与本机 CUDA 主版本匹配的 CUDA 包。
fn collect_windows_assets(
    item: &serde_json::Value,
    cuda_version: Option<&str>,
    host_backend: &str,
    blackwell: bool,
) -> (Vec<AssetInfo>, bool) {
    let mut assets = Vec::new();
    let mut cuda_matched = false;
    if let Some(arr) = item["assets"].as_array() {
        for a in arr {
            let name = a["name"].as_str().unwrap_or("");
            if is_windows_x64_package(name) {
                let matches_cuda = name.to_ascii_lowercase().contains("cuda")
                    && cuda_asset_matches(name, cuda_version, blackwell);
                if matches_cuda {
                    cuda_matched = true;
                }
                let matches_host = host_matched_asset(name, cuda_version, host_backend, blackwell);
                assets.push(AssetInfo {
                    name: name.to_string(),
                    browser_download_url: a["browser_download_url"]
                        .as_str()
                        .unwrap_or("")
                        .to_string(),
                    size: a["size"].as_u64().unwrap_or(0),
                    backend: asset_backend(name).to_string(),
                    matches_host,
                });
            }
        }
    }
    assets.sort_by_key(|asset| package_asset_score(&asset.name, cuda_version, host_backend, blackwell));
    (assets, cuda_matched)
}

fn release_info_from_value(
    item: &serde_json::Value,
    cuda_version: &Option<String>,
    host_backend: &str,
    gpu_name: &Option<String>,
    blackwell: bool,
) -> ReleaseInfo {
    let tag_name = item["tag_name"].as_str().unwrap_or("").to_string();
    let (assets, cuda_matched) =
        collect_windows_assets(item, cuda_version.as_deref(), host_backend, blackwell);
    let version = tag_name.trim_start_matches('v').to_string();
    ReleaseInfo {
        tag_name,
        version,
        assets,
        body: item["body"].as_str().unwrap_or("").to_string(),
        published_at: item["published_at"].as_str().unwrap_or("").to_string(),
        cuda_version: cuda_version.clone(),
        cuda_matched,
        host_backend: host_backend.to_string(),
        gpu_name: gpu_name.clone(),
    }
}

/// 在发布列表（按时间倒序）中取第一个确实带 Windows x64 安装包的版本。
/// 上游自 v0.3.0 起把 bXXXX 滚动构建标记为 prerelease，
/// releases/latest 会落在不带安装包的稳定版上，因此不能再用 latest 端点。
fn pick_latest_build_release(
    json: &serde_json::Value,
    cuda_version: &Option<String>,
    host_backend: &str,
    gpu_name: &Option<String>,
    blackwell: bool,
) -> Option<ReleaseInfo> {
    json.as_array()?.iter().map(|item| {
        release_info_from_value(item, cuda_version, host_backend, gpu_name, blackwell)
    }).find(|info| !info.assets.is_empty())
}

pub fn check_latest_release(proxy_url: Option<&str>) -> Result<ReleaseInfo, String> {
    let json = github_api_json("releases?per_page=15", proxy_url)?;

    let (host_backend, gpu_name) = detect_host_gpu_backend();
    let cuda_version = detect_cuda_version();
    let blackwell = is_blackwell_gpu(gpu_name.as_deref());

    pick_latest_build_release(&json, &cuda_version, &host_backend, &gpu_name, blackwell)
        .ok_or_else(|| "最近的发布中未找到可用的 Windows x64 安装包，请稍后再试。".to_string())
}

pub fn list_recent_releases(count: usize, proxy_url: Option<&str>) -> Result<Vec<ReleaseInfo>, String> {
    // 多请求一倍以过滤掉不带 Windows 安装包的公告版；比默认拉满 30 条响应小得多。
    let per_page = (count.saturating_mul(2)).clamp(10, 30);
    let json = github_api_json(&format!("releases?per_page={}", per_page), proxy_url)?;
    let (host_backend, gpu_name) = detect_host_gpu_backend();
    let cuda_version = detect_cuda_version();
    let blackwell = is_blackwell_gpu(gpu_name.as_deref());

    let mut releases = Vec::new();
    if let Some(arr) = json.as_array() {
        for item in arr.iter() {
            if releases.len() >= count {
                break;
            }
            let info =
                release_info_from_value(item, &cuda_version, &host_backend, &gpu_name, blackwell);
            // 跳过不带 Windows 安装包的发布（如 v0.3.0 这类纯公告稳定版），
            // 否则列表里会出现无法安装的空条目。
            if info.assets.is_empty() {
                continue;
            }
            releases.push(info);
        }
    }

    Ok(releases)
}

const GITHUB_MIRRORS: &[&str] = &["https://ghfast.top/"];

/// 允许直连下载发布包的主机。发布包最终会被当作可执行文件运行，
/// 因此下载地址必须限定在 GitHub 官方域名，不能接受前端传入的任意 URL。
const ALLOWED_RELEASE_HOSTS: &[&str] = &[
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];

/// 从 `https://host/path` 中取出小写 host。仅接受 https。
fn url_host(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://")?;
    let host = rest
        .split(['/', '?', '#'])
        .next()?
        .rsplit('@')
        .next()?
        .split(':')
        .next()?;
    if host.is_empty() {
        return None;
    }
    Some(host.to_ascii_lowercase())
}

fn host_allowed(host: &str, allowed: &[&str]) -> bool {
    allowed
        .iter()
        .any(|candidate| host == *candidate || host.ends_with(&format!(".{}", candidate)))
}

/// 校验发布包 URL 必须是 https 且落在 GitHub 官方域名内。
fn ensure_release_url_allowed(url: &str) -> Result<(), String> {
    match url_host(url) {
        Some(host) if host_allowed(&host, ALLOWED_RELEASE_HOSTS) => Ok(()),
        Some(host) => Err(format!(
            "拒绝从非官方地址下载发布包：{}（仅允许 GitHub 官方域名）",
            host
        )),
        None => Err("发布包地址无效，必须是 https:// 开头的 GitHub 官方地址。".to_string()),
    }
}

/// 校验加速源 URL 至少是 https。加速源内容不可信，
/// 因此它下载到的字节必须逐一通过 SHA256 比对才会被采用。
fn ensure_mirror_url_allowed(mirror: &str) -> Result<(), String> {
    match url_host(mirror) {
        Some(_) => Ok(()),
        None => Err(format!(
            "加速源地址无效，必须是 https:// 开头：{}",
            mirror
        )),
    }
}

/// 从发布包 URL 中解析出 release tag 与 asset 文件名。
/// 形如 `https://github.com/ggml-org/llama.cpp/releases/download/<tag>/<asset>`。
fn parse_release_asset_url(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("https://")?;
    let path = rest.split_once('/')?.1;
    let marker = "releases/download/";
    let after = path.split_once(marker)?.1;
    let (tag, asset) = after.split_once('/')?;
    if tag.is_empty() || asset.is_empty() || asset.contains('/') {
        return None;
    }
    Some((tag.to_string(), asset.to_string()))
}

/// 向 GitHub API 查询指定 asset 的官方 SHA256（API 返回形如 `sha256:abc...`）。
/// 这是整条更新链的信任根：没有它就无法判断下载到的字节是否被篡改。
fn fetch_expected_sha256(tag: &str, asset_name: &str, proxy_url: Option<&str>) -> Result<String, String> {
    // tag 会拼进 API 路径，必须先排除路径穿越与注入字符。
    if tag.is_empty()
        || !tag
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+'))
    {
        return Err(format!("release tag 非法：{}", tag));
    }
    let json = github_api_json(&format!("releases/tags/{}", tag), proxy_url)?;
    let assets = json["assets"]
        .as_array()
        .ok_or_else(|| "更新源未返回 assets 列表，无法校验发布包。".to_string())?;
    for item in assets {
        if item["name"].as_str() == Some(asset_name) {
            let digest = item["digest"]
                .as_str()
                .ok_or_else(|| format!("更新源未提供 {} 的校验和，已中止更新。", asset_name))?;
            let hex = digest
                .strip_prefix("sha256:")
                .ok_or_else(|| format!("不支持的校验和格式：{}", digest))?
                .trim()
                .to_ascii_lowercase();
            if hex.len() != 64 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
                return Err(format!("校验和格式非法：{}", digest));
            }
            return Ok(hex);
        }
    }
    Err(format!("更新源中找不到发布包 {}，已中止更新。", asset_name))
}

fn mirror_download_url(mirror: &str, url: &str) -> String {
    format!(
        "{}/{}",
        mirror.trim_end_matches('/'),
        url.trim_start_matches('/')
    )
}

fn try_download_stream(
    client: &reqwest::blocking::Client,
    url: &str,
    use_mirror: bool,
    mirror_url: Option<&str>,
    expected_sha256: &str,
    proxy_url: Option<&str>,
    on_progress: &dyn Fn(String),
) -> Result<Vec<u8>, String> {
    if use_mirror {
        // 按本机网络实测顺序尝试发布包加速源，失败后仍回退 GitHub 直连。
        let mirrors_to_try = if let Some(m) = mirror_url {
            vec![m.to_string()]
        } else {
            GITHUB_MIRRORS.iter().map(|s| s.to_string()).collect()
        };

        for mirror in mirrors_to_try {
            on_progress(format!("尝试加速源: {}", mirror));
            let mirrored = mirror_download_url(&mirror, url);
            match client.get(&mirrored).send() {
                Ok(resp) => {
                    if !resp.status().is_success() {
                        on_progress(format!("加速源返回 HTTP {}，跳过", resp.status()));
                        continue;
                    }
                    match download_with_progress(resp, on_progress) {
                        Ok(bytes) => match validate_downloaded_zip(&bytes) {
                            Ok(()) => {
                                // 加速源不可信：校验和不一致就换下一个源，绝不采用。
                                let actual = sha256_hex(&bytes);
                                if actual == expected_sha256 {
                                    return Ok(bytes);
                                }
                                on_progress(format!(
                                    "加速源内容校验和不匹配（期望 {}...，实际 {}...），跳过",
                                    &expected_sha256[..12],
                                    &actual[..12]
                                ));
                            }
                            Err(error) => {
                                on_progress(format!("加速源返回内容无效：{}，跳过", error));
                            }
                        },
                        Err(error) => {
                            on_progress(format!("加速源下载失败: {}", error));
                        }
                    }
                }
                Err(e) => {
                    on_progress(format!("加速源失败: {}", e));
                }
            }
        }
        // Fallback to direct
        on_progress("所有加速源失败，尝试直连...".to_string());
    }

    // Try direct connection with longer timeout（配置了代理时同样经过代理）
    on_progress("直连下载中...".to_string());
    let direct_client = build_client(proxy_url, 600, 30)?;

    match direct_client.get(url).send() {
        Ok(resp) => {
            if resp.status().is_success() {
                let bytes = download_with_progress(resp, on_progress)?;
                let actual = sha256_hex(&bytes);
                if actual != expected_sha256 {
                    return Err(format!(
                        "发布包校验和不匹配，已中止安装（期望 {}...，实际 {}...）。",
                        &expected_sha256[..12],
                        &actual[..12]
                    ));
                }
                return Ok(bytes);
            }
            Err(format!("下载失败: HTTP {}", resp.status()))
        }
        Err(e) => Err(format!("连接失败: {}", e)),
    }
}

fn download_with_progress(
    resp: reqwest::blocking::Response,
    on_progress: &dyn Fn(String),
) -> Result<Vec<u8>, String> {
    let total = resp.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut bytes = Vec::new();
    let mut reader = resp;

    let mut buffer = [0u8; 8192];
    loop {
        // 每个数据块都检查取消标志，让「停止下载」在最短时间内生效。
        ensure_not_cancelled()?;
        let n = reader.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..n]);
        downloaded += n as u64;

        if total > 0 {
            let pct = (downloaded as f64 / total as f64 * 100.0) as u32;
            let mb_down = downloaded as f64 / 1024.0 / 1024.0;
            let mb_total = total as f64 / 1024.0 / 1024.0;
            on_progress(format!(
                "下载中: {}% ({:.1}/{:.1} MB)",
                pct, mb_down, mb_total
            ));
        } else {
            let mb_down = downloaded as f64 / 1024.0 / 1024.0;
            on_progress(format!("下载中: {:.1} MB", mb_down));
        }
    }

    Ok(bytes)
}

/// 下载并强制校验一个发布包。
///
/// 调用方必须先从 GitHub API 取到官方 SHA256 再传进来；
/// 校验不通过一律返回 Err，绝不允许未校验的字节流入解压和执行环节。
fn download_zip_bytes(
    client: &reqwest::blocking::Client,
    label: &str,
    url: &str,
    use_mirror: bool,
    mirror_url: Option<&str>,
    expected_sha256: &str,
    proxy_url: Option<&str>,
    on_progress: &dyn Fn(String),
) -> Result<(Vec<u8>, String), String> {
    on_progress(format!("正在下载 {}...", label));
    let bytes = try_download_stream(client, url, use_mirror, mirror_url, expected_sha256, proxy_url, &|msg| {
        eprintln!("[updater] {}", msg);
        on_progress(msg);
    })?;

    validate_downloaded_zip(&bytes)?;
    let sha256 = sha256_hex(&bytes);
    if sha256 != expected_sha256 {
        return Err(format!(
            "{} 校验和不匹配，已中止安装（期望 {}...，实际 {}...）。",
            label,
            &expected_sha256[..12],
            &sha256[..12]
        ));
    }
    on_progress(format!(
        "{} 下载完成，SHA256 校验通过：{}...",
        label,
        &sha256[..12]
    ));
    Ok((bytes, sha256))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{:02x}", byte)).collect()
}

fn validate_downloaded_zip(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < 1_000_000 {
        return Err("下载文件过小，可能不是完整发布包。".to_string());
    }
    if !bytes.starts_with(b"PK") {
        return Err("下载文件不是有效 zip 包。".to_string());
    }
    Ok(())
}

fn safe_version_name(version: &str) -> String {
    version
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn exe_name() -> &'static str {
    if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    }
}

fn find_llama_server(root: &Path) -> Result<PathBuf, String> {
    let name = exe_name();
    let direct_path = root.join(name);
    if direct_path.exists() {
        return Ok(direct_path);
    }

    for entry in walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(|entry| entry.ok())
    {
        if entry.file_name().to_string_lossy() == name {
            return Ok(entry.path().to_path_buf());
        }
    }

    Err("解压后未找到 llama-server.exe。".to_string())
}

fn companion_cudart_url(url: &str) -> Option<String> {
    let file_name = url.rsplit('/').next()?.trim();
    let lower = file_name.to_ascii_lowercase();
    if is_cudart_package(file_name) || !lower.contains("bin-win-cuda") {
        return None;
    }

    let cuda_version = cuda_version_from_url(file_name)?;
    let cudart_file = format!("cudart-llama-bin-win-cuda-{}-x64.zip", cuda_version);
    let prefix = url.strip_suffix(file_name)?;
    Some(format!("{}{}", prefix, cudart_file))
}

fn validate_llama_server(exe_path: &Path) -> Result<String, String> {
    let mut command = Command::new(exe_path);
    command.arg("--version");
    if let Some(parent) = exe_path.parent() {
        command.current_dir(parent);
    }
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000);
    }

    let output = command
        .output()
        .map_err(|error| format!("无法运行新版 llama-server: {}", error))?;
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let preview = combined.trim();
    if !output.status.success() {
        return Err(format!(
            "新版 llama-server --version 验证失败（退出码 {:?}）：{}",
            output.status.code(),
            if preview.is_empty() { "无输出" } else { preview }
        ));
    }
    let lower = preview.to_ascii_lowercase();
    if !lower.contains("version") && !lower.contains("llama") {
        return Err("新版 llama-server 输出异常，已取消安装。".to_string());
    }
    Ok(preview
        .lines()
        .next()
        .unwrap_or("llama-server 已验证")
        .trim()
        .to_string())
}

fn copy_runtime_files_inner(
    from_dir: &Path,
    to_dir: &Path,
    require_server_exe: bool,
) -> Result<Vec<String>, String> {
    fs::create_dir_all(to_dir).map_err(|error| error.to_string())?;
    let mut copied = Vec::new();
    for entry in walkdir::WalkDir::new(from_dir)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file())
    {
        if entry
            .path()
            .strip_prefix(from_dir)
            .ok()
            .and_then(|path| path.components().next())
            .is_some_and(|component| component.as_os_str().to_string_lossy() == "versions")
        {
            continue;
        }
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        let lower = name_str.to_ascii_lowercase();
        if lower.ends_with(".dll") || name_str == exe_name() {
            fs::copy(entry.path(), to_dir.join(name_str.to_string()))
                .map_err(|error| format!("复制文件失败 {}: {}", name_str, error))?;
            copied.push(name_str.to_string());
        }
    }

    if require_server_exe && !copied.iter().any(|name| name == exe_name()) {
        return Err("发布包中没有可安装的 llama-server.exe。".to_string());
    }
    Ok(copied)
}

fn copy_runtime_files(from_dir: &Path, to_dir: &Path) -> Result<Vec<String>, String> {
    copy_runtime_files_inner(from_dir, to_dir, true)
}

fn copy_runtime_dependency_files(from_dir: &Path, to_dir: &Path) -> Result<Vec<String>, String> {
    copy_runtime_files_inner(from_dir, to_dir, false)
}

fn clear_runtime_files(dir: &Path) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }

    for entry in fs::read_dir(dir).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        let lower = name_str.to_ascii_lowercase();
        if lower.ends_with(".dll") || name_str == exe_name() {
            fs::remove_file(entry.path())
                .map_err(|error| format!("移除旧核心文件失败 {}: {}", name_str, error))?;
        }
    }
    Ok(())
}

fn detect_installed_version(resources: &Path) -> Option<String> {
    let current_exe = resources.join(exe_name());
    validate_llama_server(&current_exe)
        .ok()
        .and_then(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.replace(':', "_").replace(' ', "_"))
            }
        })
        .or_else(|| load_log().current_version)
}

fn expand_zip(zip_path: &Path, extract_dir: &Path) -> Result<(), String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("无法打开压缩文件: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("无法读取压缩文件: {}", e))?;
    fs::create_dir_all(extract_dir).map_err(|e| format!("无法创建解压目录: {}", e))?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("读取压缩条目失败: {}", e))?;
        // enclosed_name() 会在条目名包含 `..` 或为绝对路径时返回 None。
        // 这种条目必须直接拒绝：绝不能退回未清洗的 entry.name()，
        // 否则 PathBuf::join 遇到绝对路径会丢弃 extract_dir，形成任意路径写入（Zip Slip）。
        let entry_name = match entry.enclosed_name() {
            Some(name) => name.to_path_buf(),
            None => {
                return Err(format!(
                    "压缩包内条目路径非法，已中止解压：{}",
                    entry.name()
                ));
            }
        };
        let target_path = extract_dir.join(&entry_name);
        // 二次确认：规范化后的目标必须仍落在解压目录内。
        if !target_path.starts_with(extract_dir) {
            return Err(format!(
                "压缩包内条目试图写出解压目录，已中止解压：{}",
                entry.name()
            ));
        }

        if entry.is_dir() {
            fs::create_dir_all(&target_path).map_err(|e| format!("创建目录失败: {}", e))?;
        } else {
            if let Some(parent) = target_path.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败: {}", e))?;
            }
            let mut out = fs::File::create(&target_path).map_err(|e| format!("创建文件失败: {}", e))?;
            std::io::copy(&mut entry, &mut out).map_err(|e| format!("解压文件失败: {}", e))?;
        }
    }
    Ok(())
}

pub fn download_and_install(
    url: &str,
    version: &str,
    use_mirror: bool,
    mirror_url: Option<&str>,
    proxy_url: Option<&str>,
    on_progress: impl Fn(String),
) -> Result<String, String> {
    eprintln!(
        "[updater] starting download: url={}, version={}, use_mirror={}, proxy={}",
        url, version, use_mirror, proxy_url.unwrap_or("<none>")
    );

    // 新任务开始，清除上一次的取消请求。
    UPDATE_CANCELLED.store(false, Ordering::SeqCst);

    // 下载地址来自前端参数，必须先限定在 GitHub 官方域名，再取官方校验和。
    ensure_release_url_allowed(url)?;
    if let Some(mirror) = mirror_url {
        ensure_mirror_url_allowed(mirror)?;
    }
    ensure_not_cancelled()?;
    let (release_tag, asset_name) = parse_release_asset_url(url)
        .ok_or_else(|| "无法从发布包地址解析出版本与文件名，已中止更新。".to_string())?;

    on_progress("正在获取官方校验和...".to_string());
    let expected_sha256 = fetch_expected_sha256(&release_tag, &asset_name, proxy_url)?;
    ensure_not_cancelled()?;

    let client = build_client(proxy_url, 600, 30)?;

    let (bytes, sha256) = download_zip_bytes(
        &client,
        &format!("llama.cpp {}", version),
        url,
        use_mirror,
        mirror_url,
        &expected_sha256,
        proxy_url,
        &on_progress,
    )?;
    eprintln!("[updater] download complete, size: {} bytes", bytes.len());

    let safe_version = safe_version_name(version);
    let temp_root = std::env::temp_dir().join(format!(
        "agent-llm-llama-{}-{}",
        safe_version,
        chrono::Local::now().format("%Y%m%d_%H%M%S")
    ));
    let zip_path = temp_root.join("package.zip");
    let extract_dir = temp_root.join("extract");
    let runtime_zip_path = temp_root.join("runtime.zip");
    let runtime_extract_dir = temp_root.join("runtime");
    let staging_dir = temp_root.join("staging");
    fs::create_dir_all(&temp_root).map_err(|error| error.to_string())?;

    // 确保临时目录在所有路径（包括错误路径）都被清理
    struct TempGuard(PathBuf);
    impl Drop for TempGuard {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let _guard = TempGuard(temp_root.clone());
    {
        let mut file = fs::File::create(&zip_path).map_err(|error| error.to_string())?;
        file.write_all(&bytes).map_err(|error| error.to_string())?;
    }

    on_progress("正在解压主程序包...".to_string());
    ensure_not_cancelled()?;
    expand_zip(&zip_path, &extract_dir)?;

    on_progress("正在验证发布包...".to_string());
    let exe_path = find_llama_server(&extract_dir)?;
    let source_dir = exe_path
        .parent()
        .ok_or_else(|| "无法读取 llama-server 所在目录。".to_string())?;
    let server_version = validate_llama_server(&exe_path)?;
    eprintln!("[updater] validated package: {}", server_version);

    ensure_not_cancelled()?;
    fs::create_dir_all(&staging_dir).map_err(|error| error.to_string())?;
    let copied = copy_runtime_files(source_dir, &staging_dir)?;

    let mut runtime_copied = Vec::new();
    if let Some(runtime_url) = companion_cudart_url(url) {
        on_progress("检测到 CUDA 发布包，正在下载配套 CUDA runtime...".to_string());
        ensure_not_cancelled()?;
        // 配套 runtime 同样要过官方域名与校验和两道关。
        ensure_release_url_allowed(&runtime_url)?;
        let (runtime_tag, runtime_asset) = parse_release_asset_url(&runtime_url)
            .ok_or_else(|| "无法解析 CUDA runtime 地址，已中止更新。".to_string())?;
        let expected_runtime_sha256 = fetch_expected_sha256(&runtime_tag, &runtime_asset, proxy_url)?;
        let (runtime_bytes, runtime_sha256) = download_zip_bytes(
            &client,
            "CUDA runtime",
            &runtime_url,
            use_mirror,
            mirror_url,
            &expected_runtime_sha256,
            proxy_url,
            &on_progress,
        )?;
        eprintln!(
            "[updater] runtime download complete, size: {} bytes, sha256={}",
            runtime_bytes.len(),
            runtime_sha256
        );
        {
            let mut file =
                fs::File::create(&runtime_zip_path).map_err(|error| error.to_string())?;
            file.write_all(&runtime_bytes)
                .map_err(|error| error.to_string())?;
        }
        on_progress("正在解压 CUDA runtime...".to_string());
        expand_zip(&runtime_zip_path, &runtime_extract_dir)?;
        runtime_copied = copy_runtime_dependency_files(&runtime_extract_dir, &staging_dir)?;
        if runtime_copied.is_empty() {
            return Err("CUDA runtime 包中没有找到可安装的 DLL，已取消安装。".to_string());
        }
        on_progress(format!(
            "CUDA runtime 已验证，准备安装 {} 个依赖文件。",
            runtime_copied.len()
        ));
    }

    validate_llama_server(&staging_dir.join(exe_name()))?;
    ensure_not_cancelled()?;
    on_progress(format!(
        "发布包已验证，准备安装 {} 个核心文件、{} 个 CUDA runtime 文件。",
        copied.len(),
        runtime_copied.len()
    ));

    let resources = resource_dir();
    let from_version = load_log()
        .current_version
        .or_else(|| detect_installed_version(&resources));

    // 旧版平铺核心先迁移成版本化目录，作为「上一个版本」保留。
    ensure_not_cancelled()?;
    on_progress("正在整理本机核心目录...".to_string());
    migrate_legacy_runtime(&resources);

    // 每次更新都新建独立目录：kernels/<版本>_<安装时间>/，
    // 装好并验证后才切换生效；失败只影响新目录，旧核心毫发无损。
    on_progress("正在安装新核心...".to_string());
    let install_dir = kernels_dir().join(format!(
        "{}_{}",
        safe_version_name(version),
        chrono::Local::now().format("%Y%m%d_%H%M%S")
    ));
    let install_result = (|| -> Result<(), String> {
        fs::create_dir_all(&install_dir).map_err(|error| error.to_string())?;
        copy_runtime_files(&staging_dir, &install_dir)?;
        validate_llama_server(&install_dir.join(exe_name()))?;
        Ok(())
    })();

    if let Err(error) = install_result {
        eprintln!("[updater] install failed: {}", error);
        // 安装失败直接丢弃新目录；旧核心未被触碰，无需回滚。
        let _ = fs::remove_dir_all(&install_dir);
        return Err(format!("安装失败，原核心保持不变：{}", error));
    }

    // 保留最近两个核心目录：最新的 + 更新前的一个。
    cleanup_old_kernels(2);

    let installed_version = validate_llama_server(&install_dir.join(exe_name()))?;
    eprintln!("[updater] installed version: {} at {}", installed_version, install_dir.display());

    let mut log = load_log();
    log.entries.push(UpdateLogEntry {
        version: version.to_string(),
        date: chrono::Local::now().format("%Y-%m-%d %H:%M").to_string(),
        action: "updated".to_string(),
        from_version,
        sha256: Some(sha256),
    });
    log.current_version = Some(version.to_string());
    save_log(&log);

    on_progress("安装完成，下次启动模型时生效".to_string());
    Ok(format!("llama.cpp 内核已更新到 {}", version))
}

pub fn get_update_log() -> Vec<UpdateLogEntry> {
    load_log().entries
}

#[cfg(test)]
mod tests {
    use super::*;

    const REAL_ASSET_URL: &str = "https://github.com/ggml-org/llama.cpp/releases/download/b6459/llama-b6459-bin-win-cuda-12.4-x64.zip";

    #[test]
    fn accepts_official_github_release_hosts() {
        assert!(ensure_release_url_allowed(REAL_ASSET_URL).is_ok());
        assert!(ensure_release_url_allowed(
            "https://objects.githubusercontent.com/some/path/pkg.zip"
        )
        .is_ok());
    }

    #[test]
    fn rejects_non_github_and_plaintext_release_urls() {
        // 发布包最终会被当作可执行文件运行，非官方域名必须拒绝。
        assert!(ensure_release_url_allowed("https://evil.example.com/pkg.zip").is_err());
        // 仿冒域名不能因为包含 github.com 子串就通过。
        assert!(ensure_release_url_allowed("https://github.com.evil.example/pkg.zip").is_err());
        // 明文 http 一律拒绝。
        assert!(ensure_release_url_allowed(
            "http://github.com/ggml-org/llama.cpp/releases/download/b1/pkg.zip"
        )
        .is_err());
        // userinfo 混淆写法不能骗过 host 解析。
        assert!(
            ensure_release_url_allowed("https://github.com@evil.example.com/pkg.zip").is_err()
        );
    }

    #[test]
    fn parses_tag_and_asset_from_release_url() {
        let (tag, asset) = parse_release_asset_url(REAL_ASSET_URL).expect("应能解析");
        assert_eq!(tag, "b6459");
        assert_eq!(asset, "llama-b6459-bin-win-cuda-12.4-x64.zip");
    }

    #[test]
    fn rejects_urls_without_a_release_asset_path() {
        assert!(parse_release_asset_url("https://github.com/ggml-org/llama.cpp").is_none());
        assert!(parse_release_asset_url("https://github.com/a/b/releases/download/tagonly").is_none());
    }

    #[test]
    fn subdomains_of_allowed_hosts_are_accepted_but_suffix_tricks_are_not() {
        assert!(host_allowed("objects.githubusercontent.com", ALLOWED_RELEASE_HOSTS));
        assert!(!host_allowed("notgithub.com", ALLOWED_RELEASE_HOSTS));
        assert!(!host_allowed("github.com.attacker.net", ALLOWED_RELEASE_HOSTS));
    }

    /// 上游 v0.3.0 式的稳定版公告：只有 nightly-tag.txt，没有 Windows 安装包。
    fn assetless_stable_release_json() -> serde_json::Value {
        serde_json::json!({
            "tag_name": "v0.3.0",
            "body": "stable announcement",
            "published_at": "2026-08-25T10:22:54Z",
            "assets": [
                { "name": "nightly-tag.txt", "browser_download_url": "https://github.com/ggml-org/llama.cpp/releases/download/v0.3.0/nightly-tag.txt", "size": 7 }
            ]
        })
    }

    fn build_release_json(tag: &str) -> serde_json::Value {
        serde_json::json!({
            "tag_name": tag,
            "body": "build",
            "published_at": "2026-08-27T00:00:00Z",
            "assets": [
                { "name": format!("cudart-llama-bin-win-cuda-12.4-x64.zip"), "browser_download_url": format!("https://github.com/ggml-org/llama.cpp/releases/download/{tag}/cudart-llama-bin-win-cuda-12.4-x64.zip"), "size": 5_000_000u64 },
                { "name": format!("llama-{tag}-bin-win-cpu-x64.zip"), "browser_download_url": format!("https://github.com/ggml-org/llama.cpp/releases/download/{tag}/llama-{tag}-bin-win-cpu-x64.zip"), "size": 20_000_000u64 },
                { "name": format!("llama-{tag}-bin-win-cuda-12.4-x64.zip"), "browser_download_url": format!("https://github.com/ggml-org/llama.cpp/releases/download/{tag}/llama-{tag}-bin-win-cuda-12.4-x64.zip"), "size": 40_000_000u64 },
                { "name": format!("llama-{tag}-bin-ubuntu-x64.tar.gz"), "browser_download_url": format!("https://github.com/ggml-org/llama.cpp/releases/download/{tag}/llama-{tag}-bin-ubuntu-x64.tar.gz"), "size": 30_000_000u64 }
            ]
        })
    }

    #[test]
    fn pick_latest_skips_assetless_stable_release() {
        let json = serde_json::json!([
            assetless_stable_release_json(),
            build_release_json("b10642")
        ]);
        let info = pick_latest_build_release(&json, &None, "CPU", &None, false)
            .expect("应选中带安装包的 b10642");
        assert_eq!(info.tag_name, "b10642");
        assert_eq!(info.version, "b10642");
        // cudart 配套包不能作为主安装包出现，非 Windows 包也要过滤掉。
        assert!(info.assets.iter().all(|a| !a.name.starts_with("cudart-")));
        assert!(info.assets.iter().all(|a| a.name.contains("win")));
        assert_eq!(info.assets.len(), 2);
    }

    #[test]
    fn pick_latest_returns_none_when_no_windows_packages() {
        let json = serde_json::json!([assetless_stable_release_json()]);
        assert!(pick_latest_build_release(&json, &None, "CPU", &None, false).is_none());
    }

    #[test]
    fn pick_latest_prefers_cuda_asset_matching_host_cuda_major() {
        let json = serde_json::json!([build_release_json("b10642")]);
        let info = pick_latest_build_release(
            &json,
            &Some("12.8".to_string()),
            "CUDA",
            &Some("NVIDIA GeForce RTX 4070".to_string()),
            false,
        )
        .expect("应选中 b10642");
        assert_eq!(info.assets[0].name, "llama-b10642-bin-win-cuda-12.4-x64.zip");
        assert!(info.assets[0].matches_host);
        assert!(info.cuda_matched);
        let cpu_asset = info.assets.iter().find(|a| a.name.contains("cpu")).expect("应有 CPU 包");
        assert!(!cpu_asset.matches_host);
    }
}
