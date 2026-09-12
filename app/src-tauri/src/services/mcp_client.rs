//! MCP（Model Context Protocol）stdio 客户端。
//!
//! 每个已配置的服务器对应一个本机子进程，通过 stdin/stdout 交换换行分隔的
//! JSON-RPC 2.0 消息。这里只实现对话必需的最小集合：
//! `initialize` / `notifications/initialized` / `tools/list` / `tools/call`。
//!
//! 设计要点：
//! - 进程常驻：一次握手后保持连接，多次对话复用，避免每次调用重新拉起 npx。
//! - 读取线程按 id 分发响应：tools/call 可能长时间不返回，不能阻塞其它请求。
//! - Windows 上子进程挂 Job Object（KILL_ON_JOB_CLOSE），应用被强杀时不残留。

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use serde_json::{json, Value};

use crate::models::mcp_types::{
    McpCallResult, McpServerConfig, McpServerStatus, McpToolInfo,
};
use crate::services::process_manager;

/// 请求的协议版本：服务端通常回显自己支持的版本，这里声明的是广泛兼容的一版。
const PROTOCOL_VERSION: &str = "2024-11-05";
const CLIENT_NAME: &str = "agent-llm";
const CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// 单条 stdout 行的上限。某些服务端会回吐大块 JSON（例如抓取的网页），
/// 放宽到 8 MB，超过则视为异常并忽略。
const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;
/// stderr 只保留最近的若干行用于排障展示。
const MAX_STDERR_LINES: usize = 40;
/// 单个工具结果回填给模型的文本上限，避免单次调用吃爆上下文。
const MAX_TOOL_RESULT_CHARS: usize = 48_000;

type PendingMap = Arc<Mutex<HashMap<u64, Sender<Result<Value, String>>>>>;

/// 已建立的连接：传输层二选一，工具清单与状态展示是共用的。
struct McpConnection {
    /// 每次（重）启动递增；旧读取线程看到代数不符就自行退出。
    generation: u64,
    transport: ActiveTransport,
    tools: Vec<McpToolInfo>,
    server_info: Option<String>,
}

/// 传输层。stdio 有子进程与管道，http/sse 是网络连接。
enum ActiveTransport {
    Stdio {
        child: Child,
        stdin: ChildStdin,
        pending: PendingMap,
        stderr_tail: Arc<Mutex<Vec<String>>>,
        next_id: u64,
    },
    Http(Box<crate::services::mcp_http::HttpConnection>),
}

impl McpConnection {
    /// 子进程 pid；网络传输没有 pid。
    fn pid(&mut self) -> Option<u32> {
        match &mut self.transport {
            ActiveTransport::Stdio { child, .. } => Some(child.id()),
            ActiveTransport::Http(_) => None,
        }
    }

    fn status(&mut self, config: &McpServerConfig, state: &str, error: Option<String>) -> McpServerStatus {
        let last_stderr = match &self.transport {
            ActiveTransport::Stdio { stderr_tail, .. } => stderr_tail
                .lock()
                .ok()
                .and_then(|lines| lines.last().cloned()),
            ActiveTransport::Http(_) => None,
        };
        McpServerStatus {
            id: config.id.clone(),
            name: config.name.clone(),
            state: state.to_string(),
            pid: self.pid(),
            tools: self.tools.clone(),
            error,
            server_info: self.server_info.clone(),
            last_stderr,
            transport: Some(config.transport),
        }
    }

    /// 发一次请求，按传输层分派。
    fn request(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        match &mut self.transport {
            ActiveTransport::Stdio { .. } => self.request_stdio(method, params, timeout),
            ActiveTransport::Http(connection) => crate::services::mcp_http::request(connection, method, params),
        }
    }

    fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        match &mut self.transport {
            ActiveTransport::Stdio { .. } => self.notify_stdio(method, params),
            ActiveTransport::Http(connection) => crate::services::mcp_http::notify(connection, method, params),
        }
    }

    fn is_alive(&mut self) -> bool {
        match &mut self.transport {
            ActiveTransport::Stdio { child, .. } => matches!(child.try_wait(), Ok(None)),
            ActiveTransport::Http(_) => true,
        }
    }

    fn kill(&mut self) {
        match &mut self.transport {
            ActiveTransport::Stdio { child, .. } => {
                process_manager::terminate_process_tree(child, "mcp")
            }
            ActiveTransport::Http(connection) => crate::services::mcp_http::shutdown(connection),
        }
    }

    /// 让等待中的请求立刻失败（断开 / 进程退出时）。
    fn fail_pending(&mut self, reason: &str) {
        match &mut self.transport {
            ActiveTransport::Stdio { pending, .. } => {
                if let Ok(mut map) = pending.lock() {
                    for (_, sender) in map.drain() {
                        let _ = sender.send(Err(reason.to_string()));
                    }
                }
            }
            ActiveTransport::Http(connection) => crate::services::mcp_http::fail_pending_public(connection, reason),
        }
    }
}

impl McpConnection {
    fn request_stdio(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let ActiveTransport::Stdio { stdin, pending, next_id, .. } = &mut self.transport else {
            return Err("传输类型不匹配".to_string());
        };
        let id = *next_id;
        *next_id += 1;
        let (tx, rx) = mpsc::channel::<Result<Value, String>>();
        pending
            .lock()
            .map_err(|_| "MCP 请求表已损坏".to_string())?
            .insert(id, tx);

        let payload = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        if let Err(error) = write_message(stdin, &payload) {
            if let Ok(mut map) = pending.lock() {
                map.remove(&id);
            }
            return Err(format!("写入 MCP 请求失败：{error}"));
        }

        match rx.recv_timeout(timeout) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Ok(mut map) = pending.lock() {
                    map.remove(&id);
                }
                Err(format!(
                    "MCP 请求 `{method}` 在 {} 秒内没有响应。",
                    timeout.as_secs()
                ))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err("MCP 服务器进程已退出。".to_string()),
        }
    }

    fn notify_stdio(&mut self, method: &str, params: Value) -> Result<(), String> {
        let ActiveTransport::Stdio { stdin, .. } = &mut self.transport else {
            return Err("传输类型不匹配".to_string());
        };
        let payload = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        write_message(stdin, &payload)
    }
}

fn write_message(stdin: &mut ChildStdin, payload: &Value) -> Result<(), String> {
    let mut line = serde_json::to_string(payload).map_err(|e| e.to_string())?;
    line.push('\n');
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.flush())
        .map_err(|e| e.to_string())
}

/// 连接表：值是 Arc<Mutex<…>>，全局锁只用于查表（clone Arc 后立即释放），
/// 单个连接的长时间操作（tools/call 可能等几十秒）只阻塞它自己，
/// 不再拖住其它服务器的状态查询 / 连接 / 断开。
type ConnectionMap = HashMap<String, Arc<Mutex<McpConnection>>>;

static MCP_CONNECTIONS: Lazy<Mutex<ConnectionMap>> = Lazy::new(|| Mutex::new(HashMap::new()));
/// 每个服务器的连接代数：重启时递增，旧读取线程据此判断自己已经过时。
static MCP_GENERATIONS: Lazy<Mutex<HashMap<String, u64>>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn next_generation(server_id: &str) -> u64 {
    let mut generations = match MCP_GENERATIONS.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let entry = generations.entry(server_id.to_string()).or_insert(0);
    *entry += 1;
    *entry
}

fn log(level: &str, message: &str) {
    process_manager::push_system_log(level, "mcp", message);
}

/// 工具名前缀：只保留 `[a-z0-9_-]`，满足 OpenAI / llama.cpp 的函数名约束。
fn sanitize_slug(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if ch == '-' || ch == '_' {
            out.push(ch);
        } else if ch.is_whitespace() || ch == '.' {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "server".to_string()
    } else {
        trimmed.chars().take(24).collect()
    }
}

/// 模型可见的完整工具名：`mcp__<服务器名>__<工具名>`。
pub fn qualified_tool_name(server_name: &str, tool_name: &str) -> String {
    let mut tool = sanitize_slug(tool_name);
    if tool.is_empty() {
        tool = "tool".to_string();
    }
    format!("mcp__{}__{}", sanitize_slug(server_name), tool)
}

/// 读取线程：按 id 把响应投递给等待者；通知与反向请求记日志后忽略。
fn spawn_reader(
    server_id: String,
    generation: u64,
    stdout: std::process::ChildStdout,
    pending: PendingMap,
) {
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let line = match line {
                Ok(line) => line,
                Err(_) => break,
            };
            if line.len() > MAX_LINE_BYTES {
                log("warn", &format!("[mcp:{server_id}] 单行响应超过 8 MB，已忽略。"));
                continue;
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let message: Value = match serde_json::from_str(trimmed) {
                Ok(value) => value,
                Err(error) => {
                    log("warn", &format!("[mcp:{server_id}] 无法解析的响应行：{error}"));
                    continue;
                }
            };

            let Some(id) = message.get("id").and_then(|value| value.as_u64()) else {
                // 服务端发来的通知或反向请求：本客户端不实现采样/roots，记日志即可。
                if let Some(method) = message.get("method").and_then(|value| value.as_str()) {
                    log("debug", &format!("[mcp:{server_id}] 忽略服务端消息：{method}"));
                }
                continue;
            };

            let result = if let Some(error) = message.get("error") {
                let text = error
                    .get("message")
                    .and_then(|value| value.as_str())
                    .unwrap_or("未知错误");
                Err(format!("MCP 服务端返回错误：{text}"))
            } else {
                Ok(message.get("result").cloned().unwrap_or(Value::Null))
            };

            let sender = pending.lock().ok().and_then(|mut map| map.remove(&id));
            if let Some(sender) = sender {
                let _ = sender.send(result);
            }
        }

        // stdout 关闭 = 进程退出或崩溃：唤醒所有等待者，并清掉代数匹配的连接记录。
        if let Ok(mut map) = pending.lock() {
            for (_, sender) in map.drain() {
                let _ = sender.send(Err("MCP 服务器进程已退出。".to_string()));
            }
        }
        let superseded = MCP_GENERATIONS
            .lock()
            .ok()
            .and_then(|generations| generations.get(&server_id).copied())
            .map(|current| current != generation)
            .unwrap_or(false);
        if superseded {
            return;
        }
        if let Ok(mut connections) = MCP_CONNECTIONS.lock() {
            let matches_generation = connections
                .get(&server_id)
                .map(|connection| {
                    connection
                        .lock()
                        .map(|guard| guard.generation == generation)
                        .unwrap_or(false)
                })
                .unwrap_or(false);
            if matches_generation {
                connections.remove(&server_id);
            }
        }
        log("warn", &format!("[mcp:{server_id}] 服务器进程已退出，连接已释放。"));
    });
}

/// 读取线程：把子进程 stderr 收进环形缓冲，并汇入系统日志。
fn spawn_stderr_reader(
    server_id: String,
    stderr: std::process::ChildStderr,
    buffer: Arc<Mutex<Vec<String>>>,
) {
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            let line = match line {
                Ok(line) => line,
                Err(_) => break,
            };
            let text = line.trim().to_string();
            if text.is_empty() {
                continue;
            }
            if let Ok(mut lines) = buffer.lock() {
                lines.push(text.clone());
                if lines.len() > MAX_STDERR_LINES {
                    let overflow = lines.len() - MAX_STDERR_LINES;
                    lines.drain(0..overflow);
                }
            }
            log("debug", &format!("[mcp:{server_id}] {text}"));
        }
    });
}

/// 启动服务器并完成 MCP 握手 + 工具发现。已连接时直接返回现有状态。
pub fn connect(config: &McpServerConfig) -> Result<McpServerStatus, String> {
    if config.id.trim().is_empty() {
        return Err("MCP 服务器缺少 id。".to_string());
    }
    {
        let mut connections = MCP_CONNECTIONS
            .lock()
            .map_err(|_| "MCP 连接表已损坏".to_string())?;
        let mut stale = false;
        if let Some(existing) = connections.get(&config.id) {
            let mut guard = existing
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if guard.is_alive() {
                return Ok(guard.status(config, "ready", None));
            }
            // 连接已经失效：清掉占位，走下面的重建分支。
            stale = true;
        }
        if stale {
            connections.remove(&config.id);
        }
    }

    // 传输相关的字段先做完整校验（含 URL 的协议与 host 检查）。
    crate::services::mcp_endpoint::validate_server_transport(config)?;

    let generation = next_generation(&config.id);
    let mut connection = build_connection(config, generation)?;

    let timeout = request_timeout(config);
    // 握手：initialize 的 params 必须带 protocolVersion / capabilities / clientInfo。
    let init_result = match connection.request(
        "initialize",
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": CLIENT_NAME, "version": CLIENT_VERSION },
        }),
        timeout,
    ) {
        Ok(result) => result,
        Err(error) => {
            connection.kill();
            log("error", &format!("[mcp:{}] 初始化失败：{error}", config.id));
            return Err(error);
        }
    };

    connection.server_info = init_result
        .get("serverInfo")
        .and_then(|info| info.get("name"))
        .and_then(|name| name.as_str())
        .map(|name| {
            let version = init_result
                .get("serverInfo")
                .and_then(|info| info.get("version"))
                .and_then(|value| value.as_str())
                .unwrap_or("");
            if version.is_empty() {
                name.to_string()
            } else {
                format!("{name} {version}")
            }
        });

    // 规范要求握手后立刻回一条 initialized 通知。
    if let Err(error) = connection.notify("notifications/initialized", json!({})) {
        connection.kill();
        return Err(format!("发送 initialized 通知失败：{error}"));
    }

    match discover_tools(&mut connection, config, timeout) {
        Ok(tools) => connection.tools = tools,
        Err(error) => {
            connection.kill();
            log("error", &format!("[mcp:{}] 工具发现失败：{error}", config.id));
            return Err(error);
        }
    }

    log(
        "info",
        &format!(
            "[mcp:{}] 已连接 {}{}（{} 个工具）{}",
            config.id,
            config.name,
            transport_label(config.transport),
            connection.tools.len(),
            connection
                .server_info
                .as_deref()
                .map(|info| format!("· {info}"))
                .unwrap_or_default()
        ),
    );

    let status = connection.status(config, "ready", None);
    MCP_CONNECTIONS
        .lock()
        .map_err(|_| "MCP 连接表已损坏".to_string())?
        .insert(config.id.clone(), Arc::new(Mutex::new(connection)));
    Ok(status)
}

fn transport_label(transport: crate::models::mcp_types::McpTransport) -> &'static str {
    use crate::models::mcp_types::McpTransport;
    match transport {
        McpTransport::Stdio => "（stdio）",
        McpTransport::Http => "（Streamable HTTP）",
        McpTransport::Sse => "（HTTP+SSE）",
    }
}

/// 按传输方式建立底层连接（尚未握手）。
fn build_connection(config: &McpServerConfig, generation: u64) -> Result<McpConnection, String> {
    if config.transport.is_network() {
        let http = crate::services::mcp_http::connect(config)?;
        return Ok(McpConnection {
            generation,
            transport: ActiveTransport::Http(Box::new(http)),
            tools: Vec::new(),
            server_info: None,
        });
    }

    let mut child = spawn_child(config)?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "无法获取 MCP 进程的标准输入。".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法获取 MCP 进程的标准输出。".to_string())?;

    let stderr_tail = Arc::new(Mutex::new(Vec::new()));
    if let Some(stderr) = child.stderr.take() {
        spawn_stderr_reader(config.id.clone(), stderr, stderr_tail.clone());
    }

    let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
    spawn_reader(config.id.clone(), generation, stdout, pending.clone());

    Ok(McpConnection {
        generation,
        transport: ActiveTransport::Stdio {
            child,
            stdin,
            pending,
            stderr_tail,
            next_id: 1,
        },
        tools: Vec::new(),
        server_info: None,
    })
}

fn request_timeout(config: &McpServerConfig) -> Duration {
    Duration::from_millis(config.timeout_ms.clamp(5_000, 600_000))
}

/// 按配置拉起 MCP 服务器进程。
///
/// 命令与参数以列表形式交给 `process_manager::spawn_sidecar_process`，
/// 全程不经过任何 shell：参数里的空格、引号、`&`、`|`、`;` 都不会被解释。
fn spawn_child(config: &McpServerConfig) -> Result<Child, String> {
    process_manager::spawn_sidecar_process(
        &config.command,
        &config.args,
        config.cwd.as_deref(),
        &config.env,
    )
}

/// 通过 tools/list 发现工具，并生成模型可见的完整名。
fn discover_tools(
    connection: &mut McpConnection,
    config: &McpServerConfig,
    timeout: Duration,
) -> Result<Vec<McpToolInfo>, String> {
    let result = connection.request("tools/list", json!({}), timeout)?;
    let list = result
        .get("tools")
        .and_then(|tools| tools.as_array())
        .cloned()
        .unwrap_or_default();

    let mut tools = Vec::new();
    let mut seen = HashSet::new();
    for item in list {
        let Some(name) = item.get("name").and_then(|name| name.as_str()) else {
            continue;
        };
        if !seen.insert(name.to_string()) {
            continue;
        }
        let qualified_name = qualified_tool_name(&config.name, name);
        let schema = item
            .get("inputSchema")
            .cloned()
            .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
        let annotations = item.get("annotations").cloned().unwrap_or(Value::Null);
        tools.push(McpToolInfo {
            name: name.to_string(),
            qualified_name,
            description: item
                .get("description")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .trim()
                .to_string(),
            input_schema: schema,
            read_only: annotations
                .get("readOnlyHint")
                .and_then(|value| value.as_bool())
                .unwrap_or(false),
            // 未知一律按破坏性处理：界面上会照常提示风险。
            destructive: annotations
                .get("destructiveHint")
                .and_then(|value| value.as_bool())
                .unwrap_or(true),
        });
    }
    Ok(tools)
}

/// 断开服务器：让等待中的请求失败，再回收传输层（杀进程树 / 关闭网络会话）。
pub fn disconnect(server_id: &str) -> Result<(), String> {
    // 先递增代数，让旧读取线程知道自己的清理动作已经过时。
    next_generation(server_id);
    let removed = MCP_CONNECTIONS
        .lock()
        .map_err(|_| "MCP 连接表已损坏".to_string())?
        .remove(server_id);
    let Some(connection) = removed else {
        return Ok(());
    };
    let mut guard = connection
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    // 等待中的请求立即失败，调用方不必干等到超时。
    guard.fail_pending("MCP 连接已断开。");
    guard.kill();
    log("info", &format!("[mcp:{server_id}] 已断开连接。"));
    Ok(())
}

/// 读取某个服务器的状态。未连接时返回 stopped。
pub fn status(config: &McpServerConfig) -> McpServerStatus {
    let existing = {
        let connections = match MCP_CONNECTIONS.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        connections.get(&config.id).cloned()
    };
    if let Some(connection) = existing {
        let mut guard = connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if guard.is_alive() {
            return guard.status(config, "ready", None);
        }
        // 失效连接：若仍是登记的那份，就清掉占位（避免误删并发重建的新连接）。
        if let Ok(mut connections) = MCP_CONNECTIONS.lock() {
            let is_registered = connections
                .get(&config.id)
                .map(|current| Arc::ptr_eq(current, &connection))
                .unwrap_or(false);
            if is_registered {
                connections.remove(&config.id);
            }
        }
    }
    McpServerStatus {
        id: config.id.clone(),
        name: config.name.clone(),
        state: "stopped".to_string(),
        pid: None,
        tools: Vec::new(),
        error: None,
        server_info: None,
        last_stderr: None,
        transport: Some(config.transport),
    }
}

/// 调用工具：`qualified_name` 必须是连接上已发现工具里的完整名。
pub fn call_tool(
    config: &McpServerConfig,
    qualified_name: &str,
    arguments: Value,
) -> Result<McpCallResult, String> {
    let timeout = request_timeout(config);
    // 只在查表时拿全局锁；请求期间持有的是这个连接自己的锁，
    // 长时间 tools/call 不会阻塞其它服务器的状态查询与连接操作。
    let connection_arc = {
        let connections = MCP_CONNECTIONS
            .lock()
            .map_err(|_| "MCP 连接表已损坏".to_string())?;
        connections.get(&config.id).cloned().ok_or_else(|| {
            format!(
                "MCP 服务器「{}」未连接。请先在「工具」页连接后再调用。",
                config.name
            )
        })?
    };
    let mut guard = connection_arc
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !guard.is_alive() {
        return Err(format!(
            "MCP 服务器「{}」连接已失效。请先在「工具」页重新连接。",
            config.name
        ));
    }

    let tool_name = guard
        .tools
        .iter()
        .find(|tool| tool.qualified_name == qualified_name)
        .map(|tool| tool.name.clone())
        .ok_or_else(|| {
            format!(
                "MCP 服务器「{}」没有工具 {qualified_name}，可能配置已变更，请重新连接。",
                config.name
            )
        })?;

    let start = Instant::now();
    let result = guard.request(
        "tools/call",
        json!({ "name": tool_name, "arguments": arguments }),
        timeout,
    );
    let elapsed = start.elapsed().as_millis();

    match result {
        Ok(value) => {
            let (text, is_error, non_text_parts) = flatten_result(&value);
            log(
                if is_error { "warn" } else { "info" },
                &format!(
                    "[mcp:{}] tools/call {} （{} ms，{} 字符）",
                    config.id,
                    qualified_name,
                    elapsed,
                    text.chars().count()
                ),
            );
            Ok(McpCallResult {
                text: clamp_text(text),
                is_error,
                non_text_parts,
            })
        }
        Err(error) => {
            log(
                "error",
                &format!(
                    "[mcp:{}] tools/call {qualified_name} 失败：{error}",
                    config.id
                ),
            );
            Err(error)
        }
    }
}

/// 把 MCP 的 content 数组拍平成文本。
fn flatten_result(value: &Value) -> (String, bool, usize) {
    let is_error = value
        .get("isError")
        .and_then(|flag| flag.as_bool())
        .unwrap_or(false);
    let mut parts: Vec<String> = Vec::new();
    let mut non_text_parts = 0usize;

    if let Some(content) = value.get("content").and_then(|content| content.as_array()) {
        for block in content {
            match block.get("type").and_then(|kind| kind.as_str()) {
                Some("text") => {
                    if let Some(text) = block.get("text").and_then(|text| text.as_str()) {
                        parts.push(text.to_string());
                    }
                }
                Some("resource") => {
                    let text = block
                        .get("resource")
                        .and_then(|resource| resource.get("text"))
                        .and_then(|text| text.as_str());
                    match text {
                        Some(text) => parts.push(text.to_string()),
                        None => non_text_parts += 1,
                    }
                }
                Some("image") => {
                    non_text_parts += 1;
                    parts.push("[图片内容：当前版本只回填文本，图片已忽略]".to_string());
                }
                Some("audio") => {
                    non_text_parts += 1;
                    parts.push("[音频内容：当前版本只回填文本，音频已忽略]".to_string());
                }
                _ => non_text_parts += 1,
            }
        }
    }

    // 没有 content 时退化为直接序列化结构化结果（部分服务端返回结构化数据）。
    if parts.is_empty() {
        if let Some(structured) = value.get("structuredContent") {
            parts.push(
                serde_json::to_string_pretty(structured).unwrap_or_else(|_| structured.to_string()),
            );
        } else if value.as_object().map(|map| map.is_empty()).unwrap_or(false) {
            parts.push("（工具执行完成，没有返回内容）".to_string());
        }
    }

    (parts.join("\n\n"), is_error, non_text_parts)
}

fn clamp_text(text: String) -> String {
    if text.chars().count() <= MAX_TOOL_RESULT_CHARS {
        return text;
    }
    let head: String = text.chars().take(MAX_TOOL_RESULT_CHARS).collect();
    format!("{head}\n\n…（结果过长已截断）")
}

/// 断开全部连接（应用退出 / 配置重置时调用）。
pub fn disconnect_all() {
    let server_ids: Vec<String> = MCP_CONNECTIONS
        .lock()
        .map(|connections| connections.keys().cloned().collect())
        .unwrap_or_default();
    for server_id in server_ids {
        let _ = disconnect(&server_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::mcp_types::McpTransport;

    #[test]
    fn qualified_names_are_sanitized() {
        assert_eq!(
            qualified_tool_name("My Server", "read-file"),
            "mcp__my-server__read-file"
        );
        assert_eq!(
            qualified_tool_name("files.git", "Read File"),
            "mcp__files-git__read-file"
        );
        assert_eq!(qualified_tool_name("中文服务器", "echo"), "mcp__server__echo");
    }

    #[test]
    fn flatten_text_content() {
        let value = json!({
            "content": [
                { "type": "text", "text": "第一行" },
                { "type": "text", "text": "第二行" }
            ]
        });
        let (text, is_error, non_text) = flatten_result(&value);
        assert_eq!(text, "第一行\n\n第二行");
        assert!(!is_error);
        assert_eq!(non_text, 0);
    }

    #[test]
    fn flatten_reports_error_and_non_text() {
        let value = json!({
            "content": [{ "type": "image", "data": "..." }],
            "isError": true
        });
        let (text, is_error, non_text) = flatten_result(&value);
        assert!(is_error);
        assert_eq!(non_text, 1);
        assert!(text.contains("图片内容"));
    }

    #[test]
    fn oversized_results_are_truncated() {
        let long = "a".repeat(MAX_TOOL_RESULT_CHARS + 100);
        let clamped = clamp_text(long);
        assert!(clamped.ends_with("…（结果过长已截断）"));
        assert!(clamped.chars().count() < MAX_TOOL_RESULT_CHARS + 32);
    }

    /// 端到端：用仓库里的 fixture MCP 服务器跑一遍 initialize → tools/list → tools/call。
    /// fixture 是 Node 脚本，没有 Node 时跳过。
    #[test]
    fn stdio_round_trip_against_fixture_server() {
        let Some(config) = fixture_config("fixture-round-trip", "Fixture Server") else {
            return;
        };

        let connected = connect(&config).expect("应能连接 fixture 服务器");
        assert_eq!(connected.state, "ready");
        assert!(connected.pid.is_some(), "应记录子进程 pid");
        assert_eq!(connected.tools.len(), 1, "fixture 只暴露一个工具");
        let tool = &connected.tools[0];
        assert_eq!(tool.name, "echo");
        assert_eq!(tool.qualified_name, "mcp__fixture-server__echo");
        assert!(tool.read_only, "fixture 声明了 readOnlyHint");
        // inputSchema 必须原样透传，否则模型看不到参数结构。
        assert_eq!(tool.input_schema["type"], "object");
        assert!(tool.input_schema["properties"]["value"].is_object());

        let result = call_tool(&config, &tool.qualified_name, json!({ "value": "你好 MCP" }))
            .expect("应能调用工具");
        assert_eq!(result.text, "你好 MCP");
        assert!(!result.is_error);

        // 未知工具名必须被拒绝，而不是把请求原样发给服务端。
        assert!(call_tool(&config, "mcp__fixture-server__nope", json!({})).is_err());

        disconnect(&config.id).expect("应能断开连接");
        assert_eq!(status_state(&config), "stopped");
        assert!(
            status(&config).tools.is_empty(),
            "断开后不应残留工具清单"
        );
    }

    /// 未连接时必须给出可操作的中文报错，而不是把请求发给不存在的服务端。
    #[test]
    fn calling_without_connection_reports_actionable_error() {
        let config = McpServerConfig {
            id: "offline-test".to_string(),
            name: "Offline".to_string(),
            enabled: true,
            command: "node".to_string(),
            args: Vec::new(),
            env: Vec::new(),
            cwd: None,
            headers: Vec::new(),
            transport: McpTransport::Stdio,
            timeout_ms: 20_000,
        };
        let error = call_tool(&config, "mcp__offline__echo", json!({}))
            .expect_err("未连接时应拒绝调用");
        assert!(error.contains("未连接"), "错误信息应说明需要先连接：{error}");
        assert!(error.contains("工具"), "错误信息应指向工具页：{error}");
    }

    /// 不存在的命令要报「无法启动」且不留下半个连接。
    #[test]
    fn missing_command_fails_cleanly() {
        let config = McpServerConfig {
            id: "missing-command-test".to_string(),
            name: "Missing".to_string(),
            enabled: true,
            command: "definitely-not-a-real-command-xyz".to_string(),
            args: Vec::new(),
            env: Vec::new(),
            cwd: None,
            headers: Vec::new(),
            transport: McpTransport::Stdio,
            timeout_ms: 10_000,
        };
        let error = connect(&config).expect_err("不存在的命令应连接失败");
        assert!(error.contains("无法启动"), "错误信息应说明启动失败：{error}");
        assert_eq!(status(&config).state, "stopped");
    }

    /// 未知工具在本地就被拒绝，且不影响服务器继续可用。
    #[test]
    fn unknown_tool_is_rejected_without_breaking_connection() {
        let Some(config) = fixture_config("unknown-tool-test", "Unknown") else {
            return;
        };
        connect(&config).expect("连接应成功");
        let error = call_tool(&config, "mcp__unknown__nope", json!({}))
            .expect_err("未知工具应被本地拒绝");
        assert!(error.contains("没有工具"), "错误信息应说明工具不存在：{error}");
        assert_eq!(status(&config).state, "ready", "一次失败调用不应断开连接");
        disconnect(&config.id).ok();
    }

    /// 重复 connect 复用同一个子进程，而不是再拉起一个。
    #[test]
    fn repeated_connect_reuses_live_connection() {
        let Some(config) = fixture_config("reuse-test", "Reuse") else {
            return;
        };
        let first = connect(&config).expect("首次连接应成功");
        let second = connect(&config).expect("重复连接应复用现有连接");
        assert_eq!(first.pid, second.pid, "重复 connect 不应再拉起一个进程");
        disconnect(&config.id).ok();
    }

    fn status_state(config: &McpServerConfig) -> String {
        status(config).state
    }

    /// fixture 配置；没有 Node 或找不到脚本时返回 None（测试跳过）。
    fn fixture_config(id: &str, name: &str) -> Option<McpServerConfig> {
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("mcp_stdio_server.mjs");
        if !fixture.exists() {
            eprintln!("跳过：找不到 fixture MCP 服务器");
            return None;
        }
        if std::process::Command::new("node")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| !status.success())
            .unwrap_or(true)
        {
            eprintln!("跳过：未安装 Node.js");
            return None;
        }
        Some(McpServerConfig {
            id: id.to_string(),
            name: name.to_string(),
            enabled: true,
            command: "node".to_string(),
            args: vec![fixture.to_string_lossy().to_string()],
            env: Vec::new(),
            cwd: None,
            headers: Vec::new(),
            transport: McpTransport::Stdio,
            timeout_ms: 20_000,
        })
    }
}
