use std::time::Duration;

use anyhow::{anyhow, Result};
use base64::{engine::general_purpose, Engine as _};
use chrono::Utc;
use reqwest::{multipart, Client};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::time::sleep;

const IMAGE_SECRET_SERVICE: &str = "Agent LLM Image API";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageKeyStatus {
    pub provider_id: String,
    pub has_key: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInput {
    pub name: String,
    pub mime_type: String,
    pub data_base64: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageGenerateRequest {
    pub provider_id: String,
    pub base_url: String,
    pub model: String,
    pub prompt: String,
    pub negative_prompt: Option<String>,
    pub mode: Option<String>,
    pub size: Option<String>,
    pub n: Option<u32>,
    pub quality: Option<String>,
    pub style: Option<String>,
    pub response_format: Option<String>,
    pub seed: Option<i64>,
    pub steps: Option<u32>,
    pub guidance_scale: Option<f64>,
    pub aspect_ratio: Option<String>,
    pub workflow_json: Option<String>,
    pub images: Option<Vec<ImageInput>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedImage {
    pub url: Option<String>,
    pub b64_json: Option<String>,
    pub mime_type: Option<String>,
    pub revised_prompt: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageGenerateResponse {
    pub provider_id: String,
    pub model: String,
    pub images: Vec<GeneratedImage>,
    pub text: Option<String>,
    pub usage: Option<Value>,
    pub raw: Value,
}

fn secret_entry(provider_id: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(IMAGE_SECRET_SERVICE, provider_id).map_err(|e| anyhow!(e.to_string()))
}

fn load_api_key(provider_id: &str) -> Result<String> {
    secret_entry(provider_id)?
        .get_password()
        .map_err(|_| anyhow!("未保存该生图供应商的 API Key"))
}

fn normalize_base_url(base_url: &str) -> String {
    base_url.trim().trim_end_matches('/').to_string()
}

fn endpoint(base_url: &str, path: &str) -> String {
    let base = normalize_base_url(base_url);
    let path_without_slash = path.trim_start_matches('/');
    if base.ends_with(path_without_slash) {
        base
    } else {
        format!("{}{}", base, path)
    }
}

fn compact_optional_string(value: &Option<String>) -> Option<String> {
    value
        .as_ref()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty() && item != "auto")
}

fn input_as_data_url(image: &ImageInput) -> String {
    format!("data:{};base64,{}", image.mime_type, image.data_base64)
}

fn decode_image_bytes(image: &ImageInput) -> Result<Vec<u8>> {
    let data = image
        .data_base64
        .split_once(',')
        .map(|(_, right)| right)
        .unwrap_or(image.data_base64.as_str());
    general_purpose::STANDARD
        .decode(data)
        .map_err(|e| anyhow!("图片 {} 解码失败: {}", image.name, e))
}

fn numeric_n(value: Option<u32>) -> u32 {
    value.unwrap_or(1).clamp(1, 10)
}

fn siliconflow_batch_size(value: Option<u32>) -> u32 {
    value.unwrap_or(1).clamp(1, 4)
}

fn image_size(value: &Option<String>) -> String {
    compact_optional_string(value).unwrap_or_else(|| "1024x1024".to_string())
}

fn parse_image_size(value: &Option<String>) -> (u32, u32) {
    let size = image_size(value);
    let (width, height) = size
        .split_once('x')
        .or_else(|| size.split_once('X'))
        .unwrap_or(("1024", "1024"));
    let width = width.trim().parse::<u32>().unwrap_or(1024).clamp(64, 4096);
    let height = height.trim().parse::<u32>().unwrap_or(1024).clamp(64, 4096);
    (width, height)
}

fn workflow_seed(value: Option<i64>) -> i64 {
    value.unwrap_or_else(|| Utc::now().timestamp_millis().rem_euclid(9_000_000_000))
}

fn json_without_empty(mut value: Value) -> Value {
    if let Value::Object(ref mut map) = value {
        map.retain(|_, item| match item {
            Value::Null => false,
            Value::String(text) => !text.trim().is_empty(),
            Value::Array(items) => !items.is_empty(),
            _ => true,
        });
    }
    value
}

async fn post_json(client: &Client, url: String, api_key: &str, body: Value) -> Result<Value> {
    let resp = client
        .post(&url)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| anyhow!("请求失败: {}", e))?;
    parse_response(url, resp).await
}

async fn parse_response(url: String, resp: reqwest::Response) -> Result<Value> {
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!("{} 返回 {}: {}", url, status, text));
    }
    serde_json::from_str(&text).map_err(|e| anyhow!("响应不是有效 JSON: {}\n{}", e, text))
}

async fn call_siliconflow(
    client: &Client,
    request: &ImageGenerateRequest,
    api_key: &str,
) -> Result<Value> {
    let model = request.model.to_lowercase();
    let is_qwen_image = model.contains("qwen") && model.contains("image");
    let is_qwen_image_edit = is_qwen_image && model.contains("edit");
    let is_kolors = model.contains("kolors");
    let mut body = json!({
        "model": request.model,
        "prompt": request.prompt,
        "negative_prompt": compact_optional_string(&request.negative_prompt),
        "seed": request.seed,
        "num_inference_steps": request.steps,
    });

    if let Value::Object(ref mut map) = body {
        if !is_qwen_image_edit {
            map.insert(
                "image_size".to_string(),
                Value::String(image_size(&request.size)),
            );
        }

        if is_qwen_image {
            if let Some(cfg) = request.guidance_scale {
                map.insert("cfg".to_string(), json!(cfg));
            }
        } else if is_kolors {
            map.insert(
                "batch_size".to_string(),
                json!(siliconflow_batch_size(request.n)),
            );
            if let Some(guidance_scale) = request.guidance_scale {
                map.insert("guidance_scale".to_string(), json!(guidance_scale));
            }
        }
    }

    if let Some(images) = &request.images {
        if let Value::Object(ref mut map) = body {
            let supports_reference_image = is_kolors || is_qwen_image_edit;
            for (index, image) in images
                .iter()
                .take(4)
                .enumerate()
                .filter(|_| supports_reference_image)
            {
                let key = if index == 0 {
                    "image".to_string()
                } else {
                    format!("image{}", index + 1)
                };
                map.insert(key, Value::String(input_as_data_url(image)));
            }
        }
    }

    post_json(
        client,
        endpoint(&request.base_url, "/images/generations"),
        api_key,
        json_without_empty(body),
    )
    .await
}

async fn call_newapi_openai_generation(
    client: &Client,
    request: &ImageGenerateRequest,
    api_key: &str,
) -> Result<Value> {
    let body = json_without_empty(json!({
        "model": request.model,
        "prompt": request.prompt,
        "n": numeric_n(request.n),
        "size": image_size(&request.size),
        "quality": compact_optional_string(&request.quality),
        "style": compact_optional_string(&request.style),
        "response_format": compact_optional_string(&request.response_format),
    }));

    post_json(
        client,
        endpoint(&request.base_url, "/images/generations"),
        api_key,
        body,
    )
    .await
}

async fn call_newapi_openai_edit(
    client: &Client,
    request: &ImageGenerateRequest,
    api_key: &str,
) -> Result<Value> {
    let images = request
        .images
        .as_ref()
        .filter(|items| !items.is_empty())
        .ok_or_else(|| anyhow!("图片编辑需要至少上传一张参考图"))?;

    let mut form = multipart::Form::new()
        .text("model", request.model.clone())
        .text("prompt", request.prompt.clone())
        .text("n", numeric_n(request.n).to_string())
        .text("size", image_size(&request.size));

    if let Some(value) = compact_optional_string(&request.response_format) {
        form = form.text("response_format", value);
    }
    if let Some(value) = compact_optional_string(&request.quality) {
        form = form.text("quality", value);
    }

    for (index, image) in images.iter().take(10).enumerate() {
        let part = multipart::Part::bytes(decode_image_bytes(image)?)
            .file_name(image.name.clone())
            .mime_str(&image.mime_type)
            .map_err(|e| anyhow!("图片类型无效: {}", e))?;
        let field = if index == 0 { "image" } else { "image[]" };
        form = form.part(field, part);
    }

    let url = endpoint(&request.base_url, "/images/edits");
    let resp = client
        .post(&url)
        .bearer_auth(api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| anyhow!("请求失败: {}", e))?;
    parse_response(url, resp).await
}

fn gemini_parts(request: &ImageGenerateRequest) -> Vec<Value> {
    let mut parts = vec![json!({ "text": request.prompt })];
    if let Some(images) = &request.images {
        parts.extend(images.iter().take(8).map(|image| {
            json!({
                "inline_data": {
                    "mime_type": image.mime_type,
                    "data": image.data_base64,
                }
            })
        }));
    }
    parts
}

fn gemini_generation_config(request: &ImageGenerateRequest) -> Value {
    json_without_empty(json!({
        "responseModalities": ["TEXT", "IMAGE"],
        "imageConfig": json_without_empty(json!({
            "aspectRatio": compact_optional_string(&request.aspect_ratio),
            "imageSize": compact_optional_string(&request.size),
        })),
    }))
}

async fn call_newapi_gemini_native(
    client: &Client,
    request: &ImageGenerateRequest,
    api_key: &str,
) -> Result<Value> {
    let body = json_without_empty(json!({
        "contents": [{
            "role": "user",
            "parts": gemini_parts(request),
        }],
        "generationConfig": gemini_generation_config(request),
    }));
    let path = format!("/models/{}:generateContent", request.model.trim());
    post_json(client, endpoint(&request.base_url, &path), api_key, body).await
}

async fn call_newapi_gemini_openai(
    client: &Client,
    request: &ImageGenerateRequest,
    api_key: &str,
) -> Result<Value> {
    let content = if request
        .images
        .as_ref()
        .map(|items| items.is_empty())
        .unwrap_or(true)
    {
        Value::String(request.prompt.clone())
    } else {
        let mut items = vec![json!({ "type": "text", "text": request.prompt })];
        if let Some(images) = &request.images {
            items.extend(images.iter().take(8).map(|image| {
                json!({
                    "type": "image_url",
                    "image_url": { "url": input_as_data_url(image) },
                })
            }));
        }
        Value::Array(items)
    };

    let body = json_without_empty(json!({
        "model": request.model,
        "stream": false,
        "messages": [{
            "role": "user",
            "content": content,
        }],
        "extra_body": {
            "generationConfig": gemini_generation_config(request),
        },
    }));

    post_json(
        client,
        endpoint(&request.base_url, "/chat/completions"),
        api_key,
        body,
    )
    .await
}

fn default_comfyui_workflow(request: &ImageGenerateRequest) -> Value {
    let (width, height) = parse_image_size(&request.size);
    let negative_prompt = compact_optional_string(&request.negative_prompt).unwrap_or_default();
    json!({
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "seed": workflow_seed(request.seed),
                "steps": request.steps.unwrap_or(20).clamp(1, 150),
                "cfg": request.guidance_scale.unwrap_or(7.5),
                "sampler_name": "euler",
                "scheduler": "normal",
                "denoise": 1.0,
                "model": ["4", 0],
                "positive": ["6", 0],
                "negative": ["7", 0],
                "latent_image": ["5", 0]
            }
        },
        "4": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {
                "ckpt_name": request.model
            }
        },
        "5": {
            "class_type": "EmptyLatentImage",
            "inputs": {
                "width": width,
                "height": height,
                "batch_size": 1
            }
        },
        "6": {
            "class_type": "CLIPTextEncode",
            "inputs": {
                "text": request.prompt,
                "clip": ["4", 1]
            }
        },
        "7": {
            "class_type": "CLIPTextEncode",
            "inputs": {
                "text": negative_prompt,
                "clip": ["4", 1]
            }
        },
        "8": {
            "class_type": "VAEDecode",
            "inputs": {
                "samples": ["3", 0],
                "vae": ["4", 2]
            }
        },
        "9": {
            "class_type": "SaveImage",
            "inputs": {
                "filename_prefix": "agent_llm",
                "images": ["8", 0]
            }
        }
    })
}

fn comfyui_workflow(request: &ImageGenerateRequest) -> Result<Value> {
    let Some(raw) = request
        .workflow_json
        .as_ref()
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
    else {
        return Ok(default_comfyui_workflow(request));
    };
    let replaced = raw
        .replace("{{prompt}}", &request.prompt)
        .replace(
            "{{negativePrompt}}",
            request.negative_prompt.as_deref().unwrap_or_default(),
        )
        .replace("{{model}}", &request.model)
        .replace("{{seed}}", &workflow_seed(request.seed).to_string())
        .replace(
            "{{steps}}",
            &request.steps.unwrap_or(20).clamp(1, 150).to_string(),
        )
        .replace(
            "{{cfg}}",
            &request.guidance_scale.unwrap_or(7.5).to_string(),
        );
    serde_json::from_str(&replaced).map_err(|e| anyhow!("ComfyUI workflow JSON 无效: {}", e))
}

fn query_escape(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            b' ' => out.push_str("%20"),
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}

fn comfyui_view_url(base_url: &str, image: &Value) -> Option<String> {
    let filename = string_field(image, "filename")?;
    let subfolder = string_field(image, "subfolder").unwrap_or("");
    let image_type = string_field(image, "type").unwrap_or("output");
    let mut url = format!(
        "{}/view?filename={}&type={}",
        normalize_base_url(base_url),
        query_escape(filename),
        query_escape(image_type)
    );
    if !subfolder.is_empty() {
        url.push_str("&subfolder=");
        url.push_str(&query_escape(subfolder));
    }
    Some(url)
}

fn collect_comfyui_images(base_url: &str, history: &Value) -> Vec<Value> {
    let mut images = Vec::new();
    if let Some(outputs) = history.get("outputs").and_then(Value::as_object) {
        for output in outputs.values() {
            if let Some(items) = output.get("images").and_then(Value::as_array) {
                for item in items {
                    if let Some(url) = comfyui_view_url(base_url, item) {
                        images.push(json!({
                            "url": url,
                            "mime_type": "image/png"
                        }));
                    }
                }
            }
        }
    }
    images
}

async fn call_comfyui(client: &Client, request: &ImageGenerateRequest) -> Result<Value> {
    let workflow = comfyui_workflow(request)?;
    let queue_url = endpoint(&request.base_url, "/prompt");
    let queued = client
        .post(&queue_url)
        .json(&json!({ "prompt": workflow }))
        .send()
        .await
        .map_err(|e| anyhow!("ComfyUI 请求失败: {}", e))?;
    let queued = parse_response(queue_url, queued).await?;
    let prompt_id = string_field(&queued, "prompt_id")
        .ok_or_else(|| anyhow!("ComfyUI 未返回 prompt_id"))?
        .to_string();

    for _ in 0..300 {
        let history_url = endpoint(&request.base_url, &format!("/history/{}", prompt_id));
        let history_resp = client
            .get(&history_url)
            .send()
            .await
            .map_err(|e| anyhow!("ComfyUI 轮询失败: {}", e))?;
        let history = parse_response(history_url, history_resp).await?;
        if let Some(item) = history.get(&prompt_id) {
            let images = collect_comfyui_images(&request.base_url, item);
            if !images.is_empty() {
                return Ok(json!({
                    "prompt_id": prompt_id,
                    "images": images,
                    "history": item
                }));
            }
            if let Some(status) = item.get("status") {
                let failed = status
                    .get("status_str")
                    .and_then(Value::as_str)
                    .map(|text| text.eq_ignore_ascii_case("error"))
                    .unwrap_or(false);
                if failed {
                    return Err(anyhow!("ComfyUI 执行失败: {}", status));
                }
            }
        }
        sleep(Duration::from_secs(1)).await;
    }

    Err(anyhow!("ComfyUI 生成超时，请检查队列或 workflow"))
}

fn usage_from(raw: &Value) -> Option<Value> {
    raw.get("usage")
        .or_else(|| raw.get("usageMetadata"))
        .cloned()
}

fn string_field<'a>(value: &'a Value, name: &str) -> Option<&'a str> {
    value
        .get(name)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

fn push_standard_image(item: &Value, images: &mut Vec<GeneratedImage>) {
    let url = string_field(item, "url").map(str::to_string);
    let b64_json = string_field(item, "b64_json")
        .or_else(|| string_field(item, "b64Json"))
        .map(str::to_string);
    if url.is_some() || b64_json.is_some() {
        images.push(GeneratedImage {
            url,
            b64_json,
            mime_type: string_field(item, "mime_type")
                .or_else(|| string_field(item, "mimeType"))
                .map(str::to_string)
                .or_else(|| Some("image/png".to_string())),
            revised_prompt: string_field(item, "revised_prompt")
                .or_else(|| string_field(item, "revisedPrompt"))
                .map(str::to_string),
        });
    }
}

fn collect_explicit_images(
    raw: &Value,
    images: &mut Vec<GeneratedImage>,
    text_parts: &mut Vec<String>,
) {
    if let Some(data) = raw.get("data").and_then(Value::as_array) {
        for item in data {
            push_standard_image(item, images);
        }
    }
    if let Some(items) = raw.get("images").and_then(Value::as_array) {
        for item in items {
            push_standard_image(item, images);
        }
    }

    if let Some(candidates) = raw.get("candidates").and_then(Value::as_array) {
        for candidate in candidates {
            if let Some(parts) = candidate
                .get("content")
                .and_then(|content| content.get("parts"))
                .and_then(Value::as_array)
            {
                for part in parts {
                    if let Some(text) = string_field(part, "text") {
                        text_parts.push(text.to_string());
                    }
                    let inline = part.get("inlineData").or_else(|| part.get("inline_data"));
                    if let Some(inline) = inline {
                        if let Some(data) = string_field(inline, "data") {
                            images.push(GeneratedImage {
                                url: None,
                                b64_json: Some(data.to_string()),
                                mime_type: string_field(inline, "mimeType")
                                    .or_else(|| string_field(inline, "mime_type"))
                                    .map(str::to_string)
                                    .or_else(|| Some("image/png".to_string())),
                                revised_prompt: None,
                            });
                        }
                    }
                    let file = part.get("fileData").or_else(|| part.get("file_data"));
                    if let Some(file) = file {
                        if let Some(uri) =
                            string_field(file, "fileUri").or_else(|| string_field(file, "file_uri"))
                        {
                            images.push(GeneratedImage {
                                url: Some(uri.to_string()),
                                b64_json: None,
                                mime_type: string_field(file, "mimeType")
                                    .or_else(|| string_field(file, "mime_type"))
                                    .map(str::to_string),
                                revised_prompt: None,
                            });
                        }
                    }
                }
            }
        }
    }

    if let Some(choices) = raw.get("choices").and_then(Value::as_array) {
        for choice in choices {
            let message = choice.get("message").unwrap_or(choice);
            if let Some(content) = message.get("content") {
                match content {
                    Value::String(text) => text_parts.push(text.clone()),
                    Value::Array(parts) => {
                        for part in parts {
                            if let Some(text) = string_field(part, "text") {
                                text_parts.push(text.to_string());
                            }
                            if let Some(image_url) = part.get("image_url") {
                                if let Some(url) = string_field(image_url, "url") {
                                    images.push(GeneratedImage {
                                        url: Some(url.to_string()),
                                        b64_json: None,
                                        mime_type: None,
                                        revised_prompt: None,
                                    });
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            if let Some(images_value) = message.get("images").and_then(Value::as_array) {
                for item in images_value {
                    push_standard_image(item, images);
                }
            }
        }
    }
}

fn collect_fallback_urls(value: &Value, images: &mut Vec<GeneratedImage>) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                if matches!(
                    key.as_str(),
                    "url" | "image_url" | "imageUrl" | "fileUri" | "file_uri"
                ) {
                    if let Some(text) = child.as_str() {
                        if text.starts_with("http://")
                            || text.starts_with("https://")
                            || text.starts_with("data:image/")
                        {
                            images.push(GeneratedImage {
                                url: Some(text.to_string()),
                                b64_json: None,
                                mime_type: None,
                                revised_prompt: None,
                            });
                        }
                    }
                }
                collect_fallback_urls(child, images);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_fallback_urls(item, images);
            }
        }
        _ => {}
    }
}

fn dedupe_images(images: Vec<GeneratedImage>) -> Vec<GeneratedImage> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for image in images {
        let key = image
            .url
            .clone()
            .or_else(|| {
                image
                    .b64_json
                    .as_ref()
                    .map(|data| data.chars().take(80).collect())
            })
            .unwrap_or_default();
        if key.is_empty() || seen.insert(key) {
            out.push(image);
        }
    }
    out
}

fn normalize_response(provider_id: String, model: String, raw: Value) -> ImageGenerateResponse {
    let mut images = Vec::new();
    let mut text_parts = Vec::new();
    collect_explicit_images(&raw, &mut images, &mut text_parts);
    collect_fallback_urls(&raw, &mut images);

    ImageGenerateResponse {
        provider_id,
        model,
        images: dedupe_images(images),
        text: if text_parts.is_empty() {
            None
        } else {
            Some(text_parts.join("\n\n"))
        },
        usage: usage_from(&raw),
        raw,
    }
}

#[tauri::command]
pub fn get_image_api_key_status(provider_id: String) -> Result<ImageKeyStatus, String> {
    let has_key = secret_entry(&provider_id)
        .and_then(|entry| entry.get_password().map_err(|e| anyhow!(e.to_string())))
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    Ok(ImageKeyStatus {
        provider_id,
        has_key,
    })
}

#[tauri::command]
pub fn save_image_api_key(provider_id: String, api_key: String) -> Result<(), String> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("API Key 不能为空".into());
    }
    secret_entry(&provider_id)
        .and_then(|entry| {
            entry
                .set_password(api_key)
                .map_err(|e| anyhow!(e.to_string()))
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_image_api_key(provider_id: String) -> Result<(), String> {
    let entry = secret_entry(&provider_id).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(_) => Ok(()),
    }
}

/// 清空已知所有生图供应商的 API Key keyring 凭据。
/// 提供商列表与前端 ImagePage 中 PROVIDERS 常量保持一致；不存在的条目静默忽略。
#[tauri::command]
pub fn clear_all_image_keys() -> Result<u32, String> {
    const KNOWN_PROVIDERS: &[&str] = &[
        "siliconflow",
        "newapi-openai",
        "newapi-gemini-native",
        "newapi-gemini-openai",
        "comfyui-local",
        "comfyui-lan",
    ];
    let mut removed: u32 = 0;
    for provider_id in KNOWN_PROVIDERS {
        if let Ok(entry) = secret_entry(provider_id) {
            // delete_credential 在条目不存在时也会返回 Err，这里统一忽略错误，
            // 仅依赖 get_password 是否成功来判定原本是否存在。
            let existed = entry.get_password().is_ok();
            let _ = entry.delete_credential();
            if existed {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

#[tauri::command]
pub async fn generate_image(
    request: ImageGenerateRequest,
) -> Result<ImageGenerateResponse, String> {
    let provider_id = request.provider_id.trim().to_string();
    let is_comfyui = matches!(provider_id.as_str(), "comfyui-local" | "comfyui-lan");
    let api_key = if is_comfyui {
        String::new()
    } else {
        load_api_key(&provider_id).map_err(|e| e.to_string())?
    };
    if request.base_url.trim().is_empty() {
        return Err("Base URL 不能为空".into());
    }
    if request.model.trim().is_empty() {
        return Err("模型名称不能为空".into());
    }
    if request.prompt.trim().is_empty() {
        return Err("提示词不能为空".into());
    }

    let client = Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;

    let raw = match provider_id.as_str() {
        "siliconflow" => call_siliconflow(&client, &request, &api_key).await,
        "newapi-openai" => {
            let is_edit = request.mode.as_deref() == Some("edit")
                && request
                    .images
                    .as_ref()
                    .map(|items| !items.is_empty())
                    .unwrap_or(false);
            if is_edit {
                call_newapi_openai_edit(&client, &request, &api_key).await
            } else {
                call_newapi_openai_generation(&client, &request, &api_key).await
            }
        }
        "newapi-gemini-native" => call_newapi_gemini_native(&client, &request, &api_key).await,
        "newapi-gemini-openai" => call_newapi_gemini_openai(&client, &request, &api_key).await,
        "comfyui-local" | "comfyui-lan" => call_comfyui(&client, &request).await,
        _ => Err(anyhow!("不支持的生图供应商: {}", provider_id)),
    }
    .map_err(|e| e.to_string())?;

    Ok(normalize_response(provider_id, request.model.clone(), raw))
}
