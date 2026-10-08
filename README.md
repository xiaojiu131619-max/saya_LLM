# Agent LLM

Agent LLM 是一个基于 Tauri 2 + React 19 的 Windows 本地大模型启动器。它围绕 llama.cpp 的 `llama-server` 提供从「内核管理 → 模型管理 → 对话 → 对外 API」的完整本地链路：扫描本地 GGUF 模型、参数化加载推理服务、流式对话、多模态输入，并把推理能力以 OpenAI / Anthropic 兼容接口开放给局域网。

当前版本：**0.3.1**（[更新日志](CHANGELOG.md) / [下载最新版](https://github.com/xiaojiu131619-max/saya_LLM/releases/latest)）

## 功能总览

### 模型管理
- 本地 `.gguf` 模型目录扫描，自动识别分片、`mmproj` 多模态投影器、MTP / DSpark / DFlash 侧车文件
- 磁贴式模型卡片：品牌图标（内置 32 个 logo 库可自定义）、能力标签（视觉 / 音频 / 视频 / 思考 / 工具 / MTP 等）、状态与历史速度
- 每模型独立参数记忆与快速启动

### 核心更新（llama.cpp 内核）
- 应用内直接下载 ggml-org/llama.cpp 官方发布包，自动匹配本机后端：NVIDIA 用 CUDA，AMD / Intel 用 Vulkan，其余回退 CPU
- 版本化安装目录（`kernels/<版本>_<时间>/`），本机始终保留「最新 + 上一份」两个版本
- 全程 SHA256 校验 + 安装前后 `--version` 双重验证，失败自动丢弃、旧内核不受影响
- 支持 GitHub 镜像加速 / 直连下载，可配置 HTTP(S) 代理，下载可随时取消

### 模型加载与调参
- 完整暴露 llama.cpp 启动参数：GPU 卸载（ngl）、上下文（ctx）、batch、KV 缓存量化、Flash Attention、RoPE、MoE CPU 卸载等
- 启动前按内核 `--list-devices` 选择 `CUDA0` / `Vulkan0`，不再写死 CUDA 设备
- 显存预测（按模型独立校准系数）、基于实测显存的推荐参数、真实启动的自动调参（逐档搜索 ngl / ctx / KV / ncmoe）；AMD / Intel 通过 DXGI/PDH 读取显存与利用率
- 运行记录：按模型持久化启动参数与实测表现（速度、显存增量、预测偏差），供调参对比

### 对话
- 流式聊天，显示输出速度、首字延迟（TTFT）、会话上下文水位
- 多模态：图片、音频（本地重采样）、视频（ffmpeg/ffprobe 就绪时原生处理，否则自动抽帧）
- 工具调用：接入 llama-server 原生工具（文件读写、搜索、命令执行等）
- 思考模式与推测解码：内置 MTP、DSpark、DFlash 三类草稿加速

### API 中心
- 一键把 llama-server 开放为 OpenAI / Anthropic 兼容接口（监听地址、端口、Bearer Token 鉴权）
- 接口状态实时检测（`/health`、`/v1/models`、响应延迟），ctx 使用 / 输出速度 / 首字延迟 / 接口延迟实时指标
- 从接口模型列表一键添加软件内模型，自动携带能力标签

### Agent（智能体）
- 接入 DeepSeek Harness（dsh，MIT 开发者预览）：把本地模型变成带工作区、命令执行、子代理与任务审批的智能体
- 应用托管 dsh 旁路进程：环境检测、托管安装（Node.js + dsh 固定版本，pnpm 加速）、界面化开启/关闭、运行日志实时可见
- 本地模型一键接入：把当前加载的 llama-server 模型写为 dsh 默认提供方（真实对话校验），浏览器打开 dsh Web UI 即可用本地模型跑智能体任务
- 安全边界：仅在显式开启后运行，默认只连本机模型，退出应用自动回收进程树；dsh 为上游实验性版本，页面内置风险提示

### 其他
- 使用统计：token 用量、日历热力图、模型占比（设置中心）
- 深色 / 浅色 / 跟随系统主题，系统强调色同步，Win11 Mica / Win10 毛玻璃窗口材质
- 数据管理：模型扫描缓存清理、dsh 会话记录与安装仓库缓存清理、配置重置、出厂重置

## 快速开始

### 方式一：下载 Release（推荐）

1. 从 [Releases](https://github.com/xiaojiu131619-max/saya_LLM/releases/latest) 下载 `Agent_LLM_Portable_v0.4.0.zip`，解压后运行 `agent-llm.exe`
2. 进入 **设置 → 核心更新**，选择与你的硬件匹配的 llama.cpp 版本下载（NVIDIA 选 CUDA，AMD / Intel 选 Vulkan，无 GPU 时选 CPU）
3. 进入 **设置 → 模型目录**，添加包含 `.gguf` 文件的本地目录
4. 在模型页选择模型、加载，即可开始对话
5. （可选）进入 **设置 → Agent（智能体）**，安装 dsh 并把当前模型接入，即可在浏览器中使用本地智能体工作台

> 便携包只包含应用、启动脚本和用于后续下载的空资源目录，不包含 `llama-server.exe` 或 DLL。模型文件也不在本项目中。推荐到 [魔搭 ModelScope](https://www.modelscope.cn/) 搜索 `GGUF` 量化版下载；应用内的「魔搭下载」按钮可直接跳转。

### 方式二：从源码构建

环境要求：Windows 10/11、Node.js 20+、Rust stable、WebView2 Runtime。

```powershell
git clone https://github.com/xiaojiu131619-max/saya_LLM.git
cd saya_LLM/app
npm install
npm run desktop:build
```

构建产物位于 `app/src-tauri/target/release/agent-llm.exe`。首次使用同样在应用内「核心更新」页下载内核，无需手动放置 `llama-server.exe`（仓库不包含第三方预编译二进制）。

开发调试：

```powershell
npm run dev       # 浏览器预览（仅前端，无推理后端）
npm run desktop   # Tauri 桌面开发模式
npm run lint && npm run build   # 前端检查
cd src-tauri && cargo check     # Rust 检查
```

## 本机调优预设(Swift-1.5-Qwen3.8-27B)

针对本机 RTX 3080 Ti 12GB 实测定案的 Swift-1.5-Qwen3.8-27B 推理预设:

- **应用内插件**:模型工作区侧边栏 →「BeeLlama 插件」(与 ninfer 引擎同款托管模式),一键启动 / 接入 dsh / 配置编辑 / 实时日志
- 一键脚本(备选):`scripts/start-swift27b-64k.bat`、`scripts/stop-swift27b.bat`(64K 上下文 + 视觉 + k8v6 KV 量化,端口 8080)
- 调优依据、A/B 实测数据与已知坑(如当前构建下该模型 MTP 路径会拖慢约 5 倍,勿开启):[docs/guides/SWIFT27B_TUNING.md](docs/guides/SWIFT27B_TUNING.md)

## 对外 API

在 **API 中心** 打开「释放 OpenAI / Anthropic 兼容 API」后，局域网内客户端可以这样调用：

```powershell
curl.exe http://<本机局域网IP>:<端口>/v1/chat/completions `
  -H "Content-Type: application/json" `
  -H "Authorization: Bearer <API Key>" `
  --data-raw '{"model": "<模型调用名>", "messages": [{"role": "user", "content": "你好"}], "stream": false}'
```

- 监听地址以 API 中心当前配置为准；仅本机监听时无需鉴权，开放局域网监听后建议在 API 中心生成 API Key
- 每次请求需携带完整对话历史；`parallel > 1` 时上下文容量会按并发数均分

## 目录结构

```text
app/
├── src/                    # React 前端
│   ├── pages/              # 页面（聊天、模型加载、设置、核心更新、API 状态、使用统计等）
│   ├── features/           # 工作区组件（chat / model / settings / apiStatus / workspace）
│   ├── components/         # 通用组件（模型卡、气泡、Markdown 渲染等）
│   ├── lib/                # Tauri 封装与工具（desktop.ts、显存预测、媒体适配等）
│   └── context/            # 全局状态（AppContext）
├── src-tauri/              # Rust 后端
│   ├── src/commands/       # Tauri 命令（模型、服务器、更新、配置、系统）
│   ├── src/services/       # 进程管理、GGUF 解析、模型扫描、内核更新、硬件监测
│   └── src/models/         # 配置与数据结构
└── resources/              # llama.cpp 运行时（gitignore，应用内可下载）
```

## 说明

- 仓库不包含 GGUF 模型与 llama.cpp 预编译二进制；内核通过应用内「核心更新」获取（GitHub 官方源 + SHA256 校验）
- `ctx` / `ngl` / KV / batch / parallel 等推理参数的默认值是排障基线，应用不会静默修改用户设置
- 数据与缓存位置：`%APPDATA%\Roaming\AgentLLM`（config.json、model_records.json、扫描缓存），内核与运行记录不随数据重置删除
- 项目以中文为第一语言，界面与文档均为中文

## License

[MIT](LICENSE)
