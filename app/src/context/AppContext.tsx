import { createContext, useCallback, useContext, useEffect, useReducer, useRef, type ReactNode } from 'react';
import type { AppState, ViewType, ThemeType, ThemeMode, SortType, GridColumnType, ModelInfo, Message, SystemStats, ModelLoadConfig, ChatGenerationConfig, ExternalApiConfig, ModelUsageStats, ChatSession, ModelLaunchMemory, SystemPromptPreset } from '@/types';
import {
  checkDesktopEngine,
  getDesktopConfig,
  getDesktopServerStatus,
  getDesktopSystemAppearance,
  getExternalApiKeyForSession,
  getExternalApiKeyStatus,
  getServerApiKey,
  isDesktopRuntime,
  setDesktopWindowMaterial,
  createExternalApiKey,
  listenDesktopEvent,
  scanDesktopModels,
  stopDesktopServer,
  toFrontendModel,
} from '@/lib/desktop';
import { DEFAULT_MAX_COMPLETION_TOKENS, RECOMMENDED_CTX_LENGTH } from '@/lib/modelDefaults';
import { getModelThemeGroup } from '@/lib/modelTheme';

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

type Action =
  | { type: 'SET_VIEW'; payload: ViewType }
  | { type: 'SET_THEME'; payload: ThemeType }
  | { type: 'TOGGLE_THEME' }
  | { type: 'SET_THEME_MODE'; payload: ThemeMode }
  | { type: 'SET_SYNC_SYSTEM_ACCENT'; payload: boolean }
  | { type: 'SET_ACRYLIC_MODE'; payload: boolean }
  | { type: 'TOGGLE_SIDEBAR' }
  | { type: 'SET_SORT'; payload: SortType }
  | { type: 'SET_GRID_COLUMNS'; payload: GridColumnType }
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
  | { type: 'UPDATE_MESSAGE'; payload: { modelId: string; sessionId: string; messageId: string; content?: string; reasoningContent?: string } }
  | { type: 'SET_MESSAGE_STREAMING'; payload: { modelId: string; sessionId: string; messageId: string; streaming: boolean; stats?: Message['stats'] } }
  | { type: 'REPLACE_MESSAGE_AND_TRUNCATE_AFTER'; payload: { modelId: string; sessionId: string; messageId: string; message: Message } }
  | { type: 'DELETE_MESSAGE'; payload: { modelId: string; sessionId: string; messageId: string } }
  | { type: 'CLEAR_MESSAGES'; payload: { modelId: string; sessionId: string } }
  | { type: 'SET_SEARCH'; payload: string }
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
    };

const initialSystemStats: SystemStats = {
  gpuUsage: 0, vramUsed: 0, vramTotal: 0, ramUsage: 0, ramTotal: 0,
  computeScores: Array.from({ length: 60 }, () => 0),
  gpuName: '未连接硬件监控', hostName: '未连接桌面运行环境',
};

const STORAGE_KEY = 'agent-llm-local-state-v1';

interface StoredAppState {
  chatConfig?: Partial<ChatGenerationConfig>;
  systemPromptPresets?: SystemPromptPreset[];
  usageByModel?: Record<string, ModelUsageStats>;
  chatSessions?: Record<string, ChatSession[]>;
  activeChatSessionIds?: Record<string, string>;
  apiConfig?: Partial<Omit<ExternalApiConfig, 'apiKey'>> & { apiKey?: string };
  modelLoadConfigs?: Record<string, ModelLoadConfig>;
  modelLaunchMemories?: Record<string, ModelLaunchMemory>;
  recentModelUsage?: Record<string, number>;
  modelThemeColors?: Record<string, string>;
  modelThemeGroups?: Record<string, string>;
  modelApiNames?: Record<string, string>;
  modelCustomLogos?: Record<string, string>;
  ui?: Partial<Pick<AppState, 'theme' | 'themeMode' | 'syncSystemAccent' | 'acrylicMode' | 'sidebarCollapsed' | 'sortBy' | 'gridColumns' | 'serverPort'>> & {
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

const storedState = loadStoredState();
const storedUi = storedState.ui ?? {};
const storedApiConfig = storedState.apiConfig ?? {};
const storedTheme = storedUi.themePreferenceVersion === 2 ? storedUi.theme : undefined;
// themeMode 版本 3 起单独持久化；旧数据里只有 manual flag（=1 表示显式选过主题），
// 此时把当时的 theme 视为用户的显式选择，否则默认跟随系统。
const storedThemeMode = (mode: string | undefined, fallback: ThemeMode): ThemeMode =>
  (mode === 'system' || mode === 'light' || mode === 'dark') ? mode : fallback;
const legacyThemeMode: ThemeMode = typeof window !== 'undefined'
  && window.localStorage.getItem(THEME_MANUAL_FLAG) === '1'
  && (storedTheme === 'light' || storedTheme === 'dark')
  ? storedTheme
  : 'system';

const initialState: AppState = {
  currentView: 'home',
  theme: storedTheme ?? 'light',
  themeMode: storedThemeMode(storedUi.themeMode, legacyThemeMode),
  syncSystemAccent: storedUi.syncSystemAccent ?? true,
  acrylicMode: storedUi.acrylicMode ?? false,
  sidebarCollapsed: storedUi.sidebarCollapsed ?? false,
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
  systemPromptPresets: (storedState.systemPromptPresets ?? [])
    .filter((preset) => preset.prompt.trim().length > 0)
    .map((preset) => ({
      ...preset,
      title: preset.title.trim() || '未命名提示词',
      updatedAt: Number(preset.updatedAt || Date.now()),
    })),
  usageByModel: storedState.usageByModel ?? {},
  modelLaunchMemories: Object.fromEntries(
    Object.entries(storedState.modelLaunchMemories ?? {}).map(([modelId, memory]) => [
      modelId,
      { ...memory, config: normalizeLoadConfig(memory.config) },
    ])
  ),
  recentModelUsage: Object.fromEntries(
    Object.entries(storedState.recentModelUsage ?? {})
      .filter(([, usedAt]) => Number.isFinite(Number(usedAt)))
      .map(([modelId, usedAt]) => [modelId, Number(usedAt)] as const)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
  ),
  chatSessions: sanitizeStoredSessions(storedState.chatSessions ?? {}),
  activeChatSessionIds: storedState.activeChatSessionIds ?? {},
};

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeLoadConfig(config: ModelLoadConfig | (Partial<ModelLoadConfig> & { kvQuant?: string })): ModelLoadConfig {
  const migratedCtxLength = config.ctxLength === 327689 ? RECOMMENDED_CTX_LENGTH : config.ctxLength;
  const legacyKvQuant = 'kvQuant' in config && typeof config.kvQuant === 'string' ? config.kvQuant : 'f16';
  return {
    ctxLength: Math.max(1, Number(migratedCtxLength ?? RECOMMENDED_CTX_LENGTH)),
    gpuLayers: Math.max(0, Number(config.gpuLayers ?? 0)),
    batchSize: Math.max(1, Number(config.batchSize ?? 512)),
    physicalBatchSize: Math.max(1, Number(config.physicalBatchSize ?? 512)),
    threads: Math.round(Number(config.threads ?? -1)),
    parallel: Math.round(Number(config.parallel ?? -1)),
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
    ropeFreqBase: Math.max(0, Number(config.ropeFreqBase ?? 0)),
    ropeFreqScaleEnabled: config.ropeFreqScaleEnabled ?? false,
    ropeFreqScale: Math.max(0, Number(config.ropeFreqScale ?? 0)),
    seedEnabled: config.seedEnabled ?? false,
    seed: Math.round(Number(config.seed ?? -1)),
    speculativeDecoding: (() => {
      const mode = config.speculativeDecoding as ModelLoadConfig['speculativeDecoding'];
      return mode === 'mtp' || mode === 'dspark' || mode === 'dflash' ? mode : 'off';
    })(),
    specDraftNMaxEnabled: config.specDraftNMaxEnabled ?? false,
    specDraftNMax: Math.min(16, Math.max(1, Math.round(Number(config.specDraftNMax ?? 4)))),
    chatTemplate: config.chatTemplate ?? '',
    rememberSettings: config.rememberSettings ?? true,
    showAdvancedSettings: config.showAdvancedSettings ?? false,
    idleAutoUnload: config.idleAutoUnload ?? false,
    idleAutoUnloadMinutes: Math.max(1, Math.round(Number(config.idleAutoUnloadMinutes ?? 15))),
    moeCpuLayers: Math.max(0, Number(config.moeCpuLayers ?? 0)),
    reasoningBudget: Math.max(0, Math.round(Number(config.reasoningBudget ?? 0))),
  };
}

function averageTokensPerSec(usage?: ModelUsageStats) {
  if (!usage || usage.responseCount <= 0 || usage.totalTokensPerSec <= 0) return undefined;
  return usage.totalTokensPerSec / usage.responseCount;
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
    const storedLoadConfig = storedState.modelLoadConfigs?.[model.id];
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

function titleFromFirstUserMessage(message: Message) {
  if (message.role !== 'user') return null;
  const title = message.content.trim().replace(/\s+/g, ' ').slice(0, 24);
  return title || null;
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

function appReducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_VIEW':
      return { ...state, currentView: action.payload };
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
    case 'TOGGLE_SIDEBAR':
      return { ...state, sidebarCollapsed: !state.sidebarCollapsed };
    case 'SET_SORT':
      return { ...state, sortBy: action.payload };
    case 'SET_GRID_COLUMNS':
      return { ...state, gridColumns: action.payload };
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
        } : m),
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
      return { ...state, models: mergeModels(state.models, action.payload) };
    case 'PRUNE_USAGE': {
      const keepIds = new Set(action.payload);
      const nextUsageByModel = Object.fromEntries(
        Object.entries(state.usageByModel).filter(([modelId]) => keepIds.has(modelId) || modelId.startsWith('api-')),
      );
      return { ...state, usageByModel: nextUsageByModel };
    }
    case 'SET_BACKEND_AVAILABLE':
      return { ...state, backendAvailable: action.payload };
    case 'SET_SERVER_RUNNING':
      return { ...state, serverRunning: action.payload };
    case 'SET_SERVER_PORT':
      return { ...state, serverPort: action.payload };
    case 'SET_API_CONFIG':
      return { ...state, apiConfig: { ...state.apiConfig, ...action.payload } };
    case 'SET_MODEL_DIRS':
      return { ...state, modelDirs: action.payload };
    case 'SET_CLOSE_TO_TRAY':
      return { ...state, closeToTray: action.payload };
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
    default:
      return state;
  }
}

interface AppContextType { state: AppState; dispatch: React.Dispatch<Action>; }

const AppContext = createContext<AppContextType | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, baseDispatch] = useReducer(appReducer, initialState);

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
  }, []);

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
        const modelId = state.activeModelId;
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
  }, [state.activeModelId]);

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
        chatSessions: sanitizeStoredSessions(state.chatSessions),
        activeChatSessionIds: state.activeChatSessionIds,
        modelLoadConfigs,
        modelLaunchMemories: state.modelLaunchMemories,
        recentModelUsage: state.recentModelUsage,
        modelThemeColors,
        modelThemeGroups,
        modelApiNames,
        modelCustomLogos,
        ui: {
          theme: state.theme,
          themePreferenceVersion: 3,
          themeMode: state.themeMode,
          syncSystemAccent: state.syncSystemAccent,
          acrylicMode: state.acrylicMode,
          sidebarCollapsed: state.sidebarCollapsed,
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
    state.chatSessions,
    state.gridColumns,
    state.models,
    state.modelLaunchMemories,
    state.recentModelUsage,
    state.systemPromptPresets,
    state.serverPort,
    state.sidebarCollapsed,
    state.sortBy,
    state.theme,
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
