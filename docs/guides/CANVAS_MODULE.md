# 无限画布模块（外挂式）

> 状态：已接入 v0.4.0 开发线。
> 目标：在不把参考项目整套前端合进主应用的前提下，让拾壹具备本地 ComfyUI 生图/视频画布。

## 1. 形态

```txt
Agent 页「画布」标签
  └─ CanvasPanel（状态 / 设置 / 启动 / 停止 / 打开）
       ├─ canvas_manager（Rust）
       │    ├─ 托管 Node 运行时（runtimes/，node_installer）
       │    ├─ 启动 comfyui-gateway（127.0.0.1:8190）
       │    └─ 启动静态服务（127.0.0.1:3210）
       └─ 独立 Tauri 窗口 → http://127.0.0.1:3210
```

参考项目：[1314521gjy/ComfyUI-Local-Infinite-Canvas](https://github.com/1314521gjy/ComfyUI-Local-Infinite-Canvas)（MIT，基于 basketikun/infinite-canvas）。

## 2. 关键约束

- **画布端口固定 3210，不做静默回退。**
  画布项目存在该 origin 的 localStorage / IndexedDB 中；换端口等于换 origin，旧项目会看不到。端口被占用时直接报中文错误。
  不使用 3000：本项目 dev server 占用 3000。
- **网关端口默认 8190，可自动顺延。**
  网关地址通过动态 `config.js` 注入，端口变化不影响画布项目数据。
- **只监听 127.0.0.1。**
  网关 `/api`、`/admin` 默认无鉴权，不要开放局域网或公网。
- **网关自带更新与修复助手关闭。**
  `UPDATE_ENABLED=0`；画布包由应用管理，避免网关 `git pull` 或改源码破坏外挂模块。
- **启动时不做全量扫描。**
  `SCAN_ON_START=0`，否则 ComfyUI 未启动时扫描会拖住 `/health`，导致启动超时。网关就绪后由应用在后台调用 `/api/setup/scan`。
- **Node 运行时由应用的托管安装器负责。**
  优先系统 Node（^22.19 || >=24），其次 `%APPDATA%/AgentLLM/runtimes/node-v*-win-x64`；都没有时由画布面板按需下载（约 35 MB），不需要用户手动安装。

## 3. 数据目录

```txt
%APPDATA%/AgentLLM/canvas/
  config.json          # ComfyUI 地址、画布端口、网关端口、窗口偏好
  data/                # 网关任务、上传、free-workflows 等
  outputs/             # 网关输出
  workflows/           # 首次启动从模块复制；之后升级不覆盖
  logs/gateway.log     # 网关标准输出/错误
  downloads/           # 画布模块下载缓存
  pack/                # 按需安装的画布模块（web + gateway + node_modules）
```

开发环境如果存在 `app/resources/canvas`，会优先使用它（`pack.source = cwd`），不需要重复安装。

## 4. 画布模块的构建与发布

### 4.1 准备源码

```powershell
git clone --depth 1 --filter=blob:none --sparse https://github.com/1314521gjy/ComfyUI-Local-Infinite-Canvas.git canvas-upstream
cd canvas-upstream
git sparse-checkout set --no-cone `
  "/infinite-canvas/web/dist/" `
  "/comfyui-gateway/src/" `
  "/comfyui-gateway/workflows/" `
  "/comfyui-gateway/prompts/" `
  "/comfyui-gateway/package.json" `
  "/comfyui-gateway/package-lock.json" `
  "/comfyui-gateway/resources/index.json" `
  "/VERSION" "/LICENSE" "/NOTICE.md" "/THIRD_PARTY_NOTICES.md"
```

按以下结构复制到 `app/resources/canvas/`：

```txt
app/resources/canvas/
  VERSION
  LICENSE
  NOTICE.md
  THIRD_PARTY_NOTICES.md
  SOURCE.json          # 记录上游 commit / 版本 / 打包范围
  web/                 # infinite-canvas/web/dist 的内容
  gateway/
    src/
    workflows/
    prompts/
    resources/index.json
    package.json
    package-lock.json
    node_modules/      # 只装生产依赖
```

安装网关依赖：

```powershell
cd app\resources\canvas\gateway
npm ci --omit=dev --ignore-scripts
```

### 4.2 打包

```powershell
cd app
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-canvas-pack.ps1
```

产物：

```txt
app/dist-canvas/
  Agent_LLM_Canvas_v0.24.6.zip
  canvas-pack.json     # version / size / sha256 / upstream_commit
```

`app/resources/canvas/` 与 `app/dist-canvas/` 都在 `.gitignore` 中，不入库；发布时把 zip 上传到 GitHub Releases。

### 4.3 配置下载源

`CanvasPanel.tsx` 顶部的 `CANVAS_PACK_RELEASE` 固定了下载地址与 SHA256：

```ts
const CANVAS_PACK_RELEASE = {
  version: '0.24.6',
  url: 'https://github.com/<owner>/<repo>/releases/download/canvas-v0.24.6/Agent_LLM_Canvas_v0.24.6.zip',
  sha256: '<build-canvas-pack.ps1 输出的 SHA256>',
};
```

重新打包后 SHA 会变化，必须同步更新；否则下载会因校验失败而拒绝安装。

没有发布下载源时，画布面板仍支持「从本地 zip 安装」，可离线安装同一份产物。

## 5. 验收

- Agent 页出现「画布」标签，状态圆点按运行/缺失/未启动变化。
- 全新环境：安装 Node → 安装画布模块 → 启动 → 独立窗口打开。
- 画布「设置 → 添加工作流」能扫描 ComfyUI 的 `workflows` 目录并导入。
- 内置工作流在缺模型时显示不可用，不崩溃。
- ComfyUI 未启动时画布能打开，但提交任务给出明确错误。
- 停止画布/退出应用后没有残留 Node 进程，端口释放。
- 重启后画布项目仍在（固定端口 3210）。

## 6. 已知边界

- 画布是外挂 Web 应用，主题、账号、存储与主应用不互通。
- 不打包模型权重、LoRA、自定义节点；内置工作流是否可用取决于本机 ComfyUI 资源。
- 资源中心仍可能从上游地址下载节点/权重，体积与网络由用户确认。
- 画布模块升级需要重新打包并更新 SHA；上游代码变动不自动跟随。

## 7. 排障

- **画布窗口空白 / 不出现**：动态窗口必须在 Tauri 主线程创建（`run_on_main_thread`），不能直接在命令线程 `build`；否则会留下一个 `about:blank` 后立刻消失的窗口。代码已按此实现。
- **画布端口被占用**：先关闭占用程序；不要为了绕开占用直接换端口，画布项目按 origin 保存，换端口会看不到旧项目。
- **应用重启后网关仍在跑**：`canvas/runtime.json` 记录当前网关 PID；应用启动和再次启动画布时会按 PID + 命令行清理上次残留，只杀 `node.exe` 且命令行包含 `canvas` 与 `server.js` 的进程。
- **下载画布模块 404**：GitHub Releases 里还没有对应 tag/asset，或 `CANVAS_PACK_RELEASE` 的 URL/SHA 与发布的 zip 不一致；先上传 `app/dist-canvas/Agent_LLM_Canvas_v<版本>.zip`，再用 `canvas-pack.json` 的 SHA 更新代码。
- **ComfyUI 一直显示离线**：确认地址可从本机访问（LAN 地址也可以）；改地址后要停止再启动画布，网关启动时读取 `COMFY_URL`。

