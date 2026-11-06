# UI/UX 设计边界与实现规则

> 本文件是 Agent_LLM 前端界面（`app/src/`）的**设计边界**：什么能改、按什么刻度改、哪些做法一律禁止。
> 修改任何页面、组件、样式之前先读本文件；评审时按条目编号引用（如 `D-14`）。
>
> 参考来源（2026-11-04 抓取）：
> - **主参考**：Fluent UI 官方仓库 <https://github.com/microsoft/fluentui>（令牌数值取自 `packages/tokens/src/global/`）
> - 整体风格：<https://www.stylekit.top/zh/styles/fluent-design>
> - 模型卡片：<https://www.stylekit.top/zh/styles/quantized-line-field>
> - 数据/仪表盘页：<https://www.stylekit.top/zh/styles/dashboard-layout>
> - 字体：Smiley Sans（<https://github.com/atelier-anchor/smiley-sans>）、破晓像素（<https://fontpixel.com/zh/fonts/poxiao-pixel/>）
> - 图标：<https://lobehub.com/zh/icons>
> - 动效：<https://motion.dev/>

---

## 0. 三层风格分工

界面不是单一风格，而是**一层外壳 + 两类专页**。改动前先确定自己在哪一层，不要跨层套用。

| 层 | 范围 | 风格来源 | 主文件 |
| --- | --- | --- | --- |
| 外壳层（全站默认） | 导航、页头、表单、按钮、弹窗、设置页、聊天页 | Fluent Design + 本项目 Fluent 令牌 | `app/src/index.css` |
| 模型卡片层 | 模型库卡片、模型磁贴、标志区 | 量化线场的视觉语言（**仅限卡片内部**） | `app/src/workspace-design.css`、`components/ModelCard.tsx` |
| 数据页层 | API 服务、用量、性能、内核更新等监控/指标页 | Dashboard Layout 的栅格与 KPI 规则 | 各 `pages/*.tsx`、`features/*/` |

**D-01** 外壳层永远服从 `index.css` 的令牌；模型卡片层只允许在外壳卡片内部叠加视觉语言；数据页层只吸收栅格、KPI、图表比例，不改外壳。
**D-02** 禁止再做一次「整站重排」。全局功能栏 / 统一页头方案已于 2026-10-12 回滚，结论见 `docs/archive/UI_REDESIGN_ACCEPTANCE.md`。

---

## 0.1 Fluent 2 令牌对齐（主参考）

Fluent UI 官方仓库是**主要依据**：数值以 `packages/tokens/src/global/` 为准，不在仓库里的值一律视为参考站自创值，不采纳。

### 采用范围

**D-51** **只取令牌与规范，不引入 `@fluentui/react-components`。** 项目是 Tailwind + 自研组件，整套换成 Fluent React 组件会与现有令牌体系形成双轨；如确需引入，必须整页替换并单独评审。仓库代码为 MIT，但其字体与图标资产另受 assets license 约束，本项目不复制其任何资产。
**D-52** 组件状态必须对应 Fluent 的语义层：`Background1/2/3`、`Background*Hover/Pressed/Selected`、`Foreground1/2/3/Disabled`、`Stroke1/2`、`SubtleBackground`。禁止自造第 4 种悬停色。

### 颜色角色映射

| Fluent 2 角色 | 本项目令牌 | 说明 |
| --- | --- | --- |
| `colorNeutralBackground1`（#ffffff） | `--surface` | 卡片、面板 |
| `colorNeutralBackground2`（#fafafa） | `--app-bg` | 页面底 |
| `colorNeutralBackground3`（#f5f5f5） | `--surface-muted` | 侧栏、分组底 |
| `colorNeutralBackground1Hover` | `--surface-hover` | 悬停底 |
| `colorNeutralBackground1Selected` | `--surface-selected` | 选中底 |
| `colorNeutralForeground1`（#242424） | `--text-primary` | 正文 |
| `colorNeutralForeground2` | `--text-secondary` | 次要 |
| `colorNeutralForeground3` | `--text-tertiary` | 弱化 |
| `colorNeutralStroke1`（#d1d1d1） | `--border` | 常规描边 |
| `colorNeutralStroke2` | `--border-subtle` | 分隔线 |
| `colorBrandBackground` | `--accent` | 主按钮、选中态 |
| `colorBrandBackgroundHover` | `--accent-hover` | |
| `colorBrandBackgroundPressed` | `--accent-pressed` | |
| `colorStatusSuccess/Danger/Warning` | `--state-success/danger/warning` | 语义状态 |
| `colorBackgroundOverlay` | `rgba(0,0,0,.4)` 弹窗遮罩 | |

**D-53** 颜色角色一一对应后，允许 Fluent 的 8 级灰色背景层级只用到前 3 级；不新增 `--surface-4/5/6`。

### 圆角、间距、字号、描边、动效的对齐结果

| 维度 | Fluent 2 原值 | 本项目取值 | 裁决 |
| --- | --- | --- | --- |
| 圆角 | 2 / 4 / 6 / 8 / 12 / 16 / 24 … | `--radius-sm/md`=4、`--radius-lg`=8、`--radius-field`=10、`--radius-panel`=14、`--radius-bubble`=16 | 4/8/16 与 Fluent 的 Medium/XLarge/3XLarge 对齐；10/14 是项目自定档，保留，不再新增 |
| 间距 | 0 / 2 / 4 / 6 / 8 / 10 / 12 / 16 / 20 / 24 / 32 | 同左，全部采用（含 2、6、10 三个 nudge 档） | 采用完整 Fluent 刻度 |
| 字号 | 10 / 12 / 14 / 16 / 20 / 24 / 28 / 32 / 40 / 68 | `--font-*` = 10/11/12/14/15/16/18/22/40 | 保留项目刻度；18 与 22 是项目细分档，属有意偏离 |
| 描边 | 1 / 2 / 3 / 4 | 只用 1（常规）与 2（选中/焦点） | 3、4 禁用 |
| 时长 | 50 / 100 / 150 / 200 / 250 / 300 / 400 / 500 | 见 D-16 | 只用到 300 |
| 曲线 | `curveEasyEase`、`curveDecelerateMin`、`curveAccelerateMax` 等 9 条 | 见 D-17 | 采用 3 条 |

**D-54** 字号保留项目现有刻度（18/22），不迁到 Fluent 的 20/24/28；迁移会造成全站字号跳动，收益不足。
**D-55** 描边只用 1px；选中与焦点用 2px。禁止 Fluent 的 `strokeWidthThicker(3)` / `Thickest(4)`。
**D-56** Fluent 的 `display`（68px）仅允许出现在启动页/空态大标题，全站常规页面一律不用。

---

## 1. 颜色：只许用语义令牌

参考站给的十六进制是**参考值**，不是可复制值。落地一律映射到现有令牌：

| 参考值 | 本项目令牌 | 用途 |
| --- | --- | --- |
| `#0078d4` / `#106ebe` / `#005a9e` | `--accent` / `--accent-hover` / `--accent-pressed` | 主色、链接、焦点环 |
| `#f3f2f1` | `--surface-muted` | 辅背景、侧栏 |
| `#323130` | `--text-primary` | 正文主色 |
| `#605e5c` | `--text-secondary` | 次要文字 |
| `#a19f9d` | `--text-tertiary` | 弱化文字、占位符 |
| `#e1e1e1` / `#8a8886` | `--border` / `--border-strong` | 常规边框 / 输入框边框 |
| `#fafaf8` | `--app-bg` | 页面底色（已有 #FAFAFA，不再引入第二个纸白色） |
| `#10b981` / `#f59e0b` / `#ef4444` | `--state-success` / `--state-warning` / `--state-danger` | 状态色（含各自 `-bg`、`-border`） |
| `#6366f1` | `--accent` | 数据页强调色，不引入第二主色 |
| `#2152e7` | `--accent`（仅线场可做 `color-mix` 偏移） | 线场强调，不新增品牌蓝 |

**D-03** 组件里禁止出现十六进制颜色值（图表内联色板除外，见 D-05）。
**D-04** 禁止引入第二套状态色。三份参考里的 `text-green-500` / `text-red-500` / `text-yellow-500` 一律换成 `--state-*`。
**D-05** 图表（recharts）允许集中定义色板常量，但每个色值必须从令牌取值（`getComputedStyle` 或 CSS 变量字符串），不得散落在 JSX 里。
**D-06** 暗色主题由 `.dark` 覆盖同一批令牌，组件**不得**写 `dark:` 版颜色（现有少数 `dark:border-white/[0.08]` 属存量，不再新增）。

---

## 2. 字体：四级分工，不许混排

| 角色 | 字体 | 用法 | 限制 |
| --- | --- | --- | --- |
| UI 正文 / 标签 | `--font-sans`（Segoe UI Variable → Microsoft YaHei UI） | 全站默认 | 默认字体，不要改 |
| 展示标题 | Smiley Sans（得意黑） | 页面 Hero、空态大标题、版本/品牌字样 | 仅 ≥ 20px；只做展示 |
| 像素标签 | 破晓像素 PoxiaoPixel | 徽章、状态胶囊、终端感小标签 | 仅 12px 及 12 的整数倍 |
| 等宽 / 指标 | `--font-mono`（Cascadia Mono） | 数值、坐标、日志、tok/s | 配合 `tabular-nums` |

**D-07** 字号只能取令牌：`--font-micro(10) / eyebrow(11) / caption(12) / body(14) / chat(15) / subtitle(16) / title(18) / display(22) / hero(40)`。禁止 `text-[Npx]`、禁止内联 `fontSize`（图表库内部除外）。
**D-08** Smiley Sans 有整体倾斜与手绘感，上游明确**不适合正文、代码、手机界面**。因此只用于 ≥18px 的页面主标题（`.page-title`）、展示标题（`.display-title`）与空态大标题；不用于正文、按钮、表单、列表行、表格与数字，同一行不与 Segoe UI 混排。
**D-09** 破晓像素是 12px 设计尺寸的点阵字体，必须在 12/24/36px 使用；非整数倍会模糊。只用于**固定短文本**（如「已加载」「GPU」）；模型名、路径、错误信息这类长度不可控或含生僻字的内容禁止使用（GBK 覆盖率 59.74%）。
**D-10** 数字指标一律 `--font-mono` + `font-variant-numeric: tabular-nums`，避免刷新时数字跳动。
**D-11** 两款新字体以 WOFF2 随包分发，`@font-face` 加 `font-display: swap`；授权均为 OFL-1.1，允许随应用嵌入，但衍生物必须沿用 OFL 并在 `THIRD_PARTY_NOTICES` 声明。
**D-58** 字体文件放 `app/src/assets/fonts/` 并用本地相对路径引用。禁止 CDN / 远程字体：桌面端离线即失效，且引入隐私、CSP 与版本漂移问题。只打包实际用到的字重与字形。
**D-59** 随包展示字体只用于固定文案；模型名、文件路径、错误信息等用户数据必须回退 `--font-sans`，不得依赖展示字体的字符覆盖（破晓像素 GBK 覆盖仅 59.74%，缺字会显示豆腐块）。

---

## 3. 图标：功能图标与品牌图标严格分开

| 类别 | 库 | 尺寸 | 颜色 |
| --- | --- | --- | --- |
| 功能图标（导航、按钮、状态） | `lucide-react` | 14 / 16 / 18 / 20 | `currentColor` |
| 模型 / 厂商标志 | `@lobehub/icons`（已接入 `components/ModelFamilyLogo.tsx`） | 18 / 20 / 24 / 28 | 彩色原样；单色品牌可用主题色 `tone` |

**D-12** 功能图标只用 lucide，品牌图标只用 `@lobehub/icons`；禁止用品牌图标当按钮图标，也禁止为品牌手绘 SVG。
**D-13** 图标尺寸只取四档，同一行内必须一致。与 `--font-body` 同行用 16，与 `--font-caption` 同行用 14，列表首列用 18，工具栏主操作 20。
**D-14** 图标不承担唯一语义：所有纯图标按钮必须有 `aria-label` 与 `title`。
**D-15** 像素风图形（线场、点阵装饰）不得替代品牌标志，标志必须仍可识别为对应厂商。

---

## 4. 动效

项目已装 `framer-motion`（v12，即 motion.dev 的现名），**不需要**再引入 `motion` 包。

**D-16** 时长取 Fluent 档位，上限 300ms：悬停/按压 100ms（Faster），展开收起与状态切换 150ms（Fast），卡片与浮层 200ms（Normal），弹窗/抽屉入场 250–300ms（Gentle/Slow）。禁用 Fluent 的 400/500 档。
**D-17** 缓动取 Fluent 三条曲线：入场 `curveDecelerateMin` = `cubic-bezier(0.33, 0, 0.1, 1)`；状态切换 `curveEasyEase` = `cubic-bezier(0.33, 0, 0.67, 1)`；退场 `curveAccelerateMax` = `cubic-bezier(0.9, 0.1, 1, 0.2)`。线性曲线只允许用于进度条、骨架屏与循环指示器。
**D-18** 弹簧只允许用于线场与卡片视差（参考参数 `stiffness 145 / damping 19`，积分步长 ≤ 1/30s）；UI 状态切换禁止弹簧。
**D-19** 入场动画不得与内容可见性耦合：禁止 `initial={{ opacity: 0 }}` 这类把可见性写进 JS 的写法，改用 `.anim-*` CSS 类（教训见 `components/SettingSection.tsx` 注释）。
**D-20** 必须响应 `prefers-reduced-motion` 与设置项「减少动画」（`html.reduce-motion`）；加载指示器 `animate-spin` 例外。
**D-21** 禁止用动画掩盖内容未就绪：骨架屏可以有，但加载失败必须落到错误态，不能无限动画。

---

## 5. 组件规则

### 5.1 按钮
- 主按钮：`--accent` 底 + `--text-on-accent`，圆角 `--radius-md`，`active:scale-[0.97]`
- 次按钮：透明底 + `--border`，hover `--surface-hover`
- 文字按钮：无底无边，hover 只变文字色
- 危险操作：`--state-danger`，且必须二次确认（沿用 `ConfirmDialog`）

**D-22** 每个可交互元素必须有 hover / active / focus-visible 三态；焦点环 2px `--accent`、offset 2px（已全局定义，不要覆盖）。
**D-23** 输入框不加 outline，聚焦靠 `border-color: --accent`（用户明确要求，`index.css:225`）。
**D-24** 禁用态用 `opacity: 0.45` + `cursor: not-allowed`，不得只改颜色导致对比不足。
**D-25** 优先复用 `.panel`、`.action-button`、`.form-input`、`ToggleSwitch`、`ConfirmDialog`。当前 `.action-button` 使用 0 处、`.form-input` 1 处，属历史欠账；新代码不得继续手搓同类样式。

### 5.2 卡片
- 外壳：`border: --border-subtle`、`background: --surface`、`radius: --radius-panel`、`shadow: --shadow-card`
- hover：边框转 `--accent` 或底色 `--accent-subtle`，**不叠加大阴影**

**D-26** 卡片圆角统一 `--radius-panel`（14px）。不引入参考站的 17px 特例。
**D-27** 阴影只有三级：`--shadow-card`（卡片）、`--shadow-flyout`（下拉/浮层）、`--shadow-dialog`（对话框）。禁止自定义大阴影。
**D-28** 卡片内边距：紧凑 12px、标准 16px、宽松 20px；卡片间距 8/12/16 三档，同一列表内必须一致。

### 5.3 状态
**D-29** 四态齐全，且形态固定：加载（骨架或 spinner + 文案）、空（图标 + 一句说明 + 主操作）、错误（`--state-danger` + 原因 + 重试）、禁用。
**D-30** 状态色语义固定：加载中 `--status-loading`、成功/已加载 `--status-loaded`、失败 `--status-error`、待机 `--status-standby`、下载 `--status-downloading`。不得自行映射。

---

## 6. 布局

**D-31** 侧栏宽度沿用现状：常规 `w-60`（240px），窄窗 `w-52`（208px）。**不采纳**参考站 `w-64` 深色侧栏——现有侧栏是 `--surface-muted` 浅色，改深色会与 Fluent 外壳冲突。
**D-32** 内容区宽度：常规 `max-w-[1180px]`，视口 ≥1600 时 `max-w-[1520px]`。新增页面必须复用这两档，不得各写一个值。
**D-33** 断点按**内容区宽度**判断，不按视口：侧栏占 240/208px，结构性切换用 `index.css` 的容器查询，禁止只看 `min-[1600px]` 之类的视口断点（详见记忆 `ui-width-adaptation`）。
**D-34** 间距取 Fluent 全刻度：2 / 4 / 6 / 8 / 10 / 12 / 16 / 20 / 24 / 32（2、6、10 为 nudge 档，只用于微调图标与文字基线）。区块间距 24，卡片内 16，控件间 8，行内 4。禁止 5/7/9/14/18/22 这类刻度外数值。
**D-35** 触控目标不小于 32×32（桌面）/ 44×44（触控）；`flex` 布局中必须给可收缩项加 `min-w-0`，否则会把兄弟元素挤爆（记忆 `ui-width-adaptation`）。

---

## 7. 模型卡片：量化线场的落地改编

参考站是「整卡 Canvas 线场 + 三张展示卡」的视觉研究，直接照搬到 100+ 条的模型列表会拖垮性能。因此**只取视觉语言，不取整卡实现**。

**D-36** 线场就是模型磁贴里**唯一的品牌标志**：卡片固定 3:4，60 列 × 30 段细线铺满整卡，标志正方形在卡片内**居中**（约占短边 57%）；底部文字用主题色到 `--surface` 的渐变浮层压在线场上，禁止再把 Logo 图片或 SVG 叠在视觉最上层。
**D-37** 线场必须由真实标志采样生成（300×300 离屏画布、60×60 网格、Rec.709 亮度、0.12/0.42/0.89 三阈值四档线宽）；标志按 0.82 缩放居中，背景空白格只画最细一档，避免整片网格噪点。禁止用图片或 SVG 贴图冒充可见标志。
**D-38** 每张卡片只在**可见且被悬停/选中**时跑 rAF；其余显示初始化静态首帧。屏外必须 `IntersectionObserver` 暂停。
**D-39** 卡片数超过 24 张时全局关闭线场动画，只保留静态帧。
**D-40** 采样只做一次并缓存（按模型 id + 品牌路径），尺寸变化与 DPR 变化都不得重新采样；只需重建画布缓冲。
**D-41** 线场区域内禁止 `blur` / `backdrop-filter` / 大范围 `box-shadow` 制造体积——层次靠「底板 + 6px 偏移 + 描边」表达（参考做法）。
**D-42** 列表卡悬停只提升线场不透明度（0.28 → 0.40）与边框色，**不做位移**，避免网格滚动时整排卡片跳动。参考站的「卡片上移 4px + 底板下移 8px」视差只允许用于单列大卡或详情页。
**D-43** 线场配色按四级优先级取：`themeColorSolid` 自定义 → 图标品牌色（`@lobehub/icons` 的 `COLOR_PRIMARY`，321 个品牌都有）→ 家族回退色 → `--accent`。底板与描边必须由该色 `color-mix` 派生（浅底压暗 16%、深底提亮 28%），并做对比度校验；单卡可用色相微调，但禁止新增第二套全局色板。
**D-44** 减少动画模式下默认静止，键盘聚焦显示检测框，不模拟指针位移。
**D-57** 线场分三档，按场景选，不许混用：**静态首帧**（全部卡片，采样后画一帧即停）／**单卡动效**（悬停或选中的那一张，全局最多 1 个并发，列表页推荐）／**完整动效**（详情页单张大卡）。列表页禁止完整动效。

---

## 8. 数据 / 仪表盘页

**D-45** KPI 栅格：大屏 4 列、中屏 2 列、窄屏 1 列；KPI 卡固定三段式「标签 / 数值 / 变化」，数值用 `--font-hero`(40) 或 `--font-display`(22)。
**D-46** 图表区比例：主图 2/3 + 辅图 1/3；单图用 `aspect-video`，方形分布图用 `aspect-square`。
**D-47** 禁止所有面板同等大小：一屏内至少区分主/次两级面积。
**D-48** 趋势色只表语义：上升 `--state-success`、下降 `--state-danger`、持平 `--state-warning`；与「好/坏」无关的指标不得套用红绿。
**D-49** 加载与空态是必选项，不是可选项；数据未到不得渲染 0 冒充真实值。
**D-50** 表格/列表 hover 必须有整行底色反馈（`--surface-hover`），数值列右对齐。

---

## 9. 禁止清单（合并三份参考 + 本项目既有约束）

- 禁止 `rounded-none`（Fluent 必须有圆角）
- 禁止 `border-2` / `border-4` 这类粗边框
- 禁止硬边阴影 `shadow-[Npx_Npx_0px ...]`
- 禁止 `font-black`；禁止 `font-serif`（参考站的衬线大标题不进入本项目）
- 禁止 `bg-black` 纯黑底
- 禁止 `shadow-2xl`、`rounded-3xl`（卡片一律 `--radius-panel`）
- 禁止 `text-5xl` 及以上（唯一例外：KPI 巨型数字 `--font-hero`）
- 禁止 `rounded-full` 用于卡片/面板（圆点、头像、开关、胶囊不受限）
- 禁止过度使用亚克力：只在浮层、标题栏使用，卡片内不使用 `backdrop-blur`
- 禁止动画超过 300ms
- 禁止缺少 focus-visible 状态
- 禁止用 Logo 图片 / SVG 元素替代线场标志
- 禁止每帧读取像素、禁止尺寸变化时重新采样
- 禁止把视觉检测框描述为「AI 识别结果」
- 禁止给线场线段使用连续线宽（必须四档分节）
- 禁止新增十六进制色值 / 第二套状态色 / 第二套圆角刻度
- 禁止新增 `text-[Npx]` 与内联 `fontSize`
- 禁止 3px / 4px 描边（Fluent 的 Thicker/Thickest 不进入本项目）
- 禁止把 68px `display` 用于常规页面
- 禁止引入 `@fluentui/react-components`（未经整页替换评审前不允许）
- 禁止自造第 4 种悬停 / 选中 / 禁用色（只允许 Fluent 的 Hover / Pressed / Selected / Disabled 四层）
- 禁止在 `ipc/` 层写 UI 逻辑（见记忆 `desktop-ipc-layering`）

---

## 10. 交付前自检

1. `npx tsc -b` 零错误（不要用 `tsc --noEmit`，见记忆 `desktop-tsc-project-references`）
2. `npm run lint` 不高于基线 8 problems（4 error / 4 warning）
3. 全仓搜索 `text-\[`、`rounded-\[`、`#[0-9A-Fa-f]{6}`，新增文件必须为 0
4. 亮/暗两主题各截一张图；毛玻璃模式再截一张
5. 键盘 Tab 走一遍：焦点环可见、顺序合理、图标按钮有 `aria-label`
6. 开启「减少动画」复查：无卡在中途的元素、无内容不可见
7. 窄窗（≤900px）复查：侧栏收窄后不挤压、不横向滚动
8. 数据页复查：加载、空、错误、有数据四态都真实可见
9. 模型列表复查：>24 张时线场静止、屏外无 rAF、悬停占位高度不变

---

## 11. 落地顺序（建议）

| 阶段 | 内容 | 风险 |
| --- | --- | --- |
| P0 | 补齐令牌：Fluent 动效时长/曲线、间距别名、`--font-brand`、`--font-pixel`；`THIRD_PARTY_NOTICES` | 低 |
| P1 | 字体落地：Smiley Sans / 破晓像素 WOFF2 + `@font-face` + 展示位替换 | 低（中文字库体积大，需子集化） |
| P2 | 组件收口：把 `.action-button` / `.form-input` 在主要页面替换手搓样式 | 中（改动面广，逐页验证） |
| P3 | 模型卡片线场：静态首帧 → 悬停动效 → 性能门（24 张阈值） | 中高（Canvas + 性能） |
| P4 | 数据页 KPI 栅格统一 | 中 |
| P5 | 全站体检：按第 10 节逐项过 | 低 |

**已定口径**：
1. 字体**随包分发**（见 D-58），全量不子集：得意黑 woff2 1.10MB + 破晓像素 woff2 1.21MB，合计约 2.3MB。
2. 线场采用「单卡动效」形态：全部卡片静态首帧，只有悬停/选中那张运行动效，全局最多 1 个并发（见 D-57）。
3. 线场配色：自定义 > 图标品牌色 > 家族回退 > `--accent`（见 D-43）。

**已落地（P0/P1）**：
- `index.css` 新增 `--font-brand` / `--font-pixel` 与 `@font-face`（`app/src/assets/fonts/`）
- `.page-title` / `.display-title` 切到展示字体；`.model-tile-status` 切到像素字体
- 新增 Fluent 动效令牌 `--duration-*`、`--curve-*`

**仍待定**：
1. 线场检测框是否进入首版（它只用于单卡动效档）
