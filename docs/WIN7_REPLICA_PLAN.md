# Agent LLM Windows 7 复刻落地计划书

> 目标：在 Windows 7 SP1 x64 上复刻当前 `D:\Projects\Agent_LLM`（v0.4.0）的能力——本地 GGUF 模型启动器 + 对话工作台 + 对外 API。
> 本文是**反推文档**：先由现有代码与依赖树反推出「被复刻对象」，再逐项判定在 Win7 上的处置方式，最后给出可执行的分阶段计划。
> 所有版本边界均已核实到具体出处，见第 3 节与第 8 节。
> 结论如需一句话：**可行，但必须「冻结版本 + 换内核分发策略」，且有且仅有一个 go/no-go 关卡（P0）。**

---

## 1. 可行性判定

### 1.1 三条路线对比

| 路线 | 做法 | 工作量 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| **A. 冻结式移植（推荐）** | fork 现有代码，把 Tauri 钉在 2.11.x、Rust 钉在 1.77.2，内置 WebView2 109 固定版运行时，逐一降级 Win7 不兼容 crate | 中（约 8–9 周） | 中：依赖树需持续对抗升级 | **主路线** |
| B. 后端 + 浏览器 | 把 Rust 后端做成托盘程序，React 前端用本地 HTTP 提供，用户在 Chrome 109 / Edge 109 里打开 | 中低 | 中高：Win7 浏览器本身也停更，依赖用户环境 | 备选（P0 失败时启用） |
| C. .NET Framework 4.8 重写 | 用 WPF（.NET Framework 4.8 官方支持 Win7 SP1）+ WebView2 109 重写前端 | 高（38.5K 行全重写） | 低技术风险、高人力风险 | 不推荐 |

**为何路线 A 可行且成本最低**：现有代码有两处「恰好卡在边界内」的巧合，这不是运气，而是可直接利用的起点。

- `app/src-tauri/Cargo.toml:9` 已声明 `rust-version = "1.77.2"` —— 这正是**最后一个**把 `x86_64-pc-windows-msvc` 保持为 Tier 1 且支持 Win7 的 Rust 版本（1.78 起最低要求升到 Windows 10）。
- `Cargo.toml:21` 用的是 `tauri = "2.11.1"` —— 这正好是**最后一个**半官方支持 Win7 的 Tauri 版本（2.12 起 MSRV 越过 1.77，不再保证）。

也就是说，**不需要降级 Tauri 主版本**，只需挡住后续升级 + 清理少数几个越界的传递依赖。

### 1.2 唯一的 go/no-go 关卡

P0 必须在**真实 Win7 SP1 x64 机器**（非虚拟机优先，VM 次之）上验证以下四件事同时成立，任一失败则转路线 B：

1. Rust 1.77.2 编译出的空壳 Tauri 应用能启动并渲染出窗口；
2. 内置 WebView2 **固定版 109** 能加载前端（绕开 bootstrapper，见 3.4）；
3. 依赖树中 `windows-sys < 0.61`、`getrandom 0.2.x` 两个约束可解（见 3.3）；
4. 自编译的 llama-server（Vulkan 或 CUDA ≤11.4）能在该机器上加载并推理一个 GGUF。

第 4 项是产品价值的地基，务必在 P0 就打通，否则后面全部白做。

---

## 2. 被复刻对象（反推清单）

### 2.1 规模与形态

| 项 | 实测值 |
| --- | --- |
| 前端 + 后端源码 | 约 38,500 行（TS / TSX / Rust / CSS） |
| Tauri IPC 命令 | 约 100 条，分布在 11 个命令域 |
| 前端页面 | 14 个（`app/src/pages/`） |
| 后端命令域 | benchmark、config、dsh、env_check、hardware、mcp、model、server、system、updater |
| 后端服务 | auto_updater、benchmark、dsh_*、embedding_manager、ffmpeg_installer、gguf_parser、gpu_monitor、mcp_*、memory_monitor、model_scanner、process_manager |
| 打包形态 | 便携 zip（仅含 exe + bat + 空 `_up_/resources`）+ Tauri 安装包 |

### 2.2 技术栈（反推）

| 层 | 现状 | Win7 处置 |
| --- | --- | --- |
| 桌面框架 | Tauri 2.11.1 + 托盘 | **冻结在 2.11.x**，禁止升级 |
| 编译器 | Rust（声明 1.77.2） | **锁定 1.77.2**，用 `rust-toolchain.toml` 固化 |
| MSVC | VS 2022 | 工具集须 ≤ 14.38（VS 17.8）或 14.29（VS 2019），见 3.5 |
| 前端 | React 19.2 + TS 5.9 + Vite 7.2 | 保留（Chromium 109 可跑，需实测 polyfill） |
| 样式 | Tailwind 3.4 + 自定义 CSS（Fluent token、Mica、亚克力） | **降级**：去 Mica/透明，见 3.6 |
| 动效/图表 | framer-motion 12、recharts 2.15 | 保留，注意 Chromium 109 兼容 |
| 虚拟列表 | @tanstack/react-virtual | 保留 |
| 图标 | lucide-react、@lobehub/icons | 保留 |
| 文本渲染 | highlight.js + 自研 Markdown 解析 | 保留 |
| IPC | @tauri-apps/api 2.11 + dialog 插件 | 保留 |
| 持久化 | localStorage + `%APPDATA%\AgentLLM\` | 保留（路径一致） |
| HTTP | reqwest（rustls） | 保留，但需审 `getrandom` |
| GPU 监测 | NVML；回退 DXGI + PDH | 保留（Win7 上两条路都可用） |
| 凭据 | keyring 3.6 `windows-native` | 保留（凭据管理器 API Win7 有） |
| 诊断 | nvml-wrapper、sysinfo、rayon | 需逐个验证 |

### 2.3 核心能力链路（必须在 Win7 上等价成立）

```text
扫描 .gguf（gguf_parser 手写解析 v3 表头，含 MoE / MTP / 多模态字段）
  → 解析架构量化分片，缓存到 %APPDATA%\AgentLLM\cache（SCANNER_VERSION 21）
  → 显存估算 + 运行记录校准（model_records.json）
  → 组装参数（ctx / ngl / KV 量化 / batch / parallel / 投机解码）
  → 准备内核（版本化 kernels 目录，或 kernel_override_path 指向自编译核心）
  → spawn llama-server，读 stdout/stderr + 轮询 /health
  → 前端 SSE 流式对话 /v1/chat/completions
  → 会话持久化 + 用量统计（含 slot print_timing 解析）
```

**这条链路里除「内核从哪来」之外，其余在 Win7 上不需要改语义**——这正是复刻成本可控的原因。

---

## 3. 版本与依赖硬边界（本计划的核心）

### 3.1 已核实的生态截止线

| 组件 | 最后支持 Win7 的版本 | 之后的断点 | 出处 |
| --- | --- | --- | --- |
| Rust（tier-1 Windows 目标） | **1.77.2** | 1.78 起最低要求 Windows 10 | Rust 1.78 release notes / 「Updated baseline standards for Windows targets」 |
| Tauri | **2.11.x** | 2.12 起 MSRV 越过 1.77，不再保证 Win7 | tauri-apps/tauri#12550 |
| WebView2 Runtime | **109.0.1518.x** | 110+ 在 Win7 上拒绝启动 | Windows Blogs「Edge/WebView2 ending support for Windows 7」 |
| WebView2 SDK | **< 1.0.1519.0** | 1.0.1519.0+ 不再支持 Win7 | 同上 |
| MSVC 工具集 | **14.38（VS 17.8）** | 14.40（17.10）移除 Win7 目标；14.50（VS 2026）永久移除 | microsoft/STL#4858、VS 2022 changelog |
| VC++ 可再发行包 | VS 2022 系列的 redist 仍可在 Win7 使用 | 要求 Win8+ 的变更随 VS 2026（14.50）落地 | 「Microsoft C++ Build Tools, Redistributable FAQ」、microsoft/STL#4858 |
| Visual Studio（在 Win7 上运行） | **17.6 LTSC** | 17.7 起无法在 Win7 安装 | MS 支持文章「VS 2022 unsupported OS」 |
| NVIDIA 驱动 | **475.14**（2024-07，仅安全更新） | Game Ready 自 2021-10 起只服务 Win10/11 | NVIDIA 驱动详情页 |
| AMD 驱动 | **Adrenalin 22.6.1 for Win7** | 后续版本停发 | AMD 发行说明 RN-RAD-WIN-22-6-1-WIN7 |
| CUDA（可用驱动上限） | **≤ 11.4** | 驱动 475.14 是 Win7 上限，对应 CUDA 11.4（需 ≥472.50）；11.8 需 520.06，Win7 无此驱动 | CUDA 11.8 系统要求表 |
| Node.js（官方） | **13.14.0** | 官方 14 起不再支持；社区 hack 后可用 16.20.2 / 18.18.2 / 20.2.0 | nodejs/help#3878 |
| Electron（参考） | **22.x** | 23 起（Chromium 110）不支持 Win7 | Electron 官方弃用公告 |

### 3.2 两个「必须打赢」的依赖战役

当前 `app/src-tauri/Cargo.lock` 里已能看到两个越界依赖，它们不会在编译期报错，只会在 Win7 运行期以「找不到 DLL 入口点」的形式崩溃——**必须先降下来，否则 P0 无法通过**。

**战役一：`windows-sys >= 0.61` 破坏 Win7**

- 症状：程序启动即报 `无法定位程序输入点 ... 于动态链接库 combase.dll`，或 `combase.dll: cannot open shared object file`。
- 根因：windows-rs PR #3743 把部分 COM API 从 `ole32.dll` 改链到 `combase.dll`（Win8+ 才有）。**0.60.2 是最后一个可用版本**，见 microsoft/windows-rs#3808。
- 本项目实测引入路径（`cargo tree -i windows-sys@0.61.2`）：
  - `dirs-sys 0.5.0` ← `dirs 6.0.0` ← `tauri 2.11.1` / `tauri-build 2.6.1`
  - `mio 1.2.0` ← `tokio 1.52.3` ← `reqwest` / `hyper` / 自身
- 注意：项目自身声明的是 `dirs = "5.0"`（锁定 5.0.1），越界的 `dirs 6.0.0` 是 **Tauri 传递进来的**，光改自己的 Cargo.toml 没用。
- 处置：把 `mio` 钉到使用 `windows-sys 0.60.x` 的版本、把 `dirs` 钉到 5.x；必要时对 `dirs-sys` 打 patch。应急手段是自定义 `win7com` 模块用 `windows_link!` 显式重链 `ole32.dll`（社区已验证可行）。
- 附带好消息：项目自用的 `windows = "0.61"`（锁定 0.61.3）**没问题**——断点在 0.62。

**战役二：`getrandom >= 0.3` 调用 Win10 专属 ProcessPrng**

- 症状：启动即报 `无法定位程序输入点 ProcessPrng 于动态链接库 bcryptprimitives.dll`。
- 根因：getrandom 0.3+ 在普通 `*-windows-*` 目标上无条件使用 `ProcessPrng`（Windows 10 引入）。Windows 7 上必须走 `RtlGenRandom`。
- 本项目实测：锁定文件同时存在 `getrandom 0.2.17`（安全）、`0.3.4`、`0.4.2`（**危险**）。
- 处置：全树收敛到 `getrandom 0.2.15+`（0.2 分支保持 `RtlGenRandom`）。这通常意味着钉住引入 0.3+ 的上游（`rand`、`tungstenite`、部分 TLS/HTTP 栈），社区做法是降 `tungstenite` 到 0.23.1 一类。
- 关联：`ring 0.17.14`、`reqwest 0.12` / `0.13`（rustls）需在 P1 逐一实测；rustls 链路本身在 Win7 可用（tauri 的 http 插件在 Win7 工作正常即为例证）。

### 3.3 依赖钉版清单（P1 的交付物）

`app/src-tauri/Cargo.toml` 需要的约束（示意，具体 `--precise` 版本在 P1 由 `cargo tree` 收敛后写定）：

```toml
# Win7 兼容底线：勿升级
rust-version = "1.77.2"
tauri = "=2.11.1"

# 禁止越界的传递依赖
[target.'cfg(windows)'.dependencies]
windows = "=0.61.3"          # 0.62 起组合链接 combase.dll

[patch.crates-io]
# 视 P1 收敛结果决定是否需要，用于强制 windows-sys < 0.61
```

```bash
# 收敛辅助命令（每次 cargo update 后重跑）
cargo tree -i windows-sys@0.61.2   # 必须无输出
cargo tree -i getrandom@0.3.4      # 必须无输出
cargo tree -i getrandom@0.4.2      # 必须无输出
```

**防回归要求**：提交 `Cargo.lock`（不忽略），并在 CI 或本地加一条守卫脚本，一旦出现 `windows-sys >= 0.61` 或 `getrandom >= 0.3` 就报错。

### 3.4 WebView2 分发（决定能否启动）

Tauri 默认的 `downloadBootstrapper` 在 Win7 上**装不了**——bootstrapper 会以 `GetPackagesByPackageFamily` 找不到入口点而崩溃。必须改用**固定版运行时**：

1. 从微软官方下载 WebView2 Fixed Version **109.0.1518.x**（x64），解压到应用目录；
2. `tauri.conf.json` 配置 `bundle.windows.webviewInstallMode = { type: "fixedRuntime", path: ... }`；
3. 在 `tauri::Builder` 运行**之前**设置环境变量 `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` 指向该固定运行时目录——否则 wry 的版本探测走的是系统注册表，即使固定运行时就在旁边也会弹「找不到 WebView2 Runtime」（tauri-apps/tauri#13817）。

配置示意：

```json
{
  "bundle": {
    "windows": {
      "webviewInstallMode": {
        "type": "fixedRuntime",
        "path": "./Microsoft.WebView2.FixedVersionRuntime.109.0.1518.78.x64/"
      },
      "nsis": { "installMode": "currentUser" }
    }
  }
}
```

代价：安装包增大约 180MB。若要压体积，可改用「首次运行检测 + 手动引导安装 109」的折中，但体验会差。

### 3.5 构建环境

| 项 | 要求 | 说明 |
| --- | --- | --- |
| 开发机 OS | Win10/11 交叉编译即可 | 不必在 Win7 本机构建 |
| Rust | `rustup default 1.77.2-x86_64-pc-windows-msvc` | 用 `rust-toolchain.toml` 固化，避免误用新版 |
| Visual Studio | VS 2022 **≤ 17.9**（取 17.8 稳妥）或 VS 2019 16.11 | 需要工具集 14.29 / 14.38 |
| CRT 链接方式 | 建议 **静态链接**（`-C target-feature=+crt-static`） | 省掉目标机安装 VC++ redist 的前置依赖；动态链接则需随包分发与工具集匹配的 redist |
| Node（仅前端构建） | 18/20 均可 | 前端产物是静态文件，与目标机 Node 无关 |
| 测试机 | **真实 Win7 SP1 x64**，装 475.14 / 22.6.1 驱动 | 装 VC++ 2017-2019 redist（14.29）便于对照 |

**不要走 `x86_64-win7-windows-msvc`（Tier 3）目标**：windows-rs 系 crate 无法为该 target 编译，会让你陷入无解的依赖地狱。用常规 `x86_64-pc-windows-msvc` + Rust 1.77.2 即可产出可在 Win7 运行（且 Win10/11 也能跑）的单一二进制。

### 3.6 UI 视觉降级清单

| 现状 | Win7 问题 | 处置 |
| --- | --- | --- |
| `windowEffects: ["mica"]` | Mica 是 Win11 专属 | 移除该配置；项目已有毛玻璃 Blur 回退，Win7 上进一步退纯色 |
| `transparent: true` + `decorations: false` | 无边框透明窗口在 Win7 需自绘/`DwmExtendFrame`，性能差且易闪影 | 改为 `transparent: false`，恢复系统边框 + 自绘标题栏降级 |
| `backdrop-filter` 亚克力浮层 | Chromium 109 支持，但 Win7 无 GPU 合成时卡顿 | 保留但补纯色回退，默认关闭 |
| 系统强调色（DWM accent） | Win7 注册表键与取值不同 | 读取失败时回退默认 `#0078D4`（现有 CSS 已有该默认值） |
| 深浅色跟随系统 | Win7 无系统级浅色/深色 | 默认浅色，仅保留手动切换 |

---

## 4. 目标架构（Win7 版）

```text
┌──────────────────────────────────────────────────────────┐
│ Tauri 2.11 WebView  (内置 WebView2 固定版 109)            │
│ React 19 ─ AppContext ─ localStorage                     │
│   Mica/透明 已移除，纯色 + 系统边框                        │
└──────────────┬───────────────────────────────────────────┘
               │ Tauri IPC + localhost HTTP/SSE
┌──────────────▼───────────────────────────────────────────┐
│ Rust 1.77.2 Backend (静态 CRT)                            │
│   ├─ process_manager ─ llama-server  ← 自编译内核为主      │
│   ├─ model_scanner ─ gguf_parser                          │
│   ├─ gpu_monitor ─ NVML 0.10 / DXGI+PDH（Win7 均可用）    │
│   └─ updater ─ 改为「自编译 + 本地导入」，弱化在线匹配      │
└──────────────┬───────────────────────────────────────────┘
               ▼
   llama-server.exe（自编译）
      ├─ Vulkan 内核（首选，驱动 475.14 满足）
      └─ CUDA ≤ 11.4 内核（NVIDIA 可选，性能更好）
```

---

## 5. 功能处置表（保留 / 改造 / 砍掉）

| # | 模块 / 页面 | 现状 | Win7 处置 | 理由 |
| --- | --- | --- | --- | --- |
| 1 | 首页 / 模型选择 | — | **保留** | 无平台依赖 |
| 2 | 模型加载参数页 | — | **保留** | 无平台依赖；参数语义一律不动（遵循 AGENTS.md） |
| 3 | 对话页（SSE 流式） | — | **保留** | 核心价值 |
| 4 | 向量服务（embedding/rerank） | 独立端口 8081 | **保留** | 纯 llama-server，无平台依赖 |
| 5 | 多模态（图片/音频/视频） | ffmpeg 原生处理 | **保留，降级** | 视频需 ffmpeg；BtbN 新构建可能不兼容 Win7，需改用旧版 ffmpeg 4.4 |
| 6 | 工具页 · llama.cpp 原生工具 | — | **保留** | 无平台依赖 |
| 7 | 工具页 · MCP（stdio / HTTP / SSE） | — | **保留（需实测）** | rustls 链路在 Win7 可用；stdio 子进程用 Job Object，Win7 支持 |
| 8 | 核心更新页 | GitHub Releases 在线匹配 | **改造** | 官方 prebuilt 已无 Win7 可用变体，改以「自编译核心 + 本地导入」为主路径 |
| 9 | 自编译核心（kernel_override_path） | 已有 | **提升为一等公民** | 现存机制正好是 Win7 方案的核心 |
| 10 | 跑分 / 自动调参 | — | **保留** | 无平台依赖 |
| 11 | 用量统计（recharts） | — | **保留** | 需验 Chromium 109 渲染 |
| 12 | llama 日志 / 系统日志 | — | **保留** | 无平台依赖 |
| 13 | 数据管理页 | — | **保留** | 无平台依赖 |
| 14 | 软件设置 / 模型主题 | — | **保留** | 去掉 Mica 相关项 |
| 15 | 系统状态浮层 | NVML / DXGI / PDH | **保留** | Win7 三条路都通 |
| 16 | **Agent 智能体页（dsh）** | 托管 Node 22 LTS | **砍掉** | dsh 要求 Node `^22.19 \|\| >=24`，Node 22 不支持 Win7；社区 hack 上限也只到 20.2.0 |
| 17 | API key 安全存储 | keyring windows-native | **保留** | 凭据管理器 API Win7 具备 |
| 18 | 单实例 / 托盘 | — | **保留** | Win7 支持 |
| 19 | 软件自更新 | — | **改造或关闭** | 依赖同一套内核匹配逻辑；Win7 版建议只保留「检查提示 + 手动替换」 |
| 20 | Mica / 透明 / 无边框 | — | **改造** | 见 3.6 |

第 16 项是唯一的「功能级不可行」，必须在需求上明确告知使用者：**Win7 版没有智能体（dsh）能力**。

---

## 6. 分阶段落地计划

### P0 · 最小可运行验证（go/no-go）｜2–3 天

**目标**：在真实 Win7 SP1 x64 上跑起一个空壳 Tauri 应用并加载前端。

- [ ] 装 Rust 1.77.2，写 `rust-toolchain.toml` 固化
- [ ] 建最小 Tauri 2.11 空壳工程，`tauri build` 产出 exe
- [ ] 内置 WebView2 109 固定版运行时 + 设 `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER`
- [ ] 在 Win7 上启动，窗口渲染出"Hello"即通过
- [ ] 自编译一个 llama-server（先 Vulkan），在 Win7 上加载并推理一个 GGUF

**验收**：四件事同时成立。任一失败 → 评估路线 B（后端 + 浏览器）。

### P1 · 依赖收敛与全量构建通过｜1 周

**目标**：现有 38.5K 行代码在 Win7 目标下编译通过并能启动到主界面。

- [ ] 按 3.2 打掉 `windows-sys ≥ 0.61`（dirs / mio 两条路径）
- [ ] 按 3.2 把 `getrandom` 收敛到 0.2.x
- [ ] 逐一验证 ring / rustls / nvml-wrapper / keyring / sysinfo / zip / reqwest 在 Win7 可用
- [ ] 提交 `Cargo.lock`，加依赖守卫脚本
- [ ] 用静态 CRT（`+crt-static`）产出 exe

**验收**：Win7 上启动无「找不到入口点」类报错，能进主界面。**这是本计划技术风险最集中的阶段。**

### P2 · 核心链路打通｜2 周

- [ ] 模型扫描 + GGUF 解析（含分片、MoE、MTP、多模态字段）在 Win7 正确
- [ ] `process_manager` 能按自编译路径启动/监控/终止 llama-server
- [ ] 对话 SSE 流式链路端到端可用
- [ ] 会话持久化与用量统计正确
- [ ] 显存估算 + 运行记录校准可用

**验收**：能完整走通「选模型 → 加载 → 对话 → 看到用量」全流程。

### P3 · 硬件与内核路线｜1.5 周

- [ ] GPU 监测：NVML（475.14 驱动）与 DXGI + PDH 两条路在 Win7 实测
- [ ] 自编译 Vulkan 内核并在 AMD/NVIDIA 上验证
- [ ] 自编译 CUDA ≤ 11.4 内核（NVIDIA 可选路径）
- [ ] 内核更新页改造为「自编译 + 本地导入」为主
- [ ] 环境检测的「内核后端与本机显卡不匹配」提示在 Win7 语义正确

**验收**：NVIDIA 与 AMD 各一台机器能 GPU 加速加载。

### P4 · UI 适配｜1 周

- [ ] 按 3.6 移除 Mica/透明，恢复系统边框
- [ ] 强调色读取失败回退默认蓝
- [ ] 超宽/超窄断点、容器查询在 Chromium 109 复测
- [ ] 动效与图表在 Win7 低配机上不卡顿

**验收**：不用改功能即可在 Win7 上正常阅读与操作。

### P5 · 功能切割与回归｜1 周

- [ ] 摘除 dsh 智能体页及其命令域与托管安装逻辑
- [ ] ffmpeg 一键安装改指向 Win7 可用版本
- [ ] 自更新改为弱化模式
- [ ] 全量回归：每页每命令在 Win7 点一遍
- [ ] 更新环境检测项的判定逻辑（Node/ffmpeg/CUDA 版本要求）

**验收**：无死按钮、无指向不可用能力的入口。

### P6 · 打包与交付｜1 周

- [ ] NSIS 安装包（fixedRuntime 模式）+ 便携 zip 双形态
- [ ] 便携包结构对齐现有约定（exe + bat + 空 `_up_/resources`）
- [ ] 在纯净 Win7 SP1（无 WebView2、无 VC++ 运行库）上装机验证
- [ ] 出 Win7 版 README / 装机说明 / 已知限制
- [ ] 更新 `CHANGELOG.md` 与 `docs/TECHNICAL_REPORT.md`

**验收**：一台干净 Win7 装完即用，无需用户额外装任何运行时。

**合计：约 8–9 周**（单人全职，不含需求返工）。

---

## 7. 风险登记册

| 编号 | 风险 | 概率 | 影响 | 触发症状 | 应对 |
| --- | --- | --- | --- | --- | --- |
| R1 | 依赖树无法收敛到 `windows-sys < 0.61` | 中 | 致命 | 启动报 combase.dll 入口点缺失 | 优先钉 `mio`/`dirs` 版本；退一步用 `windows_link!` 自建 `win7com` 重链 ole32；再退转路线 B |
| R2 | 某 crate 硬依赖 `getrandom ≥ 0.3` | 中高 | 致命 | 报 ProcessPrng 于 bcryptprimitives.dll | 降上游（如 tungstenite 0.23.1）；或换实现；**注意 `rand` 生态整体在推 0.3+** |
| R3 | Tauri 2.11 仍有未发现的 Win7 不兼容点 | 中 | 高 | 各种入口点缺失 / 静默崩溃 | P0 提前暴露；社区已有可用模板（xialeistudio/tauri-template）可对照 |
| R4 | WebView2 固定版 109 加载前端失败或渲染异常 | 中低 | 高 | 白屏 / 「找不到 WebView2 Runtime」 | 务必设环境变量（3.4）；确认 Chromium 109 支持前端所用 API |
| R5 | 官方 prebuilt 内核在 Win7 全线不可用 | **高** | 中 | llama-server 启动缺 DLL | 已预设为「自编译」策略，见 P3；Vulkan 优先 |
| R6 | CUDA 版本选择错误 | 中 | 中 | CUDA 初始化失败或驱动不匹配 | 严格限定 CUDA ≤ 11.4，驱动 475.14；不确定就用 Vulkan |
| R7 | llama.cpp 新版本源码无法为 Win7 编译 | 中 | 中 | 链接或 CRT 错误 | 用较旧 tag 作为内核基线，或打 `_WIN32_WINNT` 兼容补丁；静态 CRT |
| R8 | 38.5K 行里散布的 Win10+ API 调用 | 中 | 中 | 运行期崩溃 | P1 用依赖树 + 运行期覆盖测试兜底；已确认 Job Object 系 API 在 Win7 可用 |
| R9 | ffmpeg 新构建不兼容 Win7 | 中 | 低 | ffmpeg -version 崩溃 | 改用 ffmpeg 4.4 静态构建 |
| R10 | Win7 机器性能不足，体验落差 | 中 | 中 | 加载慢、UI 卡 | UI 降级（3.6）+ 默认 CPU 友好参数；文档明示硬件建议 |

---

## 8. 关键结论备忘（备查）

容易被误记或误判的几条，写在这里防止后续返工：

1. **Rust 1.77.2 是硬上限**，不是建议值。升级到 1.78 即失去 Win7 Tier 1 支持。必须用 `rust-toolchain.toml` 固化，避免 rustup 自动升版。
2. **不要用 `x86_64-win7-windows-msvc`**。它虽是专为 Win7 设的 Tier 3 目标，但 windows-rs 系 crate 无法为其编译，是死路。
3. **项目自用的 `windows 0.61.3` 是安全的**，断点在 0.62；真正要打的是 `windows-sys` 这条线。
4. **`dirs 6.0.0` 是 Tauri 带进来的**，不是项目自己的（项目声明 5.0）。只改自己的 Cargo.toml 无效。
5. **WebView2 的 bootstrapper 在 Win7 已失效**，「内置固定版 109 + 设环境变量」是唯一可靠路径，缺一不可。
6. **CUDA 天花板是 11.4**，由 Win7 最后驱动 475.14 决定，不是由 CUDA 文档的表格决定。
7. **dsh 智能体在 Win7 无解**，因为它要求 Node 22+。这是需求层面的减法，不是工程问题。
8. **运行时依赖两份清单**：一是编出来的 exe 用 `/MD` 时目标机要装匹配的 VC++ redist（VS 2022 系列 redist 仍可在 Win7 用，但版本必须 ≥ 编译工具集）；二是 Win7 上 WebView2 只能是 109。前者用静态 CRT 一劳永逸，后者无解、只能内置。

---

## 9. 交付物清单

- [ ] Win7 可执行分支（建议 `win7` 分支或独立 fork）
- [ ] `rust-toolchain.toml` + 钉版后的 `Cargo.toml` / `Cargo.lock`
- [ ] 依赖守卫脚本（阻止 `windows-sys ≥ 0.61`、`getrandom ≥ 0.3` 回归）
- [ ] WebView2 109 固定运行时的获取与内置脚本
- [ ] 自编译内核的构建脚本与说明（Vulkan / CUDA 11.4 两条线）
- [ ] NSIS 安装包 + 便携 zip
- [ ] `docs/WIN7_BUILD_GUIDE.md`：从零复现构建环境
- [ ] `docs/WIN7_KNOWN_LIMITATIONS.md`：明确列出无 dsh、无 Mica 等取舍
- [ ] 更新后的 `CHANGELOG.md` 与 `TECHNICAL_REPORT.md`

---

## 10. 下一步（立即可执行）

P0 的前三件事不依赖 Win7 机器，可以现在就在开发机上做完：

```powershell
# 1. 固化工具链
cd D:\Projects\Agent_LLM\app\src-tauri
#    写入 rust-toolchain.toml: channel = "1.77.2"
rustup toolchain install 1.77.2-x86_64-pc-windows-msvc

# 2. 摸清越界依赖的真实规模
cargo tree -i windows-sys@0.61.2
cargo tree -i getrandom@0.3.4
cargo tree -i getrandom@0.4.2

# 3. 试探 1.77.2 下现有工程能否编过（大概率失败，用于暴露问题清单）
cargo +1.77.2 check --target x86_64-pc-windows-msvc
```

第 3 步的报错列表，就是 P1 的工作清单。

---

## 相关文档

- `docs/TECHNICAL_REPORT.md`：当前架构与实现现状（反推依据）
- `CHANGELOG.md`：功能演进与已知限制
- `AGENTS.md`：语言、参数与构建产物规则（本计划的改造须遵守，尤其「不得静默修改默认加载/推理参数」）
