import type {
  AgentTabId,
  ChatEngineId,
  ChatGenerationConfig,
  ChatScope,
  ChatSession,
  ExternalApiConfig,
  GridColumnType,
  McpServerEntry,
  McpServerStatus,
  Message,
  ModelInfo,
  ModelLoadConfig,
  PiFileChange,
  PiStep,
  SortType,
  SystemStats,
  ThemeMode,
  ThemeType,
  ToolActivity,
  ViewType,
  WebUiEngineId,
  WorkspaceMode,
} from '@/types';
import type { AutoTuneAuthorization } from '@/lib/autoTuneTask';
import type { AutoTuneResult } from '@/lib/ipc/model';

export type Action =
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
  /**
   * 出厂重置：清空全部只存在前端的用户数据（会话、统计、提示词预设、
   * 对话生成配置、模型快速启动记忆与界面偏好）。后端 config.json 与凭据
   * 由桌面命令处理；AppProvider 会在派发时暂停落盘并删除本地快照，
   * 防止刷新前的 beforeunload 把旧状态写回去。
   */
  | { type: 'RESET_ALL' }
  /**
   * 重置应用配置时的前端部分：清空各模型的加载预设与快速启动记忆。
   * 对话记录、使用统计与界面偏好不受影响（界面偏好走 RESET_UI_PREFS）。
   */
  | { type: 'RESET_MODEL_PREFERENCES' }
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
  | { type: 'RESTORE_CHAT_SESSIONS'; payload: { sessions: ChatSession[] } }
  | { type: 'RENAME_CHAT_SESSION'; payload: { modelId: string; sessionId: string; title: string } }
  | { type: 'ADD_MESSAGE'; payload: { modelId: string; sessionId: string; message: Message } }
  | { type: 'UPDATE_MESSAGE'; payload: { modelId: string; sessionId: string; messageId: string; content?: string; reasoningContent?: string; toolActivity?: ToolActivity[]; warnings?: string[]; piSteps?: PiStep[]; piChanges?: PiFileChange[]; piChangesRolledBack?: boolean; piTurnId?: string; piState?: Message['piState']; artifacts?: Message['artifacts']; stats?: Message['stats'] } }
  | { type: 'SET_CHAT_SESSION_PI_ID'; payload: { modelId: string; sessionId: string; piSessionId: string } }
  | { type: 'SET_CHAT_SESSION_WORKSPACE'; payload: { modelId: string; sessionId: string; workspaceId: string } }
  | { type: 'SET_MESSAGE_STREAMING'; payload: { modelId: string; sessionId: string; messageId: string; streaming: boolean; stats?: Message['stats'] } }
  | { type: 'REPLACE_MESSAGE_AND_TRUNCATE_AFTER'; payload: { modelId: string; sessionId: string; messageId: string; message: Message } }
  | { type: 'REPLACE_MESSAGE'; payload: { modelId: string; sessionId: string; messageId: string; message: Message } }
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
       * 引擎的请求记录是「最近 24 小时的全量快照」，reducer 会把快照按天
       * 增量合并进历史累计：日期桶保留历史最大值，累计总量只增不减，
       * 避免窗口滚动时年度热力图与累计消耗一起缩水。按天分桶沿用主模型的
       * 本地日期口径。
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
