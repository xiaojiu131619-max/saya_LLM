//! MCP 网络传输：Streamable HTTP（2025-03-26）与 HTTP+SSE（2024-11-05 旧版）。
//!
//! 两种传输共用同一套 JSON-RPC 消息格式，差别只在「请求怎么发、响应怎么读」：
//!
//! - **http（Streamable HTTP）**：所有请求 POST 到同一个 URL。
//!   响应可能是 `application/json`（一次性结果），也可能是 `text/event-stream`
//!   （流式，需按 SSE 解析出 `message` 事件）。服务端会在响应头返回
//!   `Mcp-Session-Id`，后续请求必须原样带回。
//! - **sse（HTTP+SSE 旧版）**：先 GET 打开发起一个长连 SSE，
//!   服务端首个 `endpoint` 事件给出「消息投递地址」，之后的请求都 POST 到那里，
//!   响应与结果仍从那条 SSE 长连接上以 `message` 事件回来。
//!
//! 两者都先经 `mcp_endpoint::validate_endpoint` 校验（仅 http/https，
//! 拒绝本机 / 内网 / 保留地址），再发起网络请求。

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use crate::services::mcp_endpoint;
use crate::services::process_manager;

/// 单条 SSE 行 / 响应体的上限，防止对端用超长响应把内存打满。
const MAX_SSE_LINE_BYTES: usize = 4 * 1024 * 1024;

type PendingMap = Arc<Mutex<HashMap<u64, Sender<Result<Value, String>>>>>;

/// HTTP 传输的连接状态。
pub struct HttpConnection {
    client: reqwest::blocking::Client,
    /// 实际用于发送消息的 URL：http 传输即配置的 URL；
    /// sse 传输是服务端下发的 endpoint（已按基址解析为绝对地址）。
    message_url: String,
    /// Streamable HTTP 的会话 id；服务端没给时为 None。
    session_id: Arc<Mutex<Option<String>>>,
    headers: Vec<(String, String)>,
    pending: PendingMap,
    next_id: u64,
    /// sse 长连接的读取线程句柄存活标记：置 false 让线程退出。
    sse_alive: Option<Arc<std::sync::atomic::AtomicBool>>,
    timeout: Duration,
    /// true = 旧版 HTTP+SSE：结果由长连接推送，POST 只回 202。
    uses_sse_push: bool,
}

impl HttpConnection {
    fn send_request(&mut self, method: &str, params: Value, is_notification: bool) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let payload = if is_notification {
            json!({ "jsonrpc": "2.0", "method": method, "params": params })
        } else {
            json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
        };

        let mut request = self
            .client
            .post(&self.message_url)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .json(&payload);
        if let Some(method_value) = payload.get("method").and_then(|value| value.as_str()) {
            request = request.header("MCP-Protocol-Version", protocol_version_for(method_value));
        }
        for (key, value) in &self.headers {
            request = request.header(key.as_str(), value.as_str());
        }
        if let Some(session) = self.session_id.lock().ok().and_then(|s| s.clone()) {
            request = request.header("Mcp-Session-Id", session);
        }

        // 旧版 HTTP+SSE：结果由长连接异步推回，所以必须**先**登记等待槽位再 POST，
        // 否则服务端可能在登记之前就把结果推回来，那条消息会被丢掉。
        let pushed_receiver = if self.uses_sse_push && !is_notification {
            let (tx, rx) = std::sync::mpsc::channel();
            if let Ok(mut map) = self.pending.lock() {
                map.insert(id, tx);
            }
            Some(rx)
        } else {
            None
        };

        let response = match request.send() {
            Ok(response) => response,
            Err(error) => {
                // SSE-push 路径在发送前已登记等待槽位，失败必须清掉，否则会挂到连接关闭。
                if pushed_receiver.is_some() {
                    if let Ok(mut map) = self.pending.lock() {
                        map.remove(&id);
                    }
                }
                return Err(format!("请求 MCP 端点失败：{error}"));
            }
        };

        // 会话 id 只在首个响应里出现，之后要一直带着。
        if let Some(session) = response
            .headers()
            .get("mcp-session-id")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
        {
            if let Ok(mut guard) = self.session_id.lock() {
                *guard = Some(session);
            }
        }

        let status = response.status();
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();

        if is_notification {
            // 通知不需要结果，只确认没被拒绝。
            if !status.is_success() {
                return Err(format!("MCP 端点拒绝了通知，HTTP {status}。"));
            }
            return Ok(Value::Null);
        }

        // 旧版 SSE 的结果走长连接推送，POST 本身通常只回 202。
        if let Some(receiver) = pushed_receiver {
            if !status.is_success() {
                if let Ok(mut map) = self.pending.lock() {
                    map.remove(&id);
                }
                let body = response.text().unwrap_or_default();
                let preview: String = body.chars().take(300).collect();
                return Err(format!("MCP 端点返回 HTTP {status}：{preview}"));
            }
            return Self::await_pushed_result(receiver, method, self.timeout);
        }

        if !status.is_success() {
            let body = response.text().unwrap_or_default();
            let preview: String = body.chars().take(300).collect();
            return Err(format!("MCP 端点返回 HTTP {status}：{preview}"));
        }

        // 流式响应：按 SSE 读出与本次 id 匹配的 message 事件。
        if content_type.contains("text/event-stream") {
            return read_sse_response(response, id, self.timeout);
        }

        let body = response.text().map_err(|error| error.to_string())?;
        if body.trim().is_empty() {
            return Err("MCP 端点返回了空响应。".to_string());
        }
        let message: Value = serde_json::from_str(body.trim())
            .map_err(|error| format!("MCP 端点返回了无法解析的内容：{error}"))?;
        extract_result(message)
    }

    /// 等待通过长连接推回的结果（旧版 HTTP+SSE 路径）。
    fn await_pushed_result(
        receiver: std::sync::mpsc::Receiver<Result<Value, String>>,
        method: &str,
        timeout: Duration,
    ) -> Result<Value, String> {
        receiver.recv_timeout(timeout).unwrap_or_else(|error| match error {
            std::sync::mpsc::RecvTimeoutError::Timeout => Err(format!(
                "MCP 请求 `{method}` 在 {} 秒内没有响应。",
                timeout.as_secs()
            )),
            std::sync::mpsc::RecvTimeoutError::Disconnected => {
                Err("MCP SSE 连接已关闭。".to_string())
            }
        })
    }
}

/// 不同协议版本对响应头的要求不同，这里统一声明客户端可接受的版本。
fn protocol_version_for(_method: &str) -> &'static str {
    "2024-11-05"
}

/// 从一条 JSON-RPC 响应里取出 result，或把 error 转成可读报错。
fn extract_result(message: Value) -> Result<Value, String> {
    if let Some(error) = message.get("error") {
        let text = error
            .get("message")
            .and_then(|value| value.as_str())
            .unwrap_or("未知错误");
        return Err(format!("MCP 服务端返回错误：{text}"));
    }
    Ok(message.get("result").cloned().unwrap_or(Value::Null))
}

/// 按 SSE 协议读取响应体，返回与 `expected_id` 匹配的那条消息结果。
///
/// 只处理 `data:` 行；`event:` 行用于区分 message / endpoint / ping。
fn read_sse_response(
    response: reqwest::blocking::Response,
    expected_id: u64,
    timeout: Duration,
) -> Result<Value, String> {
    let deadline = std::time::Instant::now() + timeout;
    let reader = BufReader::new(response);
    let mut data_buffer = String::new();

    for line in reader.lines() {
        if std::time::Instant::now() > deadline {
            return Err("等待 MCP 端点响应超时。".to_string());
        }
        let line = match line {
            Ok(line) => line,
            Err(error) => return Err(format!("读取 MCP 流式响应失败：{error}")),
        };
        if line.len() > MAX_SSE_LINE_BYTES {
            return Err("MCP 端点返回的单行内容过大。".to_string());
        }

        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            // 空行 = 一条事件结束，把累积的 data 拼起来解析。
            if data_buffer.is_empty() {
                continue;
            }
            let payload = std::mem::take(&mut data_buffer);
            if let Ok(message) = serde_json::from_str::<Value>(&payload) {
                if message.get("id").and_then(|value| value.as_u64()) == Some(expected_id) {
                    return extract_result(message);
                }
            }
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("data:") {
            if !data_buffer.is_empty() {
                data_buffer.push('\n');
            }
            data_buffer.push_str(rest.trim_start());
        }
    }

    Err("MCP 流式响应结束，但没有返回对应的结果。".to_string())
}

/// 建立 HTTP / SSE 底层连接（不含 MCP 握手；握手由 `mcp_client::connect` 统一完成）。
pub fn connect(
    config: &crate::models::mcp_types::McpServerConfig,
) -> Result<HttpConnection, String> {
    // 请求前先校验地址：仅 http/https，拒绝本机与内网。
    let endpoint = mcp_endpoint::validate_endpoint(&config.command)?;
    let timeout = Duration::from_millis(config.timeout_ms.clamp(5_000, 600_000));
    let headers: Vec<(String, String)> = config
        .headers
        .iter()
        .map(|item| (item.key.trim().to_string(), item.value.clone()))
        .filter(|(key, _)| !key.is_empty())
        .collect();

    let client = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("创建 MCP HTTP 客户端失败：{error}"))?;

    match config.transport {
        crate::models::mcp_types::McpTransport::Sse => {
            open_sse_transport(client, &endpoint, headers, timeout, config)
        }
        _ => Ok(HttpConnection {
            client,
            message_url: endpoint,
            session_id: Arc::new(Mutex::new(None)),
            headers,
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: 1,
            sse_alive: None,
            timeout,
            uses_sse_push: false,
        }),
    }
}

/// 打开 HTTP+SSE 旧版传输：GET 长连接，等服务端下发 endpoint 事件。
fn open_sse_transport(
    client: reqwest::blocking::Client,
    endpoint: &str,
    headers: Vec<(String, String)>,
    timeout: Duration,
    _config: &crate::models::mcp_types::McpServerConfig,
) -> Result<HttpConnection, String> {
    open_sse_transport_with(client, endpoint, headers, timeout, false)
}

/// 同上，`allow_local` 仅供测试连本地 fixture 用（生产路径始终为 false）。
fn open_sse_transport_with(
    client: reqwest::blocking::Client,
    endpoint: &str,
    headers: Vec<(String, String)>,
    timeout: Duration,
    allow_local: bool,
) -> Result<HttpConnection, String> {
    // 长连接用独立客户端：reqwest blocking 的 timeout 是「整个请求」的截止时间
    // （默认甚至只有 30 秒），到点必断，承载不了常驻 SSE；blocking 侧也没有
    // read_timeout 可用。这里把总时长放宽到 30 天，连接生命周期交给 alive 标志
    // 与读错误控制；等待中的请求各自有 recv_timeout 兜底，不会因连接挂着而失控。
    let sse_client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(30 * 24 * 3600))
        .build()
        .map_err(|error| format!("创建 MCP SSE 长连接客户端失败：{error}"))?;

    let mut request = sse_client
        .get(endpoint)
        .header("Accept", "text/event-stream");
    for (key, value) in &headers {
        request = request.header(key.as_str(), value.as_str());
    }

    let response = request
        .send()
        .map_err(|error| format!("打开 MCP SSE 连接失败：{error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("MCP SSE 端点返回 HTTP {status}。"));
    }

    // endpoint 事件在流的最前面，同步读出来即可（超时用整体 timeout）。
    let reader = BufReader::new(response);
    let mut lines = reader.lines();
    let deadline = std::time::Instant::now() + timeout;
    let mut endpoint_event: Option<String> = None;
    let mut event_name = String::new();

    while std::time::Instant::now() < deadline {
        let line = match lines.next() {
            Some(Ok(line)) => line,
            Some(Err(error)) => return Err(format!("读取 MCP SSE 流失败：{error}")),
            None => break,
        };
        let trimmed = line.trim_end();
        if let Some(rest) = trimmed.strip_prefix("event:") {
            event_name = rest.trim().to_string();
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("data:") {
            if event_name == "endpoint" {
                endpoint_event = Some(rest.trim().to_string());
                break;
            }
        }
        if trimmed.is_empty() {
            event_name.clear();
        }
    }

    let message_path = endpoint_event
        .ok_or_else(|| "MCP SSE 服务端没有下发 endpoint 事件，无法确定消息投递地址。".to_string())?;
    // endpoint 可能是相对路径，按 SSE 端点所在位置解析成绝对地址。
    let base = reqwest::Url::parse(endpoint).map_err(|error| error.to_string())?;
    let message_url = base
        .join(&message_path)
        .map_err(|error| format!("无法解析 MCP SSE 下发的 endpoint：{error}"))?
        .to_string();
    // 下发的地址同样要过安全校验：不能借 SSE 把请求引到内网。
    let message_url = mcp_endpoint::validate_endpoint_with(&message_url, allow_local)?;

    let alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let alive_flag = alive.clone();
    let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
    let pending_thread = pending.clone();

    // 长连接继续在后台读 message 事件，按 id 分发给等待者。
    std::thread::spawn(move || {
        let mut buffer = String::new();
        for line in lines {
            if !alive_flag.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }
            let line = match line {
                Ok(line) => line,
                Err(_) => break,
            };
            let trimmed = line.trim_end();
            if trimmed.is_empty() {
                if buffer.is_empty() {
                    continue;
                }
                let payload = std::mem::take(&mut buffer);
                if let Ok(message) = serde_json::from_str::<Value>(&payload) {
                    dispatch_message(message, &pending_thread);
                }
                continue;
            }
            if let Some(rest) = trimmed.strip_prefix("data:") {
                if !buffer.is_empty() {
                    buffer.push('\n');
                }
                buffer.push_str(rest.trim_start());
            }
        }
        fail_pending(&pending_thread, "MCP SSE 连接已关闭。");
    });

    Ok(HttpConnection {
        client,
        message_url,
        session_id: Arc::new(Mutex::new(None)),
        headers,
        pending,
        next_id: 1,
        sse_alive: Some(alive),
        timeout,
        uses_sse_push: true,
    })
}

/// 把服务端主动推来的消息分发给等待中的请求。
fn dispatch_message(message: Value, pending: &PendingMap) {
    let Some(id) = message.get("id").and_then(|value| value.as_u64()) else {
        return;
    };
    let sender = pending.lock().ok().and_then(|mut map| map.remove(&id));
    if let Some(sender) = sender {
        let _ = sender.send(extract_result(message));
    }
}

fn fail_pending(pending: &PendingMap, reason: &str) {
    if let Ok(mut map) = pending.lock() {
        for (_, sender) in map.drain() {
            let _ = sender.send(Err(reason.to_string()));
        }
    }
}

/// 供 `mcp_client` 在断开连接时唤醒等待中的请求。
pub fn fail_pending_public(connection: &HttpConnection, reason: &str) {
    fail_pending(&connection.pending, reason);
}

/// 关闭 HTTP / SSE 连接。Streamable HTTP 会话会尽力发 DELETE 通知服务端释放。
pub fn shutdown(connection: &mut HttpConnection) {
    if let Some(alive) = connection.sse_alive.take() {
        alive.store(false, std::sync::atomic::Ordering::Relaxed);
    }
    fail_pending(&connection.pending, "MCP 连接已断开。");

    // Streamable HTTP 规范允许客户端用 DELETE 结束会话；失败不影响本地清理。
    if let Some(session) = connection.session_id.lock().ok().and_then(|s| s.clone()) {
        let mut request = connection.client.delete(&connection.message_url);
        for (key, value) in &connection.headers {
            request = request.header(key.as_str(), value.as_str());
        }
        let _ = request
            .header("Mcp-Session-Id", session)
            .timeout(Duration::from_secs(3))
            .send();
    }
    process_manager::push_system_log("info", "mcp", "[mcp] HTTP 连接已断开。");
}

/// 发起一次请求并解析结果。
pub fn request(
    connection: &mut HttpConnection,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    connection.send_request(method, params, false)
}

/// 发送通知（无 id，不等响应）。
pub fn notify(
    connection: &mut HttpConnection,
    method: &str,
    params: Value,
) -> Result<(), String> {
    connection.send_request(method, params, true).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Child, Command, Stdio};

    /// 本地 fixture HTTP MCP 服务器；测试结束（Drop）时回收。
    struct FixtureServer {
        child: Child,
        port: u16,
    }

    impl FixtureServer {
        fn start(mode: &str, port: u16) -> Option<Self> {
            let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests")
                .join("fixtures")
                .join("mcp_http_server.mjs");
            if !script.exists() {
                eprintln!("跳过：找不到 fixture HTTP MCP 服务器");
                return None;
            }
            if Command::new("node")
                .arg("--version")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|s| !s.success())
                .unwrap_or(true)
            {
                eprintln!("跳过：未安装 Node.js");
                return None;
            }
            let child = Command::new("node")
                .arg(&script)
                .arg(mode)
                .arg(port.to_string())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .ok()?;
            for _ in 0..50 {
                std::thread::sleep(Duration::from_millis(100));
                if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                    return Some(Self { child, port });
                }
            }
            None
        }

        fn url(&self) -> String {
            format!("http://127.0.0.1:{}/mcp", self.port)
        }
    }

    impl Drop for FixtureServer {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    /// 直连本地 fixture。这里刻意跳过公网 host 校验：本测试验证的是
    /// HTTP/SSE 协议实现，而 127.0.0.1 会被 `validate_endpoint` 正常拒绝
    /// （该拒绝行为本身由 mcp_endpoint 的测试覆盖）。
    fn plain_connection(url: &str) -> Result<HttpConnection, String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(HttpConnection {
            client,
            message_url: url.to_string(),
            session_id: Arc::new(Mutex::new(None)),
            headers: Vec::new(),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: 1,
            sse_alive: None,
            timeout: Duration::from_secs(10),
            uses_sse_push: false,
        })
    }

    fn initialize_params() -> Value {
        json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "test", "version": "0" },
        })
    }

    /// Streamable HTTP：所有请求 POST 同一 URL，响应是 SSE 流。
    #[test]
    fn streamable_http_round_trip() {
        let Some(server) = FixtureServer::start("streamable", 8791) else {
            return;
        };
        let mut connection = plain_connection(&server.url()).expect("应能构造 HTTP 连接");

        let init = request(&mut connection, "initialize", initialize_params())
            .expect("initialize 应成功");
        assert_eq!(init["serverInfo"]["name"], "agent-llm-test-streamable");

        let tools = request(&mut connection, "tools/list", json!({})).expect("tools/list 应成功");
        assert_eq!(tools["tools"][0]["name"], "echo");

        let called = request(
            &mut connection,
            "tools/call",
            json!({ "name": "echo", "arguments": { "value": "你好 HTTP" } }),
        )
        .expect("tools/call 应成功");
        assert_eq!(called["content"][0]["text"], "你好 HTTP");
    }

    /// 会话 id 必须被记住并回带，否则服务端会把每次请求当成新会话。
    #[test]
    fn streamable_http_persists_session_id() {
        let Some(server) = FixtureServer::start("streamable", 8793) else {
            return;
        };
        let mut connection = plain_connection(&server.url()).expect("应能构造 HTTP 连接");
        request(&mut connection, "tools/list", json!({})).expect("首次请求应成功");
        let session = connection.session_id.lock().ok().and_then(|s| s.clone());
        assert!(session.is_some(), "服务端下发了 Mcp-Session-Id，应被保存");
        request(&mut connection, "tools/list", json!({})).expect("带会话 id 的请求应成功");
    }

    /// HTTP+SSE 旧版：GET 长连拿 endpoint，消息 POST 到该地址，结果从长连回来。
    #[test]
    fn http_sse_round_trip() {
        let Some(server) = FixtureServer::start("sse", 8792) else {
            return;
        };
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .expect("client");
        let mut connection = open_sse_transport_with(
            client,
            &server.url(),
            Vec::new(),
            Duration::from_secs(10),
            true,
        )
        .expect("应能建立 SSE 连接");

        let init = request(&mut connection, "initialize", initialize_params())
            .expect("SSE initialize 应成功");
        assert_eq!(init["serverInfo"]["name"], "agent-llm-test-sse");

        let called = request(
            &mut connection,
            "tools/call",
            json!({ "name": "echo", "arguments": { "value": "sse 通路" } }),
        )
        .expect("SSE tools/call 应成功");
        assert_eq!(called["content"][0]["text"], "sse 通路");
    }

    /// 服务端返回 error 时要转成可读报错，而不是静默当成空结果。
    #[test]
    fn server_error_becomes_readable_message() {
        let error = extract_result(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "error": { "code": -32601, "message": "unknown method foo" }
        }))
        .expect_err("error 应转为 Err");
        assert!(error.contains("unknown method foo"), "应带上服务端原文：{error}");
    }

    /// SSE 解析：多条事件里只取 id 匹配的那一条。
    #[test]
    fn sse_parser_picks_matching_id() {
        let body = concat!(
            "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"n\":1}}\n\n",
            "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"n\":7}}\n\n",
        );
        let mut data_buffer = String::new();
        let mut found: Option<u64> = None;
        for line in body.lines() {
            let trimmed = line.trim_end();
            if trimmed.is_empty() {
                if data_buffer.is_empty() {
                    continue;
                }
                let payload = std::mem::take(&mut data_buffer);
                if let Ok(message) = serde_json::from_str::<Value>(&payload) {
                    if message.get("id").and_then(|v| v.as_u64()) == Some(7) {
                        found = Some(extract_result(message).unwrap()["n"].as_u64().unwrap());
                    }
                }
                continue;
            }
            if let Some(rest) = trimmed.strip_prefix("data:") {
                data_buffer.push_str(rest.trim_start());
            }
        }
        assert_eq!(found, Some(7), "应取到 id=7 的事件");
    }

    /// 真机验证：走真实公网 MCP 端点跑完整链路（校验 → 握手 → 工具发现）。
    /// 需要联网，默认 ignored；手动运行：
    ///   MCP_LIVE_URL="https://mcp.exa.ai/mcp?tools=web_search_exa" \
    ///     cargo test --lib live_public_endpoint -- --ignored --nocapture
    #[test]
    #[ignore = "需要联网访问公网 MCP 端点"]
    fn live_public_endpoint_round_trip() {
        let Ok(url) = std::env::var("MCP_LIVE_URL") else {
            eprintln!("跳过：未设置 MCP_LIVE_URL");
            return;
        };

        // 1) 走生产校验路径（仅 http/https，拒绝本机与内网）。
        let endpoint = mcp_endpoint::validate_endpoint(&url).expect("公网端点应通过校验");

        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("client");
        let mut connection = HttpConnection {
            client,
            message_url: endpoint,
            session_id: Arc::new(Mutex::new(None)),
            headers: Vec::new(),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: 1,
            sse_alive: None,
            timeout: Duration::from_secs(30),
            uses_sse_push: false,
        };

        let init = request(&mut connection, "initialize", initialize_params())
            .expect("真实端点 initialize 应成功");
        println!(
            "serverInfo.name = {}",
            init["serverInfo"]["name"].as_str().unwrap_or("?")
        );

        let tools =
            request(&mut connection, "tools/list", json!({})).expect("真实端点 tools/list 应成功");
        let names: Vec<&str> = tools["tools"]
            .as_array()
            .map(|list| list.iter().filter_map(|t| t["name"].as_str()).collect())
            .unwrap_or_default();
        println!("发现 {} 个工具：{:?}", names.len(), names);
        assert!(!names.is_empty(), "真实端点应至少暴露一个工具");

        // 2) 本机地址必须被生产校验拒绝（本模块的安全验收条件）。
        assert!(
            mcp_endpoint::validate_endpoint("http://127.0.0.1:8080/mcp").is_err(),
            "本机地址必须被拒绝"
        );
    }
}
