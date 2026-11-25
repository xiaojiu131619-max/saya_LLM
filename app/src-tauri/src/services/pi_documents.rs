//! Pi 文档工作站：make/read docx 与 xlsx。
//!
//! 不引第三方 OOXML 库——docx / xlsx 本质是 zip + 几个 XML 部件，
//! 用已有的 `zip` crate 手写最小合法包（Word / WPS / Excel 均可打开）。
//! 里程碑版能力边界（刻意保持简单）：
//! - docx：标题（Heading 1-3，带内置 styles.xml）、段落、加粗；列表用
//!   「•  / 1. 」文字前缀实现，不生成 numbering.xml；
//! - xlsx：多 sheet、文本与数值单元格（inlineStr，无样式列宽）；
//! - read：docx 抽段落纯文本，xlsx 抽行 TSV（inlineStr 与数值都认，
//!   共享字符串表按需解析）。
//!
//! 所有写入都由 execute_tool 落盘（那里已有沙箱、权限与检查点挂钩）；
//! 本模块只管字节。

use std::io::{Read as _, Write as _};

use serde::Deserialize;
use zip::write::SimpleFileOptions;
use zip::{ZipArchive, ZipWriter};

// ---------------------------------------------------------------------------
// XML 基础
// ---------------------------------------------------------------------------

/// XML 文本转义（属性与文本内容通用）。
fn xml_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c => out.push(c),
        }
    }
    out
}

const XML_DECL: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#;

// ---------------------------------------------------------------------------
// docx
// ---------------------------------------------------------------------------

/// docx 的一个内容块（工具参数按此结构传输）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxBlock {
    /// heading | paragraph | bullet | numbered
    #[serde(rename = "type")]
    pub kind: String,
    pub text: String,
    /// heading 级别 1-3（默认 1）。
    #[serde(default)]
    pub level: Option<u8>,
    /// 段落是否加粗（heading 恒为粗体）。
    #[serde(default)]
    pub bold: Option<bool>,
}

fn docx_content_types() -> String {
    format!(
        "{XML_DECL}\n\
<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
<Default Extension=\"xml\" ContentType=\"application/xml\"/>\
<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>\
<Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/>\
</Types>"
    )
}

fn root_rels() -> String {
    format!(
        "{XML_DECL}\n\
<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/>\
</Relationships>"
    )
}

fn docx_document_rels() -> String {
    format!(
        "{XML_DECL}\n\
<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/>\
</Relationships>"
    )
}

/// 最小样式表：只定义 Heading 1-3（大字号加粗），正文用默认。
fn docx_styles() -> String {
    let style = |id: &str, name: &str, size: u32| {
        format!(
            "<w:style w:type=\"paragraph\" w:styleId=\"{id}\">\
<w:name w:val=\"{name}\"/><w:basedOn w:val=\"Normal\"/><w:qFormat/>\
<w:pPr><w:keepNext/><w:outlineLvl w:val=\"{lvl}\"/></w:pPr>\
<w:rPr><w:b/><w:sz w:val=\"{size}\"/></w:rPr></w:style>",
            id = id,
            name = name,
            size = size,
            lvl = id.trim_start_matches("Heading").parse::<u32>().unwrap_or(0),
        )
    };
    format!(
        "{XML_DECL}\n\
<w:styles xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">\
<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val=\"22\"/></w:rPr></w:rPrDefault></w:docDefaults>\
{}{}{}\
</w:styles>",
        style("Heading1", "heading 1", 32),
        style("Heading2", "heading 2", 28),
        style("Heading3", "heading 3", 24),
    )
}

fn docx_run(text: &str, bold: bool) -> String {
    let rpr = if bold { "<w:rPr><w:b/></w:rPr>" } else { "" };
    format!(
        "<w:r>{rpr}<w:t xml:space=\"preserve\">{}</w:t></w:r>",
        xml_escape(text)
    )
}

fn docx_paragraph(block: &DocxBlock, index: &mut usize) -> String {
    match block.kind.as_str() {
        "heading" => {
            let level = block.level.unwrap_or(1).clamp(1, 3);
            format!(
                "<w:p><w:pPr><w:pStyle w:val=\"Heading{level}\"/></w:pPr>{}</w:p>",
                docx_run(&block.text, true)
            )
        }
        "bullet" => {
            *index += 1;
            format!("<w:p>{}</w:p>", docx_run(&format!("•  {}", block.text), false))
        }
        "numbered" => {
            *index += 1;
            format!(
                "<w:p>{}</w:p>",
                docx_run(&format!("{}.  {}", index, block.text), false)
            )
        }
        _ => format!(
            "<w:p>{}</w:p>",
            docx_run(&block.text, block.bold.unwrap_or(false))
        ),
    }
}

/// 生成 docx 字节。
pub fn make_docx(title: Option<&str>, blocks: &[DocxBlock]) -> Result<Vec<u8>, String> {
    let mut body = String::new();
    if let Some(title) = title.map(str::trim).filter(|t| !t.is_empty()) {
        body.push_str(&format!(
            "<w:p><w:pPr><w:pStyle w:val=\"Heading1\"/></w:pPr>{}</w:p>",
            docx_run(title, true)
        ));
    }
    let mut index = 0usize;
    for block in blocks {
        body.push_str(&docx_paragraph(block, &mut index));
    }
    let document = format!(
        "{XML_DECL}\n\
<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">\
<w:body>{body}<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/></w:sectPr></w:body>\
</w:document>"
    );

    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut zip = ZipWriter::new(&mut buf);
        let options = SimpleFileOptions::default();
        for (name, content) in [
            ("[Content_Types].xml", docx_content_types()),
            ("_rels/.rels", root_rels()),
            ("word/document.xml", document),
            ("word/styles.xml", docx_styles()),
            ("word/_rels/document.xml.rels", docx_document_rels()),
        ] {
            zip.start_file(name, options)
                .map_err(|error| format!("打包 docx 失败：{error}"))?;
            zip.write_all(content.as_bytes())
                .map_err(|error| format!("写入 docx 部件失败：{error}"))?;
        }
        zip.finish()
            .map_err(|error| format!("收尾 docx 失败：{error}"))?;
    }
    Ok(buf.into_inner())
}

/// 读取 docx：按段落抽出纯文本（每段一行）。
pub fn read_docx(bytes: &[u8]) -> Result<String, String> {
    let document = read_zip_entry(bytes, "word/document.xml")?;
    let mut paragraphs = Vec::new();
    // 按 <w:p> / <w:p attr…> 两种段落开标签分段（<w:pPr 等不算）；
    // 本模块生成的是无属性 <w:p>，外部 Word 文件通常带属性，两者都要认。
    let mut cursor = 0usize;
    while let Some(rel) = document[cursor..].find("<w:p").map(|rel| cursor + rel) {
        let after = &document[rel + 4..];
        if !(after.starts_with('>') || after.starts_with(' ')) {
            cursor = rel + 4;
            continue;
        }
        let body_start = rel + 5;
        let Some(end_rel) = document[body_start..].find("</w:p>") else {
            break;
        };
        let body = &document[body_start..body_start + end_rel];
        cursor = body_start + end_rel + 6;
        let mut text = String::new();
        let mut rest = body;
        while let Some(start) = rest.find("<w:t").map(|rel| {
            // <w:t> 或 <w:t attr…> 才是文本节点；<w:tbl 等不算。
            let after_t = &rest[rel + 4..];
            if after_t.starts_with('>') || after_t.starts_with(' ') {
                Some(rel)
            } else {
                None
            }
        }) {
            let Some(start) = start else { break };
            rest = &rest[start..];
            let Some(gt) = rest.find('>') else { break };
            let after = &rest[gt + 1..];
            let Some(end) = after.find("</w:t>") else { break };
            text.push_str(&after[..end]);
            rest = &after[end + 6..];
        }
        let text = xml_unescape(&text);
        if !text.trim().is_empty() {
            paragraphs.push(text);
        }
    }
    Ok(if paragraphs.is_empty() {
        "（文档为空）".to_string()
    } else {
        paragraphs.join("\n")
    })
}

/// 反转义 XML 文本（读取路径用）。
fn xml_unescape(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

// ---------------------------------------------------------------------------
// xlsx
// ---------------------------------------------------------------------------

/// xlsx 的一个工作表（工具参数按此结构传输）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XlsxSheet {
    pub name: String,
    /// 行 × 单元格；字符串原样、数字按数值写、null 跳过。
    #[serde(default)]
    pub rows: Vec<Vec<serde_json::Value>>,
}

fn col_letter(mut column: usize) -> String {
    // 1 → A, 26 → Z, 27 → AA
    let mut out = Vec::new();
    while column > 0 {
        let rem = (column - 1) % 26;
        out.push(b'A' + rem as u8);
        column = (column - 1) / 26;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

fn xlsx_content_types(sheet_count: usize) -> String {
    let overrides = (1..=sheet_count)
        .map(|index| {
            format!(
                "<Override PartName=\"/xl/worksheets/sheet{index}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>"
            )
        })
        .collect::<String>();
    format!(
        "{XML_DECL}\n\
<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
<Default Extension=\"xml\" ContentType=\"application/xml\"/>\
<Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>\
{overrides}</Types>"
    )
}

fn xlsx_workbook(sheet_names: &[String]) -> String {
    let sheets = sheet_names
        .iter()
        .enumerate()
        .map(|(index, name)| {
            format!(
                "<sheet name=\"{}\" sheetId=\"{}\" r:id=\"rId{}\"/>",
                xml_escape(name),
                index + 1,
                index + 1
            )
        })
        .collect::<String>();
    format!(
        "{XML_DECL}\n\
<w:workbook xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" \
xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">\
<sheets>{sheets}</sheets></w:workbook>"
    )
}

fn xlsx_workbook_rels(sheet_count: usize) -> String {
    let rels = (1..=sheet_count)
        .map(|index| {
            format!(
                "<Relationship Id=\"rId{index}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet{index}.xml\"/>"
            )
        })
        .collect::<String>();
    format!(
        "{XML_DECL}\n\
<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">{rels}</Relationships>"
    )
}

fn xlsx_sheet_xml(rows: &[Vec<serde_json::Value>]) -> String {
    let mut sheet = String::from("<sheetData>");
    for (row_index, row) in rows.iter().enumerate() {
        sheet.push_str(&format!("<row r=\"{}\">", row_index + 1));
        for (col_index, cell) in row.iter().enumerate() {
            let reference = format!("{}{}", col_letter(col_index + 1), row_index + 1);
            match cell {
                serde_json::Value::Null => {}
                serde_json::Value::Number(number) => {
                    sheet.push_str(&format!("<c r=\"{reference}\"><v>{number}</v></c>"));
                }
                value => {
                    let text = match value {
                        serde_json::Value::Bool(flag) => flag.to_string(),
                        other => other.to_string().trim_matches('"').to_string(),
                    };
                    sheet.push_str(&format!(
                        "<c r=\"{reference}\" t=\"inlineStr\"><is><t xml:space=\"preserve\">{}</t></is></c>",
                        xml_escape(&text)
                    ));
                }
            }
        }
        sheet.push_str("</row>");
    }
    sheet.push_str("</sheetData>");
    format!(
        "{XML_DECL}\n\
<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">{sheet}</worksheet>"
    )
}

/// 生成 xlsx 字节。
pub fn make_xlsx(sheets: &[XlsxSheet]) -> Result<Vec<u8>, String> {
    if sheets.is_empty() {
        return Err("至少需要一个工作表。".to_string());
    }
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut zip = ZipWriter::new(&mut buf);
        let options = SimpleFileOptions::default();
        let entries: Vec<(String, String)> = std::iter::once((
            "[Content_Types].xml".to_string(),
            xlsx_content_types(sheets.len()),
        ))
        .chain(std::iter::once((
            "_rels/.rels".to_string(),
            root_rels(),
        )))
        .chain(std::iter::once((
            "xl/workbook.xml".to_string(),
            xlsx_workbook(&sheets.iter().map(|s| s.name.clone()).collect::<Vec<_>>()),
        )))
        .chain(std::iter::once((
            "xl/_rels/workbook.xml.rels".to_string(),
            xlsx_workbook_rels(sheets.len()),
        )))
        .chain(sheets.iter().enumerate().map(|(index, sheet)| {
            (
                format!("xl/worksheets/sheet{}.xml", index + 1),
                xlsx_sheet_xml(&sheet.rows),
            )
        }))
        .collect();
        for (name, content) in entries {
            zip.start_file(name, options)
                .map_err(|error| format!("打包 xlsx 失败：{error}"))?;
            zip.write_all(content.as_bytes())
                .map_err(|error| format!("写入 xlsx 部件失败：{error}"))?;
        }
        zip.finish()
            .map_err(|error| format!("收尾 xlsx 失败：{error}"))?;
    }
    Ok(buf.into_inner())
}

/// 读取 xlsx：返回「表名 → 行 TSV」；不指定表名时读第一个。
pub fn read_xlsx(bytes: &[u8], sheet_name: Option<&str>) -> Result<String, String> {
    let workbook = read_zip_entry(bytes, "xl/workbook.xml")?;
    let rels = read_zip_entry(bytes, "xl/_rels/workbook.xml.rels")?;
    // 表名 → rId → 目标文件。
    let mut names_in_order: Vec<(String, String)> = Vec::new(); // (name, rId)
    for chunk in workbook.split("<sheet ").skip(1) {
        let name = chunk
            .split("name=\"")
            .nth(1)
            .and_then(|rest| rest.split('"').next())
            .unwrap_or("")
            .to_string();
        let rid = chunk
            .split("r:id=\"")
            .nth(1)
            .and_then(|rest| rest.split('"').next())
            .unwrap_or("")
            .to_string();
        if !name.is_empty() && !rid.is_empty() {
            names_in_order.push((xml_unescape(&name), rid));
        }
    }
    let picked = match sheet_name.map(str::trim).filter(|s| !s.is_empty()) {
        Some(wanted) => {
            let wanted = wanted.to_string();
            match names_in_order.iter().find(|(name, _)| *name == wanted) {
                Some((_, rid)) => rid.clone(),
                None => {
                    return Err(format!(
                        "没有名为「{wanted}」的工作表；可用：{}",
                        names_in_order.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>().join("、")
                    ))
                }
            }
        }
        None => names_in_order
            .first()
            .map(|(_, rid)| rid.clone())
            .ok_or_else(|| "工作簿里没有工作表。".to_string())?,
    };
    let target = rels
        .split(&format!("Id=\"{picked}\""))
        .nth(1)
        .and_then(|rest| rest.split("Target=\"").nth(1))
        .and_then(|rest| rest.split('"').next())
        .ok_or_else(|| "工作表关系损坏。".to_string())?;
    let entry = format!("xl/{}", target.trim_start_matches("/xl/"));
    let sheet = read_zip_entry(bytes, &entry)?;

    let mut rows: Vec<String> = Vec::new();
    for row_chunk in sheet.split("<row ").skip(1) {
        let row_body = match row_chunk.find("</row>") {
            Some(end) => &row_chunk[..end],
            None => continue,
        };
        let mut cells: Vec<String> = Vec::new();
        for cell_chunk in row_body.split("<c ").skip(1) {
            let cell_body = match cell_chunk.find("</c>") {
                Some(end) => &cell_chunk[..end],
                None => continue,
            };
            let (is_text, value) = if let Some(pos) = cell_body.find("<is>") {
                // inlineStr：<t> / <t attr…> 开标签到 </t> 之间的文本。
                // 不能用 split('>') 跳过属性——它会把 </t> 的 `>` 吃掉，
                // 剩下的 `</t` 再也匹配不上完整闭合标签（教训见单测）。
                let inner = &cell_body[pos + 4..];
                let mut text = String::new();
                let mut rest = inner;
                while let Some(hit) = rest.find("<t").map(|rel| {
                    // `<t` 只有 2 字符：边界检查从 rel+2 起（`<t>` / `<t attr…>`）。
                    let after_t = &rest[rel + 2..];
                    if after_t.starts_with('>') || after_t.starts_with(' ') {
                        Some(rel)
                    } else {
                        None
                    }
                }) {
                    let Some(start) = hit else { break };
                    rest = &rest[start..];
                    let Some(gt) = rest.find('>') else { break };
                    let after = &rest[gt + 1..];
                    let Some(end) = after.find("</t>") else { break };
                    text.push_str(&after[..end]);
                    rest = &after[end + 4..];
                }
                (true, text)
            } else if let Some(pos) = cell_body.find("<v>") {
                let rest = &cell_body[pos + 3..];
                let value = rest.split("</v>").next().unwrap_or("");
                (false, value.to_string())
            } else {
                (false, String::new())
            };
            let value = xml_unescape(&value);
            if !value.is_empty() {
                if is_text || value.parse::<f64>().is_err() {
                    cells.push(value.replace('\t', " ").replace('\n', " "));
                } else {
                    cells.push(value);
                }
            } else {
                cells.push(String::new());
            }
        }
        while cells.last().is_some_and(|last| last.is_empty()) {
            cells.pop();
        }
        rows.push(cells.join("\t"));
    }
    Ok(if rows.is_empty() {
        "（工作表为空）".to_string()
    } else {
        rows.join("\n")
    })
}

// ---------------------------------------------------------------------------
// zip 基础
// ---------------------------------------------------------------------------

fn read_zip_entry(bytes: &[u8], name: &str) -> Result<String, String> {
    let mut archive = ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|error| format!("不是合法的 OOXML 包：{error}"))?;
    let mut file = archive
        .by_name(name)
        .map_err(|_| format!("包内缺少 {name}，可能不是有效的 docx/xlsx。"))?;
    let mut content = String::new();
    file.read_to_string(&mut content)
        .map_err(|error| format!("读取 {name} 失败：{error}"))?;
    Ok(content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn docx_roundtrip_contains_escaped_text() {
        let blocks = vec![
            DocxBlock { kind: "heading".into(), text: "季度报告".into(), level: Some(1), bold: None },
            DocxBlock { kind: "paragraph".into(), text: "营收 <增长> &利润".into(), level: None, bold: Some(true) },
            DocxBlock { kind: "bullet".into(), text: "要点一".into(), level: None, bold: None },
        ];
        let bytes = make_docx(Some("标题"), &blocks).expect("make");
        let text = read_docx(&bytes).expect("read");
        assert!(text.contains("标题"), "title not found in: {text:?}");
        assert!(text.contains("营收 <增长> &利润"), "escaped para not found in: {text:?}");
        assert!(text.contains("•  要点一"), "bullet not found in: {text:?}");
    }

    #[test]
    fn xlsx_roundtrip_keeps_numbers_and_text() {
        let sheets = vec![XlsxSheet {
            name: "数据".into(),
            rows: vec![
                vec![serde_json::json!("名称"), serde_json::json!("数量")],
                vec![serde_json::json!("苹果"), serde_json::json!(42)],
            ],
        }];
        let bytes = make_xlsx(&sheets).expect("make");
        let text = read_xlsx(&bytes, Some("数据")).expect("read");
        assert!(text.contains("名称\t数量"), "row1 not found in: {text:?}");
        assert!(text.contains("苹果\t42"), "row2 not found in: {text:?}");
        assert!(read_xlsx(&bytes, Some("不存在")).is_err());
    }

    #[test]
    fn col_letter_matches_spreadsheet_references() {
        assert_eq!(col_letter(1), "A");
        assert_eq!(col_letter(26), "Z");
        assert_eq!(col_letter(27), "AA");
    }
}
