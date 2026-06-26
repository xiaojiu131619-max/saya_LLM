use tauri::{AppHandle, Emitter, Manager, State};

use crate::models::app_state::AppState;
use crate::models::benchmark::{
    AutoTuneConfig, AutoTuneProgress, AutoTuneResult, BenchmarkConfig, BenchmarkProgress,
    BenchmarkResult, SortMode, TuneRecord,
};
use crate::services::benchmark;

// ============================================================
// Quick Benchmark
// ============================================================

#[tauri::command]
pub async fn start_benchmark(app: AppHandle, config: BenchmarkConfig) -> Result<(), String> {
    let port = config.port;
    let prompt_tokens = config.prompt_tokens;
    let max_tokens = config.max_tokens;
    let iterations = config.iterations;

    tokio::spawn(async move {
        let mut results = Vec::new();
        let total_start = std::time::Instant::now();

        for i in 1..=iterations {
            match benchmark::run_single_benchmark(port, prompt_tokens, max_tokens, i).await {
                Ok(iter) => {
                    results.push(iter.clone());
                    app.emit(
                        "benchmark:progress",
                        BenchmarkProgress {
                            current: i,
                            total: iterations,
                            iteration: iter,
                        },
                    )
                    .ok();
                }
                Err(e) => {
                    app.emit(
                        "benchmark:error",
                        serde_json::json!({ "error": e.to_string() }),
                    )
                    .ok();
                    return;
                }
            }
        }

        let count = results.len() as f64;
        app.emit(
            "benchmark:done",
            BenchmarkResult {
                avg_prompt_per_second: results.iter().map(|r| r.prompt_per_second).sum::<f64>()
                    / count,
                avg_tokens_per_second: results.iter().map(|r| r.tokens_per_second).sum::<f64>()
                    / count,
                avg_ttft_ms: results
                    .iter()
                    .map(|r| r.time_to_first_token_ms)
                    .sum::<f64>()
                    / count,
                total_time_ms: total_start.elapsed().as_secs_f64() * 1000.0,
                iterations: results,
            },
        )
        .ok();
    });

    Ok(())
}

// ============================================================
// Auto-Tune
// ============================================================

#[tauri::command]
pub async fn start_auto_tune(
    app: AppHandle,
    _state: State<'_, AppState>,
    config: AutoTuneConfig,
) -> Result<(), String> {
    let app2 = app.clone();

    tokio::spawn(async move {
        let state = app2.state::<AppState>();
        let gm = &state.gpu_monitor;

        // MoE tuning needs a real expert count. If the GGUF parse didn't surface
        // one (some MoE archs name the field differently), fall back to the dense
        // path instead of bailing out — dense tuning still finds a working config.
        if config.is_moe && config.expert_count > 0 {
            auto_tune_moe(&app2, &config, gm).await;
        } else {
            auto_tune_dense(&app2, &config, gm).await;
        }
    });

    Ok(())
}

// ============================================================
// Dense Model
// ============================================================

async fn auto_tune_dense(
    app: &AppHandle,
    config: &AutoTuneConfig,
    gm: &std::sync::Mutex<Option<crate::services::gpu_monitor::GpuMonitor>>,
) {
    let ngl = config.total_layers;
    let mut ctx: u32 = 32768.min(config.max_ctx as u32);
    let mut kv = "f16".to_string();
    let mut records: Vec<TuneRecord> = Vec::new();

    emit(
        app,
        "init",
        &format!("初始: ngl={} ctx={} kv=f16", ngl, ctx),
        None,
    );

    // --- Initial load ---
    let r = match benchmark::measure_point(config, gm, "dense", ngl, ctx, 0, &kv).await {
        Ok(r) => r,
        Err(e) => {
            emit_error(app, &format!("初始加载失败: {}", e));
            return;
        }
    };
    let vram_pct = r.vram_percent;
    records.push(r.clone());
    emit_record(app, "init", "初始加载", &r);

    if vram_pct <= benchmark::VRAM_LIMIT {
        // --- Phase 1: VRAM 有余量，向上升级 CTX ---
        emit(app, "ctx_up", "显存有余量，尝试增大上下文...", None);
        for &next_ctx in benchmark::CTX_UP.iter() {
            if next_ctx > config.max_ctx as u32 || next_ctx <= ctx {
                continue;
            }
            let r = match benchmark::measure_point(config, gm, "dense", ngl, next_ctx, 0, &kv).await
            {
                Ok(r) => r,
                Err(_) => break,
            };
            records.push(r);
            if records.last().unwrap().vram_percent > benchmark::VRAM_LIMIT {
                emit(app, "ctx_up", &format!("ctx={} 超标，回退", next_ctx), None);
                break;
            }
            ctx = next_ctx;
            emit_record(app, "ctx_up", "ctx增大", records.last().unwrap());
        }
    } else {
        // --- Phase 2: VRAM 超标，降级 ---
        // 2.1 CTX 降档
        emit(app, "ctx_down", "显存超标，降低上下文...", None);
        let mut found = false;
        for &down_ctx in benchmark::CTX_DOWN.iter() {
            if down_ctx >= ctx {
                continue;
            }
            let r = match benchmark::measure_point(config, gm, "dense", ngl, down_ctx, 0, &kv).await
            {
                Ok(r) => r,
                Err(_) => continue,
            };
            let fits = r.fits;
            records.push(r);
            ctx = down_ctx;
            emit_record(app, "ctx_down", "ctx降档", records.last().unwrap());
            if fits {
                found = true;
                break;
            }
        }

        // 2.2 KV 降级
        if !found {
            emit(app, "kv_down", "ctx最低仍超标，降级 KV 缓存...", None);
            for next_kv in benchmark::KV_STEPS.iter() {
                let r = match benchmark::measure_point(config, gm, "dense", ngl, ctx, 0, next_kv)
                    .await
                {
                    Ok(r) => r,
                    Err(_) => continue,
                };
                let fits = r.fits;
                kv = next_kv.to_string();
                records.push(r);
                emit_record(app, "kv_down", "KV降级", records.last().unwrap());
                if fits {
                    found = true;
                    break;
                }
            }
        }

        // 2.3 NGL 让步
        if !found {
            let _ = ngl_step_down(
                app,
                config,
                gm,
                NglStepDownParams {
                    model_type: "dense",
                    ngl_start: ngl,
                    ctx,
                    ncmoe: 0,
                    kv: &kv,
                },
                &mut records,
            )
            .await;
        }
    }

    // --- Output ---
    let _ = crate::services::process_manager::stop_server();
    emit_result(app, &records, &config.sort_mode, false);
}

// ============================================================
// MoE Model
// ============================================================

async fn auto_tune_moe(
    app: &AppHandle,
    config: &AutoTuneConfig,
    gm: &std::sync::Mutex<Option<crate::services::gpu_monitor::GpuMonitor>>,
) {
    let ngl = config.total_layers;
    let expert_count = config.expert_count;
    if expert_count == 0 {
        emit_error(app, "MoE 模型 expert_count 不能为 0");
        return;
    }
    let mut ctx: u32 = 32768.min(config.max_ctx as u32);
    let kv = "f16".to_string();
    let mut records: Vec<TuneRecord> = Vec::new();
    let mut best_ncmoe = expert_count;

    emit(
        app,
        "init",
        &format!(
            "初始: ngl={} ctx={} ncmoe={} (全CPU)",
            ngl, ctx, expert_count
        ),
        None,
    );

    // --- Initial load ---
    let r = match benchmark::measure_point(config, gm, "moe", ngl, ctx, expert_count, &kv).await {
        Ok(r) => r,
        Err(e) => {
            emit_error(app, &format!("初始加载失败: {}", e));
            return;
        }
    };
    records.push(r);
    emit_record(app, "init", "初始加载", records.last().unwrap());

    if records.last().unwrap().fits {
        // --- Phase 1: 反向搜索 ncmoe (找最小值 = 更多 GPU) ---
        emit(
            app,
            "ncmoe_search",
            "初始显存有余量，搜索最少 CPU 专家层数...",
            None,
        );
        let mut low = 0u32;
        let mut high = expert_count;

        // 二分搜索
        while high - low > 5 {
            let mid = (low + high) / 2;
            let r = match benchmark::measure_point(config, gm, "moe", ngl, ctx, mid, &kv).await {
                Ok(r) => r,
                Err(_) => {
                    low = mid;
                    continue;
                }
            };
            records.push(r);
            if records.last().unwrap().fits {
                high = mid;
                best_ncmoe = mid;
                emit_record(app, "ncmoe_bin", "二分", records.last().unwrap());
            } else {
                low = mid;
                emit(app, "ncmoe_bin", &format!("ncmoe={} 超标", mid), None);
            }
        }

        // ±5 逼近
        let mut ncmoe = best_ncmoe;
        while ncmoe > 0 {
            let next = ncmoe.saturating_sub(5);
            let r = match benchmark::measure_point(config, gm, "moe", ngl, ctx, next, &kv).await {
                Ok(r) => r,
                Err(_) => break,
            };
            records.push(r);
            if records.last().unwrap().fits {
                ncmoe = next;
                best_ncmoe = ncmoe;
                emit_record(app, "ncmoe_5", "ncmoe-5", records.last().unwrap());
            } else {
                break;
            }
        }

        // ±1 微调
        while ncmoe > 0 {
            let next = ncmoe - 1;
            let r = match benchmark::measure_point(config, gm, "moe", ngl, ctx, next, &kv).await {
                Ok(r) => r,
                Err(_) => break,
            };
            records.push(r);
            if records.last().unwrap().fits {
                ncmoe = next;
                best_ncmoe = ncmoe;
                emit_record(app, "ncmoe_1", "ncmoe-1", records.last().unwrap());
            } else {
                break;
            }
        }

        // --- Phase 2: ncmoe=0 仍有余量，向上升级 CTX ---
        if best_ncmoe == 0 {
            let last_pct = records.last().map(|r| r.vram_percent).unwrap_or(1.0);
            if last_pct < benchmark::VRAM_LIMIT {
                emit(app, "ctx_up", "ncmoe=0 仍有余量，增大上下文...", None);
                for &next_ctx in benchmark::CTX_UP.iter() {
                    if next_ctx > config.max_ctx as u32 || next_ctx <= ctx {
                        continue;
                    }
                    let r = match benchmark::measure_point(config, gm, "moe", ngl, next_ctx, 0, &kv)
                        .await
                    {
                        Ok(r) => r,
                        Err(_) => break,
                    };
                    records.push(r);
                    if records.last().unwrap().vram_percent > benchmark::VRAM_LIMIT {
                        break;
                    }
                    ctx = next_ctx;
                    emit_record(app, "ctx_up", "ctx增大", records.last().unwrap());
                }
            }
        }
    } else {
        // --- VRAM 超标：降级路径 ---
        // MoE: ncmoe 已最大(N)，初始仍超标 → ctx降 → KV降 → ngl降

        // 2.1 CTX 降档
        emit(app, "ctx_down", "初始显存超标，降低上下文...", None);
        let mut found = false;
        for &down_ctx in benchmark::CTX_DOWN.iter() {
            if down_ctx >= ctx {
                continue;
            }
            let r =
                match benchmark::measure_point(config, gm, "moe", ngl, down_ctx, expert_count, &kv)
                    .await
                {
                    Ok(r) => r,
                    Err(_) => continue,
                };
            let fits = r.fits;
            records.push(r);
            ctx = down_ctx;
            emit_record(app, "ctx_down", "ctx降档", records.last().unwrap());
            if fits {
                found = true;
                break;
            }
        }

        // 2.2 KV 降级
        if !found {
            emit(app, "kv_down", "ctx最低仍超标，降级 KV 缓存...", None);
            for next_kv in benchmark::KV_STEPS.iter() {
                let r = match benchmark::measure_point(
                    config,
                    gm,
                    "moe",
                    ngl,
                    ctx,
                    expert_count,
                    next_kv,
                )
                .await
                {
                    Ok(r) => r,
                    Err(_) => continue,
                };
                let fits = r.fits;
                records.push(r);
                emit_record(app, "kv_down", "KV降级", records.last().unwrap());
                if fits {
                    found = true;
                    break;
                }
            }
        }

        // 2.3 NGL 让步
        if !found {
            let _ = ngl_step_down(
                app,
                config,
                gm,
                NglStepDownParams {
                    model_type: "moe",
                    ngl_start: ngl,
                    ctx,
                    ncmoe: expert_count,
                    kv: &kv,
                },
                &mut records,
            )
            .await;
        }
    }

    // --- Output ---
    let _ = crate::services::process_manager::stop_server();
    emit_result(app, &records, &config.sort_mode, true);
}

// ============================================================
// Helpers
// ============================================================

/// Search downward on GPU layer count until the config fits VRAM, then fine-tune
/// back up by 1 to recover as many layers as still fit. Shared by dense and MoE
/// (MoE keeps all experts on CPU via `ncmoe` while lowering layers).
///
/// The coarse step adapts to model size (max(1, ngl/8)) and the search reaches
/// down to 0, so tiny models (≤5 layers) are covered too — the old fixed step of
/// 5 with a `> 5` bound skipped them entirely.
struct NglStepDownParams<'a> {
    model_type: &'a str,
    ngl_start: u32,
    ctx: u32,
    ncmoe: u32,
    kv: &'a str,
}

async fn ngl_step_down(
    app: &AppHandle,
    config: &AutoTuneConfig,
    gm: &std::sync::Mutex<Option<crate::services::gpu_monitor::GpuMonitor>>,
    params: NglStepDownParams<'_>,
    records: &mut Vec<TuneRecord>,
) -> bool {
    emit(app, "ngl_down", "KV 最低仍超标，减少 GPU 层数...", None);
    let step = (params.ngl_start / 8).max(1);
    let mut ngl_try = params.ngl_start;

    loop {
        // Step down (clamping the final step to land exactly on 0).
        if ngl_try <= step {
            if ngl_try == 0 {
                break;
            }
            ngl_try = 0;
        } else {
            ngl_try -= step;
        }

        let r = match benchmark::measure_point(
            config,
            gm,
            params.model_type,
            ngl_try,
            params.ctx,
            params.ncmoe,
            params.kv,
        )
        .await
        {
            Ok(r) => r,
            Err(_) => {
                if ngl_try == 0 {
                    break;
                }
                continue;
            }
        };
        let fits = r.fits;
        records.push(r);
        emit_record(app, "ngl_down", "ngl降档", records.last().unwrap());

        if fits {
            // Climb back up 1 layer at a time to reclaim layers that still fit.
            while ngl_try < params.ngl_start {
                ngl_try += 1;
                let r2 = match benchmark::measure_point(
                    config,
                    gm,
                    params.model_type,
                    ngl_try,
                    params.ctx,
                    params.ncmoe,
                    params.kv,
                )
                .await
                {
                    Ok(r) => r,
                    Err(_) => break,
                };
                if r2.vram_percent > benchmark::VRAM_LIMIT {
                    break;
                }
                records.push(r2);
                emit_record(app, "ngl_up", "ngl微调", records.last().unwrap());
            }
            return true;
        }

        if ngl_try == 0 {
            break;
        }
    }
    false
}

fn emit(app: &AppHandle, phase: &str, msg: &str, record: Option<TuneRecord>) {
    app.emit(
        "autotune:progress",
        AutoTuneProgress {
            phase: phase.to_string(),
            message: msg.to_string(),
            record,
        },
    )
    .ok();
}

fn emit_record(app: &AppHandle, phase: &str, label: &str, r: &TuneRecord) {
    emit(
        app,
        phase,
        &format!(
            "{}: ngl={} ctx={} kv={} ncmoe={} | VRAM {:.1}/{:.1} ({:.0}%) | ts={:.1}",
            label,
            r.ngl,
            r.ctx,
            r.kv,
            r.ncmoe,
            r.vram_used_gb,
            r.vram_total_gb,
            r.vram_percent * 100.0,
            r.ts
        ),
        Some(r.clone()),
    );
}

fn emit_error(app: &AppHandle, msg: &str) {
    app.emit("autotune:error", serde_json::json!({ "error": msg }))
        .ok();
}

fn emit_result(app: &AppHandle, records: &[TuneRecord], sort_mode: &SortMode, _is_moe: bool) {
    let candidates: Vec<&TuneRecord> = records.iter().filter(|r| r.fits).collect();

    if candidates.is_empty() {
        emit_error(app, "所有配置均超出显存限制");
        return;
    }

    let best = match sort_mode {
        SortMode::TsPriority => candidates
            .iter()
            .max_by(|a, b| a.ts.partial_cmp(&b.ts).unwrap())
            .unwrap(),
        SortMode::CtxPriority => candidates
            .iter()
            .max_by(|a, b| a.ctx.cmp(&b.ctx).then(a.ts.partial_cmp(&b.ts).unwrap()))
            .unwrap(),
    };

    eprintln!(
        "[auto-tune] 最佳: ngl={} ctx={} ncmoe={} kv={} ts={:.1} VRAM={:.0}%",
        best.ngl,
        best.ctx,
        best.ncmoe,
        best.kv,
        best.ts,
        best.vram_percent * 100.0
    );

    app.emit(
        "autotune:done",
        AutoTuneResult {
            best: (*best).clone(),
            records: records.to_vec(),
        },
    )
    .ok();
}
