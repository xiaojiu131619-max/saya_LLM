//! Strata 真实请求性能历史。
//!
//! 数据源是网关自己的 `GET /metrics`：它把每个请求的 token 数、首字时间、
//! 读题与解码耗时留在 `requests`（最多 500 条）里。本模块的职责只有三件：
//!
//! 1. 定时把那份历史**增量**收进本地环形缓冲（网关重启会清空它自己的历史，
//!    本地保留的那部分不受影响）；
//! 2. 统一成与 fast-27b 一致的 IPC 形状，前端两个统计面板共用一套渲染逻辑；
//! 3. 保底去重——网关的 `id` 在同一进程内唯一，跨进程会用 `started_at` 参与判重。
//!
//! 不做推算：网关没报的读数保持 null，前端显示「—」，不拿 prompt_read 冒充 TTFT。

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// 与 fast-27b 面板同一口径：最近 24 小时、最多 5000 条终态请求。
const HISTORY_WINDOW_MS: u64 = 24 * 60 * 60 * 1000;
const HISTORY_LIMIT: usize = 5000;

#[derive(Debug, Clone, serde::Serialize)]
pub struct StrataRequestMetric {
    pub id: String,
    pub request_id: u64,
    /// 请求开始时刻（毫秒，Unix）。
    pub started_at: u64,
    /// 请求结束时刻（毫秒，Unix）。
    pub finished_at: u64,
    /// success / cancelled；网关的 history 不记错误文本，失败也算 success 之外的 cancelled。
    pub outcome: String,
    /// 收尾原因（stop / length / cancelled …），前端表格里当补充信息。
    pub finish: Option<String>,
    pub prompt_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub ttft_ms: Option<f64>,
    pub total_ms: Option<f64>,
    pub decode_tps: Option<f64>,
    pub prefill_tps: Option<f64>,
    pub cache_tokens: Option<u64>,
    pub draft_accepted: Option<u64>,
    pub draft_proposed: Option<u64>,
    /// 网关记录的判重键（列表 id + 开始时刻）；只在本地用，不下发前端。
    #[serde(skip)]
    pub dedupe_key: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct StrataMetricsSnapshot {
    pub collected_at: u64,
    pub active_requests: u32,
    pub requests: Vec<StrataRequestMetric>,
}

#[derive(Default)]
struct Store {
    history: VecDeque<StrataRequestMetric>,
    seen: std::collections::HashSet<String>,
    next_id: u64,
    active_requests: u32,
    /// 最近一次成功采样的时刻（毫秒）；0 = 还没采到过。
    collected_at: u64,
}

static STORE: OnceLock<Mutex<Store>> = OnceLock::new();

fn store() -> &'static Mutex<Store> {
    STORE.get_or_init(|| Mutex::new(Store::default()))
}

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn as_u64(value: Option<&serde_json::Value>) -> Option<u64> {
    value.and_then(|v| {
        v.as_u64()
            .or_else(|| v.as_f64().filter(|f| *f >= 0.0).map(|f| f as u64))
    })
}

fn as_f64(value: Option<&serde_json::Value>) -> Option<f64> {
    value.and_then(|v| v.as_f64().filter(|f| f.is_finite()))
}

/// 一条网关 history 记录 → IPC 指标。
///
/// 网关字段名（serve/server.py 的 `self.history.append`）与这里的映射关系：
/// `time` 是开始时刻（秒），`duration_s` 是整条请求的墙钟耗时，
/// `first_engine_token_s` 是引擎吐出第一个 token 的时间，用它当首字延迟——
/// 不用 `prompt_read`（那是引擎读题耗时，官方注释特意声明它不是 TTFT）。
fn map_request(
    raw: &serde_json::Value,
    seq: u64,
) -> Option<(String, StrataRequestMetric)> {
    let started_s = as_f64(raw.get("time"))?;
    let started_at = (started_s * 1000.0) as u64;
    let duration_s = as_f64(raw.get("duration_s"));
    let finished_at = started_at + duration_s.map(|d| (d * 1000.0) as u64).unwrap_or(0);
    let finish = raw
        .get("finish")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    // 网关的 finish 实际取值包括 stop / length / tool_calls / cancel /
    // disconnect / error / timeout。旧实现只把含 cancel 的算取消，其余全记成功，
    // 结果是错误与断流也进了成功率与 token 汇总。这里显式分三档。
    let finish_lower = finish
        .as_deref()
        .unwrap_or("")
        .to_ascii_lowercase();
    let outcome = if finish_lower.contains("cancel")
        || finish_lower == "disconnect"
        || finish_lower == "disconnected"
    {
        "cancelled"
    } else if finish_lower == "error"
        || finish_lower == "timeout"
        || finish_lower.contains("fail")
    {
        "failed"
    } else {
        "success"
    };

    let prompt_tokens = as_u64(raw.get("prompt_tokens"));
    let prompt_ms = as_f64(raw.get("prompt_ms"));
    let prefill_tps = match (prompt_tokens, raw.get("reused").and_then(|v| v.as_u64())) {
        // 读题吞吐要用「新读的 token」算，直接把整段 prompt 除以读题时间会虚高。
        (Some(total), Some(reused)) if prompt_ms.unwrap_or(0.0) > 0.0 => {
            let fresh = total.saturating_sub(reused);
            Some(fresh as f64 / (prompt_ms.unwrap_or(0.0) / 1000.0))
        }
        _ => None,
    };

    let key = format!(
        "{}@{}",
        raw.get("id")
            .map(|v| v.to_string().trim_matches('"').to_string())
            .unwrap_or_else(|| finished_at.to_string()),
        started_at
    );
    Some((
        key.clone(),
        StrataRequestMetric {
            id: format!("strata-{}", seq),
            request_id: seq,
            started_at,
            finished_at,
            outcome: outcome.to_string(),
            finish,
            prompt_tokens,
            output_tokens: as_u64(raw.get("output_tokens")),
            ttft_ms: as_f64(raw.get("first_engine_token_s")).map(|s| s * 1000.0),
            total_ms: duration_s.map(|s| s * 1000.0),
            decode_tps: as_f64(raw.get("decode_tok_s")),
            prefill_tps: prefill_tps.filter(|v| *v > 0.0),
            cache_tokens: as_u64(raw.get("reused")),
            draft_accepted: as_u64(raw.get("drafts_accepted")),
            draft_proposed: as_u64(raw.get("drafts_offered")),
            dedupe_key: key,
        },
    ))
}

/// 收一份 `GET /metrics` 的响应。
///
/// 网关的 `requests` 是「最近 12 条、新的在前」；应用带 `?requests=all` 请求，
/// 拿到的是它保留的全部（最多 500 条）。这里按时间排序后增量追加。
pub fn ingest_metrics(value: &serde_json::Value) {
    let now = epoch_ms();
    let active = value
        .get("live")
        .and_then(|live| {
            live.get("running")
                .and_then(|v| v.as_u64())
                .or_else(|| match live.get("state").and_then(|v| v.as_str()) {
                    Some("generating") | Some("reading") => Some(1),
                    _ => None,
                })
        })
        .unwrap_or(0) as u32;

    let mut batch = Vec::new();
    if let Some(requests) = value.get("requests").and_then(|v| v.as_array()) {
        for raw in requests {
            if let Some((_, metric)) = map_request(raw, 0) {
                batch.push(metric);
            }
        }
    }
    // 网关把新的排在最前；统一成时间正序，追加到队尾。
    batch.sort_by_key(|metric| metric.started_at);

    let Ok(mut store) = store().lock() else {
        return;
    };
    store.collected_at = now;
    store.active_requests = active;
    for mut metric in batch {
        if store.seen.contains(&metric.dedupe_key) {
            continue;
        }
        store.next_id += 1;
        metric.request_id = store.next_id;
        metric.id = format!("strata-{}", store.next_id);
        store.seen.insert(metric.dedupe_key.clone());
        store.history.push_back(metric);
    }
    // 双重收口：时间窗外先丢，超限再从头部丢。
    let cutoff = now.saturating_sub(HISTORY_WINDOW_MS);
    while store
        .history
        .front()
        .map(|metric| metric.finished_at < cutoff)
        .unwrap_or(false)
    {
        if let Some(removed) = store.history.pop_front() {
            store.seen.remove(&removed.dedupe_key);
        }
    }
    while store.history.len() > HISTORY_LIMIT {
        if let Some(removed) = store.history.pop_front() {
            store.seen.remove(&removed.dedupe_key);
        }
    }
    // 去重集合不能只增不减：超过历史两倍后按现存历史重建一次。
    if store.seen.len() > HISTORY_LIMIT * 2 {
        let kept: std::collections::HashSet<String> = store
            .history
            .iter()
            .map(|metric| metric.dedupe_key.clone())
            .collect();
        store.seen = kept;
    }
}

/// 快照（时间正序，方便前端直接算趋势）。
pub fn snapshot() -> StrataMetricsSnapshot {
    let Ok(store) = store().lock() else {
        return StrataMetricsSnapshot {
            collected_at: epoch_ms(),
            active_requests: 0,
            requests: Vec::new(),
        };
    };
    StrataMetricsSnapshot {
        collected_at: if store.collected_at > 0 {
            store.collected_at
        } else {
            epoch_ms()
        },
        active_requests: store.active_requests,
        requests: store.history.iter().cloned().collect(),
    }
}

/// 引擎停止时清零「进行中」：否则最后一次快照的在途数会一直挂在面板上。
pub fn clear_active_requests() {
    if let Ok(mut store) = store().lock() {
        store.active_requests = 0;
    }
}

/// 清空历史（设置页「清空统计」用；不影响网关自己的记录）。
pub fn clear() {
    if let Ok(mut store) = store().lock() {
        store.history.clear();
        store.seen.clear();
        store.active_requests = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> serde_json::Value {
        sample_at(1_700_000_000.0)
    }

    fn sample_at(started_s: f64) -> serde_json::Value {
        serde_json::json!({
            "live": { "state": "idle", "running": 0 },
            "requests": [{
                "id": 7,
                "time": started_s,
                "duration_s": 2.5,
                "finish": "stop",
                "prompt_tokens": 1200,
                "reused": 800,
                "output_tokens": 64,
                "first_engine_token_s": 0.4,
                "prompt_ms": 100.0,
                "decode_ms": 2400.0,
                "decode_tok_s": 26.7,
                "drafts_offered": 40,
                "drafts_accepted": 28
            }]
        })
    }

    #[test]
    fn maps_gateway_history_into_ipc_shape() {
        let (_, metric) = map_request(&sample()["requests"][0], 3).expect("应能解析");
        assert_eq!(metric.request_id, 3);
        assert_eq!(metric.ttft_ms, Some(400.0));
        assert_eq!(metric.total_ms, Some(2500.0));
        assert_eq!(metric.decode_tps, Some(26.7));
        // 读题吞吐按「新读 token」算：(1200 - 800) / 0.1s = 4000 tok/s
        assert_eq!(metric.prefill_tps, Some(4000.0));
        assert_eq!(metric.draft_proposed, Some(40));
        assert_eq!(metric.outcome, "success");
    }

    #[test]
    fn dedupes_the_same_gateway_record() {
        // 采集按 24 小时窗口裁剪，样本必须落在窗口内，否则会被当过期记录丢掉。
        let started = (epoch_ms() as f64) / 1000.0 - 60.0;
        let value = sample_at(started);
        ingest_metrics(&value);
        ingest_metrics(&value);
        let snap = snapshot();
        assert_eq!(
            snap
                .requests
                .iter()
                .filter(|r| r.started_at == (started * 1000.0) as u64)
                .count(),
            1
        );
        clear();
    }
}
