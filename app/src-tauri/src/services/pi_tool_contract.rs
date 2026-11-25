//! 宿主工具契约：Rust 侧能执行的工具 与 TS 扩展放行的工具，必须是同一份清单。
//!
//! 这两份清单是**独立维护**的，漏登记就有两种静默故障：
//! - 只加了 `pi.registerTool`、没加进 TS 的 `HOST_TOOLS` → `pi.setActiveTools(names)`
//!   不含它，模型根本看不见这个工具（2026-11-09 实测：make_docx 失联就是这个原因，
//!   表现是模型全程 list_dir/run_command 打转、文档永远不落盘）；
//! - 只加了 Rust 的 `execute_tool` 分支、没加进 TS 白名单 → `tool_call` 守卫
//!   直接把调用拦掉，模型会拿到「工具已被宿主禁用」。
//!
//! 下面的测试直接读两个源文件做集合比对，任何一侧漏登记都会红。
//! 整个模块只在测试期存在，避免非测试构建报 dead_code。

#[cfg(test)]
mod contract {
    /// Rust 侧 `execute_tool` 支持的工具（含 MCP 路由走 mcp__ 前缀，不在此列）。
    const HOST_TOOL_NAMES: &[&str] = &[
        "read_file",
        "write_file",
        "edit_file",
        "list_dir",
        "run_command",
        "run_python",
        "save_memory",
        "make_docx",
        "make_xlsx",
        "read_docx",
        "read_xlsx",
        "canvas_status",
        "canvas_list_workflows",
        "canvas_get_workflow",
        "canvas_run",
        "canvas_cancel",
    ];

    fn service_source(name: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("services")
            .join(name);
        std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("读取 {} 失败：{error}", path.display()))
    }

    /// 解析 TS 扩展里 HOST_TOOLS 数组的字符串字面量。
    fn extension_whitelist(source: &str) -> Vec<String> {
        let start = source
            .find("const HOST_TOOLS = [")
            .expect("pi_host_tools.ts 里找不到 HOST_TOOLS 数组");
        let end = start
            + source[start..]
                .find("] as const;")
                .expect("pi_host_tools.ts 里 HOST_TOOLS 数组未闭合");
        source[start..end]
            .lines()
            .filter_map(|line| {
                let trimmed = line.trim().trim_end_matches(',');
                let value = trimmed.strip_prefix('"')?;
                value.strip_suffix('"').map(|name| name.to_string())
            })
            .collect()
    }

    #[test]
    fn extension_whitelist_matches_rust_tool_list() {
        let whitelist = extension_whitelist(&service_source("pi_host_tools.ts"));
        for name in HOST_TOOL_NAMES {
            assert!(
                whitelist.iter().any(|item| item == name),
                "pi_host_tools.ts 的 HOST_TOOLS 缺少 {name}：模型看不到该工具，\
                 tool_call 守卫也会拦掉它（两处独立维护，务必同步）"
            );
        }
        for name in &whitelist {
            assert!(
                HOST_TOOL_NAMES.contains(&name.as_str()),
                "pi_host_tools.ts 放行了 {name}，但 Rust 侧 HOST_TOOL_NAMES 没有登记"
            );
        }
    }

    #[test]
    fn every_whitelisted_tool_has_dispatch_branch() {
        let source = service_source("pi_tools.rs");
        for name in HOST_TOOL_NAMES {
            // 分发分支可能写成合并臂（`"read_docx" | "read_xlsx" =>`），
            // 所以按「同一行里出现该工具名且该行是 match 臂」判定。
            let has_branch = source
                .lines()
                .any(|line| line.contains(&format!("\"{name}\"")) && line.contains("=>"));
            assert!(has_branch, "execute_tool 缺少 {name} 的分发分支");
        }
    }

    #[test]
    fn extension_registers_every_whitelisted_tool() {
        let source = service_source("pi_host_tools.ts");
        for name in HOST_TOOL_NAMES {
            assert!(
                source.contains(&format!("name: \"{name}\"")),
                "pi_host_tools.ts 没有为 {name} 注册 registerTool"
            );
        }
    }
}
