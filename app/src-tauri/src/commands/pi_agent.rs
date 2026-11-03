//! Pi 智能体 RPC 的 Tauri 命令层（实验）。
//!
//! 只做转发：真正的进程与协议在 `services/pi_agent.rs`。
//! 事件统一走 `pi:event` / `pi:log` / `pi:ready` / `pi:exit` / `pi:error`。

use std::path::Path;

use tauri::{AppHandle, Emitter};

use crate::services::pi_agent::{
    self, PiAgentDiscover, PiAgentStartOptions, PiAgentStatus,
};
use crate::services::pi_artifacts::{self, PiArtifactPayload, PiResolvedArtifact};
use crate::services::pi_install;
use crate::services::pi_skills::{self, PiSelectedSkill, PiSkillMeta};
use crate::services::pi_tools::{self, PiPermissionMode};

#[tauri::command]
pub fn pi_agent_discover() -> PiAgentDiscover {
    pi_agent::discover()
}

/// 拉取 npm registry 上 Pi 的可安装版本列表。
#[tauri::command]
pub async fn pi_agent_npm_versions(
    state: tauri::State<'_, crate::models::app_state::AppState>,
    registry: Option<String>,
) -> Result<pi_install::PiNpmVersionsResult, String> {
    let proxy_url = state
        .config
        .lock()
        .ok()
        .and_then(|config| config.proxy_url.clone());
    tokio::task::spawn_blocking(move || {
        pi_install::fetch_versions(registry.as_deref(), proxy_url.as_deref())
    })
    .await
    .map_err(|error| format!("读取版本列表失败：{error}"))?
}

/// 从 npm 在线安装 / 升级指定版本的 Pi。
#[tauri::command]
pub async fn pi_agent_install_online(
    state: tauri::State<'_, crate::models::app_state::AppState>,
    version: String,
    registry: Option<String>,
    node_path: Option<String>,
) -> Result<crate::services::pi_agent::PiAgentInstallResult, String> {
    let proxy_url = state
        .config
        .lock()
        .ok()
        .and_then(|config| config.proxy_url.clone());
    tokio::task::spawn_blocking(move || {
        pi_install::install_online(
            &version,
            registry.as_deref(),
            node_path.as_deref(),
            proxy_url.as_deref(),
        )
    })
    .await
    .map_err(|error| format!("在线安装 Pi 失败：{error}"))?
}

/// 回滚到上一版本（升级时保留的备份）。
#[tauri::command]
pub async fn pi_agent_rollback()
-> Result<crate::services::pi_agent::PiAgentInstallResult, String> {
    tokio::task::spawn_blocking(pi_install::rollback)
        .await
        .map_err(|error| format!("回滚 Pi 失败：{error}"))?
}

/// 当前 Pi 版本锁信息（安装来源、上一版本、回滚可用性）。
#[tauri::command]
pub fn pi_agent_version_info() -> pi_install::PiVersionInfoResult {
    pi_install::version_info()
}

/// 把当前 Pi 运行时复制到应用数据目录，并写版本锁。
#[tauri::command]
pub async fn pi_agent_install(
    source: Option<String>,
) -> Result<crate::services::pi_agent::PiAgentInstallResult, String> {
    tokio::task::spawn_blocking(move || pi_agent::install(source.as_deref()))
        .await
        .map_err(|error| format!("安装 Pi 失败：{error}"))?
}

#[tauri::command]
pub fn pi_agent_get_status() -> PiAgentStatus {
    pi_agent::status()
}

/// 打开 / 聚焦 Pi 浮窗（常驻快聊入口；关闭即隐藏）。
///
/// 必须 async：同步命令跑在主线程，里面的 `run_on_main_thread` 会等自己，
/// 直接死锁（与 `canvas_open_window` 同因）。
#[tauri::command]
pub async fn pi_float_window(app: AppHandle) -> Result<(), String> {
    pi_agent::open_float_window(&app)
}

#[tauri::command]
pub fn pi_agent_start(
    app: AppHandle,
    options: PiAgentStartOptions,
) -> Result<PiAgentStatus, String> {
    match pi_agent::start(app.clone(), options) {
        Ok(status) => Ok(status),
        Err(error) => {
            pi_agent::set_error(error.clone());
            app.emit("pi:error", serde_json::json!({ "message": error.clone() }))
                .ok();
            Err(error)
        }
    }
}

#[tauri::command]
pub fn pi_agent_run(prompt: String, skill_context: Option<String>) -> Result<String, String> {
    pi_agent::run(&prompt, skill_context.as_deref())
}

/// 只读技能索引（名称/描述/触发词/工具），不返回正文。
#[tauri::command]
pub fn pi_agent_skills_index(skills_dir: String) -> Result<Vec<PiSkillMeta>, String> {
    pi_skills::index_skills(Path::new(skills_dir.trim()))
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiSkillSelection {
    pub skills: Vec<PiSelectedSkill>,
    pub context: String,
}

/// 宿主雷达：按任务文本选 1–2 个技能，并返回截断后的正文与可直接注入的文本。
#[tauri::command]
pub fn pi_agent_select_skills(
    skills_dir: String,
    text: String,
    top_k: Option<usize>,
    max_chars: Option<usize>,
) -> Result<PiSkillSelection, String> {
    let skills = pi_skills::select_skills(
        Path::new(skills_dir.trim()),
        &text,
        top_k.unwrap_or(2),
        max_chars.unwrap_or(8000),
    )?;
    let context = pi_skills::render_skill_context(&skills);
    Ok(PiSkillSelection { skills, context })
}

/// 在指定会话工作区内按文件名/相对路径解析产物。
#[tauri::command]
pub async fn pi_resolve_artifacts(
    names: Vec<String>,
    work_dir: Option<String>,
) -> Result<Vec<PiResolvedArtifact>, String> {
    tokio::task::spawn_blocking(move || {
        pi_artifacts::resolve_artifacts(&names, work_dir.as_deref())
    })
    .await
    .map_err(|error| format!("产物解析失败：{error}"))?
}

/// 读取会话工作区内的单个产物：图片转 data URL，文本回正文。
#[tauri::command]
pub async fn pi_read_artifact(
    rel_path: String,
    work_dir: Option<String>,
) -> Result<PiArtifactPayload, String> {
    tokio::task::spawn_blocking(move || {
        pi_artifacts::read_artifact(&rel_path, work_dir.as_deref())
    })
    .await
    .map_err(|error| format!("产物读取失败：{error}"))?
}

#[tauri::command]
pub fn pi_agent_cancel() -> Result<(), String> {
    pi_agent::cancel()
}

#[tauri::command]
pub fn pi_agent_stop(app: AppHandle) -> Result<(), String> {
    pi_agent::stop();
    app.emit(
        "pi:stopped",
        serde_json::json!({ "message": "Pi 已停止" }),
    )
    .ok();
    Ok(())
}

#[tauri::command]
pub fn pi_agent_get_logs() -> Vec<String> {
    pi_agent::get_logs()
}

#[tauri::command]
pub fn pi_agent_clear_logs() {
    pi_agent::clear_logs();
}

/// 权限确认弹窗的回答：放行 / 拒绝当前挂起的工具调用。
#[tauri::command]
pub fn pi_agent_permission_answer(id: String, allow: bool) -> Result<(), String> {
    pi_tools::answer_permission(&id, allow)
}

/// 运行中切换权限档（只读 / 守门 / 放行）。
#[tauri::command]
pub fn pi_agent_set_permission_mode(mode: PiPermissionMode) -> String {
    pi_tools::set_mode(mode);
    mode.as_str().to_string()
}
