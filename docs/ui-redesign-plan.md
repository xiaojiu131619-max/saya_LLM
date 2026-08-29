# Agent LLM UI 重设计执行报告（克制毛玻璃 + 原生主题）

> 状态：**✅ 已完成** · 2026-08-27 · 自包含交付物
> 方向：底层逻辑不动，只做视觉层；克制毛玻璃 + 原生黑白切换 + 主题色跟随。

## 0. TL;DR

3 个文件改动完成：

| 文件 | 改动 |
|---|---|
| `app/src/features/model/ModelWorkspace.tsx` | 侧边栏 4 个卡片组件 → 1px 线段分隔的段落式 |
| `app/src/index.css` | `.titlebar` blur 40→22, saturate 1.8→1.5；新增 `.acrylic` 工具类 + body::before 假壁纸 |
| `app/src/tauri.conf.json` | **未改**（已含 `windowEffects: ["mica"]`，见 §3 trade-off） |

未引入新依赖，未改 Rust 端。

## 1. 现状核实结论（重写：原 plan 里说"以下已存在"的部分全核过了）

### 1.1 已存在 / 勿动
- ✅ **系统 accent 读取**：`system.rs::get_system_appearance` 命令，字段 `accent_color` / `apps_use_light_theme` / `supports_mica`。
- ✅ **Mica 支持检测**：`system.rs::detect_supports_mica()`，判定 Win11 22H2+（Build ≥ 22621）。
- ✅ **accent 注入 CSS 变量**：`AppContext.tsx:675-694`，按 `state.theme` 自动重新派生 hover/pressed/subtle。明暗区分完整：
  - 亮色：hover = `mixAccent(accent, -0.12)`，pressed = `-0.22`
  - 暗色：hover = `+0.18`，pressed = `+0.08`
- ✅ **跟随系统亮/暗**：`AppContext.tsx:701+` `matchMedia('(prefers-color-scheme: dark)')` + `THEME_MANUAL_FLAG` 手动优先；`themePreferenceVersion === 2` 持久化。
- ✅ **CSS 毛玻璃雏形**：`.titlebar { backdrop-filter: blur(40px) saturate(1.8) }`（参数偏重，**本轮已克制化**）。
- ✅ **Tauri 窗口效果**：`tauri.conf.json` 已设 `"windowEffects": ["mica"]` + `"transparent": true` + `"backgroundColor": "#00000000"`。

### 1.2 本轮真正改动
- ❌→✅ 侧边栏 4 卡片 → 段落式（1px 线段分隔）
- ❌→✅ `.titlebar` blur/saturate 偏重 → 克制
- ❌→✅ 浏览器模式无"假壁纸" → 加 body::before 渐变
- ❌→✅ 缺通用 `.acrylic` 工具类 → 新增

### 1.3 跳过 / Trade-off
- ⏭ **桌面模式 body 半透明让 mica 渗透**：高风险（主区可读性下降），不在本轮 scope。
- ⏭ **`tauri-plugin-window-vibrancy` 第三方插件**：不需要——Tauri 2 内置 `set_effects()`，且 `tauri.conf.json` 静态配置已生效。

## 2. 设计基线（已落地）

| 维度 | 目标值 | 落地位置 |
|---|---|---|
| 浏览器 `.titlebar` | blur 22px, saturate 1.5, 透明度 0.82 | `index.css:209-214` |
| 浏览器 `.acrylic` | blur 20px, saturate 1.4, 透明度 0.72 | `index.css:218-223`（新） |
| 浏览器 `.acrylic-strong` | blur 28px, saturate 1.6 | `index.css:225-230`（新） |
| 浏览器假壁纸 | body::before 3 段径向渐变，z-index -1 | `index.css:123-145`（新） |
| 桌面 OS 效果 | Tauri 自动判断 Mica/Acrylic/None | `tauri.conf.json` |
| 字体/圆角 | Segoe UI Variable / 4-8px | 既有，未动 |
| accent 派生 | mixAccent + theme 重新派生 | `AppContext.tsx` 既有 |
| 明暗切换 | matchMedia + manual flag | `AppContext.tsx` 既有 |

## 3. 已知 Trade-off（要让你知道）

### 3.1 桌面模式 Mica/Acrylic 视觉渗透
- **现状**：`tauri.conf.json` 启用 mica，OS 层在 Win11 22H2+ 生效。
- **视觉被 body 实色盖住**：`body { background-color: var(--app-bg) }` 是 #FAFAFA 不透明，OS Mica 效果被 webview 内部色盖住。
- **能看到 Mica 的前提**：body 半透明 + 主区也半透明（保证可读性）。这是大改，需要视觉调优，本轮跳过。
- **当前桌面模式仍能看到的效果**：`.titlebar` 的 backdrop-filter 22px 模糊（背后是 body 实色，但仍有微妙"轻"感）。要看真壁纸色需要浏览器模式或后续 body 透明化。

### 3.2 浏览器模式假壁纸的颜色基调
- 用了微软 Fluent 蓝 + Fluent 橙 + 深蓝 3 段径向渐变。
- 若你想要冷/暖/中性不同调子（影响品牌氛围），改 `index.css:130-143` 的 `radial-gradient` 颜色即可。
- 桌面模式这个渐变被 webview 遮挡不影响。

## 4. 验证清单

| 验证项 | 结果 |
|---|---|
| `npm run lint` | ✅ 0 error，6 warning（全部预先存在） |
| `npm run build` | ✅ 5.7s 成功，2453 modules transformed |
| `cargo check` (Rust) | ✅ Finished，0 warning 0 error，LASTEXITCODE 0 |
| TS 编译 | ✅ 无 TS error |
| 业务逻辑保留 | ✅ onClick / dispatch / onStop / openSettings 全部未动 |
| 死代码清理 | ✅ `Power` `Activity` `Gauge` `HardDrive` `MemoryStick` `CircleAlert` `CircleCheck` `ServiceMetric` 子组件 已从 import / 代码中删除 |
| `.titlebar` 引用 | ✅ WorkspaceShell.tsx 仍用 `.titlebar` 类，效果克制化已生效 |
| `.acrylic` 类 | ✅ 已暴露，尚未被任何 TSX 引用（备用工具类，浮层/输入区/命令面板可用） |
| 侧边栏段落式 | ✅ 4 组件 + 容器 + 底部已改，零卡片样式组合（无 `bg-[var(--surface)] rounded-md border` 三件套） |
| 主题色跟随 | ✅ AppContext 已有 mixAccent 派生；改 Windows 个性化-主题色 → 注入新 accent；改系统明暗 → 重新派生 |
| 明暗切换 | ✅ matchMedia 自动 + 手动优先；`THEME_MANUAL_FLAG` localStorage |

## 5. 关键文件改动

### 5.1 `app/src/features/model/ModelWorkspace.tsx`
- 顶部 import 删 8 个图标（`Activity, CircleAlert, CircleCheck, Gauge, HardDrive, MemoryStick, Power`），保留 10 个
- `LoadedModelPanel` 卡片 → 段落：`border-b border-[var(--border-subtle)] py-2.5` + 11px 小标题 + 状态点 + 行内文字按钮「停止运行」
- `ServiceStatusPanel` 4 宫格嵌套 → 2 行纯文本 grid + ctx 进度条横排
- `LlamaLogsCard` 卡片 → 单行段落：icon + 「llama 日志」+ 状态点 + chevron
- `ServiceMetric` 子组件 删除（不再用）
- 容器 `mt-5 space-y-2 px-2` → `mt-5 px-3`（去掉卡片间距）
- 底部「当前目标」+ [主题][设置] → 段落式跳转行 + 行内操作

### 5.2 `app/src/index.css`
- 亮色 token：`--titlebar-bg` 0.7→0.82，新增 `--acrylic-bg` 0.72 + `--acrylic-border`
- 暗色 token：`--titlebar-bg` 0.7→0.78，新增 `--acrylic-bg` 0.68 + `--acrylic-border`
- `.titlebar` blur 40px→22px，saturate 1.8→1.5
- 新增 `.acrylic` 类（blur 20px + saturate 1.4 + 1px border）
- 新增 `.acrylic-strong` 类（blur 28px + saturate 1.6）
- 新增 `body::before` 浏览器模式假壁纸（3 段径向渐变，z-index -1）

### 5.3 未改
- `app/src/context/AppContext.tsx`：明暗区分 accent 派生已完整
- `app/src/lib/desktop.ts`：系统外观 API 已完整
- `app/src-tauri/src/lib.rs` / `Cargo.toml`：Mica/Acrylic 静态配置已完整
- `app/src-tauri/tauri.conf.json`：windowEffects 已正确
- 任何 page 内容 / chat 流 / 模型启动逻辑

## 6. 验收方式（请你在自己机器跑）

### 6.1 浏览器模式（最快）
```powershell
cd D:\Projects\Agent_LLM\app
npm run dev
# 浏览器打开 http://127.0.0.1:3000
```
应能看到：
- 顶栏明显毛玻璃化（blur 22px 比之前轻）
- body 背景有微妙彩色渐变（冷色调）
- 侧边栏 4 卡片消失，改为 1px 线段分隔的 4 段
- 主题切换（明/暗）响应正常

### 6.2 桌面模式
```powershell
cd D:\Projects\Agent_LLM\app
npm run desktop
```
应能看到：
- 侧边栏段落化（同上）
- 顶栏 backdrop-filter 仍在工作（背后是 body 实色，视觉上比之前轻）
- Mica 效果被 body 盖住（trade-off，已说明）
- 改 Windows 个性化-主题色 → accent 跟随
- 改 Windows 个性化-明暗 → 应用跟随

### 6.3 回归
- 模型扫描/加载/启动/停止
- 聊天流式输出
- 多模态附件（图片/音频/视频）
- 工具调用
- API 暴露
- 设置各 section
- 日志

## 7. 后续可选增强（不在本轮 scope）

- **桌面模式 body 半透明**：让 OS Mica 真正渗透到主区。风险：可读性。改法：App.tsx 加 `data-tauri` 属性，CSS 用 `[data-tauri] body { background: rgba(250,250,250,0.85) }` + WorkspaceShell 主区 0.95 不透明。
- **Chrome 区域用 .acrylic 工具类**：浮层/输入区/命令面板的 className 加 `.acrylic`，替代现有 `bg-[var(--surface)]`。
- **自定义主题色设置页**：让用户在应用内选择 accent 而非跟随系统。
- **Mica Alt 模式（深色）**：当前 `state: "active"`，可加 follow 系统明暗自动 active/inactive。
