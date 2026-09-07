//! dsh `settings.yaml` 配置管理（F5 本地模型接入，Phase 3）。
//!
//! Phase 0 定稿策略（docs/DSH_SPIKE_RECORD.md）：
//! - **只在 dsh 停止时写入**（热加载不可观测，且 dsh 自身经同一串行链整文档回写，
//!   运行中外部重写有被覆盖风险）——由调用方（commands::dsh）保证时序；
//! - 只维护本应用的两处键：`llm-pi-ai.providers.agent-llm-local` 与顶层
//!   `agent-default-model`，其余配置（用户在 dsh Web UI 的改动）原样保留；
//! - 每次写入前备份为 `settings.yaml.bak`（单份滚动），失败不落盘；
//! - 接入校验 = `/v1/models` 之外再做一次真实小补全：Qwen 系推理模型的回复在
//!   `reasoning_content`、正式回答在 `content`，两者任一非空即认为链路可用。

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_yaml::Value;

/// 本应用在 dsh 中的提供方 ID（Phase 0 定稿）。
pub const PROVIDER_ID: &str = "agent-llm-local";
/// 提供方显示名。
pub const PROVIDER_DISPLAY_NAME: &str = "Agent LLM 本地模型";

fn settings_path() -> PathBuf {
    crate::services::dsh_installer::dsh_home_dir().join("settings.yaml")
}

/// 读取 settings.yaml 为 YAML 值；文件不存在或为空时返回空映射。
fn read_root_at(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(Value::Mapping(serde_yaml::Mapping::new()));
    }
    let text = std::fs::read_to_string(path).map_err(|e| format!("无法读取 settings.yaml：{}", e))?;
    if text.trim().is_empty() {
        return Ok(Value::Mapping(serde_yaml::Mapping::new()));
    }
    let value: Value = serde_yaml::from_str(&text).map_err(|e| {
        format!(
            "settings.yaml 解析失败（{}）。已中止写入，不会覆盖你现有的 dsh 配置；可先在 dsh Web UI 检查该文件。",
            e
        )
    })?;
    if !value.is_mapping() {
        return Err("settings.yaml 顶层不是键值结构，已中止写入以保护现有配置。".to_string());
    }
    Ok(value)
}

/// 备份并写入 settings.yaml。
fn write_root_at(path: &Path, root: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("无法创建 dsh-home 目录：{}", e))?;
    }
    if path.exists() {
        let backup = path.with_extension("yaml.bak");
        std::fs::copy(path, &backup).map_err(|e| format!("无法备份 settings.yaml：{}", e))?;
    }
    let text = serde_yaml::to_string(root).map_err(|e| format!("无法序列化 settings.yaml：{}", e))?;
    std::fs::write(path, text).map_err(|e| format!("无法写入 settings.yaml：{}", e))
}

fn read_root() -> Result<Value, String> {
    read_root_at(&settings_path())
}

fn write_root(root: &Value) -> Result<(), String> {
    write_root_at(&settings_path(), root)
}

/// 在嵌套映射中按路径设值（中间节点不存在则创建）。
fn set_nested(root: &mut Value, keys: &[&str], value: Value) {
    let mut current = root;
    for (index, key) in keys.iter().enumerate() {
        if !current.is_mapping() {
            *current = Value::Mapping(serde_yaml::Mapping::new());
        }
        let mapping = current.as_mapping_mut().expect("已确保是映射");
        let key_value = Value::String(key.to_string());
        if index == keys.len() - 1 {
            mapping.insert(key_value, value);
            return;
        }
        current = mapping
            .entry(key_value)
            .or_insert_with(|| Value::Mapping(serde_yaml::Mapping::new()));
    }
}

/// 写入/更新本应用的提供方，并把它设为 dsh 会话默认模型。
pub fn write_provider(
    base_url: &str,
    model_id: &str,
    api_key: Option<&str>,
    context_window: Option<u32>,
) -> Result<(), String> {
    write_provider_at(&settings_path(), base_url, model_id, api_key, context_window)
}

/// `write_provider` 的路径参数化版本（单测使用）。
pub(crate) fn write_provider_at(
    path: &Path,
    base_url: &str,
    model_id: &str,
    api_key: Option<&str>,
    context_window: Option<u32>,
) -> Result<(), String> {
    let mut root = read_root_at(path)?;
    let authorization = format!("Bearer {}", api_key.unwrap_or("unused"));
    // contextWindow 用真实运行配置（否则省略，让 dsh 按协议默认），
    // maxTokens 不再写死：dsh 会话输出上限跟随模型实际能力，而非固定 8192。
    let model_entry = match context_window {
        Some(ctx) => serde_json::json!({
            "id": model_id,
            "name": model_id,
            "contextWindow": ctx,
        }),
        None => serde_json::json!({
            "id": model_id,
            "name": model_id,
        }),
    };
    let provider = serde_yaml::to_value(serde_json::json!({
        "displayName": PROVIDER_DISPLAY_NAME,
        "api": "openai-completions",
        "baseURL": format!("{}/v1", base_url.trim_end_matches('/')),
        "headers": { "authorization": authorization },
        "models": [ model_entry ],
    }))
    .map_err(|e| format!("无法构造提供方配置：{}", e))?;
    set_nested(
        &mut root,
        &["llm-pi-ai", "providers", PROVIDER_ID],
        provider,
    );
    let default_model = serde_yaml::to_value(serde_json::json!({
        "provider": PROVIDER_ID,
        "model": model_id,
    }))
    .map_err(|e| format!("无法构造默认模型配置：{}", e))?;
    set_nested(&mut root, &["agent-default-model"], default_model);
    write_root_at(path, &root)
}

/// 移除本应用的提供方与默认模型设置（其他配置原样保留）。
pub fn remove_provider() -> Result<(), String> {
    remove_provider_at(&settings_path())
}

/// `remove_provider` 的路径参数化版本（单测使用）。
pub(crate) fn remove_provider_at(path: &Path) -> Result<(), String> {
    let mut root = read_root_at(path)?;
    let our_provider = Value::String(PROVIDER_ID.to_string());
    if let Some(providers) = root
        .get_mut("llm-pi-ai")
        .and_then(|value| value.get_mut("providers"))
        .and_then(|value| value.as_mapping_mut())
    {
        providers.remove(&our_provider);
    }
    // agent-default-model 仅在仍指向本应用提供方时移除，避免误删用户手动改的默认值。
    let points_at_ours = root
        .get("agent-default-model")
        .and_then(|value| value.get("provider"))
        == Some(&our_provider);
    if points_at_ours {
        if let Some(mapping) = root.as_mapping_mut() {
            mapping.remove(&Value::String("agent-default-model".to_string()));
        }
    }
    write_root_at(path, &root)
}

/// 真实小补全校验：直接请求 llama-server 的 OpenAI 兼容端点，
/// content 或 reasoning_content 任一非空即通过（推理模型小 max_tokens 下
/// 可能只有思考内容，见 spike 兼容性清单）。
pub fn verify_model_completion(
    base_url: &str,
    model_id: &str,
    api_key: Option<&str>,
) -> Result<(), String> {
    let url = format!(
        "{}/v1/chat/completions",
        base_url.trim_end_matches('/')
    );
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(60))
        .no_proxy()
        .build()
        .map_err(|e| format!("无法创建校验客户端：{}", e))?;
    let body = serde_json::json!({
        "model": model_id,
        "messages": [ { "role": "user", "content": "Reply with exactly one word: OK" } ],
        "max_tokens": 256,
        "temperature": 0
    });
    let mut request = client.post(&url).json(&body);
    if let Some(key) = api_key.map(str::trim).filter(|key| !key.is_empty()) {
        request = request.bearer_auth(key);
    }
    let response = request
        .send()
        .map_err(|e| format!("无法连接本地模型端点（{}）：{}", url, e))?;
    let status = response.status();
    let text = response.text().unwrap_or_default();
    if !status.is_success() {
        let snippet: String = text.chars().take(200).collect();
        return Err(format!("本地模型返回 {}：{}", status, snippet));
    }
    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("本地模型返回了无法解析的响应：{}", e))?;
    let message = &value["choices"][0]["message"];
    let content = message["content"].as_str().unwrap_or("").trim();
    let reasoning = message["reasoning_content"].as_str().unwrap_or("").trim();
    if content.is_empty() && reasoning.is_empty() {
        return Err(
            "本地模型返回了空回复：请确认模型能正常对话（可在「模型」页的对话中试一句）。".to_string(),
        );
    }
    Ok(())
}

/// 直接探测指定端口的 `/v1/models`（不依赖应用进程内状态，
/// 覆盖 llama-server 由外部/上次会话启动的场景）。返回模型 id 列表。
pub fn probe_models_at(port: u16) -> Result<Vec<String>, String> {
    let url = format!("http://127.0.0.1:{}/v1/models", port);
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(3))
        .no_proxy()
        .build()
        .map_err(|e| format!("无法创建探测客户端：{}", e))?;
    let response = client
        .get(&url)
        .send()
        .map_err(|e| format!("端口 {} 无响应：{}", port, e))?;
    if !response.status().is_success() {
        return Err(format!("端口 {} 返回 {}", port, response.status()));
    }
    let text = response.text().map_err(|e| format!("读取响应失败：{}", e))?;
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("响应不是有效 JSON：{}", e))?;
    let models = value["data"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item["id"].as_str().map(str::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if models.is_empty() {
        return Err(format!("端口 {} 未列出任何模型。", port));
    }
    Ok(models)
}

/// 读取当前绑定信息（供状态查询；未绑定时返回空）。
pub fn read_binding() -> (Option<String>, Option<String>) {
    read_binding_at(&settings_path())
}

/// `read_binding` 的路径参数化版本（单测使用）。
pub(crate) fn read_binding_at(path: &Path) -> (Option<String>, Option<String>) {
    let Ok(root) = read_root_at(path) else {
        return (None, None);
    };
    let provider = root.get("agent-default-model").and_then(|value| {
        value
            .get("provider")
            .and_then(|provider| provider.as_str())
            .map(str::to_string)
    });
    if provider.as_deref() != Some(PROVIDER_ID) {
        return (None, None);
    }
    let model = root
        .get("agent-default-model")
        .and_then(|value| value.get("model"))
        .and_then(|model| model.as_str())
        .map(str::to_string);
    let base_url = root
        .get("llm-pi-ai")
        .and_then(|value| value.get("providers"))
        .and_then(|value| value.get(PROVIDER_ID))
        .and_then(|value| value.get("baseURL"))
        .and_then(|url| url.as_str())
        .map(str::to_string);
    (model, base_url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_settings(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "agent-llm-dsh-config-test-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("settings.yaml")
    }

    const USER_KEYS_YAML: &str = "ui-onboarding:\n  welcomeNoticeVersion: 2026-08-13.1\nagent-presets:\n  default: minimal\n";

    #[test]
    fn write_read_roundtrip_and_user_keys_preserved() {
        let path = temp_settings("roundtrip");
        std::fs::write(&path, USER_KEYS_YAML).unwrap();

        write_provider_at(&path, "http://127.0.0.1:8080", "demo-model", None, Some(32768)).unwrap();
        let (model, base_url) = read_binding_at(&path);
        assert_eq!(model.as_deref(), Some("demo-model"));
        assert_eq!(base_url.as_deref(), Some("http://127.0.0.1:8080/v1"));

        // 用户自己的键在写入后必须原样保留。
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("welcomeNoticeVersion"));
        assert!(text.contains("agent-presets"));

        // contextWindow 上报真实上下文；maxTokens 不再写死（省略跟随协议默认）。
        assert!(text.contains("contextWindow: 32768"));
        assert!(!text.contains("maxTokens"), "maxTokens 不应再写死，应省略由协议默认");

        // 备份文件在首次写入时生成。
        assert!(path.with_extension("yaml.bak").exists());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn remove_provider_keeps_user_keys_and_foreign_default() {
        let path = temp_settings("remove");
        std::fs::write(&path, USER_KEYS_YAML).unwrap();
        write_provider_at(&path, "http://127.0.0.1:9000", "m1", None, None).unwrap();

        // 用户手动把默认模型改成别的提供方时，解除接入不得误删。
        let mut root = read_root_at(&path).unwrap();
        set_nested(
            &mut root,
            &["agent-default-model"],
            serde_yaml::to_value(serde_json::json!({"provider": "other", "model": "x"})).unwrap(),
        );
        write_root_at(&path, &root).unwrap();

        remove_provider_at(&path).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("agent-llm-local"));
        assert!(text.contains("other"), "用户手动设置的默认模型应保留");
        assert!(text.contains("welcomeNoticeVersion"));

        // 默认模型仍指向本应用时才一并移除。
        write_provider_at(&path, "http://127.0.0.1:9000", "m1", None, None).unwrap();
        remove_provider_at(&path).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("agent-default-model"));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn binding_absent_when_default_points_elsewhere() {
        let path = temp_settings("foreign");
        std::fs::write(&path, USER_KEYS_YAML).unwrap();
        let (model, base_url) = read_binding_at(&path);
        assert_eq!(model, None);
        assert_eq!(base_url, None);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn set_nested_creates_intermediate_maps() {
        let mut root = Value::Mapping(serde_yaml::Mapping::new());
        set_nested(
            &mut root,
            &["a", "b", "c"],
            Value::String("v".to_string()),
        );
        assert_eq!(
            root["a"]["b"]["c"].as_str(),
            Some("v")
        );
    }
}
