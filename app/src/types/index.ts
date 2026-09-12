export type ViewType = 'home' | 'chat' | 'settings' | 'tools' | 'kernel' | 'agent' | 'modelLoad' | 'usage' | 'apiStatus' | 'logs' | 'llamaLogs' | 'data' | 'modelTheme' | 'embedding';
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

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  // 多模态用户消息：用于重发/编辑时还原 image_url / audio_url / video_url。
  multimodalContent?: ChatMessageContentPart[];
  reasoningContent?: string;
  modelId?: string;
  modelName?: string;
  modelColor?: string;
  timestamp: number;
  isStreaming?: boolean;
  stats?: MessageStats;
  /** 本轮模型发起、且应用已执行完成的工具调用（用于气泡内展示）。 */
  toolActivity?: ToolActivity[];
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

export interface AppState {
  currentView: ViewType;
  theme: ThemeType;
  // 主题模式（浅色/深色/跟随系统）与生效主题 theme 分离存储。
  themeMode: ThemeMode;
  // 是否自动同步 Windows 系统主题色（强调色）；关闭后回落到内置 Fluent 默认蓝。
  syncSystemAccent: boolean;
  // 毛玻璃模式：窗口与主要表面采用半透明亚克力质感。
  acrylicMode: boolean;
  sidebarCollapsed: boolean;
  models: ModelInfo[];
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
