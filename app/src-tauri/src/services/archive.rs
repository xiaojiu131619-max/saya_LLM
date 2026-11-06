//! 压缩包解压。
//!
//! - zip：直接复用核心更新已有的实现（内含 Zip Slip 防护）。
//! - rar：NiNfer 的发行包只有 `.rar`，交给随包的完整版 `7z.exe`。
//!   **不能用 `7zr.exe`**——它是精简版，不支持 RAR 解码。
//! - tar.gz：Strata 的引擎包，用系统自带的 bsdtar（Win10 17063+ 内置）。
//!
//! 所有解压都在临时目录里做完、校验路径没越界之后，才由调用方搬进正式位置；
//! 这样解压失败不会留下半个被覆盖的引擎目录。

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::services::{auto_updater, process_manager};

/// 963MB 的引擎包 + 机械盘，留足 30 分钟。
const EXTRACT_TIMEOUT: Duration = Duration::from_secs(1800);
const POLL_INTERVAL: Duration = Duration::from_millis(200);

/// 解压 rar（NiNfer 引擎包）。
pub fn extract_rar(archive: &Path, dest: &Path) -> Result<(), String> {
    let seven = seven_zip_exe()?;
    prepare_dir(dest)?;
    run_archiver(
        seven.to_string_lossy().as_ref(),
        &[
            "x".to_string(),
            "-y".to_string(),
            "-bd".to_string(),
            "-bso0".to_string(),
            "-bsp0".to_string(),
            format!("-o{}", dest.display()),
            archive.display().to_string(),
        ],
        "7-Zip",
    )?;
    ensure_within(dest)
}

pub fn extract_tar_gz(archive: &Path, dest: &Path) -> Result<(), String> {
    prepare_dir(dest)?;
    run_archiver(
        "tar",
        &[
            "-xzf".to_string(),
            archive.display().to_string(),
            "-C".to_string(),
            dest.display().to_string(),
        ],
        "tar",
    )?;
    ensure_within(dest)
}

/// 随包分发的 7z.exe 位置。允许用环境变量覆盖，方便开发期指向本地副本。
fn seven_zip_exe() -> Result<PathBuf, String> {
    if let Some(raw) = std::env::var_os("AGENT_LLM_7Z") {
        let candidate = PathBuf::from(raw);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    let resources = auto_updater::resource_dir();
    for candidate in [
        resources.join("tools").join("7z.exe"),
        resources.join("7z.exe"),
        resources.join("7z").join("7z.exe"),
    ] {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "缺少解压组件 7z.exe（应在 {}）。请重新安装应用，或把 7z.exe 放到资源目录。",
        resources.display()
    ))
}

fn prepare_dir(dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest)
        .map_err(|e| format!("无法创建解压目录（{}）：{e}", dest.display()))
}

fn run_archiver(program: &str, args: &[String], label: &str) -> Result<(), String> {
    let mut child = process_manager::spawn_sidecar_process(program, args, None, &[])
        .map_err(|e| format!("无法启动{label}解压程序：{e}"))?;
    let started = Instant::now();
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|e| format!("等待{label}解压失败：{e}"))?
        {
            if status.success() {
                return Ok(());
            }
            return Err(format!(
                "{label}解压失败（退出码 {}）。压缩包可能已损坏。",
                status.code().unwrap_or(-1)
            ));
        }
        if auto_updater::ensure_not_cancelled().is_err() {
            process_manager::terminate_process_tree(&mut child, "archive");
            return Err("已取消解压。".to_string());
        }
        if started.elapsed() > EXTRACT_TIMEOUT {
            process_manager::terminate_process_tree(&mut child, "archive");
            return Err(format!(
                "{label}解压超时（超过 {} 分钟），已中止。",
                EXTRACT_TIMEOUT.as_secs() / 60
            ));
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

/// 解压后再确认一遍：任何条目都不能跑到目标目录之外。
fn ensure_within(root: &Path) -> Result<(), String> {
    let root = root
        .canonicalize()
        .map_err(|e| format!("无法解析解压目录（{}）：{e}", root.display()))?;
    for entry in walkdir::WalkDir::new(&root) {
        let entry = entry.map_err(|e| format!("校验解压结果失败：{e}"))?;
        let path = entry.path();
        let canonical = path
            .canonicalize()
            .map_err(|e| format!("校验解压结果失败（{}）：{e}", path.display()))?;
        if !canonical.starts_with(&root) {
            return Err(format!(
                "压缩包试图写入目标目录之外（{}），已中止。",
                path.display()
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_within_accepts_plain_tree() {
        let dir = std::env::temp_dir().join("agent-llm-within-test");
        std::fs::create_dir_all(&dir).ok();
        std::fs::write(dir.join("a.txt"), b"ok").ok();
        assert!(ensure_within(&dir).is_ok());
        std::fs::remove_dir_all(&dir).ok();
    }
}
