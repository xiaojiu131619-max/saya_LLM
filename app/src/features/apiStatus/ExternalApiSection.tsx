import { useState, type ReactNode } from 'react';
import { Copy, Globe2, KeyRound } from 'lucide-react';
import { useEffect } from 'react';
import ToggleSwitch from '@/components/ToggleSwitch';
import { useApp } from '@/context/AppContext';
import {
  createExternalApiKey,
  deleteExternalApiKey,
  getLanIpAddress,
  isDesktopRuntime,
  saveDesktopRuntimeSettings,
} from '@/lib/desktop';
import { resolveApiName } from '@/lib/modelIdentity';

function clampPort(value: number) {
  if (!Number.isFinite(value)) return 8080;
  return Math.min(65535, Math.max(1, Math.round(value)));
}

function generateApiKey() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `allm-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function powerShellQuote(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

export default function ExternalApiSection({ embedded = false }: { embedded?: boolean }) {
  const { state, dispatch } = useApp();
  const [newApiKey, setNewApiKey] = useState<string | null>(null);
  const [lanIpAddress, setLanIpAddress] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getLanIpAddress()
      .then((address) => {
        if (!cancelled) setLanIpAddress(address);
      })
      .catch(() => {
        if (!cancelled) setLanIpAddress(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 复制目标：刚申请的 Key > 待生效的 Key > 当前会话保存的 Key。
  // 运行中的 llama-server 只认启动时的旧 Key（apiKey），新 Key 在重新加载模型后生效；
  // 软件内对话继续用旧 Key，因此两者分开存，互不影响。
  const storedApiKey = state.apiConfig.hasApiKey ? state.apiConfig.apiKey?.trim() || null : null;
  const pendingKey = state.apiConfig.pendingApiKey?.trim() || null;
  const configuredApiKey = newApiKey ?? pendingKey ?? storedApiKey;
  // 服务运行中且存在待生效的新 Key 时给出提示。
  const keyPendingApply = Boolean(state.serverRunning && (newApiKey || pendingKey));
  const clientHost = state.apiConfig.enabled
    ? lanIpAddress ?? '<本机局域网 IP>'
    : '127.0.0.1';
  const externalApiBaseUrl = `http://${clientHost}:${state.serverPort}/v1`;
  const chatCompletionsUrl = `${externalApiBaseUrl}/chat/completions`;

  const persistRuntimeSettings = async (port = state.serverPort, apiConfig = state.apiConfig) => {
    if (!isDesktopRuntime()) {
      setMessage('请在 Tauri 桌面版中保存 API 设置。');
      return;
    }

    try {
      await saveDesktopRuntimeSettings({
        defaultPort: clampPort(port),
        apiEnabled: apiConfig.enabled,
        apiHost: apiConfig.host || '0.0.0.0',
      });
      setMessage('API 设置已保存，下一次加载模型时生效。');
    } catch (error) {
      setMessage(`API 设置保存失败：${String(error)}`);
    }
  };

  const updateApiConfig = (patch: Partial<typeof state.apiConfig>, persist = false) => {
    const next = { ...state.apiConfig, ...patch };
    dispatch({ type: 'SET_API_CONFIG', payload: patch });
    if (persist) void persistRuntimeSettings(state.serverPort, next);
  };

  const handleApiEnabledChange = (enabled: boolean) => {
    // 监听地址不再单独配置：开启对外自动监听 0.0.0.0（局域网可访问），关闭则回落 127.0.0.1（仅本机）。
    const host = enabled ? '0.0.0.0' : '127.0.0.1';
    updateApiConfig({ enabled, host }, true);
  };

  const handlePortChange = (value: string) => {
    const next = Number(value);
    if (!Number.isFinite(next)) return;
    dispatch({ type: 'SET_SERVER_PORT', payload: clampPort(next) });
  };

  const handleGenerateApiKey = () => {
    const nextKey = generateApiKey();
    if (!isDesktopRuntime()) {
      setMessage('请在 Tauri 桌面版中申请 API Key。');
      return;
    }
    void createExternalApiKey(nextKey)
      .then(() => {
        setNewApiKey(nextKey);
        if (state.serverRunning) {
          // 运行中的服务只认启动时加载的旧 Key；新 Key 先挂到 pendingApiKey，
          // 软件内对话继续用旧 Key，重新加载模型后新 Key 转正。
          dispatch({ type: 'SET_API_CONFIG', payload: { hasApiKey: true, pendingApiKey: nextKey } });
          setMessage('新的 API Key 已生成并保存。运行中的 llama-server 仍在使用旧 Key（软件内对话不受影响）；重新加载模型后新 Key 生效。');
        } else {
          dispatch({ type: 'SET_API_CONFIG', payload: { hasApiKey: true, apiKey: nextKey, pendingApiKey: undefined } });
          setMessage('新的 API Key 已生成，下一次加载模型时生效。');
        }
        void persistRuntimeSettings(state.serverPort, { ...state.apiConfig, hasApiKey: true });
      })
      .catch((error) => {
        setMessage(`API Key 生成失败：${String(error)}`);
      });
  };

  const handleDeleteApiKey = () => {
    if (!isDesktopRuntime()) {
      setMessage('请在 Tauri 桌面版中撤销 API Key。');
      return;
    }
    void deleteExternalApiKey()
      .then(() => {
        setNewApiKey(null);
        if (state.serverRunning) {
          dispatch({ type: 'SET_API_CONFIG', payload: { hasApiKey: false, pendingApiKey: undefined } });
          setMessage('API Key 已撤销。当前 llama-server 仍要求旧 Key 鉴权，软件内对话不受影响。重新加载模型后外部访问将不再需要 Key。');
        } else {
          dispatch({ type: 'SET_API_CONFIG', payload: { hasApiKey: false, apiKey: undefined, pendingApiKey: undefined } });
          setMessage('API Key 已撤销。下一次加载模型时将不再要求外部请求鉴权。');
        }
        void persistRuntimeSettings(state.serverPort, { ...state.apiConfig, hasApiKey: false });
      })
      .catch((error) => {
        setMessage(`API Key 撤销失败：${String(error)}`);
      });
  };

  const handleCopyApiExample = async () => {
    if (state.apiConfig.enabled && !lanIpAddress) {
      setMessage('暂未识别到局域网 IP，请确认电脑已连接局域网后重试。');
      return;
    }
    const modelName = resolveApiName(state.models.find((model) => model.id === state.activeModelId));
    const payload = JSON.stringify({
      model: modelName,
      messages: [{ role: 'user', content: '你好' }],
      stream: false,
    });
    const auth = configuredApiKey
      ? ` -H ${powerShellQuote(`Authorization: Bearer ${configuredApiKey}`)}`
      : '';
    const command = `curl.exe ${powerShellQuote(chatCompletionsUrl)} -H ${powerShellQuote('Content-Type: application/json')}${auth} --data-raw ${powerShellQuote(payload)}`;
    await navigator.clipboard.writeText(command);
    setMessage(configuredApiKey
      ? '已复制包含当前 API Key 的 PowerShell 调用示例，请勿公开粘贴。'
      : '已复制 PowerShell 调用示例。当前配置未启用 API Key 鉴权。');
  };

  const handleCopyNewApiKey = async () => {
    if (!newApiKey) return;
    await navigator.clipboard.writeText(newApiKey);
    setMessage('已复制新的 API Key，请妥善保存。');
  };

  const handleCopyConfiguredApiKey = async () => {
    if (!configuredApiKey) return;
    await navigator.clipboard.writeText(configuredApiKey);
    setMessage('已复制 API Key，请只提供给受信任的客户端。');
  };

  return (
    <div className={embedded ? '' : 'flex h-full min-h-0 flex-col overflow-hidden bg-[var(--app-bg)] text-[var(--text-primary)] dark:bg-[var(--app-bg)] dark:text-[var(--text-primary)]'}>
      <div className={embedded ? '' : 'flex-1 overflow-y-auto px-6 py-6'}>
        <div className={embedded ? '' : 'mx-auto max-w-3xl'}>
          {!embedded && (
            <div className="mb-6">
              <h1 className="text-2xl font-bold text-primary-custom">对外 API</h1>
              <p className="mt-1 text-sm leading-6 text-secondary-custom">
                管理 OpenAI / Anthropic 兼容接口的监听范围、端口和 API Key。修改后请重新加载模型以生效。
              </p>
            </div>
          )}

          <div className={embedded ? 'space-y-4' : 'space-y-4 pb-12'}>
            <section>
              <div className="mb-3 flex items-center gap-2">
                <Globe2 className="h-4 w-4 text-[var(--accent)]" />
                <h2 className="text-sm font-semibold text-[var(--text-primary)] dark:text-[var(--text-primary)]">对外 API</h2>
              </div>
              <div className="divide-y divide-[var(--border-subtle)]">
              <ApiSettingRow
                label="释放 OpenAI / Anthropic 兼容 API"
                description={state.apiConfig.enabled ? `开启后局域网设备可访问，下一次加载模型时监听 0.0.0.0:${state.serverPort}` : '关闭时仅本机 127.0.0.1 可访问'}
              >
                <ToggleSwitch
                  checked={state.apiConfig.enabled}
                  onChange={handleApiEnabledChange}
                  label="释放 OpenAI / Anthropic 兼容 API"
                />
              </ApiSettingRow>
              <ApiSettingRow
                label="API 端口"
                description={state.serverRunning ? '修改后需要重新加载模型才会生效' : '用于 llama-server --port'}
              >
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={state.serverPort}
                  onChange={(event) => handlePortChange(event.target.value)}
                  onBlur={() => void persistRuntimeSettings()}
                  className="mono-font h-9 w-28 rounded-lg border border-[var(--border)] bg-[var(--app-bg)] px-3 text-right text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)] dark:border-white/[0.08] dark:bg-[var(--app-bg)] dark:text-[var(--text-primary)]"
                />
              </ApiSettingRow>
              <ApiSettingRow
                label="API Key"
                description={state.apiConfig.hasApiKey ? '已设置。软件内请求会自动使用，外部客户端需携带 Bearer Token。' : '未设置。软件内无需 Key；对外开放时建议生成 Key。'}
              >
                <div className="flex items-center gap-2">
                  {configuredApiKey && (
                    <button
                      onClick={() => void handleCopyConfiguredApiKey()}
                      className="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--app-bg)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[var(--text-secondary)]"
                      title="复制最新的 API Key"
                    >
                      <Copy className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    onClick={handleGenerateApiKey}
                    className="h-9 rounded-lg border border-[var(--border)] bg-[var(--app-bg)] px-3 text-sm font-semibold text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)] dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[var(--text-primary)] dark:hover:bg-white/[0.09]"
                  >
                    {state.apiConfig.hasApiKey ? '重新申请' : '生成'}
                  </button>
                  {state.apiConfig.hasApiKey && (
                    <button
                      onClick={handleDeleteApiKey}
                      className="h-9 rounded-lg border border-[var(--state-danger-border)] bg-[var(--state-danger-bg)] px-3 text-sm font-semibold text-[var(--state-danger)] transition-colors hover:bg-[var(--state-danger-border)] dark:border-[var(--state-danger-border)] dark:bg-[var(--surface-raised)] dark:text-[var(--state-danger)] dark:hover:bg-[var(--state-danger-bg)]"
                    >
                      撤销
                    </button>
                  )}
                </div>
              </ApiSettingRow>
              </div>
              {newApiKey && (
                <div className="mt-3 rounded-xl border border-[var(--accent-subtle)] bg-[var(--accent-subtle)] p-3 dark:border-[var(--accent)] dark:bg-[var(--accent-subtle)]">
                  <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-[var(--text-primary)] dark:text-[var(--text-primary)]">
                    <KeyRound className="h-3.5 w-3.5 text-[var(--accent)]" />
                    新 API Key
                  </div>
                  <div className="flex min-w-0 items-center gap-2">
                    <code className="mono-font min-w-0 flex-1 truncate rounded-lg border border-[var(--accent-subtle)] bg-[var(--app-bg)] px-3 py-2 text-xs text-[var(--text-primary)] dark:border-white/[0.08] dark:bg-black/20 dark:text-[var(--text-primary)]">
                      {newApiKey}
                    </code>
                    <button
                      onClick={() => void handleCopyNewApiKey()}
                      className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-[var(--accent-subtle)] bg-[var(--app-bg)] text-[var(--accent)] hover:bg-[var(--accent-subtle)] dark:border-white/[0.08] dark:bg-white/[0.06] dark:text-[var(--accent)]"
                      title="复制 API Key"
                    >
                      <Copy className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => setNewApiKey(null)}
                      className="px-3 py-2 text-xs text-secondary-custom hover:text-primary-custom"
                    >
                      隐藏
                    </button>
                  </div>
                  {keyPendingApply && (
                    <p className="mt-2 text-[11px] leading-4 text-[var(--state-warning)] dark:text-[var(--accent)]">
                      运行中的服务仍在使用旧 Key，上面的复制按钮随时可用；重新加载模型后新 Key 自动生效。
                    </p>
                  )}
                </div>
              )}
              <div className="mt-3 border-t border-[var(--border-subtle)] pt-3">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">OpenAI 接口根地址（Base URL）</div>
                    <div className="mono-font truncate text-xs text-[var(--text-primary)] dark:text-[var(--text-primary)]">{externalApiBaseUrl}</div>
                  </div>
                  <button
                    onClick={() => void handleCopyApiExample()}
                    className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)] dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[var(--text-secondary)] dark:hover:bg-white/[0.09]"
                    title="复制 PowerShell curl 示例"
                  >
                    <Copy className="h-4 w-4" />
                  </button>
                </div>
                <p className="text-[11px] leading-relaxed text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">
                  软件内本机模式不启用鉴权。开启对外访问后，外部客户端使用上方局域网地址；如已设置 API Key，需携带 Bearer Token。防火墙需要放行端口，修改设置后请重新加载模型。
                </p>
              </div>
            </section>

            {message && <p className="text-xs text-secondary-custom">{message}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

function ApiSettingRow({ label, description, children }: { label: string; description?: string; children: ReactNode }) {
  return (
    <div className="grid gap-3 py-3 md:grid-cols-[minmax(220px,1fr)_auto] md:items-center">
      <div className="min-w-0">
        <div className="text-sm font-medium text-[var(--text-primary)] dark:text-[var(--text-primary)]">{label}</div>
        {description && <div className="mt-0.5 text-xs leading-5 text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">{description}</div>}
      </div>
      <div className="flex min-w-0 justify-start md:justify-end">{children}</div>
    </div>
  );
}
