export type ViewType = 'home' | 'chat' | 'settings' | 'tools' | 'kernel' | 'agent' | 'modelLoad' | 'usage' | 'apiStatus' | 'logs' | 'llamaLogs' | 'data' | 'modelTheme' | 'skills' | 'embedding' | 'fast27b' | 'strata';

/**
 * 顶层界面：**两棵完全独立的界面树**，各有各的侧边栏与导航。
 *
 * - `agent`    Agent 工作区：模型 / 引擎 / 智能体的操作区
 * - `chat`     对话界面：自己的侧边栏与对话记忆区
 * - `settings` 设置中心
 *
 * 以前"在哪个界面"是用 `currentView === 'chat'` 隐式表达的——界面选择和
 * 界面内导航挤在同一个变量里，两个界面因此看起来像同一页的两态，
 * 切过去还要重新认路。这里把两层拆开：切换界面换的是 workspace，
 * 界面内翻页换的是 currentView。
 */
export type WorkspaceMode = 'agent' | 'chat' | 'settings';
export type ThemeType = 'dark' | 'light';
// 主题模式：system=跟随系统亮/暗，light/dark=用户显式指定。
export type ThemeMode = 'system' | ThemeType;
// 强调色来源：auto=跟随 Windows 系统主题色，default=使用内置 Fluent 默认蓝。
export type AccentSource = 'auto' | 'default';
export type SortType = 'default' | 'name' | 'size' | 'updated';
export type GridColumnType = 1 | 2;
export type ModelType = 'dense' | 'moe';
/// 模型任务类型：对话/补全、向量嵌入、重排。
export type ModelTask = 'chat' | 'embedding' | 'rerank';
export type ModelStatus = 'loaded' | 'standby' | 'downloading' | 'loading' | 'error';
export type ReasoningMode = 'off' | 'auto' | 'think' | 'deep';
/** 思考挡位：模型对话模板真正认识的 reasoning_effort 取值（按强度升序）。 */
export type ReasoningEffortGear = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/**
 * 模型思考挡位档案：按对话模板（GGUF 的 tokenizer.chat_template 或用户自定义模板）
 * 自动识别该模型支持哪些思考挡位，界面「思考强度」据此翻译成模型认的参数。
 */
export interface ReasoningProfile {
  /** 模板是否认识 enable_thinking（能否真正关闭思考）。 */
  canDisable: boolean;
  /** 模板支持的 reasoning_effort 挡位；空 = 该模型没有离散挡位，深浅只能靠思考预算。 */
  efforts: ReasoningEffortGear[];
  /** 模板里用到的思考相关变量名（界面说明与排障用）。 */
  knobs: string[];
  /** 识别依据：template=对话模板原文，architecture/name=兜底推断，none=无证据。 */
  source: 'template' | 'architecture' | 'name' | 'none';
  /** 一句话识别结论，直接展示给用户。 */
  summary: string;
}

export interface ModelLoadConfig {
  ctxLength: number;
  gpuLayers: number;
  batchSize: number;
  physicalBatchSize: number;
  threads: number;
  parallel: number;
  fastAttention: boolean;
  kvCache: boolean;
  kvUnified: boolean;
  mmap: boolean;
  mlock: boolean;
  noWarmup: boolean;
  cacheTypeKEnabled: boolean;
  cacheTypeK: string;
  cacheTypeVEnabled: boolean;
  cacheTypeV: string;
  ropeFreqBaseEnabled: boolean;
  ropeFreqBase: number;
  ropeFreqScaleEnabled: boolean;
  ropeFreqScale: number;
  seedEnabled: boolean;
  seed: number;
  // 推测解码 / 多 token 预测：可用内置 MTP 层、兼容独立 MTP head，或 DSpark/DFlash 侧车。
  // 四种模式互斥：同一时刻只挂一个草稿模型（后端优先级 MTP > DSpark > DFlash）。
  speculativeDecoding: 'off' | 'mtp' | 'dspark' | 'dflash';
  // 草稿深度（--spec-draft-n-max，1–16）；关闭时用 llama-server 内核默认。
  specDraftNMaxEnabled: boolean;
  specDraftNMax: number;
  chatTemplate: string;
  rememberSettings: boolean;
  showAdvancedSettings: boolean;
  idleAutoUnload: boolean;
  idleAutoUnloadMinutes: number;
  moeCpuLayers: number;
  reasoningBudget: number;
}

export interface ModelLaunchMemory {
  config: ModelLoadConfig;
  updatedAt: number;
}

export interface ChatGenerationConfig {
  temperature: number;
  topP: number;
  repeatPenalty: number;
  maxTokens: number;
  systemPrompt: string;
  reasoningMode: ReasoningMode;
  enabledTools: string[];
}

export interface SystemPromptPreset {
  id: string;
  title: string;
  prompt: string;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// MCP（Model Context Protocol）服务器
// ---------------------------------------------------------------------------

export interface McpEnvVar {
  key: string;
  value: string;
}

/** MCP 传输方式：stdio（本机子进程）/ http（Streamable HTTP）/ sse（HTTP+SSE 旧版）。 */
export type McpTransport = 'stdio' | 'http' | 'sse';

export interface McpServerConfig {
  id: string;
  name: string;
  /** 是否随对话自动连接（关闭后只能在工具页手动连接）。 */
  enabled: boolean;
  /** 传输方式；缺省按 stdio 处理。 */
  transport?: McpTransport;
  /**
   * stdio：可执行文件（node / npx / 绝对路径）；
   * http / sse：MCP 端点 URL（仅 http/https，且拒绝本机与内网地址）。
   */
  command: string;
  args: string[];
  env: McpEnvVar[];
  cwd?: string | null;
  /** 附加请求头（http / sse 用，例如 `Authorization: Bearer xxx`）。 */
  headers?: McpEnvVar[];
  /** 单个请求超时（毫秒），5000–600000。 */
  timeoutMs: number;
}

export interface McpToolInfo {
  /** 服务端原始工具名。 */
  name: string;
  /** 暴露给模型的完整名：`mcp__<服务器名>__<工具名>`。 */
  qualifiedName: string;
  description: string;
  /** JSON Schema，直接透传给 llama.cpp 的 tools。 */
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  /** 未知按破坏性处理，界面上会提示风险。 */
  destructive: boolean;
}

/** `stopped` | `starting` | `ready` | `error` */
export type McpServerState = 'stopped' | 'starting' | 'ready' | 'error';

export interface McpServerStatus {
  id: string;
  name: string;
  state: McpServerState;
  pid?: number | null;
  tools: McpToolInfo[];
  error?: string | null;
  serverInfo?: string | null;
  lastStderr?: string | null;
  transport?: McpTransport | null;
}

export interface McpCallResult {
  text: string;
  isError: boolean;
  nonTextParts: number;
}

/**
 * 界面使用的合并视图：配置项 + 最近一次运行状态。
 * 配置部分持久化在 config.json；`state` / `tools` 等来自运行中的连接，
 * 不写回磁盘（保存时用 toConfig 剥离）。
 */
export interface McpServerEntry extends McpServerConfig {
  state?: McpServerState;
  tools?: McpToolInfo[];
  pid?: number | null;
  error?: string | null;
  serverInfo?: string | null;
  lastStderr?: string | null;
}

export interface ExternalApiConfig {
  enabled: boolean;
  host: string;
  hasApiKey: boolean;
  apiKey?: string;
  // 刚申请、尚未对运行中的 llama-server 生效的新 Key。
  // 只存在于当前会话，重新加载模型后会转正为 apiKey。
  pendingApiKey?: string;
}

export interface ModelUsageStats {
  modelName?: string;
  modelColor?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  responseCount: number;
  totalTokensPerSec: number;
  totalFirstTokenDelay?: number;
  totalGenTime?: number;
  lastUsedAt?: number;
  dailyTokens: Record<string, number>;
}

export interface ModelMemoryLayout {
  version: number;
  layers: Array<{ weight_bytes: number; expert_bytes: number }>;
  input_bytes: number;
  output_bytes: number;
  other_bytes: number;
  total_bytes: number;
  signature: string;
  accuracy?: 'exact' | 'upper_bound';
  tied_output?: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  family: string;
  params: string;
  quant: string;
  fileSize: string;
  fileSizeBytes: number;
  modelType: ModelType;
  status: ModelStatus;
  themeColor: string;
  themeColorSolid: string;
  description: string;
  longDescription: string;
  tags: string[];
  downloadCount: string;
  ctxLength: number;
  loadConfig: ModelLoadConfig;
  benchmarks?: Record<string, string>;
  releaseDate: string;
  license: string;
  filePath?: string;
  splitPart?: number;
  splitCount?: number;
  splitTotalSizeGb?: number;
  source?: 'catalog' | 'local' | 'api';
  architecture?: string;
  blockCount?: number;
  expertCount?: number;
  embeddingLength?: number;
  headCount?: number;
  headCountKv?: number;
  /** 混合架构逐层 head_count_kv 数组的求和（0 层 = 无 KV 的 Mamba 层）；标量形式时缺省。 */
  kvHeadsSum?: number;
  kvHeadsByLayer?: number[];
  swaLayerPattern?: boolean[];
  fullAttentionInterval?: number;
  memoryLayout?: ModelMemoryLayout;
  /** gemma 系 SWA 分列求和：全注意力层（pattern=0）/ SWA 层（pattern≠0）。 */
  kvHeadsSumFull?: number;
  kvHeadsSumSwa?: number;
  /** 滑动窗口大小与 SWA 层 K/V 维度：SWA 层 KV 只按窗口分配。 */
  slidingWindow?: number;
  keyLengthSwa?: number;
  valueLengthSwa?: number;
  keyLength?: number;
  valueLength?: number;
  ggufVersion?: number;
  tensorCount?: number;
  mtpTensorCount?: number;
  nextnPredictLayers?: number;
  hasEmbeddedMtp?: boolean;
  mtpArchitectureSupported?: boolean;
  vocabSize?: number;
  tensorTypeSummary?: Array<[string, number]>;
  ropeFreqBase?: number;
  ropeDimensionCount?: number;
  ropeScalingType?: string;
  ropeScalingFactor?: number;
  ropeScalingOriginalContextLength?: number;
  tokenizerModel?: string;
  tokenizerBosId?: number;
  tokenizerEosId?: number;
  tokenizerPadId?: number;
  mmprojPath?: string;
  mmprojSupportsVision?: boolean;
  mmprojSupportsAudio?: boolean;
  mmprojProjectorType?: string;
  mmprojVisionProjectorType?: string;
  mmprojAudioProjectorType?: string;
  mtpDraftPath?: string;
  /// DSpark 推测解码侧车路径（扫描时按 dspark- 前缀或 dspark/ 子目录发现）。
  dsparkDraftPath?: string;
  /// DFlash 推测解码侧车路径。
  dflashDraftPath?: string;
  /// 文件名带 UD- 量化标记（unsloth Dynamic GGUF）。
  isDynamicQuant?: boolean;
  ggufMetadata?: Array<{ key: string; value: string }>;
  avgTokensPerSec?: number;
  serverPort?: number;
  // 能力标记：用于模型卡片上的能力徽章。
  // 视频必须区分已验证、候选和抽帧兼容，不能由视觉能力直接推导。
  // 思考：是否支持 think 模式开关（如 Qwen3）；
  // 工具：是否支持函数调用 / 工具调用；推理：是否为 R1/QwQ 类强推理模型。
  supportsVision?: boolean;
  supportsAudio?: boolean;
  supportsVideo?: boolean;
  videoSupport?: VideoSupportLevel;
  supportsThinking?: boolean;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  /** 思考挡位档案：模型支持的 reasoning 挡位（自动识别）。 */
  reasoningProfile?: ReasoningProfile;
  supportsMtp?: boolean;
  /// 任务类型（chat / embedding / rerank）：向量与重排模型走独立服务进程。
  modelTask?: ModelTask;
  /// GGUF 声明的默认池化方式（mean / cls / last / rank）。
  poolingType?: string;
  /// 是否为向量嵌入模型（可作为独立服务与对话/VLM 同时运行）。
  supportsEmbedding?: boolean;
  /// 是否为重排模型（--rerank 端点）。
  supportsRerank?: boolean;
  /** 对外 API 调用名（llama.cpp --alias）；空则用提取到的关键词 */
  apiName?: string;
  /** 用户自定义头像，data URL */
  customLogo?: string;
}

export type VideoSupportLevel = 'verified' | 'candidate' | 'frames' | 'none';

/**
 * Agent 产出的富媒体成果。
 *
 * 普通对话用不到（它只有纯文本），agent 模式才有：agent 能自动跑任务，
 * 除了文字还会给出图片 / 文件 / 网页链接 / 思维导图，这些都要显示在
 * 同一个 chat 界面里。
 *
 * 产物都落在 agent 的工作区里，`path` 记的是**工作区内的相对路径**——
 * 换工作区不用改数据，绝对路径由宿主按当前工作区根拼出来。
 */
export type AgentArtifactKind = 'image' | 'file' | 'link' | 'mindmap';

/** 思维导图节点（agent 产出的导图数据）。 */
export interface MindMapNode {
  label: string;
  children?: MindMapNode[];
}

export interface AgentArtifact {
  kind: AgentArtifactKind;
  /** 展示标题：文件名 / 网页标题 / 导图标题。 */
  title: string;
  /** kind=image：图片地址（宿主按需读取，只放运行时内存，绝不写 localStorage）。 */
  src?: string;
  /** kind=image/file/mindmap：工作区内的相对路径。 */
  path?: string;
  /** kind=file：mime 类型。 */
  mime?: string;
  /** kind=file：字节数。 */
  size?: number;
  /** 同名文件命中多个时，宿主取最新修改的一份并在这里标记。 */
  duplicate?: boolean;
  /** 文件最后修改时间（Unix 秒），用于展示与重名判定。 */
  mtime?: number;
  /** 宿主嗅探出的真实文件格式（png / jpeg / pdf / zip …）；文本类可能为空。 */
  magic?: string;
  /** 文件头是否与扩展名一致；无签名要求的类型为 true。 */
  magicOk?: boolean;
  /** kind=link：链接地址。 */
  url?: string;
  /** kind=link：agent 给的摘要。 */
  snippet?: string;
  /** kind=mindmap：导图数据。 */
  mindmap?: MindMapNode;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  // 多模态用户消息：用于重发/编辑时还原 image_url / audio_url / video_url。
  multimodalContent?: ChatMessageContentPart[];
  /**
   * Agent 产出的富媒体成果（普通对话用不到——它只有纯文本）。
   *
   * agent 模式能自动跑任务，除了文字还会给出图片 / 文件 / 网页链接 /
   * 思维导图，这些都要显示在同一个 chat 界面里。
   */
  artifacts?: AgentArtifact[];
  reasoningContent?: string;
  modelId?: string;
  modelName?: string;
  modelColor?: string;
  timestamp: number;
  isStreaming?: boolean;
  stats?: MessageStats;
  /** 本轮模型发起、且应用已执行完成的工具调用（用于气泡内展示）。 */
  toolActivity?: ToolActivity[];
  /** 交付护栏的警告（本轮回答可能不完整）；不存在 = 判定通过。 */
  warnings?: string[];
  /** Pi 助手轮次：执行步骤流（气泡内折叠展示）。 */
  piSteps?: PiStep[];
  /** Pi 助手轮次 id（取消时回传）。 */
  piTurnId?: string;
  /** Pi 助手轮次状态：running / done / aborted。 */
  piState?: 'running' | 'waiting_user' | 'done' | 'aborted';
}

/** Pi 执行步骤在气泡里的一条展示记录。 */
export interface PiStep {
  ts: number;
  point: string;
  text: string;
  tone: 'info' | 'ok' | 'warn' | 'err';
  /** 连续相同事件合并后的次数（界面显示 ×N）。 */
  repeat?: number;
}

/** 一次 MCP 工具调用在界面上的记录。 */
export interface ToolActivity {
  id: string;
  /** 服务器名（来自工具名中的 mcp__<服务器>__ 段）。 */
  server: string;
  /** 服务端原始工具名。 */
  tool: string;
  /** 调用参数（已解析对象）。 */
  arguments: Record<string, unknown>;
  /** 执行结果文本（截断后的展示副本）。 */
  result?: string;
  isError?: boolean;
  /** 正在执行 / 已完成。 */
  pending?: boolean;
}

export type ChatMessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'audio_url'; audio_url: { url: string } }
  | {
      type: 'video_url';
      video_url: {
        url: string;
        frames?: Array<{ url: string; timestampSeconds: number }>;
      };
    }
  | { type: 'input_audio'; input_audio: { data: string; format: 'wav' | 'mp3' } }
  | { type: 'input_video'; input_video: { data: string } };

export interface ChatSession {
  id: string;
  modelId: string;
  runtimeModelId?: string;
  modelName?: string;
  modelColor?: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  /** Pi 内核会话 id：每个 Chat 会话独立，切换后恢复各自上下文。 */
  piSessionId?: string;
}

export interface MessageStats {
  ctxUsed: number;
  ctxTotal: number;
  outputTokens: number;
  firstTokenDelay: number;
  tokensPerSec: number;
  genTime: number;
}

export interface SystemStats {
  gpuUsage: number;
  vramUsed: number;
  vramTotal: number;
  ramUsage: number;
  ramTotal: number;
  computeScores: number[];
  gpuName: string;
  hostName: string;
}

/**
 * 对话界面的归属。
 *
 * - `main` 主对话：llama / NiNfer / Strata 三个后端共用一个对话界面
 * - `pi`   Pi 智能体对话：复用同一套对话 UI，但**侧边栏与数据都独立**
 *
 * 两者共用 ChatPage 的对话 UI（气泡 / 输入框 / 步骤流），差别只在
 * 「对话属于谁」——agent 的对话侧边栏接的是 Pi 自己的工作区。
 */
export type ChatScope = 'main' | 'pi';

/** agent 对话在会话桶里的合成键：与真实模型 id 天然隔开，不串数据。 */
export const AGENT_SCOPE_MODEL_ID: Record<Exclude<ChatScope, 'main'>, string> = {
  pi: 'agent:pi',
};

export interface AppState {
  /** 顶层界面：Agent 工作区 / 对话界面 / 设置中心（两棵独立界面树）。 */
  workspace: WorkspaceMode;
  /** 当前对话属于谁：主对话 还是 某个 agent（各自独立的侧边栏与数据）。 */
  chatScope: ChatScope;
  /** 当前界面内正在看哪一页（工作区内导航、设置区分页）。 */
  currentView: ViewType;
  /** 对话后端：main = 主 llama-server；fast27b = NiNfer 引擎（自带 OpenAI API）。 */
  chatEngine: ChatEngineId;
  /** Agent 页 WebUI 标签的后端：主模型 / NiNfer（NiNfer 由同源桥提供官方页面）。 */
  webuiEngine: WebUiEngineId;
  /** Agent 页当前标签（dsh / WebUI 之间互相跳转用）。 */
  agentTab: AgentTabId;
  theme: ThemeType;
  // 主题模式（浅色/深色/跟随系统）与生效主题 theme 分离存储。
  themeMode: ThemeMode;
  // 是否自动同步 Windows 系统主题色（强调色）；关闭后回落到内置 Fluent 默认蓝。
  syncSystemAccent: boolean;
  // 毛玻璃模式：窗口与主要表面采用半透明亚克力质感。
  acrylicMode: boolean;
  // 减少界面动画：用户手动开关，等价于强制 prefers-reduced-motion。
  // CSS 过渡与 framer-motion 动画都会被降级为瞬时完成，不影响功能逻辑。
  reduceMotion: boolean;
  // 发送快捷键偏好：true = Enter 发送、Shift+Enter 换行；
  // false = Ctrl/⌘+Enter 发送、Enter 换行（便于输入多行提示词）。
  enterToSend: boolean;
  sidebarCollapsed: boolean;
  /** 聊天侧边栏展开时的宽度（px），用户拖动分隔条调整后持久化。 */
  sidebarWidth: number;
  models: ModelInfo[];
  /** 自动调参的原子配置应用回执，仅本次应用进程使用，不持久化授权。 */
  autoTuneApplication?: { runId: string; applied: boolean };
  sortBy: SortType;
  gridColumns: GridColumnType;
  activeModelId: string | null;
  selectedModelId: string | null;
  systemStats: SystemStats;
  chatSessions: Record<string, ChatSession[]>;
  activeChatSessionIds: Record<string, string>;
  searchQuery: string;
  backendAvailable: boolean;
  serverRunning: boolean;
  serverPort: number;
  apiConfig: ExternalApiConfig;
  modelDirs: string[];
  appStatus: string | null;
  chatConfig: ChatGenerationConfig;
  systemPromptPresets: SystemPromptPreset[];
  usageByModel: Record<string, ModelUsageStats>;
  modelLaunchMemories: Record<string, ModelLaunchMemory>;
  recentModelUsage: Record<string, number>;
  closeToTray: boolean;
  /** MCP 服务器配置（持久化在 config.json，与后端 AppConfig.mcp_servers 对应）。 */
  mcpServers: McpServerEntry[];
}

/**
 * 自带对话的后端选择：主模型 / NiNfer / Strata。
 *
 * Pi 不在这个轴上——它属于 `ChatScope`（主对话 / Pi 工作区），
 * 引擎只描述主对话用哪个补全后端。把 agent 塞进引擎轴会让所有引擎分支
 * 都要额外比对一次，漏一处就掉进兜底。
 */
export type ChatEngineId = 'main' | 'fast27b' | 'strata';

/** WebUI 标签的后端选择：主模型 / NiNfer（NiNfer 走应用提供的同源桥）。 */
export type WebUiEngineId = 'main' | 'fast27b' | 'strata';

/** Agent 页标签（跨面板跳转用；放在全局状态里，NiNfer 面板按钮可直接切到 WebUI 标签）。 */
export type AgentTabId = 'pi' | 'webui' | 'canvas';
