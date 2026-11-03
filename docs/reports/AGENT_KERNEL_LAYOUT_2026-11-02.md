# Agent 设置双列 + 核心更新双列（2026-11-02）

## Agent 设置页

- 内容区从单列 `max-w-2xl` 扩到 `max-w-6xl`，宽屏按两列排布。
- 状态卡横跨整行；下面左右两列各自独立堆叠，避免 Grid 行高把另一列拉出大块空白：
  - 左列：内核与工作区、引擎来源、运行日志；
  - 右列：提示词与权限、记忆区、技能树。
- 卡片内边距与标题间距收紧，按钮加 `whitespace-nowrap`，避免「检查路径」在窄列里换行。
- 顶部 Tab 栏同步加宽，纵向 padding 收紧。

## 核心更新页

- 页面内容改为 `max-w-6xl`，左右两列独立堆叠：
  - 左列：环境检测、内核状态、视频运行时（ffmpeg 安装）、下载设置（下载源）；
  - 右列：可更新版本、下载进度（仅在更新时出现）、本机核心目录选择、自编译核心。
- 可更新版本只读取最近 **5** 个 release；当前内核已经是最新版本时，列表里只显示「已是最新」，不再显示更新按钮。
- 本机核心目录改为直接点击切换，不再用下拉框：
  - 点击任一已安装目录行即切换为当前核心，右侧日期区域同属整行按钮；
  - 顶部「自动（最新）」行用于恢复按安装时间自动选择；
  - 选择会落盘，重启后仍生效；切换后重新加载模型生效，自编译核心启用时选择会保存但暂不生效。
- 更新逻辑优化：
  - 后端本来就会在下载前停止 llama-server，前端不再要求用户先手动停止；提示改为「更新会自动停止服务」。
  - 进入页面时当前内核、已安装核心、ffmpeg、发布列表并行读取，不再串行等待。
  - 更新前增加并发锁，避免连点启动两次下载。
  - 事件监听失败时退化为无进度文本，仍然继续更新，不再把 `updatingVersion` 卡死。
  - 更新失败也刷新已安装核心列表；结束时按真实服务状态刷新 `serverRunning` 与模型状态。
  - 内核检查失败会落到明确错误文案，不再停在「正在检查」。

## 验证

- `cd app && npx tsc -b --pretty false`：通过
- `npx eslint src/pages/AgentPage.tsx src/pages/KernelUpdatePage.tsx`：通过
- `npm test`：349 通过 / 0 失败
- 真机 WebView2（CDP 9333）截图：
  - [06-agent-two-column.png](kernel-update-two-column/06-agent-two-column.png)
  - [09-kernel-clickable-cores.png](kernel-update-two-column/09-kernel-clickable-cores.png)
- 真机验证发布列表只返回 5 条；点击 `b11913` 行后 `is_active / is_selected` 正确切换，点击「自动（最新）」后恢复 `b11982`。
