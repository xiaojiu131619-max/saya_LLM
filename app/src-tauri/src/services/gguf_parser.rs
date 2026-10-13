use std::collections::HashSet;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;
use std::time::UNIX_EPOCH;

use anyhow::{bail, Result};
use sha2::{Digest, Sha256};

use crate::models::model_info::{GgufLayerMemoryLayout, GgufMemoryAccuracy, GgufMemoryLayout};

const BUF_SIZE: u64 = 100 * 1024 * 1024; // 头部上限，按字段读取，不扫描大体积张量数据
const MAX_LAYOUT_LAYERS: u64 = 100_000;
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
    /// `<arch>.pooling_type`：向量模型默认池化方式（mean/cls/last/rank）。
    /// 带此键基本可判定为嵌入/重排模型；`rank` 表示重排模型。
    pub pooling_type: Option<String>,
    /// `<arch>.attention.causal`：false 表示非因果（双向）注意力，典型的编码器
    /// 嵌入模型（bert / nomic-bert / bge 等）为 false。
    pub attention_causal: Option<bool>,
    // Attention head metadata — needed for an accurate KV-cache size estimate.
    pub head_count: Option<u64>,
    pub head_count_kv: Option<u64>,
    /// 全量逐层 KV 头数，必须与 block_count 对齐；0 = SSM/recurrent 层。
    pub kv_heads_by_layer: Option<Vec<u64>>,
    pub swa_layer_pattern: Option<Vec<bool>>,
    pub full_attention_interval: Option<u64>,
    /// 有效逐层 KV 头数的求和；无逐层信息时为 None。
    pub kv_heads_sum: Option<u64>,
    /// SWA 分列求和（仅逐层数组 + 滑窗模式齐备时有值）：pattern=0 全注意力 / pattern≠0 SWA。
    pub kv_heads_sum_full: Option<u64>,
    pub kv_heads_sum_swa: Option<u64>,
    /// 滑动窗口大小与 SWA 层的 K/V 维度（gemma 系），供 KV 公式按窗口估算。
    pub sliding_window: Option<u64>,
    pub key_length_swa: Option<u64>,
    pub value_length_swa: Option<u64>,
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
    pub memory_layout: Option<GgufMemoryLayout>,
    // 分片内部信息仅供完整性校验，不传到前端。
    pub(crate) split_no: Option<u64>,
    pub(crate) split_count: Option<u64>,
    pub(crate) split_tensors_count: Option<u64>,
    pub(crate) tensor_names: Vec<String>,
    pub(crate) layout_source: Option<GgufLayoutSource>,
    pub(crate) kv_heads_array_present: bool,
    // 真实读出的能力信号：来自 HuggingFace 模型卡的 tags 数组（包含 vision / tool-use 等）
    pub tags: Vec<String>,
    // chat_template 原文，用来判断模型是否有工具调用语法
    pub chat_template: Option<String>,
}

/// 只累积元数据和 tensor table。BufReader 最多预读少量数据，避免原先固定
/// 读取文件前 100 MB 时把 tensor payload 一并读入。
struct HeaderReader {
    reader: BufReader<File>,
    buf: Vec<u8>,
    file_len: u64,
}

impl HeaderReader {
    fn take(&mut self, len: u64) -> Result<()> {
        let end = (self.buf.len() as u64)
            .checked_add(len)
            .filter(|end| *end <= BUF_SIZE && *end <= self.file_len)
            .ok_or_else(|| anyhow::anyhow!("GGUF 头部截断或超过 {} MB", BUF_SIZE / 1024 / 1024))?;
        let start = self.buf.len();
        self.buf.resize(end as usize, 0);
        self.reader.read_exact(&mut self.buf[start..])?;
        Ok(())
    }

    fn u32(&mut self) -> Result<u32> {
        self.take(4)?;
        Ok(u32::from_le_bytes(
            self.buf[self.buf.len() - 4..].try_into()?,
        ))
    }

    fn u64(&mut self) -> Result<u64> {
        self.take(8)?;
        Ok(u64::from_le_bytes(
            self.buf[self.buf.len() - 8..].try_into()?,
        ))
    }

    fn string(&mut self) -> Result<()> {
        let len = self.u64()?;
        if len > MAX_STR_LEN {
            bail!("GGUF 字符串过长：{}", len);
        }
        self.take(len)
    }

    fn value(&mut self, ty: u32, depth: u32) -> Result<()> {
        match ty {
            0 | 1 | 7 => self.take(1),
            2 | 3 => self.take(2),
            4..=6 => self.take(4),
            8 => self.string(),
            9 => {
                if depth >= MAX_NEST_DEPTH {
                    bail!("GGUF 数组嵌套过深：{}", depth);
                }
                let element_type = self.u32()?;
                let count = self.u64()?;
                if count > MAX_ARRAY {
                    bail!("GGUF 数组过长：{}", count);
                }
                let width = match element_type {
                    0 | 1 | 7 => Some(1u64),
                    2 | 3 => Some(2),
                    4..=6 => Some(4),
                    10..=12 => Some(8),
                    8 | 9 => None,
                    _ => bail!("GGUF 数组元素类型无效：{}", element_type),
                };
                if let Some(width) = width {
                    self.take(count * width)?;
                } else {
                    for _ in 0..count {
                        self.value(element_type, depth + 1)?;
                    }
                }
                Ok(())
            }
            10..=12 => self.take(8),
            _ => bail!("GGUF 元数据类型无效：{}", ty),
        }
    }
}

fn read_header(file: File, file_len: u64) -> Result<Vec<u8>> {
    let mut reader = HeaderReader {
        reader: BufReader::new(file),
        buf: Vec::new(),
        file_len,
    };
    reader.take(4)?;
    if &reader.buf[..4] != b"GGUF" {
        bail!("文件不是 GGUF");
    }
    let version = reader.u32()?;
    if !matches!(version, 2 | 3) {
        bail!("不支持的 GGUF 版本：{}", version);
    }
    let tensor_count = reader.u64()?;
    let metadata_count = reader.u64()?;
    if tensor_count > file_len / 32 || metadata_count > file_len / 13 {
        bail!("GGUF 头部计数超出文件边界");
    }
    for _ in 0..metadata_count {
        reader.string()?;
        let ty = reader.u32()?;
        reader.value(ty, 0)?;
    }
    for _ in 0..tensor_count {
        reader.string()?;
        let n_dims = reader.u32()?;
        if n_dims > 8 {
            bail!("GGUF 张量维数无效：{}", n_dims);
        }
        reader.take(n_dims as u64 * 8 + 12)?;
    }
    Ok(reader.buf)
}

#[derive(Debug, Clone)]
pub(crate) struct GgufLayoutSource {
    tensors: Vec<TensorDescriptor>,
    header_len: u64,
    file_len: u64,
    alignment: Option<u64>,
    mtime: Option<std::time::Duration>,
    header_hash: [u8; 32],
}

#[derive(Debug, Clone)]
struct TensorDescriptor {
    name: String,
    dims: Vec<u64>,
    tensor_type: u32,
    offset: u64,
}

/// 已知 GGML 量化的 (block 元素数, block 字节数)。未确认的分支/重排类型
/// 故意不猜 bpw，交由 offset 跨度保守估算。
fn ggml_type_layout(tensor_type: u32) -> Option<(u64, u64)> {
    match tensor_type {
        0 | 26 => Some((1, 4)),
        1 | 25 | 30 => Some((1, 2)),
        24 => Some((1, 1)),
        27 | 28 => Some((1, 8)),
        2 | 20 => Some((32, 18)),
        3 => Some((32, 20)),
        6 => Some((32, 22)),
        7 => Some((32, 24)),
        8 => Some((32, 34)),
        9 => Some((32, 36)),
        10 => Some((256, 84)),
        11 => Some((256, 110)),
        12 => Some((256, 144)),
        13 => Some((256, 176)),
        14 => Some((256, 210)),
        15 => Some((256, 292)),
        16 => Some((256, 66)),
        17 => Some((256, 74)),
        18 => Some((256, 98)),
        19 => Some((256, 50)),
        21 => Some((256, 110)),
        22 => Some((256, 82)),
        23 => Some((256, 136)),
        29 => Some((256, 56)),
        34 => Some((256, 54)),
        35 => Some((256, 66)),
        39 => Some((32, 17)),
        _ => None,
    }
}

fn tensor_byte_size(tensor: &TensorDescriptor) -> Result<Option<u64>> {
    let Some(&first_dim) = tensor.dims.first() else {
        bail!("GGUF 张量没有维度");
    };
    let elements = tensor.dims.iter().try_fold(1u64, |count, dim| {
        if *dim == 0 {
            bail!("GGUF 张量维度为零");
        }
        count
            .checked_mul(*dim)
            .ok_or_else(|| anyhow::anyhow!("GGUF 张量维度溢出"))
    })?;
    let Some((block, bytes)) = ggml_type_layout(tensor.tensor_type) else {
        return Ok(None);
    };
    if first_dim % block != 0 {
        bail!("GGUF 量化张量行宽与 block 不对齐");
    }
    Ok(Some(
        elements
            .checked_div(block)
            .and_then(|n| n.checked_mul(bytes))
            .ok_or_else(|| anyhow::anyhow!("GGUF 张量字节数溢出"))?,
    ))
}

fn build_memory_layout(
    tensors: &[TensorDescriptor],
    block_count: u64,
    header_len: u64,
    file_len: u64,
    alignment: u64,
    mtime: Option<std::time::Duration>,
    header_hash: [u8; 32],
) -> Option<GgufMemoryLayout> {
    if tensors.is_empty()
        || block_count == 0
        || block_count > MAX_LAYOUT_LAYERS
        || alignment == 0
        || !alignment.is_power_of_two()
    {
        return None;
    }
    let data_start = header_len.checked_add(alignment - 1)? / alignment * alignment;
    let data_len = file_len.checked_sub(data_start)?;
    let mut ordered: Vec<_> = tensors.iter().collect();
    ordered.sort_by_key(|tensor| tensor.offset);
    // 第一张量前出现未描述的数据时，布局无法覆盖整个 tensor data 区域。
    if ordered.first()?.offset != 0 {
        return None;
    }
    let mut names = HashSet::new();
    let mut layout = GgufMemoryLayout {
        version: 1,
        layers: vec![GgufLayerMemoryLayout::default(); block_count as usize],
        input_bytes: 0,
        output_bytes: 0,
        other_bytes: 0,
        total_bytes: 0,
        signature: String::new(),
        accuracy: GgufMemoryAccuracy::Exact,
        tied_output: tensors
            .iter()
            .any(|tensor| tensor.name == "token_embd.weight")
            && !tensors.iter().any(|tensor| tensor.name == "output.weight"),
    };
    let mut hasher = Sha256::new();
    hasher.update(b"agentllm.gguf.memory_layout.v1");
    hasher.update(file_len.to_le_bytes());
    hasher.update(data_start.to_le_bytes());
    hasher.update(alignment.to_le_bytes());
    hasher.update(block_count.to_le_bytes());
    hasher.update(header_hash);
    hasher.update([u8::from(mtime.is_some())]);
    if let Some(mtime) = mtime {
        hasher.update(mtime.as_secs().to_le_bytes());
        hasher.update(mtime.subsec_nanos().to_le_bytes());
    }
    for (index, tensor) in ordered.iter().enumerate() {
        if tensor.name.is_empty()
            || tensor.name.contains('\u{fffd}')
            || tensor.name.contains('\0')
            || !names.insert(&tensor.name)
            || tensor.offset % alignment != 0
            || tensor.offset >= data_len
        {
            return None;
        }
        let next_offset = ordered.get(index + 1).map_or(data_len, |next| next.offset);
        let span = next_offset
            .checked_sub(tensor.offset)
            .filter(|span| *span > 0)?;
        let exact = tensor_byte_size(tensor).ok()?;
        if exact.is_some_and(|bytes| bytes > span) {
            return None;
        }
        // 已知类型一律使用真实 payload 尺寸，排除所有 alignment padding/footer。
        // 未知类型使用完整跨度：对齐 padding 通常每张量多计至多 alignment - 1
        // 字节，末张量可能包含 footer，明确标记 upper_bound。
        let bytes = exact.unwrap_or(span);
        if exact.is_none() {
            layout.accuracy = GgufMemoryAccuracy::UpperBound;
        }
        if tensor.name.starts_with("blk.") {
            let block = tensor_block_index(&tensor.name)?;
            let layer = layout.layers.get_mut(usize::try_from(block).ok()?)?;
            layer.weight_bytes = layer.weight_bytes.checked_add(bytes)?;
            // 对齐 -ncmoe 的 ffn_(up|down|gate).*_exps 匹配；ffn_*_shexp
            // 共享专家、ffn_gate_inp 路由器以及其它 block 张量仍计 GPU 权重。
            let suffix = tensor.name.splitn(3, '.').nth(2)?;
            if ["ffn_gate", "ffn_up", "ffn_down"].iter().any(|prefix| {
                suffix
                    .strip_prefix(prefix)
                    .is_some_and(|rest| rest.contains("_exps"))
            }) {
                layer.expert_bytes = layer.expert_bytes.checked_add(bytes)?;
            }
        } else if tensor.name.starts_with("token_embd.") {
            layout.input_bytes = layout.input_bytes.checked_add(bytes)?;
        } else if tensor.name.starts_with("output.") || tensor.name.starts_with("output_norm.") {
            layout.output_bytes = layout.output_bytes.checked_add(bytes)?;
        } else {
            layout.other_bytes = layout.other_bytes.checked_add(bytes)?;
        }
        layout.total_bytes = layout.total_bytes.checked_add(bytes)?;
        hasher.update((tensor.name.len() as u64).to_le_bytes());
        hasher.update(tensor.name.as_bytes());
        hasher.update((tensor.dims.len() as u64).to_le_bytes());
        for dim in &tensor.dims {
            hasher.update(dim.to_le_bytes());
        }
        hasher.update(tensor.tensor_type.to_le_bytes());
        hasher.update(tensor.offset.to_le_bytes());
    }
    hasher.update([u8::from(layout.accuracy == GgufMemoryAccuracy::UpperBound)]);
    hasher.update([u8::from(layout.tied_output)]);
    layout.signature = format!("{:x}", hasher.finalize());
    Some(layout)
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
    let file = File::open(path)?;
    let file_metadata = file.metadata()?;
    let file_len = file_metadata.len();
    let mtime = file_metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok());
    let buf = read_header(file, file_len)?;
    let header_hash: [u8; 32] = Sha256::digest(&buf).into();

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
    // 混合架构（nemotron_h_moe / lfm2 / gemma4 等）把 head_count_kv 写成逐层数组：
    // 非 0 = 该层 KV 头数，0 = Mamba 等无 KV 层。逐层读全量后求和（read_val 只
    // 物化前 10 个元素，不能用它算），供 KV 显存估算直接使用。
    let mut kv_heads_layers: Option<Vec<u64>> = None;
    // gemma 系逐层滑动窗口模式（1 = SWA 层、0 = 全注意力层），用于把 KV 头
    // 按「全 ctx / 滑窗」两类分开求和——SWA 层的 KV 只按窗口大小分配。
    let mut swa_pattern_layers: Option<Vec<u64>> = None;
    let mut swa_window: Option<u64> = None;
    let mut klen_swa: Option<u64> = None;
    let mut vlen_swa: Option<u64> = None;
    let mut klen: Option<u64> = None;
    let mut vlen: Option<u64> = None;
    let mut pooling_type: Option<String> = None;
    let mut attention_causal: Option<bool> = None;
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
    let mut metadata_keys = HashSet::new();
    let mut alignment = Some(32u64);
    let mut split_no = None;
    let mut split_count = None;
    let mut split_tensors_count = None;
    let mut full_attention_interval = None;
    let mut layout_metadata_valid = true;

    for _ in 0..kvn {
        if p >= buf.len() {
            bail!("GGUF metadata exceeds {} MB", BUF_SIZE / 1024 / 1024);
        }
        let key = rstr(&buf, &mut p)?;
        if key.contains('\u{fffd}') || !metadata_keys.insert(key.clone()) {
            bail!("GGUF 元数据键无效或重复：{}", key);
        }
        let ty = r32(&buf, &mut p)?;

        if key == "tokenizer.ggml.tokens" {
            let (token_count, token_hash) = read_tokenizer_tokens(&buf, &mut p, ty)?;
            vocab_size.get_or_insert(token_count);
            tokenizer_tokens_hash = Some(token_hash);
            entries.push((key, format!("array[{}]", token_count)));
            continue;
        }

        let keep = key.starts_with("general.")
            || key.starts_with("split.")
            || key.contains(".ssm.")
            || key.starts_with("ssm.")
            || key.ends_with(".full_attention_interval")
            || key.ends_with(".block_count")
            || key.ends_with(".context_length")
            || key.ends_with(".embedding_length")
            || key.ends_with(".embedding_length_out")
            || key.ends_with(".vocab_size")
            || key.ends_with(".expert_count")
            || key.ends_with(".expert_used_count")
            || key.ends_with(".attention.head_count")
            || key.ends_with(".attention.head_count_kv")
            || key.ends_with(".attention.sliding_window_pattern")
            || key.ends_with(".attention.sliding_window")
            || key.ends_with(".attention.key_length")
            || key.ends_with(".attention.key_length_swa")
            || key.ends_with(".attention.value_length")
            || key.ends_with(".attention.value_length_swa")
            || key.ends_with(".attention.causal")
            || key.ends_with(".pooling_type")
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
            || key == "clip.vision.projection_dim"
            || key == "clip.audio.projection_dim"
            || key == "clip.projector_type"
            || key == "clip.vision.projector_type"
            || key == "clip.audio.projector_type";

        if !keep {
            skip(&buf, &mut p, ty)?;
            continue;
        }

        // 逐层数组键不走 read_val——它只物化前 10 个元素，逐层求和/分类必须读
        // 全量。直接从缓冲区逐元素读出后 continue，也避免把大数组整体物化。
        if ty == 9
            && (key.ends_with(".attention.head_count_kv")
                || key.ends_with(".attention.sliding_window_pattern"))
        {
            let et = r32(&buf, &mut p)?;
            let cnt = r64(&buf, &mut p)?;
            if cnt > MAX_ARRAY {
                bail!("array {}", cnt);
            }
            // 仅接受数值元素（滑窗模式实际是 bool 数组，et=7）；其余类型按元素
            // 跳过并放弃该键。
            let numeric = matches!(et, 0 | 1 | 2 | 3 | 4 | 5 | 7 | 10 | 11);
            let mut vals: Vec<u64> = Vec::with_capacity(cnt.min(1024) as usize);
            let mut valid = numeric;
            for _ in 0..cnt {
                if !numeric {
                    skip(&buf, &mut p, et)?;
                    continue;
                }
                let value = read_val(&buf, &mut p, et)?;
                let n = value.as_u64().or_else(|| value.as_bool().map(u64::from));
                if let Some(n) = n {
                    vals.push(n);
                } else {
                    // 负头数不能静默夹成 0，也不能把 u64 转 i64 截断。
                    valid = false;
                }
            }
            // 数组内容已从缓冲区消费完毕，无论元素类型都直接进入下一个键。
            entries.push((key.clone(), format!("array[{}]", cnt)));
            if key.ends_with(".attention.head_count_kv") {
                // 无效数组也保留“键存在”信号，避免再用标量公式冒充有效向量。
                kv_heads_layers = Some(if valid { vals } else { Vec::new() });
            } else {
                swa_pattern_layers = Some(if valid { vals } else { Vec::new() });
            }
            continue;
        }

        let v = read_val(&buf, &mut p, ty)?;
        if let Some(value) = value_to_string(&v) {
            entries.push((key.clone(), value));
        }

        match key.as_str() {
            "general.alignment" => alignment = v.as_u64(),
            "split.no" => {
                split_no = v.as_u64();
                layout_metadata_valid &= split_no.is_some();
            }
            "split.count" => {
                split_count = v.as_u64();
                layout_metadata_valid &= split_count.is_some_and(|count| count > 0);
            }
            "split.tensors.count" => {
                split_tensors_count = v.as_u64();
                layout_metadata_valid &= split_tensors_count.is_some();
            }
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
                    // 逐层数组已在 read_val 之前截获处理；这里只剩标量形式。
                    hckv = v.as_u64();
                } else if key.ends_with(".attention.sliding_window") {
                    swa_window = v.as_u64();
                } else if key.ends_with(".attention.key_length_swa") {
                    klen_swa = v.as_u64();
                } else if key.ends_with(".attention.value_length_swa") {
                    vlen_swa = v.as_u64();
                } else if key.ends_with(".attention.key_length") {
                    klen = v.as_u64();
                } else if key.ends_with(".attention.value_length") {
                    vlen = v.as_u64();
                } else if key.ends_with(".full_attention_interval") {
                    full_attention_interval = v.as_u64();
                } else if key.ends_with(".attention.causal") {
                    attention_causal = v.as_bool();
                } else if key.ends_with(".pooling_type") {
                    // GGUF 里 pooling_type 既可能是字符串（mean/cls/last/rank），
                    // 也可能是枚举整数；两种都归一成小写字符串，未知枚举值留空。
                    pooling_type = v
                        .as_str()
                        .map(|s| s.to_ascii_lowercase())
                        .or_else(|| v.as_u64().and_then(pooling_type_from_id));
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
    let mut tensors = Vec::new();
    for _ in 0..tensor_count {
        if p >= buf.len() {
            bail!("GGUF tensor table exceeds {} MB", BUF_SIZE / 1024 / 1024);
        }
        let name = rstr(&buf, &mut p)?;
        let n_dims = r32(&buf, &mut p)?;
        if n_dims > 8 {
            bail!("tensor dims {}", n_dims);
        }
        let mut dims = Vec::with_capacity(n_dims as usize);
        for _ in 0..n_dims {
            dims.push(r64(&buf, &mut p)?);
        }
        let tensor_type = r32(&buf, &mut p)?;
        let offset = r64(&buf, &mut p)?;
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
        tensors.push(TensorDescriptor {
            name,
            dims,
            tensor_type,
            offset,
        });
    }
    if !layout_metadata_valid {
        alignment = None;
    }
    let memory_layout = alignment.and_then(|alignment| {
        build_memory_layout(
            &tensors,
            blk,
            p as u64,
            file_len,
            alignment,
            mtime,
            header_hash,
        )
    });
    let tensor_names = tensors.iter().map(|tensor| tensor.name.clone()).collect();
    let layout_source = if blk == 0 && split_count.is_some_and(|count| count > 1) {
        // 标准后续分片可能只有 split.*：保留描述，待首片给出 block_count 后估算。
        Some(GgufLayoutSource {
            tensors,
            header_len: p as u64,
            file_len,
            alignment,
            mtime,
            header_hash,
        })
    } else {
        None
    };

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

    // 全量数组先按 block_count 校验；分片中的实际 KV/SSM 张量证据须待合并后再用。
    let kv_heads_array_present = kv_heads_layers.is_some();
    let kv_heads_by_layer = kv_heads_layers.filter(|values| {
        blk > 0
            && blk <= MAX_LAYOUT_LAYERS
            && values.len() as u64 == blk
            && values
                .iter()
                .try_fold(0u64, |sum, value| sum.checked_add(*value))
                .is_some()
    });
    let swa_layer_pattern = swa_pattern_layers
        .filter(|values| blk > 0 && blk <= MAX_LAYOUT_LAYERS && values.len() as u64 == blk)
        .map(|values| values.into_iter().map(|value| value != 0).collect());

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
        pooling_type,
        attention_causal,
        head_count: hc,
        head_count_kv: hckv,
        kv_heads_by_layer,
        swa_layer_pattern,
        full_attention_interval,
        kv_heads_sum: None,
        kv_heads_sum_full: None,
        kv_heads_sum_swa: None,
        sliding_window: swa_window,
        key_length_swa: klen_swa,
        value_length_swa: vlen_swa,
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
        memory_layout,
        split_no,
        split_count,
        split_tensors_count,
        tensor_names,
        layout_source,
        kv_heads_array_present,
        tags,
        chat_template,
    })
}

// 以实际部署内核二进制（resources/llama.dll）中的 "<ARCH> MTP" 断言标记为准，
// 而非 third_party/llama-agent 源码检出（两者版本不一致，源码无 MTP graph 的架构
// 可能在部署内核中已实现，反之亦然）。
// 已验证标记：COHERE2MOE / DEEPSEEK32 / DEEPSEEK4 / GLM4 / GLM_DSA / HY_V3 / MIMO2 /
// NEMOTRON_H_MOE / QWEN35 / QWEN35MOE / QWEN3NEXT / STEP35，另加 gemma4-assistant
// （官方独立草稿架构）。glm4moe/exaone4/exaone-moe/bailingmoe2 在部署内核中无
// MTP 标记，不列入；deepseek2（DeepSeek V2/V3 老 norm）同样无标记。
fn supports_mtp_graph(architecture: &str) -> bool {
    matches!(
        architecture,
        "cohere2moe"
            | "deepseek32"
            | "deepseek4"
            | "gemma4"
            | "gemma4-assistant"
            | "glm-dsa"
            | "glm4"
            | "hy-v3"
            | "mimo2"
            | "nemotron_h_moe"
            | "qwen35"
            | "qwen35moe"
            | "qwen3next"
            | "step35"
    )
}

// gemma4 主模型不含内嵌 MTP：它通过与独立的 gemma4-assistant 草稿配对使用 MTP，
// 因此不在此列；其余支持 MTP graph 的架构均可用内嵌 NextN 层或同架构独立草稿。
fn supports_embedded_or_same_arch_mtp(architecture: &str) -> bool {
    matches!(
        architecture,
        "cohere2moe"
            | "deepseek32"
            | "deepseek4"
            | "glm-dsa"
            | "glm4"
            | "hy-v3"
            | "mimo2"
            | "nemotron_h_moe"
            | "qwen35"
            | "qwen35moe"
            | "qwen3next"
            | "step35"
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

/// pooling_type 枚举整数 → 名称（对齐 llama.cpp 的 enum llama_pooling_type：
/// UNSPECIFIED=-1, NONE=0, MEAN=1, CLS=2, LAST=3, RANK=4）。
/// 未知 id 返回 None（表示「无池化信息」），不要把 UNSPECIFIED 的语义套到未知值上。
fn pooling_type_from_id(id: u64) -> Option<String> {
    match id {
        0 => Some("none".to_string()),
        1 => Some("mean".to_string()),
        2 => Some("cls".to_string()),
        3 => Some("last".to_string()),
        4 => Some("rank".to_string()),
        _ => None,
    }
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

fn refresh_kv_metadata(metadata: &mut GgufMetadata, complete_tensors: bool) {
    let layer_count = metadata.block_count;
    metadata.kv_heads_by_layer = metadata.kv_heads_by_layer.take().filter(|heads| {
        layer_count > 0
            && layer_count <= MAX_LAYOUT_LAYERS
            && heads.len() as u64 == layer_count
            && heads
                .iter()
                .try_fold(0u64, |sum, value| sum.checked_add(*value))
                .is_some()
    });
    metadata.swa_layer_pattern = metadata
        .swa_layer_pattern
        .take()
        .filter(|pattern| layer_count > 0 && pattern.len() as u64 == layer_count);
    let hybrid_qwen = matches!(
        metadata.architecture.as_str(),
        "qwen35" | "qwen35moe" | "qwen3next"
    );
    if hybrid_qwen && layer_count > 0 && layer_count <= MAX_LAYOUT_LAYERS {
        let mut attention = vec![false; layer_count as usize];
        let mut recurrent = vec![false; layer_count as usize];
        for name in &metadata.tensor_names {
            let Some(block) = tensor_block_index(name).filter(|block| *block < layer_count) else {
                continue;
            };
            let suffix = name.splitn(3, '.').nth(2).unwrap_or_default();
            if matches!(suffix, "attn_k.weight" | "attn_kv.weight") {
                attention[block as usize] = true;
            }
            if suffix.starts_with("ssm_") || suffix.starts_with("ssm.") {
                recurrent[block as usize] = true;
            }
        }
        if !metadata.kv_heads_array_present {
            // 只对已知 Qwen 混合架构应用 (层号 + 1) % interval == 0。
            // 显式数组优先；NextN 层用 tensor 证据，不能套主模型的周期公式。
            metadata.kv_heads_by_layer = metadata.head_count_kv.and_then(|heads| {
                let interval = metadata
                    .full_attention_interval
                    .filter(|interval| *interval > 0);
                if interval.is_none()
                    && (!complete_tensors
                        || !(0..layer_count as usize)
                            .all(|index| attention[index] != recurrent[index]))
                {
                    return None;
                }
                let main_layers = layer_count.checked_sub(metadata.nextn_predict_layers)?;
                let mut values = Vec::with_capacity(layer_count as usize);
                for index in 0..layer_count {
                    let full = if index < main_layers {
                        interval.map_or(attention[index as usize], |interval| {
                            (index + 1) % interval == 0
                        })
                    } else if complete_tensors
                        && attention[index as usize] != recurrent[index as usize]
                    {
                        attention[index as usize]
                    } else {
                        return None;
                    };
                    values.push(if full { heads } else { 0 });
                }
                values
                    .iter()
                    .try_fold(0u64, |sum, value| sum.checked_add(*value))?;
                Some(values)
            });
        }
        if let Some(heads) = &metadata.kv_heads_by_layer {
            // 实际 tensor 与元数据冲突时不输出貌似有效的 KV 向量。
            let valid = heads.iter().enumerate().all(|(index, heads)| {
                if attention[index] && recurrent[index] {
                    return false;
                }
                (!attention[index] || *heads > 0) && (!recurrent[index] || *heads == 0)
            });
            if !valid {
                metadata.kv_heads_by_layer = None;
            }
        }
    }
    if !hybrid_qwen
        && !metadata.kv_heads_array_present
        && complete_tensors
        && layer_count > 0
        && layer_count <= MAX_LAYOUT_LAYERS
        && metadata.full_attention_interval.is_none()
        && !metadata
            .metadata_entries
            .iter()
            .any(|(key, _)| key.contains(".ssm.") || key.starts_with("ssm."))
    {
        // dense 标量只在全部层都有注意力张量、且没有 recurrent 信号时展开。
        // qkv 对 dense 是有效证据；Qwen 混合层仍由上面的专用逻辑判定。
        let mut attention = vec![false; layer_count as usize];
        let mut has_recurrent = false;
        for name in &metadata.tensor_names {
            let Some(block) = tensor_block_index(name).filter(|block| *block < layer_count) else {
                continue;
            };
            let suffix = name.splitn(3, '.').nth(2).unwrap_or_default();
            if matches!(
                suffix,
                "attn_k.weight" | "attn_kv.weight" | "attn_qkv.weight"
            ) {
                attention[block as usize] = true;
            }
            has_recurrent |= suffix.starts_with("ssm_") || suffix.starts_with("ssm.");
        }
        if !has_recurrent && attention.iter().all(|has_attention| *has_attention) {
            metadata.kv_heads_by_layer = metadata
                .head_count_kv
                .filter(|heads| *heads > 0)
                .filter(|heads| heads.checked_mul(layer_count).is_some())
                .map(|heads| vec![heads; layer_count as usize]);
        }
    }
    metadata.kv_heads_sum = metadata.kv_heads_by_layer.as_ref().and_then(|heads| {
        heads
            .iter()
            .try_fold(0u64, |sum, value| sum.checked_add(*value))
    });
    metadata.kv_heads_sum_full = None;
    metadata.kv_heads_sum_swa = None;
    if let (Some(heads), Some(pattern)) = (&metadata.kv_heads_by_layer, &metadata.swa_layer_pattern)
    {
        let sums =
            heads
                .iter()
                .zip(pattern)
                .try_fold((0u64, 0u64), |(full, swa), (heads, is_swa)| {
                    if *is_swa {
                        Some((full, swa.checked_add(*heads)?))
                    } else {
                        Some((full.checked_add(*heads)?, swa))
                    }
                });
        if let Some((full, swa)) = sums {
            metadata.kv_heads_sum_full = Some(full);
            metadata.kv_heads_sum_swa = Some(swa);
        }
    }
}

fn fold_memory_layout(shards: &[GgufMetadata], expected_count: u32) -> Option<GgufMemoryLayout> {
    if shards.len() != expected_count as usize {
        return None;
    }
    let first = shards.first()?;
    let mut layout = first.memory_layout.clone()?;
    let mut names = HashSet::new();
    let mut tensors_count = 0u64;
    let mut hasher = Sha256::new();
    hasher.update(b"agentllm.gguf.memory_layout.split.v1");
    hasher.update(expected_count.to_le_bytes());
    for (index, shard) in shards.iter().enumerate() {
        let part = shard.memory_layout.as_ref()?;
        if shard.block_count != first.block_count
            || shard.architecture != first.architecture
            || part.layers.len() != layout.layers.len()
            || part.version != 1
            || shard.split_no.is_some_and(|number| number != index as u64)
            || shard
                .split_count
                .is_some_and(|count| count != expected_count as u64)
        {
            return None;
        }
        for name in &shard.tensor_names {
            if !names.insert(name) {
                return None;
            }
        }
        tensors_count = tensors_count.checked_add(shard.tensor_count)?;
        hasher.update((index as u64).to_le_bytes());
        hasher.update((part.signature.len() as u64).to_le_bytes());
        hasher.update(part.signature.as_bytes());
        if part.accuracy == GgufMemoryAccuracy::UpperBound {
            layout.accuracy = GgufMemoryAccuracy::UpperBound;
        }
        if index == 0 {
            continue;
        }
        for (layer, extra) in layout.layers.iter_mut().zip(&part.layers) {
            layer.weight_bytes = layer.weight_bytes.checked_add(extra.weight_bytes)?;
            layer.expert_bytes = layer.expert_bytes.checked_add(extra.expert_bytes)?;
        }
        layout.input_bytes = layout.input_bytes.checked_add(part.input_bytes)?;
        layout.output_bytes = layout.output_bytes.checked_add(part.output_bytes)?;
        layout.other_bytes = layout.other_bytes.checked_add(part.other_bytes)?;
        layout.total_bytes = layout.total_bytes.checked_add(part.total_bytes)?;
    }
    if shards.iter().any(|shard| {
        shard
            .split_tensors_count
            .is_some_and(|count| count != tensors_count)
    }) {
        return None;
    }
    layout.tied_output = names
        .iter()
        .any(|name| name.as_str() == "token_embd.weight")
        && !names.iter().any(|name| name.as_str() == "output.weight");
    hasher.update([u8::from(layout.accuracy == GgufMemoryAccuracy::UpperBound)]);
    hasher.update([u8::from(layout.tied_output)]);
    layout.signature = format!("{:x}", hasher.finalize());
    Some(layout)
}

pub fn parse_gguf_header(path: &Path) -> Result<GgufMetadata> {
    let mut metadata = parse_gguf_header_single(path)?;
    let Some((prefix, part_number, count)) = split_gguf_info(path) else {
        let complete = metadata.split_count.unwrap_or(1) == 1
            && metadata.split_no.unwrap_or(0) == 0
            && metadata
                .split_tensors_count
                .map_or(true, |count| count == metadata.tensor_count);
        if !complete {
            metadata.memory_layout = None;
        }
        refresh_kv_metadata(&mut metadata, complete);
        return Ok(metadata);
    };
    let Some(parent) = path.parent() else {
        metadata.memory_layout = None;
        refresh_kv_metadata(&mut metadata, false);
        return Ok(metadata);
    };
    if count == 0 || part_number == 0 || part_number > count {
        metadata.memory_layout = None;
        refresh_kv_metadata(&mut metadata, false);
        return Ok(metadata);
    }
    let mut shards = Vec::new();
    let mut complete = true;
    for part in 1..=count {
        if part == part_number {
            shards.push(metadata.clone());
            continue;
        }
        let shard = parent.join(format!(
            "{}-{:05}-of-{:05}.{}",
            prefix,
            part,
            count,
            path.extension()
                .and_then(|ext| ext.to_str())
                .unwrap_or("gguf")
        ));
        match parse_gguf_header_single(&shard) {
            Ok(shard_metadata) => shards.push(shard_metadata),
            Err(_) => complete = false,
        }
    }
    if complete {
        let first_arch = shards[0].architecture.clone();
        let first_block_count = shards[0].block_count;
        for shard in &mut shards {
            if let Some(source) = shard.layout_source.take() {
                if shard.architecture == "unknown" {
                    shard.architecture = first_arch.clone();
                }
                shard.block_count = first_block_count;
                shard.memory_layout = source.alignment.and_then(|alignment| {
                    build_memory_layout(
                        &source.tensors,
                        first_block_count,
                        source.header_len,
                        source.file_len,
                        alignment,
                        source.mtime,
                        source.header_hash,
                    )
                });
            }
        }
        metadata = shards[0].clone();
    }
    metadata.memory_layout = if complete {
        fold_memory_layout(&shards, count)
    } else {
        None
    };
    let mut names = Vec::new();
    let mut mtp_count = 0u64;
    let mut tensor_count = 0u64;
    let mut type_counts: Vec<(String, u64)> = Vec::new();
    for shard in &shards {
        metadata.has_main_model_tensors |= shard.has_main_model_tensors;
        names.extend(shard.tensor_names.iter().cloned());
        mtp_count = mtp_count.saturating_add(shard.mtp_tensor_count);
        tensor_count = tensor_count.saturating_add(shard.tensor_count);
        for (kind, count) in &shard.tensor_type_summary {
            if let Some((_, total)) = type_counts.iter_mut().find(|(name, _)| name == kind) {
                *total = total.saturating_add(*count);
            } else {
                type_counts.push((kind.clone(), *count));
            }
        }
    }
    metadata.tensor_names = names;
    metadata.mtp_tensor_count = mtp_count;
    if complete {
        metadata.tensor_count = tensor_count;
        type_counts.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        metadata.tensor_type_summary = type_counts;
    }
    refresh_mtp_classification(&mut metadata);
    refresh_kv_metadata(&mut metadata, complete);
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
        // 143 = PTQ1_0：PRISM 分支（Hadamard 三值量化，约 1.75 bpw）专有张量类型。
        // 上游 llama.cpp 的类型表只到 42，官方内核读到此类型会直接
        // "invalid ggml type 143. should be in [0, 43)" 拒绝加载；
        // 只有带 PTQ1_0 kernel 的自编译核心（如 llama-prism）能读。
        143 => "PTQ1_0",
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
        U64Array(&'a [u64]),
        I32Array(&'a [i32]),
        BoolArray(&'a [bool]),
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
                TestValue::U64Array(values) => {
                    data.extend_from_slice(&9u32.to_le_bytes());
                    data.extend_from_slice(&10u32.to_le_bytes());
                    data.extend_from_slice(&(values.len() as u64).to_le_bytes());
                    for value in *values {
                        data.extend_from_slice(&value.to_le_bytes());
                    }
                }
                TestValue::I32Array(values) => {
                    data.extend_from_slice(&9u32.to_le_bytes());
                    data.extend_from_slice(&5u32.to_le_bytes());
                    data.extend_from_slice(&(values.len() as u64).to_le_bytes());
                    for value in *values {
                        data.extend_from_slice(&value.to_le_bytes());
                    }
                }
                TestValue::BoolArray(values) => {
                    data.extend_from_slice(&9u32.to_le_bytes());
                    data.extend_from_slice(&7u32.to_le_bytes());
                    data.extend_from_slice(&(values.len() as u64).to_le_bytes());
                    for value in *values {
                        data.push(u8::from(*value));
                    }
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

        for (index, tensor) in tensors.iter().enumerate() {
            push_string(&mut data, tensor);
            data.extend_from_slice(&1u32.to_le_bytes());
            data.extend_from_slice(&1u64.to_le_bytes());
            data.extend_from_slice(&0u32.to_le_bytes());
            data.extend_from_slice(&(index as u64 * 32).to_le_bytes());
        }
        if !tensors.is_empty() {
            let start = (data.len() + 31) / 32 * 32;
            data.resize(start + (tensors.len() - 1) * 32 + 4, 0);
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

    /// 使用小型合成 payload 检查 offset/量化边界；生产解析只读取头部。
    fn parse_layout_bytes(data: &[u8]) -> Result<GgufMetadata> {
        let id = TEST_FILE_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "agent-llm-layout-{}-{}.gguf",
            std::process::id(),
            id
        ));
        std::fs::write(&path, data).expect("写入合成 GGUF");
        let parsed = parse_gguf_header(&path);
        std::fs::remove_file(path).ok();
        parsed
    }

    fn build_layout_gguf(
        kv: &[(&str, TestValue<'_>)],
        tensors: &[(&str, &[u64], u32, u64)],
        payload_len: usize,
    ) -> Vec<u8> {
        let mut data = build_test_gguf(kv, &[]);
        data[8..16].copy_from_slice(&(tensors.len() as u64).to_le_bytes());
        for (name, dims, tensor_type, offset) in tensors {
            push_string(&mut data, name);
            data.extend_from_slice(&(dims.len() as u32).to_le_bytes());
            for dim in *dims {
                data.extend_from_slice(&dim.to_le_bytes());
            }
            data.extend_from_slice(&tensor_type.to_le_bytes());
            data.extend_from_slice(&offset.to_le_bytes());
        }
        let data_start = (data.len() + 31) / 32 * 32;
        data.resize(data_start + payload_len, 0);
        data
    }

    #[test]
    fn memory_layout_classifies_experts_shared_input_and_output() {
        let kv = [
            ("general.architecture", TestValue::String("qwen35moe")),
            ("qwen35moe.block_count", TestValue::U32(2)),
        ];
        let tensors = [
            ("token_embd.weight", &[1u64][..], 0, 0),
            ("blk.0.attn_q.weight", &[1u64][..], 0, 32),
            ("blk.0.ffn_gate_exps.weight", &[32u64][..], 2, 64),
            ("blk.0.ffn_up_exps.weight", &[32u64][..], 2, 96),
            ("blk.0.ffn_down_exps.weight", &[32u64][..], 2, 128),
            ("blk.0.ffn_up_shexp.weight", &[1u64][..], 0, 160),
            ("blk.0.ffn_gate_inp.weight", &[1u64][..], 0, 192),
            ("blk.1.ffn_gate_up_exps.weight", &[32u64][..], 2, 224),
            ("blk.1.ffn_down_shexp.weight", &[1u64][..], 0, 256),
            ("output.weight", &[1u64][..], 0, 288),
            ("output_norm.weight", &[1u64][..], 0, 320),
            ("pos_embd.weight", &[32u64][..], 2, 352),
        ];
        let layout = parse_layout_bytes(&build_layout_gguf(&kv, &tensors, 400))
            .unwrap()
            .memory_layout
            .unwrap();
        assert_eq!(layout.version, 1);
        assert_eq!(
            layout.layers,
            vec![
                GgufLayerMemoryLayout {
                    weight_bytes: 66,
                    expert_bytes: 54
                },
                GgufLayerMemoryLayout {
                    weight_bytes: 22,
                    expert_bytes: 18
                },
            ]
        );
        assert_eq!(
            (layout.input_bytes, layout.output_bytes, layout.other_bytes),
            (4, 8, 18)
        );
        assert_eq!(layout.total_bytes, 118);
        assert_eq!(layout.accuracy, GgufMemoryAccuracy::Exact);
        assert!(!layout.tied_output);
        assert_eq!(layout.signature.len(), 64);
    }

    #[test]
    fn memory_layout_unknown_quant_uses_conservative_span() {
        let kv = [
            ("general.architecture", TestValue::String("llama")),
            ("llama.block_count", TestValue::U32(1)),
        ];
        let tensors = [("blk.0.custom.weight", &[256u64][..], 143, 0)];
        let layout = parse_layout_bytes(&build_layout_gguf(&kv, &tensors, 79))
            .unwrap()
            .memory_layout
            .unwrap();
        assert_eq!(layout.layers[0].weight_bytes, 79);
        assert_eq!(layout.total_bytes, 79);
        assert_eq!(layout.accuracy, GgufMemoryAccuracy::UpperBound);
        assert!(!layout.tied_output);
        let mixed = [
            ("blk.0.custom.weight", &[256u64][..], 143, 0),
            ("output.weight", &[1u64][..], 0, 64),
        ];
        let mixed = parse_layout_bytes(&build_layout_gguf(&kv, &mixed, 96))
            .unwrap()
            .memory_layout
            .unwrap();
        assert_eq!(mixed.layers[0].weight_bytes, 64);
        assert_eq!(mixed.output_bytes, 4);
        assert_eq!(mixed.accuracy, GgufMemoryAccuracy::UpperBound);
    }

    #[test]
    fn memory_layout_tied_output_and_optional_fields_are_compatible() {
        let kv = [
            ("general.architecture", TestValue::String("llama")),
            ("llama.block_count", TestValue::U32(1)),
        ];
        let tensors = [
            ("token_embd.weight", &[1u64][..], 0, 0),
            ("output_norm.weight", &[1u64][..], 0, 32),
        ];
        let layout = parse_layout_bytes(&build_layout_gguf(&kv, &tensors, 36))
            .unwrap()
            .memory_layout
            .unwrap();
        assert!(layout.tied_output);
        let mut json = serde_json::to_value(layout).unwrap();
        assert_eq!(json["accuracy"], "exact");
        assert_eq!(json["tied_output"], true);
        json.as_object_mut().unwrap().remove("accuracy");
        json.as_object_mut().unwrap().remove("tied_output");
        let old: GgufMemoryLayout = serde_json::from_value(json).unwrap();
        assert_eq!(old.accuracy, GgufMemoryAccuracy::Exact);
        assert!(!old.tied_output);
    }

    #[test]
    fn memory_layout_rejects_malformed_offsets_dimensions_and_duplicates() {
        let kv = [
            ("general.architecture", TestValue::String("llama")),
            ("llama.block_count", TestValue::U32(1)),
        ];
        let cases = vec![
            vec![("blk.0.a.weight", vec![1], 0, 32)], // 首 offset 非零
            vec![
                ("blk.0.a.weight", vec![1], 0, 0),
                ("blk.0.b.weight", vec![1], 0, 0),
            ],
            vec![
                ("blk.0.a.weight", vec![1], 0, 0),
                ("blk.0.b.weight", vec![1], 0, 33),
            ],
            vec![
                ("blk.0.a.weight", vec![1], 0, 0),
                ("blk.0.b.weight", vec![1], 0, 64),
            ],
            vec![
                ("blk.0.a.weight", vec![16], 0, 0),
                ("blk.0.b.weight", vec![1], 0, 32),
            ],
            vec![
                ("blk.0.a.weight", vec![1], 0, 0),
                ("blk.0.a.weight", vec![1], 0, 32),
            ],
            vec![("blk.1.a.weight", vec![1], 0, 0)],
            vec![("blk.invalid.a.weight", vec![1], 0, 0)],
            vec![("blk.0.a.weight", vec![0], 0, 0)],
            vec![("blk.0.a.weight", vec![31], 2, 0)],
            vec![("blk.0.a.weight", vec![u64::MAX, 2], 143, 0)],
            vec![
                ("blk.0.a.weight", vec![1], 0, 0),
                ("blk.0.b.weight", vec![1], 0, u64::MAX),
            ],
        ];
        for tensors in cases {
            let descriptions = tensors
                .iter()
                .map(|(name, dims, ty, offset)| (*name, dims.as_slice(), *ty, *offset))
                .collect::<Vec<_>>();
            let parsed = parse_layout_bytes(&build_layout_gguf(&kv, &descriptions, 64)).unwrap();
            assert!(
                parsed.memory_layout.is_none(),
                "畸形描述不能生成布局：{:?}",
                tensors
            );
        }
        let valid = build_layout_gguf(&kv, &[("blk.0.a.weight", &[1], 0, 0)], 4);
        assert!(parse_layout_bytes(&valid[..valid.len() - 1])
            .unwrap()
            .memory_layout
            .is_none());
        let header_only = build_test_gguf(&kv, &["blk.0.a.weight"]);
        assert!(parse_layout_bytes(&header_only[..header_only.len() - 40]).is_err());
        let duplicate_kv = [
            ("general.architecture", TestValue::String("llama")),
            ("llama.block_count", TestValue::U32(1)),
            ("llama.block_count", TestValue::U32(2)),
        ];
        assert!(parse_layout_bytes(&build_layout_gguf(
            &duplicate_kv,
            &[("blk.0.a.weight", &[1], 0, 0)],
            4
        ))
        .is_err());
        let alignment_kv = [
            ("general.architecture", TestValue::String("llama")),
            ("llama.block_count", TestValue::U32(1)),
            ("general.alignment", TestValue::U32(0)),
        ];
        assert!(parse_layout_bytes(&build_layout_gguf(
            &alignment_kv,
            &[("blk.0.a.weight", &[1], 0, 0)],
            4
        ))
        .unwrap()
        .memory_layout
        .is_none());
    }

    #[test]
    fn memory_layout_folds_all_split_shards_and_rejects_partial_or_duplicate() {
        let id = TEST_FILE_ID.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "agent-llm-layout-split-{}-{}",
            std::process::id(),
            id
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let paths = (1..=3)
            .map(|part| dir.join(format!("model-{:05}-of-00003.gguf", part)))
            .collect::<Vec<_>>();
        let names = [
            "token_embd.weight",
            "blk.0.ffn_up_exps.weight",
            "output.weight",
        ];
        let write_shard = |index: usize, name: &str, number: u32| {
            let kv = [
                ("general.architecture", TestValue::String("llama")),
                ("llama.block_count", TestValue::U32(2)),
                ("split.no", TestValue::U32(number)),
                ("split.count", TestValue::U32(3)),
                ("split.tensors.count", TestValue::U32(3)),
            ];
            std::fs::write(
                &paths[index],
                build_layout_gguf(&kv, &[(name, &[1], 0, 0)], 4),
            )
            .unwrap();
        };
        write_shard(0, names[0], 0);
        assert!(parse_gguf_header(&paths[0])
            .unwrap()
            .memory_layout
            .is_none());
        write_shard(1, names[1], 1);
        assert!(parse_gguf_header(&paths[0])
            .unwrap()
            .memory_layout
            .is_none());
        write_shard(2, names[2], 2);
        let parsed = parse_gguf_header(&paths[0]).unwrap();
        let layout = parsed.memory_layout.unwrap();
        assert_eq!(parsed.tensor_count, 3);
        assert_eq!(layout.layers.len(), 2);
        assert_eq!(
            (layout.layers[0].weight_bytes, layout.layers[0].expert_bytes),
            (4, 4)
        );
        assert_eq!(
            (layout.input_bytes, layout.output_bytes, layout.total_bytes),
            (4, 4, 12)
        );
        assert!(!layout.tied_output);
        assert_eq!(layout.accuracy, GgufMemoryAccuracy::Exact);
        assert_eq!(
            layout,
            parse_gguf_header(&paths[2]).unwrap().memory_layout.unwrap()
        );
        // 标准后续片可仅含 split.*，继承首片架构和层数后仍完整折叠。
        let split_only = [
            ("split.no", TestValue::U32(2)),
            ("split.count", TestValue::U32(3)),
            ("split.tensors.count", TestValue::U32(3)),
        ];
        std::fs::write(
            &paths[2],
            build_layout_gguf(&split_only, &[(names[2], &[1], 0, 0)], 4),
        )
        .unwrap();
        let inherited = parse_gguf_header(&paths[2]).unwrap().memory_layout.unwrap();
        assert_eq!(inherited.total_bytes, 12);
        assert!(!inherited.tied_output);
        // 第二片未知量化须把整个合并布局标成 upper_bound。
        let unknown_kv = [
            ("general.architecture", TestValue::String("llama")),
            ("llama.block_count", TestValue::U32(2)),
            ("split.no", TestValue::U32(1)),
            ("split.count", TestValue::U32(3)),
            ("split.tensors.count", TestValue::U32(3)),
        ];
        std::fs::write(
            &paths[1],
            build_layout_gguf(&unknown_kv, &[(names[1], &[256], 143, 0)], 8),
        )
        .unwrap();
        let upper = parse_gguf_header(&paths[0]).unwrap().memory_layout.unwrap();
        assert_eq!(upper.total_bytes, 16);
        assert_eq!(upper.accuracy, GgufMemoryAccuracy::UpperBound);
        assert_ne!(upper.signature, layout.signature);
        write_shard(1, names[1], 1);
        write_shard(2, names[1], 2);
        assert!(parse_gguf_header(&paths[0])
            .unwrap()
            .memory_layout
            .is_none());
        write_shard(2, names[2], 1);
        assert!(parse_gguf_header(&paths[0])
            .unwrap()
            .memory_layout
            .is_none());
        write_shard(2, names[2], 2);
        std::fs::write(&paths[2], b"GGUF").unwrap();
        assert!(parse_gguf_header(&paths[0])
            .unwrap()
            .memory_layout
            .is_none());
        let renamed = dir.join("renamed.gguf");
        std::fs::rename(&paths[0], &renamed).unwrap();
        assert!(parse_gguf_header(&renamed).unwrap().memory_layout.is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn memory_layout_signature_is_stable_and_tracks_descriptors_length_and_mtime() {
        let tensors = [TensorDescriptor {
            name: "blk.0.a.weight".to_string(),
            dims: vec![1],
            tensor_type: 0,
            offset: 0,
        }];
        let build = |tensors: &[TensorDescriptor], file_len, nanos, hash| {
            build_memory_layout(
                tensors,
                1,
                64,
                file_len,
                32,
                Some(std::time::Duration::new(10, nanos)),
                hash,
            )
            .unwrap()
            .signature
        };
        let signature = build(&tensors, 68, 1, [0; 32]);
        assert_eq!(signature, build(&tensors, 68, 1, [0; 32]));
        assert_ne!(signature, build(&tensors, 69, 1, [0; 32]));
        assert_ne!(signature, build(&tensors, 68, 2, [0; 32]));
        assert_ne!(signature, build(&tensors, 68, 1, [1; 32]));
        let renamed = [TensorDescriptor {
            name: "blk.0.b.weight".to_string(),
            dims: vec![1],
            tensor_type: 0,
            offset: 0,
        }];
        assert_ne!(signature, build(&renamed, 68, 1, [0; 32]));
    }

    #[test]
    fn keeps_complete_mixed_kv_and_swa_arrays_with_ssm_metadata() {
        let heads = [0, 8, 0, 4, 0, 8, 0, 4, 0, 8, 0, 4];
        let pattern = [
            false, false, true, true, false, false, true, true, false, false, true, true,
        ];
        let parsed = parse_test_gguf(
            &[
                ("general.architecture", TestValue::String("nemotron_h_moe")),
                ("nemotron_h_moe.block_count", TestValue::U32(12)),
                (
                    "nemotron_h_moe.attention.head_count_kv",
                    TestValue::U64Array(&heads),
                ),
                (
                    "nemotron_h_moe.attention.sliding_window_pattern",
                    TestValue::BoolArray(&pattern),
                ),
                ("nemotron_h_moe.ssm.state_size", TestValue::U32(128)),
                ("nemotron_h_moe.ssm.conv_kernel", TestValue::U32(4)),
            ],
            &["blk.0.attn_norm.weight"],
        );
        assert_eq!(parsed.kv_heads_by_layer, Some(heads.to_vec()));
        assert_eq!(parsed.swa_layer_pattern, Some(pattern.to_vec()));
        assert_eq!(parsed.kv_heads_sum, Some(36));
        assert_eq!(parsed.kv_heads_sum_full, Some(24));
        assert_eq!(parsed.kv_heads_sum_swa, Some(12));
        assert!(parsed.metadata_entries.contains(&(
            "nemotron_h_moe.ssm.state_size".to_string(),
            "128".to_string()
        )));
        assert!(parsed.metadata_entries.contains(&(
            "nemotron_h_moe.ssm.conv_kernel".to_string(),
            "4".to_string()
        )));
    }

    #[test]
    fn rejects_misaligned_negative_and_overflowing_layer_vectors() {
        for values in [
            TestValue::U64Array(&[8, 0]),
            TestValue::I32Array(&[8, -1, 4]),
            TestValue::U64Array(&[u64::MAX, 1, 0]),
        ] {
            let parsed = parse_test_gguf(
                &[
                    ("general.architecture", TestValue::String("nemotron_h_moe")),
                    ("nemotron_h_moe.block_count", TestValue::U32(3)),
                    ("nemotron_h_moe.attention.head_count_kv", values),
                    (
                        "nemotron_h_moe.attention.sliding_window_pattern",
                        TestValue::BoolArray(&[false, true]),
                    ),
                ],
                &[],
            );
            assert!(parsed.kv_heads_by_layer.is_none());
            assert!(parsed.swa_layer_pattern.is_none());
            assert!(parsed.kv_heads_sum.is_none());
            assert!(parsed.kv_heads_sum_full.is_none());
            assert!(parsed.kv_heads_sum_swa.is_none());
        }
    }

    #[test]
    fn dense_scalar_kv_expands_with_complete_tensors_and_preserves_swa_array() {
        let pattern = [true, true, true, false, true, true, true, false];
        let kv = [
            ("general.architecture", TestValue::String("spark2_5")),
            ("spark2_5.block_count", TestValue::U32(8)),
            ("spark2_5.attention.head_count_kv", TestValue::U32(4)),
            ("spark2_5.attention.sliding_window", TestValue::U32(512)),
            (
                "spark2_5.attention.sliding_window_pattern",
                TestValue::BoolArray(&pattern),
            ),
        ];
        let names = (0..8)
            .map(|index| format!("blk.{}.attn_qkv.weight", index))
            .collect::<Vec<_>>();
        let tensors = names.iter().map(String::as_str).collect::<Vec<_>>();
        let parsed = parse_test_gguf(&kv, &tensors);
        assert_eq!(parsed.kv_heads_by_layer, Some(vec![4; 8]));
        assert_eq!(parsed.swa_layer_pattern, Some(pattern.to_vec()));
        assert_eq!(parsed.kv_heads_sum, Some(32));
        assert_eq!(parsed.kv_heads_sum_full, Some(8));
        assert_eq!(parsed.kv_heads_sum_swa, Some(24));
        assert_eq!(parsed.sliding_window, Some(512));

        let partial = parse_test_gguf(&kv, &tensors[..7]);
        assert!(partial.kv_heads_by_layer.is_none());
        assert!(partial.kv_heads_sum.is_none());
        let mut recurrent_tensors = tensors.clone();
        recurrent_tensors.push("blk.0.ssm_conv1d.weight");
        let recurrent = parse_test_gguf(&kv, &recurrent_tensors);
        assert!(recurrent.kv_heads_by_layer.is_none());

        let unknown_pattern = parse_test_gguf(
            &[
                ("general.architecture", TestValue::String("spark2_5")),
                ("spark2_5.block_count", TestValue::U32(8)),
                ("spark2_5.attention.head_count_kv", TestValue::U32(4)),
                (
                    "spark2_5.attention.sliding_window_pattern",
                    TestValue::U32(4),
                ),
            ],
            &tensors,
        );
        assert_eq!(unknown_pattern.kv_heads_by_layer, Some(vec![4; 8]));
        assert!(
            unknown_pattern.swa_layer_pattern.is_none(),
            "未知标量 SWA 模式不能伪造成向量"
        );
        assert!(unknown_pattern.kv_heads_sum_full.is_none());
        assert!(unknown_pattern.kv_heads_sum_swa.is_none());

        let invalid_array = parse_test_gguf(
            &[
                ("general.architecture", TestValue::String("spark2_5")),
                ("spark2_5.block_count", TestValue::U32(8)),
                (
                    "spark2_5.attention.head_count_kv",
                    TestValue::U64Array(&[4, 4]),
                ),
            ],
            &tensors,
        );
        assert!(
            invalid_array.kv_heads_by_layer.is_none(),
            "无效显式数组不能回退到标量展开"
        );
    }

    #[test]
    fn qwen_forty_layer_interval_regression_keeps_ten_full_layers() {
        let names = (0..40)
            .map(|index| {
                if (index + 1) % 4 == 0 {
                    format!("blk.{}.attn_k.weight", index)
                } else {
                    format!("blk.{}.ssm_conv1d.weight", index)
                }
            })
            .collect::<Vec<_>>();
        let tensors = names.iter().map(String::as_str).collect::<Vec<_>>();
        let parsed = parse_test_gguf(
            &[
                ("general.architecture", TestValue::String("qwen35")),
                ("qwen35.block_count", TestValue::U32(40)),
                ("qwen35.attention.head_count_kv", TestValue::U32(2)),
                ("qwen35.full_attention_interval", TestValue::U32(4)),
            ],
            &tensors,
        );
        let expected = (0..40)
            .map(|index| if (index + 1) % 4 == 0 { 2 } else { 0 })
            .collect::<Vec<_>>();
        assert_eq!(parsed.kv_heads_by_layer, Some(expected));
        assert_eq!(parsed.kv_heads_sum, Some(20));
        assert_eq!(
            parsed.memory_layout.unwrap().accuracy,
            GgufMemoryAccuracy::Exact
        );
    }

    #[test]
    fn qwen_full_attention_interval_only_allocates_kv_to_full_layers() {
        let tensors = [
            "blk.0.ssm_in.weight",
            "blk.1.attn_k.weight",
            "blk.2.ssm_conv1d.weight",
            "blk.3.attn_k.weight",
        ];
        for arch in ["qwen35", "qwen35moe", "qwen3next"] {
            let parsed = parse_test_gguf(
                &[
                    ("general.architecture", TestValue::String(arch)),
                    (&format!("{}.block_count", arch), TestValue::U32(4)),
                    (
                        &format!("{}.attention.head_count_kv", arch),
                        TestValue::U32(2),
                    ),
                    (
                        &format!("{}.full_attention_interval", arch),
                        TestValue::U32(2),
                    ),
                ],
                &tensors,
            );
            assert_eq!(parsed.full_attention_interval, Some(2));
            assert_eq!(parsed.kv_heads_by_layer, Some(vec![0, 2, 0, 2]));
            assert_eq!(parsed.kv_heads_sum, Some(4));
        }
        let unknown = parse_test_gguf(
            &[
                ("general.architecture", TestValue::String("unknown-hybrid")),
                ("unknown-hybrid.block_count", TestValue::U32(4)),
                ("unknown-hybrid.attention.head_count_kv", TestValue::U32(2)),
                ("unknown-hybrid.full_attention_interval", TestValue::U32(2)),
            ],
            &tensors,
        );
        assert!(unknown.kv_heads_by_layer.is_none());
        assert!(unknown.kv_heads_sum.is_none());
        let conflict = parse_test_gguf(
            &[
                ("general.architecture", TestValue::String("qwen35")),
                ("qwen35.block_count", TestValue::U32(4)),
                ("qwen35.attention.head_count_kv", TestValue::U32(2)),
                (
                    "qwen35.attention.full_attention_interval",
                    TestValue::U32(2),
                ),
            ],
            &["blk.0.attn_k.weight", "blk.1.ssm_in.weight"],
        );
        assert!(conflict.kv_heads_by_layer.is_none());
        let from_tensors = parse_test_gguf(
            &[
                ("general.architecture", TestValue::String("qwen35")),
                ("qwen35.block_count", TestValue::U32(4)),
                ("qwen35.attention.head_count_kv", TestValue::U32(2)),
            ],
            &tensors,
        );
        assert_eq!(from_tensors.kv_heads_by_layer, Some(vec![0, 2, 0, 2]));
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
    fn parses_pooling_type_and_causal_flags() {
        // 嵌入模型的元数据：pooling_type 字符串 + 非因果注意力。
        let parsed = parse_test_gguf(
            &[
                ("general.architecture", TestValue::String("bert")),
                ("bert.embedding_length", TestValue::U32(768)),
                ("bert.pooling_type", TestValue::String("cls")),
                ("bert.attention.causal", TestValue::Bool(false)),
            ],
            &["token_embd.weight"],
        );
        assert_eq!(parsed.pooling_type.as_deref(), Some("cls"));
        assert_eq!(parsed.attention_causal, Some(false));

        // pooling_type 也可能是枚举整数：3 = last。
        let parsed_numeric = parse_test_gguf(
            &[
                ("general.architecture", TestValue::String("bert")),
                ("bert.pooling_type", TestValue::U32(3)),
            ],
            &["token_embd.weight"],
        );
        assert_eq!(parsed_numeric.pooling_type.as_deref(), Some("last"));

        // 未知枚举整数不属于任何已知池化方式：应留空，而不是伪造一个名字。
        assert_eq!(pooling_type_from_id(3).as_deref(), Some("last"));
        assert_eq!(pooling_type_from_id(99), None);
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
    fn detects_embedded_glm_dsa_mtp() {
        let parsed = parse_test_gguf(
            &[
                ("general.architecture", TestValue::String("glm-dsa")),
                ("glm-dsa.block_count", TestValue::U32(47)),
                ("glm-dsa.embedding_length", TestValue::U32(4096)),
                ("glm-dsa.nextn_predict_layers", TestValue::U32(1)),
            ],
            &["blk.0.attn_norm.weight", "blk.46.nextn.eh_proj.weight"],
        );

        assert!(parsed.mtp_architecture_supported);
        assert!(parsed.has_embedded_mtp);
        assert!(!parsed.is_mtp_draft_model);
    }

    #[test]
    fn glm4moe_has_no_mtp_graph_in_deployed_kernel() {
        let parsed = parse_test_gguf(
            &[
                ("general.architecture", TestValue::String("glm4moe")),
                ("glm4moe.block_count", TestValue::U32(47)),
                ("glm4moe.nextn_predict_layers", TestValue::U32(1)),
            ],
            &["blk.0.attn_norm.weight", "blk.46.nextn.eh_proj.weight"],
        );

        assert!(!parsed.mtp_architecture_supported);
        assert!(!parsed.has_embedded_mtp);
        assert!(!parsed.is_mtp_draft_model);
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
    fn test_local_vram_metadata() {
        let Ok(model_path) = std::env::var("AGENT_LLM_TEST_MODEL_PATH") else {
            eprintln!("skip: AGENT_LLM_TEST_MODEL_PATH 未设置");
            return;
        };
        let parsed = parse_gguf_header(Path::new(&model_path)).expect("解析本地显存元数据");
        // 先输出脱敏的显存相关原始键，再做断言；向量缺失时仍能核查根因。
        let dump = serde_json::json!({
            "architecture": parsed.architecture,
            "block_count": parsed.block_count,
            "embedding_length": parsed.embedding_length,
            "head_count": parsed.head_count,
            "head_count_kv": parsed.head_count_kv,
            "kv_heads_by_layer": parsed.kv_heads_by_layer,
            "swa_layer_pattern": parsed.swa_layer_pattern,
            "full_attention_interval": parsed.full_attention_interval,
            "sliding_window": parsed.sliding_window,
            "key_length": parsed.key_length,
            "value_length": parsed.value_length,
            "key_length_swa": parsed.key_length_swa,
            "value_length_swa": parsed.value_length_swa,
            "metadata_entries": parsed.metadata_entries.iter().filter(|(key, _)| {
                key.contains(".ssm.") || key.contains(".attention.")
                    || key.ends_with(".full_attention_interval")
            }).collect::<Vec<_>>(),
            "memory_layout": parsed.memory_layout,
        });
        println!("{}", dump);
        if let Ok(output) = std::env::var("AGENT_LLM_TEST_METADATA_OUTPUT") {
            std::fs::write(output, serde_json::to_vec_pretty(&dump).unwrap()).unwrap();
        }
        let layout = parsed
            .memory_layout
            .as_ref()
            .expect("本地模型应有完整张量布局");
        assert_eq!(layout.layers.len() as u64, parsed.block_count);
        assert!(layout.total_bytes > 0);
        assert_eq!(
            layout.total_bytes,
            layout
                .layers
                .iter()
                .map(|layer| layer.weight_bytes)
                .sum::<u64>()
                + layout.input_bytes
                + layout.output_bytes
                + layout.other_bytes
        );
        assert!(layout
            .layers
            .iter()
            .all(|layer| layer.expert_bytes <= layer.weight_bytes));
        let kv_heads = parsed
            .kv_heads_by_layer
            .as_ref()
            .expect("本地模型应有逐层 KV 布局");
        assert_eq!(kv_heads.len() as u64, parsed.block_count);
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
