import type { AppState, ModelUsageStats, SystemPromptPreset, ThemeType, ViewType, ChatSession } from '@/types';
import { activateMainModel, clearMainLoadedModels } from '@/lib/modelState';
import { canApplyAutoTune, tuneRecordPatch } from '@/lib/autoTuneTask';
import { normalizeFontScale } from '@/lib/uiScale';
import { getModelThemeGroup } from '@/lib/modelTheme';
import { dayKey } from '@/lib/usageHeatmap';
import type { Action } from './appActions';
import {
  SIDEBAR_DEFAULT_WIDTH,
  migrateLaunchMemoryGpuLayers,
  needsGpuLayersCeilingMigration,
  normalizeLoadConfig,
  titleFromFirstUserMessage,
} from './appStorage';
import { mergeModels, DEFAULT_CHAT_CONFIG } from './appDefaults';

function updateSessionList(
  sessions: ChatSession[],
  sessionId: string,
  updater: (session: ChatSession) => ChatSession
) {
  return sessions.map((session) => session.id === sessionId ? updater(session) : session);
}

export function hasStreamingMessage(sessionsByModel: Record<string, ChatSession[]>) {
  return Object.values(sessionsByModel).some((sessions) =>
    sessions.some((session) => session.messages.some((message) => message.isStreaming))
  );
}

/** 每日用量按**本地日期**分桶：`toISOString()` 是 UTC，在 UTC+8 的 00:00–08:00
    会落到前一天，热力图与每日统计整体错位一天。复用 usageHeatmap 的口径。 */
function todayKey() {
  return dayKey(new Date());
}

/** 设置中心里的分页：这些视图属于设置界面，不属于 Agent 工作区。 */
const SETTINGS_VIEWS: ViewType[] = ['settings', 'kernel', 'usage', 'tools', 'skills', 'data', 'webui', 'pet', 'device'];

/** 界面偏好回到出厂值；RESET_UI_PREFS 与出厂重置共用同一份口径。 */
function resetUiPreferences(): Pick<AppState,
  'themeMode' | 'theme' | 'syncSystemAccent' | 'acrylicMode' | 'reduceMotion' | 'fontScale'
  | 'enterToSend' | 'sidebarCollapsed' | 'sidebarWidth' | 'sortBy' | 'gridColumns'> {
  const prefersDark = typeof window !== 'undefined' && Boolean(window.matchMedia)
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme: ThemeType = prefersDark ? 'dark' : 'light';
  return {
    themeMode: 'system',
    theme,
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
}

export function appReducer(state: AppState, action: Action): AppState {
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
      return { ...state, ...resetUiPreferences() };
    case 'RESET_ALL':
      // 出厂重置：清空全部只存在前端的用户数据，让内存态与「已删除本地快照」
      // 保持一致。落盘由 AppProvider 的 dispatch 包装层暂停并删除快照，
      // 否则刷新前的 beforeunload 会把下面这些内存态重新写回去。
      // 后端 config.json、模型目录与 API Key 由桌面命令负责，不在这里处理。
      return {
        ...state,
        chatSessions: {},
        activeChatSessionIds: {},
        usageByModel: {},
        recentModelUsage: {},
        chatConfig: { ...DEFAULT_CHAT_CONFIG },
        systemPromptPresets: [],
        modelLaunchMemories: {},
        autoTuneApplication: undefined,
        ...resetUiPreferences(),
      };
    case 'RESET_MODEL_PREFERENCES':
      // 重置应用配置：清空各模型的加载预设与快速启动记忆。
      // 模型列表同步清空——重置会连模型目录一起清掉，下次扫描前不应再展示旧模型；
      // 也让落盘时无法从 model.loadConfig 重新拼回旧参数（旧值另由
      // forgetStoredModelPreferences 从本地快照里删除）。
      return {
        ...state,
        models: [],
        modelLaunchMemories: {},
        autoTuneApplication: undefined,
        activeModelId: null,
        selectedModelId: null,
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
    case 'RESTORE_CHAT_SESSIONS': {
      // 撤销删除：按会话归属的 modelId 放回原桶，并按最近使用顺序重新排序。
      // 只补回当前不存在的会话，重复撤销不会产生副本。
      const grouped = new Map<string, ChatSession[]>();
      for (const session of action.payload.sessions) {
        const list = grouped.get(session.modelId) ?? [];
        list.push(session);
        grouped.set(session.modelId, list);
      }
      const nextChatSessions = { ...state.chatSessions };
      const nextActive = { ...state.activeChatSessionIds };
      for (const [modelId, sessions] of grouped) {
        const existing = nextChatSessions[modelId] ?? [];
        const existingIds = new Set(existing.map((session) => session.id));
        nextChatSessions[modelId] = [...existing, ...sessions.filter((session) => !existingIds.has(session.id))]
          .sort((a, b) => b.updatedAt - a.updatedAt);
        // 桶里原本没有选中会话（刚删掉的就是最后一个）时，撤销后自动选中恢复的会话。
        if (!nextActive[modelId] && sessions[0]) nextActive[modelId] = sessions[0].id;
      }
      return { ...state, chatSessions: nextChatSessions, activeChatSessionIds: nextActive };
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
          ...(action.payload.piChanges !== undefined ? { piChanges: action.payload.piChanges } : {}),
          ...(action.payload.piChangesRolledBack !== undefined ? { piChangesRolledBack: action.payload.piChangesRolledBack } : {}),
          ...(action.payload.piTurnId !== undefined ? { piTurnId: action.payload.piTurnId } : {}),
          ...(action.payload.piState !== undefined ? { piState: action.payload.piState } : {}),
          ...(action.payload.artifacts !== undefined ? { artifacts: action.payload.artifacts } : {}),
          // Pi 收尾时把本轮性能指标写在 UPDATE_MESSAGE 上；漏掉这一行，
          // Pi 工作区的气泡永远只有「-- tok / --s TTFT」。
          ...(action.payload.stats !== undefined ? { stats: action.payload.stats } : {}),
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
    case 'SET_CHAT_SESSION_WORKSPACE': {
      const sessions = state.chatSessions[action.payload.modelId] || [];
      const nextSessions = updateSessionList(sessions, action.payload.sessionId, (session) => ({
        ...session,
        workspaceId: action.payload.workspaceId,
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
    case 'REPLACE_MESSAGE': {
      // 原位替换（不截断后续消息）：历史轮次重新生成时，该回答留在原位置，
      // 后续对话与上下文顺序保持不变。
      const sessions = state.chatSessions[action.payload.modelId] || [];
      const nextSessions = updateSessionList(sessions, action.payload.sessionId, (session) => {
        if (!session.messages.some((m) => m.id === action.payload.messageId)) return session;
        return {
          ...session,
          updatedAt: action.payload.message.timestamp,
          messages: session.messages.map((m) => m.id === action.payload.messageId ? action.payload.message : m),
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
    // 引擎后端：指标快照只覆盖最近 24 小时，直接覆盖会让更早的日期桶与累计
    // 总量随窗口滚动一起消失（年度热力图变空、累计消耗缩水）。改为增量合并：
    // 日期桶取历史最大值，总量按桶的增量累加；响应数与速度类指标没有逐日分桶，
    // 用上一次快照窗口的原始读数求新增量后累加，窗口滚动时只增不减。
    case 'SET_ENGINE_USAGE': {
      const {
        modelId, modelName, modelColor,
        promptTokens, completionTokens, totalTokens, responseCount,
        totalTokensPerSec, totalFirstTokenDelay, totalGenTime, dailyTokens, lastUsedAt,
      } = action.payload;
      // 没有任何 token 时不要凭空创建条目（引擎起来了但还没请求过）。
      if (totalTokens <= 0 && responseCount <= 0) return state;
      const prev = state.usageByModel[modelId];
      const mergedDaily: Record<string, number> = { ...(prev?.dailyTokens ?? {}) };
      for (const [day, tokens] of Object.entries(dailyTokens)) {
        mergedDaily[day] = Math.max(mergedDaily[day] ?? 0, tokens);
      }
      // 历史日期桶求和就是累计总量；旧条目缺分桶时至少不能比原值小。
      const total = Math.max(
        Object.values(mergedDaily).reduce((sum, tokens) => sum + tokens, 0),
        prev?.totalTokens ?? 0,
      );
      const added = Math.max(0, total - (prev?.totalTokens ?? 0));
      const snapshotTotal = promptTokens + completionTokens;
      const promptShare = snapshotTotal > 0 ? promptTokens / snapshotTotal : 0;
      const addedPrompt = Math.round(added * promptShare);
      // 响应数：优先用「本次窗口计数 − 上次窗口计数」的差值（没有请求过期时是精确的）。
      // 快照窗口滚动会让原始计数下降，差值不可信，此时用「新增 token ÷ 窗口内
      // 平均每条响应的 token」估算新增响应数，避免累计值卡在高水位不再增长。
      const prevWindowResponses = prev?.engineWindowResponses;
      let nextResponseCount: number;
      if (!prev) {
        nextResponseCount = responseCount;
      } else if (prevWindowResponses == null) {
        // 旧版本条目没有锚点：原值本身可能就是窗口读数，不能再把整窗加一遍。
        nextResponseCount = Math.max(prev.responseCount, responseCount);
      } else if (responseCount >= prevWindowResponses) {
        nextResponseCount = prev.responseCount + (responseCount - prevWindowResponses);
      } else {
        const averageResponseTokens = responseCount > 0 ? snapshotTotal / responseCount : 0;
        const estimatedAdded = averageResponseTokens > 0 ? Math.round(added / averageResponseTokens) : 0;
        nextResponseCount = prev.responseCount + estimatedAdded;
      }
      const addedResponses = Math.max(0, nextResponseCount - (prev?.responseCount ?? 0));
      // 速度 / 首字延迟 / 生成耗时按「新增响应数 × 当前窗口均值」累加：
      // 统计页用这些累计值除以 responseCount 求平均，不能只保留窗口读数。
      const addedMetric = (sum: number) => responseCount > 0 ? (sum * addedResponses) / responseCount : 0;
      const nextUsage: ModelUsageStats = {
        modelName,
        modelColor,
        promptTokens: (prev?.promptTokens ?? 0) + addedPrompt,
        completionTokens: (prev?.completionTokens ?? 0) + (added - addedPrompt),
        totalTokens: total,
        responseCount: nextResponseCount,
        totalTokensPerSec: (prev?.totalTokensPerSec ?? 0) + addedMetric(totalTokensPerSec),
        totalFirstTokenDelay: (prev?.totalFirstTokenDelay ?? 0) + addedMetric(totalFirstTokenDelay),
        totalGenTime: (prev?.totalGenTime ?? 0) + addedMetric(totalGenTime),
        lastUsedAt: Math.max(prev?.lastUsedAt ?? 0, lastUsedAt) || Date.now(),
        dailyTokens: mergedDaily,
        engineWindowResponses: responseCount,
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
