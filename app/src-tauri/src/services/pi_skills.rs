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

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
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

/// 默认技能库：显式配置 → 环境变量 → 仓库内 pi 专属技能树 → 资源目录 → 应用数据目录。
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
        // 仓库内的 pi 专属技能树：开发态直接命中。
        repo_skills_dir(),
        // 打包态：把这份目录放到 exe 旁的 resources/pi/skills。
        Some(resources.join("pi").join("skills")),
        Some(resources.join("skills")),
        Some(data.join("skills")),
    ];
    candidates.into_iter().flatten().find(|path| path.is_dir())
}

/// 仓库内的 pi 专属技能树：`<repo>/app/resources/pi/skills`。
///
/// 编译期路径只在开发机上成立；正式分发时该目录不存在，
/// 自动落到 exe 旁的 `resources/pi/skills` 或应用数据目录。
fn repo_skills_dir() -> Option<PathBuf> {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let app_dir = manifest.parent()?; // <repo>/app
    let candidate = app_dir.join("resources").join("pi").join("skills");
    candidate.is_dir().then_some(candidate)
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
        "longread" => &["大文件", "长文件", "文件太大", "读不下", "分块读取", "读取截断"],
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

// ── 技能树（taxonomy）───────────────────────────────────────
// 层级与关联数据放 `_tree.json`（与 SKILL.md 平级，随技能库目录走），
// 不写进每个 SKILL.md 的 frontmatter——那样 239 个文件要逐个改，
// 且拾一原库同步时会被上游覆盖。文件缺失或非法时整体退化为平铺路由。

/// 技能库根目录下的分类映射文件。
const TAXONOMY_FILE: &str = "_tree.json";

/// 未收录进 `_tree.json` 的技能归入这个隐式分支（与真实分支同等参与两级路由）。
const UNCLASSIFIED_LABEL: &str = "未分类";

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
struct TaxonomyFile {
    categories: Vec<TaxCategoryFile>,
    links: Vec<TaxLink>,
}

#[derive(Debug, Clone, Deserialize)]
struct TaxCategoryFile {
    id: String,
    label: String,
    #[serde(default)]
    triggers: Vec<String>,
    #[serde(default)]
    children: Vec<TaxChildFile>,
    #[serde(default)]
    members: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct TaxChildFile {
    label: String,
    #[serde(default)]
    members: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct TaxLink {
    from: String,
    to: String,
    /// complement（配套）/ depends（依赖）/ delegate（委托）。
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    note: String,
}

/// 加载后的运行时分类表：顶层分支（用于两级路由）+ 成员路径 + 关联图。
#[derive(Debug, Clone, Default)]
pub struct Taxonomy {
    branches: Vec<TaxBranch>,
    /// 技能名 → [大类名, 子类名]（子类直挂时只有一层）。
    member_path: HashMap<String, Vec<String>>,
    links: Vec<TaxLink>,
}

#[derive(Debug, Clone)]
struct TaxBranch {
    label: String,
    triggers: Vec<String>,
}

impl Taxonomy {
    fn is_empty(&self) -> bool {
        self.branches.is_empty()
    }

    fn branch_label(&self, skill: &str) -> &str {
        self.member_path
            .get(skill)
            .and_then(|path| path.first())
            .map(String::as_str)
            .unwrap_or(UNCLASSIFIED_LABEL)
    }

    fn category_path(&self, skill: &str) -> Vec<String> {
        self.member_path.get(skill).cloned().unwrap_or_default()
    }

    /// 顶层分支声明序；未收录的技能给 usize::MAX（自然垫底）。
    fn category_order(&self, skill: &str) -> usize {
        self.member_path
            .get(skill)
            .and_then(|path| path.first())
            .and_then(|label| self.branches.iter().position(|b| &b.label == label))
            .unwrap_or(usize::MAX)
    }
}

/// 解析 `_tree.json`；文件缺失、非法 JSON 或分支缺 label 时整体退化为空表
/// （空表 = 不做分支裁剪，路由行为与旧版平铺一致）。
fn load_taxonomy(root: &Path) -> Taxonomy {
    let path = root.join(TAXONOMY_FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(_) => return Taxonomy::default(),
    };
    let file: TaxonomyFile = match serde_json::from_str(&text) {
        Ok(file) => file,
        Err(error) => {
            eprintln!("[pi_skills] {TAXONOMY_FILE} 解析失败，按平铺路由处理：{error}");
            return Taxonomy::default();
        }
    };
    let mut taxonomy = Taxonomy {
        branches: Vec::with_capacity(file.categories.len()),
        member_path: HashMap::new(),
        links: file.links,
    };
    for category in file.categories {
        if category.id.is_empty() || category.label.is_empty() {
            continue;
        }
        taxonomy.branches.push(TaxBranch {
            label: category.label.clone(),
            triggers: category.triggers,
        });
        for member in &category.members {
            taxonomy
                .member_path
                .insert(member.clone(), vec![category.label.clone()]);
        }
        for child in &category.children {
            if child.label.is_empty() {
                continue;
            }
            for member in &child.members {
                taxonomy.member_path.insert(
                    member.clone(),
                    vec![category.label.clone(), child.label.clone()],
                );
            }
        }
    }
    taxonomy
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
    /// 技能树分类路径（如 ["媒体生成", "图像"]）；未收录时为空。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub category_path: Vec<String>,
    /// 顶层分支的声明序（_tree.json 顺序）；未收录为 usize::MAX，UI 据此给分支排序。
    pub category_order: usize,
    /// 关联技能（_tree.json 的 links，双向展开）。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub related: Vec<PiSkillLink>,
}

/// 技能间关联：direction = outbound（from 方）/ inbound（to 方）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiSkillLink {
    pub name: String,
    /// complement / depends / delegate。
    pub kind: String,
    pub direction: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub note: String,
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
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub category_path: Vec<String>,
}

/// 一次路由的完整结果：入选技能 + 晋级分支（两级路由的透明度）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRoute {
    pub skills: Vec<PiSelectedSkill>,
    /// 本轮晋级的顶层分支名；未启用两级路由（无 taxonomy）时为空。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub branches: Vec<String>,
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
        .map(flatten_ws)
        .filter(|value| !value.is_empty())
}

/// 压平多行值里的换行与缩进。
///
/// 拾一的 Python 解析器用 `re.sub(r"\s*\n\s*", " ", raw)` 压平，
/// serde_yaml 保留原始换行 —— 两边口径不一致时，触发词与 not_for
/// 的抽取正则会被换行截断，同一个技能在两个宿主里的命中情况就不同。
/// 这里跟拾一对齐：只把「含换行的空白段」压成一个空格，段内空格保留。
fn flatten_ws(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut out = String::with_capacity(value.len());
    let mut index = 0;
    while index < chars.len() {
        if chars[index].is_whitespace() {
            let start = index;
            while index < chars.len() && chars[index].is_whitespace() {
                index += 1;
            }
            let run: String = chars[start..index].iter().collect();
            if run.contains('\n') {
                out.push(' ');
            } else {
                out.push_str(&run);
            }
        } else {
            out.push(chars[index]);
            index += 1;
        }
    }
    out.trim().to_string()
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
    // 抽出来的短语常带引号与尾部标点（'review my paper,' / '" "simulate peer review'），
    // 这些形态在用户输入里永远不会原样出现，等于白抽。清洗后再入表。
    let cleaned = clean_trigger(value);
    let len = cleaned.chars().count();
    if (2..=40).contains(&len) {
        out.push(cleaned);
    }
}

/// 剪除抽出来的短语中的句内标点前的部分。
///
/// 例如 longread 描述里的 `NOT for structured data (CSV, DTA, XLSX, etc.)`，
/// 抽词会拉出 `then proceed accordingly. Supports PDF` 这种跨句碎片——
/// 它们既不是触发词，也不会在用户输入里出现。
fn truncate_at_clause(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        if matches!(ch, '.' | ',' | '\u{3001}' | '\u{ff0c}' | ';' | '\u{ff1b}' | ':' | '\u{ff1a}' | '?') {
            break;
        }
        out.push(ch);
    }
    out.trim().to_string()
}

/// 去掉首尾的引号与标点（中英文引号、逗号、句号等）。
fn clean_trigger(value: &str) -> String {
    const EDGE: &[char] = &[
        '"', '\'', '\u{201c}', '\u{201d}', '\u{2018}', '\u{2019}', '\u{300c}', '\u{300d}', '\u{300e}',
        '\u{300f}', ',', '\u{3001}', '\u{ff0c}', ';', '\u{ff1b}', '|', '\u{00b7}', '.', '!', '?',
        '\u{3002}', '\u{ff01}', '\u{ff1f}',
    ];
    let mut text = value.trim();
    loop {
        let before = text;
        text = text.trim_matches(EDGE).trim();
        if text == before {
            break;
        }
    }
    text.to_string()
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
    // 引号短语常是整句剪归的，先剪到句内标点前，再去标点。
    out = out
        .into_iter()
        .map(|value| truncate_at_clause(&value))
        .filter(|value| !value.is_empty())
        .collect();
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
/// 都要做一次路由，不能每次都重扫。签名 = 根目录 mtime + 技能数 + `_tree.json`
/// mtime（与拾一的缓存失效口径一致）：新增/删除技能或改分类表会失效，
/// 改单个 SKILL.md 内容不会变——那种情况重启应用或碰一下技能根目录即可。
pub fn index_skills(root: &Path) -> Result<Vec<PiSkillMeta>, String> {
    cached_index(root).map(|snapshot| snapshot.metas)
}

/// 索引快照：元数据（已按 `_tree.json` 补分类路径与关联）+ 分类表。
#[derive(Clone)]
struct IndexSnapshot {
    metas: Vec<PiSkillMeta>,
    taxonomy: Taxonomy,
}

fn cached_index(root: &Path) -> Result<IndexSnapshot, String> {
    if !root.is_dir() {
        return Err(format!("技能库目录不存在：{}", root.display()));
    }
    let signature = index_signature(root);
    if let Some(entry) = INDEX_CACHE.lock().ok().and_then(|guard| guard.clone()) {
        if entry.root == root && Some(entry.signature) == signature {
            return Ok(IndexSnapshot {
                metas: entry.metas,
                taxonomy: entry.taxonomy,
            });
        }
    }
    let taxonomy = load_taxonomy(root);
    let mut metas = scan_skills(root)?;
    apply_taxonomy(&mut metas, &taxonomy);
    if let Ok(mut guard) = INDEX_CACHE.lock() {
        if let Some(signature) = signature {
            *guard = Some(IndexCacheEntry {
                root: root.to_path_buf(),
                signature,
                metas: metas.clone(),
                taxonomy: taxonomy.clone(),
            });
        }
    }
    Ok(IndexSnapshot { metas, taxonomy })
}

/// 把分类路径与关联技能写进元数据（缓存里存的就是补全后的版本）。
fn apply_taxonomy(metas: &mut [PiSkillMeta], taxonomy: &Taxonomy) {
    for meta in metas.iter_mut() {
        meta.category_path = taxonomy.category_path(&meta.name);
        meta.category_order = taxonomy.category_order(&meta.name);
        meta.related = taxonomy
            .links
            .iter()
            .filter(|link| link.from == meta.name || link.to == meta.name)
            .map(|link| {
                let outbound = link.from == meta.name;
                PiSkillLink {
                    name: if outbound { link.to.clone() } else { link.from.clone() },
                    kind: link.kind.clone(),
                    direction: if outbound { "outbound" } else { "inbound" }.to_string(),
                    note: link.note.clone(),
                }
            })
            .collect();
    }
}

type IndexSignature = (std::time::SystemTime, usize, Option<std::time::SystemTime>);

#[derive(Clone)]
struct IndexCacheEntry {
    root: PathBuf,
    signature: IndexSignature,
    metas: Vec<PiSkillMeta>,
    taxonomy: Taxonomy,
}

static INDEX_CACHE: Lazy<Mutex<Option<IndexCacheEntry>>> = Lazy::new(|| Mutex::new(None));

fn index_signature(root: &Path) -> Option<IndexSignature> {
    let modified = std::fs::metadata(root).ok()?.modified().ok()?;
    let count = std::fs::read_dir(root)
        .ok()?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().join("SKILL.md").is_file())
        .count();
    let tree = std::fs::metadata(root.join(TAXONOMY_FILE))
        .ok()
        .and_then(|metadata| metadata.modified().ok());
    Some((modified, count, tree))
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
        let mut triggers: Vec<String> = yaml_list(&front, "triggers")
            .into_iter()
            .map(|value| truncate_at_clause(&value))
            .filter(|value| !value.is_empty())
            .collect();
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
            category_path: Vec::new(),
            category_order: usize::MAX,
            related: Vec::new(),
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

/// 一次打分结果：分数 + 是否带「豁免级」强信号。
///
/// 豁免 = 命中过技能名或格式词——这两类信号歧义最低（STL/XLSX/技能名），
/// 两级路由里即使所属分支没晋级，也保留入选资格，跨类任务
/// （如「生成图表并写进报告」里的 xlsx）不被分支一票否决。
struct ScoredSkill {
    meta: PiSkillMeta,
    score: f32,
    escape: bool,
}

/// 两级路由取多少个分支晋级。
const BRANCH_TOP_K: usize = 2;

/// 按任务文本选 1–2 个技能，并把正文截到 `max_chars` 以内。
///
/// 有 `_tree.json` 时走两级路由：
/// 1. 阶段 0：逐技能打分，权重与门槛与平铺版完全一致（排障基线不动）；
/// 2. 阶段 1：分支晋级——分支分 = 分支内最高成员分 + 类级触发词命中每个 +2，取 Top-2；
/// 3. 阶段 2：候选 = 晋级分支成员 ∪ 豁免技能，再做转发器互斥与 top_k 截断。
///
/// 无 `_tree.json`（或解析失败）时整库只有一个「未分类」分支，
/// 不做任何裁剪，行为与旧版平铺路由一致。
pub fn select_skills(
    root: &Path,
    text: &str,
    top_k: usize,
    max_chars: usize,
) -> Result<SkillRoute, String> {
    let snapshot = cached_index(root)?;
    let lower = text.to_lowercase();
    let text_tokens = tokens(text);
    let formats = format_terms_in_text(&lower);
    let mut scored: Vec<ScoredSkill> = Vec::new();
    for meta in snapshot.metas {
        let mut score = 0.0f32;
        // 强信号：名称 / 别名 / 触发词 / 格式词至少命中一个。纯描述 token
        // 命中太弱（真机实测：「帮我看看工作区里有什么文件」会误中市场查询
        // 类技能），不允许仅凭描述入选。
        let mut strong = false;
        // 豁免：名称与格式词的歧义最低，其余强信号（别名/触发词）不够格。
        let mut escape = false;
        let name_lower = meta.name.to_lowercase();
        if lower.contains(&name_lower) {
            score += 3.0;
            strong = true;
            escape = true;
        }
        // 格式词命中 +3：STL/MP4/XLSX 这类歧义最低；要求词出现在技能
        // 描述或名字里，避免「pdf」命中所有无关技能。
        for term in &formats {
            let description_lower = meta.description.to_lowercase();
            if description_lower.contains(term) || name_lower.contains(term) {
                score += 3.0;
                strong = true;
                escape = true;
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
            scored.push(ScoredSkill { meta, score, escape });
        }
    }
    scored.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.meta.name.cmp(&b.meta.name))
    });

    // 配套技能加成：关联对两端都已入选时各 +1（_tree.json 的 links），
    // 只影响排序与分支分，不改变入选资格。
    if !snapshot.taxonomy.links.is_empty() && scored.len() > 1 {
        let index_of: HashMap<String, usize> = scored
            .iter()
            .enumerate()
            .map(|(index, skill)| (skill.meta.name.clone(), index))
            .collect();
        for link in &snapshot.taxonomy.links {
            if let (Some(&a), Some(&b)) = (
                index_of.get(link.from.as_str()),
                index_of.get(link.to.as_str()),
            ) {
                if a != b {
                    scored[a].score += 1.0;
                    scored[b].score += 1.0;
                }
            }
        }
        scored.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.meta.name.cmp(&b.meta.name))
        });
    }

    // 阶段 1：分支晋级。分支分 = 分支内最高成员分 + 类级触发词命中每个 +2。
    // 未收录进 `_tree.json` 的技能组成隐式「未分类」分支，同等参与竞争。
    let mut advancing_branches: Vec<String> = Vec::new();
    if !snapshot.taxonomy.is_empty() && !scored.is_empty() {
        struct RankedBranch {
            label: String,
            score: f32,
            members: Vec<usize>,
        }
        let mut ranked: Vec<RankedBranch> = Vec::new();
        let mut unclassified: Vec<usize> = Vec::new();
        for branch in &snapshot.taxonomy.branches {
            ranked.push(RankedBranch {
                label: branch.label.clone(),
                score: 0.0,
                members: Vec::new(),
            });
        }
        for (index, skill) in scored.iter().enumerate() {
            let label = snapshot.taxonomy.branch_label(&skill.meta.name);
            match ranked.iter_mut().find(|entry| entry.label == label) {
                Some(entry) => {
                    entry.score = entry.score.max(skill.score);
                    entry.members.push(index);
                }
                None => unclassified.push(index),
            }
        }
        if !unclassified.is_empty() {
            let best = unclassified
                .iter()
                .map(|&index| scored[index].score)
                .fold(0.0f32, f32::max);
            ranked.push(RankedBranch {
                label: UNCLASSIFIED_LABEL.to_string(),
                score: best,
                members: unclassified,
            });
        }
        for entry in ranked.iter_mut() {
            let branch = snapshot
                .taxonomy
                .branches
                .iter()
                .find(|branch| branch.label == entry.label);
            if let Some(branch) = branch {
                for trigger in &branch.triggers {
                    if matches(text, &lower, trigger) {
                        entry.score += 2.0;
                    }
                }
            }
        }
        ranked.retain(|entry| entry.score > 0.0);
        // sort_by 稳定：同分保持 `_tree.json` 声明顺序。
        ranked.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        if !ranked.is_empty() {
            let top_count = BRANCH_TOP_K.min(ranked.len());
            let allowed: std::collections::HashSet<usize> = ranked
                .iter()
                .take(top_count)
                .flat_map(|entry| entry.members.iter().copied())
                .collect();
            advancing_branches = ranked
                .iter()
                .take(top_count)
                .map(|entry| entry.label.clone())
                .collect();
            let mut kept = Vec::with_capacity(scored.len());
            for (index, skill) in scored.into_iter().enumerate() {
                if allowed.contains(&index) || skill.escape {
                    kept.push(skill);
                }
            }
            scored = kept;
        }
    }

    // 转发器互斥：同一件事只留分最高的那一个转发器。
    let mut picked: Vec<(f32, PiSkillMeta)> = Vec::new();
    let mut seen_forwarder = false;
    for skill in scored {
        if skill.meta.kind == "delegated" {
            if seen_forwarder {
                continue;
            }
            seen_forwarder = true;
        }
        picked.push((skill.score, skill.meta));
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
            category_path: meta.category_path.clone(),
        });
    }
    // 分数在展开循环里丢了；从 picked 重新对齐，未展开的目标技能给 0。
    for skill in out.iter_mut() {
        if let Some((score, _)) = picked.iter().find(|(_, meta)| meta.name == skill.name) {
            skill.score = *score;
        }
    }
    Ok(SkillRoute {
        skills: out,
        branches: advancing_branches,
    })
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
    fn default_skills_dir_prefers_repo_pi_tree() {
        // 仓库内的 pi 专属技能树必须能被找到，
        // 且优先于应用数据目录（否则开发机上会误用旧副本）。
        let repo = repo_skills_dir().expect("仓库内应存在 app/resources/pi/skills");
        assert!(repo.ends_with("skills"));
        assert!(repo.join("comfyui-workflows").join("SKILL.md").is_file());
        assert!(repo.join("living-ascii-wallpaper").join("SKILL.md").is_file());
        let resolved = default_skills_dir(None).expect("应能定位到技能树");
        assert_eq!(resolved, repo);
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
        let route = select_skills(&root, "帮我写一份报告", 2, 4000).expect("select");
        // 临时目录没有 _tree.json：分类路径为空、分支不晋级（平铺路由）。
        assert!(route.skills[0].category_path.is_empty());
        assert!(route.branches.is_empty());
        assert_eq!(route.skills.len(), 1);
        assert_eq!(route.skills[0].name, "doc-writer");
        assert!(route.skills[0].body.contains("先列大纲"));
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
        let route = select_skills(&root, "不要写报告，直接生图", 2, 4000).expect("select");
        assert!(route.skills.iter().all(|skill| skill.name != "doc-writer"));
        assert!(route.skills.iter().any(|skill| skill.name == "image-gen"));
        // 转发器正文被替换成画布工具转发说明
        let img = route.skills.iter().find(|skill| skill.name == "image-gen").unwrap();
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
        let route = select_skills(&root, "把这张图放大到 4k", 2, 4000).expect("select");
        let forwarders: Vec<&str> = route.skills
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
        let route = select_skills(&root, "画个手柄底座的 stl", 1, 4000).expect("select");
        assert_eq!(route.skills[0].name, "print3d");
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
        let route = select_skills(&root, "画硫酸根结构式存 svg", 2, 4000).expect("select");
        assert_eq!(route.skills[0].name, "svg-drawing");
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
        let route = select_skills(&root, "唱一首关于春天的歌", 2, 4000).expect("select");
        assert!(route.skills.iter().all(|skill| skill.name != "tts-local"));
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
        let route = select_skills(&root, "做一个长任务", 1, 300).expect("select");
        assert_eq!(route.skills.len(), 1);
        assert!(route.skills[0].body.chars().count() <= 330);
        assert!(route.skills[0].body.contains("已截断"));
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
            category_path: Vec::new(),
        }];
        let text = render_skill_context(&skills);
        assert!(text.contains("技能：doc-writer"));
        assert!(text.contains("先列大纲"));
    }

    #[test]
    fn real_skills_router_regression() {
        // 用宿主真正会用的目录，不要写死路径：技能树换位后路由可能断。
        let Some(root) = default_skills_dir(None) else {
            return;
        };
        if !root.is_dir() {
            return;
        }
        let root = root.as_path();
        let metas = index_skills(root).expect("index real skills");
        println!("技能总数：{}", metas.len());
        let delegated_count = metas
            .iter()
            .filter(|meta| meta.kind == "delegated")
            .count();
        assert_eq!(delegated_count, 4, "应有 4 个转发器");

        // 技能树（_tree.json）必须让绝大多数技能带上分类路径。
        let classified = metas.iter().filter(|meta| !meta.category_path.is_empty()).count();
        println!("已分类：{classified}/{}", metas.len());
        assert!(classified as f32 >= metas.len() as f32 * 0.95, "分类覆盖率不足：{classified}/{}", metas.len());

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
            let route = select_skills(root, text, 2, 8000).expect("select");
            let names: Vec<&str> = route.skills.iter().map(|skill| skill.name.as_str()).collect();
            println!("{text} -> {names:?}（分支：{:?}）", route.branches);
            // 两级路由在真库上必须真的启用（_tree.json 已入库）；
            // 零命中的输入（如「看看工作区里有什么文件」）没有晋级分支属正常。
            if !expect_any.is_empty() {
                assert!(!route.branches.is_empty(), "{text} 没有晋级分支：{names:?}");
            }
            // 全局不变量：任何输入最多命中一个转发器；且不允许重复注入。
            let forwarders = route
                .skills
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

    /// 写一份 `_tree.json` 到临时技能库根目录。
    fn write_tree(root: &Path, json: &str) {
        std::fs::write(root.join("_tree.json"), json).unwrap();
    }

    #[test]
    fn two_stage_gating_cuts_offbranch_and_escape_saves_format_hit() {
        // 四个分支：媒体(4.0) 数据(3.0,格式词) 工程(3.0,格式词) 文档(2.0)。
        // Top-2 = 媒体 + 数据；工程分支的 budget-tool 靠 xlsx 格式词豁免活下来，
        // 文档分支的 doc-writer（无豁免）被裁掉。
        let root = temp_root("two-stage");
        write_skill(
            &root,
            "notepad",
            "name: notepad\ndescription: 记事本\ntools:\n  - write_file\ntriggers:\n  - 数据\n  - 导出",
            "记录数据。",
        );
        write_skill(
            &root,
            "doc-writer",
            "name: doc-writer\ndescription: 写正式文档\ntriggers:\n  - 报表",
            "写文档。",
        );
        write_skill(
            &root,
            "sheet-helper",
            "name: sheet-helper\ndescription: 把数据导出成 xlsx 表格",
            "导出表格。",
        );
        write_skill(
            &root,
            "budget-tool",
            "name: budget-tool\ndescription: 预算表处理，读写 xlsx",
            "处理预算。",
        );
        write_tree(
            &root,
            r#"{"version":1,"categories":[
                {"id":"media","label":"媒体","children":[{"id":"img","label":"图像","members":["notepad"]}]},
                {"id":"docs","label":"文档","members":["doc-writer"]},
                {"id":"data","label":"数据","members":["sheet-helper"]},
                {"id":"eng","label":"工程","members":["budget-tool"]}
            ]}"#,
        );
        let route = select_skills(&root, "把这份数据导出成 xlsx 报表", 3, 4000).expect("select");
        let names: Vec<&str> = route.skills.iter().map(|s| s.name.as_str()).collect();
        println!("两级路由 -> {names:?}（分支：{:?}）", route.branches);
        assert_eq!(route.branches, vec!["数据".to_string(), "媒体".to_string()]);
        assert!(names.contains(&"notepad"), "最高分在晋级分支内：{names:?}");
        assert!(names.contains(&"sheet-helper"), "格式词豁免技能应入选：{names:?}");
        assert!(names.contains(&"budget-tool"), "工程分支被裁，但 xlsx 格式词豁免应保住 budget-tool：{names:?}");
        assert!(!names.contains(&"doc-writer"), "文档分支未晋级且无豁免，应被裁掉：{names:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn branch_trigger_boosts_branch_ranking() {
        // music-gen 自身零命中，但「写首歌」命中媒体分支的类级触发词，
        // 让媒体分支晋级，从而 notepad（晋级分支成员）胜出。
        let root = temp_root("branch-trigger");
        write_skill(
            &root,
            "music-gen",
            "name: music-gen\ndescription: 音乐生成",
            "音乐。",
        );
        write_skill(
            &root,
            "doc-writer",
            "name: doc-writer\ndescription: 写正式文档\ntriggers:\n  - 报表",
            "写文档。",
        );
        write_skill(
            &root,
            "notepad",
            "name: notepad\ndescription: 记事本\ntriggers:\n  - 记一下\ntools:\n  - write_file",
            "记录。",
        );
        write_tree(
            &root,
            r#"{"version":1,"categories":[
                {"id":"media","label":"媒体","triggers":["写首歌"],"children":[{"id":"img","label":"图像","members":["music-gen","notepad"]}]},
                {"id":"docs","label":"文档","members":["doc-writer"]}
            ]}"#,
        );
        let route = select_skills(&root, "写首歌，顺便记一下备忘", 2, 4000).expect("select");
        let names: Vec<&str> = route.skills.iter().map(|s| s.name.as_str()).collect();
        println!("类级触发词 -> {names:?}（分支：{:?}）", route.branches);
        assert!(route.branches.contains(&"媒体".to_string()), "类级触发词应让媒体分支晋级：{:?}", route.branches);
        assert!(names.contains(&"notepad"), "notepad 应入选：{names:?}");
        assert!(!names.contains(&"doc-writer"), "文档分支未晋级且 doc-writer 无豁免：{names:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn linked_complements_outrank_strangers() {
        // 三个同分技能按名字序本会选 alpha/mid；links 让 zeta↔alpha 各 +1，
        // 于是 zeta 与 alpha 双双入选，mid 被挤掉。单分支避免门控干扰。
        let root = temp_root("links");
        for (name, trigger) in [("zeta", "清单"), ("alpha", "清单"), ("mid", "清单")] {
            write_skill(
                &root,
                name,
                &format!("name: {name}\ndescription: 通用处理\ntriggers:\n  - {trigger}"),
                "正文。",
            );
        }
        write_tree(
            &root,
            r#"{"version":1,"categories":[
                {"id":"misc","label":"通用","members":["zeta","alpha","mid"]}
            ],
            "links":[{"from":"zeta","type":"complement","to":"alpha","note":"配套"}]}"#,
        );
        let route = select_skills(&root, "帮我整理这份清单", 2, 4000).expect("select");
        let names: Vec<&str> = route.skills.iter().map(|s| s.name.as_str()).collect();
        println!("关联加成 -> {names:?}");
        assert!(names.contains(&"zeta") && names.contains(&"alpha"), "配套对应一起入选：{names:?}");
        assert!(!names.contains(&"mid"), "无关联的 mid 应被挤出 Top-2：{names:?}");
        // 索引里能查到双向关联。
        let metas = index_skills(&root).expect("index");
        let zeta = metas.iter().find(|meta| meta.name == "zeta").unwrap();
        assert!(zeta.related.iter().any(|link| link.name == "alpha" && link.direction == "outbound"));
        assert_eq!(zeta.category_path, vec!["通用".to_string()]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn broken_tree_json_falls_back_to_flat() {
        let root = temp_root("broken-tree");
        write_skill(
            &root,
            "doc-writer",
            "name: doc-writer\ndescription: 写正式文档\ntriggers:\n  - 报告",
            "写文档。",
        );
        write_tree(&root, "{ 这不是合法 JSON");
        let metas = index_skills(&root).expect("index");
        assert!(metas[0].category_path.is_empty(), "非法 tree.json 应按未分类处理");
        let route = select_skills(&root, "帮我写一份报告", 2, 4000).expect("select");
        assert_eq!(route.skills.len(), 1);
        assert_eq!(route.skills[0].name, "doc-writer");
        assert!(route.branches.is_empty(), "退化平铺时不该有晋级分支");
        let _ = std::fs::remove_dir_all(&root);
    }
}
