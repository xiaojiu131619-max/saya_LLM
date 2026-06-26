# 变更日志

本文件记录 Agent LLM 项目所有可观察的改动。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

每次发版前在对应版本段下增补条目；进行中的改动写到 `[Unreleased]` 段。

---

## [Unreleased]

本轮以性能、安全、UI 一致性、深色模式为主线，未改动任何模型加载/推理默认参数（`ctx`/`ngl`/KV/batch/parallel/max token/reasoning 等）。

### 新增

**深色模式**

- `app/src/pages/ModelLoadPage.tsx` —— 整页（约 1100 行）补全 `dark:` 变体，覆盖根容器、顶部 sticky 加载栏、模型信息卡、tab 切换、参数行（输入框/开关/复选/滑块/下拉）、显存预测、加载/重置/停止按钮、加载进度、缺表头提示、信息页（模型介绍、GGUF 摘要、基准测试、标签、元数据、空状态）、`InfoCard`、`MetadataCard`、`PredictionPill`、`ParamLabel`

**功能**

- `app/src/features/model/ModelWorkspace.tsx::ServiceStatusPanel` —— 服务状态卡新增**显存 / 内存实时占用**两项指标（`vram` / `mem`），调用 `useSystemStats()` 每秒刷新；显存来自后端 `get_system_status` + `get_hardware_info`，内存按 `ramUsage% × ramTotal` 换算成 GB
- `app/src/pages/SettingsPage.tsx` —— llama.cpp 内核区新增「下载源」选择项（镜像加速 / 直连 GitHub 官方），偏好用 localStorage（`agent-llm-kernel-download-source`）持久化；替代原先硬编码的 `useMirror=true`
- `app/src/index.css` —— 新增一组轻量 CSS 动画工具类：`anim-fade-in`、`anim-fade-rise`、`anim-card-rise`、`anim-pop-in`、`anim-panel-in`、`hover-rise`、`hover-rise-lg`，全部尊重 `prefers-reduced-motion`

**前端依赖切割**

- `app/vite.config.ts` —— `manualChunks` 改为函数式，按 node_modules 路径精确分组：`react`（含 jsx-runtime/scheduler）、`motion`、`charts`、`markdown`、`icons`、`tauri`；解决 `react/jsx-runtime` 被并入 motion chunk 导致首屏强拉 framer-motion 的问题

### 变更

**首屏加载（性能）**

- `app/src/features/workspace/WorkspaceShell.tsx` —— 三大工作区改用 `React.lazy` + `Suspense` 路由级懒加载；首屏只下载默认的 `ModelWorkspace` 链路；新增 `WorkspaceFallback` 中文加载占位
- `app/src/context/AppContext.tsx::hydrateDesktopState` —— 启动 hydration 去串行：`getDesktopConfig` / `getDesktopServerStatus` / `getExternalApiKeyStatus` / `getExternalApiKeyForSession` / `checkDesktopEngine` / `scanDesktopModels(false)` 并入单一 `Promise.all`；缓存命中的模型列表先渲染，全量扫描在其后补全
- `app/src-tauri/src/lib.rs` + `commands/config.rs` —— 历史明文 API Key 的 keyring 迁移从启动同步路径剥离：明文在配置加载时立即从内存配置移除，keyring 写入与磁盘改写在 `setup()` 中 `async_runtime::spawn` 异步执行；引入 `migrate_plaintext_api_key`

**首屏体积（性能）**

- 首屏链路完全移除 framer-motion，改用纯 CSS 动画：`ColumnToggle`、`SortDropdown`、`ModelCard`、`ThemeToggleButton`、`HomePage`、`ModelDownloadPanel`、`ModelWorkspace`、`ModelLoadPage`（共 8 个文件）
- 主 chunk 体积变化（实测 gzip）：427 KB → **213 KB**（路由级分割后）→ **32.8 KB**（剥离 framer-motion + jsx-runtime 归位后）；motion chunk（41.5 KB gzip）不再进首屏
- highlight.js 仅在懒加载的 `ChatPage` 触发时下载

**流式输出（性能）**

- `app/src/context/AppContext.tsx` —— 落盘改为防抖：流式生成时每个 token 不再触发全量 `sanitizeStoredSessions` + `JSON.stringify` + 同步 `localStorage.setItem`；新增 `persistRef` / `persistTimerRef`，停止变化 600ms 后落盘，`beforeunload` / `visibilitychange(hidden)` / 卸载时立即 flush
- `app/src/context/AppContext.tsx::loadStoredState` —— 解析结果非对象/数组时直接返回空，避免被篡改后崩溃
- `app/src/context/AppContext.tsx::sanitizeStoredSessions` —— 加入 `Array.isArray` 校验，过滤非法 session/message，避免模块初始化阶段 `.map` 抛错导致整页白屏

**UI 一致性（四大界面 + 侧栏 + 使用详情）**

统一字号档位（标题 `text-xl/text-base`，区块 `text-sm font-semibold`，正文 `text-sm`，副信息 `text-xs`，徽标 `text-[11px]`，取消 `text-[10px]`/`text-[13px]`/`text-[15px]`/`text-[17px]`）、间距节奏（卡片 `p-4`/大面板 `p-5`、区块 `mb-4`/`mb-5`、`gap-2`/`gap-3`）、圆角层级（卡片 `rounded-xl`、控件/按钮 `rounded-lg`、徽标 `rounded-md`、圆形保留 `rounded-full`）、过渡（按钮 `transition-colors`、输入框 focus 边框、滑块、tab 指示器）。涉及文件：

- `app/src/pages/ChatPage.tsx`（含 `ChatSettingsPanel`、`InputToolButton`、`IconButton`、`ChatNumberSetting`）
- `app/src/pages/ModelLoadPage.tsx`（含 `ParamLabel`、`SliderParamRow`、`NumberParamRow`、`OptionalNumberParamRow`、`SelectParamRow`、`TextParamRow`、`CacheTypeParamRow`、`CheckboxParamRow`、`ToggleParamRow`、`IdleAutoUnloadParamRow`、`ReadOnlyParamRow`、`InfoCard`、`MetadataCard`、`PredictionPill`、`ModelLoadTopBar`）
- `app/src/pages/HomePage.tsx`、`app/src/components/ModelCard.tsx`
- `app/src/features/chat/ChatSidebar.tsx`（含 `SessionRow`、`MiniToolButton`）
- `app/src/pages/UsagePage.tsx`（页头、指标卡、热力图、模型占比卡、`DonutChart`、`UsageRankRow`、`MetricCard`）

**使用详情热力图重做**

- `app/src/pages/UsagePage.tsx` —— 仿 GitHub 贡献图风格：5 档离散色阶替代连续 `opacity` 渐变；新增月份标签、星期标签、图例；新增 `buildHeatmapWeeks` 切分周列结构；新增 `HEATMAP_LEVELS_LIGHT`/`HEATMAP_LEVELS_DARK` 主题适配；按 `state.theme` 切换；将原 O(n²) 的 `dailyTotals.find` 改为 `Map` 查表 O(1)
- 指标卡入场动画 staggered（`delay 0→240ms`）；卡片 hover 边框高亮；占比进度条 `transition-[width] 500ms` 平滑

**桌面侧栏可见层**

- `app/src/features/model/ModelWorkspace.tsx` —— 模型工作区侧栏的「服务状态」卡：网格从 2 列 2 项扩到 2 列 4 项，新增 `formatGbPair` 格式化函数

**`SettingsPage` 状态分离**

- `app/src/pages/SettingsPage.tsx` —— 拆分出 `currentKernelMessage`（仅由 `handleCheckEngine` 写入）与 `engineMessage`（检查更新 / 下载进度 / 错误共用）；「当前内核」行优先显示 `currentKernelMessage`，否则回落到 `engineInfo.llama_server_version`；「最新 release」行接管 `engineMessage`。修复因状态串用导致「当前内核」行被检查更新结果污染、看起来像内核版本读取错误的问题

### 修复

**安全**

- `app/src-tauri/src/services/gguf_parser.rs::parse_gguf_header` —— `buf.len() < 4` 预判，畸形/截断的 `.gguf` 文件不再让并行扫描线程 panic（原 `&buf[0..4]` 越界）
- `app/src-tauri/src/services/process_manager.rs` —— 新增 `build_redacted_command_line`，对 `--api-key` 后的实参替换为 `***`，覆盖 `eprintln!` stderr 输出与 `add_log` 日志缓冲两处；API Key 不再经 `get_server_logs` 回传前端

**前端**

- `app/src/components/MarkdownRenderer.tsx::ThoughtBlock` —— 折叠态不再显示流式滚动的「最后两行」预览（每个 token 都会让预览跳动），改为「思考内容 + N 行徽标」的完全静态指示，展开后才显示完整内容；按钮区补 `transition-colors`

**构建**

- `app/.gitignore` —— 补 `dist-portable`（之前 `dist` 已忽略但便携包打包目录漏掉）

### 移除

- `framer-motion` 不再被首屏 chunk 加载（仍作为懒加载页面 `ChatPage` 的依赖保留，整体未从 `package.json` 删除）

### 验证

- `npm run build` —— 通过
- `npm run lint` —— 仅剩 1 条 pre-existing 错误：`app/src/components/ModelDownloadPanel.tsx:92:7`（`setState in effect`，与本轮无关，留作后续）
- `cargo check`（间接，被 `npm run desktop:build` 触发）—— 通过
- `npm run desktop:build` —— 通过，产物 `app/src-tauri/target/release/agent-llm.exe`

### 后续待办（性能 / 安全审计中尚未处理）

- **M2** 聊天列表无虚拟化（`pages/ChatPage.tsx:744-755`）：长对话渲染开销大，建议引入 `@tanstack/react-virtual`
- **M3** `MarkdownRenderer` 每次渲染重解析 + `CodeBlock` 每次重新 highlight：建议 `useMemo(parseContent, [content])` + `React.memo(CodeBlock)`
- **M4** 文件拖拽监听竞态（`pages/ChatPage.tsx:244-269`、`features/model/ModelWorkspace.tsx:149-170`）：`unlisten` 在 promise resolve 前 cleanup 已运行时无法解绑；改用 `cancelled` 标记
- **L3** `ChatBubble.tsx:111` 重新生成消息 id 派生模式可能重复（`${message.id}-regenerated`）；改用 `crypto.randomUUID()`
- **L4** `lib/desktop.ts:776` 错误信息直接回显原始服务端响应，建议截断
- **L5** `context/AppContext.tsx:626-637` 明文 API Key 迁移依赖下次落盘隐式清除，没有显式 `removeItem`
- **后端安全** M-2（API Key 命令行可见）、M-3（`read_file_content` 无白名单）、M-4（`rollback_to` 路径穿越）、M-6（`executable_path` 任意 exe）、M-7（进程管理 `unwrap()` 中毒 + 无 Job Object）、L-1（PowerShell 解压）、L-2（`partial_cmp().unwrap()`）等
- **H-1**（内核更新签名校验）按用户决定：**不做**，但「下载源」改为用户可选项已落地
- `ModelDownloadPanel.tsx:92:7` 的 pre-existing lint 错误

---

## [0.1.0] - 2026-06-15

仓库初始提交基线，包含 Tauri 桌面应用骨架与 React/TypeScript 前端。

### 新增

**仓库根标准文件**

- `.gitignore` —— 根级忽略规则（OS 元数据、IDE、备份、日志、`docs/_build`、本地 secrets）
- `.editorconfig` —— UTF-8 + LF + 2 空格（Rust/TOML 用 4）；`.bat/.cmd/.ps1` 强制 CRLF
- `.gitattributes` —— 文本/二进制标记、`*.rs diff=rust`、`linguist-generated` 标记 `gen/` / `target/` / `dist/` / `output/`
- `LICENSE` —— MIT 许可（与 `app/src-tauri/Cargo.toml::license` 一致）
- `CONTRIBUTING.md` —— 贡献指南：目录结构、提交规范、提交前清单、PR 流程、依赖新增规范、发版流程
- `docs/` —— 集中存放项目文档（`README.md`、`tech-spec.md`、`TECHNICAL_REPORT.md`、`DEVELOPMENT_GUIDE.md`）

**项目主体**

- `app/` —— Tauri + React 19 + Vite 7 桌面应用，Rust 后端 + TypeScript 前端
- `app/src-tauri/` —— `commands/`（前端可调用的 Tauri 命令）、`services/`（GGUF 解析、进程管理、自动更新、硬件监测）、`models/`（配置/状态结构）
- `app/src/` —— React 前端，工作区组件按 `features/{model,chat,settings,workspace}/` 分组，页面按 `pages/` 平铺

---

## 模板（后续条目参考）

新增条目时复制以下骨架并填入：

```markdown
## [X.Y.Z] - YYYY-MM-DD

### 新增
- 新功能描述

### 变更
- 已有行为改动描述

### 修复
- Bug 修复描述

### 移除
- 删除内容描述（**必须**列出文件名 / 配置项）

### 安全
- 安全相关修复
```

约定：

1. 每次发版在文件顶部新增一个 `## [X.Y.Z] - YYYY-MM-DD` 段，按时间倒序排列
2. 不在已发版的段落中修改历史条目；如需更正发版内容，写到新的 `[Unreleased]` 段并标注「修正：…」
3. `Added` / `Changed` / `Deprecated` / `Removed` / `Fixed` / `Security` 六类按需选用
4. 涉及 Rust 后端（`app/src-tauri/src/`）的变更也写在本文件，不另起 `CHANGELOG-rust.md`
5. 涉及运行时资源（`app/resources/`）变更时记录精确的文件清单与哈希，便于 `tauri.conf.json::bundle.resources` 校对

---

## 历史参考（无版本号提交）

- 早期前端原型设计文档：见 `docs/tech-spec.md`
- 当前架构与数据流：见 `docs/TECHNICAL_REPORT.md`
- 开发与构建流程：见 `docs/DEVELOPMENT_GUIDE.md`
