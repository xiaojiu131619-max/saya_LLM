use serde::{Deserialize, Serialize};

/// MCP 传输方式。
///
/// - `stdio`：本机子进程，stdin/stdout 上跑 JSON-RPC（默认，全离线）。
/// - `http`：Streamable HTTP（MCP 2025-03-26）：POST 到单一 URL，
///   响应可能是 JSON，也可能是 SSE 流。
/// - `sse`：HTTP+SSE（MCP 2024-11-05 旧版）：GET 到 SSE 端点建立长连接，
///   服务端通过 `event: endpoint` 下发消息投递用的 POST 地址。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpTransport {
    Stdio,
    Http,
    Sse,
}

impl Default for McpTransport {
    fn default() -> Self {
        Self::Stdio
    }
}

impl McpTransport {
    /// 是否为走网络的传输（需要 URL 与 host 安全校验）。
    pub fn is_network(self) -> bool {
        matches!(self, Self::Http | Self::Sse)
    }
}

/// 单个 MCP 服务器的用户配置。
///
/// 支持两种传输：stdio（本机子进程）与 http（Streamable HTTP 远端端点）。
/// 选择 http 会把对话内容与工具参数发送到该端点所属的第三方服务。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    /// 稳定 id（由前端生成，形如 `mcp-<时间戳>-<随机>`）。
    pub id: String,
    /// 展示名，同时用于工具名前缀（会被规范化为 `[a-z0-9_-]`）。
    pub name: String,
    /// 是否随对话自动连接。关闭后仅在工具页手动连接。
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 传输方式；老配置缺该字段时按 stdio 处理（平滑迁移）。
    #[serde(default)]
    pub transport: McpTransport,
    /// stdio：可执行文件；http / sse：远端端点 URL（仅 http/https）。
    /// 对 sse 传输，这里填 SSE 端点本身（例如 `https://host/sse`），
    /// 消息 POST 地址由服务端下发的 `endpoint` 事件决定。
    pub command: String,
    /// 参数列表（逐项传递，不做 shell 拼接）。仅 stdio 使用。
    #[serde(default)]
    pub args: Vec<String>,
    /// 追加的环境变量（在父进程环境之上覆盖）。仅 stdio 使用。
    #[serde(default)]
    pub env: Vec<McpEnvVar>,
    /// 工作目录；None = 继承应用当前目录。仅 stdio 使用。
    #[serde(default)]
    pub cwd: Option<String>,
    /// 附加请求头（http 传输用，例如 `Authorization: Bearer xxx`）。
    #[serde(default)]
    pub headers: Vec<McpEnvVar>,
    /// 单个请求超时（毫秒）。MCP 工具可能耗时较长，默认 60 秒。
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

impl McpServerConfig {
    /// 与「已建立的连接」相关的字段是否有变化。
    ///
    /// 保存配置时若这些字段变了，运行中的旧连接还在用旧命令 / 旧端点 / 旧请求头，
    /// 必须断开重连；`enabled` 只影响下次启动是否自动连接，不在此列。
    pub fn connection_differs(&self, other: &Self) -> bool {
        self.name != other.name
            || self.transport != other.transport
            || self.command != other.command
            || self.args != other.args
            || self.env != other.env
            || self.cwd != other.cwd
            || self.headers != other.headers
            || self.timeout_ms != other.timeout_ms
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpEnvVar {
    pub key: String,
    pub value: String,
}

fn default_true() -> bool {
    true
}

pub fn default_timeout_ms() -> u64 {
    60_000
}

/// MCP 工具（tools/list 结果 + 归属信息）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    /// 服务端原始工具名，用于 tools/call。
    pub name: String,
    /// 暴露给模型的完整名：`mcp__<服务器名>__<工具名>`。
    pub qualified_name: String,
    pub description: String,
    /// JSON Schema（对象），直接透传给 llama.cpp 的 tools 字段。
    pub input_schema: serde_json::Value,
    /// 只读提示（annotations.readOnlyHint）。
    pub read_only: bool,
    /// 破坏性提示（annotations.destructiveHint）。未知按 true（保守）。
    pub destructive: bool,
}

/// 服务器运行状态快照。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    pub id: String,
    pub name: String,
    /// `stopped` | `starting` | `ready` | `error`
    pub state: String,
    pub pid: Option<u32>,
    pub tools: Vec<McpToolInfo>,
    /// 失败原因（state = error 时）。
    pub error: Option<String>,
    /// serverInfo.name / version。
    pub server_info: Option<String>,
    /// 最近一条 stderr 摘要，便于排障（仅 stdio 有）。
    pub last_stderr: Option<String>,
    /// 该服务器的传输方式（界面展示用）。
    #[serde(default)]
    pub transport: Option<McpTransport>,
}

/// tools/call 的执行结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCallResult {
    /// 拼接后的文本结果（供回填给模型）。
    pub text: String,
    /// 服务端标记的工具级错误（isError）。
    pub is_error: bool,
    /// 结果里附带的图片等非文本块数量（本轮不解析，仅提示）。
    pub non_text_parts: usize,
}

impl Default for McpServerConfig {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            enabled: true,
            transport: McpTransport::default(),
            command: String::new(),
            args: Vec::new(),
            env: Vec::new(),
            cwd: None,
            headers: Vec::new(),
            timeout_ms: default_timeout_ms(),
        }
    }
}
