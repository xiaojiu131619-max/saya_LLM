use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use anyhow::Result;
use once_cell::sync::Lazy;
use rayon::prelude::*;
use regex::Regex;
use walkdir::WalkDir;

use crate::models::model_info::{ModelInfo, VideoSupportLevel};
use crate::services::gguf_parser::{parse_gguf_header, GgufMetadata};

static RE_PARAM: Lazy<Regex> = Lazy::new(|| Regex::new(r"(\d+(?:\.\d+)?)\s*[bB]").unwrap());

static RE_QUANT: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(Q[0-9]_[A-Z0-9_]+|IQ[0-9]_[A-Z0-9_]+|BF16|F16|F32|AWQ)").unwrap());
static RE_SPLIT_GGUF: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)-(\d{5})-of-(\d{5})\.gguf$").unwrap());

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
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    file_path.to_string_lossy().hash(&mut hasher);
    let hash = hasher.finish();
    get_cache_dir().join(format!("{:016x}.json", hash))
}

const SCANNER_VERSION: u32 = 16;

fn infer_video_support(
    name: &str,
    tags: &[String],
    mmproj: Option<&GgufMetadata>,
) -> VideoSupportLevel {
    let Some(mmproj) = mmproj else {
        return VideoSupportLevel::None;
    };
    if !mmproj.mmproj_supports_vision {
        return VideoSupportLevel::None;
    }

    let projector = mmproj
        .mmproj_vision_projector_type
        .as_deref()
        .or(mmproj.mmproj_projector_type.as_deref())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let name_mentions_video = name
        .to_ascii_lowercase()
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .any(|part| part == "video");
    let tags_mention_video = tags.iter().any(|tag| {
        matches!(
            tag.as_str(),
            "video" | "video-to-text" | "video-text-to-text" | "video-understanding"
        )
    });

    // Nemotron v2 VL 是当前项目已实测通过的视频模型；显式 video 名称/标签同样视为强证据。
    if projector == "nemotron_v2_vl" || name_mentions_video || tags_mention_video {
        return VideoSupportLevel::Verified;
    }

    // llama.cpp 对 Qwen VL projector 有专用的 temporal merge，但能否工作仍取决于
    // ffmpeg/ffprobe、主模型训练及 chat template，因此只标记为候选。
    if matches!(
        projector.as_str(),
        "qwen2vl_merger" | "qwen2.5vl_merger" | "qwen25vl_merger" | "qwen3vl_merger"
    ) {
        return VideoSupportLevel::Candidate;
    }

    VideoSupportLevel::Frames
}

fn is_companion_gguf_stem(lower_stem: &str) -> bool {
    lower_stem.starts_with("mmproj")
        || lower_stem.contains("mmproj")
        || lower_stem.starts_with("mtp")
}

fn split_gguf_info(path: &Path) -> Option<(u32, u32)> {
    let name = path.file_name()?.to_string_lossy();
    let caps = RE_SPLIT_GGUF.captures(&name)?;
    let part = caps.get(1)?.as_str().parse::<u32>().ok()?;
    let count = caps.get(2)?.as_str().parse::<u32>().ok()?;
    Some((part, count))
}

fn split_gguf_prefix(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_string_lossy();
    let matched = RE_SPLIT_GGUF.find(&name)?;
    Some(name[..matched.start()].to_string())
}

fn split_total_size(path: &Path, count: u32) -> Option<u64> {
    let parent = path.parent()?;
    let prefix = split_gguf_prefix(path)?;
    let mut total = 0u64;
    for part in 1..=count {
        let candidate = parent.join(format!("{}-{:05}-of-{:05}.gguf", prefix, part, count));
        total = total.checked_add(candidate.metadata().ok()?.len())?;
    }
    Some(total)
}

fn load_cache(
    cache: &Path,
    expected_mtime: u64,
    expected_size: u64,
    expected_companions: u64,
) -> Option<ModelInfo> {
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
    if parsed["companions"].as_u64() != Some(expected_companions) {
        return None;
    }
    serde_json::from_value(parsed["info"].clone()).ok()
}

fn save_cache(cache: &Path, mtime: u64, size: u64, companions: u64, info: &ModelInfo) {
    let data = serde_json::json!({
        "ver": SCANNER_VERSION,
        "mtime": mtime,
        "size": size,
        "companions": companions,
        "info": info
    });
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
            if path.extension().map(|ext| ext.eq_ignore_ascii_case("gguf")).unwrap_or(false) {
                if let Some((part, _count)) = split_gguf_info(&path) {
                    if part != 1 {
                        continue;
                    }
                }
                let name = path
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                let lower = name.to_ascii_lowercase();
                if is_companion_gguf_stem(&lower) {
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

/// Include all sibling GGUF changes in the cache key. Official MTP heads are
/// usually prefixed with `mtp-`, but Gemma 4 Assistant heads can use a regular
/// model filename and are identified from their GGUF architecture metadata.
fn companion_signature(model_path: &Path) -> u64 {
    let Some(parent) = model_path.parent() else {
        return 0;
    };
    let Ok(entries) = std::fs::read_dir(parent) else {
        return 0;
    };

    let mut companions = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path != model_path)
        .filter(|path| {
            path.extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("gguf"))
        })
        .collect::<Vec<_>>();
    companions.sort();

    let mut hasher = DefaultHasher::new();
    for path in companions {
        path.file_name().hash(&mut hasher);
        if let Some((mtime, size)) = file_meta(&path) {
            mtime.hash(&mut hasher);
            size.hash(&mut hasher);
        }
    }
    hasher.finish()
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
                let companions = companion_signature(p);
                let cache_p = cache_path(p);

                if cache_p.exists() {
                    if let Some(info) = load_cache(&cache_p, mtime, size, companions) {
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
                save_cache(&cache_p, mtime, size, companions, &info);
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
                let companions = companion_signature(p);
                let cache_p = cache_path(p);
                if cache_p.exists() {
                    load_cache(&cache_p, mtime, size, companions)
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
    let substring_bonus =
        if candidate_stem.contains(model_stem) || model_stem.contains(&candidate_stem) {
            8
        } else {
            0
        };
    prefix_bonus + substring_bonus + overlap
}

fn optional_values_match<T: PartialEq>(left: Option<T>, right: Option<T>) -> bool {
    match left.zip(right) {
        Some((left, right)) => left == right,
        None => true,
    }
}

pub(crate) fn mtp_draft_is_compatible(main: &GgufMetadata, draft: &GgufMetadata) -> bool {
    let gemma4_assistant =
        main.architecture == "gemma4" && draft.architecture == "gemma4-assistant";
    let same_architecture = main.architecture == draft.architecture;
    if !draft.is_mtp_draft_model
        || !main.mtp_architecture_supported
        || (!same_architecture && !gemma4_assistant)
    {
        return false;
    }
    if gemma4_assistant {
        if main.embedding_length == 0 || draft.embedding_length_out != Some(main.embedding_length) {
            return false;
        }
    } else if main.embedding_length > 0
        && draft.embedding_length > 0
        && main.embedding_length != draft.embedding_length
    {
        return false;
    }
    if !optional_values_match(main.vocab_size, draft.vocab_size)
        || !optional_values_match(main.tokenizer_bos_id, draft.tokenizer_bos_id)
        || !optional_values_match(main.tokenizer_eos_id, draft.tokenizer_eos_id)
        || !optional_values_match(main.tokenizer_pad_id, draft.tokenizer_pad_id)
        || !optional_values_match(main.tokenizer_add_bos, draft.tokenizer_add_bos)
        || !optional_values_match(main.tokenizer_add_eos, draft.tokenizer_add_eos)
        || !optional_values_match(main.tokenizer_tokens_hash, draft.tokenizer_tokens_hash)
    {
        return false;
    }
    if main
        .tokenizer_model
        .as_ref()
        .zip(draft.tokenizer_model.as_ref())
        .is_some_and(|(left, right)| left != right)
    {
        return false;
    }
    if main
        .tokenizer_pre
        .as_ref()
        .zip(draft.tokenizer_pre.as_ref())
        .is_some_and(|(left, right)| left != right)
    {
        return false;
    }

    if !gemma4_assistant && main.block_count > 0 && draft.block_count > 0 {
        let expected_split_block_count =
            main.block_count.saturating_add(draft.nextn_predict_layers);
        let same_as_bundled = draft.block_count == main.block_count;
        let split_head_matches =
            main.nextn_predict_layers == 0 && draft.block_count == expected_split_block_count;
        if !same_as_bundled && !split_head_matches {
            return false;
        }
    }
    true
}

fn find_companion_gguf(
    path: &Path,
    name: &str,
    kind: &str,
    target: Option<&GgufMetadata>,
) -> Option<(String, GgufMetadata)> {
    let dir = path.parent()?;
    let model_stem = name.to_ascii_lowercase();
    let mut best: Option<(u32, PathBuf, GgufMetadata)> = None;

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
        if split_gguf_info(&candidate).is_some_and(|(part, _)| part != 1) {
            continue;
        }

        let stem = path_stem_lower(&candidate);
        let is_match = match kind {
            "mmproj" => stem.starts_with("mmproj") || stem.contains("mmproj"),
            // llama.cpp's converter and sibling resolver both use an `mtp-` prefix.
            // Gemma 4 Assistant is a dedicated GGUF architecture and does not
            // require that prefix, so inspect all siblings for Gemma 4 targets.
            "mtp" => {
                stem.starts_with("mtp-")
                    || stem.starts_with("mtp_")
                    || target.is_some_and(|main| main.architecture == "gemma4")
            }
            _ => false,
        };
        if !is_match {
            continue;
        }

        let metadata = match parse_gguf_header(&candidate) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        let valid = match kind {
            "mmproj" => metadata.mmproj_supports_vision || metadata.mmproj_supports_audio,
            "mtp" => target.is_some_and(|main| mtp_draft_is_compatible(main, &metadata)),
            _ => false,
        };
        if !valid {
            continue;
        }

        let prefix_bonus = if stem.starts_with(kind) {
            10
        } else if kind == "mtp" && metadata.architecture == "gemma4-assistant" {
            5
        } else {
            0
        };
        let score = candidate_score(&model_stem, &candidate, prefix_bonus);
        if score == 0 {
            continue;
        }
        if best
            .as_ref()
            .map_or(true, |(best_score, _, _)| score > *best_score)
        {
            best = Some((score, candidate, metadata));
        }
    }

    best.map(|(_, path, metadata)| (path.to_string_lossy().to_string(), metadata))
}

fn enriched_metadata_entries(
    gguf: Option<&crate::services::gguf_parser::GgufMetadata>,
) -> Vec<(String, String)> {
    let Some(gguf) = gguf else {
        return Vec::new();
    };
    let mut entries = gguf.metadata_entries.clone();
    entries.push((
        "agentllm.gguf_version".to_string(),
        gguf.gguf_version.to_string(),
    ));
    entries.push((
        "agentllm.tensor_count".to_string(),
        gguf.tensor_count.to_string(),
    ));
    entries.push((
        "agentllm.mtp_tensor_count".to_string(),
        gguf.mtp_tensor_count.to_string(),
    ));
    entries.push((
        "agentllm.nextn_predict_layers".to_string(),
        gguf.nextn_predict_layers.to_string(),
    ));
    entries.push((
        "agentllm.has_embedded_mtp".to_string(),
        gguf.has_embedded_mtp.to_string(),
    ));
    entries.push((
        "agentllm.is_mtp_draft_model".to_string(),
        gguf.is_mtp_draft_model.to_string(),
    ));
    if !gguf.tensor_type_summary.is_empty() {
        entries.push((
            "agentllm.tensor_type_summary".to_string(),
            gguf.tensor_type_summary
                .iter()
                .map(|(kind, count)| format!("{}:{}", kind, count))
                .collect::<Vec<_>>()
                .join(", "),
        ));
    }
    entries
}

pub fn parse_model_info_from_path(path: &Path) -> Option<ModelInfo> {
    let metadata = path.metadata().ok()?;
    let split_info = split_gguf_info(path);
    let split_total_size_bytes =
        split_info.and_then(|(_part, count)| split_total_size(path, count));
    let display_size_bytes = split_total_size_bytes.unwrap_or(metadata.len());
    let file_size = display_size_bytes as f64 / 1024.0 / 1024.0 / 1024.0;
    let file_name = path.file_name()?.to_string_lossy().to_string();
    let name = split_gguf_prefix(path).unwrap_or_else(|| {
        path.file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string()
    });

    let lower_name = name.to_ascii_lowercase();
    if is_companion_gguf_stem(&lower_name) {
        return None;
    }

    let gguf = parse_gguf_header(path).ok();
    if gguf.as_ref().is_some_and(|metadata| {
        metadata.is_mtp_draft_model
            || (metadata.architecture == "clip"
                && (metadata.mmproj_supports_vision || metadata.mmproj_supports_audio))
    }) {
        return None;
    }

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
            .and_then(|g| {
                g.tensor_type_summary
                    .first()
                    .map(|(kind, _)| kind.clone())
                    .filter(|kind| kind != "UNKNOWN")
            })
            .or_else(|| {
                gguf.as_ref()
                    .and_then(|g| g.quantization_version.map(|v| format!("v{}", v)))
            })
    });

    let block_count = gguf.as_ref().map(|g| g.block_count).filter(|&c| c > 0);
    let context_length = gguf.as_ref().map(|g| g.context_length).filter(|&c| c > 0);
    let embedding_length = gguf.as_ref().map(|g| g.embedding_length).filter(|&c| c > 0);

    // GGUF tags + chat_template 是比文件名更可靠的能力信号
    let gguf_tags: Vec<String> = gguf.as_ref().map(|g| g.tags.clone()).unwrap_or_default();
    let chat_template = gguf
        .as_ref()
        .and_then(|g| g.chat_template.clone())
        .unwrap_or_default();

    // 工具调用：严格匹配 chat_template 里的工具语法（最权威）
    let has_tool_template = detect_tool_template(&chat_template);

    // 思考/推理：合并判定 —— GGUF tags 含 reasoning/thinking，或架构/名字命中
    let supports_reasoning =
        gguf_tags.iter().any(|t| {
            t == "reasoning"
                || t == "thinking"
                || t == "chain-of-thought"
                || t == "chain_of_thought"
                || t == "cot"
        }) || detect_reasoning_support(&name, gguf.as_ref().map(|g| g.architecture.as_str()));

    let mmproj = find_companion_gguf(path, &name, "mmproj", gguf.as_ref());
    let mtp_draft = find_companion_gguf(path, &name, "mtp", gguf.as_ref());
    let mmproj_path = mmproj.as_ref().map(|(path, _)| path.clone());
    let mtp_draft_path = mtp_draft.as_ref().map(|(path, _)| path.clone());
    let mmproj_metadata = mmproj.as_ref().map(|(_, metadata)| metadata);
    let video_support = infer_video_support(&name, &gguf_tags, mmproj_metadata);
    let has_embedded_mtp = gguf
        .as_ref()
        .map(|metadata| metadata.has_embedded_mtp)
        .unwrap_or(false);

    Some(ModelInfo {
        name,
        file_name,
        file_path: path.to_string_lossy().to_string(),
        file_size_gb: (file_size * 100.0).round() / 100.0,
        split_part: split_info.map(|(part, _count)| part),
        split_count: split_info.map(|(_part, count)| count),
        split_total_size_gb: split_total_size_bytes
            .map(|size| ((size as f64 / 1024.0 / 1024.0 / 1024.0) * 100.0).round() / 100.0),
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
        gguf_version: gguf.as_ref().map(|g| g.gguf_version).unwrap_or(0),
        mtp_support: has_embedded_mtp || mtp_draft_path.is_some(),
        nextn_predict_layers: gguf.as_ref().map(|g| g.nextn_predict_layers).unwrap_or(0),
        has_embedded_mtp,
        mtp_architecture_supported: gguf
            .as_ref()
            .map(|g| g.mtp_architecture_supported)
            .unwrap_or(false),
        mtp_tensor_count: gguf.as_ref().map(|g| g.mtp_tensor_count).unwrap_or(0),
        vocab_size: gguf.as_ref().and_then(|g| g.vocab_size),
        tensor_count: gguf.as_ref().map(|g| g.tensor_count).unwrap_or(0),
        tensor_type_summary: gguf
            .as_ref()
            .map(|g| g.tensor_type_summary.clone())
            .unwrap_or_default(),
        rope_freq_base: gguf.as_ref().and_then(|g| g.rope_freq_base),
        rope_dimension_count: gguf.as_ref().and_then(|g| g.rope_dimension_count),
        rope_scaling_type: gguf.as_ref().and_then(|g| g.rope_scaling_type.clone()),
        rope_scaling_factor: gguf.as_ref().and_then(|g| g.rope_scaling_factor),
        rope_scaling_original_context_length: gguf
            .as_ref()
            .and_then(|g| g.rope_scaling_original_context_length),
        tokenizer_model: gguf.as_ref().and_then(|g| g.tokenizer_model.clone()),
        tokenizer_bos_id: gguf.as_ref().and_then(|g| g.tokenizer_bos_id),
        tokenizer_eos_id: gguf.as_ref().and_then(|g| g.tokenizer_eos_id),
        tokenizer_pad_id: gguf.as_ref().and_then(|g| g.tokenizer_pad_id),
        mmproj_path,
        mmproj_supports_vision: mmproj_metadata
            .map(|metadata| metadata.mmproj_supports_vision)
            .unwrap_or(false),
        mmproj_supports_audio: mmproj_metadata
            .map(|metadata| metadata.mmproj_supports_audio)
            .unwrap_or(false),
        mmproj_projector_type: mmproj_metadata
            .and_then(|metadata| metadata.mmproj_projector_type.clone()),
        mmproj_vision_projector_type: mmproj_metadata
            .and_then(|metadata| metadata.mmproj_vision_projector_type.clone()),
        mmproj_audio_projector_type: mmproj_metadata
            .and_then(|metadata| metadata.mmproj_audio_projector_type.clone()),
        video_support,
        mtp_draft_path,
        supports_reasoning,
        gguf_tags,
        has_tool_template,
        gguf_metadata: enriched_metadata_entries(gguf.as_ref()),
    })
}

/// 通过 chat_template 中是否含工具调用相关语法来权威判断 function calling 支持。
/// 主流 instruct 模板（Qwen/Llama/Mistral/Gemma/GLM/GPT-OSS 等）在支持工具时会在模板里出现
/// tool_calls / tools / function_call 等占位符；纯 base / 无工具的对话模板不会有。
fn detect_tool_template(template: &str) -> bool {
    if template.is_empty() {
        return false;
    }
    let lower = template.to_ascii_lowercase();
    // 任一关键词命中即视为支持工具
    lower.contains("tool_calls")
        || lower.contains("tool_call")
        || lower.contains("\"tools\"")
        || lower.contains("function_call")
        || lower.contains("<|tool|>")
        || lower.contains("<tool_call")
        || lower.contains("<|tool_call|>")
        || lower.contains("function calling")
        || lower.contains("tools }}")
        || lower.contains("tools %}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vision_projector(projector: &str) -> GgufMetadata {
        GgufMetadata {
            mmproj_supports_vision: true,
            mmproj_projector_type: Some(projector.to_string()),
            ..GgufMetadata::default()
        }
    }

    #[test]
    fn video_support_is_not_equated_with_generic_vision() {
        let tags = Vec::new();
        assert_eq!(
            infer_video_support("Gemma4-26B", &tags, Some(&vision_projector("gemma4v"))),
            VideoSupportLevel::Frames
        );
        assert_eq!(
            infer_video_support(
                "Qwen3.5-9B",
                &tags,
                Some(&vision_projector("qwen3vl_merger"))
            ),
            VideoSupportLevel::Candidate
        );
        assert_eq!(
            infer_video_support(
                "Nemotron-3-Nano-Omni",
                &tags,
                Some(&vision_projector("nemotron_v2_vl"))
            ),
            VideoSupportLevel::Verified
        );
        assert_eq!(
            infer_video_support("Text-only", &tags, None),
            VideoSupportLevel::None
        );
    }

    #[test]
    fn explicit_video_metadata_is_verified() {
        let tags = vec!["video-understanding".to_string()];
        assert_eq!(
            infer_video_support("SmolVLM2", &tags, Some(&vision_projector("llava"))),
            VideoSupportLevel::Verified
        );
    }

    #[test]
    fn accepts_official_gemma4_assistant_mtp_pair() {
        let token_hash = [7u8; 32];
        let main = GgufMetadata {
            architecture: "gemma4".to_string(),
            embedding_length: 3840,
            mtp_architecture_supported: true,
            vocab_size: Some(262_144),
            tokenizer_model: Some("llama".to_string()),
            tokenizer_pre: Some("gemma".to_string()),
            tokenizer_bos_id: Some(2),
            tokenizer_eos_id: Some(1),
            tokenizer_tokens_hash: Some(token_hash),
            ..GgufMetadata::default()
        };
        let draft = GgufMetadata {
            architecture: "gemma4-assistant".to_string(),
            embedding_length: 1024,
            embedding_length_out: Some(3840),
            is_mtp_draft_model: true,
            mtp_architecture_supported: true,
            nextn_predict_layers: 4,
            vocab_size: Some(262_144),
            tokenizer_model: Some("llama".to_string()),
            tokenizer_pre: Some("gemma".to_string()),
            tokenizer_bos_id: Some(2),
            tokenizer_eos_id: Some(1),
            tokenizer_tokens_hash: Some(token_hash),
            ..GgufMetadata::default()
        };

        assert!(mtp_draft_is_compatible(&main, &draft));

        let incompatible = GgufMetadata {
            embedding_length_out: Some(4096),
            ..draft
        };
        assert!(!mtp_draft_is_compatible(&main, &incompatible));
    }

    #[test]
    #[ignore]
    fn test_local_multimodal_and_mtp_pairing() {
        // 需要本地模型文件：AGENT_LLM_TEST_MODEL_DIR=<目录> cargo test -- --ignored
        let Some(dir) = std::env::var("AGENT_LLM_TEST_MODEL_DIR")
            .ok()
            .map(std::path::PathBuf::from)
            .filter(|d| d.is_dir())
        else {
            eprintln!("skip: AGENT_LLM_TEST_MODEL_DIR 未设置或不存在");
            return;
        };
        let vision_models = [
            (
                "Qwen3.5-9B-Uncensored-Q6_K_M.gguf",
                VideoSupportLevel::Candidate,
            ),
            (
                "Gemma4-26B-A4B-Uncensored-HauhauCS-Balanced-Q6_K_P.gguf",
                VideoSupportLevel::Frames,
            ),
            (
                "Nemotron-3-Nano-Omni-30B-A3B-Reasoning-APEX-I-Quality.gguf",
                VideoSupportLevel::Verified,
            ),
        ];
        for (file_name, expected) in vision_models {
            let vision_model = dir.join(file_name);
            if !vision_model.exists() {
                continue;
            }
            let info = parse_model_info_from_path(&vision_model).expect("scan local vision model");
            assert!(info.mmproj_path.is_some());
            assert!(info.mmproj_supports_vision);
            assert!(!info.mmproj_supports_audio);
            assert_eq!(info.video_support, expected, "model={}", info.name);
        }

        let mtp_model = dir.join("Qwythos-9B-Claude-Mythos-5-1M-MTP-Q5_K_M.gguf");
        if mtp_model.exists() {
            let info = parse_model_info_from_path(&mtp_model).expect("scan local MTP model");
            assert!(info.has_embedded_mtp);
            assert!(info.mtp_support);
            assert!(info.mtp_draft_path.is_none());
        }
    }
}
