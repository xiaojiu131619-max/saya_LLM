import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  Copy,
  Gauge,
  Globe2,
  KeyRound,
  Loader2,
  Lock,
  RefreshCw,
  WifiOff,
  XCircle,
  Zap,
} from 'lucide-react';
import {
  fast27bGetLogs,
  getLanIpAddress,
  isDesktopRuntime,
  pingLocalApi,
  type PingResult,
} from '@/lib/desktop';
import { useApp } from '@/context/AppContext';
import { parseEngineLog } from '@/features/chat/chatUtils';
import {
  FAST27B_MAX_CONCURRENCY,
  fast27bServiceView,
  refreshEngineStatus,
  useEngineStatuses,
} from '@/hooks/useEngineStatuses';
import ExternalApiSection from './ExternalApiSection';

function formatTimeFromMs(timestamp: number) {
  if (!timestamp) return '尚未检测';
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false });
}

function statusText(result: PingResult | null, serverRunning: boolean) {
  if (!serverRunning) return '服务未运行';
  if (!result) return '等待检测';
  if (result.reachable) return '接口可用';
  return '接口异常';
}

function formatCount(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '暂无';
  return Math.round(value).toLocaleString('zh-CN');
}

function StatusPill({ ok, text, neutral = false }: { ok: boolean; text: string; neutral?: boolean }) {
  // neutral：正常态而非错误（如「仅本机」= 未开启对外监听），用中性灰；红色只留给真正的失败。
  if (neutral) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface-muted)] px-2.5 py-1 text-[length:var(--font-eyebrow)] font-bold text-[var(--text-secondary)]">
        <Lock className="h-3.5 w-3.5" />
        {text}
      </span>
    );
  }
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[length:var(--font-eyebrow)] font-bold ${ok ? 'bg-[var(--state-success-bg)] text-[var(--state-success)]' : 'bg-[var(--state-danger-bg)] text-[var(--state-danger)]'}`}>
      {ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
      {text}
    </span>
  );
}

/** 区块头：标题 + 说明在左，kicker 在右（原型 section-head 节奏）。 */
function Section({ title, note, kicker, children, className = '' }: {
  title: string;
  note?: string;
  kicker?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`mt-7 ${className}`}>
      <div className="mb-3 flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-[length:var(--font-title)] font-semibold tracking-[var(--tracking-tight)] text-[var(--text-primary)]">{title}</h2>
          {note && <p className="mt-0.5 text-[length:var(--font-caption)] text-[var(--text-secondary)]">{note}</p>}
        </div>
        {kicker && <span className="flex-shrink-0 text-[length:var(--font-caption)] text-[var(--text-tertiary)]">{kicker}</span>}
      </div>
      {children}
    </section>
  );
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">{label}</div>
      <div className={`mt-0.5 truncate text-[13px] text-[var(--text-primary)] ${mono ? 'mono-font' : ''}`}>{value}</div>
    </div>
  );
}

function DetailRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-[var(--border-subtle)] py-3 last:border-b-0 last:pb-0">
      <span className="flex-shrink-0 text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">{label}</span>
      <span className={`min-w-0 truncate text-[13px] text-[var(--text-primary)] ${mono ? 'mono-font' : ''}`}>{value}</span>
    </div>
  );
}

/** 请求槽位占用条：填充段数 = 在途请求数，最多画 8 段（再多数字本身已足够说明）。 */
function SlotBar({ total, used, tone }: { total: number; used: number; tone: 'idle' | 'busy' | 'error' }) {
  const segments = Math.min(Math.max(total, 1), 8);
  const filled = Math.min(used, segments);
  const toneClass = tone === 'busy'
    ? 'bg-[var(--state-warning)]'
    : tone === 'error' ? 'bg-[var(--state-danger)]' : 'bg-[var(--state-success)]';
  return (
    // 段宽封顶 40px：单并发时只画一小段，避免整条被误读成分隔线。
    <div className="flex w-[92px] flex-shrink-0 justify-end gap-1" aria-hidden="true">
      {Array.from({ length: segments }, (_, index) => (
        <span key={index} className={`h-1.5 max-w-10 flex-1 rounded-full ${index < filled ? toneClass : 'bg-[var(--border)]'}`} />
      ))}
    </div>
  );
}

export default function ApiStatusPage() {
  const { state, dispatch } = useApp();
  const [result, setResult] = useState<PingResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);
  const [engineLogs, setEngineLogs] = useState<string[]>([]);
  const [lanIp, setLanIp] = useState<string | null>(null);
  const [copiedBaseUrl, setCopiedBaseUrl] = useState(false);
  const checkingRef = useRef(false);
  const advancedRef = useRef<HTMLDetailsElement>(null);

  // ---- 服务后端：跟随「对话后端」选择（主模型 llama-server / fast-27b 引擎）----
  const engineStatuses = useEngineStatuses();
  const engine = fast27bServiceView(engineStatuses.fast27b);
  const engineMode = state.chatEngine === 'fast27b';

  const runCheck = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    try {
      if (engineMode) {
        await refreshEngineStatus();
      } else {
        const nextResult = await pingLocalApi();
        setResult(nextResult);
        setLastCheckedAt(new Date());
      }
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
  }, [engineMode]);

  useEffect(() => {
    if (engineMode) return;
    void runCheck();
    const timer = window.setInterval(() => void runCheck(), 2000);
    return () => window.clearInterval(timer);
  }, [engineMode, runCheck]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let disposed = false;
    void getLanIpAddress()
      .then((address) => { if (!disposed) setLanIp(address); })
      .catch(() => { if (!disposed) setLanIp(null); });
    return () => { disposed = true; };
  }, []);

  // 引擎日志只用于一件事：判定在途请求（请求槽位）。读 400 行足够覆盖最近一次
  // started 与终止行，不必每 1.5 秒搬运整个 5000 行缓冲（fast-27b 页已有一份全量轮询）。
  useEffect(() => {
    if (!isDesktopRuntime() || !engineMode) return;
    let disposed = false;
    const refreshLogs = async () => {
      try {
        const lines = await fast27bGetLogs();
        if (!disposed) setEngineLogs(lines.slice(-400));
      } catch {
        if (!disposed) setEngineLogs([]);
      }
    };
    void refreshLogs();
    const timer = window.setInterval(() => void refreshLogs(), 1500);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      setEngineLogs([]);
    };
  }, [engineMode]);

  const bindHost = result?.bindHost?.trim();
  const runningExternal = bindHost === '0.0.0.0'
    || bindHost === '::'
    || (Boolean(bindHost) && bindHost !== '127.0.0.1' && bindHost !== '::1' && bindHost !== 'localhost');
  const llamaBase = result?.externalBaseUrl
    ?? (runningExternal ? '未识别到局域网 IP' : result?.baseUrl)
    ?? `http://127.0.0.1:${state.serverPort}`;
  const activeModel = state.models.find((model) => model.id === state.activeModelId)
    ?? state.models.find((model) => model.status === 'loaded');
  const standards = result?.protocolStandards?.length ? result.protocolStandards.join(' / ') : '探测中…';
  const healthStatusCode = result?.statusCode ? `/health ${result.statusCode}` : '/health 状态码 --';

  // 在途请求：软件内对话按 isStreaming 统计；引擎另外用日志的 started/done 判定，
  // 后者涵盖外部客户端与 dsh 的请求，是引擎真正的占用来源。
  const appInFlight = useMemo(
    () => Object.values(state.chatSessions).reduce(
      (count, sessions) => count + sessions.reduce(
        (inner, session) => inner + session.messages.filter((message) => message.isStreaming).length,
        0,
      ),
      0,
    ),
    [state.chatSessions],
  );
  const engineInFlight = useMemo(() => parseEngineLog(engineLogs).inFlight, [engineLogs]);

  const llamaSlotTotal = Math.max(1, activeModel?.loadConfig.parallel && activeModel.loadConfig.parallel > 0
    ? activeModel.loadConfig.parallel
    : 1);

  // ---- 统一后的服务视图（两套后端共用同一批渲染分支）----
  const serviceRunning = engineMode ? engine.running : state.serverRunning;
  const serviceHealthy = engineMode ? engine.serviceable : Boolean(result?.reachable);
  const servicePort = engineMode ? engine.port : state.serverPort;
  const serviceModelName = engineMode ? engine.modelId : (activeModel ? activeModel.name : '未加载');
  const serviceModelNote = engineMode
    ? engine.modelLabel
    : (activeModel ? `${activeModel.params} ${activeModel.quant}` : '未加载模型');
  const serviceExposed = engineMode ? engine.lan : runningExternal;
  const serviceTitle = engineMode
    ? engine.serviceable ? '引擎运行中' : engine.running ? '引擎已失效' : '引擎未启动'
    : statusText(result, state.serverRunning);
  const serviceHint = engineMode
    ? engine.serviceable
      ? '可接受请求'
      : engine.running ? '引擎进程还在，但已判定失效' : '到 fast-27b 页启动引擎'
    : serviceHealthy ? '可接受请求' : state.serverRunning ? '接口异常' : '服务未运行，请先加载模型';
  const serviceBaseUrl = engineMode
    ? `http://${engine.lan ? lanIp ?? '<本机局域网 IP>' : '127.0.0.1'}:${engine.port}/v1`
    : llamaBase;
  const serviceStandards = engineMode ? 'OpenAI Compatible' : standards;
  const serviceAuthRequired = engineMode ? Boolean(engine.apiKey) : Boolean(result?.apiKeyRequired);
  const serviceCheckedAtMs = engineMode ? engineStatuses.fetchedAt : (lastCheckedAt ? lastCheckedAt.getTime() : 0);
  const serviceLatencyMs = engineMode ? undefined : result?.latencyMs;
  const slotTotal = engineMode ? FAST27B_MAX_CONCURRENCY : llamaSlotTotal;
  const slotUsed = engineMode
    ? (engineInFlight || appInFlight > 0 ? 1 : 0)
    : Math.min(llamaSlotTotal, appInFlight);
  const slotNote = engineMode
    ? '来自引擎日志（含外部客户端请求）'
    : '仅统计软件内对话；外部 API 请求不计入';
  const slotTone: 'idle' | 'busy' | 'error' = !serviceRunning ? 'error' : slotUsed > 0 ? 'busy' : 'idle';

  const copyBaseUrl = async () => {
    await navigator.clipboard.writeText(serviceBaseUrl);
    setCopiedBaseUrl(true);
    window.setTimeout(() => setCopiedBaseUrl(false), 1800);
  };

  const openAdvancedSettings = () => {
    const node = advancedRef.current;
    if (!node) return;
    node.open = true;
    node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  const openFast27bPage = () => dispatch({ type: 'SET_VIEW', payload: 'fast27b' });

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-[var(--app-bg)] text-[var(--text-primary)]">
      {/* 克制的 accent 光晕：只调氛围，不改底色，明暗自适应。 */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[320px]"
        style={{ background: 'radial-gradient(58% 100% at 78% 0%, color-mix(in srgb, var(--accent) 11%, transparent), transparent 72%)' }}
      />

      <div className="relative flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto w-full max-w-[1120px] min-[1600px]:max-w-[1360px]">

          <header className="mb-7 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <div className="eyebrow">服务控制台 / API · {engineMode ? engine.label : '主模型'}</div>
              <h1 className="display-title mt-2">API 服务</h1>
              <p className="mt-1.5 max-w-[620px] text-[length:var(--font-body)] leading-[var(--leading-ui)] text-[var(--text-secondary)]">
                {engineMode
                  ? `本页描述 fast-27b 引擎自带的 OpenAI 兼容端点（端口 ${engine.port}，固定单并发）；切换对话后端即可在本页与主模型之间切换。`
                  : '每 2 秒检测本地 OpenAI / Anthropic 兼容接口；这里集中查看运行状态与对外 API 连接信息。'}
              </p>
            </div>
            <div className="flex flex-shrink-0 flex-wrap items-center gap-2 lg:justify-end">
              <StatusPill ok={serviceHealthy} text={serviceTitle} />
              <button
                type="button"
                onClick={() => void runCheck()}
                disabled={checking}
                className="inline-flex h-9 items-center justify-center gap-2 rounded-[var(--radius-field)] border border-[var(--border)] bg-[var(--surface)] px-3.5 text-[length:var(--font-body)] font-semibold text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)] disabled:opacity-60"
              >
                {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                立即检测
              </button>
            </div>
          </header>

          {/* 另一个后端在跑时给出提示与一键切换，避免「引擎已启动但本页还是主模型」的困惑。 */}
          {!engineMode && engine.running && (
            <div className="accent-soft mb-3.5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--radius-field)] px-4 py-3">
              <Zap className="h-4 w-4 flex-shrink-0 text-[var(--accent)]" />
              <span className="min-w-0 flex-1 text-[length:var(--font-caption)] text-[var(--text-secondary)]">
                fast-27b 引擎正在运行（端口 {engine.port}），本页当前描述的是主模型服务。
              </span>
              <button
                type="button"
                onClick={() => dispatch({ type: 'SET_CHAT_ENGINE', payload: 'fast27b' })}
                className="flex flex-shrink-0 items-center gap-1 text-[length:var(--font-caption)] font-bold text-[var(--accent)] transition-opacity hover:opacity-75"
              >
                切换对话后端为 fast-27b
                <ArrowUpRight className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          <section className="grid gap-3.5 lg:grid-cols-[minmax(0,1.32fr)_minmax(280px,0.68fr)]">
            <article className="panel relative overflow-hidden p-6">
              {/* 同心环装饰（对应原型的双层圆环）：两圈才读得出是刻意的图案。 */}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute -right-28 -top-32 h-[280px] w-[280px] rounded-full border border-[var(--border-subtle)]"
                style={{ boxShadow: '0 0 0 32px color-mix(in srgb, var(--border-subtle) 55%, transparent), 0 0 0 64px color-mix(in srgb, var(--border-subtle) 32%, transparent)' }}
              />
              <div className="relative">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
                      <span className={`absolute -inset-1 rounded-full opacity-20 ${serviceHealthy ? 'bg-[var(--state-success)]' : 'bg-[var(--state-danger)]'}`} />
                      <span className={`absolute inset-0 rounded-full ${serviceHealthy ? 'bg-[var(--state-success)]' : 'bg-[var(--state-danger)]'}`} />
                    </span>
                    <h2 className="truncate text-[20px] font-bold tracking-[var(--tracking-tight)] text-[var(--text-primary)]">
                      {serviceTitle}
                    </h2>
                  </div>
                  <div className="flex flex-shrink-0 flex-wrap justify-end gap-2">
                    {engineMode ? (
                      <>
                        <StatusPill ok={engine.apiReachable} text="/v1/models" />
                        <StatusPill ok={engine.running} text={engine.running ? '进程存活' : '进程未启动'} />
                        {engine.degraded && <StatusPill ok={false} text="引擎已失效" />}
                      </>
                    ) : (
                      <>
                        <StatusPill ok={Boolean(result?.healthOk)} text="/health" />
                        <StatusPill ok={Boolean(result?.modelsOk)} text="/v1/models" />
                      </>
                    )}
                  </div>
                </div>

                <div className="mt-7">
                  <div className="text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">当前加载模型</div>
                  <div className="mono-font mt-1 truncate text-[length:var(--font-title)] text-[var(--text-primary)]">
                    {serviceModelName}
                  </div>
                  <div className="mt-1 text-[length:var(--font-caption)] text-[var(--text-secondary)]">{serviceModelNote}</div>
                </div>

                <div className="mt-6 flex flex-wrap gap-x-7 gap-y-3">
                  <Fact
                    label="最近检测"
                    value={`${formatTimeFromMs(serviceCheckedAtMs)}${serviceLatencyMs != null ? ` · ${serviceLatencyMs} ms` : ''}`}
                  />
                  <Fact
                    label="访问范围"
                    value={serviceExposed
                      ? `监听 ${engineMode ? '0.0.0.0' : result?.bindHost ?? '0.0.0.0'}`
                      : '仅本机访问'}
                  />
                  <Fact label="服务端口" value={String(servicePort)} mono />
                  {engineMode && (
                    <Fact
                      label="设备 KV 池"
                      value={engine.devicePoolTokens != null ? `${formatCount(engine.devicePoolTokens)} tok` : '未知'}
                      mono
                    />
                  )}
                </div>

                {engineMode && engine.degraded && (
                  <div className="mt-4 rounded-[var(--radius-field)] border border-[var(--state-danger-border)] bg-[var(--state-danger-bg)] px-3.5 py-3">
                    <div className="text-[length:var(--font-caption)] font-semibold text-[var(--state-danger)]">
                      引擎已失效{engine.faultAt ? `（${engine.faultAt}）` : ''}
                      {engine.faultKindText ? ` · ${engine.faultKindText}` : ''}
                    </div>
                    {engine.degradedReason && (
                      <div className="mt-1 break-words text-[length:var(--font-caption)] leading-[var(--leading-ui)] text-[var(--text-primary)]">
                        {engine.degradedReason}
                      </div>
                    )}
                    {engine.rawFaultLine && (
                      <div className="mono-font mt-1.5 break-words text-[length:var(--font-eyebrow)] leading-4 text-[var(--text-tertiary)]">
                        {engine.rawFaultLine}
                      </div>
                    )}
                    {engine.requiresRestart && (
                      <button
                        type="button"
                        onClick={openFast27bPage}
                        className="mt-2.5 inline-flex items-center gap-1 text-[length:var(--font-caption)] font-bold text-[var(--state-danger)] transition-opacity hover:opacity-75"
                      >
                        到 fast-27b 页重启引擎
                        <ArrowUpRight className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                )}

                {!engineMode && result?.error && (
                  <div className="mt-4 break-words text-[length:var(--font-caption)] text-[var(--state-danger)]">{result.error}</div>
                )}
                {!engineMode && !result?.error && state.serverRunning && (
                  <div className="mt-4 break-words text-[length:var(--font-caption)] text-[var(--text-tertiary)]">{healthStatusCode} · 兼容标准：{standards}</div>
                )}
              </div>
            </article>

            <article className="panel flex flex-col justify-between p-6">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-[length:var(--font-body)] font-bold tracking-[var(--tracking-tight)] text-[var(--text-primary)]">当前请求</h2>
                <span className="text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">
                  {engineMode ? `固定单并发 ${slotTotal}` : `单并发上限 ${slotTotal}`}
                </span>
              </div>

              <div className="my-6">
                <strong className="block text-[length:var(--font-display)] tracking-[var(--tracking-display)] text-[var(--text-primary)]">
                  {!serviceRunning ? '无法接受请求' : slotUsed > 0 ? '请求处理中' : '服务空闲'}
                </strong>
                <span className="mt-1 block text-[length:var(--font-body)] leading-[var(--leading-ui)] text-[var(--text-secondary)]">
                  {serviceHint}
                </span>
              </div>

              <div className="flex items-center justify-between gap-3 border-t border-[var(--border-subtle)] pt-4">
                <div>
                  <div className="text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">请求槽位</div>
                  <div className="metric-value text-[length:var(--font-title)] text-[var(--text-primary)]">
                    {serviceRunning ? `${slotUsed} / ${slotTotal}` : `— / ${slotTotal}`}
                  </div>
                </div>
                <SlotBar total={slotTotal} used={serviceRunning ? slotUsed : 0} tone={slotTone} />
              </div>
              <p className="mt-2 text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">{slotNote}</p>
            </article>
          </section>

          <Section title="连接信息" note="外部客户端只需要下面三项信息即可发起调用。">
            <div className="grid gap-3.5 lg:grid-cols-[minmax(0,1.25fr)_minmax(240px,0.75fr)]">
              <article className="panel p-5">
                <div className="text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">客户端 Base URL</div>
                <div className="accent-soft mt-2 flex items-center justify-between gap-3 rounded-[var(--radius-field)] px-3.5 py-3">
                  <code className="mono-font min-w-0 truncate text-[13px] text-[var(--accent)]" title={serviceBaseUrl}>{serviceBaseUrl}</code>
                  <button
                    type="button"
                    onClick={() => void copyBaseUrl()}
                    className="flex flex-shrink-0 items-center gap-1.5 text-[length:var(--font-caption)] font-bold text-[var(--accent)] transition-opacity hover:opacity-75"
                    title="复制 Base URL"
                  >
                    <Copy className="h-3.5 w-3.5" />
                    {copiedBaseUrl ? '已复制' : '复制'}
                  </button>
                </div>
                <div className="mt-4">
                  <DetailRow label="当前模型" value={serviceModelName} mono />
                  <DetailRow label="聊天接口" value="/v1/chat/completions" mono />
                  <DetailRow label="兼容协议" value={serviceStandards} />
                  {engineMode && (
                    <DetailRow label="健康检查" value="引擎无 /health，用 /v1/models 判活" />
                  )}
                  {engineMode && engine.dshBoundModel && (
                    <DetailRow label="dsh 绑定" value={engine.dshBoundModel} mono />
                  )}
                </div>
              </article>

              <article className="panel flex flex-col justify-between p-5">
                <div>
                  <div className="text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">访问鉴权</div>
                  <div className="mt-4 flex items-center gap-3">
                    <div className={`grid h-9 w-9 flex-shrink-0 place-items-center rounded-[var(--radius-field)] ${serviceAuthRequired ? 'bg-[var(--state-success-bg)] text-[var(--state-success)]' : 'bg-[var(--surface-muted)] text-[var(--text-tertiary)]'}`}>
                      <KeyRound className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-[length:var(--font-body)] font-semibold text-[var(--text-primary)]">
                        {serviceAuthRequired ? 'API Key 已启用' : '未启用 API Key'}
                      </div>
                      <div className="mt-0.5 text-[length:var(--font-caption)] text-[var(--text-secondary)]">
                        {serviceAuthRequired ? '外部请求需要 Bearer Token' : '外部请求当前无需鉴权'}
                      </div>
                    </div>
                  </div>
                </div>
                <div className="mt-5">
                  <button
                    type="button"
                    onClick={engineMode ? openFast27bPage : openAdvancedSettings}
                    className="w-full rounded-[var(--radius-field)] border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-[length:var(--font-body)] font-semibold text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover)]"
                  >
                    {engineMode ? '到 fast-27b 页管理 API Key' : '管理 API Key'}
                  </button>
                  <p className="mt-2.5 text-center text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">
                    {engineMode ? '引擎的端口、局域网访问与 Key 都在 fast-27b 页配置' : '监听范围、端口与调用示例见下方「高级设置」'}
                  </p>
                </div>
              </article>
            </div>
          </Section>

          {/* 引擎模式不再放只读参数表：端口 / 监听范围 / 鉴权已经在「连接信息」与「访问鉴权」卡里，
              其余（模型变体、草稿 token、KV 池、文件路径…）是 fast-27b 页的职责，抄一份过来只是噪音。 */}
          {!engineMode && (
            <Section
              title="高级设置"
              note="监听范围、端口、API Key 与调用示例。修改后需重新加载模型生效。"
              className="pb-8"
            >
              <details ref={advancedRef} className="panel group overflow-hidden">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-[var(--surface-muted)] [&::-webkit-details-marker]:hidden">
                  <span className="flex items-center gap-2.5">
                    <Globe2 className="h-4 w-4 flex-shrink-0 text-[var(--accent)]" />
                    <strong className="text-[length:var(--font-body)] font-semibold text-[var(--text-primary)]">对外 API</strong>
                    <StatusPill ok={state.apiConfig.enabled} text={state.apiConfig.enabled ? '局域网可访问' : '仅本机'} neutral={!state.apiConfig.enabled} />
                  </span>
                  <ChevronDown className="h-4 w-4 flex-shrink-0 text-[var(--text-tertiary)] transition-transform group-open:rotate-180" />
                </summary>
                <div className="border-t border-[var(--border-subtle)] px-5 py-4">
                  <ExternalApiSection embedded />
                </div>
              </details>
            </Section>
          )}

          <div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-[var(--border-subtle)] pt-4 pb-8 text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">
            {engineMode ? (
              <>
                <span className="inline-flex items-center gap-1.5"><Zap className="h-3.5 w-3.5" />引擎状态每 3 秒刷新</span>
                <span className="inline-flex items-center gap-1.5"><Gauge className="h-3.5 w-3.5" />引擎日志每 1.5 秒刷新</span>
                <span className="inline-flex items-center gap-1.5"><Activity className="h-3.5 w-3.5" />引擎无 /health，判活走 /v1/models</span>
              </>
            ) : (
              <>
                <span className="inline-flex items-center gap-1.5"><Activity className="h-3.5 w-3.5" />状态每 2 秒刷新</span>
                <span className="inline-flex items-center gap-1.5"><Gauge className="h-3.5 w-3.5" />判活走 /health 与 /v1/models</span>
              </>
            )}
            {!serviceRunning && <span className="inline-flex items-center gap-1.5"><WifiOff className="h-3.5 w-3.5" />服务未运行</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
