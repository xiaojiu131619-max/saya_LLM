//! 无限画布 × Pi 联动（M1 只读 + M2 生图提交）。
//!
//! Pi 通过工具桥调用这里的 `canvas_status` / `canvas_list_workflows` /
//! `canvas_run`，把「生图 / 放大」交给画布执行，产物落到当前会话工作区的
//! `canvas/` 子目录，再由产物卡展示。画布保持独立窗口/独立模块，不合并前端。
//!
//! 网络边界：画布网关只监听 127.0.0.1 且无鉴权，本模块的 HTTP 一律
//! 显式 `no_proxy()`——宿主环境的 HTTP_PROXY 会劫持回环连接（SSE 被重置），
//! 画布联动必须直连。工作流 ID 只接受网关已安装的（白名单），输出路径
//! 固定在会话工作区内，不允许模型提交任意绝对路径。

use std::path::PathBuf;

use serde_json::{json, Value};

use crate::services::canvas_manager;
use crate::services::pi_agent;

const LIST_TIMEOUT_SECS: u64 = 10;
const RUN_DEFAULT_TIMEOUT_SECS: u64 = 300;
const RUN_MAX_TIMEOUT_SECS: u64 = 600;
/// 工作流详情注入给模型的字符上限（schema 可能很大，4B 模型吃不下全文）。
const DETAIL_MAX_CHARS: usize = 6000;

fn http_client(timeout_secs: u64) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(timeout_secs.max(1)))
        .connect_timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|error| format!("创建画布 HTTP 客户端失败：{error}"))
}

fn sanitize_output_name(raw: &str) -> String {
    let cleaned: String = raw
        .trim()
        .chars()
        .filter(|ch| {
            !matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
                && !ch.is_control()
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    if trimmed.is_empty() {
        "image".to_string()
    } else {
        trimmed.chars().take(80).collect()
    }
}

/// 网关地址（未启动时 None）。
pub fn gateway_base() -> Option<String> {
    let (_, gateway_port, _) = canvas_manager::runtime_ports()?;
    Some(format!("http://127.0.0.1:{gateway_port}"))
}

/// 画布联动状态（只读，三档权限都放行）。
pub fn status() -> Value {
    let snapshot = canvas_manager::status(None);
    json!({
        "running": snapshot.running,
        "gatewayPort": snapshot.gateway_port,
        "gatewayReady": snapshot.gateway_ready,
        "canvasUrl": snapshot.canvas_url,
        "comfyUrl": snapshot.comfy_url,
        "comfyReachable": snapshot.comfy_reachable,
        "modelCount": snapshot.model_count,
        "packInstalled": snapshot.pack.installed,
        "packVersion": snapshot.pack.version,
        "error": snapshot.error,
        "lastError": snapshot.last_error,
        "hint": if snapshot.running {
            "画布网关在线；用 canvas_list_workflows 看可用工作流。"
        } else if !snapshot.pack.installed {
            "画布模块未安装；请用户在 Agent 页「画布」标签安装。"
        } else {
            "画布未启动；请用户在 Agent 页「画布」标签点启动。"
        },
    })
}

/// 网关已安装的工作流（白名单来源）。
pub fn list_workflows() -> Result<Value, String> {
    let base = gateway_base().ok_or_else(|| {
        "画布网关未启动。请用户在 Agent 页「画布」标签启动画布后再试。".to_string()
    })?;
    let client = http_client(LIST_TIMEOUT_SECS)?;
    let response = client
        .get(format!("{base}/api/workflows"))
        .send()
        .map_err(|error| format!("读取画布工作流失败：{error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("画布网关返回 HTTP {status}"));
    }
    let value: Value = response
        .json()
        .map_err(|error| format!("解析工作流列表失败：{error}"))?;
    let mut out: Vec<Value> = Vec::new();
    if let Some(entries) = value.get("workflows").and_then(Value::as_array) {
        for entry in entries {
            let id = entry
                .get("id")
                .or_else(|| entry.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if id.is_empty() {
                continue;
            }
            out.push(json!({
                "id": id,
                "name": entry.get("name").and_then(Value::as_str).unwrap_or(id),
                "category": entry.get("category").cloned().unwrap_or(Value::Null),
                "type": entry.get("type").cloned().unwrap_or(Value::Null),
                "enabled": entry.get("enabled").and_then(Value::as_bool).unwrap_or(true),
                "availability": entry.get("availability").cloned().unwrap_or(Value::Null),
            }));
        }
    }
    Ok(json!({ "count": out.len(), "workflows": out }))
}

/// 单个工作流详情（含参数 schema，截断注入）。
pub fn workflow_detail(workflow: &str) -> Result<Value, String> {
    let base = gateway_base()
        .ok_or_else(|| "画布网关未启动。请用户先在 Agent 页启动画布。".to_string())?;
    let workflow = workflow.trim();
    if workflow.is_empty() || workflow.contains('/') || workflow.contains('\\') {
        return Err(format!("工作流 ID 不合法：{workflow:?}"));
    }
    let client = http_client(LIST_TIMEOUT_SECS)?;
    let response = client
        .get(format!("{base}/api/workflows/{}/schema", urlencode(workflow)))
        .send()
        .map_err(|error| format!("读取工作流详情失败：{error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("画布网关返回 HTTP {status}（工作流不存在？）"));
    }
    let value: Value = response
        .json()
        .map_err(|error| format!("解析工作流详情失败：{error}"))?;
    let mut text = serde_json::to_string_pretty(&value).unwrap_or_default();
    if text.chars().count() > DETAIL_MAX_CHARS {
        text = text.chars().take(DETAIL_MAX_CHARS).collect();
        text.push_str("\n…（schema 已截断）");
    }
    Ok(json!({ "workflow": workflow, "schema": text }))
}

fn urlencode(raw: &str) -> String {
    let mut out = String::new();
    for byte in raw.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// 画布生图结果。
pub struct CanvasRunOutcome {
    /// 相对当前会话工作区的产物路径（canvas/<名字>.png）。
    pub artifact: String,
    pub bytes: usize,
    pub seed: Option<i64>,
    pub elapsed_ms: u128,
}

/// 提交生图 / 图生图（M2 + M3）。工作流必须在白名单内；产物固定写会话工作区
/// `canvas/`。给了 `input_images`（工作区相对路径，最多 4 张）时走画布的
/// 图生图端点（改图 / 局部重绘 / 扩图），否则走文生图。
pub fn run_image(
    workflow: &str,
    prompt: &str,
    negative: Option<&str>,
    size: Option<&str>,
    output_name: Option<&str>,
    input_images: &[String],
    timeout_secs: Option<u64>,
) -> Result<CanvasRunOutcome, String> {
    let base = gateway_base()
        .ok_or_else(|| "画布网关未启动。请用户在 Agent 页「画布」标签启动画布。".to_string())?;
    let workflow = workflow.trim();
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("prompt 不能为空".to_string());
    }
    // 白名单：只允许提交网关已安装的工作流，不允许模型编造 ID。
    let workflows = list_workflows()?;
    let known = workflows
        .get("workflows")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .any(|entry| entry.get("id").and_then(Value::as_str) == Some(workflow))
        })
        .unwrap_or(false);
    if !known {
        return Err(format!(
            "工作流 {workflow:?} 不在画布已安装列表里；用 canvas_list_workflows 查看可用 ID。"
        ));
    }

    let work_dir = pi_agent::current_work_dir()
        .ok_or_else(|| "Pi 会话工作区未就绪，无法落产物。".to_string())?;
    let canvas_dir: PathBuf = work_dir.join("canvas");
    std::fs::create_dir_all(&canvas_dir)
        .map_err(|error| format!("创建画布产物目录失败：{error}"))?;

    let stem = sanitize_output_name(output_name.unwrap_or("image"));
    let mut file_name = format!("{stem}.png");
    let mut counter = 2usize;
    while canvas_dir.join(&file_name).exists() {
        file_name = format!("{stem}-{counter}.png");
        counter += 1;
    }

    let timeout = timeout_secs
        .unwrap_or(RUN_DEFAULT_TIMEOUT_SECS)
        .clamp(10, RUN_MAX_TIMEOUT_SECS);

    // 输入图：工作区内路径解析 + 大小上限；越界一律拒绝。
    const INPUT_IMAGE_MAX_BYTES: usize = 20 * 1024 * 1024;
    let mut images: Vec<(String, Vec<u8>)> = Vec::new();
    for raw in input_images.iter().take(4) {
        let path = crate::services::pi_tools::resolve_inside(&work_dir, raw)
            .map_err(|error| format!("输入图 {raw:?} 越界：{error}"))?;
        if !path.is_file() {
            return Err(format!("输入图不存在：{raw:?}"));
        }
        let bytes = std::fs::read(&path)
            .map_err(|error| format!("读取输入图 {raw:?} 失败：{error}"))?;
        if bytes.len() > INPUT_IMAGE_MAX_BYTES {
            return Err(format!(
                "输入图 {raw:?} 超过 20 MB 上限，请先压缩"
            ));
        }
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "input.png".to_string());
        images.push((name, bytes));
    }

    // 主模型在跑时给一句显式提示（不硬阻断——用户可能显存足够）。
    let gpu_warning = if crate::services::process_manager::is_server_running() {
        "注意：主模型（llama-server）正在运行，画布生图会与它共享显存。"
    } else {
        ""
    };

    let started = std::time::Instant::now();
    let client = http_client(timeout)?;
    let endpoint = if images.is_empty() {
        "v1/images/generations"
    } else {
        "v1/images/edits"
    };
    let mut request = client
        .post(format!("{base}/{endpoint}"))
        .header("Accept", "application/json");
    if images.is_empty() {
        let mut body = json!({
            "model": workflow,
            "prompt": prompt,
            "response_format": "b64_json",
        });
        if let Some(negative) = negative.map(str::trim).filter(|value| !value.is_empty()) {
            body["negative"] = json!(negative);
        }
        if let Some(size) = size.map(str::trim).filter(|value| !value.is_empty()) {
            body["size"] = json!(size);
        }
        request = request.json(&body);
    } else {
        let mut form = reqwest::blocking::multipart::Form::new()
            .text("model", workflow.to_string())
            .text("prompt", prompt.to_string())
            .text("response_format", "b64_json".to_string());
        if let Some(negative) = negative.map(str::trim).filter(|value| !value.is_empty()) {
            form = form.text("negative", negative.to_string());
        }
        if let Some(size) = size.map(str::trim).filter(|value| !value.is_empty()) {
            form = form.text("size", size.to_string());
        }
        for (name, bytes) in &images {
            let part = reqwest::blocking::multipart::Part::bytes(bytes.clone())
                .file_name(name.clone())
                .mime_str("image/png")
                .map_err(|error| format!("输入图 MIME 解析失败：{error}"))?;
            form = form.part("image", part);
        }
        request = request.multipart(form);
    }
    let response = request.send().map_err(|error| {
        if gpu_warning.is_empty() {
            format!("画布生图请求失败：{error}")
        } else {
            format!("画布生图请求失败：{error}（{gpu_warning}）")
        }
    })?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().unwrap_or_default();
        let detail: String = text.chars().take(600).collect();
        return Err(format!("画布生图失败（HTTP {status}）：{detail}"));
    }
    let value: Value = response
        .json()
        .map_err(|error| format!("解析生图响应失败：{error}"))?;
    let b64 = value
        .pointer("/data/0/b64_json")
        .and_then(Value::as_str)
        .ok_or_else(|| "画布没有返回图片数据".to_string())?;
    let bytes = decode_base64(b64)
        .ok_or_else(|| "画布返回的图片数据不是合法 base64".to_string())?;
    if bytes.is_empty() {
        return Err("画布返回了空图片".to_string());
    }
    let target = canvas_dir.join(&file_name);
    std::fs::write(&target, &bytes)
        .map_err(|error| format!("写入画布产物失败：{error}"))?;

    Ok(CanvasRunOutcome {
        artifact: format!("canvas/{file_name}"),
        bytes: bytes.len(),
        seed: value.get("seed").and_then(Value::as_i64),
        elapsed_ms: started.elapsed().as_millis(),
    })
}

fn decode_base64(input: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.decode(input.trim()).ok()
}

/// 取消当前画布任务：中断 ComfyUI 队列里的工作流（网关的图片请求是同步的，
/// 真正的停止手段是 ComfyUI 的 /interrupt）。
pub fn cancel() -> Result<(), String> {
    let comfy_url = canvas_manager::load_config().comfy_url;
    let comfy_url = comfy_url.trim().trim_end_matches('/').to_string();
    if comfy_url.is_empty() {
        return Err("ComfyUI 地址未配置，无法中断画布任务。".to_string());
    }
    let client = http_client(LIST_TIMEOUT_SECS)?;
    let response = client
        .post(format!("{comfy_url}/interrupt"))
        .send()
        .map_err(|error| format!("中断 ComfyUI 失败：{error}（ComfyUI 可达吗？）"))?;
    let status = response.status();
    if status.is_success() {
        Ok(())
    } else {
        Err(format!("ComfyUI 中断请求返回 HTTP {status}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_name_is_sanitized() {
        assert_eq!(sanitize_output_name("雨夜城市"), "雨夜城市");
        assert_eq!(sanitize_output_name("  "), "image");
        assert_eq!(sanitize_output_name("a/b\\c:d*e"), "abcde");
        assert_eq!(sanitize_output_name(".."), "image");
        let long = "x".repeat(200);
        assert_eq!(sanitize_output_name(&long).chars().count(), 80);
    }

    #[test]
    fn base64_decode_roundtrip() {
        use base64::Engine as _;
        let encoded = base64::engine::general_purpose::STANDARD.encode(b"png-bytes");
        assert_eq!(decode_base64(&encoded).unwrap(), b"png-bytes");
        assert!(decode_base64("not-base64!!!").is_none());
    }
}
