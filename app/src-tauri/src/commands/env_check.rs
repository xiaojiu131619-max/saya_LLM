//! 首次启动环境检测：一次性检查本机运行 Agent LLM 所需的组件，
//! 对未就绪的项返回中文说明与安装引导（应用内跳转或外部下载链接）。
//!
//! 检测项（顺序即前端展示顺序）：
//! 1. llama.cpp 推理内核（llama-server.exe）
//! 2. Microsoft VC++ 运行库（CUDA / 部分 Vulkan 内核依赖）
//! 3. 显卡与驱动（NVIDIA CUDA / AMD·Intel Vulkan / CPU）
//! 4. ffmpeg / ffprobe（可选，视频与部分音频格式）
//! 5. 数据目录可写（排障项）

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::models::app_state::AppState;
use crate::services::{auto_updater, process_manager};

/// 单项检测结果。level 决定前端展示颜色：
/// `ok` = 通过、`warning` = 不影响核心功能、`error` = 必需组件未就绪。
#[derive(Debug, Clone, Serialize)]
pub struct EnvCheckItem {
    pub id: String,
    pub level: String,
    pub title: String,
    pub detail: String,
    /// 未通过时的安装引导说明（中文，可直接展示）。
    pub install_hint: Option<String>,
    /// 外部下载/官方页面链接（VC++ 运行库、ffmpeg、显卡驱动）。
    pub install_url: Option<String>,
    /// 应用内动作：`kernel-update` = 跳转「核心更新」页。
    pub in_app_action: Option<String>,
}

impl EnvCheckItem {
    pub fn new(id: &str, level: &str, title: &str, detail: String) -> Self {
        Self {
            id: id.to_string(),
            level: level.to_string(),
            title: title.to_string(),
            detail,
            install_hint: None,
            install_url: None,
            in_app_action: None,
        }
    }

    pub fn with_hint(mut self, hint: &str, url: Option<&str>, action: Option<&str>) -> Self {
        self.install_hint = Some(hint.to_string());
        self.install_url = url.map(str::to_string);
        self.in_app_action = action.map(str::to_string);
        self
    }
}

/// llama.cpp 内核：按与加载模型一致的解析规则查找 llama-server.exe。
fn check_kernel() -> EnvCheckItem {
    const TITLE: &str = "llama.cpp 推理内核";
    let resolved = process_manager::resolve_exe_path("resources/llama-server.exe");
    if resolved.is_empty() {
        return EnvCheckItem::new(
            "kernel",
            "error",
            TITLE,
            "未找到 llama-server.exe，无法加载和运行本地模型。".to_string(),
        )
        .with_hint(
            "请在「核心更新」页下载与你显卡匹配的官方内核：NVIDIA 选 CUDA，AMD / Intel 选 Vulkan。",
            None,
            Some("kernel-update"),
        );
    }

    let version = auto_updater::get_current_version()
        .map(|v| format!("版本 {}", v))
        .unwrap_or_else(|| "版本未知".to_string());
    let devices = process_manager::list_runtime_devices(&resolved);
    let (host_backend, gpu_name) = auto_updater::detect_host_gpu_backend();
    let runtime_backend = if devices
        .iter()
        .any(|device| device.to_ascii_lowercase().starts_with("cuda"))
    {
        "CUDA"
    } else if devices
        .iter()
        .any(|device| device.to_ascii_lowercase().starts_with("vulkan"))
    {
        "Vulkan"
    } else if devices.is_empty() {
        "未知"
    } else {
        devices[0].as_str()
    };

    if host_backend == "CUDA" && runtime_backend == "Vulkan" {
        return EnvCheckItem::new(
            "kernel",
            "warning",
            TITLE,
            format!(
                "内核已就绪（{}，当前为 Vulkan），但这台机器更适合 CUDA 包。路径：{}",
                version, resolved
            ),
        )
        .with_hint(
            "NVIDIA 显卡请在「核心更新」下载 CUDA 内核，速度通常明显优于 Vulkan。",
            None,
            Some("kernel-update"),
        );
    }
    if host_backend == "Vulkan" && runtime_backend == "CUDA" {
        return EnvCheckItem::new(
            "kernel",
            "error",
            TITLE,
            format!(
                "内核已就绪（{}），但是 CUDA 包。这台 {} 需要 Vulkan 内核才能用 GPU。路径：{}",
                version,
                gpu_name.as_deref().unwrap_or("AMD / Intel 显卡"),
                resolved
            ),
        )
        .with_hint(
            "请在「核心更新」下载 Vulkan 包，不要使用 CUDA 包。",
            None,
            Some("kernel-update"),
        );
    }
    if host_backend != "CPU" && runtime_backend == "未知" {
        return EnvCheckItem::new(
            "kernel",
            "warning",
            TITLE,
            format!("内核已就绪（{}），但未能列出加速设备。路径：{}", version, resolved),
        )
        .with_hint(
            "请确认内核完整，或到「核心更新」重新下载匹配本机显卡的包。",
            None,
            Some("kernel-update"),
        );
    }

    let device_text = if devices.is_empty() {
        "未列出加速设备".to_string()
    } else {
        format!("加速设备 {}", devices.join(" / "))
    };
    EnvCheckItem::new(
        "kernel",
        "ok",
        TITLE,
        format!("内核已就绪（{}，{}）。路径：{}", version, device_text, resolved),
    )
}

/// VC++ 运行库：CUDA 版 llama.cpp 内核运行依赖的三个核心 DLL。
/// 应用本身是 x64 进程，检查 64 位系统目录（System32）即可。
fn vc_runtime_installed() -> bool {
    #[cfg(windows)]
    {
        let system_root =
            std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
        let system32 = Path::new(&system_root).join("System32");
        ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll"]
            .iter()
            .all(|name| system32.join(name).exists())
    }
    #[cfg(not(windows))]
    {
        true
    }
}

fn check_vc_runtime() -> EnvCheckItem {
    const TITLE: &str = "Microsoft VC++ 运行库";
    if vc_runtime_installed() {
        return EnvCheckItem::new("vc_runtime", "ok", TITLE, "已安装（vcruntime140 / msvcp140）。".to_string());
    }
    EnvCheckItem::new(
        "vc_runtime",
        "error",
        TITLE,
        "缺少 VC++ 运行库（vcruntime140 / msvcp140），CUDA / Vulkan 内核都可能无法启动。".to_string(),
    )
    .with_hint(
        "请安装 Microsoft Visual C++ 2015-2022 可再发行程序包（x64），安装完成后重新检测。",
        Some("https://aka.ms/vs/17/release/vc_redist.x64.exe"),
        None,
    )
}

/// 显卡与驱动：NVIDIA 走 CUDA；AMD / Intel 走 Vulkan。两条路线都视为可用加速，不是「没 NVIDIA 就不算」。
fn check_gpu() -> EnvCheckItem {
    const TITLE: &str = "显卡与驱动";
    let (backend, gpu_name) = auto_updater::detect_host_gpu_backend();
    match (backend.as_str(), gpu_name.as_deref()) {
        ("CUDA", Some(name)) => {
            let detail = match auto_updater::detect_cuda_version() {
                Some(version) => format!("NVIDIA 驱动正常：{}（CUDA {}）。核心更新将匹配 CUDA 包。", name, version),
                None => format!("NVIDIA 驱动正常：{}。核心更新将匹配 CUDA 包。", name),
            };
            EnvCheckItem::new("gpu", "ok", TITLE, detail)
        }
        ("Vulkan", Some(name)) => EnvCheckItem::new(
            "gpu",
            "ok",
            TITLE,
            format!("{} 将使用 Vulkan 加速。请在「核心更新」下载 Vulkan 内核，不要选 CUDA。", name),
        ),
        ("CPU", _) => EnvCheckItem::new(
            "gpu",
            "warning",
            TITLE,
            "未检测到可用独显，模型将以 CPU 模式运行，速度可能较慢。".to_string(),
        ),
        (_, Some(name)) => EnvCheckItem::new(
            "gpu",
            "ok",
            TITLE,
            format!("已检测到显卡：{}（{}）。", name, backend),
        ),
        _ => EnvCheckItem::new(
            "gpu",
            "warning",
            TITLE,
            "未检测到显卡信息，模型将以 CPU 模式运行，速度可能较慢。".to_string(),
        ),
    }
}

/// ffmpeg / ffprobe：可选组件，只影响原生视频理解与部分音频格式。
fn check_video_runtime() -> EnvCheckItem {
    const TITLE: &str = "ffmpeg / ffprobe（视频支持）";
    let runtime = process_manager::check_video_runtime();
    let ffmpeg = runtime.ffmpeg_available;
    let ffprobe = runtime.ffprobe_available;
    let missing = match (ffmpeg, ffprobe) {
        (true, true) => {
            let path = runtime.ffmpeg_path.as_deref().unwrap_or("ffmpeg");
            return EnvCheckItem::new("video_runtime", "ok", TITLE, format!("已就绪：{}", path));
        }
        (false, false) => "ffmpeg 与 ffprobe".to_string(),
        (false, true) => "ffmpeg".to_string(),
        (true, false) => "ffprobe".to_string(),
    };
    EnvCheckItem::new(
        "video_runtime",
        "warning",
        TITLE,
        format!("未找到{}。不影响对话与图片理解，仅视频原生处理与部分音频格式受限。", missing),
    )
    .with_hint(
        "推荐在本弹窗内点「一键安装 ffmpeg」自动下载并安装到应用 resources 目录；也可从 ffmpeg 官方构建页手动下载，将 ffmpeg.exe / ffprobe.exe 放入 resources 目录或加入 PATH 后重新检测。",
        Some("https://www.gyan.dev/ffmpeg/builds/"),
        None,
    )
}

/// 数据目录：Agent LLM 的配置、记录与扫描缓存都存放在这里。
/// 被杀毒软件或权限策略拦截时应用无法保存任何设置，列入检测便于排障。
fn check_data_dir() -> EnvCheckItem {
    const TITLE: &str = "数据目录";
    let dir: PathBuf = crate::commands::config::get_app_data_root();
    let probe = dir.join(".env_check_write_test");
    let write_result = (|| -> std::io::Result<()> {
        std::fs::write(&probe, b"ok")?;
        std::fs::remove_file(&probe)?;
        Ok(())
    })();
    match write_result {
        Ok(()) => EnvCheckItem::new("data_dir", "ok", TITLE, format!("目录可读写：{}", dir.display())),
        Err(error) => EnvCheckItem::new(
            "data_dir",
            "warning",
            TITLE,
            format!("目录无法写入（{}）：{}", error, dir.display()),
        )
        .with_hint(
            "请检查该目录的访问权限或杀毒软件拦截设置，否则配置与运行记录无法保存。",
            None,
            None,
        ),
    }
}

/// 运行一次完整环境检测。包含少量子进程探测（nvidia-smi / PowerShell），
/// 整体在秒级内完成，供首次启动与设置页手动检测调用。
#[tauri::command]
pub fn run_env_check(_state: State<'_, AppState>) -> Vec<EnvCheckItem> {
    vec![
        check_kernel(),
        check_vc_runtime(),
        check_gpu(),
        check_video_runtime(),
        check_data_dir(),
    ]
}

/// 读取首次启动检测标记，供前端判断是否需要自动弹窗。
#[tauri::command]
pub fn get_env_check_done(state: State<'_, AppState>) -> Result<bool, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;
    Ok(config.env_check_done)
}
