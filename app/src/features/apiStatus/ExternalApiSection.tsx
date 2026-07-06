import { useState } from 'react';
import { Copy, Globe2, KeyRound } from 'lucide-react';
import ToggleSwitch from '@/components/ToggleSwitch';
import { SettingRow, SettingSection } from '@/components/SettingSection';
import { useApp } from '@/context/AppContext';
import {
  createExternalApiKey,
  deleteExternalApiKey,
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

export default function ExternalApiSection() {
  const { state, dispatch } = useApp();
  const [newApiKey, setNewApiKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const externalApiAddress = state.apiConfig.enabled
    ? `http://<本机局域网IP>:${state.serverPort}/v1/chat/completions`
    : `http://127.0.0.1:${state.serverPort}/v1/chat/completions`;

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
        const nextApiConfig = { ...state.apiConfig, hasApiKey: true, apiKey: nextKey };
        dispatch({ type: 'SET_API_CONFIG', payload: { hasApiKey: true, apiKey: nextKey } });
        setMessage('新的 API Key 已生成。请现在复制保存；关闭此提示后将无法再次查看。');
        void persistRuntimeSettings(state.serverPort, nextApiConfig);
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
        dispatch({ type: 'SET_API_CONFIG', payload: { hasApiKey: false, apiKey: undefined } });
        setMessage('API Key 已撤销。下一次加载模型时将不再要求外部请求鉴权。');
        void persistRuntimeSettings(state.serverPort, { ...state.apiConfig, hasApiKey: false, apiKey: undefined });
      })
      .catch((error) => {
        setMessage(`API Key 撤销失败：${String(error)}`);
      });
  };

  const handleCopyApiExample = async () => {
    const auth = state.apiConfig.hasApiKey ? ` \\\n+  -H "Authorization: Bearer <API_KEY>"` : '';
    const command = [
      `curl http://127.0.0.1:${state.serverPort}/v1/chat/completions \\`,
      '  -H "Content-Type: application/json" \\',
      `${auth}${auth ? ' \\' : ''}`,
      `  -d "{\\"model\\": \\"${state.models.find((model) => model.id === state.activeModelId)?.name ?? 'local-model'}\\", \\"messages\\": [{\\"role\\": \\"user\\", \\"content\\": \\"你好\\"}], \\"stream\\": false}"`,
    ].filter(Boolean).join('\n');
    await navigator.clipboard.writeText(command);
    setMessage('已复制 OpenAI 兼容 API 调用示例。');
  };

  const handleCopyNewApiKey = async () => {
    if (!newApiKey) return;
    await navigator.clipboard.writeText(newApiKey);
    setMessage('已复制新的 API Key。请妥善保存；之后只能重新申请。');
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[#FBFAF6] text-[#2F2C26] dark:bg-[#171512] dark:text-[#F3EBDD]">
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-3xl">
          <div className="mb-6">
            <h1 className="text-2xl font-bold text-primary-custom">对外 API</h1>
            <p className="mt-1 text-sm leading-6 text-secondary-custom">
              管理 OpenAI 兼容接口的监听范围、端口和 API Key。修改后请重新加载模型以生效。
            </p>
          </div>

          <div className="space-y-4 pb-12">
            <SettingSection title="对外 API" icon={Globe2}>
              <SettingRow
                label="释放 OpenAI 兼容 API"
                description={state.apiConfig.enabled ? `下一次加载模型时监听 ${state.apiConfig.host || '0.0.0.0'}:${state.serverPort}` : '关闭时仅本机 127.0.0.1 可访问'}
              >
                <ToggleSwitch
                  checked={state.apiConfig.enabled}
                  onChange={handleApiEnabledChange}
                  label="释放 OpenAI 兼容 API"
                />
              </SettingRow>
              <div className="border-t border-white/5 dark:border-white/5" />
              <SettingRow
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
                  className="mono-font w-28 rounded-lg bg-black/5 px-3 py-2 text-right text-sm text-primary-custom outline-none focus:ring-1 focus:ring-[#5A6CFF]/50 dark:bg-white/5"
                />
              </SettingRow>
              <SettingRow
                label="监听地址"
                description="0.0.0.0 表示允许局域网访问；127.0.0.1 表示仅本机访问"
              >
                <select
                  value={state.apiConfig.host}
                  onChange={(event) => updateApiConfig({ host: event.target.value }, true)}
                  className="glass-panel w-36 bg-transparent px-3 py-2 text-sm text-primary-custom outline-none"
                >
                  <option value="0.0.0.0">0.0.0.0</option>
                  <option value="127.0.0.1">127.0.0.1</option>
                </select>
              </SettingRow>
              <SettingRow
                label="API Key"
                description={state.apiConfig.hasApiKey ? '已设置。明文只在创建后显示一次；忘记后请重新申请。' : '未设置，不建议在局域网开放时留空'}
              >
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleGenerateApiKey}
                    className="rounded-lg bg-[#5A6CFF]/10 px-3 py-2 text-sm text-[#5A6CFF] transition-colors hover:bg-[#5A6CFF]/15"
                  >
                    {state.apiConfig.hasApiKey ? '重新申请' : '生成'}
                  </button>
                  {state.apiConfig.hasApiKey && (
                    <button
                      onClick={handleDeleteApiKey}
                      className="rounded-lg bg-[#F87171]/10 px-3 py-2 text-sm text-[#F87171] transition-colors hover:bg-[#F87171]/15"
                    >
                      撤销
                    </button>
                  )}
                </div>
              </SettingRow>
              {newApiKey && (
                <div className="rounded-xl border border-[#5A6CFF]/20 bg-[#5A6CFF]/[0.06] p-3">
                  <div className="mb-2 flex items-center gap-2 text-xs font-medium text-primary-custom">
                    <KeyRound className="h-3.5 w-3.5 text-[#5A6CFF]" />
                    新 API Key 仅显示一次
                  </div>
                  <div className="flex min-w-0 items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded-lg bg-black/5 px-3 py-2 text-xs text-primary-custom dark:bg-white/5">
                      {newApiKey}
                    </code>
                    <button
                      onClick={() => void handleCopyNewApiKey()}
                      className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-[#5A6CFF]/10 text-[#5A6CFF] hover:bg-[#5A6CFF]/15"
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
              <div className="rounded-xl bg-black/[0.04] p-3 dark:bg-white/[0.04]">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs text-secondary-custom">接口地址</div>
                    <div className="mono-font truncate text-xs text-primary-custom">{externalApiAddress}</div>
                  </div>
                  <button
                    onClick={() => void handleCopyApiExample()}
                    className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-black/5 text-secondary-custom transition-colors hover:text-primary-custom dark:bg-white/5"
                    title="复制 curl 示例"
                  >
                    <Copy className="h-4 w-4" />
                  </button>
                </div>
                <p className="text-[11px] leading-relaxed text-secondary-custom">
                  对外 API 使用 llama-server 原生 OpenAI 兼容接口。防火墙需要放行端口，修改设置后请重新加载模型。
                </p>
              </div>
            </SettingSection>

            {message && <p className="text-xs text-secondary-custom">{message}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
