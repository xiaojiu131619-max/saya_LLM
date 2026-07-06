export type ViewType = 'home' | 'chat' | 'settings' | 'tools' | 'modelLoad' | 'usage' | 'apiStatus' | 'logs' | 'image';
export type ThemeType = 'dark' | 'light';
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
  // 推测解码 / 多 token 预测（MTP）：'off' 关闭；'mtp' 使用同目录扫描到的 mtp 草稿模型。
  speculativeDecoding: 'off' | 'mtp';
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
  source?: 'catalog' | 'local';
  architecture?: string;
  blockCount?: number;
  expertCount?: number;
  embeddingLength?: number;
  headCount?: number;
  headCountKv?: number;
  keyLength?: number;
  valueLength?: number;
  mmprojPath?: string;
  mtpDraftPath?: string;
  ggufMetadata?: Array<{ key: string; value: string }>;
  avgTokensPerSec?: number;
  serverPort?: number;
  // 能力标记：用于模型卡片上的能力徽章。
  // 视觉：是否多模态（看图）；音频：是否支持音频输入；视频：是否支持视频输入；
  // 思考：是否支持 think 模式开关（如 Qwen3）；
  // 工具：是否支持函数调用 / 工具调用；推理：是否为 R1/QwQ 类强推理模型。
  supportsVision?: boolean;
  supportsAudio?: boolean;
  supportsVideo?: boolean;
  supportsThinking?: boolean;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  supportsMtp?: boolean;
}

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
  | { type: 'video_url'; video_url: { url: string } }
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
