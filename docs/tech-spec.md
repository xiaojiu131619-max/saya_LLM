# Agent LLM — 历史前端原型规格

> 这份文档保留早期前端原型的设计约束，不再是当前可运行桌面项目的唯一事实来源。当前启动、构建和本地 GGUF 运行说明以 `app/README.md` 为准。

## 依赖清单

| 包名 | 版本 | 用途 |
|------|------|------|
| react | ^19.0.0 | UI 框架 |
| react-dom | ^19.0.0 | DOM 渲染 |
| typescript | ^5.7.0 | 类型系统 |
| vite | ^6.0.0 | 构建工具 |
| tailwindcss | ^4.0.0 | 样式方案 |
| @tailwindcss/vite | ^4.0.0 | Tailwind Vite 集成 |
| lucide-react | ^0.469.0 | 图标系统 |
| framer-motion | ^12.0.0 | 核心动画引擎 |
| recharts | ^2.15.0 | 硬件监控图表 |
| clsx | ^2.1.0 | 类名条件拼接 |
| tailwind-merge | ^2.6.0 | Tailwind 类名合并 |

**不引入的库及原因：**
- **zustand / jotai**：应用状态规模可控（当前视图、主题模式、侧边栏状态、模型列表、排序方式），React Context 足够，无需额外状态库。
- **react-router-dom**：单窗口桌面启动器，视图切换通过全局状态管理，无需浏览器路由。
- **three.js / @react-three/fiber**：3D 倾斜墙效果完全可用 CSS `transform: rotateY/rotateX` 实现，无需真正的 3D 引擎。
- **@radix-ui/* (shadcn 底层)**：所有交互组件（开关、下拉框、对话框）用 framer-motion + 原生 HTML 自定义实现，更贴合设计规范中的动画细节。

---

## 组件清单

### 布局层（Layout）

| 组件 | 来源 | 复用 |
|------|------|------|
| AppLayout | 自定义 | 一次 — 根布局，包裹 DotGridBackground + Sidebar + 主内容区 |
| Sidebar | 自定义 | 一次 — 可伸缩导航栏（240px ↔ 60px），chat 视图下收缩 |
| TopStatusBar | 自定义 | 一次 — 硬件状态栏（GPU/VRAM/RAM + 算力图表） |
| DotGridBackground | 自定义 | 一次 — Canvas 2D 动态点阵背景 |

### 页面级（Pages）

| 组件 | 来源 | 复用 |
|------|------|------|
| HomePage | 自定义 | 一次 — 主页（3D 倾斜墙 + 模型卡片网格） |
| MarketPage | 自定义 | 一次 — 模型市场（发现与下载） |
| ChatPage | 自定义 | 一次 — 聊天界面（仿 llama.cpp WebUI） |
| SettingsPage | 自定义 | 一次 — 设置页面（卡片式配置项） |
| SystemStatusOverlay | 自定义 | 一次 — 全屏硬件监控覆盖层 |

### 可复用组件（Shared）

| 组件 | 来源 | 复用 |
|------|------|------|
| GlassPanel | 自定义 | 多次 — 毛玻璃面板容器（backdrop-blur + 半透明背景） |
| ModelCard | 自定义 | 多次 — 模型卡片（主页 + 市场复用基础结构） |
| NumericTicker | 自定义 | 多次 — 数字滚动器（状态栏 + 系统监控） |
| ToggleSwitch | 自定义 | 多次 — 弹性开关（设置项、主题切换） |
| SortDropdown | 自定义 | 一次 — 排序下拉框 |
| ColumnToggle | 自定义 | 一次 — 单双列切换按钮组 |
| ChatBubble | 自定义 | 多次 — 聊天消息气泡（用户/AI） |
| CodeBlock | 自定义 | 多次 — AI 代码块容器（带语言标签和复制按钮） |
| SparklineChart | 自定义 (recharts) | 多次 — 极简折线微图（状态栏 + 系统监控） |
| DownloadProgress | 自定义 | 多次 — 下载进度面板 |

---

## 动画实现方案

| 动画 | 库 | 实现方式 | 复杂度 |
|------|-----|---------|--------|
| 动态点阵背景（鼠标排斥场） | 原生 Canvas 2D | 离屏 Canvas + requestAnimationFrame，每帧计算点与鼠标距离，Lerp 插值更新位置 | **高** 🔒 |
| 3D 倾斜滚动墙 | CSS transform + JS | 容器设置 perspective: 1000px，内容区 rotateY(-5deg) rotateX(3deg)，scroll 事件驱动 skewY 畸变 | **高** 🔒 |
| 页面转场（视图切换） | framer-motion | AnimatePresence + motion.div，opacity + scale(0.98→1)，ease [0.16, 1, 0.3, 1] | 中 |
| 模型卡片入场（Staggered Reveal） | framer-motion | staggerChildren: 0.05，子元素 y: 30→0, opacity: 0→1 | 低 |
| 卡片位置重排（排序切换） | framer-motion | layout prop 自动处理位置过渡动画 | 低 |
| 模型卡片 Hover 浮动 | CSS transition | translateY(-4px) + 阴影加深，transition 0.2s ease-out | 低 |
| 数字滚动器（Numeric Ticker） | framer-motion / CSS | 垂直数字列 translateY 滚动到目标数字位 | **高** 🔒 |
| 弹性开关（Toggle Switch） | CSS | cubic-bezier(0.34, 1.56, 0.64, 1) 弹簧缓动，thumb translateX 带过冲 | 中 |
| 聊天消息入场 | framer-motion | 用户消息 x: 20→0 滑入，AI 消息 y: 10→0 淡入 | 低 |
| 流式打字输出 | 自定义 JS | setInterval 逐字渲染，间隔 10ms/字，配合 ref 管理 | 中 |
| 下载完成闪光 | CSS | 伪元素白光 opacity 0→100%→0，0.3s 内完成 | 低 |
| 系统监控覆盖层入场 | framer-motion | scale(0.8→1) + 背景透明度渐变 | 低 |
| 图表实时更新 | recharts | 每秒 unshift 新数据点，保持数组长度 60，动画 duration 0 | 低 |
| 侧边栏伸缩 | framer-motion | layout animation，宽度 240↔60 平滑过渡 | 中 |

---

## 状态与逻辑规划

### 全局状态（React Context）

```
AppContext
├── currentView: 'home' | 'market' | 'chat' | 'settings'
├── theme: 'dark' | 'light'
├── sidebarCollapsed: boolean (由 currentView 推导，chat 时自动收缩)
├── models: Model[] (已加载模型列表)
├── sortBy: 'default' | 'name' | 'size' | 'updated'
├── gridColumns: 1 | 2
├── activeModelId: string | null (当前用于聊天的模型)
└── systemStats: { gpuUsage, vramUsed, vramTotal, ramUsage, computeScore[] }
```

### Chat 局部状态（useState，不提升）

```
ChatState (仅在 ChatPage 内)
├── messages: Message[]
├── inputText: string
├── isStreaming: boolean
└── scrollToBottom: boolean
```

### 关键逻辑决策

1. **DotGridBackground 使用命令式 Canvas，而非 React 状态驱动** — 60fps 动画不可通过 React re-render 驱动，必须在 useEffect 中直接操作 Canvas API，通过 ref 共享鼠标坐标。

2. **3D 倾斜墙的 skewY 畸变需节流** — scroll 事件触发频率极高，使用 `requestAnimationFrame` 节流，避免每帧计算 transform。滚动停止检测通过 `setTimeout` 实现（100ms 无新 scroll 事件即判定停止）。

3. **NumericTicker 的数字拆分渲染策略** — 每个数字位独立渲染一个溢出隐藏的容器，内部垂直排列 0-9，通过精确的 translateY 百分比定位目标数字。

4. **系统数据模拟 + 真实数据接口预留** — 初始版本使用 `setInterval` 生成模拟数据，但所有消费组件通过统一 Hook `useSystemStats()` 获取数据，该 Hook 内部封装数据来源切换逻辑，未来替换为 IPC/WebSocket 时零改动。

---

## 其他关键决策

- **不使用 shadcn/ui 组件库**：设计规范要求完全自定义的毛玻璃质感、特定的弹簧动画和 3D 效果，shadcn 的默认样式反而会增加覆盖成本。所有交互组件（开关、下拉框、对话框）从零实现。
- **主题切换通过 CSS 变量 + data 属性**：在 `<html>` 上设置 `data-theme="dark|light"`，Tailwind 通过 `[data-theme="dark"]` 选择器切换颜色变量，避免引入复杂的 CSS-in-JS。
- **模型图标使用 CSS 渐变 + 几何图形代替真实图片**：设计规范中的 3D 渲染图用纯 CSS/SVG 实现抽象几何体（多面体、立方体、圆锥），减少资源加载并保证缩放清晰。
