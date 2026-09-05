# Agent LLM v0.4 计划书：DeepSeek Harness（dsh）本地智能体接入

> 制定日期：2026-09-02
> 基线版本：0.3.1（2026-09-02 发布，commit `5d29b5f`）
> 目标版本：**0.4.0**
> 上游项目：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（MIT，开发者预览）
> 关联文档：[ROADMAP_0.3.0_1.0.0.md](ROADMAP_0.3.0_1.0.0.md)（0.4.0 是其「1.0.0 Agent 深度强化」目标的落地前置）
> 状态：**已实现并发布（2026-09-04，v0.4.0）**。Phase 0-5 全部完成；实施结论与实测证据见 [DSH_SPIKE_RECORD.md](DSH_SPIKE_RECORD.md)（第 9 章定稿、pnpm 提速、干净环境说明均已回填）

---

## 0. 摘要

**目标**：在 Agent LLM 中接入 DeepSeek Harness（以下简称 **dsh**），让软件从「本地模型启动器」延伸为「本地智能体工作台」——**dsh 以 Agent LLM 托管的旁路进程（sidecar）方式运行**（见 1.3）——用户在 **设置中心 → Agent（智能体）** 页完成 dsh 的**环境检测、安装辅助、开启/关闭、日志查看**，并把 Agent LLM 正在运行的**本地模型一键接入 dsh**，使 dsh 的 Web UI（默认 `http://127.0.0.1:3080`）直接用本地模型执行智能体任务（读写工作区、跑命令、委派子代理、维护计划等）。

需求 → 方案映射：

| # | 需求（用户原话） | v0.4 交付物 |
|---|------------------|-------------|
| F1 | 在设置中增加 agent 界面 | 设置中心新增「Agent（智能体）」标签页与独立页面 |
| F2 | 增加环境检测 | dsh 运行环境检测：Node.js 运行时、dsh 包、DSH_HOME、端口 3080、本地模型 API 可达性等 |
| F3 | 安装辅助 | 应用内托管安装 Node.js 便携运行时 + `@deepseek-ai/dsh` 包；缺项修复引导 |
| F4 | 开启和关闭 | dsh 进程的启动/停止/状态/健康检查（与 llama-server 同套进程管理规范） |
| F5 | 把本地模型接入到 dsh 中 | 把 Agent LLM 的 llama-server OpenAI 兼容端点写成 dsh 自定义 Provider 并校验 |
| F6 | dsh 运行日志可以在软件中看到 | Agent 页内嵌 dsh 运行日志面板（实时/暂停/导出/清空） |
| F7 | 可以用软件的界面开启和关闭 dsh | 界面化启停 + 「打开 dsh 界面」入口（外部浏览器打开 3080） |

---

## 1. 背景

### 1.1 为什么是 dsh

Agent LLM 目前通过 llama-server 的**原生工具调用**提供浅层 agent 能力（文件读写、搜索、命令执行），但它仍是「单模型、单会话、无工作区/审批/子代理」的对话形态。

dsh 是 DeepSeek AI 开源的 agent harness（智能体框架），基于 Cordis「一切皆插件」架构，自带：

- **Web UI**（`dsh web`，默认 `127.0.0.1:3080`）：会话、工作区、模型设置、审批、计划、轨迹
- **智能体能力**：读写/编辑工作区文件、执行命令、委派子代理、维护计划、工具审批与权限预设
- **会话持久化**、日程、webhook、MCP client、Python SDK / ACP 等插件体系
- MIT 许可证（可随 Agent LLM 分发/托管，无传染性约束）

接入 dsh 后，Agent LLM 的本地模型获得完整的「智能体工作台」体验，而不必自研 harness——符合项目「本地优先、模型启动器 + 能力集成」的产品路线。

> ⚠️ dsh 仍处于**开发者预览**阶段：未做安全审计、版本快速迭代、可能存在破坏兼容性的变更（上游 README 原话）。本计划书第 8 章针对此风险给出了「固定版本、隔离托管、可回退」的对策。

### 1.2 dsh 关键事实（调研快照，2026-09-02）

| 项目 | 事实 |
|------|------|
| 运行方式 | `npx @deepseek-ai/dsh web`（`web` 是 `--profile web` 的别名） |
| Web UI 默认地址 | `http://127.0.0.1:3080`；`--no-open` 可只起服务不开浏览器；`--port` 等应用参数在启动器参数之后 |
| 运行时依赖 | Node.js（仓库开发基线 `engines.node: ^22.19.0 || >=24.0.0`；npm 包本身未声明 engines，需 spike 实测） |
| npm 最新版 | `@deepseek-ai/dsh@0.1.1-rc.2`（master 分支已到 `0.1.2-alpha.4`，迭代很快） |
| 数据主目录 | `$DSH_HOME`（默认 `~/.dsh`）：`profiles/<name>/`、`cordis.patch.yml`、`settings.yaml`、`.credentials.yaml` 等 |
| Profile 初始化 | `web`/`headless`/`sdk`/`sdk-minimal`/`acp` 首次使用从随附模板自动初始化 |
| 模型提供方 | 设置 → 模型；支持目录提供方与**自定义 OpenAI 兼容提供方**（Provider ID、baseURL、协议、凭据、模型列表） |
| 配置落盘 | `$DSH_HOME/settings.yaml`（例：`llm-pi-ai.providers.<id>` 含 `api`/`baseURL`/`apiKeyEnv`/`models`）；密钥在 `.credentials.yaml`，settings 只存引用 |
| 本地模型接入点 | Agent LLM 的 llama-server 已暴露 OpenAI 兼容 `/v1/chat/completions`，dsh 自定义提供方选 `api: openai-completions` + `baseURL: http://127.0.0.1:<port>/v1` 即可 |
| 许可证 | MIT；第三方依赖见上游 `THIRD_PARTY_NOTICES.md` |

### 1.3 dsh 的运行形态：旁路进程（sidecar），不是代码内嵌

**先回答问题：dsh 是「外挂」的旁路进程，不是编译进 Agent LLM 的库。** 它独立于 Agent LLM 存在，Agent LLM 只做**托管与遥控**。

运行链路：

```text
┌────────────────────────────── Agent LLM（主进程，Tauri）─────────────────────────────┐
│  设置中心 → Agent 页                                                                  │
│    ├─ 环境检测 / 安装辅助（托管 Node + dsh 包）                                          │
│    ├─ 开启/关闭（spawn / kill，Job Object 回收进程树）                                    │
│    ├─ 日志接管（stdout/stderr → 应用内日志面板）                                          │
│    └─ 本地模型接入（写 DSH_HOME/settings.yaml + 校验 /v1/models）                         │
└──────────────┬──────────────────────────────────────────────┬─────────────────────────┘
               │ 启动 / 停止 / 读日志（子进程 + 本地文件）                    │ HTTP 调用模型
               ▼                                                                          ▼
┌──────────────────────────────┐                        ┌──────────────────────────────┐
│ dsh（独立 Node 旁路进程）       │   OpenAI 兼容 /v1        │ llama-server（本地模型进程）   │
│  Cordis + Web UI              │ ────────────────────►  │  Agent LLM 已管理、已加载       │
│  http://127.0.0.1:3080        │                        └──────────────────────────────┘
└──────────────────────────────┘
               │ Web UI（网页）
               ▼
    A. 外部浏览器打开 3080（v0.4 默认）
    B.（可选增强）Agent LLM 内嵌 WebView 指向 3080
```

| 形态 | 说明 | 与 Agent LLM 的关系 | 结论 |
|------|------|---------------------|------|
| **A. 旁路进程 + 外部浏览器** | dsh 独立进程跑在本地，UI 在浏览器打开 3080 | 托管关系：启停/日志/配置由 Agent LLM 控制；无代码内嵌 | ✅ v0.4 默认，最稳、与官方形态一致 |
| **B. 旁路进程 + 应用内 WebView** | 进程仍是旁路，仅把 3080 网页套进 Agent LLM 窗口标签 | 同上，多一层「壳」；WebView 指向 localhost | 🟡 P2 可选增强，不阻塞 v0.4 |
| **C. 深度内嵌（fork 改造）** | 把 dsh 当引擎库改造成 Agent LLM 自带聊天页的后端 | 代码级集成，需长期维护 Cordis 运行时 | ❌ 不建议（成本高、违背官方形态） |

> 由此可推出三条产品约束，已贯穿本计划：
> 1. Agent LLM 与 dsh 之间是**进程外通信**（子进程管理 + 本地端口 + 配置文件），不存在把 dsh 代码编进 Agent LLM 的情况；
> 2. dsh 依赖 Agent LLM 的 llama-server 提供模型，因此「先加载模型、再开 dsh」是默认使用顺序；
> 3. 任何形态下 dsh 都是**用户明确开启才运行**的本地服务，不做静默自启。

### 1.4 与既有路线图的关系

`ROADMAP_0.3.0_1.0.0.md` 原计划把「Agent 深度强化」放在 1.0.0。本计划把 **dsh 智能体接入**提前到 **0.4.0**，作为「功能成熟」的正式第一步；0.3.x 已完成稳定加固（0.3.1 已发布），具备承载新模块的条件。0.4.0 遵循 `AGENTS.md`：**不改动任何默认加载/推理参数**（`ctx`/`ngl`/KV/batch/parallel/max token/reasoning 等仍是排障基线）。

---

## 2. 需求拆解与范围

### 2.1 功能需求（F1–F7）

#### F1 设置中心新增「Agent（智能体）」界面
- 在 `SettingsWorkspace.tsx` 的 `settingsTabs` 增加标签：`{ id: 'agent', label: 'Agent（智能体）', icon: Bot }`
- `ViewType` 增加 `'agent'`；新增页面 `pages/AgentPage.tsx`（移动端横向 chip 与桌面侧栏同步支持）
- 页面定位为 **dsh 控制台**，与现有「工具」页（llama.cpp 原生工具开关）**并列但不混淆**：页面顶部说明二者差异

#### F2 环境检测
复用 `env_check.rs` 的 `EnvCheckItem` 结构（id/level/title/detail/install_hint/install_url/in_app_action），新增 dsh 检测项：

| 检测项 id | 检测内容 | 失败等级 | 通过标准 |
|-----------|----------|----------|----------|
| `dsh_node` | Node.js 运行时（系统或托管） | error | 版本 ≥ spike 实测下限（预期 ≥22.19；托管 Node LTS 直接通过） |
| `dsh_pkg` | `@deepseek-ai/dsh` 已安装版本 | error | 托管目录存在且 `--version`/`dump-config` 可用 |
| `dsh_home` | DSH_HOME 目录可写 | error | 托管 `dsh-home/` 可创建/写文件 |
| `dsh_port` | 端口 3080 未被占用 | warning | 端口可绑定（被占用时给出占用进程提示） |
| `dsh_model_api` | 本地模型 API 可达 | warning | 绑定的 llama-server `/v1/models` 返回 200（未绑定模型时显示「未绑定」，不阻塞） |
| `dsh_proxy` | HTTP(S) 代理连通性（可选） | warning | 沿用 `proxy_url`，能访问 npm registry / GitHub |

#### F3 安装辅助
- **Node.js 运行时**：默认**托管安装**官方便携版（zip）到 `%APPDATA%\AgentLLM\runtimes\node-<版本>\`（版本化目录，保留「最新 + 上一份」，与内核更新同策略）；仅当系统已存在合规 Node 时自动复用并标注来源。
- **dsh 包**：把 `@deepseek-ai/dsh` 以固定版本安装到托管目录 `dsh\packages\`（npm 离线/镜像 + SHA256 校验，参照内核下载链路），不污染用户全局 npm。
- 安装动作全部**由用户点击触发**，带进度、可取消、可重试；缺 Node 时同时提供「跳转官方 LTS 下载页」备选。
- 支持代理与 GitHub/npm 镜像配置（沿用 `proxy_url`）。

#### F4 开启 / 关闭（进程管理）
- 后端 `services/dsh_manager.rs`：启动（解析出 node + dsh bin 路径，`node lib/bin.js web --no-open`，注入 `DSH_HOME`/`PATH`/代理环境变量）、停止、状态、健康检查（GET 3080）。
- Windows 进程树管理：复用 llama-server 的 Job Object / 句柄终止模式，退出 Agent LLM 时自动回收 dsh，避免残留 node 子进程。
- 前端按钮：状态卡上的「开启 dsh / 关闭 dsh」，二次确认关闭；运行中禁止重复启动。

#### F5 本地模型接入 dsh
- 用户在 Agent 页选择**当前加载的模型**（或任一已扫描模型）→ 点击「接入 dsh」。
- 后端组装 llama-server 端点：`baseURL = http://127.0.0.1:<port>/v1`、`model id = model_alias`（未设 alias 用模型文件名），若 llama-server 配置了 API key 则通过 env（如 `AGENT_LLM_DSH_KEY`）注入。
- 把自定义提供方写入 `$DSH_HOME/settings.yaml`（dsh 停止时写入，避免配置竞态），随后启动并调用 `/v1/models` 校验，返回「已接入」状态。
- dsh 内模型路由为 `llm-pi-ai.providers.agent-llm-local`（命名待 spike 定稿），UI 提示用户在 dsh 的「设置 → 模型」选中该提供方。

#### F6 dsh 运行日志在软件中可见
- 捕获 dsh 子进程 stdout/stderr → 独立环形缓冲（与 llama 日志分离）+ Tauri 事件推送；
- Agent 页内嵌日志面板（复用 `LlamaLogsPage` 交互范式）：实时/暂停、自动滚动、错误/警告着色、复制、导出、清空。
- 启动日志中解析出 dsh 打印的访问 URL，用于状态卡显示与「打开界面」按钮。

#### F7 界面化启停与打开
- Agent 页状态卡展示：dsh 运行状态、Web UI 地址、绑定模型、端口、DSH_HOME；
- 按钮：开启 / 关闭 / 打开 dsh 界面（默认浏览器打开 3080；若启动时未带 `--no-open` 则由 dsh 自行开浏览器，二者择一，避免双开）。

### 2.2 明确不做（v0.4 范围外）

| 项 | 说明 | 去向 |
|----|------|------|
| 应用内嵌 dsh Web UI（WebView 套 3080） | 增加复杂度与版本耦合 | 列为 P2 可选项，不在 0.4 验收 |
| dsh 插件市场/管理 UI | 只托管官方核心包，不管理第三方插件 | 后续版本 |
| 远端/云模型接 dsh | 0.4 只接 Agent LLM 本地 llama-server | 后续版本 |
| 多 dsh profile / 多实例 | 0.4 只管理 `web` profile 单实例 | 后续版本 |
| 替代现有「工具」页 llama.cpp 原生工具 | 两者共存，Agent 页做差异化说明 | — |

---

## 3. 现状盘点（可复用资产，避免重复开发）

| 能力 | 现状 | 位置 |
|------|------|------|
| 环境检测框架 | `EnvCheckItem`（level/title/detail/hint/url/in_app_action）与「跳转核心更新」动作 | `commands/env_check.rs` |
| 版本化下载安装 | GitHub release 下载、SHA256 校验、装前装后 `--version` 双验证、失败丢弃、保留最新+上一份、代理/镜像 | `services/auto_updater.rs`、`commands/updater.rs`、`pages/KernelUpdatePage.tsx` |
| 进程管理 | 启动/停止/状态、Job Object 句柄终止、健康检测、日志缓冲、`server:*` Tauri 事件 | `services/process_manager.rs`、`commands/server.rs` |
| 配置持久化 | `config.json`（`AppConfig`，serde default 可平滑加字段）、API key 走 keyring | `models/app_state.rs`、`commands/config.rs` |
| 设置中心 | 侧栏标签（设置/核心更新/使用统计/工具）+ 移动端 chip | `features/settings/SettingsWorkspace.tsx` |
| 日志 UI | 实时轮询/暂停/自动滚动/着色/复制/导出/清空 | `pages/LlamaLogsPage.tsx`、`components/LogPanel.tsx` |
| 前端 Tauri 封装 | `desktop.ts` 命令封装、`AppContext` 全局状态、事件订阅 | `lib/desktop.ts`、`context/AppContext.tsx` |
| 系统能力 | `open_external_url`、`reveal_path`、数据目录、HTTP 代理 | `commands/system.rs`、`commands/config.rs` |

> 关键差异：现有「核心更新」托管的是 **llama.cpp 预编译内核**，dsh 需要**两个新运行时**（Node.js + npm 包），安装/校验链路可复用内核更新的骨架但需新增「npm registry 解析」环节。

---

## 4. 总体架构

### 4.1 托管目录布局（均在 `%APPDATA%\AgentLLM\` 下，随数据管理可清）

```text
AgentLLM/
├── config.json                     # AppConfig（新增 dsh 段）
├── runtimes/
│   └── node-v22.x.x-win-x64/       # 托管 Node 便携版（版本化，保留最新+上一份）
├── dsh/
│   ├── packages/                   # npm 安装 @deepseek-ai/dsh（固定版本，含 lock）
│   └── versions.json               # 已安装版本记录（复用内核 version 文件思路）
└── dsh-home/                       # DSH_HOME（settings.yaml / .credentials.yaml / profiles/ / sessions）
```

- `DSH_HOME` 指向 `dsh-home/`，让 dsh 的会话/设置/凭据都收进应用数据目录，与 Agent LLM「数据与缓存位置」说明一致；
- 目录可写性由 F2 检测，首次安装前自动创建。

### 4.2 运行时策略（推荐：系统优先 + 托管兜底）

| 场景 | 处理 |
|------|------|
| 系统存在合规 Node（≥ 实测下限） | 直接复用系统 Node，UI 标注「使用系统 Node vX.Y.Z」 |
| 无 Node 或版本过低 | 默认执行**托管安装**（官方便携 zip → `runtimes/node-*`），仅注入到 dsh 子进程 env，不改系统 PATH |
| 托管 Node 下载失败 / 用户偏好 | 备选按钮「跳转 Node.js 官方 LTS 下载页」+ 检测到安装后自动识别 |

> 取舍：托管便携 Node 与「核心更新」理念一致（不动系统环境、可整体删除、版本可控），代价是约 30–40 MB 体积与下载耗时；系统 Node 存在时自动复用可抵消该代价。

### 4.3 进程管理设计（`services/dsh_manager.rs`）

- 启动：解析 node 路径与 `dsh/packages/node_modules/@deepseek-ai/dsh/lib/bin.js` → `node <bin> web --no-open`（参数与端口由配置决定，默认 3080）→ 注入 `DSH_HOME`、`PATH`、`HTTP_PROXY/HTTPS_PROXY`（若配代理）→ 健康轮询 GET `/` 直到 200 或超时 → 发 `dsh:ready`。
- 停止：发 SIGTERM/终止句柄 → Job Object 回收整棵进程树 → 发 `dsh:stopped`；超时强制结束。
- 退出钩子：`quit_app`/托盘退出时联动 `stop_dsh()`（仿 `stop_server`）。
- 事件：`dsh:log`（增量行）、`dsh:ready`、`dsh:stopped`、`dsh:error`、`dsh:progress`（安装进度）。
- 命令面：`dsh_start` / `dsh_stop` / `dsh_status`（含健康与 Web URL）/ `dsh_get_logs` / `dsh_clear_logs`。

### 4.4 dsh 配置管理

- dsh 的 `settings.yaml` 采用**「dsh 停止时整段写入 + 启动时校验」**：Agent LLM 只维护 `llm-pi-ai.providers.agent-llm-local` 段，其余配置由 dsh Web UI 管理，避免互相覆盖；
- 写前备份 `settings.yaml.bak`，失败可回滚；
- 如需调试，提供「导出当前 dsh 配置」（复用 dsh `--dump-config`）按钮，便于排障与计划书第 9 章待确认项验证。

### 4.5 本地模型接入链路（F5 时序）

```text
Agent 页选择模型 ─► 后端组装端点(baseURL/model id/API key env)
      │
      ▼
dsh 已停止？ ──否──► 提示先关闭 dsh（或自动执行 停止→写入→启动）
      │是
      ▼
写入 $DSH_HOME/settings.yaml（provider 段）＋备份
      ▼
启动 dsh ──► GET /v1/models 校验 llama-server 可达且含该 model id
      ▼
状态卡置「已接入」＋提示：在 dsh 设置→模型 选择 agent-llm-local 提供方
```

- 依赖关系提示：接入前若 llama-server 未运行，引导用户在模型页先加载目标模型（**不改动加载参数**）；若绑定模型被卸载，Agent 页显示「模型未运行」并允许重新接入。

### 4.6 日志链路（F6）

```text
dsh 子进程 stdout/stderr
   └─► dsh_manager 行解析（时间戳/级别着色关键词）
        ├─► 内存环形缓冲（get_dsh_logs 全量拉取）
        └─► tauri emit "dsh:log" ──► 前端 Agent 页日志面板增量渲染
```

### 4.7 Agent 页 UI 设计（中文文案示例）

| 区块 | 内容 | 关键按钮/文案 |
|------|------|----------------|
| 状态卡 | dsh 运行状态、Web UI 地址、绑定模型、端口、DSH_HOME | 「开启 dsh」「关闭 dsh」「打开界面」 |
| 环境检测 | F2 列表（level 着色 + 修复动作） | 「重新检测」「修复全部可自动修复项」 |
| 安装辅助 | Node/dsh 包状态与版本、更新可用性 | 「安装 dsh」「更新 dsh」「重装/修复」 |
| 本地模型接入 | 模型下拉 + 端点预览（只读） | 「接入本地模型」「解除接入」 |
| 运行日志 | F6 面板 | 「实时/暂停」「复制」「导出」「清空」 |
| 安全提示 | 首次进入折叠提示（dsh 实验性 + 可执行代码风险，引用上游 SAFETY） | 「我已了解」 |

---

## 5. 分阶段实施计划

> 估算按单人全栈，工作日（d）计；每阶段结束都要求可运行、可演示。

### Phase 0 —— 调研 / Spike（P0，约 2–3 d）⭐先行

**目的**：把「待确认项」（第 9 章）逐一实测，产出《dsh 接入实验记录》，定稿配置 schema 与版本。

| 任务 | 产出 |
|------|------|
| 安装固定版 `@deepseek-ai/dsh`，确认 npm 包 Node 运行下限与依赖体积 | 实测版本号 + Node 下限 |
| 实测 `dsh web` 的 flags（`--no-open`/`--port`/host）、首次 profile 初始化、健康探测路径 | 启动参数与健康检查规范 |
| 手动构造 `llm-pi-ai.providers.*`（`openai-completions`）指向 llama-server，验证无鉴权/带 key 两种接入；验证 dsh 发起的请求与 llama-server 兼容（`role: developer`、`max_completion_tokens`、工具调用 schema 等） | 本地模型端到端跑通一个 agent 任务 + 兼容性差异清单 |
| 确认 `settings.yaml` 外部写入的生效时机（热加载 vs 需重启）与备份/回滚策略 | 写入策略定稿 |
| 在 Windows 上确认 `web` profile 所需的命令工具（PowerShell/`pwsh`、git 等）与权限预设 | 环境检测项补充 |

**验收**：本地模型经 dsh Web UI 完成一次真实 agent 任务（读取工作区 → 运行命令 → 输出结果）；实验记录入库（`docs/` 或 `app/scripts/`）。

### Phase 1 —— 托管运行时与 dsh 安装服务（P0，约 3–4 d）

- 后端：`services/dsh_installer.rs`（Node 便携版下载/SHA256/解压/版本记录；npm 包安装与校验；代理/镜像）、`models/dsh_types.rs`（`DshConfig`/`DshStatus`/`DshEnvCheckItem`）、`commands/dsh.rs`（安装类命令）、`AppConfig.dsh` 字段（serde default）。
- 前端：`AgentPage.tsx` 骨架 + 环境检测列表 + 安装按钮与进度（复用 `KernelUpdatePage` 的下载进度交互）。
- **验收**：干净环境（无 Node）下点两下完成托管安装；重复安装幂等；卸载数据目录后无残留。

### Phase 2 —— dsh 进程管理与日志（P0，约 3–4 d）

- 后端：`services/dsh_manager.rs` + `commands/dsh.rs`（启停/状态/日志）+ 事件；退出钩子联动。
- 前端：状态卡 + 启停按钮 + 日志面板（复用 `LogPanel`/`LlamaLogsPage` 模式）。
- **验收**：开启后 3080 可访问；关闭后进程树无残留；重启 Agent LLM 不产生孤儿进程；日志实时可见且与 llama 日志分离。

### Phase 3 —— 本地模型接入（P0/P1，约 3 d）

- 后端：`settings.yaml` 段写入/备份/回滚；端点组装；`/v1/models` 校验。
- 前端：模型下拉 + 接入/解除按钮 + 依赖提示。
- **验收**：绑定当前加载模型 → 在 dsh 设置选中提供方 → agent 任务跑通（复用 Phase 0 用例）；解除绑定后 dsh 配置回滚干净。

### Phase 4 —— UI 整合与安全/数据管理（P1，约 2–3 d）

- 设置中心标签/路由整合；页面中文文案与安全提示定稿；「打开界面」按钮；
- 数据管理：Agent 数据目录显示/打开/清理入口（与「数据管理」设置项一致）；端口冲突提示。
- **验收**：F1/F7 全部可用；页面深/浅色与现有 Fluent 主题一致；移动端 chip 可用。

### Phase 5 —— 测试、文档与发版（P1，约 2–3 d）

- Rust 单测：`dsh_installer`（路径/版本/幂等）、`dsh_manager`（启停关键路径）、`settings.yaml` 写入回滚；
- 前端：类型/lint/build；手工冒烟清单（含干净环境安装、断网重试、代理场景）；
- 文档：`CHANGELOG.md` 0.4.0 段、`README.md` 功能总览与快速开始增补、`docs/` 实验记录归档；
- 发版：`npm run desktop:build` 产物落 `app/src-tauri/target/release/agent-llm.exe`（遵守 AGENTS.md），便携包验证。
- **验收**：全部里程碑绿 + CI（cargo check / npm lint+build）通过 + 冒烟清单通过。

> 合计约 **13–17 个工作日**，可视团队人力并行 Phase 1/2。

---

## 6. 文件改动清单（以当前 main `5d29b5f` 为基准）

### Rust 后端（`app/src-tauri/src/`）

| 文件 | 动作 | 内容 |
|------|------|------|
| `models/dsh_types.rs` | 新增 | `DshConfig`、`DshStatus`、`DshEnvCheckItem`、`DshLogLine` |
| `models/app_state.rs` | 修改 | `AppConfig` 增 `dsh: Option<DshConfig>`（serde default 迁移） |
| `services/dsh_installer.rs` | 新增 | Node 托管安装、dsh npm 包安装/校验/卸载、版本记录 |
| `services/dsh_manager.rs` | 新增 | 启停/健康/日志环形缓冲/事件/退出钩子 |
| `services/dsh_config.rs` | 新增 | `settings.yaml` 段读写/备份/回滚、`--dump-config` 导出 |
| `commands/dsh.rs` | 新增 | `dsh_env_check`、`dsh_install_node`、`dsh_install_package`、`dsh_uninstall`、`dsh_start`、`dsh_stop`、`dsh_status`、`dsh_get_logs`、`dsh_clear_logs`、`dsh_bind_model`、`dsh_unbind_model`、`dsh_open_ui`、`dsh_export_config` |
| `commands/env_check.rs` | 修改 | 复用 `EnvCheckItem` 增加 dsh 项（或在 dsh.rs 内独立实现同构列表） |
| `commands/mod.rs` / `lib.rs` | 修改 | 注册新命令与事件 |

### 前端（`app/src/`）

| 文件 | 动作 | 内容 |
|------|------|------|
| `types/index.ts` | 修改 | `ViewType` 增 `'agent'`；`DshConfig`/`DshStatus` 类型 |
| `features/settings/SettingsWorkspace.tsx` | 修改 | `settingsTabs` 增 Agent 标签 + 面板路由 |
| `pages/AgentPage.tsx` | 新增 | 状态卡/环境检测/安装/模型接入/日志/安全提示区块 |
| `lib/desktop.ts` | 修改 | dsh 命令封装 + 事件订阅（`dsh:*`） |
| `context/AppContext.tsx` | 修改 | dsh 状态切片（运行状态/日志/安装进度） |
| `components/LogPanel.tsx`（或复用） | 修改 | 泛化供 Agent 页使用 |

---

## 7. 里程碑与验收

| 里程碑 | 交付物 | 验证标准 |
|--------|--------|----------|
| M0 | Phase 0 实验记录 + 版本/配置定稿 | 本地模型在 dsh 端到端跑通 agent 任务 |
| M1 | 托管运行时 + 安装服务 | 干净环境点两下装好；幂等；可卸载 |
| M2 | 进程管理 + 日志 | 界面启停、无孤儿进程、日志可见 |
| M3 | 本地模型接入 | 绑定→dsh 选中提供方→任务跑通；解除回滚干净 |
| M4 | UI 整合 + 安全/数据管理 | F1/F7 全可用，主题一致 |
| **发布 0.4.0** | CHANGELOG + README + exe | 构建 + 冒烟清单通过 |

---

## 8. 风险与对策

| 风险 | 等级 | 对策 |
|------|------|------|
| dsh 开发者预览，版本快速迭代、可能有破坏性变更 | 高 | **固定版本**安装（记录 `versions.json`），不做无声自动升级；升级走 UI 显式「更新 dsh」并保留上一份可回退 |
| dsh 配置 schema（settings.yaml/provider 段）不稳定 | 高 | Phase 0 定稿 + 每次安装后 `--dump-config` 校验；写前备份，启动前校验失败即回滚 |
| llama-server 与 dsh 的 OpenAI 兼容差异（`role: developer`、`max_completion_tokens`、工具 schema） | 中 | Phase 0 用真实模型端到端验证；记录差异清单；必要时在 provider 段或 llama-server alias 侧做最小适配（**不改默认推理参数**） |
| 首次安装体积/耗时（Node ~30–40MB + dsh 包依赖） | 中 | 下载进度可视化、可取消、断点续传思路沿用内核链路；系统 Node 存在时自动复用 |
| dsh 可执行模型生成的代码/命令（安全面扩大） | 高 | 仅在用户明确开启 dsh 后运行；页面折叠展示上游 SAFETY 中文要点；默认仅绑回环 llama-server；提示用户用 dsh 的权限预设/审批；不向 dsh 暴露用户系统凭据 |
| Windows 进程树残留/僵尸 node | 中 | Job Object 整树终止 + 退出钩子 + 健康轮询兜底 |
| 端口 3080 被占用 | 低 | 检测并提示；支持配置端口 |
| 代理/镜像网络环境安装失败 | 中 | 沿用 `proxy_url`，安装命令注入代理 env；失败给出中文排障与重试 |
| DSH_HOME 会话数据增长 | 低 | 数据管理页提供目录定位与清理（用户确认） |
| 应用内嵌 Web UI 过度承诺 | 低 | v0.4 明确外部浏览器打开；内嵌列为 P2 备选 |

---

## 9. 待确认问题清单（已于 2026-09-04 Phase 0 实测定稿，证据见 [DSH_SPIKE_RECORD.md](DSH_SPIKE_RECORD.md)）

1. ✅ **Node 下限 `^22.19 || >=24`**（实测 22.23.2 与 24.15.0 均端到端通过；npm 包 engines 为 null）；托管默认装 **22 LTS** 便携版，系统 Node 合规时复用。
2. ✅ **无鉴权无需 apiKeyEnv/凭据**：provider 段 `headers.authorization: Bearer unused` 占位即可跑通；llama-server 配置 API key 时才注入真实 key。
3. ✅ **不依赖热加载**：settings.yaml 虽有 chokidar watcher，但外部写入后 web 进程无可观测重载反应，且 dsh 自身会经同链回写覆盖；统一采用「**停止 → 写 → 启动**」。
4. ✅ **绑定粒度以「当前加载模型」为主**：绑定即把 llama-server 端点写为 provider 并以顶层 `agent-default-model` 设为默认模型；显式端口/alias 的高级绑定 v0.4 不做 UI。
5. ✅ **形态 A：外部浏览器打开 3080**；B（WebView 内嵌）维持 P2。
6. ✅ **锁定已测版本 `@deepseek-ai/dsh@0.1.1-rc.2`** + UI 显式更新，不做无声自动升级。
7. ✅ **不做任何自启**；仅用户显式开启。

> 补充定稿（spike 新增）：健康探测 = `GET /` 返回 200；启动日志锚点 = `dsh web: <url>`；启动 CWD = 用户工作区（可配置）；依赖体积约 271 MB / 2.96 万文件（安装进度与重试必备）；F5 校验升级为「/v1/models + 真实小补全」；环境检测增加 `dsh_shell`（info，pwsh 7 可选、5.1 回退可用）。

---

## 10. 附录

### A. dsh 快速事实卡（调研快照）

- 运行：`npx @deepseek-ai/dsh web` → Web UI `http://127.0.0.1:3080`（`--no-open` 只起服务）
- CLI：`dsh web`=`--profile web`；另有 `headless`/`sdk`/`sdk-minimal`/`acp`；`dsh plugin --profile <name> <pnpm args>` 管理插件
- 目录：`$DSH_HOME/profiles/<name>/`、`cordis.patch.yml`、`settings.yaml`、`.credentials.yaml`
- 配置层：profile bundle patches → profile `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch`
- 模型：设置 → 模型；自定义 OpenAI 兼容提供方（Provider ID/baseURL/协议/凭据/模型）；`llm-pi-ai.providers.*`
- 许可证：MIT；官方安全说明：`SAFETY.zh.md`（实验性、未安全审计、可执行模型生成的代码）

### B. 参考链接

- dsh 中文 README：<https://github.com/deepseek-ai/deepseek-harness/blob/master/README.zh.md>
- dsh 文档站：<https://deepseek-harness.github.io/deepseek-harness/>
- npm 包：<https://www.npmjs.com/package/@deepseek-ai/dsh>
- 本项目路线图：`docs/ROADMAP_0.3.0_1.0.0.md`

### C. 术语

| 术语 | 含义 |
|------|------|
| dsh / DeepSeek Harness | DeepSeek 开源的 Cordis 驱动 agent harness（智能体框架） |
| DSH_HOME | dsh 数据/设置主目录（本计划收进 `%APPDATA%\AgentLLM\dsh-home`） |
| profile | dsh 的插件组合包 + 用户补丁层；`web` profile 提供 Web UI |
| Provider | dsh 中的模型提供方；`openai-completions` 即 OpenAI 兼容端点协议 |


