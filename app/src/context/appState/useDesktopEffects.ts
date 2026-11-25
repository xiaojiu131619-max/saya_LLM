import { useEffect, useRef } from 'react';
import type { Dispatch } from 'react';
import type { Action } from './appActions';
import type { AppState, McpServerStatus } from '@/types';
import {
  checkDesktopEngine,
  connectMcpServer,
  createExternalApiKey,
  getApiTokenUsage,
  getDesktopConfig,
  getDesktopServerStatus,
  getExternalApiKeyForSession,
  getExternalApiKeyStatus,
  getServerApiKey,
  isDesktopRuntime,
  listenDesktopEvent,
  listMcpServers,
  scanDesktopModels,
  stopDesktopServer,
  toFrontendModel,
} from '@/lib/desktop';
import { STORAGE_KEY, storedApiConfig } from './appStorage';
import { hasStreamingMessage } from './appReducer';

/**
 * 桌面运行时的全部集成副作用：
 * 启动 hydrate（配置 / 模型扫描 / MCP 自动连接）、空闲自动卸载、
 * server 事件监听、API token 用量轮询。
 * 依赖顺序与原 AppProvider 中的 effect 顺序一致，勿乱调。
 */
export function useDesktopEffects(
  state: AppState,
  stateRef: { current: AppState },
  dispatch: Dispatch<Action>,
) {
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
  }, [state.activeModelId, stateRef, dispatch]);

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
}
