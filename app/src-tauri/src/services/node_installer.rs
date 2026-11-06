//! 托管 Node.js 运行时安装服务（无限画布的 Node 依赖）。
//!
//! 职责：从 nodejs.org 官方 dist 下载 win-x64 便携 zip，用官方 SHASUMS256.txt
//! 校验后解压到 `runtimes/node-v<版本>-win-x64/`，并解析可用运行时
//! （系统 Node 优先，托管便携版兜底）。
//!
//! 安全边界：所有子进程均为参数列表调用（不走 shell、无字符串拼接命令），
//! 程序路径要么是字面量 `"node"`，要么是 `runtimes/` 自管目录下解析出的
//! node.exe，不接受任何外部输入构造可执行路径。
//!
//! 历史：本模块原为 dsh（DeepSeek Harness）服务的安装器，dsh 接入已于
//! 2026-11-06 移除；Node 托管能力保留给画布复用。

#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::io::Read;
use std::path::{Path, PathBuf};

// 参数列表式子进程封装（std::process::Command 的本文件内别名）。
use std::process::Command as SpawnProcess;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::services::auto_updater;

/// Node.js 运行时来源：系统 Node / 托管便携版 / 未找到。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum NodeSource {
    /// 系统 PATH 中的 Node，版本满足 `^22.19 || >=24`。
    System,
    /// 应用托管的便携版（runtimes/node-v*-win-x64）。
    Managed,
    /// 未找到可用 Node。
    None,
}

/// Node.js 运行时状态。
#[derive(Debug, Clone, Serialize)]
pub struct NodeInfo {
    pub source: NodeSource,
    /// 实测版本号（如 "22.23.2"），未找到时为 None。
    pub version: Option<String>,
    /// 实际使用的 node.exe 路径。
    pub path: Option<String>,
}

// ---------------------------------------------------------------------------
// 目录布局（均在 %APPDATA%\AgentLLM 下）
// ---------------------------------------------------------------------------

/// 应用数据根目录（%APPDATA%\AgentLLM）。
fn app_root() -> PathBuf {
    crate::commands::config::get_app_data_root()
}

/// 托管 Node 便携版根目录：runtimes/。
pub fn runtimes_dir() -> PathBuf {
    app_root().join("runtimes")
}

/// 指定版本的托管 Node 目录：runtimes/node-v<版本>-win-x64/。
pub fn managed_node_dir(version: &str) -> PathBuf {
    runtimes_dir().join(format!("node-v{}-win-x64", version))
}

// ---------------------------------------------------------------------------
// 版本解析与检测
// ---------------------------------------------------------------------------

/// 解析 `vMAJOR.MINOR.PATCH` / `MAJOR.MINOR.PATCH` 中的 (major, minor)。
fn parse_node_version(version: &str) -> Option<(u32, u32)> {
    let rest = version.trim().strip_prefix('v').unwrap_or(version.trim());
    let mut parts = rest.split('.');
    let major: u32 = parts.next()?.parse().ok()?;
    let minor: u32 = parts.next()?.parse().ok()?;
    Some((major, minor))
}

/// Node 版本合规线：`^22.19 || >=24`。
fn node_version_compliant(version: &str) -> bool {
    match parse_node_version(version) {
        Some((22, minor)) => minor >= 19,
        Some((major, _)) => major >= 24,
        None => false,
    }
}

/// 隐藏控制台窗口地构造子进程（程序为 PATH 中的固定名称 "node"）。
fn quiet_node_command() -> SpawnProcess {
    let mut command = SpawnProcess::new("node");
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    command
}

/// 隐藏控制台窗口地构造子进程（程序为应用自管目录解析出的 node.exe）。
fn quiet_command(program: &Path) -> SpawnProcess {
    let mut command = SpawnProcess::new(program.as_os_str());
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    command
}

/// 用指定 node.exe 实测版本号（`node --version`，如 "v22.23.2"）。
fn probe_node_version(node_exe: &Path) -> Option<String> {
    let output = quiet_command(node_exe).arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if parse_node_version(&text).is_some() {
        Some(text.trim_start_matches('v').to_string())
    } else {
        None
    }
}

/// 检测系统 PATH 中的 Node（node --version），版本合规才返回。
fn detect_system_node() -> NodeInfo {
    let output = match quiet_node_command().arg("--version").output() {
        Ok(output) if output.status.success() => output,
        _ => return NodeInfo { source: NodeSource::None, version: None, path: None },
    };
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !node_version_compliant(&version) {
        return NodeInfo { source: NodeSource::None, version: None, path: None };
    }
    let path = quiet_node_command()
        .arg("-p")
        .arg("process.execPath")
        .output()
        .ok()
        .map(|out| {
            String::from_utf8_lossy(&out.stdout)
                .trim()
                .trim_matches('"')
                .to_string()
        });
    NodeInfo {
        source: NodeSource::System,
        version: Some(version.trim_start_matches('v').to_string()),
        path,
    }
}

/// 扫描 runtimes/ 下已解压的托管 Node，取合规版本中最高的一份。
fn detect_managed_node() -> NodeInfo {
    let none = NodeInfo { source: NodeSource::None, version: None, path: None };
    let Ok(entries) = std::fs::read_dir(runtimes_dir()) else {
        return none;
    };
    let mut best: Option<(u32, u32, PathBuf, String)> = None;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(version) = name
            .strip_prefix("node-v")
            .and_then(|rest| rest.strip_suffix("-win-x64"))
        else {
            continue;
        };
        let exe = entry.path().join("node.exe");
        if !exe.exists() {
            continue;
        }
        let Some((major, minor)) = parse_node_version(version) else {
            continue;
        };
        if !node_version_compliant(version) {
            continue;
        }
        if best.as_ref().map(|(bm, bn, _, _)| (major, minor) > (*bm, *bn)).unwrap_or(true) {
            best = Some((major, minor, exe, version.to_string()));
        }
    }
    match best {
        Some((_, _, exe, version)) => NodeInfo {
            source: NodeSource::Managed,
            version: Some(version),
            path: Some(exe.to_string_lossy().to_string()),
        },
        None => none,
    }
}

/// 解析可用的 Node 运行时：系统 Node 优先，托管便携版兜底。
pub fn resolve_node() -> NodeInfo {
    let system = detect_system_node();
    if system.source == NodeSource::System {
        return system;
    }
    detect_managed_node()
}

// ---------------------------------------------------------------------------
// HTTP 下载（Node 便携 zip + SHASUMS256 校验）
// ---------------------------------------------------------------------------

fn build_download_client(proxy_url: Option<&str>) -> Result<reqwest::blocking::Client, String> {
    let mut builder = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .connect_timeout(std::time::Duration::from_secs(30));
    if let Some(proxy) = auto_updater::build_proxy(proxy_url)? {
        builder = builder.proxy(proxy);
    }
    builder.build().map_err(|e| format!("无法创建下载客户端：{}", e))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

const NODE_DIST_BASE: &str = "https://nodejs.org/dist";

/// 下载 Node 便携版 zip 并做官方 SHASUMS256 校验，返回字节。
fn download_node_zip(
    client: &reqwest::blocking::Client,
    version: &str,
    on_progress: &dyn Fn(String),
) -> Result<Vec<u8>, String> {
    let asset = format!("node-v{}-win-x64.zip", version);
    let base = format!("{}/v{}", NODE_DIST_BASE, version);

    on_progress("正在获取官方 SHASUMS256 校验和...".to_string());
    let sums_url = format!("{}/SHASUMS256.txt", base);
    let sums = client
        .get(&sums_url)
        .send()
        .and_then(|resp| resp.error_for_status())
        .and_then(|resp| resp.text())
        .map_err(|e| format!("无法下载官方校验和文件（{}）：{}", sums_url, e))?;
    let expected = sums
        .lines()
        .find_map(|line| {
            let mut parts = line.trim().split_whitespace();
            let hash = parts.next()?;
            let name = parts.next()?;
            name.trim_start_matches('*')
                .eq_ignore_ascii_case(&asset)
                .then(|| hash.to_string())
        })
        .ok_or_else(|| format!("官方校验和文件中未找到 {} 的条目。", asset))?;

    let url = format!("{}/{}", base, asset);
    on_progress(format!("开始下载 Node.js 便携版（{}）...", asset));
    let mut response = client
        .get(&url)
        .send()
        .and_then(|resp| resp.error_for_status())
        .map_err(|e| format!("无法下载 Node.js 便携版（{}）：{}", url, e))?;

    let total = response.content_length();
    let mut bytes: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    let mut last_percent = 0u64;
    loop {
        let read = response.read(&mut chunk).map_err(|e| format!("下载中断：{}", e))?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..read]);
        if let Some(total) = total {
            if total > 0 {
                let percent = (bytes.len() as u64) * 100 / total as u64;
                if percent >= last_percent + 5 || percent == 100 {
                    last_percent = percent;
                    on_progress(format!(
                        "正在下载 Node.js 便携版：{:.1} / {:.1} MB（{}%）",
                        bytes.len() as f64 / 1024.0 / 1024.0,
                        total as f64 / 1024.0 / 1024.0,
                        percent
                    ));
                }
            }
        }
    }

    let actual = sha256_hex(&bytes);
    if !actual.eq_ignore_ascii_case(&expected) {
        return Err(format!(
            "Node.js 便携版校验失败：官方 SHA256 为 {}，实际下载为 {}。已中止安装。",
            expected, actual
        ));
    }
    on_progress("下载完成，官方 SHA256 校验通过。".to_string());
    Ok(bytes)
}

/// 解压 Node 便携 zip 到 runtimes/（zip 内自带顶层目录 node-vX-win-x64/）。
fn extract_node_zip(bytes: &[u8], version: &str) -> Result<PathBuf, String> {
    let target_root = runtimes_dir();
    std::fs::create_dir_all(&target_root).map_err(|e| format!("无法创建运行时目录：{}", e))?;
    let expect_prefix = format!("node-v{}-win-x64/", version);
    let target_dir = managed_node_dir(version);

    let reader = std::io::Cursor::new(bytes);
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|e| format!("无法读取 Node 压缩包：{}", e))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("压缩包读取失败（第 {} 项）：{}", index, e))?;
        let Some(rel_path) = entry.enclosed_name().map(|path| path.to_path_buf()) else {
            continue; // 跳过非法路径项，防 zip-slip
        };
        let rel = match rel_path.to_string_lossy().strip_prefix(&expect_prefix) {
            Some(rest) => rest.to_string(),
            None => continue,
        };
        let out_path = target_dir.join(&rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path)
                .map_err(|e| format!("无法创建目录 {}：{}", out_path.display(), e))?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("无法创建目录 {}：{}", parent.display(), e))?;
            }
            let mut out_file = std::fs::File::create(&out_path)
                .map_err(|e| format!("无法写入文件 {}：{}", out_path.display(), e))?;
            std::io::copy(&mut entry, &mut out_file)
                .map_err(|e| format!("解压文件 {} 失败：{}", out_path.display(), e))?;
        }
    }
    Ok(target_dir)
}

/// 托管安装 Node.js 便携版（幂等：已装同版本且可用则直接跳过）。
/// 返回实际就绪的版本号。
pub fn install_node_portable(
    version: &str,
    proxy_url: Option<&str>,
    on_progress: &dyn Fn(String),
) -> Result<String, String> {
    let node_exe = managed_node_dir(version).join("node.exe");
    if node_exe.exists() {
        if let Some(probed) = probe_node_version(&node_exe) {
            on_progress(format!("托管 Node.js v{} 已就绪，跳过下载。", probed));
            return Ok(probed);
        }
        on_progress("检测到损坏的托管 Node 目录，将重新安装...".to_string());
        let _ = std::fs::remove_dir_all(managed_node_dir(version));
    }

    let client = build_download_client(proxy_url)?;
    let bytes = download_node_zip(&client, version, on_progress)?;

    on_progress("正在解压 Node.js 便携版...".to_string());
    extract_node_zip(&bytes, version)?;

    let probed = probe_node_version(&node_exe)
        .ok_or_else(|| "解压完成但 node.exe 无法运行，可能被杀毒软件拦截。".to_string())?;
    on_progress(format!("托管 Node.js v{} 安装完成。", probed));
    Ok(probed)
}
