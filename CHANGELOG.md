# 变更日志

本文件记录 Agent LLM 项目所有可观察的改动。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

每次发版前在对应版本段下增补条目；进行中的改动写到 `[Unreleased]` 段。

---

## [0.4.0] - 2026-09-04

接入 DeepSeek Harness（dsh）：软件从「本地模型启动器」延伸为「本地智能体工作台」。设置中心新增「Agent（智能体）」页，覆盖环境检测、托管安装、启停、日志与本地模型一键接入。dsh 以旁路进程（sidecar）方式由应用托管，仅在用户显式开启后运行，退出应用自动回收。

### 新增

**Agent（智能体）页（设置中心新标签）**

- 环境检测：Node.js 运行时、dsh 包、数据目录、Web 端口、本地模型 API、命令执行 Shell，逐项进度上报；llama-server 由外部启动时也能通过直连探测正确识别
- 托管安装：Node.js 22 LTS 便携版（SHASUMS256 校验）与固定版 `@deepseek-ai/dsh`，全程流式进度与日志、可取消；默认走 pnpm（445 包实测 40.8 秒），失败自动回退 npm 链路；未声明 engines 的包按实测锁定 Node 下限 `^22.19 || >=24`
- 进程管理：开启/关闭 dsh（Job Object 整树回收 + 退出钩子联动 + 启动前孤儿清扫），健康轮询 `GET /`，启动日志解析 Web UI 地址锚点 `dsh web: <url>`
- 运行日志：dsh stdout/stderr 实时流（与 llama 日志分离），支持实时/暂停、复制、导出、清空
- 本地模型一键接入：真实小补全校验（容忍推理模型 `reasoning_content`）→ 备份并写入 `$DSH_HOME/settings.yaml`（只维护 `agent-llm-local` 提供方与 `agent-default-model` 两键，用户其余配置原样保留）→ dsh 运行中自动重启生效；解除接入回滚干净
- 数据管理：新增「清除 dsh 会话记录」「清理 dsh 安装仓库缓存（pnpm store）」两项，与既有确认弹窗体系一致

### 变更

- 配置 `config.json` 新增 `dsh` 段（端口、锁定版本、工作区、绑定信息；serde default 平滑迁移，老配置无需改动）
- dsh 包安装工具链锁定：Node v22.23.2 便携版、pnpm@10.17.1（经托管 Node 自带 corepack）、`@deepseek-ai/dsh@0.1.1-rc.2`；升级需在界面显式操作
- pnpm 构建脚本白名单（node-pty / koffi / protobufjs 等）随安装预写，保证终端/PTY 等原生能力与 npm 安装对齐

### 安全

- dsh 为上游开发者预览版：页面常驻安全提示（实验性、可执行模型生成的命令与代码）；默认仅绑定本机回环 llama-server，无用户确认不启动、不静默自启
- 所有子进程均为参数列表调用（无 shell 拼接）；Node/dsh 下载做官方校验和验证；`settings.yaml` 写入前自动备份

---

## [Unreleased]

### 新增

- **MCP 支持三种传输方式**：除原有的 stdio（本机子进程），新增 **Streamable HTTP**（MCP 2025-03-26）与 **HTTP + SSE**（MCP 2024-11-05 旧版）两种网络传输，工具页新增「传输方式」选择器，按选择切换表单字段（stdio 填命令/参数/环境变量/工作目录，http 与 sse 填端点地址与请求头）：
  - Streamable HTTP：所有请求 POST 到同一端点，兼容 `application/json` 与 `text/event-stream`（SSE）两种响应；自动捕获并回带服务端下发的 `Mcp-Session-Id`，断开时尽力发 `DELETE` 结束会话
  - HTTP + SSE（旧版）：GET 建立 SSE 长连接，读取服务端 `endpoint` 事件下发的消息投递地址，请求 POST 到该地址、结果由长连接按 id 推送回来
  - 已用真实公网端点验证（`mcp.exa.ai`）：连接 `exa-search-server` 并正确发现 `web_search_exa` / `web_fetch_exa` / `web_search_advanced_exa` 三个工具
  - 网络传输支持自定义请求头（如 `Authorization: Bearer …`），鉴权信息不必写进 URL
- 配置 `config.json` 的 `mcp_servers` 条目新增 `transport` 与 `headers` 字段（serde default 平滑迁移，老配置按 stdio 处理，无需改动）
- **对话接入 MCP（Model Context Protocol）工具**：设置中心「工具」页现在除了 llama.cpp 原生工具，还能接入 MCP 服务器，把它们的工具交给模型在对话中直接调用。模型发起工具调用 → 应用执行 → 结果回填 → 模型继续作答，整个循环在一次回复内自动完成：
  - **「工具」页新增 MCP 服务器区块**（设置中心 → 工具，与原生工具同屏）：添加/编辑/删除服务器，支持一键连接/断开、手动刷新状态、展开查看该服务器发现的工具清单（名称、完整调用名、描述、是否可能修改数据）
  - **随对话自动连接**：勾选后应用启动即连接该服务器；未勾选的只在工具页手动连接。状态每 5 秒自动刷新，子进程意外退出会被识别并释放连接
  - **工具命名与调用**：工具以 `mcp__<服务器名>__<工具名>` 暴露给模型（自动小写并把非法字符转连字符），完全兼容 OpenAI / llama.cpp 的函数名约束；参数 schema 原样透传，模型能看到每个工具的参数结构
  - **聊天页工具调用可视化**：气泡内新增工具调用面板，显示调用了哪些工具、归属哪个服务器、传了什么参数，执行中转圈、失败标红，点击可展开查看完整返回内容
  - **多轮工具循环**：单次回复内最多连续 6 轮工具调用，达到上限会在消息里明确说明并停止，避免模型来回调用失控；可随时点「停止生成」中断
  - 仅向模型暴露**已连接**服务器的工具；工具结果单条最多 48K 字符（超出截断并注明），避免一次调用吃爆上下文
- 配置 `config.json` 新增 `mcp_servers` 数组（serde default 平滑迁移，老配置无需改动）；新增 `list_mcp_servers` / `save_mcp_server` / `delete_mcp_server` / `get_mcp_statuses` / `connect_mcp_server` / `disconnect_mcp_server` / `call_mcp_tool` 七个命令

### 修复

- **长工具调用不再阻塞其它 MCP 服务器**：`tools/call` 期间原先一直持有全局连接表锁，慢工具（如网页抓取）会让工具页状态轮询、其它服务器的连接/断开全部排队挂起；现改为全局锁只用于查表，单个连接有自己的锁，长时间调用只阻塞它自己
- **编辑已连接的 MCP 服务器后自动断开旧连接**：原先保存配置后旧进程/旧端点仍按旧命令、旧请求头继续服务，改名后工具名对不上还会报「没有工具」；现在凡是连接相关字段（名称/传输方式/命令/参数/环境变量/工作目录/请求头/超时）有变更，保存即断开，重新连接后生效
- **模型给出非法 JSON 工具参数时不再空参执行**：原先参数解析失败会静默以空参数真的调用工具；现在把解析错误连同模型原文回填给模型，让它修正后重试
- **HTTP + SSE 长连接不再 300 秒必断**：原先给长连接设的 300 秒超时实际是「整个请求」的截止时间（reqwest blocking 语义），到点无论有无数据都掉线；现改用独立客户端把总时长放宽到 30 天，连接生命周期由断开标志与读错误控制
- **工具页局部状态更新不再误标其它服务器**：连接/断开单条状态时，原先会把界面上其它仍在线的服务器一并标成「未连接」，在这个窗口发消息会漏掉它们的工具；现在状态合并只更新 payload 里出现的条目
- 其它：SSE-push 路径请求发送失败时清理等待槽位（原先挂到连接关闭）；非流式响应也解析工具调用（原先仅流式路径）；对话中止后工具记录不再永远显示「执行中」；编辑重发与首次发送的耗时统计口径统一

### 安全

- **MCP 网络端点校验**：仅允许 http / https；发请求前解析 host，拒绝 localhost 及其子域、回环、私有（10/172.16-31/192.168）、链路本地（169.254）、运营商级 NAT（100.64/10）、未指定、组播与文档地址，IPv6 同样覆盖回环、唯一本地（fc00::/7）与链路本地（fe80::/10）
- 拒绝 URL 内嵌用户名/密码，引导改用请求头；请求头键值禁止含换行（防请求头注入）；SSE 服务端下发的 endpoint 地址同样过一遍安全校验，避免借 SSE 把请求引向内网
- 已知限制：校验在 DNS 解析后进行，但仍存在 DNS rebinding 的理论窗口（校验时的解析结果与真正连接时可能不同）；本校验的目标是防止把地址指向内网服务，而非抵御恶意 DNS
- MCP 服务器是以用户权限运行的本机程序（stdio），或会把对话内容与工具参数外发的第三方服务（http/sse）；工具页常驻风险提示，说明只应添加可信来源
- stdio 子进程以**参数列表**形式启动，全程不经过 shell，参数中的空格、引号、`&`、`|`、`;` 都不会被解释
- stdio 子进程同样挂 Windows Job Object（`KILL_ON_JOB_CLOSE`），应用退出时连整棵进程树一并回收（`taskkill /T /F`），不残留孤儿进程；退出应用、关闭窗口、删除服务器配置三种路径都会断开连接
- 工具调用失败（服务器未连接、工具不存在、服务端报错、超时）都以中文错误回填给模型并标记在界面上，不会静默丢调用


- **Embedding / Rerank 模型适配 + 与对话/VLM 模型同时运行**：新增独立「向量服务」页（模型工作区侧边栏入口，与 Agent 同级）。向量与重排模型走**独立的 llama-server 进程与独立端口**（默认 8081，与对话服务的 8080 区分），因此可以和对话/VLM 模型**同时加载、同时对外提供服务**，互不干扰：
  - 启动参数：`--embeddings` 限定服务只提供向量用途；重排模型自动追加 `--rerank`；支持 `--pooling`（跟随模型默认 / none / mean / cls / last / rank）与可选 `--embd-normalize`
  - 进程隔离：独立子进程槽位、独立 Windows Job Object、独立日志缓冲与代数计数；对话服务启停、内核更新、跑分/自动调参重启都**不会**波及向量服务
  - 孤儿清扫防误杀：对话服务与向量服务共用同一个 `llama-server.exe`，原按路径清扫会误杀另一方；现改为按「当前由应用管理的 PID 集合」排除，启动任一方都保留另一方
  - 状态与日志：向量服务页实时显示运行状态、端口、模型、类型（向量/重排），提供向量服务日志区与 `/v1/embeddings`、`/rerank` 接口地址及 curl 示例
- **多模态向量嵌入（图片 / 视频）**：向量服务支持挂载 mmproj 的多模态嵌入模型（如 WeMM-Embedding-2B），可同时编码文本、图片与视频为同一向量空间：
  - 启动参数：embedding 任务保留 `--mmproj` / `--mmproj-offload`（多模态向量依赖投影），只剥离推测解码侧车（MTP/DSpark/DFlash 对嵌入无意义）
  - 媒体标记动态获取：内核**每次启动随机生成**媒体标记，写死的 `<__media__>` 永远匹配不上；就绪后从 `/props` 读取 `media_marker` 与 `modalities`，在「运行状态」中展示并用于生成正确的调用示例
  - 请求格式：`{"input":{"prompt_string":"<媒体标记><文本>","multimodal_data":["<原始 base64>"]}}`（`multimodal_data` 只接受原始 base64，不接受 data-url 或文件路径；N 个媒体需 N 个标记）
  - 视频依赖：视频帧由内核调用 ffmpeg/ffprobe 解码，前端会检测并在缺失时给出明确提示（图片向量不受影响）
  - 能力徽标：多模态嵌入模型在卡片上正确显示「视觉 / 视频候选」，不再被误判为纯文本模型
- **模型任务类型自动识别**：GGUF 解析新增 `<arch>.pooling_type` 与 `<arch>.attention.causal`，结合编码器架构白名单（bert / nomic-bert / bge / gte / e5 等）与文件名兜底，自动判定模型为 `chat` / `embedding` / `rerank`；重排模型不挂接 mmproj 与推测解码侧车，也不再显示视觉/思考/工具等对话能力徽标
- **向量模型卡片与加载页分流**：模型卡片新增「向量 / 重排」徽标；点进向量模型的参数页不再进入对话加载参数（KV 量化、投机解码对其无意义），而是给出说明并一键跳转「向量服务」页
- **ffmpeg 一键安装**：核心更新页新增「视频运行时（ffmpeg）」区块，环境检测弹窗的 ffmpeg 未就绪项也提供「一键安装 ffmpeg」按钮。点击后从 BtbN/FFmpeg-Builds 官方 release 下载静态 win64 构建，解压出 ffmpeg.exe / ffprobe.exe 安装到应用 resources 目录（`process_manager` 的媒体搜索路径之一），装好后对话服务的原生视频理解与向量服务的图片/视频向量都可直接使用：
  - 安全口径与内核更新一致：下载地址限定 GitHub 官方域名；必须拿到官方 SHA256（asset digest）并逐一比对，校验不过绝不落盘；解压走带 Zip Slip 防护的实现；安装前后都实际执行 `-version` 做功能性验证
  - 下载优先走 `api.github.com` 资产端点（部分地区 `github.com` 不可达但该端点可用），失败再回退镜像/直连；进度实时上报，可随时取消
  - 安装完成后自动重新检测，区块与检测弹窗即时变为「已就绪」
- 配置 `config.json` 新增 `embedding_port` 字段（默认 8081，serde default 平滑迁移，老配置无需改动）

- 核心更新页最下方新增「自编译核心」区块：可指定自编译 llama.cpp 的 `llama-server.exe` 完整路径（支持系统文件选择框挑选或手动填写），保存后加载模型、跑分、环境检测与本页内核状态解析都优先使用该路径；一键恢复内置版本化核心
- 自编译路径校验：仅接受绝对路径下真实存在的核心可执行文件（llama-server.exe / llama-cli.exe 等白名单文件名），路径失效时内核解析自动回退内置核心，不影响启动
- **使用详情新增「API」统计来源**：后端解析 llama-server `slot print_timing` 日志中的 token 用量，把经服务的全部请求（含对外 API、dsh 智能体等非应用内聊天入口）累加并展示为 `API · <模型>` 行；自动扣除已计入应用内聊天的 token，避免总数虚高
- **dsh 本地模型接入不再写死上下文上限**：接入时 `contextWindow` 改为读取当前 llama-server 实时启动参数（`n_ctx`），不再固定 32768；`maxTokens` 完全省略，由 dsh 按协议与模型实际能力决定，不再限制输出为 8192 —— 每次用不同 ctx 加载模型时接入值都会跟随

### 变更

- **模型管理单列卡片改回单行紧凑布局**：原来的「两行布局」（第一行名称/类型/大小/量化，第二行标签/speed/按钮）改回单行——图标、名称、类型、大小、量化、能力标签、速度、最近使用与操作按钮全部排成一行，名字过长截断让位；能力标签只显示点亮的（视觉/音频/视频/思考/工具/MTP/DSpark/DFlash/UD量化），不再显示灰色「未检测到」占位；窄窗口下按屏宽隐藏速度/标签等次要项，核心信息恒可见。列数（单列/多列磁贴）默认不变，仍可手动切换
- **对话侧边栏移除 Agent（智能体）快捷入口按钮**（Bot 图标）；智能体功能仍可从模型工作区导航进入
- **使用详情计数格式化**：令牌数（总/输入/输出/每日/排行）改为 K/M/B 缩写显示（1.24M / 512K / 8K），超过 10 位再分别用 B；平均速度与耗时等指标维持原样

- 配置 `config.json` 新增 `kernel_override_path` 字段（serde default 平滑迁移，老配置无需改动）；出厂重置会同步清空该设置

**参数页与自动调参**

- 加载参数页去掉「推荐参数」卡；「自动调参」与「运行记录」合并为一张卡，调参日志和启动/调参实测记录同屏查看
- 自动调参支持停止：顶栏按钮运行中变为「停止调参」，后端新增 `cancel_auto_tune` 命令，在测量点之间安全中断并保留已测样本
- 调参结束后自动应用最优参数（写入加载配置、tune_history 与运行记录），不再需要手动点「应用最佳参数」
- ctx 快捷定位新增 160K、200K 两档（超过模型上下文上限的档位仍自动隐藏）

**参数页布局**

- 「加载参数 / 模型信息」切换移到右上角（顶栏），删除与顶栏重复的模型头部区块，为调参和参数区留出空间
- API 调用名输入框移到顶栏模型名右侧，只保留输入框本身；输入结束（失焦/回车）自动保存，留空使用默认名

**导航与页面顺序**

- Agent（智能体）页提升为一级页面：入口在模型工作区侧边栏与聊天侧栏，设置中心不再有 Agent 标签
- Agent 页内「本地模型接入」上移到「环境检测」上方，紧跟运行状态卡
- 设置中心顺序调整：「模型主题」「数据管理」排到「工具」下方

**模型管理**

- 单列模型列表改为两行布局：第一行是模型名称、类型、大小、量化等级，第二行是能力标签、tok/s 与快速启动/对话/文件按钮；窄窗口下不再按断点隐藏信息
- 单列卡片第二行的能力标签与速度改为右对齐，与右侧操作按钮排在一起

**超宽 / 超窄窗口适配**

- 超宽屏（视口 ≥1600px）：模型管理、加载参数页内容上限 1180→1520px，API 状态与 llama 日志页 1024→1360px，聊天消息列与输入框 768→896px，减少两侧留白
- 超窄窗口（≤900px）：模型工作区与设置中心左侧边栏 240→208px，给内容区让出宽度
- 加载参数页顶栏改为按内容区实际宽度（container query）切换横排/竖排，不再依赖视口断点：模型名与 API 调用名输入框恒在同一行，名字过长自动截断让位，输入框不再被挤瘪或换行，宽度有余时自动加宽

**界面顺序与设置中心整理**

- API 状态页不再全屏独占：改为与「llama 日志」一致、保留左侧边栏的内嵌展示，从侧边栏「服务状态」卡进入
- API 状态页只保留状态本体；对外 API 的开关、端口与 API Key 设置移入「软件设置」
- API 状态页去掉「最新运行日志」；完整 llama-server 日志仍从侧边栏「llama 日志」进入
- 取消「监听地址」单独配置：开启对外 API 自动监听 `0.0.0.0`（局域网可访问），关闭则保持 `127.0.0.1`（仅本机）
- 设置中心重新整理：「设置」更名「软件设置」；「模型主题」「数据管理（数据清除）」各自独立成页
- 移除「服务控制」（与核心更新重复），环境检测移入「核心更新」页
- 「下载代理」移入软件设置并更名「软件代理」，语义覆盖核心更新与 dsh 下载链路

### 修复

- **代码审查修复（向量服务 / ffmpeg 安装）**：
  - 向量服务的 Windows Job Object 在重新启动时不再泄漏句柄：覆盖全局句柄前先终止并关闭上一次的 Job Object
  - 多模态嵌入缺 ffmpeg/ffprobe 时在向量服务日志里给出可见提示（图片向量不受影响，仅视频会解码失败），不再静默
  - `pooling_type` 遇到未知枚举整数时留空，不再伪造 `unspecified`（避免被误当成有效池化方式）
  - 修正 5 处函数/结构体声明与首条语句挤在同一行、以及两段文档注释粘连的格式问题
  - 向量服务页切换模型时重置池化方式改为在选择动作内完成，消除 effect 内同步 setState 的级联渲染；服务就绪后状态轮询由 1.5s 放宽到 5s
  - 多模态调用示例在媒体标记尚未就绪时给出明确警告占位，避免复制出必然失败的示例
- **b10883 内核模型加载必失败（`error: invalid argument: --mmap`）**：llama.cpp b10883 移除了独立的 `--mmap`/`--no-mmap`/`--mlock` 旗标，功能并入 `-lm/--load-mode`，而应用仍无条件传旧旗标，llama-server 在参数解析阶段直接退出，GPU 尝试与 CPU 兼容重试接连挂掉（UI 里切 mmap 开关也无效，`--no-mmap` 同样被移除）。现在以内核二进制中的 `--load-mode` 参数标记做能力探测，自动选择新旧写法：探测不到标记的老内核（b10687、spark 自编译等）沿用旧旗标，新内核按 `mmap`/`mlock` 组合一一映射为 `mmap` / `mmap+mlock` / `mlock` / `none`；加载与跑分两条启动链路都已修正
- **多模态投影（mmproj）误配导致模型加载失败**：平铺模型目录里任何一个 `mmproj-*.gguf`（如 Qwen 的视觉投影）都会被自动挂到目录内所有模型上，架构不匹配时 llama-server 报 `mismatch between text model (n_embd) and mmproj (n_embd)` 直接退出（典型受害者：Spark-X2.5-4B）。现在扫描器会用 mmproj 的 `clip.vision/audio.projection_dim` 与主模型 `embedding_length` 做维度级配对校验，不匹配不再挂载；无该元数据的旧 mmproj 仍保持放行，由加载时校验兜底
- 扫描缓存版本升至 v22：老缓存中的错误 mmproj 配对会自动失效重扫，无需手动清理
- 同类宽度适配问题排查修复：参数行两列布局（标签列 220→160px 下限）在视口刚过 lg、侧边栏挤压内容时不再裁掉输入框；模型信息页四格卡改在内容区足够宽时才展开四列（md→lg）；单列模型卡第一行不再因长模型名把类型/大小/量化挤到第二行（名字截断让位）；软件设置新生成的 API Key 与 Agent 页 Web UI 地址截断时补上悬浮全文
- 窄宽度下参数页多处文案被裁切：空闲自动卸载说明、复选框标签、运行记录备注、调参日志、预测缺表头提示等改为换行显示
- 跟随系统主题时，左下角主题切换按钮点击无效（被跟随系统的逻辑立即覆盖）；现在手动切换会自动转为显式主题
- 主题切换按钮深色状态下图标几乎不可见（近背景色图标 + 过亮描边）
- 聊天中展开思考框后被流式输出持续拽到页面底部、无法折叠：展开/收起思考框立即脱离自动滚动，滚轮向上也可随时脱离
- 浅色主题下输入框发送按钮激活态图标与背景同色、按钮看似消失

### 文档修正

- 修正 v0.3.1 的缓存版本记录：发布代码中的 `SCANNER_VERSION` 实际为 `21`，不是条目中写的 `20`
- 修正 v0.3.1 验证说明：无 NVIDIA 时按 AMD/Intel Vulkan 或 CPU 后端匹配设备，不会继续按 CUDA 包选择
- 修正 v0.2.0 后续待办状态：聊天虚拟化、Markdown memo、拖拽清理、UUID、错误截断、API Key 迁移清理，以及 API Key 日志脱敏、路径/可执行文件校验、Job Object、原生解压等已在后续代码中落地；当前安全事项应按现存命令重新审计
- 修正已删除模块的引用：`ModelDownloadPanel` 已在 v0.3.0 删除，旧 lint 条目和模型下载断点续传不再适用于当前代码
- 修正更新功能位置：`list_recent_releases` 位于 `app/src/lib/desktop.ts` 和 Rust updater 链路，不在 `chatUtils.ts`

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
