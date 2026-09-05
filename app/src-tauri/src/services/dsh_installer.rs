//! dsh（DeepSeek Harness）托管安装服务。
//!
//! 职责（对应计划书 F2/F3，Phase 0 结论见 docs/DSH_SPIKE_RECORD.md）：
//! 1. Node.js 便携版托管安装：从 nodejs.org 官方 dist 下载 zip，
//!    SHASUMS256.txt 校验后解压到 `runtimes/node-v<版本>-win-x64/`；
//! 2. `@deepseek-ai/dsh` 包托管安装：用托管 Node 的 npm-cli 安装到
//!    `dsh/packages/`（不污染用户全局 npm），装后 `--version` 验证；
//! 3. 运行状态汇总（dsh_status）与 Agent 页环境检测项。
//!
//! 版本策略：锁定已测版本（Phase 0 定稿），升级由用户显式触发。
//! 安全边界：所有子进程均为参数列表调用（不走 shell、无字符串拼接命令），
//! 程序路径要么是字面量 `"node"`，要么是 `runtimes/` 等应用自管目录下
//! 解析出的 node.exe，不接受任何外部输入构造可执行路径。

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

// 参数列表式子进程封装（std::process::Command 的本文件内别名）。
// 与 process_manager.rs 的做法一致：只 spawn，不经过 shell。
use std::process::Command as SpawnProcess;

use sha2::{Digest, Sha256};

use crate::commands::env_check::EnvCheckItem;
use crate::models::dsh_types::{
    read_versions, write_version, DshInstalledVersion, DshNodeInfo, DshNodeSource,
    DshPackageInfo, DshStatus,
};
use crate::services::auto_updater;
use crate::services::dsh_manager;

/// 用户请求取消当前 dsh 安装任务的全局标志。
static DSH_CANCELLED: AtomicBool = AtomicBool::new(false);

pub fn request_cancel() {
    DSH_CANCELLED.store(true, Ordering::SeqCst);
}

fn ensure_not_cancelled() -> Result<(), String> {
    if DSH_CANCELLED.load(Ordering::SeqCst) {
        return Err("安装已被用户取消。".to_string());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 目录与文件布局（均在 %APPDATA%\AgentLLM 下）
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

/// dsh 包安装根目录：dsh/。
pub fn dsh_root_dir() -> PathBuf {
    app_root().join("dsh")
}

/// dsh npm 包安装目录：dsh/packages/。
pub fn dsh_packages_dir() -> PathBuf {
    dsh_root_dir().join("packages")
}

/// dsh 包入口 bin.js：dsh/packages/node_modules/@deepseek-ai/dsh/lib/bin.js。
pub fn dsh_bin_js() -> PathBuf {
    dsh_packages_dir()
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("lib")
        .join("bin.js")
}

/// dsh 安装记录文件：dsh/versions.json。
fn versions_file() -> PathBuf {
    dsh_root_dir().join("versions.json")
}

/// DSH_HOME 目录（dsh 的会话/设置/凭据都收在这里）：dsh-home/。
pub fn dsh_home_dir() -> PathBuf {
    app_root().join("dsh-home")
}

// ---------------------------------------------------------------------------
// Node.js 版本解析与检测
// ---------------------------------------------------------------------------

/// 解析 `vMAJOR.MINOR.PATCH` / `MAJOR.MINOR.PATCH` 中的 (major, minor)。
fn parse_node_version(version: &str) -> Option<(u32, u32)> {
    let rest = version.trim().strip_prefix('v').unwrap_or(version.trim());
    let mut parts = rest.split('.');
    let major: u32 = parts.next()?.parse().ok()?;
    let minor: u32 = parts.next()?.parse().ok()?;
    Some((major, minor))
}

/// Phase 0 定稿的 Node 版本合规线：`^22.19 || >=24`。
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
fn detect_system_node() -> DshNodeInfo {
    let output = match quiet_node_command().arg("--version").output() {
        Ok(output) if output.status.success() => output,
        _ => return DshNodeInfo { source: DshNodeSource::None, version: None, path: None },
    };
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !node_version_compliant(&version) {
        return DshNodeInfo { source: DshNodeSource::None, version: None, path: None };
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
    DshNodeInfo {
        source: DshNodeSource::System,
        version: Some(version.trim_start_matches('v').to_string()),
        path,
    }
}

/// 扫描 runtimes/ 下已解压的托管 Node，取合规版本中最高的一份。
fn detect_managed_node() -> DshNodeInfo {
    let none = DshNodeInfo { source: DshNodeSource::None, version: None, path: None };
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
        Some((_, _, exe, version)) => DshNodeInfo {
            source: DshNodeSource::Managed,
            version: Some(version),
            path: Some(exe.to_string_lossy().to_string()),
        },
        None => none,
    }
}

/// 解析 dsh 可用的 Node 运行时：系统 Node 优先，托管便携版兜底
/// （计划书 4.2 运行时策略）。
pub fn resolve_node() -> DshNodeInfo {
    let system = detect_system_node();
    if system.source == DshNodeSource::System {
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
    ensure_not_cancelled()?;

    let url = format!("{}/{}", base, asset);
    on_progress(format!("开始下载 Node.js 便携版（{}）...", asset));
    let mut response = client
        .get(&url)
        .send()
        .and_then(|resp| resp.error_for_status())
        .map_err(|e| format!("无法下载 Node.js 便携版（{}）：{}", url, e))?;
    ensure_not_cancelled()?;

    let total = response.content_length();
    let mut bytes: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    let mut last_percent = 0u64;
    loop {
        ensure_not_cancelled()?;
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
        ensure_not_cancelled()?;
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

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// 托管安装 Node.js 便携版（幂等：已装同版本且可用则直接跳过）。
/// 返回实际就绪的版本号。
pub fn install_node_portable(
    version: &str,
    proxy_url: Option<&str>,
    on_progress: &dyn Fn(String),
) -> Result<String, String> {
    ensure_not_cancelled()?;
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
    ensure_not_cancelled()?;

    on_progress("正在解压 Node.js 便携版...".to_string());
    extract_node_zip(&bytes, version)?;
    ensure_not_cancelled()?;

    let probed = probe_node_version(&node_exe)
        .ok_or_else(|| "解压完成但 node.exe 无法运行，可能被杀毒软件拦截。".to_string())?;
    write_version(
        &versions_file(),
        DshInstalledVersion {
            kind: "node".to_string(),
            version: probed.clone(),
            installed_at: unix_now(),
        },
    )?;
    on_progress(format!("托管 Node.js v{} 安装完成。", probed));
    Ok(probed)
}

// ---------------------------------------------------------------------------
// dsh npm 包安装
// ---------------------------------------------------------------------------

/// 托管 Node 的 npm-cli.js 路径（便携 zip 自带完整 npm）。
fn managed_npm_cli(version: &str) -> PathBuf {
    managed_node_dir(version)
        .join("node_modules")
        .join("npm")
        .join("bin")
        .join("npm-cli.js")
}

/// 读取已安装 dsh 包的版本号（解析其 package.json，不启动子进程）。
fn installed_package_version() -> Option<String> {
    let manifest = dsh_packages_dir()
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("package.json");
    let text = std::fs::read_to_string(manifest).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get("version").and_then(|v| v.as_str()).map(str::to_string)
}

/// 单次 npm 安装执行（流式日志 + 双超时保护）。
/// - 60 秒无任何输出：判定 npm 挂死（实测 Node 22 便携版自带 npm 10.9.x 在部分
///   Windows 环境会无输出死循环），杀进程返回带「无响应」字样的错误；
/// - 总时长超过 20 分钟：同样终止并报错。
fn run_npm_install(
    node_exe: &Path,
    npm_cli: &Path,
    packages_dir: &Path,
    package_version: &str,
    proxy_url: Option<&str>,
    on_progress: &dyn Fn(String),
) -> Result<(), String> {
    let mut command = quiet_command(node_exe);
    command
        .arg(npm_cli)
        .arg("install")
        .arg("--prefix")
        .arg(packages_dir)
        // silly 级别让 placeDep 依赖解析阶段也持续输出（http/notice 级别在该阶段
        // 可能静默 10 分钟以上，会被无输出护栏误杀）；本地日志面板，无凭据泄漏面。
        .args(["--no-audit", "--no-fund", "--no-update-notifier", "--loglevel", "silly"])
        .arg(format!("@deepseek-ai/dsh@{}", package_version))
        .env("NO_COLOR", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(proxy) = proxy_url.filter(|url| !url.trim().is_empty()) {
        command
            .env("HTTP_PROXY", proxy)
            .env("HTTPS_PROXY", proxy)
            .env("http_proxy", proxy)
            .env("https_proxy", proxy)
            .env("NO_PROXY", "127.0.0.1,localhost")
            .env("no_proxy", "127.0.0.1,localhost");
    }

    dsh_manager::add_dsh_log(&format!(
        "[npm] {} install --prefix {} @deepseek-ai/dsh@{}",
        npm_cli.display(),
        packages_dir.display(),
        package_version
    ));
    let mut child = command
        .spawn()
        .map_err(|e| format!("无法启动 npm 安装进程：{}", e))?;

    // 流式读取 npm 输出：每一行落 dsh 日志面板，进度条按心跳刷新，
    // 失败时保留末尾若干行用于中文报错。
    let (tx, rx) = channel::<String>();
    if let Some(out) = child.stdout.take() {
        let tx_out = tx.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if tx_out.send(line).is_err() {
                    break;
                }
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
    }

    // placeDep 依赖解析是纯 CPU 计算且可长时间零输出（实测 >60s），静默阈值
    // 必须远大于正常解析间隔；真实挂死由 30 分钟总超时与用户取消兜底。
    const SILENCE_TIMEOUT: Duration = Duration::from_secs(600);
    // dsh 依赖树庞大（400+ 包），placeDep 解析加下载可能耗时 20 分钟以上。
    const OVERALL_TIMEOUT: Duration = Duration::from_secs(30 * 60);
    let started = Instant::now();
    let mut last_output = Instant::now();
    let mut last_heartbeat = 0u64;
    let mut tail: VecDeque<String> = VecDeque::with_capacity(16);
    loop {
        if ensure_not_cancelled().is_err() {
            let _ = child.kill();
            let _ = child.wait();
            dsh_manager::add_dsh_log("[npm] 安装已被用户取消。");
            return Err("安装已被用户取消。".to_string());
        }
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(line) => {
                last_output = Instant::now();
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    dsh_manager::add_dsh_log(&format!("[npm] {}", trimmed));
                    if tail.len() >= 12 {
                        tail.pop_front();
                    }
                    tail.push_back(trimmed.to_string());
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                if child.try_wait().map(|status| status.is_some()).unwrap_or(false) {
                    break;
                }
            }
        }
        let elapsed = started.elapsed();
        if elapsed >= OVERALL_TIMEOUT || last_output.elapsed() >= SILENCE_TIMEOUT {
            let reason = if elapsed >= OVERALL_TIMEOUT {
                format!("npm 安装总时长超过 {} 分钟", OVERALL_TIMEOUT.as_secs() / 60)
            } else {
                format!("npm 超过 {} 秒无任何输出（疑似挂死）", SILENCE_TIMEOUT.as_secs())
            };
            let _ = child.kill();
            let _ = child.wait();
            dsh_manager::add_dsh_log(&format!("[npm] 已终止：{}", reason));
            return Err(format!("npm 无响应：{}", reason));
        }
        let elapsed_secs = elapsed.as_secs();
        if elapsed_secs >= last_heartbeat + 15 {
            last_heartbeat = elapsed_secs;
            on_progress(format!("npm 正在解析并下载依赖（已运行 {} 秒）...", elapsed_secs));
        }
    }
    let status = child.wait().map_err(|e| format!("等待 npm 退出失败：{}", e))?;
    if !status.success() {
        let tail_text: String = tail.into_iter().take(8).collect::<Vec<_>>().join("\n");
        return Err(format!(
            "npm 安装失败（退出码 {:?}）：{}",
            status.code(),
            tail_text
        ));
    }
    Ok(())
}

/// 系统.Node 的 npm-cli.js 路径（系统 Node 安装在同目录自带完整 npm）。
fn system_npm_cli(system_node_path: &str) -> Option<PathBuf> {
    let node_path = Path::new(system_node_path);
    let node_dir = node_path.parent()?;
    let cli = node_dir.join("node_modules").join("npm").join("bin").join("npm-cli.js");
    cli.exists().then_some(cli)
}

/// 托管 Node 自带 corepack 的入口（Windows 无扩展名 shim 是 Unix 脚本，须走 dist 入口）。
fn managed_corepack_js(node_version: &str) -> PathBuf {
    managed_node_dir(node_version)
        .join("node_modules")
        .join("corepack")
        .join("dist")
        .join("corepack.js")
}

/// pnpm 内容寻址存储目录（收在应用数据目录内，随数据管理可整体清理）。
pub fn pnpm_store_dir() -> PathBuf {
    dsh_root_dir().join("pnpm-store")
}

/// 预写 packages 目录的 package.json：
/// 1) 声明 `pnpm.onlyBuiltDependencies` 白名单——pnpm v10 默认拦截依赖的构建脚本，
///    而 npm 会执行；node-pty / koffi 等原生模块不编译会导致 dsh 终端/PTY 功能缺失
///    （白名单与锁定的 dsh 版本依赖集对应，更新 dsh 版本时同步维护）；
/// 2) 让 pnpm add 在确定性的清单上工作。
fn prepare_packages_manifest() -> Result<(), String> {
    let dir = dsh_packages_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建 dsh 包目录：{}", e))?;
    let manifest = dir.join("package.json");
    if manifest.exists() {
        return Ok(());
    }
    let content = serde_json::json!({
        "name": "agent-llm-dsh-packages",
        "private": true,
        "pnpm": {
            "onlyBuiltDependencies": [
                "@deepseek-ai/dsh-subprocess-local",
                "@google/genai",
                "koffi",
                "node-pty",
                "protobufjs"
            ]
        }
    });
    let text = serde_json::to_string_pretty(&content).map_err(|e| e.to_string())?;
    std::fs::write(&manifest, text).map_err(|e| format!("无法写入 package.json：{}", e))
}

/// 单次 pnpm 安装执行（corepack 运行锁定版本的 pnpm；append-only 报告器持续流式输出）。
fn run_pnpm_install(
    node_exe: &Path,
    corepack_js: &Path,
    pnpm_version: &str,
    packages_dir: &Path,
    store_dir: &Path,
    package_version: &str,
    proxy_url: Option<&str>,
    on_progress: &dyn Fn(String),
) -> Result<(), String> {
    let mut command = quiet_command(node_exe);
    command
        .arg(corepack_js)
        .arg(format!("pnpm@{}", pnpm_version))
        .arg("add")
        .arg("--dir")
        .arg(packages_dir)
        .arg("--store-dir")
        .arg(store_dir)
        .args(["--reporter", "append-only"])
        .arg(format!("@deepseek-ai/dsh@{}", package_version))
        .env("NO_COLOR", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(proxy) = proxy_url.filter(|url| !url.trim().is_empty()) {
        command
            .env("HTTP_PROXY", proxy)
            .env("HTTPS_PROXY", proxy)
            .env("http_proxy", proxy)
            .env("https_proxy", proxy)
            .env("NO_PROXY", "127.0.0.1,localhost")
            .env("no_proxy", "127.0.0.1,localhost");
    }

    dsh_manager::add_dsh_log(&format!(
        "[pnpm] corepack pnpm@{} add --dir {} @deepseek-ai/dsh@{}（存储 {}）",
        pnpm_version,
        packages_dir.display(),
        package_version,
        store_dir.display()
    ));
    let mut child = command
        .spawn()
        .map_err(|e| format!("无法启动 pnpm 安装进程：{}", e))?;

    let (tx, rx) = channel::<String>();
    if let Some(out) = child.stdout.take() {
        let tx_out = tx.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if tx_out.send(line).is_err() {
                    break;
                }
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
    }

    const SILENCE_TIMEOUT: Duration = Duration::from_secs(600);
    const OVERALL_TIMEOUT: Duration = Duration::from_secs(30 * 60);
    let started = Instant::now();
    let mut last_output = Instant::now();
    let mut last_heartbeat = 0u64;
    let mut tail: VecDeque<String> = VecDeque::with_capacity(16);
    loop {
        if ensure_not_cancelled().is_err() {
            let _ = child.kill();
            let _ = child.wait();
            dsh_manager::add_dsh_log("[pnpm] 安装已被用户取消。");
            return Err("安装已被用户取消。".to_string());
        }
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(line) => {
                last_output = Instant::now();
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    dsh_manager::add_dsh_log(&format!("[pnpm] {}", trimmed));
                    if tail.len() >= 12 {
                        tail.pop_front();
                    }
                    tail.push_back(trimmed.to_string());
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                if child.try_wait().map(|status| status.is_some()).unwrap_or(false) {
                    break;
                }
            }
        }
        let elapsed = started.elapsed();
        if elapsed >= OVERALL_TIMEOUT || last_output.elapsed() >= SILENCE_TIMEOUT {
            let reason = if elapsed >= OVERALL_TIMEOUT {
                format!("pnpm 安装总时长超过 {} 分钟", OVERALL_TIMEOUT.as_secs() / 60)
            } else {
                format!("pnpm 超过 {} 秒无任何输出（疑似挂死）", SILENCE_TIMEOUT.as_secs())
            };
            let _ = child.kill();
            let _ = child.wait();
            dsh_manager::add_dsh_log(&format!("[pnpm] 已终止：{}", reason));
            return Err(format!("pnpm 无响应：{}", reason));
        }
        let elapsed_secs = elapsed.as_secs();
        if elapsed_secs >= last_heartbeat + 15 {
            last_heartbeat = elapsed_secs;
            on_progress(format!("pnpm 正在解析并下载依赖（已运行 {} 秒）...", elapsed_secs));
        }
    }
    let status = child.wait().map_err(|e| format!("等待 pnpm 退出失败：{}", e))?;
    if !status.success() {
        let tail_text: String = tail.into_iter().take(8).collect::<Vec<_>>().join("\n");
        return Err(format!(
            "pnpm 安装失败（退出码 {:?}）：{}",
            status.code(),
            tail_text
        ));
    }
    Ok(())
}

/// 安装固定版本 `@deepseek-ai/dsh` 到 dsh/packages/。
/// 幂等：同版本已安装且 bin.js 存在时跳过。
/// 工具链三级回退：托管 corepack 跑锁定版 pnpm（实测约 1 分钟）→
/// 托管 npm → 系统 npm（运行时始终为托管 Node，保证版本一致）。
#[allow(clippy::too_many_arguments)]
pub fn install_dsh_package(
    node_version: &str,
    package_version: &str,
    proxy_url: Option<&str>,
    on_progress: &dyn Fn(String),
) -> Result<String, String> {
    ensure_not_cancelled()?;
    let node_exe = managed_node_dir(node_version).join("node.exe");
    if !node_exe.exists() {
        return Err(format!(
            "未找到托管 Node.js v{}，请先安装 Node 运行时。",
            node_version
        ));
    }

    if dsh_bin_js().exists() {
        if let Some(installed) = installed_package_version() {
            if installed == package_version {
                on_progress(format!("dsh v{} 已安装，跳过。", installed));
                return Ok(installed);
            }
        }
    }

    let packages_dir = dsh_packages_dir();
    prepare_packages_manifest()?;

    on_progress(format!(
        "开始安装 @deepseek-ai/dsh v{}（约 270 MB；正常 1-3 分钟，详细输出见 dsh 日志）...",
        package_version
    ));

    // 1) 快路径：corepack + 锁定版 pnpm。
    let corepack_js = managed_corepack_js(node_version);
    if corepack_js.exists() {
        if let Err(error) = run_pnpm_install(
            &node_exe,
            &corepack_js,
            crate::models::dsh_types::PNPM_PINNED_VERSION,
            &packages_dir,
            &pnpm_store_dir(),
            package_version,
            proxy_url,
            on_progress,
        ) {
            if error.contains("取消") {
                return Err(error);
            }
            dsh_manager::add_dsh_log(&format!("[pnpm] 失败，自动回退 npm：{}", error));
            on_progress("pnpm 安装未成功，自动改用 npm 继续安装...".to_string());
        }
    } else {
        dsh_manager::add_dsh_log("[pnpm] 托管 Node 缺少 corepack，直接使用 npm 安装。");
    }

    // 2) pnpm 未产出可用目录时，回退 npm 链路（托管 npm → 系统 npm）。
    if !dsh_bin_js().exists() {
        let npm_cli = managed_npm_cli(node_version);
        if !npm_cli.exists() {
            return Err(
                "托管 Node 目录缺少 npm（node_modules/npm），请重新安装 Node 运行时。".to_string(),
            );
        }
        let managed_result = run_npm_install(
            &node_exe,
            &npm_cli,
            &packages_dir,
            package_version,
            proxy_url,
            on_progress,
        );
        if let Err(error) = managed_result {
            let is_unresponsive = error.contains("npm 无响应");
            let system_node = detect_system_node();
            let fallback_cli = system_node.path.as_deref().and_then(system_npm_cli);
            if is_unresponsive {
                if let (Some(system_node_path), Some(system_cli)) = (&system_node.path, fallback_cli)
                {
                    dsh_manager::add_dsh_log(
                        "[npm] 托管 npm 无响应，自动回退：改用系统 Node 的 npm 继续安装（运行时仍为托管 Node）。",
                    );
                    on_progress("托管 npm 无响应，已自动改用系统 npm 继续安装...".to_string());
                    run_npm_install(
                        Path::new(system_node_path),
                        &system_cli,
                        &packages_dir,
                        package_version,
                        proxy_url,
                        on_progress,
                    )?;
                } else {
                    return Err(format!(
                        "{}。本机也未找到系统 Node 的 npm，无法自动回退：请检查杀毒软件对 {} 的拦截，或安装系统 Node.js LTS 后重试。",
                        error,
                        npm_cli.display()
                    ));
                }
            } else {
                return Err(error);
            }
        }
    }
    ensure_not_cancelled()?;

    if !dsh_bin_js().exists() {
        return Err(
            "npm 安装流程结束但未找到 dsh 入口（lib/bin.js），安装目录不完整。".to_string(),
        );
    }

    on_progress("正在验证 dsh 入口可用性...".to_string());
    let version_output = quiet_command(&node_exe)
        .arg(dsh_bin_js())
        .arg("--version")
        .output()
        .map_err(|e| format!("无法启动 dsh 验证进程：{}", e))?;
    let probed = String::from_utf8_lossy(&version_output.stdout).trim().to_string();
    if !version_output.status.success() || probed.is_empty() {
        let stderr = String::from_utf8_lossy(&version_output.stderr);
        return Err(format!("dsh --version 验证失败：{}", stderr.trim()));
    }

    write_version(
        &versions_file(),
        DshInstalledVersion {
            kind: "dsh".to_string(),
            version: probed.clone(),
            installed_at: unix_now(),
        },
    )?;
    on_progress(format!("dsh v{} 安装完成。", probed));
    Ok(probed)
}

/// 卸载 dsh 包（删除 dsh/packages 并清理 versions.json 记录）。
/// DSH_HOME（会话/设置）与托管 Node 不在此清理，由数据管理统一负责。
pub fn uninstall_dsh_package() -> Result<(), String> {
    let packages = dsh_packages_dir();
    if packages.exists() {
        std::fs::remove_dir_all(&packages)
            .map_err(|e| format!("无法删除 dsh 包目录：{}", e))?;
    }
    let file = versions_file();
    let mut list = read_versions(&file);
    list.retain(|item| item.kind != "dsh");
    let text = serde_json::to_string_pretty(&list).unwrap_or_else(|_| "[]".to_string());
    std::fs::create_dir_all(dsh_root_dir()).ok();
    std::fs::write(&file, text).map_err(|e| format!("无法更新安装记录：{}", e))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 状态汇总与环境检测
// ---------------------------------------------------------------------------

/// 汇总 dsh 当前安装状态（运行状态由 dsh_manager 填充）。
pub fn dsh_status() -> DshStatus {
    let node = resolve_node();
    let bin = dsh_bin_js();
    let installed = bin.exists();
    let package = DshPackageInfo {
        installed,
        version: if installed { installed_package_version() } else { None },
        bin_path: if installed { Some(bin.to_string_lossy().to_string()) } else { None },
    };
    DshStatus {
        node,
        package,
        home_dir: dsh_home_dir().to_string_lossy().to_string(),
        packages_dir: dsh_packages_dir().to_string_lossy().to_string(),
        web_url: format!("http://127.0.0.1:{}", crate::models::dsh_types::DSH_DEFAULT_PORT),
        runtime: crate::services::dsh_manager::runtime_status(),
        bound_model: None,
        bound_base_url: None,
    }
}

/// 端口是否可以绑定（可绑定 = 空闲）。
fn port_is_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// PowerShell 7 是否可用（dsh 命令执行的优选 shell；5.1 回退始终存在）。
fn pwsh7_available() -> bool {
    let program_files =
        std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".to_string());
    Path::new(&program_files)
        .join("PowerShell")
        .join("7")
        .join("pwsh.exe")
        .exists()
}

/// Agent 页的 dsh 环境检测（F2，含 Phase 0 补充的 dsh_shell 项）。
/// 与首启检测（run_env_check）相互独立，仅覆盖 dsh 链路；
/// 每项检测前后通过 on_progress 上报（前端进度可见，同时落入 dsh 日志）。
pub fn run_dsh_env_check(
    dsh_port: u16,
    llama_port: u16,
    on_progress: &dyn Fn(String),
) -> Vec<EnvCheckItem> {
    let steps: Vec<(&str, Box<dyn Fn() -> EnvCheckItem>)> = vec![
        ("Node.js 运行时", Box::new(check_dsh_node) as Box<dyn Fn() -> EnvCheckItem>),
        ("dsh 智能体框架", Box::new(check_dsh_package)),
        ("dsh 数据目录", Box::new(check_dsh_home)),
        ("dsh Web 端口", Box::new(move || check_dsh_port(dsh_port))),
        ("本地模型 API", Box::new(move || check_dsh_model_api(llama_port))),
        ("命令执行 Shell", Box::new(check_dsh_shell)),
    ];
    let mut items = Vec::with_capacity(steps.len());
    for (index, (title, check)) in steps.iter().enumerate() {
        on_progress(format!("正在检测（{}/{}）：{}...", index + 1, steps.len(), title));
        items.push(check());
    }
    on_progress(format!("环境检测完成：{} 项。", steps.len()));
    items
}

fn check_dsh_node() -> EnvCheckItem {
    const TITLE: &str = "Node.js 运行时";
    let node = resolve_node();
    match (&node.source, &node.version, &node.path) {
        (DshNodeSource::System, Some(version), path) => EnvCheckItem::new(
            "dsh_node",
            "ok",
            TITLE,
            format!(
                "使用系统 Node v{}（合规：^22.19 || >=24）。路径：{}",
                version,
                path.clone().unwrap_or_else(|| "PATH 中的 node".to_string())
            ),
        ),
        (DshNodeSource::Managed, Some(version), path) => EnvCheckItem::new(
            "dsh_node",
            "ok",
            TITLE,
            format!(
                "使用托管 Node.js v{}。路径：{}",
                version,
                path.clone().unwrap_or_default()
            ),
        ),
        _ => EnvCheckItem::new(
            "dsh_node",
            "error",
            TITLE,
            "未找到合规的 Node.js（需要 ^22.19 || >=24）。".to_string(),
        )
        .with_hint(
            "点击「安装 Node 运行时」由应用托管安装官方便携版（约 35 MB，不动系统环境），或到 Node.js 官网下载 LTS 安装。",
            Some("https://nodejs.org/zh-cn/download"),
            Some("dsh-install-node"),
        ),
    }
}

fn check_dsh_package() -> EnvCheckItem {
    const TITLE: &str = "dsh 智能体框架";
    let bin = dsh_bin_js();
    if !bin.exists() {
        return EnvCheckItem::new(
            "dsh_pkg",
            "error",
            TITLE,
            "尚未安装 @deepseek-ai/dsh 包。".to_string(),
        )
        .with_hint(
            "点击「安装 dsh」由应用托管安装固定版本（依赖约 270 MB，不污染全局 npm）。",
            None,
            Some("dsh-install-package"),
        );
    }
    match installed_package_version() {
        Some(version) => EnvCheckItem::new(
            "dsh_pkg",
            "ok",
            TITLE,
            format!("已安装 v{}。路径：{}", version, dsh_packages_dir().display()),
        ),
        None => EnvCheckItem::new(
            "dsh_pkg",
            "warning",
            TITLE,
            "安装目录存在但 package.json 无法解析，可能不完整，建议重装。".to_string(),
        )
        .with_hint("点击「重装 dsh」修复安装。", None, Some("dsh-install-package")),
    }
}

fn check_dsh_home() -> EnvCheckItem {
    const TITLE: &str = "dsh 数据目录";
    let home = dsh_home_dir();
    let probe = home.join(".dsh_env_check_write_test");
    let result = (|| -> std::io::Result<()> {
        std::fs::create_dir_all(&home)?;
        std::fs::write(&probe, b"ok")?;
        std::fs::remove_file(&probe)?;
        Ok(())
    })();
    match result {
        Ok(()) => EnvCheckItem::new(
            "dsh_home",
            "ok",
            TITLE,
            format!("目录可读写：{}", home.display()),
        ),
        Err(error) => EnvCheckItem::new(
            "dsh_home",
            "error",
            TITLE,
            format!("目录无法写入（{}）：{}", error, home.display()),
        )
        .with_hint(
            "请检查该目录的访问权限或杀毒软件拦截设置，dsh 的会话与设置无法保存。",
            None,
            None,
        ),
    }
}

fn check_dsh_port(dsh_port: u16) -> EnvCheckItem {
    const TITLE: &str = "dsh Web 端口";
    if port_is_free(dsh_port) {
        return EnvCheckItem::new("dsh_port", "ok", TITLE, format!("端口 {} 空闲可用。", dsh_port));
    }
    EnvCheckItem::new(
        "dsh_port",
        "warning",
        TITLE,
        format!("端口 {} 已被占用。可能是已在运行的 dsh，也可能是其他程序。", dsh_port),
    )
    .with_hint("若不是 dsh 占用，请在设置中修改 dsh 端口后重试。", None, None)
}

fn check_dsh_model_api(llama_port: u16) -> EnvCheckItem {
    const TITLE: &str = "本地模型 API";
    let ping = crate::services::process_manager::ping_server();
    if ping.reachable && ping.models_ok {
        let models = if ping.models.is_empty() {
            String::new()
        } else {
            format!("，可用模型：{}", ping.models.join("、"))
        };
        return EnvCheckItem::new(
            "dsh_model_api",
            "ok",
            TITLE,
            format!("llama-server 可达（{}）{}。", ping.base_url.unwrap_or_default(), models),
        );
    }
    // 应用进程不知道的实例（外部启动 / 上次会话遗留）：直连配置端口兜底探测。
    if let Ok(models) = crate::services::dsh_config::probe_models_at(llama_port) {
        return EnvCheckItem::new(
            "dsh_model_api",
            "ok",
            TITLE,
            format!(
                "检测到本地模型服务（127.0.0.1:{}，非本应用启动），可用模型：{}。",
                llama_port,
                models.join("、")
            ),
        );
    }
    if !crate::services::process_manager::is_server_running() {
        return EnvCheckItem::new(
            "dsh_model_api",
            "warning",
            TITLE,
            "llama-server 未运行，dsh 暂无可用模型。".to_string(),
        )
        .with_hint("先在「模型」页加载一个模型，再回到 Agent 页接入。", None, None);
    }
    EnvCheckItem::new(
        "dsh_model_api",
        "warning",
        TITLE,
        format!(
            "llama-server 正在运行但 API 未就绪：{}",
            ping.error.unwrap_or_else(|| "未知原因".to_string())
        ),
    )
}

fn check_dsh_shell() -> EnvCheckItem {
    const TITLE: &str = "命令执行 Shell";
    if pwsh7_available() {
        return EnvCheckItem::new(
            "dsh_shell",
            "ok",
            TITLE,
            "检测到 PowerShell 7（pwsh），dsh 命令执行将使用它。".to_string(),
        );
    }
    EnvCheckItem::new(
        "dsh_shell",
        "ok",
        TITLE,
        "未安装 PowerShell 7，dsh 将使用系统自带的 Windows PowerShell 5.1（可用；个别命令的中文输出可能乱码）。".to_string(),
    )
}

// ---------------------------------------------------------------------------
// 供 Phase 2 进程管理复用的启动参数组装
// ---------------------------------------------------------------------------

/// 组装 dsh 启动所需的子进程程序与参数：
/// `node <bin.js> web --no-open --port <port>`。
/// （F4/Phase 2 使用；这里只负责路径解析与参数形态，不涉及进程生命周期。）
#[allow(dead_code)]
pub fn compose_dsh_command_parts(
    node: &DshNodeInfo,
    dsh_port: u16,
) -> Result<(PathBuf, Vec<String>), String> {
    let node_path = match (&node.source, &node.path) {
        (DshNodeSource::System, Some(path)) => PathBuf::from(path),
        (DshNodeSource::Managed, Some(path)) => PathBuf::from(path),
        _ => return Err("未找到可用的 Node.js 运行时。".to_string()),
    };
    let bin = dsh_bin_js();
    if !bin.exists() {
        return Err("尚未安装 dsh 包。".to_string());
    }
    let args = vec![
        bin.to_string_lossy().to_string(),
        "web".to_string(),
        "--no-open".to_string(),
        "--port".to_string(),
        dsh_port.to_string(),
    ];
    Ok((node_path, args))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_version_parse() {
        assert_eq!(parse_node_version("v22.19.0"), Some((22, 19)));
        assert_eq!(parse_node_version("24.15.0"), Some((24, 15)));
        assert_eq!(parse_node_version("v20.11.1"), Some((20, 11)));
        assert_eq!(parse_node_version("garbage"), None);
    }

    #[test]
    fn node_version_compliance_follows_spike_conclusion() {
        // Phase 0 定稿：^22.19 || >=24。
        assert!(node_version_compliant("v22.19.0"));
        assert!(node_version_compliant("v22.23.2"));
        assert!(node_version_compliant("v24.15.0"));
        assert!(node_version_compliant("v26.0.0"));
        assert!(!node_version_compliant("v22.18.0"));
        assert!(!node_version_compliant("v20.18.0"));
        assert!(!node_version_compliant("v23.9.0"));
        assert!(!node_version_compliant("bogus"));
    }

    #[test]
    fn managed_dir_layout_matches_documented_convention() {
        let dir = managed_node_dir("22.23.2");
        let name = dir.file_name().unwrap().to_string_lossy().to_string();
        assert_eq!(name, "node-v22.23.2-win-x64");
    }
}
