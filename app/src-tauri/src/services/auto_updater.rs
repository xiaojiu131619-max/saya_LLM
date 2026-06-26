use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

static UPDATE_LOG: Lazy<PathBuf> = Lazy::new(|| resource_dir().join("update.log"));

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

fn versions_dir() -> PathBuf {
    let v = resource_dir().join("versions");
    fs::create_dir_all(&v).ok();
    v
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

fn detect_nvidia_gpu_names() -> Vec<String> {
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

fn detect_video_controller_names() -> Vec<String> {
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

fn is_real_display_adapter(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    !lower.is_empty()
        && !lower.contains("microsoft basic")
        && !lower.contains("remote")
        && !lower.contains("virtual")
        && !lower.contains("parsec")
}

fn detect_host_gpu_backend() -> (String, Option<String>) {
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

    if let Some(name) = controllers
        .iter()
        .find(|name| is_real_display_adapter(name) && !name.to_ascii_lowercase().contains("nvidia"))
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

fn cuda_asset_score(name: &str, cuda_version: Option<&str>) -> (u8, u32, u32) {
    let Some((asset_major, asset_minor)) = cuda_asset_version(name) else {
        return (3, 0, 0);
    };
    let Some((cuda_major, cuda_minor)) = cuda_version.and_then(parse_cuda_version) else {
        return (1, u32::MAX - asset_major, u32::MAX - asset_minor);
    };

    if asset_major == cuda_major {
        let distance = asset_minor.abs_diff(cuda_minor);
        (0, distance, u32::MAX - asset_minor)
    } else if asset_major > cuda_major {
        (1, asset_major - cuda_major, u32::MAX - asset_minor)
    } else {
        (2, cuda_major - asset_major, u32::MAX - asset_minor)
    }
}

fn cuda_asset_matches(name: &str, cuda_version: Option<&str>) -> bool {
    let Some((asset_major, _)) = cuda_asset_version(name) else {
        return false;
    };
    let Some((cuda_major, _)) = cuda_version.and_then(parse_cuda_version) else {
        return false;
    };
    asset_major == cuda_major
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

fn host_matched_asset(name: &str, cuda_version: Option<&str>, host_backend: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    match host_backend {
        "CUDA" => {
            lower.contains("cuda")
                && cuda_version
                    .map(|version| cuda_asset_matches(name, Some(version)))
                    .unwrap_or(true)
        }
        "Vulkan" => lower.contains("vulkan") || lower.contains("kompute"),
        "CPU" => lower.contains("cpu") || lower.contains("avx") || lower.contains("noavx"),
        _ => false,
    }
}

fn package_asset_score(name: &str, cuda_version: Option<&str>, host_backend: &str) -> (u8, u32, u32, String) {
    let lower = name.to_ascii_lowercase();
    match host_backend {
        "CUDA" => {
            if lower.contains("cuda") {
                if cuda_version.is_none() {
                    return (0, 0, 0, lower);
                }
                let (tier, distance, minor_score) = cuda_asset_score(name, cuda_version);
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

fn github_api_json(path: &str) -> Result<serde_json::Value, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let urls = [format!(
        "https://api.github.com/repos/ggml-org/llama.cpp/{}",
        path
    )];
    let mut last_error = String::new();
    for url in urls {
        let resp = match client
            .get(&url)
            .header("User-Agent", "AgentLLM/0.1.0")
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
        match resp.json() {
            Ok(json) => return Ok(json),
            Err(error) => {
                last_error = format!("更新源响应解析失败: {}", error);
                continue;
            }
        }
    }
    Err(last_error)
}

pub fn check_latest_release() -> Result<ReleaseInfo, String> {
    let json = github_api_json("releases/latest")?;

    let tag_name = json["tag_name"].as_str().unwrap_or("").to_string();
    let body = json["body"].as_str().unwrap_or("").to_string();
    let published_at = json["published_at"].as_str().unwrap_or("").to_string();

    let (host_backend, gpu_name) = detect_host_gpu_backend();
    let cuda_version = detect_cuda_version();
    let mut assets = Vec::new();
    let mut cuda_matched = false;
    if let Some(arr) = json["assets"].as_array() {
        for item in arr {
            let name = item["name"].as_str().unwrap_or("");
            if is_windows_x64_package(name) {
                let matches_cuda = name.to_ascii_lowercase().contains("cuda")
                    && cuda_asset_matches(name, cuda_version.as_deref());
                if matches_cuda {
                    cuda_matched = true;
                }
                let matches_host = host_matched_asset(name, cuda_version.as_deref(), &host_backend);
                assets.push(AssetInfo {
                    name: name.to_string(),
                    browser_download_url: item["browser_download_url"]
                        .as_str()
                        .unwrap_or("")
                        .to_string(),
                    size: item["size"].as_u64().unwrap_or(0),
                    backend: asset_backend(name).to_string(),
                    matches_host,
                });
            }
        }
    }

    assets.sort_by_key(|asset| package_asset_score(&asset.name, cuda_version.as_deref(), &host_backend));

    let version = tag_name.trim_start_matches('v').to_string();

    Ok(ReleaseInfo {
        tag_name,
        version,
        assets,
        body,
        published_at,
        cuda_version,
        cuda_matched,
        host_backend,
        gpu_name,
    })
}

pub fn list_recent_releases(count: usize) -> Result<Vec<ReleaseInfo>, String> {
    let json = github_api_json("releases")?;
    let (host_backend, gpu_name) = detect_host_gpu_backend();
    let cuda_version = detect_cuda_version();

    let mut releases = Vec::new();
    if let Some(arr) = json.as_array() {
        for item in arr.iter().take(count) {
            let tag_name = item["tag_name"].as_str().unwrap_or("").to_string();
            let body = item["body"].as_str().unwrap_or("").to_string();
            let published_at = item["published_at"].as_str().unwrap_or("").to_string();

            let mut assets = Vec::new();
            let mut cuda_matched = false;
            if let Some(assets_arr) = item["assets"].as_array() {
                for a in assets_arr {
                    let name = a["name"].as_str().unwrap_or("");
                    if is_windows_x64_package(name) {
                        let matches_cuda = name.to_ascii_lowercase().contains("cuda")
                            && cuda_asset_matches(name, cuda_version.as_deref());
                        if matches_cuda {
                            cuda_matched = true;
                        }
                        let matches_host =
                            host_matched_asset(name, cuda_version.as_deref(), &host_backend);
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
            assets.sort_by_key(|asset| package_asset_score(&asset.name, cuda_version.as_deref(), &host_backend));

            let version = tag_name.trim_start_matches('v').to_string();
            releases.push(ReleaseInfo {
                tag_name,
                version,
                assets,
                body,
                published_at,
                cuda_version: cuda_version.clone(),
                cuda_matched,
                host_backend: host_backend.clone(),
                gpu_name: gpu_name.clone(),
            });
        }
    }

    Ok(releases)
}

const GITHUB_MIRRORS: &[&str] = &[
    "https://ghfast.top/",
];

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
                            Ok(()) => return Ok(bytes),
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

    // Try direct connection with longer timeout
    on_progress("直连下载中...".to_string());
    let direct_client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .connect_timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    match direct_client.get(url).send() {
        Ok(resp) => {
            if resp.status().is_success() {
                return download_with_progress(resp, on_progress);
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

fn download_zip_bytes(
    client: &reqwest::blocking::Client,
    label: &str,
    url: &str,
    use_mirror: bool,
    mirror_url: Option<&str>,
    on_progress: &dyn Fn(String),
) -> Result<(Vec<u8>, String), String> {
    on_progress(format!("正在下载 {}...", label));
    let bytes = try_download_stream(client, url, use_mirror, mirror_url, &|msg| {
        eprintln!("[updater] {}", msg);
        on_progress(msg);
    })?;

    validate_downloaded_zip(&bytes)?;
    let sha256 = sha256_hex(&bytes);
    on_progress(format!("{} 下载完成，SHA256：{}...", label, &sha256[..12]));
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

    for entry in walkdir::WalkDir::new(root).into_iter().filter_map(|entry| entry.ok()) {
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
    if !output.status.success() && preview.is_empty() {
        return Err("新版 llama-server --version 验证失败。".to_string());
    }
    if !preview.to_ascii_lowercase().contains("version")
        && !preview.to_ascii_lowercase().contains("llama")
    {
        return Err("新版 llama-server 输出异常，已取消安装。".to_string());
    }
    Ok(preview.lines().next().unwrap_or("llama-server 已验证").trim().to_string())
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

fn backup_current_runtime(resources: &Path) -> Result<Option<PathBuf>, String> {
    let current_exe = resources.join(exe_name());
    if !current_exe.exists() {
        return Ok(None);
    }

    let backup_dir = versions_dir();
    let old_version = detect_installed_version(resources).unwrap_or_else(|| "unknown".to_string());
    let now = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
    let backup_path = backup_dir.join(format!("{}_{}", safe_version_name(&old_version), now));
    fs::create_dir_all(&backup_path).map_err(|error| error.to_string())?;
    copy_runtime_files(resources, &backup_path)?;
    cleanup_old_backups(&backup_dir, 2);
    Ok(Some(backup_path))
}

fn restore_backup(backup_path: Option<&Path>, resources: &Path) -> Result<(), String> {
    if let Some(path) = backup_path {
        clear_runtime_files(resources)?;
        copy_runtime_files(path, resources)?;
    }
    Ok(())
}

fn install_from_staging(staging_dir: &Path, resources: &Path) -> Result<(), String> {
    clear_runtime_files(resources)?;
    copy_runtime_files(staging_dir, resources)?;
    validate_llama_server(&resources.join(exe_name()))?;
    Ok(())
}

fn powershell_path(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "''"))
}

fn expand_zip(zip_path: &Path, extract_dir: &Path) -> Result<(), String> {
    let mut command = Command::new("powershell");
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        &format!(
            "Expand-Archive -LiteralPath {} -DestinationPath {} -Force",
            powershell_path(zip_path),
            powershell_path(extract_dir)
        ),
    ]);
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000);
    }

    let output = command.output().map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        Err(format!("解压失败: {}{}", stderr, stdout))
    }
}

pub fn download_and_install(
    url: &str,
    version: &str,
    use_mirror: bool,
    mirror_url: Option<&str>,
    on_progress: impl Fn(String),
) -> Result<String, String> {
    eprintln!(
        "[updater] starting download: url={}, version={}, use_mirror={}",
        url, version, use_mirror
    );

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;

    let (bytes, sha256) = download_zip_bytes(
        &client,
        &format!("llama.cpp {}", version),
        url,
        use_mirror,
        mirror_url,
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
    {
        let mut file = fs::File::create(&zip_path).map_err(|error| error.to_string())?;
        file.write_all(&bytes).map_err(|error| error.to_string())?;
    }

    on_progress("正在解压主程序包...".to_string());
    expand_zip(&zip_path, &extract_dir)?;

    on_progress("正在验证发布包...".to_string());
    let exe_path = find_llama_server(&extract_dir)?;
    let source_dir = exe_path
        .parent()
        .ok_or_else(|| "无法读取 llama-server 所在目录。".to_string())?;
    let server_version = validate_llama_server(&exe_path)?;
    eprintln!("[updater] validated package: {}", server_version);

    fs::create_dir_all(&staging_dir).map_err(|error| error.to_string())?;
    let copied = copy_runtime_files(source_dir, &staging_dir)?;

    let mut runtime_copied = Vec::new();
    if let Some(runtime_url) = companion_cudart_url(url) {
        on_progress("检测到 CUDA 发布包，正在下载配套 CUDA runtime...".to_string());
        let (runtime_bytes, runtime_sha256) = download_zip_bytes(
            &client,
            "CUDA runtime",
            &runtime_url,
            use_mirror,
            mirror_url,
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
    on_progress(format!(
        "发布包已验证，准备安装 {} 个核心文件、{} 个 CUDA runtime 文件。",
        copied.len(),
        runtime_copied.len()
    ));

    let resources = resource_dir();
    let from_version = load_log()
        .current_version
        .or_else(|| detect_installed_version(&resources));
    on_progress("正在备份当前核心...".to_string());
    let backup = backup_current_runtime(&resources)?;

    on_progress("正在安装新核心...".to_string());
    if let Err(error) = install_from_staging(&staging_dir, &resources) {
        eprintln!("[updater] install failed: {}", error);
        on_progress("安装失败，正在恢复旧核心...".to_string());
        if backup.is_none() {
            clear_runtime_files(&resources).ok();
        }
        if let Err(restore_error) = restore_backup(backup.as_deref(), &resources) {
            return Err(format!("安装失败：{}；回滚失败：{}", error, restore_error));
        }
        return Err(format!("安装失败，已恢复旧核心：{}", error));
    }

    let installed_version = validate_llama_server(&resources.join(exe_name()))?;
    eprintln!("[updater] installed version: {}", installed_version);

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

    let _ = fs::remove_dir_all(&temp_root);
    on_progress("安装完成，重启生效".to_string());
    Ok(format!("llama.cpp 内核已更新到 {}", version))
}

fn cleanup_old_backups(dir: &Path, keep: usize) {
    if let Ok(entries) = fs::read_dir(dir) {
        let mut dirs: Vec<_> = entries.flatten().filter(|e| e.path().is_dir()).collect();
        dirs.sort_by_key(|e| std::cmp::Reverse(e.metadata().ok().and_then(|m| m.modified().ok())));
        for entry in dirs.into_iter().skip(keep) {
            fs::remove_dir_all(entry.path()).ok();
        }
    }
}

pub fn list_backups() -> Vec<(String, String)> {
    let dir = versions_dir();
    let mut backups = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                let name = entry.file_name().to_string_lossy().to_string();
                let modified = entry
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .map(|t| {
                        chrono::DateTime::<chrono::Local>::from(t)
                            .format("%Y-%m-%d")
                            .to_string()
                    })
                    .unwrap_or_default();
                backups.push((name, modified));
            }
        }
    }
    backups.sort_by(|a, b| b.0.cmp(&a.0));
    backups
}

pub fn rollback_to(version_dir: &str) -> Result<(), String> {
    let backup_dir = versions_dir().join(version_dir);
    let resources = resource_dir();

    if !backup_dir.exists() {
        return Err("没有找到可回滚的核心备份。".to_string());
    }
    clear_runtime_files(&resources)?;
    copy_runtime_files(&backup_dir, &resources)?;
    validate_llama_server(&resources.join(exe_name()))?;

    // Log rollback
    let mut log = load_log();
    log.entries.push(UpdateLogEntry {
        version: version_dir.to_string(),
        date: chrono::Local::now().format("%Y-%m-%d %H:%M").to_string(),
        action: "rolled_back".to_string(),
        from_version: log.current_version.clone(),
        sha256: None,
    });
    log.current_version = Some(version_dir.to_string());
    save_log(&log);

    Ok(())
}

pub fn get_update_log() -> Vec<UpdateLogEntry> {
    load_log().entries
}
