import { useEffect, useRef } from 'react';
import type { AppState } from '@/types';
import { getModelThemeGroup } from '@/lib/modelTheme';
import {
  STORAGE_KEY,
  STORAGE_WARNING_EVENT,
  THEME_PREFERENCE_VERSION,
  loadStoredState,
  sanitizeStoredSessions,
  stripPersistedMedia,
  type StoredAppState,
} from './appStorage';
import { appStatePersistenceSuspended } from './persistenceControl';

/**
 * 全局状态的 localStorage 持久化（防抖 600ms + 页面隐藏/卸载时立即落盘）。
 * 拆自 AppProvider：只依赖 state，与桌面运行时无关。
 */
export function usePersistState(state: AppState) {
  // H1: 把"构建快照 + JSON.stringify + 同步写 localStorage"集中到一个 ref 函数，
  // 流式输出时每个 token 都会改写 chatSessions，若每次都全量序列化+写盘会严重阻塞主线程。
  // 这里用防抖（600ms）合并高频写入，并在页面隐藏/卸载时立即落盘，避免丢数据。
  const persistRef = useRef<() => void>(() => {});
  const persistTimerRef = useRef<number | null>(null);

  // 每次渲染后刷新落盘函数，使其始终捕获最新 state（在 render 期间赋值 ref 不被允许）。
  useEffect(() => {
    persistRef.current = () => {
      if (typeof window === 'undefined') return;
      // 出厂重置已删除本地快照：此时任何写盘都会把内存里的旧状态原样写回去，
      // 必须在拼装快照之前拦下（防抖、visibilitychange、beforeunload 共用这里）。
      if (appStatePersistenceSuspended()) return;

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
        // 配额写满不能静默吞掉：聊天历史是本地 AI 客户端的核心资产。先做一次
        // 无损降级——丢掉可再生的用量统计再试；仍失败就广播全局警告条，
        // 明确告诉用户这次没有存进去，而不是让数据无声消失。
        try {
          const degraded: StoredAppState = { ...next, usageByModel: {}, recentModelUsage: {} };
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(degraded));
          window.dispatchEvent(new CustomEvent<string>(STORAGE_WARNING_EVENT, {
            detail: '本地存储已写满，本次已跳过用量统计的保存。请清理或导出旧会话，否则新的聊天记录可能无法保存。',
          }));
        } catch {
          window.dispatchEvent(new CustomEvent<string>(STORAGE_WARNING_EVENT, {
            detail: '本地存储已写满，本次聊天记录与设置未能保存。请导出重要会话，并清理旧会话后重试。',
          }));
        }
      }
    };
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // 已暂停落盘时不再排定时器：状态清理会持续触发 effect，没必要反复取消/重建。
    if (appStatePersistenceSuspended()) return;

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
}
