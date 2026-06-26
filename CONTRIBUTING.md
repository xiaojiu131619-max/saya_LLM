# 贡献指南

欢迎参与 Agent LLM 的开发。本文件描述仓库约定与协作流程。

## 开发环境

- Windows 10/11（项目使用 Windows 专属的 `creation_flags(0x08000000)` 与 WebView2）
- Node.js 20+
- Rust stable（MSRV 1.77.2）+ Visual Studio Build Tools（C++ 工作负载）
- Edge WebView2 Runtime

## 项目结构

```
Agent_LLM/
├── LICENSE                  MIT 许可
├── README.md                → docs/README.md（极简入口）
├── CHANGELOG.md             按 [Keep a Changelog] 记录所有可观察改动
├── CONTRIBUTING.md          本文件
├── .gitignore               根级忽略规则（IDE、OS、备份）
├── .editorconfig            跨编辑器统一缩进/换行
├── .gitattributes           行尾、diff、linguist 标记
├── docs/                    详细文档
│   ├── README.md            启动速查
│   ├── tech-spec.md         早期前端原型设计意图
│   ├── TECHNICAL_REPORT.md  架构与数据流
│   └── DEVELOPMENT_GUIDE.md 开发与构建
└── app/                     实际项目（前端 + Tauri 后端）
    ├── src/                 React + TypeScript
    ├── src-tauri/           Rust 后端
    ├── resources/           llama.cpp 运行时（打包进安装包）
    └── package.json
```

## 提交规范

本项目使用类 Conventional Commits 风格。提交信息格式：

```text
<type>(<scope>): <subject>

<body>

<footer>
```

`<type>` 取值：

- `feat` —— 新功能
- `fix` —— Bug 修复
- `refactor` —— 不改变行为的重构
- `perf` —— 性能优化
- `docs` —— 仅文档变更
- `style` —— 不影响语义的格式调整
- `test` —— 测试新增或修改
- `build` —— 构建系统或外部依赖变更
- `ci` —— CI 配置变更
- `chore` —— 杂项（不归入以上）

`<scope>` 取值（可省略）：`frontend` / `backend` / `desktop` / `chat` / `model` / `settings` / `docs` / `deps` 等。

示例：

- `feat(chat): 支持 reasoning_content 流式渲染`
- `fix(desktop): 修复端口冲突时 on_ready 不触发的问题`
- `refactor(frontend): 合并 HomePage 中重复的 useMemo`

## 提交前检查清单

提交 `Agent_LLM` 相关文件前，请运行：

```powershell
cd D:\Projects\Agent_LLM\app
npm run lint
npm run build
cd src-tauri
cargo check
```

Rust 端推荐：

```powershell
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

## Git 边界

`D:\Projects` 是 Git 仓库根目录，`Agent_LLM` 是其中一个子项目。提交时请**只**勾选 `Agent_LLM/` 路径下的文件，避免污染其他项目。

`git status` 应只显示 `Agent_LLM/...` 与本项目无关的其他目录（除非是其他项目的工作）。

## Pull Request

虽然当前是单开发者仓库，约定：

1. 每个 PR 关联一个明确目标（一个功能、一组相关修复、一个文档更新）
2. PR 描述包含：背景 / 改动点 / 验证步骤 / 截图（UI 变更）
3. 至少一次本地 `npm run build` + Rust `cargo check` 通过
4. 在 `CHANGELOG.md` 的 `[Unreleased]` 段追加对应条目（`新增` / `变更` / `修复` / `移除` / `安全`）

## 代码风格

- **TypeScript**：遵循 ESLint + `typescript-eslint` 默认规则；2 空格缩进、LF 行尾（详见 `.editorconfig`）
- **Rust**：`cargo fmt` 默认风格；Clippy 警告必须清零
- **CSS**：Tailwind 优先；自定义样式写到 `app/src/index.css`，避免散落内联
- **命名**：组件 PascalCase、hooks `useXxx`、普通函数 camelCase、类型 `XxxInfo` / `XxxConfig`

## 添加新依赖

前端新增依赖前，请确认：

1. 没有可用的小工具函数替代
2. 不与现有包重叠（如已有 `clsx` 就别再加 `classnames`）
3. 包大小可接受（zip 后增量 < 100 KB 优先）

Rust 端新增 crate 前请确认：

1. crates.io 上活跃维护
2. 兼容 MSRV 1.77.2
3. license 与本项目 MIT 兼容

新增后请同步：

- `app/package.json` 或 `app/src-tauri/Cargo.toml`
- `CHANGELOG.md` 中标注「依赖」条目
- 必要时更新 `docs/DEVELOPMENT_GUIDE.md` 中的相关说明

## 发版流程

1. 确认 `[Unreleased]` 段条目完整
2. 把日期与版本号写入新段：`## [X.Y.Z] - YYYY-MM-DD`
3. 按 SemVer 升级版本号：
   - 补丁 X.Y.**Z+1**：Bug 修复、不破坏 API 的小调整
   - 次版本 X.**Y+1**.0：新增功能、向后兼容
   - 主版本 **X+1**.0.0：破坏性变更
4. 重新生成 `Cargo.lock` 与 `package-lock.json`（如有变化）
5. 在 Git 仓库根目录 commit `Agent_LLM/CHANGELOG.md` 与对应代码

## 报告问题

发现 Bug 时请提供：

- 复现步骤
- 期望行为 / 实际行为
- 环境（OS / Node 版本 / Rust 版本 / GPU 型号 / CUDA 版本）
- llama-server 日志（`app/src-tauri/target/release/logs/` 或控制台 `[server] spawn: ...` 行）
- 客户端 DevTools console 截图（如果是 UI 问题）

## 安全

发现安全漏洞请私下联系维护者（见 `docs/DEVELOPMENT_GUIDE.md`「联系与维护」），不要公开 Issue。

[Keep a Changelog]: https://keepachangelog.com/zh-CN/1.1.0/
