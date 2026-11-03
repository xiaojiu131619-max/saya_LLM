//! Pi 的在线安装 / 升级 / 回滚。
//!
//! 与 [`pi_agent::install`](crate::services::pi_agent::install)（本地复制）互补：
//! 这一层的 npm 从 registry 在线拉取 `@earendil-works/pi-coding-agent` 及整棵依赖树
//! （本机实测约 114 MB）。完整性由 npm 自带的 SRI（sha512）逐包校验，这不是宿主
//! 可关闭的行为；顶层包的 `dist.integrity` 另行记录进 `pi-version.json` 供排障。
//!
//! 升级流程：旧 `node_modules` 改名为回滚点 → npm 安装（失败 / 冒烟失败时把
//! 回滚点换回来）。回滚点只保留最近一份：再次升级会覆盖上一份，这是
//! 「回滚上一版本」语义。
//!
//! 进程一律经 [`process_manager::spawn_sidecar_process`] 拉起：程序字符串先过
//! 白名单校验，参数以列表逐项传递，不经过任何 shell 解释。

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::services::pi_agent::{self, PiAgentInstallResult};
use crate::services::process_manager;

pub const PACKAGE: &str = "@earendil-works/pi-coding-agent";
pub const REGISTRY_OFFICIAL: &str = "https://registry.npmjs.org";
pub const REGISTRY_MIRROR: &str = "https://registry.npmmirror.com";

/// npm 元数据请求超时；下载本身由 npm 进程自己控制，没有宿主超时。
const METADATA_TIMEOUT_SECS: u64 = 20;
/// `npm --version` 探测的等待上限。
const NPM_PROBE_TIMEOUT_SECS: u64 = 10;
/// 安装后冒烟测试的等待上限（`node cli.js --version`）。
const SMOKE_TIMEOUT_SECS: u64 = 20;
/// 版本列表最多返回多少条（含 latest）。
const VERSION_LIST_MAX: usize = 15;

static INSTALLING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiNpmVersionInfo {
    pub version: String,
    /// registry 元数据里的 `dist.integrity`（sha512-…）。
    pub integrity: String,
    pub tarball: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiNpmVersionsResult {
    pub package: String,
    pub registry: String,
    pub installed_version: Option<String>,
    pub latest: String,
    pub versions: Vec<PiNpmVersionInfo>,
    /// 当前是否已有可回滚的上一版本。
    pub rollback_available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiVersionLock {
    pub name: String,
    pub version: String,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integrity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_version: Option<String>,
    pub installed_at: u64,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

/// registry 只接受 http(s) URL；去尾斜杠，空值回落官方源。
pub fn normalize_registry(registry: Option<&str>) -> Result<String, String> {
    let raw = registry
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(REGISTRY_OFFICIAL);
    let raw = raw.trim_end_matches('/');
    if !raw.starts_with("http://") && !raw.starts_with("https://") {
        return Err(format!("registry 必须以 http:// 或 https:// 开头：{raw}"));
    }
    if raw.contains(char::is_whitespace) {
        return Err("registry 不能包含空白字符".to_string());
    }
    Ok(raw.to_string())
}

/// 版本号只允许 semver 字符，避免拼进命令行参数。
fn sanitize_version(version: &str) -> Result<String, String> {
    let version = version.trim();
    if version.is_empty() {
        return Err("版本号不能为空".to_string());
    }
    if !version
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '+' | '_'))
    {
        return Err(format!("版本号包含不支持的字符：{version}"));
    }
    Ok(version.to_string())
}

fn node_modules_root() -> PathBuf {
    pi_agent::pi_data_root().join("node_modules")
}

fn rollback_point() -> PathBuf {
    pi_agent::pi_data_root().join("node_modules.backup")
}

/// 当前安装的版本：优先读版本锁，回落读包内 package.json。
pub fn installed_version() -> Option<String> {
    let lock_path = pi_agent::pi_data_root().join("pi-version.json");
    if let Ok(text) = std::fs::read_to_string(&lock_path) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(version) = value.get("version").and_then(|v| v.as_str()) {
                if !version.is_empty() {
                    return Some(version.to_string());
                }
            }
        }
    }
    pi_agent::read_pi_version(&node_modules_root())
}

/// 是否存在可回滚的上一版本。
pub fn rollback_available() -> bool {
    pi_agent::find_node_modules(&rollback_point()).is_some()
}

/// 读 `pi-version.json`；不存在或解析失败时返回 None。
pub fn read_version_lock() -> Option<PiVersionLock> {
    let text = std::fs::read_to_string(pi_agent::pi_data_root().join("pi-version.json")).ok()?;
    serde_json::from_str(&text).ok()
}

/// 版本信息的只读快照（界面展示用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiVersionInfoResult {
    pub installed_version: Option<String>,
    pub lock: Option<PiVersionLock>,
    pub rollback_available: bool,
    /// 常用 registry：官方源 + 国内镜像，界面下拉直接用。
    pub registries: Vec<RegistryOption>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryOption {
    pub id: &'static str,
    pub label: &'static str,
    pub url: &'static str,
}

pub fn version_info() -> PiVersionInfoResult {
    PiVersionInfoResult {
        installed_version: installed_version(),
        lock: read_version_lock(),
        rollback_available: rollback_available(),
        registries: vec![
            RegistryOption {
                id: "official",
                label: "官方 npm",
                url: REGISTRY_OFFICIAL,
            },
            RegistryOption {
                id: "npmmirror",
                label: "npmmirror 镜像",
                url: REGISTRY_MIRROR,
            },
        ],
    }
}

fn write_version_lock(lock: &PiVersionLock) -> Result<(), String> {
    let path = pi_agent::pi_data_root().join("pi-version.json");
    std::fs::create_dir_all(pi_agent::pi_data_root())
        .map_err(|error| format!("创建 Pi 目录失败：{error}"))?;
    std::fs::write(&path, serde_json::to_string_pretty(lock).map_err(|e| e.to_string())?)
        .map_err(|error| format!("写入版本锁失败：{error}"))
}

fn semver_key(version: &str) -> (u64, u64, u64, bool, String) {
    let (core, prerelease) = match version.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (version, None),
    };
    let mut numbers = [0u64, 0, 0];
    for (index, part) in core.split('.').take(3).enumerate() {
        numbers[index] = part.parse::<u64>().unwrap_or(0);
    }
    (
        numbers[0],
        numbers[1],
        numbers[2],
        prerelease.is_none(),
        prerelease.unwrap_or("").to_string(),
    )
}

/// 拉取 npm registry 元数据，返回可安装的版本列表（新版本在前，含 latest）。
pub fn fetch_versions(
    registry: Option<&str>,
    proxy_url: Option<&str>,
) -> Result<PiNpmVersionsResult, String> {
    let registry = normalize_registry(registry)?;
    // npm 的 scoped 包名在 URL 里必须编码：@scope/name -> @scope%2Fname
    let url = format!("{registry}/@earendil-works%2Fpi-coding-agent");
    let client = crate::services::auto_updater::build_client(
        proxy_url,
        METADATA_TIMEOUT_SECS,
        METADATA_TIMEOUT_SECS.min(10),
    )?;
    pi_agent::add_log(&format!("[pi:install] 读取 registry 元数据 {url}"));
    let response = client
        .get(&url)
        .header(
            "Accept",
            "application/vnd.npm.install-v1+json, application/json",
        )
        .send()
        .map_err(|error| format!("读取 registry 元数据失败：{error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("registry 返回 HTTP {status}：{url}"));
    }
    let value: serde_json::Value = response
        .json()
        .map_err(|error| format!("解析 registry 元数据失败：{error}"))?;

    let latest = value
        .pointer("/dist-tags/latest")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if latest.is_empty() {
        return Err("registry 元数据缺少 dist-tags.latest".to_string());
    }

    let mut versions: Vec<PiNpmVersionInfo> = Vec::new();
    if let Some(map) = map_of(&value) {
        for (name, entry) in map {
            // 预发布版本（1.2.3-beta.1）不进列表；用户可以手填版本强制装。
            if name.contains('-') && name != &latest {
                continue;
            }
            versions.push(PiNpmVersionInfo {
                version: name.clone(),
                integrity: entry_integrity(entry),
                tarball: entry_tarball(entry),
            });
        }
    }
    versions.sort_by(|a, b| {
        semver_key(&b.version)
            .partial_cmp(&semver_key(&a.version))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    versions.truncate(VERSION_LIST_MAX);

    Ok(PiNpmVersionsResult {
        package: PACKAGE.to_string(),
        registry,
        installed_version: installed_version(),
        latest,
        versions,
        rollback_available: rollback_available(),
    })
}

fn map_of(value: &serde_json::Value) -> Option<&serde_json::Map<String, serde_json::Value>> {
    value.get("versions").and_then(|v| v.as_object())
}

fn entry_integrity(entry: &serde_json::Value) -> String {
    entry
        .get("dist")
        .and_then(|dist| dist.get("integrity"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn entry_tarball(entry: &serde_json::Value) -> String {
    entry
        .get("dist")
        .and_then(|dist| dist.get("tarball"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// 定位 npm：环境变量 → PATH 上的 npm.cmd → 常见安装位置。
fn find_npm() -> Result<String, String> {
    if let Ok(path) = std::env::var("PI_AGENT_NPM") {
        let trimmed = path.trim();
        if !trimmed.is_empty() && Path::new(trimmed).is_file() {
            return Ok(trimmed.to_string());
        }
    }
    let mut candidates: Vec<String> = vec!["npm.cmd".to_string()];
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        candidates.push(format!(
            "{}\\nodejs\\npm.cmd",
            program_files.to_string_lossy()
        ));
    }
    if let Some(home) = std::env::var_os("USERPROFILE") {
        candidates.push(format!(
            "{}\\AppData\\Roaming\\npm\\npm.cmd",
            home.to_string_lossy()
        ));
    }
    for candidate in &candidates {
        if npm_works(candidate) {
            return Ok(candidate.clone());
        }
    }
    Err("未找到 npm。请先安装 Node.js（含 npm），或设置环境变量 PI_AGENT_NPM 指向 npm.cmd。".to_string())
}

fn npm_works(candidate: &str) -> bool {
    let child = process_manager::spawn_sidecar_process(
        candidate,
        &["--version".to_string()],
        None,
        &[],
    );
    let mut child = match child {
        Ok(child) => child,
        Err(_) => return false,
    };
    let deadline = Instant::now() + Duration::from_secs(NPM_PROBE_TIMEOUT_SECS);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) => {
                if Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return false;
                }
                thread::sleep(Duration::from_millis(100));
            }
            Err(_) => return false,
        }
    }
}

fn dir_stats(dir: &Path) -> (usize, u64) {
    let mut files = 0usize;
    let mut bytes = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                stack.push(entry.path());
            } else if file_type.is_file() {
                files += 1;
                bytes += entry.metadata().map(|meta| meta.len()).unwrap_or(0);
            }
        }
    }
    (files, bytes)
}

/// 安装失败 / 冒烟失败时把回滚点换回 node_modules。
fn restore_backup(backup: &Path) {
    let target = node_modules_root();
    if backup.exists() {
        if target.exists() {
            let _ = std::fs::remove_dir_all(&target);
        }
        let _ = std::fs::rename(backup, &target);
        pi_agent::add_log("[pi:install] 已恢复上一版本 node_modules");
    }
}

fn read_piped(child: &mut Child) -> String {
    use std::io::Read;
    let mut output = String::new();
    if let Some(stdout) = child.stdout.as_mut() {
        let _ = stdout.read_to_string(&mut output);
    }
    output.trim().to_string()
}

/// 冒烟测试：`node <cli.js> --version` 能打印版本号才算安装成功。
fn smoke_test(node_path: &str, cli_path: &Path) -> Result<String, String> {
    let mut child = process_manager::spawn_sidecar_process(
        node_path.trim(),
        &[cli_path.display().to_string(), "--version".to_string()],
        None,
        &[],
    )
    .map_err(|error| format!("冒烟测试无法启动 Node：{error}"))?;
    let deadline = Instant::now() + Duration::from_secs(SMOKE_TIMEOUT_SECS);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = read_piped(&mut child);
                if status.success() && !output.is_empty() {
                    return Ok(output);
                }
                return Err(format!("Pi CLI 冒烟测试失败（exit {status}）：{output}"));
            }
            Ok(None) => {
                if Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("Pi CLI 冒烟测试超时".to_string());
                }
                thread::sleep(Duration::from_millis(150));
            }
            Err(error) => return Err(format!("冒烟测试失败：{error}")),
        }
    }
}

/// 从 npm 在线安装指定版本的 Pi（含整棵依赖树）。
///
/// 流程：备份旧安装 → npm 安装（`--global-style` 落到 `<prefix>/node_modules`，
/// 与 `discover()` 的候选路径一致；npm 对每个下载的 tarball 做 SRI sha512 校验）
/// → 校验版本 → `--version` 冒烟 → 写版本锁。失败自动恢复旧安装。
pub fn install_online(
    version: &str,
    registry: Option<&str>,
    node_path: Option<&str>,
    proxy_url: Option<&str>,
) -> Result<PiAgentInstallResult, String> {
    let version = sanitize_version(version)?;
    let registry = normalize_registry(registry)?;
    // Windows 下 rename 正在使用的 node_modules 会共享冲突；Pi 在跑时直接拒绝，
    // 给出明确动作指引，而不是报一句晦涩的备份失败。
    if pi_agent::is_running() {
        return Err("Pi 正在运行：请先停止 Pi（或等当前任务收尾）再安装 / 升级。".to_string());
    }
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err("已有 Pi 在线安装在进行中".to_string());
    }
    let result = install_online_inner(&version, &registry, node_path, proxy_url);
    INSTALLING.store(false, Ordering::SeqCst);
    result
}

fn install_online_inner(
    version: &str,
    registry: &str,
    node_path: Option<&str>,
    proxy_url: Option<&str>,
) -> Result<PiAgentInstallResult, String> {
    // 顶层包的 integrity 记录用；拿不到不阻塞安装（npm 自己会做 SRI 校验）。
    let top_integrity = fetch_versions(Some(registry), proxy_url)
        .ok()
        .and_then(|result| {
            result
                .versions
                .iter()
                .find(|info| info.version == version)
                .map(|info| info.integrity.clone())
                .filter(|integrity| !integrity.is_empty())
        })
        .or_else(|| {
            // 列表截断或预发布版本时列表里没有，单独查一次完整元数据。
            let url = format!("{registry}/@earendil-works/pi-coding-agent");
            let client = crate::services::auto_updater::build_client(
                proxy_url,
                METADATA_TIMEOUT_SECS,
                10,
            )
            .ok()?;
            let value: serde_json::Value = client.get(&url).send().ok()?.json().ok()?;
            value
                .pointer(&format!("/versions/{version}/dist/integrity"))
                .and_then(|v| v.as_str())
                .map(str::to_string)
        });

    let npm = find_npm()?;
    let pi_root = pi_agent::pi_data_root();
    let target = node_modules_root();
    let previous_version = installed_version();

    // 备份旧安装作为回滚点；只保留一份。
    let backup = rollback_point();
    if backup.exists() {
        std::fs::remove_dir_all(&backup)
            .map_err(|error| format!("清理旧回滚点失败：{error}"))?;
    }
    if target.exists() {
        std::fs::rename(&target, &backup)
            .map_err(|error| format!("备份当前 Pi 安装失败：{error}"))?;
    }

    pi_agent::add_log(&format!(
        "[pi:install] 开始在线安装 {PACKAGE}@{version}（registry {registry}）"
    ));
    let package_ref = format!("{PACKAGE}@{version}");
    let npm_args: Vec<String> = [
        "install",
        "--prefix",
        pi_root.to_str().unwrap_or("."),
        "--global-style",
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--registry",
        registry,
        package_ref.as_str(),
    ]
    .iter()
    .map(|value| value.to_string())
    .collect();

    let mut child = match process_manager::spawn_sidecar_process(
        &npm,
        &npm_args,
        Some(pi_root.to_str().unwrap_or(".")),
        &[],
    ) {
        Ok(child) => child,
        Err(error) => {
            restore_backup(&backup);
            return Err(format!("启动 npm 失败：{error}"));
        }
    };

    // npm 输出逐行进 Pi 运行日志，界面能看进度。
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_thread = thread::spawn(move || {
        if let Some(reader) = stdout.map(BufReader::new) {
            for line in reader.lines().map_while(Result::ok) {
                if !line.trim().is_empty() {
                    pi_agent::add_log(&format!("[pi:install] {line}"));
                }
            }
        }
    });
    let stderr_thread = thread::spawn(move || {
        if let Some(reader) = stderr.map(BufReader::new) {
            for line in reader.lines().map_while(Result::ok) {
                if !line.trim().is_empty() {
                    pi_agent::add_log(&format!("[pi:install] {line}"));
                }
            }
        }
    });

    let status = match child.wait() {
        Ok(status) => status,
        Err(error) => {
            restore_backup(&backup);
            return Err(format!("等待 npm 失败：{error}"));
        }
    };
    let _ = stdout_thread.join();
    let _ = stderr_thread.join();

    if !status.success() {
        restore_backup(&backup);
        return Err(format!(
            "npm 安装失败（exit {status}），已恢复上一版本；详情见 Pi 运行日志。"
        ));
    }

    // npm 可能装出别的东西；必须确认目标包在位且版本一致。
    let installed = pi_agent::read_pi_version(&target).unwrap_or_default();
    if installed != version {
        restore_backup(&backup);
        return Err(format!(
            "npm 完成但安装的版本是 {installed:?}，期望 {version:?}；已恢复上一版本。"
        ));
    }

    let cli = target
        .join("@earendil-works")
        .join("pi-coding-agent")
        .join("dist")
        .join("bundle")
        .join("cli.js");
    let node = node_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("node");
    if let Err(error) = smoke_test(node, &cli) {
        restore_backup(&backup);
        pi_agent::add_log(&format!("[pi:install] 冒烟失败：{error}"));
        return Err(format!("{error}；已恢复上一版本。"));
    }

    let (files, bytes) = dir_stats(&target);
    let lock = PiVersionLock {
        name: PACKAGE.to_string(),
        version: version.to_string(),
        source: format!("npm:{registry}"),
        integrity: top_integrity,
        previous_version: previous_version.clone(),
        installed_at: now_secs(),
    };
    if let Err(error) = write_version_lock(&lock) {
        // 版本锁写失败不回滚：安装本身已验证可用。
        pi_agent::add_log(&format!("[pi:install] 警告：{error}"));
    }
    pi_agent::add_log(&format!(
        "[pi:install] {PACKAGE}@{version} 安装完成（{files} 个文件，{:.1} MB）",
        bytes as f64 / 1024.0 / 1024.0
    ));

    Ok(PiAgentInstallResult {
        target: target.display().to_string(),
        version: version.to_string(),
        files,
        bytes,
    })
}

/// 回滚到上一版本（升级时保留的 `node_modules.backup`）。
pub fn rollback() -> Result<PiAgentInstallResult, String> {
    let backup = rollback_point();
    if !backup.exists() {
        return Err("没有可回滚的上一版本。".to_string());
    }
    if pi_agent::is_running() {
        return Err("Pi 正在运行：请先停止 Pi 再回滚。".to_string());
    }
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err("已有 Pi 在线安装在进行中".to_string());
    }
    let result = rollback_inner(&backup);
    INSTALLING.store(false, Ordering::SeqCst);
    result
}

fn rollback_inner(backup: &Path) -> Result<PiAgentInstallResult, String> {
    let target = node_modules_root();
    let previous_version = installed_version();
    let mut discarded: Option<PathBuf> = None;
    if target.exists() {
        let stale = pi_agent::pi_data_root().join(format!(
            "node_modules.discarded-{}",
            std::process::id()
        ));
        std::fs::rename(&target, &stale)
            .map_err(|error| format!("移出当前安装失败：{error}"))?;
        discarded = Some(stale);
    }
    if let Err(error) = std::fs::rename(backup, &target) {
        if let Some(stale) = &discarded {
            let _ = std::fs::rename(stale, &target);
        }
        return Err(format!("回滚失败：{error}"));
    }
    if let Some(stale) = &discarded {
        let _ = std::fs::remove_dir_all(stale);
    }

    let version = pi_agent::read_pi_version(&target).unwrap_or_else(|| "unknown".to_string());
    let lock = PiVersionLock {
        name: PACKAGE.to_string(),
        version: version.clone(),
        source: "rollback".to_string(),
        integrity: None,
        previous_version,
        installed_at: now_secs(),
    };
    if let Err(error) = write_version_lock(&lock) {
        pi_agent::add_log(&format!("[pi:install] 被警告：{error}"));
    }
    let (files, bytes) = dir_stats(&target);
    pi_agent::add_log(&format!("[pi:install] 已回滚到 {version}"));
    Ok(PiAgentInstallResult {
        target: target.display().to_string(),
        version,
        files,
        bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_must_be_http_url() {
        assert_eq!(normalize_registry(None).unwrap(), REGISTRY_OFFICIAL);
        assert_eq!(
            normalize_registry(Some("https://registry.npmmirror.com/")).unwrap(),
            REGISTRY_MIRROR
        );
        assert!(normalize_registry(Some("ftp://example.com")).is_err());
        assert!(normalize_registry(Some("registry.npmjs.org")).is_err());
    }

    #[test]
    fn version_must_be_semver_like() {
        assert!(sanitize_version("1.5.0").is_ok());
        assert!(sanitize_version("1.5.0-beta.2").is_ok());
        assert!(sanitize_version("").is_err());
        assert!(sanitize_version("1.5.0; rm -rf /").is_err());
        assert!(sanitize_version("1.5.0 & echo").is_err());
    }

    #[test]
    fn semver_sort_prefers_newer_release() {
        let mut versions = vec!["1.10.0", "1.9.0", "2.0.0", "1.5.0"];
        versions.sort_by(|a, b| {
            semver_key(b)
                .partial_cmp(&semver_key(a))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        assert_eq!(versions, vec!["2.0.0", "1.10.0", "1.9.0", "1.5.0"]);
    }
}
