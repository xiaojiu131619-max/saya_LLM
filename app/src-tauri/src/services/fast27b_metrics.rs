//! fast27b 真实引擎请求性能历史。
//!
//! 只接收经管理器代数校验的 stdout/stderr，不回扫人工启动日志、不发送探活请求。
//! 历史范围为最近 24 小时且最多 5000 条终态请求；活跃集合仅在当前应用会话内存在。
//! 解析和状态机不访问进程、GPU、网络或文件，持久化由独立后台线程合并写入。

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chrono::{Local, NaiveDateTime, TimeZone};
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::models::app_state::Fast27bModel;

const HISTORY_WINDOW_MS: u64 = 24 * 60 * 60 * 1000;
const HISTORY_LIMIT: usize = 5000;
// 引擎本身 max-concurrency=1；异常日志序列也不能令活跃集合或去重集合无限增长。
const ACTIVE_LIMIT: usize = 5000;
const MAX_ERROR_CHARS: usize = 512;
const MAX_PERSIST_BYTES: u64 = 16 * 1024 * 1024;
const WRITE_COALESCE: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Fast27bRequestOutcome {
    Success,
    Failed,
    Cancelled,
}

/// IPC 契约全部采用 snake_case；缺少引擎读数时保留 null，不推算 TTFT 或吞吐量。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Fast27bRequestMetric {
    pub id: String,
    pub request_id: u64,
    pub model: Fast27bModel,
    pub started_at: u64,
    pub finished_at: u64,
    pub outcome: Fast27bRequestOutcome,
    pub prompt_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub ttft_ms: Option<f64>,
    pub total_ms: Option<f64>,
    pub decode_tps: Option<f64>,
    pub prefill_tps: Option<f64>,
    pub cache_tokens: Option<u64>,
    pub draft_accepted: Option<u64>,
    pub draft_proposed: Option<u64>,
    /// done 原因为 `tool calls N` 时的工具调用次数；Some(>0) = 请求以工具调用收尾。
    /// 服务状态页「运行时间分布」工具行的数据源；旧持久化记录缺该字段时按 None 读入。
    #[serde(default)]
    pub tool_calls: Option<u64>,
    pub error: Option<String>,
}

/// 最近 24 小时、最多 5000 条终态请求（按完成时间从旧到新）；不附带图表汇总。
#[derive(Debug, Clone, Serialize)]
pub struct Fast27bMetricsSnapshot {
    pub collected_at: u64,
    pub active_requests: usize,
    pub requests: Vec<Fast27bRequestMetric>,
}

#[derive(Debug, Clone, Default, PartialEq)]
struct EngineReadings {
    prompt_tokens: Option<u64>,
    output_tokens: Option<u64>,
    ttft_ms: Option<f64>,
    total_ms: Option<f64>,
    decode_tps: Option<f64>,
    prefill_tps: Option<f64>,
    cache_tokens: Option<u64>,
    draft_accepted: Option<u64>,
    draft_proposed: Option<u64>,
}

impl EngineReadings {
    fn fill_missing(&self, metric: &mut Fast27bRequestMetric) {
        metric.prompt_tokens = metric.prompt_tokens.or(self.prompt_tokens);
        metric.output_tokens = metric.output_tokens.or(self.output_tokens);
        metric.ttft_ms = metric.ttft_ms.or(self.ttft_ms);
        metric.total_ms = metric.total_ms.or(self.total_ms);
        metric.decode_tps = metric.decode_tps.or(self.decode_tps);
        metric.prefill_tps = metric.prefill_tps.or(self.prefill_tps);
        metric.cache_tokens = metric.cache_tokens.or(self.cache_tokens);
        metric.draft_accepted = metric.draft_accepted.or(self.draft_accepted);
        metric.draft_proposed = metric.draft_proposed.or(self.draft_proposed);
    }
}

#[derive(Debug, Clone)]
enum RequestLogEvent {
    Started(u64),
    Terminal {
        request_id: u64,
        outcome: Fast27bRequestOutcome,
        readings: EngineReadings,
        /// done 原因为 `tool calls N` 时的调用次数（其余终态为 None）。
        tool_calls: Option<u64>,
        error: Option<String>,
    },
    WorkerCrash(String),
}

static ANSI_COLOUR: Lazy<Regex> = Lazy::new(|| Regex::new(r"\x1b\[[0-9;]*[A-Za-z]").unwrap());
static REQUEST_MARKER: Lazy<Regex> = Lazy::new(|| Regex::new(r"\breq#([0-9]+)\s+(.+)").unwrap());
static LOG_TIMESTAMP: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\b[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?").unwrap()
});
static DURATION_PART: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)([0-9]+(?:\.[0-9]+)?)\s*(ms|s|m|h)").unwrap());

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or_default()
}

fn short_error(text: &str) -> String {
    text.chars().take(MAX_ERROR_CHARS).collect()
}

fn log_epoch_ms(line: &str, fallback: u64) -> u64 {
    let plain = ANSI_COLOUR.replace_all(line, "");
    LOG_TIMESTAMP
        .find(&plain)
        .and_then(|matched| {
            NaiveDateTime::parse_from_str(matched.as_str(), "%Y-%m-%d %H:%M:%S%.f").ok()
        })
        .and_then(|time| Local.from_local_datetime(&time).earliest())
        .and_then(|time| u64::try_from(time.timestamp_millis()).ok())
        .unwrap_or(fallback)
}

fn parse_count(text: &str) -> Option<u64> {
    let token = text.split_whitespace().next()?;
    if !token.chars().all(|ch| ch.is_ascii_digit() || ch == ',') {
        return None;
    }
    token.replace(',', "").parse().ok()
}

/// 引擎 pretty duration 会输出 `393 ms`、`1.6s`、`1m 19.4s` 等格式。
fn parse_duration_ms(text: &str) -> Option<f64> {
    let text = text.trim();
    let mut end = 0;
    let mut value = 0.0;
    let mut found = false;
    for captures in DURATION_PART.captures_iter(text) {
        let matched = captures.get(0)?;
        if !text.get(end..matched.start())?.trim().is_empty() {
            return None;
        }
        let count = captures.get(1)?.as_str().parse::<f64>().ok()?;
        let factor = match captures.get(2)?.as_str().to_ascii_lowercase().as_str() {
            "ms" => 1.0,
            "s" => 1000.0,
            "m" => 60_000.0,
            "h" => 3_600_000.0,
            _ => return None,
        };
        value += count * factor;
        end = matched.end();
        found = true;
    }
    (found && text.get(end..)?.trim().is_empty() && value.is_finite()).then_some(value)
}

fn parse_rate(text: &str) -> Option<f64> {
    let token = text.strip_suffix(" tok/s")?.trim();
    let (number, factor) = if token.ends_with('k') || token.ends_with('K') {
        (&token[..token.len() - 1], 1000.0)
    } else if token.ends_with('m') || token.ends_with('M') {
        (&token[..token.len() - 1], 1_000_000.0)
    } else {
        (token, 1.0)
    };
    let value = number.replace(',', "").parse::<f64>().ok()? * factor;
    (value.is_finite() && value >= 0.0).then_some(value)
}

fn parse_readings(clauses: &[&str]) -> EngineReadings {
    let mut readings = EngineReadings::default();
    for clause in clauses {
        if let Some(value) = clause.strip_prefix("prompt ") {
            readings.prompt_tokens = parse_count(value);
        } else if let Some(value) = clause.strip_prefix("output ") {
            readings.output_tokens = parse_count(value);
        } else if let Some(value) = clause.strip_prefix("cache ") {
            readings.cache_tokens = parse_count(value);
        } else if let Some(value) = clause.strip_prefix("TTFT ") {
            readings.ttft_ms = parse_duration_ms(value);
        } else if let Some(value) = clause.strip_prefix("total ") {
            readings.total_ms = parse_duration_ms(value);
        } else if let Some(value) = clause.strip_prefix("decode ") {
            readings.decode_tps = parse_rate(value);
        } else if let Some(value) = clause.strip_prefix("prefill ") {
            readings.prefill_tps = parse_rate(value);
        } else if let Some(value) = clause
            .strip_prefix("dflash2 accepted ")
            .or_else(|| clause.strip_prefix("mtp accepted "))
        {
            if let Some((accepted, proposed)) = value
                .split_whitespace()
                .next()
                .and_then(|pair| pair.split_once('/'))
            {
                readings.draft_accepted = parse_count(accepted);
                readings.draft_proposed = parse_count(proposed);
            }
        }
    }
    readings
}

fn is_cancelled(text: &str) -> bool {
    text.contains("cancelled")
        || text.contains("canceled")
        || text.contains("HTTP 499")
        || text.contains("client disconnected")
        || text.contains("client_disconnected")
}

/// 仅接受引擎报告的实际完成原因；done/HTTP 200 自身不能证明生成成功。
fn completed_outcome(clauses: &[&str], readings: &EngineReadings) -> Fast27bRequestOutcome {
    let reason = clauses.get(2).copied().unwrap_or_default();
    if is_cancelled(reason) {
        return Fast27bRequestOutcome::Cancelled;
    }
    let completed = matches!(
        reason,
        "stop token" | "stop string" | "output limit" | "context capacity"
    ) || tool_call_count(clauses).is_some_and(|count| count > 0);
    if completed
        && readings.prompt_tokens.is_some()
        && readings.output_tokens.is_some()
        && readings.total_ms.is_some()
    {
        Fast27bRequestOutcome::Success
    } else {
        Fast27bRequestOutcome::Failed
    }
}

/// done 原因 `tool calls N`（工具循环收尾）里的调用次数。
fn tool_call_count(clauses: &[&str]) -> Option<u64> {
    clauses
        .iter()
        .find_map(|clause| clause.strip_prefix("tool calls "))
        .and_then(parse_count)
}

fn parse_request_log(line: &str) -> Option<RequestLogEvent> {
    let plain = ANSI_COLOUR.replace_all(line, "");
    let line = plain.trim();
    // 人工启动/状态说明不会进入采集入口；额外拒绝应用日志，避免未来接线误用。
    if line.starts_with("[fast27b]") {
        return None;
    }
    if line.contains("worker crash") || line.contains("Paged KV reservation invariant was violated")
    {
        return Some(RequestLogEvent::WorkerCrash(short_error(line)));
    }
    let captures = REQUEST_MARKER.captures(line)?;
    let request_id = captures.get(1)?.as_str().parse::<u64>().ok()?;
    let action = captures.get(2)?.as_str();
    if action.starts_with("started |") {
        return Some(RequestLogEvent::Started(request_id));
    }
    if action.starts_with("done |") {
        let clauses: Vec<_> = action.split('|').map(str::trim).collect();
        let readings = parse_readings(&clauses);
        let outcome = completed_outcome(&clauses, &readings);
        let error = match outcome {
            Fast27bRequestOutcome::Success => None,
            Fast27bRequestOutcome::Cancelled => Some("引擎报告请求已取消。".to_string()),
            Fast27bRequestOutcome::Failed => Some(format!(
                "引擎 done 未报告有效完成原因或完整读数：{}",
                short_error(clauses.get(2).copied().unwrap_or_default())
            )),
        };
        return Some(RequestLogEvent::Terminal {
            request_id,
            outcome,
            readings,
            tool_calls: tool_call_count(&clauses).filter(|count| *count > 0),
            error,
        });
    }
    if action.starts_with("failed during ")
        || action.starts_with("rejected during ")
        || action.starts_with("response failed during ")
        || action.starts_with("cancelled")
        || action.starts_with("canceled")
    {
        return Some(RequestLogEvent::Terminal {
            request_id,
            outcome: if is_cancelled(action) {
                Fast27bRequestOutcome::Cancelled
            } else {
                Fast27bRequestOutcome::Failed
            },
            readings: EngineReadings::default(),
            tool_calls: None,
            error: Some(short_error(line)),
        });
    }
    None
}

#[derive(Debug)]
struct GenerationContext {
    number: u32,
    model: Fast27bModel,
    worker_failure: Option<String>,
}

/// 有界纯状态：终态历史 5000、活跃请求 5000、当前代数终态去重 5000。
/// 去重集合被压缩淘汰后，水位以下的旧日志仍不会重新计数；新代数有独立请求编号。
#[derive(Debug)]
struct MetricsState {
    session: String,
    generation: Option<GenerationContext>,
    active: BTreeMap<u64, u64>,
    closed: BTreeSet<u64>,
    closed_through: Option<u64>,
    history: VecDeque<Fast27bRequestMetric>,
    revision: u64,
}

impl MetricsState {
    fn new(session: String) -> Self {
        Self {
            session,
            generation: None,
            active: BTreeMap::new(),
            closed: BTreeSet::new(),
            closed_through: None,
            history: VecDeque::new(),
            revision: 0,
        }
    }

    fn begin_generation(&mut self, number: u32, model: Fast27bModel, now: u64) -> bool {
        let changed = self.finish_active(
            Fast27bRequestOutcome::Failed,
            "旧引擎已退出或被重启，请求未完成。",
            now,
        );
        self.generation = Some(GenerationContext {
            number,
            model,
            worker_failure: None,
        });
        self.active.clear();
        self.closed.clear();
        self.closed_through = None;
        self.prune(now);
        changed
    }

    fn prune(&mut self, now: u64) {
        let cutoff = now.saturating_sub(HISTORY_WINDOW_MS);
        self.history.retain(|metric| metric.finished_at >= cutoff);
        while self.history.len() > HISTORY_LIMIT {
            self.history.pop_front();
        }
    }

    fn already_closed(&self, request_id: u64) -> bool {
        self.closed.contains(&request_id)
            || self
                .closed_through
                .is_some_and(|watermark| request_id <= watermark)
    }

    fn remember_closed(&mut self, request_id: u64) {
        self.closed.insert(request_id);
        while self.closed.len() > HISTORY_LIMIT {
            if let Some(first) = self.closed.iter().next().copied() {
                self.closed.remove(&first);
                self.closed_through = Some(self.closed_through.unwrap_or_default().max(first));
            }
        }
    }

    fn terminal(
        &mut self,
        request_id: u64,
        outcome: Fast27bRequestOutcome,
        readings: EngineReadings,
        tool_calls: Option<u64>,
        error: Option<String>,
        at: u64,
        now: u64,
    ) -> bool {
        let Some(generation) = self.generation.as_ref() else {
            return false;
        };
        let id = format!("{}:{}:{}", self.session, generation.number, request_id);
        let model = generation.model;
        let worker_failure = generation.worker_failure.clone();
        let (outcome, error) =
            if outcome == Fast27bRequestOutcome::Success && worker_failure.is_some() {
                (Fast27bRequestOutcome::Failed, worker_failure)
            } else {
                (outcome, error)
            };
        if self.already_closed(request_id) && !self.active.contains_key(&request_id) {
            let Some(metric) = self.history.iter_mut().find(|metric| metric.id == id) else {
                return false;
            };
            let previous = metric.clone();
            // failed/cancelled 永不被后到的 done 翻回 success；响应传输错误可降级先到的 success。
            if metric.outcome == Fast27bRequestOutcome::Success
                && outcome != Fast27bRequestOutcome::Success
            {
                metric.outcome = outcome;
                metric.error = error;
            }
            readings.fill_missing(metric);
            metric.tool_calls = metric.tool_calls.or(tool_calls);
            return *metric != previous;
        }
        // prepare 失败可能没有 started。只移除真实存在的活跃项，不做减一计数。
        let started_at = self.active.remove(&request_id).unwrap_or(at);
        self.remember_closed(request_id);
        let mut metric = Fast27bRequestMetric {
            id,
            request_id,
            model,
            started_at,
            finished_at: at.max(started_at),
            outcome,
            prompt_tokens: None,
            output_tokens: None,
            ttft_ms: None,
            total_ms: None,
            decode_tps: None,
            prefill_tps: None,
            cache_tokens: None,
            draft_accepted: None,
            draft_proposed: None,
            tool_calls,
            error,
        };
        readings.fill_missing(&mut metric);
        let position = self
            .history
            .iter()
            .position(|existing| existing.finished_at > metric.finished_at)
            .unwrap_or(self.history.len());
        self.history.insert(position, metric);
        self.prune(now);
        true
    }

    fn finish_active(&mut self, outcome: Fast27bRequestOutcome, error: &str, now: u64) -> bool {
        let requests: Vec<_> = self.active.keys().copied().collect();
        let mut changed = false;
        for request_id in requests {
            changed |= self.terminal(
                request_id,
                outcome,
                EngineReadings::default(),
                None,
                Some(short_error(error)),
                now,
                now,
            );
        }
        changed
    }

    fn finish_generation(
        &mut self,
        number: u32,
        outcome: Fast27bRequestOutcome,
        error: &str,
        now: u64,
    ) -> bool {
        if self.generation.as_ref().map(|generation| generation.number) != Some(number) {
            return false;
        }
        let changed = self.finish_active(outcome, error, now);
        self.generation = None;
        self.active.clear();
        changed
    }

    fn ingest(&mut self, number: u32, line: &str, now: u64) -> bool {
        if self.generation.as_ref().map(|generation| generation.number) != Some(number) {
            return false;
        }
        self.prune(now);
        let Some(event) = parse_request_log(line) else {
            return false;
        };
        let at = log_epoch_ms(line, now);
        match event {
            RequestLogEvent::Started(request_id) => {
                if self.already_closed(request_id) || self.active.contains_key(&request_id) {
                    return false;
                }
                if let Some(error) = self
                    .generation
                    .as_ref()
                    .and_then(|generation| generation.worker_failure.clone())
                {
                    return self.terminal(
                        request_id,
                        Fast27bRequestOutcome::Failed,
                        EngineReadings::default(),
                        None,
                        Some(error),
                        at,
                        now,
                    );
                }
                if self.active.len() < ACTIVE_LIMIT {
                    self.active.insert(request_id, at);
                }
                false
            }
            RequestLogEvent::Terminal {
                request_id,
                outcome,
                readings,
                tool_calls,
                error,
            } => self.terminal(request_id, outcome, readings, tool_calls, error, at, now),
            RequestLogEvent::WorkerCrash(error) => {
                if let Some(generation) = self.generation.as_mut() {
                    generation.worker_failure = Some(error.clone());
                }
                // 不为 worker 自身虚构请求；仅终止已有 req# started 的真实活跃请求。
                let requests: Vec<_> = self.active.keys().copied().collect();
                let mut changed = false;
                for request_id in requests {
                    changed |= self.terminal(
                        request_id,
                        Fast27bRequestOutcome::Failed,
                        EngineReadings::default(),
                        None,
                        Some(error.clone()),
                        at,
                        now,
                    );
                }
                changed
            }
        }
    }

    fn snapshot(&mut self, now: u64) -> Fast27bMetricsSnapshot {
        self.prune(now);
        Fast27bMetricsSnapshot {
            collected_at: now,
            active_requests: self.active.len(),
            requests: self.history.iter().cloned().collect(),
        }
    }

    fn from_json(session: String, json: &str, now: u64) -> Result<Self, String> {
        let mut saved: PersistedHistory =
            serde_json::from_str(json).map_err(|error| error.to_string())?;
        if saved.version != 1 {
            return Err("请求性能历史版本不受支持".to_string());
        }
        let cutoff = now.saturating_sub(HISTORY_WINDOW_MS);
        saved.requests.retain(|metric| {
            !metric.id.is_empty()
                && metric.id.len() <= 128
                && metric.started_at <= metric.finished_at
                && metric.finished_at >= cutoff
                && [
                    metric.ttft_ms,
                    metric.total_ms,
                    metric.decode_tps,
                    metric.prefill_tps,
                ]
                .iter()
                .flatten()
                .all(|value| value.is_finite() && *value >= 0.0)
        });
        saved.requests.sort_by_key(|metric| metric.finished_at);
        if saved.requests.len() > HISTORY_LIMIT {
            saved.requests.drain(..saved.requests.len() - HISTORY_LIMIT);
        }
        let mut ids = BTreeSet::new();
        saved
            .requests
            .retain(|metric| ids.insert(metric.id.clone()));
        for metric in &mut saved.requests {
            metric.error = metric.error.as_deref().map(short_error);
        }
        let mut state = Self::new(session);
        state.history = saved.requests.into();
        // 持久化不含活跃集合、代数或去重集合，应用重启不会伪造仍在执行的请求。
        Ok(state)
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct PersistedHistory {
    version: u32,
    requests: Vec<Fast27bRequestMetric>,
}

impl PersistedHistory {
    fn from_state(state: &MetricsState) -> Self {
        Self {
            version: 1,
            requests: state.history.iter().cloned().collect(),
        }
    }
}

struct Persistence {
    path: Option<PathBuf>,
    saved_revision: u64,
    warned: bool,
}

struct MetricsService {
    state: Arc<Mutex<MetricsState>>,
    persistence: Arc<Mutex<Persistence>>,
    wake: Option<SyncSender<()>>,
}

fn metrics_file_path() -> Option<PathBuf> {
    // 复用 config.json 的应用数据根目录；无系统数据目录时只保留内存，禁止回退到仓库 CWD。
    dirs::data_dir()
        .filter(|directory| directory.is_absolute())
        .map(|_| {
            crate::commands::config::get_app_data_root()
                .join("fast27b")
                .join("request_metrics.json")
        })
}

fn load_history(path: &Path, session: String, now: u64) -> Result<MetricsState, String> {
    let mut json = String::new();
    std::fs::File::open(path)
        .map_err(|error| error.to_string())?
        .take(MAX_PERSIST_BYTES + 1)
        .read_to_string(&mut json)
        .map_err(|error| error.to_string())?;
    if json.len() as u64 > MAX_PERSIST_BYTES {
        return Err("请求性能历史超过文件大小上限".to_string());
    }
    MetricsState::from_json(session, &json, now)
}

fn write_history(path: &Path, saved: &PersistedHistory) -> Result<(), String> {
    let json = serde_json::to_vec(saved).map_err(|error| error.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary = path.with_extension("json.tmp");
    let mut file = std::fs::File::create(&temporary).map_err(|error| error.to_string())?;
    file.write_all(&json)
        .and_then(|_| file.sync_all())
        .map_err(|error| error.to_string())?;
    drop(file);
    std::fs::rename(&temporary, path).map_err(|error| error.to_string())
}

fn persist_pending(state: &Mutex<MetricsState>, persistence: &Mutex<Persistence>) {
    // 写锁与快照锁独立；克隆终态历史后释放状态锁，再执行序列化与磁盘 I/O。
    // 后台合并写入和应用退出 flush 共用写锁，旧快照不能覆盖更新的退出快照。
    let Ok(mut persistence) = persistence.lock() else {
        return;
    };
    let Some(path) = persistence.path.clone() else {
        return;
    };
    let (revision, saved) = {
        let Ok(mut state) = state.lock() else {
            return;
        };
        if state.revision == persistence.saved_revision {
            return;
        }
        state.prune(epoch_ms());
        (state.revision, PersistedHistory::from_state(&state))
    };
    match write_history(&path, &saved) {
        Ok(()) => {
            persistence.saved_revision = revision;
            persistence.warned = false;
        }
        Err(error) => {
            if !persistence.warned {
                // 不经 add_fast27b_log / ingest，写失败不影响引擎也不递归产生采集事件。
                log::warn!("[fast27b] 请求性能历史写入失败：{}", short_error(&error));
                persistence.warned = true;
            }
        }
    }
}

impl MetricsService {
    fn new() -> Self {
        let now = epoch_ms();
        let session = format!(
            "{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        let path = metrics_file_path();
        let state = match path.as_ref().filter(|path| path.exists()) {
            Some(path) => match load_history(path, session.clone(), now) {
                Ok(state) => state,
                Err(error) => {
                    log::warn!("[fast27b] 请求性能历史读取失败：{}", short_error(&error));
                    MetricsState::new(session)
                }
            },
            None => MetricsState::new(session),
        };
        if path.is_none() {
            log::warn!("[fast27b] 未找到应用数据目录，请求性能历史暂存于内存。");
        }
        let state = Arc::new(Mutex::new(state));
        let persistence = Arc::new(Mutex::new(Persistence {
            path,
            saved_revision: 0,
            warned: false,
        }));
        let (wake, receiver) = sync_channel(1);
        let writer_state = state.clone();
        let writer_persistence = persistence.clone();
        let writer = std::thread::Builder::new()
            .name("fast27b-metrics".to_string())
            .spawn(move || {
                while receiver.recv().is_ok() {
                    std::thread::sleep(WRITE_COALESCE);
                    while receiver.try_recv().is_ok() {}
                    persist_pending(&writer_state, &writer_persistence);
                }
            });
        let wake = match writer {
            Ok(_) => Some(wake),
            Err(error) => {
                log::warn!(
                    "[fast27b] 请求性能历史后台写入线程未启动：{}",
                    short_error(&error.to_string())
                );
                None
            }
        };
        Self {
            state,
            persistence,
            wake,
        }
    }

    fn update(&self, update: impl FnOnce(&mut MetricsState, u64) -> bool) {
        let changed = {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            let changed = update(&mut state, epoch_ms());
            if changed {
                state.revision = state.revision.saturating_add(1);
            }
            changed
        };
        if changed {
            if let Some(wake) = &self.wake {
                // 容量为 1 的唤醒队列：重复日志及吞吐量启动行均不排队写全文件。
                let _ = wake.try_send(());
            }
        }
    }
}

static METRICS: Lazy<MetricsService> = Lazy::new(MetricsService::new);

/// 应用启动时加载终态历史，避免首个 snapshot 在热路径读取磁盘。
pub fn initialize() {
    Lazy::force(&METRICS);
}

pub fn begin_generation(generation: u32, model: Fast27bModel) {
    METRICS.update(|state, now| state.begin_generation(generation, model, now));
}

pub fn ingest_engine_log_line(line: &str, generation: u32) {
    METRICS.update(|state, now| state.ingest(generation, line, now));
}

pub fn finish_generation(generation: u32, outcome: Fast27bRequestOutcome, error: &str) {
    METRICS.update(|state, now| state.finish_generation(generation, outcome, error, now));
}

/// 与运行态/配置锁和网络探活无关，读取纯内存快照。
pub fn snapshot() -> Fast27bMetricsSnapshot {
    let now = epoch_ms();
    METRICS
        .state
        .lock()
        .map(|mut state| state.snapshot(now))
        .unwrap_or(Fast27bMetricsSnapshot {
            collected_at: now,
            active_requests: 0,
            requests: Vec::new(),
        })
}

/// 正常应用退出时同步保留最后的取消/失败请求，仍不把活跃集合写入磁盘。
pub fn flush_on_exit() {
    persist_pending(&METRICS.state, &METRICS.persistence);
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 2_000_000_000_000;
    const START: &str = "req#1 started | openai-chat stream | 2 messages | max output 32,768 | thinking high, budget 8,192";
    const DONE: &str = "req#1 done | openai-chat | stop token | prompt 3,360 | output 74 | cache 1,433 (42.6%, private endpoint) | TTFT 1.6s | total 1.9s | prefill 2.14k tok/s | decode 215.2 tok/s | dflash2 accepted 54/84 (64.3%)";

    fn state(model: Fast27bModel) -> MetricsState {
        let mut state = MetricsState::new("session-one".to_string());
        state.begin_generation(1, model, NOW);
        state
    }

    #[test]
    fn parses_explicit_ms_seconds_minutes_and_k_rates() {
        let mut state = state(Fast27bModel::Heretic);
        assert!(!state.ingest(1, START, NOW));
        assert!(state.ingest(1, DONE, NOW + 1900));
        let metric = &state.history[0];
        assert_eq!(metric.ttft_ms, Some(1600.0));
        assert_eq!(metric.total_ms, Some(1900.0));
        assert_eq!(metric.prefill_tps, Some(2140.0));
        assert_eq!(metric.decode_tps, Some(215.2));
        assert_eq!(metric.prompt_tokens, Some(3360));
        assert_eq!(metric.output_tokens, Some(74));
        assert_eq!(metric.cache_tokens, Some(1433));
        assert_eq!(
            (metric.draft_accepted, metric.draft_proposed),
            (Some(54), Some(84))
        );
        assert_eq!(metric.started_at, NOW);
        assert_eq!(metric.finished_at, NOW + 1900);
        assert_eq!(parse_duration_ms("393 ms"), Some(393.0));
        assert_eq!(parse_duration_ms("1m 19.4s"), Some(79400.0));
        assert_eq!(parse_duration_ms("1h 2m 3s"), Some(3723000.0));
        assert_eq!(parse_duration_ms("unknown"), None);
        assert_eq!(parse_duration_ms("1.2s invalid"), None);
        assert_eq!(parse_rate("NaN tok/s"), None);
        assert_eq!(parse_rate("-1 tok/s"), None);
    }

    #[test]
    fn saluki_mtp_and_nullable_missing_readings() {
        let mut state = state(Fast27bModel::Saluki);
        let line = "req#1 done | openai-chat | output limit | prompt 1,612 | output 957 | TTFT 500 ms | total 6.3s | decode 1.20k tok/s | mtp accepted 698/1,032 (67.6%)";
        assert!(state.ingest(1, line, NOW));
        let metric = &state.history[0];
        assert_eq!(metric.model, Fast27bModel::Saluki);
        assert_eq!(metric.outcome, Fast27bRequestOutcome::Success);
        assert_eq!(metric.ttft_ms, Some(500.0));
        assert_eq!(metric.decode_tps, Some(1200.0));
        assert_eq!(metric.prefill_tps, None);
        assert_eq!(metric.cache_tokens, None);
        assert_eq!(
            (metric.draft_accepted, metric.draft_proposed),
            (Some(698), Some(1032))
        );
        assert_eq!(state.snapshot(NOW).active_requests, 0);
    }

    #[test]
    fn duplicate_stdout_stderr_and_terminal_lines_count_once() {
        let mut state = state(Fast27bModel::Heretic);
        state.ingest(1, START, NOW);
        state.ingest(1, START, NOW + 1);
        assert_eq!(state.snapshot(NOW).active_requests, 1);
        assert!(state.ingest(1, DONE, NOW + 1900));
        assert!(!state.ingest(1, DONE, NOW + 1901));
        assert!(!state.ingest(1, START, NOW + 1902));
        assert_eq!(state.snapshot(NOW + 1902).active_requests, 0);
        assert_eq!(state.history.len(), 1);
    }

    #[test]
    fn restart_req_one_has_independent_identity_and_old_generation_is_ignored() {
        let mut state = state(Fast27bModel::Heretic);
        state.ingest(1, DONE, NOW);
        let first_id = state.history[0].id.clone();
        state.begin_generation(3, Fast27bModel::Saluki, NOW + 1);
        assert!(!state.ingest(1, START, NOW + 2));
        state.ingest(3, START, NOW + 3);
        state.ingest(3, DONE, NOW + 1903);
        assert_eq!(state.history.len(), 2);
        assert_ne!(state.history[1].id, first_id);
        assert_eq!(state.history[1].model, Fast27bModel::Saluki);
    }

    #[test]
    fn prepare_and_generation_failure_stay_failed_after_done() {
        for failure in [
            "req#1 failed during prepare | openai-chat stream | HTTP 503 | service unavailable",
            "req#1 failed during generation | openai-chat | HTTP 500 | internal error",
            "req#1 rejected during prepare | openai-chat | HTTP 400 | invalid request",
        ] {
            let mut state = state(Fast27bModel::Heretic);
            assert!(state.ingest(1, failure, NOW));
            assert!(!state.ingest(1, failure, NOW + 1));
            assert_eq!(state.snapshot(NOW).active_requests, 0);
            assert!(state.ingest(1, DONE, NOW + 1900));
            assert_eq!(state.history.len(), 1);
            assert_eq!(state.history[0].outcome, Fast27bRequestOutcome::Failed);
            assert_eq!(state.history[0].ttft_ms, Some(1600.0));
            assert_eq!(state.history[0].error.as_deref(), Some(failure));
            assert!(!state.ingest(1, DONE, NOW + 1901));
        }
    }

    #[test]
    fn tool_call_done_reason_records_call_count_for_timeline() {
        let mut state = state(Fast27bModel::Heretic);
        state.ingest(1, START, NOW);
        assert!(state.ingest(1, &DONE.replace("stop token", "tool calls 3"), NOW + 1900));
        let metric = &state.history[0];
        assert_eq!(metric.outcome, Fast27bRequestOutcome::Success);
        assert_eq!(metric.tool_calls, Some(3));

        // 普通完成不携带工具调用数。
        let mut state = super::tests::state(Fast27bModel::Heretic);
        state.ingest(1, DONE, NOW);
        assert_eq!(state.history[0].tool_calls, None);

        // 「tool calls 0」不是有效的工具调用收尾，也不计次数。
        let mut state = super::tests::state(Fast27bModel::Heretic);
        state.ingest(1, &DONE.replace("stop token", "tool calls 0"), NOW);
        assert_eq!(state.history[0].outcome, Fast27bRequestOutcome::Failed);
        assert_eq!(state.history[0].tool_calls, None);
    }

    #[test]
    fn cancellation_never_counts_as_success_in_either_stream_order() {
        let cancellation =
            "req#1 response failed during transport | HTTP 499 | client disconnected";
        for done_first in [false, true] {
            let mut state = state(Fast27bModel::Heretic);
            state.ingest(1, START, NOW);
            if done_first {
                state.ingest(1, DONE, NOW + 1900);
            }
            state.ingest(1, cancellation, NOW + 1901);
            state.ingest(1, DONE, NOW + 1902);
            assert_eq!(state.history.len(), 1);
            assert_eq!(state.history[0].outcome, Fast27bRequestOutcome::Cancelled);
            assert_eq!(state.snapshot(NOW + 1902).active_requests, 0);
        }
        let mut state = state(Fast27bModel::Heretic);
        let done_cancelled = DONE.replace("stop token", "cancelled");
        state.ingest(1, &done_cancelled, NOW);
        assert_eq!(state.history[0].outcome, Fast27bRequestOutcome::Cancelled);
        let mut state = super::tests::state(Fast27bModel::Heretic);
        state.ingest(
            1,
            "req#1 cancelled during generation | openai-chat | HTTP 499",
            NOW,
        );
        state.ingest(1, DONE, NOW + 1);
        assert_eq!(state.history[0].outcome, Fast27bRequestOutcome::Cancelled);
    }

    #[test]
    fn worker_crash_fails_active_requests_without_inventing_requests() {
        let crash = "ERROR engine | worker crash: Paged KV reservation invariant was violated";
        let mut state = state(Fast27bModel::Heretic);
        assert!(!state.ingest(1, crash, NOW));
        assert!(state.history.is_empty());
        state.begin_generation(2, Fast27bModel::Saluki, NOW);
        state.ingest(2, START, NOW);
        state.ingest(2, crash, NOW + 1);
        state.ingest(2, DONE, NOW + 1900);
        assert_eq!(state.snapshot(NOW + 1900).active_requests, 0);
        assert_eq!(state.history.len(), 1);
        assert_eq!(state.history[0].outcome, Fast27bRequestOutcome::Failed);
        assert_eq!(state.history[0].ttft_ms, Some(1600.0));
    }

    #[test]
    fn stop_exit_and_restart_only_finish_real_active_requests() {
        for outcome in [
            Fast27bRequestOutcome::Cancelled,
            Fast27bRequestOutcome::Failed,
        ] {
            let mut state = state(Fast27bModel::Heretic);
            state.ingest(1, START, NOW);
            state.ingest(1, "req#2 failed during prepare | HTTP 503", NOW);
            assert_eq!(state.snapshot(NOW).active_requests, 1);
            assert!(!state.finish_generation(99, outcome, "过期退出", NOW));
            assert!(state.finish_generation(1, outcome, "引擎已停止", NOW + 1));
            assert!(!state.ingest(1, DONE, NOW + 2));
            assert_eq!(state.snapshot(NOW + 2).active_requests, 0);
            assert_eq!(state.history.len(), 2);
            assert_eq!(state.history.back().unwrap().outcome, outcome);
        }
        let mut state = state(Fast27bModel::Heretic);
        state.ingest(1, START, NOW);
        assert!(state.begin_generation(2, Fast27bModel::Saluki, NOW + 1));
        assert_eq!(state.history[0].outcome, Fast27bRequestOutcome::Failed);
    }

    #[test]
    fn drained_stop_keeps_completed_readings_and_cancels_only_remaining_active() {
        let mut state = state(Fast27bModel::Heretic);
        for request_id in 1..=4 {
            state.ingest(
                1,
                &START.replace("req#1 ", &format!("req#{request_id} ")),
                NOW,
            );
        }
        // 运行事件代数已经失效，但指标代数保持到管道排空，真实终态应先于兜底取消。
        state.ingest(1, DONE, NOW + 1900);
        state.ingest(1, &DONE.replace("req#1 ", "req#2 "), NOW + 1901);
        state.ingest(
            1,
            "req#2 response failed during transport | HTTP 500 | internal error",
            NOW + 1902,
        );
        state.ingest(
            1,
            "req#3 response failed during transport | HTTP 499 | client disconnected",
            NOW + 1903,
        );
        state.finish_generation(
            1,
            Fast27bRequestOutcome::Cancelled,
            "引擎已停止",
            NOW + 2000,
        );
        assert_eq!(state.history.len(), 4);
        let first = state
            .history
            .iter()
            .find(|metric| metric.request_id == 1)
            .unwrap();
        assert_eq!(first.outcome, Fast27bRequestOutcome::Success);
        assert_eq!(first.decode_tps, Some(215.2));
        let second = state
            .history
            .iter()
            .find(|metric| metric.request_id == 2)
            .unwrap();
        assert_eq!(second.outcome, Fast27bRequestOutcome::Failed);
        assert_eq!(second.ttft_ms, Some(1600.0));
        let third = state
            .history
            .iter()
            .find(|metric| metric.request_id == 3)
            .unwrap();
        assert_eq!(third.outcome, Fast27bRequestOutcome::Cancelled);
        let remaining = state
            .history
            .iter()
            .find(|metric| metric.request_id == 4)
            .unwrap();
        assert_eq!(remaining.outcome, Fast27bRequestOutcome::Cancelled);
        assert_eq!(remaining.error.as_deref(), Some("引擎已停止"));
        assert_eq!(state.snapshot(NOW + 2000).active_requests, 0);
        assert!(!state.ingest(1, DONE, NOW + 2001));
        let json = serde_json::to_string(&PersistedHistory::from_state(&state)).unwrap();
        let restored = MetricsState::from_json("session-two".into(), &json, NOW + 2001).unwrap();
        assert_eq!(restored.history, state.history);
        state.begin_generation(3, Fast27bModel::Saluki, NOW + 2002);
        assert!(!state.ingest(1, DONE, NOW + 2003));
        state.ingest(3, DONE, NOW + 2004);
        assert_eq!(state.history.len(), 5);
        assert_eq!(state.history.back().unwrap().model, Fast27bModel::Saluki);
    }

    #[test]
    fn incomplete_done_and_unrelated_logs_cannot_be_success() {
        let mut state = state(Fast27bModel::Heretic);
        for line in [
            "[fast27b] 启动：req#1 started | 人工说明",
            "engine ready | bonsai2 | total 6.6s",
            "throughput | 5.0s | decode 140 tok/s | running 1",
            "prompt 10 | output 20 | TTFT 50 ms | total 1s",
        ] {
            assert!(!state.ingest(1, line, NOW));
        }
        assert!(state.history.is_empty());
        assert_eq!(state.active.len(), 0);
        for line in [
            "req#1 done | openai-chat | none | prompt 1 | output 1 | total 1s",
            "req#2 done | openai-chat | stop token",
        ] {
            state.ingest(1, line, NOW);
        }
        assert!(state
            .history
            .iter()
            .all(|metric| metric.outcome == Fast27bRequestOutcome::Failed));
        state.ingest(
            1,
            "req#3 done | openai-chat | tool calls 1 | prompt 1 | output 1 | total 1s",
            NOW,
        );
        assert_eq!(
            state.history.back().unwrap().outcome,
            Fast27bRequestOutcome::Success
        );
    }

    #[test]
    fn rolling_24_hours_and_count_cap_are_bounded_and_deduplicated() {
        let mut state = state(Fast27bModel::Heretic);
        state.ingest(1, DONE, NOW - HISTORY_WINDOW_MS);
        assert_eq!(state.snapshot(NOW).requests.len(), 1);
        assert!(state.snapshot(NOW + 1).requests.is_empty());
        assert!(!state.ingest(1, DONE, NOW + 1));
        for request_id in 2..HISTORY_LIMIT as u64 + 4 {
            state.ingest(
                1,
                &DONE.replace("req#1 ", &format!("req#{request_id} ")),
                NOW + request_id,
            );
        }
        assert_eq!(state.history.len(), HISTORY_LIMIT);
        assert!(state.closed.len() <= HISTORY_LIMIT);
        assert!(!state.ingest(1, DONE, NOW + 6000));
        assert_eq!(state.history.len(), HISTORY_LIMIT);
        assert_eq!(
            state
                .snapshot(NOW + HISTORY_WINDOW_MS + 6000)
                .requests
                .len(),
            0
        );
    }

    #[test]
    fn persistence_roundtrip_keeps_terminal_history_but_not_active_requests() {
        let mut original = state(Fast27bModel::Heretic);
        original.ingest(1, DONE, NOW);
        original.ingest(1, "req#2 started | openai-chat stream | 1 message", NOW + 1);
        let json = serde_json::to_string(&PersistedHistory::from_state(&original)).unwrap();
        assert!(!json.contains("active"));
        let mut restored = MetricsState::from_json("session-two".into(), &json, NOW + 2).unwrap();
        assert_eq!(restored.snapshot(NOW + 2).active_requests, 0);
        assert_eq!(restored.history, original.history);
        restored.begin_generation(1, Fast27bModel::Saluki, NOW + 3);
        restored.ingest(1, DONE, NOW + 4);
        assert_eq!(restored.history.len(), 2);
        assert_ne!(restored.history[0].id, restored.history[1].id);
        let expired =
            MetricsState::from_json("session-three".into(), &json, NOW + HISTORY_WINDOW_MS + 1)
                .unwrap();
        assert!(expired.history.is_empty());
        assert!(MetricsState::from_json("session-three".into(), "not json", NOW).is_err());
    }

    #[test]
    fn epoch_timestamp_and_ansi_logs_are_supported() {
        let log = format!("\x1b[32m2026-10-13 02:26:37.346  INFO  {DONE}\x1b[0m");
        let expected = Local
            .with_ymd_and_hms(2026, 10, 13, 2, 26, 37)
            .earliest()
            .unwrap()
            .timestamp_millis() as u64
            + 346;
        let at = log_epoch_ms(&log, NOW);
        assert_eq!(at, expected, "必须从引擎原始时间戳读取，不能回退到采集时间");
        assert_eq!(
            log_epoch_ms("[2026-10-13 02:26:37.346] INFO req#1 done", NOW),
            expected
        );
        assert_eq!(
            log_epoch_ms("2026-10-13 02:26:37 INFO req#1 done", NOW),
            expected - 346
        );
        assert_eq!(log_epoch_ms("没有时间戳的中文日志", NOW), NOW);
        let mut state = state(Fast27bModel::Heretic);
        state.ingest(1, &log, at);
        assert_eq!(state.history[0].finished_at, at);
        assert_eq!(state.history[0].outcome, Fast27bRequestOutcome::Success);
    }

    #[test]
    fn snapshot_serialization_matches_snake_case_contract() {
        let mut state = state(Fast27bModel::Heretic);
        state.ingest(1, DONE, NOW);
        let snapshot = serde_json::to_value(state.snapshot(NOW)).unwrap();
        let object = snapshot.as_object().unwrap();
        assert_eq!(object.len(), 3);
        assert!(object.contains_key("collected_at"));
        assert!(object.contains_key("active_requests"));
        let metric = snapshot["requests"][0].as_object().unwrap();
        assert_eq!(metric.len(), 17);
        for key in [
            "id",
            "request_id",
            "model",
            "started_at",
            "finished_at",
            "outcome",
            "prompt_tokens",
            "output_tokens",
            "ttft_ms",
            "total_ms",
            "decode_tps",
            "prefill_tps",
            "cache_tokens",
            "draft_accepted",
            "draft_proposed",
            "tool_calls",
            "error",
        ] {
            assert!(metric.contains_key(key), "缺少字段 {key}");
        }
        assert_eq!(metric["model"], "heretic");
        assert_eq!(metric["outcome"], "success");
        assert!(metric["error"].is_null());
    }
}
