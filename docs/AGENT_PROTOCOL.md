# Agent 协议（阶段 3 契约留档）

> 状态：**契约冻结，本轮不落地代码**。  
> 现有实现仍是前端 `EventSource` 直连拾一 HTTP API（`lib/ipc/shiyi.ts`）。  
> 阶段 3 把传输换成宿主（Rust）↔ worker（Python）的 stdio 行协议，本文件是那次替换的依据。

## 1. 角色与边界

- **宿主**：Tauri / Rust 骨架。负责进程、窗口、文件、GPU、沙箱与工具权限的最终收口。
- **worker**：拾一 Python 内核。负责 loop、判据、工具执行、skills 与会话状态。
- **宿主不重写内核**；worker 不直接操作系统 UI，也不直接打开浏览器 / 资源管理器。

stdin / stdout 只承载协议消息；日志、进度、Python traceback 一律走 stderr。宿主把 stderr 收进环形日志，不解析成协议。

## 2. 传输格式

- UTF-8 编码，一行一个 JSON 对象，行尾 `\n`。
- 不允许 pretty-print、多行 JSON、BOM。
- 每条消息必须有 `type` 字段；未知 `type` 由接收方记录警告并忽略。
- 协议版本放在 `ready` / `config` 的 `protocol` 字段，当前为 `1`。
- 所有 id 使用字符串；宿主生成 `run_id`，worker 生成 `turn_id`、`ask_id`。

## 3. 一轮任务的时序

```text
宿主                                    worker
  │  spawn                                │
  │ ────────────── config ──────────────> │
  │ <───────────── ready ──────────────── │
  │ ────────────── run ─────────────────> │
  │ <───────────── event ──────────────── │  (可多次)
  │ <───────────── ask ────────────────── │  (可多次，挂起等待回答)
  │ ────────────── answer ───────────────> │  (必须带 ask_id)
  │ <───────────── event ──────────────── │
  │ <───────────── turn_done ───────────── │  (终态)
  │                                       │
  │ ────────────── cancel ───────────────> │  (任意时刻)
  │ <───────────── turn_done ───────────── │  state = aborted / cancelled
```

约束：

- 同一个 `turn_id` 内，`event.seq` 从 1 开始严格递增；宿主按 `(turn_id, seq)` 去重。
- `ask` 会挂起当前轮次，但不会关闭流；回答后继续产生 `event`。
- `turn_done` 是轮次终态；发出后该轮不再产生 `event` / `ask`。
- `cancel` 是幂等的；对已结束的轮次返回一条 `error`（`code = turn_finished`）或直接忽略，二者都可接受，但必须稳定。

## 4. 宿主 → worker

### 4.1 `config`

启动后、`ready` 之前发送一次。后续配置变化需要宿主重启 worker（本轮不做热更新）。

```json
{
  "type": "config",
  "protocol": 1,
  "workspace_dir": "C:\\Users\\me\\AppData\\Roaming\\AgentLLM\\shiyi\\sandbox",
  "state_dir": "C:\\Users\\me\\AppData\\Roaming\\AgentLLM\\shiyi\\state",
  "skills_dir": "D:\\Projects\\shyi-ai\\data\\skills",
  "log_file": "C:\\Users\\me\\AppData\\Roaming\\AgentLLM\\shiyi\\logs\\events.jsonl",
  "permission": "auto",
  "ctx": 32768,
  "engine": {
    "base_url": "http://127.0.0.1:8080/v1",
    "model": "local-model",
    "api_key": null
  }
}
```

- `permission`：`plan` / `auto` / `full`，与现有三档一致。
- `engine.api_key` 可以为 `null`；宿主只在连接本机引擎时注入。
- `workspace_dir` 是文件工具的唯一边界。worker 不得把路径写到该目录之外。

### 4.2 `run`

```json
{
  "type": "run",
  "run_id": "run-018f...",
  "text": "帮我把这个目录里的截图整理成一份报告",
  "perm": "auto"
}
```

- `run_id` 由宿主生成，用于关联日志与取消；worker 可生成自己的 `turn_id`。
- `perm` 可选；缺省使用 `config.permission`。
- 同一时间默认只跑一轮；若未来支持并发，宿主必须给每轮独立的 `run_id`，worker 用 `turn_id` 隔离状态。

### 4.3 `answer`

```json
{
  "type": "answer",
  "turn_id": "turn-...",
  "ask_id": "ask-...",
  "reply": "允许"
}
```

**`ask_id` 是必填字段。** 现有 HTTP 协议只有 `turn_id`，多轮确认时会串答：两条挂起的提问只能靠到达顺序猜，用户回答第二个问题可能被当成第一个问题的答案。worker 必须：

- 每个 `ask` 生成唯一 `ask_id`；
- 校验 `answer.ask_id` 属于当前挂起的提问；
- `ask_id` 不匹配或缺失时返回 `error`（`code = invalid_ask_id`），**绝不猜测**。

### 4.4 `cancel`

```json
{
  "type": "cancel",
  "turn_id": "turn-...",
  "reason": "用户点击停止"
}
```

worker 应尽快停止模型调用 / 工具执行，并发出终态 `turn_done`（`state = aborted`）。`reason` 只用于日志。

### 4.5 `ping`

```json
{ "type": "ping", "id": "ping-42" }
```

worker 用一条 `event` 回复：

```json
{
  "type": "event",
  "turn_id": null,
  "seq": 0,
  "ts": 1730000000.0,
  "point": "pong",
  "id": "ping-42"
}
```

宿主用它做存活探测；`pong` 不进入对话步骤流。

## 5. worker → 宿主

### 5.1 `ready`

```json
{
  "type": "ready",
  "protocol": 1,
  "worker_version": "0.4.0",
  "skills_count": 238,
  "sandbox_dir": "C:\\Users\\me\\AppData\\Roaming\\AgentLLM\\shiyi\\sandbox"
}
```

`ready` 之后宿主机才允许发 `run`。如果 worker 需要引擎但引擎未就绪，仍然发 `ready`，并在 `engine_ok` / `message` 里说明；不要把「进程起了但引擎不可达」当成启动失败。

### 5.2 `event`

```json
{
  "type": "event",
  "turn_id": "turn-...",
  "seq": 7,
  "ts": 1730000000.0,
  "point": "after_tool_result",
  "tool": "write_file",
  "decision": "已写入 report.md",
  "ok": true
}
```

- 字段与现有 SSE 事件记录保持同构，宿主直接把 `point` 翻译成步骤文案。
- `seq` 必须在单个 `turn_id` 内严格递增；心跳事件也占用序号。
- `ts` 为 Unix 秒（浮点）。

### 5.3 `ask`

```json
{
  "type": "ask",
  "ask_id": "ask-...",
  "turn_id": "turn-...",
  "kind": "permission",
  "prompt": "是否允许覆盖已有的 report.md？",
  "options": ["允许", "拒绝"]
}
```

- `kind`：`permission` / `question`。
- `ask_id` 由 worker 生成，必须全局唯一（至少在同一 worker 生命周期内唯一）。
- 宿主在气泡里显示确认按钮，用户回答时原样回传 `ask_id`。
- 允许多个 `ask` 先后挂起，但同一时刻默认只有一个待回答的 `ask`；若未来支持并发，宿主用 `ask_id` 区分。

### 5.4 `turn_done`

```json
{
  "type": "turn_done",
  "turn_id": "turn-...",
  "state": "done",
  "reply": "报告已经生成，共 3 个文件。",
  "steps": 12,
  "artifacts": [
    "report.md",
    { "name": "chart.png", "kind": "image", "title": "月度趋势" },
    { "name": "https://example.com/source", "kind": "link", "title": "数据来源" }
  ]
}
```

- `state`：`done` / `aborted` / `error` / `waiting_user`。
- `waiting_user` 表示挂起等待 `answer`，**不是终态**；回答后继续产生 `event`，最终再发一条真正的终态 `turn_done`。
- `reply` 是本轮最终答复正文；宿主写进气泡，不能只显示「完成 · N 步」。
- `artifacts` 的兼容契约见第 6 节。

### 5.5 `error`

```json
{
  "type": "error",
  "turn_id": "turn-...",
  "code": "engine_unreachable",
  "message": "引擎端点不可达：http://127.0.0.1:8080/v1",
  "fatal": false
}
```

- `fatal = true` 表示 worker 无法继续服务，宿主应回收进程。
- 非致命错误仍应尽量发 `turn_done`（`state = error`），避免界面停在「输出中」。

## 6. `artifacts` 契约

宿主接收两代载荷：

```json
["report.md", "chart.png"]
```

```json
[
  { "name": "report.md", "kind": "file", "title": "调研报告" },
  { "name": "chart.png", "kind": "image", "title": "月度趋势" },
  { "name": "https://example.com/source", "kind": "link", "title": "数据来源" }
]
```

规则：

- 旧 `string[]`：元素是**文件名**（不是绝对路径）。宿主按扩展名推断 `image` / `file`。
- 新对象：`name` 必填；`kind` 可选，缺省按扩展名推断 `image` / `file`。
- `link` 与 `mindmap` **必须显式声明**，不靠扩展名猜。
- `link.name`（或对象里的 `url`）必须是 `http` / `https`；其他协议直接丢弃。
- 宿主在拾一沙箱内按文件名递归解析（深度 ≤ 6、条目 ≤ 5000），重名取最新修改并标记。
- 解析结果附带文件头嗅探：`magic` 是真实格式（png / jpeg / pdf / zip / cfb …），`magicOk` 表示它与扩展名是否一致。PNG / JPEG / PDF / ZIP 容器（docx、xlsx、pptx、odt）等都会校验。
- 消息里只存相对路径、大小、mtime、标题等元数据；**绝不存 base64**。
- 图片、PDF、文本由前端按需调用宿主读取；读取路径必须 canonicalize 后仍位于沙箱子树内。PDF 读取前同样校验 `%PDF-` 文件头，不符直接拒绝。
- 产物门（前端 `artifactGate.ts`）只在任务类型白名单内生效，并要求出现明确产出动作或文件名；它按「存在 → 扩展名 → 非空 → 文件头」顺序校验，失败时把本轮标为未交付并给出中文原因。
- `pdf` 预览走内嵌 iframe；思维导图识别 `.mmd` / `.mermaid` / `.mindmap` / `.mindmap.json`，支持 mermaid `mindmap`、嵌套 JSON 和 Markdown 标题/列表三种来源，解析成树后用纯 CSS 渲染，不引入 mermaid / 图形库。

## 7. 错误与重试

| code | 触发条件 | 宿主处理 |
| --- | --- | --- |
| `invalid_ask_id` | `answer.ask_id` 缺失或不匹配 | 提示用户重新回答，不推进轮次 |
| `turn_finished` | 对已结束轮次发 `answer` / `cancel` | 忽略并清理挂起 UI |
| `engine_unreachable` | 引擎端点不可达 | 气泡显示错误，保留任务文本可重试 |
| `sandbox_denied` | 工具试图越过沙箱 | 拒绝执行，步骤流标红 |
| `worker_crashed` | 进程退出 / stdout 关闭 | 宿主回收进程，界面标「已中止」 |

超时建议：

- `ping` 5 秒无 `pong` → 标记 worker 失联；
- `run` 后 60 秒无任何 `event` → 显示「内核无响应」，允许取消；
- `ask` 挂起不设硬超时，由用户回答或 `cancel` 结束。

## 8. 与现有 HTTP / SSE 的映射

| 现有 | 阶段 3 |
| --- | --- |
| `POST /task` | `run` |
| `GET /events?turn=` (SSE) | `event` 行 |
| `POST /answer` | `answer`（新增 `ask_id`） |
| `POST /cancel` | `cancel` |
| `GET /health` | `ready` / `ping` |
| `turn_done.artifacts: string[]` | 兼容旧数组，新增对象数组 |

前端传输层替换点：`app/src/lib/ipc/shiyi.ts` 的 `shiyiSubscribeEvents`（`EventSource`）改为订阅 Tauri 事件；业务层接口形状尽量保持不变，减少 ChatPage 改动。

## 9. 安全边界

- 协议消息不是可信输入：worker 产出的路径、URL、文件名都要在宿主侧重新校验。
- 文件读取走独立命令（`shiyi_read_artifact`），**不复用**聊天附件的白名单；附件白名单覆盖桌面 / 文档 / 下载，产物路径来自模型输出，必须单独收口到沙箱。
- `link` 只允许 `http` / `https`，由 `open_external_url` 二次校验。
- worker 执行模型生成的代码时，权限三档、沙箱与 Job Object 回收仍由宿主兜底；协议不替代这些边界。
