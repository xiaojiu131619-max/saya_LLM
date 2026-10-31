//! 推理后端的互斥闸门。
//!
//! 本应用同时具备三条推理后端：主模型（llama-server）、NiNfer 引擎、Strata 引擎。
//! 三者的显存预算互斥——同开两个会互相挤显存，双方都掉速甚至 OOM；两个引擎本身
//! 又都只接受单并发请求。约定是「同一时刻只跑一个后端」，因此启动任一个之前，
//! 先把另外两个停掉。
//!
//! 每个后端从自己那个模块拿「当前进程是否存活」的判断，因此不必在这里复刻
//! 各自的进程句柄结构。停止动作走各模块既有的 stop 函数，返回值里的错误
//! （例如引擎本来就没起）在互相清理时视为「已达成目标」，不向外冒泡。

use tauri::AppHandle;

use crate::services::{fast27b_manager, process_manager, strata_manager};

/// 启动前需要被停掉的其它后端。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    Main,
    Fast27b,
    Strata,
}

impl Backend {
    fn label(self) -> &'static str {
        match self {
            Backend::Main => "主模型",
            Backend::Fast27b => "NiNfer",
            Backend::Strata => "Strata",
        }
    }
}

/// 确保除 `target` 之外的推理后端都已停止，返回实际被停掉的后端名。
///
/// 只停「确实在跑」的后端：对没在跑的调用 stop 会在各模块里走一遍清理路径，
/// 既慢又会在日志里留下无意义的停止记录。
///
/// 停止动作走各后端**命令层**的停止实现，而不是直接调 manager 里的裸函数：
/// 裸停主模型不会取消 `NORMAL_LOAD` 的监视线程、也不会发 `server:stopped`，
/// 前端会继续以为模型还在跑；裸停 NiNfer 还会漏掉 webui 桥与事件。任何一步
/// 停不下来（例如自动调参仍持有生命周期）都返回错误，让调用方放弃启动目标后端，
/// 避免出现「目标没起来、别人先被停掉」的空窗。
pub fn ensure_exclusive(target: Backend, app: &AppHandle) -> Result<Vec<&'static str>, String> {
    let mut stopped = Vec::new();
    if target != Backend::Main && process_manager::is_server_running() {
        crate::commands::server::stop_server_with_app(app)
            .map_err(|error| format!("无法停止主模型：{error}"))?;
        stopped.push(Backend::Main.label());
    }
    if target != Backend::Fast27b && fast27b_manager::is_fast27b_running() {
        crate::commands::fast27b::stop_fast27b_with_app(app)
            .map_err(|error| format!("无法停止 NiNfer：{error}"))?;
        stopped.push(Backend::Fast27b.label());
    }
    if target != Backend::Strata && strata_manager::is_strata_running() {
        crate::commands::strata::stop_strata_with_app(app)
            .map_err(|error| format!("无法停止 Strata：{error}"))?;
        stopped.push(Backend::Strata.label());
    }
    Ok(stopped)
}

/// 当前有哪个后端在跑（用于「对话后端自动选择」的兜底判断）。
///
/// 三个都不在跑时返回 None。两个以上同时存活属于异常状态（互斥闸门应已阻止），
/// 此时优先回报主模型，其次 NiNfer，最后 Strata——与启动成本从低到高一致。
pub fn active_backend() -> Option<Backend> {
    if process_manager::is_server_running() {
        return Some(Backend::Main);
    }
    if fast27b_manager::is_fast27b_running() {
        return Some(Backend::Fast27b);
    }
    if strata_manager::is_strata_running() {
        return Some(Backend::Strata);
    }
    None
}
