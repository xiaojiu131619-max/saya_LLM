//! 统一更新中心：把六个组件的「检查最新版 / 下载 / 安装」收敛到一处。
//!
//! 设计原则：
//! - **不重写下载逻辑**。llama / Pi / ffmpeg 直接复用各自已有的安装器；
//!   这里只负责「判断该不该更新、该装哪个包、装之前要不要先停服务」。
//! - **按显卡选包**。发行包是分架构的（CUDA 12/13、HIP RDNA2/3/4），
//!   选错不是「装不上」而是「能装但跑不起来」，所以判断依据集中在 `gpu_profile`。
//! - **只提供最新版**。不列历史版本、不提供版本选择——这是产品决定，不是省事。
//! - 安装失败不允许留下半个目录：先解压到临时目录并校验，再搬进正式位置。

use std::io::{Read, Write};
use std::net::{IpAddr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::services::gpu_profile::{self, AmdArch, GpuProfile};
use crate::services::{
    archive, auto_updater, fast27b_manager, ffmpeg_installer, pi_agent, pi_install,
    process_manager, strata_manager, storage_paths,
};

/// 允许下载的主机。发布包最终会被当作可执行文件运行，地址不能由前端任意指定。
const ALLOWED_HOSTS: &[&str] = &[    "github.com",
    "api.github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];

const STRATA_RELEASE_API: &str = "https://api.github.com/repos/Niko1221/Strata/releases/latest";
const NINFER_RELEASE_API: &str =
    "https://api.github.com/repos/melis2023/ninfer-kvmem-actkv/releases?per_page=10";
const FFMPEG_RELEASE_API: &str =
    "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest";

/// 「检查更新」是只读探测，不该按下载的超时标准等。
/// 60s 总超时 × 2 次重试 × 5 个组件串行，网络不通时要等十几分钟。
const CHECK_TIMEOUT_SECS: u64 = 20;
const CHECK_CONNECT_TIMEOUT_SECS: u64 = 6;
/// 重试间隔：短超时下没必要再等 1s。
const CHECK_RETRY_DELAY_MS: u64 = 500;
/// 版本戳缺失但目录里确实有引擎时的展示占位。
const INSTALLED_UNKNOWN: &str = "已安装";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Component {
    Pi,
    Llama,
    Strata,
    Ninfer,
    Ffmpeg,
}

impl Component {
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "pi" => Ok(Component::Pi),
            "llama" => Ok(Component::Llama),
            "strata" => Ok(Component::Strata),
            "ninfer" => Ok(Component::Ninfer),
            "ffmpeg" => Ok(Component::Ffmpeg),
            other => Err(format!("未知的更新组件：{other}")),
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Component::Pi => "pi",
            Component::Llama => "llama",
            Component::Strata => "strata",
            Component::Ninfer => "ninfer",
            Component::Ffmpeg => "ffmpeg",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Component::Pi => "Pi 智能体内核",
            Component::Llama => "llama.cpp 推理内核",
            Component::Strata => "Strata 引擎",
            Component::Ninfer => "NiNfer 引擎",
            Component::Ffmpeg => "ffmpeg",
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Ports {
    pub llama: u16,
    pub strata: u16,
    pub ninfer: u16,
}

/// 检查「是否已安装」需要知道用户把引擎放在哪。
/// 版本戳只在更新中心装过时才有；用户自己放的引擎要按目录探测。
#[derive(Debug, Clone, Default)]
pub struct LocalPaths {
    pub strata_work_dir: Option<PathBuf>,
    pub ninfer_engine_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentUpdate {
    pub id: &'static str,
    pub name: &'static str,
    pub installed_version: Option<String>,
    pub latest_version: Option<String>,
    pub update_available: bool,
    /// 本机是否已经装了这个组件（有版本戳，或配置目录里能找到可执行文件）。
    pub installed: bool,
    /// 本机硬件是否支持这个组件的发行包（NiNfer 只支持 NVIDIA）。
    pub applicable: bool,
    /// 人话说明为什么选了这个包 / 为什么不可用。
    pub applicability: String,
    pub running: bool,
    pub port: Option<u16>,
    pub message: Option<String>,
}

fn base(component: Component, applicable: bool, applicability: impl Into<String>) -> ComponentUpdate {
    ComponentUpdate {
        id: component.id(),
        name: component.name(),
        installed_version: None,
        latest_version: None,
        update_available: false,
        installed: false,
        applicable,
        applicability: applicability.into(),
        running: false,
        port: None,
        message: None,
    }
}

/// 并行检查全部组件；每完成一个就回调一次，界面可以边等边显示。
///
/// 串行检查的问题是「一个组件卡住，整页都空着」：GitHub 不通时每个组件
/// 都要走完超时 + 重试，五个加在一起就是分钟级等待，而第一条结果本来是
/// 秒级就能拿到的。所以这里按组件并发，顺序只影响事件到达时间，不影响
/// 返回值的固定顺序。
pub fn check_all_with(
    proxy: Option<&str>,
    ports: Ports,
    paths: &LocalPaths,
    on_result: &dyn Fn(ComponentUpdate),
) -> Vec<ComponentUpdate> {
    let gpu = gpu_profile::current();
    let components = [
        Component::Pi,
        Component::Llama,
        Component::Strata,
        Component::Ninfer,
        Component::Ffmpeg,
    ];
    let (sender, receiver) = std::sync::mpsc::channel::<(usize, ComponentUpdate)>();
    let mut collected: Vec<Option<ComponentUpdate>> =
        (0..components.len()).map(|_| None).collect();

    std::thread::scope(|scope| {
        for (index, component) in components.iter().copied().enumerate() {
            let sender = sender.clone();
            let gpu = &gpu;
            scope.spawn(move || {
                let update = check_component(component, proxy, ports, paths, gpu);
                let _ = sender.send((index, update));
            });
        }
        drop(sender);
        for (index, update) in receiver {
            on_result(update.clone());
            collected[index] = Some(update);
        }
    });

    collected.into_iter().flatten().collect()
}

fn check_component(
    component: Component,
    proxy: Option<&str>,
    ports: Ports,
    paths: &LocalPaths,
    gpu: &GpuProfile,
) -> ComponentUpdate {
    match component {
        Component::Pi => check_pi(proxy),
        Component::Llama => check_llama(proxy, gpu, ports.llama),
        Component::Strata => check_strata(proxy, gpu, ports.strata, paths.strata_work_dir.as_deref()),
        Component::Ninfer => check_ninfer(proxy, gpu, ports.ninfer, paths.ninfer_engine_dir.as_deref()),
        Component::Ffmpeg => check_ffmpeg(proxy),
    }
}

fn check_pi(proxy: Option<&str>) -> ComponentUpdate {
    let mut entry = base(Component::Pi, true, "通用（与显卡无关）");
    entry.running = pi_agent::is_running();
    // registry.npmjs.org 在部分网络下不可达；检查是只读操作，官方源失败时
    // 静默换 npmmirror，避免整行显示成「检查失败」。
    let info = pi_install::fetch_versions(None, proxy)
        .or_else(|_| pi_install::fetch_versions(Some(pi_install::REGISTRY_MIRROR), proxy));
    match info {
        Ok(info) => {
            entry.update_available = version_is_newer(&info.latest, info.installed_version.as_deref());
            entry.installed = info.installed_version.is_some();
            entry.installed_version = info.installed_version;
            entry.latest_version = Some(info.latest);
        }
        Err(error) => entry.message = Some(format!("检查更新失败：{error}")),
    }
    entry
}

fn check_llama(proxy: Option<&str>, gpu: &GpuProfile, port: u16) -> ComponentUpdate {
    let applicability = llama_applicability(gpu);
    let mut entry = base(Component::Llama, true, applicability);
    entry.running = process_manager::is_server_running() || port_open(port);
    if port > 0 {
        entry.port = Some(port);
    }
    entry.installed_version = installed_llama_version();
    entry.installed = entry.installed_version.is_some();
    match auto_updater::check_latest_release_with(
        proxy,
        CHECK_TIMEOUT_SECS,
        CHECK_CONNECT_TIMEOUT_SECS,
    ) {
        Ok(release) => {
            entry.update_available =
                version_is_newer(&release.version, entry.installed_version.as_deref());
            entry.latest_version = Some(release.version);
        }
        Err(error) => entry.message = Some(format!("检查更新失败：{}", network_error_hint(&error, proxy))),
    }
    entry
}

fn llama_applicability(gpu: &GpuProfile) -> String {
    match gpu.vendor.as_str() {
        "nvidia" => match gpu.cuda_major {
            Some(major) if gpu.is_blackwell && major < 13 => {
                format!("已按 {} 选择 CUDA 包（Blackwell 建议 ≥12.8）", gpu.name.clone().unwrap_or_else(|| "NVIDIA 显卡".into()))
            }
            Some(major) => format!(
                "已按 {} 选择 CUDA {major} 包",
                gpu.name.clone().unwrap_or_else(|| "NVIDIA 显卡".into())
            ),
            None => "未能识别 CUDA 版本，将选择通用包".to_string(),
        },
        "amd" => format!(
            "已按 {} 选择 Vulkan 包（{}）",
            gpu.name.clone().unwrap_or_else(|| "AMD 显卡".into()),
            gpu.amd_arch.map(AmdArch::label).unwrap_or("未识别架构")
        ),
        "intel" => "已选择 Vulkan 包".to_string(),
        _ => "未能识别显卡，将选择通用包".to_string(),
    }
}

fn check_strata(
    proxy: Option<&str>,
    gpu: &GpuProfile,
    port: u16,
    work_dir: Option<&Path>,
) -> ComponentUpdate {
    let variant = strata_variant(gpu);
    let applicability = match &variant {
        Ok(name) => format!("已按 {} 选择 {name} 包", gpu.name.clone().unwrap_or_else(|| gpu.vendor_label.clone())),
        Err(reason) => reason.clone(),
    };
    let mut entry = base(Component::Strata, variant.is_ok(), applicability);
    entry.installed_version = read_stamp("strata-engine");
    // 版本戳只覆盖「从更新中心装过」的情况；用户自己放的引擎也要算已安装：
    // 既认原生 strata.exe，也认源码/网关形态（bin/strata.cmd、strata.py）。
    let engine = work_dir.and_then(|dir| {
        ["strata.exe", "strata.py", "bin/strata.cmd", "bin/strata"]
            .iter()
            .map(|relative| dir.join(relative))
            .find(|path| path.is_file())
    });
    entry.installed = entry.installed_version.is_some() || engine.is_some();
    if entry.installed && entry.installed_version.is_none() {
        // 不知道具体版本时给一个占位：界面显示「已安装」，版本比较按未知处理。
        entry.installed_version = Some(INSTALLED_UNKNOWN.to_string());
    }
    entry.running = strata_manager::is_strata_running() || port_open(port);
    if port > 0 {
        entry.port = Some(port);
    }
    if let Err(reason) = variant {
        entry.message = Some(reason);
        return entry;
    }
    match github_json(STRATA_RELEASE_API, proxy) {
        Ok(json) => {
            entry.latest_version = json["tag_name"].as_str().map(normalize_version);
            if entry.latest_version.is_none() {
                entry.message = Some("发行信息里没有版本号".to_string());
            } else {
                entry.update_available =
                    version_is_newer(entry.latest_version.as_deref().unwrap_or(""), entry.installed_version.as_deref());
            }
        }
        Err(error) => entry.message = Some(format!("检查更新失败：{}", network_error_hint(&error, proxy))),
    }
    entry
}

fn check_ninfer(
    proxy: Option<&str>,
    gpu: &GpuProfile,
    port: u16,
    engine_dir: Option<&Path>,
) -> ComponentUpdate {
    let applicable = gpu.is_nvidia();
    let applicability = if applicable {
        format!(
            "已按 {} 选择 Ninfer 引擎包",
            gpu.name.clone().unwrap_or_else(|| "NVIDIA 显卡".into())
        )
    } else {
        format!("仅支持 NVIDIA 显卡，本机为 {}", gpu.vendor_label)
    };
    let mut entry = base(Component::Ninfer, applicable, applicability);
    entry.installed_version = read_stamp("ninfer-engine");
    let engine = engine_dir
        .filter(|dir| dir.is_dir())
        .and_then(|dir| find_file(dir, |name| name.starts_with("ninfer-serve") && name.ends_with(".exe")));
    entry.installed = entry.installed_version.is_some() || engine.is_some();
    if entry.installed && entry.installed_version.is_none() {
        entry.installed_version = Some(INSTALLED_UNKNOWN.to_string());
    }
    entry.running = fast27b_manager::is_fast27b_running() || port_open(port);
    if port > 0 {
        entry.port = Some(port);
    }
    if !applicable {
        entry.message = Some("NiNfer 引擎只发布 NVIDIA（CUDA）构建，本机无法使用。".to_string());
        return entry;
    }
    match ninfer_latest_release(proxy) {
        Ok((version, _asset)) => {
            entry.update_available =
                version_is_newer(&version, entry.installed_version.as_deref());
            entry.latest_version = Some(version);
        }
        Err(error) => entry.message = Some(format!("检查更新失败：{}", network_error_hint(&error, proxy))),
    }
    entry
}

fn check_ffmpeg(proxy: Option<&str>) -> ComponentUpdate {
    let mut entry = base(Component::Ffmpeg, true, "通用（与显卡无关）");
    entry.installed_version = ffmpeg_installer::installed_version();
    entry.installed = entry.installed_version.is_some();
    match github_json(FFMPEG_RELEASE_API, proxy) {
        Ok(json) => {
            // BtbN 使用滚动 tag（`latest`），没有可比较的版本号；
            // 「更新」的含义就是重新拉一次最新构建。
            entry.latest_version = Some(
                json["published_at"]
                    .as_str()
                    .map(|date| date.chars().take(10).collect::<String>())
                    .unwrap_or_else(|| "最新构建".to_string()),
            );
            // 滚动构建没有可比较的版本号：装过也允许重新拉一次最新。
            entry.update_available = true;
        }
        Err(error) => entry.message = Some(format!("检查更新失败：{}", network_error_hint(&error, proxy))),
    }
    entry
}

/// Strata 引擎包的架构变体。
pub fn strata_variant(gpu: &GpuProfile) -> Result<&'static str, String> {
    if gpu.is_nvidia() {
        return Ok(match gpu.cuda_major {
            Some(major) if major >= 13 => "cuda-cuda13",
            _ => "cuda-cuda12",
        });
    }
    if gpu.is_amd() {
        return match gpu.amd_arch {
            Some(AmdArch::Rdna4) => Ok("hip-rx9070"),
            Some(AmdArch::Rdna3) => Ok(concat!("hip-", "rdna3")),
            Some(AmdArch::Rdna2) => Ok(concat!("hip-", "rdna2")),
            _ => Err("本机 AMD 显卡不在 Strata 引擎支持范围内（需要 RX 6000 / 7000 / 9000 系列）".to_string()),
        };
    }
    Err("Strata 引擎只发布 NVIDIA / AMD 的 Windows 包".to_string())
}

// ---------------------------------------------------------------------------
// 安装
// ---------------------------------------------------------------------------

pub struct InstallContext<'a> {
    pub proxy: Option<&'a str>,
    pub strata_work_dir: Option<PathBuf>,
    pub ninfer_engine_dir: Option<PathBuf>,
    pub ports: Ports,
    pub on_progress: &'a dyn Fn(String),
}

pub fn install(component: Component, ctx: &InstallContext<'_>) -> Result<String, String> {
    auto_updater::reset_cancel();
    match component {
        Component::Pi => install_pi(ctx),
        Component::Llama => install_llama(ctx),
        Component::Strata => install_strata(ctx),
        Component::Ninfer => install_ninfer(ctx),
        Component::Ffmpeg => install_ffmpeg(ctx),
    }
}

fn install_pi(ctx: &InstallContext<'_>) -> Result<String, String> {
    if pi_agent::is_running() {
        return Err("Pi 正在运行：请先停止 Pi 再更新。".to_string());
    }
    (ctx.on_progress)("正在读取 Pi 版本列表...".to_string());
    let versions = pi_install::fetch_versions(None, ctx.proxy)?;
    (ctx.on_progress)(format!("正在安装 Pi {}...", versions.latest));
    let result = pi_install::install_online(&versions.latest, None, None, ctx.proxy)?;
    Ok(format!("Pi 已更新到 {}", result.version))
}

fn install_llama(ctx: &InstallContext<'_>) -> Result<String, String> {
    let release = auto_updater::check_latest_release(ctx.proxy)?;
    let asset = release
        .assets
        .first()
        .ok_or_else(|| "最新发行版里没有可用的 Windows 包".to_string())?;
    (ctx.on_progress)(format!("正在停止 llama-server 并安装 {}...", release.version));
    if process_manager::is_server_running() {
        process_manager::stop_server().map_err(|e| e.to_string())?;
    }
    ensure_port_free(ctx.ports.llama, "llama-server")?;
    auto_updater::download_and_install(
        &asset.browser_download_url,
        &release.version,
        false,
        None,
        ctx.proxy,
        ctx.on_progress,
    )
}

fn install_strata(ctx: &InstallContext<'_>) -> Result<String, String> {
    let work_dir = ctx
        .strata_work_dir
        .clone()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| "请先在 Strata 页配置源码目录，再更新引擎。".to_string())?;
    if !work_dir.is_dir() {
        return Err(format!("Strata 源码目录不存在：{}", work_dir.display()));
    }
    let variant = strata_variant(&gpu_profile::current())?;
    let json = github_json(STRATA_RELEASE_API, ctx.proxy)?;
    let tag = json["tag_name"].as_str().unwrap_or("").to_string();
    let asset = pick_strata_asset(&json, variant)
        .ok_or_else(|| format!("发行版 {tag} 里没有 {variant} 的 Windows 引擎包"))?;

    let version = normalize_version(&tag);
    (ctx.on_progress)(format!("正在下载 Strata 引擎 {version}（{variant}）..."));
    if strata_manager::is_strata_running() {
        (ctx.on_progress)("正在停止 Strata...".to_string());
        strata_manager::stop_strata().map_err(|e| e.to_string())?;
    }
    ensure_port_free(ctx.ports.strata, "Strata")?;

    let staging = temp_dir("strata")?;
    let archive_path = staging.join("engine.tar.gz");
    download_to_file(&asset.url, asset.sha256.as_deref(), &archive_path, ctx.proxy, ctx.on_progress, "Strata 引擎")?;
    let unpacked = staging.join("unpacked");
    archive::extract_tar_gz(&archive_path, &unpacked)?;

    let engine = find_file(&unpacked, |name| name.eq_ignore_ascii_case("strata.exe"))
        .ok_or_else(|| "Strata 引擎包里没有找到 strata.exe，已中止（未改动现有文件）。".to_string())?;

    // 只替换内核可执行文件：Python 网关与 run config 仍由用户自己维护。
    let target = work_dir.join("strata.exe");
    std::fs::copy(&engine, &target)
        .map_err(|e| format!("写入 {} 失败：{e}", target.display()))?;
    write_stamp("strata-engine", &version)?;
    let _ = std::fs::remove_dir_all(&staging);
    Ok(format!("Strata 引擎已更新到 {version}（{variant}）"))
}

fn install_ninfer(ctx: &InstallContext<'_>) -> Result<String, String> {
    let gpu = gpu_profile::current();
    if !gpu.is_nvidia() {
        return Err("NiNfer 引擎只发布 NVIDIA（CUDA）构建，本机无法安装。".to_string());
    }
    let engine_dir = ctx
        .ninfer_engine_dir
        .clone()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| "请先在 NiNfer 页配置引擎路径，再更新引擎。".to_string())?;

    let (version, asset) = ninfer_latest_release(ctx.proxy)?;
    (ctx.on_progress)(format!("正在下载 NiNfer 引擎 {version}..."));
    if fast27b_manager::is_fast27b_running() {
        (ctx.on_progress)("正在停止 NiNfer...".to_string());
        fast27b_manager::stop_fast27b().map_err(|e| e.to_string())?;
    }
    ensure_port_free(ctx.ports.ninfer, "NiNfer")?;

    let staging = temp_dir("ninfer")?;
    let archive_path = staging.join("engine.rar");
    download_to_file(&asset.url, asset.sha256.as_deref(), &archive_path, ctx.proxy, ctx.on_progress, "NiNfer 引擎")?;
    let unpacked = staging.join("unpacked");
    archive::extract_rar(&archive_path, &unpacked)?;

    let engine = find_file(&unpacked, |name| name.eq_ignore_ascii_case("ninfer-serve-86.exe"))
        .or_else(|| find_file(&unpacked, |name| name.starts_with("ninfer-serve") && name.ends_with(".exe")))
        .ok_or_else(|| "NiNfer 引擎包里没有找到 ninfer-serve-86.exe，已中止（未改动现有文件）。".to_string())?;
    let source_dir = engine
        .parent()
        .ok_or_else(|| "无法确定引擎文件所在目录".to_string())?;

    std::fs::create_dir_all(&engine_dir)
        .map_err(|e| format!("无法创建引擎目录（{}）：{e}", engine_dir.display()))?;
    copy_dir_contents(source_dir, &engine_dir)?;
    write_stamp("ninfer-engine", &version)?;
    let _ = std::fs::remove_dir_all(&staging);
    Ok(format!("NiNfer 引擎已更新到 {version}"))
}

fn install_ffmpeg(ctx: &InstallContext<'_>) -> Result<String, String> {
    (ctx.on_progress)("正在获取 ffmpeg 最新构建...".to_string());
    // 不做镜像回退：直连失败就明确报错，避免用户拿到来源不明的二进制。
    ffmpeg_installer::install(ctx.proxy, false, |message| (ctx.on_progress)(message))
}

// ---------------------------------------------------------------------------
// 发行版解析
// ---------------------------------------------------------------------------

struct AssetChoice {
    url: String,
    sha256: Option<String>,
}

fn pick_strata_asset(json: &Value, variant: &str) -> Option<AssetChoice> {
    let assets = json["assets"].as_array()?;
    let prefix = format!("strata-engine-");
    let suffix = format!("-windows-x86_64-{variant}.tar.gz");
    assets.iter().find_map(|asset| {
        let name = asset["name"].as_str()?;
        if name.starts_with(&prefix) && name.ends_with(&suffix) {
            Some(AssetChoice {
                url: asset["browser_download_url"].as_str()?.to_string(),
                sha256: asset_sha256(asset),
            })
        } else {
            None
        }
    })
}

/// NiNfer 的 tag 前缀不统一（`niner-actkv-1.7` / `ninfer-actkv-1.5`），
/// 所以按发布时间取最新，而不是按 tag 名匹配。
fn ninfer_latest_release(proxy: Option<&str>) -> Result<(String, AssetChoice), String> {
    let json = github_json(NINFER_RELEASE_API, proxy)?;
    let releases = json
        .as_array()
        .ok_or_else(|| "NiNfer 发行信息格式异常".to_string())?;
    let latest = releases
        .iter()
        .filter(|release| !release["draft"].as_bool().unwrap_or(false))
        .max_by(|a, b| {
            let left = a["published_at"].as_str().unwrap_or("");
            let right = b["published_at"].as_str().unwrap_or("");
            left.cmp(right)
        })
        .ok_or_else(|| "NiNfer 还没有发布任何版本".to_string())?;

    let version = ninfer_display_version(latest["tag_name"].as_str().unwrap_or(""));
    let assets = latest["assets"]
        .as_array()
        .ok_or_else(|| "NiNfer 发行版缺少资产列表".to_string())?;
    let asset = assets
        .iter()
        .find_map(|asset| {
            let name = asset["name"].as_str()?;
            let lower = name.to_ascii_lowercase();
            // 引擎包；launcher / gguf / 转换工具都不参与引擎更新。
            if lower.starts_with("kvmem-actkv") && lower.ends_with(".rar") {
                Some(AssetChoice {
                    url: asset["browser_download_url"].as_str()?.to_string(),
                    sha256: asset_sha256(asset),
                })
            } else {
                None
            }
        })
        .ok_or_else(|| format!("NiNfer {version} 里没有找到引擎压缩包（kvmem-actkv*.rar）"))?;
    Ok((version, asset))
}

/// GitHub 自 2024 起给资产附 `digest: "sha256:..."`；缺失时返回 None，
/// 调用方只做大小/结构校验并在进度里说明。
fn asset_sha256(asset: &Value) -> Option<String> {
    asset["digest"]
        .as_str()
        .and_then(|raw| raw.strip_prefix("sha256:"))
        .map(|value| value.to_ascii_lowercase())
}

// ---------------------------------------------------------------------------
// 下载与文件
// ---------------------------------------------------------------------------

fn download_to_file(
    url: &str,
    expected_sha256: Option<&str>,
    dest: &Path,
    proxy: Option<&str>,
    on_progress: &dyn Fn(String),
    label: &str,
) -> Result<(), String> {
    ensure_download_url_allowed(url)?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建临时目录（{}）：{e}", parent.display()))?;
    }
    let client = auto_updater::build_client(proxy, 1800, 30)?;
    let mut response = client
        .get(url)
        .header("User-Agent", "AgentLLM")
        .send()
        .map_err(|e| format!("下载{label}失败：{e}"))?;
    if !response.status().is_success() {
        return Err(format!("下载{label}失败：HTTP {}", response.status()));
    }
    let total = response.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(dest)
        .map_err(|e| format!("无法写入临时文件（{}）：{e}", dest.display()))?;
    let mut hasher = sha2::Sha256::new();
    use sha2::Digest;
    let mut buffer = vec![0u8; 256 * 1024];
    let mut written: u64 = 0;
    let mut next_report: u64 = 0;
    loop {
        auto_updater::ensure_not_cancelled()?;
        let read = response
            .read(&mut buffer)
            .map_err(|e| format!("下载{label}中断：{e}"))?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|e| format!("写入{label}失败：{e}"))?;
        hasher.update(&buffer[..read]);
        written += read as u64;
        if written >= next_report {
            next_report = written + 16 * 1024 * 1024;
            if total > 0 {
                on_progress(format!(
                    "正在下载{label}：{:.0}% （{:.0} MB / {:.0} MB）",
                    written as f64 / total as f64 * 100.0,
                    written as f64 / 1048576.0,
                    total as f64 / 1048576.0
                ));
            } else {
                on_progress(format!("正在下载{label}：{:.0} MB", written as f64 / 1048576.0));
            }
        }
    }
    drop(file);
    let digest: String = hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect();
    if let Some(expected) = expected_sha256 {
        if !expected.eq_ignore_ascii_case(&digest) {
            let _ = std::fs::remove_file(dest);
            return Err(format!(
                "{label}校验失败：SHA256 不匹配（期望 {expected}，实际 {digest}），已删除下载文件。"
            ));
        }
    } else {
        on_progress(format!("{label}未提供官方校验值，已按大小 {written} 字节完成下载。"));
    }
    Ok(())
}

pub fn ensure_download_url_allowed(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "下载地址格式无效".to_string())?;
    if parsed.scheme() != "https" {
        return Err("下载地址必须是 https".to_string());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "下载地址缺少主机名".to_string())?
        .to_ascii_lowercase();
    if is_forbidden_host(&host) {
        return Err(format!("拒绝从本机或内网地址下载：{host}"));
    }
    if !ALLOWED_HOSTS.iter().any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}"))) {
        return Err(format!("拒绝从非官方地址下载：{host}"));
    }
    Ok(())
}

fn is_forbidden_host(host: &str) -> bool {
    if host == "localhost" || host.ends_with(".localhost") {
        return true;
    }
    let Ok(ip) = host.parse::<IpAddr>() else {
        return false;
    };
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || o[0] == 0
                || o[0] >= 224
                || (o[0] == 100 && (64..128).contains(&o[1]))
        }
        IpAddr::V6(v6) => {
            let segments = v6.segments();
            v6.is_loopback()
                || v6.is_unspecified()
                || (segments[0] & 0xfe00) == 0xfc00
                || (segments[0] & 0xffc0) == 0xfe80
        }
    }
}

fn github_json(url: &str, proxy: Option<&str>) -> Result<Value, String> {
    ensure_download_url_allowed(url)?;
    let client = auto_updater::build_client(
        proxy,
        CHECK_TIMEOUT_SECS,
        CHECK_CONNECT_TIMEOUT_SECS,
    )?;
    let mut last_error = String::new();
    // 三个组件并发打同一个代理时偶发单次失败，多给一次机会比直接判失败好。
    for attempt in 0..3 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(
                CHECK_RETRY_DELAY_MS * (attempt as u64) * 2,
            ));
        }
        match client.get(url).header("User-Agent", "AgentLLM").send() {
            Ok(response) => {
                if response.status().as_u16() == 403 {
                    return Err("GitHub API 限流（403），请稍后再试。".to_string());
                }
                if !response.status().is_success() {
                    last_error = format!("HTTP {}", response.status());
                    continue;
                }
                return response
                    .json::<Value>()
                    .map_err(|e| format!("解析发布信息失败：{e}"));
            }
            Err(error) => last_error = error.to_string(),
        }
    }
    Err(network_error_hint(&last_error, proxy))
}

/// 把底层网络错误翻译成用户能照做的提示。
/// 绝大多数「连接不上」都是代理没生效，所以把当前用的是哪个代理也写进去，便于判断。
fn network_error_hint(error: &str, proxy: Option<&str>) -> String {
    let lower = error.to_ascii_lowercase();
    let unreachable = lower.contains("timed out")
        || lower.contains("timeout")
        || lower.contains("connect")
        || lower.contains("dns")
        || lower.contains("tls")
        || lower.contains("certificate")
        || lower.contains("reset")
        || lower.contains("sending request");
    if unreachable {
        let proxy_label = match proxy.map(str::trim).filter(|value| !value.is_empty()) {
            Some(url) => format!("当前代理 {url}"),
            None => "当前未配置代理（直连）".to_string(),
        };
        format!(
            "无法连接更新服务器（{error}）。{proxy_label}；请在「设置 → 软件设置」里检查代理是否可用。"
        )
    } else {
        error.to_string()
    }
}

fn temp_dir(tag: &str) -> Result<PathBuf, String> {
    let dir = storage_paths::app_data_root()
        .join("update-center")
        .join(format!("tmp-{tag}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("无法创建临时目录（{}）：{e}", dir.display()))?;
    Ok(dir)
}

fn find_file(root: &Path, predicate: impl Fn(&str) -> bool) -> Option<PathBuf> {
    walkdir::WalkDir::new(root)
        .max_depth(8)
        .into_iter()
        .filter_map(Result::ok)
        .find(|entry| {
            entry.file_type().is_file()
                && entry
                    .file_name()
                    .to_str()
                    .map(|name| predicate(name))
                    .unwrap_or(false)
        })
        .map(|entry| entry.into_path())
}

fn copy_dir_contents(source: &Path, target: &Path) -> Result<(), String> {
    for entry in walkdir::WalkDir::new(source).min_depth(1) {
        let entry = entry.map_err(|e| format!("遍历解压结果失败：{e}"))?;
        let relative = entry
            .path()
            .strip_prefix(source)
            .map_err(|_| "无法计算解压文件相对路径".to_string())?;
        let destination = target.join(relative);
        if entry.file_type().is_dir() {
            std::fs::create_dir_all(&destination)
                .map_err(|e| format!("创建目录失败（{}）：{e}", destination.display()))?;
        } else {
            if let Some(parent) = destination.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("创建目录失败（{}）：{e}", parent.display()))?;
            }
            std::fs::copy(entry.path(), &destination).map_err(|e| {
                format!(
                    "复制 {} 失败：{e}",
                    entry.path().display()
                )
            })?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 版本戳与版本比较
// ---------------------------------------------------------------------------

fn stamp_path(id: &str) -> PathBuf {
    storage_paths::app_data_root()
        .join("update-center")
        .join(format!("{id}.version"))
}

fn read_stamp(id: &str) -> Option<String> {
    std::fs::read_to_string(stamp_path(id))
        .ok()
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
}

fn write_stamp(id: &str, version: &str) -> Result<(), String> {
    let path = stamp_path(id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建版本记录目录：{e}"))?;
    }
    std::fs::write(&path, version).map_err(|e| format!("写入版本记录失败：{e}"))
}

fn installed_llama_version() -> Option<String> {
    auto_updater::list_installed_kernels()
        .into_iter()
        .find(|kernel| kernel.is_active)
        .map(|kernel| kernel.version)
}

fn normalize_version(raw: &str) -> String {
    raw.trim().trim_start_matches(['v', 'V']).to_string()
}

/// NiNfer 的 tag 形如 `niner-actkv-1.7`（注意上游把 ninfer 拼成了 niner）。
/// 界面上只展示末尾的数字版本，不把整个 tag 当版本号。
fn ninfer_display_version(tag: &str) -> String {
    let trimmed = tag.trim();
    if let Some((_, tail)) = trimmed.rsplit_once('-') {
        let tail = tail.trim();
        if tail.chars().next().is_some_and(|ch| ch.is_ascii_digit()) {
            return tail.to_string();
        }
    }
    normalize_version(trimmed)
}

/// 数字段比较；忽略前缀字母与后缀。缺失的段按 0 处理。
pub fn version_is_newer(latest: &str, installed: Option<&str>) -> bool {
    let Some(installed) = installed else {
        return !latest.trim().is_empty();
    };
    let left = version_parts(latest);
    if left.is_empty() {
        return false;
    }
    let right = version_parts(installed);
    for index in 0..left.len().max(right.len()) {
        let a = left.get(index).copied().unwrap_or(0);
        let b = right.get(index).copied().unwrap_or(0);
        if a != b {
            return a > b;
        }
    }
    false
}

fn version_parts(raw: &str) -> Vec<u64> {
    raw.split(|ch: char| !ch.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse::<u64>().ok())
        .take(4)
        .collect()
}

fn port_open(port: u16) -> bool {
    if port == 0 {
        return false;
    }
    TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(300),
    )
    .is_ok()
}

/// 停服务之后端口必须真的释放了才允许替换文件：Windows 下正在被占用的 exe 无法覆盖。
fn ensure_port_free(port: u16, label: &str) -> Result<(), String> {
    if !port_open(port) {
        return Ok(());
    }
    Err(format!(
        "{label} 仍在占用端口 {port}，未开始替换文件。请手动结束该进程后重试。"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gpu(vendor: &str, cuda: Option<u32>, arch: Option<AmdArch>) -> GpuProfile {
        GpuProfile {
            vendor: vendor.to_string(),
            vendor_label: vendor.to_string(),
            name: Some("test gpu".to_string()),
            cuda_major: cuda,
            is_blackwell: false,
            amd_arch: arch,
        }
    }

    #[test]
    fn strata_variant_follows_cuda_major() {
        assert_eq!(strata_variant(&gpu("nvidia", Some(12), None)), Ok("cuda-cuda12"));
        assert_eq!(strata_variant(&gpu("nvidia", Some(13), None)), Ok("cuda-cuda13"));
        // 识别不到 CUDA 版本时保守选 cuda12。
        assert_eq!(strata_variant(&gpu("nvidia", None, None)), Ok("cuda-cuda12"));
    }

    #[test]
    fn strata_variant_maps_amd_arch() {
        assert_eq!(strata_variant(&gpu("amd", None, Some(AmdArch::Rdna2))), Ok(concat!("hip-", "rdna2")));
        assert_eq!(strata_variant(&gpu("amd", None, Some(AmdArch::Rdna3))), Ok("hip-rdna3"));
        assert_eq!(strata_variant(&gpu("amd", None, Some(AmdArch::Rdna4))), Ok("hip-rx9070"));
        assert!(strata_variant(&gpu("amd", None, Some(AmdArch::Other))).is_err());
    }

    #[test]
    fn strata_variant_rejects_intel_and_unknown() {
        assert!(strata_variant(&gpu("intel", None, None)).is_err());
        assert!(strata_variant(&gpu("unknown", None, None)).is_err());
    }

    #[test]
    fn rejects_loopback_and_private_downloads() {
        assert!(ensure_download_url_allowed("http://github.com/x.zip").is_err());
        assert!(ensure_download_url_allowed("https://localhost/x.zip").is_err());
        assert!(ensure_download_url_allowed("https://127.0.0.1/x.zip").is_err());
        assert!(ensure_download_url_allowed("https://192.168.1.10/x.zip").is_err());
        assert!(ensure_download_url_allowed("https://169.254.1.1/x.zip").is_err());
        assert!(ensure_download_url_allowed("https://10.0.0.5/x.zip").is_err());
        assert!(ensure_download_url_allowed("https://example.com/x.zip").is_err());
        assert!(ensure_download_url_allowed("https://github.com/o/r/releases/download/v1/a.zip").is_ok());
    }

    #[test]
    fn version_comparison_handles_prefixes_and_tags() {
        assert!(version_is_newer("0.2.10", Some("0.2.9")));
        assert!(!version_is_newer("0.2.9", Some("0.2.10")));
        assert!(version_is_newer("v1.7", None));
        assert!(version_is_newer("niner-actkv-1.7", Some("1.5")));
        assert!(!version_is_newer("b4206", Some("b4206")));
    }

    #[test]
    fn ninfer_version_uses_numeric_tail() {
        assert_eq!(ninfer_display_version("niner-actkv-1.7"), "1.7");
        assert_eq!(ninfer_display_version("ninfer-actkv-1.5"), "1.5");
        assert_eq!(ninfer_display_version("ninfer-actkv"), "ninfer-actkv");
        assert_eq!(ninfer_display_version("v0.2.10"), "0.2.10");
    }
}
