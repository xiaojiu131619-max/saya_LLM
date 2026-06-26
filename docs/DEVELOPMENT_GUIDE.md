# Agent LLM 开发指南

> 面向想在此项目上工作（修 bug、加功能、调样式、改 Rust 后端）的开发者。读完应该能独立完成：本地启动 → 改动 → 验证 → 打包。

## 1. 环境准备

### 1.1 操作系统

仅在 Windows 10/11 上验证通过（`main.rs` 加了 `windows_subsystem = "windows"`，且 `process_manager.rs` 使用 `creation_flags(0x08000000)` 隐藏子进程窗口）。其他平台理论上能跑 Tauri 框架，但 llama.cpp 二进制是 Windows x64 + CUDA 13.3 的预编译产物，需要替换 `app/resources/` 内的 `llama-server.exe` 与 `*.dll`。

### 1.2 必需软件

| 软件 | 版本 | 用途 |
| --- | --- | --- |
| Node.js | 20+ | Vite / npm scripts |
| Rust | stable（MSRV 1.77.2） | Tauri 后端编译 |
| Microsoft Edge WebView2 Runtime | 最新 | Tauri WebView 引擎 |
| Microsoft C++ Build Tools | 含 `cl.exe` 与 Windows SDK | Rust 链接 |
| （可选）NVIDIA 驱动 + CUDA 13.3 runtime | 与 `app/resources/ggml-cuda.dll` 配套 | GPU 推理 |
| （可选）任意 GGUF 模型 | 任意家族 | 加载测试 |

> Tauri CLI 不需要全局安装：`npm` 脚本里通过 `npx tauri ...` 走 `@tauri-apps/cli`。

### 1.3 校验命令

```powershell
node --version       # v20.x 或更高
rustc --version      # 1.77.2 或更高
cargo --version
cl /?                # 应输出 Microsoft C++ 编译器用法
```

## 2. 第一次启动

### 2.1 安装依赖

```powershell
cd D:\Projects\Agent_LLM\app
npm install
```

首次运行会下载 `tauri`、`@tauri-apps/cli`、`vite` 等较大依赖。如遇网络问题，可设置国内镜像：

```powershell
npm config set registry https://registry.npmmirror.com
```

### 2.2 浏览器预览（前端快速迭代）

```powershell
npm run dev
```

打开 `http://127.0.0.1:3000`。浏览器模式**不能启动 llama-server**，所有 `isDesktopRuntime()` 返回 `false` 的路径会优雅降级（显示占位、禁用按钮、提示「请在桌面版中操作」）。适合只调 UI。

### 2.3 桌面开发

```powershell
npm run desktop
```

等价于 `tauri dev`：会先 `npm run dev` 启动 Vite，再编译 Rust 后端并打开 Tauri 窗口。第一次会编译全部依赖（10-20 分钟），之后增量编译几秒到几分钟。

启动后流程：

1. 应用以「设置」为入口（`WorkspaceShell` 默认展示 Model 工作区，但 `ModelWorkspace` 检测到 `state.modelDirs.length === 0` 时会把 `appStatus` 置为提示文本）。
2. 在设置页点击「选择目录」选择任意含 `.gguf` 的目录（多选可多次添加）。
3. 回到「模型管理」点刷新 → 列表出现模型 → 点击进入参数加载。
4. 调整参数 → 点击「加载模型」 → 等待 100% → 切到「对话」开始聊天。

### 2.4 生产构建

```powershell
npm run desktop:build
```

等价于 `tauri build`：先 `npm run build` 出前端静态资源，再 release 编译 Rust 端。

产物：

```text
D:\Projects\Agent_LLM\app\src-tauri\target\release\agent-llm.exe   # 主可执行
D:\Projects\Agent_LLM\app\src-tauri\target\release\bundle\msi\*.msi  # 安装包（取决于 Tauri bundle target）
```

`tauri.conf.json::bundle.targets = ["app"]` 当前只生成便携式 `.exe`，未打包 MSI。如需 MSI，把这一行改为 `["app", "msi"]` 后重跑 `desktop:build`。

## 3. 代码地图（从哪里读起）

按"目标 → 入口"的顺序给你定位路径：

| 我想做的事 | 从哪里开始 |
| --- | --- |
| 改主题色 / 字体 | `app/src/index.css`、`app/tailwind.config.js` |
| 改某个工作区布局 | `app/src/features/{workspace,model,chat,settings}/*.tsx` |
| 改模型卡片外观 | `app/src/components/ModelCard.tsx` |
| 增加新的设置项 | `app/src/pages/SettingsPage.tsx` + `app/src-tauri/src/commands/config.rs` + `app/src-tauri/src/models/app_state.rs::AppConfig` |
| 增加新的 Tauri 命令 | 在 `app/src-tauri/src/commands/*.rs` 新增函数，注册到 `app/src-tauri/src/lib.rs::invoke_handler!`，再在 `app/src/lib/desktop.ts` 包装 |
| 调整 llama-server 启动参数 | `app/src-tauri/src/services/process_manager.rs::spawn_server_process` |
| 调整流式对话解析 | `app/src/lib/desktop.ts::streamChatCompletion` |
| 调整 GGUF 解析字段 | `app/src-tauri/src/services/gguf_parser.rs::parse_gguf_header`，同时增加 `SCANNER_VERSION` 让旧缓存失效 |
| 调整硬件监控采样 | `app/src/hooks/useSystemStats.ts`（前端节奏） + `app/src-tauri/src/commands/system.rs`（后端实现） |
| 改默认推荐参数 | `app/src/lib/modelDefaults.ts` |

## 4. 开发工作流

### 4.1 日常开发循环

1. 终端 A：`npm run desktop`（保持运行；Rust 会监听 `src/**` 增量重编）。
2. 终端 B：编辑 `app/src/**` 任意文件，Vite HMR 立即热替换 React 组件；编辑 `app/src-tauri/**` 后保存，Tauri 自动重启窗口。
3. 需要看 Rust 端日志时切到终端 A（`tauri dev` 把 stderr 透传）。
4. 修改 Rust 端 `commands/*` 注册的命令列表后**必须重启 dev**，因为 `invoke_handler!` 是宏展开。

### 4.2 推荐的 IDE 设置

- **VS Code** + 扩展：
  - `rust-analyzer`（Rust）
  - `tauri-apps.tauri-vscode`（Tauri 提示）
  - `dbaeumer.vscode-eslint` + `esbenp.prettier-vscode`
  - `bradlc.vscode-tailwindcss`（Tailwind IntelliSense）

- **配置快捷任务**（`.vscode/tasks.json` 可选）：

  ```json
  {
    "version": "2.0.0",
    "tasks": [
      { "label": "desktop", "type": "npm", "script": "desktop", "problemMatcher": [] }
    ]
  }
  ```

### 4.3 代码风格

前端遵循默认 ESLint 配置（`app/eslint.config.js` + `typescript-eslint`）：

```powershell
cd D:\Projects\Agent_LLM\app
npm run lint
```

Rust 端没有专门的 clippy 配置，但项目用了 `rust-version = "1.77.2"`，本地推荐：

```powershell
cd D:\Projects\Agent_LLM\app\src-tauri
cargo clippy --all-targets -- -D warnings
cargo fmt
```

### 4.4 类型检查

前端 TS 检查内置于 `npm run build`：

```powershell
cd D:\Projects\Agent_LLM\app
npm run build        # = tsc -b && vite build
```

单独跑：

```powershell
npx tsc -b --noEmit
```

Rust 端：

```powershell
cd D:\Projects\Agent_LLM\app\src-tauri
cargo check
```

## 5. 调试技巧

### 5.1 前端

- **React DevTools**：Tauri 窗口是 WebView，DevTools 通过 `webview` 的右键 → Inspect 打开（dev 模式默认开启）。或运行 `tauri dev` 时按 `Ctrl+Shift+I`（取决于 Tauri 版本）。
- **状态调试**：`AppContext` 把全部状态装在 `state`，可在控制台 `window.__store__` 注入调试工具，或临时在组件里 `console.log(state)`。
- **持久化检查**：

  ```js
  // DevTools console
  JSON.parse(localStorage.getItem('agent-llm-local-state-v1'))
  ```

### 5.2 后端

- `tauri dev` 默认会把 `eprintln!` 输出到启动终端；可加 `RUST_LOG=debug` 调 tauri-plugin-log。
- 关键性能日志：`[perf] setup / load_config / walkdir / parse / cache / scan_total / scan_fast`。
- 启动 `llama-server` 的完整命令行会在 `[server] spawn: ...` 行打印；可以直接复制到 `cmd` 重现。
- 如果 llama-server 启动后页面卡住：检查 `get_server_status` 是否返回 `true`，以及 `process_manager.rs::monitor_server` 的 `last_health_check` 是否在 500 ms 间隔内执行。

### 5.3 常见故障

| 症状 | 检查 | 修法 |
| --- | --- | --- |
| `npm run desktop` 报 `failed to bundle project` | 是否缺少 WebView2 | 安装 Edge WebView2 Runtime |
| Tauri 窗口白屏 | 前端未构建或 `devUrl` 错误 | 确认 `tauri.conf.json::build.devUrl = "http://127.0.0.1:3000"` 与 Vite `server.port = 3000` 一致 |
| `找不到 llama-server.exe` | `app/resources/` 缺失 | 重新拷贝 `llama-server.exe` 与 `*.dll` |
| 加载模型后页面无响应 | `on_ready` 未触发 | 确认 `/health` 返回 200；检查 `process_manager.rs` 是否被错误分支吞掉 |
| OOM | `gpuLayers` 过大 | UI 调低 ngl 或降低 `n_ctx`；Rust 端有 `compatible_cpu_config` 兜底 |
| `CUDA error` | 驱动版本不匹配 | `app/resources/ggml-cuda.dll` 是 CUDA 13.3；驱动需要 ≥ 580.x |
| `cargo build` 在 `nvml-wrapper` 失败 | nvml.lib 不在 PATH | 安装 NVIDIA CUDA Toolkit 或把 `C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.3\lib\x64` 加到 `LIB` |
| localStorage 撑爆 | 大量会话累积 | UI 提供「批量删除」入口；可以临时在 DevTools 清掉 `agent-llm-local-state-v1` |

### 5.4 重新生成 GGUF 解析缓存

```powershell
Remove-Item -Recurse "$env:APPDATA\AgentLLM\cache"
```

或者在 UI 设置中调 `clear_model_cache` 命令（暴露在 Rust 但前端目前没有按钮，需要时可加）。

## 6. 扩展项目

### 6.1 添加一个新的 Tauri 命令

1. 在 `app/src-tauri/src/commands/foo.rs`：

   ```rust
   use tauri::State;
   use crate::models::app_state::AppState;

   #[tauri::command]
   pub fn my_thing(state: State<'_, AppState>, arg: String) -> Result<String, String> {
       let _ = state.config.lock().map_err(|e| e.to_string())?;
       Ok(format!("hello {}", arg))
   }
   ```

2. `app/src-tauri/src/commands/mod.rs` 中 `pub mod foo;`。

3. `app/src-tauri/src/lib.rs::run` 注册：

   ```rust
   .invoke_handler(tauri::generate_handler![
       // ...
       commands::foo::my_thing,
   ])
   ```

4. `app/src/lib/desktop.ts` 加包装：

   ```ts
   export async function myThing(arg: string) {
     if (!isDesktopRuntime()) return null;
     return invoke<string>('my_thing', { arg });
   }
   ```

5. 在 React 组件中 `import { myThing } from '@/lib/desktop';`。

### 6.2 添加新的视图

1. `app/src/types/index.ts` 把新 id 加进 `ViewType`。
2. `app/src/context/AppContext.tsx::appReducer` 加一个对应的 `SET_VIEW` 处理（如果需要新字段）。
3. 在 `app/src/features/<name>/` 下新建 `<Name>Workspace.tsx`。
4. 在 `app/src/features/workspace/WorkspaceShell.tsx::workspaceMode` 映射到对应工作区。
5. 在侧栏或设置中心加入口 `dispatch({ type: 'SET_VIEW', payload: '<name>' })`。

### 6.3 修改 llama-server 启动参数

直接在 `process_manager.rs::spawn_server_process` 中编辑 `cmd.arg(...)` 列表。提交前请确认：

- 前端 `ModelLoadConfig` → `ServerConfig` 的字段映射在 `lib/desktop.ts::buildServerConfig` 也对应更新。
- 新增 CLI 参数如果只部分构建支持（如新 llama.cpp 才支持），要在 `detect_error` 里加上错误检测分支。

### 6.4 新增 GGUF 元数据字段

1. `app/src-tauri/src/services/gguf_parser.rs::GgufMetadata` 加字段。
2. `parse_gguf_header` 在白名单 `keep` 中加入新 key 前缀，并在循环里写入对应变量。
3. `ModelInfo`（Rust 端 `models/model_info.rs`）和 TS `types/index.ts` 同步加字段。
4. 把 `SCANNER_VERSION` 加 1，避免旧缓存回填新字段。
5. UI 端在 `ModelLoadPage`（信息 Tab）或 `ModelCard` 中显示新字段。

### 6.5 增加新的会话后端

当前所有会话都存 localStorage。如果要加 SQLite / 文件后端：

1. 在 Rust 端新增 `services/chat_store.rs`，定义 `ChatStore` trait。
2. `commands::chat_store::*` 提供命令：`list_sessions` / `load_sessions` / `save_session` / `delete_session`。
3. 前端 `lib/desktop.ts` 包装这些命令，`AppContext` 的 `chatSessions` 改为按需加载/同步。

### 6.6 国际化

当前所有 UI 字符串都是中文硬编码。最小可行方案：

1. 引入 `i18next` + `react-i18next`。
2. 把硬编码字符串抽到 `app/src/locales/zh.json` / `en.json`。
3. 在 `AppContext.theme` 旁边加 `locale`，配合 `theme` 持久化。

## 7. 仓库约定

### 7.1 Git 边界

- 工作根目录是 `D:\Projects`（Git 仓库），不是 `D:\Projects\Agent_LLM`。
- 提交时**只**选择 `Agent_LLM/` 相关文件，避免污染其它项目。
- `.gitignore` 在 `app/` 下，覆盖 `node_modules/`、`dist/`、`output/`、`src-tauri/target/`、`*.log`。

### 7.2 不要提交的内容

- `app/node_modules/`
- `app/dist/`、`app/output/`
- `app/src-tauri/target/`
- `app/vite.out.log`、`app/vite.err.log`
- `cudart-llama-bin-win-cuda-13.3-x64/`（仓库根目录下的开发参考文件，体积较大，建议不进库；`llama-server.exe` 通过 `tauri.conf.json::bundle.resources` 打进安装包）
- 用户在 `%APPDATA%\AgentLLM\` 下的配置、缓存、聊天记录

### 7.3 提交流程建议

```powershell
cd D:\Projects
git status
git add Agent_LLM\app\src Agent_LLM\app\resources Agent_LLM\app\package.json ...
git diff --cached --stat
git commit -m "feat(model): 在 ModelCard 显示架构标签"
```

## 8. 测试

### 8.1 当前状态

- 前端：未引入单元测试框架；行为靠手测。
- Rust：`gguf_parser.rs` 末尾有一段 `#[ignore]` 的手写测试（`test_parse_qwen` / `test_parse_wukomg`），需要在 `D:\LLM\...` 路径上有真实模型才能跑：

  ```powershell
  cd D:\Projects\Agent_LLM\app\src-tauri
  cargo test -- --ignored
  ```

### 8.2 推荐补充

- 前端：`vitest` + `@testing-library/react`，从纯函数（`chatUtils.ts`、`modelDefaults.ts`、`modelTheme.ts`、`utils.ts`）入手。
- Rust：`cargo test` 给 `process_manager::parse_progress` 与 `gguf_parser::parse_gguf_header` 加 fixture；`process_manager` 还可以注入一个伪 `Child` 跑集成测试。
- E2E：`tauri-driver` 或 WebDriver + 自带的 Tauri 协议，做窗口级回归。

## 9. 故障排查清单（Troubleshooting）

启动 / 编译相关：

- **首次 `cargo` 编译很慢**：正常；后续会显著加快。
- **`link.exe not found`**：安装 Visual Studio Build Tools，对应 "Desktop development with C++" 工作负载，并把 `cl.exe` 加入 PATH。
- **`tauri.conf.json` 报错 schema**：执行 `npm install` 让 `@tauri-apps/cli` 下载 schema。

运行时：

- **窗口能开，但所有按钮点了都说"请在桌面版中…"**：Tauri 注入失败；检查是否在真正的 Tauri 窗口内运行（不是普通浏览器）。
- **`Cannot find module '@/...'`**：TS 路径别名；运行 `npx tsc -b` 让 `tsconfig.app.json::paths` 生效，并确认 IDE 使用工作区版本。
- **端口被占用**：先停掉占用 8080 的进程，或者在「设置」里把 `default_port` 改成 8081/8082。
- **下载 / 升级 llama.cpp 失败**：检查防火墙；更新流程（`auto_updater.rs`）走 GitHub Releases，目前仅支持检查，不自动安装。

## 10. 常用命令速查

```powershell
# 进入项目
cd D:\Projects\Agent_LLM\app

# 安装 / 升级依赖
npm install

# 浏览器预览
npm run dev

# 桌面开发
npm run desktop

# 生产构建
npm run desktop:build

# Lint
npm run lint

# 类型检查 + 前端构建（不打包桌面）
npm run build

# 审计依赖
npm audit

# Rust 检查
cd src-tauri
cargo check
cargo clippy --all-targets -- -D warnings
cargo test -- --ignored
```

## 11. 相关文档

- `README.md`：极简启动。
- `tech-spec.md`：早期前端原型设计意图。
- `app/README.md`：项目自带 README，重启 / 构建 / 检查 / 注意。
- `TECHNICAL_REPORT.md`：架构、数据流、模块清单。

## 12. 联系与维护

项目维护者：`sky`（参见 `app/src-tauri/Cargo.toml::authors`）。如发现本文档与代码不一致，**以代码为准并提交修复**。
