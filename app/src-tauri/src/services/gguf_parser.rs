use std::fs::File;
use std::io::Read;
use std::path::Path;

use anyhow::{bail, Result};

const BUF_SIZE: u64 = 100 * 1024 * 1024; // 100MB buffer for large tokenizer data
const MAX_ARRAY: u64 = 1_000_000;
const MAX_STR_LEN: u64 = 100_000_000;

#[derive(Debug, Clone)]
pub struct GgufMetadata {
    pub architecture: String,
    pub block_count: u64,
    pub context_length: u64,
    pub embedding_length: u64,
    pub expert_count: Option<u64>,
    pub _expert_used_count: Option<u64>,
    pub name: Option<String>,
    pub size_label: Option<String>,
    pub quantization_version: Option<u32>,
    pub mtp_support: bool,
    // Attention head metadata — needed for an accurate KV-cache size estimate.
    pub head_count: Option<u64>,
    pub head_count_kv: Option<u64>,
    pub key_length: Option<u64>,
    pub value_length: Option<u64>,
    pub metadata_entries: Vec<(String, String)>,
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
            let et = r32(buf, p)?;
            let mut n = r64(buf, p)?;
            if n > MAX_ARRAY {
                n = MAX_ARRAY;
            }
            for _ in 0..n {
                skip(buf, p, et)?;
            }
            Ok(())
        }
        10 | 11 => adv(buf, p, 8),
        12 => adv(buf, p, 8),
        _ => bail!("ty {}", ty),
    }
}

fn read_val(buf: &[u8], p: &mut usize, ty: u32) -> Result<serde_json::Value> {
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
            let et = r32(buf, p)?;
            let cnt = r64(buf, p)?;
            let mut arr = Vec::new();
            for _ in 0..std::cmp::min(cnt, 10) {
                arr.push(read_val(buf, p, et)?);
            }
            let mut skip_n = cnt.saturating_sub(10);
            if skip_n > MAX_ARRAY {
                skip_n = MAX_ARRAY;
            }
            for _ in 0..skip_n {
                skip(buf, p, et)?;
            }
            Ok(serde_json::Value::Array(arr))
        }
        _ => bail!("ty {}", ty),
    }
}

pub fn parse_gguf_header(path: &Path) -> Result<GgufMetadata> {
    let mut file = File::open(path)?;
    let file_len = file.metadata()?.len();
    let buf_size = std::cmp::min(file_len, BUF_SIZE) as usize;
    let mut buf = vec![0u8; buf_size];
    file.read_exact(&mut buf)?;

    let mut p: usize = 4;
    if buf.len() < 4 || &buf[0..4] != b"GGUF" {
        bail!("not GGUF");
    }

    let _ver = r32(&buf, &mut p)?;
    let _tc = r64(&buf, &mut p)?;
    let kvn = r64(&buf, &mut p)?;

    let mut arch = String::from("unknown");
    let mut blk = 0u64;
    let mut ctx = 0u64;
    let mut emb = 0u64;
    let mut exp: Option<u64> = None;
    let mut expu: Option<u64> = None;
    let mut qv: Option<u32> = None;
    let mut nm: Option<String> = None;
    let mut sl: Option<String> = None;
    let mut mtp_support = false;
    let mut hc: Option<u64> = None;
    let mut hckv: Option<u64> = None;
    let mut klen: Option<u64> = None;
    let mut vlen: Option<u64> = None;
    let mut entries: Vec<(String, String)> = Vec::new();

    for _ in 0..kvn {
        if p >= buf.len() {
            break;
        }
        let key = rstr(&buf, &mut p)?;
        let ty = match r32(&buf, &mut p) {
            Ok(t) => t,
            Err(_) => break,
        };

        let keep = key.starts_with("general.")
            || key.ends_with(".block_count")
            || key.ends_with(".context_length")
            || key.ends_with(".embedding_length")
            || key.ends_with(".expert_count")
            || key.ends_with(".expert_used_count")
            || key.ends_with(".attention.head_count")
            || key.ends_with(".attention.head_count_kv")
            || key.ends_with(".attention.key_length")
            || key.ends_with(".attention.value_length")
            || key.ends_with(".nextn_predict_layers");

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
            _ => {
                if key.ends_with(".block_count") {
                    blk = v.as_u64().unwrap_or(0);
                } else if key.ends_with(".context_length") {
                    ctx = v.as_u64().unwrap_or(0);
                } else if key.ends_with(".embedding_length") {
                    emb = v.as_u64().unwrap_or(0);
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
                } else if key.ends_with(".nextn_predict_layers") && v.as_u64().unwrap_or(0) > 0 {
                    mtp_support = true;
                }
            }
        }
    }

    Ok(GgufMetadata {
        architecture: arch,
        block_count: blk,
        context_length: ctx,
        embedding_length: emb,
        expert_count: exp,
        _expert_used_count: expu,
        name: nm,
        size_label: sl,
        quantization_version: qv,
        mtp_support,
        head_count: hc,
        head_count_kv: hckv,
        key_length: klen,
        value_length: vlen,
        metadata_entries: entries,
    })
}

fn value_to_string(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::Null => None,
        serde_json::Value::Bool(v) => Some(v.to_string()),
        serde_json::Value::Number(v) => Some(v.to_string()),
        serde_json::Value::String(v) => Some(v.clone()),
        serde_json::Value::Array(v) => Some(format!("array[{}]", v.len())),
        serde_json::Value::Object(_) => Some("object".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // These tests require local model files and are ignored by default.
    // Run with: cargo test -- --ignored
    #[test]
    #[ignore]
    fn test_parse_qwen() {
        let r = parse_gguf_header(Path::new(
            "D:\\LLM\\HauhauCS\\Qwen3.5\\Qwen3.5-9B-Uncensored-Q6_K_M.gguf",
        ));
        assert!(r.is_ok(), "{:?}", r.err());
        let m = r.unwrap();
        assert_eq!(m.block_count, 32);
    }

    #[test]
    #[ignore]
    fn test_parse_wukomg() {
        let r = parse_gguf_header(Path::new(
            "D:\\LLM\\Unsloth\\Qwen\\wukomg2.2\\wukomg-2.2b-sinq-q6.gguf",
        ));
        assert!(r.is_ok(), "{:?}", r.err());
        let m = r.unwrap();
        println!(
            "arch={} blk={} emb={} exp={:?} name={:?} size_label={:?}",
            m.architecture, m.block_count, m.embedding_length, m.expert_count, m.name, m.size_label
        );
    }
}
