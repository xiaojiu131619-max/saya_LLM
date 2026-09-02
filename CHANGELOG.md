# 变更日志

本文件记录 Agent LLM 项目所有可观察的改动。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

每次发版前在对应版本段下增补条目；进行中的改动写到 `[Unreleased]` 段。

---

## [Unreleased]

---

## [0.3.1] - 2026-09-02

本轮补上 AMD / Intel Vulkan 加速与显存监测，并修一批显存预测、对话 ctx 口径和 Gemma4 MTP 启动问题。NVIDIA 仍走 CUDA，未改加载/推理默认参数。

### 新增

**AMD / Intel Vulkan 设备支持**

- 启动 llama-server 前查询 `--list-devices`，按本机内核实际设备选择 `CUDA0` 或 `Vulkan0`，不再写死 `--device CUDA0`
- Vulkan 包在 AMD / Intel 上可正常卸载到 GPU；NVIDIA 继续优先 CUDA。`--main-gpu` 只在 CUDA 设备上传递
- 环境检测与「核心更新」同时显示本机后端和运行时设备：NVIDIA 匹配 CUDA 包，AMD / Intel 匹配 Vulkan 包；装错包会提示换包
- Windows 无 NVML 时用 DXGI + PDH 读取独显显存与利用率，AMD 上不再显示「未连接」
- 首次启动环境检测：内核、VC++ 运行库、显卡与驱动、ffmpeg / ffprobe、数据目录可写性；未通过项给出中文安装引导

### 修复

**Vulkan 内核被当成 CUDA 失败并静默回退 CPU**

- 根因：非 CPU 模式默认传 `--device CUDA0`。Vulkan 包只有 `Vulkan0`，llama.cpp 报 `invalid device: CUDA0` 后 CPU 回退把 ngl 打成 0
- `process_manager.rs` —— 按实际设备选卡；识别 Vulkan / 无效设备错误，不再一律当 CUDA 失败
- `desktop.ts` —— GPU 模式不再写死 `CUDA0`，CPU 模式才传 `none`

**AMD 显卡不显示显存、推荐参数偏保守、运行时显存占不满**

- 根因：`GpuMonitor` 只接了 NVIDIA NVML。AMD / Intel 上整条监测链路为空；同时「40GB+ 稳妥推荐」会在硬件推荐之前把 `ngl` 推成 0
- `gpu_monitor.rs` —— NVML 不可用时回退 DXGI（总显存）+ PDH 已用显存 / 利用率。按适配器 LUID 对齐，丢掉 DXGI 枚举出的同名幽灵适配器，默认选已用显存更高的那张
- `ModelLoadPage.tsx` —— 读到实测显存时优先「基于实测显存的推荐」；体积启发式（超大分片 / 40GB+ 稳妥、ngl=0）只在没有显存数据时作为回退

**显存预测校准后系统性偏低、越校越小**

- 根因有三：①整体校准比值用了「含 6% 余量的总预测」做分母，应用时却只加 2% 余量，校准后必然略低于实测；②EMA 按「从新到旧」折叠，最旧样本反而权重最高，历史偏低记录把预测越拉越小；③整体校准把 KV 一并缩放，ctx 变大时准确的 KV 也被旧权重误差压小
- `app/src/lib/vramCalibration.ts` —— 比值改为实测 / 不含余量的小计；EMA 改为从旧到新，让最新一次加载权重最高
- `app/src/lib/vramEstimate.ts` —— 整体校准只缩放 GPU 权重，KV 与计算开销按解析式保留；校准后安全余量回到 6%（与无校准时一致）；整体比率下限 0.3 → 0.5，宁多勿少
- `app/src/pages/ModelLoadPage.tsx` —— 「实测校准」徽章说明改为「权重 ×N，KV 按解析式」

**侧边栏状态卡 ctx 与对话气泡同口径**

- `app/src/pages/ChatPage.tsx` —— 侧边栏状态卡的 ctx% 从「会话消息的服务端单轮 stats」改为与对话气泡同口径的**本地会话累计水位**（`sessionCtxTotals` 末值 ÷ 当前加载模型 `-c`），两处数值一致；API 状态页保持日志口径独立，互不混用。此前侧边栏显示的是最近一轮请求的服务端统计，和气泡的会话累计对不上

**对话侧边栏与 API 页的 ctx 数据跨模型串台**

- 根因：全部会话都存在 `state.chatSessions['chat-workspace']` 一个桶里（会话靠 `runtimeModelId` 字段标记实际模型），而侧边栏、API 状态页、模型工作区服务状态卡的取数都是「取桶 → 取最新」，模型间切换后显示的是上一个聊天模型的 ctxUsed/ctxTotal——分母（上下文容量）也跟着错，两边数值看似互换
- `app/src/features/chat/chatUtils.ts` —— 新增 `sessionBelongsToModel`：按会话 `runtimeModelId`（发起对话时的实际模型快照）匹配模型；`modelId` 字段是桶 id、无模型语义，仅在恰好等于模型 id 时参与匹配
- `app/src/pages/ChatPage.tsx`（侧边栏状态卡）—— ctx% 只认当前加载模型的会话 stats，当前模型没有聊天记录就显示 `--`，不再回退到其他模型
- `app/src/features/apiStatus/ApiStatusPage.tsx` —— 「ctx 使用」在日志解析不到时（当前模型还没生成过）兜底到该模型自己的会话 stats，不再拿任意模型最近一次聊天的数据充数
- `app/src/features/model/ModelWorkspace.tsx` —— 服务状态卡的本地会话水位与输出速度同样按当前加载模型过滤

**显存预测对混合架构模型虚高数倍、连续加载时实测失真**

- `app/src-tauri/src/services/gguf_parser.rs` —— 解析 `head_count_kv` 逐层数组：混合注意力架构（`nemotron_h_moe` / `lfm2` / `gemma4` 等）把该键写成每层数组，非 0 = 该层 KV 头数、0 = Mamba 等无 KV 层。此前数组被读成 `None`，KV 估算退回 `head_count` 整层近似，Nemotron-3.5-Lightning-30B / Gemma4-26B 预测虚高至实测的 6~10 倍（30B 模型预测 60GB、实测 10GB）。现绕过 `read_val` 的「只物化前 10 个元素」限制、从缓冲区读全量数组，聚合为 `kv_heads_sum`；gemma 系再按滑窗模式分列出全注意力 / SWA 两类头数并透出 `sliding_window` / `key_length_swa`（SWA 层 KV 只按窗口分配，全 ctx 计算会再虚高一个量级）。`app/src-tauri/src/models/model_info.rs` 透出上述字段，`app/src-tauri/src/services/model_scanner.rs` 升级 `SCANNER_VERSION` 20 使旧缓存全量失效重扫
- `app/src/lib/vramEstimate.ts` —— KV 公式改为按「KV 头总数」计算（`kvHeadsSum` 优先、标量按层展开，数值与旧公式完全兼容）；gemma 系 SWA 分列齐备时改用「全注意力层 × 全 ctx + SWA 层 × 滑动窗口」双段估算；`key_length` / `value_length` 缺省时按 llama.cpp 口径退回 `embedding_length / head_count`，修复 LFM2.5 系缺键导致 KV 完全不计入、预测偏低 25%；整体兜底比率下限 0.5 → 0.3，容纳「大模型被 `-fit` 自动卸载压进显卡、实测贴着容量上限」的场景
- `app/src/lib/vramCalibration.ts` —— 校准样本可信下限改为「解析项一半」与「文件体积三成 + 0.5GB」取低者：既拦启动失败残值，也不再误杀解析项虚高 / `-fit` 压顶的合法低实测样本（此前 Nemotron 全部样本被旧守卫拒绝、永远无法校准）
- `app/src/pages/ModelLoadPage.tsx` —— 读取显存基线前先停掉仍在运行的 server 并等显存回落：连续加载 / 换模型时旧实例占用会串进差值，实测被压成 0.1~2GB 的脏数据；入库前用同一可信下限复核，异常差值 `vram_gb` 置空并附注，保留记录但不参与校准。经全部 10 个有记录模型复算，校准后预测偏差从最高 +597% 收敛到 ±9% 以内

**思考强度菜单只显示一项**

- `app/src/pages/ChatPage.tsx` —— 移除对话输入卡片的 `overflow-hidden`：思考强度菜单（关闭/自动/思考/深思）从卡片内向上弹出，被卡片裁剪后只露出最底部一项（当前选中项），其余选项不可见也无法点击，表现为「只有深思且无法切换」；卡片内容（透明输入框 + 按钮行）无需要裁剪的溢出，去掉后菜单完整显示，交互正常

**Gemma4 QAT 模型加载与对话链路**

- `app/src-tauri/src/services/process_manager.rs` —— 规避 llama.cpp b10687 已知 bug（ggml-org/llama.cpp#24343）：`--spec-type draft-mtp`（Gemma4 MTP）下内核 memory fitting 阶段初始化草稿上下文报 `Gemma4Assistant requires ctx_other to be set` 并退出，导致 Gemma4 QAT 等模型开启 MTP 推测解码时启动失败；现 draft-mtp 模式自动附加 `-fit off`（官方 workaround）
- 同文件 —— 修复启用 server 工具后对话请求全部 `Failed to fetch`：内核会把默认 CORS 收紧为仅允许 `http://localhost`，而应用 WebView origin 是 `http://tauri.localhost`；现显式传 `--cors-origins *` 恢复 Origin 回显。实测 b10687 的 `--cors-origins` 逗号分隔列表会被整体当单值回显、多次传参仅最后一个生效，均不可用
- `app/src/pages/KernelUpdatePage.tsx` —— 内核存在但 `--version` 解析不出版本号（如自编译构建）时，徽章显示「已安装 · 版本未知」而非误报「未安装内核」

### 变更

**显存预测改为实测数据驱动校准**

- `app/src/lib/vramCalibration.ts` 重写 —— 校准数据源从 localStorage 系数改为「运行记录」（AppData/model_records.json）：每条带实测显存的启动记录用模型表头还原当时的分项预测，反推偏差；换机 / 重置浏览器状态后校准不再丢失，启动模型即自动积累样本
- 同文件 —— 两级校准：①分项校准（优先）只修正「计算暂存 + 运行时」经验项，权重与 KV 按解析式原样保留，改 `ctx` / `ngl` 不再被旧样本误差按比例污染；②整体兜底——解析项本身虚高（如 MoE 权重公式与实际结构不符）导致分项还原为负时，退化为总实测/总预测比缩放。样本按参数指纹筛选（`ngl` / `kv` / Flash Attention / `ncmoe` 一致且 ctx 同数量级，≥2 条才启用），启动失败的残值记录（实测低于解析项一半）自动剔除
- `app/src/lib/vramEstimate.ts` —— `predictVramUsage` 接受 `{ scratchRatio | overallRatio }` 校准输入，暴露 `analyticalGb` / `empiricalGb` 分项；无实测样本时保持原有整体 6% 安全余量行为
- `app/src/pages/ModelLoadPage.tsx` —— 校准改为 `useMemo` 从运行记录派生（启动写档后自动更新）；「实测校准 ×N」徽章区分分项 / 整体两种口径（悬停可看说明），「计算 / 运行」分项与校准后总数保持同口径
- 说明：旧版记录若缺 `ncmoe` 字段（MoE 权重无法准确还原）不参与校准；启动一次模型后新记录即带全字段并开始生效

### 修复

**模型管理磁贴排版**

- `app/src/components/ModelCard.tsx::CapabilityBadges` —— 多列磁贴的能力标签由「全量 9 格 `grid-cols-5` 矩阵」改为只展示激活的能力、flex 自然横排（超 6 个折叠为 +N）。此前磁贴宽约 215px、每格仅约 37px，「视觉」「UD量化」等标签文字被挤压成竖排折行，磁贴失去可读性
- 单列模式展示逻辑不变

### 验证

- AMD Radeon RX 7700 XT + Vulkan 内核 `b10752`：`--device Vulkan0`，35B MoE 实测约 23–26 tok/s，独显占用约 10.8 GB
- NVIDIA 路线未改：本机无 NVIDIA 时仍按 CUDA 包匹配逻辑选择设备

---

## [0.3.0] - 2026-08-28

本轮以「核心更新体验重做、API 中心精简、数据口径统一、模型管理磁贴化」为主线，未改动任何模型加载/推理默认参数（`ctx`/`ngl`/KV/batch/parallel/max token/reasoning 等）。

### 新增

**核心更新（llama.cpp 内核管理）**

- `app/src/pages/KernelUpdatePage.tsx` —— 独立「核心更新」页（设置中心侧栏新标签）：内核状态徽章（已是最新 / 有可用更新 / 未安装）、最近 8 个 release 列表（逐版本「更新」按钮）、下载进度条与「停止下载」、本机核心目录列表（标注使用中）
- `app/src-tauri/src/services/auto_updater.rs` —— **版本化内核目录**：每次更新安装到 `resources/kernels/<版本>_<安装时间>/`，装好并 `--version` 验证后才切换生效，自动只保留最近两份（最新 + 上一个）；旧平铺布局在首次更新时自动迁移
- 同文件 —— **可取消下载**：全局取消标志，下载循环逐块检查，取消后清理临时文件、本机核心保持不变；新增 `cancel_kernel_update` / `list_installed_kernels` 命令
- 同文件 —— **显式代理**：`AppConfig.proxy_url`（仅 http/https），GitHub API 与全部下载走该代理（Rust 端 reqwest 关闭了 system-proxy 特性，系统代理对本程序无效，必须显式配置）；`list_recent_releases` 按需拉取并放宽超时，修复默认 30 条响应过大导致的解码失败
- `process_manager.rs` —— llama-server 启动路径优先解析版本化核心目录；`check_video_runtime` 命令独立检测 ffmpeg/ffprobe

**模型运行记录**

- `app/src-tauri/src/models/app_state.rs::ModelRunRecord` + `commands/config.rs` —— 独立存储 `AppData/model_records.json`：按模型记录启动参数（ngl/ctx/kv/ncmoe/flash-attn/推测解码）与实测表现（速度、显存增量、预测偏差%），启动与调参应用时自动写入，每模型上限 30 条；模型删除时一并清理
- `app/src/pages/ModelLoadPage.tsx` —— 「运行记录」折叠卡片展示最近 8 条，供推荐参数与自动调参对比

**显存校准按模型独立**

- `app/src/lib/vramCalibration.ts` —— 校准系数从全局单值改为每模型一份（EMA α=0.25，上限 60 样本，旧数据自动迁移为全局兜底），显存预测/推荐参数按模型取系数

**头像 logo 库**

- `app/src/lib/modelLogo.ts` + `ModelFamilyLogo` + `ModelLoadPage` —— 点击头像弹出内置品牌 logo 库（32 个品牌网格，点选即用，`lobehub:<key>` 引用存储），移除上传图片入口；右键恢复默认保留

### 变更

**API 中心精简与口径分离**

- `ApiStatusWorkspace` —— 移除侧边栏与应用日志入口，只保留 API 状态页；指标卡改为独立底色卡片并允许换行，相邻文本不再粘连
- 「使用统计」（UsagePage）移入设置中心；API 页 ctx 指标维持「最近一次请求」口径（服务端日志解析），归属 API 数据
- API Key 逻辑修复：新增会话级 `pendingApiKey`，服务运行中重新申请 Key 不再导致复制按钮消失，也不影响软件内对话（旧 Key 继续生效，新 Key 重新加载模型后转正）
- 「接口可用模型」列表支持一键添加为软件内模型，按名称自动推断标签（工具/思考/视觉/嵌入/重排等）

**上下文水位口径统一（本地对话）**

- `chatUtils.ts` —— 新增会话 token 估算（CJK≈1 token/字，其余 4 字符/token）；对话气泡与模型页服务状态面板统一显示**本地会话累计水位** `ctx X%（≈已用/容量）`，气泡历史可回看水位变化
- `chatUtils.ts::list_recent_releases` 响应解析修复见上（更新源）

**模型管理磁贴化**

- `app/src/components/ModelCard.tsx` —— 多列模式重写为 Win10 磁贴：主题色染底方形 logo、mono 信息行（参数·量化·大小）、能力徽章 5 列 × 2 行全显示、底部 ctx/速度 + 紧凑操作键；整卡可点进入参数页
- `index.css` —— 多列网格 `auto-fill minmax(215px,1fr)` 自适应列数并限制磁贴宽度；移除旧 2/3/4 列断点
- 侧栏服务状态重排为四行「标签左、数值右」，长数值换行不截断；ctx 快捷节点（10K/32K/64K/100K，超容量自动隐藏）；自动调参入口改为顶栏按钮（重置/加载之前）
- API 调用名输入框改双排紧凑布局；全局 `:focus-visible` 不再对输入类元素显示蓝色描边

**聊天与外观**

- `ChatSidebar` —— 新建对话按钮浅色主题文字颜色修复（原 `--app-bg` 白字压浅底不可读）
- `index.css` —— 毛玻璃面层透明度整体下调（浅 0.78→0.60 / 深 0.90→0.72）；`setDesktopWindowMaterial` 在 Win10 上 Acrylic 失败自动回退 Blur
- 聊天附件拖拽读取白名单放宽至用户常用目录（桌面/文档/下载/图片/音乐/视频）；模型工作区拖拽导入移除（拖拽仅保留在聊天界面）

**移除**

- 模型下载功能（`ModelDownloadPanel` 组件删除，Rust `download_model_file` 保留未启用）；模型页工具栏新增「魔搭下载」按钮，跳转 https://www.modelscope.cn/

**MTP / 校验修复**

- `process_manager.rs` —— 推测解码：模式为 off 时不再残留 `--spec-draft-n-max`；显式 `spec_type` 与草稿路径强制跨模式一致；侧车校验只针对实际启用的那一个（被更高优先级遮蔽的侧车异常不再阻断启动）

### 修复

- `model_scanner`/`chatUtils` —— GitHub API 响应超时报「解码失败」的问题（见上）
- `.gitignore` —— 排除 `.zcode/`、`.mimosa/`、`test-results/` 等工具产物并移出仓库

### 验证

- `npm run build` / `cargo check` —— 通过
- `npm run desktop:build` —— 通过，产物 `app/src-tauri/target/release/agent-llm.exe`

---

## [0.2.0] - 2026-07-07

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
