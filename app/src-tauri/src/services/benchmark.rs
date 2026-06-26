use anyhow::Result;
use reqwest::Client;
use serde_json::json;
use std::time::Duration;

use crate::models::benchmark::{BenchmarkIteration, TuneRecord};
use crate::models::server_config::ServerConfig;
use crate::services::process_manager;

pub const VRAM_LIMIT: f64 = 0.90;

pub const CTX_UP: [u32; 4] = [49152, 57344, 65536, 73728];
pub const CTX_DOWN: [u32; 3] = [24576, 16384, 10240];
pub const KV_STEPS: [&str; 2] = ["q8_0", "q4_0"];

pub fn parse_kv(kv: &str) -> (&str, &str) {
    match kv {
        "q8_0" => ("q8_0", "q8_0"),
        "q4_0" => ("q4_0", "q4_0"),
        _ => ("f16", "f16"),
    }
}

pub async fn run_single_benchmark(
    port: u16,
    prompt_tokens: u32,
    max_tokens: u32,
    iteration: u32,
) -> Result<BenchmarkIteration> {
    let client = Client::builder()
        .timeout(Duration::from_secs(120))
        .build()?;
    let url = format!("http://127.0.0.1:{}/completion", port);
    // "the " is roughly one token for most BPE tokenizers, giving a more stable estimate.
    let prompt = "the ".repeat(prompt_tokens as usize);

    let body = json!({
        "prompt": prompt,
        "n_predict": max_tokens,
        "temperature": 0.0,
        "stream": false,
        "cache_prompt": true
    });

    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("请求失败: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow::anyhow!("服务器返回错误 {}: {}", status, text));
    }

    let data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| anyhow::anyhow!("解析响应失败: {}", e))?;

    let timings = &data["timings"];
    let pp = timings["prompt_per_second"].as_f64().unwrap_or(0.0);
    let tg = timings["predicted_per_second"].as_f64().unwrap_or(0.0);
    let prompt_n = timings["prompt_n"].as_u64().unwrap_or(prompt_tokens as u64) as u32;
    let predicted_n = timings["predicted_n"].as_u64().unwrap_or(max_tokens as u64) as u32;
    let prompt_ms = timings["prompt_ms"].as_f64().unwrap_or(0.0);
    let predicted_ms = timings["predicted_ms"].as_f64().unwrap_or(0.0);
    let ttft_ms = if pp > 0.0 { 1000.0 / pp } else { prompt_ms };

    Ok(BenchmarkIteration {
        iteration,
        prompt_tokens: prompt_n,
        prompt_per_second: pp,
        generated_tokens: predicted_n,
        tokens_per_second: tg,
        time_to_first_token_ms: ttft_ms,
        total_time_ms: predicted_ms + prompt_ms,
    })
}

pub fn build_server_config(
    base: &crate::models::benchmark::AutoTuneConfig,
    ngl: u32,
    n_ctx: u32,
    ncmoe: u32,
    kv: &str,
) -> ServerConfig {
    let (ctk, ctv) = parse_kv(kv);
    ServerConfig {
        executable_path: base.executable_path.clone(),
        model_path: base.model_path.clone(),
        port: base.port,
        host: "127.0.0.1".to_string(),
        api_key: None,
        ngl,
        n_ctx,
        batch_size: base.batch_size,
        ubatch_size: 512,
        threads: -1,
        parallel: -1,
        flash_attn: base.flash_attn,
        kv_offload: base.kv_offload,
        kv_unified: true,
        mmap: base.mmap,
        mlock: base.mlock,
        cache_type_k: ctk.to_string(),
        cache_type_v: ctv.to_string(),
        cache_type_k_enabled: kv != "f16",
        cache_type_v_enabled: kv != "f16",
        rope_freq_base: None,
        rope_freq_scale: None,
        seed: None,
        chat_template: None,
        mmproj_path: None,
        mtp_draft_path: None,
        spec_type: None,
        ncmoe,
        tools: None,
        reasoning_budget: 0,
        device: Some("CUDA0".to_string()),
        main_gpu: Some(0),
        retry_cpu_fallback: false,
        no_cuda: false,
    }
}

pub async fn restart_server_and_wait(
    config: &crate::models::benchmark::AutoTuneConfig,
    ngl: u32,
    n_ctx: u32,
    ncmoe: u32,
    kv: &str,
) -> Result<()> {
    let _ = process_manager::stop_server();
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    let server_config = build_server_config(config, ngl, n_ctx, ncmoe, kv);

    let (tx_ready, rx_ready) = tokio::sync::oneshot::channel::<()>();
    let tx_ready = std::sync::Mutex::new(Some(tx_ready));

    process_manager::start_server(
        &server_config,
        move |_| {},
        move || {
            if let Ok(mut guard) = tx_ready.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(());
                }
            }
        },
        move |_| {},
    )
    .map_err(|e| anyhow::anyhow!("启动服务器失败: {}", e))?;

    match tokio::time::timeout(std::time::Duration::from_secs(180), rx_ready).await {
        Ok(Ok(())) => {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            Ok(())
        }
        Ok(Err(_)) => Err(anyhow::anyhow!("服务器就绪信号丢失")),
        Err(_) => {
            let _ = process_manager::stop_server();
            Err(anyhow::anyhow!("服务器启动超时"))
        }
    }
}

pub fn read_vram(
    gpu_monitor: &std::sync::Mutex<Option<crate::services::gpu_monitor::GpuMonitor>>,
) -> Option<(f64, f64)> {
    let mut guard = gpu_monitor.lock().ok()?;
    let gpu = guard.as_mut()?;
    let used = gpu.get_vram_used().ok()?;
    let total = gpu.get_vram_total().ok()?;
    Some((used, total))
}

pub async fn measure_point(
    config: &crate::models::benchmark::AutoTuneConfig,
    gpu_monitor: &std::sync::Mutex<Option<crate::services::gpu_monitor::GpuMonitor>>,
    model_type: &str,
    ngl: u32,
    n_ctx: u32,
    ncmoe: u32,
    kv: &str,
) -> Result<TuneRecord> {
    restart_server_and_wait(config, ngl, n_ctx, ncmoe, kv).await?;

    // Read a baseline right after load. KV cache / compute buffers are allocated
    // lazily, so this is the *floor*, not the real footprint.
    let (vram_total, vram_baseline) = {
        let (used, total) =
            read_vram(gpu_monitor).ok_or_else(|| anyhow::anyhow!("无法读取 VRAM"))?;
        (total, used)
    };

    // Run several short benchmarks and average. A single 64/64 pass is noisy, so
    // we average tokens/sec across a few iterations to stabilize the ranking.
    const SAMPLES: u32 = 3;
    let mut ts_sum = 0.0;
    let mut ttft_sum = 0.0;
    let mut ok_samples = 0u32;
    let mut vram_peak = vram_baseline;
    for i in 1..=SAMPLES {
        let bench = run_single_benchmark(config.port, 64, 96, i).await?;
        ts_sum += bench.tokens_per_second;
        ttft_sum += bench.time_to_first_token_ms;
        ok_samples += 1;
        // Read VRAM right after each pass — by now KV cache + compute buffers are
        // fully resident, so this reflects the true working-set footprint.
        if let Some((used, _)) = read_vram(gpu_monitor) {
            if used > vram_peak {
                vram_peak = used;
            }
        }
    }
    let samples = ok_samples.max(1) as f64;
    let ts = ts_sum / samples;
    let first_token_ms = ttft_sum / samples;

    let vram_percent = vram_peak / vram_total;
    let record = TuneRecord {
        model_type: model_type.to_string(),
        ngl,
        ncmoe,
        ctx: n_ctx,
        kv: kv.to_string(),
        vram_used_gb: vram_peak,
        vram_total_gb: vram_total,
        vram_percent,
        ts,
        first_token_ms,
        fits: vram_percent <= VRAM_LIMIT,
    };

    eprintln!(
        "[tune] {} ngl={} ctx={} ncmoe={} kv={} | VRAM peak {:.1}/{:.1} ({:.0}%) baseline {:.1} | ts={:.1}",
        model_type, ngl, n_ctx, ncmoe, kv,
        vram_peak, vram_total, record.vram_percent * 100.0, vram_baseline, record.ts
    );

    Ok(record)
}
