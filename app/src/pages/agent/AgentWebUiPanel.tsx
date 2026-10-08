import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Copy, ExternalLink, Globe, Info, KeyRound, RefreshCw, Zap } from 'lucide-react';
import {
  fast27bBridgeEnsure,
  fast27bBridgeStatus,
  getServerApiKey,
  openExternalUrl,
  type WebuiBridgeInfo,
} from '@/lib/desktop';
import { useApp } from '@/context/AppContext';
import { useEngineStatuses } from '@/hooks/useEngineStatuses';
import type { WebUiEngineId } from '@/types';

const ENGINE_OPTIONS: Array<{ id: WebUiEngineId; label: string }> = [
  { id: 'main', label: '主模型' },
  { id: 'fast27b', label: 'fast-27b' },
];

/**
 * Agent 页「WebUI」标签：**官方 llama.cpp 网页界面的入口**（不内嵌任何应用自绘界面）。
 *
 * - 主模型：本身就是 llama.cpp 服务，浏览器直接开它自己的端口即可；
 * - fast-27b：引擎没有任何 HTML 页面，由应用的**同源桥**（`services::webui_bridge`）在回环上
 *   提供官方页面并把引擎的协议差异（必须带 model、top_k ≤ 20、无 /props）抹平，
 *   所以这里显示的是桥的地址；引擎在跑时打开标签会自动把桥拉起来。
 */
export default function AgentWebUiPanel() {
  const { state, dispatch } = useApp();
  const engine = state.webuiEngine;
  const statuses = useEngineStatuses(engine);
  const [serverApiKey, setServerApiKey] = useState<string | null>(null);
  const [copied, setCopied] = useState<'url' | 'key' | null>(null);
  const [bridge, setBridge] = useState<WebuiBridgeInfo | null>(null);
  const [bridgeError, setBridgeError] = useState<string | null>(null);

  // 当前后端解析：主模型取 AppContext 状态；引擎取轮询到的状态快照。
  const target = useMemo(() => {
    if (engine === 'main') {
      return {
        label: '主模型',
        running: state.serverRunning,
        port: state.serverPort,
        // 主模型直接用 llama-server 自带页面（同源，无需桥）。
        webUrl: `http://127.0.0.1:${state.serverPort}`,
        engineApiKey: null as string | null,
      };
    }
    const status = statuses.fast27b;
    const port = status?.port ?? 8094;
    return {
      label: 'fast-27b',
      running: Boolean(status?.running),
      port,
      webUrl: bridge?.url ?? '',
      engineApiKey: status?.api_key ?? null,
    };
  }, [engine, statuses, bridge, state.serverRunning, state.serverPort]);

  // fast-27b 的网页地址来自桥；引擎在跑就自动把桥拉起来，省得用户手动点。
  // 状态只在 Promise 回调里写（避免在 effect 体里同步 setState 触发级联渲染）。
  const ensureBridge = useCallback(
    () =>
      Promise.resolve()
        .then(() => fast27bBridgeEnsure())
        .then((info) => {
          setBridge(info ?? null);
          setBridgeError(null);
        })
        .catch((error) => setBridgeError(String(error))),
    [],
  );

  useEffect(() => {
    if (engine !== 'fast27b') return;
    let cancelled = false;
    void fast27bBridgeStatus()
      .then((info) => {
        if (!cancelled) setBridge(info ?? null);
      })
      .catch(() => {
        if (!cancelled) setBridge(null);
      });
    return () => {
      cancelled = true;
    };
  }, [engine]);

  useEffect(() => {
    if (engine !== 'fast27b' || !target.running || (bridge && bridge.upstream_port === target.port)) return;
    void ensureBridge();
  }, [engine, target.running, bridge, target.port, ensureBridge]);

  // API Key：主模型走 getServerApiKey；引擎的密钥由桥在转发时注入。
  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => {
        if (!target.running || engine === 'fast27b') {
          return null;
        }
        return getServerApiKey();
      })
      .then((key) => {
        if (!cancelled) setServerApiKey(key && key.trim() ? key : null);
      })
      .catch(() => {
        if (!cancelled) setServerApiKey(null);
      });
    return () => {
      cancelled = true;
    };
  }, [engine, target.running, target.engineApiKey]);

  const copy = async (kind: 'url' | 'key', value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      // 剪贴板不可用时静默（值仍在按钮 title 里可见）。
    }
  };

  const backendSelector = (
    <label
      className="flex flex-shrink-0 items-center gap-1.5 text-xs"
      title="这里的内嵌网页只跟这个选择走；对话页的「后端」是独立的一份选择，互不影响"
    >
      <span className="text-[var(--text-tertiary)] dark:text-[var(--text-secondary)]">后端</span>
      <select
        value={engine}
        onChange={(event) => dispatch({ type: 'SET_WEBUI_ENGINE', payload: event.target.value as WebUiEngineId })}
        className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-1.5 py-1 text-xs text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)] dark:bg-[var(--surface-muted)]"
      >
        {ENGINE_OPTIONS.map((option) => (
          <option key={option.id} value={option.id}>{option.label}</option>
        ))}
      </select>
    </label>
  );

  const shell = (children: React.ReactNode) => (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--app-bg)] px-4 py-2 dark:border-white/[0.08]">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-primary-custom">
          <Globe className="h-3.5 w-3.5 text-[var(--accent)]" /> WebUI
        </span>
        <span className="flex-1" />
        {backendSelector}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">{children}</div>
    </div>
  );

  // ---- 未运行：引导态 ----
  if (!target.running) {
    const startAction = engine === 'main'
      ? { text: '去加载模型', run: () => dispatch({ type: 'SET_VIEW', payload: 'home' }) }
      : { text: `去启动 ${target.label}`, run: () => dispatch({ type: 'SET_VIEW', payload: 'fast27b' }) };
    return shell(
      <div className="mx-auto max-w-lg text-center">
        <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-[var(--surface)] text-[var(--text-tertiary)]">
          <Globe className="h-7 w-7 opacity-50" />
        </div>
        <h2 className="text-base font-semibold text-primary-custom">
          {engine === 'main' ? 'llama-server 未运行' : `${target.label} 未运行`}
        </h2>
        <p className="mt-2 text-xs leading-6 text-secondary-custom">
          {engine === 'main'
            ? <>这里给的是 llama-server <span className="text-primary-custom">自带网页界面</span>的入口，加载模型并启动服务后即可在浏览器里使用（当前端口<span className="mono-font"> {target.port}</span>）。</>
            : <>请到 <span className="text-primary-custom">fast-27b</span> 页启动引擎（当前端口<span className="mono-font"> {target.port}</span>），就绪后这里会给出它的网页界面地址。</>}
        </p>
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={startAction.run}
            className="flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[var(--accent-hover)]"
          >
            <Zap className="h-3.5 w-3.5" /> {startAction.text}
          </button>
        </div>
      </div>
    );
  }

  // ---- 运行中：连接信息 + 打开网页（官方界面，浏览器打开；不在应用里内嵌） ----
  const address = target.webUrl;
  const isFast27b = engine === 'fast27b';
  return shell(
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-primary-custom">网页连接</h2>
          <span className="rounded-full border border-[var(--state-success-border)] bg-[var(--state-success-bg)] px-2 py-0.5 text-xs text-[var(--state-success)]">
            {target.label} 运行中
          </span>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <span className="mono-font min-w-0 flex-1 truncate rounded-md border border-[var(--border)] bg-[var(--surface-muted)] px-2 py-1.5 text-[11px] text-secondary-custom" title="官方网页界面地址">
            {address || '（正在启动 fast-27b 的网页桥…）'}
          </span>
          <button
            type="button"
            onClick={() => void openExternalUrl(address)}
            disabled={!address}
            className="flex flex-shrink-0 items-center gap-1 rounded-md bg-[var(--accent)] px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40"
            title="用系统浏览器打开官方网页界面"
          >
            <ExternalLink className="h-3 w-3" /> 打开网页
          </button>
          <button
            type="button"
            onClick={() => void copy('url', address)}
            disabled={!address}
            className="flex flex-shrink-0 items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1.5 text-xs text-secondary-custom transition-colors hover:bg-[var(--surface-muted)] disabled:opacity-40"
            title="复制地址"
          >
            {copied === 'url' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {copied === 'url' ? '已复制' : '复制地址'}
          </button>
          {serverApiKey && (
            <button
              type="button"
              onClick={() => void copy('key', serverApiKey)}
              className="flex flex-shrink-0 items-center gap-1 rounded-md border border-[var(--state-warning-border)] px-2 py-1 text-xs text-[var(--state-warning)] transition-colors hover:bg-[var(--state-warning-bg)]"
              title={`服务开启了 API Key 鉴权：官方界面首次使用需在「设置」里粘贴这个密钥。点击复制：${serverApiKey}`}
            >
              {copied === 'key' ? <Check className="h-3 w-3" /> : <KeyRound className="h-3 w-3" />}
              {copied === 'key' ? '已复制' : '复制 API Key'}
            </button>
          )}
          {isFast27b && (
            <button
              type="button"
              onClick={() => void ensureBridge()}
              className="flex flex-shrink-0 items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1.5 text-xs text-secondary-custom transition-colors hover:bg-[var(--surface-muted)] disabled:opacity-40"
              title="重新启动 fast-27b 的网页桥（引擎已就绪但地址为空时可点）"
            >
              <RefreshCw className="h-3 w-3" /> 重启网页桥
            </button>
          )}
        </div>
        <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-5 text-secondary-custom">
          <Info className="mt-0.5 h-3 w-3 flex-shrink-0" />
          {isFast27b ? (
            <span>
              fast-27b 引擎没有任何内置网页界面，这里由应用在<span className="text-primary-custom">回环上起一层同源桥</span>：页面用 llama.cpp 官方 webui（随应用内嵌），
              请求转发到引擎并在转发时抹平差异（补 <span className="mono-font">model</span> 字段、<span className="mono-font">top_k</span> 收敛到 20、合成 <span className="mono-font">/props</span>）；
              API Key 由桥自动注入，界面里不需要手填。桥端口可在 fast-27b 页的「引擎配置」里改。
            </span>
          ) : (
            <span>
              地址就是引擎自带的官方网页界面（同源，请求直达引擎）。界面不在应用里内嵌，避免与官方实现各维护一份；
              服务若开了 API Key，先在界面「设置」里粘贴一次（点上方按钮复制）。
            </span>
          )}
        </p>
        {bridgeError && (
          <p className="mt-2 rounded-md bg-[var(--state-danger-bg)] px-2 py-1.5 text-[11px] text-[var(--state-danger)]">
            网页桥启动失败：{bridgeError}
          </p>
        )}
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4 text-[11px] leading-5 text-secondary-custom">
        <p className="mb-1 font-medium text-primary-custom">关于这个入口</p>
        <p>
          官方 webui 提供对话、思考过程折叠、采样参数、模型信息与流式续传等完整能力；
          应用不再自带一份自绘的中文界面，页面的正确性以引擎/官方实现为准。
          {isFast27b ? '主模型有自己的官方页面，浏览器直接开它的地址即可（切上方「后端」）。' : '切到 fast-27b 时，地址会自动变成应用提供的同源桥。'}
        </p>
      </div>
    </div>
  );
}
