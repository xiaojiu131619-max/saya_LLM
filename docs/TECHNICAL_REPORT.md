# Agent LLM 技术报告

> 范围：`D:\Projects\Agent_LLM` 当前可运行版本 `v0.3.1`（Tauri 桌面端 + 浏览器预览）。本文以实际代码为准；早期原型设想保留在同级 `tech-spec.md`，未来 ComfyUI 方案见 `COMFY_IMAGE_WORKSPACE_PLAN.md`。

## 1. 项目定位

Agent LLM 是面向 Windows 的本地 GGUF 模型启动器。它把内核管理、模型扫描、参数化加载、流式对话和 OpenAI / Anthropic 兼容 API 集成在一个 Tauri 应用中：

1. 扫描本地 `.gguf` 文件，解析架构、量化、分片和多模态能力并缓存元数据。
2. 通过应用内核心更新下载匹配本机的 llama.cpp 内核，启动 `llama-server` 推理服务。
3. 通过本地 HTTP 服务流式对话，持久化多模型会话、运行记录和用量统计。

当前 GPU 路线为 NVIDIA CUDA、AMD/Intel Vulkan；没有可用 GPU 时使用 CPU。仓库和便携包均不内置第三方 llama.cpp 二进制。

## 2. 技术栈

### 2.1 前端（`app/`）

| 层 | 选型 | 备注 |
| --- | --- | --- |
| 框架 | React 19.2 + TypeScript 5.9 | 函数组件、Hooks、`useReducer` |
| 构建 | Vite 7.2 | `@` 别名指向 `src/` |
| 样式 | Tailwind CSS 3.4 + 自定义 CSS | Win11 Fluent token、深浅色和系统强调色 |
| 动效 | framer-motion 12 | 工作区、列表和面板过渡 |
| 图标 | lucide-react、`@lobehub/icons` | 通用图标与模型品牌图标 |
| 图表 | recharts 2.15 | 用量和状态数据 |
| 文本 | highlight.js + 自定义 Markdown 解析 | `MarkdownRenderer` 使用 `useMemo`，代码块使用 `memo` |
| 虚拟列表 | `@tanstack/react-virtual` | 长聊天消息列表 |
| 持久化 | `window.localStorage` | UI 状态键为 `agent-llm-local-state-v1` |
| IPC | `@tauri-apps/api` 2.11 + dialog 插件 | 命令调用、事件和文件选择 |

当前没有 `app/src/components/ui/`、Radix UI 全量组件集或 `markdown-it` 依赖。视图不使用 `react-router`，由 `AppContext` 和 `WorkspaceShell` 管理。

### 2.2 后端（`app/src-tauri/`）

| 模块 | 作用 |
| --- | --- |
| `services/process_manager.rs` | 解析设备、构造 llama-server 参数、启动/监控/终止进程、日志与 CPU 回退 |
| `services/model_scanner.rs` | 并行扫描模型目录、缓存 `ModelInfo`、识别分片和侧车文件 |
| `services/gguf_parser.rs` | 手写 GGUF v3 表头解析，读取架构、层数、KV 头、MoE、MTP 和多模态字段 |
| `services/gpu_monitor.rs` | NVIDIA NVML；Windows 无 NVML 时回退 DXGI + PDH |
| `services/memory_monitor.rs` | 系统内存监测 |
| `services/auto_updater.rs` | GitHub Releases 匹配、下载、SHA256 校验、安装、取消和版本保留 |
| `services/benchmark.rs` | 基准测试和自动调参支持 |
| `commands/env_check.rs` | 首次启动环境检测：内核、VC++、GPU/驱动、ffmpeg 和数据目录 |
| `commands/*.rs` | Tauri IPC 入口 |
| `models/*.rs` | 配置、服务参数、模型信息和运行记录数据结构 |

## 3. 内核分发与硬件路线

### 3.1 内核来源

`app/resources/` 只保留说明文件。`tauri.conf.json` 当前没有把 llama.cpp runtime 作为 bundle resource 打包。用户在「设置 → 核心更新」中选择 release，更新器会：

- 根据主机后端匹配 CUDA、Vulkan 或 CPU 包；NVIDIA 还会匹配 CUDA 版本和显卡信息。
- 下载内核及所需运行时，校验 SHA256，并在安装前后检查 `--version`。
- 安装到运行时数据目录的 `resources/kernels/<版本>_<时间>/`。
- 支持 GitHub 镜像、显式 HTTP(S) 代理、取消下载，并保留最近两个版本。
- 兼容旧的平铺目录作为迁移路径，但不应把它当作开发或发布要求。

便携包由 `app/scripts/package-portable.ps1` 单独生成，文件名为 `Agent_LLM_Portable_v<版本>.zip`，只包含 `agent-llm.exe`、启动 bat、说明文件和空的 `_up_/resources` 目录。

### 3.2 GPU 监测和设备选择

- `gpu_monitor.rs` 优先使用 NVIDIA NVML；Windows 上 NVML 不可用时使用 DXGI 读取独显总显存，并使用 PDH 读取已用显存和利用率。
- `process_manager.rs` 启动前调用 `llama-server --list-devices`，按内核实际输出选择 `CUDA0` 或 `Vulkan0`，不在 Vulkan 内核上硬编码 CUDA 设备。
- CPU 模式传 `--device none --no-op-offload`；GPU 模式只传匹配的设备和适用参数。
- 环境检测会提示“内核后端与本机显卡不匹配”，避免 Vulkan 被误判为 CUDA 失败并静默回退 CPU。

## 4. 顶层架构

```text
┌──────────────────────────────────────────────────────────┐
│ Tauri WebView                                             │
│ React 19 ─ AppContext(useReducer) ─ localStorage          │
│   │ invoke/listen                                          │
│   ├─ ModelWorkspace / ModelLoadPage                        │
│   ├─ ChatPage / ApiStatusPage                              │
│   └─ SettingsWorkspace / KernelUpdatePage / EnvCheckDialog │
└──────────────┬───────────────────────────────────────────┘
               │ Tauri IPC + localhost HTTP/SSE
┌──────────────▼───────────────────────────────────────────┐
│ Rust Backend                                               │
│ commands ─ services ─ models                               │
│   ├─ process_manager ─ llama-server                        │
│   ├─ model_scanner ─ gguf_parser                           │
│   ├─ gpu_monitor ─ NVML 或 DXGI/PDH                       │
│   └─ auto_updater ─ GitHub Releases                         │
└──────────────┬───────────────────────────────────────────┘
               ▼
       llama-server /v1/chat/completions
```

`AppProvider` 在桌面环境 hydration 阶段并行读取配置、服务状态、外部 API key、引擎信息和模型缓存；完整扫描由模型页按需触发。

## 5. 前端结构与状态

### 5.1 目录

```text
app/src/
├── App.tsx, main.tsx, index.css
├── context/AppContext.tsx          # 全局状态、持久化和桌面 hydration
├── types/index.ts                  # 领域类型
├── lib/
│   ├── desktop.ts                  # Tauri 命令封装和流式请求
│   ├── vramEstimate.ts             # 显存解析式
│   ├── vramCalibration.ts          # 基于运行记录的校准
│   ├── vramRecommend.ts            # 推荐参数
│   ├── mediaAdapters.ts            # 音频/视频处理
│   └── llamaTools.ts               # llama-server 原生工具配置
├── hooks/useSystemStats.ts
├── components/                     # ModelCard、ChatBubble、MarkdownRenderer 等
├── features/
│   ├── chat/                       # 聊天侧栏和会话工具
│   ├── model/                      # 模型工作区
│   ├── settings/                   # 设置中心
│   ├── apiStatus/                  # API 状态区
│   └── workspace/                  # 工作区外壳、状态条、环境检测弹窗
└── pages/                          # Chat、ModelLoad、Settings、Kernel、Logs、Usage 等
```

当前不存在 `features/image/`、`ImagePage` 或 ComfyUI 页面；相关内容只在未来计划中。

### 5.2 视图与会话

当前 `ViewType` 包括 `home`、`chat`、`settings`、`tools`、`kernel`、`modelLoad`、`usage`、`apiStatus`、`logs` 和 `llamaLogs`。`WorkspaceShell` 将聊天、模型和设置分别映射到三个工作区；`tools`、`kernel`、`usage`、`logs` 属于设置中心子页，`llamaLogs` 属于模型工作区子页。

所有聊天记录物理上存于 `chat-workspace` 聚合桶，使用会话的 `runtimeModelId` 保存发起对话时的实际模型快照。侧边栏、API 状态和模型工作区读取数据时按当前模型过滤，避免切换模型后 ctx、速度和最近消息串台。

### 5.3 模型加载链路

```text
HomePage 选择模型
  → ModelLoadPage 组装 ModelLoadConfig
  → lib/desktop.ts::buildServerConfig
  → invoke('start_server')
  → process_manager::start_server
      → 解析 llama-server 路径与 --list-devices
      → 清理旧实例
      → spawn_server_process
      → 读取 stdout/stderr 并轮询 /health
  → server:progress / ready / error / stopped
  → ChatPage 通过 SSE 请求 /v1/chat/completions
```

进程管理保留一次 CPU 兼容回退：仅在 warmup、CUDA/Vulkan 设备或 OOM 等适用错误且未关闭回退时，将 `ngl`、ctx、batch 等降到兼容配置重试。`draft-mtp` 模式为规避特定 llama.cpp 版本问题附加 `-fit off`；不存在通用的固定 `--fit on` 启动约定。

## 6. GGUF 解析、显存预测与运行记录

`gguf_parser.rs` 读取 GGUF v3 表头和架构相关 KV，重点字段包括 `block_count`、`context_length`、`embedding_length`、`head_count`、逐层 `head_count_kv`、`key_length`、`value_length`、专家数和 `nextn_predict_layers`。混合架构的 KV 头总数会聚合为 `kvHeadsSum`；Gemma 滑动窗口字段用于区分全注意力和 SWA 层的上下文开销。

扫描器磁盘缓存位于 `%APPDATA%\AgentLLM\cache`，当前 `SCANNER_VERSION = 21`。新增或改变解析字段时必须递增该版本。

`ModelRunRecord` 持久化到 `%APPDATA%\AgentLLM\model_records.json`，记录启动参数、预测显存、实测显存、速度和错误信息。显存校准按模型和参数指纹筛选样本：优先校正计算暂存与运行时经验项，整体比例只作为解析项不可靠时的兜底；KV 和 SWA 继续按解析式估算。推荐参数会优先使用有效实测显存。

## 7. 多模态、工具和 API

- 图片附件直接提交；音频会按运行时要求预处理；视频在 ffmpeg/ffprobe 可用时原生处理，否则抽帧后提交。
- `llamaTools.ts` 和设置中心配置 llama.cpp 原生 server tools，不等同于规划中的 Agent/MCP 工具编排。
- API 中心通过 `llama-server` 提供 OpenAI / Anthropic 兼容接口，支持监听地址、端口、Bearer Token、`/health`、`/v1/models` 和延迟检测。
- 服务端日志、系统日志、模型运行记录和用量统计分别有独立的读取与清理入口。

## 8. 关键 IPC 命令

命令注册集中在 `app/src-tauri/src/lib.rs`，主要包括：

| 类别 | 命令 |
| --- | --- |
| 配置 | `get_config`、`save_config`、`add_model_dir`、`remove_model_dir`、`reset_app_config`、`mark_env_check_done` |
| 模型 | `scan_models`、`scan_fast`、`clear_model_cache`、`load_model_from_path` |
| 服务 | `start_server`、`stop_server`、`get_server_status`、`get_server_logs`、`get_system_logs` |
| 硬件 | `get_hardware_info`、`list_gpus`、`set_gpu_device`、`get_system_status` |
| 内核 | `check_engine_info`、`check_for_update`、`list_recent_releases`、`download_and_update`、`cancel_kernel_update`、`list_installed_kernels`、`get_update_history` |
| 环境 | `run_env_check`、`get_env_check_done` |
| 记录与调优 | `save_model_run_record`、`get_model_run_records`、`clear_model_run_records`、`save_tune_result`、`start_benchmark`、`start_auto_tune` |

`read_file_content`、`read_media_file`、`reveal_path` 和 `open_external_url` 是文件/外部链接辅助命令。当前没有 `get_image_api_key_status`、`generate_image`、`rollback_to_version` 等旧文档中出现的命令。

## 9. 调试与测试

前端检查：

```powershell
cd D:\Projects\Agent_LLM\app
npm run lint
npm run build
```

Rust 检查：

```powershell
cd D:\Projects\Agent_LLM\app\src-tauri
cargo fmt --check
cargo check
cargo test
```

Rust 单测分布在 GGUF 解析、模型扫描、进程管理、GPU 监测、自动更新和服务命令模块。需要真实模型文件的 ignored 测试使用：

```powershell
$env:AGENT_LLM_TEST_MODEL_DIR = "D:\Models\gguf"
cargo test -- --ignored
```

开发日志中可查找 `[perf]` 扫描阶段、`[server] spawn` 完整命令行以及 server health 轮询结果。若内核缺失或后端不匹配，优先从「设置 → 核心更新」和首次启动「环境检测」排查。

## 10. 相关文档

- `README.md`：快速开始、发布包和用户功能说明。
- `docs/DEVELOPMENT_GUIDE.md`：本地开发、构建、测试和故障排查。
- `docs/COMFY_IMAGE_WORKSPACE_PLAN.md`：尚未实现的 ComfyUI 生图工作区计划。
- `docs/tech-spec.md`：早期前端原型设计意图。
- `CHANGELOG.md`：版本变更和已知限制。

如文档与代码不一致，以当前代码、`package.json`、`Cargo.toml` 和 `tauri.conf.json` 为准，并在同一变更中修正文档。
