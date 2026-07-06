use reqwest::{multipart, Client};
use serde_json::Value;
use std::time::Duration;

fn build_url(base_url: &str, path: &str) -> Result<String, String> {
    let base = base_url.trim().trim_end_matches('/');
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err("Comfy 地址必须以 http:// 或 https:// 开头。".to_string());
    }
    let normalized_path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    Ok(format!("{base}{normalized_path}"))
}

async fn parse_response(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("读取 Comfy 响应失败：{error}"))?;
    if !status.is_success() {
        return Err(format!("Comfy 请求失败（HTTP {status}）：{text}"));
    }
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&text).map_err(|error| format!("解析 Comfy JSON 失败：{error}"))
}

fn client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| format!("创建 Comfy HTTP 客户端失败：{error}"))
}

#[tauri::command]
pub async fn comfy_get_json(base_url: String, path: String) -> Result<Value, String> {
    let url = build_url(&base_url, &path)?;
    let response = client()?
        .get(url)
        .send()
        .await
        .map_err(|error| format!("连接 Comfy 失败：{error}"))?;
    parse_response(response).await
}

#[tauri::command]
pub async fn comfy_post_json(base_url: String, path: String, payload: Value) -> Result<Value, String> {
    let url = build_url(&base_url, &path)?;
    let response = client()?
        .post(url)
        .json(&payload)
        .send()
        .await
        .map_err(|error| format!("连接 Comfy 失败：{error}"))?;
    parse_response(response).await
}

#[tauri::command]
pub async fn comfy_upload_image(
    base_url: String,
    filename: String,
    data: Vec<u8>,
    overwrite: bool,
) -> Result<Value, String> {
    let url = build_url(&base_url, "/upload/image")?;
    let part = multipart::Part::bytes(data).file_name(filename);
    let form = multipart::Form::new()
        .part("image", part)
        .text("overwrite", overwrite.to_string());
    let response = client()?
        .post(url)
        .multipart(form)
        .send()
        .await
        .map_err(|error| format!("上传图片到 Comfy 失败：{error}"))?;
    parse_response(response).await
}
