//! Pi 技能路由（宿主侧，对齐拾一完整雷达）。
//!
//! 不把技能库全部注册成 Pi skills —— 那样会把技能索引和正文塞进模型上下文，
//! 效率和准确率都会掉。这里保留拾一雷达的完整打分口径：
//! 1. 只扫描 `*/SKILL.md` 的元数据；
//! 2. 零模型成本的关键词打分：技能名 +3、格式词 +3、别名 +2、触发词 +2、
//!    描述 token +0.5（封顶 4）、`not_for` −4、查询型 −0.5；
//! 3. 转发器互斥：image-gen / video-gen / music-gen / media-enhance 的实现
//!    委托给 comfyui-workflows（本仓对应画布工具），同一句话只留分最高的
//!    一个转发器，避免四条技能抢同一件事；
//! 4. 只把命中的 1–2 个技能正文注入本轮任务。
//!
//! 每一条权重都对应一次拾一真机误判（STL 命中生图、朗读≠唱、放大到 4K
//! 选中全部转发器），不要随意调整；口径与 `shyi-ai/shiyi/kernel/skill_loader.py`
//! 的 radar 保持一致。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;
use serde_yaml::Value as YamlValue;

static TRIGGER_BLOCK: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"触发词[:：]\s*([^。\n]+)").unwrap());
static USE_WHEN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)(?:use when|when)\s*[:：]?\s*(?:用户)?(?:要求|需要|想要|说)?\s*([^。\n]{4,400})")
        .unwrap()
});
static TRIGGERS_ON: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)triggers?\s+on\s*[:：]?\s*([^.\n]{4,400})").unwrap()
});
static NOT_FOR_BLOCK: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)(?:do not use for|not for|不要用于|不适用于)\s*[:：]\s*([^.\n]+)").unwrap()
});
static QUOTED: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"[“"「']([^”"」']{2,40})[”"」']"#).unwrap());
static CHINESE_RUN: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"[\x{4e00}-\x{9fff}]{2,}").unwrap());
static ENGLISH_WORD: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"[A-Za-z][A-Za-z0-9_-]{2,}").unwrap());

/// 默认技能库：显式配置 → 环境变量 → 资源目录 → 应用数据目录 → 本地开发技能库。
///
/// 这里只定位目录，不把技能注册成 Pi skills；路由仍然在宿主侧完成。
pub fn default_skills_dir(configured: Option<&str>) -> Option<PathBuf> {
    if let Some(path) = configured.map(str::trim).filter(|path| !path.is_empty()) {
        let candidate = PathBuf::from(path);
        if candidate.is_dir() {
            return Some(candidate);
        }
    }
    if let Ok(path) = std::env::var("PI_SKILLS_DIR") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            let candidate = PathBuf::from(trimmed);
            if candidate.is_dir() {
                return Some(candidate);
            }
        }
    }
    let resources = crate::services::auto_updater::resource_dir();
    let data = crate::services::storage_paths::app_data_root().join("pi");
    let candidates = [
        resources.join("pi").join("skills"),
        resources.join("skills"),
        data.join("skills"),
        // 本地开发机上的技能库；正式分发不依赖它。
        PathBuf::from(r"D:\Projects\shyi-ai\data\skills"),
    ];
    candidates.into_iter().find(|path| path.is_dir())
}

/// 查询型技能：依赖外部数据源可达性，同等条件下优先生成型技能。
const QUERY_SKILLS: &[&str] = &[
    "chemistry-lookup",
    "web-research",
    "designrag",
    "coderag",
    "entityradar",
    "search",
    "deep-probe",
    "astro-lookup",
];

/// 没写 `not_for` 的技能，用这些词兜底判断「不该用」（轮 26：朗读 ≠ 唱）。
const DEFAULT_NEGATIVE: &[&str] = &["朗读", "配音", "文字转语音", "有声书", "播客"];

/// 格式/文件名是决定性信号：用户说 STL 就几乎一定是 3D 打印，不是画图。
/// 这类词权重高于普通触发词，因为它们的歧义最低。
const FORMAT_TERMS: &[&str] = &[
    "stl", "step", "3mf", "obj", "glb", "dxf", "ifc", "mp4", "webm", "mov", "gif", "mp3", "wav",
    "flac", "xlsx", "xlsm", "csv", "docx", "pptx", "pdf", "svg", "png", "jpg",
];

/// 给描述全英文的技能补中文别名（xlsx 这类），否则中文用户永远命中不到它们。
/// 只补「用户真会这么说」的词，不做同义词泛化。
fn aliases_for(name: &str) -> &'static [&'static str] {
    match name {
        "xlsx" => &["excel", "表格", "电子表格", "spreadsheet", "统计表"],
        "pptx" => &["ppt", "幻灯片", "演示文稿", "slides"],
        "docx" => &["word", "文档", "doc", "报告", "简历", "公文"],
        "pdf" => &["pdf", "合并pdf", "拆分pdf"],
        "cad-codegen" => &["建模", "零件", "3d打印", "机械", "工程图", "参数化"],
        "mesh-modeling" => &["网格模型", "游戏模型", "低多边形", "blender"],
        "print3d" => &["3d", "打印", "stl"],
        "tts-local" => &["朗读", "配音", "语音", "读出来"],
        "chemistry-lookup" => &["化学", "分子", "化合物", "结构式", "药物"],
        "chart-gen" => &["图表", "柱状图", "折线图", "饼图", "统计图"],
        "svg-drawing" => &["svg", "矢量图", "示意图", "流程图", "结构式"],
        "deep-research-v2" => &[
            "调研", "研究", "资料", "搜索", "查一下", "查查", "搜一下", "新闻", "最新消息",
        ],
        "content-research-writer" => &["报告", "写作", "文章", "调研", "研究"],
        "equity-research-report-cn" => &["研报", "股票", "财报", "报告"],
        "market-research-brief" => &["市场", "调研", "简报", "报告"],
        "print3d-check" => &["打印件", "切片"],
        _ => &[],
    }
}

// ── 外部委托 ────────────────────────────────────────────────
// image-gen / video-gen / music-gen / media-enhance 的实现交给画布
// （comfyui-workflows）。命中转发器时不再注入它自己的正文（那里面全是
// 直接调 ComfyUI 的指令，会跟宿主画布工具打架），只注入转发说明 + 路由。
const DELEGATED: &[(&str, &str, &str)] = &[
    (
        "image-gen",
        "无输入图 → krea2（写实）/ sdxl-anime（二次元）/ zit-portrait（人像）/ krea2-4k（要 4K）；有输入图改图 → flux2-edit（默认）/ qwen-edit；四视图 → krea2-quadview；2D转3D → qwen-2d3d",
        "把用户的话翻成画布的 prompt（中英文都可，写全主体+风格+光线+构图）与工作流 ID，必要时给 negative / aspect_ratio。",
    ),
    (
        "video-gen",
        "纯文字 → minimax-t2v；给首尾帧 → minimax-fl2v；给参考图 → minimax-ref2v；已有视频要放大 → vosr2-video",
        "产出 prompt、时长（秒）、起始/参考图路径、工作流 ID。",
    ),
    (
        "music-gen",
        "音频生成（ACE-Step / Stable Audio 类），需要画布里有现成音频工作流",
        "产出歌词、曲风、BPM、时长、语言、段落结构（Intro/Verse/Chorus…）。不要谎称已生成了音频。",
    ),
    (
        "media-enhance",
        "图片放大 → seedvr2（高清修复）/ vosr2（2-5 倍整数）；视频放大 → vosr2-video",
        "产出输入文件路径、放大倍率、目标分辨率、工作流 ID。",
    ),
];

/// ComfyUI 转发器的别名按场景分组；`scope` 决定该词归哪个转发器，
/// 避免 4 个转发器同时命中同一句话（真机实测：「放大到4K」四个全中）。
const COMFY_ALIAS_SCOPES: &[(&str, &[&str])] = &[
    (
        "image",
        &[
            "生成图片", "画一张", "画个", "帮我画", "出图", "生图", "做张图", "海报", "插画",
            "二次元", "动漫", "人像", "写真", "4k", "超清", "高清", "换风格", "改成", "换成",
            "修图", "重绘", "风格转换", "洗图", "2d转3d", "四视图", "三视图", "角色设定",
        ],
    ),
    (
        "video",
        &[
            "生成视频", "做视频", "做成视频", "文生视频", "图生视频", "首尾帧", "参考图生视频",
            "让这张图动起来", "视频放大", "视频超分", "一段视频", "个视频", "视频短片", "动画",
        ],
    ),
    (
        "music",
        &["写歌", "作曲", "生成音乐", "配乐", "bgm", "唱一首"],
    ),
    (
        "enhance",
        &[
            "放大", "超分", "提升清晰度", "变清晰", "upscale", "高清放大", "修复画质",
        ],
    ),
    (
        "reverse",
        &["反推", "提示词反推", "描述这张图", "图里有什么", "caption"],
    ),
];

/// 转发器 → 它该吃的别名范围。没有列出的词不参与它的打分，
/// 否则「生成一段视频」会让 image-gen 也拿分。
const DELEGATED_SCOPES: &[(&str, &[&str])] = &[
    ("image-gen", &["image", "reverse"]),
    ("video-gen", &["video", "enhance"]),
    ("music-gen", &["music"]),
    ("media-enhance", &["enhance"]),
];

fn scope_aliases(scopes: &[&str]) -> Vec<&'static str> {
    let mut out = Vec::new();
    for (scope_name, words) in COMFY_ALIAS_SCOPES {
        if scopes.contains(scope_name) {
            out.extend_from_slice(words);
        }
    }
    out
}

fn delegated_entry(name: &str) -> Option<(&'static str, &'static str)> {
    DELEGATED
        .iter()
        .find(|(delegated, _, _)| *delegated == name)
        .map(|(_, routes, handoff)| (*routes, *handoff))
}

fn delegated_target() -> &'static str {
    "comfyui-workflows"
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiSkillMeta {
    pub name: String,
    pub description: String,
    pub triggers: Vec<String>,
    pub not_for: Vec<String>,
    pub tools: Vec<String>,
    /// generate / query / delegated / generic。
    pub kind: String,
    pub path: String,
    pub body_chars: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiSelectedSkill {
    pub name: String,
    pub description: String,
    pub tools: Vec<String>,
    pub score: f32,
    pub kind: String,
    pub body: String,
}

fn split_frontmatter(text: &str) -> (Option<YamlValue>, String) {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    if !text.starts_with("---") {
        return (None, text.to_string());
    }
    let rest = &text[3..];
    let rest = rest
        .strip_prefix("\r\n")
        .or_else(|| rest.strip_prefix('\n'))
        .unwrap_or(rest);
    let Some(end) = rest.find("\n---") else {
        return (None, text.to_string());
    };
    let yaml = &rest[..end];
    let body = &rest[end + 4..];
    let body = body
        .strip_prefix("\r\n")
        .or_else(|| body.strip_prefix('\n'))
        .unwrap_or(body);
    (serde_yaml::from_str::<YamlValue>(yaml).ok(), body.to_string())
}

fn yaml_str(front: &Option<YamlValue>, key: &str) -> Option<String> {
    front
        .as_ref()?
        .get(key)?
        .as_str()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn yaml_list(front: &Option<YamlValue>, key: &str) -> Vec<String> {
    let Some(value) = front.as_ref().and_then(|front| front.get(key)) else {
        return Vec::new();
    };
    match value {
        YamlValue::Sequence(items) => items
            .iter()
            .filter_map(|item| item.as_str())
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty())
            .collect(),
        YamlValue::String(item) => {
            let item = item.trim();
            if item.is_empty() {
                Vec::new()
            } else {
                vec![item.to_string()]
            }
        }
        _ => Vec::new(),
    }
}

fn push_trigger(out: &mut Vec<String>, value: &str) {
    let value = value.trim();
    let len = value.chars().count();
    if (2..=40).contains(&len) {
        out.push(value.to_string());
    }
}

fn push_split(out: &mut Vec<String>, text: &str) {
    for part in text.split(|c| {
        matches!(
            c,
            '、' | ',' | '，' | '/' | ';' | '；' | '|' | '·'
        )
    }) {
        push_trigger(out, part);
    }
}

fn dedupe(items: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for item in items {
        if seen.insert(item.clone()) {
            out.push(item);
        }
    }
    out
}

/// 从 description 里抽触发词：拾一支持「触发词：」「Use when」「Triggers on」和引号短语。
fn derived_triggers(description: &str) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(caps) = TRIGGER_BLOCK.captures(description) {
        push_split(&mut out, &caps[1]);
    }
    if let Some(caps) = USE_WHEN.captures(description) {
        let segment = caps[1].split("or when").next().unwrap_or(&caps[1]);
        push_split(&mut out, segment);
    }
    if let Some(caps) = TRIGGERS_ON.captures(description) {
        let segment = caps[1].split("or when").next().unwrap_or(&caps[1]);
        push_split(&mut out, segment);
    }
    for caps in QUOTED.captures_iter(description) {
        push_trigger(&mut out, &caps[1]);
    }
    dedupe(out)
}

fn derived_not_for(description: &str) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(caps) = NOT_FOR_BLOCK.captures(description) {
        push_split(&mut out, &caps[1]);
    }
    dedupe(out)
}

fn tokens(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for word in ENGLISH_WORD.find_iter(text) {
        out.push(word.as_str().to_lowercase());
    }
    for run in CHINESE_RUN.find_iter(text) {
        let chars: Vec<char> = run.as_str().chars().collect();
        for n in 2..=4 {
            if chars.len() < n {
                continue;
            }
            for index in 0..=chars.len() - n {
                out.push(chars[index..index + n].iter().collect());
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max_chars).collect();
    out.push_str("\n…（技能正文已截断）");
    out
}

/// 转发器注入的替代正文：路由 + 宿主画布工具用法，不含技能原始正文。
fn delegated_body(routes: &str, handoff: &str) -> String {
    format!(
        "【转发器】实际执行由「{}」完成。不要复制工作流 JSON，也不要假装生成——\
你必须调用宿主提供的画布工具真的执行。\n\n\
可用工具：\n\
- canvas_status：确认画布 / ComfyUI / 网关是否就绪（只读）\n\
- canvas_list_workflows：列出可用工作流 ID（只读）\n\
- canvas_run：提交任务，参数 {{ workflow, prompt, negative, aspect_ratio, input_image, output_name }}\n\n\
成功标志：canvas_run 返回的 artifacts 里有产物文件。\n\
失败时把工具返回的错误原文转告用户，不要编原因。\n\n\
路由规则：{routes}\n\
本轮职责：{handoff}",
        delegated_target()
    )
}

/// 只读技能元数据，不返回正文。
///
/// 带进程级缓存：技能库 238 个 SKILL.md 全量读一遍约 150ms，Chat 每次发送
/// 都要做一次路由，不能每次都重扫。签名 = 根目录 mtime + 技能数（与拾一
/// 的缓存失效口径一致）：新增/删除技能会变，改单个 SKILL.md 内容不会变——
/// 那种情况重启应用或碰一下技能根目录即可。
pub fn index_skills(root: &Path) -> Result<Vec<PiSkillMeta>, String> {
    if !root.is_dir() {
        return Err(format!("技能库目录不存在：{}", root.display()));
    }
    let signature = index_signature(root);
    if let Some(entry) = INDEX_CACHE.lock().ok().and_then(|guard| guard.clone()) {
        if entry.root == root && Some(entry.signature) == signature {
            return Ok(entry.metas);
        }
    }
    let metas = scan_skills(root)?;
    if let Ok(mut guard) = INDEX_CACHE.lock() {
        if let Some(signature) = signature {
            *guard = Some(IndexCacheEntry {
                root: root.to_path_buf(),
                signature,
                metas: metas.clone(),
            });
        }
    }
    Ok(metas)
}

type IndexSignature = (std::time::SystemTime, usize);

#[derive(Clone)]
struct IndexCacheEntry {
    root: PathBuf,
    signature: IndexSignature,
    metas: Vec<PiSkillMeta>,
}

static INDEX_CACHE: Lazy<Mutex<Option<IndexCacheEntry>>> = Lazy::new(|| Mutex::new(None));

fn index_signature(root: &Path) -> Option<IndexSignature> {
    let modified = std::fs::metadata(root).ok()?.modified().ok()?;
    let count = std::fs::read_dir(root)
        .ok()?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().join("SKILL.md").is_file())
        .count();
    Some((modified, count))
}

fn scan_skills(root: &Path) -> Result<Vec<PiSkillMeta>, String> {
    let mut out = Vec::new();
    let entries = std::fs::read_dir(root)
        .map_err(|error| format!("读取技能库失败：{error}"))?;
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let file = dir.join("SKILL.md");
        if !file.is_file() {
            continue;
        }
        let text = match std::fs::read_to_string(&file) {
            Ok(text) => text,
            Err(_) => continue,
        };
        let (front, body) = split_frontmatter(&text);
        let name = yaml_str(&front, "name").unwrap_or_else(|| {
            dir.file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default()
        });
        if name.is_empty() {
            continue;
        }
        let description = yaml_str(&front, "description").unwrap_or_default();
        let mut triggers = yaml_list(&front, "triggers");
        if triggers.is_empty() {
            triggers = derived_triggers(&description);
        }
        // ComfyUI 本身也要吃同一份别名表，否则「放大到4K」这类说法
        // 只能命中间接转发器，命不中真正的执行技能。
        if name == delegated_target() {
            for (_, words) in COMFY_ALIAS_SCOPES {
                for word in *words {
                    triggers.push(word.to_string());
                }
            }
            triggers = dedupe(triggers);
        }
        let delegated = delegated_entry(&name);
        if let Some((_, _)) = delegated {
            let scopes = DELEGATED_SCOPES
                .iter()
                .find(|(delegated, _)| *delegated == name)
                .map(|(_, scopes)| *scopes)
                .unwrap_or(&[]);
            for alias in scope_aliases(scopes) {
                triggers.push(alias.to_string());
            }
            triggers = dedupe(triggers);
        }
        let mut not_for = yaml_list(&front, "not_for");
        if not_for.is_empty() {
            not_for = derived_not_for(&description);
        }
        if not_for.is_empty() {
            not_for = DEFAULT_NEGATIVE
                .iter()
                .filter(|word| description.contains(*word))
                .map(|word| word.to_string())
                .collect();
        }
        let tools = yaml_list(&front, "tools");
        let kind = if QUERY_SKILLS.contains(&name.as_str()) {
            "query"
        } else if delegated.is_some() {
            "delegated"
        } else if !tools.is_empty() {
            "generate"
        } else {
            "generic"
        };
        out.push(PiSkillMeta {
            name,
            description,
            triggers,
            not_for,
            tools,
            kind: kind.to_string(),
            path: file.display().to_string(),
            body_chars: body.chars().count(),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn matches(text: &str, lower: &str, term: &str) -> bool {
    let term = term.trim();
    if term.is_empty() {
        return false;
    }
    text.contains(term) || lower.contains(&term.to_lowercase())
}

/// 文本里的格式词（按非字母数字分词，等价词边界；`stl` 不会命中 `steps`）。
fn format_terms_in_text(lower: &str) -> Vec<&'static str> {
    let mut out = Vec::new();
    for word in lower.split(|ch: char| !ch.is_ascii_alphanumeric()) {
        if let Some(term) = FORMAT_TERMS.iter().find(|term| **term == word) {
            out.push(*term);
        }
    }
    out.sort();
    out.dedup();
    out
}

/// 按任务文本选 1–2 个技能，并把正文截到 `max_chars` 以内。
pub fn select_skills(
    root: &Path,
    text: &str,
    top_k: usize,
    max_chars: usize,
) -> Result<Vec<PiSelectedSkill>, String> {
    let metas = index_skills(root)?;
    let lower = text.to_lowercase();
    let text_tokens = tokens(text);
    let formats = format_terms_in_text(&lower);
    let mut scored: Vec<(f32, PiSkillMeta)> = Vec::new();
    for meta in metas {
        let mut score = 0.0f32;
        // 强信号：名称 / 别名 / 触发词 / 格式词至少命中一个。纯描述 token
        // 命中太弱（真机实测：「帮我看看工作区里有什么文件」会误中市场查询
        // 类技能），不允许仅凭描述入选。
        let mut strong = false;
        let name_lower = meta.name.to_lowercase();
        if lower.contains(&name_lower) {
            score += 3.0;
            strong = true;
        }
        // 格式词命中 +3：STL/MP4/XLSX 这类歧义最低；要求词出现在技能
        // 描述或名字里，避免「pdf」命中所有无关技能。
        for term in &formats {
            let description_lower = meta.description.to_lowercase();
            if description_lower.contains(term) || name_lower.contains(term) {
                score += 3.0;
                strong = true;
            }
        }
        for alias in aliases_for(&meta.name) {
            if lower.contains(alias) {
                score += 2.0;
                strong = true;
            }
        }
        for trigger in &meta.triggers {
            if matches(text, &lower, trigger) {
                score += 2.0;
                strong = true;
            }
        }
        for negative in &meta.not_for {
            if matches(text, &lower, negative) {
                score -= 4.0;
            }
        }
        if !meta.description.is_empty() {
            let description = meta.description.to_lowercase();
            let hits = text_tokens
                .iter()
                .filter(|token| description.contains(token.as_str()))
                .count();
            score += (hits.min(4) as f32) * 0.5;
        }
        if meta.kind == "query" {
            score -= 0.5;
        }
        let qualifies = if strong {
            score >= 1.0
        } else {
            // 没有任何强信号时，需要 5 个以上描述 token 才有可能靠分数入选
            // （4 个封顶只有 2.0，永远到不了 2.5）。
            score >= 2.5
        };
        if qualifies {
            scored.push((score, meta));
        }
    }
    scored.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.1.name.cmp(&b.1.name))
    });

    // 转发器互斥：同一件事只留分最高的那一个转发器。
    let mut picked: Vec<(f32, PiSkillMeta)> = Vec::new();
    let mut seen_forwarder = false;
    for (score, meta) in scored {
        if meta.kind == "delegated" {
            if seen_forwarder {
                continue;
            }
            seen_forwarder = true;
        }
        picked.push((score, meta));
        if picked.len() >= top_k.max(1) {
            break;
        }
    }

    // 转发器自动带上它的目标技能（全链路按名字去重保序），正文给执行摘要。
    let mut expanded: Vec<PiSkillMeta> = Vec::new();
    let mut delegated_targets: Vec<String> = Vec::new();
    for (_, meta) in &picked {
        if expanded.iter().any(|item| item.name == meta.name) {
            continue;
        }
        expanded.push(meta.clone());
        if meta.kind == "delegated" {
            let target = delegated_target();
            delegated_targets.push(target.to_string());
            if !expanded.iter().any(|item| item.name == target) {
                if let Some(target_meta) = index_lookup(root, target) {
                    expanded.push(target_meta);
                }
            }
        }
    }

    let mut out = Vec::new();
    let mut used = 0usize;
    for meta in expanded {
        let body = if let Some((routes, handoff)) = delegated_entry(&meta.name) {
            // 转发器：只给路由 + 画布工具用法，不给正文（正文会跟目标技能打架）。
            delegated_body(routes, handoff)
        } else {
            let file = PathBuf::from(&meta.path);
            let text = match std::fs::read_to_string(&file) {
                Ok(text) => text,
                Err(_) => continue,
            };
            let (_, body) = split_frontmatter(&text);
            let body = body.trim().to_string();
            if delegated_targets.contains(&meta.name) {
                // 转发目标：只给可执行摘要，不给全文。正文越长，模型越容易
                // 把「读完」当成「做完」。
                exec_summary(&body, max_chars.min(3000))
            } else {
                body
            }
        };
        let remaining = max_chars.saturating_sub(used);
        if remaining < 200 {
            break;
        }
        let body = truncate_chars(&body, remaining);
        used += body.chars().count();
        out.push(PiSelectedSkill {
            name: meta.name,
            description: meta.description,
            tools: meta.tools,
            score: 0.0,
            kind: meta.kind,
            body,
        });
    }
    // 分数在展开循环里丢了；从 picked 重新对齐，未展开的目标技能给 0。
    for skill in out.iter_mut() {
        if let Some((score, _)) = picked.iter().find(|(_, meta)| meta.name == skill.name) {
            skill.score = *score;
        }
    }
    Ok(out)
}

fn index_lookup(root: &Path, name: &str) -> Option<PiSkillMeta> {
    index_skills(root)
        .ok()?
        .into_iter()
        .find(|meta| meta.name == name)
}

/// 转发目标的执行摘要：保留「下一步做什么」，丢弃长篇背景。
fn exec_summary(body: &str, max_chars: usize) -> String {
    let kept: Vec<&str> = body
        .lines()
        .filter(|line| {
            let trimmed = line.trim_start();
            let keep_prefixes = [
                "工作流", "--workflow", "canvas_", "成功", "失败", "常见错误", "参数",
                "workflow", "输出", "步骤", "1.", "2.", "3.", "4.", "5.",
            ];
            keep_prefixes
                .iter()
                .any(|prefix| trimmed.starts_with(prefix))
        })
        .collect();
    let joined = if kept.is_empty() {
        body.to_string()
    } else {
        kept.join("\n")
    };
    truncate_chars(&joined, max_chars)
}

/// 把选中的技能拼成注入给模型的一段文本。
pub fn render_skill_context(skills: &[PiSelectedSkill]) -> String {
    if skills.is_empty() {
        return String::new();
    }
    let mut out = String::new();
    for skill in skills {
        out.push_str(&format!("## 技能：{}\n", skill.name));
        if !skill.description.is_empty() {
            out.push_str(&skill.description);
            out.push('\n');
        }
        if skill.kind == "query" {
            out.push_str("⚠ 查询型技能：先确认数据源可达，再决定是否依赖它。\n");
        }
        out.push_str(skill.body.trim());
        out.push_str("\n\n");
    }
    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pi-skills-test-{}-{}-{}",
            std::process::id(),
            tag,
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("create skills root");
        dir
    }

    fn write_skill(root: &Path, dir: &str, front: &str, body: &str) {
        let target = root.join(dir);
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(
            target.join("SKILL.md"),
            format!("---\n{front}\n---\n\n{body}\n"),
        )
        .unwrap();
    }

    #[test]
    fn index_and_select_doc_skill() {
        let root = temp_root("doc");
        write_skill(
            &root,
            "doc-writer",
            "name: doc-writer\ndescription: 写正式文档\ntriggers:\n  - 写报告\n  - 报告\nnot_for:\n  - 不要写\ntools:\n  - write_file",
            "写报告时先列大纲，再写正文。",
        );
        write_skill(
            &root,
            "image-gen",
            "name: image-gen\ndescription: 生图\ntriggers:\n  - 生图\n  - 画图\ntools:\n  - run_command",
            "生图走 ComfyUI。",
        );
        let metas = index_skills(&root).expect("index");
        assert_eq!(metas.len(), 2);
        let doc = metas.iter().find(|meta| meta.name == "doc-writer").unwrap();
        assert_eq!(doc.kind, "generate");
        let img = metas
            .iter()
            .find(|meta| meta.name == "image-gen")
            .unwrap();
        assert_eq!(img.kind, "delegated");
        // 转发器触发词带上了 image 场景别名
        assert!(img.triggers.contains(&"画一张".to_string()));
        let selected = select_skills(&root, "帮我写一份报告", 2, 4000).expect("select");
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].name, "doc-writer");
        assert!(selected[0].body.contains("先列大纲"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn not_for_excludes_skill() {
        let root = temp_root("notfor");
        write_skill(
            &root,
            "doc-writer",
            "name: doc-writer\ndescription: 写正式文档\ntriggers:\n  - 写报告\n  - 报告\nnot_for:\n  - 不要写",
            "写报告时先列大纲。",
        );
        write_skill(
            &root,
            "image-gen",
            "name: image-gen\ndescription: 生图\ntriggers:\n  - 生图\n  - 画图",
            "生图走 ComfyUI。",
        );
        let selected =
            select_skills(&root, "不要写报告，直接生图", 2, 4000).expect("select");
        assert!(selected.iter().all(|skill| skill.name != "doc-writer"));
        assert!(selected.iter().any(|skill| skill.name == "image-gen"));
        // 转发器正文被替换成画布工具转发说明
        let img = selected.iter().find(|skill| skill.name == "image-gen").unwrap();
        assert!(img.body.contains("canvas_run"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn forwarder_mutex_picks_one() {
        let root = temp_root("mutex");
        write_skill(
            &root,
            "image-gen",
            "name: image-gen\ndescription: 生图\ntriggers:\n  - 生图",
            "旧正文会跟画布打架。",
        );
        write_skill(
            &root,
            "video-gen",
            "name: video-gen\ndescription: 生视频\ntriggers:\n  - 生视频",
            "旧正文。",
        );
        write_skill(
            &root,
            "media-enhance",
            "name: media-enhance\ndescription: 放大\ntriggers:\n  - 放大",
            "旧正文。",
        );
        // 「放大到4K」在拾一真机曾同时选中 4 个转发器；现在只允许一个
        let selected = select_skills(&root, "把这张图放大到 4k", 2, 4000).expect("select");
        let forwarders: Vec<&str> = selected
            .iter()
            .filter(|skill| skill.kind == "delegated")
            .map(|skill| skill.name.as_str())
            .collect();
        assert_eq!(forwarders.len(), 1);
        assert_eq!(forwarders[0], "media-enhance");
        // 转发目标 comfyui-workflows 不在库里时，注入只有转发器自己
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn format_term_boosts_print3d_over_image() {
        let root = temp_root("format");
        write_skill(
            &root,
            "print3d",
            "name: print3d\ndescription: 3D 打印，输出 stl 文件\ntriggers:\n  - 打印",
            "用画布出 STL。",
        );
        write_skill(
            &root,
            "image-gen",
            "name: image-gen\ndescription: 生图\ntriggers:\n  - 画图",
            "画图。",
        );
        // 拾一轮教训：「画个手柄底座的 STL」原来命中了 image-gen
        let selected = select_skills(&root, "画个手柄底座的 stl", 1, 4000).expect("select");
        assert_eq!(selected[0].name, "print3d");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn query_skill_downweighted() {
        let root = temp_root("query");
        write_skill(
            &root,
            "chemistry-lookup",
            "name: chemistry-lookup\ndescription: 化学分子查询\ntriggers:\n  - 结构式",
            "查询化合物。",
        );
        write_skill(
            &root,
            "svg-drawing",
            "name: svg-drawing\ndescription: 画示意图与结构式\ntriggers:\n  - 结构式",
            "输出 SVG。",
        );
        // 同分时查询型 −0.5，生成型（svg-drawing）应排在前面
        let selected = select_skills(&root, "画硫酸根结构式存 svg", 2, 4000).expect("select");
        assert_eq!(selected[0].name, "svg-drawing");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn default_negative_blocks_tts_for_singing() {
        let root = temp_root("negative");
        write_skill(
            &root,
            "tts-local",
            "name: tts-local\ndescription: 朗读配音，把文字转成语音",
            "调用语音合成。",
        );
        write_skill(
            &root,
            "music-gen",
            "name: music-gen\ndescription: 音乐生成\ntriggers:\n  - 唱歌\n  - 歌",
            "音乐。",
        );
        // tts-local 没写 not_for，DEFAULT_NEGATIVE 从描述兜底（朗读/配音都在描述里）
        let selected = select_skills(&root, "唱一首关于春天的歌", 2, 4000).expect("select");
        assert!(selected.iter().all(|skill| skill.name != "tts-local"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn body_is_truncated_to_budget() {
        let root = temp_root("budget");
        let body = "正文".repeat(2000);
        write_skill(
            &root,
            "long-skill",
            "name: long-skill\ndescription: 长技能\ntriggers:\n  - 长任务",
            &body,
        );
        let selected = select_skills(&root, "做一个长任务", 1, 300).expect("select");
        assert_eq!(selected.len(), 1);
        assert!(selected[0].body.chars().count() <= 330);
        assert!(selected[0].body.contains("已截断"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn render_includes_name_and_body() {
        let skills = vec![PiSelectedSkill {
            name: "doc-writer".to_string(),
            description: "写文档".to_string(),
            tools: vec![],
            score: 4.0,
            kind: "generate".to_string(),
            body: "先列大纲".to_string(),
        }];
        let text = render_skill_context(&skills);
        assert!(text.contains("技能：doc-writer"));
        assert!(text.contains("先列大纲"));
    }

    #[test]
    #[ignore]
    fn real_skills_router_regression() {
        let root = Path::new(r"D:\Projects\shyi-ai\data\skills");
        if !root.is_dir() {
            return;
        }
        let metas = index_skills(root).expect("index real skills");
        println!("技能总数：{}", metas.len());
        let delegated_count = metas
            .iter()
            .filter(|meta| meta.kind == "delegated")
            .count();
        assert_eq!(delegated_count, 4, "应有 4 个转发器");

        let cases: Vec<(&str, Vec<&str>, Vec<&str>)> = vec![
            // (输入, 必须命中其一, 不得命中)
            ("帮我写一份报告", vec!["content-research-writer", "docx"], vec![]),
            ("查一下今天的 AI 新闻", vec!["deep-research-v2"], vec![]),
            ("画一个流程图", vec!["svg-drawing", "code-to-chart"], vec!["image-gen", "video-gen"]),
            ("画一张雨夜赛博朋克城市，16:9", vec!["image-gen"], vec!["video-gen", "music-gen"]),
            ("把这张图放大到 4k", vec!["comfyui-workflows"], vec!["video-gen", "music-gen"]),
            ("生成一段视频", vec!["video-gen"], vec!["image-gen"]),
            ("画个手柄底座的 stl 拿去打印", vec!["print3d", "cad-codegen"], vec!["image-gen"]),
            ("把这些数据导出成 xlsx 表格", vec!["xlsx"], vec![]),
            ("帮我看看工作区里有什么文件", vec![], vec![]),
            ("唱一首关于春天的歌", vec!["music-gen"], vec!["tts-local"]),
            ("画硫酸根结构式存 svg", vec!["svg-drawing", "chemistry-lookup"], vec![]),
        ];
        for (text, expect_any, forbid) in &cases {
            let selected = select_skills(root, text, 2, 8000).expect("select");
            let names: Vec<&str> = selected.iter().map(|skill| skill.name.as_str()).collect();
            println!("{text} -> {names:?}");
            // 全局不变量：任何输入最多命中一个转发器；且不允许重复注入。
            let forwarders = selected
                .iter()
                .filter(|skill| skill.kind == "delegated")
                .count();
            assert!(forwarders <= 1, "{text} 命中了 {forwarders} 个转发器：{names:?}");
            let mut unique = names.clone();
            unique.sort_unstable();
            unique.dedup();
            assert_eq!(unique.len(), names.len(), "{text} 重复注入：{names:?}");
            if !expect_any.is_empty() {
                assert!(
                    expect_any
                        .iter()
                        .any(|name| names.contains(name)),
                    "{text} 应命中 {expect_any:?}，实际 {names:?}"
                );
            }
            for name in forbid {
                assert!(
                    !names.contains(name),
                    "{text} 不应命中 {name}，实际 {names:?}"
                );
            }
        }
    }
}
