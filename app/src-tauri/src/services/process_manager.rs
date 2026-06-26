use std::io::{BufRead, BufReader};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use anyhow::Result;
use once_cell::sync::Lazy;
use serde::Serialize;
use sysinfo::System;

use crate::models::server_config::ServerConfig;

static CHILD_PROCESS: Lazy<Mutex<Option<Child>>> = Lazy::new(|| Mutex::new(None));
static SERVER_LOGS: Lazy<Mutex<Vec<String>>> = Lazy::new(|| Mutex::new(Vec::new()));

#[derive(Clone, Serialize)]
pub struct ServerProgress {
    pub progress: u32,
    pub stage: String,
    pub log: String,
}

#[derive(Clone, Serialize)]
pub struct ServerError {
    pub error_type: String,
    pub title: String,
    pub details: String,
    pub suggestions: Vec<String>,
}

fn build_redacted_command_line(exe: &str, cmd: &Command) -> String {
    let mut s = exe.to_string();
    // 对 --api-key 后紧跟的实参做脱敏，避免明文密钥进入日志缓冲（会被 get_server_logs 回传前端）与 stderr。
    let mut redact_next = false;
    for a in cmd.get_args() {
        s.push(' ');
        if redact_next {
            s.push_str("***");
            redact_next = false;
            continue;
        }
        if a == "--api-key" {
            redact_next = true;
        }
        s.push_str(&a.to_string_lossy());
    }
    s
}

fn resolve_exe_path(path: &str) -> String {
    let requested = Path::new(path);
    if requested.is_absolute() && requested.exists() {
        return path.to_string();
    }

    let fname = requested
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path);
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|d| d.to_path_buf()));
    let grandparent = exe_dir
        .as_ref()
        .and_then(|d| d.parent().map(|p| p.to_path_buf()));

    let candidates: Vec<PathBuf> = [
        exe_dir
            .as_ref()
            .map(|d| d.join("_up_").join("resources").join(fname)),
        grandparent
            .as_ref()
            .map(|g| g.join("_up_").join("resources").join(fname)),
        exe_dir.as_ref().map(|d| d.join("resources").join(fname)),
        grandparent
            .as_ref()
            .map(|g| g.join("resources").join(fname)),
        exe_dir.as_ref().map(|d| d.join(fname)),
        exe_dir.as_ref().map(|d| d.join(path)),
        Some(PathBuf::from(format!("_up_/resources/{}", fname))),
        Some(PathBuf::from(format!("resources/{}", fname))),
        Some(PathBuf::from(format!("../{}", path))),
        Some(PathBuf::from(format!("./{}", path))),
        Some(PathBuf::from(format!("./{}", fname))),
        Some(PathBuf::from(format!("../resources/{}", fname))),
        Some(PathBuf::from(format!("../../resources/{}", fname))),
        Some(PathBuf::from(path)),
        Some(PathBuf::from(fname)),
    ]
    .into_iter()
    .flatten()
    .collect();

    for c in &candidates {
        if c.exists() {
            eprintln!("[server] resolved exe: {}", c.display());
            return c.to_string_lossy().to_string();
        }
    }
    eprintln!("[server] exe not found, tried: {:?}", candidates);
    path.to_string()
}

fn same_path(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(aa), Ok(bb)) => aa == bb,
        _ => a == b,
    }
}

fn stop_stale_servers_for_exe(exe: &str) {
    let exe_path = Path::new(exe);
    let mut system = System::new_all();
    system.refresh_processes();

    let mut stopped = 0usize;
    for process in system.processes_by_exact_name("llama-server.exe") {
        if let Some(process_exe) = process.exe() {
            if same_path(process_exe, exe_path) {
                eprintln!(
                    "[server] stopping stale llama-server pid={:?} path={}",
                    process.pid(),
                    process_exe.display()
                );
                if process.kill() {
                    stopped += 1;
                }
            }
        }
    }

    if stopped > 0 {
        eprintln!(
            "[server] stopped {} stale llama-server process(es)",
            stopped
        );
        std::thread::sleep(Duration::from_millis(400));
    }
}

fn parse_progress(line: &str) -> u32 {
    if line.contains("server is listening") {
        return 100;
    }
    if line.contains("model loaded") {
        return 92;
    }
    if line.contains("CUDA0 model buffer size") {
        return 85;
    }

    if line.contains("offloaded ") {
        if let Some(caps) = line.find("offloaded ") {
            let rest = &line[caps + 10..];
            if let Some(slash) = rest.find('/') {
                let done: u32 = rest[..slash].trim().parse().unwrap_or(0);
                let rest2 = &rest[slash + 1..];
                let end: u32 = rest2
                    .split_whitespace()
                    .next()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(1);
                if end > 0 {
                    return 20 + ((done * 60).checked_div(end).unwrap_or(1).min(65));
                }
            }
        }
    }
    if line.contains("offload") {
        return 40;
    }
    if line.contains("llama_new_context_with_model") {
        return 82;
    }
    if line.contains("fitting params") {
        return 30;
    }
    if line.contains("creatingavid") {
        return 75;
    }
    if line.contains("loading model") || line.contains("load_model") {
        return 12;
    }
    if line.contains("llama_init_from_file") {
        return 22;
    }
    if line.contains("ggml init") || line.contains("initialize ggml") {
        return 5;
    }
    if line.contains("System info") || line.contains("system info") {
        return 3;
    }
    if line.contains("llama") && line.contains("build") {
        return 2;
    }
    5
}

fn stage_name(progress: u32) -> String {
    match progress {
        0..=15 => "启动推理引擎...".into(),
        16..=35 => "分析模型参数...".into(),
        36..=55 => "加载模型权重...".into(),
        56..=85 => "加载模型到显存...".into(),
        86..=99 => "初始化服务...".into(),
        _ => "服务就绪".into(),
    }
}

fn bind_host(config: &ServerConfig) -> String {
    let host = config.host.trim();
    if host.is_empty() {
        "127.0.0.1".to_string()
    } else {
        host.to_string()
    }
}

fn health_check_host(config: &ServerConfig) -> String {
    match bind_host(config).as_str() {
        "0.0.0.0" | "::" | "[::]" => "127.0.0.1".to_string(),
        host => host.to_string(),
    }
}

fn port_is_listening(config: &ServerConfig) -> bool {
    let addr = format!("{}:{}", health_check_host(config), config.port);
    let Ok(addrs) = addr.to_socket_addrs() else {
        return false;
    };

    addrs
        .into_iter()
        .any(|addr| TcpStream::connect_timeout(&addr, Duration::from_millis(150)).is_ok())
}

fn wait_for_port_release(config: &ServerConfig, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if !port_is_listening(config) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    !port_is_listening(config)
}

fn detect_error(line: &str) -> Option<ServerError> {
    let line_lower = line.to_lowercase();

    // Some llama.cpp builds can crash during the empty warmup pass after the
    // model is already loaded. Treat it as a launch failure with actionable
    // GPU/parameter guidance instead of leaving the frontend waiting.
    if line_lower.contains("ggml_assert(buffer)")
        || line_lower.contains("assert(buffer)")
        || (line_lower.contains("warm")
            && line_lower.contains("buffer")
            && line_lower.contains("failed"))
    {
        return Some(ServerError {
            error_type: "warmup".into(),
            title: "模型预热失败".into(),
            details: line.into(),
            suggestions: vec![
                "这是 llama.cpp 预热阶段失败，请先查看 [server] spawn 命令确认当前显式参数".into(),
                "如果仍然失败，再手动降低 GPU 卸载层数或上下文长度后重试".into(),
                "显存接近上限时，关闭 mlock 并改用更小的 KV 缓存类型".into(),
            ],
        });
    }

    // CUDA errors - broad matching
    if line_lower.contains("cuda error")
        || line_lower.contains("cuda init")
        || line_lower.contains("cudamalloc")
        || line_lower.contains("failed to initialize cuda")
        || line_lower.contains("no cuda device")
        || line_lower.contains("no cuda")
        || (line_lower.contains("failed") && line_lower.contains("cuda"))
        || (line_lower.contains("nvcc") && line_lower.contains("not found"))
        || line_lower.contains("could not find cuda")
        || line_lower.contains("cuda driver")
        || line_lower.contains("cuda dll")
    {
        return Some(ServerError {
            error_type: "cuda".into(),
            title: "CUDA 错误".into(),
            details: line.into(),
            suggestions: vec![
                "更新 NVIDIA 驱动".into(),
                "确保 CUDA 驱动版本与 llama-server 兼容".into(),
                "检查 resources/ 目录下的 DLL 是否完整".into(),
            ],
        });
    }

    // OOM
    if line_lower.contains("out of memory")
        || line_lower.contains("cuda oom")
        || line_lower.contains("out of vram")
        || (line_lower.contains("allocate") && line_lower.contains("failed"))
    {
        return Some(ServerError {
            error_type: "oom".into(),
            title: "显存不足".into(),
            details: line.into(),
            suggestions: vec![
                "降低 GPU 卸载层数".into(),
                "减少上下文长度".into(),
                "使用更小的量化模型".into(),
            ],
        });
    }

    // Model errors
    if line_lower.contains("error loading model")
        || line_lower.contains("unknown format")
        || line_lower.contains("invalid model")
        || line_lower.contains("failed to load model")
    {
        return Some(ServerError {
            error_type: "model".into(),
            title: "模型格式错误".into(),
            details: line.into(),
            suggestions: vec!["检查模型文件是否完整".into(), "更新 llama.cpp 版本".into()],
        });
    }

    // Port conflict
    if line.contains("Address already in use")
        || line.contains("bind() failed")
        || (line_lower.contains("port") && line_lower.contains("in use"))
    {
        return Some(ServerError {
            error_type: "port".into(),
            title: "端口被占用".into(),
            details: line.into(),
            suggestions: vec![
                "关闭占用 8080 端口的程序".into(),
                "在设置中修改默认端口".into(),
            ],
        });
    }

    // Llama load failure
    if line_lower.contains("failed")
        && (line_lower.contains("llama") || line_lower.contains("model"))
    {
        return Some(ServerError {
            error_type: "cuda".into(),
            title: "加载失败".into(),
            details: line.into(),
            suggestions: vec![
                "检查 llama-server.exe 是否匹配当前 GPU".into(),
                "尝试手动运行 llama-server.exe 查看具体错误".into(),
            ],
        });
    }

    None
}

#[allow(dead_code)]
fn start_server_once_legacy<F: Fn(ServerProgress) + Send + 'static>(
    config: &ServerConfig,
    on_progress: F,
    on_ready: impl Fn() + Send + Sync + 'static,
    on_error: impl Fn(ServerError) + Send + Sync + 'static,
) -> Result<()> {
    eprintln!(
        "[server] start_server called with: ngl={}, n_ctx={}, host={}, port={}",
        config.ngl,
        config.n_ctx,
        bind_host(config),
        config.port
    );

    {
        let mut guard = CHILD_PROCESS.lock().unwrap();
        if let Some(mut old_child) = guard.take() {
            eprintln!("[server] stopping existing server before restart...");
            let _ = old_child.kill();
            let _ = old_child.wait();
        }
    }

    let exe = resolve_exe_path(&config.executable_path);
    eprintln!("[server] resolved exe path: {}", exe);
    if !Path::new(&exe).exists() {
        return Err(anyhow::anyhow!(
            "找不到 llama-server.exe (搜索路径: {})。请在设置中指定正确路径，或将其放入 resources/ 目录。",
            exe
        ));
    }

    stop_stale_servers_for_exe(&exe);
    clear_logs();

    // Honor the configured ngl exactly. The detail page defaults the slider to
    // the model's full layer count, so an untouched config still offloads every
    // layer — but if the user (or Auto-Tune) lowered ngl, we respect that here
    // instead of forcing it back to max.
    let effective_ngl = config.ngl;
    eprintln!("[server] using configured ngl={}", effective_ngl);
    let host = bind_host(config);

    let mut cmd = Command::new(&exe);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    cmd.arg("-m")
        .arg(&config.model_path)
        .arg("--port")
        .arg(config.port.to_string())
        .arg("--host")
        .arg(&host)
        .arg("-ngl")
        .arg(effective_ngl.to_string())
        .arg("-c")
        .arg(config.n_ctx.to_string())
        .arg("-b")
        .arg(config.batch_size.to_string());

    if config.ubatch_size > 0 {
        cmd.arg("-ub").arg(config.ubatch_size.to_string());
    }
    if config.threads > 0 {
        cmd.arg("-t").arg(config.threads.to_string());
    }
    if config.parallel > 0 {
        cmd.arg("-np").arg(config.parallel.to_string());
    }

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    cmd.arg("--flash-attn")
        .arg(if config.flash_attn { "on" } else { "off" });
    if !config.kv_offload {
        cmd.arg("--no-kv-offload");
    }
    cmd.arg(if config.kv_unified {
        "--kv-unified"
    } else {
        "--no-kv-unified"
    });
    cmd.arg(if config.mmap { "--mmap" } else { "--no-mmap" });
    if config.mlock {
        cmd.arg("--mlock");
    }
    if config.no_cuda {
        cmd.arg("--device").arg("none");
    }
    if config.ncmoe > 0 {
        cmd.arg("-ncmoe").arg(config.ncmoe.to_string());
    }
    if let Some(ref tools) = config.tools {
        if !tools.is_empty() {
            cmd.arg("--tools").arg(tools);
        }
    }
    if let Some(api_key) = config
        .api_key
        .as_ref()
        .map(|key| key.trim())
        .filter(|key| !key.is_empty())
    {
        cmd.arg("--api-key").arg(api_key);
    }
    if config.cache_type_k_enabled && !config.cache_type_k.trim().is_empty() {
        cmd.arg("-ctk").arg(&config.cache_type_k);
    }
    if config.cache_type_v_enabled && !config.cache_type_v.trim().is_empty() {
        cmd.arg("-ctv").arg(&config.cache_type_v);
    }
    if let Some(value) = config.rope_freq_base {
        if value > 0.0 {
            cmd.arg("--rope-freq-base").arg(value.to_string());
        }
    }
    if let Some(value) = config.rope_freq_scale {
        if value > 0.0 {
            cmd.arg("--rope-freq-scale").arg(value.to_string());
        }
    }
    if let Some(seed) = config.seed {
        cmd.arg("-s").arg(seed.to_string());
    }
    if let Some(template) = config
        .chat_template
        .as_ref()
        .map(|template| template.trim())
        .filter(|template| !template.is_empty())
    {
        cmd.arg("--chat-template").arg(template);
    }

    // Print the exact command line so the user can copy-paste and test manually.
    eprintln!("[server] spawn: {}", build_redacted_command_line(&exe, &cmd));

    let mut child = cmd.spawn()?;
    eprintln!("[server] child pid = {:?}", child.id());

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    {
        let mut guard = CHILD_PROCESS.lock().unwrap();
        *guard = Some(child);
    }

    let (tx, rx) = mpsc::channel::<String>();

    if let Some(out) = stdout {
        let tx_out = tx.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if tx_out.send(line).is_err() {
                    break;
                }
            }
        });
    }

    if let Some(err) = stderr {
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
    }

    // Whichever signals readiness/failure first wins; the guard makes sure the
    // frontend only ever receives one terminal event.
    let fired = Arc::new(AtomicBool::new(false));
    let on_ready = Arc::new(on_ready);
    let on_error = Arc::new(on_error);

    // HTTP health-check fallback: the log line "server is listening" can be
    // missed (buffering, reworded across llama.cpp versions), which previously
    // left the loading screen stuck forever. Polling /health is authoritative.
    {
        let fired = fired.clone();
        let on_ready = on_ready.clone();
        let port = config.port;
        let health_host = health_check_host(config);
        let api_key = config
            .api_key
            .as_ref()
            .map(|key| key.trim().to_string())
            .filter(|key| !key.is_empty());
        std::thread::spawn(move || {
            let client = match reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(2))
                .build()
            {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("[server] health-check client build failed: {}", e);
                    return;
                }
            };
            let url = format!("http://{}:{}/health", health_host, port);
            eprintln!("[server] health-check polling {}", url);
            let deadline = Instant::now() + Duration::from_secs(600);
            while Instant::now() < deadline {
                // Give up if the process already died.
                if !is_server_running() {
                    eprintln!("[server] health-check abort: process died");
                    return;
                }
                let request = client.get(&url);
                let request = if let Some(key) = &api_key {
                    request.bearer_auth(key)
                } else {
                    request
                };
                if let Ok(resp) = request.send() {
                    if resp.status().is_success() {
                        eprintln!("[server] health-check ready ({})", resp.status());
                        if !fired.swap(true, Ordering::SeqCst) {
                            on_ready();
                        }
                        return;
                    }
                }
                std::thread::sleep(Duration::from_millis(500));
            }
            eprintln!("[server] health-check timed out after 600s");
        });
    }

    std::thread::spawn(move || {
        let mut max_progress = 0u32;
        for line in rx {
            add_log(&line);
            let p = parse_progress(&line);
            if p > max_progress {
                max_progress = p;
            }
            on_progress(ServerProgress {
                progress: max_progress,
                stage: stage_name(max_progress),
                log: line.clone(),
            });

            if line.contains("server is listening") {
                if !fired.swap(true, Ordering::SeqCst) {
                    on_ready();
                }
                return;
            }

            if let Some(err) = detect_error(&line) {
                if !fired.swap(true, Ordering::SeqCst) {
                    on_error(err);
                }
                return;
            }
        }

        // Log stream ended. If we never signaled readiness, the process bailed
        // before listening — report a failure (unless the health check already
        // declared success).
        if !fired.swap(true, Ordering::SeqCst) {
            eprintln!(
                "[server] log stream ended without ready/error signal — process exited early"
            );
            on_error(ServerError {
                error_type: "unknown".into(),
                title: "启动失败".into(),
                details: "进程异常退出，请在 llama.cpp 目录下手动运行 llama-server.exe 测试".into(),
                suggestions: vec![
                    "检查模型文件路径是否正确".into(),
                    "在命令行手动测试: llama-server.exe -m 模型路径".into(),
                    "检查显卡驱动是否正常".into(),
                ],
            });
        }
    });

    Ok(())
}

enum MonitorResult {
    Ready,
    Error(ServerError),
    Exited,
    TimedOut,
}

fn server_request(
    client: &reqwest::blocking::Client,
    url: &str,
    api_key: Option<&str>,
) -> reqwest::blocking::RequestBuilder {
    let request = client.get(url);
    if let Some(key) = api_key {
        request.bearer_auth(key)
    } else {
        request
    }
}

fn models_endpoint_ready(
    client: &reqwest::blocking::Client,
    models_url: &str,
    api_key: Option<&str>,
) -> bool {
    match server_request(client, models_url, api_key).send() {
        Ok(resp) if resp.status().is_success() => match resp.json::<serde_json::Value>() {
            Ok(json) => json
                .get("data")
                .and_then(|data| data.as_array())
                .is_some_and(|models| {
                    models.iter().any(|model| {
                        model
                            .get("id")
                            .and_then(|id| id.as_str())
                            .is_some_and(|id| !id.trim().is_empty())
                    })
                }),
            Err(error) => {
                eprintln!("[server] /v1/models JSON parse failed: {}", error);
                false
            }
        },
        Ok(resp) => {
            eprintln!("[server] /v1/models not ready ({})", resp.status());
            false
        }
        Err(_) => false,
    }
}

fn compatible_cpu_config(config: &ServerConfig) -> ServerConfig {
    let mut fallback = config.clone();
    fallback.no_cuda = true;
    fallback.ngl = 0;
    fallback.device = Some("none".to_string());
    fallback.main_gpu = None;
    fallback.n_ctx = fallback.n_ctx.min(4096);
    fallback.batch_size = fallback.batch_size.min(128);
    fallback.flash_attn = false;
    fallback.kv_offload = false;
    fallback.mlock = false;
    fallback.ncmoe = 0;
    fallback
}

fn should_retry_with_cpu(error: &ServerError, config: &ServerConfig) -> bool {
    config.retry_cpu_fallback
        && !config.no_cuda
        && matches!(error.error_type.as_str(), "warmup" | "cuda" | "oom")
}

fn spawn_server_process(exe: &str, config: &ServerConfig) -> Result<Receiver<String>> {
    let effective_ngl = config.ngl;
    let host = bind_host(config);
    let selected_device = if config.no_cuda {
        "none".to_string()
    } else {
        config
            .device
            .as_deref()
            .map(str::trim)
            .filter(|device| !device.is_empty())
            .unwrap_or("CUDA0")
            .to_string()
    };
    let selected_main_gpu = if config.no_cuda {
        None
    } else {
        config.main_gpu.or(Some(0))
    };
    eprintln!(
        "[server] spawning with ngl={}, n_ctx={}, batch={}, host={}, port={}, device={}, main_gpu={:?}, no_cuda={}",
        effective_ngl,
        config.n_ctx,
        config.batch_size,
        host,
        config.port,
        selected_device,
        selected_main_gpu,
        config.no_cuda
    );

    let mut cmd = Command::new(exe);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    cmd.arg("-m")
        .arg(&config.model_path)
        .arg("--port")
        .arg(config.port.to_string())
        .arg("--host")
        .arg(&host)
        .arg("-ngl")
        .arg(effective_ngl.to_string())
        .arg("-c")
        .arg(config.n_ctx.to_string())
        .arg("-b")
        .arg(config.batch_size.to_string());

    if config.ubatch_size > 0 {
        cmd.arg("-ub").arg(config.ubatch_size.to_string());
    }
    if config.threads > 0 {
        cmd.arg("-t").arg(config.threads.to_string());
    }
    if config.parallel > 0 {
        cmd.arg("-np").arg(config.parallel.to_string());
    }

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    cmd.arg("--flash-attn")
        .arg(if config.flash_attn { "on" } else { "off" });
    if !config.kv_offload {
        cmd.arg("--no-kv-offload");
    }
    cmd.arg(if config.kv_unified {
        "--kv-unified"
    } else {
        "--no-kv-unified"
    });
    cmd.arg(if config.mmap { "--mmap" } else { "--no-mmap" });
    if config.mlock {
        cmd.arg("--mlock");
    }
    if config.no_cuda {
        cmd.arg("--device").arg("none");
        cmd.arg("--no-op-offload");
    } else {
        cmd.arg("--device").arg(&selected_device);
        if let Some(main_gpu) = selected_main_gpu {
            cmd.arg("--main-gpu").arg(main_gpu.to_string());
        }
    }
    if config.ncmoe > 0 {
        cmd.arg("-ncmoe").arg(config.ncmoe.to_string());
    }
    if let Some(ref tools) = config.tools {
        if !tools.is_empty() {
            cmd.arg("--tools").arg(tools);
        }
    }
    if let Some(api_key) = config
        .api_key
        .as_ref()
        .map(|key| key.trim())
        .filter(|key| !key.is_empty())
    {
        cmd.arg("--api-key").arg(api_key);
    }
    if config.cache_type_k_enabled && !config.cache_type_k.trim().is_empty() {
        cmd.arg("-ctk").arg(&config.cache_type_k);
    }
    if config.cache_type_v_enabled && !config.cache_type_v.trim().is_empty() {
        cmd.arg("-ctv").arg(&config.cache_type_v);
    }
    if let Some(value) = config.rope_freq_base {
        if value > 0.0 {
            cmd.arg("--rope-freq-base").arg(value.to_string());
        }
    }
    if let Some(value) = config.rope_freq_scale {
        if value > 0.0 {
            cmd.arg("--rope-freq-scale").arg(value.to_string());
        }
    }
    if let Some(seed) = config.seed {
        cmd.arg("-s").arg(seed.to_string());
    }
    if let Some(template) = config
        .chat_template
        .as_ref()
        .map(|template| template.trim())
        .filter(|template| !template.is_empty())
    {
        cmd.arg("--chat-template").arg(template);
    }
    if let Some(mmproj_path) = config
        .mmproj_path
        .as_ref()
        .map(|path| path.trim())
        .filter(|path| !path.is_empty())
    {
        cmd.arg("--mmproj").arg(mmproj_path);
        cmd.arg("--mmproj-offload");
    }
    if let Some(mtp_draft_path) = config
        .mtp_draft_path
        .as_ref()
        .map(|path| path.trim())
        .filter(|path| !path.is_empty())
    {
        cmd.arg("-md").arg(mtp_draft_path);
        let spec_type = config
            .spec_type
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("draft-mtp");
        cmd.arg("--spec-type").arg(spec_type);
        if !config.no_cuda {
            cmd.arg("--spec-draft-device").arg(&selected_device);
            cmd.arg("-ngld").arg(effective_ngl.to_string());
        }
    }

    let command_line = build_redacted_command_line(exe, &cmd);
    eprintln!("[server] spawn: {}", command_line);
    add_log(&format!("[server] spawn: {}", command_line));

    let mut child = cmd.spawn()?;
    eprintln!("[server] child pid = {:?}", child.id());

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    {
        let mut guard = CHILD_PROCESS.lock().unwrap();
        *guard = Some(child);
    }

    let (tx, rx) = mpsc::channel::<String>();

    if let Some(out) = stdout {
        let tx_out = tx.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if tx_out.send(line).is_err() {
                    break;
                }
            }
        });
    }

    if let Some(err) = stderr {
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
    }

    Ok(rx)
}

fn monitor_server(
    config: &ServerConfig,
    rx: Receiver<String>,
    on_progress: &Arc<dyn Fn(ServerProgress) + Send + Sync>,
    on_ready: &Arc<dyn Fn() + Send + Sync>,
) -> MonitorResult {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .ok();
    let health_url = format!(
        "http://{}:{}/health",
        health_check_host(config),
        config.port
    );
    let models_url = format!(
        "http://{}:{}/v1/models",
        health_check_host(config),
        config.port
    );
    let api_key = config
        .api_key
        .as_ref()
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty());
    let deadline = Instant::now() + Duration::from_secs(600);
    let mut last_health_check = Instant::now() - Duration::from_secs(1);
    let mut max_progress = 0u32;

    loop {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(line) => {
                add_log(&line);
                let p = parse_progress(&line);
                if p > max_progress {
                    max_progress = p;
                }
                on_progress(ServerProgress {
                    progress: max_progress,
                    stage: stage_name(max_progress),
                    log: line.clone(),
                });

                if line.contains("server is listening") {
                    max_progress = max_progress.max(96);
                    on_progress(ServerProgress {
                        progress: max_progress,
                        stage: "正在确认模型 API...".into(),
                        log: line.clone(),
                    });
                }

                if let Some(err) = detect_error(&line) {
                    return MonitorResult::Error(err);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return MonitorResult::Exited,
        }

        if last_health_check.elapsed() >= Duration::from_millis(500) {
            last_health_check = Instant::now();
            if let Some(client) = &client {
                if let Ok(resp) = server_request(client, &health_url, api_key.as_deref()).send() {
                    if resp.status().is_success() {
                        if models_endpoint_ready(client, &models_url, api_key.as_deref()) {
                            eprintln!(
                                "[server] model API ready via /health and /v1/models ({})",
                                resp.status()
                            );
                            on_ready();
                            return MonitorResult::Ready;
                        }
                        max_progress = max_progress.max(98);
                        on_progress(ServerProgress {
                            progress: max_progress,
                            stage: "正在等待模型 API...".into(),
                            log: "[server] /health ok; waiting for /v1/models".into(),
                        });
                    }
                }
            }
        }

        if Instant::now() >= deadline {
            eprintln!("[server] health-check timed out after 600s");
            return MonitorResult::TimedOut;
        }

        if !is_server_running() {
            return MonitorResult::Exited;
        }
    }
}

fn exited_error() -> ServerError {
    ServerError {
        error_type: "unknown".into(),
        title: "启动失败".into(),
        details: "llama-server 进程在监听端口前异常退出。".into(),
        suggestions: vec![
            "检查模型文件路径是否正确，确认 GGUF 文件没有损坏".into(),
            "降低 GPU 卸载层数、上下文长度和 batch 后重试".into(),
            "如果仍然失败，请查看加载日志中的 [server] spawn 命令和最后几行错误".into(),
        ],
    }
}

pub fn start_server<F: Fn(ServerProgress) + Send + Sync + 'static>(
    config: &ServerConfig,
    on_progress: F,
    on_ready: impl Fn() + Send + Sync + 'static,
    on_error: impl Fn(ServerError) + Send + Sync + 'static,
) -> Result<()> {
    eprintln!(
        "[server] start_server called with: ngl={}, n_ctx={}, host={}, port={}",
        config.ngl,
        config.n_ctx,
        bind_host(config),
        config.port
    );

    stop_server().ok();

    let exe = resolve_exe_path(&config.executable_path);
    eprintln!("[server] resolved exe path: {}", exe);
    if !Path::new(&exe).exists() {
        return Err(anyhow::anyhow!(
            "找不到 llama-server.exe（搜索路径：{}）。请在设置中指定正确路径，或将它放入 resources 目录。",
            exe
        ));
    }

    stop_stale_servers_for_exe(&exe);
    clear_logs();

    if !wait_for_port_release(config, Duration::from_secs(2)) {
        return Err(anyhow::anyhow!(
            "端口 {} 已被其它服务占用，请先关闭旧的 llama-server 或在设置中换一个端口。",
            config.port
        ));
    }

    let initial_config = config.clone();
    let on_progress: Arc<dyn Fn(ServerProgress) + Send + Sync> = Arc::new(on_progress);
    let on_ready: Arc<dyn Fn() + Send + Sync> = Arc::new(on_ready);
    let on_error: Arc<dyn Fn(ServerError) + Send + Sync> = Arc::new(on_error);
    let fired = Arc::new(AtomicBool::new(false));

    std::thread::spawn(move || {
        let mut current_config = initial_config;
        let mut did_cpu_retry = false;

        loop {
            on_progress(ServerProgress {
                progress: 1,
                stage: if current_config.no_cuda {
                    "GPU 启动失败，正在使用 CPU 兼容模式重试...".into()
                } else {
                    "正在启动推理服务...".into()
                },
                log: if current_config.no_cuda {
                    "[server] retry with CPU compatibility mode".into()
                } else {
                    "[server] starting llama-server".into()
                },
            });

            let rx = match spawn_server_process(&exe, &current_config) {
                Ok(rx) => rx,
                Err(e) => {
                    if !fired.swap(true, Ordering::SeqCst) {
                        on_error(ServerError {
                            error_type: "spawn".into(),
                            title: "启动失败".into(),
                            details: e.to_string(),
                            suggestions: vec![
                                "检查 llama-server.exe 路径是否正确".into(),
                                "确认 resources 目录中的 llama.cpp 运行文件完整".into(),
                            ],
                        });
                    }
                    return;
                }
            };

            match monitor_server(&current_config, rx, &on_progress, &on_ready) {
                MonitorResult::Ready => {
                    fired.store(true, Ordering::SeqCst);
                    return;
                }
                MonitorResult::Error(err)
                    if should_retry_with_cpu(&err, &current_config) && !did_cpu_retry =>
                {
                    eprintln!(
                        "[server] launch failed with {}, retrying in CPU compatibility mode",
                        err.error_type
                    );
                    add_log(&format!(
                        "[server] {}，自动切换到 CPU 兼容模式重试",
                        err.title
                    ));
                    stop_server().ok();
                    current_config = compatible_cpu_config(&current_config);
                    did_cpu_retry = true;
                    continue;
                }
                MonitorResult::Error(err) => {
                    if !fired.swap(true, Ordering::SeqCst) {
                        on_error(err);
                    }
                    return;
                }
                MonitorResult::Exited => {
                    if !fired.swap(true, Ordering::SeqCst) {
                        on_error(exited_error());
                    }
                    return;
                }
                MonitorResult::TimedOut => {
                    if !fired.swap(true, Ordering::SeqCst) {
                        on_error(ServerError {
                            error_type: "timeout".into(),
                            title: "启动超时".into(),
                            details: "llama-server 启动超过 10 分钟仍未就绪。".into(),
                            suggestions: vec![
                                "换用更小的上下文长度后重试".into(),
                                "确认模型体积和当前内存、显存容量匹配".into(),
                            ],
                        });
                    }
                    return;
                }
            }
        }
    });

    Ok(())
}

pub fn stop_server() -> Result<()> {
    let mut guard = CHILD_PROCESS.lock().unwrap();
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

pub fn is_server_running() -> bool {
    let mut guard = CHILD_PROCESS.lock().unwrap();
    guard
        .as_mut()
        .is_some_and(|c| matches!(c.try_wait(), Ok(None)))
}

pub fn add_log(line: &str) {
    if let Ok(mut logs) = SERVER_LOGS.lock() {
        logs.push(line.to_string());
        if logs.len() > 2000 {
            logs.drain(0..1000);
        }
    }
}

pub fn get_logs() -> Vec<String> {
    SERVER_LOGS
        .lock()
        .map(|logs| logs.clone())
        .unwrap_or_default()
}

pub fn clear_logs() {
    if let Ok(mut logs) = SERVER_LOGS.lock() {
        logs.clear();
    }
}
