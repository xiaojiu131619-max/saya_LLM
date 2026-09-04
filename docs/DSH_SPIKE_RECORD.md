# dsh 接入实验记录（Phase 0 Spike）

> 日期：2026-09-04（补充首轮 2026-09-02 的遗留产物）
> 目的：为 [DSH_AGENT_0.4_PLAN.md](DSH_AGENT_0.4_PLAN.md) 第 9 章 7 项待确认问题提供实测结论，定稿 v0.4.0 配置 schema 与版本。
> 环境：Windows 10 (19044) x64、RTX 3080 Ti 12GB、系统 Node v24.15.0、llama.cpp 内核 **b10760**（`resources/kernels/b10760_20260902_233229`）、模型 Qwen3.5-9B-Uncensored-Q6_K_M（D:\lmstudio-community）。
> 实验产物目录：`%APPDATA%\AgentLLM\dsh-spike\`（草稿区）、`%APPDATA%\AgentLLM\dsh-home\`（DSH_HOME）。

---

## 结论速览（第 9 章 7 项定稿）

| # | 待确认问题 | 定稿结论 |
|---|-----------|----------|
| 1 | Node 版本下限；托管装 22 LTS 还是 24 LTS | 下限 **`^22.19 \|\| >=24`**（实测 22.23.2 与 24.15.0 均完整跑通端到端；npm 包 `engines` 字段为 null）。托管默认装 **22 LTS 便携版**（体积更小、与上游开发基线一致）；系统 Node 满足 `^22.19 \|\| >=24` 时自动复用 |
| 2 | 无鉴权 llama-server 是否需要占位 `apiKeyEnv`/凭据 | **不需要**。实测 settings.yaml 的 provider 段直接写 `headers.authorization: Bearer unused`（占位）即可，无 `.credentials.yaml` 依赖、无 apiKeyEnv 也能跑通。若 llama-server 配了 API key，再用 env 注入真实 key |
| 3 | settings.yaml 外部写入是否热加载 | **不依赖热加载，统一「停止 → 写 → 启动」**。`dsh-settings-file` 内部确有 chokidar watcher（默认 `watch: true`），但实测外部修改 settings.yaml 后 web 进程**无任何可观测重载反应**（日志无变化）；且 dsh 自身（Web UI 改设置时）会经由同一条串行链整文档回写，运行中外部重写有被覆盖风险 |
| 4 | 模型绑定粒度 | **以「当前加载模型」为主**，绑定动作=把 llama-server 端点写为 provider（含 model id）；如需高级绑定（显式端口/alias），直接编辑 provider 段即可，v0.4 UI 不做 |
| 5 | 界面形态 A / B | **A：外部浏览器打开 3080**。B（WebView 内嵌）维持 P2 不做 |
| 6 | dsh 更新节奏 | **锁定已测版本 `0.1.1-rc.2`** + UI 显式「更新 dsh」按钮；不做无声自动升级 |
| 7 | 是否自启 | **不做**任何自启/随应用启动；仅用户在 Agent 页显式开启 |

---

## 1. dsh 包与运行时（对应计划 F2/F3）

| 实测项 | 结果 |
|--------|------|
| 固定版本 | `@deepseek-ai/dsh@0.1.1-rc.2`（bin: `lib/bin.js`） |
| npm `engines` 声明 | **无（null）**，运行下限只能实测 |
| Node 实测 | v22.23.2 便携版 ✅ / v24.15.0 系统 ✅（同任务双通过） |
| 依赖体积 | **约 271 MB、约 29,600 个文件**（node_modules 实测）。托管安装需预估下载/解压耗时，UI 进度与「重试」必备 |
| 安装布局 | 实际采用：包安装进 `$DSH_HOME/profiles/`（pnpm workspace 结构，`profiles/node_modules` 内为 junction）；spike 期实体位于 `dsh-spike/node_modules` 后以 junction 挂入。**Phase 1 改为规范布局**：`%APPDATA%\AgentLLM\dsh\packages\`（npm 安装 + versions.json），junction 方案废弃 |
| CLI 骨架 | `dsh [--profile <name>] [args]`；`web`=`--profile web` 别名；`--dump-config` 可打印组合配置（调试用）；`--profile headless "任务"` 单任务运行后退出（自动化验证利器） |

## 2. web profile 与健康探测（对应计划 F4/F6/F7）

- 启动 flags 实测可用：`web --no-open --port <port> [--host <host>]`；`--port 0` 由 OS 选空闲端口；另有 `--trusted-host`（/api 的浏览器信任围栏）。
- 启动日志固定输出一行 **`dsh web: http://127.0.0.1:3080`**（含实际端口）——F6 日志解析锚点：正则 `dsh web: (http\S+)`。
- 健康探测：**`GET /` 返回 200 即健康**；`/health`、`/api/health`、`/api` 均 404。健康轮询用根路径。
- 会话落盘：headless 运行成功后 `session.jsonl.zstd` 仅含会话 header（消息延迟落盘/投影缓存），**验收不要以会话文件行数判断任务成败**，以工具产物（文件落盘/命令输出）与 headless stdout 为准。
- 会话按 CWD 归档：`$DSH_HOME/sessions/<编码后的工作区路径>/`。**Phase 2 dsh_manager 启动 dsh 时必须显式设置 CWD** 为用户工作区（默认 `%USERPROFILE%`，可配置），否则会话散落难以管理。

## 3. 本地模型接入端到端（对应计划 F5，M0 验收 ✅）

链路：`dsh headless → settings.yaml provider → llama-server b10760 (:8080/v1) → Qwen3.5-9B`。

实测可用的 provider 配置（写入 `$DSH_HOME/settings.yaml`）：

```yaml
# Agent LLM 写入的 dsh 设置
agent-default-model:
  provider: agent-llm-local      # 顶层键可直接指定默认模型，免去用户去 Web UI 手选
  model: qwen35-9b

llm-pi-ai:
  providers:
    agent-llm-local:
      displayName: Agent LLM 本地模型
      api: openai-completions
      baseURL: http://127.0.0.1:8080/v1
      headers:
        authorization: Bearer unused   # 无鉴权时占位即可（结论 #2）
      models:
        - id: qwen35-9b
          name: Qwen3.5 9B
          contextWindow: 32768
          maxTokens: 8192
```

端到端任务（Node 24 与 Node 22 各跑一次）：

> 任务："Create a file named spike-hello.txt containing `dsh end-to-end works`. Then read it back with a command and verify."

结果：agent 依次调用 **`write`（创建文件）→ `pwsh`（Get-Content 回读）**，输出自检报告，文件真实落盘且内容一致。两次运行 exit 0。

### 兼容性发现清单

| 发现 | 影响 | 处置 |
|------|------|------|
| Qwen3.5 为推理模型，响应含 `reasoning_content`，content 可能为空（当 max_tokens 太小时全被思考吃掉） | dsh 需容忍空 content；小 maxTokens 会导致「有思考无回答」 | provider 段 `maxTokens` 给足（≥8192）；在「接入」校验时用小任务实测一次，而非只查 /v1/models |
| `GET /v1/models` 的 `data[].id` 即 `--alias` 值 | model id 绑定可靠 | Agent LLM 组装 provider 时以 alias 为 model id（未设 alias 时以文件名），并在绑定流程加 `--alias`（启动参数属于应用既有逻辑，不在此改动默认值） |
| llama-server b10760 未见 `role: developer` / `max_completion_tokens` 报错 | 计划书风险表中的兼容性担忧实测未复现 | 保持风险监控，Phase 3 验收再跑一轮 |

## 4. Windows 命令执行环境（对应计划 F2 补充检测项）

- `dsh-pwsh-local` 的 shell 解析顺序：**PowerShell 7 (`%ProgramFiles%\PowerShell\7\pwsh.exe`) → PATH 中的 pwsh → Windows PowerShell 5.1 (`System32\WindowsPowerShell\v1.0\powershell.exe`)**。
- 本机（Win10）无 pwsh 7，**5.1 回退实测可用**（端到端任务的命令执行即走 5.1）。
- 官方代码注释明确：5.1 输出非 ASCII 可能乱码（pwsh 7 默认 UTF-8）。中文用户命令输出乱码属已知边界，不算阻断。
- 环境检测新增项：`dsh_shell`（info 级）——检测 pwsh 7，无则提示「使用 Windows PowerShell 5.1（中文输出可能乱码，可选装 PowerShell 7 改善）」，不阻断。

## 5. 网络与代理

- npm 下载/Node 便携包下载均需考虑代理（用户环境代理 `127.0.0.1:7890` 时通、直连亦通）。Node v22.23.2 win-x64 zip 实测 35 MB。
- Phase 1 安装链路沿用 `proxy_url` 注入 `HTTP_PROXY/HTTPS_PROXY` 到子进程 env 的既定设计，维持不变。

## 6. 对计划书的修订点汇总

1. F3 安装布局改为 `dsh\packages\`（npm 安装），**不使用** `$DSH_HOME/profiles` 内 junction；
2. F5 增加「顶层 `agent-default-model` 键直接设默认模型」，UI 文案从「请在 dsh 设置中手动选择提供方」改为「已设为 dsh 默认模型」；
3. F5 绑定校验从「仅 /v1/models 200」升级为「/v1/models + 一次真实小补全（容忍 reasoning_content）」；
4. F4/F6：健康探测=`GET /`；URL 解析锚点=`dsh web: <url>`；启动 CWD=用户工作区（新增配置项）；
5. F2 检测项增加 `dsh_shell`（info）；
6. 第 9 章 7 项全部定稿（见顶部表格），Phase 1 可以开工。
