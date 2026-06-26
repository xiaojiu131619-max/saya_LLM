import { createContext, useContext, useEffect, useReducer, useRef, type ReactNode } from 'react';
import type { AppState, ViewType, ThemeType, SortType, GridColumnType, ModelInfo, Message, SystemStats, ModelLoadConfig, ChatGenerationConfig, ExternalApiConfig, ModelUsageStats, ChatSession, ModelLaunchMemory, SystemPromptPreset } from '@/types';
import {
  checkDesktopEngine,
  getDesktopConfig,
  getDesktopServerStatus,
  getExternalApiKeyForSession,
  getExternalApiKeyStatus,
  isDesktopRuntime,
  createExternalApiKey,
  scanDesktopModels,
  stopDesktopServer,
  toFrontendModel,
} from '@/lib/desktop';
import { DEFAULT_MAX_COMPLETION_TOKENS, RECOMMENDED_CTX_LENGTH } from '@/lib/modelDefaults';
import { getModelThemeGroup } from '@/lib/modelTheme';

type Action =
  | { type: 'SET_VIEW'; payload: ViewType }
  | { type: 'SET_THEME'; payload: ThemeType }
  | { type: 'TOGGLE_THEME' }
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
  | { type: 'SET_BACKEND_AVAILABLE'; payload: boolean }
  | { type: 'SET_SERVER_RUNNING'; payload: boolean }
  | { type: 'SET_SERVER_PORT'; payload: number }
  | { type: 'SET_API_CONFIG'; payload: Partial<ExternalApiConfig> }
  | { type: 'SET_MODEL_DIRS'; payload: string[] }
  | { type: 'SET_APP_STATUS'; payload: string | null }
  | { type: 'SET_CHAT_CONFIG'; payload: Partial<ChatGenerationConfig> }
  | { type: 'SAVE_SYSTEM_PROMPT_PRESET'; payload: { title: string; prompt: string } }
  | { type: 'DELETE_SYSTEM_PROMPT_PRESET'; payload: { presetId: string } }
  | { type: 'SET_MODEL_THEME_COLOR'; payload: { modelId: string; color: string } }
  | { type: 'SET_MODEL_GROUP_THEME_COLOR'; payload: { groupKey: string; color: string } }
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
  ui?: Partial<Pick<AppState, 'theme' | 'sidebarCollapsed' | 'sortBy' | 'gridColumns' | 'serverPort'>> & {
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

const initialState: AppState = {
  currentView: 'home',
  theme: storedTheme ?? 'light',
  sidebarCollapsed: storedUi.sidebarCollapsed ?? false,
  models: [],
  sortBy: storedUi.sortBy ?? 'default',
  gridColumns: storedUi.gridColumns ?? 2,
  activeModelId: null, selectedModelId: null,
  systemStats: initialSystemStats, searchQuery: '',
  backendAvailable: false, serverRunning: false, serverPort: storedUi.serverPort ?? 8080,
  apiConfig: {
    enabled: storedApiConfig.enabled ?? false,
    host: storedApiConfig.host ?? '0.0.0.0',
    hasApiKey: false,
  },
  modelDirs: [], appStatus: '启动桌面版并选择本地 GGUF 模型目录后才会显示真实数据。',
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
      .map(([modelId, usedAt]) => [modelId, Number(usedAt)])
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
    speculativeDecoding: 'off',
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
    return existing
      ? {
          ...model,
          status: existing.status,
          loadConfig: normalizeLoadConfig({ ...model.loadConfig, ...storedLoadConfig, ...existing.loadConfig }),
          themeColor: themeColorSolid ? `${themeColorSolid}55` : model.themeColor,
          themeColorSolid: themeColorSolid ?? model.themeColorSolid,
          avgTokensPerSec,
        }
      : {
          ...model,
          loadConfig: normalizeLoadConfig({ ...model.loadConfig, ...storedLoadConfig }),
          avgTokensPerSec,
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
    case 'TOGGLE_THEME':
      return { ...state, theme: state.theme === 'dark' ? 'light' : 'dark' };
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
      return {
        ...state,
        recentModelUsage: {
          ...state.recentModelUsage,
          [action.payload.modelId]: Date.now(),
        },
      };
    }
    case 'UPDATE_MODEL_STATUS': {
      return { ...state, models: state.models.map((m) => m.id === action.payload.modelId ? { ...m, status: action.payload.status } : m) };
    }
    case 'UPSERT_MODELS':
      return { ...state, models: mergeModels(state.models, action.payload) };
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
  const [state, dispatch] = useReducer(appReducer, initialState);

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

        if (config) {
          dispatch({ type: 'SET_MODEL_DIRS', payload: config.model_dirs });
          dispatch({ type: 'SET_SERVER_PORT', payload: config.default_port });
          dispatch({
            type: 'SET_API_CONFIG',
            payload: {
              enabled: config.api_enabled ?? false,
              host: config.api_enabled
                ? config.api_host || '0.0.0.0'
                : (config.api_host && config.api_host !== '127.0.0.1' ? config.api_host : storedApiConfig.host ?? '0.0.0.0'),
              hasApiKey: resolvedHasApiKey,
              apiKey: resolvedSessionApiKey,
            },
          });
        }
        dispatch({ type: 'SET_SERVER_RUNNING', payload: serverRunning });

        if (engineInfo && !engineInfo.binary_exists) {
          if (typeof window !== 'undefined') {
            window.sessionStorage.setItem('agent-llm-focus-kernel-update', '1');
          }
          dispatch({ type: 'SET_VIEW', payload: 'settings' });
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

        dispatch({ type: 'UPSERT_MODELS', payload: scanned.map(toFrontendModel) });
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
        ui: {
          theme: state.theme,
          themePreferenceVersion: 2,
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
