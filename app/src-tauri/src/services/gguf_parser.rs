use std::fs::File;
use std::io::Read;
use std::path::Path;

use anyhow::{bail, Result};
use sha2::{Digest, Sha256};

const BUF_SIZE: u64 = 100 * 1024 * 1024; // 100MB buffer for large tokenizer data
const MAX_ARRAY: u64 = 10_000_000; // 支持大词表模型（如 10M+ tokens）
const MAX_STR_LEN: u64 = 100_000_000;
/// 数组嵌套深度上限。GGUF 规范中数组元素不应再是数组，这里留 2 层容错。
/// 没有这个上限时，畸形文件可以让元素类型一直是 9（数组）从而无限递归，
/// 导致栈溢出——栈溢出会直接 abort 进程，Result 无法拦截。
const MAX_NEST_DEPTH: u32 = 2;

#[derive(Debug, Clone, Default)]
pub struct GgufMetadata {
    pub gguf_version: u32,
    pub tensor_count: u64,
    pub architecture: String,
    pub block_count: u64,
    pub context_length: u64,
    pub embedding_length: u64,
    pub embedding_length_out: Option<u64>,
    pub expert_count: Option<u64>,
    pub _expert_used_count: Option<u64>,
    pub name: Option<String>,
    pub size_label: Option<String>,
    pub quantization_version: Option<u32>,
    pub nextn_predict_layers: u64,
    pub has_embedded_mtp: bool,
    pub is_mtp_draft_model: bool,
    pub mtp_architecture_supported: bool,
    pub mtp_tensor_count: u64,
    pub(crate) has_main_model_tensors: bool,
    pub vocab_size: Option<u64>,
    pub mmproj_supports_vision: bool,
    pub mmproj_supports_audio: bool,
    pub mmproj_projector_type: Option<String>,
    pub mmproj_vision_projector_type: Option<String>,
    pub mmproj_audio_projector_type: Option<String>,
    pub tensor_type_summary: Vec<(String, u64)>,
    // Attention head metadata — needed for an accurate KV-cache size estimate.
    pub head_count: Option<u64>,
    pub head_count_kv: Option<u64>,
    pub key_length: Option<u64>,
    pub value_length: Option<u64>,
    pub rope_freq_base: Option<f64>,
    pub rope_dimension_count: Option<u64>,
    pub rope_scaling_type: Option<String>,
    pub rope_scaling_factor: Option<f64>,
    pub rope_scaling_original_context_length: Option<u64>,
    pub tokenizer_model: Option<String>,
    pub tokenizer_pre: Option<String>,
    pub tokenizer_bos_id: Option<u64>,
    pub tokenizer_eos_id: Option<u64>,
    pub tokenizer_pad_id: Option<u64>,
    pub tokenizer_add_bos: Option<bool>,
    pub tokenizer_add_eos: Option<bool>,
    pub(crate) tokenizer_tokens_hash: Option<[u8; 32]>,
    pub metadata_entries: Vec<(String, String)>,
    // 真实读出的能力信号：来自 HuggingFace 模型卡的 tags 数组（包含 vision / tool-use 等）
    pub tags: Vec<String>,
    // chat_template 原文，用来判断模型是否有工具调用语法
    pub chat_template: Option<String>,
}

fn adv(buf: &[u8], p: &mut usize, n: usize) -> Result<()> {
    if *p + n > buf.len() {
        bail!("eof");
    }
    *p += n;
    Ok(())
}

fn r32(buf: &[u8], p: &mut usize) -> Result<u32> {
    if *p + 4 > buf.len() {
        bail!("eof");
    }
    let v = u32::from_le_bytes(buf[*p..*p + 4].try_into().unwrap());
    *p += 4;
    Ok(v)
}

fn r8(buf: &[u8], p: &mut usize) -> Result<u8> {
    if *p + 1 > buf.len() {
        bail!("eof");
    }
    let v = buf[*p];
    *p += 1;
    Ok(v)
}

fn r64(buf: &[u8], p: &mut usize) -> Result<u64> {
    if *p + 8 > buf.len() {
        bail!("eof");
    }
    let v = u64::from_le_bytes(buf[*p..*p + 8].try_into().unwrap());
    *p += 8;
    Ok(v)
}

fn rstr(buf: &[u8], p: &mut usize) -> Result<String> {
    let n = r64(buf, p)? as usize;
    if n > MAX_STR_LEN as usize {
        bail!("str {}", n);
    }
    if *p + n > buf.len() {
        bail!("eof");
    }
    let s = String::from_utf8_lossy(&buf[*p..*p + n]).to_string();
    *p += n;
    Ok(s)
}

fn rbytes<'a>(buf: &'a [u8], p: &mut usize, n: usize) -> Result<&'a [u8]> {
    if *p + n > buf.len() {
        bail!("eof");
    }
    let slice = &buf[*p..*p + n];
    *p += n;
    Ok(slice)
}

fn skip(buf: &[u8], p: &mut usize, ty: u32) -> Result<()> {
    skip_at(buf, p, ty, 0)
}

fn skip_at(buf: &[u8], p: &mut usize, ty: u32, depth: u32) -> Result<()> {
    match ty {
        0 | 1 | 7 => adv(buf, p, 1),
        2 | 3 => adv(buf, p, 2),
        4..=6 => adv(buf, p, 4),
        8 => {
            let n = r64(buf, p)? as usize;
            if n > MAX_STR_LEN as usize {
                bail!("str {}", n);
            }
            adv(buf, p, n)
        }
        9 => {
            if depth >= MAX_NEST_DEPTH {
                bail!("array nesting too deep ({})", depth);
            }
            let et = r32(buf, p)?;
            let n = r64(buf, p)?;
            if n > MAX_ARRAY {
                bail!("array {}", n);
            }
            for _ in 0..n {
                skip_at(buf, p, et, depth + 1)?;
            }
            Ok(())
        }
        10 | 11 => adv(buf, p, 8),
        12 => adv(buf, p, 8),
        _ => bail!("ty {}", ty),
    }
}

fn read_val(buf: &[u8], p: &mut usize, ty: u32) -> Result<serde_json::Value> {
    read_val_at(buf, p, ty, 0)
}

fn read_val_at(buf: &[u8], p: &mut usize, ty: u32, depth: u32) -> Result<serde_json::Value> {
    match ty {
        0 => Ok(serde_json::json!(r8(buf, p)?)),
        1 => Ok(serde_json::json!(r8(buf, p)? as i8)),
        2 => Ok(serde_json::json!(u16::from_le_bytes(
            rbytes(buf, p, 2)?.try_into().unwrap()
        ))),
        3 => Ok(serde_json::json!(i16::from_le_bytes(
            rbytes(buf, p, 2)?.try_into().unwrap()
        ))),
        4 => Ok(serde_json::json!(r32(buf, p)?)),
        5 => Ok(serde_json::json!(r32(buf, p)? as i32)),
        6 => Ok(serde_json::json!(f32::from_le_bytes(
            rbytes(buf, p, 4)?.try_into().unwrap()
        ))),
        7 => Ok(serde_json::json!(r8(buf, p)? != 0)),
        8 => Ok(serde_json::json!(rstr(buf, p)?)),
        10 => Ok(serde_json::json!(r64(buf, p)?)),
        11 => Ok(serde_json::json!(i64::from_le_bytes(
            rbytes(buf, p, 8)?.try_into().unwrap()
        ))),
        12 => Ok(serde_json::json!(f64::from_le_bytes(
            rbytes(buf, p, 8)?.try_into().unwrap()
        ))),
        9 => {
            if depth >= MAX_NEST_DEPTH {
                bail!("array nesting too deep ({})", depth);
            }
            let et = r32(buf, p)?;
            let cnt = r64(buf, p)?;
            // 长度校验必须在递归读取之前，否则畸形的超大 cnt 已经先把栈耗掉了。
            if cnt > MAX_ARRAY {
                bail!("array {}", cnt);
            }
            let mut arr = Vec::new();
            for _ in 0..std::cmp::min(cnt, 10) {
                arr.push(read_val_at(buf, p, et, depth + 1)?);
            }
            for _ in 0..cnt.saturating_sub(10) {
                skip_at(buf, p, et, depth + 1)?;
            }
            Ok(serde_json::Value::Array(arr))
        }
        _ => bail!("ty {}", ty),
    }
}

fn read_tokenizer_tokens(buf: &[u8], p: &mut usize, ty: u32) -> Result<(u64, [u8; 32])> {
    if ty != 9 {
        bail!("tokenizer tokens type {}", ty);
    }
    let element_type = r32(buf, p)?;
    let count = r64(buf, p)?;
    if element_type != 8 || count > MAX_ARRAY {
        bail!(
            "tokenizer tokens array type {} count {}",
            element_type,
            count
        );
    }

    let mut hasher = Sha256::new();
    hasher.update(count.to_le_bytes());
    for _ in 0..count {
        let len = r64(buf, p)?;
        if len > MAX_STR_LEN {
            bail!("str {}", len);
        }
        let bytes = rbytes(buf, p, len as usize)?;
        hasher.update(len.to_le_bytes());
        hasher.update(bytes);
    }
    Ok((count, hasher.finalize().into()))
}

fn tensor_block_index(name: &str) -> Option<u64> {
    name.strip_prefix("blk.")?.split('.').next()?.parse().ok()
}

fn parse_gguf_header_single(path: &Path) -> Result<GgufMetadata> {
    let mut file = File::open(path)?;
    let file_len = file.metadata()?.len();
    let buf_size = std::cmp::min(file_len, BUF_SIZE) as usize;
    let mut buf = vec![0u8; buf_size];
    file.read_exact(&mut buf)?;

    let mut p: usize = 4;
    if buf.len() < 4 || &buf[0..4] != b"GGUF" {
        bail!("not GGUF");
    }

    let gguf_version = r32(&buf, &mut p)?;
    let tensor_count = r64(&buf, &mut p)?;
    let kvn = r64(&buf, &mut p)?;

    let mut arch = String::from("unknown");
    let mut blk = 0u64;
    let mut ctx = 0u64;
    let mut emb = 0u64;
    let mut embedding_length_out: Option<u64> = None;
    let mut exp: Option<u64> = None;
    let mut expu: Option<u64> = None;
    let mut qv: Option<u32> = None;
    let mut nm: Option<String> = None;
    let mut sl: Option<String> = None;
    let mut nextn_predict_layers = 0u64;
    let mut mtp_tensor_count = 0u64;
    let mut tensor_type_counts: Vec<(u32, u64)> = Vec::new();
    let mut hc: Option<u64> = None;
    let mut hckv: Option<u64> = None;
    let mut klen: Option<u64> = None;
    let mut vlen: Option<u64> = None;
    let mut rope_freq_base: Option<f64> = None;
    let mut rope_dimension_count: Option<u64> = None;
    let mut rope_scaling_type: Option<String> = None;
    let mut rope_scaling_factor: Option<f64> = None;
    let mut rope_scaling_original_context_length: Option<u64> = None;
    let mut tokenizer_model: Option<String> = None;
    let mut tokenizer_pre: Option<String> = None;
    let mut tokenizer_bos_id: Option<u64> = None;
    let mut tokenizer_eos_id: Option<u64> = None;
    let mut tokenizer_pad_id: Option<u64> = None;
    let mut tokenizer_add_bos: Option<bool> = None;
    let mut tokenizer_add_eos: Option<bool> = None;
    let mut tokenizer_tokens_hash: Option<[u8; 32]> = None;
    let mut vocab_size: Option<u64> = None;
    let mut mmproj_supports_vision = false;
    let mut mmproj_supports_audio = false;
    let mut mmproj_projector_type: Option<String> = None;
    let mut mmproj_vision_projector_type: Option<String> = None;
    let mut mmproj_audio_projector_type: Option<String> = None;
    let mut tags: Vec<String> = Vec::new();
    let mut chat_template: Option<String> = None;
    let mut entries: Vec<(String, String)> = Vec::new();

    for _ in 0..kvn {
        if p >= buf.len() {
            bail!("GGUF metadata exceeds {} MB", BUF_SIZE / 1024 / 1024);
        }
        let key = rstr(&buf, &mut p)?;
        let ty = r32(&buf, &mut p)?;

        if key == "tokenizer.ggml.tokens" {
            let (token_count, token_hash) = read_tokenizer_tokens(&buf, &mut p, ty)?;
            vocab_size.get_or_insert(token_count);
            tokenizer_tokens_hash = Some(token_hash);
            entries.push((key, format!("array[{}]", token_count)));
            continue;
        }

        let keep = key.starts_with("general.")
            || key.ends_with(".block_count")
            || key.ends_with(".context_length")
            || key.ends_with(".embedding_length")
            || key.ends_with(".embedding_length_out")
            || key.ends_with(".vocab_size")
            || key.ends_with(".expert_count")
            || key.ends_with(".expert_used_count")
            || key.ends_with(".attention.head_count")
            || key.ends_with(".attention.head_count_kv")
            || key.ends_with(".attention.key_length")
            || key.ends_with(".attention.value_length")
            || key.ends_with(".nextn_predict_layers")
            || key.ends_with(".rope.freq_base")
            || key.ends_with(".rope.dimension_count")
            || key.ends_with(".rope.scaling.type")
            || key.ends_with(".rope.scaling.factor")
            || key.ends_with(".rope.scaling.original_context_length")
            || key == "tokenizer.ggml.model"
            || key == "tokenizer.ggml.pre"
            || key == "tokenizer.ggml.bos_token_id"
            || key == "tokenizer.ggml.eos_token_id"
            || key == "tokenizer.ggml.padding_token_id"
            || key == "tokenizer.ggml.add_bos_token"
            || key == "tokenizer.ggml.add_eos_token"
            || key == "tokenizer.chat_template"
            || key == "clip.has_vision_encoder"
            || key == "clip.has_audio_encoder"
            || key == "clip.projector_type"
            || key == "clip.vision.projector_type"
            || key == "clip.audio.projector_type";

        if !keep {
            skip(&buf, &mut p, ty)?;
            continue;
        }

        let v = read_val(&buf, &mut p, ty)?;
        if let Some(value) = value_to_string(&v) {
            entries.push((key.clone(), value));
        }

        match key.as_str() {
            "general.architecture" => {
                if let Some(s) = v.as_str() {
                    arch = s.to_string();
                }
            }
            "general.name" => {
                nm = v.as_str().map(|s| s.to_string());
            }
            "general.size_label" => {
                sl = v.as_str().map(|s| s.to_string());
            }
            "general.quantization_version" => {
                qv = v.as_u64().map(|n| n as u32);
            }
            "general.tags" => {
                if let Some(arr) = v.as_array() {
                    tags = arr
                        .iter()
                        .filter_map(|item| item.as_str().map(|s| s.to_ascii_lowercase()))
                        .collect();
                }
            }
            "tokenizer.chat_template" => {
                chat_template = v.as_str().map(|s| s.to_string());
            }
            "tokenizer.ggml.model" => {
                tokenizer_model = v.as_str().map(|s| s.to_string());
            }
            "tokenizer.ggml.pre" => tokenizer_pre = v.as_str().map(ToString::to_string),
            "tokenizer.ggml.bos_token_id" => tokenizer_bos_id = v.as_u64(),
            "tokenizer.ggml.eos_token_id" => tokenizer_eos_id = v.as_u64(),
            "tokenizer.ggml.padding_token_id" => tokenizer_pad_id = v.as_u64(),
            "tokenizer.ggml.add_bos_token" => tokenizer_add_bos = v.as_bool(),
            "tokenizer.ggml.add_eos_token" => tokenizer_add_eos = v.as_bool(),
            "clip.has_vision_encoder" => mmproj_supports_vision = v.as_bool().unwrap_or(false),
            "clip.has_audio_encoder" => mmproj_supports_audio = v.as_bool().unwrap_or(false),
            "clip.projector_type" => mmproj_projector_type = v.as_str().map(ToString::to_string),
            "clip.vision.projector_type" => {
                mmproj_vision_projector_type = v.as_str().map(ToString::to_string)
            }
            "clip.audio.projector_type" => {
                mmproj_audio_projector_type = v.as_str().map(ToString::to_string)
            }
            _ => {
                if key.ends_with(".block_count") {
                    blk = v.as_u64().unwrap_or(0);
                } else if key.ends_with(".context_length") {
                    ctx = v.as_u64().unwrap_or(0);
                } else if key.ends_with(".embedding_length") {
                    emb = v.as_u64().unwrap_or(0);
                } else if key.ends_with(".embedding_length_out") {
                    embedding_length_out = v.as_u64();
                } else if key.ends_with(".vocab_size") {
                    vocab_size = v.as_u64();
                } else if key.ends_with(".expert_count") {
                    exp = v.as_u64();
                } else if key.ends_with(".expert_used_count") {
                    expu = v.as_u64();
                } else if key.ends_with(".attention.head_count") {
                    hc = v.as_u64();
                } else if key.ends_with(".attention.head_count_kv") {
                    hckv = v.as_u64();
                } else if key.ends_with(".attention.key_length") {
                    klen = v.as_u64();
                } else if key.ends_with(".attention.value_length") {
                    vlen = v.as_u64();
                } else if key.ends_with(".nextn_predict_layers") {
                    nextn_predict_layers = v.as_u64().unwrap_or(0);
                } else if key.ends_with(".rope.freq_base") {
                    rope_freq_base = v.as_f64().or_else(|| v.as_u64().map(|n| n as f64));
                } else if key.ends_with(".rope.dimension_count") {
                    rope_dimension_count = v.as_u64();
                } else if key.ends_with(".rope.scaling.type") {
                    rope_scaling_type = v.as_str().map(|s| s.to_string());
                } else if key.ends_with(".rope.scaling.factor") {
                    rope_scaling_factor = v.as_f64().or_else(|| v.as_u64().map(|n| n as f64));
                } else if key.ends_with(".rope.scaling.original_context_length") {
                    rope_scaling_original_context_length = v.as_u64();
                }
            }
        }
    }

    let mut has_main_model_tensors = false;
    for _ in 0..tensor_count {
        if p >= buf.len() {
            bail!("GGUF tensor table exceeds {} MB", BUF_SIZE / 1024 / 1024);
        }
        let name = rstr(&buf, &mut p)?;
        let n_dims = r32(&buf, &mut p)?;
        if n_dims > 8 {
            bail!("tensor dims {}", n_dims);
        }
        for _ in 0..n_dims {
            let _ = r64(&buf, &mut p)?;
        }
        let tensor_type = r32(&buf, &mut p)?;
        let _offset = r64(&buf, &mut p)?;
        let main_layer_count = blk.saturating_sub(nextn_predict_layers);
        if name == "blk.0.attn_norm.weight"
            || tensor_block_index(&name).is_some_and(|index| index < main_layer_count)
        {
            has_main_model_tensors = true;
        }
        if name.starts_with("mtp.") || name.starts_with("nextn.") || name.contains(".nextn.") {
            mtp_tensor_count += 1;
        }
        if let Some((_, count)) = tensor_type_counts
            .iter_mut()
            .find(|(kind, _)| *kind == tensor_type)
        {
            *count += 1;
        } else {
            tensor_type_counts.push((tensor_type, 1));
        }
    }

    let mut tensor_type_summary: Vec<(String, u64)> = tensor_type_counts
        .into_iter()
        .map(|(kind, count)| (ggml_type_name(kind).to_string(), count))
        .collect();
    tensor_type_summary.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

    let (mtp_architecture_supported, has_embedded_mtp, is_mtp_draft_model) = classify_mtp(
        &arch,
        nextn_predict_layers,
        mtp_tensor_count,
        has_main_model_tensors,
    );

    Ok(GgufMetadata {
        gguf_version,
        tensor_count,
        architecture: arch,
        block_count: blk,
        context_length: ctx,
        embedding_length: emb,
        embedding_length_out,
        expert_count: exp,
        _expert_used_count: expu,
        name: nm,
        size_label: sl,
        quantization_version: qv,
        nextn_predict_layers,
        has_embedded_mtp,
        is_mtp_draft_model,
        mtp_architecture_supported,
        mtp_tensor_count,
        has_main_model_tensors,
        vocab_size,
        mmproj_supports_vision,
        mmproj_supports_audio,
        mmproj_projector_type,
        mmproj_vision_projector_type,
        mmproj_audio_projector_type,
        tensor_type_summary,
        head_count: hc,
        head_count_kv: hckv,
        key_length: klen,
        value_length: vlen,
        rope_freq_base,
        rope_dimension_count,
        rope_scaling_type,
        rope_scaling_factor,
        rope_scaling_original_context_length,
        tokenizer_model,
        tokenizer_pre,
        tokenizer_bos_id,
        tokenizer_eos_id,
        tokenizer_pad_id,
        tokenizer_add_bos,
        tokenizer_add_eos,
        tokenizer_tokens_hash,
        metadata_entries: entries,
        tags,
        chat_template,
    })
}

fn supports_mtp_graph(architecture: &str) -> bool {
    matches!(
        architecture,
        "cohere2moe" | "gemma4" | "gemma4-assistant" | "qwen35" | "qwen35moe" | "step35"
    )
}

fn supports_embedded_or_same_arch_mtp(architecture: &str) -> bool {
    matches!(
        architecture,
        "cohere2moe" | "qwen35" | "qwen35moe" | "step35"
    )
}

fn classify_mtp(
    architecture: &str,
    nextn_predict_layers: u64,
    mtp_tensor_count: u64,
    has_main_model_tensors: bool,
) -> (bool, bool, bool) {
    let architecture_supported = supports_mtp_graph(architecture);
    let has_payload = nextn_predict_layers > 0 && mtp_tensor_count > 0;
    if architecture == "gemma4-assistant" {
        return (architecture_supported, false, has_payload);
    }
    if !supports_embedded_or_same_arch_mtp(architecture) || !has_payload {
        return (architecture_supported, false, false);
    }
    (
        architecture_supported,
        has_main_model_tensors,
        !has_main_model_tensors,
    )
}

fn refresh_mtp_classification(metadata: &mut GgufMetadata) {
    let (supported, embedded, draft) = classify_mtp(
        &metadata.architecture,
        metadata.nextn_predict_layers,
        metadata.mtp_tensor_count,
        metadata.has_main_model_tensors,
    );
    metadata.mtp_architecture_supported = supported;
    metadata.has_embedded_mtp = embedded;
    metadata.is_mtp_draft_model = draft;
}

fn split_gguf_info(path: &Path) -> Option<(String, u32, u32)> {
    let name = path.file_name()?.to_str()?;
    if !name.to_ascii_lowercase().ends_with(".gguf") {
        return None;
    }
    let stem = &name[..name.len() - 5];
    let (before_count, count) = stem.rsplit_once("-of-")?;
    let (prefix, part) = before_count.rsplit_once('-')?;
    if part.len() != 5
        || count.len() != 5
        || !part.bytes().all(|value| value.is_ascii_digit())
        || !count.bytes().all(|value| value.is_ascii_digit())
    {
        return None;
    }
    Some((prefix.to_string(), part.parse().ok()?, count.parse().ok()?))
}

pub fn parse_gguf_header(path: &Path) -> Result<GgufMetadata> {
    let mut metadata = parse_gguf_header_single(path)?;
    let Some((prefix, _part, count)) = split_gguf_info(path) else {
        return Ok(metadata);
    };
    if count <= 1 || !metadata.mtp_architecture_supported || metadata.nextn_predict_layers == 0 {
        return Ok(metadata);
    }

    let Some(parent) = path.parent() else {
        return Ok(metadata);
    };
    for part in (1..=count).rev() {
        let shard = parent.join(format!("{}-{:05}-of-{:05}.gguf", prefix, part, count));
        if shard == path || !shard.exists() {
            continue;
        }
        let shard_metadata = parse_gguf_header_single(&shard)?;
        metadata.mtp_tensor_count = metadata
            .mtp_tensor_count
            .saturating_add(shard_metadata.mtp_tensor_count);
        metadata.has_main_model_tensors |= shard_metadata.has_main_model_tensors;

        if metadata.mtp_tensor_count > 0 && metadata.has_main_model_tensors {
            break;
        }
    }
    refresh_mtp_classification(&mut metadata);
    Ok(metadata)
}

fn ggml_type_name(value: u32) -> &'static str {
    match value {
        0 => "F32",
        1 => "F16",
        2 => "Q4_0",
        3 => "Q4_1",
        6 => "Q5_0",
        7 => "Q5_1",
        8 => "Q8_0",
        9 => "Q8_1",
        10 => "Q2_K",
        11 => "Q3_K",
        12 => "Q4_K",
        13 => "Q5_K",
        14 => "Q6_K",
        15 => "Q8_K",
        16 => "IQ2_XXS",
        17 => "IQ2_XS",
        18 => "IQ3_XXS",
        19 => "IQ1_S",
        20 => "IQ4_NL",
        21 => "IQ3_S",
        22 => "IQ2_S",
        23 => "IQ4_XS",
        24 => "I8",
        25 => "I16",
        26 => "I32",
        27 => "I64",
        28 => "F64",
        29 => "IQ1_M",
        30 => "BF16",
        31 => "Q4_0_4_4",
        32 => "Q4_0_4_8",
        33 => "Q4_0_8_8",
        34 => "TQ1_0",
        35 => "TQ2_0",
        39 => "MXFP4",
        40 => "NVFP4",
        41 => "Q1_0",
        42 => "Q2_0",
        _ => "UNKNOWN",
    }
}

fn value_to_string(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::Null => None,
        serde_json::Value::Bool(v) => Some(v.to_string()),
        serde_json::Value::Number(v) => Some(v.to_string()),
        serde_json::Value::String(v) => Some(v.clone()),
        serde_json::Value::Array(v) => {
            // 如果数组里全是短字符串（典型的 general.tags / general.languages），
            // 直接拼接成可读的列表，方便前端展示和后续判定使用。
            let all_short_strings = v.len() <= 32
                && v.iter()
                    .all(|item| item.as_str().is_some_and(|s| s.len() <= 64));
            if all_short_strings {
                let items: Vec<String> = v
                    .iter()
                    .filter_map(|item| item.as_str().map(|s| s.to_string()))
                    .collect();
                Some(items.join(", "))
            } else {
                Some(format!("array[{}]", v.len()))
            }
        }
        serde_json::Value::Object(_) => Some("object".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_FILE_ID: AtomicU64 = AtomicU64::new(0);

    enum TestValue<'a> {
        Bool(bool),
        U32(u32),
        String(&'a str),
        StringArray(&'a [&'a str]),
    }

    fn push_string(buf: &mut Vec<u8>, value: &str) {
        buf.extend_from_slice(&(value.len() as u64).to_le_bytes());
        buf.extend_from_slice(value.as_bytes());
    }

    fn build_test_gguf(kv: &[(&str, TestValue<'_>)], tensors: &[&str]) -> Vec<u8> {
        let mut data = Vec::new();
        data.extend_from_slice(b"GGUF");
        data.extend_from_slice(&3u32.to_le_bytes());
        data.extend_from_slice(&(tensors.len() as u64).to_le_bytes());
        data.extend_from_slice(&(kv.len() as u64).to_le_bytes());

        for (key, value) in kv {
            push_string(&mut data, key);
            match value {
                TestValue::Bool(value) => {
                    data.extend_from_slice(&7u32.to_le_bytes());
                    data.push(u8::from(*value));
                }
                TestValue::U32(value) => {
                    data.extend_from_slice(&4u32.to_le_bytes());
                    data.extend_from_slice(&value.to_le_bytes());
                }
                TestValue::String(value) => {
                    data.extend_from_slice(&8u32.to_le_bytes());
                    push_string(&mut data, value);
                }
                TestValue::StringArray(values) => {
                    data.extend_from_slice(&9u32.to_le_bytes());
                    data.extend_from_slice(&8u32.to_le_bytes());
                    data.extend_from_slice(&(values.len() as u64).to_le_bytes());
                    for value in *values {
                        push_string(&mut data, value);
                    }
                }
            }
        }

        for tensor in tensors {
            push_string(&mut data, tensor);
            data.extend_from_slice(&1u32.to_le_bytes());
            data.extend_from_slice(&1u64.to_le_bytes());
            data.extend_from_slice(&0u32.to_le_bytes());
            data.extend_from_slice(&0u64.to_le_bytes());
        }

        data
    }

    fn write_test_gguf_at(path: &Path, kv: &[(&str, TestValue<'_>)], tensors: &[&str]) {
        let data = build_test_gguf(kv, tensors);
        let mut file = File::create(path).expect("create synthetic GGUF");
        file.write_all(&data).expect("write synthetic GGUF");
    }

    fn write_test_gguf(kv: &[(&str, TestValue<'_>)], tensors: &[&str]) -> std::path::PathBuf {
        let id = TEST_FILE_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "agent-llm-gguf-parser-{}-{}.gguf",
            std::process::id(),
            id
        ));
        write_test_gguf_at(&path, kv, tensors);
        path
    }

    fn parse_test_gguf(kv: &[(&str, TestValue<'_>)], tensors: &[&str]) -> GgufMetadata {
        let path = write_test_gguf(kv, tensors);
        let parsed = parse_gguf_header(&path).expect("parse synthetic GGUF");
        std::fs::remove_file(path).ok();
        parsed
    }

    /// 构造一个深度嵌套的数组值：连续 `depth` 层「元素类型=9（数组）、元素个数=1」，
    /// 最内层放一个 u32。畸形 GGUF 可以用极小的体积表达极深的嵌套。
    fn nested_array_value(depth: usize) -> Vec<u8> {
        let mut data = Vec::new();
        for _ in 0..depth {
            data.extend_from_slice(&9u32.to_le_bytes()); // 元素类型 = 数组
            data.extend_from_slice(&1u64.to_le_bytes()); // 元素个数 = 1
        }
        data.extend_from_slice(&4u32.to_le_bytes()); // 最内层元素类型 = u32
        data.extend_from_slice(&1u64.to_le_bytes());
        data.extend_from_slice(&7u32.to_le_bytes());
        data
    }

    #[test]
    fn rejects_deeply_nested_arrays_instead_of_overflowing_the_stack() {
        // 每层仅 12 字节，10 万层也只有 1.2MB——足以打爆默认线程栈。
        // 必须返回 Err，而不是递归到栈溢出（栈溢出会直接 abort 进程，Result 拦不住）。
        let payload = nested_array_value(100_000);

        let mut p = 0usize;
        assert!(
            skip(&payload, &mut p, 9).is_err(),
            "skip 必须拒绝超深嵌套数组"
        );

        let mut p = 0usize;
        assert!(
            read_val(&payload, &mut p, 9).is_err(),
            "read_val 必须拒绝超深嵌套数组"
        );
    }

    #[test]
    fn accepts_flat_arrays_after_the_depth_limit() {
        // 深度上限不能把正常的一维数组也挡掉。
        let mut payload = Vec::new();
        payload.extend_from_slice(&4u32.to_le_bytes()); // 元素类型 = u32
        payload.extend_from_slice(&2u64.to_le_bytes()); // 2 个元素
        payload.extend_from_slice(&11u32.to_le_bytes());
        payload.extend_from_slice(&22u32.to_le_bytes());

        let mut p = 0usize;
        assert!(skip(&payload, &mut p, 9).is_ok());
        assert_eq!(p, payload.len());

        let mut p = 0usize;
        let value = read_val(&payload, &mut p, 9).expect("一维数组应正常解析");
        assert_eq!(value, serde_json::json!([11, 22]));
    }

    #[test]
    fn rejects_oversized_array_before_recursing() {
        // 长度字段超过 MAX_ARRAY 时必须先拒绝，不能先递归读取前 10 个元素。
        let mut payload = Vec::new();
        payload.extend_from_slice(&4u32.to_le_bytes());
        payload.extend_from_slice(&(MAX_ARRAY + 1).to_le_bytes());

        let mut p = 0usize;
        assert!(read_val(&payload, &mut p, 9).is_err());
    }

    #[test]
    fn detects_embedded_qwen_mtp() {
        let parsed = parse_test_gguf(
            &[
                ("general.architecture", TestValue::String("qwen35")),
                ("qwen35.block_count", TestValue::U32(33)),
                ("qwen35.embedding_length", TestValue::U32(4096)),
                ("qwen35.vocab_size", TestValue::U32(151_936)),
                ("qwen35.nextn_predict_layers", TestValue::U32(1)),
            ],
            &["blk.0.attn_norm.weight", "blk.32.nextn.eh_proj.weight"],
        );

        assert!(parsed.has_embedded_mtp);
        assert!(!parsed.is_mtp_draft_model);
        assert_eq!(parsed.nextn_predict_layers, 1);
        assert_eq!(parsed.mtp_tensor_count, 1);
        assert_eq!(parsed.vocab_size, Some(151_936));
    }

    #[test]
    fn detects_standalone_qwen_mtp_head() {
        let parsed = parse_test_gguf(
            &[
                ("general.architecture", TestValue::String("qwen35moe")),
                ("qwen35moe.block_count", TestValue::U32(41)),
                ("qwen35moe.embedding_length", TestValue::U32(2048)),
                ("qwen35moe.nextn_predict_layers", TestValue::U32(1)),
            ],
            &["blk.40.nextn.eh_proj.weight"],
        );

        assert!(!parsed.has_embedded_mtp);
        assert!(parsed.is_mtp_draft_model);
    }

    #[test]
    fn detects_gemma4_assistant_as_standalone_mtp_head() {
        let parsed = parse_test_gguf(
            &[
                (
                    "general.architecture",
                    TestValue::String("gemma4-assistant"),
                ),
                ("gemma4-assistant.block_count", TestValue::U32(4)),
                ("gemma4-assistant.embedding_length", TestValue::U32(1024)),
                (
                    "gemma4-assistant.embedding_length_out",
                    TestValue::U32(3840),
                ),
                ("gemma4-assistant.nextn_predict_layers", TestValue::U32(4)),
            ],
            &[
                "blk.0.attn_norm.weight",
                "nextn.pre_projection.weight",
                "nextn.post_projection.weight",
            ],
        );

        assert!(parsed.mtp_architecture_supported);
        assert!(!parsed.has_embedded_mtp);
        assert!(parsed.is_mtp_draft_model);
        assert_eq!(parsed.embedding_length_out, Some(3840));
        assert_eq!(parsed.mtp_tensor_count, 2);
    }

    #[test]
    fn uses_tokenizer_tokens_for_vocab_size_and_fingerprint() {
        let tokens = ["<unk>", "<s>", "</s>", "hello"];
        let parsed = parse_test_gguf(
            &[
                ("general.architecture", TestValue::String("qwen35")),
                ("tokenizer.ggml.tokens", TestValue::StringArray(&tokens)),
            ],
            &[],
        );

        assert_eq!(parsed.vocab_size, Some(tokens.len() as u64));
        assert!(parsed.tokenizer_tokens_hash.is_some());
    }

    #[test]
    fn detects_embedded_mtp_across_split_shards() {
        let id = TEST_FILE_ID.fetch_add(1, Ordering::Relaxed);
        let prefix = format!("agent-llm-split-mtp-{}-{}", std::process::id(), id);
        let shard_1 = std::env::temp_dir().join(format!("{}-00001-of-00002.gguf", prefix));
        let shard_2 = std::env::temp_dir().join(format!("{}-00002-of-00002.gguf", prefix));
        let metadata = [
            ("general.architecture", TestValue::String("qwen35")),
            ("qwen35.block_count", TestValue::U32(33)),
            ("qwen35.nextn_predict_layers", TestValue::U32(1)),
        ];
        write_test_gguf_at(&shard_1, &metadata, &["blk.0.attn_norm.weight"]);
        write_test_gguf_at(
            &shard_2,
            &[
                ("general.architecture", TestValue::String("qwen35")),
                ("qwen35.block_count", TestValue::U32(33)),
                ("qwen35.nextn_predict_layers", TestValue::U32(1)),
            ],
            &["blk.32.nextn.eh_proj.weight"],
        );

        let parsed = parse_gguf_header(&shard_1).expect("parse split MTP GGUF");
        std::fs::remove_file(shard_1).ok();
        std::fs::remove_file(shard_2).ok();

        assert!(parsed.has_embedded_mtp);
        assert!(!parsed.is_mtp_draft_model);
        assert_eq!(parsed.mtp_tensor_count, 1);
    }

    #[test]
    fn does_not_enable_unimplemented_nextn_architecture() {
        let parsed = parse_test_gguf(
            &[
                ("general.architecture", TestValue::String("deepseek2")),
                ("deepseek2.nextn_predict_layers", TestValue::U32(1)),
            ],
            &["blk.0.attn_norm.weight", "blk.60.nextn.eh_proj.weight"],
        );

        assert!(!parsed.mtp_architecture_supported);
        assert!(!parsed.has_embedded_mtp);
        assert!(!parsed.is_mtp_draft_model);
    }

    #[test]
    fn reads_mtmd_projector_capabilities() {
        let parsed = parse_test_gguf(
            &[
                ("general.architecture", TestValue::String("clip")),
                ("clip.has_vision_encoder", TestValue::Bool(true)),
                ("clip.has_audio_encoder", TestValue::Bool(true)),
                (
                    "clip.vision.projector_type",
                    TestValue::String("qwen2.5vl_merger"),
                ),
                ("clip.audio.projector_type", TestValue::String("qwen2a")),
            ],
            &[],
        );

        assert!(parsed.mmproj_supports_vision);
        assert!(parsed.mmproj_supports_audio);
        assert_eq!(
            parsed.mmproj_vision_projector_type.as_deref(),
            Some("qwen2.5vl_merger")
        );
        assert_eq!(
            parsed.mmproj_audio_projector_type.as_deref(),
            Some("qwen2a")
        );
    }

    // These tests require local model files and are ignored by default.
    // Run with: AGENT_LLM_TEST_MODEL_DIR=<目录> cargo test -- --ignored
    fn local_test_dir() -> Option<std::path::PathBuf> {
        let dir = std::env::var("AGENT_LLM_TEST_MODEL_DIR").ok()?;
        let dir = std::path::PathBuf::from(dir.trim());
        dir.is_dir().then_some(dir)
    }

    #[test]
    #[ignore]
    fn test_parse_qwen() {
        let Some(dir) = local_test_dir() else {
            eprintln!("skip: AGENT_LLM_TEST_MODEL_DIR 未设置或不存在");
            return;
        };
        let path = dir.join("Qwen3.5-9B-Uncensored-Q6_K_M.gguf");
        if !path.exists() {
            eprintln!("skip missing local model: {}", path.display());
            return;
        }
        let r = parse_gguf_header(&path);
        assert!(r.is_ok(), "{:?}", r.err());
        let m = r.unwrap();
        println!(
            "arch={} blocks={} nextn={} embedded={} draft={} mtp_tensors={}",
            m.architecture,
            m.block_count,
            m.nextn_predict_layers,
            m.has_embedded_mtp,
            m.is_mtp_draft_model,
            m.mtp_tensor_count
        );
        assert!(m.block_count > 0);
    }

    #[test]
    #[ignore]
    fn test_parse_qwythos_mtp() {
        let Some(dir) = local_test_dir() else {
            eprintln!("skip: AGENT_LLM_TEST_MODEL_DIR 未设置或不存在");
            return;
        };
        let path = dir.join("Qwythos-9B-Claude-Mythos-5-1M-MTP-Q5_K_M.gguf");
        if !path.exists() {
            eprintln!("skip missing local model: {}", path.display());
            return;
        }
        let r = parse_gguf_header(&path);
        assert!(r.is_ok(), "{:?}", r.err());
        let m = r.unwrap();
        println!(
            "arch={} blocks={} nextn={} embedded={} draft={} mtp_tensors={} name={:?}",
            m.architecture,
            m.block_count,
            m.nextn_predict_layers,
            m.has_embedded_mtp,
            m.is_mtp_draft_model,
            m.mtp_tensor_count,
            m.name
        );
    }

    #[test]
    #[ignore]
    fn test_parse_local_mmproj() {
        let Some(dir) = local_test_dir() else {
            eprintln!("skip: AGENT_LLM_TEST_MODEL_DIR 未设置或不存在");
            return;
        };
        let paths = [
            "mmproj-Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-BF16.gguf",
            "mmproj-Gemma4-26B-A4B-Uncensored-HauhauCS-Balanced-f16.gguf",
            "mmproj-Nemotron3-Nano-BF16.gguf",
        ];
        for file_name in paths {
            let path = dir.join(file_name);
            if !path.exists() {
                eprintln!("skip missing local projector: {}", path.display());
                continue;
            }
            let m = parse_gguf_header(&path).expect("parse local projector");
            println!(
                "file={} arch={} vision={} audio={} projector={:?} vision_projector={:?} audio_projector={:?}",
                path.display(),
                m.architecture,
                m.mmproj_supports_vision,
                m.mmproj_supports_audio,
                m.mmproj_projector_type,
                m.mmproj_vision_projector_type,
                m.mmproj_audio_projector_type
            );
            assert!(m.mmproj_supports_vision || m.mmproj_supports_audio);
        }
    }
}
