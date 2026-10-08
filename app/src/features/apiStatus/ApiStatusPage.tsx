import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { Activity, ArrowDown, ArrowUp, CheckCircle2, Clock3, Gauge, Globe2, KeyRound, Loader2, Plus, RefreshCw, Server, WifiOff, XCircle, Zap } from 'lucide-react';
import { getDesktopServerLogs, isDesktopRuntime, pingLocalApi, type PingResult } from '@/lib/desktop';
import { useApp } from '@/context/AppContext';
import { ctxUsagePercent, latestRuntimeStatsFromServerLogs, latestStatsForSessions, sessionBelongsToModel } from '@/features/chat/chatUtils';
import { createApiModel } from '@/lib/apiModel';
import PageHeader from '@/components/PageHeader';
import ExternalApiSection from './ExternalApiSection';

function formatTime(date: Date | null) {
  if (!date) return '尚未检测';
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

function statusText(result: PingResult | null, serverRunning: boolean) {
  if (!serverRunning) return '服务未运行';
  if (!result) return '等待检测';
  if (result.reachable) return '接口可用';
  return '接口异常';
}

function displayModelName(raw: string) {
  const value = raw.trim();
  if (!value) return value;
  try {
    const url = new URL(value);
    const lastPart = url.pathname.split('/').filter(Boolean).pop();
    return lastPart || url.hostname || value;
  } catch {
    const normalized = value.replace(/\\/g, '/');
    return normalized.split('/').filter(Boolean).pop() ?? value;
  }
}

function StatusPill({ ok, text }: { ok: boolean; text: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${ok ? 'bg-[var(--state-success-bg)] text-[var(--state-success)] dark:bg-[var(--state-success-bg)] dark:text-[var(--state-success)]' : 'bg-[var(--state-danger-bg)] text-[var(--state-danger)] dark:bg-[var(--surface-raised)] dark:text-[var(--state-danger)]'}`}>
      {ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
      {text}
    </span>
  );
}

function InfoCard({ icon: Icon, label, value, note }: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="rounded-xl bg-[var(--surface-muted)] px-3.5 py-3.5 dark:bg-white/[0.04]">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">
        <Icon className="h-4 w-4 flex-shrink-0 text-[var(--accent)]" />
        {label}
      </div>
      <div className="mono-font break-words text-base font-semibold leading-6 text-[var(--text-primary)] dark:text-[var(--text-primary)]">{value}</div>
      {note && <div className="mt-1.5 break-words text-xs leading-5 text-[var(--text-tertiary)] dark:text-[var(--text-secondary)]">{note}</div>}
    </div>
  );
}

function LiveMetric({ icon: Icon, label, value, note }: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="rounded-xl bg-[var(--surface-muted)] px-3.5 py-3 dark:bg-white/[0.04]">
      <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">
        <Icon className="h-3.5 w-3.5 flex-shrink-0 text-[var(--accent)]" />
        {label}
      </div>
      <div className="mono-font break-words text-sm font-semibold leading-5 text-[var(--text-primary)] dark:text-[var(--text-primary)]">{value}</div>
      {note && <div className="mt-1 break-words text-[11px] leading-4 text-[var(--text-tertiary)] dark:text-[var(--text-secondary)]">{note}</div>}
    </div>
  );
}

function formatLiveMetric(value: number | undefined, suffix: string, digits = 1) {
  if (!value || !Number.isFinite(value) || value <= 0) return '暂无';
  return `${value.toFixed(digits)}${suffix}`;
}

function formatCtxUsage(stats: ReturnType<typeof latestStatsForSessions>) {
  if (!stats || stats.ctxUsed <= 0 || stats.ctxTotal <= 0) return '暂无';
  return `${stats.ctxUsed.toLocaleString()} / ${stats.ctxTotal.toLocaleString()}`;
}

function formatTokens(value: number) {
  return Math.max(0, Math.round(value)).toLocaleString('zh-CN');
}

export default function ApiStatusPage() {
  const { state, dispatch } = useApp();
  const [result, setResult] = useState<PingResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);
  const [serverLogs, setServerLogs] = useState<string[]>([]);
  const [modelListMessage, setModelListMessage] = useState<string | null>(null);
  const checkingRef = useRef(false);

  const runCheck = async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    try {
      const nextResult = await pingLocalApi();
      setResult(nextResult);
      setLastCheckedAt(new Date());
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
  };

  useEffect(() => {
    void runCheck();
    const timer = window.setInterval(() => void runCheck(), 2000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let disposed = false;
    const refreshLogs = async () => {
      try {
        const lines = await getDesktopServerLogs();
        if (!disposed) setServerLogs(lines.slice(-80));
      } catch {
        if (!disposed) setServerLogs([]);
      }
    };
    void refreshLogs();
    const timer = window.setInterval(() => void refreshLogs(), 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  const bindHost = result?.bindHost?.trim();
  const runningExternal = bindHost === '0.0.0.0'
    || bindHost === '::'
    || (Boolean(bindHost) && bindHost !== '127.0.0.1' && bindHost !== '::1' && bindHost !== 'localhost');
  const apiBase = result?.externalBaseUrl
    ?? (runningExternal ? '未识别到局域网 IP' : result?.baseUrl)
    ?? `http://127.0.0.1:${state.serverPort}`;
  const healthy = Boolean(result?.reachable);
  const activeModel = state.models.find((model) => model.id === state.activeModelId)
    ?? state.models.find((model) => model.status === 'loaded');
  const standards = result?.protocolStandards?.length ? result.protocolStandards.join(' / ') : '探测中…';
  const healthStatusCode = result?.statusCode ? `/health ${result.statusCode}` : '/health 状态码 --';
  const logRuntimeStats = useMemo(() => {
    const ctxTotal = activeModel?.loadConfig.ctxLength || activeModel?.ctxLength || 0;
    return latestRuntimeStatsFromServerLogs(serverLogs, ctxTotal);
  }, [activeModel, serverLogs]);
  // 日志解析不到时（当前模型还没生成过）兜底到该模型自己的会话 stats；
  // 不跨模型回退——别的模型的 ctxUsed/ctxTotal 显示在这里毫无意义。
  const modelSessions = useMemo(
    () => Object.values(state.chatSessions).flat().filter((session) => sessionBelongsToModel(session, activeModel?.id)),
    [state.chatSessions, activeModel?.id],
  );
  const latestStats = logRuntimeStats ?? latestStatsForSessions(modelSessions);
  const ctxPercent = ctxUsagePercent(latestStats);
  const usageTotals = useMemo(() => Object.values(state.usageByModel).reduce(
    (acc, usage) => ({
      promptTokens: acc.promptTokens + usage.promptTokens,
      completionTokens: acc.completionTokens + usage.completionTokens,
      totalTokens: acc.totalTokens + usage.totalTokens,
      responseCount: acc.responseCount + usage.responseCount,
    }),
    { promptTokens: 0, completionTokens: 0, totalTokens: 0, responseCount: 0 },
  ), [state.usageByModel]);
  const externalUsage = useMemo(() => Object.entries(state.usageByModel)
    .filter(([modelId]) => modelId.startsWith('api-'))
    .reduce(
      (acc, [, usage]) => ({
        promptTokens: acc.promptTokens + usage.promptTokens,
        completionTokens: acc.completionTokens + usage.completionTokens,
        totalTokens: acc.totalTokens + usage.totalTokens,
        responseCount: acc.responseCount + usage.responseCount,
      }),
      { promptTokens: 0, completionTokens: 0, totalTokens: 0, responseCount: 0 },
    ), [state.usageByModel]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--app-bg)] text-[var(--text-primary)] dark:bg-[var(--app-bg)] dark:text-[var(--text-primary)]">
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-5xl min-[1600px]:max-w-[1360px]">
          <PageHeader
            icon={Activity}
            title="API 状态"
            description="每 2 秒检测本地 OpenAI / Anthropic 兼容接口；这里集中查看运行状态、Token 用量与对外 API 设置。"
            className="mb-6"
            actions={(
              <button
                type="button"
                onClick={() => void runCheck()}
                disabled={checking}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 text-sm font-semibold text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)] disabled:opacity-60 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[var(--text-primary)] dark:hover:bg-white/[0.08]"
              >
                {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                立即检测
              </button>
            )}
          />

          <section className="mb-2 border-b border-[var(--border-subtle)] py-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex items-start gap-3">
                <div className={`grid h-11 w-11 flex-shrink-0 place-items-center rounded-xl ${healthy ? 'bg-[var(--state-success-bg)] text-[var(--state-success)] dark:bg-[var(--state-success-bg)] dark:text-[var(--state-success)]' : 'bg-[var(--state-danger-bg)] text-[var(--state-danger)] dark:bg-[var(--surface-raised)] dark:text-[var(--state-danger)]'}`}>
                  {healthy ? <Activity className="h-5 w-5" /> : <WifiOff className="h-5 w-5" />}
                </div>
                <div>
                  <div className="text-lg font-semibold text-[var(--text-primary)] dark:text-[var(--text-primary)]">{statusText(result, state.serverRunning)}</div>
                  <div className="mt-1 text-sm text-[var(--text-tertiary)] dark:text-[var(--text-secondary)]">上次检测：{formatTime(lastCheckedAt)}</div>
                  <div className="mt-0.5 text-sm text-[var(--text-tertiary)] dark:text-[var(--text-secondary)]">兼容标准：{standards}</div>
                  {result?.error && <div className="mt-2 break-words text-sm text-[var(--state-danger)] dark:text-[var(--state-danger)]">{result.error}</div>}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <StatusPill ok={state.serverRunning} text={state.serverRunning ? '服务运行中' : '服务未运行'} />
                <StatusPill ok={Boolean(result?.healthOk)} text="/health" />
                <StatusPill ok={Boolean(result?.modelsOk)} text="/v1/models" />
              </div>
            </div>
          </section>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <InfoCard icon={Server} label="当前接口地址" value={apiBase} note={runningExternal ? `当前监听 ${result?.bindHost ?? '0.0.0.0'}` : '当前仅本机访问'} />
            <InfoCard icon={Clock3} label="响应延迟" value={result?.latencyMs != null ? `${result.latencyMs} ms` : '--'} note="基于 /health 请求" />
            <InfoCard icon={Activity} label="模型状态" value={activeModel ? activeModel.name : '未加载'} note={state.serverRunning ? healthStatusCode : '服务启动后可对话'} />
            <InfoCard icon={KeyRound} label="当前鉴权" value={result?.apiKeyRequired ? '需要 API Key' : '无需 API Key'} note={result?.apiKeyRequired ? '软件内自动携带，外部请求使用 Bearer Token' : '当前运行实例未启用鉴权'} />
          </div>

          <section className="mt-2 border-b border-[var(--border-subtle)] py-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)] dark:text-[var(--text-primary)]">
                <Zap className="h-4 w-4 text-[var(--accent)]" />
                Token 统计
              </h2>
              <span className="text-[11px] text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">包含软件内对话与对外 API</span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <LiveMetric icon={Zap} label="累计 Token" value={formatTokens(usageTotals.totalTokens)} note={`对外 API ${formatTokens(externalUsage.totalTokens)}`} />
              <LiveMetric icon={ArrowDown} label="输入 Token" value={formatTokens(usageTotals.promptTokens)} note="提示词与上下文" />
              <LiveMetric icon={ArrowUp} label="输出 Token" value={formatTokens(usageTotals.completionTokens)} note="模型生成内容" />
              <LiveMetric icon={Activity} label="请求次数" value={formatTokens(usageTotals.responseCount)} note={`对外 API ${formatTokens(externalUsage.responseCount)} 次`} />
            </div>
          </section>

          <section className="mt-4 border-b border-[var(--border-subtle)] pb-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)] dark:text-[var(--text-primary)]">
                  <Globe2 className="h-4 w-4 text-[var(--accent)]" />
                  对外 API 设置
                </h2>
                <p className="mt-1 text-[11px] text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">监听范围、端口、API Key 与调用示例统一在这里管理。</p>
              </div>
              <StatusPill ok={state.apiConfig.enabled} text={state.apiConfig.enabled ? '已开启' : '仅本机'} />
            </div>
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-4 py-2 dark:bg-white/[0.025]">
              <ExternalApiSection embedded />
            </div>
          </section>

          <section className="mt-2 border-b border-[var(--border-subtle)] py-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)] dark:text-[var(--text-primary)]">
                <Gauge className="h-4 w-4 text-[var(--accent)]" />
                实时运行
              </h2>
              <span className="text-[11px] text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">自动刷新：状态 2 秒</span>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <LiveMetric icon={Gauge} label="ctx 使用" value={formatCtxUsage(latestStats)} note={ctxPercent !== undefined ? `${Math.round(ctxPercent)}%` : '等待生成统计'} />
              <LiveMetric icon={Zap} label="输出速度" value={formatLiveMetric(latestStats?.tokensPerSec, ' tok/s')} note="最近一次响应" />
              <LiveMetric icon={Clock3} label="首字延迟" value={formatLiveMetric(latestStats?.firstTokenDelay, 's', 2)} note="TTFT" />
              <LiveMetric icon={Activity} label="接口延迟" value={result?.latencyMs != null ? `${result.latencyMs} ms` : '暂无'} note={formatTime(lastCheckedAt)} />
            </div>
          </section>

          <div className="mt-4">
            <section className="border-b border-[var(--border-subtle)] py-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className="flex items-center gap-2 text-[15px] font-semibold text-primary-custom">
                  <Globe2 className="h-4 w-4 text-[var(--accent)]" />
                  接口可用模型
                </h2>
                <span className="text-xs text-secondary-custom">{result?.models.length ?? 0} 个模型</span>
              </div>
              {result?.models.length ? (
                <div className="space-y-2">
                  {result.models.map((model) => {
                    const displayName = displayModelName(model);
                    const apiModel = createApiModel(displayName, state.serverPort);
                    const added = state.models.some((item) => item.id === apiModel.id);
                    return (
                      <div key={model} title={model} className="flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] py-2 last:border-b-0">
                        <div className="min-w-0">
                          <div className="mono-font truncate text-xs text-[var(--text-primary)]">{displayName}</div>
                          <div className="mt-0.5 flex flex-wrap gap-1">
                            {apiModel.tags.filter((tag) => tag !== 'API').map((tag) => (
                              <span key={tag} className="rounded-full bg-[var(--surface-muted)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)] dark:bg-white/[0.06]">
                                {tag}
                              </span>
                            ))}
                          </div>
                        </div>
                        <button
                          onClick={() => {
                            dispatch({ type: 'UPSERT_MODELS', payload: [apiModel] });
                            setModelListMessage(`已把 ${displayName} 添加到软件，自动标签：${apiModel.tags.filter((tag) => tag !== 'API').join('、') || '无'}。`);
                          }}
                          disabled={added}
                          className="flex h-8 flex-shrink-0 items-center gap-1 rounded-md border border-[var(--border)] px-2 text-xs text-[var(--accent)] transition-colors hover:bg-[var(--surface-muted)] disabled:opacity-40 dark:border-white/[0.08] dark:hover:bg-white/[0.06]"
                          title={added ? '已在软件中' : '添加到软件并自动携带标签'}
                        >
                          {added ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                          {added ? '已添加' : '添加'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="py-8 text-center text-sm text-secondary-custom">
                  {state.serverRunning ? '接口可用后会显示 /v1/models 返回的模型。' : '服务未运行，暂无法读取模型列表。'}
                </div>
              )}
              {modelListMessage && (
                <p className="mt-2 break-words text-xs text-secondary-custom">{modelListMessage}</p>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
