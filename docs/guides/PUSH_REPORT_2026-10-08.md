# Agent LLM 推送报告

> **报告日期：** 2026-10-08  
> **项目版本：** 0.4.0  
> **当前分支：** `main`  
> **当前提交：** `b87c896`（`09.28更新推送`）  
> **报告状态：** 待审核、待提交/推送

## 一、推送范围

本次推送围绕 fast-27b 工作台和本地智能体链路进行整合，覆盖以下需求：

- fast-27b 界面精简与模型切换；
- Swift / Heretic 27B 模型接入；
- DSH 与官方 WebUI 入口保留并重新排版；
- API 状态、对外 API 配置和 Token 统计整合；
- Chat 页面布局调整；
- MCP 工具调用链修复和 fast-27b 支持；
- DSH 管理、WebUI bridge、启动脚本及相关文档同步更新。

## 二、功能变更

### 1. fast-27b 工作台

- 增加 **Swift / Heretic** 模型选择。
- Heretic 默认模型路径：

  ```text
  D:\Projects\fast-llm\model\Ternary-Bonsai-2-27B-Heretic.ninfer
  ```

- Swift 自动探测以下模型文件：

  ```text
  bonsai2_27b_swift_pq2.v3.ninfer
  bonsai2_27b_swift_pq2.ninfer
  ```

- 默认推理引擎路径：

  ```text
  D:\Projects\fast-llm\engine\infer-engine-sm86-20261002\engine\ninfer-serve-86.exe
  ```

- 启动参数与 `D:\Projects\fast-llm\launch\fastllm-ui.mjs` 及 BAT 配置对齐，显式保留上下文、KV、预填充、视觉、并发、最大输出及思考强度等参数。
- Heretic 使用 `--spec none`，不传草稿参数。
- Swift 使用 `--spec mtp`、`--draft-tokens 4`、`--lm-head-draft`。
- 保留并整合启动、停止、重启、配置保存、日志查看、清空日志、DSH 绑定/解除绑定和 WebUI 入口。
- 通过状态卡展示进程、接口、引擎退化和 DSH 绑定状态，减少不必要的页面占用。

### 2. API 状态与 Token 统计

- 从设置页移除独立的“对外 API”区域。
- 将对外 API 配置集中到“API 状态”页面，统一管理监听范围、端口、API Key 和调用示例。
- API 状态页新增：
  - 累计 Token；
  - 输入 Token；
  - 输出 Token；
  - 请求次数；
  - 对外 API Token 与请求次数；
  - 当前接口地址；
  - 健康状态；
  - 模型状态；
  - 接口响应延迟；
  - 当前鉴权状态。
- 统计数据复用应用现有 `usageByModel`，并保留从 llama-server 日志同步对外 API 用量的逻辑。

### 3. Chat 页面排版

- 侧栏展开时保留搜索、会话分组和会话列表。
- 侧栏折叠后隐藏会话标题、搜索框和完整会话列表，保留：
  - 展开按钮；
  - 新建对话；
  - 模型状态；
  - 主题切换；
  - 软件设置。
- 保留消息中的思考内容折叠和工具调用记录，避免丢失调试信息。
- 调整 Chat 主区域、消息气泡及工具状态展示，减少空白和重复占位。

### 4. MCP 工具调用

- 主模型和 fast-27b 均向请求传递已连接 MCP Server 的工具清单。
- 移除 fast-27b 的工具限制，使其可以进入统一 MCP 调用链。
- 修复首轮工具调用未进入执行循环的问题：

  ```text
  模型返回 tool_calls
  → 应用调用 callMcpTool
  → 回填 assistant.tool_calls 与 tool.tool_call_id
  → 模型继续生成最终回答
  ```

- 保留 `tool_calls`、`tool_call_id` 和 `name` 等字段，兼容 OpenAI 风格工具调用消息。
- 支持主模型和 fast-27b 的工具调用结果回填及多轮继续生成。

### 5. DSH / WebUI 接入

- 保留 DSH 管理入口和官方 WebUI 入口，不将 WebUI 重绘为应用内重复页面。
- 增加 fast-27b WebUI bridge，便于在 fast-27b 服务与官方 WebUI 之间切换。
- 完善 DSH 配置、安装、运行状态、端口和绑定模型相关后端结构。
- 增加 fast-27b 启停脚本、WebUI 打包脚本及 Swift-27B 调优说明。

## 三、主要改动文件

### 前端

- `app/src/pages/Fast27bPage.tsx`
- `app/src/pages/ChatPage.tsx`
- `app/src/pages/SettingsPage.tsx`
- `app/src/features/apiStatus/ApiStatusPage.tsx`
- `app/src/features/chat/ChatSidebar.tsx`
- `app/src/features/chat/mcpTools.ts`
- `app/src/features/model/ModelWorkspace.tsx`
- `app/src/features/workspace/WorkspaceShell.tsx`
- `app/src/pages/AgentPage.tsx`
- `app/src/pages/agent/AgentWebUiPanel.tsx`
- `app/src/pages/agent/DshAgentPanel.tsx`
- `app/src/lib/desktop.ts`
- `app/src/context/AppContext.tsx`
- `app/src/types/index.ts`

### Rust 后端

- `app/src-tauri/src/models/app_state.rs`
- `app/src-tauri/src/commands/fast27b.rs`
- `app/src-tauri/src/services/fast27b_manager.rs`
- `app/src-tauri/src/services/webui_assets.rs`
- `app/src-tauri/src/services/webui_bridge.rs`
- `app/src-tauri/src/services/dsh_config.rs`
- `app/src-tauri/src/services/dsh_installer.rs`
- `app/src-tauri/src/commands/dsh.rs`
- `app/src-tauri/src/commands/system.rs`
- `app/src-tauri/src/lib.rs`

### 脚本与文档

- `scripts/start-swift27b-64k.bat`
- `scripts/stop-swift27b.bat`
- `scripts/pack-llama-webui.mjs`
- `docs/guides/SWIFT27B_TUNING.md`
- `CHANGELOG.md`
- `README.md`
- `docs/README.md`
- `docs/guides/DEVELOPMENT_GUIDE.md`
- `docs/guides/TECHNICAL_REPORT.md`

## 四、验证结果

| 验证项 | 命令/结果 | 状态 |
| --- | --- | --- |
| 前端构建 | `cd app && npm run build` | 通过 |
| fast-27b Rust 单元测试 | `cd app/src-tauri && cargo test --lib fast27b -- --test-threads=1` | 通过：21 passed，2 ignored |
| 桌面版构建 | `cd app && npm run desktop:build` | 通过 |
| 产物位置 | `app/src-tauri/target/release/agent-llm.exe` | 已生成，约 21.6 MB |
| Diff 空白检查 | `git diff --check` | 通过；仅有 CRLF/LF 换行提示 |
| MCP 真实端到端调用 | 当前没有处于 ready 状态的 MCP Server | 尚未完成 |

## 五、已知风险与推送前检查

1. **MCP 仍需真实端到端验证。** 应启动或连接一个可用 MCP Server，确认 fast-27b 能够完成“发送工具清单 → 返回 `tool_calls` → 执行工具 → 回填结果 → 生成最终答案”的完整流程。
2. **fast-27b 依赖本机目录。** 目标机器需要准备 `D:\Projects\fast-llm` 下的引擎和 Swift/Heretic 模型文件；缺失时应在界面中确认错误提示和路径修正流程。
3. **对外 API 应检查监听安全。** 开放局域网监听时需要确认 API Key 生效，避免在无鉴权情况下暴露接口。
4. **当前工作区存在未提交改动。** `git status` 显示约 53 项修改、删除、重命名或未跟踪内容，其中包含 `app/.playwright-cli/`、`app/src-tauri/resources/` 和 `scripts/` 等目录，推送前应逐项确认是否属于本次版本，避免把临时文件或不完整资源一并提交。
5. **不要清理发布产物。** 推送或整理工作区时必须保留：

   ```text
   D:\Projects\Agent_LLM\app\src-tauri\target\release\agent-llm.exe
   ```

## 六、建议提交信息

```text
feat: 重构 fast-27b 工作台并接入 API 状态与 MCP
```

可选正文：

```text
- 增加 Swift / Heretic 27B 模型切换与 BAT 参数对齐
- 合并 API 状态、对外 API 配置和 Token 统计
- 精简 Chat 侧栏与 fast-27b 页面布局
- 修复首轮 MCP tool_calls 未执行问题
- 保留 DSH / WebUI 接入并补充 bridge 与启动脚本
```

## 七、推送结论

本次功能改造已经完成，前端、Rust 单元测试和桌面版构建均已通过，最新桌面产物已生成。当前建议先完成一次真实 MCP Server 端到端验证，并审查未跟踪文件后，再执行提交和远端推送。

> 本报告仅记录当前工作区状态，**本次操作未执行 `git commit` 或 `git push`**。

