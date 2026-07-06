# Comfy API 生图工作区推进计划书

> 状态：待执行  
> 目标：在 Agent LLM 中重写一个基于 ComfyUI API 的生图界面。  
> 原则：先做到稳定可用，再逐步兼容复杂工作流；工作流是底座，界面只是参数控制器。

## 1. 背景与目标

当前项目已移除旧的生图相关代码，后续需要重新实现一个连接 ComfyUI API 的生图工作区。新界面需要支持：

- 读取 Comfy 工作流
- 上传 Comfy 工作流
- 切换模型
- 切换、增加、减少 LoRA
- 上传图片并写入工作流
- 输入正提示词和负提示词
- 更改生图比例和分辨率
- 输出复数图片
- 图库展示
- 推荐提示词生成
- 点击图片读取提示词和生成信息

本计划重点解决三个问题：

1. 如何让界面适配不同 Comfy 工作流，而不是写死一套 SD 表单。
2. 如何把生图任务、图库、参数复用做成可追溯、可恢复的闭环。
3. 如何分阶段推进，避免第一版范围过大。

## 2. 产品定位

建议把新功能定位为：

**Comfy 生图工作区 = 工作流驱动的生图控制台。**

它不是一个替代 ComfyUI 的节点编辑器，也不是只服务单一模型的简单文生图页面。它应该负责：

- 管理常用工作流
- 识别工作流中的关键参数节点
- 提供更适合日常使用的表单化控制界面
- 提交任务到 ComfyUI
- 保存输出、参数和工作流快照
- 支持从历史图片恢复配置并再次生成

不建议第一阶段实现完整节点编辑能力。节点图编辑本身复杂度很高，且会偏离当前 Agent LLM 的产品方向。

## 3. 设计原则

### 3.1 工作流优先

上传或选择工作流后，前端解析 workflow JSON，提取可控节点，生成参数映射。用户改的是界面控件，底层实际改的是 workflow JSON 的指定 node input。

### 3.2 默认值显式可见

不要静默改动用户工作流中的默认推理参数。包括：

- seed
- steps
- cfg
- sampler
- scheduler
- width
- height
- batch_size
- 模型
- LoRA 强度

界面可以显示这些值，也可以让用户修改，但任何修改都应来自明确操作。

### 3.3 自动识别 + 手动绑定

Comfy 工作流千差万别，不能只依赖自动识别。建议：

- 常见节点自动识别
- 识别失败时给出手动绑定入口
- 绑定结果按工作流保存
- 同一个工作流下次加载时自动恢复绑定

### 3.4 图片输出可追溯

每张输出图都要保存完整生成信息：

- prompt_id
- 正提示词
- 负提示词
- 模型
- LoRA 列表
- 尺寸
- seed
- steps / cfg / sampler / scheduler
- 原始 workflow JSON 快照
- 输出文件信息
- 创建时间

这样才能支持“点击图片读取提示词和生成信息”以及“一键复用”。

### 3.5 先支持常见路径，再支持复杂路径

推荐推进顺序：

1. 文生图基础工作流
2. 图生图 / 参考图
3. 已存在 LoRA 节点的工作流
4. 动态插入 LoRA 节点链
5. ControlNet / IPAdapter / 局部重绘等扩展工作流

## 4. 参考界面布局

已有参考稿：

- `tmp/comfy-ui-reference.png`
- `tmp/comfy-ui-reference.html`

建议采用三栏工作台：

| 区域 | 主要内容 | 目的 |
| --- | --- | --- |
| 左侧资源栏 | 工作流、模型、LoRA、图片输入 | 管理输入资源 |
| 中间主工作区 | 正反提示词、生成按钮、图库 | 完成主操作 |
| 右侧参数栏 | 比例、分辨率、采样参数、队列、绑定状态 | 控制可复现参数 |

这种结构适合桌面应用：

- 左侧用于选择和上传
- 中间承载最高频操作
- 右侧显示可调参数和当前状态

## 5. 信息架构

建议新增一个独立视图：

- `image`：Comfy 生图工作区

它不建议归入“设置中心”。生图属于高频主功能，应该和聊天、模型加载一样是一级工作区。

建议后续视图结构：

| ViewType | 说明 |
| --- | --- |
| `home` | 首页 / 模型入口 |
| `modelLoad` | 模型加载工作区 |
| `chat` | 聊天工作区 |
| `image` | Comfy 生图工作区 |
| `settings` | 设置 |
| `tools` | 工具 |
| `logs` | 运行日志 |

当前代码里 `WorkspaceShell` 已经出现过 `image` 判断痕迹，但 `ViewType` 中暂时没有 `image`。正式开发时需要统一类型和路由。

## 6. 关键用户流程

### 6.1 首次使用

1. 用户进入“生图”工作区。
2. 输入或确认 ComfyUI 地址，例如 `http://127.0.0.1:8188`。
3. 点击“连接”。
4. 应用请求 ComfyUI 状态和对象信息。
5. 成功后显示模型、LoRA、采样器等资源列表。
6. 用户上传或选择工作流。
7. 应用自动识别可控节点。
8. 用户确认或手动绑定关键节点。
9. 输入提示词并开始生成。

### 6.2 常规文生图

1. 选择工作流。
2. 选择模型。
3. 设置 LoRA。
4. 输入正反提示词。
5. 设置比例和分辨率。
6. 设置生成张数。
7. 点击“开始生成”。
8. 查看队列进度。
9. 输出进入图库。

### 6.3 图生图 / 参考图

1. 工作流中存在 `LoadImage` 类节点。
2. 用户上传图片。
3. 应用调用 ComfyUI 上传图片接口。
4. 上传成功后，把返回文件名写入对应 `LoadImage` 节点。
5. 用户开始生成。

### 6.4 从图库复用

1. 用户点击历史图片。
2. 应用打开图片详情面板。
3. 应用读取本地生成记录或图片 metadata。
4. 展示正反提示词、模型、LoRA、尺寸、seed、采样参数、工作流。
5. 用户点击“复用”。
6. 应用恢复当次参数到当前工作区。
7. 用户可直接再次生成或微调后生成。

## 7. Comfy API 封装建议

建议只在一个服务层封装 ComfyUI API，避免 UI 组件直接拼接口。

建议模块：

- `src/features/image/services/comfyApi.ts`

建议能力：

| 方法 | 作用 |
| --- | --- |
| `getSystemStats` | 检查 ComfyUI 是否可用 |
| `getObjectInfo` | 读取节点定义、模型输入类型等信息 |
| `getQueue` | 查询当前队列 |
| `submitPrompt` | 提交 workflow prompt |
| `getHistory` | 查询生成结果 |
| `uploadImage` | 上传图片给 ComfyUI |
| `viewImage` | 获取输出图片 |
| `interrupt` | 中断当前任务 |

常用 ComfyUI API 路径：

| API | 用途 |
| --- | --- |
| `/system_stats` | 系统状态 |
| `/object_info` | 节点和输入定义 |
| `/queue` | 队列状态 |
| `/prompt` | 提交任务 |
| `/history/{prompt_id}` | 查询历史 |
| `/upload/image` | 上传图片 |
| `/view` | 读取图片 |
| `/interrupt` | 中断任务 |

注意：

- API 层只负责请求、响应解析和错误归一。
- 不要把 workflow 解析逻辑塞进 API 层。
- 不要让组件直接处理 ComfyUI 的原始错误结构。

## 8. 工作流解析策略

建议新增工作流解析层：

- `src/features/image/workflow/workflowParser.ts`
- `src/features/image/workflow/workflowBinding.ts`
- `src/features/image/workflow/workflowMutator.ts`

### 8.1 输入格式

ComfyUI 可能导出两类 JSON：

1. API 格式 prompt：节点 id 映射到节点定义，适合直接提交 `/prompt`。
2. UI 格式 workflow：包含节点位置、连线、额外 metadata，不能直接提交，需要转换。

第一阶段建议优先支持 API 格式 prompt。  
第二阶段再支持 UI 格式 workflow 转 prompt。

### 8.2 自动识别节点

建议按 `class_type` 和连接关系识别，不要依赖固定 node id。

常见节点识别：

| 功能 | 常见 class_type |
| --- | --- |
| 模型加载 | `CheckpointLoaderSimple`、`UNETLoader`、`DualCLIPLoader` |
| LoRA | `LoraLoader`、`LoraLoaderModelOnly` |
| 正负提示词 | `CLIPTextEncode` |
| 空 latent | `EmptyLatentImage` |
| 采样器 | `KSampler`、`KSamplerAdvanced` |
| 图片输入 | `LoadImage` |
| 图片保存 | `SaveImage` |
| VAE 解码 | `VAEDecode` |

### 8.3 正负提示词识别

优先策略：

1. 找到 `KSampler`。
2. 查看它的 `positive` 和 `negative` 输入连线。
3. 追溯到对应 `CLIPTextEncode`。
4. 把 positive 绑定为正提示词，把 negative 绑定为负提示词。

兜底策略：

- 如果无法追溯，则列出所有 `CLIPTextEncode` 节点，让用户手动选择。

### 8.4 尺寸识别

优先识别：

- `EmptyLatentImage.width`
- `EmptyLatentImage.height`
- `EmptyLatentImage.batch_size`

如果工作流使用其他 latent 节点，则进入手动绑定。

### 8.5 模型识别

常规 SD/SDXL：

- `CheckpointLoaderSimple.inputs.ckpt_name`

Flux 或其他拆分加载：

- `UNETLoader`
- `DualCLIPLoader`
- `VAELoader`

第一阶段建议只把 `CheckpointLoaderSimple` 作为稳定范围。后续再扩展 Flux 专用工作流。

### 8.6 LoRA 识别

第一阶段：

- 只支持工作流中已经存在的 `LoraLoader` 节点。
- UI 可以切换 LoRA 文件名和强度。
- 增加 LoRA 时，如果工作流里有空 LoRA 槽位，就填入。
- 删除 LoRA 时，把对应强度设为 `0` 或清空为占位 LoRA，具体策略需根据 ComfyUI 节点行为验证。

第二阶段：

- 支持动态插入新的 `LoraLoader` 节点。
- 自动重连 model / clip 链。
- 保存修改后的 workflow 快照。

动态插入 LoRA 风险较高，建议放到 MVP 之后。

## 9. 核心数据模型草案

### 9.1 Comfy 连接配置

```ts
interface ComfyConnectionConfig {
  enabled: boolean;
  baseUrl: string;
  lastConnectedAt?: number;
}
```

### 9.2 工作流记录

```ts
interface ImageWorkflowRecord {
  id: string;
  name: string;
  source: 'uploaded' | 'preset';
  format: 'apiPrompt' | 'uiWorkflow';
  rawJson: unknown;
  promptJson?: ComfyPrompt;
  binding?: WorkflowBinding;
  createdAt: number;
  updatedAt: number;
}
```

### 9.3 工作流绑定

```ts
interface WorkflowBinding {
  positivePrompt?: NodeInputBinding;
  negativePrompt?: NodeInputBinding;
  width?: NodeInputBinding;
  height?: NodeInputBinding;
  batchSize?: NodeInputBinding;
  checkpoint?: NodeInputBinding;
  seed?: NodeInputBinding;
  steps?: NodeInputBinding;
  cfg?: NodeInputBinding;
  samplerName?: NodeInputBinding;
  scheduler?: NodeInputBinding;
  imageInputs: NodeInputBinding[];
  loras: LoraBinding[];
}

interface NodeInputBinding {
  nodeId: string;
  input: string;
}

interface LoraBinding {
  nodeId: string;
  loraNameInput: string;
  strengthModelInput?: string;
  strengthClipInput?: string;
}
```

### 9.4 生图参数

```ts
interface ImageGenerationParams {
  workflowId: string;
  positivePrompt: string;
  negativePrompt: string;
  checkpoint?: string;
  loras: ImageLoraParam[];
  width: number;
  height: number;
  seed?: number;
  randomSeed: boolean;
  steps?: number;
  cfg?: number;
  samplerName?: string;
  scheduler?: string;
  batchSize: number;
  batchCount: number;
  imageInputs: ImageInputParam[];
}
```

### 9.5 生图任务

```ts
interface ImageGenerationJob {
  id: string;
  promptId?: string;
  status: 'draft' | 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  params: ImageGenerationParams;
  workflowSnapshot: unknown;
  outputs: ImageOutputRecord[];
  error?: string;
  createdAt: number;
  updatedAt: number;
}
```

### 9.6 图库图片

```ts
interface ImageOutputRecord {
  id: string;
  jobId: string;
  promptId?: string;
  filename: string;
  subfolder?: string;
  type?: 'output' | 'temp' | 'input';
  localPath?: string;
  remoteUrl?: string;
  metadata?: ImageGenerationMetadata;
  createdAt: number;
}
```

## 10. 前端模块拆分建议

建议新增目录：

```txt
app/src/features/image/
  components/
    ComfyConnectionBar.tsx
    WorkflowPanel.tsx
    WorkflowUploadDialog.tsx
    WorkflowBindingPanel.tsx
    ModelSelector.tsx
    LoraStackEditor.tsx
    ImageInputPanel.tsx
    PromptEditor.tsx
    SizePresetControl.tsx
    SamplerSettingsPanel.tsx
    GenerationQueuePanel.tsx
    GalleryGrid.tsx
    ImageDetailDrawer.tsx
    PromptSuggestionPanel.tsx
  services/
    comfyApi.ts
    imageStorage.ts
  workflow/
    workflowParser.ts
    workflowBinding.ts
    workflowMutator.ts
  state/
    imageReducer.ts
    imageTypes.ts
  ImageWorkspace.tsx
```

页面入口：

```txt
app/src/pages/ImagePage.tsx
```

或者直接：

```txt
app/src/features/image/ImageWorkspace.tsx
```

建议优先采用 `features/image/ImageWorkspace.tsx`，和现有 `features/model/ModelWorkspace`、`features/settings/SettingsWorkspace` 保持一致。

## 11. UI 组件职责

| 组件 | 职责 |
| --- | --- |
| `ComfyConnectionBar` | 显示连接状态、Comfy 地址、刷新资源 |
| `WorkflowPanel` | 选择、上传、删除工作流，显示识别结果 |
| `WorkflowBindingPanel` | 手动绑定正反提示词、尺寸、模型、图片节点 |
| `ModelSelector` | 选择 checkpoint / unet / clip 等模型 |
| `LoraStackEditor` | 管理 LoRA 列表、强度、增删 |
| `ImageInputPanel` | 上传参考图、绑定到 `LoadImage` 节点 |
| `PromptEditor` | 正反提示词编辑、模板、优化入口 |
| `SizePresetControl` | 比例预设、宽高输入、分辨率锁定 |
| `SamplerSettingsPanel` | seed、steps、cfg、sampler、scheduler |
| `GenerationQueuePanel` | 当前任务进度、队列、停止 |
| `GalleryGrid` | 展示本次输出和历史图片 |
| `ImageDetailDrawer` | 查看图片提示词、生成信息、复用 |
| `PromptSuggestionPanel` | 调用本地聊天模型生成推荐提示词 |

## 12. 视觉与交互建议

### 12.1 整体风格

沿用当前项目的暖色纸面风格：

- 背景：暖白 / 纸面色
- 强调色：橙红
- 辅助状态色：青绿色
- 面板边框：低对比暖灰

不要做成营销页，不要做大 hero。生图界面是高频生产工具，应保持紧凑、可扫描。

### 12.2 控件规则

- 图标按钮用于上传、删除、刷新、停止。
- 分段控件用于比例选择。
- 数字输入用于宽高、steps、cfg、batch。
- 下拉选择用于模型、LoRA、sampler、scheduler。
- 详情抽屉用于图片生成信息。
- 弹窗用于上传工作流和手动节点绑定。

### 12.3 状态设计

必须覆盖：

- 未连接 ComfyUI
- ComfyUI 连接失败
- 没有工作流
- 工作流识别失败
- 节点绑定不完整
- 图片上传中
- 生图排队中
- 生图运行中
- 生图成功
- 生图失败
- 队列被取消
- 图库为空

## 13. 提示词推荐功能

提示词推荐建议不直接依赖 ComfyUI，而是复用项目已有聊天模型能力。

推荐入口：

- 正提示词框旁边：“推荐提示词”
- 图库图片详情里：“基于这张图生成变体提示词”
- 空白状态：“帮我生成一组起步提示词”

推荐模式：

| 模式 | 输入 | 输出 |
| --- | --- | --- |
| 主题扩写 | 简短中文主题 | 英文正提示词 + 中文解释 |
| 风格增强 | 现有提示词 | 优化后的正提示词 |
| 负面词补全 | 正提示词或模型类型 | 常用负面词 |
| 变体生成 | 历史图片参数 | 3 到 5 组变化方向 |

建议输出结构：

- 中文摘要：说明画面方向
- 正提示词：可直接填入
- 负提示词：可直接填入
- 可选标签：摄影、动漫、产品、建筑、人像等

## 14. 图库设计

### 14.1 图库范围

第一阶段：

- 展示本次运行输出
- 支持点击查看详情

第二阶段：

- 持久化历史图片
- 支持搜索、筛选、按工作流过滤

第三阶段：

- 支持收藏、批量删除、打开所在目录、复制提示词

### 14.2 图片详情

点击图片后显示：

- 大图预览
- 正提示词
- 负提示词
- 模型
- LoRA
- seed
- steps
- cfg
- sampler
- scheduler
- 宽高
- 工作流名称
- 生成时间
- prompt_id

操作按钮：

- 复用参数
- 复制正提示词
- 复制负提示词
- 复制完整生成信息
- 打开图片位置
- 重新生成

## 15. 存储策略

### 15.1 第一阶段

可先使用浏览器侧存储：

- 工作流列表
- 绑定配置
- 最近一次参数
- 本次会话图库

但图片文件本身建议不要只依赖远程 ComfyUI `/view`，因为 ComfyUI 输出目录可能被清理。

### 15.2 第二阶段

建议通过 Tauri 后端增加本地文件管理：

- 保存输出图片到应用数据目录
- 保存 generation metadata JSON
- 提供打开目录能力
- 提供删除图片能力

建议结构：

```txt
AgentLLM/
  images/
    outputs/
      2026-07/
        image-id.png
    metadata/
      image-id.json
    workflows/
      workflow-id.json
```

## 16. 执行阶段

### 阶段 0：准备与确认

目标：明确范围，恢复生图入口，不写复杂逻辑。

任务：

- 确认 ComfyUI API 地址配置放在哪里。
- 确认 `image` 是否作为一级工作区。
- 确认首版只支持 API prompt 格式，还是同时支持 UI workflow 格式。
- 确认首版目标工作流类型：SDXL 文生图优先。
- 确认是否需要内置一个示例工作流。

交付：

- 最终范围确认
- 数据模型确认
- 文件结构确认

验收：

- 可以清楚说明第一版支持什么、不支持什么。

### 阶段 1：MVP 骨架

目标：界面入口和基础状态跑通。

任务：

- 新增 `image` 视图类型。
- 在工作区路由中接入 `ImageWorkspace`。
- 新增 Comfy 连接配置。
- 实现连接状态检查。
- 实现基础三栏界面。
- 实现工作流上传和 JSON 读取。
- 实现工作流基础校验。

交付：

- 可进入生图工作区。
- 可填写 Comfy 地址并检查连接。
- 可上传工作流并展示基础信息。

验收：

- ComfyUI 未启动时显示中文错误。
- ComfyUI 启动时显示已连接状态。
- 上传非法 JSON 时不崩溃。
- 上传工作流后能看到节点数量和识别摘要。

### 阶段 2：工作流解析和参数绑定

目标：把常见文生图工作流映射成可编辑表单。

任务：

- 实现 `workflowParser`。
- 识别 `KSampler`。
- 追溯正负 `CLIPTextEncode`。
- 识别 `EmptyLatentImage` 宽高和 batch。
- 识别 `CheckpointLoaderSimple`。
- 识别已有 `LoraLoader`。
- 实现手动绑定面板。
- 保存工作流绑定配置。

交付：

- 上传常见 SDXL API prompt 后，自动填充提示词、尺寸、模型、采样参数。
- 自动识别失败时可以手动绑定。

验收：

- 正提示词和负提示词不会识别反。
- 修改宽高后只影响绑定节点。
- 工作流重新打开后绑定仍然存在。

### 阶段 3：提交生成与输出展示

目标：真正调用 ComfyUI 生成图片。

任务：

- 实现 `workflowMutator`，根据 UI 参数生成 prompt JSON。
- 实现 `/prompt` 提交。
- 轮询 `/history/{prompt_id}`。
- 读取输出图片 `/view`。
- 展示本次输出图库。
- 实现生成中、成功、失败、取消状态。
- 实现队列和停止按钮。

交付：

- 可以从界面提交一次文生图任务。
- 生成结束后图片出现在图库。

验收：

- 生成中按钮状态正确。
- 出错时显示 ComfyUI 错误说明。
- 多张输出能全部显示。
- 停止按钮能中断当前任务或给出明确失败提示。

### 阶段 4：模型、LoRA 和图片上传

目标：补齐用户最需要的资源控制能力。

任务：

- 从 `/object_info` 或节点定义读取可用模型输入。
- 实现 checkpoint 选择。
- 实现已有 `LoraLoader` 节点切换。
- 实现 LoRA 强度调节。
- 实现图片上传 `/upload/image`。
- 将上传图片写入 `LoadImage` 节点。
- 支持多个图片输入节点选择。

交付：

- 可切换模型。
- 可调整已有 LoRA。
- 可上传图片并用于图生图或参考图工作流。

验收：

- 模型切换后提交的 workflow 中对应字段正确。
- LoRA 强度修改后不影响其他参数。
- 图片上传失败时显示原因。
- 没有 `LoadImage` 节点时，图片上传入口提示当前工作流不支持图片输入。

### 阶段 5：图库与生成信息复用

目标：形成生成闭环。

任务：

- 定义图库记录。
- 保存每次生成参数快照。
- 保存 workflow JSON 快照。
- 图片详情展示完整生成信息。
- 实现“复用参数”。
- 实现复制提示词和复制生成信息。
- 支持从 PNG metadata 读取 Comfy 信息。

交付：

- 点击图片能看到提示词和生成参数。
- 可以一键恢复历史参数再次生成。

验收：

- 复用后正反提示词、模型、LoRA、尺寸、seed 等一致。
- 对没有 metadata 的图片，也能读取本地记录。
- 本地记录缺失时给出中文提示，而不是空白失败。

### 阶段 6：提示词推荐

目标：接入本地聊天模型辅助生图。

任务：

- 新增提示词推荐面板。
- 支持输入中文主题生成正反提示词。
- 支持基于现有提示词优化。
- 支持基于历史图片生成变体。
- 支持一键填入正提示词或负提示词。

交付：

- 可生成推荐提示词。
- 可直接应用到当前工作流。

验收：

- 没有加载聊天模型时给出明确提示。
- 推荐结果不会自动覆盖用户已有内容，除非用户点击应用。
- 中文说明和英文提示词分区清晰。

### 阶段 7：高级工作流兼容

目标：增强复杂工作流支持。

任务：

- 支持 UI workflow JSON 转 API prompt。
- 支持动态插入 LoRA 节点链。
- 支持 Flux 常见工作流。
- 支持 ControlNet / IPAdapter 节点识别。
- 支持多输出节点分组展示。
- 支持工作流模板库。

交付：

- 支持更多真实用户工作流。

验收：

- 动态插入 LoRA 后连线正确。
- Flux 工作流不会被 SDXL 规则误判。
- 多输出节点能正确归档。

## 17. 风险与应对

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| Comfy 工作流格式差异大 | 自动识别失败 | 自动识别 + 手动绑定 |
| UI workflow 不能直接提交 | 用户上传后无法生成 | 第一版明确优先 API prompt，第二版做转换 |
| LoRA 动态插入复杂 | 容易破坏工作流连线 | 第一版只支持已有 LoRA 节点 |
| ComfyUI 输出目录被清理 | 历史图片失效 | 第二阶段复制图片到本地图库 |
| 生成参数被静默覆盖 | 排障困难 | 所有默认值可见且只由用户操作修改 |
| 复杂节点误判 | 生成结果异常 | 显示绑定状态，允许用户手动修正 |
| 提示词推荐覆盖用户内容 | 用户体验差 | 推荐结果只预览，用户点击后应用 |

## 18. 测试计划

### 18.1 单元测试

重点测试：

- workflow 解析
- 正负提示词追溯
- 尺寸节点识别
- 参数写回
- LoRA 节点识别
- 错误 workflow 处理

### 18.2 集成测试

准备测试工作流：

1. 标准 SDXL 文生图 API prompt
2. 带 LoRA 的 SDXL 工作流
3. 带 `LoadImage` 的图生图工作流
4. 多输出节点工作流
5. 缺少关键节点的异常工作流

### 18.3 手动验收

必测路径：

- 连接 ComfyUI
- 上传工作流
- 自动识别绑定
- 手动绑定
- 修改提示词
- 修改尺寸
- 切换模型
- 调整 LoRA
- 上传图片
- 生成多张图
- 查看图库
- 复用历史图片参数
- 生成失败提示

## 19. 第一版范围建议

建议第一版只承诺：

- 连接本机 ComfyUI
- 上传 API prompt 格式工作流
- 自动识别标准 SDXL 文生图节点
- 编辑正反提示词
- 修改尺寸、seed、steps、cfg、sampler、scheduler
- 切换 checkpoint
- 支持已有 LoRA 节点
- 提交生成
- 展示本次输出图库
- 点击图片查看本地记录

第一版暂不承诺：

- 完整节点图编辑
- 所有 UI workflow 自动转换
- 动态插入任意 LoRA 链
- ControlNet 完整配置
- IPAdapter 完整配置
- 局部重绘完整流程
- 多用户或远程 Comfy 认证

## 20. 推荐开工顺序

1. 恢复 `image` 视图和空工作区。
2. 做 Comfy 连接状态。
3. 做工作流上传和基础解析。
4. 做正反提示词、尺寸、采样参数绑定。
5. 做 `/prompt` 提交和 `/history` 轮询。
6. 做输出图片展示。
7. 做模型和已有 LoRA 切换。
8. 做图片上传和 `LoadImage` 写入。
9. 做图库详情和参数复用。
10. 做提示词推荐。
11. 做 UI workflow 转换和高级节点兼容。

## 21. 最小可验收版本定义

当以下条件全部满足，可以认为 MVP 完成：

- 用户能进入“生图”工作区。
- 用户能连接本机 ComfyUI。
- 用户能上传一个标准 API prompt 工作流。
- 应用能识别正提示词、负提示词、尺寸和采样器。
- 用户能修改提示词和分辨率。
- 用户能提交任务生成至少一张图。
- 输出图片能展示在图库中。
- 点击输出图能看到本次生成的核心信息。
- 所有失败状态都有中文提示。

## 22. 后续决策点

正式开工前建议确认：

1. 生图入口放在主导航哪里。
2. Comfy 地址配置是否放进设置页。
3. 首版是否内置示例 workflow。
4. 图库图片是否第一版就复制到本地。
5. 是否优先支持 SDXL，还是需要同时兼容 Flux。
6. LoRA 第一版是否只支持已有节点。
7. 提示词推荐是否复用当前聊天模型。

## 23. 计划结论

这次重写建议采用“工作流驱动 + 参数绑定 + 图库快照”的方案。

第一阶段不要追求完整替代 ComfyUI，而是先做一个稳定、好用、可复现的生图控制台。等基础链路跑通后，再逐步加入动态 LoRA、复杂工作流、ControlNet、提示词助手和长期图库。

