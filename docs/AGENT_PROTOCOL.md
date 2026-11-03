# Agent（Pi）宿主集成协议

> 状态：**现行实现**。本文档描述宿主（Rust）与 Pi 内核（Node 子进程）的实际集成契约，
> 是改动 `pi_*` 系列代码前的必读依据。
>
> 历史：2026-11-02 的旧版本是「拾一 Python worker + 自定义 stdio 行协议」的契约冻结稿。
> 实施时（2026-11-02→04）内核换成 Pi——Pi 更适合本地助手形态（Node 常驻进程、自带
> `--mode rpc`、扩展机制可宿主代理工具），旧 stdio 设计由 Pi 自带 RPC 取代，旧版可在
> git 历史查到。旧设计的核心原则保留了下来：**宿主是权限与文件访问的唯一收口**。

## 1. 角色与边界

- **宿主（Rust）**：进程托管、权限最终否决权、文件与命令的实际执行、产物读取、
  记忆落盘、窗口与 UI。
  - `commands/pi_agent.rs` 只做转发；
  - 进程与 RPC 协议在 `services/pi_agent.rs`；
  - 工具执行与权限判定在 `services/pi_tools.rs`；
  - 产物在 `services/pi_artifacts.rs`。
- **Pi 内核（Node 子进程）**：agent loop、模型调用、会话状态。**自带 read/write/edit/bash
  全部禁用**，只能通过宿主代理扩展调用工具——内核不直接碰文件系统与命令行。
- **前端**：`lib/ipc/pi.ts`（invoke 包装 + 事件订阅）；编排逻辑在
  `features/pi/PiRuntimeContext.tsx`。

## 2. 进程模型与安装

- spawn：`node <cli.js> --mode rpc --model <model> --session-id <id> --session-dir <dir>
  --extension <host_tools.js> …`。常驻子进程，stdin/stdout 承载 JSONL RPC；日志走
  stderr，宿主收进环形日志。
- 启动参数 `PiAgentStartOptions`：`node_path` / `cli_path` / `agent_dir` / `work_dir` /
  `provider` / `model` / `base_url` / `api_key` / `permission_mode` / `session_id` /
  `session_dir`。路径由界面填写或自动探测，不写死。
- 桥地址与 token 由 spawn 时环境变量注入（`PI_HOST_BRIDGE_URL` / `PI_HOST_BRIDGE_TOKEN`），
  **不得写进日志或落盘**。
- 安装与版本（`services/pi_install.rs`）：npm registry 版本列表、在线安装到应用数据
  目录、版本锁、回滚。Pi 不要求目标机装 Python——Node 由 dsh 链路同款方式托管。

## 3. 传输一：RPC JSONL（宿主 ↔ Pi）

- UTF-8，一行一个 JSON 对象；未知 `type` 记录警告并忽略。
- 宿主 → Pi：`{"type":"prompt", …}`（发起一轮，见 `pi_agent_run`）、
  `{"type":"abort"}`（中止当前轮，见 `pi_agent_cancel`）。
- Pi → 宿主：Pi 自己的 RPC 事件词汇（`message_update` / `tool_execution_*` /
  `agent_settled` 等），宿主**原样**封进 `pi:event`（payload `{ runId, event }`）转发，
  不在 Rust 层做语义改写。

## 4. 传输二：宿主工具桥（权限的唯一收口）

Pi 自带工具全部禁用；`services/pi_host_tools.ts` 是随 spawn 注入的扩展，把模型的工具
调用经**本地回环 HTTP**（`tiny_http`）送回宿主：

- 工具面：`read_file` / `write_file` / `edit_file` / `list_dir` / `run_command` /
  `save_memory` / `canvas_*` 等，见扩展里的 `HOST_TOOLS`。
- `services/pi_tools.rs` 是唯一执行点：
  - 路径必须落在 Pi 工作区（沙箱）内，canonicalize 校验；
  - 权限三档 `plan / auto / full`；auto 档需要确认时发 `pi:permission` 事件挂起，
    前端用 `pi_agent_permission_answer(id, allow)` 回答——**`id` 就是确认请求的凭证，
    等价于旧设计里的 `ask_id`**，杜绝多轮确认串答；
  - 命令用 PowerShell 执行，超时整树回收。
- 浮窗（`pi_float_window`）不弹确认：收到 `pi:permission` 只提示「请到主界面确认」，
  避免双弹竞态（主窗与浮窗都订阅了 `pi:permission`，一边确认后另一边挂着失效弹窗）。

## 5. 事件面（Rust → 前端，Tauri 事件）

| 事件 | payload | 语义 |
|---|---|---|
| `pi:event` | `{ runId, event }` | Pi RPC 事件原样转发 |
| `pi:log` | `{ line, stream? }` | 子进程日志 |
| `pi:ready` | `PiAgentStatus` | 进程就绪 |
| `pi:exit` | `{ message? }` | 进程退出 |
| `pi:error` | `{ message? }` | 错误 |
| `pi:permission` | `PiPermissionRequest`（带 `id`） | 权限确认请求 |

## 6. 产物契约（`services/pi_artifacts.rs`）

- 产物只允许落在工作区根下，**每个会话一个子目录**；读取时宿主再做 canonicalize
  子树校验。**不复用**聊天附件的白名单（`read_media_file` 覆盖桌面/文档/下载；
  产物路径来自模型输出，必须单独收口）。
- `pi_resolve_artifacts`：递归按文件名解析（深度 ≤ 8、条目 ≤ 20,000），返回
  `{ name, relPath, size, mtime, exists, duplicate, magic, … }`；重名取最新修改并标记。
- `pi_read_artifact`：按需读取。上限：图片 16MB、PDF 24MB、文本 2MB。
- 文件头嗅探：`magic` 是真实格式（png / jpeg / pdf / zip / cfb …），`magicOk` 表示
  与扩展名是否一致。PNG / JPEG / PDF / ZIP 容器（docx、xlsx、pptx、odt）都会校验；
  PDF 读取前校验 `%PDF-` 头，不符直接拒绝。
- 消息里只存相对路径、大小、mtime、标题等元数据；**绝不存 base64**——AppContext
  持久化时剥离 `artifacts[].src`，防止 localStorage 配额写满后全部数据不再落盘。
- 产物门（前端 `artifactGate.ts`）只在任务类型白名单内生效，并要求出现明确产出动作
  或文件名；它按「存在 → 扩展名 → 非空 → 文件头」顺序校验，失败时把本轮标为未交付
  并给出中文原因。
- `pdf` 预览走内嵌 iframe；思维导图识别 `.mmd` / `.mermaid` / `.mindmap` /
  `.mindmap.json`，支持 mermaid `mindmap`、嵌套 JSON 和 Markdown 标题/列表三种来源，
  解析成树后用纯 CSS 渲染（`MindMapPreview`），不引入 mermaid / 图形库。

## 7. 记忆与技能

- 记忆（`services/pi_memory.rs`）：跨会话全局——会话工作区按会话隔离，所以「记住
  用户偏好 / 提炼出的事实」不能落在工作区里。
  - `MEMORY.md`：模型经 `save_memory` 宿主工具主动写入的事实；
  - `tool-errors.md`：宿主在工具调用失败时自动追加（零模型成本），让下一轮不再踩
    同一个坑；
  - 每轮任务前把两者拼成【长期记忆】块注入（有大小上限，超限从最旧行裁起）；
  - 记忆内容会进入后续轮次的提示词——它由模型写入，宿主只做转义，注入前要意识到
    这是不可信内容。
- 技能（`services/pi_skills.rs`）：索引与选配；筛选口径源自拾一时期的实测结论
  （`shyi-ai/shiyi/kernel/skill_loader.py`）。

## 8. 错误与恢复

- 子进程退出：`pi:exit` 带消息；宿主清理运行态，界面标「已停止」，不自动重启
  （重启是显式动作，由 PiPanel / 聊天入口触发）。
- 错误：`pi:error` 带消息；气泡内以步骤（tone=err）呈现，不弹系统对话框。
- 权限挂起不设硬超时：由用户回答或 `pi_agent_cancel` 结束；轮次收尾时清除挂起提示。
- 旧 stdio 设计里的 `ping/pong` 存活探测未在 Pi 集成中实现——存活以进程句柄
  `pi_agent_get_status().running` 为准。

## 9. 安全边界

- 协议消息不是可信输入：Pi 产出的路径、URL、文件名都要在宿主侧重新校验。
- `link` 只允许 `http` / `https`，由 `open_external_url` 二次校验。
- **`full` 档不是操作系统级沙箱**：它只拦截常见危险命令与越界路径，无法覆盖所有
  PowerShell 绕过；真正的强隔离需要容器/虚拟机。这是已知且接受的边界，如实写在这里。
- 权限三档、沙箱路径校验、超时整树回收由宿主兜底；协议与扩展不替代这些边界。

## 10. 改动纪律

1. 不要绕过 `pi_tools` 执行模型请求的动作；宿主是权限的唯一收口。
2. 新增工具先在 `pi_host_tools.ts` 的 `HOST_TOOLS` 注册，再在 `pi_tools` 实现与判定，
   两处名字必须一致。
3. 桥 token 出现在日志或落盘文件里视为缺陷。
4. 会话数据读写走 `historyKeyOf(scope)`，不要硬编码桶键（见架构 v3 记忆）。
5. 改前端后必须 touch `build.rs` 再 `cargo build --release`，否则 exe 里仍是旧前端。
