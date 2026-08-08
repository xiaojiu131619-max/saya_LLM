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

  const configuredApiKey = newApiKey
    ?? (state.apiConfig.hasApiKey ? state.apiConfig.apiKey?.trim() || null : null);
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
    const host = enabled && (!state.apiConfig.host || state.apiConfig.host === '127.0.0.1')
      ? '0.0.0.0'
      : state.apiConfig.host || '0.0.0.0';
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
          dispatch({ type: 'SET_API_CONFIG', payload: { hasApiKey: true } });
          setMessage('新的 API Key 已生成。当前 llama-server 仍使用旧 Key，软件内对话不受影响；重新加载模型后新 Key 对外生效。');
        } else {
          dispatch({ type: 'SET_API_CONFIG', payload: { hasApiKey: true, apiKey: nextKey } });
          setMessage('新的 API Key 已生成，下一次加载模型时生效。');
        }
        void persistRuntimeSettings(state.serverPort, { ...state.apiConfig, hasApiKey: true, apiKey: nextKey });
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
          dispatch({ type: 'SET_API_CONFIG', payload: { hasApiKey: false } });
          setMessage('API Key 已撤销。当前 llama-server 仍要求旧 Key 鉴权，软件内对话不受影响。重新加载模型后外部访问将不再需要 Key。');
        } else {
          dispatch({ type: 'SET_API_CONFIG', payload: { hasApiKey: false, apiKey: undefined } });
          setMessage('API Key 已撤销。下一次加载模型时将不再要求外部请求鉴权。');
        }
        void persistRuntimeSettings(state.serverPort, { ...state.apiConfig, hasApiKey: false, apiKey: undefined });
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
    const modelName = state.models.find((model) => model.id === state.activeModelId)?.name ?? 'local-model';
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
    <div className={embedded ? '' : 'flex h-full min-h-0 flex-col overflow-hidden bg-[#FBFAF6] text-[#2F2C26] dark:bg-[#141720] dark:text-[#E2E8F2]'}>
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
            <section className="rounded-xl border border-[#E1DCD0] bg-[#FAF9F5] p-4 dark:border-white/[0.08] dark:bg-white/[0.04]">
              <div className="mb-3 flex items-center gap-2">
                <Globe2 className="h-4 w-4 text-[#D7663E]" />
                <h2 className="text-sm font-semibold text-[#403C32] dark:text-[#E2E8F2]">对外 API</h2>
              </div>
              <div className="divide-y divide-[#E6E0D5] dark:divide-white/[0.06]">
              <ApiSettingRow
                label="释放 OpenAI / Anthropic 兼容 API"
                description={state.apiConfig.enabled ? `下一次加载模型时监听 ${state.apiConfig.host || '0.0.0.0'}:${state.serverPort}` : '关闭时仅本机 127.0.0.1 可访问'}
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
                  className="mono-font h-9 w-28 rounded-lg border border-[#DCD8CF] bg-[#FBFAF6] px-3 text-right text-sm text-[#403C32] outline-none transition-colors focus:border-[#D7663E] dark:border-white/[0.08] dark:bg-[#141720] dark:text-[#E2E8F2]"
                />
              </ApiSettingRow>
              <ApiSettingRow
                label="监听地址"
                description="0.0.0.0 表示允许局域网访问；127.0.0.1 表示仅本机访问"
              >
                <select
                  value={state.apiConfig.host}
                  onChange={(event) => updateApiConfig({ host: event.target.value }, true)}
                  className="h-9 w-36 rounded-lg border border-[#DCD8CF] bg-[#FBFAF6] px-3 text-sm text-[#403C32] outline-none transition-colors focus:border-[#D7663E] dark:border-white/[0.08] dark:bg-[#141720] dark:text-[#E2E8F2]"
                >
                  <option value="0.0.0.0">0.0.0.0</option>
                  <option value="127.0.0.1">127.0.0.1</option>
                </select>
              </ApiSettingRow>
              <ApiSettingRow
                label="API Key"
                description={state.apiConfig.hasApiKey ? '已设置。软件内请求会自动使用，外部客户端需携带 Bearer Token。' : '未设置。软件内无需 Key；对外开放时建议生成 Key。'}
              >
                <div className="flex items-center gap-2">
                  {configuredApiKey && (
                    <button
                      onClick={() => void handleCopyConfiguredApiKey()}
                      className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#DCD8CF] bg-[#FBFAF6] text-[#6F685A] transition-colors hover:bg-[#F1EEE7] dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[#B8C2D4]"
                      title="复制 API Key"
                    >
                      <Copy className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    onClick={handleGenerateApiKey}
                    className="h-9 rounded-lg border border-[#DCD8CF] bg-[#FBFAF6] px-3 text-sm font-semibold text-[#403C32] transition-colors hover:bg-[#F1EEE7] dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[#E2E8F2] dark:hover:bg-white/[0.09]"
                  >
                    {state.apiConfig.hasApiKey ? '重新申请' : '生成'}
                  </button>
                  {state.apiConfig.hasApiKey && (
                    <button
                      onClick={handleDeleteApiKey}
                      className="h-9 rounded-lg border border-[#E7C9BE] bg-[#F6E4DE] px-3 text-sm font-semibold text-[#B4563B] transition-colors hover:bg-[#F1D4CA] dark:border-[#3A5570] dark:bg-[#1C2836] dark:text-[#5A96D0] dark:hover:bg-[#1E2A3A]"
                    >
                      撤销
                    </button>
                  )}
                </div>
              </ApiSettingRow>
              </div>
              {newApiKey && (
                <div className="mt-3 rounded-xl border border-[#D7C7F5] bg-[#F4ECFF] p-3 dark:border-[#6A4CA3] dark:bg-[#25183D]">
                  <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-[#403C32] dark:text-[#E2E8F2]">
                    <KeyRound className="h-3.5 w-3.5 text-[#8B5CF6]" />
                    新 API Key
                  </div>
                  <div className="flex min-w-0 items-center gap-2">
                    <code className="mono-font min-w-0 flex-1 truncate rounded-lg border border-[#D7C7F5] bg-[#FBFAF6] px-3 py-2 text-xs text-[#403C32] dark:border-white/[0.08] dark:bg-black/20 dark:text-[#E2E8F2]">
                      {newApiKey}
                    </code>
                    <button
                      onClick={() => void handleCopyNewApiKey()}
                      className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-[#D7C7F5] bg-[#FBFAF6] text-[#6E3BD1] hover:bg-[#EEE2FF] dark:border-white/[0.08] dark:bg-white/[0.06] dark:text-[#A8B8F0]"
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
                </div>
              )}
              <div className="mt-3 rounded-xl border border-[#E5DFD3] bg-[#FBFAF6] p-3 dark:border-white/[0.08] dark:bg-black/20">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs text-[#8C8576] dark:text-[#8E99AD]">OpenAI 接口根地址（Base URL）</div>
                    <div className="mono-font truncate text-xs text-[#403C32] dark:text-[#E2E8F2]">{externalApiBaseUrl}</div>
                  </div>
                  <button
                    onClick={() => void handleCopyApiExample()}
                    className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-[#DCD8CF] bg-[#FAF9F5] text-[#6F685A] transition-colors hover:bg-[#F1EEE7] hover:text-[#403C32] dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[#B8C2D4] dark:hover:bg-white/[0.09]"
                    title="复制 PowerShell curl 示例"
                  >
                    <Copy className="h-4 w-4" />
                  </button>
                </div>
                <p className="text-[11px] leading-relaxed text-[#8C8576] dark:text-[#8E99AD]">
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
        <div className="text-sm font-medium text-[#403C32] dark:text-[#E2E8F2]">{label}</div>
        {description && <div className="mt-0.5 text-xs leading-5 text-[#8C8576] dark:text-[#8E99AD]">{description}</div>}
      </div>
      <div className="flex min-w-0 justify-start md:justify-end">{children}</div>
    </div>
  );
}
