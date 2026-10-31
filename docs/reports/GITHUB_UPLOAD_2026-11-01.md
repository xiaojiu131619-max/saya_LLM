# GitHub 上传报道（2026-11-01）

## 一、上传结果

| 项目 | 内容 |
| --- | --- |
| 仓库 | [xiaojiu131619-max/saya_LLM](https://github.com/xiaojiu131619-max/saya_LLM)（公开） |
| 分支 | `main` |
| 本次提交 | `3accc0d` feat: 拾壹界面、Strata 引擎与聊天增强；修复后端生命周期缺陷 |
| 一并推送 | `5a882de` 显存估算算法改进（此前已提交、未推送） |
| 远端区间 | `0f40825..3accc0d` |
| 变更规模 | 139 个文件：66 新增 / 69 修改 / 4 删除，+23,413 / −5,807 行 |
| 推送时间 | 2026-11-01 |
| 推送结果 | `git push origin main` 成功，远端 `main` 已指向 `3accc0d` |

本轮把此前累积在工作区的一整批功能（Strata 引擎、拾壹界面、自动调参、附件、搜索/导出/热力图等）与代码审查后的修复一起整理提交。推送前完成了类型检查、lint、前端 349 项回归、Rust 204 项测试与生产构建；桌面版 exe 的打包结果见文末。

## 二、本次上传的主要内容

### 2.1 界面与交互

- **产品显示名改为「拾壹」**：窗口标题、侧边栏、设置页关于、`BrandLogo` 字标统一；仓库名与 `productName` / `identifier` 不变。
- **对话侧栏可拖拽调宽**（200–480px，双击复位 288px），底部服务状态卡扩为 ctx / 显存 / 内存 / GPU 四项，并按卡片实际宽度做 2×2 / 1×4 两档容器查询。
- **会话搜索**：标题子序列模糊匹配 + 对话正文检索，正文命中带角色摘要与 `mark` 高亮，不破坏 Markdown 语法。
- **会话导出与归档**：Markdown / 纯文本 / JSON 三种格式，可选思考过程、统计与工具调用；数据管理新增「归档全部对话」。
- **使用统计**：年 / 月 / 日三档热力图、模型占比、按来源（主模型 / 对外 API / 引擎）拆分。
- **设置扁平化**：工具页改为原生工具 + MCP 双栏；模型主题从独立页面移到模型头像面板；数据管理重写为目录设置 + 分级清除。

### 2.2 Strata（智慧模型）后端

- 新增 `services/strata_manager`：托管 Python 网关 `serve.server`，拉起 `strata.exe` 内核，按 `/health.loaded` 区分「接口在线」与「可对话」。
- `services/strata_metrics`：从网关 `/metrics?requests=all` 增量采集请求历史，提供首字延迟、decode TPS、缓存、草稿接受率等指标。
- `commands/strata`：启动 / 停止 / 重启 / 状态 / 日志 / 配置 / 指标 / dsh 接入，共 12 个命令。
- 新增 `StrataPage`（概览 / 性能 / 日志 / 设置）与 `StrataPerformance` 面板；侧边栏导航按后端运行状态着色。
- 与主模型、NiNfer 做硬互斥；对话页去掉手动下拉，按「谁在跑」自动选择后端。

### 2.3 后端生命周期与互斥

- 新增 `services/backend_gate`：启动任一后端前停掉另外两个，经 `backend:exclusive` 事件通知前端。
- 新增 `services/storage_paths` 与 `commands/storage`：引擎 / 日志 / 归档目录可配置，并提供归档写盘命令。
- 主模型、NiNfer、Strata 的停止路径统一到命令层，事件、webui 桥与加载生命周期不再被绕过。

### 2.4 对话与自动调参

- 新增附件链路：拖拽 / 粘贴 / 文件选择，支持 HTML 内嵌图片、`data:` URL、URI 列表与文字；重复附件去重。
- 新增交付护栏 `deliveryGuard`：空正文、未闭合代码围栏 / `<svg>`、`finish_reason=length` 只提示不重发。
- 首轮回答后自动生成会话标题；标题请求按会话归属解析端口 / Key / 模型名。
- 自动调参任务化：结果只在模型身份、路径、显存签名与推理配置未变时应用；界面偏好变更不再算冲突。

## 三、代码审查与修复清单

审查覆盖了新增 Rust 模块、前端新模块与 76 个已跟踪文件的 diff，共修复以下问题（按影响排序）：

### 严重

1. **Job Object 结构体布局错误，整树回收从未生效**（`process_manager`、`fast27b_manager`、`dsh_manager`、`embedding_manager`、`strata_manager`）
   - 末尾字段写成 `ChildProcessCount + Reserved[2]`，正确布局是 `PriorityClass + SchedulingClass`；结构体多 4 字节，`SetInformationJobObject` 恒以 `ERROR_BAD_LENGTH (24)` 失败，`KILL_ON_JOB_CLOSE` 从未设置。
   - 五处一并修正，并加 x64 编译期断言 `size_of == 144`，防止再次写错。
2. **互斥闸门绕过命令层，前端以为主模型还在跑**（`services/backend_gate.rs`）
   - 直接调 `process_manager::stop_server()` 不取消 `NORMAL_LOAD`、不发 `server:stopped`；停 NiNfer 还漏掉 webui 桥。
   - 改为走 `stop_server_with_app` / `stop_fast27b_with_app` / `stop_strata_with_app`，事件与手动停止一致；停止失败则放弃启动目标后端。
3. **取消加载被当成「服务静默退出」**（`process_manager.rs`）
   - 新增 `MonitorResult::Cancelled`；取消不再触发 CPU 回退或 `server:error`。
4. **启动新加载永远撞上「正在加载」**（`commands/server.rs`）
   - 先取消并 join 旧加载，再申请生命周期，最后执行互斥闸门。

### 高

5. **Strata 停止后 6 秒清理误杀重启的新内核**（`strata_manager.rs`）
   - 延迟线程校验停止代数与运行态；`--serve` / `--pack` 改为逐参数精确匹配。
6. **Strata 错误请求被记成成功**（`strata_metrics.rs`）
   - `error` / `timeout` / `disconnect` 映射为 `failed` / `cancelled`；表格与用量同步。
7. **Strata 运行中改 API Key / 局域网开关导致 401 与状态失真**（`commands/strata.rs`）
   - 纳入出生参数检查，运行中禁止修改。
8. **Strata 开发模式 CORS 端口错误**（`strata_manager.rs`）
   - 补 `127.0.0.1:3000`、`localhost:3000` 与 `tauri://localhost`。
9. **首轮自动标题永远不执行，引擎会话取错端点**（`ChatPage.tsx`、`sessionTitle.ts`）
   - 发送方显式带入首条消息与正文；按 `runtimeModelId` 解析主模型 / NiNfer / Strata 的端口、Key 与模型名；标题预算提高到 128 并关闭思考。
10. **媒体附件写进 localStorage 撑爆配额并静默丢失全部持久化**（`AppContext.tsx`）
    - 持久化前剥离非文本 part；本次运行内仍可显示，重启后保留文字与附件数量说明。
11. **归档文件名把标题省略号当路径穿越**（`commands/storage.rs`、`DataManagementPage.tsx`）
    - 只拒绝整名 `.` / `..`、分隔符、盘符与控制字符；join 后校验落点；文件名追加会话标识避免同名覆盖。

### 中

12. Strata 状态查询阻塞 IPC 最长 2 秒 → 改 async + `spawn_blocking`。
13. Strata 停止后「进行中请求」残留 → 停止时清零。
14. Strata `extra_args` 可覆盖端口 / 鉴权 → 拒绝 `--port` / `--host` / `--api-key` / `--config` / `--engine`。
15. Strata / NiNfer 默认配置硬编码作者路径与固定 Key → 路径改由 `%LOCALAPPDATA%` 推导，源码目录留空；本地 Key 每次全新配置随机生成。
16. 热力图月底翻页溢出 → 翻月前把日号钳到目标月最后一天。
17. 导出文件名用 UTC 日期、非法 `createdAt` 抛错 → 改本地日期并回退今天。
18. 引擎 TPS 分子分母来自不同请求集合 → 分子只累计贡献了耗时的请求。
19. 时长格式在 59.95 秒附近输出「1分60.0秒」→ 先按显示精度取整再拆分单位。
20. 重复拖入同一附件会发送两遍 → 跨次按 `name + size + kind` 去重。
21. Strata 页面事件监听卸载后泄漏 → 补 `disposed` 标志与 `.catch`。
22. Strata 启用开关用旧快照整份回写 → 改用 `strataSetEnabled`。
23. 版本 2 的主题偏好被丢弃 → 读取门槛放宽到 `>= 2`。
24. 「恢复界面默认值」漏掉侧边栏宽度 → 补 `sidebarWidth`。
25. 自动调参把 UI 偏好算作配置冲突 → 只比较推理字段。
26. 残留 llama-server 清扫在生产路径不可达 → 每次加载都清扫应用目录树内遗留实例。
27. 自动后端选择在互斥切换后滞后最多 3 秒 → 监听 stopped / ready 事件立即刷新快照。

## 四、验证记录

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `cd app && npx tsc -b` | 通过，无输出 |
| Lint | `cd app && npx eslint .` | 0 error；1 条既有告警（TanStack Virtual 与 React Compiler） |
| 前端回归 | `cd app && npm test` | 349 passed / 0 failed |
| Rust 单元测试 | `cd app/src-tauri && cargo test` | 204 passed / 0 failed / 10 ignored |
| Rust 编译 | `cd app/src-tauri && cargo check` | 通过 |
| 前端生产构建 | `cd app && npm run build` | 通过（3129 modules，7.39s） |
| 桌面版打包 | `cd app && npm run desktop:build` | 通过（release 增量编译 1m10s） |

新增回归用例：

- `app/scripts/session-export.test.mjs`：导出文件名的省略号、控制字符、本地日期与非法时间。
- `app/scripts/service-usage.test.mjs`：59.95 秒进位边界；缺读数的请求不进入 TPS 分子。
- `app/scripts/autotune.test.mjs`：界面偏好变更不算调参配置冲突。

## 五、仓库整理

- `.gitignore` 新增 `.workbuddy/`；删除 `app/scripts/_repro.*.log` 两个临时复现日志。
- 确认 `app/src-tauri/target/`、`app/dist/`、`app/output/`、`app/resources/` 下的内核与模型二进制、`.mimosa/` 均未入库。
- `README.md` 当前版本从 0.3.1 更正为 0.4.0，补充「拾壹」显示名、Strata 与搜索 / 导出 / 数据管理说明。
- `CHANGELOG.md` 的 `[Unreleased]` 下新增「2026-11-01 代码审查批次」，逐条记录本轮修复。

## 六、已知限制与后续建议

1. **引擎用量仍以 24 小时快照覆盖**：`SET_ENGINE_USAGE` 的口径是「指标窗口内全量」，超过 24 小时的历史请求滚出窗口后，引擎累计值可能下降；「清零统计」后 1–2 秒内也会被快照恢复。彻底解决需要按请求 ID 做增量账本，留待下一轮。
2. **Strata `--lazy` / 空闲卸载**：`/health.loaded=false` 但接口可用时，应用会一直判为「加载中」。当前建议不使用 `--lazy`；后续可按 `/v1/status` 的 `auto_load` 区分。
3. **Strata 端口预检无法发现「正在加载、尚未 bind」的外部网关**：极端情况下可能重复加载同一 pack；Job Object 修好后崩溃残留已能被回收，剩余场景建议后续按进程命令行做单实例检测。
4. **Fast27b 默认路径仍是作者本机的 `D:\Projects\fast-llm\...`**：这是既有排障基线，本轮只替换了固定 Key，未改路径；新机器需在 fast-27b 页手动指定引擎与模型。
5. **本轮未做真实硬件冒烟**：Strata 需要 90 GiB 级权重与专用环境，桌面打包只验证到构建成功；建议在目标机器上补一次「启动 → 加载 → 对话 → 停止」实测。
6. **Mimosa 安全扫描未完整完成**（提交 / 推送钩子提示 `python_ast_unavailable`、`callgraph_fact_partial`）。本报告不宣称项目「安全」；涉及本地 Key、局域网监听与文件写盘的部分建议后续单独跑一次完整审计。

## 七、桌面版产物

`npm run desktop:build` 已成功完成：

- 可执行文件：`app/src-tauri/target/release/agent-llm.exe`
- 大小 / 时间：22 MB，2026-11-01 01:03
- 构建过程：`beforeBuildCommand` 重新执行 `tsc -b && vite build`（3129 modules），随后 release 编译 1m10s
- 编译告警：9 条 `never used`（既有代码，不影响产物）

---

**结论**：本轮上传完成了功能整合与一轮系统性缺陷修复，所有可自动化的检查均通过；剩余问题已明确记录，不影响本次代码入库。
