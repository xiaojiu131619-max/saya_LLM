use std::collections::{HashSet, VecDeque};
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::models::benchmark::*;
use crate::models::server_config::ServerConfig;
use crate::services::process_manager::{self, ServerError};

pub const VRAM_LIMIT: f64 = 0.90;
pub const POINT_BUDGET: usize = 32;

/// 一个集中注册表协调调参、普通加载/停止、测速与内核更新。
/// Guard 不持有 Mutex，能够跨 await；只有匹配的所有者能释放槽位。
#[derive(Default)]
struct TaskRegistry {
    generation: u64,
    owner: Option<u64>,
    status: Option<AutoTuneStatus>,
    cancel: Option<Arc<AtomicBool>>,
}
static TASKS: Lazy<Mutex<TaskRegistry>> = Lazy::new(|| Mutex::new(TaskRegistry::default()));

pub struct LifecycleGuard(u64);
impl Drop for LifecycleGuard {
    fn drop(&mut self) {
        if let Ok(mut tasks) = TASKS.lock() {
            if tasks.owner == Some(self.0) {
                tasks.owner = None;
                tasks.cancel = None;
            }
        }
    }
}

pub fn acquire_lifecycle() -> Result<LifecycleGuard, String> {
    let mut tasks = TASKS.lock().map_err(|_| "生命周期注册表不可用")?;
    if tasks.owner.is_some() {
        return Err("正在加载、测速、自动调参或更新核心，请等待当前任务结束".into());
    }
    tasks.generation += 1;
    tasks.owner = Some(tasks.generation);
    Ok(LifecycleGuard(tasks.generation))
}

pub fn register_tune(config: &AutoTuneConfig) -> Result<(LifecycleGuard, Arc<AtomicBool>), String> {
    validate_config(config)?;
    let guard = acquire_lifecycle()?;
    if process_manager::is_server_running() {
        return Err("请先正常停止当前模型，再开始自动调参；不会自动停止用户的模型".into());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    let mut tasks = TASKS.lock().map_err(|_| "生命周期注册表不可用")?;
    if tasks
        .status
        .as_ref()
        .is_some_and(|s| s.run_id == config.run_id)
    {
        return Err("run_id 已使用，请为新任务生成独立 run_id".into());
    }
    tasks.cancel = Some(cancel.clone());
    tasks.status = Some(AutoTuneStatus {
        run_id: config.run_id.clone(),
        model_id: config.model_id.clone(),
        status: "running".into(),
        result: None,
        error: None,
        records: vec![],
        failures: vec![],
    });
    Ok((guard, cancel))
}

pub fn request_cancel(run_id: &str) -> Result<(), String> {
    let mut tasks = TASKS.lock().map_err(|_| "生命周期注册表不可用")?;
    let active = tasks
        .status
        .as_ref()
        .is_some_and(|s| s.run_id == run_id && matches!(s.status.as_str(), "running" | "stopping"));
    if active {
        if let Some(cancel) = &tasks.cancel {
            cancel.store(true, Ordering::SeqCst);
        }
        if let Some(status) = tasks.status.as_mut() {
            status.status = "stopping".into();
        }
        Ok(())
    } else {
        Err("该 run_id 没有正在运行的自动调参任务".into())
    }
}

pub fn tune_status() -> Option<AutoTuneStatus> {
    TASKS.lock().ok()?.status.clone()
}

pub fn update_tune_records(run_id: &str, records: &[TuneRecord], failures: &[TuneFailure]) {
    if let Ok(mut tasks) = TASKS.lock() {
        if let Some(status) = tasks.status.as_mut().filter(|s| s.run_id == run_id) {
            status.records = records.to_vec();
            status.failures = failures.to_vec();
        }
    }
}

/// 调用方必须已经完成所有子进程清理；终态、取消优先级、释放任务槽位在同一锁内提交。
pub fn finish_tune(guard: LifecycleGuard, mut status: AutoTuneStatus) -> AutoTuneStatus {
    if let Ok(mut tasks) = TASKS.lock() {
        if tasks.owner == Some(guard.0) {
            if tasks
                .cancel
                .as_ref()
                .is_some_and(|c| c.load(Ordering::SeqCst))
            {
                status.status = "cancelled".into();
                status.result = None;
                status.error = None;
            }
            tasks.status = Some(status.clone());
            tasks.owner = None;
            tasks.cancel = None;
        }
    }
    status
}

pub fn validate_config(config: &AutoTuneConfig) -> Result<(), String> {
    if config.run_id.trim().is_empty() || config.model_id.trim().is_empty() {
        return Err("run_id 和 model_id 不能为空".into());
    }
    if config.baseline.n_ctx == 0
        || config.max_ctx == 0
        || u64::from(config.baseline.n_ctx) > config.max_ctx
    {
        return Err("当前上下文必须大于 0 且不超过模型 max_ctx".into());
    }
    if config.baseline.port == 0 {
        return Err("测量端口不能为 0".into());
    }
    if config.is_moe && (config.block_count == 0 || config.baseline.ncmoe > config.block_count) {
        return Err("MoE 的 CPU 专家层数不能超过重复层数（block_count）".into());
    }
    if config.baseline.embedding || config.baseline.rerank {
        return Err("自动调参仅支持生成模型，不支持向量或重排模型".into());
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Candidate {
    pub ngl: u32,
    pub ncmoe: u32,
    pub ctx: u32,
    pub cache_type_k: String,
    pub cache_type_v: String,
    pub cache_type_k_enabled: bool,
    pub cache_type_v_enabled: bool,
}
impl Candidate {
    pub fn baseline(config: &AutoTuneConfig) -> Self {
        let b = &config.baseline;
        Self {
            ngl: b.ngl,
            ncmoe: b.ncmoe,
            ctx: b.n_ctx,
            cache_type_k: b.cache_type_k.clone(),
            cache_type_v: b.cache_type_v.clone(),
            cache_type_k_enabled: b.cache_type_k_enabled,
            cache_type_v_enabled: b.cache_type_v_enabled,
        }
    }
    pub fn from_record(record: &TuneRecord) -> Self {
        Self {
            ngl: record.ngl,
            ncmoe: record.ncmoe,
            ctx: record.ctx,
            cache_type_k: record.cache_type_k.clone(),
            cache_type_v: record.cache_type_v.clone(),
            cache_type_k_enabled: record.cache_type_k_enabled,
            cache_type_v_enabled: record.cache_type_v_enabled,
        }
    }
    fn quantized(mut self, kv: &str) -> Self {
        self.cache_type_k = kv.into();
        self.cache_type_v = kv.into();
        self.cache_type_k_enabled = true;
        self.cache_type_v_enabled = true;
        self
    }
}

pub fn build_server_config(base: &AutoTuneConfig, point: &Candidate) -> ServerConfig {
    let mut config = base.baseline.clone();
    config.ngl = point.ngl;
    config.ncmoe = point.ncmoe;
    config.n_ctx = point.ctx;
    config.cache_type_k = point.cache_type_k.clone();
    config.cache_type_v = point.cache_type_v.clone();
    config.cache_type_k_enabled = point.cache_type_k_enabled;
    config.cache_type_v_enabled = point.cache_type_v_enabled;
    // 唯一明确的本地测量策略；不改 ubatch、parallel、sidecars、RoPE 或 CPU 语义。
    config.host = "127.0.0.1".into();
    config.api_key = None;
    config.retry_cpu_fallback = false;
    if point.ngl == 0 {
        config.device = Some("none".into());
        config.main_gpu = None;
        config.no_cuda = true;
        config.kv_offload = false;
    }
    config
}

impl TuneFailure {
    fn new(kind: FailureKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            server_error: None,
            candidate: None,
        }
    }
    pub fn cancelled() -> Self {
        Self::new(FailureKind::Cancelled, "自动调参已停止")
    }
    pub fn fatal(message: impl Into<String>) -> Self {
        Self::new(FailureKind::Fatal, message)
    }
}

/// 只用明确的内存证据判 OOM；CUDA/DLL/端口/模型格式等错误不能参与内存搜索。
pub fn classify_server_error(error: ServerError) -> TuneFailure {
    let text = error.details.to_lowercase();
    let oom = [
        "out of memory",
        "out of vram",
        "cuda oom",
        "cudamalloc failed",
        "cannot allocate memory",
        "not enough memory",
        "vk_error_out_of_device_memory",
        "cuda_error_out_of_memory",
        "cudaerroroutofmemory",
    ]
    .iter()
    .any(|s| text.contains(s));
    let candidate_option = [
        "cache-type",
        "cache_type",
        "cache type",
        "kv cache",
        "flash attention",
        "flash_attn",
        "flash-attn",
        "ncmoe",
    ]
    .iter()
    .any(|s| text.contains(s));
    let unsupported = [
        "not supported",
        "unsupported",
        "invalid",
        "not implemented",
        "requires",
        "unknown argument",
        "unrecognized",
    ]
    .iter()
    .any(|s| text.contains(s));
    let kind = if oom {
        FailureKind::Oom
    } else if candidate_option
        && unsupported
        && !matches!(error.error_type.as_str(), "port" | "model" | "quant")
    {
        FailureKind::Unsupported
    } else {
        FailureKind::Fatal
    };
    let message = format!("{}：{}", error.title, error.details);
    TuneFailure {
        kind,
        message,
        server_error: serde_json::to_value(error).ok(),
        candidate: None,
    }
}

type Errors = Arc<Mutex<VecDeque<ServerError>>>;
fn check(cancel: &AtomicBool, errors: Option<&Errors>) -> Result<(), TuneFailure> {
    if cancel.load(Ordering::SeqCst) {
        return Err(TuneFailure::cancelled());
    }
    if let Some(errors) = errors {
        if let Some(error) = errors
            .lock()
            .map_err(|_| TuneFailure::fatal("错误回调队列不可用"))?
            .pop_front()
        {
            return Err(classify_server_error(error));
        }
    }
    Ok(())
}

async fn interruptible<F: Future>(
    future: F,
    cancel: &AtomicBool,
    errors: Option<&Errors>,
) -> Result<F::Output, TuneFailure> {
    let mut future = Box::pin(future);
    loop {
        check(cancel, errors)?;
        if let Ok(output) = tokio::time::timeout(Duration::from_millis(40), future.as_mut()).await {
            check(cancel, errors)?;
            return Ok(output);
        }
    }
}

#[derive(Default)]
struct StreamMeasurement {
    pending: Vec<u8>,
    first_ms: Option<f64>,
    timings: Option<serde_json::Value>,
    stopped: bool,
}
impl StreamMeasurement {
    fn feed(&mut self, bytes: &[u8], elapsed_ms: f64) -> Result<(), TuneFailure> {
        self.pending.extend_from_slice(bytes);
        if self.pending.len() > 4 * 1024 * 1024 {
            return Err(TuneFailure::fatal("流式响应行过长"));
        }
        while let Some(pos) = self.pending.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=pos).collect();
            let line = std::str::from_utf8(&line)
                .map_err(|_| TuneFailure::fatal("流式响应不是有效 UTF-8"))?
                .trim();
            let Some(data) = line.strip_prefix("data:").map(str::trim) else {
                continue;
            };
            if data == "[DONE]" {
                continue;
            }
            let value: serde_json::Value = serde_json::from_str(data)
                .map_err(|e| TuneFailure::fatal(format!("流式响应解析失败：{e}")))?;
            if !value["error"].is_null() {
                return Err(classify_server_error(ServerError {
                    error_type: "http".into(),
                    title: "测量请求失败".into(),
                    details: value["error"].to_string(),
                    suggestions: vec![],
                }));
            }
            if value["content"].as_str().is_some_and(|s| !s.is_empty()) && self.first_ms.is_none() {
                self.first_ms = Some(elapsed_ms);
            }
            if value["stop"].as_bool() == Some(true) {
                self.stopped = true;
            }
            if value["timings"].is_object() {
                self.timings = Some(value["timings"].clone());
            }
        }
        Ok(())
    }
    fn finish(self, iteration: u32, total_ms: f64) -> Result<BenchmarkIteration, TuneFailure> {
        let timings = self
            .timings
            .ok_or_else(|| TuneFailure::fatal("流式响应缺少 timings"))?;
        let generated = timings["predicted_n"]
            .as_u64()
            .filter(|n| *n > 0 && *n <= u32::MAX as u64)
            .ok_or_else(|| TuneFailure::fatal("测量未生成有效 token"))?
            as u32;
        let ts = timings["predicted_per_second"]
            .as_f64()
            .filter(|v| v.is_finite() && *v > 0.0)
            .ok_or_else(|| TuneFailure::fatal("测量吞吐无效"))?;
        let ttft = self
            .first_ms
            .ok_or_else(|| TuneFailure::fatal("测量没有收到首个非空生成内容"))?;
        if !self.stopped {
            return Err(TuneFailure::fatal("流式响应异常截断"));
        }
        Ok(BenchmarkIteration {
            iteration,
            prompt_tokens: timings["prompt_n"]
                .as_u64()
                .unwrap_or(0)
                .min(u32::MAX as u64) as u32,
            prompt_per_second: timings["prompt_per_second"]
                .as_f64()
                .filter(|v| v.is_finite())
                .unwrap_or(0.0),
            generated_tokens: generated,
            tokens_per_second: ts,
            time_to_first_token_ms: ttft,
            total_time_ms: total_ms,
        })
    }
}

async fn stream_benchmark(
    port: u16,
    prompt_tokens: u32,
    max_tokens: u32,
    iteration: u32,
    cache_prompt: bool,
    cancel: &AtomicBool,
    errors: Option<&Errors>,
) -> Result<BenchmarkIteration, TuneFailure> {
    if max_tokens == 0 || prompt_tokens == 0 {
        return Err(TuneFailure::fatal("提示和生成 token 数必须大于 0"));
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| TuneFailure::fatal(e.to_string()))?;
    let start = Instant::now();
    let response = interruptible(
        client
            .post(format!("http://127.0.0.1:{port}/completion"))
            .json(
                &json!({"prompt": "the ".repeat(prompt_tokens as usize), "n_predict": max_tokens,
            "temperature": 0.0, "stream": true, "cache_prompt": cache_prompt, "ignore_eos": true}),
            )
            .send(),
        cancel,
        errors,
    )
    .await?;
    let mut response = response.map_err(|e| TuneFailure::fatal(format!("测量请求失败：{e}")))?;
    if !response.status().is_success() {
        let status = response.status();
        let text = interruptible(response.text(), cancel, errors)
            .await?
            .unwrap_or_default();
        return Err(classify_server_error(ServerError {
            error_type: "http".into(),
            title: format!("HTTP {status}"),
            details: text,
            suggestions: vec![],
        }));
    }
    let mut stream = StreamMeasurement::default();
    loop {
        let chunk = interruptible(response.chunk(), cancel, errors)
            .await?
            .map_err(|e| TuneFailure::fatal(format!("读取流式响应失败：{e}")))?;
        let Some(chunk) = chunk else {
            break;
        };
        stream.feed(&chunk, start.elapsed().as_secs_f64() * 1000.0)?;
    }
    if !stream.pending.is_empty() {
        stream.feed(b"\n", start.elapsed().as_secs_f64() * 1000.0)?;
    }
    check(cancel, errors)?;
    stream.finish(iteration, start.elapsed().as_secs_f64() * 1000.0)
}

pub async fn run_single_benchmark(
    port: u16,
    prompt_tokens: u32,
    max_tokens: u32,
    iteration: u32,
) -> anyhow::Result<BenchmarkIteration> {
    stream_benchmark(
        port,
        prompt_tokens,
        max_tokens,
        iteration,
        true,
        &AtomicBool::new(false),
        None,
    )
    .await
    .map_err(|e| anyhow::anyhow!(e.message))
}

/// 每点独立线程取消开关；Drop 顺序为请求停止→等待启动/监控线程→回收 owned child。
/// 先等待线程，避免后台晚到的 spawn 在清理后重新创建进程。
struct OwnedServer {
    cancel: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl Drop for OwnedServer {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        let _ = process_manager::stop_server();
    }
}

pub fn read_vram(
    gpu_monitor: &Mutex<Option<crate::services::gpu_monitor::GpuMonitor>>,
) -> Option<(f64, f64)> {
    let mut guard = gpu_monitor.lock().ok()?;
    let gpu = guard.as_mut()?;
    let used = gpu.get_vram_used().ok()?;
    let total = gpu.get_vram_total().ok()?;
    if used.is_finite() && total.is_finite() && used >= 0.0 && total > 0.0 {
        Some((used, total))
    } else {
        None
    }
}

pub fn statistics(values: &[f64]) -> (f64, f64) {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let n = sorted.len();
    if n == 0 {
        return (0.0, 0.0);
    }
    let median = if n % 2 == 0 {
        (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0
    } else {
        sorted[n / 2]
    };
    let mean = sorted.iter().sum::<f64>() / n as f64;
    let stddev = (sorted.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / n as f64).sqrt();
    (median, stddev)
}

pub async fn measure_point(
    config: &AutoTuneConfig,
    gm: &Mutex<Option<crate::services::gpu_monitor::GpuMonitor>>,
    point: &Candidate,
    cancel: &AtomicBool,
    refined: bool,
) -> Result<TuneRecord, TuneFailure> {
    check(cancel, None)?;
    let server = build_server_config(config, point);
    // 不通过 stop_server 抢占既有模型，也不通过端口清扫杀任何外部进程。
    if process_manager::is_server_running() {
        return Err(TuneFailure::fatal("测量前发现非本任务的模型仍在运行"));
    }
    let listener = std::net::TcpListener::bind(("127.0.0.1", server.port))
        .map_err(|e| TuneFailure::fatal(format!("测量端口 {} 不可用：{e}", server.port)))?;
    drop(listener);
    let ready = Arc::new(AtomicBool::new(false));
    let ready2 = ready.clone();
    let errors: Errors = Arc::new(Mutex::new(VecDeque::new()));
    let errors2 = errors.clone();
    let point_cancel = Arc::new(AtomicBool::new(false));
    let worker = process_manager::start_tuning_server(
        &server,
        point_cancel.clone(),
        move || {
            ready2.store(true, Ordering::SeqCst);
        },
        move |e| {
            if let Ok(mut queue) = errors2.lock() {
                queue.push_back(e);
            }
        },
    )
    .map_err(|e| TuneFailure::fatal(format!("启动测量服务失败：{e}")))?;
    let _owned = OwnedServer {
        cancel: point_cancel,
        worker: Some(worker),
    };
    let deadline = Instant::now() + Duration::from_secs(180);
    while !ready.load(Ordering::SeqCst) {
        check(cancel, Some(&errors))?;
        if Instant::now() >= deadline {
            return Err(TuneFailure::fatal("测量服务启动超时"));
        }
        interruptible(
            tokio::time::sleep(Duration::from_millis(50)),
            cancel,
            Some(&errors),
        )
        .await?;
    }
    let prompt = 64.min((point.ctx / 4).max(1));
    let tokens = 64.min((point.ctx / 4).max(1));
    // 冷提示不复用前缀；第二次作为预热不计入热测量中位数。
    let cold =
        stream_benchmark(server.port, prompt, tokens, 0, false, cancel, Some(&errors)).await?;
    let warmup =
        stream_benchmark(server.port, prompt, tokens, 0, true, cancel, Some(&errors)).await?;
    let mut samples = Vec::new();
    let mut vram = read_vram(gm);
    for i in 1..=if refined { 5 } else { 2 } {
        check(cancel, Some(&errors))?;
        samples.push(
            stream_benchmark(server.port, prompt, tokens, i, true, cancel, Some(&errors)).await?,
        );
        if let Some((used, total)) = read_vram(gm) {
            vram = Some((vram.map(|v| v.0).unwrap_or(0.0).max(used), total));
        }
    }
    check(cancel, Some(&errors))?;
    let (ts, ts_stddev) = statistics(
        &samples
            .iter()
            .map(|s| s.tokens_per_second)
            .collect::<Vec<_>>(),
    );
    let (ttft, ttft_stddev) = statistics(
        &samples
            .iter()
            .map(|s| s.time_to_first_token_ms)
            .collect::<Vec<_>>(),
    );
    if point.ngl > 0 && vram.is_none() {
        return Err(TuneFailure::fatal(
            "GPU 候选缺少有效显存遥测，无法验证 90% 预算；请检查 GPU 监控后重试",
        ));
    }
    let (used, total) = vram.unwrap_or((0.0, 0.0));
    let pct = if total > 0.0 { used / total } else { 0.0 };
    let kv = if point.cache_type_k == point.cache_type_v
        && point.cache_type_k_enabled == point.cache_type_v_enabled
    {
        if point.cache_type_k_enabled {
            point.cache_type_k.clone()
        } else {
            "默认".into()
        }
    } else {
        format!("K={}/V={}", point.cache_type_k, point.cache_type_v)
    };
    Ok(TuneRecord {
        model_type: if config.is_moe { "moe" } else { "dense" }.into(),
        ngl: point.ngl,
        ncmoe: point.ncmoe,
        ctx: point.ctx,
        kv,
        vram_used_gb: used,
        vram_total_gb: total,
        vram_percent: pct,
        // CPU ngl=0 不受其他程序的 GPU 占用限制。无遥测时仅代表短测量成功，非最大 ctx 保证。
        fits: point.ngl == 0 || vram.is_none() || pct <= VRAM_LIMIT,
        ts,
        first_token_ms: ttft,
        cache_type_k: point.cache_type_k.clone(),
        cache_type_v: point.cache_type_v.clone(),
        cache_type_k_enabled: point.cache_type_k_enabled,
        cache_type_v_enabled: point.cache_type_v_enabled,
        samples: samples.len() as u32,
        ts_stddev,
        ttft_stddev_ms: ttft_stddev,
        cold_ttft_ms: cold.time_to_first_token_ms,
        warmup_ttft_ms: warmup.time_to_first_token_ms,
        measurement_phase: if refined { "refined_hot" } else { "coarse_hot" }.into(),
        vram_available: vram.is_some(),
    })
}

/// 可用假测量器驱动的有界搜索状态机。失败不伪装成测速记录。
pub struct Search {
    config: AutoTuneConfig,
    queue: VecDeque<Candidate>,
    seen: HashSet<Candidate>,
    found: bool,
    attempts: usize,
    outcomes: Vec<(Candidate, bool)>,
    supported_kv: Candidate,
}
impl Search {
    pub fn new(config: &AutoTuneConfig) -> Self {
        let baseline = Candidate::baseline(config);
        let mut queue = VecDeque::from([baseline.clone()]);
        let mut point = baseline;
        let floor = point.ctx.min(256);
        // 最多 6 个 ctx 降档，预留 KV/MoE/ngl（含 0）与边界微调预算。
        for i in 0..6 {
            if point.ctx <= floor {
                break;
            }
            point.ctx = if i == 5 {
                floor
            } else {
                (point.ctx / 2).max(floor)
            };
            queue.push_back(point.clone());
        }
        for kv in ["q8_0", "q4_0"] {
            point = point.quantized(kv);
            queue.push_back(point.clone());
        }
        if config.is_moe {
            point.ncmoe = config.block_count;
            queue.push_back(point.clone());
        }
        let step = (point.ngl / 8 + u32::from(point.ngl % 8 != 0)).max(1);
        while point.ngl > 0 {
            point.ngl = point.ngl.saturating_sub(step);
            queue.push_back(point.clone());
        }
        Self {
            config: config.clone(),
            queue,
            seen: HashSet::new(),
            found: false,
            attempts: 0,
            outcomes: vec![],
            supported_kv: Candidate::baseline(config),
        }
    }
    pub fn next(&mut self) -> Option<Candidate> {
        while self.attempts < POINT_BUDGET {
            let point = self.queue.pop_front()?;
            if self.seen.insert(point.clone()) {
                self.attempts += 1;
                return Some(point);
            }
        }
        None
    }
    pub fn skip_unsupported(&mut self, point: &Candidate) {
        // q4 不支持时不能把该格式带进所有后续 ngl/CPU 候选，回到最近实际可执行的 KV。
        if point.cache_type_k == self.supported_kv.cache_type_k
            && point.cache_type_v == self.supported_kv.cache_type_v
            && point.cache_type_k_enabled == self.supported_kv.cache_type_k_enabled
            && point.cache_type_v_enabled == self.supported_kv.cache_type_v_enabled
        {
            return;
        }
        for next in &mut self.queue {
            if next.cache_type_k == point.cache_type_k
                && next.cache_type_v == point.cache_type_v
                && next.cache_type_k_enabled == point.cache_type_k_enabled
                && next.cache_type_v_enabled == point.cache_type_v_enabled
            {
                next.cache_type_k = self.supported_kv.cache_type_k.clone();
                next.cache_type_v = self.supported_kv.cache_type_v.clone();
                next.cache_type_k_enabled = self.supported_kv.cache_type_k_enabled;
                next.cache_type_v_enabled = self.supported_kv.cache_type_v_enabled;
            }
        }
    }
    pub fn observe(&mut self, point: &Candidate, fits: bool) {
        self.supported_kv = point.clone();
        self.outcomes.push((point.clone(), fits));
        if fits && !self.found {
            self.found = true;
            self.queue.clear();
        }
        // 只根据实际 OOM/超预算与成功的边界二分；不支持候选不会进入这里。
        for (other, other_fits) in self.outcomes.clone() {
            if other_fits == fits
                || other.ctx != point.ctx
                || other.cache_type_k != point.cache_type_k
                || other.cache_type_v != point.cache_type_v
                || other.cache_type_k_enabled != point.cache_type_k_enabled
                || other.cache_type_v_enabled != point.cache_type_v_enabled
            {
                continue;
            }
            let mut middle = point.clone();
            if other.ncmoe == point.ncmoe && other.ngl.abs_diff(point.ngl) > 1 {
                middle.ngl = other.ngl.min(point.ngl) + other.ngl.abs_diff(point.ngl) / 2;
                self.queue.push_front(middle);
            } else if other.ngl == point.ngl && other.ncmoe.abs_diff(point.ncmoe) > 1 {
                middle.ncmoe = other.ncmoe.min(point.ncmoe) + other.ncmoe.abs_diff(point.ncmoe) / 2;
                self.queue.push_front(middle);
            }
        }
        if !fits {
            return;
        }
        let max_ctx = self.config.max_ctx.min(u32::MAX as u64) as u32;
        if point.ctx < max_ctx {
            let mut next = point.clone();
            next.ctx = point.ctx.saturating_mul(2).min(max_ctx);
            self.queue.push_back(next);
        }
        if self.config.is_moe && point.ncmoe > 0 {
            let mut next = point.clone();
            next.ncmoe = point
                .ncmoe
                .saturating_sub((self.config.block_count / 4).max(1));
            self.queue.push_back(next);
        }
        // 降档成功后恢复少量 GPU 层，不能把量化 KV 重置回 f16。
        if point.ngl < self.config.baseline.ngl {
            let mut next = point.clone();
            next.ngl = point
                .ngl
                .saturating_add((self.config.baseline.ngl / 8).max(1))
                .min(self.config.baseline.ngl);
            self.queue.push_back(next);
        }
    }
}

pub fn rank_records(records: &mut [TuneRecord], mode: &SortMode) {
    records.sort_by(|a, b| match mode {
        SortMode::TsPriority => b.ts.total_cmp(&a.ts).then(b.ctx.cmp(&a.ctx)),
        SortMode::CtxPriority => b.ctx.cmp(&a.ctx).then(b.ts.total_cmp(&a.ts)),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> AutoTuneConfig {
        AutoTuneConfig {
            run_id: "test-run".into(),
            model_id: "test-model".into(),
            baseline: ServerConfig {
                ngl: 40,
                ncmoe: 0,
                ..ServerConfig::default()
            },
            block_count: 40,
            max_ctx: 131072,
            is_moe: false,
            sort_mode: SortMode::TsPriority,
        }
    }
    fn server_error(kind: &str, details: &str) -> ServerError {
        ServerError {
            error_type: kind.into(),
            title: "测试错误".into(),
            details: details.into(),
            suggestions: vec!["测试建议".into()],
        }
    }

    #[test]
    fn baseline_preserves_all_unsearched_fields_and_independent_kv() {
        let mut c = config();
        c.baseline.ubatch_size = 123;
        c.baseline.parallel = 3;
        c.baseline.kv_unified = false;
        c.baseline.rope_freq_base = Some(12345.0);
        c.baseline.rope_freq_scale = Some(2.0);
        c.baseline.mtp_draft_path = Some("draft.gguf".into());
        c.baseline.no_warmup = true;
        c.baseline.cache_type_k = "q8_0".into();
        c.baseline.cache_type_k_enabled = true;
        c.baseline.cache_type_v = "f16".into();
        c.baseline.cache_type_v_enabled = false;
        c.baseline.api_key = Some("secret".into());
        c.baseline.retry_cpu_fallback = true;
        let built = build_server_config(&c, &Candidate::baseline(&c));
        let mut expected = c.baseline.clone();
        expected.host = "127.0.0.1".into();
        expected.api_key = None;
        expected.retry_cpu_fallback = false;
        assert_eq!(
            serde_json::to_value(built).unwrap(),
            serde_json::to_value(expected).unwrap()
        );
    }

    #[test]
    fn zero_ngl_uses_explicit_normal_cpu_semantics() {
        let c = config();
        let mut point = Candidate::baseline(&c);
        point.ngl = 0;
        let cpu = build_server_config(&c, &point);
        assert!(cpu.no_cuda);
        assert!(!cpu.kv_offload);
        assert_eq!(cpu.main_gpu, None);
        assert_eq!(cpu.device.as_deref(), Some("none"));
        assert!(!build_server_config(&c, &Candidate::baseline(&c)).no_cuda);
    }

    #[test]
    fn error_classification_keeps_structured_error_and_only_real_oom_downgrades() {
        for (kind, text, expected) in [
            ("cuda", "CUDA out of memory", FailureKind::Oom),
            ("oom", "allocate model buffer failed", FailureKind::Fatal),
            (
                "spawn",
                "cache-type-v q4_0 not supported",
                FailureKind::Unsupported,
            ),
            (
                "unknown",
                "quantized KV cache requires flash attention",
                FailureKind::Unsupported,
            ),
            ("quant", "invalid ggml type 99", FailureKind::Fatal),
            ("port", "Address already in use", FailureKind::Fatal),
            ("cuda", "CUDA driver not supported", FailureKind::Fatal),
            ("model", "invalid model kv cache", FailureKind::Fatal),
        ] {
            let result = classify_server_error(server_error(kind, text));
            assert_eq!(result.kind, expected, "{text}");
            assert_eq!(result.server_error.unwrap()["error_type"], kind);
        }
    }

    #[test]
    fn first_point_oom_still_reaches_quantized_cpu_without_duplicates() {
        let mut c = config();
        c.is_moe = true;
        let mut search = Search::new(&c);
        let mut points = Vec::new();
        while let Some(point) = search.next() {
            search.observe(&point, false);
            points.push(point);
        }
        assert_eq!(points[0], Candidate::baseline(&c));
        assert!(points
            .iter()
            .any(|p| p.cache_type_k == "q8_0" && p.cache_type_v_enabled));
        let last = points.last().unwrap();
        assert_eq!(last.ngl, 0);
        assert_eq!(last.ncmoe, c.block_count);
        assert_eq!(last.cache_type_k, "q4_0");
        assert!(last.cache_type_v_enabled);
        assert_eq!(points.len(), points.iter().collect::<HashSet<_>>().len());
        assert!(points.len() <= POINT_BUDGET);
    }

    #[test]
    fn huge_context_budget_reserves_zero_ngl() {
        let mut c = config();
        c.baseline.n_ctx = u32::MAX;
        c.max_ctx = u64::MAX;
        c.baseline.ngl = u32::MAX;
        c.is_moe = true;
        let mut search = Search::new(&c);
        let mut reached_cpu = false;
        while let Some(point) = search.next() {
            reached_cpu |= point.ngl == 0;
            search.observe(&point, false);
        }
        assert!(reached_cpu);
    }

    #[test]
    fn tiny_layer_models_reach_zero_and_moe_uses_block_count() {
        let mut c = config();
        c.baseline.ngl = 3;
        c.block_count = 3;
        c.is_moe = true;
        let mut search = Search::new(&c);
        let mut all = Vec::new();
        while let Some(p) = search.next() {
            assert!(p.ncmoe <= 3);
            search.observe(&p, false);
            all.push(p);
        }
        assert!(all.iter().any(|p| p.ngl == 0 && p.ncmoe == 3));
    }

    #[test]
    fn fake_measurement_refines_gpu_layer_boundary() {
        let mut c = config();
        c.baseline.n_ctx = 256;
        c.max_ctx = 256;
        let mut search = Search::new(&c);
        let mut best = 0;
        while let Some(p) = search.next() {
            let fits = p.ngl <= 23;
            if fits {
                best = best.max(p.ngl);
            }
            search.observe(&p, fits);
        }
        assert_eq!(best, 23);
    }

    #[test]
    fn fake_measurement_expands_context_only_to_model_boundary() {
        let mut c = config();
        c.baseline.n_ctx = 1024;
        c.max_ctx = 10000;
        let mut search = Search::new(&c);
        let mut max = 0;
        while let Some(p) = search.next() {
            assert!(p.ctx <= 10000);
            max = max.max(p.ctx);
            search.observe(&p, true);
        }
        assert_eq!(max, 10000);
    }

    #[test]
    fn unsupported_points_do_not_create_false_memory_boundaries() {
        let c = config();
        let mut search = Search::new(&c);
        let _unsupported = search.next().unwrap();
        assert!(search.outcomes.is_empty());
        assert!(search.next().is_some());
    }

    #[test]
    fn unsupported_quantized_kv_does_not_poison_cpu_fallback() {
        let c = config();
        let mut search = Search::new(&c);
        let mut reached = false;
        while let Some(p) = search.next() {
            if p.cache_type_k_enabled {
                search.skip_unsupported(&p);
            } else {
                search.observe(&p, false);
            }
            if p.ngl == 0 {
                assert!(!p.cache_type_k_enabled);
                reached = true;
            }
        }
        assert!(reached);
    }

    #[test]
    fn fake_measurement_refines_moe_repeated_layer_boundary() {
        let mut c = config();
        c.is_moe = true;
        c.baseline.n_ctx = 256;
        c.max_ctx = 256;
        let mut search = Search::new(&c);
        let mut min = c.block_count;
        while let Some(p) = search.next() {
            let fits = p.ncmoe >= 13;
            if fits {
                min = min.min(p.ncmoe);
            }
            search.observe(&p, fits);
        }
        assert_eq!(min, 13);
    }

    #[test]
    fn sse_chunking_measures_actual_first_content_not_prompt_rate() {
        let mut stream = StreamMeasurement::default();
        stream
            .feed(b"data: {\"content\":\"\"}\n\ndata: {\"cont", 1.0)
            .unwrap();
        assert!(stream.first_ms.is_none());
        stream.feed(b"ent\":\"hello\"}\n\n", 123.0).unwrap();
        stream.feed(b"data: {\"stop\":true,\"timings\":{\"predicted_n\":2,\"predicted_per_second\":40,\"prompt_per_second\":10000}}\n\n", 200.0).unwrap();
        let sample = stream.finish(1, 200.0).unwrap();
        assert_eq!(sample.time_to_first_token_ms, 123.0);
        assert_eq!(sample.generated_tokens, 2);
    }

    #[test]
    fn zero_tokens_missing_content_and_truncated_stream_are_rejected() {
        for data in [
            "data: {\"content\":\"x\",\"stop\":true,\"timings\":{\"predicted_n\":0,\"predicted_per_second\":1}}\n",
            "data: {\"stop\":true,\"timings\":{\"predicted_n\":1,\"predicted_per_second\":1}}\n",
            "data: {\"content\":\"x\",\"timings\":{\"predicted_n\":1,\"predicted_per_second\":1}}\n",
        ] {
            let mut stream = StreamMeasurement::default(); stream.feed(data.as_bytes(), 10.0).unwrap();
            assert!(stream.finish(1, 20.0).is_err());
        }
    }

    #[test]
    fn median_and_variation_ignore_order_not_warmup() {
        let (median, spread) = statistics(&[10.0, 50.0, 11.0]);
        assert_eq!(median, 11.0);
        assert!(spread > 10.0);
    }

    #[test]
    fn cancellation_precedes_structured_oom_and_interrupts_pending_future() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let cancel = AtomicBool::new(true);
            let errors = Arc::new(Mutex::new(VecDeque::from([server_error(
                "oom",
                "out of memory",
            )])));
            assert_eq!(
                check(&cancel, Some(&errors)).unwrap_err().kind,
                FailureKind::Cancelled
            );
            let result = interruptible(std::future::pending::<()>(), &cancel, Some(&errors)).await;
            assert_eq!(result.unwrap_err().kind, FailureKind::Cancelled);
        });
    }

    #[test]
    fn task_registry_is_exclusive_cancel_scoped_and_terminal_retained() {
        let c = config();
        let (guard, cancel) = register_tune(&c).unwrap();
        assert!(acquire_lifecycle().is_err());
        assert!(register_tune(&c).is_err());
        assert!(request_cancel("wrong-run").is_err());
        assert!(!cancel.load(Ordering::SeqCst));
        request_cancel(&c.run_id).unwrap();
        assert_eq!(tune_status().unwrap().status, "stopping");
        assert!(acquire_lifecycle().is_err());
        let status = finish_tune(
            guard,
            AutoTuneStatus {
                run_id: c.run_id,
                model_id: c.model_id,
                status: "done".into(),
                result: None,
                error: None,
                records: vec![],
                failures: vec![],
            },
        );
        assert_eq!(status.status, "cancelled");
        assert_eq!(tune_status().unwrap().status, "cancelled");
        assert!(acquire_lifecycle().is_ok());
    }

    #[test]
    fn contract_serializes_without_legacy_fields_or_api_key_in_candidate() {
        let c = config();
        let value = serde_json::to_value(&c).unwrap();
        assert!(value.get("expert_count").is_none());
        assert!(value.get("total_layers").is_none());
        assert!(value.get("baseline").is_some());
        assert!(serde_json::to_value(Candidate::baseline(&c))
            .unwrap()
            .get("api_key")
            .is_none());
    }
}
