//! dsh（DeepSeek Harness）接入的类型定义。
//! 覆盖：应用配置中的 dsh 段、安装/运行状态、环境检测项。
//! 依据 docs/DSH_SPIKE_RECORD.md 的 Phase 0 定稿结论。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// dsh 固定版本（Phase 0 结论：锁定已测版本，不做无声自动升级）。
pub const DSH_PINNED_VERSION: &str = "0.1.1-rc.2";
/// 托管 Node.js 固定版本（Phase 0 结论：托管默认装 22 LTS 便携版）。
pub const NODE_PINNED_VERSION: &str = "22.23.2";
/// 安装 dsh 包用的 pnpm 固定版本（经托管 Node 自带 corepack 运行，实测 454 包约 1 分钟）。
pub const PNPM_PINNED_VERSION: &str = "10.17.1";
/// dsh Web UI 默认端口。
pub const DSH_DEFAULT_PORT: u16 = 3080;

/// AppConfig 中的 dsh 配置段（serde default 平滑迁移，老配置文件无需改动）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct DshConfig {
    /// dsh Web UI 端口。
    pub dsh_port: u16,
    /// 锁定的 dsh 包版本。
    pub pinned_version: String,
    /// 托管 Node 便携版版本。
    pub node_pinned_version: String,
    /// dsh 启动时的 CWD（工作区）。None = 用户主目录。
    /// spike 实测：dsh 按启动 CWD 归档会话，必须显式设置。
    pub workspace_dir: Option<String>,
    /// 已绑定的本地模型 model id（F5，Phase 3 使用）。
    pub bound_model: Option<String>,
    /// 已绑定的 llama-server 端点（如 http://127.0.0.1:8080/v1）。
    pub bound_base_url: Option<String>,
}

impl Default for DshConfig {
    fn default() -> Self {
        Self {
            dsh_port: DSH_DEFAULT_PORT,
            pinned_version: String::from(DSH_PINNED_VERSION),
            node_pinned_version: String::from(NODE_PINNED_VERSION),
            workspace_dir: None,
            bound_model: None,
            bound_base_url: None,
        }
    }
}

/// Node.js 运行时来源：系统 Node / 托管便携版 / 未找到。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DshNodeSource {
    /// 系统 PATH 中的 Node，版本满足 `^22.19 || >=24`。
    System,
    /// 应用托管的便携版（runtimes/node-v*-win-x64）。
    Managed,
    /// 未找到可用 Node。
    None,
}

/// Node.js 运行时状态。
#[derive(Debug, Clone, Serialize)]
pub struct DshNodeInfo {
    pub source: DshNodeSource,
    /// 实测版本号（如 "22.23.2"），未找到时为 None。
    pub version: Option<String>,
    /// 实际使用的 node.exe 路径。
    pub path: Option<String>,
}

/// dsh 包安装状态。
#[derive(Debug, Clone, Serialize)]
pub struct DshPackageInfo {
    pub installed: bool,
    /// 安装的包版本（来自 versions.json 与 package.json 双向核对）。
    pub version: Option<String>,
    /// bin.js 路径（启动 dsh 用）。
    pub bin_path: Option<String>,
}

/// dsh 运行状态（Phase 2，进程启停链路）。
#[derive(Debug, Clone, Serialize)]
pub struct DshRuntimeStatus {
    /// dsh 子进程是否在运行。
    pub running: bool,
    /// 实际 Web UI 地址（运行中才有意义，来自启动日志解析）。
    pub web_url: Option<String>,
    /// dsh 主进程 PID。
    pub pid: Option<u32>,
}

/// dsh 综合状态（dsh_get_status 返回）。
#[derive(Debug, Clone, Serialize)]
pub struct DshStatus {
    pub node: DshNodeInfo,
    pub package: DshPackageInfo,
    /// DSH_HOME 目录（%APPDATA%\AgentLLM\dsh-home）。
    pub home_dir: String,
    /// dsh 包安装目录。
    pub packages_dir: String,
    /// 按配置构造的 Web UI 地址（http://127.0.0.1:<port>）。
    pub web_url: String,
    /// 进程运行状态。
    pub runtime: DshRuntimeStatus,
}

/// versions.json 的一条安装记录（dsh 包或 Node 便携版）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DshInstalledVersion {
    /// 组件类型："node" 或 "dsh"。
    pub kind: String,
    pub version: String,
    /// 安装时间（Unix 秒）。
    pub installed_at: u64,
}

/// 读取 dsh 安装记录（dsh/versions.json）。
pub fn read_versions(file: &PathBuf) -> Vec<DshInstalledVersion> {
    match std::fs::read_to_string(file) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// 追加/更新一条安装记录并写回 versions.json（自动创建父目录）。
pub fn write_version(file: &PathBuf, entry: DshInstalledVersion) -> Result<(), String> {
    let mut list = read_versions(file);
    list.retain(|item| item.kind != entry.kind);
    list.push(entry);
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?;
    std::fs::write(file, text).map_err(|e| e.to_string())
}
