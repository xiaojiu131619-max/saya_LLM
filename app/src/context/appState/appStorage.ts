import type {
  AppState,
  ChatEngineId,
  ChatGenerationConfig,
  ChatScope,
  ChatSession,
  ExternalApiConfig,
  Message,
  ModelInfo,
  ModelLoadConfig,
  ModelLaunchMemory,
  ModelUsageStats,
  SystemPromptPreset,
  ThemeMode,
} from '@/types';
import { RECOMMENDED_CTX_LENGTH, maxGpuLayers } from '@/lib/modelDefaults';

/**
 * 应用状态的 localStorage 持久层：读写、清洗、旧数据迁移。
 *
 * 这个模块在首次 import 时就会读一次 localStorage（模块级单例 `storedState`），
 * 并执行一次性迁移的落标（GPU 卸载上限版本号）。初始化阶段必须防御一切坏数据：
 * 隐私模式、配额异常、手动篡改都会在这里抛错——任何未捕获异常都会让整个应用
 * 白屏且无法自愈。
 */

export const THEME_MANUAL_FLAG = 'agent-llm-theme-manual';

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

export const STORAGE_KEY = 'agent-llm-local-state-v1';

/** 持久化失败（如 localStorage 配额写满）时广播的全局事件；StorageWarningBanner 监听。 */
export const STORAGE_WARNING_EVENT = 'agent-llm:storage-warning';

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

export interface StoredAppState {
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

export function loadStoredState(): StoredAppState {
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
 * 从本地快照中删除「各模型加载预设 / 快速启动记忆」。
 *
 * 重置应用配置后 config.json 已恢复默认、模型目录被清空，但这部分数据只存在
 * localStorage；若只是刷新页面，落盘时还会从内存里的模型列表把旧参数重新拼回来，
 * 与文案「清空各模型的预设参数与调参历史」不符。这里先删掉快照中的旧值，
 * 配合 RESET_MODEL_PREFERENCES 清空内存态，下一次落盘才是干净的。
 *
 * 返回是否真的改写了快照（隐私模式 / 配额异常时为 false，调用方无需报错）。
 */
export function forgetStoredModelPreferences(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const stored = parsed as StoredAppState;
    if (!('modelLoadConfigs' in stored) && !('modelLaunchMemories' in stored)) return false;
    delete stored.modelLoadConfigs;
    delete stored.modelLaunchMemories;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    return true;
  } catch {
    return false;
  }
}

/**
 * 旧状态里的对话后端只保留三档合法值；不在三档内的值统一归一为 `main`，
 * 避免旧 localStorage 把失效的字符串带进新类型。
 */
export function normalizeStoredChatEngine(value: unknown): ChatEngineId {
  return value === 'fast27b' || value === 'strata' ? value : 'main';
}

export function storedChatScope(stored: StoredAppState): ChatScope {
  return stored.chatScope === 'pi' ? 'pi' : 'main';
}

export function sanitizeStoredSessions(sessionsByModel: Record<string, ChatSession[]>) {
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
export function stripPersistedMedia(sessionsByModel: Record<string, ChatSession[]>) {
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

export function titleFromFirstUserMessage(message: Message) {
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
export function refreshLegacyAutoTitles(sessionsByModel: Record<string, ChatSession[]>) {
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

// ---- 模块级单例：整个应用生命周期只读一次 localStorage ----

export const storedState = loadStoredState();
export const storedUi = storedState.ui ?? {};
export const storedApiConfig = storedState.apiConfig ?? {};

/**
 * 主题持久化版本门控。
 *
 * themeMode 从版本 3 起单独持久化（版本 2 及更早只有 theme + manual flag）。
 * 这里必须与落盘处写的版本号保持一致：曾经读 `=== 2` 而写 `3`，导致用户选的
 * 主题永远读不回来——界面按默认「跟随系统」显示，设置页却写着用户选过的档位。
 * 现在接受「>= 2」：版本 2 是初始提交写入的格式（theme + manual flag），
 * 它的 theme 值同样是用户显式选择，只有 themeMode 需要从 legacy flag 推导。
 */
export const THEME_PREFERENCE_VERSION = 3;
const storedThemeVersion = Number(storedUi.themePreferenceVersion ?? 0);
export const storedTheme = storedThemeVersion >= 2
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

export const needsGpuLayersCeilingMigration = readGpuLayersCeilingVersion() < GPU_LAYERS_CEILING_VERSION;

if (needsGpuLayersCeilingMigration && typeof window !== 'undefined') {
  try {
    window.localStorage.setItem(GPU_LAYERS_CEILING_KEY, String(GPU_LAYERS_CEILING_VERSION));
  } catch {
    // best-effort：写不进标记也不会影响本次迁移结果。
  }
}

export function storedLoadConfigFor(model: ModelInfo): ModelLoadConfig | undefined {
  const stored = storedState.modelLoadConfigs?.[model.id];
  if (!stored) return undefined;
  return needsGpuLayersCeilingMigration
    ? migrateGpuLayersToCeiling(model.blockCount, stored)
    : stored;
}

// themeMode 版本 3 起单独持久化；旧数据里只有 manual flag（=1 表示显式选过主题），
// 此时把当时的 theme 视为用户的显式选择，否则默认跟随系统。
export const storedThemeMode = (mode: string | undefined, fallback: ThemeMode): ThemeMode =>
  (mode === 'system' || mode === 'light' || mode === 'dark') ? mode : fallback;
export const legacyThemeMode: ThemeMode = readStoredFlag(THEME_MANUAL_FLAG) === '1'
  && (storedTheme === 'light' || storedTheme === 'dark')
  ? storedTheme
  : 'system';

/** 只接受字面量对象，数组 / 字符串 / null 一律当空表，避免后续遍历时炸。 */
export function asRecord<T>(value: unknown): Record<string, T> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, T>;
}

/** 提示词预设：整体可能不是数组，单项也可能缺 id / title / prompt。 */
export function sanitizeStoredPresets(value: unknown): SystemPromptPreset[] {
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
export function sanitizeLaunchMemories(value: unknown): Record<string, ModelLaunchMemory> {
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
export function sanitizeActiveSessions(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [modelId, sessionId] of Object.entries(asRecord<unknown>(value))) {
    if (typeof sessionId === 'string') result[modelId] = sessionId;
  }
  return result;
}

/**
 * 取有限数值：`Number('bad')` / `Number(Infinity)` 会得到 NaN / Infinity，
 * 直接进 `Math.max` 仍是 NaN，最终被序列化进模型加载参数，报错点离数据源很远。
 * 非法值统一回落 fallback，再按 [min, max] 收口。
 */
export function finiteNumber(
  value: unknown,
  fallback: number,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

export function normalizeLoadConfig(config: ModelLoadConfig | (Partial<ModelLoadConfig> & { kvQuant?: string })): ModelLoadConfig {
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
    // 旧存档没有这个字段：按「不降级」处理，避免升级后仍在静默改写用户参数。
    retryCpuFallback: config.retryCpuFallback ?? false,
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
    nCpuFfn: Math.round(finiteNumber(config.nCpuFfn ?? 0, 0, 0)),
    moeCacheMib: Math.round(finiteNumber(config.moeCacheMib ?? 0, 0, 0)),
    lazyMode: (() => {
      const mode = config.lazyMode as ModelLoadConfig['lazyMode'];
      return mode === 'on' || mode === 'off' ? mode : 'auto';
    })(),
    swaFull: config.swaFull ?? false,
    kvUnifiedPerSlotEnabled: config.kvUnifiedPerSlotEnabled ?? false,
    kvUnifiedPerSlot: Math.round(finiteNumber(config.kvUnifiedPerSlot ?? 8192, 8192, 0)),
    cacheRamEnabled: config.cacheRamEnabled ?? false,
    cacheRamMb: Math.round(finiteNumber(config.cacheRamMb ?? 8192, 8192, -1)),
    specDraftNubatch: Math.round(finiteNumber(config.specDraftNubatch ?? 0, 0, 0)),
    mmprojOffload: config.mmprojOffload ?? true,
    reasoningBudget: Math.round(finiteNumber(config.reasoningBudget ?? 0, 0, 0)),
  };
}

/**
 * 一次性迁移：旧版把所有模型的「拉满」档位存成 block_count，而内核的满档是
 * block_count + 1——差这一层会让它留在 CPU，GPU 计算图被迫与 CPU 往返同步，
 * 生成速度成倍下降（27B 三值量化实测 8.6 → 57.9 t/s）。
 * 恰好等于 block_count 的存量值来自旧上限而非用户手选（旧滑块最大就是它），
 * 因此抬到新的满档值；其它值一律保持不动，不覆盖用户的选择。
 */
export function migrateGpuLayersToCeiling(
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
export function migrateLaunchMemoryGpuLayers(
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
