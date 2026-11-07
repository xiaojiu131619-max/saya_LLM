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
    // 先枚举条目做安全校验：绝对路径 / `..` 越界必须在解压前拒绝，
    // 不能等 7z 已经写出去之后再回头检查。
    for name in list_rar_entries(archive)? {
        reject_unsafe_entry(&name)?;
    }
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
    // 同上：条目级校验（含符号链接 / 硬链接）全部在解压前完成。
    validate_tar_entries(&list_tar_gz_entries(archive)?)?;
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

/// 运行解压器并捕获 stdout（用于解压前的条目枚举）。
/// 用 `Command::output()` 边读边等，避免条目多时管道写满导致子进程卡死。
fn run_archiver_capture(program: &Path, args: &[String], label: &str) -> Result<Vec<u8>, String> {
    use std::os::windows::process::CommandExt;
    let output = std::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output()
        .map_err(|e| format!("无法启动{label}：{e}"))?;
    if !output.status.success() {
        return Err(format!(
            "{label}失败（退出码 {}）。压缩包可能已损坏。",
            output.status.code().unwrap_or(-1)
        ));
    }
    Ok(output.stdout)
}

/// 枚举 RAR 条目名（`7z l -slt -ba` 的 `Path = ` 行）。
fn list_rar_entries(archive: &Path) -> Result<Vec<String>, String> {
    let seven = seven_zip_exe()?;
    let stdout = run_archiver_capture(
        &seven,
        &[
            "l".to_string(),
            "-slt".to_string(),
            "-ba".to_string(),
            "-bd".to_string(),
            archive.display().to_string(),
        ],
        "7-Zip 条目列表",
    )?;
    let text = String::from_utf8_lossy(&stdout);
    let entries: Vec<String> = text
        .lines()
        .filter_map(|line| line.trim_start().strip_prefix("Path = "))
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .collect();
    if entries.is_empty() {
        return Err("无法读取 RAR 条目列表，已中止（未解压）。".to_string());
    }
    Ok(entries)
}

/// 枚举 tar.gz 条目名与类型（`tar -tzf` 列名字、`tar -tvzf` 列类型，顺序一致）。
fn list_tar_gz_entries(archive: &Path) -> Result<Vec<(String, char)>, String> {
    let archive_arg = archive.display().to_string();
    let names_out = run_archiver_capture(
        Path::new("tar"),
        &["-tzf".to_string(), archive_arg.clone()],
        "tar 条目列表",
    )?;
    let details_out = run_archiver_capture(
        Path::new("tar"),
        &["-tvzf".to_string(), archive_arg],
        "tar 条目列表",
    )?;
    let names: Vec<String> = String::from_utf8_lossy(&names_out)
        .lines()
        .map(|line| line.trim_end_matches('\r').to_string())
        .filter(|line| !line.is_empty())
        .collect();
    let kinds: Vec<char> = String::from_utf8_lossy(&details_out)
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.chars().next().unwrap_or('-'))
        .collect();
    if names.len() != kinds.len() {
        return Err("tar 条目列表解析失败，已中止（未解压）。".to_string());
    }
    Ok(names.into_iter().zip(kinds).collect())
}

/// 单条路径安全检查：拒绝绝对路径与 `..` 越界组件。
fn reject_unsafe_entry(name: &str) -> Result<(), String> {
    let normalized = name.replace('\\', "/");
    let trimmed = normalized.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    let bytes = trimmed.as_bytes();
    let absolute = trimmed.starts_with('/')
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':');
    if absolute {
        return Err(format!(
            "压缩包包含绝对路径条目（{}），已中止（未解压）。",
            name
        ));
    }
    if trimmed
        .split('/')
        .any(|component| component == "..")
    {
        return Err(format!(
            "压缩包包含越界路径条目（{}），已中止（未解压）。",
            name
        ));
    }
    Ok(())
}

/// tar 条目级校验：路径安全 + 拒绝符号链接（`l`）/ 硬链接（`h`）。
fn validate_tar_entries(entries: &[(String, char)]) -> Result<(), String> {
    for (name, kind) in entries {
        reject_unsafe_entry(name)?;
        if matches!(kind, 'l' | 'h') {
            return Err(format!(
                "压缩包包含链接条目（{}），已中止（未解压）。",
                name
            ));
        }
    }
    Ok(())
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

/// 解压后再确认一遍：任何条目都不能跑到目标目录之外，也不接受符号链接。
fn ensure_within(root: &Path) -> Result<(), String> {
    let root = root
        .canonicalize()
        .map_err(|e| format!("无法解析解压目录（{}）：{e}", root.display()))?;
    for entry in walkdir::WalkDir::new(&root) {
        let entry = entry.map_err(|e| format!("校验解压结果失败：{e}"))?;
        if entry.file_type().is_symlink() {
            return Err(format!(
                "压缩包包含符号链接（{}），已中止。",
                entry.path().display()
            ));
        }
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

    /// 解压前条目校验：绝对路径 / 盘符 / `..` 越界必须拒绝，正常相对路径放行。
    #[test]
    fn rejects_unsafe_archive_entries() {
        for safe in ["a.txt", "dir/a.txt", "dir\\a.txt", "a/./b.txt"] {
            assert!(reject_unsafe_entry(safe).is_ok(), "{safe} 应放行");
        }
        for unsafe_name in [
            "/etc/passwd",
            "\\windows\\system32\\x.dll",
            "C:\\Windows\\x.dll",
            "c:/windows/x.dll",
            "../escape.txt",
            "a/../../escape.txt",
            "a\\..\\..\\escape.txt",
        ] {
            assert!(
                reject_unsafe_entry(unsafe_name).is_err(),
                "{unsafe_name} 必须拒绝"
            );
        }
    }

    /// tar 符号链接 / 硬链接条目必须在解压前拒绝。
    #[test]
    fn rejects_tar_link_entries() {
        let ok = vec![
            ("a.txt".to_string(), '-'),
            ("dir/".to_string(), 'd'),
        ];
        assert!(validate_tar_entries(&ok).is_ok());

        let symlink = vec![("link".to_string(), 'l')];
        assert!(validate_tar_entries(&symlink).is_err());

        let hardlink = vec![("hard".to_string(), 'h')];
        assert!(validate_tar_entries(&hardlink).is_err());
    }
}
