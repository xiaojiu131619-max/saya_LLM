//! Pi 会话产物的解析与读取。
//!
//! 产物路径只允许落在 Pi 启动时配置的工作区根目录下；每个会话一个子目录，
//! 读取时由前端带上会话工作区，宿主再做一次 canonicalize 校验。
//! 这里不记录文件内容，只返回相对路径、大小、修改时间和按需读取的预览。

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use walkdir::WalkDir;

use crate::services::pi_agent;

const ARTIFACT_MAX_DEPTH: usize = 8;
const ARTIFACT_MAX_ENTRIES: usize = 20_000;
const ARTIFACT_IMAGE_LIMIT: u64 = 16 * 1024 * 1024;
const ARTIFACT_PDF_LIMIT: u64 = 24 * 1024 * 1024;
const ARTIFACT_TEXT_LIMIT: u64 = 2 * 1024 * 1024;
/// 嗅探文件头时最多读这么多字节；魔数都在前 64 字节内。
const SNIFF_BYTES: usize = 64;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiResolvedArtifact {
    pub name: String,
    pub rel_path: String,
    pub size: u64,
    pub mtime: u64,
    pub exists: bool,
    pub duplicate: bool,
    /// 文件头嗅探出的真实格式（png / jpeg / pdf / zip …）；认不出时为 null。
    pub magic: Option<String>,
    /// 扩展名有已知签名且与文件头一致；扩展名没有签名要求时保持 true。
    pub magic_ok: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiArtifactPayload {
    pub kind: String,
    pub mime_type: String,
    pub size: u64,
    pub data_url: Option<String>,
    pub text: Option<String>,
}

/// 解析并校验会话工作区：必须位于 Pi 启动时配置的根目录下。
fn allowed_work_dir(requested: Option<&str>) -> Result<PathBuf, String> {
    let root = pi_agent::current_work_root()
        .ok_or_else(|| "Pi 尚未启动，无法读取产物；请先发送一条任务。".to_string())?;
    let root = root
        .canonicalize()
        .map_err(|_| "Pi 工作区根目录不存在，请检查设置。".to_string())?;
    let requested = requested.map(str::trim).filter(|path| !path.is_empty());
    let work = match requested {
        Some(path) => PathBuf::from(path),
        None => pi_agent::current_work_dir()
            .ok_or_else(|| "Pi 当前没有会话工作区。".to_string())?,
    };
    let work = work
        .canonicalize()
        .map_err(|_| "会话工作区不存在或已被删除。".to_string())?;
    if !work.starts_with(&root) {
        return Err("产物目录不在 Pi 工作区根目录内，已拒绝读取。".to_string());
    }
    if !work.is_dir() {
        return Err("产物目录不可用。".to_string());
    }
    Ok(work)
}

fn read_head(path: &Path) -> Option<Vec<u8>> {
    let mut buffer = [0u8; SNIFF_BYTES];
    let mut file = std::fs::File::open(path).ok()?;
    let read = file.read(&mut buffer).ok()?;
    Some(buffer[..read].to_vec())
}

/// 按文件头判断真实格式。这里只覆盖「扩展名可能被谎报」的高风险容器，
/// 文本类没有可靠魔数，保持 `None`。
fn sniff_magic(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("png");
    }
    if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("jpeg");
    }
    if head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a") {
        return Some("gif");
    }
    if head.len() >= 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        return Some("webp");
    }
    if head.starts_with(b"BM") {
        return Some("bmp");
    }
    if head.starts_with(&[0x49, 0x49, 0x2A, 0x00]) || head.starts_with(&[0x4D, 0x4D, 0x00, 0x2A]) {
        return Some("tiff");
    }
    if head.starts_with(b"%PDF-") {
        return Some("pdf");
    }
    // docx / xlsx / pptx / odt 等都是 ZIP 容器。
    if head.starts_with(&[0x50, 0x4B, 0x03, 0x04])
        || head.starts_with(&[0x50, 0x4B, 0x05, 0x06])
        || head.starts_with(&[0x50, 0x4B, 0x07, 0x08])
    {
        return Some("zip");
    }
    // 旧版 doc / xls / ppt 是 OLE 复合文档。
    if head.starts_with(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]) {
        return Some("cfb");
    }
    if head.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        return Some("ebml");
    }
    if head.len() >= 12 && &head[4..8] == b"ftyp" {
        return Some("ftyp");
    }
    if head.starts_with(b"OggS") {
        return Some("ogg");
    }
    if head.starts_with(b"fLaC") {
        return Some("flac");
    }
    if head.starts_with(b"ID3") || head.starts_with(&[0xFF, 0xFB]) {
        return Some("mp3");
    }
    if head.len() >= 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"WAVE" {
        return Some("wav");
    }
    if head.len() >= 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"AVI " {
        return Some("avi");
    }
    if head.starts_with(&[0x1F, 0x8B]) {
        return Some("gzip");
    }
    if head.starts_with(&[0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]) {
        return Some("7z");
    }
    if head.starts_with(b"Rar!") {
        return Some("rar");
    }
    // SVG 没有二进制魔数，只检查文本开头是否出现 <svg>。
    let text = String::from_utf8_lossy(&head[..head.len().min(512)]);
    let lower = text.trim_start_matches('\u{feff}').trim_start().to_ascii_lowercase();
    if lower.contains("<svg") {
        return Some("svg");
    }
    None
}

/// 扩展名 → 允许的魔数集合。返回 `None` 表示该类型没有可靠签名，不做强校验。
fn expected_magic(extension: &str) -> Option<&'static [&'static str]> {
    Some(match extension {
        "png" => &["png"],
        "jpg" | "jpeg" => &["jpeg"],
        "gif" => &["gif"],
        "webp" => &["webp"],
        "bmp" => &["bmp"],
        "tif" | "tiff" => &["tiff"],
        "svg" => &["svg"],
        "pdf" => &["pdf"],
        "zip" | "docx" | "docm" | "xlsx" | "xlsm" | "pptx" | "pptm" | "odt" | "ods" | "odp" => {
            &["zip"]
        }
        "doc" | "xls" | "ppt" => &["cfb"],
        "mp4" | "m4v" | "m4a" | "mov" => &["ftyp"],
        "webm" | "mkv" => &["ebml"],
        "ogg" | "oga" | "ogv" | "opus" => &["ogg"],
        "flac" => &["flac"],
        "mp3" => &["mp3"],
        "wav" => &["wav"],
        "avi" => &["avi"],
        "gz" | "tgz" => &["gzip"],
        "7z" => &["7z"],
        "rar" => &["rar"],
        _ => return None,
    })
}

fn extended_name(path: &Path) -> String {
    path.extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

/// 返回 (检测到的格式, 是否与扩展名匹配或无签名要求)。
fn inspect_magic(path: &Path) -> (Option<String>, bool) {
    let extension = extended_name(path);
    let detected = read_head(path).and_then(|head| sniff_magic(&head));
    match expected_magic(&extension) {
        None => (detected.map(str::to_string), true),
        Some(allowed) => {
            let ok = detected
                .map(|magic| allowed.contains(&magic))
                .unwrap_or(false);
            (detected.map(str::to_string), ok)
        }
    }
}

/// 在会话工作区内按文件名/相对路径递归查找产物；重名取最新修改的一份并标记。
pub fn resolve_artifacts(names: &[String], work_dir: Option<&str>) -> Result<Vec<PiResolvedArtifact>, String> {
    let root = allowed_work_dir(work_dir)?;
    Ok(resolve_artifacts_in(&root, names))
}

fn resolve_artifacts_in(root: &Path, names: &[String]) -> Vec<PiResolvedArtifact> {
    let targets: Vec<(String, String, String)> = names
        .iter()
        .map(|name| {
            let original = name.trim().to_string();
            let normalized = original.replace('\\', "/").to_lowercase();
            let base = normalized.rsplit('/').next().unwrap_or("").to_string();
            (original, normalized, base)
        })
        .collect();
    if targets.is_empty() {
        return Vec::new();
    }

    let mut hits: Vec<Vec<(u64, u64, String)>> = vec![Vec::new(); targets.len()];
    let mut seen_entries = 0usize;
    for entry in WalkDir::new(root)
        .max_depth(ARTIFACT_MAX_DEPTH)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        seen_entries += 1;
        if seen_entries > ARTIFACT_MAX_ENTRIES {
            break;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let rel_path = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        let rel_lower = rel_path.to_lowercase();
        let file_name = entry.file_name().to_string_lossy().to_lowercase();
        let meta = entry.metadata().ok();
        let size = meta.as_ref().map(|meta| meta.len()).unwrap_or(0);
        let mtime = meta
            .as_ref()
            .and_then(|meta| meta.modified().ok())
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs())
            .unwrap_or(0);
        for (index, (_, normalized, base)) in targets.iter().enumerate() {
            if normalized.is_empty() {
                continue;
            }
            if file_name == *base || file_name == *normalized || rel_lower == *normalized {
                hits[index].push((mtime, size, rel_path.clone()));
            }
        }
    }

    targets
        .into_iter()
        .enumerate()
        .map(|(index, (name, _, _))| {
            let mut candidates = hits[index].clone();
            candidates.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.2.cmp(&b.2)));
            let duplicate = candidates.len() > 1;
            match candidates.first() {
                Some((mtime, size, rel_path)) => {
                    let (magic, magic_ok) = inspect_magic(&root.join(rel_path));
                    PiResolvedArtifact {
                        name,
                        rel_path: rel_path.clone(),
                        size: *size,
                        mtime: *mtime,
                        exists: true,
                        duplicate,
                        magic,
                        magic_ok,
                    }
                }
                None => PiResolvedArtifact {
                    name,
                    rel_path: String::new(),
                    size: 0,
                    mtime: 0,
                    exists: false,
                    duplicate: false,
                    magic: None,
                    magic_ok: true,
                },
            }
        })
        .collect()
}

fn artifact_image_mime(path: &Path) -> Option<String> {
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if extension == "svg" {
        return Some("image/svg+xml".to_string());
    }
    crate::commands::system::infer_media_mime(path).filter(|mime| mime.starts_with("image/"))
}

fn is_text_artifact(path: &Path) -> bool {
    const EXTS: &[&str] = &[
        "txt", "md", "markdown", "json", "jsonl", "csv", "tsv", "log", "xml", "html", "htm",
        "css", "js", "jsx", "mjs", "cjs", "ts", "tsx", "py", "rs", "go", "java", "c", "cpp",
        "h", "hpp", "cs", "php", "rb", "swift", "kt", "kts", "sql", "toml", "yaml", "yml",
        "ini", "env", "bat", "cmd", "ps1", "sh", "mm", "mmd", "mermaid",
    ];
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| EXTS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// 读取会话工作区内的单个产物：图片转 data URL，文本回正文，其余类型拒绝。
pub fn read_artifact(rel_path: &str, work_dir: Option<&str>) -> Result<PiArtifactPayload, String> {
    let root = allowed_work_dir(work_dir)?;
    read_artifact_in(&root, rel_path)
}

fn read_artifact_in(root: &Path, rel_path: &str) -> Result<PiArtifactPayload, String> {
    let target = root
        .join(rel_path)
        .canonicalize()
        .map_err(|_| "文件已不存在。".to_string())?;
    if !target.starts_with(root) {
        return Err("产物路径不在会话工作区内，已拒绝读取。".to_string());
    }
    let meta = std::fs::metadata(&target).map_err(|error| format!("无法读取文件信息：{error}"))?;
    if !meta.is_file() {
        return Err("产物不是文件。".to_string());
    }
    let size = meta.len();
    let extension = extended_name(&target);

    // PDF 先按文件头确认，避免把「扩展名是 .pdf、内容其实是 Markdown」的假产物
    // 当成 PDF 塞进预览器；前端产物门也会用同一份判定拦一次。
    if extension == "pdf" {
        if size > ARTIFACT_PDF_LIMIT {
            return Err(format!(
                "PDF 过大（{:.1}MB），预览上限为 {}MB。",
                size as f64 / 1024.0 / 1024.0,
                ARTIFACT_PDF_LIMIT / 1024 / 1024
            ));
        }
        let (magic, _) = inspect_magic(&target);
        if magic.as_deref() != Some("pdf") {
            return Err(format!(
                "文件扩展名是 PDF，但文件头不是 %PDF-（检测到 {}），可能已损坏或类型不符。",
                magic.as_deref().unwrap_or("未知格式")
            ));
        }
        let bytes = std::fs::read(&target).map_err(|error| format!("读取 PDF 失败：{error}"))?;
        let encoded = crate::commands::system::base64_encode(&bytes);
        return Ok(PiArtifactPayload {
            kind: "pdf".to_string(),
            mime_type: "application/pdf".to_string(),
            size,
            data_url: Some(format!("data:application/pdf;base64,{encoded}")),
            text: None,
        });
    }

    if let Some(mime) = artifact_image_mime(&target) {
        if size > ARTIFACT_IMAGE_LIMIT {
            return Err(format!(
                "图片过大（{:.1}MB），预览上限为 {}MB。",
                size as f64 / 1024.0 / 1024.0,
                ARTIFACT_IMAGE_LIMIT / 1024 / 1024
            ));
        }
        let (magic, magic_ok) = inspect_magic(&target);
        if !magic_ok {
            return Err(format!(
                "图片文件头与扩展名不符（检测到 {}），可能已损坏或并非图片。",
                magic.as_deref().unwrap_or("未知格式")
            ));
        }
        let bytes = std::fs::read(&target).map_err(|error| format!("读取图片失败：{error}"))?;
        let encoded = crate::commands::system::base64_encode(&bytes);
        return Ok(PiArtifactPayload {
            kind: "image".to_string(),
            mime_type: mime.clone(),
            size,
            data_url: Some(format!("data:{mime};base64,{encoded}")),
            text: None,
        });
    }

    if is_text_artifact(&target) {
        if size > ARTIFACT_TEXT_LIMIT {
            return Err(format!(
                "文本过大（{:.1}MB），预览上限为 {}MB。",
                size as f64 / 1024.0 / 1024.0,
                ARTIFACT_TEXT_LIMIT / 1024 / 1024
            ));
        }
        let bytes = std::fs::read(&target).map_err(|error| format!("读取文本失败：{error}"))?;
        return Ok(PiArtifactPayload {
            kind: "text".to_string(),
            mime_type: "text/plain; charset=utf-8".to_string(),
            size,
            data_url: None,
            text: Some(String::from_utf8_lossy(&bytes).to_string()),
        });
    }

    Err("该文件类型暂不支持预览，请打开所在位置查看。".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pi-artifacts-test-{}-{}-{}",
            std::process::id(),
            tag,
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn rejects_path_outside_work_dir() {
        let root = temp_dir("outside");
        let work = root.join("session");
        std::fs::create_dir_all(&work).unwrap();
        let outside = root.join("secret.txt");
        std::fs::write(&outside, "secret").unwrap();
        let result = read_artifact_in(&work, "../secret.txt");
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolves_file_by_name() {
        let root = temp_dir("resolve");
        let work = root.join("session");
        std::fs::create_dir_all(work.join("out")).unwrap();
        std::fs::write(work.join("out").join("report.md"), "hello").unwrap();
        let resolved = resolve_artifacts_in(&work, &["report.md".to_string()]);
        assert_eq!(resolved.len(), 1);
        assert!(resolved[0].exists);
        assert_eq!(resolved[0].rel_path, "out/report.md");
        // 文本类没有可靠魔数，不因为嗅探不出格式就判失败。
        assert!(resolved[0].magic_ok);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn sniffs_known_container_magic() {
        assert_eq!(sniff_magic(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]), Some("png"));
        assert_eq!(sniff_magic(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("jpeg"));
        assert_eq!(sniff_magic(b"%PDF-1.7\n"), Some("pdf"));
        assert_eq!(sniff_magic(&[0x50, 0x4B, 0x03, 0x04]), Some("zip"));
        assert_eq!(sniff_magic(b"<svg xmlns=\"http://www.w3.org/2000/svg\">"), Some("svg"));
        assert_eq!(sniff_magic(b"# markdown report"), None);
    }

    #[test]
    fn flags_extension_magic_mismatch() {
        let root = temp_dir("magic");
        // 正确 PDF：扩展名与文件头一致。
        std::fs::write(root.join("real.pdf"), b"%PDF-1.7\n%%EOF").unwrap();
        // 谎报类型：把 Markdown 当成 PDF 交付。
        std::fs::write(root.join("fake.pdf"), b"# not a pdf\n").unwrap();
        let resolved = resolve_artifacts_in(
            &root,
            &["real.pdf".to_string(), "fake.pdf".to_string()],
        );
        assert!(resolved[0].magic_ok);
        assert_eq!(resolved[0].magic.as_deref(), Some("pdf"));
        assert!(!resolved[1].magic_ok);
        assert_eq!(resolved[1].magic, None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn reads_pdf_as_data_url_and_rejects_fake_pdf() {
        let root = temp_dir("pdf-read").canonicalize().expect("canonical temp dir");
        std::fs::write(root.join("real.pdf"), b"%PDF-1.7\n%%EOF").unwrap();
        std::fs::write(root.join("fake.pdf"), b"# not a pdf\n").unwrap();

        let payload = read_artifact_in(&root, "real.pdf").expect("real pdf should read");
        assert_eq!(payload.kind, "pdf");
        assert_eq!(payload.mime_type, "application/pdf");
        assert!(payload.data_url.unwrap_or_default().starts_with("data:application/pdf;base64,"));

        let error = read_artifact_in(&root, "fake.pdf").expect_err("fake pdf must be rejected");
        assert!(error.contains("%PDF-"), "{error}");
        let _ = std::fs::remove_dir_all(&root);
    }
}
