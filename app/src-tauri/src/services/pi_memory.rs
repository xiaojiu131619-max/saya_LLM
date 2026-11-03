//! Pi 长期记忆：跨会话共享的全局记忆。
//!
//! 会话工作区是按会话隔离的（B 会话读不到 A 的产物），所以「记住用户偏好 /
//! 提炼出的事实」不能落在工作区里。这里提供全局记忆：
//! - `MEMORY.md`：模型通过 `save_memory` 宿主工具主动写入的事实；
//! - `tool-errors.md`：宿主在工具调用失败时自动追加（零模型成本），
//!   让下一轮任务能「记住工具错误」不再踩同一个坑。
//!
//! 注入：`pi_agent::run` 在每轮任务前把两者拼成【长期记忆】块（有大小上限，
//! 超限从最旧行裁起），并提示模型用 `save_memory` 持久化新事实。
//!
//! 安全边界：记忆内容会进入后续轮次的提示词。它由模型写入、宿主只做转义
//! 与截断，可能被任务文本里的提示注入污染——这与工具结果注入是同一类风险，
//! 由权限层兜底（详见 pi_tools 的安全边界说明），不做额外过滤。

use std::io::Write as IoWrite;
use std::path::PathBuf;
use std::sync::Mutex;

use once_cell::sync::Lazy;

use crate::services::pi_agent;

/// 单条记忆/错误记录的字符上限。
const ENTRY_MAX_CHARS: usize = 2000;
/// MEMORY.md 的体积上限；超过后从最旧的行开始裁。
const MEMORY_CAP_BYTES: usize = 32 * 1024;
/// tool-errors.md 的行数上限。
const TOOL_ERRORS_MAX_LINES: usize = 100;
/// 注入给模型的记忆块字符上限（MEMORY + 工具错误合计）。
pub const INJECT_MAX_CHARS: usize = 3000;

/// 测试用：覆写记忆目录，避免单测写到真实应用数据目录。
static MEMORY_DIR_OVERRIDE: Lazy<Mutex<Option<PathBuf>>> = Lazy::new(|| Mutex::new(None));

#[doc(hidden)]
pub fn set_memory_dir_for_tests(path: Option<PathBuf>) {
    if let Ok(mut slot) = MEMORY_DIR_OVERRIDE.lock() {
        *slot = path;
    }
}

pub fn memory_dir() -> PathBuf {
    if let Ok(slot) = MEMORY_DIR_OVERRIDE.lock() {
        if let Some(path) = slot.clone() {
            return path;
        }
    }
    pi_agent::pi_data_root().join("memory")
}

fn memory_file() -> PathBuf {
    memory_dir().join("MEMORY.md")
}

fn timestamp() -> String {
    // 本地时间戳（秒级）；记忆是给人看的辅助信息，不做时区换算。
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    format!("[{secs}]")
}

fn sanitize_entry(text: &str) -> String {
    // 单行化 + 去控制字符 + 截断，保证追加不会破坏行结构。
    let cleaned: String = text
        .chars()
        .map(|ch| if ch == '\n' || ch == '\r' { ' ' } else if ch.is_control() { ' ' } else { ch })
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.chars().count() <= ENTRY_MAX_CHARS {
        cleaned.to_string()
    } else {
        cleaned.chars().take(ENTRY_MAX_CHARS).collect()
    }
}

/// 把一行事实追加进 MEMORY.md；超限时从最旧的行裁起。
pub fn append_memory(text: &str) -> Result<(), String> {
    append_memory_in(memory_dir(), text)
}

/// 把一行事实写进指定记忆目录（`save_memory` 工具与测试共用）。
pub fn append_memory_in(dir: PathBuf, text: &str) -> Result<(), String> {
    let entry = sanitize_entry(text);
    if entry.is_empty() {
        return Err("记忆内容不能为空".to_string());
    }
    append_line(&dir.join("MEMORY.md"), &format!("{} {}", timestamp(), entry), MEMORY_CAP_BYTES)
}

/// 工具调用失败时自动记录；连续重复（同工具 + 同目标）只记一次。
pub fn append_tool_error(tool: &str, target: &str, error: &str) {
    append_tool_error_in(memory_dir(), tool, target, error);
}

fn append_tool_error_in(dir: PathBuf, tool: &str, target: &str, error: &str) {
    let entry = sanitize_entry(&format!("tool={tool} target={target} error={error}"));
    if entry.is_empty() {
        return;
    }
    let line = format!("{} {}", timestamp(), entry);
    let file = dir.join("tool-errors.md");
    // 连续重复去重：最后一行完全相同就不再追加。
    if let Ok(existing) = std::fs::read_to_string(&file) {
        if existing.lines().last().map(|last| last.trim()) == Some(line.trim()) {
            return;
        }
    }
    let _ = append_line(&file, &line, 8 * 1024 * TOOL_ERRORS_MAX_LINES / 10);
}

fn append_line(file: &PathBuf, line: &str, cap_bytes: usize) -> Result<(), String> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("创建记忆目录失败：{error}"))?;
    }
    let mut body = std::fs::read_to_string(file).unwrap_or_default();
    body.push_str(line);
    body.push('\n');
    // 超限裁剪：丢最旧的行，保住最新内容。
    while body.len() > cap_bytes {
        match body.find('\n') {
            Some(index) => body = body[index + 1..].to_string(),
            None => {
                body.truncate(cap_bytes);
                break;
            }
        }
    }
    // 原子替换，避免写一半被读到。
    let temp = file.with_extension("tmp");
    {
        let mut handle = std::fs::File::create(&temp).map_err(|error| format!("写记忆失败：{error}"))?;
        handle
            .write_all(body.as_bytes())
            .map_err(|error| format!("写记忆失败：{error}"))?;
    }
    std::fs::rename(&temp, file).map_err(|error| format!("替换记忆文件失败：{error}"))
}

/// 组装注入给模型的【长期记忆】块；没有任何记忆时返回空串。
pub fn render_memory_context() -> String {
    render_memory_in(memory_dir())
}

fn render_memory_in(dir: PathBuf) -> String {
    let memory = std::fs::read_to_string(dir.join("MEMORY.md")).unwrap_or_default();
    let errors = std::fs::read_to_string(dir.join("tool-errors.md")).unwrap_or_default();
    if memory.trim().is_empty() && errors.trim().is_empty() {
        return String::new();
    }
    let mut out = String::from("【长期记忆】（跨会话共享；需要记住新事实、用户偏好或结论时，调用 save_memory 工具）\n");
    let memory = memory.trim();
    if !memory.is_empty() {
        out.push_str("\n## 已记住的事实\n");
        out.push_str(memory);
        out.push('\n');
    }
    let errors = errors.trim();
    if !errors.is_empty() {
        out.push_str("\n## 最近的工具错误（避免重复踩坑）\n");
        out.push_str(errors);
        out.push('\n');
    }
    if out.chars().count() > INJECT_MAX_CHARS {
        // 保尾：最新的记忆在文件尾部。
        let mut kept: String = out
            .chars()
            .skip(out.chars().count() - INJECT_MAX_CHARS)
            .collect();
        // 从下一个完整行开始，避免截出半行。
        if let Some(index) = kept.find('\n') {
            kept = kept[index + 1..].to_string();
        }
        out = kept;
    }
    out
}

/// 记忆文件路径（界面「打开记忆目录」用）。
pub fn file_paths() -> Vec<PathBuf> {
    vec![memory_file(), memory_dir().join("tool-errors.md")]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_memory_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pi-memory-test-{}-{}-{}",
            std::process::id(),
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn sanitize_strips_newlines_and_controls() {
        assert_eq!(sanitize_entry("a\nb\rc\u{7}d"), "a b c d");
        let long = "很".repeat(ENTRY_MAX_CHARS + 10);
        assert_eq!(sanitize_entry(&long).chars().count(), ENTRY_MAX_CHARS);
    }

    #[test]
    fn append_memory_and_render() {
        // 走显式目录版本，不碰全局覆写，避免与其他测试并行时互相串扰。
        let dir = temp_memory_root("append");
        append_memory_in(dir.clone(), "用户偏好深色主题").unwrap();
        append_memory_in(dir.clone(), "喜欢简洁回复").unwrap();
        let context = render_memory_in(dir.clone());
        assert!(context.contains("已记住的事实"));
        assert!(context.contains("用户偏好深色主题"));
        assert!(context.contains("save_memory"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn tool_error_dedupes_consecutive_duplicates() {
        let dir = temp_memory_root("dedupe");
        append_tool_error_in(dir.clone(), "read_file", "a.txt", "不是文件");
        append_tool_error_in(dir.clone(), "read_file", "a.txt", "不是文件");
        let body = std::fs::read_to_string(dir.join("tool-errors.md")).unwrap();
        assert_eq!(body.lines().count(), 1);
        append_tool_error_in(dir.clone(), "run_command", "dir", "退出码 1");
        let body = std::fs::read_to_string(dir.join("tool-errors.md")).unwrap();
        assert_eq!(body.lines().count(), 2);
        let context = render_memory_in(dir.clone());
        assert!(context.contains("最近的工具错误"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn append_line_trims_oldest_on_overflow() {
        let dir = temp_memory_root("trim");
        let file = dir.join("t.md");
        // cap 很小：只容得下最后一行
        for index in 0..5 {
            append_line(&file, &format!("line-{index}"), 32).unwrap();
        }
        let body = std::fs::read_to_string(&file).unwrap();
        assert!(!body.contains("line-0"), "最旧的行应被裁掉：{body}");
        assert!(body.contains("line-4"), "最新的行应保留：{body}");
        let _ = std::fs::remove_dir_all(dir);
    }
}
