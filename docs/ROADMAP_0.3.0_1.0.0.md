# 产品版本迭代策划：0.3.0 → 1.0.0 路线图

> 制定日期：2026-07-18  
> 基于版本：0.2.0（2026-07-07）  
> 目标：用两个次版本迭代，将 Agent LLM 从一个功能完备的模型启动器打磨成稳定、可扩展、对用户友好的 1.0 成熟产品。

---

## 一、版本哲学

| 版本 | 主题 | 核心目标 |
|------|------|----------|
| **0.3.0** | 稳定加固 | 清理已知技术债务、补齐用户体验短板、加固安全、为 ComfyUI 生图工作区打基础 |
| **1.0.0** | 功能成熟 | 推出生图工作区、Agent 深度强化、多平台起步、达到可对外正式发布的质量标准 |

> 两个版本均**不改动**默认加载/推理参数（`ctx`/`ngl`/KV/batch/parallel/max token/reasoning 等），遵循 `AGENTS.md` 约定。

---

## 二、0.3.0 —— "稳定加固"版

> 预计时间线：0.2.0 发布后 4-6 周  
> 版本号理由：新增 ComfyUI 生图预备基础设施、Agent 增强，属向后兼容的次版本。

### 2.1 技术债务清理（优先级：P0）

来自 0.2.0 CHANGELOG 遗留事项：

| 编号 | 遗留项 | 文件/位置 | 目标方案 |
|------|--------|-----------|----------|
| M2 | 聊天列表无虚拟化 | `ChatPage.tsx:744-755` | 引入 `@tanstack/react-virtual`，长会话（>200 条）增量渲染 |
| M3 | MarkdownRenderer 每次重解析 + CodeBlock 重高亮 | `MarkdownRenderer.tsx` | `useMemo(parseContent, [content])` + `React.memo(CodeBlock)` |
| M4 | 文件拖拽监听竞态 | `ChatPage.tsx:244-269`、`ModelWorkspace.tsx:149-170` | 改用 `cancelled` 标记，确保 cleanup 幂等 |
| L3 | 重新生成消息 id 可能重复 | `ChatBubble.tsx:111` | 改用 `crypto.randomUUID()` |
| L4 | 错误信息直接回显服务端响应 | `lib/desktop.ts:776` | 增加错误信息截断/脱敏 |
| L5 | API Key 迁移无显式 `removeItem` | `AppContext.tsx:626-637` | 迁移完成后显式清除旧明文 key |
| — | 后端安全审计的 M-3/M-4/M-6/M-7/L-1/L-2 | 多个后端文件 | 见下方「安全加固」 |

### 2.2 安全加固（P0-P1）

| 风险项 | 风险等级 | 处置方案 |
|--------|----------|----------|
| `read_file_content` 无路径白名单（M-3） | 中 | 限定允许读取的目录（模型目录、配置目录），拒绝路径穿越 |
| `rollback_to_version` 路径穿越（M-4） | 中 | 路径规范化 + 限制在备份目录内 |
| `executable_path` 任意 exe 执行（M-6） | 中 | 进程路径校验 + 可执行白名单 |
| 进程管理 `unwrap()` 中毒 + 无 Job Object（M-7） | 中 | 改用 `expect` / `?` 安全传播，附加 Job Object 避免僵尸进程 |
| PowerShell 解压命令注入（L-1） | 低 | 改用 Rust 原生解压（`zip` crate 或 `tar` crate） |
| `partial_cmp().unwrap()`（L-2） | 低 | 加 `if let Some(...)` 安全分支 |

### 2.3 ComfyUI 生图预备工作（P1）

**不为 0.3.0 交付完整生图界面**，仅做基础设施准备，为 1.0.0 铺路：

1. **后端：ComfyUI 进程管理服务**
   - 新建 `services/comfy_manager.rs`，参考 `process_manager.rs` 架构
   - 能力：启动/停止/健康检测 ComfyUI 进程（类似 llama-server 管理）
   - 前端命令：`start_comfy` / `stop_comfy` / `get_comfy_status`

2. **数据模型：生图配置与历史记录**
   - 新建 `models/comfy_types.rs`：工作流节点路由、生图任务记录、输出图片元数据
   - 前端类型同步到 `src/types/index.ts`

3. **前端路由骨架**
   - 在 `ViewType` 中新增 `'image'`
   - `WorkspaceShell.tsx` 添加 `image` → 跳转到 `ImageWorkspace` 懒加载
   - 新建 `features/image/` 下的类型定义与状态初始化（`ImageContext` 或并入 `AppContext`）

### 2.4 Agent 增强（P1）

| 改进项 | 现状 | 目标 |
|--------|------|------|
| Agent 会话持久化 | agent 对话在内存中，重开丢失 | agent 会话存入 `localStorage`，与普通聊天会话平级管理 |
| Agent 日志 UI | 通过 `get_agent_server_logs` | 在 ToolsPage 中新增日志面板可视化 |
| 工具执行反馈 | 仅有文字结果 | 支持工具调用结构化的 JSON 展示（类似 ChatGPT 的 function call 渲染） |
| MCP 服务器稳定性 | 连接断开时无重试 | 加入自动重连机制（指数退避） |

### 2.5 用户体验改进（P1-P2）

| 改进项 | 说明 |
|--------|------|
| 模型加载页 GPU 显存预测校准 | 当前预测偏保守，收集用户反馈后调整算法 |
| 聊天窗口自动滚动优化 | 当前在长消息流式输出时可能抖动，引入 IntersectionObserver |
| 设置页搜索功能 | 设置项逐渐变多，提供搜索框快速定位 |
| 模型下载断点续传 | 当前 `download_model_file` 不支持断点续传，大模型下载体验差 |
| 窗口记忆 | 记住窗口位置和大小（`tauri.conf.json` 的 `window` 配置持久化） |

### 2.6 测试体系建设（P2）

| 改进项 | 现状 | 目标 |
|--------|------|------|
| Rust 单元测试 | 仅 `mcp_bridge.rs` 有 fixture 测试 | 至少覆盖：gguf_parser、process_manager（关键路径）、commands 主要流程 |
| 前端组件测试 | 无 | 用 Vitest + React Testing Library 覆盖核心组件 |
| E2E 测试 | 无 | 用 Tauri 的 WebDriver 或 Playwright 覆盖核心用户流程 |
| CI 配置 | 无 | 加 GitHub Actions：`cargo check` + `npm run build` + `npm run lint` |

### 2.7 构建与发布（P2）

| 改进项 | 说明 |
|--------|------|
| MSI 安装包 | 当前仅 `bundle.targets = ["app"]`，增加 MSI 安装程序 |
| 便携包兼容性 | 验证 0.3.0 便携包在干净 Windows 环境可运行 |
| 发布清单 | 每次发版附 CHANGELOG.md + 完整构建产物验证 |

### 2.8 0.3.0 里程碑

| 里程碑 | 交付物 | 验证标准 |
|--------|--------|----------|
| M1：技术债务冻结 | M2/M3/M4/L3/L4/L5 全部关闭 | CI 通过 + 手动功能验证 |
| M2：安全基线 | 所有 >1 级安全项修复 | `cargo audit` 通过 |
| M3：Comfy 预备就绪 | comfy_manager、comfy_types、前端路由 | 能手动启停 ComfyUI 并确认健康 |
| M4：Agent 可用性提升 | 会话持久化 + 日志面板 + MCP 重连 | 完整 agent 流程可运行 |
| M5：测试基础 | Rust 关键路径测试 + CI 配置 | GH Actions 绿 |
| **发布：0.3.0** | 全部里程碑绿，CHANGELOG 更新 | 构建 + 手动冒烟测试通过 |

---

## 三、1.0.0 —— "功能成熟"版

> 预计时间线：0.3.0 发布后 6-8 周  
> 版本号理由：ComfyUI 生图工作区独立模块达到可用状态，加上跨平台起步、架构稳定，达到 1.0 质量标准。

### 3.1 ComfyUI 生图工作区（P0 — 核心新功能）

基于 `docs/COMFY_IMAGE_WORKSPACE_PLAN.md` 推进第一阶段交付。

**最小可用范围（Phase 1-3）：**

1. **工作流管理**
   - 上传/选择/删除工作流 JSON
   - 自动识别基础节点（CheckpointLoader、KSampler、CLIPTextEncode、VAEDecode、EmptyLatentImage）
   - 手动绑定兜底界面
   - 每个工作流的绑定配置本地持久化

2. **参数控制界面**
   - 正/负提示词文本框
   - 模型/Checkpoint 选择下拉
   - LoRA 列表（增删、强度滑块）
   - seed/steps/cfg/sampler/scheduler 参数控件
   - 分辨率/宽高比快速选择
   - batch size 控制

3. **图库与追溯**
   - 生图输出画廊（网格/列表切换）
   - 每张图片展示生成参数（seed、prompt、model、LoRA 等）
   - 一键复用到参数面板
   - 生图参数 + 工作流快照关联存档

4. **任务队列**
   - 后台生图队列（排队 + 进度）
   - 完成通知（系统托盘或应用内提示）
   - 取消排队/中断进行中任务

**不纳入 1.0.0 的范围（Post-1.0）：**
- 完整节点图编辑器
- LoRA 训练/微调
- ControlNet 高级控制
- 视频生图工作流

### 3.2 Agent 深度进化（P1）

| 改进项 | 说明 |
|--------|------|
| Agent 多工具编排 | 工具执行支持依赖图（A 的输出是 B 的输入） |
| 文件系统工具 | 读/写文件工具（在沙箱目录内），让 Agent 能操作本地代码 |
| 代码执行沙箱 | Optional: 集成 Python 或 JavaScript 沙箱执行环境 |
| Agent 模板市场 | 预设 Agent 配置（编码助手、翻译助理、写作助手）可一键启用 |
| 对话中创建/编辑 Agent | 在聊天界面内直接修改工具集和提示词 |

### 3.3 跨平台起步（P1）

| 平台 | 工作项 |
|------|--------|
| **macOS** | 1. 验证 WebKit WebView 兼容性；2. `llama-server` 替换为 macOS 预编译二进制；3. macOS 特定逻辑（菜单栏、权限、路径等） |
| **Linux** | 1. 验证 WebKitGTK WebView；2. 替换 `llama-server` 预编译二进制（build-on-install 或分发静态链接版本）；3. 桌面文件、图标注册 |

**不要求 1.0.0 三平台完全一致**，但需达到：
- Windows：完整功能（同 0.3.0）
- macOS：核心功能（模型管理 + 聊天 + 设置）可用
- Linux：核心功能可用（可能缺少 GPU 加速）

### 3.4 API 生态扩展（P1-P2）

| 改进项 | 说明 |
|--------|------|
| OpenAI API 兼容 | 启动 `llama-server` 后支持 `/v1/models`、`/v1/chat/completions`、`/v1/embeddings`（受 llama-server 能力限制） |
| 多引擎切换 | 在原生引擎外，允许切换到 Ollama / vLLM / 云端 API 后端（初步） |
| 外部 API 集中管理 | 设置页增加 API key 管理中心（当前只有零散的 keyring） |

### 3.5 性能与架构（P2）

| 改进项 | 说明 |
|--------|------|
| `agent_loop.rs` 重构 | 当前 104 KB，拆分为 `agent_loop.rs`（协调） + `agent_tool.rs`（工具执行） + `agent_context.rs`（已有） |
| AppContext 状态拆分 | 当前 38 KB 单一 reducer，考虑拆分为 `ModelContext` + `ChatContext` + `ConfigContext`（或引入 Zustand） |
| Rust 编译优化 | 增量编译缓存、LTO 优化、减少 `serde` 派生宏开销 |
| 模型加载预热加速 | 后台预加载常用模型参数，减少首次加载时间 |

### 3.6 文档与用户引导（P2）

| 改进项 | 说明 |
|--------|------|
| 新手引导 | 首次启动弹窗引导：添加模型目录 → 下载/扫描模型 → 开始对话 |
| 内置帮助页 | 快捷键列表、FAQ、术语说明 |
| API 文档 | `llama-server` 可用接口文档集成到应用内 |
| 配置说明 | 设置页每个选项加 tooltip 解释 |

### 3.7 1.0.0 里程碑

| 里程碑 | 交付物 | 验证标准 |
|--------|--------|----------|
| M1：生图工作区 | Phase 1-3 完整可用 | 生图流程可走通（文生图基础工作流） |
| M2：Agent 增强 | 多工具编排 + 文件工具 + Agent 模板 | Agent 可执行复杂任务 |
| M3：跨平台 | Win/macOS/Linux 构建 | 三个平台核心功能冒烟通过 |
| M4：架构稳定 | agent_loop 拆分、上下文拆分、编译优化 | CI 全绿 |
| M5：用户引导 | 首次引导 + 帮助页 + 设置 tooltip | 新用户可独立完成首次使用 |
| **发布：1.0.0** | 全部里程碑绿，CHANGELOG 更新 | 全平台 + 全功能冒烟测试通过 |

---

## 四、发版策略

### 4.1 版本分支模型

```
main (发布分支)
├── v0.2.0     ← 当前
├── v0.3.0     ← 下一个目标
└── v1.0.0     ← 最终目标

dev (开发分支)
├── feat/comfy-prepare    ← 0.3.0 M3
├── feat/agent-enhance    ← 0.3.0 M4
├── fix/tech-debt         ← 0.3.0 M1-M2
└── feat/image-workspace  ← 1.0.0 M1
```

### 4.2 发布节奏

| 发布 | 预发布 | RC 窗口 | 正式发布 |
|------|--------|---------|----------|
| 0.3.0-rc.1 | 功能冻结后 | 1 周 | 无阻塞问题即可发 |
| 1.0.0-rc.1 | 功能冻结后 | 2 周 | 至少 3 个平台验证通过 |

### 4.3 版本号约定

遵循 SemVer 2.0：
- `0.3.0` — 次版本，新增功能（Comfy 预备、Agent 增强），向后兼容
- `1.0.0` — 主版本，第一次成熟发布，新用户第一次接触的版本号

### 4.4 发布检查清单

每条目在发版前逐项验证：

```markdown
- [ ] `[Unreleased]` 段已写入正式版本号与日期
- [ ] 三处版本号一致（`package.json` / `Cargo.toml` / `tauri.conf.json`）
- [ ] `npm run build` 通过
- [ ] `npm run lint` 通过（允许 pre-existing 未关闭项）
- [ ] `cargo check` 通过
- [ ] 所有 >= P1 的已知问题已修复或记录为已知问题
- [ ] 便携包打包测试通过（`npm run portable:zip`）
- [ ] 桌面构建成功（`npm run desktop:build`）
- [ ] 至少在一个干净 Windows 环境冒烟测试通过
- [ ] CHANGELOG.md 格式化正确
```

---

## 五、风险与应对

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|----------|
| ComfyUI 工作流兼容性复杂 | 1.0.0 生图延期 | 中 | Phase 1 只支持基础工作流，复杂场景 Post-1.0 |
| macOS/Linux llama-server 二进制获取 | 跨平台延期 | 中 | 由上游 llama.cpp 提供预编译产物，必要时建自定义构建流水线 |
| 开发者时间有限（单人项目） | 版本延期 | 高 | 每个版本设 MVP 边界，先交付核心功能，锦上添花项延后 |
| llama-server 版本兼容性 | 升级后行为变化 | 中 | 跟随上游 release 节奏测试，设回滚机制（已有） |
| 安全审计发现高危问题 | 需紧急修复 | 低 | 0.3.0 已纳入已知安全项修复；新发现按优先级插入 |

---

## 六、总结

| | 0.3.0（稳定加固） | 1.0.0（功能成熟） |
|--|-------------------|-------------------|
| **关键词** | 还债、加固、预备 | 生图、跨平台、完善 |
| **核心交付** | M2-M4 + 安全 + 测试 | ComfyUI 生图 + Agent 进化 + Win/macOS/Linux |
| **代码修改** | 中（10-15 个文件） | 大（25-40 个文件） |
| **用户感知** | 更流畅、更安全、新功能少 | 全新功能模块、新平台 |
| **发布形式** | 便携包 + MSI 安装包 | 便携包 + MSI 安装包 |

---

> 本文档是活文档。随着开发推进，里程碑和优先级可根据实际情况调整，但版本主题和核心交付物应在发版前保持稳定。
