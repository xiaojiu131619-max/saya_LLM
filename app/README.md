# Agent LLM

Agent LLM 是一个基于 React/Vite + Tauri 的本地 GGUF 模型启动器。当前项目已经接入从 Llama Desktop 复制来的 Tauri 后端和 llama.cpp 运行文件，可以在桌面版中扫描本地 `.gguf` 模型、启动 `llama-server.exe`、进行流式聊天，并读取基础硬件状态。

## 已接入的本地能力

- Tauri 桌面壳：`app/src-tauri`
- llama.cpp 运行文件：`app/resources/llama-server.exe` 和所需 DLL
- GGUF 模型目录扫描：设置页选择目录后刷新模型列表
- 模型启动：加载页会把前端参数映射给 `llama-server`
- 聊天推理：桌面版会请求 `http://127.0.0.1:8080/v1/chat/completions`
- 系统监控：桌面版优先读取真实 RAM/GPU/VRAM 状态，浏览器预览使用模拟数据

## 环境要求

- Windows 10/11
- Node.js 20+
- Rust stable toolchain
- Microsoft Edge WebView2 Runtime
- 至少一个本地 `.gguf` 模型文件

## 准备 llama.cpp 运行文件

仓库不包含 `app/resources/` 下的 llama.cpp 预编译二进制（DLL/EXE 体积大且为第三方产物，已加入 .gitignore）。首次 clone 后需要自行补齐：

1. 前往 [llama.cpp Releases](https://github.com/ggml-org/llama.cpp/releases) 下载对应平台的预编译包，例如 Windows + CUDA 版本 `llama-bxxxx-bin-win-cuda-x64.zip`。
2. 解压后把里面的 `*.dll` 和 `*.exe`（至少包含 `llama-server.exe`、`ggml*.dll`、`llama*.dll`、`mtmd.dll`）拷贝到 `app/resources/`。
3. CUDA 版还需要 NVIDIA CUDA 运行时（`cudart64_*.dll` 等），可以从 NVIDIA 官方驱动或 CUDA Toolkit 获取。

桌面端启动模型时会从 `app/resources/llama-server.exe` 加载推理后端。

## 安装依赖

```powershell
cd D:\Projects\Agent_LLM\app
npm install
```

## 浏览器预览

浏览器模式只用于前端预览，不能启动真实本地推理后端。

```powershell
npm run dev
```

打开 [http://127.0.0.1:3000](http://127.0.0.1:3000)。

## 桌面开发运行

桌面模式会启用 Tauri IPC、模型扫描、硬件监控和 `llama-server` 启动能力。

```powershell
npm run desktop
```

启动后进入「设置」页，点击「选择目录」，选择包含 `.gguf` 文件的目录，然后回到「模型管理」选择模型并点击「加载模型」。

## 构建

```powershell
npm run desktop:build
```

构建成功后，可执行文件位于：

```text
D:\Projects\Agent_LLM\app\src-tauri\target\release\agent-llm.exe
```

## 常用检查

```powershell
npm run lint
npm run build
npm audit
cd src-tauri
cargo check
```

## 注意

- 项目默认不内置 GGUF 模型文件，需要用户在设置页添加本地模型目录。
- `app/resources/` 下的 llama.cpp 预编译二进制已被忽略，需要自行从上游 release 补齐，详见上面的「准备 llama.cpp 运行文件」。
- `src-tauri/target` 是 Rust 构建产物，已被忽略，不需要提交。
