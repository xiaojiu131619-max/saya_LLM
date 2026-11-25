//! Pi 文件改动检查点：改动前备份 + unified diff + 一键回滚。
//!
//! 与权限层互补：权限决定「能不能改」，这里记录「改了什么、怎么退回去」。
//! `write_file` / `edit_file` 每次成功落盘前，把原始内容备份到
//! `<pi data>/checkpoints/<changeSetId>/`，并把行级 diff 通过 `pi:file-changes`
//! 事件推给前端（聊天气泡里的「文件改动」卡片）。
//!
//! - **每次任务轮次一个 changeSetId**：气泡卡片按轮次展示/回滚，检查点也按轮次记录；
//!   同一文件在同一轮内只备份**本轮开始时**的原文件，回滚语义是「恢复到本轮开始前」；
//! - 备份留在数据目录里，不污染用户的工作区；历史检查点只保留最近 N 轮。
//!
//! 回滚由前端在确认后调用 [`rollback_set`]：created 的文件删除、modified 的
//! 文件用备份覆盖。清单完全从磁盘重建（meta.json + changes.jsonl），
//! 路径以记录时的工作区为根重新校验，不信任前端传来的任何路径。

use std::collections::HashMap;
use std::io::BufRead;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::services::pi_agent;

/// 单侧文本超过这个长度就不生成 diff（备份照常）。
const MAX_DIFF_CHARS: usize = 256 * 1024;
/// diff 的行级 LCS 输入上限：超过按整文件替换处理，避免 O(n·m) 爆内存。
const MAX_DIFF_LINES: usize = 5000;
/// 数据目录里最多保留多少轮任务的检查点。
const KEEP_CHANGE_SETS: usize = 20;

/// 检查点根目录：`<pi data>/checkpoints/`。
fn checkpoint_root() -> PathBuf {
    pi_agent::pi_data_root().join("checkpoints")
}

/// 一次任务轮次的改动集合。每次 prompt 发出前通过 [`ChangeTracker::begin_turn`]
/// 切到新一轮，第一笔文件改动时落盘创建目录。
pub struct ChangeTracker {
    app: AppHandle,
    /// 本轮的权限边界：Pi 工作区。
    workspace: PathBuf,
    state: Mutex<TrackerState>,
}

struct TrackerState {
    /// 当前轮次的检查点目录；None 表示本轮尚未产生文件改动。
    dir: Option<PathBuf>,
    change_set_id: String,
    /// 下一笔改动需要新开一轮（每次 prompt 发出时置位）。
    start_new: bool,
}

impl TrackerState {
    fn new() -> Self {
        Self {
            dir: None,
            change_set_id: String::new(),
            start_new: true,
        }
    }
}

/// 磁盘上的一份检查点元数据（meta.json）。
#[derive(Serialize, Deserialize)]
struct ChangeSetMeta {
    #[serde(rename = "changeSetId")]
    change_set_id: String,
    workspace: PathBuf,
    /// 新版按任务轮次记录；旧版按整个工具桥会话记录，缺省为 false。
    #[serde(default)]
    per_turn: bool,
}

/// changes.jsonl 的一行：一次落盘改动的完整记录。
/// `backup` 只在本轮首次遇到该路径时有值；回滚按「每个路径在本轮的首行」恢复本轮开始前的状态。
#[derive(Serialize, Deserialize)]
struct ChangeLine {
    path: String,
    /// created | modified
    op: String,
    /// 备份文件名（`backup/<seq>.bin`）；`None` 表示本轮开始前文件不存在。
    backup: Option<String>,
    #[serde(default)]
    diff: String,
    #[serde(default)]
    ts: u64,
}

/// 推给前端的单条改动事件。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiFileChange {
    pub change_set_id: String,
    /// 相对工作区的路径（正斜杠）。
    pub path: String,
    /// created | modified
    pub op: String,
    pub diff: String,
    pub ts: u64,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

impl ChangeTracker {
    /// 创建检查点跟踪器。目录在第一笔文件改动时才建立，避免空轮次产生空目录。
    pub fn start(app: AppHandle, workspace: &Path) -> Result<Self, String> {
        Ok(Self {
            app,
            workspace: workspace.to_path_buf(),
            state: Mutex::new(TrackerState::new()),
        })
    }

    /// 新的一轮 prompt 即将发出：下一笔文件改动归入新的 changeSetId。
    ///
    /// 由宿主在真正写入 Pi stdin 前调用（排队任务在出队发送时调用），
    /// 保证气泡卡片按「单条消息」回滚时，检查点也只覆盖这一轮。
    pub fn begin_turn(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.start_new = true;
        }
    }

    /// 为当前轮次创建磁盘目录与 meta.json。
    fn create_set(&self) -> Result<(String, PathBuf), String> {
        let change_set_id = format!(
            "cs-{}-{}-{}",
            now_millis(),
            std::process::id(),
            SET_SEQ.fetch_add(1, Ordering::SeqCst)
        );
        let dir = checkpoint_root().join(&change_set_id);
        std::fs::create_dir_all(dir.join("backup"))
            .map_err(|error| format!("创建检查点目录失败：{error}"))?;
        let meta = ChangeSetMeta {
            change_set_id: change_set_id.clone(),
            workspace: self.workspace.clone(),
            per_turn: true,
        };
        let meta_json = serde_json::to_string(&meta).map_err(|error| error.to_string())?;
        std::fs::write(dir.join("meta.json"), meta_json)
            .map_err(|error| format!("写入检查点元数据失败：{error}"))?;
        prune_old_change_sets();
        Ok((change_set_id, dir))
    }

    /// 记录一次成功落盘的改动并推事件。
    ///
    /// `before` 为改动前的原始字节；`None` 表示本轮开始时文件不存在（created）。
    /// 同一路径在同一轮内重复改动：备份维持本轮第一份，diff 每次都追加并照发事件。
    pub fn record(&self, relative: &str, before: Option<&[u8]>, after: &str) {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return,
        };
        if state.start_new || state.dir.is_none() {
            match self.create_set() {
                Ok((change_set_id, dir)) => {
                    state.change_set_id = change_set_id;
                    state.dir = Some(dir);
                    state.start_new = false;
                }
                Err(error) => {
                    pi_agent::add_log(&format!("[pi] 检查点轮次创建失败：{error}"));
                    return;
                }
            }
        }
        let Some(dir) = state.dir.clone() else {
            return;
        };
        let change_set_id = state.change_set_id.clone();
        let op = if before.is_some() { "modified" } else { "created" };
        let backup = backup_original(&dir, relative, before);
        let diff = match before {
            Some(bytes) => diff_between(&String::from_utf8_lossy(bytes), after, relative),
            None => whole_file_as_addition(relative, after),
        };
        let ts = now_millis();
        let line = ChangeLine {
            path: relative.to_string(),
            op: op.to_string(),
            backup,
            diff: diff.clone(),
            ts,
        };
        append_jsonl(&dir.join("changes.jsonl"), &line);
        // 事件发送不占用状态锁，避免前端/事件线程异常拖住后续工具落盘。
        drop(state);
        let change = PiFileChange {
            change_set_id,
            path: relative.to_string(),
            op: op.to_string(),
            diff,
            ts,
        };
        self.app.emit("pi:file-changes", &change).ok();
    }
}

/// 备份序号：进程内单调即可，备份名只需要在集合内唯一。
static NOW_SEQ: AtomicU64 = AtomicU64::new(1);
/// 检查点集合序号：同一毫秒内连续开轮次时保证 id 唯一。
static SET_SEQ: AtomicU64 = AtomicU64::new(1);

/// 把本轮首次遇到的文件原始字节写进 `backup/<seq>.bin`；同一轮内已有备份时跳过。
/// 返回备份文件名（相对检查点目录）。
fn backup_original(dir: &Path, relative: &str, before: Option<&[u8]>) -> Option<String> {
    let bytes = before?;
    let jsonl = dir.join("changes.jsonl");
    if jsonl_has_path(&jsonl, relative) {
        return None;
    }
    let seq = NOW_SEQ.fetch_add(1, Ordering::SeqCst);
    let name = format!("{seq}.bin");
    std::fs::write(dir.join("backup").join(&name), bytes).ok()?;
    Some(format!("backup/{name}"))
}

/// changes.jsonl 里是否已经记录过该路径（决定「最初备份」只做一次）。
fn jsonl_has_path(jsonl: &Path, relative: &str) -> bool {
    let Ok(file) = std::fs::File::open(jsonl) else {
        return false;
    };
    std::io::BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| serde_json::from_str::<ChangeLine>(&line).ok())
        .any(|line| line.path == relative)
}

/// 追加一行 JSON（changes.jsonl 是回滚时重建清单的唯一依据）。
fn append_jsonl(path: &Path, value: &impl Serialize) {
    use std::io::Write as _;
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        if let Ok(line) = serde_json::to_string(value) {
            let _ = writeln!(file, "{line}");
        }
    }
}

/// 只保留最近 [`KEEP_CHANGE_SETS`] 份检查点，按目录名里的毫秒时间戳与轮次序号排序。
fn prune_old_change_sets() {
    let root = checkpoint_root();
    let Ok(entries) = std::fs::read_dir(&root) else {
        return;
    };
    let mut sets: Vec<(u64, u64, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let rest = name.strip_prefix("cs-")?;
            let mut parts = rest.split('-');
            let millis = parts.next()?.parse().ok()?;
            // 旧版 id 是 cs-<millis>-<pid>（没有轮次序号）；按 0 处理即可。
            let seq = parts.nth(1).and_then(|value| value.parse().ok()).unwrap_or(0);
            Some((millis, seq, entry.path()))
        })
        .collect();
    if sets.len() <= KEEP_CHANGE_SETS {
        return;
    }
    sets.sort_by_key(|(millis, seq, _)| (*millis, *seq));
    let excess = sets.len() - KEEP_CHANGE_SETS;
    for (_, _, path) in sets.into_iter().take(excess) {
        let _ = std::fs::remove_dir_all(path);
    }
}

// ---------------------------------------------------------------------------
// 回滚
// ---------------------------------------------------------------------------

/// 回滚结果摘要（返回给前端弹提示）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackSummary {
    pub change_set_id: String,
    /// 恢复的文件数（原文件被覆盖回去）。
    pub restored: usize,
    /// 删除的文件数（Pi 新建的文件）。
    pub removed: usize,
    /// 找不到记录或已不在工作区内的路径（保持原样）。
    pub skipped: Vec<String>,
}

/// 把一组路径恢复到本轮 Pi 改动之前的状态。
///
/// 每个 changeSetId 对应一轮任务；首行记录决定语义：首行 op 是 created
/// （本轮开始时不存在）→ 删除现文件；是 modified → 用首行 backup 覆盖回去。
/// 路径必须仍落在记录时的工作区内。
pub fn rollback_set(change_set_id: &str, paths: &[String]) -> Result<RollbackSummary, String> {
    if change_set_id.is_empty()
        || !change_set_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("检查点标识不合法。".to_string());
    }
    let dir = checkpoint_root().join(change_set_id);
    let meta_raw = std::fs::read_to_string(dir.join("meta.json"))
        .map_err(|_| "检查点不存在或已过期。".to_string())?;
    let meta: ChangeSetMeta =
        serde_json::from_str(&meta_raw).map_err(|error| format!("检查点元数据损坏：{error}"))?;
    // 旧版检查点按整个工具桥会话记录，前端卡片却按单条消息展示；
    // 直接回滚可能把更早轮次的改动一并撤销，甚至在「上一轮创建、本轮修改」时误删文件。
    // 无法在旧数据上还原轮次边界，因此明确拒绝，让用户手动确认。
    if !meta.per_turn {
        return Err(
            "该检查点由旧版按整个会话记录，无法安全地只回滚这一轮；为避免误删文件已拒绝。请在工作区手动确认文件状态。"
                .to_string(),
        );
    }
    let workspace = meta.workspace;

    // 每个路径取本轮 changes.jsonl 的首次记录（本轮开始时是否已存在）。
    let mut first: HashMap<String, ChangeLine> = HashMap::new();
    let jsonl = dir.join("changes.jsonl");
    if let Ok(file) = std::fs::File::open(&jsonl) {
        for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
            let Ok(record) = serde_json::from_str::<ChangeLine>(&line) else {
                continue;
            };
            first.entry(record.path.clone()).or_insert(record);
        }
    }

    let mut summary = RollbackSummary {
        change_set_id: change_set_id.to_string(),
        restored: 0,
        removed: 0,
        skipped: Vec::new(),
    };
    for relative in paths {
        let Some(record) = first.get(relative) else {
            summary.skipped.push(relative.clone());
            continue;
        };
        let Ok(target) = safe_join(&workspace, relative) else {
            summary.skipped.push(relative.clone());
            continue;
        };
        match record.op.as_str() {
            "created" => {
                // 只删文件，不递归；目录本身留给用户（空目录无害）。
                match std::fs::remove_file(&target) {
                    Ok(()) => summary.removed += 1,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        summary.removed += 1;
                    }
                    Err(_) => summary.skipped.push(relative.clone()),
                }
            }
            "modified" => {
                let Some(backup) = record.backup.as_deref() else {
                    summary.skipped.push(relative.clone());
                    continue;
                };
                let backup_path = dir.join(backup);
                match std::fs::read(&backup_path) {
                    Ok(bytes) => {
                        if let Some(parent) = target.parent() {
                            let _ = std::fs::create_dir_all(parent);
                        }
                        match std::fs::write(&target, &bytes) {
                            Ok(()) => summary.restored += 1,
                            Err(_) => summary.skipped.push(relative.clone()),
                        }
                    }
                    Err(_) => summary.skipped.push(relative.clone()),
                }
            }
            _ => summary.skipped.push(relative.clone()),
        }
    }
    Ok(summary)
}

/// 把相对路径安全地接到根下：拒绝绝对路径、`..` 越界与 Windows 前缀组件。
fn safe_join(root: &Path, relative: &str) -> Result<PathBuf, ()> {
    let rel = Path::new(relative);
    if rel.is_absolute() {
        return Err(());
    }
    if relative.replace('\\', "/").starts_with('/') {
        return Err(());
    }
    let mut out = root.to_path_buf();
    for component in rel.components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            _ => return Err(()),
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// 行级 diff
// ---------------------------------------------------------------------------

/// 生成统一风格的行级 diff；任何一侧超限（字符数/行数）都退化为摘要。
pub fn diff_between(before: &str, after: &str, path: &str) -> String {
    if before.chars().count() > MAX_DIFF_CHARS || after.chars().count() > MAX_DIFF_CHARS {
        return "（文件过大，未生成 diff，可回滚）".to_string();
    }
    let old_lines: Vec<&str> = before.lines().collect();
    let new_lines: Vec<&str> = after.lines().collect();
    if old_lines.len() > MAX_DIFF_LINES || new_lines.len() > MAX_DIFF_LINES {
        return format!(
            "（{} 行 → {} 行，超过 diff 上限，未生成逐行对比，可回滚）",
            old_lines.len(),
            new_lines.len()
        );
    }
    unified_diff_with_lines(&old_lines, &new_lines, path)
}

/// 新文件的 diff：整文件按新增展示。
fn whole_file_as_addition(path: &str, after: &str) -> String {
    if after.chars().count() > MAX_DIFF_CHARS {
        return "（新文件过大，未生成 diff，可回滚）".to_string();
    }
    let new_lines: Vec<&str> = after.lines().collect();
    if new_lines.len() > MAX_DIFF_LINES {
        return format!(
            "（新文件 {} 行，超过 diff 上限，未生成逐行对比，可回滚）",
            new_lines.len()
        );
    }
    unified_diff_with_lines(&[], &new_lines, path)
}

/// 最长公共子序列行级 diff，输出带 2 行上下文的分块。
fn unified_diff_with_lines(old: &[&str], new: &[&str], path: &str) -> String {
    // LCS 表：n·m ≤ 5000·5000 = 25M u32 ≈ 100MB 太大；
    // 这里行数上限收紧到实际常见尺寸，超过直接整文件替换。
    let lcs_limit = 1500;
    let mut out = String::new();
    out.push_str(&format!("--- {path}\n+++ {path}\n"));
    if old.len() > lcs_limit || new.len() > lcs_limit {
        out.push_str(&format!("@@ 全文件替换（{} 行 → {} 行）@@\n", old.len(), new.len()));
        for line in new.iter().take(40) {
            out.push_str(&format!("+ {line}\n"));
        }
        if new.len() > 40 {
            out.push_str(&format!("+ …（其余 {} 行省略）\n", new.len() - 40));
        }
        return out;
    }

    // dp[i][j] = old[i..] 与 new[j..] 的 LCS 长度。
    let n = old.len();
    let m = new.len();
    let mut dp = vec![0u32; (n + 1) * (m + 1)];
    let idx = |i: usize, j: usize| i * (m + 1) + j;
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[idx(i, j)] = if old[i] == new[j] {
                dp[idx(i + 1, j + 1)] + 1
            } else {
                dp[idx(i + 1, j)].max(dp[idx(i, j + 1)])
            };
        }
    }
    // 走一遍 LCS 得到对齐操作序列：Same / Delete / Insert。
    #[derive(Clone, Copy)]
    enum Op<'a> {
        Same(&'a str),
        Del(&'a str),
        Ins(&'a str),
    }
    let mut ops: Vec<Op> = Vec::with_capacity(n + m);
    let (mut i, mut j) = (0usize, 0usize);
    while i < n && j < m {
        if old[i] == new[j] {
            ops.push(Op::Same(old[i]));
            i += 1;
            j += 1;
        } else if dp[idx(i + 1, j)] >= dp[idx(i, j + 1)] {
            ops.push(Op::Del(old[i]));
            i += 1;
        } else {
            ops.push(Op::Ins(new[j]));
            j += 1;
        }
    }
    while i < n {
        ops.push(Op::Del(old[i]));
        i += 1;
    }
    while j < m {
        ops.push(Op::Ins(new[j]));
        j += 1;
    }

    // 带 2 行上下文输出分块；纯 Same 的块跳过。
    const CONTEXT: usize = 2;
    let mut emitted = false;
    let mut k = 0usize;
    while k < ops.len() {
        if matches!(ops[k], Op::Same(_)) {
            k += 1;
            continue;
        }
        let start = k.saturating_sub(CONTEXT);
        let mut end = k;
        let mut changes = 0usize;
        while end < ops.len() {
            if matches!(ops[end], Op::Same(_)) {
                let trailing = ops[end..].iter().take_while(|op| matches!(op, Op::Same(_))).count();
                if trailing > CONTEXT {
                    break;
                }
            } else {
                changes += 1;
            }
            end += 1;
        }
        if emitted {
            out.push_str("……\n");
        }
        emitted = true;
        for op in &ops[start..end.min(ops.len())] {
            match op {
                Op::Same(line) => out.push_str(&format!("  {line}\n")),
                Op::Del(line) => out.push_str(&format!("- {line}\n")),
                Op::Ins(line) => out.push_str(&format!("+ {line}\n")),
            }
        }
        let _ = changes;
        k = end;
    }
    if !emitted {
        out.push_str("（内容无变化）\n");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diff_marks_changed_lines() {
        let diff = diff_between("a\nb\nc\n", "a\nB\nc\n", "demo.txt");
        assert!(diff.contains("- b"));
        assert!(diff.contains("+ B"));
        assert!(diff.contains("  a"));
    }

    #[test]
    fn diff_handles_new_file() {
        let diff = whole_file_as_addition("new.txt", "hello\nworld\n");
        assert!(diff.contains("+ hello"));
        // 头部 `--- path` 含 "- " 子串，这里必须按「行首删除标记」判断。
        assert!(!diff.lines().any(|line| line.starts_with("- ")));
    }

    #[test]
    fn safe_join_rejects_traversal() {
        let root = Path::new("D:/work");
        assert!(safe_join(root, "a/b.txt").is_ok());
        assert!(safe_join(root, "../outside.txt").is_err());
        assert!(safe_join(root, "C:/abs.txt").is_err());
        assert!(safe_join(root, "/abs.txt").is_err());
    }
}
