use tauri::{AppHandle, Emitter, State};

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use once_cell::sync::Lazy;

use crate::models::app_state::AppState;
use crate::services::auto_updater;
use crate::services::ffmpeg_installer;
use crate::services::process_manager;
use crate::services::update_center::{self, Component, ComponentUpdate, LocalPaths, Ports};

/// 从应用配置中读取代理地址（核心更新相关的所有 HTTP 请求共用）。
fn proxy_from_state(state: &State<'_, AppState>) -> Option<String> {
    state
        .config
        .lock()
        .ok()
        .and_then(|config| config.proxy_url.clone())
        .filter(|url| !url.trim().is_empty())
}

/// 更新中心实际使用的代理：应用内显式配置优先，没配时跟随 Windows 系统代理。
///
/// 设置页在打开时会自动填入系统代理，但用户如果从没进过设置页，
/// 配置里就是空的——此时直连 api.github.com 往往直接超时，
/// 表现就是「核心更新检查不出来、装也装不上」。
fn resolve_proxy(state: &State<'_, AppState>) -> Option<String> {
    proxy_from_state(state).or_else(system_proxy::read)
}

#[tauri::command]
pub async fn check_for_update(
    state: State<'_, AppState>,
) -> Result<auto_updater::ReleaseInfo, String> {
    let proxy = proxy_from_state(&state);
    tokio::task::spawn_blocking(move || auto_updater::check_latest_release(proxy.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn list_recent_releases(
    state: State<'_, AppState>,
    count: Option<usize>,
) -> Result<Vec<auto_updater::ReleaseInfo>, String> {
    let proxy = proxy_from_state(&state);
    tokio::task::spawn_blocking(move || {
        auto_updater::list_recent_releases(count.unwrap_or(5), proxy.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn download_and_update(
    state: State<'_, AppState>,
    app: AppHandle,
    url: String,
    version: String,
    use_mirror: Option<bool>,
    mirror_url: Option<String>,
) -> Result<String, String> {
    let guard = crate::services::benchmark::acquire_lifecycle()?;
    let app2 = app.clone();
    let url2 = url.clone();
    let version2 = version.clone();
    let mirror = use_mirror.unwrap_or(false);
    let proxy = proxy_from_state(&state);

    tokio::task::spawn_blocking(move || {
        let _guard = guard;
        if process_manager::is_server_running() {
            app2.emit(
                "updater:progress",
                serde_json::json!({ "message": "正在停止 llama-server..." }),
            )
            .ok();
            process_manager::stop_server().map_err(|e| e.to_string())?;
        }
        auto_updater::download_and_install(
            &url2,
            &version2,
            mirror,
            mirror_url.as_deref(),
            proxy.as_deref(),
            |msg| {
                app2.emit("updater:progress", serde_json::json!({ "message": msg }))
                    .ok();
            },
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 请求取消正在进行的下载/安装；更新流程会在最近的检查点中止。
#[tauri::command]
pub fn cancel_kernel_update() {
    auto_updater::request_cancel();
}

/// 列出本机版本化核心目录（kernels/<版本>_<安装时间>/），按安装时间从新到旧。
#[tauri::command]
pub fn list_installed_kernels() -> Vec<auto_updater::InstalledKernel> {
    auto_updater::list_installed_kernels()
}

#[tauri::command]
pub fn get_update_history() -> Vec<auto_updater::UpdateLogEntry> {
    auto_updater::get_update_log()
}

/// 下载并安装 ffmpeg / ffprobe 到应用 resources 目录（视频与部分音频格式的可选运行时）。
/// 与内核更新共用代理设置、镜像加速偏好与取消标志。
#[tauri::command]
pub async fn install_ffmpeg(
    state: State<'_, AppState>,
    app: AppHandle,
    use_mirror: Option<bool>,
) -> Result<String, String> {
    let proxy = proxy_from_state(&state);
    let mirror = use_mirror.unwrap_or(true);
    tokio::task::spawn_blocking(move || {
        ffmpeg_installer::install(proxy.as_deref(), mirror, |message| {
            app.emit(
                "ffmpeg:progress",
                serde_json::json!({ "message": message }),
            )
            .ok();
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 取消正在进行的 ffmpeg 安装（与内核更新共用取消标志）。
#[tauri::command]
pub fn cancel_ffmpeg_install() {
    auto_updater::request_cancel();
}

// ---------------------------------------------------------------------------
// 统一更新中心：五个组件的最新版检查与安装
// ---------------------------------------------------------------------------

/// 各组件当前监听的端口，用于「更新前是否在运行」的判断。
fn ports_from_state(state: &State<'_, AppState>) -> Ports {
    state
        .config
        .lock()
        .map(|config| Ports {
            llama: config.default_port,
            strata: config.strata.port,
            ninfer: config.fast27b.port,
        })
        .unwrap_or_default()
}

/// 引擎所在目录：用户自己放的引擎没有版本戳，需要按目录判断「已安装」。
fn local_paths_from_state(state: &State<'_, AppState>) -> LocalPaths {
    state
        .config
        .lock()
        .map(|config| {
            let strata_dir = config.strata.work_dir.trim().to_string();
            let engine_path = config.fast27b.engine_path.trim().to_string();
            LocalPaths {
                strata_work_dir: if strata_dir.is_empty() {
                    None
                } else {
                    Some(PathBuf::from(strata_dir))
                },
                ninfer_engine_dir: Path::new(&engine_path)
                    .parent()
                    .filter(|parent| !parent.as_os_str().is_empty())
                    .map(Path::to_path_buf),
            }
        })
        .unwrap_or_default()
}

/// 正在安装的组件集合：只拦同一个组件，不同组件可以并行更新。
static INSTALLING: Lazy<Mutex<HashSet<&'static str>>> = Lazy::new(|| Mutex::new(HashSet::new()));

struct InstallSlot(&'static str);

impl Drop for InstallSlot {
    fn drop(&mut self) {
        if let Ok(mut set) = INSTALLING.lock() {
            set.remove(self.0);
        }
    }
}

fn begin_install(id: &'static str) -> Result<InstallSlot, String> {
    let mut set = INSTALLING.lock().map_err(|_| "更新状态不可用".to_string())?;
    if !set.insert(id) {
        return Err("该组件正在更新，请等它完成后再试。".to_string());
    }
    Ok(InstallSlot(id))
}

#[tauri::command]
pub async fn update_center_check(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Vec<ComponentUpdate>, String> {
    let proxy = resolve_proxy(&state);
    let ports = ports_from_state(&state);
    let paths = local_paths_from_state(&state);
    tokio::task::spawn_blocking(move || {
        update_center::check_all_with(proxy.as_deref(), ports, &paths, &|update| {
            // 逐项回传：前端不必等五个组件全部结束才看到结果。
            app.emit("update-center:component", &update).ok();
        })
    })
    .await
    .map_err(|e| e.to_string())
}

/// 安装 / 升级单个组件。进度统一走 `update-center:progress` 事件。
#[tauri::command]
pub async fn update_center_install(
    state: State<'_, AppState>,
    app: AppHandle,
    component: String,
) -> Result<String, String> {
    let parsed = update_center::Component::parse(&component)?;
    // 同一个组件不允许并行装；不同组件互不影响，可以同时更新。
    let slot = begin_install(parsed.id())?;
    let proxy = resolve_proxy(&state);
    let ports = ports_from_state(&state);
    let (strata_work_dir, ninfer_engine_dir) = {
        let config = state
            .config
            .lock()
            .map_err(|e| format!("配置锁定失败: {e}"))?;
        let work_dir = config.strata.work_dir.trim().to_string();
        let engine_path = config.fast27b.engine_path.trim().to_string();
        (
            if work_dir.is_empty() {
                None
            } else {
                Some(std::path::PathBuf::from(work_dir))
            },
            std::path::Path::new(&engine_path)
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .map(|parent| parent.to_path_buf()),
        )
    };

    // 只有 llama.cpp 会停掉主模型服务，才需要与「加载/测速/自动调参」互斥；
    // Pi / ffmpeg / 引擎都是独立目录，允许同时下载安装。
    let lifecycle = if parsed == Component::Llama {
        Some(crate::services::benchmark::acquire_lifecycle()?)
    } else {
        None
    };
    let event_component = component.clone();
    tokio::task::spawn_blocking(move || {
        let _slot = slot;
        let _lifecycle = lifecycle;
        let progress = move |message: String| {
            app.emit(
                "update-center:progress",
                serde_json::json!({ "component": event_component, "message": message }),
            )
            .ok();
        };
        let ctx = update_center::InstallContext {
            proxy: proxy.as_deref(),
            strata_work_dir,
            ninfer_engine_dir,
            ports,
            on_progress: &progress,
        };
        update_center::install(parsed, &ctx)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 取消当前更新（与内核 / ffmpeg 安装共用同一标志）。
#[tauri::command]
pub fn update_center_cancel() {
    auto_updater::request_cancel();
}

/// 读取 Windows 系统代理（系统设置里那一个），用于自动填入下载代理。
/// 未启用或读不到时返回 None。
#[tauri::command]
pub fn detect_system_proxy() -> Option<String> {
    system_proxy::read()
}

#[cfg(windows)]
mod system_proxy {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    const INTERNET_SETTINGS: &str =
        r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";

    pub fn read() -> Option<String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let key = hkcu.open_subkey(INTERNET_SETTINGS).ok()?;
        let enabled: u32 = key.get_value("ProxyEnable").unwrap_or(0);
        if enabled == 0 {
            return None;
        }
        let server: String = key.get_value("ProxyServer").ok()?;
        normalize(&server)
    }

    fn normalize(raw: &str) -> Option<String> {
        let raw = raw.trim();
        if raw.is_empty() {
            return None;
        }
        // 系统代理有两种写法：`host:port` 与 `http=host:port;https=host:port`。
        let candidate = if raw.contains('=') {
            raw.split(';')
                .filter_map(|part| part.split_once('='))
                .find(|(scheme, _)| scheme.trim().eq_ignore_ascii_case("http"))
                .map(|(_, value)| value.to_string())
                .or_else(|| {
                    raw.split(';')
                        .next()?
                        .split_once('=')
                        .map(|(_, value)| value.to_string())
                })?
        } else {
            raw.to_string()
        };
        let candidate = candidate.trim();
        if candidate.is_empty() {
            return None;
        }
        if candidate.starts_with("http://") || candidate.starts_with("https://") {
            Some(candidate.to_string())
        } else {
            Some(format!("http://{candidate}"))
        }
    }

    #[cfg(test)]
    mod tests {
        use super::normalize;

        #[test]
        fn normalizes_plain_host_port() {
            assert_eq!(
                normalize("127.0.0.1:7890").as_deref(),
                Some("http://127.0.0.1:7890")
            );
        }

        #[test]
        fn picks_http_entry_from_per_protocol_list() {
            assert_eq!(
                normalize("ftp=127.0.0.1:21;http=127.0.0.1:7890").as_deref(),
                Some("http://127.0.0.1:7890")
            );
        }

        #[test]
        fn keeps_existing_scheme() {
            assert_eq!(
                normalize("http://127.0.0.1:8080").as_deref(),
                Some("http://127.0.0.1:8080")
            );
        }
    }
}

#[cfg(not(windows))]
mod system_proxy {
    pub fn read() -> Option<String> {
        None
    }
}
