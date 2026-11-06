import { createContext, useCallback, useContext, useEffect, useReducer, useRef, type ReactNode } from 'react';
import type { AppState, ViewType, WorkspaceMode, ThemeType, ThemeMode, SortType, GridColumnType, ModelInfo, Message, SystemStats, ModelLoadConfig, ChatGenerationConfig, ExternalApiConfig, ModelUsageStats, ChatSession, ModelLaunchMemory, SystemPromptPreset, McpServerEntry, McpServerStatus, ToolActivity, PiStep, ChatEngineId, WebUiEngineId, AgentTabId, ChatScope } from '@/types';
import {
  checkDesktopEngine,
  connectMcpServer,
  getApiTokenUsage,
  getDesktopConfig,
  getDesktopServerStatus,
  getDesktopSystemAppearance,
  getExternalApiKeyForSession,
  getExternalApiKeyStatus,
  getServerApiKey,
  isDesktopRuntime,
  listMcpServers,
  setDesktopWindowMaterial,
  createExternalApiKey,
  listenDesktopEvent,
  scanDesktopModels,
  stopDesktopServer,
  toFrontendModel,
} from '@/lib/desktop';
import { DEFAULT_MAX_COMPLETION_TOKENS, RECOMMENDED_CTX_LENGTH, maxGpuLayers } from '@/lib/modelDefaults';
import { dayKey } from '@/lib/usageHeatmap';
import { getModelThemeGroup } from '@/lib/modelTheme';
import { autoTuneManager, ensureAutoTuneRuntime } from '@/lib/autoTuneRuntime';
import { canApplyAutoTune, tuneRecordPatch, type AutoTuneAuthorization } from '@/lib/autoTuneTask';
import type { AutoTuneResult } from '@/lib/ipc/model';
import { activateMainModel, clearMainLoadedModels } from '@/lib/modelState';
import { normalizeFontScale } from '@/lib/uiScale';
import { DEMO_MODELS } from '@/lib/demoModels';

/**
 * 把 hex 颜色朝白（amount > 0）或黑（amount < 0）线性混合。
 * 用于根据系统 accent 实时推算 hover/pressed/subtle 派生色。
 */
function mixAccent(hex: string, amount: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const target = amount > 0 ? 255 : 0;
  const t = Math.min(1, Math.abs(amount));
  const mix = (c: number) => Math.round(c + (target - c) * t);
  return `#${[mix(r), mix(g), mix(b)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

const THEME_MANUAL_FLAG = 'agent-llm-theme-manual';

/**
 * 读取 localStorage 的安全封装。
 * 隐私模式、被策略禁用或存储配额异常时，连 `getItem` 都可能抛错；
 * 这些调用发生在模块初始化阶段，一次异常就会让整个应用白屏且无法自愈。
 */
function readStoredFlag(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

type Action =
  | { type: 'SET_VIEW'; payload: ViewType }
  // 顶层界面切换：Agent 工作区 / 对话界面 / 设置中心。
  // 与 SET_VIEW 分开：前者换整棵界面树，后者只换当前这棵树里在看哪一页。
  | { type: 'SET_WORKSPACE'; payload: WorkspaceMode }
  // 切换对话归属：主对话 ↔ 某个 agent 的对话（各自独立侧边栏与数据）。
  | { type: 'SET_CHAT_SCOPE'; payload: ChatScope }
  | { type: 'SET_CHAT_ENGINE'; payload: ChatEngineId }
  | { type: 'SET_WEBUI_ENGINE'; payload: WebUiEngineId }
  | { type: 'SET_AGENT_TAB'; payload: AgentTabId }
  | { type: 'SET_PI_PROMPT_DRAFT'; payload: string | null }
  | { type: 'SET_THEME'; payload: ThemeType }
  | { type: 'TOGGLE_THEME' }
  | { type: 'SET_THEME_MODE'; payload: ThemeMode }
  | { type: 'SET_SYNC_SYSTEM_ACCENT'; payload: boolean }
  | { type: 'SET_ACRYLIC_MODE'; payload: boolean }
  // 界面偏好：减少动画、字体缩放、发送快捷键。
  | { type: 'SET_REDUCE_MOTION'; payload: boolean }
  | { type: 'SET_FONT_SCALE'; payload: number }
  | { type: 'SET_ENTER_TO_SEND'; payload: boolean }
  // 数据维护：清空全部对话历史、清空使用统计、界面偏好恢复默认值。
  | { type: 'CLEAR_ALL_CHAT_HISTORY' }
  | { type: 'RESET_USAGE' }
  | { type: 'RESET_UI_PREFS' }
  | { type: 'TOGGLE_SIDEBAR' }
  | { type: 'SET_SIDEBAR_WIDTH'; payload: number }
  | { type: 'SET_SORT'; payload: SortType }
  | { type: 'SET_GRID_COLUMNS'; payload: GridColumnType }
  | { type: 'ACTIVATE_MODEL'; payload: string }
  | { type: 'SET_ACTIVE_MODEL'; payload: string | null }
  | { type: 'SET_SELECTED_MODEL'; payload: string | null }
  | { type: 'UPDATE_MODELS'; payload: ModelInfo[] }
  | { type: 'UPDATE_SYSTEM_STATS'; payload: SystemStats }
  | { type: 'CREATE_CHAT_SESSION'; payload: { session: ChatSession } }
  | { type: 'SET_ACTIVE_CHAT_SESSION'; payload: { modelId: string; sessionId: string } }
  | { type: 'SET_CHAT_SESSION_MODEL'; payload: { modelId: string; sessionId: string; runtimeModelId?: string; modelName?: string; modelColor?: string } }
  | { type: 'DELETE_CHAT_SESSION'; payload: { modelId: string; sessionId: string } }
  | { type: 'RENAME_CHAT_SESSION'; payload: { modelId: string; sessionId: string; title: string } }
  | { type: 'ADD_MESSAGE'; payload: { modelId: string; sessionId: string; message: Message } }
  | { type: 'UPDATE_MESSAGE'; payload: { modelId: string; sessionId: string; messageId: string; content?: string; reasoningContent?: string; toolActivity?: ToolActivity[]; warnings?: string[]; piSteps?: PiStep[]; piTurnId?: string; piState?: Message['piState']; artifacts?: Message['artifacts'] } }
  | { type: 'SET_CHAT_SESSION_PI_ID'; payload: { modelId: string; sessionId: string; piSessionId: string } }
  | { type: 'SET_MESSAGE_STREAMING'; payload: { modelId: string; sessionId: string; messageId: string; streaming: boolean; stats?: Message['stats'] } }
  | { type: 'REPLACE_MESSAGE_AND_TRUNCATE_AFTER'; payload: { modelId: string; sessionId: string; messageId: string; message: Message } }
  | { type: 'DELETE_MESSAGE'; payload: { modelId: string; sessionId: string; messageId: string } }
  | { type: 'CLEAR_MESSAGES'; payload: { modelId: string; sessionId: string } }
  | { type: 'SET_SEARCH'; payload: string }
  | { type: 'APPLY_AUTO_TUNE'; payload: { authorization: AutoTuneAuthorization; result: AutoTuneResult } }
  | { type: 'UPDATE_MODEL_CONFIG'; payload: { modelId: string; config: Partial<ModelLoadConfig> } }
  | { type: 'REMEMBER_MODEL_LAUNCH_CONFIG'; payload: { modelId: string; config: ModelLoadConfig } }
  | { type: 'MARK_MODEL_RECENTLY_USED'; payload: { modelId: string } }
  | { type: 'UPDATE_MODEL_STATUS'; payload: { modelId: string; status: ModelInfo['status'] } }
  | { type: 'UPSERT_MODELS'; payload: ModelInfo[] }
  // 清理使用统计：只保留 payload 中的模型 id（以及 api- 前缀的接口模型）。
  | { type: 'PRUNE_USAGE'; payload: string[] }
  | { type: 'SET_BACKEND_AVAILABLE'; payload: boolean }
  | { type: 'SET_SERVER_RUNNING'; payload: boolean }
  | { type: 'SET_SERVER_PORT'; payload: number }
  | { type: 'SET_API_CONFIG'; payload: Partial<ExternalApiConfig> }
  | { type: 'SET_MODEL_DIRS'; payload: string[] }
  | { type: 'SET_CLOSE_TO_TRAY'; payload: boolean }
  | { type: 'SET_MCP_SERVERS'; payload: McpServerEntry[] }
  | { type: 'SET_MCP_STATUSES'; payload: McpServerStatus[] }
  | { type: 'SET_APP_STATUS'; payload: string | null }
  | { type: 'SET_CHAT_CONFIG'; payload: Partial<ChatGenerationConfig> }
  | { type: 'SAVE_SYSTEM_PROMPT_PRESET'; payload: { title: string; prompt: string } }
  | { type: 'DELETE_SYSTEM_PROMPT_PRESET'; payload: { presetId: string } }
  | { type: 'SET_MODEL_THEME_COLOR'; payload: { modelId: string; color: string } }
  | { type: 'SET_MODEL_GROUP_THEME_COLOR'; payload: { groupKey: string; color: string } }
  | { type: 'SET_MODEL_API_NAME'; payload: { modelId: string; apiName: string } }
  | { type: 'SET_MODEL_CUSTOM_LOGO'; payload: { modelId: string; customLogo?: string } }
  | {
      type: 'ADD_USAGE';
      payload: {
        modelId: string;
        modelName?: string;
        modelColor?: string;
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        tokensPerSec?: number;
        firstTokenDelay?: number;
        genTime?: number;
      };
    }
  | {
      type: 'SET_API_USAGE';
      payload: {
        modelId: string;
        modelName?: string;
        modelColor?: string;
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        responseCount: number;
      };
    }
  | {
      /**
       * 清空日志累计派生的 `api-*` 用量条目。
       * 后端在加载/切换模型时会清空 `API_TOKEN_USAGE`；前端若不跟着清，
       * 上一个模型的 API 用量会一直挂在统计页，直到下一次外部请求覆盖它。
       */
      type: 'CLEAR_API_USAGE';
    }
  | {
      /**
       * 引擎（NiNfer / Strata）用量的快照式写入。
       *
       * 引擎的请求记录本身是「全量快照」（最近 24 小时、按请求一条），
       * 与主模型的增量累加不同：这里直接用它算出的累计值覆盖该后端条目，
       * 避免每次轮询都重复累加。按天分桶沿用主模型的本地日期口径。
       */
      type: 'SET_ENGINE_USAGE';
      payload: {
        modelId: string;
        modelName: string;
        modelColor: string;
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        responseCount: number;
        totalTokensPerSec: number;
        totalFirstTokenDelay: number;
        totalGenTime: number;
        dailyTokens: Record<string, number>;
        lastUsedAt: number;
      };
    };

const initialSystemStats: SystemStats = {
  gpuUsage: 0, vramUsed: 0, vramTotal: 0, ramUsage: 0, ramTotal: 0,
  computeScores: Array.from({ length: 60 }, () => 0),
  gpuName: '未连接硬件监控', hostName: '未连接桌面运行环境',
};

const STORAGE_KEY = 'agent-llm-local-state-v1';

/** 聊天侧边栏宽度的默认值与上下限（拖拽分隔条时同样按这套值收口）。 */
export const SIDEBAR_DEFAULT_WIDTH = 288;
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 480;

/** 把任意来源（拖拽 / localStorage）的宽度收敛到合法区间；非法值回落默认。 */
export function clampSidebarWidth(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(numeric)));
}

interface StoredAppState {
  chatConfig?: Partial<ChatGenerationConfig>;
  systemPromptPresets?: SystemPromptPreset[];
  usageByModel?: Record<string, ModelUsageStats>;
  chatSessions?: Record<string, ChatSession[]>;
  activeChatSessionIds?: Record<string, string>;
  /** 当前对话归属（主对话 / Agent 工作区）。 */
  chatScope?: ChatScope;
  /** 旧版本可能落过盘的后端选择：只用于迁移，新版本不再持久化它。 */
  chatEngine?: string;
  apiConfig?: Partial<Omit<ExternalApiConfig, 'apiKey'>> & { apiKey?: string };
  modelLoadConfigs?: Record<string, ModelLoadConfig>;
  modelLaunchMemories?: Record<string, ModelLaunchMemory>;
  recentModelUsage?: Record<string, number>;
  modelThemeColors?: Record<string, string>;
  modelThemeGroups?: Record<string, string>;
  modelApiNames?: Record<string, string>;
  modelCustomLogos?: Record<string, string>;
  ui?: Partial<Pick<AppState, 'theme' | 'themeMode' | 'syncSystemAccent' | 'acrylicMode' | 'reduceMotion' | 'fontScale' | 'enterToSend' | 'sidebarCollapsed' | 'sidebarWidth' | 'sortBy' | 'gridColumns' | 'serverPort'>> & {
    themePreferenceVersion?: number;
  };
}

function loadStoredState(): StoredAppState {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    // 仅接受对象，避免被篡改成数组/字符串/null 时后续解构与遍历崩溃。
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as StoredAppState;
  } catch {
    return {};
  }
}

/**
 * 旧状态里的对话后端只保留三档合法值；不在三档内的值统一归一为 `main`，
 * 避免旧 localStorage 把失效的字符串带进新类型。
 */
function normalizeStoredChatEngine(value: unknown): ChatEngineId {
  return value === 'fast27b' || value === 'strata' ? value : 'main';
}

function storedChatScope(stored: StoredAppState): ChatScope {
  return stored.chatScope === 'pi' ? 'pi' : 'main';
}

function sanitizeStoredSessions(sessionsByModel: Record<string, ChatSession[]>) {
  // 对来自 localStorage 的数据做防御式校验：旧版本、浏览器扩展或手动篡改可能导致
  // sessions / messages 不是数组，若直接 .map 会在模块初始化阶段抛错并白屏且无法自愈。
  if (!sessionsByModel || typeof sessionsByModel !== 'object') return {};
  return Object.fromEntries(
    Object.entries(sessionsByModel)
      .filter(([, sessions]) => Array.isArray(sessions))
      .map(([modelId, sessions]) => [
        modelId,
        sessions
          .filter((session): session is ChatSession => Boolean(session) && typeof session === 'object')
          .map((session) => ({
            ...session,
            messages: Array.isArray(session.messages)
              ? session.messages
                  .filter((message) => Boolean(message) && typeof message === 'object')
                  .map((message) => ({ ...message, isStreaming: false }))
              : [],
          })),
      ])
  );
}

/**
 * 持久化前剥离消息里的媒体二进制。
 *
 * 图片 / 音频 / 视频以 data URL（base64）挂在 `multimodalContent` 上，单张截图
 * 就能到几 MB；localStorage 配额通常只有 5–10 MB，写满后 `setItem` 抛
 * QuotaExceededError，之后的会话与配置**全部**不再落盘。媒体只在本次运行内
 * 可用，重启后保留文字与「N 个附件」的说明；不让它挤掉真正需要持久化的会话。
 *
 * agent 产物的图片同样只留路径：`artifacts[].src` 是运行时按需读取的 data URL，
 * 这里再剥一层，保证任何调用方都不会把 base64 写进 localStorage。
 */
function stripPersistedMedia(sessionsByModel: Record<string, ChatSession[]>) {
  return Object.fromEntries(
    Object.entries(sessionsByModel).map(([modelId, sessions]) => [
      modelId,
      sessions.map((session) => ({
        ...session,
        messages: session.messages.map((message) => {
          let next = message;
          if (next.multimodalContent) {
            const textParts = next.multimodalContent.filter((part) => part.type === 'text');
            if (textParts.length !== next.multimodalContent.length) {
              next = { ...next, multimodalContent: textParts.length > 0 ? textParts : undefined };
            }
          }
          if (next.artifacts?.some((artifact) => artifact.src)) {
            next = {
              ...next,
              artifacts: next.artifacts.map((artifact) => ({ ...artifact, src: undefined })),
            };
          }
          return next;
        }),
      })),
    ]),
  );
}

/** 自动标题的最大字数：超出后截断并加省略号。
    侧边栏标题现在按两行折行显示（见 ChatSidebar 的 SessionRow），
    24 字会把「写一段 200 字左右的介绍，主题是你自己，尽量慢一点输出。」这类句子砍掉一半。 */
const AUTO_TITLE_MAX_LENGTH = 40;

/** 旧版自动标题的字数上限：超出的部分被硬切掉且不带省略号。 */
const LEGACY_AUTO_TITLE_MAX_LENGTH = 24;

function titleFromFirstUserMessage(message: Message) {
  if (message.role !== 'user') return null;
  const title = message.content.trim().replace(/\s+/g, ' ');
  if (!title) return null;
  return title.length > AUTO_TITLE_MAX_LENGTH ? `${title.slice(0, AUTO_TITLE_MAX_LENGTH)}…` : title;
}

/**
 * 把旧规则生成的自动标题按新规则重算一遍。
 * 判定条件是「当前标题 == 首条用户消息的前 24 字」——只有机器按旧规则生成的标题才会命中，
 * 用户手动改过名的会话（标题对不上）保持原样，不会被覆盖。
 */
function refreshLegacyAutoTitles(sessionsByModel: Record<string, ChatSession[]>) {
  return Object.fromEntries(
    Object.entries(sessionsByModel).map(([modelId, sessions]) => [
      modelId,
      sessions.map((session) => {
        const firstUserMessage = session.messages.find((message) => message.role === 'user');
        if (!firstUserMessage) return session;
        const source = firstUserMessage.content.trim().replace(/\s+/g, ' ');
        if (!source || session.title !== source.slice(0, LEGACY_AUTO_TITLE_MAX_LENGTH)) return session;
        const title = source.length > AUTO_TITLE_MAX_LENGTH ? `${source.slice(0, AUTO_TITLE_MAX_LENGTH)}…` : source;
        return title === session.title ? session : { ...session, title };
      }),
    ])
  );
}

const storedState = loadStoredState();
const storedUi = storedState.ui ?? {};
const storedApiConfig = storedState.apiConfig ?? {};
/**
 * 主题持久化版本门控。
 *
 * themeMode 从版本 3 起单独持久化（版本 2 及更早只有 theme + manual flag）。
 * 这里必须与落盘处写的版本号保持一致：曾经读 `=== 2` 而写 `3`，导致用户选的
 * 主题永远读不回来——界面按默认「跟随系统」显示，设置页却写着用户选过的档位。
 * 现在接受「>= 2」：版本 2 是初始提交写入的格式（theme + manual flag），
 * 它的 theme 值同样是用户显式选择，只有 themeMode 需要从 legacy flag 推导。
 */
const THEME_PREFERENCE_VERSION = 3;
const storedThemeVersion = Number(storedUi.themePreferenceVersion ?? 0);
const storedTheme = storedThemeVersion >= 2
  && (storedUi.theme === 'light' || storedUi.theme === 'dark')
  ? storedUi.theme
  : undefined;

/**
 * GPU 卸载上限口径的一次性迁移（版本 2）：
 * 旧版滑块上限是 block_count，而内核把输出层也算一层，满档是 block_count + 1。
 * 恰好等于 block_count 的存量值来自旧上限、不是用户手选（旧滑块最大就是它），
 * 抬到新满档值；其它值不动，用户主动留层在 CPU 的选择被保留。
 *
 * 用独立的时间戳版本号做闸门，只在首次启动迁移一次——否则每次扫描都会把用户
 * 之后手选的 block_count 又抬上去，相当于用户的显式设置被反复覆盖。
 */
const GPU_LAYERS_CEILING_VERSION = 2;
const GPU_LAYERS_CEILING_KEY = 'agent-llm.gpuLayersCeilingVersion';

function readGpuLayersCeilingVersion(): number {
  if (typeof window === 'undefined') return GPU_LAYERS_CEILING_VERSION;
  try {
    return Number(window.localStorage.getItem(GPU_LAYERS_CEILING_KEY) ?? 0) || 0;
  } catch {
    // 读不到时按已迁移处理，宁可少改用户配置。
    return GPU_LAYERS_CEILING_VERSION;
  }
}

const needsGpuLayersCeilingMigration = readGpuLayersCeilingVersion() < GPU_LAYERS_CEILING_VERSION;

if (needsGpuLayersCeilingMigration && typeof window !== 'undefined') {
  try {
    window.localStorage.setItem(GPU_LAYERS_CEILING_KEY, String(GPU_LAYERS_CEILING_VERSION));
  } catch {
    // best-effort：写不进标记也不会影响本次迁移结果。
  }
}

function storedLoadConfigFor(model: ModelInfo): ModelLoadConfig | undefined {
  const stored = storedState.modelLoadConfigs?.[model.id];
  if (!stored) return undefined;
  return needsGpuLayersCeilingMigration
    ? migrateGpuLayersToCeiling(model.blockCount, stored)
    : stored;
}

// themeMode 版本 3 起单独持久化；旧数据里只有 manual flag（=1 表示显式选过主题），
// 此时把当时的 theme 视为用户的显式选择，否则默认跟随系统。
const storedThemeMode = (mode: string | undefined, fallback: ThemeMode): ThemeMode =>
  (mode === 'system' || mode === 'light' || mode === 'dark') ? mode : fallback;
const legacyThemeMode: ThemeMode = readStoredFlag(THEME_MANUAL_FLAG) === '1'
  && (storedTheme === 'light' || storedTheme === 'dark')
  ? storedTheme
  : 'system';

/** 只接受字面量对象，数组 / 字符串 / null 一律当空表，避免后续遍历时炸。 */
function asRecord<T>(value: unknown): Record<string, T> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, T>;
}

/** 提示词预设：整体可能不是数组，单项也可能缺 id / title / prompt。 */
function sanitizeStoredPresets(value: unknown): SystemPromptPreset[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((preset): preset is Partial<SystemPromptPreset> => Boolean(preset) && typeof preset === 'object')
    .map((preset, index) => ({
      id: typeof preset.id === 'string' && preset.id ? preset.id : `preset-${index}`,
      title: typeof preset.title === 'string' ? preset.title.trim() || '未命名提示词' : '未命名提示词',
      prompt: typeof preset.prompt === 'string' ? preset.prompt : '',
      updatedAt: finiteNumber(preset.updatedAt, Date.now()),
    }))
    .filter((preset) => preset.prompt.trim().length > 0);
}

/** 启动记忆：条目可能是 null，`memory.config` 也可能是残缺对象。 */
function sanitizeLaunchMemories(value: unknown): Record<string, ModelLaunchMemory> {
  return Object.fromEntries(
    Object.entries(asRecord<unknown>(value))
      .filter(([, memory]) => Boolean(memory) && typeof memory === 'object')
      .map(([modelId, memory]) => {
        const entry = memory as Partial<ModelLaunchMemory>;
        return [
          modelId,
          {
            config: normalizeLoadConfig((entry.config ?? {}) as Partial<ModelLoadConfig>),
            updatedAt: finiteNumber(entry.updatedAt, Date.now()),
          },
        ] as const;
      })
  );
}

/** 每个模型的「当前会话」映射：值必须是字符串，否则活动会话会指向 undefined。 */
function sanitizeActiveSessions(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [modelId, sessionId] of Object.entries(asRecord<unknown>(value))) {
    if (typeof sessionId === 'string') result[modelId] = sessionId;
  }
  return result;
}

const initialState: AppState = {
  // 顶层界面：每次启动都落在 Agent 工作区——对话界面依赖已加载的模型，
  // 空手进来只会看到一个用不了的输入框。
  workspace: 'agent',
  // 对话归属：默认主对话（Pi 工作区从侧边栏头像或 Agent 页入口进来）。
  chatScope: storedChatScope(storedState),
  currentView: 'home',
  theme: storedTheme ?? 'light',
  themeMode: storedThemeMode(storedUi.themeMode, legacyThemeMode),
  syncSystemAccent: storedUi.syncSystemAccent ?? true,
  acrylicMode: storedUi.acrylicMode ?? false,
  reduceMotion: storedUi.reduceMotion ?? false,
  fontScale: normalizeFontScale(storedUi.fontScale),
  enterToSend: storedUi.enterToSend ?? true,
  sidebarCollapsed: storedUi.sidebarCollapsed ?? false,
  sidebarWidth: clampSidebarWidth(storedUi.sidebarWidth),
  models: [],
  sortBy: storedUi.sortBy ?? 'default',
  gridColumns: storedUi.gridColumns ?? 2,
  activeModelId: null, selectedModelId: null,
  systemStats: initialSystemStats, searchQuery: '',
  backendAvailable: false, serverRunning: false, serverPort: storedUi.serverPort ?? 8080,
  apiConfig: {
    enabled: storedApiConfig.enabled ?? false,
    // 监听地址不再单独配置：关闭对外时保持仅本机回环。
    host: '127.0.0.1',
    hasApiKey: false,
  },
  modelDirs: [], appStatus: '启动桌面版并选择本地 GGUF 模型目录后才会显示真实数据。',
  closeToTray: true,
  chatConfig: {
    temperature: storedState.chatConfig?.temperature ?? 0.8,
    topP: storedState.chatConfig?.topP ?? 0.95,
    repeatPenalty: storedState.chatConfig?.repeatPenalty ?? 1.1,
    maxTokens: storedState.chatConfig?.maxTokens ?? DEFAULT_MAX_COMPLETION_TOKENS,
    systemPrompt: storedState.chatConfig?.systemPrompt ?? '',
    reasoningMode: storedState.chatConfig?.reasoningMode ?? 'auto',
    enabledTools: Array.isArray(storedState.chatConfig?.enabledTools) ? storedState.chatConfig.enabledTools : [],
  },
  systemPromptPresets: sanitizeStoredPresets(storedState.systemPromptPresets),
  usageByModel: asRecord<ModelUsageStats>(storedState.usageByModel),
  modelLaunchMemories: sanitizeLaunchMemories(storedState.modelLaunchMemories),
  recentModelUsage: Object.fromEntries(
    Object.entries(storedState.recentModelUsage ?? {})
      .filter(([, usedAt]) => Number.isFinite(Number(usedAt)))
      .map(([modelId, usedAt]) => [modelId, Number(usedAt)] as const)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
  ),
  chatSessions: refreshLegacyAutoTitles(sanitizeStoredSessions(storedState.chatSessions ?? {})),
  activeChatSessionIds: sanitizeActiveSessions(storedState.activeChatSessionIds),
  // MCP 服务器配置以后端 config.json 为唯一真源，hydrate 时拉取，这里只给空初值。
  mcpServers: [],
  // 自带对话的后端选择（会话级，不持久化）：main = 主 llama-server。
  chatEngine: normalizeStoredChatEngine(storedState.chatEngine),
  // 设置 → 测试页的 WebUI 后端选择（会话级）：与对话页的后端各自独立。
  webuiEngine: 'main',
  // Agent 页标签（会话级）：默认 Pi 工作区。
  agentTab: 'pi',
  // 画布「交给 Pi」的预填提示词（会话级）：由入口写入、ChatPage 消费后清空。
  piPromptDraft: null,
};

/** 每日用量按**本地日期**分桶：`toISOString()` 是 UTC，在 UTC+8 的 00:00–08:00
    会落到前一天，热力图与每日统计整体错位一天。复用 usageHeatmap 的口径。 */
function todayKey() {
  return dayKey(new Date());
}

/**
 * 取有限数值：`Number('bad')` / `Number(Infinity)` 会得到 NaN / Infinity，
 * 直接进 `Math.max` 仍是 NaN，最终被序列化进模型加载参数，报错点离数据源很远。
 * 非法值统一回落 fallback，再按 [min, max] 收口。
 */
function finiteNumber(
  value: unknown,
  fallback: number,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function normalizeLoadConfig(config: ModelLoadConfig | (Partial<ModelLoadConfig> & { kvQuant?: string })): ModelLoadConfig {
  const migratedCtxLength = config.ctxLength === 327689 ? RECOMMENDED_CTX_LENGTH : config.ctxLength;
  const legacyKvQuant = 'kvQuant' in config && typeof config.kvQuant === 'string' ? config.kvQuant : 'f16';
  return {
    ctxLength: finiteNumber(migratedCtxLength ?? RECOMMENDED_CTX_LENGTH, RECOMMENDED_CTX_LENGTH, 1),
    gpuLayers: finiteNumber(config.gpuLayers ?? 0, 0, 0),
    batchSize: finiteNumber(config.batchSize ?? 512, 512, 1),
    physicalBatchSize: finiteNumber(config.physicalBatchSize ?? 512, 512, 1),
    threads: Math.round(finiteNumber(config.threads ?? -1, -1)),
    parallel: Math.round(finiteNumber(config.parallel ?? -1, -1)),
    fastAttention: config.fastAttention ?? true,
    kvCache: config.kvCache ?? true,
    kvUnified: config.kvUnified ?? false,
    mmap: config.mmap ?? true,
    mlock: config.mlock ?? false,
    noWarmup: config.noWarmup ?? false,
    cacheTypeKEnabled: config.cacheTypeKEnabled ?? legacyKvQuant !== 'f16',
    cacheTypeK: config.cacheTypeK ?? legacyKvQuant,
    cacheTypeVEnabled: config.cacheTypeVEnabled ?? legacyKvQuant !== 'f16',
    cacheTypeV: config.cacheTypeV ?? legacyKvQuant,
    ropeFreqBaseEnabled: config.ropeFreqBaseEnabled ?? false,
    ropeFreqBase: finiteNumber(config.ropeFreqBase ?? 0, 0, 0),
    ropeFreqScaleEnabled: config.ropeFreqScaleEnabled ?? false,
    ropeFreqScale: finiteNumber(config.ropeFreqScale ?? 0, 0, 0),
    seedEnabled: config.seedEnabled ?? false,
    seed: Math.round(finiteNumber(config.seed ?? -1, -1)),
    speculativeDecoding: (() => {
      const mode = config.speculativeDecoding as ModelLoadConfig['speculativeDecoding'];
      return mode === 'mtp' || mode === 'dspark' || mode === 'dflash' ? mode : 'off';
    })(),
    specDraftNMaxEnabled: config.specDraftNMaxEnabled ?? false,
    specDraftNMax: Math.min(16, Math.max(1, Math.round(finiteNumber(config.specDraftNMax ?? 4, 4)))),
    chatTemplate: config.chatTemplate ?? '',
    rememberSettings: config.rememberSettings ?? true,
    showAdvancedSettings: config.showAdvancedSettings ?? false,
    idleAutoUnload: config.idleAutoUnload ?? false,
    idleAutoUnloadMinutes: Math.round(finiteNumber(config.idleAutoUnloadMinutes ?? 15, 15, 1)),
    moeCpuLayers: finiteNumber(config.moeCpuLayers ?? 0, 0, 0),
    reasoningBudget: Math.round(finiteNumber(config.reasoningBudget ?? 0, 0, 0)),
  };
}

function averageTokensPerSec(usage?: ModelUsageStats) {
  if (!usage || usage.responseCount <= 0 || usage.totalTokensPerSec <= 0) return undefined;
  return usage.totalTokensPerSec / usage.responseCount;
}

/**
 * 一次性迁移：旧版把所有模型的「拉满」档位存成 block_count，而内核的满档是
 * block_count + 1——差这一层会让它留在 CPU，GPU 计算图被迫与 CPU 往返同步，
 * 生成速度成倍下降（27B 三值量化实测 8.6 → 57.9 t/s）。
 * 恰好等于 block_count 的存量值来自旧上限而非用户手选（旧滑块最大就是它），
 * 因此抬到新的满档值；其它值一律保持不动，不覆盖用户的选择。
 */
function migrateGpuLayersToCeiling(
  blockCount: number | null | undefined,
  config: ModelLoadConfig,
): ModelLoadConfig {
  const layers = Math.max(0, Number(blockCount ?? 0));
  if (layers <= 0) return config;
  if (Math.round(Number(config.gpuLayers ?? 0)) !== layers) return config;
  return { ...config, gpuLayers: maxGpuLayers(layers) };
}

/**
 * 同上的迁移，作用在「记忆参数快速启动」保存的那份配置上——快速启动读的是记忆
 * 配置而非详情页配置，漏掉它会让用户点一下又退回慢档。
 */
function migrateLaunchMemoryGpuLayers(
  models: ModelInfo[],
  memories: Record<string, ModelLaunchMemory> | undefined,
): Record<string, ModelLaunchMemory> | undefined {
  if (!memories) return memories;
  const layersById = new Map(
    models.map((model) => [model.id, Math.max(0, Number(model.blockCount ?? 0))]),
  );
  let changed = false;
  const next: Record<string, ModelLaunchMemory> = {};
  for (const [modelId, memory] of Object.entries(memories)) {
    const layers = layersById.get(modelId) ?? 0;
    const migrated = layers > 0 && Math.round(Number(memory.config?.gpuLayers ?? 0)) === layers
      ? { ...memory, config: { ...memory.config, gpuLayers: maxGpuLayers(layers) } }
      : memory;
    if (migrated !== memory) changed = true;
    next[modelId] = migrated;
  }
  return changed ? next : memories;
}

function mergeModels(current: ModelInfo[], incoming: ModelInfo[]) {
  if (incoming.length === 0) return current.filter((model) => model.source !== 'local');
  const incomingIds = new Set(incoming.map((model) => model.id));
  const existingById = new Map(current.map((model) => [model.id, model]));
  const currentGroupColors = new Map(current.map((model) => [getModelThemeGroup(model).key, model.themeColorSolid]));
  const nonLocal = current.filter((model) => model.source !== 'local' && !incomingIds.has(model.id));
  const mergedLocal = incoming.map((model) => {
    const existing = existingById.get(model.id);
    const groupKey = getModelThemeGroup(model).key;
    const storedColor = storedState.modelThemeColors?.[model.id];
    const groupColor = currentGroupColors.get(groupKey) ?? storedState.modelThemeGroups?.[groupKey];
    const themeColorSolid = existing?.themeColorSolid ?? storedColor ?? groupColor;
    const storedLoadConfig = storedLoadConfigFor(model);
    const avgTokensPerSec = existing?.avgTokensPerSec ?? averageTokensPerSec(storedState.usageByModel?.[model.id]);
    const apiName = existing?.apiName ?? storedState.modelApiNames?.[model.id] ?? model.apiName;
    const customLogo = existing?.customLogo ?? storedState.modelCustomLogos?.[model.id] ?? model.customLogo;
    return existing
      ? {
          ...model,
          status: existing.status,
          loadConfig: normalizeLoadConfig({ ...model.loadConfig, ...storedLoadConfig, ...existing.loadConfig }),
          themeColor: themeColorSolid ? `${themeColorSolid}55` : model.themeColor,
          themeColorSolid: themeColorSolid ?? model.themeColorSolid,
          avgTokensPerSec,
          apiName,
          customLogo,
        }
      : {
          ...model,
          loadConfig: normalizeLoadConfig({ ...model.loadConfig, ...storedLoadConfig }),
          avgTokensPerSec,
          apiName,
          customLogo,
          ...(themeColorSolid ? { themeColorSolid, themeColor: `${themeColorSolid}55` } : {}),
        };
  });
  return [...nonLocal, ...mergedLocal];
}

function updateSessionList(
  sessions: ChatSession[],
  sessionId: string,
  updater: (session: ChatSession) => ChatSession
) {
  return sessions.map((session) => session.id === sessionId ? updater(session) : session);
}

function hasStreamingMessage(sessionsByModel: Record<string, ChatSession[]>) {
  return Object.values(sessionsByModel).some((sessions) =>
    sessions.some((session) => session.messages.some((message) => message.isStreaming))
  );
}

/** 设置中心里的分页：这些视图属于设置界面，不属于 Agent 工作区。 */
const SETTINGS_VIEWS: ViewType[] = ['settings', 'kernel', 'usage', 'tools', 'skills', 'data', 'webui'];

function appReducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_WORKSPACE':
      // 只换整棵界面树，当前这棵树里在看哪一页保持不变——
      // 切到 Agent 工作区再切回对话，正在聊的那句不会被打断。
      return { ...state, workspace: action.payload };
    case 'SET_CHAT_SCOPE':
      return { ...state, chatScope: action.payload };
    case 'SET_VIEW': {
      // SET_VIEW 兼容旧写法：'chat' 是"去对话界面"，其余按归属分流到
      // Agent 工作区或设置中心。界面归属在这里定死，调用方不必各自记着。
      if (action.payload === 'chat') {
        return { ...state, workspace: 'chat' };
      }
      if (SETTINGS_VIEWS.includes(action.payload)) {
        return { ...state, workspace: 'settings', currentView: action.payload };
      }
      return { ...state, workspace: 'agent', currentView: action.payload };
    }
    case 'SET_CHAT_ENGINE':
      return { ...state, chatEngine: action.payload };
    case 'SET_WEBUI_ENGINE':
      return { ...state, webuiEngine: action.payload };
    case 'SET_AGENT_TAB':
      return { ...state, agentTab: action.payload };
    case 'SET_PI_PROMPT_DRAFT':
      return { ...state, piPromptDraft: action.payload };
    case 'SET_THEME':
      return { ...state, theme: action.payload };
    case 'TOGGLE_THEME': {
      // 手动切换的同时把主题模式落为显式的浅色/深色。
      // 若仍停留在 system 模式，跟随系统的 effect 会立刻按系统偏好覆盖这次切换，
      // 表现为「跟随系统时点按钮无效」。
      const next: ThemeType = state.theme === 'dark' ? 'light' : 'dark';
      return { ...state, theme: next, themeMode: next };
    }
    case 'SET_THEME_MODE': {
      // 切到跟随系统时立刻按当前系统偏好同步一次生效主题，避免 UI 停留在旧值。
      let nextTheme = state.theme;
      if (action.payload === 'system') {
        const prefersDark = typeof window !== 'undefined' && window.matchMedia
          && window.matchMedia('(prefers-color-scheme: dark)').matches;
        nextTheme = prefersDark ? 'dark' : 'light';
      } else {
        nextTheme = action.payload;
      }
      return { ...state, themeMode: action.payload, theme: nextTheme };
    }
    case 'SET_SYNC_SYSTEM_ACCENT':
      return { ...state, syncSystemAccent: action.payload };
    case 'SET_ACRYLIC_MODE':
      return { ...state, acrylicMode: action.payload };
    case 'SET_REDUCE_MOTION':
      return { ...state, reduceMotion: action.payload };
    case 'SET_FONT_SCALE':
      return { ...state, fontScale: normalizeFontScale(action.payload) };
    case 'SET_ENTER_TO_SEND':
      return { ...state, enterToSend: action.payload };
    case 'CLEAR_ALL_CHAT_HISTORY':
      // 只清空会话与消息，保留模型配置、使用统计与界面偏好。
      return { ...state, chatSessions: {}, activeChatSessionIds: {} };
    case 'RESET_USAGE':
      // 使用统计按模型累加，清零不影响任何运行参数或会话内容。
      return { ...state, usageByModel: {}, recentModelUsage: {} };
    case 'RESET_UI_PREFS':
      // 外观与交互偏好回到出厂值；主题跟随系统、强调色恢复自动同步。
      // 不触碰 serverPort、模型目录、MCP 配置与对话记录。
      return {
        ...state,
        themeMode: 'system',
        theme: typeof window !== 'undefined' && window.matchMedia
          && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
        syncSystemAccent: true,
        acrylicMode: false,
        reduceMotion: false,
        fontScale: 100,
        enterToSend: true,
        sidebarCollapsed: false,
        // 文案承诺「侧边栏宽度恢复出厂值」，就必须一起重置，否则用户拖动过的宽度会留着。
        sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
        sortBy: 'default',
        gridColumns: 2,
      };
    case 'TOGGLE_SIDEBAR':
      return { ...state, sidebarCollapsed: !state.sidebarCollapsed };
    case 'SET_SIDEBAR_WIDTH':
      return { ...state, sidebarWidth: action.payload };
    case 'SET_SORT':
      return { ...state, sortBy: action.payload };
    case 'SET_GRID_COLUMNS':
      return { ...state, gridColumns: action.payload };
    case 'ACTIVATE_MODEL': {
      const model = state.models.find((item) => item.id === action.payload);
      if (!model || model.modelTask === 'embedding' || model.modelTask === 'rerank') return state;
      return {
        ...state,
        activeModelId: action.payload,
        models: activateMainModel(state.models, action.payload),
      };
    }
    case 'SET_ACTIVE_MODEL':
      return { ...state, activeModelId: action.payload };
    case 'SET_SELECTED_MODEL':
      return { ...state, selectedModelId: action.payload };
    case 'UPDATE_MODELS':
      return { ...state, models: action.payload };
    case 'UPDATE_SYSTEM_STATS':
      return { ...state, systemStats: action.payload };
    case 'SET_SEARCH':
      return { ...state, searchQuery: action.payload };
    case 'CREATE_CHAT_SESSION': {
      const { session } = action.payload;
      const sessions = state.chatSessions[session.modelId] || [];
      return {
        ...state,
        chatSessions: {
          ...state.chatSessions,
          [session.modelId]: [session, ...sessions],
        },
        activeChatSessionIds: {
          ...state.activeChatSessionIds,
          [session.modelId]: session.id,
        },
      };
    }
    case 'SET_ACTIVE_CHAT_SESSION':
      return {
        ...state,
        activeChatSessionIds: {
          ...state.activeChatSessionIds,
          [action.payload.modelId]: action.payload.sessionId,
        },
      };
    case 'SET_CHAT_SESSION_MODEL':
      return {
        ...state,
        chatSessions: {
          ...state.chatSessions,
          [action.payload.modelId]: updateSessionList(
            state.chatSessions[action.payload.modelId] || [],
            action.payload.sessionId,
            (session) => ({
              ...session,
              runtimeModelId: action.payload.runtimeModelId ?? session.runtimeModelId,
              modelName: action.payload.modelName ?? session.modelName,
              modelColor: action.payload.modelColor ?? session.modelColor,
            })
          ),
        },
      };
    case 'DELETE_CHAT_SESSION': {
      const sessions = (state.chatSessions[action.payload.modelId] || [])
        .filter((session) => session.id !== action.payload.sessionId);
      const wasActive = state.activeChatSessionIds[action.payload.modelId] === action.payload.sessionId;
      return {
        ...state,
        chatSessions: {
          ...state.chatSessions,
          [action.payload.modelId]: sessions,
        },
        activeChatSessionIds: {
          ...state.activeChatSessionIds,
          [action.payload.modelId]: wasActive ? sessions[0]?.id ?? '' : state.activeChatSessionIds[action.payload.modelId],
        },
      };
    }
    case 'RENAME_CHAT_SESSION':
      return {
        ...state,
        chatSessions: {
          ...state.chatSessions,
          [action.payload.modelId]: updateSessionList(
            state.chatSessions[action.payload.modelId] || [],
            action.payload.sessionId,
            (session) => ({ ...session, title: action.payload.title.trim() || session.title, updatedAt: Date.now() })
          ),
        },
      };
    case 'ADD_MESSAGE': {
      const sessions = state.chatSessions[action.payload.modelId] || [];
      const nextSessions = updateSessionList(sessions, action.payload.sessionId, (session) => {
        const nextTitle = session.title === '新对话'
          ? titleFromFirstUserMessage(action.payload.message) ?? session.title
          : session.title;
        return {
          ...session,
          title: nextTitle,
          updatedAt: action.payload.message.timestamp,
          messages: [...session.messages, action.payload.message],
        };
      });
      return { ...state, chatSessions: { ...state.chatSessions, [action.payload.modelId]: nextSessions } };
    }
    case 'UPDATE_MESSAGE': {
      const sessions = state.chatSessions[action.payload.modelId] || [];
      const nextSessions = updateSessionList(sessions, action.payload.sessionId, (session) => ({
        ...session,
        updatedAt: Date.now(),
        messages: session.messages.map((m) => m.id === action.payload.messageId ? {
          ...m,
          ...(action.payload.content !== undefined ? { content: action.payload.content } : {}),
          ...(action.payload.reasoningContent !== undefined ? { reasoningContent: action.payload.reasoningContent } : {}),
          ...(action.payload.toolActivity !== undefined ? { toolActivity: action.payload.toolActivity } : {}),
          ...(action.payload.warnings !== undefined ? { warnings: action.payload.warnings } : {}),
          ...(action.payload.piSteps !== undefined ? { piSteps: action.payload.piSteps } : {}),
          ...(action.payload.piTurnId !== undefined ? { piTurnId: action.payload.piTurnId } : {}),
          ...(action.payload.piState !== undefined ? { piState: action.payload.piState } : {}),
          ...(action.payload.artifacts !== undefined ? { artifacts: action.payload.artifacts } : {}),
        } : m),
      }));
      return { ...state, chatSessions: { ...state.chatSessions, [action.payload.modelId]: nextSessions } };
    }
    case 'SET_CHAT_SESSION_PI_ID': {
      const sessions = state.chatSessions[action.payload.modelId] || [];
      const nextSessions = updateSessionList(sessions, action.payload.sessionId, (session) => ({
        ...session,
        piSessionId: action.payload.piSessionId,
        updatedAt: Date.now(),
      }));
      return { ...state, chatSessions: { ...state.chatSessions, [action.payload.modelId]: nextSessions } };
    }
    case 'SET_MESSAGE_STREAMING': {
      const sessions = state.chatSessions[action.payload.modelId] || [];
      const nextSessions = updateSessionList(sessions, action.payload.sessionId, (session) => ({
        ...session,
        updatedAt: Date.now(),
        messages: session.messages.map((m) => m.id === action.payload.messageId ? { ...m, isStreaming: action.payload.streaming, stats: action.payload.stats || m.stats } : m),
      }));
      return { ...state, chatSessions: { ...state.chatSessions, [action.payload.modelId]: nextSessions } };
    }
    case 'REPLACE_MESSAGE_AND_TRUNCATE_AFTER': {
      const sessions = state.chatSessions[action.payload.modelId] || [];
      const nextSessions = updateSessionList(sessions, action.payload.sessionId, (session) => {
        const messageIndex = session.messages.findIndex((m) => m.id === action.payload.messageId);
        if (messageIndex === -1) return session;
        return {
          ...session,
          updatedAt: action.payload.message.timestamp,
          messages: [
            ...session.messages.slice(0, messageIndex),
            action.payload.message,
          ],
        };
      });
      return { ...state, chatSessions: { ...state.chatSessions, [action.payload.modelId]: nextSessions } };
    }
    case 'DELETE_MESSAGE': {
      const sessions = state.chatSessions[action.payload.modelId] || [];
      const nextSessions = updateSessionList(sessions, action.payload.sessionId, (session) => ({
        ...session,
        updatedAt: Date.now(),
        messages: session.messages.filter((m) => m.id !== action.payload.messageId),
      }));
      return { ...state, chatSessions: { ...state.chatSessions, [action.payload.modelId]: nextSessions } };
    }
    case 'CLEAR_MESSAGES': {
      const sessions = state.chatSessions[action.payload.modelId] || [];
      const nextSessions = updateSessionList(sessions, action.payload.sessionId, (session) => ({
        ...session,
        title: '新对话',
        updatedAt: Date.now(),
        messages: [],
      }));
      return { ...state, chatSessions: { ...state.chatSessions, [action.payload.modelId]: nextSessions } };
    }
    case 'APPLY_AUTO_TUNE': {
      const { authorization, result } = action.payload;
      if (state.autoTuneApplication?.runId === result.run_id) return state;
      const target = state.models.find((model) => model.id === authorization.config.model_id);
      const applied = result.run_id === authorization.config.run_id && result.model_id === authorization.config.model_id
        && canApplyAutoTune(target, authorization);
      return {
        ...state,
        autoTuneApplication: { runId: result.run_id, applied },
        models: applied ? state.models.map((model) => model.id === result.model_id
          ? { ...model, loadConfig: { ...model.loadConfig, ...tuneRecordPatch(result.best) } } : model) : state.models,
        appStatus: applied ? `${authorization.modelName} 已自动应用调参结果。短负载实测不保证长对话或交互最优。`
          : `${authorization.modelName} 的身份或完整加载配置已变化，未自动覆盖当前参数。`,
      };
    }
    case 'UPDATE_MODEL_CONFIG': {
      return { ...state, models: state.models.map((m) => m.id === action.payload.modelId ? { ...m, loadConfig: { ...m.loadConfig, ...action.payload.config } } : m) };
    }
    case 'REMEMBER_MODEL_LAUNCH_CONFIG': {
      return {
        ...state,
        modelLaunchMemories: {
          ...state.modelLaunchMemories,
          [action.payload.modelId]: {
            config: normalizeLoadConfig(action.payload.config),
            updatedAt: Date.now(),
          },
        },
      };
    }
    case 'MARK_MODEL_RECENTLY_USED': {
      // 只保留最近使用的 3 个模型，按时间戳从新到旧保留。
      const MAX_RECENT = 3;
      const merged: Record<string, number> = {
        ...state.recentModelUsage,
        [action.payload.modelId]: Date.now(),
      };
      const top = Object.entries(merged)
        .sort(([, a], [, b]) => b - a)
        .slice(0, MAX_RECENT);
      return {
        ...state,
        recentModelUsage: Object.fromEntries(top),
      };
    }
    case 'UPDATE_MODEL_STATUS': {
      return { ...state, models: state.models.map((m) => m.id === action.payload.modelId ? { ...m, status: action.payload.status } : m) };
    }
    case 'UPSERT_MODELS':
      return {
        ...state,
        models: mergeModels(state.models, action.payload),
        // 记忆参数（快速启动）里的同口径迁移也要走一次，否则用户点「快速启动」
        // 又会用回少一层的慢档；仅在本次启动尚未迁移时执行。
        modelLaunchMemories: needsGpuLayersCeilingMigration
          ? (migrateLaunchMemoryGpuLayers(action.payload, state.modelLaunchMemories) ?? {})
          : state.modelLaunchMemories,
      };
    case 'PRUNE_USAGE': {
      const keepIds = new Set(action.payload);
      // `api-` 是日志口径的外部 API 用量，`engine:` 是 NiNfer / Strata 引擎用量；
      // 两者都不来自模型扫描，不能被「清理已删除模型」一并抹掉。
      const nextUsageByModel = Object.fromEntries(
        Object.entries(state.usageByModel).filter(([modelId]) =>
          keepIds.has(modelId) || modelId.startsWith('api-') || modelId.startsWith('engine:')),
      );
      return { ...state, usageByModel: nextUsageByModel };
    }
    case 'SET_BACKEND_AVAILABLE':
      return { ...state, backendAvailable: action.payload };
    case 'SET_SERVER_RUNNING':
      return {
        ...state,
        serverRunning: action.payload,
        models: action.payload ? state.models : clearMainLoadedModels(state.models),
      };
    case 'SET_SERVER_PORT':
      return { ...state, serverPort: action.payload };
    case 'SET_API_CONFIG':
      return { ...state, apiConfig: { ...state.apiConfig, ...action.payload } };
    case 'SET_MODEL_DIRS':
      return { ...state, modelDirs: action.payload };
    case 'SET_CLOSE_TO_TRAY':
      return { ...state, closeToTray: action.payload };
    case 'SET_MCP_SERVERS':
      return { ...state, mcpServers: action.payload };
    case 'SET_MCP_STATUSES': {
      // 运行状态按 id 合并进配置项，供工具页与聊天页读取工具清单。
      // 只更新 payload 里出现的条目：单条更新（连接/断开）不应把
      // 其它仍在运行的服务器错误地标回「未连接」；整表删除由 SET_MCP_SERVERS 负责。
      const byId = new Map(action.payload.map((status) => [status.id, status]));
      return {
        ...state,
        mcpServers: state.mcpServers.map((server) => {
          const status = byId.get(server.id);
          if (!status) return server;
          // status.transport 可能为 null（后端未记录），此时保留配置里的值。
          const { transport, ...rest } = status;
          return {
            ...server,
            ...rest,
            ...(transport ? { transport } : {}),
          };
        }),
      };
    }
    case 'SET_APP_STATUS':
      return { ...state, appStatus: action.payload };
    case 'SET_CHAT_CONFIG':
      return { ...state, chatConfig: { ...state.chatConfig, ...action.payload } };
    case 'SAVE_SYSTEM_PROMPT_PRESET': {
      const title = action.payload.title.trim() || `提示词 ${state.systemPromptPresets.length + 1}`;
      const prompt = action.payload.prompt.trim();
      if (!prompt) return state;
      const now = Date.now();
      const existing = state.systemPromptPresets.find((preset) => preset.title === title);
      const nextPreset: SystemPromptPreset = {
        id: existing?.id ?? `prompt-${now}`,
        title,
        prompt,
        updatedAt: now,
      };
      return {
        ...state,
        systemPromptPresets: [
          nextPreset,
          ...state.systemPromptPresets.filter((preset) => preset.id !== nextPreset.id),
        ],
      };
    }
    case 'DELETE_SYSTEM_PROMPT_PRESET':
      return {
        ...state,
        systemPromptPresets: state.systemPromptPresets.filter((preset) => preset.id !== action.payload.presetId),
      };
    case 'SET_MODEL_THEME_COLOR': {
      const color = action.payload.color;
      const nextUsageByModel = state.usageByModel[action.payload.modelId]
        ? {
            ...state.usageByModel,
            [action.payload.modelId]: {
              ...state.usageByModel[action.payload.modelId],
              modelColor: color,
            },
          }
        : state.usageByModel;
      return {
        ...state,
        usageByModel: nextUsageByModel,
        models: state.models.map((model) => model.id === action.payload.modelId
          ? {
              ...model,
              themeColorSolid: color,
              themeColor: `${color}55`,
            }
          : model),
      };
    }
    case 'SET_MODEL_API_NAME':
      return {
        ...state,
        models: state.models.map((model) => model.id === action.payload.modelId
          ? { ...model, apiName: action.payload.apiName }
          : model),
      };
    case 'SET_MODEL_CUSTOM_LOGO':
      return {
        ...state,
        models: state.models.map((model) => model.id === action.payload.modelId
          ? { ...model, customLogo: action.payload.customLogo }
          : model),
      };
    case 'SET_MODEL_GROUP_THEME_COLOR': {
      const color = action.payload.color;
      const matchingModelIds = new Set(
        state.models
          .filter((model) => getModelThemeGroup(model).key === action.payload.groupKey)
          .map((model) => model.id)
      );
      const nextUsageByModel = Object.fromEntries(
        Object.entries(state.usageByModel).map(([modelId, usage]) => [
          modelId,
          matchingModelIds.has(modelId) ? { ...usage, modelColor: color } : usage,
        ])
      );
      return {
        ...state,
        usageByModel: nextUsageByModel,
        models: state.models.map((model) => getModelThemeGroup(model).key === action.payload.groupKey
          ? {
              ...model,
              themeColorSolid: color,
              themeColor: `${color}55`,
            }
          : model),
      };
    }
    case 'ADD_USAGE': {
      const current = state.usageByModel[action.payload.modelId] ?? {
        modelName: action.payload.modelName,
        modelColor: action.payload.modelColor,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        responseCount: 0,
        totalTokensPerSec: 0,
        totalFirstTokenDelay: 0,
        totalGenTime: 0,
        dailyTokens: {},
      };
      const day = todayKey();
      const nextUsage = {
        modelName: action.payload.modelName ?? current.modelName,
        modelColor: action.payload.modelColor ?? current.modelColor,
        promptTokens: current.promptTokens + action.payload.promptTokens,
        completionTokens: current.completionTokens + action.payload.completionTokens,
        totalTokens: current.totalTokens + action.payload.totalTokens,
        responseCount: current.responseCount + 1,
        totalTokensPerSec: current.totalTokensPerSec + (action.payload.tokensPerSec ?? 0),
        totalFirstTokenDelay: (current.totalFirstTokenDelay ?? 0) + (action.payload.firstTokenDelay ?? 0),
        totalGenTime: (current.totalGenTime ?? 0) + (action.payload.genTime ?? 0),
        lastUsedAt: Date.now(),
        dailyTokens: {
          ...current.dailyTokens,
          [day]: (current.dailyTokens[day] ?? 0) + action.payload.totalTokens,
        },
      };
      const avg = nextUsage.responseCount > 0 && nextUsage.totalTokensPerSec > 0
        ? nextUsage.totalTokensPerSec / nextUsage.responseCount
        : undefined;
      return {
        ...state,
        usageByModel: {
          ...state.usageByModel,
          [action.payload.modelId]: nextUsage,
        },
        models: state.models.map((model) => model.id === action.payload.modelId
          ? { ...model, avgTokensPerSec: avg }
          : model),
      };
    }
    // 快照式写入外部 API 的 token 用量（比 ADD_USAGE 更适合“整块累计”场景，
    // 避免增量差分导致 prompt/completion 重复累加或百分比失真）。
    case 'SET_API_USAGE': {
      const { modelId, modelName, modelColor, promptTokens, completionTokens, totalTokens, responseCount } = action.payload;
      const existing = state.usageByModel[modelId];
      const prevTotal = existing?.totalTokens ?? 0;
      const day = todayKey();
      const nextUsage: ModelUsageStats = {
        modelName: modelName ?? existing?.modelName ?? modelId,
        modelColor: modelColor ?? existing?.modelColor,
        promptTokens,
        completionTokens,
        totalTokens,
        responseCount,
        totalTokensPerSec: existing?.totalTokensPerSec ?? 0,
        totalFirstTokenDelay: existing?.totalFirstTokenDelay ?? 0,
        totalGenTime: existing?.totalGenTime ?? 0,
        lastUsedAt: Date.now(),
        dailyTokens: {
          ...(existing?.dailyTokens ?? {}),
          [day]: (existing?.dailyTokens[day] ?? 0) + Math.max(0, totalTokens - prevTotal),
        },
      };
      return { ...state, usageByModel: { ...state.usageByModel, [modelId]: nextUsage } };
    }
    // 后端日志累计已清空（或服务刚启动）：移除残留的 api-* 条目。
    // 没有可删条目时返回原 state，避免轮询每 2 秒制造一次新引用触发全应用重渲染。
    case 'CLEAR_API_USAGE': {
      const apiIds = Object.keys(state.usageByModel).filter((id) => id.startsWith('api-'));
      if (apiIds.length === 0) return state;
      const usageByModel = { ...state.usageByModel };
      for (const id of apiIds) delete usageByModel[id];
      return { ...state, usageByModel };
    }
    // 引擎后端：指标快照已是全量口径，直接覆盖该后端的累计条目。
    // 不累加的原因：快照每次轮询都会把同一批历史请求再算一遍，累加会让总量持续虚高。
    case 'SET_ENGINE_USAGE': {
      const {
        modelId, modelName, modelColor,
        promptTokens, completionTokens, totalTokens, responseCount,
        totalTokensPerSec, totalFirstTokenDelay, totalGenTime, dailyTokens, lastUsedAt,
      } = action.payload;
      // 没有任何 token 时不要凭空创建条目（引擎起来了但还没请求过）。
      if (totalTokens <= 0 && responseCount <= 0) return state;
      const nextUsage: ModelUsageStats = {
        modelName,
        modelColor,
        promptTokens,
        completionTokens,
        totalTokens,
        responseCount,
        totalTokensPerSec,
        totalFirstTokenDelay,
        totalGenTime,
        lastUsedAt: lastUsedAt > 0 ? lastUsedAt : Date.now(),
        dailyTokens,
      };
      return {
        ...state,
        usageByModel: { ...state.usageByModel, [modelId]: nextUsage },
      };
    }
    default:
      return state;
  }
}

interface AppContextType { state: AppState; dispatch: React.Dispatch<Action>; }

const AppContext = createContext<AppContextType | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, baseDispatch] = useReducer(appReducer, initialState);
  const stateRef = useRef(state);

  /**
   * 包装 dispatch：用户手动改主题时打 localStorage 标记，
   * 之后 matchMedia 跟随系统的 effect 看到这个标记就不再覆盖用户选择。
   */
  const dispatch = useCallback((action: Action) => {
    if (action.type === 'SET_THEME' || action.type === 'TOGGLE_THEME' || action.type === 'SET_THEME_MODE') {
      try { window.localStorage.setItem(THEME_MANUAL_FLAG, '1'); } catch { /* best-effort */ }
    }
    baseDispatch(action);
  }, []);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // 浏览器开发预览：`?demo=1` 注入示例模型，方便在没有 GGUF 的机器上检查卡片样式。
  // 桌面端不注入，真实模型列表不受影响。
  useEffect(() => {
    if (typeof window === 'undefined' || isDesktopRuntime()) return;
    if (new URLSearchParams(window.location.search).get('demo') !== '1') return;
    dispatch({ type: 'UPSERT_MODELS', payload: DEMO_MODELS });
    // UPSERT 会合并本地保存的分组主题色；示例数据要按脚本里的颜色展示，逐卡再定一次。
    for (const model of DEMO_MODELS) {
      dispatch({ type: 'SET_MODEL_THEME_COLOR', payload: { modelId: model.id, color: model.themeColorSolid } });
    }
    dispatch({ type: 'MARK_MODEL_RECENTLY_USED', payload: { modelId: 'demo-llama' } });
    dispatch({ type: 'REMEMBER_MODEL_LAUNCH_CONFIG', payload: { modelId: 'demo-qwen', config: DEMO_MODELS[0].loadConfig } });
  }, [dispatch]);

  useEffect(() => {
    autoTuneManager.setApplicationHandler((authorization, result) => {
      dispatch({ type: 'APPLY_AUTO_TUNE', payload: { authorization, result } });
    });
    void ensureAutoTuneRuntime().catch((error) => {
      dispatch({ type: 'SET_APP_STATUS', payload: `自动调参状态连接失败：${String(error)}` });
    });
    return () => autoTuneManager.setApplicationHandler(undefined);
  }, [dispatch]);

  useEffect(() => {
    const receipt = state.autoTuneApplication;
    if (receipt) autoTuneManager.reportApplication(receipt.runId, receipt.applied);
  }, [state.autoTuneApplication]);

  /**
   * 把 Rust 端读到的 Windows accent color 注入到 CSS 变量。
   *
   * 直接写 <html style="--accent: #xxx"> 比放在 React state 更稳——避免
   * "主题切换 → 整树 re-render"。同时按当前亮/暗算出 hover/pressed/subtle 派生色。
   * syncSystemAccent 关闭时移除内联覆盖，回落到 index.css 里的 Fluent 默认蓝。
   */
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement.style;
    if (!state.syncSystemAccent) {
      root.removeProperty('--accent');
      root.removeProperty('--accent-hover');
      root.removeProperty('--accent-pressed');
      root.removeProperty('--accent-subtle');
      return;
    }
    let cancelled = false;
    void (async () => {
      const appearance = await getDesktopSystemAppearance();
      if (cancelled || !appearance) return;
      const accent = appearance.accent_color;
      if (!accent || !/^#[0-9A-Fa-f]{6}$/.test(accent)) return;
      const dark = document.documentElement.classList.contains('dark');
      const hover = dark ? mixAccent(accent, 0.18) : mixAccent(accent, -0.12);
      const pressed = dark ? mixAccent(accent, 0.08) : mixAccent(accent, -0.22);
      const subtle = `${accent}26`; // ~15% alpha
      root.setProperty('--accent', accent);
      root.setProperty('--accent-hover', hover);
      root.setProperty('--accent-pressed', pressed);
      root.setProperty('--accent-subtle', subtle);
    })();
    return () => { cancelled = true; };
  }, [state.theme, state.syncSystemAccent]);

  /**
   * 跟随系统亮/暗：themeMode 为 system 时跟随 matchMedia，否则尊重用户显式选择。
   * - Tauri 桌面端 + 浏览器都启用，prefers-color-scheme 在 WebView2 上自动可用。
   * - 系统触发的切换直接走 baseDispatch，避免写 manual flag。
   */
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    if (state.themeMode !== 'system') return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = (e: MediaQueryListEvent | MediaQueryList) => {
      const dark = e.matches;
      const next: ThemeType = dark ? 'dark' : 'light';
      if (state.theme !== next) {
        // 直接调 baseDispatch，跳过 manual flag（这是系统不是用户）
        baseDispatch({ type: 'SET_THEME', payload: next });
      }
    };
    apply(mql);
    if (mql.addEventListener) {
      mql.addEventListener('change', apply);
      return () => mql.removeEventListener('change', apply);
    }
    mql.addListener(apply);
    return () => mql.removeListener(apply);
  }, [state.theme, state.themeMode]);

  /**
   * 毛玻璃模式：
   * - html.acrylic-mode 交给 CSS 铺一层可读的半透明霜化罩
   * - 桌面运行时把窗口从 Mica 切到系统 Acrylic，才能真正透出壁纸颜色变化
   * - html.tauri-desktop 用来关掉浏览器假壁纸，避免盖住系统材质
   */
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (isDesktopRuntime()) root.classList.add('tauri-desktop');
    root.classList.toggle('acrylic-mode', state.acrylicMode);
    if (!isDesktopRuntime()) return;
    void setDesktopWindowMaterial(state.acrylicMode ? 'acrylic' : 'mica');
  }, [state.acrylicMode]);

  /**
   * 减少动画：html.reduce-motion 让 CSS 过渡/动画瞬间完成（index.css 里有对应规则）；
   * framer-motion 侧由 App 根节点的 MotionConfig 读取同一开关，两边口径一致。
   */
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.classList.toggle('reduce-motion', state.reduceMotion);
  }, [state.reduceMotion]);

  /**
   * 字体缩放：只改根字号，token 与 Tailwind 的 rem 字号一起缩放，
   * 避免「令牌字号变了、text-sm 没变」的分裂。
   */
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.style.setProperty('--ui-font-scale', String(state.fontScale / 100));
  }, [state.fontScale]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;

    let cancelled = false;

    async function hydrateDesktopState() {
      dispatch({ type: 'SET_BACKEND_AVAILABLE', payload: true });
      dispatch({ type: 'SET_APP_STATUS', payload: '正在连接本地运行环境...' });

      try {
        // 引擎检测与缓存扫描不依赖前端 config，提前与配置请求一起并行发起，
        // 避免串行等待导致首屏模型列表迟迟不出现。
        const [config, serverRunning, hasExternalApiKey, sessionApiKey, engineInfo, cached] =
          await Promise.all([
            getDesktopConfig(),
            getDesktopServerStatus().catch(() => false),
            getExternalApiKeyStatus().catch(() => false),
            getExternalApiKeyForSession().catch(() => null),
            checkDesktopEngine().catch(() => null),
            scanDesktopModels(false).catch(() => []),
          ]);
        if (cancelled) return;

        const migratedStoredApiKey = storedApiConfig.apiKey?.trim();
        let resolvedHasApiKey = hasExternalApiKey;
        let resolvedSessionApiKey = sessionApiKey ?? undefined;
        if (!resolvedHasApiKey && migratedStoredApiKey) {
          try {
            await createExternalApiKey(migratedStoredApiKey);
            resolvedHasApiKey = true;
            resolvedSessionApiKey = migratedStoredApiKey;
          } catch {
            resolvedHasApiKey = false;
          }
        }

        if (serverRunning) {
          const activeKey = await getServerApiKey().catch(() => null);
          if (activeKey) {
            resolvedSessionApiKey = activeKey;
            resolvedHasApiKey = true;
          }
        }

        // 迁移完成后立即清除 localStorage 中的旧明文 apiKey
        if (migratedStoredApiKey) {
          try {
            const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
            if (stored?.apiConfig && 'apiKey' in stored.apiConfig) {
              delete stored.apiConfig.apiKey;
              window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
            }
          } catch { /* best-effort */ }
        }

        if (config) {
          dispatch({ type: 'SET_MODEL_DIRS', payload: config.model_dirs });
          dispatch({ type: 'SET_SERVER_PORT', payload: config.default_port });
          dispatch({ type: 'SET_CLOSE_TO_TRAY', payload: config.close_to_tray ?? true });
          dispatch({
            type: 'SET_API_CONFIG',
            payload: {
              enabled: config.api_enabled ?? false,
              // 监听地址跟随对外开关：开启自动适配局域网（0.0.0.0），关闭保持仅本机。
              host: config.api_enabled ? '0.0.0.0' : '127.0.0.1',
              hasApiKey: resolvedHasApiKey,
              apiKey: resolvedSessionApiKey,
            },
          });
        }
        dispatch({ type: 'SET_SERVER_RUNNING', payload: serverRunning });

        // MCP 服务器配置：以后端 config.json 为准拉取一次；
        // 标记为「随对话自动连接」的项在这里连上，其余留给工具页手动操作。
        void (async () => {
          try {
            const servers = await listMcpServers();
            if (cancelled) return;
            dispatch({ type: 'SET_MCP_SERVERS', payload: servers });
            const autoConnect = servers.filter((server) => server.enabled);
            if (autoConnect.length === 0) return;
            const results = await Promise.all(
              autoConnect.map((server) =>
                connectMcpServer(server.id).catch(() => null)
              )
            );
            if (cancelled) return;
            const statuses = results.filter((status): status is McpServerStatus => Boolean(status));
            if (statuses.length > 0) {
              dispatch({ type: 'SET_MCP_STATUSES', payload: statuses });
            }
          } catch {
            // MCP 不可用不应阻断启动流程。
          }
        })();

        if (engineInfo && !engineInfo.binary_exists) {
          // 直接打开独立的核心更新页，引导用户下载内核。
          dispatch({ type: 'SET_VIEW', payload: 'kernel' });
          dispatch({
            type: 'SET_APP_STATUS',
            payload: '未检测到 llama.cpp 内核，请先下载核心后再加载模型。',
          });
          return;
        }

        if (!config?.model_dirs.length) {
          dispatch({ type: 'SET_APP_STATUS', payload: '请选择本地 GGUF 模型目录。' });
          return;
        }

        // 先用缓存扫描结果渲染模型列表，让用户尽快可交互。
        if (cached.length > 0) {
          dispatch({ type: 'UPSERT_MODELS', payload: cached.map(toFrontendModel) });
        }

        const scanned = await scanDesktopModels(true);
        if (cancelled) return;

        const scannedModels = scanned.map(toFrontendModel);
        dispatch({ type: 'UPSERT_MODELS', payload: scannedModels });
        // 只保留目录中现存的模型的统计数据，已删除的模型数据一并清掉。
        dispatch({ type: 'PRUNE_USAGE', payload: scannedModels.map((model) => model.id) });
        dispatch({
          type: 'SET_APP_STATUS',
          payload: scanned.length > 0 ? `已发现 ${scanned.length} 个本地 GGUF 模型。` : '模型目录里暂未发现 GGUF 文件。',
        });
      } catch (error) {
        if (!cancelled) {
          dispatch({ type: 'SET_APP_STATUS', payload: `本地运行环境连接失败：${String(error)}` });
        }
      }
    }

    void hydrateDesktopState();

    return () => {
      cancelled = true;
    };
  }, [dispatch]);

  useEffect(() => {
    if (!isDesktopRuntime() || !state.serverRunning || !state.activeModelId) return;

    const activeModel = state.models.find((model) => model.id === state.activeModelId);
    if (!activeModel?.loadConfig.idleAutoUnload) return;
    if (hasStreamingMessage(state.chatSessions)) return;

    const minutes = Math.max(1, Math.round(Number(activeModel.loadConfig.idleAutoUnloadMinutes ?? 15)));
    let disposed = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          await stopDesktopServer();
          if (disposed) return;
          dispatch({ type: 'SET_SERVER_RUNNING', payload: false });
          dispatch({ type: 'UPDATE_MODEL_STATUS', payload: { modelId: activeModel.id, status: 'standby' } });
          dispatch({ type: 'SET_APP_STATUS', payload: `${activeModel.name} 已在空闲 ${minutes} 分钟后自动卸载。` });
        } catch (error) {
          if (!disposed) {
            dispatch({ type: 'SET_APP_STATUS', payload: `自动卸载失败：${String(error)}` });
          }
        }
      })();
    }, minutes * 60 * 1000);

    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [
    state.activeModelId,
    state.chatSessions,
    state.models,
    state.serverRunning,
    dispatch,
  ]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;

    let disposed = false;
    const unlisteners: Array<() => void> = [];

    void listenDesktopEvent<{ error_type?: string; title?: string; details?: string }>(
      'server:error',
      (error) => {
        if (disposed) return;
        dispatch({ type: 'SET_SERVER_RUNNING', payload: false });
        const modelId = stateRef.current.models.find((model) => model.status === 'loading')?.id
          ?? stateRef.current.activeModelId;
        if (modelId) {
          dispatch({ type: 'UPDATE_MODEL_STATUS', payload: { modelId, status: 'error' } });
        }
        dispatch({
          type: 'SET_APP_STATUS',
          payload: error.title
            ? `${error.title}：${error.details ?? ''}`
            : '推理服务异常退出，请重新加载模型。',
        });
      },
    ).then((unlisten) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    });

    void listenDesktopEvent('server:stopped', () => {
      if (disposed) return;
      dispatch({ type: 'SET_SERVER_RUNNING', payload: false });
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    });

    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [state.activeModelId, dispatch]);

  // 轮询 llama-server 日志累计的 token 用量（含对外 API 等非前端聊天请求）。
  // key = `api-<model_name>`；为避免把已在前端聊天统计里计入的 token 重复累加，
  // 先从日志总额里扣掉前端聊天统计（state.usageByModel 里非 api- 前缀同模型名的 total）。
  const usageByModelRef = useRef(state.usageByModel);
  useEffect(() => {
    usageByModelRef.current = state.usageByModel;
  }, [state.usageByModel]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let disposed = false;
    let timer: number | null = null;
    // 连续失败次数：用于退避重试。曾经 catch 里直接 return，注释写「下个周期再试」，
    // 实际却再也不会排下一轮——服务重启或一次 IPC 抖动之后，整个应用生命周期内
    // 都不再采集 API 用量。
    let failures = 0;

    const poll = async () => {
      if (disposed) return;
      try {
        const entries = await getApiTokenUsage();
        failures = 0;
        if (disposed || !Array.isArray(entries)) return;
        if (entries.length === 0) {
          // 服务刚启动/刚换模型时后端累计为空，同步清掉前端残留的 api-* 条目。
          dispatch({ type: 'CLEAR_API_USAGE' });
          return;
        }
        for (const entry of entries) {
          const modelId = `api-${entry.model_name}`;
          // 该模型在前端聊天统计里已计入的 token（真实模型 id，非 api- 前缀）。
          // 日志总额 = 聊天 + 外部 API；净 API = 总额 − 已计聊天，避免总数虚高。
          const chat = Object.entries(usageByModelRef.current)
            .filter(([id]) => !id.startsWith('api-'))
            .reduce(
              (acc, [id, usage]) => {
                const matches = usage.modelName === entry.model_name || id === entry.model_name;
                if (!matches) return acc;
                return {
                  promptTokens: acc.promptTokens + usage.promptTokens,
                  completionTokens: acc.completionTokens + usage.completionTokens,
                  totalTokens: acc.totalTokens + usage.totalTokens,
                };
              },
              { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            );
          // 净 API 消耗（钳制为 ≥0）。
          const apiTotal = Math.max(0, entry.total_tokens - chat.totalTokens);
          if (apiTotal <= 0) {
            continue;
          }
          const apiPrompt = Math.min(entry.prompt_tokens, apiTotal);
          const apiCompletion = apiTotal - apiPrompt;
          dispatch({
            type: 'SET_API_USAGE',
            payload: {
              modelId,
              modelName: `API · ${entry.model_name}`,
              modelColor: 'var(--accent)',
              promptTokens: apiPrompt,
              completionTokens: apiCompletion,
              totalTokens: apiTotal,
              responseCount: entry.response_count,
            },
          });
        }
      } catch {
        // 桌面运行时偶尔失效（服务刚重启 / IPC 抖动）：计数退避，下一轮继续。
        failures += 1;
      } finally {
        // 无论成功、失败还是提前 return，都必须在 finally 里排下一轮，
        // 否则一次失败就让轮询永久停摆。
        if (!disposed) {
          const delay = failures === 0 ? 2000 : Math.min(30_000, 2000 * 2 ** Math.min(failures, 4));
          timer = window.setTimeout(poll, delay);
        }
      }
    };
    void poll();

    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [dispatch]);

  // H1: 把"构建快照 + JSON.stringify + 同步写 localStorage"集中到一个 ref 函数，
  // 流式输出时每个 token 都会改写 chatSessions，若每次都全量序列化+写盘会严重阻塞主线程。
  // 这里用防抖（600ms）合并高频写入，并在页面隐藏/卸载时立即落盘，避免丢数据。
  const persistRef = useRef<() => void>(() => {});
  const persistTimerRef = useRef<number | null>(null);

  // 每次渲染后刷新落盘函数，使其始终捕获最新 state（在 render 期间赋值 ref 不被允许）。
  useEffect(() => {
    persistRef.current = () => {
      if (typeof window === 'undefined') return;

      const existing = loadStoredState();
      const modelThemeColors = {
        ...(existing.modelThemeColors ?? {}),
        ...Object.fromEntries(state.models.map((model) => [model.id, model.themeColorSolid])),
      };
      const modelThemeGroups = {
        ...(existing.modelThemeGroups ?? {}),
        ...Object.fromEntries(state.models.map((model) => [getModelThemeGroup(model).key, model.themeColorSolid])),
      };
      const modelLoadConfigs = {
        ...(existing.modelLoadConfigs ?? {}),
        ...Object.fromEntries(state.models.map((model) => [model.id, model.loadConfig])),
      };
      const modelApiNames = { ...(existing.modelApiNames ?? {}) };
      const modelCustomLogos = { ...(existing.modelCustomLogos ?? {}) };
      for (const model of state.models) {
        const apiName = model.apiName?.trim();
        if (apiName) modelApiNames[model.id] = apiName;
        else delete modelApiNames[model.id];
        if (model.customLogo) modelCustomLogos[model.id] = model.customLogo;
        else delete modelCustomLogos[model.id];
      }

      const next: StoredAppState = {
        chatConfig: state.chatConfig,
        systemPromptPresets: state.systemPromptPresets,
        apiConfig: {
          enabled: state.apiConfig.enabled,
          host: state.apiConfig.host,
          hasApiKey: state.apiConfig.hasApiKey,
        },
        usageByModel: state.usageByModel,
        chatSessions: stripPersistedMedia(sanitizeStoredSessions(state.chatSessions)),
        activeChatSessionIds: state.activeChatSessionIds,
        chatScope: state.chatScope,
        modelLoadConfigs,
        modelLaunchMemories: state.modelLaunchMemories,
        recentModelUsage: state.recentModelUsage,
        modelThemeColors,
        modelThemeGroups,
        modelApiNames,
        modelCustomLogos,
        ui: {
          theme: state.theme,
          themePreferenceVersion: THEME_PREFERENCE_VERSION,
          themeMode: state.themeMode,
          syncSystemAccent: state.syncSystemAccent,
          acrylicMode: state.acrylicMode,
          reduceMotion: state.reduceMotion,
          fontScale: state.fontScale,
          enterToSend: state.enterToSend,
          sidebarCollapsed: state.sidebarCollapsed,
          sidebarWidth: state.sidebarWidth,
          sortBy: state.sortBy,
          gridColumns: state.gridColumns,
          serverPort: state.serverPort,
        },
      };

      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Local persistence is best-effort; the app still runs without it.
      }
    };
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;

    // 防抖调度：每次状态变化重置计时器，停止变化 600ms 后才真正写盘。
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current);
    }
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null;
      persistRef.current();
    }, 600);

    return () => {
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
  }, [
    state.activeChatSessionIds,
    state.apiConfig,
    state.chatConfig,
    state.chatScope,
    state.chatSessions,
    state.gridColumns,
    state.models,
    state.modelLaunchMemories,
    state.recentModelUsage,
    state.systemPromptPresets,
    state.serverPort,
    state.sidebarCollapsed,
    state.sidebarWidth,
    state.sortBy,
    state.theme,
    state.themeMode,
    state.syncSystemAccent,
    state.acrylicMode,
    state.reduceMotion,
    state.fontScale,
    state.enterToSend,
    state.usageByModel,
  ]);

  // 页面隐藏/卸载时立即落盘，确保防抖窗口内的最后一次变更不丢失。
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const flush = () => {
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
      persistRef.current();
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };

    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', handleVisibility);
      flush();
    };
  }, []);

  return <AppContext.Provider value={{ state, dispatch }}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used within AppProvider');
  return context;
}
