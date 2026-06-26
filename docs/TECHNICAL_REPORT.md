# Agent LLM 技术报告

> 范围：`D:\Projects\Agent_LLM` 当前可运行版本（桌面端 + 浏览器预览）。早期原型的设计意图保留在同级 `tech-spec.md`，本文档以实际代码为准。

## 1. 项目定位

Agent LLM 是一个面向 Windows 的本地 GGUF 模型启动器。它把以下三件事打包进一个 Tauri 桌面应用：

1. **模型管理**：扫描本地 `.gguf` 文件，解析表头，缓存元数据，按家族着色。
2. **推理引擎**：调用随包分发的 `llama-server.exe`（位于 `app/resources/`），把前端参数映射成命令行，启动一个 OpenAI 兼容 HTTP 服务。
3. **对话与会话**：通过该 HTTP 服务流式对话，支持多会话、多模型历史、按日聚合用量统计。

与 Llama Desktop 的关系：桌面后端、模型扫描、推理参数、GGUF 解析逻辑借鉴自 Llama Desktop，但**前端从零重写**，使用自定义 React 状态机和 paper-surface 设计语言。

## 2. 技术栈

### 2.1 前端（`app/`）

| 层 | 选型 | 备注 |
| --- | --- | --- |
| 框架 | React 19.2 + TypeScript 5.9 | 函数组件 + Hooks + `useReducer` |
| 构建 | Vite 7.2.4 | `@` 别名指向 `src/`；`kimi-plugin-inspect-react` 注入 inspect attr |
| 样式 | Tailwind 3.4 + shadcn 主题 + 自定义 `.paper-surface` | 设计语言以暖米色 + 焦橙强调色为主 |
| 动效 | framer-motion 12 | 卡片入场、抽屉、模型网格切换 |
| 组件库 | Radix UI 1.x 完整集合 + 自定义 shadcn 风格包装 | 见 `app/src/components/ui/` |
| 图标 | lucide-react 0.562 | 全部 UI 图标 |
| 图表 | recharts 2.15 | 算力曲线 / 历史用量 |
| 文本 | highlight.js + markdown-it | 代码高亮 + Markdown 渲染 |
| 持久化 | `window.localStorage` | key 为 `agent-llm-local-state-v1` |
| IPC | `@tauri-apps/api` 2.11 + `@tauri-apps/plugin-dialog` | invoke / listen / drag-drop |

不引入但容易踩坑：
- **未使用 react-router** — 通过 `AppContext.currentView` 枚举切换工作区。
- **未使用 Zustand/Jotai** — 单 `useReducer` 足够。
- **未使用 shadcn 之外的动效库** — DotGridBackground 用原生 Canvas 2D；3D 倾斜墙用 CSS `transform`（见 `tech-spec.md` 中保留的设计意图）。

### 2.2 后端（`app/src-tauri/`）

| 模块 | 关键依赖 | 作用 |
| --- | --- | --- |
| `services/process_manager.rs` | `std::process`、`sysinfo`、`reqwest (blocking)` | 拉起 / 监控 / 终止 `llama-server.exe`，解析启动日志，http health 兜底 |
| `services/model_scanner.rs` | `walkdir`、`rayon`、`regex`、`once_cell` | 并行扫描多个目录，命中磁盘缓存 |
| `services/gguf_parser.rs` | 无第三方 | 手写 GGUF v3 二进制解析，读取架构、层数、上下文、专家数等关键 KV |
| `services/gpu_monitor.rs` | `nvml-wrapper` 0.10 | 显卡名 / 显存 / 利用率 / 温度 |
| `services/memory_monitor.rs` | `sysinfo` 0.30 | 系统 RAM |
| `services/auto_updater.rs` | `reqwest` | 拉 GitHub Releases 检查更新、下载回滚备份 |
| `services/benchmark.rs` | `std::time` + 外部 `llama-bench.exe` | 跑基准测试，输出 tokens/s |
| `commands/*.rs` | `tauri::command` | 对前端的 invoke 入口，约 25 个命令 |
| `models/*.rs` | `serde` | `AppConfig`、`ServerConfig`、`ModelInfo`、`HardwareInfo` 等 |

### 2.3 第三方二进制

`app/resources/`（`tauri.conf.json` 中的 `bundle.resources`）携带完整的 llama.cpp Windows x64 CUDA 13.3 运行时：

- `llama-server.exe`：HTTP 服务，对外暴露 `/v1/chat/completions` 与 `/health`。
- `llama-cli.exe`、`llama-bench.exe`、`llama-fit-params.exe`、`llama-quantize.exe` 等辅助工具。
- `ggml-cpu-*.dll`、`ggml-cuda.dll`：按微架构分发的 CPU 后端 + CUDA 后端。
- `cudart-llama-bin-win-cuda-13.3-x64/` 在仓库根目录是开发期参考，**构建后由 `llama-server.exe` 自动定位 `cudart64_13.dll` / `cublas64_13.dll` / `cublasLt64_13.dll`**（`process_manager.rs` 中 `resolve_exe_path` 会向上回溯到这些目录）。

## 3. 顶层架构

```text
┌──────────────────────────────────────────────────────────────┐
│                         Tauri WebView                         │
│                                                               │
│  React 19  ── AppContext (useReducer) ── localStorage         │
│      │                                                         │
│      │  invoke('get_config' / 'scan_models' / 'start_server')  │
│      ▼                                                         │
│  @tauri-apps/api/core  ◀──── listen('server:progress' etc.)    │
└──────┬───────────────────────────────────────────────────────┘
       │ IPC (window.localStorage is the only client-side state)
       ▼
┌──────────────────────────────────────────────────────────────┐
│                         Rust Backend                          │
│                                                               │
│  commands/*  ──▶  services/*  ──▶  models/*                   │
│       │              │                                          │
│       │              ├─ process_manager ─▶ llama-server.exe    │
│       │              │                       (子进程 + 日志流) │
│       │              ├─ model_scanner ─▶ walkdir + GGUF 解析  │
│       │              ├─ gpu_monitor ─▶ NVML                    │
│       │              └─ memory_monitor ─▶ sysinfo             │
│       │                                                         │
│       └─ config  ◀──▶  %APPDATA%\AgentLLM\config.json          │
└──────────────────────────────────────────────────────────────┘
       │
       ▼
   llama-server.exe  ◀── HTTP /v1/chat/completions ──▶  前端 fetch 流
```

## 4. 前端结构

### 4.1 目录与职责

```
app/src/
├── App.tsx                          # 顶层：包 AppProvider + AppContent
├── main.tsx                         # createRoot 入口
├── index.css                        # Tailwind + shadcn tokens + paper-surface
├── context/
│   └── AppContext.tsx               # 全局状态机 + 持久化 + 桌面环境 hydration
├── types/index.ts                   # 所有领域类型
├── lib/
│   ├── desktop.ts                   # 对 Tauri 命令的薄封装（含流式 fetch）
│   ├── modelDefaults.ts             # 推荐 ctx / gpuLayers / reasoningBudget
│   ├── modelTheme.ts                # 按 family 决定色板与图标
│   └── utils.ts                     # cn() 类名合并
├── hooks/
│   ├── useSystemStats.ts            # 1 秒轮询硬件状态
│   └── use-mobile.ts
├── components/                      # 跨工作区可复用组件
│   ├── ChatBubble.tsx               # 单条消息，支持 reasoning + stats
│   ├── CodeBlock.tsx                # 高亮 + 复制
│   ├── ColumnToggle.tsx             # 单/双列切换
│   ├── DotGridBackground.tsx        # Canvas 2D 点阵（鼠标排斥场）
│   ├── MarkdownRenderer.tsx         # markdown-it + highlight.js
│   ├── ModelCard.tsx                # 模型卡片
│   ├── NumericTicker.tsx            # 数字滚动
│   ├── SortDropdown.tsx
│   ├── ToggleSwitch.tsx
│   ├── TopStatusBar.tsx
│   └── ui/                          # 50+ shadcn 基础组件
├── features/
│   ├── workspace/
│   │   ├── WorkspaceShell.tsx       # 根据 currentView 路由到 Model/Chat/Settings
│   │   └── SystemStatusStrip.tsx    # 顶栏硬件条
│   ├── chat/
│   │   ├── ChatSidebar.tsx          # 会话列表 + 选择模式
│   │   └── chatUtils.ts             # 附件处理 / 日期分组 / 模型名缩写
│   ├── model/
│   │   └── ModelWorkspace.tsx       # 左侧导航 + 列表/详情切换 + 拖拽区
│   └── settings/
│       └── SettingsWorkspace.tsx    # 设置中心（设置 / 用量 / 生图 三标签）
└── pages/                           # 工作区内容面板
    ├── HomePage.tsx                 # 模型列表 + 搜索/排序/列切换
    ├── ModelLoadPage.tsx            # 加载参数面板（ngl/ctx/flash/...）
    ├── ChatPage.tsx                 # 对话界面 + 附件 + reasoning 菜单
    ├── SettingsPage.tsx             # 目录 / 端口 / API key / 主题 / 更新检查
    ├── UsagePage.tsx                # 按模型 / 按日聚合
    ├── ImagePage.tsx                # 多家云端生图入口
    └── SystemStatusOverlay.tsx      # 全屏硬件监控
```

### 4.2 全局状态

`AppContext.tsx` 是唯一的状态源，使用 `useReducer` 维护 `AppState`：

```ts
interface AppState {
  currentView: ViewType;        // 'home' | 'modelLoad' | 'chat' | 'settings' | 'usage' | 'image'
  theme: 'dark' | 'light';
  sidebarCollapsed: boolean;
  models: ModelInfo[];
  sortBy: SortType;
  gridColumns: 1 | 2;
  activeModelId: string | null;
  selectedModelId: string | null;
  systemStats: SystemStats;
  searchQuery: string;
  backendAvailable: boolean;
  serverRunning: boolean;
  serverPort: number;
  apiConfig: { enabled; host; apiKey };
  modelDirs: string[];
  appStatus: string | null;
  chatConfig: ChatGenerationConfig;
  usageByModel: Record<string, ModelUsageStats>;
  chatSessions: Record<modelId, ChatSession[]>;
  activeChatSessionIds: Record<modelId, sessionId>;
  modelLaunchMemories: Record<modelId, ModelLaunchMemory>;
}
```

设计上的一些关键约定：

- **会话键**：`chat-workspace`（`features/chat/chatUtils.ts` 中 `CHAT_HISTORY_MODEL_ID`）是一个聚合会话桶，所有用户消息在它名下保存，**每个模型可独立展示历史**——参见 `ChatPage` 中 `activeSessionModelId` 的派生逻辑。
- **持久化**：每次 reducer 触发都会把相关子集写回 `localStorage`，键为 `agent-llm-local-state-v1`；`sanitizeStoredSessions` 会把还原出来的消息强制重置 `isStreaming: false`，防止刷新后卡在 loading。
- **Hydration**：`AppProvider` 在挂载时若检测到 `isTauri()`，会串行调用 `get_config → get_server_status → scan_fast → scan_models`，把桌面后端的真实状态填进 reducer。
- **版本标记**：当前 ui 持久化段写入 `themePreferenceVersion: 2`，旧版本主题在加载时被丢弃（防止旧的暗色覆盖新的浅色）。

### 4.3 视图路由

不依赖路由库，全部走 `WorkspaceShell`：

```ts
function workspaceMode(view: ViewType): 'model' | 'chat' | 'settings' {
  if (view === 'chat') return 'chat';
  if (view === 'settings' || view === 'usage' || view === 'image') return 'settings';
  return 'model';
}
```

`'modelLoad'` 视为 `model` 工作区的二级页面，由 `ModelWorkspace` 在内部按 `state.currentView` 决定显示 `HomePage` 还是 `ModelLoadPage`。

### 4.4 模型加载链路（前端 ↔ 后端 ↔ 推理引擎）

```text
HomePage               ── 选中 ──▶  SET_SELECTED_MODEL
                                            │
                                            ▼
ModelLoadPage          ──▶  listenDesktopEvent('server:progress' / 'server:ready' / 'server:error')
                                            │
                                            ▼
lib/desktop.ts         startDesktopServer(model, port, exePath, apiConfig)
                            │ 构造 ServerConfig
                            ▼
invoke('start_server', { config })
                            │
                            ▼
Rust services::process_manager::start_server
   ├─ resolve_exe_path   (回溯到 resources/llama-server.exe)
   ├─ stop_stale_servers_for_exe  (清理同名残留)
   ├─ spawn_server_process        (CREATE_NO_WINDOW, 拼 -m/-c/-ngl/...)
   ├─ 监听 stdout/stderr 行流     (mpsc::channel)
   ├─ monitor_server              (行解析进度 + http /health 兜底)
   └─ on_progress / on_ready / on_error
                            │
                            ▼  events: server:progress | server:ready | server:error | server:stopped
                                            │
                                            ▼
前端 SET_SERVER_RUNNING(true) / UPDATE_MODEL_STATUS('loaded')
                                            │
                                            ▼
ChatPage.streamChatCompletion → POST /v1/chat/completions (SSE)
                                            │
                                            ▼
UPDATE_MESSAGE → reducer 把 token 增量写回，UI 流式刷新
```

进度解析见 `process_manager.rs::parse_progress`，关键里程碑：

| 日志关键字 | 进度 |
| --- | --- |
| `llama build` / `system info` | 2 / 3 |
| `ggml init` / `loading model` | 5 / 12 |
| `llama_init_from_file` / `offloaded X/Y layers` | 22 / 20 + 60·X/Y |
| `llama_new_context_with_model` | 82 |
| `model loaded` | 92 |
| `server is listening` 或 HTTP 200 `/health` | 100 |

错误分类见 `detect_error`：`warmup` / `cuda` / `oom` / `model` / `port` / `spawn` / `timeout`，前端可在 `ModelLoadPage` 给出对应建议。

### 4.5 GGUF 元数据解析

`gguf_parser.rs` 完全手写：

1. 读取文件前 100 MB（`BUF_SIZE = 100 * 1024 * 1024`），跳过 GGUF magic 与 version。
2. 遍历 KV 对，仅当 key 命中白名单（`general.*` 或各段 KV 后缀）时才解码；其余 `skip`。
3. 类型系统对应 GGUF v3 spec：u8 / i8 / u16 / i16 / u32 / i32 / f32 / bool / string / array / u64 / i64 / f64。
4. 关键字段：`general.architecture`、`*.block_count`、`*.context_length`、`*.embedding_length`、`*.expert_count`、`attention.{head_count, head_count_kv, key_length, value_length}`、`*.nextn_predict_layers`（MTP 标记）。
5. 数组遇到大尺寸时只解码前 10 项，其余 `skip`，避免一次性读爆内存。

`parse_gguf_header` 返回 `GgufMetadata`，由 `model_scanner::parse_model_info_from_path` 与文件名正则（`RE_PARAM`、`RE_QUANT`、`is_moe`、`detect_reasoning_support`）合并成 `ModelInfo`。

#### 磁盘缓存

每次扫描把 `ModelInfo` 序列化到 `%APPDATA%\AgentLLM\cache\<sanitized_path>.json`，header 含 `ver`、`mtime`、`size`，任一变化即作废。`SCANNER_VERSION = 7` 表示当前缓存格式的版本号，升级 GGUF 解析字段时务必同步增加。`scan_cache_only` 只读取缓存，提供给启动时的快速 hydration。

### 4.6 推理参数映射

`ModelLoadConfig` (TS) → `ServerConfig` (Rust) 的字段映射位于 `lib/desktop.ts::buildServerConfig`：

| 前端字段 | llama-server 参数 | 默认 |
| --- | --- | --- |
| `gpuLayers` | `-ngl` | `blockCount`（模型层数） |
| `ctxLength` | `-c` | `32768` |
| `batchSize` | `-b` | `512` |
| `fastAttention` | `--flash-attn on/off` | `true` |
| `kvCache` | `--no-kv-offload` 取反 | `true` |
| `mmap` | `--mmap` / `--no-mmap` | `true` |
| `mlock` | `--mlock` | `false` |
| `kvQuant` | `-ctk` / `-ctv`（同时使用） | `f16` |
| `moeCpuLayers` | `-ncmoe`（仅 MoE 模型） | `0` |
| `reasoningBudget` | `--reasoning on --reasoning-format deepseek --chat-template-kwargs '{"enable_thinking":true}' --reasoning-budget` | 模型标签决定 |
| `apiKey` | `--api-key` | 空 |
| `host` / `port` | `--host` / `--port` | `127.0.0.1:8080` |

另两条隐含参数：

- `--no-warmup`：规避 llama.cpp 空跑 warmup pass 在某些版本上的崩溃。
- `--fit on --fit-target 1024 --fit-ctx 4096`：CUDA 模式下自动寻找最大可用 `ngl`，CPU 模式强制 `--device none --no-op-offload`。

#### CPU 回退

`process_manager::should_retry_with_cpu` 在以下错误类型时自动重试一次：`warmup` / `cuda` / `oom`。重试时调用 `compatible_cpu_config` 把 ngl 置 0、n_ctx 限到 4096、batch 限到 128、关闭 flash-attn / kv-offload / mlock / ncmoe。`retry_cpu_fallback` 关闭时跳过。

### 4.7 流式对话与推理指标

`lib/desktop.ts::streamChatCompletion` 直接 `fetch('http://127.0.0.1:8080/v1/chat/completions')`：

- SSE 行以 `data: ` 起头，`[DONE]` 表示结束；每行 JSON 解析后读 `choices[0].delta.content` 与 `delta.reasoning_content / reasoning / thinking`（多版本兼容）。
- 指标聚合：`usage.prompt_tokens` / `completion_tokens` / `total_tokens` 与 `timings.predicted_per_second` / `tokens_per_second`，缺失时由 `predicted_n / predicted_ms` 回退推算。
- 端到端时延：首 token 延迟由 `performance.now()` 与首个 SSE event 的差值计算；总生成时间在 reader 结束时计算。
- 中止：`AbortSignal` 透传，前端 `abortControllerRef.current?.abort()` 可立即中断流（不会杀死 llama-server）。

reasoning 控制由 `reasoningBudgetForMode(mode, modelBudget, supportsReasoning)` 完成：

| `reasoningMode` | 行为 |
| --- | --- |
| `off` | `reasoning_budget=0`, `chat_template_kwargs.enable_thinking=false` |
| `auto` | 仅当模型原生支持或预算 > 0 时启用 |
| `think` | 强制启用，`budget = DEFAULT_REASONING_BUDGET (4096)` |
| `deep` | 强制启用，`budget = 4×DEFAULT` |

### 4.8 拖拽与拖放

模型加载与对话都支持拖拽，分两层处理：

1. **OS 级窗口拖放**：`tauri.conf.json` 设置 `dragDropEnabled: true`，前端通过 `getCurrentWindow().onDragDropEvent` 拿到绝对路径（`features/model/ModelWorkspace.tsx` 中）。
2. **DOM 级拖放**：浏览器兼容路径，仅当 `event.dataTransfer.files[i].path` 存在才走加载流程，否则提示用户使用桌面窗口拖入。

拖入的 `.gguf` 文件会：

1. 取所在目录作为新 `model_dir`（`addDesktopModelDir`）。
2. 调 `load_model_from_path` 解析 GGUF 表头。
3. `UPSERT_MODELS` 合并到全局列表，并选中进入 `modelLoad` 视图。

## 5. 后端结构

### 5.1 进程模型

`process_manager.rs` 的进程模型值得单独说明：

- 全局单实例：用一个 `Lazy<Mutex<Option<Child>>>` 持有当前子进程；`start_server` 会先调用 `stop_server` 清理旧进程，再清理 sysinfo 中同 exe 路径的残留 llama-server。
- 日志传输：stdout 与 stderr 各起一个线程，逐行 `tx.send(line)`，主监控线程通过 `mpsc::Receiver` 聚合，避免阻塞 IO。
- 双轨就绪判断：日志关键字（`server is listening`）与 HTTP `/health` 轮询（每 500ms），先到先触发 `on_ready`；保证 buffer / 重写日志不会卡住加载页。
- 错误检测：`detect_error` 行扫描分类，命中即触发 `on_error`，加载页据此给出降级建议。
- CPU 兜底：错误落在 `warmup/cuda/oom` 且未禁用过 `retry_cpu_fallback` 时，会切换到 `compatible_cpu_config` 重试一次（仍允许业务层 UI 关闭它）。

### 5.2 启动顺序

```
lib.rs::run
  ├─ commands::config::init_config()      // 同步加载 %APPDATA%\AgentLLM\config.json
  ├─ tauri::Builder::default()
  │     .plugin(tauri_plugin_dialog::init())
  │     .manage(app_state)
  │     .invoke_handler![ ... 25 commands ... ]
  │     .setup(|app| tauri_plugin_log::Builder ...)     // 仅 debug 构建
  │     .on_window_event(Destroyed => stop_server())
  │     .run(...)
```

### 5.3 关键 IPC 命令清单

| 命令 | 调用方 | 行为 |
| --- | --- | --- |
| `get_config` / `save_config` | `lib/desktop.ts` 同步读写 | 启动时获取 `AppConfig`；保存时同时落盘 |
| `add_model_dir` / `remove_model_dir` | `SettingsPage`、`ModelWorkspace` 拖拽 | 维护 `AppConfig.model_dirs` |
| `scan_models` / `scan_fast` | `AppProvider` 启动 hydration、`HomePage` 刷新 | 完整扫描 vs 仅缓存 |
| `load_model_from_path` | 拖拽流程 | 单文件解析 |
| `start_server` / `stop_server` / `get_server_status` / `get_server_logs` / `clear_server_logs` | `ModelLoadPage` | 启停 + 日志 |
| `get_hardware_info` / `list_gpus` / `set_gpu_device` | `SettingsPage` | NVML 信息 |
| `get_system_status` | `useSystemStats` hook | NVML + sysinfo 综合 |
| `check_engine_info` / `check_for_update` / `download_and_update` / `list_recent_releases` / `list_version_backups` / `rollback_to_version` / `get_update_history` | 设置页升级面板 | llama.cpp 内核热替换 |
| `save_model_preset` / `delete_model_preset` / `save_tune_result` | 调参面板 | 持久化预设 |
| `start_benchmark` / `start_auto_tune` | 用量面板 | 调优 |
| `get_image_api_key_status` / `save_image_api_key` / `delete_image_api_key` / `generate_image` | `ImagePage` | keyring 存储 + HTTP 调用多家云端 |
| `reveal_path` / `read_file_content` | 资源管理器 / 调试 | 文件辅助 |

事件（前端通过 `listenDesktopEvent` 监听）：

- `server:progress` → `ServerProgress { progress, stage, log }`
- `server:ready`
- `server:error` → `ServerError { error_type, title, details, suggestions }`
- `server:stopped`

### 5.4 配置文件

`%APPDATA%\AgentLLM\config.json`：

```json
{
  "version": 1,
  "model_dirs": ["D:\\Models\\gguf", "D:\\Models\\HauhauCS"],
  "llama_server_path": "llama-server.exe",
  "default_port": 8080,
  "api_enabled": false,
  "api_host": "127.0.0.1",
  "api_key": null,
  "theme": "dark",
  "refresh_interval": 2,
  "auto_scan_on_startup": true,
  "model_presets": {},
  "tools": null,
  "last_model_path": null,
  "tune_history": []
}
```

`AppConfig::default` 提供缺省值；`config.rs::load_config_from_disk` 失败时使用默认值。`model_presets` 与 `tune_history` 是面向未来扩展保留的字段。

### 5.5 Tauri 权限

`capabilities/default.json`：

```json
{
  "permissions": ["core:default", "dialog:default", "core:event:default"]
}
```

窗口对象只声明 `main`；CSP 见 `tauri.conf.json::app.security`，禁止外网脚本。

## 6. UI 设计语言

### 6.1 配色

- 主背景 `#FBFAF6`（暖米）/ `#0F0F13`（暗色）。
- 强调色 `#D7663E`（焦橙）。
- 文本主色 `#403C32`，次色 `#8C8576`。
- 模型家族色板见 `lib/desktop.ts::colorByFamily`：Qwen 紫、Llama 绿、Mistral 橙、Yi 蓝、Gemma 番茄、DeepSeek 灰、Phi 蓝灰、Local 靛。

### 6.2 动效约定

- 视图切换：`WorkspaceShell` 不做统一转场；每个 `Workspace` 内部用 framer-motion 的 `motion.div` + `key` 做进入/退出。
- 模型网格：`layout` 属性配合 `AnimatePresence` 做 1↔2 列的位置重排。
- 长内容：消息流、设置侧栏用 `AnimatePresence` + `width` / `x` 过渡。

### 6.3 DotGridBackground

`components/DotGridBackground.tsx` 是项目里唯一的命令式渲染：

- 离屏 Canvas + `requestAnimationFrame` 驱动。
- 每个点保存目标位置 + 当前 lerp 位置；鼠标靠近时偏移。
- 60fps 下必须绕开 React 渲染，只通过 ref 共享鼠标坐标。

## 7. 性能与稳定性注意

- **`scan_models` 并行化**：`rayon` 在 `par_iter` 中处理每个 gguf 文件，单文件解析走 GGUF 二进制读取，未命中缓存才解析。日志用 `eprintln!("[perf] ...")`，dev 模式下可观察 `setup / walkdir / parse / cache / scan_total` 各阶段耗时。
- **`scan_fast` 路径**：`AppProvider` 启动时先尝试命中缓存，避免每次冷启动阻塞 UI。
- **CUDA 启动阶段参数自适配**：`spawn_server_process` 给 GPU 模式加了 `--fit on --fit-target 1024 --fit-ctx 4096`，让 llama.cpp 自动挑选 ngl，简化 UI 默认值。
- **`--no-warmup`**：规避某些 llama.cpp 版本在空跑 warmup 时崩在已加载模型后的问题。
- **服务端日志上限**：`SERVER_LOGS` 滚动保留 2000 行（满了丢弃前 1000）。
- **前端消息流**：`UPDATE_MESSAGE` 每次 token 触发；reducer 只重写当前消息；React 通过 key 复用避免整列表重建。
- **统计用量**：`ADD_USAGE` 累加 `promptTokens / completionTokens / responseCount / totalTokensPerSec / totalFirstTokenDelay / totalGenTime` 以及按日桶 `dailyTokens[YYYY-MM-DD]`；`avgTokensPerSec` 派生写入 `models[id]` 便于卡片显示。

## 8. 已知的脆弱点

- **Port 8080 冲突**：默认端口固定，端口被占用会进入重试路径给出建议但不会自动迁移。
- **CPU 后端的 fit 参数**：当前只在 GPU 模式下启用 `--fit`；CPU 回退时 `compatible_cpu_config` 强制关掉了它。
- **`localStorage` 大小**：所有会话 / 主题 / 主题色 / 启动参数都写 localStorage。典型大小在 MB 级，但仍要注意清空策略。
- **CSP**：`connect-src` 仅允许 `http://localhost:*` 与 `http://127.0.0.1:*`，云端生图 API 走的是 Rust 侧 reqwest，因此不需要额外放行。
- **`kimi-plugin-inspect-react`**：在生产构建里仍然会注入 inspect 属性；如果不需要可从 `vite.config.ts` 移除以减小包体。
- **`kimi-plugin-inspect-react` 在 `npm run build` 时是否摇树**：当前未单独验证，需要时可手动 `vite build --mode production` 检查 dist 大小。

## 9. 文件级索引（便于检索）

### 前端核心

- 状态机：`app/src/context/AppContext.tsx:213`
- 持久化键：`app/src/context/AppContext.tsx:68`
- hydration：`app/src/context/AppContext.tsx:482`
- 视图路由：`app/src/features/workspace/WorkspaceShell.tsx:9`
- 模型卡片：`app/src/components/ModelCard.tsx`
- 加载参数：`app/src/pages/ModelLoadPage.tsx:51`
- 对话发送：`app/src/pages/ChatPage.tsx:187`
- 流式请求：`app/src/lib/desktop.ts:513`
- 推理参数映射：`app/src/lib/desktop.ts:435`
- 推荐默认值：`app/src/lib/modelDefaults.ts`

### 后端核心

- 进程生命周期：`app/src-tauri/src/services/process_manager.rs:821`
- 启动参数构造：`app/src-tauri/src/services/process_manager.rs:608`
- 健康检查兜底：`app/src-tauri/src/services/process_manager.rs:727`
- 错误分类：`app/src-tauri/src/services/process_manager.rs:209`
- GGUF 解析：`app/src-tauri/src/services/gguf_parser.rs:161`
- 模型扫描：`app/src-tauri/src/services/model_scanner.rs:130`
- 磁盘缓存：`app/src-tauri/src/services/model_scanner.rs:50`
- GPU 监控：`app/src-tauri/src/services/gpu_monitor.rs:11`
- 配置持久化：`app/src-tauri/src/commands/config.rs`
- 命令清单：`app/src-tauri/src/lib.rs:12`

## 10. 与同级文档的关系

- `tech-spec.md`：早期前端原型设计文档，包含动效细节、shadcn 取舍、3D 倾斜墙等未实现的设想；当前实现以本文档为准。
- `README.md`：极简启动说明，仅含 `npm install && npm run desktop`。
- `app/README.md`：实际可运行项目的启动 / 构建 / 检查 / 注意事项。
- `app/info.md`：脚手架初始化日志，仅供溯源。
