use tauri::{AppHandle, Emitter, Manager};

use crate::models::app_state::AppState;
use crate::models::benchmark::*;
use crate::services::benchmark;

#[tauri::command]
pub async fn start_benchmark(app: AppHandle, config: BenchmarkConfig) -> Result<(), String> {
    let guard = benchmark::acquire_lifecycle()?;
    if config.iterations == 0 || config.prompt_tokens == 0 || config.max_tokens == 0 {
        return Err("迭代次数、提示和生成 token 数必须大于 0".into());
    }
    tokio::spawn(async move {
        let _guard = guard;
        let mut results = Vec::new();
        let total_start = std::time::Instant::now();
        for i in 1..=config.iterations {
            match benchmark::run_single_benchmark(
                config.port,
                config.prompt_tokens,
                config.max_tokens,
                i,
            )
            .await
            {
                Ok(iter) => {
                    results.push(iter.clone());
                    app.emit(
                        "benchmark:progress",
                        BenchmarkProgress {
                            current: i,
                            total: config.iterations,
                            iteration: iter,
                        },
                    )
                    .ok();
                }
                Err(e) => {
                    app.emit(
                        "benchmark:error",
                        serde_json::json!({"error": e.to_string()}),
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

#[tauri::command]
pub async fn start_auto_tune(app: AppHandle, config: AutoTuneConfig) -> Result<(), String> {
    let (guard, cancel) = benchmark::register_tune(&config)?;
    tokio::spawn(async move {
        let mut records = Vec::new();
        let mut failures = Vec::new();
        let outcome = run_tune(&app, &config, &cancel, &mut records, &mut failures).await;
        // run_tune 返回前每个 owned server 已完成 Drop/join，取消命令只发请求。
        let status = benchmark::finish_tune(
            guard,
            AutoTuneStatus {
                run_id: config.run_id.clone(),
                model_id: config.model_id.clone(),
                status: match &outcome {
                    Ok(_) => "done",
                    Err(e) if e.kind == FailureKind::Cancelled => "cancelled",
                    Err(_) => "error",
                }
                .into(),
                result: outcome.as_ref().ok().cloned(),
                error: outcome.as_ref().err().map(|e| e.message.clone()),
                records,
                failures,
            },
        );
        match status.status.as_str() {
            "done" => {
                app.emit("autotune:done", status.result.as_ref().unwrap())
                    .ok();
            }
            "cancelled" => {
                app.emit("autotune:cancelled", serde_json::json!({
                "run_id": status.run_id, "model_id": status.model_id, "message": "自动调参已停止，测量服务已回收",
                "records": status.records, "failures": status.failures })).ok();
            }
            _ => {
                app.emit(
                    "autotune:error",
                    serde_json::json!({
                "run_id": status.run_id, "model_id": status.model_id, "error": status.error,
                "records": status.records, "failures": status.failures }),
                )
                .ok();
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn cancel_auto_tune(run_id: String) -> Result<(), String> {
    benchmark::request_cancel(&run_id)
}

#[tauri::command]
pub fn get_auto_tune_status() -> Option<AutoTuneStatus> {
    benchmark::tune_status()
}

fn progress(
    app: &AppHandle,
    config: &AutoTuneConfig,
    phase: &str,
    message: &str,
    record: Option<TuneRecord>,
) {
    app.emit(
        "autotune:progress",
        AutoTuneProgress {
            run_id: config.run_id.clone(),
            model_id: config.model_id.clone(),
            phase: phase.into(),
            message: message.into(),
            record,
        },
    )
    .ok();
}

fn failure(
    config: &AutoTuneConfig,
    point: &benchmark::Candidate,
    mut error: TuneFailure,
    cancel: &std::sync::atomic::AtomicBool,
    failures: &mut Vec<TuneFailure>,
) -> TuneFailure {
    if cancel.load(std::sync::atomic::Ordering::SeqCst) {
        error = TuneFailure::cancelled();
    }
    // 不含完整 ServerConfig，因此不会把 API key 写入结果/实验记录。
    error.candidate = serde_json::to_value(point).ok();
    failures.push(error.clone());
    let _ = config;
    error
}

async fn run_tune(
    app: &AppHandle,
    config: &AutoTuneConfig,
    cancel: &std::sync::atomic::AtomicBool,
    records: &mut Vec<TuneRecord>,
    failures: &mut Vec<TuneFailure>,
) -> Result<AutoTuneResult, TuneFailure> {
    let state = app.state::<AppState>();
    let gm = &state.gpu_monitor;
    progress(app, config, "init", "以当前完整配置为起点；仅搜索 ctx、KV、GPU/CPU 卸载层数。ctx 最小 256（当前值更小时保持该下界），几何上探至模型 max_ctx；粗测最多 32 点，候选去重，最优点另做复测。短提示显存读数不代表最大上下文峰值。", None);
    let mut search = benchmark::Search::new(config);
    while let Some(point) = search.next() {
        if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(TuneFailure::cancelled());
        }
        progress(
            app,
            config,
            "coarse",
            &format!(
                "粗测 ctx={} ngl={} ncmoe={}；短提示负载，不保证满上下文显存",
                point.ctx, point.ngl, point.ncmoe
            ),
            None,
        );
        match benchmark::measure_point(config, gm, &point, cancel, false).await {
            Ok(record) => {
                search.observe(&point, record.fits);
                records.push(record.clone());
                progress(
                    app,
                    config,
                    "coarse",
                    "粗测完成：热测中位数（预热不计入），显存为短负载采样值",
                    Some(record),
                );
            }
            Err(error) => {
                let error = failure(config, &point, error, cancel, failures);
                progress(app, config, "candidate_failed", &error.message, None);
                benchmark::update_tune_records(&config.run_id, records, failures);
                if error.kind == FailureKind::Oom {
                    search.observe(&point, false);
                }
                if error.kind == FailureKind::Unsupported {
                    search.skip_unsupported(&point);
                }
                if matches!(error.kind, FailureKind::Fatal | FailureKind::Cancelled) {
                    return Err(error);
                }
                // OOM 继续降档；不支持候选仅跳过，绝不当作 OOM 边界。
            }
        }
        benchmark::update_tune_records(&config.run_id, records, failures);
    }
    let mut candidates: Vec<TuneRecord> = records.iter().filter(|r| r.fits).cloned().collect();
    benchmark::rank_records(&mut candidates, &config.sort_mode);
    // 最多复测前三名。未复测/复测失败的粗测记录不允许作为最终 best。
    let mut refined = Vec::new();
    for candidate in candidates.into_iter().take(3) {
        let point = benchmark::Candidate::from_record(&candidate);
        progress(
            app,
            config,
            "refine",
            "重启最优候选，分离冷提示、预热与 5 次热测，重新验证可用性",
            None,
        );
        match benchmark::measure_point(config, gm, &point, cancel, true).await {
            Ok(record) => {
                let fits = record.fits;
                records.push(record.clone());
                progress(
                    app,
                    config,
                    "refine",
                    "复测完成；仍不代表满上下文显存峰值",
                    Some(record.clone()),
                );
                benchmark::update_tune_records(&config.run_id, records, failures);
                if fits {
                    refined.push(record);
                }
            }
            Err(error) => {
                let error = failure(config, &point, error, cancel, failures);
                if matches!(error.kind, FailureKind::Fatal | FailureKind::Cancelled) {
                    return Err(error);
                }
            }
        }
    }
    benchmark::rank_records(&mut refined, &config.sort_mode);
    match refined.into_iter().next() {
        Some(best) => Ok(AutoTuneResult {
            run_id: config.run_id.clone(),
            model_id: config.model_id.clone(),
            best,
            records: records.clone(),
            failures: failures.clone(),
        }),
        None => Err(TuneFailure::fatal(
            "没有通过复测的可用配置；未自动应用任何粗测结果",
        )),
    }
}
