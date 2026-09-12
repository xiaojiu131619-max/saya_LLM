# 产品版本迭代路线图：v0.3.1 → 1.0.0

> 更新日期：2026-09-02
> 当前基线：v0.3.1（已发布）
> 目标：在已完成稳定加固和内核管理的基础上，将 Agent LLM 推进为稳定、可扩展、对用户友好的 1.0 产品。

`v0.3.0` 与 `v0.3.1` 已发布，具体实现以 `CHANGELOG.md` 和当前代码为准。本文件只描述已交付状态、未完成事项和 1.0.0 未来目标。

---

## 一、版本哲学

| 版本 | 状态 | 核心目标 |
|------|------|----------|
| **0.3.0** | 已发布 | 核心更新、模型管理磁贴化、API 中心精简、数据口径统一 |
| **0.3.1** | 已发布 | AMD / Intel Vulkan、GPU 监测、环境检测、显存预测修正 |
| **1.0.0** | 规划中 | ComfyUI 生图工作区、Agent 能力增强、跨平台起步和发布质量完善 |

> 所有版本均**不改动**默认加载/推理参数（`ctx`/`ngl`/KV/batch/parallel/max token/reasoning 等），遵循 `AGENTS.md` 约定。

---

## 二、v0.3.x 已交付与后续事项

### 2.1 已交付：技术债与安全基线

以下事项已在 v0.3.0/v0.3.1 代码中落地，不再作为待办：

| 编号 | 已交付内容 | 当前实现 |
|--------|--------|----------|
| M2 | 聊天列表虚拟化 | `@tanstack/react-virtual` |
| M3 | Markdown 与代码块缓存 | `MarkdownRenderer` 使用 `useMemo` / `memo` |
| M4 | 拖拽监听清理 | 异步监听使用 `cancelled` 标记，清理幂等 |
| L3 | 重新生成消息 ID | 使用 `crypto.randomUUID()` |
| L4 | 服务端错误信息控制 | `desktop.ts` 截断和归一化错误文本 |
| L5 | API Key 迁移清理 | 迁移后显式移除旧明文 key |
| — | 进程与文件安全 | API key 脱敏、路径/可执行文件校验、Job Object、原生 ZIP 解压等 |

### 2.2 已交付：用户与运行时能力

- 版本化 llama.cpp 内核目录、CUDA/Vulkan/CPU 匹配、SHA256 和 `--version` 校验、可取消下载、代理配置和最近两版本保留。
- 模型运行记录、按模型显存实测校准、混合架构 KV/SWA 解析、真实启动自动调参。
- AMD / Intel Vulkan 设备选择，Windows DXGI + PDH 显存监测，首次启动环境检测。
- 聊天虚拟列表、多模态附件、llama.cpp 原生工具、OpenAI / Anthropic 兼容 API。

### 2.3 延期或未开始：ComfyUI 预备设施

v0.3.x 没有交付 ComfyUI 进程管理、工作流模型或生图路由。以下内容延期到 1.0.0 规划，当前不存在对应模块：

- `app/src-tauri/src/services/comfy_manager.rs`、`app/src-tauri/src/models/comfy_types.rs`、`app/src-tauri/src/commands/comfy.rs`
- `start_comfy` / `stop_comfy` / `get_comfy_status`
- `app/src/features/image/`、`image` ViewType 和 `ImageWorkspace`

详细方案见 `docs/COMFY_IMAGE_WORKSPACE_PLAN.md`。

### 2.4 Agent / MCP

`ToolsPage` 同时承载两类工具：llama.cpp 原生 server tools（由服务端 `--tools` 提供），以及**用户自配的 MCP 服务器**。MCP 侧已交付：

- 服务器增删改查与配置持久化（`config.json` 的 `mcp_servers`）
- **三种传输**：stdio（本机子进程）、Streamable HTTP（2025-03-26）、HTTP+SSE（2024-11-05 旧版）
- 连接 / 断开 / 工具发现 / 工具调用；stdio 子进程按 Windows Job Object 整树回收
- 网络端点的 host 安全校验（仅 http/https，拒绝本机、内网与保留地址）
- 对话内的多轮工具循环（模型请求工具 → 应用执行 → 结果回填 → 续写作答），气泡内可视化工具调用

仍未实现：

- Agent 会话持久化和专用日志面板
- 工具调用依赖图、文件工具和代码执行沙箱
- MCP 断线自动重连（当前由状态轮询识别退出，需手动重连）
- MCP 的 resources / prompts 能力（当前只用了 tools）
- DNS rebinding 防护（校验后仍有一次解析窗口）

### 2.5 仍待处理的体验、测试与发布事项

| 改进项 | 当前状态 |
|--------|----------|
| 设置页搜索 | 未实现，保留为 1.0 前体验任务 |
| 窗口位置和大小记忆 | 未实现 |
| 前端组件测试 | 未引入 Vitest / React Testing Library |
| E2E 测试 | 未建立 Tauri WebDriver / Playwright 流程 |
| MSI 安装包 | `tauri.conf.json` 当前只启用 `targets: ["app"]` |
| 旧模型下载断点续传 | 不适用；模型下载 UI 已移除，使用外部 ModelScope 等来源 |
| 内核签名校验 | 未实现；当前使用 SHA256 和安装前后版本验证 |

### 2.6 当前测试基线

- Rust 内联单测分布在 `gguf_parser`、`model_scanner`、`process_manager`、`gpu_monitor`、`auto_updater` 和服务命令模块。
- 需要真实模型文件的解析测试使用 `#[ignore]`，通过 `AGENT_LLM_TEST_MODEL_DIR` 指定目录。
- 前端当前以 `npm run build` 和 `npm run lint` 为主，尚未引入独立组件测试框架。
- CI 已覆盖基础的前端构建、Lint 和 Rust 检查；完整窗口级 E2E 仍待补充。

### 2.7 v0.3.x 状态结论

| 里程碑 | 状态 |
|--------|------|
| 技术债和安全基线 | 已交付，个别新审计项按当前命令重新盘点 |
| 核心更新与多后端 GPU | 已交付 |
| 显存预测、运行记录和自动调参 | 已交付 |
| ComfyUI 预备设施 | 延期，未开始 |
| Agent/MCP 增强 | 延期，未开始 |
| 测试、MSI 和窗口记忆 | 未完成 |
| **v0.3.0 / v0.3.1 发布** | 已完成 |

---

## 三、1.0.0 —— “功能成熟”版

> 时间安排待功能范围确认；版本号理由：ComfyUI 生图工作区达到可用状态，加上架构稳定和跨平台起步，达到 1.0 质量标准。


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
| `agent_loop.rs` 拆分 | 当前仓库没有 `agent_loop.rs`；未来若 Agent 编排规模扩大，再按协调、工具执行和上下文职责拆分 |
| AppContext 状态拆分 | 当前仍由单一 reducer 管理，评估拆分为 `ModelContext` + `ChatContext` + `ConfigContext`（或引入 Zustand） |
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

当前主分支已包含并发布 `v0.3.0`、`v0.3.1`；后续功能按主题建立 feature 分支并合并回 `main`：

```
main (发布分支)
├── v0.3.0     ← 已发布
├── v0.3.1     ← 已发布，当前基线
└── v1.0.0     ← 规划中

后续工作分支（示例）
├── feat/comfy-image-workspace
├── feat/agent-enhance
├── feat/cross-platform
└── test/desktop-e2e
```

### 4.2 发布节奏

具体日期待 1.0.0 范围确认；正式发布前继续使用 RC 窗口完成 Windows 冒烟、构建产物和核心流程验证。

| 发布 | 状态 | 说明 |
|------|------|------|
| v0.3.0 | 已发布 | 稳定加固与核心更新基础 |
| v0.3.1 | 已发布 | Vulkan、GPU 监测和环境检测 |
| 1.0.0-rc.1 | 规划中 | 功能冻结后进入验证窗口 |

### 4.3 版本号约定

遵循 SemVer 2.0：
- `0.3.x`：向后兼容的功能和修复版本。
- `1.0.0`：ComfyUI、Agent、跨平台和发布质量达到既定验收标准后的主版本。

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
