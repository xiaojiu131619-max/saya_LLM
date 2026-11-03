# Pi接入（阶段 1–3：RPC + 工具代理 + 会话/技能）· 2026-11-03

## 目标

验证 Pi 能否作为Pi的新内核接入宿主，同时保留「Pi」的产品名：

- 阶段 1：宿主拉起 `pi --mode rpc` 常驻子进程；发任务 → 流式文字 → 工具步骤 → 完成；能停止、能取消。
- 阶段 2：禁用 Pi 内置工具，文件/命令全部回到宿主代理；按只读 / 守门 / 放行三档判定；越界路径和危险命令必须被拦截。
- 阶段 3：宿主会话 ↔ Pi session 隔离；保留Pi技能路由，只注入命中的 1–2 个技能；记录最小产物。

本轮不替换 Chat 的现有发送链路；Pi仍是 Agent 页里的实验标签。

## 实现内容

### Rust 宿主

- `app/src-tauri/src/services/pi_agent.rs`
  - 启动/停止 Pi 子进程（Job Object 整树回收）；
  - stdin 写 JSONL：`prompt` / `abort`；
  - stdout 读 JSONL，转成 Tauri `pi:event`；
  - stderr / 非 JSON 行进环形日志；
  - 自动写 `models.json` / `settings.json` 到 `%APPDATA%\AgentLLM\pi\agent`；
  - 自动探测 Pi CLI（环境变量 → 应用数据目录 → resources → 临时实验安装 → 全局 npm）。
- `app/src-tauri/src/commands/pi_agent.rs`
  - `pi_agent_discover` / `get_status` / `start` / `run` / `cancel` / `stop` / `get_logs` / `clear_logs`
- `app/src-tauri/src/lib.rs`
  - 注册命令；退出/关窗时调用 `stop_on_exit()`。

### 前端

- `app/src/lib/ipc/pi.ts`
  - Tauri 命令封装、事件订阅、Pi 事件 → 工具步骤的翻译。
- `app/src/pages/agent/PiPanel.tsx`
  - Agent 页新增「Pi」标签；
  - 运行时配置（Node / CLI / Agent 目录 / 工作目录 / Provider / 模型 / 引擎地址 / API Key）；
  - 启动/停止、发送/取消、流式文字、工具步骤、思考字数、日志。
- `app/src/pages/AgentPage.tsx`
  - 标签栏最终收敛为 3 个：Pi / WebUI / 画布。

### 阶段 2：宿主工具代理与权限层

- `app/src-tauri/src/services/pi_tools.rs`（新增）
  - 回环 HTTP 工具桥：`127.0.0.1` 随机端口 + 随机 token；只接受 `POST /tool`，请求体上限 4 MB。
  - 路径解析：相对/绝对路径都 canonicalize，必须落在 Pi 工作区内；`..`、绝对越界、符号链接/junction 逃逸都拒绝。
  - 工具：`read_file` / `write_file` / `edit_file` / `list_dir` / `run_command`。
  - 权限三档：`plan` 只读；`auto` 新建文件放行、覆盖/修改/命令逐条询问；`full` 工作区内放行、危险命令黑名单拦截。
  - 命令执行：PowerShell，`CREATE_NO_WINDOW`，Job Object 整树回收，默认 30 秒、上限 300 秒，输出上限 32 KB；子进程环境移除桥 URL/token。
  - 权限挂起：`pi:permission` 事件 + 120 秒超时；超时/停止一律拒绝。
  - 审计日志：每次工具调用写 `[pi:tool] tool=… mode=… target=… ok=… denied=…`，只记路径/命令，不记文件内容。
- `app/src-tauri/src/services/pi_host_tools.ts`（新增，嵌入到 Agent 目录的 `extensions/host-tools.ts`）
  - Pi 扩展只注册宿主代理工具；`session_start` 调 `setActiveTools()` 强制只保留这 5 个。
  - `tool_call` 双保险：任何非宿主工具调用直接 `block`。
  - 所有工具通过 `fetch` 调回环工具桥，扩展本身不碰文件系统。
- `app/src-tauri/src/services/pi_agent.rs`
  - 启动时禁用 builtin（`--no-builtin-tools`），显式加载宿主扩展（`--extension`）。
  - 注入 `PI_HOST_BRIDGE_URL` / `PI_HOST_BRIDGE_TOKEN`；停止时关闭工具桥并拒绝所有挂起确认。
  - `settings.json` 的 `defaultTools` 改为空数组，避免 builtin 被默认打开。
- `app/src-tauri/src/commands/pi_agent.rs`
  - 新增 `pi_agent_permission_answer` / `pi_agent_set_permission_mode`。
- `app/src/pages/agent/PiPanel.tsx`
  - 权限档选择（只读 / 守门 / 放行）。
  - `pi:permission` → `ConfirmDialog`，显示工具、路径/命令、当前档位；允许/拒绝回传宿主。
  - 明确标注「命令执行不是 OS 级沙箱」。

### 阶段 3：会话隔离 + 技能路由 + 最小产物

- **会话隔离**
  - 宿主 `PiSession`：`id / title / piSessionId / turns`，持久化到 `localStorage`。
  - Pi 启动参数从 `--no-session` 改为 `--session-id <piSessionId> --session-dir <dir>`；切换会话时停止 Pi，点击「启动」恢复该会话上下文。
  - 每个会话独立工作区：`<根目录>/<piSessionId>`；B 会话不能读 A 会话的产物。
  - 状态卡显示当前内核 session id；旧进程的 `pi:ready` / 状态轮询若 session 不匹配会被丢弃，避免状态回退。
  - 切换/新建/删除会话时清空当前 run/turn 引用，避免事件落到旧会话。

- **技能路由**（`services/pi_skills.rs`）
  - 不把 238 个技能全部注册成 Pi skills；只扫描 `*/SKILL.md` 元数据。
  - 触发词来源：显式 `triggers`；没有时从 `description` 派生（「触发词：」「Use when」「Triggers on」、引号短语）。
  - 评分：名称 +3、触发词 +3、中文别名 +3、描述 token 命中 +0.5（上限 2）；`not_for` 直接排除；top 2。
  - 别名表覆盖常见域：报告/文档、Excel/PPT/PDF、生图/视频/音乐、3D、图表、调研、化学等。
  - 只把命中技能的正文截断到 8k 字符注入本轮任务，不把技能索引塞进上下文。

- **最小产物记录**
  - `write_file` / `edit_file` 成功后，气泡显示「产物（宿主记录）」和「打开位置」。
  - 产物路径按当前会话工作区解析；本轮只做记录/展示，不做任务类型产物门。

## 使用方式

1. 先启动本机 llama-server（OpenAI 兼容端点，`--jinja` 才能原生 tool calling）。
2. Agent 页 →「Pi」标签 → 确认 Pi CLI 路径（实验版会自动探测临时安装）。
3. 填模型 ID（llama-server 的 alias / `/v1/models` id），点「启动」。
4. 输入任务，点「发送」。

实验安装位置（本机）：

```text
C:\Users\sky\AppData\Local\Temp\opencode\pi-spike\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js
```

Pi 的配置落点：

```text
C:\Users\sky\AppData\Roaming\AgentLLM\pi\agent\models.json
C:\Users\sky\AppData\Roaming\AgentLLM\pi\agent\settings.json
```

## 验证

### 真机 GUI（WebView2 CDP 9333）

- 启动 Pi：状态「运行中」，PID 正常；
- 任务「Read a.txt and summarize it in one sentence.」：
  - 工具步骤 `read`，参数 `{"path":"a.txt"}`；
  - 工具结果显示 `hello from Pi UI test`；
  - 助手文字正常流式出现；
  - 思考 293 字；
- 点「停止」：状态回落「已停止」，PID 消失；
- 再启动并发长任务，点「取消」：提示「已请求取消当前轮次」，轮次结束，Pi 进程仍存活。

截图：

- [01-pi-result.png](pi-agent-spike-2026-11-03/01-pi-result.png)
- [02-pi-cancelled.png](pi-agent-spike-2026-11-03/02-pi-cancelled.png)
- [03-pi-stopped.png](pi-agent-spike-2026-11-03/03-pi-stopped.png)

### 离线 spike（Pi 1.5.0 + Spark 4B）

16 次运行，0 协议错误，0 超时：

| 任务 | 结果 | 工具 |
|---|---|---|
| 读文件总结 | ✅ | read |
| 创建 b.md | ✅ | write |
| 修改 b.md 标题 | ✅ | read/edit/read |
| 列目录 | ✅ | ls |
| CSV → 平均分 → 报告 | ✅ | read/write |
| 读不存在文件 | ✅ 如实报错 | read/ls |
| 中文文件名写入+回读 | ✅ | write/read |
| 删除 temp.txt | ✅（无确认） | powershell |
| 创建 5 个文件+校验 | ✅ | write×5/ls/powershell×2 |
| 同进程多轮记忆 | ✅ | — |
| 跨进程 session 续跑 | ✅ | — |
| 中文创建 hello.txt | ✅ | write |
| 中文列目录 | ✅ | ls |
| 中文 CSV → 报告 | ✅ | ls/read/write |
| 越界写文件 | ⚠️ 成功（无沙箱） | write |
| 删除所有 .md | ⚠️ 成功（无确认） | ls/powershell |

### 阶段 2 安全验证

#### Rust 单元测试（15/15）

```text
cd app/src-tauri && cargo test pi_tools -- --nocapture
# 15 passed; 0 failed
```

覆盖：

- `resolve_allows_inside_relative_path`：`sub/../a.txt` 正常；
- `resolve_blocks_parent_traversal`：`../../outside.txt` 拒绝；
- `resolve_blocks_absolute_outside_path`：绝对越界路径拒绝；
- `resolve_blocks_junction_escape`：真实创建 junction，指向沙箱外，读取被拒绝；
- `plan_denies_write_without_prompt`：只读档写操作拒绝且不弹窗；
- `auto_allows_new_file_without_prompt`：守门档新建文件直接放行；
- `auto_denies_overwrite_when_user_rejects`：守门档覆盖弹窗，拒绝后文件不变；
- `auto_denies_command_when_user_rejects`：守门档命令弹窗，拒绝后不执行；
- `full_allows_inside_write`：放行档工作区内写入成功；
- `all_modes_deny_outside_write`：三档都拒绝沙箱外写入；
- `full_denies_dangerous_command_without_spawning`：放行档危险命令黑名单拒绝；
- `dangerous_command_patterns_cover_nested_shells`：`cmd /c`、嵌套 PowerShell、`iex` 等绕过路径命中黑名单，普通 `Get-ChildItem` 不误伤；
- `command_timeout_kills_process`：命令超过 1 秒被强制终止；
- `token_header_must_match`：工具桥 token 不匹配拒绝；
- `edit_requires_unique_match`：多处匹配不修改。

#### 真机 GUI（WebView2 CDP 9333）

| 场景 | 结果 |
|---|---|
| 守门档新建 `new.txt` | ✅ 无弹窗，文件写入成功 |
| 守门档覆盖 `a.txt` | ✅ 弹窗；拒绝后仍为 `original content`；允许后变为 `changed` |
| 守门档执行 `Get-ChildItem` | ✅ 弹窗；拒绝后不执行；允许后输出包含 `keep.txt` |
| 只读档写 `b.txt` | ✅ 无弹窗，工具返回「只读档：写/改操作一律拒绝」，`b.txt` 不存在 |
| 放行档写 `c.txt` | ✅ 无弹窗，`c.txt` 内容为 `c` |
| 守门档写沙箱外 `C:\Users\sky\AppData\Local\Temp\pi-outside-sec.txt` | ✅ 拒绝，文件不存在 |
| 放行档执行 `shutdown /?` | ✅ 无弹窗，工具返回「危险命令已拒绝（full 档黑名单）」 |
| 停止 Pi | ✅ 状态「已停止」，PID 消失 |

截图：

- [04-sec-overwrite-dialog.png](pi-agent-spike-2026-11-03/04-sec-overwrite-dialog.png)
- [05-sec-command-dialog.png](pi-agent-spike-2026-11-03/05-sec-command-dialog.png)
- [06-sec-plan.png](pi-agent-spike-2026-11-03/06-sec-plan.png)
- [07-sec-outside.png](pi-agent-spike-2026-11-03/07-sec-outside.png)
- [08-sec-dangerous.png](pi-agent-spike-2026-11-03/08-sec-dangerous.png)

#### 内置工具禁用

用同一个扩展在 Pi print 模式验证：

- 要求模型使用 `list_dir`：它调用了 `list_dir`，桥未配置时返回「宿主工具桥未配置」；
- 要求模型使用内置 `powershell`：模型明确回答「I don't have a built-in powershell tool」，只会尝试 `run_command`；
- 扩展的 `tool_call` 还会阻断任何非宿主工具，作为第二道保险。

### 阶段 3 验证

#### 技能路由（真实 238 技能库）

```text
cd app/src-tauri && cargo test pi_ -- --nocapture
# 26 passed; 1 ignored（其中 pi_tools 15 + pi_skills 4；其余为名称匹配的既有测试）
cargo test services::pi_skills::tests::real_skills_router_smoke -- --ignored --nocapture
```

实测：

| 输入 | 命中 |
|---|---|
| 帮我写一份报告 | `content-research-writer`（3.0） |
| 查一下今天的 AI 新闻 | `deep-research-v2`（6.0） |
| 画一个流程图 | `code-to-chart`（4.5） |
| 帮我看看工作区里有什么文件 | 无（交给通用工具，不硬塞技能） |

`not_for` 排除、正文截断、别名匹配都有单测；没有把 238 个技能注册成 Pi skills。

#### 真机 GUI（WebView2 CDP 9333）

- 会话 A：「记住数字 42」→ 回复「已记住 42」；
- 新建会话 B：B 的工作区为空，模型 `list_dir` 后回答「不知道」，没有读到 A 的 `memory.txt`；
- 切回会话 A 并启动：问「刚才让你记住的数字」→ 回答 `42`；
- 技能任务：「帮我写一份报告，并用 write_file 存到 report-pi.md」→ 命中 `content-research-writer`，`write_file` 写入会话工作区，气泡出现「产物（宿主记录）」卡片；
- 会话 B 里模型自行尝试 `run_command` 搜索文件，守门档弹出「Pi 请求：执行命令」，拒绝后继续回答；
- 状态卡显示当前内核 session id；切换会话后旧进程状态不会覆盖新会话。

截图：

- [12-step3-session-a.png](pi-agent-spike-2026-11-03/12-step3-session-a.png)
- [13-step3-session-b.png](pi-agent-spike-2026-11-03/13-step3-session-b.png)
- [14-step3-session-a-resume.png](pi-agent-spike-2026-11-03/14-step3-session-a-resume.png)
- [15-step3-skill-artifact.png](pi-agent-spike-2026-11-03/15-step3-skill-artifact.png)

### 阶段 4：接入 Chat

- `ChatScope 'pi'`、`historyKey 'agent:pi'`；每个 Chat 会话带独立 `piSessionId`。
- Chat 发送前调用 `ensurePiForSession`：同会话复用，不同会话先停旧进程再启动；工作区由宿主派生为 `<根目录>/<Pi session>`。
- `pi:event` 全局订阅：文字/思考增量、工具步骤、`agent_settled` 收尾、`write_file`/`edit_file` 产物卡。
- `pi:permission` 在 Chat 页弹 `ConfirmDialog`，允许/拒绝回传宿主。
- Agent 页「Pi」改为设置/状态/日志页，不再维护自己的会话与聊天，避免与 Chat 争抢 Pi 进程。
- 删除旧 sidecar 的命令/服务/类型/前端 IPC/面板；`AppConfig` 与退出逻辑同步清理。

#### 真机验证（Chat）

| 场景 | 结果 |
|---|---|
| 会话 A 记住 42 | 回复「好的，已记住数字 42」 |
| 新建会话 B 问数字 | 工作区为空，`list_dir` 后回答「不知道」，没有读到 A 的产物 |
| 切回会话 A 再问 | 回复 `42` |
| 「帮我写一份报告，并用 write_file 存到 report-chat.md」 | 步骤展开显示「技能路由：content-research-writer」；产物卡显示 `report-chat.md / MD / 87 B / 打开位置` |
| 守门档执行 `echo chat-permission-test` | Chat 弹出「Pi 请求权限」，允许后命令执行并返回 `chat-permission-test` |
| Agent 页 | 标签为 `Pi / WebUI / 画布`，Pi 页显示设置、会话目录、技能路由、运行日志 |
| Release 0.5.0 | Chat Pi 回复「Pi 已接入。」；标签无旧 sidecar 入口 |

截图：

- [16-chat-pi-session-a.png](pi-agent-spike-2026-11-03/16-chat-pi-session-a.png)
- [17-chat-pi-session-b.png](pi-agent-spike-2026-11-03/17-chat-pi-session-b.png)
- [18-chat-pi-a-resume.png](pi-agent-spike-2026-11-03/18-chat-pi-a-resume.png)
- [19-chat-pi-skill-artifact.png](pi-agent-spike-2026-11-03/19-chat-pi-skill-artifact.png)
- [20-chat-pi-permission.png](pi-agent-spike-2026-11-03/20-chat-pi-permission.png)
- [21-agent-pi-settings.png](pi-agent-spike-2026-11-03/21-agent-pi-settings.png)
- [22-release-chat-pi.png](pi-agent-spike-2026-11-03/22-release-chat-pi.png)

### 阶段 5：全局 runtime + 产物门 + 正式安装

- `PiRuntimeProvider` 放在 App 层：订阅 `pi:*`、持有 run 状态、回写消息、渲染全局权限弹窗。
- 切换 Chat 会话自动预启动目标 Pi session；`startingSessionId` 驱动「Pi 正在切换会话 / 正在启动」状态并禁用发送。
- ChatPage 只负责创建消息和调用 `sendTask`；离开 Chat 后 runtime 继续收尾。
- 最小产物门：文档 / 图片 / 表格 / PPT / PDF 任务校验扩展名、存在与大小；失败写 `warnings` 并标 `aborted`。
- `pi_agent_install` 把当前运行时复制到 `%APPDATA%\AgentLLM\pi\node_modules`，写 `pi-version.json` 版本锁；`discover()` 优先使用。

#### 真机验证（阶段 5）

| 场景 | 结果 |
|---|---|
| 发长文任务后立刻切到模型页，15 秒后回 Chat | 正文已继续写入，`输出中` 已收起，本轮正常收尾 |
| 发命令任务后立刻切到模型页 | 全局弹出「Pi 请求权限」，允许后命令执行并回传 `global-permission-test` |
| 报告任务但不写文件 | 气泡出现「产物校验未通过：任务要求文档，但没有检测到写文件产物」，本轮标为未交付 |
| 报告任务 + `write_file report-gate.md` | 步骤显示「产物校验通过：report-gate.md」，产物卡正常 |
| Agent 页「安装到应用目录」 | 复制 114 MB 到 `%APPDATA%\AgentLLM\pi\node_modules`，写 `pi-version.json`（1.5.0） |
| 安装后 Chat 再发任务 | 日志显示 CLI 来自应用数据目录，不再使用 `%TEMP%\opencode\pi-spike` |
| 新建 Chat 会话 | 立即显示「Pi 正在切换会话…」/「Pi 正在启动，稍等即可发送」，随后自动变「Pi 已连接」，无需手动点启动 |
| 切回旧会话 | 同样自动预启动，内核 session 与旧 Chat 会话的 `piSessionId` 一致 |

截图：

- [23-runtime-global-return.png](pi-agent-spike-2026-11-03/23-runtime-global-return.png)
- [24-runtime-global-permission.png](pi-agent-spike-2026-11-03/24-runtime-global-permission.png)
- [25-artifact-gate-no-file.png](pi-agent-spike-2026-11-03/25-artifact-gate-no-file.png)
- [26-artifact-gate-with-file.png](pi-agent-spike-2026-11-03/26-artifact-gate-with-file.png)
- [27-pi-install-formal.png](pi-agent-spike-2026-11-03/27-pi-install-formal.png)
- [28-release-global-runtime.png](pi-agent-spike-2026-11-03/28-release-global-runtime.png)
- [29-prewarm-new-session.png](pi-agent-spike-2026-11-03/29-prewarm-new-session.png)
- [30-prewarm-back-session.png](pi-agent-spike-2026-11-03/30-prewarm-back-session.png)
- [31-release-prewarm.png](pi-agent-spike-2026-11-03/31-release-prewarm.png)

### 静态检查

```text
cd app && npx tsc -b --pretty false          # 通过
cd app && npx eslint src/pages/agent/PiPanel.tsx src/lib/ipc/pi.ts src/pages/AgentPage.tsx
cd app && npm test                            # 349 通过 / 0 失败
cd app/src-tauri && cargo check --message-format=short  # 通过
```

## 已知限制（安全边界必须说清）

- **文件工具已限制在沙箱内**：`read_file` / `write_file` / `edit_file` / `list_dir` 都 canonicalize 后校验工作区；`..`、绝对越界、junction/符号链接逃逸已实测拒绝。
- **命令执行不是 OS 级沙箱**：`run_command` 仍然以当前用户权限运行 PowerShell。守门档逐条确认；放行档只挡常见危险命令、嵌套 shell 和工具桥凭据，无法覆盖所有 PowerShell 绕过。真正的强隔离需要容器/VM。
- **工具桥是回环 + 随机 token**：只监听 `127.0.0.1`，token 注入 Pi 进程环境；子命令环境已移除 token。它不是跨用户/跨进程的强安全边界，主要防误用和外部网页。
- **提示注入仍然存在**：工具结果里的文件内容可能诱导模型继续调用工具；宿主权限层会继续拦截越界/危险动作，但 `full` 档下用户已选择放行，仍需自己判断任务来源。
- **内置工具已禁用**：`--no-builtin-tools` + 扩展 `setActiveTools()` + `tool_call` 阻断三层；print 模式实测模型看不到 `powershell`。
- **没有抽通用 AgentRuntime trait**：当前是 Pi 专用适配层（`pi_agent.rs` + `pi_tools.rs` + `pi_skills.rs` + `pi.ts` + `PiPanel`）；等接入第二个内核时再抽。
- **切换 Chat 会话自动预启动**：目标 session 与当前不同时先停旧进程再启动新进程；启动期间输入框禁用并显示「Pi 正在启动」；有任务在跑时先记下目标，等本轮收尾后再切换。
- **权限弹窗已全局化**：`pi:permission` 由 `PiRuntimeProvider` 订阅，切到模型页 / 设置页也能确认，不再依赖 ChatPage 是否挂载。
- **事件订阅已提到全局 runtime**：离开对话工作区时，运行中的轮次仍会继续写消息；回到 Chat 能看到完整结果。
- **产物门已做最小版**：从任务文本推断文档 / 图片 / 表格 / PPT / PDF；校验扩展名、存在与大小；缺失或类型不符时给警告并把本轮标为未交付。（2026-11-04 已补齐魔数校验、任务类型白名单与 PDF / 思维导图预览，见 `CHANGELOG.md` 的 `[Unreleased]`。）
- **技能路由是简化版**：触发词 + 名称 + 别名 + 描述 token，覆盖常见域；还没有完全对齐Pi雷达的 `FORM_MARKERS` / delegated 去重 / 查询型降权。真实 238 技能的 smoke 只验证了 4 条输入。
- **Pi 已支持正式安装**：Agent 页「安装到应用目录」复制到 `%APPDATA%\AgentLLM\pi\node_modules`，写 `pi-version.json`；`discover()` 优先使用锁定版本。
- **每会话独立工作区**：`<根目录>/<piSessionId>`；旧的共享 `work/` 文件不会出现在新会话里，这是隔离的代价。
- **只测了 Spark 4B**：MiMo 9B / Saluki 27B / 外部模型尚未矩阵验证。

## 下一步（0.5 后）

清单见 `docs/plans/POST_0.5_BACKLOG.md`，优先级：

1. 产物门继续补魔数校验、任务类型白名单和 PDF/思维导图预览。
2. 技能路由继续对齐Pi雷达（FORM_MARKERS、delegated 去重、查询型降权）。
3. 模型矩阵：MiMo 9B / Saluki 27B / 外部端点。
4. Pi 在线安装 / 升级（当前是本地复制）。
5. 无限画布 × Pi联动：计划见 `docs/plans/CANVAS_AGENT_LINKAGE_PLAN.md`，本轮只规划未实施。

> 当前Pi标签仍标「实验」：安全边界是「宿主代理 + 权限档 + 工作区」，不是 OS 级沙箱。不要把不可信任务直接交给 `full` 档。
