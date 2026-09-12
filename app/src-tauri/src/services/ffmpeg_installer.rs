//! ffmpeg / ffprobe 安装器（视频与部分音频格式的可选运行时）。
//!
//! 下载源固定为 **BtbN/FFmpeg-Builds** 的 GitHub `latest` release（静态 win64 构建），
//! 取出其中的 `ffmpeg.exe` 与 `ffprobe.exe` 安装到应用 `resources/` 目录 —— 该目录正是
//! `process_manager` 的媒体运行时搜索路径之一，安装后向量服务与对话服务都能直接找到。
//!
//! 与内核更新同一套安全口径：
//! - 下载地址必须落在 GitHub 官方域名（`ensure_release_url_allowed`）；
//! - 必须从 GitHub API 拿到官方 SHA256（asset `digest`）并逐一比对，校验不通过绝不落盘；
//! - 解压走带 Zip Slip 防护的 `expand_zip`；
//! - 安装前实际执行 `ffmpeg -version` / `ffprobe -version` 做功能性验证。
//!
//! 取消沿用内核更新同一个全局标志（`auto_updater::request_cancel`），
//! 同一时刻只会有一个安装任务在跑。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use crate::services::auto_updater;

/// BtbN/FFmpeg-Builds 的固定 `latest` release。
const RELEASE_REPO: &str = "BtbN/FFmpeg-Builds";
const RELEASE_TAG: &str = "latest";
/// 静态（非 shared）win64 GPL 包：内含单文件 ffmpeg.exe / ffprobe.exe，无额外 DLL 依赖。
/// 注意 `...-win64-gpl-shared.zip` 以 `-shared.zip` 结尾，不会被这个后缀命中。
const ASSET_SUFFIX: &str = "win64-gpl.zip";

/// 目标可执行文件名（与 `process_manager::media_binary_file_name` 保持一致）。
fn media_exe_name(stem: &str) -> String {
    if cfg!(windows) {
        format!("{}.exe", stem)
    } else {
        stem.to_string()
    }
}

/// 读取 BtbN release 的 JSON（未认证 GitHub API，带重试）。
fn fetch_release_json(proxy_url: Option<&str>) -> Result<serde_json::Value, String> {
    let client = auto_updater::build_client(proxy_url, 60, 30)?;
    let url = format!(
        "https://api.github.com/repos/{}/releases/tags/{}",
        RELEASE_REPO, RELEASE_TAG
    );
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
            Err(error) => {
                last_error = error.to_string();
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
                last_error = format!("读取响应失败: {}", error);
                continue;
            }
        };
        match serde_json::from_slice(&body) {
            Ok(json) => return Ok(json),
            Err(error) => {
                last_error = format!("响应解析失败: {}", error);
                continue;
            }
        }
    }
    Err(format!("读取 ffmpeg 发布信息失败：{}", last_error))
}

/// 从 release JSON 中挑出目标 zip 资产。
///
/// 返回 `(文件名, 网页下载地址, API 资产地址, 官方 sha256)`。
///
/// 之所以同时给出 API 资产地址：部分地区 `github.com` 被墙，但 `api.github.com`
/// 可达（实测该路径能正常下载），因此下载时优先走 API 资产端点，
/// 失败再回退网页下载地址。
fn pick_asset(json: &serde_json::Value) -> Result<(String, String, String, String), String> {
    let assets = json["assets"]
        .as_array()
        .ok_or_else(|| "发布信息里没有 assets 列表，无法下载。".to_string())?;
    for item in assets {
        let Some(name) = item["name"].as_str() else {
            continue;
        };
        if !name.ends_with(ASSET_SUFFIX) {
            continue;
        }
        let url = item["browser_download_url"]
            .as_str()
            .ok_or_else(|| format!("{} 缺少下载地址。", name))?
            .to_string();
        // API 资产端点需要资产 id；缺 id 时只保留网页地址。
        let api_url = item["id"]
            .as_u64()
            .map(|id| format!("https://api.github.com/repos/{}/releases/assets/{}", RELEASE_REPO, id));
        let digest = item["digest"]
            .as_str()
            .ok_or_else(|| format!("发布源未提供 {} 的校验和，已中止安装。", name))?;
        let hex = digest
            .strip_prefix("sha256:")
            .ok_or_else(|| format!("不支持的校验和格式：{}", digest))?
            .trim()
            .to_ascii_lowercase();
        if hex.len() != 64 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(format!("校验和格式非法：{}", digest));
        }
        return Ok((name.to_string(), url, api_url.unwrap_or_default(), hex));
    }
    Err(format!(
        "未在 {} release 中找到 {} 资产。",
        RELEASE_TAG, ASSET_SUFFIX
    ))
}

/// 在解压目录里递归查找指定名称的可执行文件。
fn find_binary(root: &Path, file_name: &str) -> Option<PathBuf> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = fs::read_dir(&dir).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case(file_name))
            {
                return Some(path);
            }
        }
    }
    None
}

/// 功能性验证：实际执行 `-version`，确认能跑且身份正确。
/// 这比只看文件大小更可靠——一个损坏或被替换的二进制无法通过。
fn validate_media_binary(exe: &Path, stem: &str) -> Result<String, String> {
    let mut command = Command::new(exe);
    command.arg("-version");
    if let Some(parent) = exe.parent() {
        command.current_dir(parent);
    }
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000);
    }

    let output = command
        .output()
        .map_err(|error| format!("无法运行 {}: {}", stem, error))?;
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let preview = combined.trim();
    if preview.is_empty() {
        return Err(format!("{} -version 没有输出，已取消安装。", stem));
    }
    let lower = preview.to_ascii_lowercase();
    if !lower.contains(stem) {
        return Err(format!(
            "{} 输出异常（未包含 \"{}\"），已取消安装。",
            stem, stem
        ));
    }
    Ok(preview
        .lines()
        .next()
        .unwrap_or(stem)
        .trim()
        .to_string())
}

/// 从 BtbN/FFmpeg-Builds 下载并安装 ffmpeg / ffprobe 到 resources 目录。
///
/// 返回安装结果的说明文字（含版本），失败返回中文错误。
pub fn install(
    proxy_url: Option<&str>,
    use_mirror: bool,
    on_progress: impl Fn(String),
) -> Result<String, String> {
    auto_updater::reset_cancel();
    on_progress("正在获取 ffmpeg 发布信息...".to_string());

    let json = fetch_release_json(proxy_url)?;
    let (asset_name, url, api_url, expected_sha256) = pick_asset(&json)?;
    // 两个下载地址都来自 API 响应，同样必须限定在 GitHub 官方域名。
    auto_updater::ensure_release_url_allowed(&url)?;
    if !api_url.is_empty() {
        auto_updater::ensure_release_url_allowed(&api_url)?;
    }
    auto_updater::ensure_not_cancelled()?;

    let client = auto_updater::build_client(proxy_url, 600, 30)?;
    let bytes = download_verified(
        &client,
        &asset_name,
        &url,
        &api_url,
        use_mirror,
        &expected_sha256,
        proxy_url,
        &on_progress,
    )?;
    eprintln!("[ffmpeg] download complete, {} bytes", bytes.len());

    let temp_root = std::env::temp_dir().join(format!(
        "agent-llm-ffmpeg-{}",
        chrono::Local::now().format("%Y%m%d_%H%M%S")
    ));
    struct TempGuard(PathBuf);
    impl Drop for TempGuard {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let _guard = TempGuard(temp_root.clone());
    fs::create_dir_all(&temp_root).map_err(|error| error.to_string())?;
    let zip_path = temp_root.join("ffmpeg.zip");
    let extract_dir = temp_root.join("extract");
    fs::write(&zip_path, &bytes).map_err(|error| error.to_string())?;

    on_progress("正在解压...".to_string());
    auto_updater::ensure_not_cancelled()?;
    auto_updater::expand_zip(&zip_path, &extract_dir)?;

    on_progress("正在验证 ffmpeg 与 ffprobe...".to_string());
    auto_updater::ensure_not_cancelled()?;
    let ffmpeg_name = media_exe_name("ffmpeg");
    let ffprobe_name = media_exe_name("ffprobe");
    let ffmpeg_src = find_binary(&extract_dir, &ffmpeg_name)
        .ok_or_else(|| format!("压缩包内未找到 {}，已取消安装。", ffmpeg_name))?;
    let ffprobe_src = find_binary(&extract_dir, &ffprobe_name)
        .ok_or_else(|| format!("压缩包内未找到 {}，已取消安装。", ffprobe_name))?;
    let ffmpeg_version = validate_media_binary(&ffmpeg_src, "ffmpeg")?;
    let ffprobe_version = validate_media_binary(&ffprobe_src, "ffprobe")?;
    eprintln!("[ffmpeg] validated: {} | {}", ffmpeg_version, ffprobe_version);

    // 安装到应用 resources 目录：process_manager 的媒体搜索路径之一。
    let target_dir = auto_updater::resource_dir();
    fs::create_dir_all(&target_dir).map_err(|error| error.to_string())?;
    auto_updater::ensure_not_cancelled()?;
    let ffmpeg_dest = target_dir.join(&ffmpeg_name);
    let ffprobe_dest = target_dir.join(&ffprobe_name);
    fs::copy(&ffmpeg_src, &ffmpeg_dest)
        .map_err(|error| format!("复制 {} 失败：{}", ffmpeg_name, error))?;
    fs::copy(&ffprobe_src, &ffprobe_dest)
        .map_err(|error| format!("复制 {} 失败：{}", ffprobe_name, error))?;

    // 安装后再验证一次落盘结果，避免复制过程出错却报成功。
    validate_media_binary(&ffmpeg_dest, "ffmpeg")?;
    validate_media_binary(&ffprobe_dest, "ffprobe")?;

    Ok(format!(
        "ffmpeg 与 ffprobe 已安装到 {}（{}）。",
        target_dir.display(),
        ffmpeg_version
    ))
}

/// 下载并强制校验 sha256。
///
/// 尝试顺序（每一路都必须通过官方校验和才采用）：
/// 1. `api.github.com` 资产端点 —— 部分地区 `github.com` 不可达但此端点可用，故优先；
/// 2. 网页下载地址（镜像加速优先，失败回退直连）。
fn download_verified(
    _client: &reqwest::blocking::Client,
    label: &str,
    url: &str,
    api_url: &str,
    use_mirror: bool,
    expected_sha256: &str,
    proxy_url: Option<&str>,
    on_progress: &dyn Fn(String),
) -> Result<Vec<u8>, String> {
    // 1) API 资产端点优先（GitHub API 走 Accept: application/octet-stream 返回资产内容）。
    if !api_url.is_empty() {
        on_progress("正在通过 GitHub API 下载...".to_string());
        let client = auto_updater::build_client(proxy_url, 600, 30)?;
        if let Ok(resp) = client
            .get(api_url)
            .header("Accept", "application/octet-stream")
            .header("User-Agent", "AgentLLM/0.2.0")
            .send()
        {
            if resp.status().is_success() {
                if let Ok(bytes) = auto_updater::download_with_progress(resp, on_progress) {
                    if auto_updater::validate_downloaded_zip(&bytes).is_ok()
                        && auto_updater::sha256_hex(&bytes) == expected_sha256
                    {
                        return Ok(bytes);
                    }
                    on_progress("API 下载内容校验未通过，改用网页地址。".to_string());
                }
            } else {
                on_progress(format!("API 端点返回 HTTP {}，改用网页地址。", resp.status()));
            }
        } else {
            on_progress("API 端点不可用，改用网页地址。".to_string());
        }
        auto_updater::ensure_not_cancelled()?;
    }

    // 2) 网页下载地址：镜像加速优先（内容不可信，必须比对），失败回退直连。
    if use_mirror {
        for mirror in auto_updater::GITHUB_MIRRORS {
            on_progress(format!("尝试加速源: {}", mirror));
            let mirrored = auto_updater::mirror_download_url(mirror, url);
            let client = auto_updater::build_client(proxy_url, 600, 30)?;
            match client.get(&mirrored).send() {
                Ok(resp) if resp.status().is_success() => {
                    match auto_updater::download_with_progress(resp, on_progress) {
                        Ok(bytes) => {
                            if auto_updater::validate_downloaded_zip(&bytes).is_err() {
                                on_progress("加速源返回内容无效，跳过".to_string());
                                continue;
                            }
                            let actual = auto_updater::sha256_hex(&bytes);
                            if actual == expected_sha256 {
                                return Ok(bytes);
                            }
                            on_progress("加速源内容校验和不匹配，跳过".to_string());
                        }
                        Err(error) => on_progress(format!("加速源下载失败: {}", error)),
                    }
                }
                Ok(resp) => on_progress(format!("加速源返回 HTTP {}，跳过", resp.status())),
                Err(error) => on_progress(format!("加速源失败: {}", error)),
            }
        }
        on_progress("所有加速源失败，尝试直连...".to_string());
    }

    on_progress(format!("直连下载 {}...", label));
    let client = auto_updater::build_client(proxy_url, 600, 30)?;
    let resp = client
        .get(url)
        .send()
        .map_err(|error| format!("连接失败: {}", error))?;
    if !resp.status().is_success() {
        return Err(format!("下载失败: HTTP {}", resp.status()));
    }
    let bytes = auto_updater::download_with_progress(resp, on_progress)?;
    auto_updater::validate_downloaded_zip(&bytes)?;
    let actual = auto_updater::sha256_hex(&bytes);
    if actual != expected_sha256 {
        return Err(format!(
            "发布包校验和不匹配，已中止安装（期望 {}...，实际 {}...）。",
            &expected_sha256[..12],
            &actual[..12]
        ));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_suffix_excludes_shared_build() {
        // 静态包选中，shared 包必须排除。
        assert!("ffmpeg-master-latest-win64-gpl.zip".ends_with(ASSET_SUFFIX));
        assert!(!"ffmpeg-master-latest-win64-gpl-shared.zip".ends_with(ASSET_SUFFIX));
    }

    #[test]
    fn pick_asset_reads_url_and_digest() {
        let json = serde_json::json!({
            "assets": [
                { "id": 1, "name": "ffmpeg-master-latest-win64-gpl-shared.zip",
                  "browser_download_url": "https://github.com/x/shared.zip",
                  "digest": "sha256:aa" },
                { "id": 2, "name": "checksums.sha256",
                  "browser_download_url": "https://github.com/x/checksums.sha256" },
                { "id": 555315199, "name": "ffmpeg-master-latest-win64-gpl.zip",
                  "browser_download_url": "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
                  "digest": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" }
            ]
        });
        let (name, url, api_url, sha) = pick_asset(&json).expect("pick static asset");
        assert_eq!(name, "ffmpeg-master-latest-win64-gpl.zip");
        assert!(url.ends_with("ffmpeg-master-latest-win64-gpl.zip"));
        // API 资产端点用 id 拼出，供 github.com 不可达时下载。
        assert_eq!(
            api_url,
            "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/assets/555315199"
        );
        assert_eq!(sha.len(), 64);
    }

    #[test]
    fn pick_asset_fails_without_digest() {
        // 缺少官方校验和时必须失败关闭，绝不落盘未校验的包。
        let json = serde_json::json!({
            "assets": [
                { "name": "ffmpeg-master-latest-win64-gpl.zip",
                  "browser_download_url": "https://github.com/x/y.zip" }
            ]
        });
        assert!(pick_asset(&json).is_err());
    }

    #[test]
    fn pick_asset_fails_when_asset_missing() {
        let json = serde_json::json!({ "assets": [] });
        assert!(pick_asset(&json).is_err());
    }

    #[test]
    fn media_exe_name_matches_platform() {
        let name = media_exe_name("ffmpeg");
        if cfg!(windows) {
            assert_eq!(name, "ffmpeg.exe");
        } else {
            assert_eq!(name, "ffmpeg");
        }
    }

    /// 真实网络端到端验证（默认忽略，需显式 `--ignored` 运行）：
    /// 走官方 API 取校验和 → 下载 194MB 静态包 → 校验 SHA256 → 解压验证。
    /// 不在常规测试里跑，避免每次 CI 都拉近 200MB。
    #[test]
    #[ignore]
    fn live_download_and_validate() {
        use std::sync::Mutex;
        let last = Mutex::new(String::new());
        let result = install(None, false, |msg| {
            eprintln!("[live] {}", msg);
            if let Ok(mut guard) = last.lock() {
                *guard = msg;
            }
        });
        match result {
            Ok(summary) => eprintln!("[live] OK: {}", summary),
            Err(error) => panic!("真实下载安装失败: {}", error),
        }
    }
}
