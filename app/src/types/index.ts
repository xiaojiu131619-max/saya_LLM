export type ViewType = 'home' | 'chat' | 'settings' | 'tools' | 'kernel' | 'modelLoad' | 'usage' | 'apiStatus' | 'logs' | 'llamaLogs';
export type ThemeType = 'dark' | 'light';
// 主题模式：system=跟随系统亮/暗，light/dark=用户显式指定。
export type ThemeMode = 'system' | ThemeType;
// 强调色来源：auto=跟随 Windows 系统主题色，default=使用内置 Fluent 默认蓝。
export type AccentSource = 'auto' | 'default';
export type SortType = 'default' | 'name' | 'size' | 'updated';
export type GridColumnType = 1 | 2;
export type ModelType = 'dense' | 'moe';
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
}
