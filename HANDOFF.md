# Agent_LLM 交接文档

> ⚠️ **本文件是 2026-11-02 09:35 的旧版（对应「M1：Chat 内嵌拾一助手」阶段）。**
> **最新交接文档：`D:\Projects\shyi-ai\HANDOVER-2026-11-02.md`**
> 架构已升到 v3（拾一作为 Chat 里的 Agent 模式）；本轮修了 9 个界面级缺陷、界面拆成三棵独立树；
> **阶段 1（产物渲染）/ 2（ChatScope 分流）/ 3（Python worker 接宿主）三个都还没开工**——新窗口请先读那份新文档。
> 本文件以下内容仅作历史背景保留。

> 更新：2026-11-02 09:35 · 交接人：晓玖 & AI 助手
> 用途：任何人（包括未来的自己/新的 AI 会话）接手本项目时，5 分钟看懂现状、10 分钟跑起验证。

---

## 一、一句话现状

**M1（Chat 内嵌拾一助手）功能已全部写完并真机验证 95%**，唯一未闭环的是「挂起后点击『允许继续』按钮 → resume」的 UI 层验证；拾一内核层的 resume 链路已用脚本绕过 UI 验证通过。两仓改动**均未 git commit**。

## 二、产品大方向（用户已定调，不要跑偏）

从「模型管理与调参启动」转向**本地个人助手**：

- **引擎三档**：llama（兜底）、strata（智慧）、ninfer（快速）
- **拾一 = 个人助手**，三种形态：
  1. Agent 控制台（已有，AgentPage）
  2. 浮窗（M2，未开工）
  3. Chat 内嵌连续对话 + 操控工作区文件（M1，本次已做）
- **功能区块划分**：本地模型启动 / agent 模型操控
- 其他方向：满载协作模式（模型吃满资源、客户端极简）、内核/引擎按需下载

## 三、M1 完成情况（含验证证据）

### 已验证 ✓

| 项 | 证据 |
|---|---|
| 助手档切换（页头「后端」徽章可点击） | 截图 chatA/chatC 系列 |
| 任务发送 → 拾一识别为 doc 任务 | `POST /task` 返回 `task: "doc"` |
| SSE 步骤流渲染（步骤面板、着色、折叠） | 截图 + 事件流 |
| write 工具真实执行 | 沙盒 `hello.txt` 内容正确 |
| overwrite 触发 ask 挂起 | `verdict:ask → gate:permission_suspend → turn_done{state:waiting_user}` |
| UI 挂起态呈现（确认按钮） | chatC6.png：按钮在原图 (402,465) |
| **拾一内核 answer→resume 链路（层A）** | `/answer yes → {resumed:true}`，假引擎收到请求 #2/#3/#4 |

### 未闭环 ✗（唯一）

**层B：UI 点击「允许继续」→ 前端 onAnswer → invoke → POST /answer → resume**。
像素级鼠标点击命中了按钮坐标但 resume 未发生，根因未查明（点击未触发 onClick / invoke 失败被吞）。

**续做方式（脚本已备好，一条命令）**：

```bash
C:/Users/sky/AppData/Local/Programs/Python/Python312/python.exe D:/tmp/layerB_ui_test.py
```

- 脚本逻辑：启动假引擎+应用（WebView2 开 CDP 9223）→ 等 8720 就绪 → CDP 进 Chat 页 → 用 title 定位「后端」徽章切到拾一档 → DOM 注入覆盖任务并发送 → 轮询等新轮次 waiting_user → **DOM 层 click「允许继续」**（比像素点击可靠）→ 验证轮次离开挂起 + 假引擎日志出现「请求 #2」→ 三张截图存 `D:\tmp\layerB_*.png`。
- 退出码 0 = 通过。注意**必须整条命令跑完**（见踩坑 #1）。
- 2026-11-02 09:32 跑过一次但被会话中断（无截图、进程已回收），需重跑。

### 已知非缺陷（不要当 bug 修）

- 假引擎 finish 被收尾门拒 ×3 → force_finish aborted：doc 任务要求 .docx/.md/.pdf 正式产物，txt 是中间件。真模型会写正式产物，行为合理。
- 层A测试中文件未被覆盖：假引擎 resume 后输出的是 finish（非重放 write），属剧本局限。

## 四、关键代码改动（两仓，均未 commit）

### Agent_LLM（主仓）

- `app/src/pages/ChatPage.tsx`：核心集成——shiyiStatus 3s 轮询、`handleShiyiSend`（SSE 步骤流）、`handleShiyiAnswer`、停止按钮拾一分支、页头「后端」徽章切换器（hidden sm:inline-flex，文本「后端 {主模型|NiNfer|Strata|拾一助手}」，title 含「点击切换到拾一助手」）
- `app/src/components/ChatBubble.tsx`：`ShiyiStepsPanel`（tone 着色、waiting 时渲染允许/拒绝按钮）
- `app/src/lib/ipc/shiyi.ts`：`shiyiRunTask/shiyiAnswer/shiyiCancel/shiyiSubscribeEvents`（EventSource）、`describeShiyiEvent`
- `app/src/types/index.ts`：`ChatEngineId + 'shiyi'`、`Message.shiyiSteps/shiyiTurnId/shiyiState`、`ShiyiStep`
- `app/src/context/AppContext.tsx`：UPDATE_MESSAGE 支持拾一字段
- `app/src/hooks/useAutoChatEngine.ts`：`shiyi` 档手动不被自动覆盖
- `app/src-tauri/src/services/shiyi_manager.rs`：**代理修复**——spawn 无条件 `NO_PROXY=127.0.0.1,localhost,::1`，无代理时显式清空 HTTP_PROXY 等
- `scripts/dev-mode.bat` / `start-agent-llm.bat`：分工注释（**开发走 `npm run desktop`，不用每次构建 exe**）
- `README.md`：dsh→拾一文档债清理

### shyi-ai（拾一仓）

无代码改动（本轮只改了测试脚本，放在 D:\tmp）。

## 五、踩坑清单（干活费劲的根源，接手必读）

### 环境坑

1. **后台进程活不过启动它的 bash 命令**。bash 命令一结束，其启动的所有进程被回收。→ 所有涉及真实进程的验证必须**压缩进单条命令**（脚本内部 Popen 全家桶 + finally kill）。
2. **环境有 HTTP_PROXY=127.0.0.1:59629**（WorkBuddy 代理）。会劫持拾一→引擎的回环连接，SSE 被重置、任务卡在模型调用。→ 已在 `shiyi_manager.rs` spawn 时修；手动启动拾一也要带 `NO_PROXY` + 清空代理变量。
3. **PowerShell Start-Process 启动应用即死**（工作目录不对）。→ 用 bash 在 release 目录启动，或脚本内 Popen 带 `cwd=os.path.dirname(EXE)`。
4. **Python 双版本**：`python` = WorkBuddy 自带 3.13.12（无第三方库）；`C:/Users/sky/AppData/Local/Programs/Python/Python312/python.exe` 有 websocket-client 1.9.2。CDP 脚本必须用后者。

### 技术坑

5. **假引擎绝不能读请求 body**：hook 里读 body 后，原 handler 再读 HTTP/1.1 socket 会阻塞卡死整个 handler，任务永远停在 before_model_call。→ 按请求计数选剧本，不读 body（见 `fake_engine_live.py` 注释）。
6. **CDP WebSocket 握手 403**：WebView2 需 `--remote-debugging-port=9223 --remote-allow-origins=*`（两个参数缺一不可）。
7. **`is_shiyi_running()` 只认 app 自己 spawn 的子进程**。外部手动启动的拾一（哪怕 8720 健在）app 不认。→ 要让 UI 完整工作，必须让 app 自己拉拾一（Agent 页点启动；本次实测 app 启动后拾一自己起来了，来源待查）。
8. **像素级鼠标点击不可靠**：坐标吻合但 onClick 未触发过一次。→ 一律改用 CDP `Runtime.evaluate` 在 DOM 层 `.click()`，并用 React 原生 setter 注入受控输入框的值。
9. **权限三档语义**：plan = 写操作直接 **deny**（不是 ask！）；auto = 新文件 allow、覆盖/删除/越界 **ask**；full = 全放行。测试挂起用 auto + 已存在的文件。
10. **剪贴板 64 位句柄截断**：ctypes 调 kernel32.GlobalAlloc 必须 `restype = c_void_p`，否则 access violation。
11. **窗口消失≠崩溃**：进程被环境回收后窗口自然没了，重验前先 `tasklist` 查进程。

## 六、测试工具箱（D:\tmp）

| 文件 | 用途 |
|---|---|
| `fake_engine_live.py` | 两段式假引擎 :8099。请求1→write 动作，≥2→finish。复用 `shyi-ai/shiyi/kernel/fake_openai._Handler` |
| `layerA_resume_test.py` | 层A：纯 curl 层验证拾一内核 answer→resume（**已通过**）。自起假引擎+拾一，最后自 kill |
| `layerB_ui_test.py` | 层B：CDP 全链路 UI 验证（**待跑**，见第三节命令） |
| `fakeA.log / shiyiA.log / fakeB2.log / appB2.log` | 最近运行的日志残留 |

## 七、启动手册

### 拾一手动启动（与 app spawn 等价）

```bash
SHIYI_STATE="C:/Users/sky/AppData/Roaming/AgentLLM/shiyi/state" \
SHIYI_SANDBOX="C:/Users/sky/AppData/Roaming/AgentLLM/shiyi/sandbox" \
SHIYI_LOG="C:/Users/sky/AppData/Roaming/AgentLLM/shiyi/logs/kernel.log" \
SHIYI_SKILLS="D:/Projects/shyi-ai/data/skills" \
SHIYI_BASE_URL="http://127.0.0.1:8099/v1" SHIYI_MODEL="fake-model" \
HTTP_PROXY= HTTPS_PROXY= http_proxy= https_proxy= \
NO_PROXY="127.0.0.1,localhost,::1" \
"D:/Projects/shyi-ai/dist-sidecar/shiyi/shiyi.exe" --port 8720
```

注意：`shiyi/state/config.json` 已持久化 `base_url=8099`（external source），不设 env 也会读它。

### 拾一 API

- `POST /task {text, perm}` → `{turn_id, task, events}`
- `GET /events?turn=<id>` SSE；`GET /status` 全轮次
- `POST /answer {turn_id, reply}`；`POST /cancel {turn_id}`；`GET /health`
- 挂起态：`turn_done {state: waiting_user}`，SSE 不关闭（非终态）

### 应用（真机验证态）

exe：`D:/Projects/Agent_LLM/app/src-tauri/target/release/agent-llm.exe`，`cwd` 必须是 exe 所在目录。
CDP 模式：env `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 --remote-allow-origins=*`，然后 `http://127.0.0.1:9223/json` 拿 page 的 webSocketDebuggerUrl。

### 日常开发

`npm run desktop`（dev 模式，热重载）。**不要**为验证而构建 release。

## 八、后续路线图

1. **M1 收尾**：跑层B脚本闭环 UI 确认链路 → 两仓 git commit → 更新 README
2. **M2**：拾一浮窗形态
3. **M3**：引擎分层调度（llama 兜底 / strata 智慧 / ninfer 快速）
4. 满载协作模式（客户端瘦身，给模型让资源）
5. 内核/引擎按需下载

## 九、验证通过标准（M1 完成定义）

层B脚本退出码 0（轮次离开挂起 + 假引擎收到请求 #2 + 三张截图），即视为 M1 端到端全通，可以 commit 收官。
