use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::models::app_state::AppState;
use crate::models::model_info::ModelInfo;
use crate::services::model_scanner::{parse_model_info_from_path, ModelScanner};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDownloadRequest {
    pub url: String,
    pub file_name: Option<String>,
    pub target_dir: String,
}

#[derive(Debug, Serialize)]
pub struct DownloadedModelFile {
    pub path: String,
    pub file_name: String,
    pub size_bytes: u64,
}

#[tauri::command]
pub fn scan_models(state: State<'_, AppState>) -> Result<Vec<ModelInfo>, String> {
    let start = Instant::now();
    let dirs = state
        .config
        .lock()
        .map_err(|e| e.to_string())?
        .model_dirs
        .clone();
    let result = ModelScanner::new(dirs).scan().map_err(|e| e.to_string());
    eprintln!("[scan] scan_models took {:?}", start.elapsed());
    result
}

#[tauri::command]
pub fn scan_fast(state: State<'_, AppState>) -> Result<Vec<ModelInfo>, String> {
    let start = Instant::now();
    let dirs = state
        .config
        .lock()
        .map_err(|e| e.to_string())?
        .model_dirs
        .clone();
    let result = ModelScanner::new(dirs)
        .scan_cache_only()
        .map_err(|e| e.to_string());
    eprintln!("[perf] scan_fast took {:?}", start.elapsed());
    result
}

#[tauri::command]
pub fn clear_model_cache(_state: State<'_, AppState>) -> Result<String, String> {
    let dir = crate::services::model_scanner::get_cache_dir_clone();
    let count = std::fs::read_dir(&dir)
        .map(|entries| entries.count())
        .unwrap_or(0);
    std::fs::remove_dir_all(&dir).ok();
    std::fs::create_dir_all(&dir).ok();
    Ok(format!("已清除 {} 个缓存文件", count))
}

/// Build a full ModelInfo for a single .gguf file path. Used by the drag-and-drop
/// "drop a gguf to load it" flow, where the file may live outside any configured
/// model directory (so it won't show up in scan_models).
#[tauri::command]
pub fn load_model_from_path(path: String) -> Result<ModelInfo, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err("文件不存在".to_string());
    }
    let is_gguf = p
        .extension()
        .map(|e| e.eq_ignore_ascii_case("gguf"))
        .unwrap_or(false);
    if !is_gguf {
        return Err("不是有效的 .gguf 模型文件".to_string());
    }
    parse_model_info_from_path(p).ok_or_else(|| "无法解析模型文件".to_string())
}

#[tauri::command]
pub async fn download_model_file(
    app: AppHandle,
    request: ModelDownloadRequest,
) -> Result<DownloadedModelFile, String> {
    tokio::task::spawn_blocking(move || download_model_file_blocking(app, request))
        .await
        .map_err(|e| e.to_string())?
}

fn download_model_file_blocking(
    app: AppHandle,
    request: ModelDownloadRequest,
) -> Result<DownloadedModelFile, String> {
    let url = reqwest::Url::parse(request.url.trim())
        .map_err(|_| "下载链接格式不正确".to_string())?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err("下载链接必须是 http 或 https".to_string());
    }

    let target_dir = PathBuf::from(request.target_dir.trim());
    if target_dir.as_os_str().is_empty() {
        return Err("请选择模型保存目录".to_string());
    }
    std::fs::create_dir_all(&target_dir)
        .map_err(|e| format!("无法创建模型目录: {}", e))?;
    if !target_dir.is_dir() {
        return Err("模型保存目录无效".to_string());
    }

    let file_name = resolve_download_file_name(&url, request.file_name.as_deref())?;
    let target_path = unique_target_path(&target_dir, &file_name);
    let part_path = part_path_for(&target_path)?;
    if part_path.exists() {
        std::fs::remove_file(&part_path).ok();
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(60 * 60 * 6))
        .user_agent("Agent_LLM/0.1 model downloader")
        .build()
        .map_err(|e| e.to_string())?;

    emit_download_progress(
        &app,
        "starting",
        &file_name,
        0,
        None,
        "正在连接模型下载源...",
    );

    let mut resp = client
        .get(url)
        .send()
        .map_err(|e| format!("连接下载源失败: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("下载源返回 HTTP {}", resp.status()));
    }

    let total = resp.content_length();
    let mut file = File::create(&part_path).map_err(|e| format!("无法写入模型文件: {}", e))?;
    let mut buffer = [0u8; 1024 * 256];
    let mut downloaded = 0u64;
    let mut last_emit = Instant::now();

    loop {
        let n = match resp.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => n,
            Err(error) => {
                std::fs::remove_file(&part_path).ok();
                return Err(format!("下载中断: {}", error));
            }
        };
        if let Err(error) = file.write_all(&buffer[..n]) {
            std::fs::remove_file(&part_path).ok();
            return Err(format!("写入模型文件失败: {}", error));
        }
        downloaded += n as u64;

        if last_emit.elapsed().as_millis() >= 180 {
            let message = match total {
                Some(total_bytes) if total_bytes > 0 => format!(
                    "正在下载 {:.1} / {:.1} GB",
                    downloaded as f64 / 1024.0 / 1024.0 / 1024.0,
                    total_bytes as f64 / 1024.0 / 1024.0 / 1024.0
                ),
                _ => format!(
                    "正在下载 {:.1} GB",
                    downloaded as f64 / 1024.0 / 1024.0 / 1024.0
                ),
            };
            emit_download_progress(&app, "downloading", &file_name, downloaded, total, &message);
            last_emit = Instant::now();
        }
    }

    file.flush().map_err(|e| format!("保存模型文件失败: {}", e))?;
    drop(file);

    std::fs::rename(&part_path, &target_path).map_err(|error| {
        std::fs::remove_file(&part_path).ok();
        format!("完成下载但移动模型文件失败: {}", error)
    })?;

    emit_download_progress(
        &app,
        "finished",
        &file_name,
        downloaded,
        total,
        "模型下载完成",
    );

    Ok(DownloadedModelFile {
        path: target_path.to_string_lossy().to_string(),
        file_name,
        size_bytes: downloaded,
    })
}

fn resolve_download_file_name(url: &reqwest::Url, explicit: Option<&str>) -> Result<String, String> {
    let raw_name = explicit
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            url.path_segments()
                .and_then(|segments| segments.filter(|part| !part.is_empty()).last())
                .map(|part| part.to_string())
        })
        .ok_or_else(|| "无法从链接中识别模型文件名".to_string())?;

    let decoded = raw_name.replace("%20", " ");
    let sanitized = sanitize_file_name(&decoded);
    if sanitized.is_empty() {
        return Err("模型文件名不能为空".to_string());
    }
    if !sanitized.to_lowercase().ends_with(".gguf") {
        return Err("只支持下载 .gguf 模型文件".to_string());
    }
    Ok(sanitized)
}

fn sanitize_file_name(name: &str) -> String {
    name.chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            ch if ch.is_control() => '_',
            ch => ch,
        })
        .collect::<String>()
        .trim_matches(['.', ' '])
        .to_string()
}

fn unique_target_path(target_dir: &Path, file_name: &str) -> PathBuf {
    let candidate = target_dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }

    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("model");
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{}", value))
        .unwrap_or_default();

    for index in 1..=999 {
        let next = target_dir.join(format!("{}-{}{}", stem, index, ext));
        if !next.exists() {
            return next;
        }
    }

    target_dir.join(format!("{}-{}{}", stem, chrono::Utc::now().timestamp(), ext))
}

fn part_path_for(target_path: &Path) -> Result<PathBuf, String> {
    let file_name = target_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "模型保存路径无效".to_string())?;
    Ok(target_path.with_file_name(format!("{}.part", file_name)))
}

fn emit_download_progress(
    app: &AppHandle,
    status: &str,
    file_name: &str,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    message: &str,
) {
    let percent = total_bytes
        .filter(|total| *total > 0)
        .map(|total| (downloaded_bytes as f64 / total as f64 * 100.0).min(100.0));
    app.emit(
        "model-download:progress",
        serde_json::json!({
            "status": status,
            "fileName": file_name,
            "downloadedBytes": downloaded_bytes,
            "totalBytes": total_bytes,
            "percent": percent,
            "message": message,
        }),
    )
    .ok();
}
