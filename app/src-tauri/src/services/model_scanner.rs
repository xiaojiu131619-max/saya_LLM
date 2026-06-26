use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use anyhow::Result;
use once_cell::sync::Lazy;
use rayon::prelude::*;
use regex::Regex;
use walkdir::WalkDir;

use crate::models::model_info::ModelInfo;
use crate::services::gguf_parser::parse_gguf_header;

static RE_PARAM: Lazy<Regex> = Lazy::new(|| Regex::new(r"(\d+(?:\.\d+)?)\s*[bB]").unwrap());

static RE_QUANT: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(Q[0-9]_[A-Z0-9_]+|IQ[0-9]_[A-Z0-9_]+|BF16|F16|F32|AWQ)").unwrap());

pub struct ModelScanner {
    dirs: Vec<PathBuf>,
}

fn get_cache_dir() -> PathBuf {
    let dir = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("AgentLLM")
        .join("cache");
    std::fs::create_dir_all(&dir).ok();
    dir
}

pub fn get_cache_dir_clone() -> PathBuf {
    get_cache_dir()
}

fn cache_path(file_path: &Path) -> PathBuf {
    let sanitized = file_path
        .to_string_lossy()
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>();
    get_cache_dir().join(format!("{}.json", sanitized))
}

const SCANNER_VERSION: u32 = 8;

fn load_cache(cache: &Path, expected_mtime: u64, expected_size: u64) -> Option<ModelInfo> {
    let content = std::fs::read_to_string(cache).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&content).ok()?;
    if parsed["ver"].as_u64() != Some(SCANNER_VERSION as u64) {
        return None;
    }
    if parsed["mtime"].as_u64() != Some(expected_mtime) {
        return None;
    }
    if parsed["size"].as_u64() != Some(expected_size) {
        return None;
    }
    serde_json::from_value(parsed["info"].clone()).ok()
}

fn save_cache(cache: &Path, mtime: u64, size: u64, info: &ModelInfo) {
    let data =
        serde_json::json!({ "ver": SCANNER_VERSION, "mtime": mtime, "size": size, "info": info });
    if let Ok(json) = serde_json::to_string_pretty(&data) {
        std::fs::write(cache, json).ok();
    }
}

fn cleanup_stale_caches(known_paths: &[PathBuf]) {
    let cache_dir = get_cache_dir();
    let known: Vec<String> = known_paths
        .iter()
        .map(|p| cache_path(p).to_string_lossy().to_string())
        .collect();
    if let Ok(entries) = std::fs::read_dir(&cache_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map(|e| e == "json").unwrap_or(false)
                && !known.contains(&path.to_string_lossy().to_string())
            {
                std::fs::remove_file(&path).ok();
            }
        }
    }
}

/// Walk all model directories and collect paths to .gguf files (excluding mmproj).
fn collect_gguf_paths(dirs: &[PathBuf]) -> Vec<PathBuf> {
    let mut gguf_paths = Vec::new();
    for dir in dirs {
        if !dir.exists() {
            continue;
        }
        for entry in WalkDir::new(dir).into_iter().filter_map(|e| e.ok()) {
            let path = entry.path().to_path_buf();
            if path.extension().map(|ext| ext == "gguf").unwrap_or(false) {
                let name = path
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                let lower = name.to_ascii_lowercase();
                if lower.starts_with("mmproj") || lower.starts_with("mtp") {
                    continue;
                }
                gguf_paths.push(path);
            }
        }
    }
    gguf_paths
}

/// Return (mtime_secs, size) for a file, or None on error.
fn file_meta(path: &Path) -> Option<(u64, u64)> {
    let meta = path.metadata().ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Some((mtime, meta.len()))
}

impl ModelScanner {
    pub fn new(dirs: Vec<PathBuf>) -> Self {
        Self { dirs }
    }

    pub fn scan(&self) -> Result<Vec<ModelInfo>> {
        let t0 = std::time::Instant::now();
        let gguf_paths = collect_gguf_paths(&self.dirs);
        let t_walk = t0.elapsed();
        eprintln!("[perf] walkdir: {:?} ({} files)", t_walk, gguf_paths.len());

        let t_parse = std::time::Instant::now();
        let models: Vec<ModelInfo> = gguf_paths
            .par_iter()
            .filter_map(|p| {
                let (mtime, size) = file_meta(p)?;
                let cache_p = cache_path(p);

                if cache_p.exists() {
                    if let Some(info) = load_cache(&cache_p, mtime, size) {
                        return Some(info);
                    }
                }

                let t = std::time::Instant::now();
                let info = parse_model_info_from_path(p)?;
                let elapsed = t.elapsed();
                if elapsed.as_secs_f64() > 0.1 {
                    eprintln!(
                        "[perf] parse {} took {:?}",
                        p.file_name().unwrap_or_default().to_string_lossy(),
                        elapsed
                    );
                }
                save_cache(&cache_p, mtime, size, &info);
                Some(info)
            })
            .collect();
        eprintln!("[perf] parse+cache phase: {:?}", t_parse.elapsed());

        cleanup_stale_caches(&gguf_paths);
        eprintln!("[perf] scan total: {:?}", t0.elapsed());
        Ok(models)
    }

    pub fn scan_cache_only(&self) -> Result<Vec<ModelInfo>> {
        let t0 = std::time::Instant::now();
        let gguf_paths = collect_gguf_paths(&self.dirs);

        let models: Vec<ModelInfo> = gguf_paths
            .par_iter()
            .filter_map(|p| {
                let (mtime, size) = file_meta(p)?;
                let cache_p = cache_path(p);
                if cache_p.exists() {
                    load_cache(&cache_p, mtime, size)
                } else {
                    None
                }
            })
            .collect();

        eprintln!(
            "[perf] scan_cache_only: {:?} ({} cached of {} files)",
            t0.elapsed(),
            models.len(),
            gguf_paths.len()
        );
        Ok(models)
    }
}

fn parse_param_str(name: &str) -> Option<String> {
    RE_PARAM
        .captures(name)
        .map(|c| format!("{}B", c.get(1).unwrap().as_str()))
}

fn parse_quantization(name: &str) -> Option<String> {
    RE_QUANT
        .captures(name)
        .map(|c| c.get(1).unwrap().as_str().to_string())
}

fn is_moe(name: &str) -> bool {
    name.contains("MoE") || name.contains("moe") || name.contains("A3B") || name.contains("A4B")
}

fn detect_reasoning_support(name: &str, architecture: Option<&str>) -> bool {
    let name_lower = name.to_lowercase();

    // Explicit reasoning/thinking models
    if name_lower.contains("deepseek-r1")
        || name_lower.contains("deepseek_r1")
        || name_lower.contains("r1-")
        || name_lower.contains("-r1-")
        || name_lower.contains("thinking")
        || name_lower.contains("think")
        || name_lower.contains("qwq")
    {
        return true;
    }

    // Qwen3+ models natively support /think mode
    if name_lower.contains("qwen3") || name_lower.contains("qwen-3") {
        return true;
    }

    // Architecture-based detection
    if let Some(arch) = architecture {
        let arch_lower = arch.to_lowercase();
        if arch_lower == "deepseek2" || arch_lower == "deepseek3" {
            // DeepSeek v2/v3 architecture with R1 in name
            if name_lower.contains("r1") {
                return true;
            }
        }
    }

    false
}

fn tokenize_name(value: &str) -> Vec<String> {
    value
        .to_ascii_lowercase()
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|token| {
            token.len() >= 3
                && !matches!(
                    *token,
                    "gguf" | "mmproj" | "mtp" | "the" | "and" | "for" | "q4" | "bf16" | "f16"
                )
        })
        .map(ToString::to_string)
        .collect()
}

fn path_stem_lower(path: &Path) -> String {
    path.file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase()
}

fn candidate_score(model_stem: &str, candidate: &Path, prefix_bonus: u32) -> u32 {
    let candidate_stem = path_stem_lower(candidate);
    let model_tokens = tokenize_name(model_stem);
    let candidate_tokens = tokenize_name(&candidate_stem);
    let overlap = model_tokens
        .iter()
        .filter(|token| candidate_tokens.contains(token))
        .count() as u32;
    let substring_bonus = if candidate_stem.contains(model_stem) || model_stem.contains(&candidate_stem) {
        8
    } else {
        0
    };
    prefix_bonus + substring_bonus + overlap
}

fn find_companion_gguf(path: &Path, name: &str, kind: &str) -> Option<String> {
    let dir = path.parent()?;
    let model_stem = name.to_ascii_lowercase();
    let mut best: Option<(u32, PathBuf)> = None;

    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let candidate = entry.path();
        if !candidate
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("gguf"))
        {
            continue;
        }
        if candidate == path {
            continue;
        }

        let stem = path_stem_lower(&candidate);
        let is_match = match kind {
            "mmproj" => stem.starts_with("mmproj") || stem.contains("mmproj"),
            "mtp" => stem.starts_with("mtp") || stem.contains("-mtp") || stem.contains("_mtp"),
            _ => false,
        };
        if !is_match {
            continue;
        }

        let prefix_bonus = if stem.starts_with(kind) { 10 } else { 0 };
        let score = candidate_score(&model_stem, &candidate, prefix_bonus);
        if score == 0 {
            continue;
        }
        if best.as_ref().is_none_or(|(best_score, _)| score > *best_score) {
            best = Some((score, candidate));
        }
    }

    best.map(|(_, path)| path.to_string_lossy().to_string())
}

pub fn parse_model_info_from_path(path: &Path) -> Option<ModelInfo> {
    let metadata = path.metadata().ok()?;
    let file_size = metadata.len() as f64 / 1024.0 / 1024.0 / 1024.0;
    let file_name = path.file_name()?.to_string_lossy().to_string();
    let name = path.file_stem()?.to_string_lossy().to_string();

    let lower_name = name.to_ascii_lowercase();
    if lower_name.starts_with("mmproj") || lower_name.starts_with("mtp") {
        return None;
    }

    let gguf = parse_gguf_header(path).ok();

    let is_moe_model = gguf
        .as_ref()
        .map(|g| g.expert_count.unwrap_or(0) > 1)
        .unwrap_or_else(|| is_moe(&name));

    let params = gguf
        .as_ref()
        .and_then(|g| g.size_label.clone())
        .or_else(|| gguf.as_ref().and_then(|g| g.name.clone()))
        .or_else(|| parse_param_str(&name));

    let quantization = parse_quantization(&file_name).or_else(|| {
        gguf.as_ref()
            .and_then(|g| g.quantization_version.map(|v| format!("v{}", v)))
    });

    let block_count = gguf.as_ref().map(|g| g.block_count).filter(|&c| c > 0);
    let context_length = gguf.as_ref().map(|g| g.context_length).filter(|&c| c > 0);
    let embedding_length = gguf.as_ref().map(|g| g.embedding_length).filter(|&c| c > 0);

    let supports_reasoning =
        detect_reasoning_support(&name, gguf.as_ref().map(|g| g.architecture.as_str()));
    let mmproj_path = find_companion_gguf(path, &name, "mmproj");
    let mtp_draft_path = find_companion_gguf(path, &name, "mtp");

    Some(ModelInfo {
        name,
        file_name,
        file_path: path.to_string_lossy().to_string(),
        file_size_gb: (file_size * 100.0).round() / 100.0,
        architecture: gguf.as_ref().map(|g| g.architecture.clone()),
        params,
        quantization,
        is_moe: is_moe_model,
        expert_count: gguf.as_ref().and_then(|g| g.expert_count),
        context_length,
        block_count,
        embedding_length,
        head_count: gguf.as_ref().and_then(|g| g.head_count),
        head_count_kv: gguf.as_ref().and_then(|g| g.head_count_kv),
        key_length: gguf.as_ref().and_then(|g| g.key_length),
        value_length: gguf.as_ref().and_then(|g| g.value_length),
        mtp_support: gguf.as_ref().map(|g| g.mtp_support).unwrap_or(false) || mtp_draft_path.is_some(),
        mmproj_path,
        mtp_draft_path,
        supports_reasoning,
        gguf_metadata: gguf
            .as_ref()
            .map(|g| g.metadata_entries.clone())
            .unwrap_or_default(),
    })
}
