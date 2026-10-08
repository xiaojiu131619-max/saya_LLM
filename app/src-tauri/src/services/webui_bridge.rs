//! fast-27b 同源桥：把官方 llama.cpp webui 与 fast-27b 引擎的 OpenAI 兼容 API 放到同一个源上。
//!
//! 背景：官方 webui 只会用相对路径请求同源端点（`./props`、`./v1/chat/completions`、
//! `./v1/stream?conv_id=..`），没有「服务器地址」设置项；而 fast-27b 引擎**没有任何 HTML 页面**
//! （`/`、`/props`、`/slots` 都 404），两者无法直接对接。所以由应用在回环上起一个薄转发层：
//!
//! - 静态资产：官方 webui（`services::webui_assets` 内嵌，gzip 原样回给浏览器）；
//! - 转发：`/v1/models` 与其它 `/v1/*` 透传（注入引擎的 `Authorization`）；
//! - 合成：`/props`（webui 强依赖）、`/slots`、`/health`、`/tools`；
//! - 抹平 fast-27b 协议差异：请求体补 `model`、`top_k` 收敛到引擎上限 20；
//! - 仿真 llama-server 的流回放端点：`/v1/stream`（回放/续传/取消）、`/v1/streams/lookup`，
//!   这样官方界面在流被掐断时能续传，而不是弹「Stream connection lost」。
//!
//! 只有 fast-27b 需要它：主模型与 llama.cpp 都是 llama.cpp 服务，浏览器直接开它们的端口即可。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::services::webui_assets;

/// 桥的对外信息（前端拿它显示/打开网页）。
#[derive(Debug, Clone, Serialize)]
pub struct BridgeInfo {
    /// 浏览器打开的地址，如 `http://127.0.0.1:8095`。
    pub url: String,
    /// 实际监听的端口（配置端口被占用时会顺延）。
    pub port: u16,
    /// 引擎 API 端口。
    pub upstream_port: u16,
}

/// 单个流（一次流式补全）的字节账本，用于回放/续传。
struct StreamRecord {
    data: Vec<u8>,
    done: bool,
    cancelled: bool,
    updated: Instant,
}

struct Bridge {
    port: u16,
    upstream_port: u16,
    api_key: String,
    /// 引擎默认输出上限（`--default-max-tokens`）；0 表示未设。官方 webui 读 /props 的
    /// `default_generation_settings.n_predict` 作为界面默认值，必须与引擎真实默认一致，
    /// 否则界面会显示一个引擎并不兑现的上限（此前写死 -1「无限」）。
    default_max_tokens: u32,
    client: reqwest::blocking::Client,
    model: Mutex<ModelCache>,
    streams: Mutex<HashMap<String, StreamRecord>>,
    shutdown: Arc<AtomicBool>,
    inflight: Arc<AtomicUsize>,
    /// accept 循程线程句柄：stop() 等它退出，确保监听端口已释放后再重绑。
    accept: Mutex<Option<thread::JoinHandle<()>>>,
}

#[derive(Debug, Clone, Default)]
struct ModelCache {
    id: String,
    max_model_len: u32,
}

static BRIDGE: Mutex<Option<Arc<Bridge>>> = Mutex::new(None);

/// 同时处理的连接上限（回环自用，防线程爆炸）。
const MAX_INFLIGHT: usize = 32;
/// 请求体上限（多模态 base64 图片会比较大）。
const MAX_BODY: usize = 64 * 1024 * 1024;
/// 流记录保留时长。
const STREAM_TTL: Duration = Duration::from_secs(600);

/// 当前桥信息（未运行返回 None）。
pub fn info() -> Option<BridgeInfo> {
    BRIDGE.lock().ok()?.as_ref().map(|bridge| BridgeInfo {
        url: format!("http://127.0.0.1:{}", bridge.port),
        port: bridge.port,
        upstream_port: bridge.upstream_port,
    })
}

/// 启动（或复用）桥。端口被占用时向后顺延最多 10 个端口。
///
/// `default_max_tokens` 是引擎 `--default-max-tokens` 的取值（0 = 未设），用于让合成的
/// `/props` 与引擎真实默认输出上限保持一致。
pub fn ensure(
    port: u16,
    upstream_port: u16,
    api_key: &str,
    default_max_tokens: u32,
) -> Result<BridgeInfo, String> {
    if let Some(existing) = BRIDGE.lock().ok().and_then(|guard| guard.clone()) {
        if existing.upstream_port == upstream_port
            && existing.api_key == api_key
            && existing.default_max_tokens == default_max_tokens
            && !existing.shutdown.load(Ordering::SeqCst)
        {
            return Ok(BridgeInfo {
                url: format!("http://127.0.0.1:{}", existing.port),
                port: existing.port,
                upstream_port,
            });
        }
        drop(existing);
        stop();
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(None) // 生成可能持续几分钟，整请求截止时间不能卡死流式
        .build()
        .map_err(|err| format!("创建 HTTP 客户端失败：{err}"))?;

    let mut last_error = String::new();
    for candidate in port..port.saturating_add(10) {
        match TcpListener::bind(("127.0.0.1", candidate)) {
            Ok(listener) => {
                let bridge = Arc::new(Bridge {
                    port: candidate,
                    upstream_port,
                    api_key: api_key.to_string(),
                    default_max_tokens,
                    client,
                    model: Mutex::new(ModelCache::default()),
                    streams: Mutex::new(HashMap::new()),
                    shutdown: Arc::new(AtomicBool::new(false)),
                    inflight: Arc::new(AtomicUsize::new(0)),
                    accept: Mutex::new(None),
                });
                refresh_model(&bridge);
                let accept_handle = spawn_accept_loop(Arc::clone(&bridge), listener);
                if let Ok(mut guard) = bridge.accept.lock() {
                    *guard = Some(accept_handle);
                }
                let info = BridgeInfo {
                    url: format!("http://127.0.0.1:{}", candidate),
                    port: candidate,
                    upstream_port,
                };
                if let Ok(mut guard) = BRIDGE.lock() {
                    *guard = Some(bridge);
                }
                log::info!("[webui-bridge] listening on {}{}", info.url, if candidate == port { String::new() } else { format!("（{} 被占用，已顺延）", port) });
                return Ok(info);
            }
            Err(err) => last_error = err.to_string(),
        }
    }
    Err(format!("无法在 127.0.0.1:{} 起网页桥：{last_error}", port))
}

/// 停止桥（应用退出、切换配置时调用）。
///
/// 关闭后 join accept 线程：`ensure()` 重建时往往要绑同一个端口，若旧监听
/// socket 还没被线程释放，绑定会失败而顺延到 port+1（端口漂移），这里等它退干净。
pub fn stop() {
    let bridge = BRIDGE.lock().ok().and_then(|mut guard| guard.take());
    if let Some(bridge) = bridge {
        bridge.shutdown.store(true, Ordering::SeqCst);
        // 连一下自己的端口，把阻塞在 accept 上的线程唤醒。
        let _ = TcpStream::connect(("127.0.0.1", bridge.port));
        let handle = bridge.accept.lock().ok().and_then(|mut guard| guard.take());
        if let Some(handle) = handle {
            let _ = handle.join();
        }
        log::info!("[webui-bridge] stopped (port {})", bridge.port);
    }
}

fn spawn_accept_loop(bridge: Arc<Bridge>, listener: TcpListener) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        for incoming in listener.incoming() {
            if bridge.shutdown.load(Ordering::SeqCst) {
                break;
            }
            match incoming {
                Ok(stream) => {
                    if bridge.inflight.load(Ordering::SeqCst) >= MAX_INFLIGHT {
                        let _ = stream.shutdown(Shutdown::Both);
                        continue;
                    }
                    let bridge = Arc::clone(&bridge);
                    bridge.inflight.fetch_add(1, Ordering::SeqCst);
                    thread::spawn(move || {
                        let _ = handle_connection(&bridge, stream);
                        bridge.inflight.fetch_sub(1, Ordering::SeqCst);
                    });
                }
                Err(_) => continue,
            }
        }
    })
}

// ---------------------------------------------------------------------------
// 请求解析与响应
// ---------------------------------------------------------------------------

struct Request {
    method: String,
    path: String,
    query: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(&name.to_ascii_lowercase()).map(|value| value.as_str())
    }

    fn query_value(&self, key: &str) -> Option<String> {
        for pair in self.query.split('&') {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            if k == key {
                return Some(percent_decode(v));
            }
        }
        None
    }

    /// webui 用 `<convId>::<model>` 当流 id；按 `convId` 归并（模型名可能带空格等差异）。
    fn stream_key(&self) -> String {
        let raw = self
            .header("x-conversation-id")
            .map(|value| value.to_string())
            .or_else(|| self.query_value("conv_id"));
        match raw {
            Some(value) => value.split("::").next().unwrap_or(&value).to_string(),
            None => String::new(),
        }
    }
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(byte) => {
                        out.push(byte);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

fn parse_request(reader: &mut BufReader<TcpStream>) -> Result<Option<Request>, String> {
    let mut line = String::new();
    if reader.read_line(&mut line).map_err(|err| err.to_string())? == 0 {
        return Ok(None);
    }
    let mut parts = line.trim_end().split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("/").to_string();
    if method.is_empty() {
        return Ok(None);
    }
    let (path, query) = match target.split_once('?') {
        Some((path, query)) => (path.to_string(), query.to_string()),
        None => (target, String::new()),
    };

    let mut headers = HashMap::new();
    loop {
        let mut header_line = String::new();
        if reader.read_line(&mut header_line).map_err(|err| err.to_string())? == 0 {
            break;
        }
        let trimmed = header_line.trim_end();
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, value)) = trimmed.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }

    let length: usize = headers
        .get("content-length")
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    if length > MAX_BODY {
        return Err("请求体过大".to_string());
    }
    let mut body = vec![0u8; length];
    if length > 0 {
        reader.read_exact(&mut body).map_err(|err| err.to_string())?;
    }
    Ok(Some(Request { method, path, query, headers, body }))
}

fn write_simple(stream: &mut TcpStream, status: u16, reason: &str, content_type: &str, body: &[u8]) {
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

fn write_json(stream: &mut TcpStream, status: u16, value: &serde_json::Value) {
    write_simple(stream, status, "OK", "application/json; charset=utf-8", value.to_string().as_bytes());
}

fn write_error(stream: &mut TcpStream, status: u16, reason: &str, message: &str) {
    if status >= 500 {
        log::warn!("[webui-bridge] {status} {reason}: {message}");
    } else {
        // 官方界面会顺带请求 /tools、/build.json 之类的可选端点，404 噪声不必上报。
        log::debug!("[webui-bridge] {status} {reason}: {message}");
    }
    write_simple(stream, status, reason, "text/plain; charset=utf-8", message.as_bytes());
}

/// 开始一个 chunked 流式响应，返回是否成功写出响应头。
fn write_stream_head(stream: &mut TcpStream, content_type: &str) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n"
    );
    stream.write_all(head.as_bytes())?;
    stream.flush()
}

fn write_chunk(stream: &mut TcpStream, data: &[u8]) -> std::io::Result<()> {
    if data.is_empty() {
        return Ok(());
    }
    stream.write_all(format!("{:x}\r\n", data.len()).as_bytes())?;
    stream.write_all(data)?;
    stream.write_all(b"\r\n")?;
    stream.flush()
}

fn write_stream_end(stream: &mut TcpStream) {
    let _ = stream.write_all(b"0\r\n\r\n");
    let _ = stream.flush();
}

// ---------------------------------------------------------------------------
// 上游调用
// ---------------------------------------------------------------------------

fn upstream_url(bridge: &Bridge, path_and_query: &str) -> String {
    format!("http://127.0.0.1:{}{}", bridge.upstream_port, path_and_query)
}

fn refresh_model(bridge: &Bridge) {
    let url = upstream_url(bridge, "/v1/models");
    let Ok(response) = bridge
        .client
        .get(url)
        .header("Authorization", format!("Bearer {}", bridge.api_key))
        .send()
    else {
        return;
    };
    let Ok(text) = response.text() else { return };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { return };
    let entry = value.get("data").and_then(|data| data.as_array()).and_then(|rows| rows.first());
    if let Some(entry) = entry {
        let mut cache = bridge.model.lock().unwrap();
        cache.id = entry.get("id").and_then(|id| id.as_str()).unwrap_or("").to_string();
        cache.max_model_len = entry
            .get("max_model_len")
            .and_then(|value| value.as_u64())
            .unwrap_or(0) as u32;
        log::info!("[webui-bridge] 引擎模型 {}（上下文 {}）", cache.id, cache.max_model_len);
    }
}

fn synth_props(bridge: &Bridge) -> serde_json::Value {
    let mut cache = bridge.model.lock().unwrap().clone();
    if cache.id.is_empty() {
        drop(cache);
        refresh_model(bridge);
        cache = bridge.model.lock().unwrap().clone();
    }
    let n_ctx = if cache.max_model_len > 0 { cache.max_model_len } else { 8192 };
    // n_predict 必须反映引擎真实的默认输出上限：官方 webui 用它作为「最大输出」界面的
    // 初值，写死 -1（无限）会让界面显示一个引擎并不兑现的上限。
    // 0 = 未设 --default-max-tokens，此时报 -1（引擎自定，等同于不限制界面输入）。
    let n_predict: i64 = if bridge.default_max_tokens > 0 {
        i64::from(bridge.default_max_tokens)
    } else {
        -1
    };
    let model = if cache.id.is_empty() { "engine".to_string() } else { cache.id.clone() };
    // 默认采样参数用 fast-27b 自己的取值（top_k 20 是引擎上限；repeat_penalty 引擎会忽略）。
    let params = serde_json::json!({
        "seed": 4_294_967_295u32,
        "temperature": 0.8,
        "dynatemp_range": 0.0,
        "dynatemp_exponent": 1.0,
        "top_k": 20,
        "top_p": 0.95,
        "min_p": 0.05,
        "xtc_probability": 0.0,
        "xtc_threshold": 0.1,
        "typical_p": 1.0,
        "repeat_last_n": 64,
        "repeat_penalty": 1.0,
        "presence_penalty": 0.0,
        "frequency_penalty": 0.0,
        "dry_multiplier": 0.0,
        "dry_base": 1.75,
        "dry_allowed_length": 2,
        "dry_penalty_last_n": -1,
        "mirostat": 0,
        "mirostat_tau": 5.0,
        "mirostat_eta": 0.1,
        "samplers": ["top_k", "tfs_z", "typical_p", "top_p", "min_p", "temperature"],
        "n_keep": 0,
        "n_discard": 0,
        "ignore_eos": false,
        "stop": [],
        "n_probs": 0,
        "min_keep": 0,
        "grammar": "",
        "chat_format": ""
    });
    serde_json::json!({
        "model_path": model,
        "model_alias": model,
        "model_ftype": "unknown",
        "build_info": "agent-llm-webui-bridge",
        "is_sleeping": false,
        "total_slots": 1,
        "modalities": { "vision": false, "video": false, "audio": false },
        // fast-27b 不暴露 chat template；空串让界面按「无思考模板」处理（与 --no-thinking 一致）。
        "chat_template": "",
        "cors_proxy_enabled": false,
        "media_marker": "",
        "eos_token": "",
        "bos_token": "",
        "default_generation_settings": {
            "n_ctx": n_ctx,
            "n_predict": n_predict,
            "params": params,
        },
    })
}

/// 抹平 fast-27b 的协议差异：请求体必须带 `model`，`top_k` 只接受 0..20。
fn patch_body(bridge: &Bridge, path: &str, body: &[u8]) -> Vec<u8> {
    if !matches!(path, "/v1/chat/completions" | "/v1/completions" | "/v1/messages") {
        return body.to_vec();
    }
    let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(body) else {
        return body.to_vec();
    };
    let model_id = bridge.model.lock().unwrap().id.clone();
    if !model_id.is_empty() && value.get("model").map(|m| m.is_null()).unwrap_or(true) {
        value["model"] = serde_json::Value::String(model_id);
    }
    if let Some(top_k) = value.get("top_k").and_then(|value| value.as_i64()) {
        value["top_k"] = serde_json::Value::from(top_k.clamp(0, 20));
    }
    serde_json::to_vec(&value).unwrap_or_else(|_| body.to_vec())
}

// ---------------------------------------------------------------------------
// 分发
// ---------------------------------------------------------------------------

fn handle_connection(bridge: &Bridge, stream: TcpStream) -> Result<(), String> {
    let _ = stream.set_nodelay(true);
    // 读超时：浏览器预连接/半开连接不会永久占住一个处理线程（回环上 30 秒足够发完请求头）。
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let mut stream = stream;
    let mut reader = BufReader::new(stream.try_clone().map_err(|err| err.to_string())?);
    let request = match parse_request(&mut reader)? {
        Some(request) => request,
        None => return Ok(()),
    };

    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/") | ("GET", "/index.html") => serve_asset(&mut stream, "index.html", &request),
        ("GET", "/sw.js") => {
            let body = webui_assets::SERVICE_WORKER_STUB.as_bytes();
            write_simple(&mut stream, 200, "OK", "application/javascript; charset=utf-8", body);
            Ok(())
        }
        ("GET", path) if path.starts_with('/') => handle_get(bridge, &mut stream, &request, path),
        ("POST", "/v1/chat/completions") => handle_completion(bridge, &mut stream, &request),
        ("POST", "/v1/streams/lookup") => handle_streams_lookup(bridge, &mut stream, &request),
        ("POST", "/v1/chat/completions/control") => {
            // fast-27b 没有「提前结束思考」的控制面；真正的停止走 DELETE /v1/stream。
            write_json(&mut stream, 200, &serde_json::json!({ "success": true }));
            Ok(())
        }
        ("POST", "/tools") => {
            write_error(&mut stream, 501, "Not Implemented", "fast-27b 引擎不提供内置工具。");
            Ok(())
        }
        ("POST", path) if path.starts_with('/') => proxy(bridge, &mut stream, &request, false),
        ("DELETE", "/v1/stream") => {
            let key = request.stream_key();
            if !key.is_empty() {
                if let Ok(mut streams) = bridge.streams.lock() {
                    if let Some(record) = streams.get_mut(&key) {
                        record.cancelled = true;
                        record.updated = Instant::now();
                    }
                }
            }
            write_json(&mut stream, 200, &serde_json::json!({}));
            Ok(())
        }
        _ => {
            write_error(&mut stream, 404, "Not Found", "桥未实现该路径。");
            Ok(())
        }
    }
}

fn handle_get(bridge: &Bridge, stream: &mut TcpStream, request: &Request, path: &str) -> Result<(), String> {
    match path {
        "/props" => {
            write_json(stream, 200, &synth_props(bridge));
            return Ok(());
        }
        "/slots" => {
            // 空数组：webui 用「所有槽位都空闲」判断能否发送。
            write_json(stream, 200, &serde_json::json!([]));
            return Ok(());
        }
        "/tools" => {
            write_json(stream, 200, &serde_json::json!([]));
            return Ok(());
        }
        "/health" => {
            write_json(stream, 200, &serde_json::json!({ "status": "ok" }));
            return Ok(());
        }
        "/v1/stream" => return replay_stream(bridge, stream, request),
        "/v1/models" => {
            refresh_model(bridge);
            return proxy(bridge, stream, request, false);
        }
        _ => {}
    }
    if let Some(asset) = webui_assets::find(path).or_else(|| webui_assets::find_fallback(path)) {
        return serve_asset(stream, asset.path, request);
    }
    // 未知路径按 llama-server 的 /<model>/props 习惯再兜一次，其余透传给引擎。
    if path.ends_with("/props") {
        write_json(stream, 200, &synth_props(bridge));
        return Ok(());
    }
    proxy(bridge, stream, request, false)
}

fn serve_asset(stream: &mut TcpStream, path: &str, request: &Request) -> Result<(), String> {
    let Some(asset) = webui_assets::find(path) else {
        write_error(stream, 404, "Not Found", "资产不存在。");
        return Ok(());
    };
    let accepts_gzip = request
        .header("accept-encoding")
        .map(|value| value.to_ascii_lowercase().contains("gzip"))
        .unwrap_or(false);
    if !accepts_gzip {
        // 与 llama-server 一致：内嵌资产是 gzip 流，客户端不支持就直接拒绝。
        write_error(stream, 415, "Unsupported Media Type", "gzip is not supported by this browser");
        return Ok(());
    }
    let body = asset.gz_bytes();
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Encoding: gzip\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n",
        asset.mime,
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
    Ok(())
}

/// `/v1/stream?conv_id=<id>[&from=N]`：回放已有字节，若该流仍在生成则继续跟到结束。
fn replay_stream(bridge: &Bridge, stream: &mut TcpStream, request: &Request) -> Result<(), String> {
    let key = request.stream_key();
    let from: usize = request.query_value("from").and_then(|value| value.parse().ok()).unwrap_or(0);
    let exists = bridge
        .streams
        .lock()
        .map(|streams| streams.contains_key(&key))
        .unwrap_or(false);
    if !exists {
        write_error(stream, 404, "Not Found", "没有该会话的流记录（可能是页面刷新前的旧会话）。");
        return Ok(());
    }
    write_stream_head(stream, "text/event-stream; charset=utf-8").map_err(|err| err.to_string())?;
    let mut sent = from;
    let mut idle = Duration::ZERO;
    loop {
        // 只拷贝未发送的增量，不等整个流（长回答下每 50ms 整段 clone 太浪费）。
        let (piece, done, cancelled) = {
            let streams = bridge.streams.lock().map_err(|err| err.to_string())?;
            match streams.get(&key) {
                Some(record) => (
                    record.data[sent.min(record.data.len())..].to_vec(),
                    record.done,
                    record.cancelled,
                ),
                None => (Vec::new(), true, false),
            }
        };
        if !piece.is_empty() {
            sent += piece.len();
            idle = Duration::ZERO;
            if write_chunk(stream, &piece).is_err() {
                return Ok(()); // 客户端断开
            }
        } else if done || cancelled {
            break;
        } else {
            thread::sleep(Duration::from_millis(50));
            idle += Duration::from_millis(50);
            if idle > Duration::from_secs(300) {
                break;
            }
        }
    }
    write_stream_end(stream);
    Ok(())
}

fn handle_streams_lookup(bridge: &Bridge, stream: &mut TcpStream, request: &Request) -> Result<(), String> {
    let wanted: Vec<String> = serde_json::from_slice::<serde_json::Value>(&request.body)
        .ok()
        .and_then(|value| value.get("conversation_ids").and_then(|ids| ids.as_array()).cloned())
        .map(|rows| rows.iter().filter_map(|row| row.as_str().map(|text| text.to_string())).collect())
        .unwrap_or_default();
    let live: Vec<String> = {
        let streams = bridge.streams.lock().map_err(|err| err.to_string())?;
        wanted
            .into_iter()
            .filter(|id| {
                let key = id.split("::").next().unwrap_or(id);
                streams.get(key).map(|record| !record.done).unwrap_or(false)
            })
            .collect()
    };
    write_json(stream, 200, &serde_json::json!(live));
    Ok(())
}

/// 流式补全：打补丁 → 转发 → 边回给浏览器边记进流账本（供回放/续传）。
fn handle_completion(bridge: &Bridge, stream: &mut TcpStream, request: &Request) -> Result<(), String> {
    let body = patch_body(bridge, &request.path, &request.body);
    let key = request.stream_key();
    prune_streams(bridge);
    if !key.is_empty() {
        if let Ok(mut streams) = bridge.streams.lock() {
            streams.insert(
                key.clone(),
                StreamRecord { data: Vec::new(), done: false, cancelled: false, updated: Instant::now() },
            );
        }
    }
    let accept = request.header("accept").unwrap_or("text/event-stream").to_string();
    let response = bridge
        .client
        .post(upstream_url(bridge, "/v1/chat/completions"))
        .header("Authorization", format!("Bearer {}", bridge.api_key))
        .header("Content-Type", "application/json")
        .header("Accept", accept)
        .body(body)
        .send();
    let mut response = match response {
        Ok(response) => response,
        Err(err) => {
            mark_stream(bridge, &key, true, false);
            write_error(stream, 502, "Bad Gateway", &format!("引擎请求失败：{err}"));
            return Ok(());
        }
    };
    let status = response.status().as_u16();
    if status != 200 {
        let text = response.text().unwrap_or_default();
        mark_stream(bridge, &key, true, false);
        write_simple(stream, status, "Upstream Error", "application/json; charset=utf-8", text.as_bytes());
        return Ok(());
    }
    let is_stream = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.contains("text/event-stream"))
        .unwrap_or(false);
    if !is_stream {
        let mut text = Vec::new();
        response.read_to_end(&mut text).map_err(|err| err.to_string())?;
        if !key.is_empty() {
            if let Ok(mut streams) = bridge.streams.lock() {
                if let Some(record) = streams.get_mut(&key) {
                    record.data.extend_from_slice(&text);
                }
            }
        }
        write_simple(stream, 200, "OK", "application/json; charset=utf-8", &text);
        mark_stream(bridge, &key, true, false);
        return Ok(());
    }

    write_stream_head(stream, "text/event-stream; charset=utf-8").map_err(|err| err.to_string())?;
    let mut buffer = [0u8; 4096];
    loop {
        match response.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                let chunk = &buffer[..read];
                if !key.is_empty() {
                    if let Ok(mut streams) = bridge.streams.lock() {
                        if let Some(record) = streams.get_mut(&key) {
                            record.data.extend_from_slice(chunk);
                            record.updated = Instant::now();
                        }
                    }
                }
                if write_chunk(stream, chunk).is_err() {
                    break; // 浏览器断开：放下游响应即让引擎取消本轮
                }
                let cancelled = bridge
                    .streams
                    .lock()
                    .ok()
                    .and_then(|streams| streams.get(&key).map(|record| record.cancelled))
                    .unwrap_or(false);
                if cancelled {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    write_stream_end(stream);
    mark_stream(bridge, &key, true, false);
    Ok(())
}

fn mark_stream(bridge: &Bridge, key: &str, done: bool, cancelled: bool) {
    if key.is_empty() {
        return;
    }
    if let Ok(mut streams) = bridge.streams.lock() {
        if let Some(record) = streams.get_mut(key) {
            record.done |= done;
            record.cancelled |= cancelled;
            record.updated = Instant::now();
        }
    }
}

/// 清理过期流记录，避免长时间运行后内存堆积。
fn prune_streams(bridge: &Bridge) {
    let Ok(mut streams) = bridge.streams.lock() else { return };
    let now = Instant::now();
    streams.retain(|_, record| now.duration_since(record.updated) < STREAM_TTL);
}

/// 通用转发：注入引擎密钥，SSE 走 chunked 流式，其余带 Content-Length 一次性返回。
fn proxy(bridge: &Bridge, stream: &mut TcpStream, request: &Request, _streaming: bool) -> Result<(), String> {
    let target = if request.query.is_empty() {
        request.path.clone()
    } else {
        format!("{}?{}", request.path, request.query)
    };
    let method = reqwest::Method::from_bytes(request.method.as_bytes()).map_err(|err| err.to_string())?;
    let mut builder = bridge
        .client
        .request(method, upstream_url(bridge, &target))
        .header("Authorization", format!("Bearer {}", bridge.api_key));
    if let Some(content_type) = request.header("content-type") {
        builder = builder.header("Content-Type", content_type);
    }
    if let Some(accept) = request.header("accept") {
        builder = builder.header("Accept", accept);
    }
    if !request.body.is_empty() {
        builder = builder.body(request.body.clone());
    }
    let mut response = match builder.send() {
        Ok(response) => response,
        Err(err) => {
            write_error(stream, 502, "Bad Gateway", &format!("引擎请求失败：{err}"));
            return Ok(());
        }
    };
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/json; charset=utf-8")
        .to_string();
    if content_type.contains("text/event-stream") {
        write_stream_head(stream, &content_type).map_err(|err| err.to_string())?;
        let mut buffer = [0u8; 4096];
        loop {
            match response.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    if write_chunk(stream, &buffer[..read]).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        write_stream_end(stream);
        return Ok(());
    }
    let mut text = Vec::new();
    response.read_to_end(&mut text).map_err(|err| err.to_string())?;
    let reason = if status == 200 { "OK" } else { "Upstream Error" };
    write_simple(stream, status, reason, &content_type, &text);
    Ok(())
}

#[cfg(test)]
#[path = "webui_bridge_tests.rs"]
mod tests;
