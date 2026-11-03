# Agent LLM（拾壹）

Windows 本地大模型启动器。Tauri 2 + React 19 前端，Rust 后端，围绕 llama.cpp 的 `llama-server` 提供「内核管理 → 模型扫描 → 参数加载 → 对话 → 对外 API」的完整链路。

版本号 **0.5.0**（`package.json` 与 `tauri.conf.json` 同步）· [更新日志](CHANGELOG.md) · [Releases](https://github.com/xiaojiu131619-max/saya_LLM/releases/latest)

> 0.5.0 主线：Pi 内核接入 Chat、全局 Pi runtime、最小产物门、Pi 在线安装/升级/回滚、宿主工具代理与权限三档、技能路由对齐完整雷达、Pi 长期记忆与浮窗、无限画布 × Pi 联动（状态/工作流只读 + 生图/图生图，画布包 v0.24.7）。

---

## 1. 项目用途

把一个 `.gguf` 文件变成可对话、可被局域网调用的本地推理服务，中间那些麻烦事（下载哪个内核、显存够不够、参数怎么填、进程怎么回收）由应用代管。

它解决的具体问题：

| 场景 | 应用里的对应能力 |
| --- | --- |
| 下载 llama.cpp 到底选 CUDA、Vulkan 还是 ROCm | 设置 → 核心更新：按本机后端自动匹配发布包，SHA256 校验 + `--version` 双验证，只保留最近两个内核目录 |
| 显存不够，不知道该把 ngl 调到几 | 显存估算（按 GGUF 真实张量分布算）+ 加载后实测校准，真实启动的逐档自动调参（ngl / ctx / KV / ncmoe） |
| 一堆模型文件分不清谁是谁 | 目录扫描识别分片、`mmproj` 多模态投影器、MTP / DSpark / DFlash 侧车文件，磁贴式卡片展示能力标签 |
| 想给局域网其他设备用 | API 服务：一键开放 OpenAI / Anthropic 兼容接口，Bearer Token 鉴权，实时指标 |
| 想让本地模型跑智能体任务 | Agent 页：配置 Pi 内核，Chat 的 Pi 工作区用本地模型连续执行任务并记录产物 |

除主模型（`llama-server`）外，还托管两条引擎后端：**NiNfer**（`fast27b` 页）与 **Strata**（智慧模型）。三者共享显存，应用内做了硬互斥——启动任一个前先停掉另外两个。

界面分三个工作区：**模型**、**对话**、**设置**。API 服务、Agent、NiNfer、Strata、llama 日志都不是独立窗口，而是切换在模型工作区里的子视图。

技术栈：Tauri 2.11 / React 19 / TypeScript 5.9 / Vite 7 / Tailwind 3 / Rust（MSRV 1.77.2）。

---

## 2. 安装步骤

### 2.1 环境要求

| 依赖 | 版本 | 用途 |
| --- | --- | --- |
| Windows | 10 / 11 | 唯一验证过的平台 |
| Node.js | 20+ | Vite 与 npm 脚本 |
| Rust | stable（MSRV 1.77.2） | Tauri 后端编译 |
| Microsoft C++ Build Tools | 含 `cl.exe` 与 Windows SDK | Rust 链接 |
| Edge WebView2 Runtime | 最新 | Tauri 窗口引擎 |
| 显卡驱动 | NVIDIA → CUDA；AMD / Intel → Vulkan；AMD 在 ROCm 支持列表内的卡可另选 ROCm | GPU 推理（可选，可纯 CPU 跑） |

Tauri CLI 不需要全局装，`npm` 脚本走 `@tauri-apps/cli`。

### 2.2 直接用打包好的版本（不构建）

从 [Releases](https://github.com/xiaojiu131619-max/saya_LLM/releases/latest) 下载 `Agent_LLM_Portable_v<版本>.zip`，解压后运行 `agent-llm.exe`。

包内只有应用与启动脚本，没有 `llama-server.exe`、DLL 和模型——首次启动后仍要按 3.3 走一遍：下内核、加模型目录。

### 2.3 从源码构建

```powershell
git clone https://github.com/xiaojiu131619-max/saya_LLM.git
cd saya_LLM/app
npm install
npm run desktop:build
```

产物：`app/src-tauri/target/release/agent-llm.exe`。

首次编译 `cargo` 会比较慢，属正常现象。清磁盘时注意区分：`target/debug/` 是增量编译缓存，删了只影响下次编译速度；`target/release/` 里是可直接运行的产物，别连它一起删。

### 2.4 自己打包便携版（可选）

```powershell
cd app
npm run portable:zip
```

产物：`app/dist-portable/Agent_LLM_Portable_v0.5.0.zip`（版本号取自 `package.json`）。脚本会校验包内不含 llama.cpp 运行时文件。

### 2.5 仓库里**没有**的东西

以下内容不随仓库或便携包分发，需要单独获取：

- `.gguf` 模型文件 —— 推荐 [魔搭 ModelScope](https://www.modelscope.cn/) 搜 `GGUF` 量化版
- `llama-server.exe` 与配套 DLL —— 走应用内「设置 → 核心更新」下载，或自编译后在 `config.json` 里填 `kernel_override_path`（见 5.2）

---

## 3. 运行方式

### 3.1 命令行

在 `app/` 目录下：

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 仅前端，浏览器访问 `http://127.0.0.1:3000`，**没有推理后端**，按钮会提示「请在桌面版中…」 |
| `npm run desktop` | Tauri 桌面开发模式，前端热重载 |
| `npm run desktop:build` | 生产构建，产出 `src-tauri/target/release/agent-llm.exe` |
| `npm run build` | 类型检查 + 前端构建（不打包桌面） |
| `npm run lint` | ESLint |
| `npm test` | 回归测试，扫描 `app/scripts/*.test.mjs` 后交给 `node --test` 执行 |
| `npm run tauri` | 直接透传 Tauri CLI |

Rust 侧检查：

```powershell
cd app/src-tauri
cargo check
```

### 3.2 双击脚本

`scripts/` 下有两个和应用有关的批处理，区别只在**跑哪一版**（脚本用 `%~dp0..\app` 定位项目，可整体移动目录）：

| 脚本 | 跑什么 | 什么时候用 |
| --- | --- | --- |
| [`scripts/dev-mode.bat`](scripts/dev-mode.bat) | `npm run desktop`，调试版（`target\debug`），前端热重载 | **日常开发**：改代码即生效，不产出 exe |
| [`scripts/start-agent-llm.bat`](scripts/start-agent-llm.bat) | 正式版（`target\release\agent-llm.exe`）；找不到才检查 Node/Cargo、装依赖、构建 | 只是打开应用，或要验证打包后的行为 |

开发期不需要每次 `desktop:build`：dev 模式改前端即时刷新，改 Rust 由 Tauri 自己增量编译并重启。只有要交给别人、或验证 release 独有行为（安装包、资源目录布局）时才跑一次正式构建。

### 3.3 首次启动流程

1. 应用会自动跑一次环境检测（llama.cpp 内核 / VC++ 运行库 / 显卡驱动 / ffmpeg / 数据目录可写），未通过项给出中文安装引导
2. 进 **设置 → 核心更新**，按下表选线路下载内核

   | 本机显卡 | 内核线路 |
   | --- | --- |
   | NVIDIA | CUDA |
   | AMD / Intel | Vulkan（默认推荐） |
   | AMD（RX 6000 / 7000 / 9000 等 ROCm 支持列表内的卡） | 追加 ROCm 候选，排位仍在 Vulkan 之后 |
   | 无可用 GPU | CPU |

3. 进 **设置 → 数据管理**，添加包含 `.gguf` 的模型目录
4. 模型页选模型 → 加载 → 对话

---

## 4. 使用示例

### 4.1 从命令行验证 API

在 **模型工作区 → 左侧栏「服务状态」→ 对外 API 分区** 打开「释放 OpenAI / Anthropic 兼容 API」后，局域网内任意设备可调用：

```powershell
curl.exe http://<本机局域网IP>:<端口>/v1/chat/completions `
  -H "Content-Type: application/json" `
  -H "Authorization: Bearer <API Key>" `
  --data-raw '{"model": "<模型调用名>", "messages": [{"role": "user", "content": "你好"}], "stream": false}'
```

要点：

- 监听地址、端口、模型调用名以服务状态页当前显示为准
- 仅监听 `127.0.0.1` 时不需要鉴权；放开局域网监听后应在该页生成 API Key
- `llama-server` 是无状态的，每次请求需携带完整对话历史
- `parallel > 1` 时上下文容量按并发数均分，ctx 会显得「变小」

### 4.2 用脚本拉起 27B 调优预设

针对 RTX 3080 Ti 12GB 实测定案的 Swift-1.5-Qwen3.8-27B（64K 上下文 + 视觉投影器放 CPU + kvarn4 KV 量化，端口 8080）：

```powershell
scripts\start-swift27b-64k.bat    # 启动
scripts\stop-swift27b.bat         # 停止
```

调优依据与 A/B 数据见 [docs/guides/SWIFT27B_TUNING.md](docs/guides/SWIFT27B_TUNING.md)。脚本里是 `-ctk kvarn4 -ctv kvarn4 --kv-tail-tokens 1024`，不是文档早期版本的 k8v6（`q8_0/q6_0`）预设——后者在本卡上会让 64K 溢出到系统内存。注意 `stop-swift27b.bat` 会结束本机**全部** `llama-server.exe`，包括应用主模型的进程。

### 4.3 接入智能体（Pi）

模型工作区左侧栏 → **Agent** → 「Pi」标签，填写 Node / Pi CLI（`cli.js`）路径；状态卡显示内核、模型、当前会话与工作区。对话入口在 Chat 的 **Pi 工作区**（侧边栏头像切换），发送时自动启动对应会话。

同一页可管：Node / CLI / Agent 配置目录、工作区根目录、会话目录、引擎端点、权限三档（只读 / 守门 / 放行）、技能库与技能路由、运行日志。

- 技能是独立资产（238 个，约 2.3G），**不进安装包**：首次使用需指定技能库目录；宿主只读取元数据，命中 1–2 个技能时才注入正文
- 数据落在 `%APPDATA%\AgentLLM\pi\`（agent / sessions / work），每个 Chat 会话独立工作区
- 退出应用时回收 Pi 进程树；Pi 内置文件/命令工具被禁用，全部经宿主代理与权限档判定

引擎（主模型 / NiNfer / Strata）没起时，Pi 仍可启动，但发任务会失败——Chat 的 Pi 工作区会直接提示先回首页加载模型。

### 4.4 调用前的连通性自检

服务状态页内置三种探测：`/health`、`/v1/models`、实际响应延迟。加载模型后页面长时间无响应时，先看 `/health` 是否返回 200。

---

## 5. 关键配置说明

### 5.1 配置文件位置

| 内容 | 路径 |
| --- | --- |
| 应用配置 `config.json` | `%APPDATA%\AgentLLM\config.json` |
| 模型运行记录 `model_records.json` | `%APPDATA%\AgentLLM\` |
| 扫描缓存 | `%APPDATA%\AgentLLM\cache\` |
| 聊天归档（默认） | `%APPDATA%\AgentLLM\archives\` |
| 引擎数据（Pi / NiNfer / Strata） | `%APPDATA%\AgentLLM\pi`（agent / sessions / work）、`fast27b`、`strata`；旧版 dsh 遗留的 `dsh-home` 可删 |
| llama.cpp 内核（默认） | 应用资源目录 `resources/kernels/` |
| 对外 API Key | Windows 凭据管理器（服务名 `Agent LLM External API`） |

API Key 不再明文落盘；旧版回退文件 `%APPDATA%\AgentLLM\api_key` 在凭据写入成功后会被删除，只有凭据管理器读不到时才回退到它。

### 5.2 `config.json` 主要字段

| 字段 | 含义 | 默认 |
| --- | --- | --- |
| `model_dirs` | 模型扫描目录列表 | 空 |
| `llama_server_path` | 内核可执行文件路径 | `resources/llama-server.exe` |
| `default_port` | 对话 / VLM 服务端口 | `8080` |
| `embedding_port` | 向量 / 重排模型的独立端口 | `8081` |
| `api_enabled` / `api_host` / `api_key` | 对外 API 开关、监听地址、鉴权 | 关 / 本机 |
| `proxy_url` | HTTP(S) 代理，如 `http://127.0.0.1:7890` | 空 |
| `kernel_override_path` | 自编译 `llama-server.exe` 绝对路径，设置后优先使用 | 空 |
| `engine_dir` / `log_dir` / `archive_dir` | 引擎、日志、归档目录 | 见 5.1 |
| `model_presets` | 每模型独立参数记忆 | — |
| `tune_history` | 自动调参历史记录 | — |
| `mcp_servers` | MCP 服务器列表（stdio / http / sse） | 空 |
| `dsh` / `fast27b` / `strata` | 各引擎后端的接入配置（`dsh` 为旧版遗留字段） | — |
| `theme` / `close_to_tray` / `auto_scan_on_startup` | 界面与启动行为 | — |

### 5.3 推理参数默认值

`ServerConfig` 的默认值就是**排障基线**，应用不会静默改动用户的设置：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `host` / `port` | `127.0.0.1` / `8080` | 服务监听 |
| `ngl`（GPU 卸载） | `0` | 按显存手动调，或用自动调参搜索 |
| `n_ctx`（上下文） | `32768` | 越大越吃显存 |
| `batch_size` / `ubatch_size` | `512` / `512` | 批处理 |
| `threads` / `parallel` | `-1` / `-1` | `-1` 表示交给内核决定 |
| `flash_attn` | `true` | KV 量化只在 FA 路径生效 |
| `kv_offload` / `kv_unified` | `true` / `true` | KV 放显存、统一缓存 |
| `cache_type_k` / `cache_type_v` | `f16` / `f16` | 可换 `q8_0`、`q6_0`、`kvarn4` 等降显存 |
| `mmap` / `mlock` | `true` / `false` | 内存映射 / 锁定 |
| `ncmoe` | `0` | MoE 的 CPU 卸载层数 |
| `device` / `main_gpu` | 空 / `0` | 按内核 `--list-devices` 实际输出选，如 `CUDA0`、`Vulkan0` |
| `reasoning_budget` | `0` | 思考模式的 token 预算 |

`device` 不要凭设备名猜：Vulkan 内核上指定 `CUDA0` 必然报 `invalid device`。

### 5.4 目录约定

```text
Agent_LLM/
├── app/
│   ├── src/                React 前端
│   │   ├── pages/          页面：对话、模型加载、设置、核心更新、使用统计、数据管理、工具、Skills、Agent、NiNfer、Strata
│   │   ├── features/       工作区组件：chat / model / settings / apiStatus / embedding / fast27b / strata / workspace
│   │   ├── components/     通用组件（模型卡、气泡、Markdown 渲染、品牌字标）
│   │   ├── lib/            Tauri 封装与工具（desktop.ts、显存估算与实测校准、媒体适配）
│   │   └── context/        全局状态
│   ├── src-tauri/
│   │   ├── src/commands/   Tauri 命令（model / server / updater / config / pi_agent / dsh / strata / mcp / hardware…）
│   │   ├── src/services/   进程管理、GGUF 解析、模型扫描、内核更新、显卡监测、引擎管理
│   │   └── src/models/     配置与数据结构
│   ├── scripts/            回归测试（*.test.mjs）与打包脚本
│   └── resources/          运行时资源（内核由应用内下载，不进仓库）
├── scripts/                独立脚本：开发模式 / 一键启动、27B 启动停止、webui 资产打包
├── docs/                   指南、计划、报告、归档（见 docs/README.md）
├── *.md                    根目录只放文档：README / LICENSE / CHANGELOG / CONTRIBUTING / AGENTS
└── .github/ .gitignore .gitattributes .editorconfig .workbuddy/   工具与 CI 配置
```

---

## 6. 常见问题

**Q：提示找不到 `llama-server.exe`？**
内核还没下载，或内核目录被清理了。进「设置 → 核心更新」按显卡线路重新下载，看 SHA256 与 `--version` 校验是否通过。

**Q：加载模型后报 `CUDA error` / `invalid device: CUDA0`？**
内核后端与本机显卡不匹配。NVIDIA 用 CUDA 内核，AMD / Intel 用 Vulkan 内核，别在 Vulkan 内核上指定 `CUDA0`。AMD 的 ROCm/HIP 包只覆盖 ROCm 支持列表内的卡，普通 Radeon 与核显必须用 Vulkan，装不上也不该硬换。用环境检测确认后端。

**Q：OOM 或显存贴边之后速度骤降（无报错）？**
先降 `ngl` 或 `n_ctx`；再考虑把 `cache_type_k/v` 换成量化档（需 `flash_attn` 开启）。显存贴边会触发 NVIDIA 驱动的系统内存回退，表现为静默掉速——把「NVIDIA App → CUDA 系统内存回退策略」设为「首选无回退」，让问题变成明确的 OOM 更容易发现。

**Q：`npm run desktop` 报 `failed to bundle project`？**
多半没装 WebView2 Runtime。

**Q：Tauri 窗口白屏？**
前端没构建，或 `tauri.conf.json` 的 `devUrl`（`http://127.0.0.1:3000`）与 Vite `server.port = 3000` 不一致。

**Q：`link.exe not found`？**
装 Visual Studio Build Tools 的「使用 C++ 的桌面开发」工作负载，确认 `cl.exe` 在 PATH 里。

**Q：GPU 监测显示未连接？**
NVIDIA 走 NVML，检查驱动；AMD / Intel 走 DXGI + PDH 回退读取独显显存与利用率，检查显卡驱动与 Vulkan。

**Q：端口被占用？**
停掉占用 `8080` 的进程，或在设置里改 `default_port`。

**Q：内核下载失败 / 卡住？**
检查防火墙与 GitHub 可达性；国内网络在设置里填 `proxy_url`，或用镜像加速。下载可随时取消，失败不会破坏现有内核。注意应用的核心更新请求默认不走系统代理，必须显式配置 `proxy_url`。

**Q：主模型、NiNfer、Strata 能同时开吗？**
不能，也不需要。三者显存互斥，应用内有硬闸门：启动任一个前先停另外两个，停不下来就放弃启动并报错。对话后端按「谁在跑」自动切换。

**Q：浏览器里跑 `npm run dev`，所有按钮都提示「请在桌面版中…」？**
这是预期行为。纯前端模式没有 Tauri 注入，也没有推理后端。

---

## 7. 已知限制

- **仅 Windows 10/11 验证**。代码里有 `windows_subsystem = "windows"`、`creation_flags(0x08000000)` 隐藏子进程窗口、Windows 专属显存读取等实现；其他平台理论上能跑 Tauri，但不在支持范围。
- **仓库与便携包不含模型、不含 llama.cpp 预编译二进制**。没有内核时应用无法加载任何模型。
- **`npm run eval:v4.2` 当前不可用**。该脚本指向 `app/scripts/eval-v4.2.mjs`，但这个文件不在仓库中，执行会失败。
- **三条推理后端不能并行**。显存互斥导致的硬限制，同时起会互相抢显存、双双掉速甚至 OOM。
- **`scripts/stop-swift27b.bat` 的作用域是整个机器**：它会结束所有 `llama-server.exe` 进程，包括你正在用的主模型。
- **Pi 是常驻 Node 子进程**：它跑在宿主拉起的 `pi --mode rpc` 里，关掉应用时进程树会被整体回收。技能库需单独指定；宿主只注入命中的 1–2 个技能正文，缺失时任务质量会下降。
- **Pi 的命令执行不是 OS 级沙箱**：文件路径限制在会话工作区，命令按权限三档判定，但 `full` 档仍以当前用户权限执行；强隔离需要容器/VM。
- **旧版 dsh（DeepSeek Harness）入口已从 Agent 页移除**，相关代码与配置字段暂时保留在仓库中，不再出现在界面上。
- **大 MoE 模型在消费级显存上需要 `ncmoe` 卸载**，速度会明显低于全显存方案，这是权重搬运开销而非配置错误。
- **长上下文质量没有官方背书**。以 27B 预设为例，其模型卡的 KLD 评测只覆盖 512 token；长上下文出现异常输出时先降 `-c` 复验。
- **`mmproj` 必须与模型架构严格匹配**，同名系列的不同仓库可能是不兼容的投影器（如 27B 与 Flash-Next）。
- **会话历史存在前端 localStorage（配额 5–10 MB）**。图片 / 音频 / 视频的 data URL 在写入前会被剥离，重开旧会话只剩文字与「N 个附件」的说明；配额写满后写入是静默失败的，界面不会提示，需要手动删会话或先导出归档。
- **界面与文档以中文为第一语言**，暂无国际化实现。

---

## 相关文档

- [docs/README.md](docs/README.md) —— 文档索引
- [docs/guides/DEVELOPMENT_GUIDE.md](docs/guides/DEVELOPMENT_GUIDE.md) —— 开发、构建、调试与故障排查
- [docs/guides/TECHNICAL_REPORT.md](docs/guides/TECHNICAL_REPORT.md) —— 架构、数据流与模块清单
- [docs/guides/SWIFT27B_TUNING.md](docs/guides/SWIFT27B_TUNING.md) —— 27B 调优依据与已知坑
- [CONTRIBUTING.md](CONTRIBUTING.md) —— 仓库约定与提交流程
- [AGENTS.md](AGENTS.md) —— 本项目的中文文案与参数基线规则

## License

[MIT](LICENSE)
