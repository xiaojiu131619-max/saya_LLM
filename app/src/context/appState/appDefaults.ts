import type { AppState, ChatGenerationConfig, ModelInfo, ModelUsageStats, SystemStats } from '@/types';
import { DEFAULT_MAX_COMPLETION_TOKENS } from '@/lib/modelDefaults';
import { normalizeFontScale } from '@/lib/uiScale';
import { getModelThemeGroup } from '@/lib/modelTheme';
import {
  asRecord,
  clampSidebarWidth,
  legacyThemeMode,
  normalizeLoadConfig,
  normalizeStoredChatEngine,
  refreshLegacyAutoTitles,
  sanitizeActiveSessions,
  sanitizeLaunchMemories,
  sanitizeStoredPresets,
  sanitizeStoredSessions,
  storedApiConfig,
  storedChatScope,
  storedLoadConfigFor,
  storedState,
  storedTheme,
  storedThemeMode,
  storedUi,
} from './appStorage';

export const initialSystemStats: SystemStats = {
  gpuUsage: 0, vramUsed: 0, vramTotal: 0, ramUsage: 0, ramTotal: 0,
  computeScores: Array.from({ length: 60 }, () => 0),
  gpuName: '未连接硬件监控', hostName: '未连接桌面运行环境',
};

/**
 * 对话生成的出厂默认值。
 * 首次启动与出厂重置共用同一份常量，避免两处各写一遍导致默认值漂移。
 */
export const DEFAULT_CHAT_CONFIG: ChatGenerationConfig = {
  temperature: 0.8,
  topP: 0.95,
  repeatPenalty: 1.1,
  maxTokens: DEFAULT_MAX_COMPLETION_TOKENS,
  systemPrompt: '',
  reasoningMode: 'auto',
  enabledTools: [],
};

/** 构建应用的初始状态：全部来自 localStorage 单例（见 appStorage），只跑一次。 */
export function createInitialState(): AppState {
  return {
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
      ...DEFAULT_CHAT_CONFIG,
      temperature: storedState.chatConfig?.temperature ?? DEFAULT_CHAT_CONFIG.temperature,
      topP: storedState.chatConfig?.topP ?? DEFAULT_CHAT_CONFIG.topP,
      repeatPenalty: storedState.chatConfig?.repeatPenalty ?? DEFAULT_CHAT_CONFIG.repeatPenalty,
      maxTokens: storedState.chatConfig?.maxTokens ?? DEFAULT_CHAT_CONFIG.maxTokens,
      systemPrompt: storedState.chatConfig?.systemPrompt ?? DEFAULT_CHAT_CONFIG.systemPrompt,
      reasoningMode: storedState.chatConfig?.reasoningMode ?? DEFAULT_CHAT_CONFIG.reasoningMode,
      enabledTools: Array.isArray(storedState.chatConfig?.enabledTools) ? storedState.chatConfig.enabledTools : DEFAULT_CHAT_CONFIG.enabledTools,
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
}

export function averageTokensPerSec(usage?: ModelUsageStats) {
  if (!usage || usage.responseCount <= 0 || usage.totalTokensPerSec <= 0) return undefined;
  return usage.totalTokensPerSec / usage.responseCount;
}

/** 扫描结果与现有列表合并：保留运行状态、落盘的加载配置与用户自定义外观。 */
export function mergeModels(current: ModelInfo[], incoming: ModelInfo[]) {
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
