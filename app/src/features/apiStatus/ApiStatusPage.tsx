import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  Copy,
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
import PageHeader from '@/components/PageHeader';
import {
  FAST27B_MAX_CONCURRENCY,
  fast27bServiceView,
  refreshEngineStatus,
  useEngineStatuses,
} from '@/hooks/useEngineStatuses';
import { useFast27bMetrics } from '@/hooks/useFast27bMetrics';
import {
  fast27bModelDisplayName,
  fast27bServiceUsage,
  llamaServiceUsage,
} from '@/lib/serviceUsage';
import ServiceUsageCard from './ServiceUsageCard';
import ExternalApiSection from './ExternalApiSection';

function statusText(result: PingResult | null, serverRunning: boolean) {
  if (!serverRunning) return '服务未运行';
  if (!result) return '等待检测';
  if (result.reachable) return '接口可用';
  return '接口异常';
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

/** 状态卡下方的一组关键参数：标签在上、值在下，四列排布。 */
function Fact({ label, value, hint, mono = false }: { label: string; value: string; hint?: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">{label}</dt>
      <dd className={`mt-1 truncate text-[length:var(--font-body)] font-medium text-[var(--text-primary)] ${mono ? 'mono-font' : ''}`}>{value}</dd>
      {hint && <dd className="mt-0.5 truncate text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">{hint}</dd>}
    </div>
  );
}

function DetailRow({ label, value, mono = false, action }: {
  label: string;
  value: string;
  mono?: boolean;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] py-2.5 last:border-b-0">
      <span className="flex-shrink-0 text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">{label}</span>
      <span className="flex min-w-0 items-center gap-2">
        <span className={`truncate text-[length:var(--font-body)] text-[var(--text-primary)] ${mono ? 'mono-font' : ''}`}>{value}</span>
        {action}
      </span>
    </div>
  );
}

/**
 * API 服务页。
 *
 * 信息结构按「一个事实只出现一次」重排：
 * 1. 状态卡：现在能不能用、跑的是什么模型、端口 / 范围 / 槽位 / 协议；
 * 2. 用量卡（与对话同一端点，口径一致）；
 * 3. 连接信息：外部客户端接入所需的全部字段 + 鉴权管理入口；
 * 4. 高级设置：监听范围、端口、API Key 与调用示例（默认折叠）。
 *
 * 曾经的状态文案在页头、大卡标题、请求卡、页脚各出现一次，端口与模型名也重复出现，
 * 这些重复项已合并；检测时间、刷新频率、设备 KV 池、dsh 绑定等运行细节改由各自的
 * 专页（NiNfer / 日志）承载。
 */
export default function ApiStatusPage() {
  const { state, dispatch } = useApp();
  const [result, setResult] = useState<PingResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [engineLogs, setEngineLogs] = useState<string[]>([]);
  const [lanIp, setLanIp] = useState<string | null>(null);
  const [copiedBaseUrl, setCopiedBaseUrl] = useState(false);
  const checkingRef = useRef(false);
  const advancedRef = useRef<HTMLDetailsElement>(null);

  // ---- 服务后端：跟随「对话后端」选择（主模型 llama-server / NiNfer 引擎）----
  const engineStatuses = useEngineStatuses();
  const engine = fast27bServiceView(engineStatuses.fast27b);
  const engineMode = state.chatEngine === 'fast27b';
  // 引擎模式的真实运行数据（与 NiNfer 页共用同一份轮询快照，指标口径一致）。
  const engineMetrics = useFast27bMetrics();

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
  // started 与终止行，不必每 1.5 秒搬运整个 5000 行缓冲（NiNfer 页已有一份全量轮询）。
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

  // ---- 数据模块（解耦层）：界面不认识具体引擎，两种后端各自聚合出同一份视图模型 ----
  const engineUsage = useMemo(
    () => fast27bServiceUsage(engineMetrics, {
      title: fast27bModelDisplayName(engine.modelPath, engine.modelLabel),
      subtitle: 'NiNfer 引擎',
    }),
    [engineMetrics, engine.modelPath, engine.modelLabel],
  );
  const llamaUsage = useMemo(
    () => llamaServiceUsage(activeModel ? state.usageByModel[activeModel.id] : undefined, {
      title: activeModel ? activeModel.name : '主模型',
      subtitle: activeModel ? `${activeModel.params} ${activeModel.quant}` : '主模型',
    }),
    [activeModel, state.usageByModel],
  );
  const usageStats = engineMode ? engineUsage : llamaUsage;
  const usageNote = engineMode
    ? '统计最近 24 小时完成的请求，覆盖对话、dsh 与外部 API 调用。'
    : '统计当前主模型在本会话的累计用量，来自 llama.cpp 响应。';

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
  const serviceBaseUrl = engineMode
    ? `http://${engine.lan ? lanIp ?? '<本机局域网 IP>' : '127.0.0.1'}:${engine.port}/v1`
    : llamaBase;
  const serviceStandards = engineMode ? 'OpenAI Compatible' : standards;
  const serviceAuthRequired = engineMode ? Boolean(engine.apiKey) : Boolean(result?.apiKeyRequired);
  const slotTotal = engineMode ? FAST27B_MAX_CONCURRENCY : llamaSlotTotal;
  const slotUsed = engineMode
    ? (engineInFlight || appInFlight > 0 ? 1 : 0)
    : Math.min(llamaSlotTotal, appInFlight);
  const slotHint = engineMode
    ? '固定单并发（含外部客户端）'
    : '并行槽位（仅软件内对话）';
  const exposureLabel = serviceExposed
    ? `局域网 · ${engineMode ? '0.0.0.0' : bindHost ?? '0.0.0.0'}`
    : '仅本机';

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
  const manageTarget = engineMode ? openFast27bPage : openAdvancedSettings;
  const manageLabel = engineMode ? '到 NiNfer 页管理' : '管理监听与 Key';

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--app-bg)] text-[var(--text-primary)]">
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto w-full max-w-[1040px]">
          <PageHeader
            icon={Activity}
            eyebrow={`服务控制台 / API · ${engineMode ? engine.label : '主模型'}`}
            title="API 服务"
            description={engineMode
              ? `NiNfer 引擎自带的 OpenAI 兼容端点（端口 ${engine.port}，固定单并发）；切换对话后端即可在主模型与引擎之间切换。`
              : '本地 OpenAI / Anthropic 兼容接口。外部客户端用下方 Base URL 即可接入；参数修改后需重新加载模型生效。'}
            actions={(
              <>
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
              </>
            )}
          />

          {/* 另一个后端在跑时给出提示与一键切换，避免「引擎已启动但本页还是主模型」的困惑。 */}
          {!engineMode && engine.running && (
            <div className="accent-soft mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--radius-field)] px-4 py-3">
              <Zap className="h-4 w-4 flex-shrink-0 text-[var(--accent)]" />
              <span className="min-w-0 flex-1 text-[length:var(--font-caption)] text-[var(--text-secondary)]">
                NiNfer 引擎正在运行（端口 {engine.port}），本页当前描述的是主模型服务。
              </span>
              <button
                type="button"
                onClick={openFast27bPage}
                className="flex flex-shrink-0 items-center gap-1 text-[length:var(--font-caption)] font-bold text-[var(--accent)] transition-opacity hover:opacity-75"
              >
                前往 NiNfer 页
                <ArrowUpRight className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {/* ---- 状态卡：状态 + 模型 + 四项关键参数，一屏说清 ---- */}
          <section className="panel mt-4 p-5 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
                    <span className={`absolute -inset-1 rounded-full opacity-20 ${serviceHealthy ? 'bg-[var(--state-success)]' : 'bg-[var(--state-danger)]'}`} />
                    <span className={`absolute inset-0 rounded-full ${serviceHealthy ? 'bg-[var(--state-success)]' : 'bg-[var(--state-danger)]'}`} />
                  </span>
                  <h2 className="text-[length:var(--font-display)] font-bold tracking-[var(--tracking-tight)] text-[var(--text-primary)]">{serviceTitle}</h2>
                  <span className="rounded-[var(--radius-sm)] bg-[var(--surface-muted)] px-1.5 py-0.5 text-[length:var(--font-eyebrow)] text-[var(--text-secondary)]">
                    {engineMode ? engine.label : '主模型'}
                  </span>
                  {engineMode ? (
                    <StatusPill ok={engine.apiReachable} text="/v1/models" />
                  ) : (
                    <>
                      <StatusPill ok={Boolean(result?.healthOk)} text="/health" />
                      <StatusPill ok={Boolean(result?.modelsOk)} text="/v1/models" />
                    </>
                  )}
                </div>

                <div className="mono-font mt-3 truncate text-[length:var(--font-title)] font-semibold text-[var(--text-primary)]">{serviceModelName}</div>
                <div className="mt-0.5 text-[length:var(--font-caption)] text-[var(--text-secondary)]">{serviceModelNote}</div>
              </div>

              <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void copyBaseUrl()}
                  className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-field)] border border-[var(--border)] bg-[var(--surface)] px-3 text-[length:var(--font-body)] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)]"
                >
                  <Copy className="h-3.5 w-3.5" />
                  {copiedBaseUrl ? '已复制' : '复制 Base URL'}
                </button>
                <button
                  type="button"
                  onClick={manageTarget}
                  className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-field)] bg-[var(--accent)] px-3 text-[length:var(--font-body)] font-semibold text-[var(--text-on-accent)] transition-colors hover:bg-[var(--accent-hover)]"
                >
                  <KeyRound className="h-3.5 w-3.5" />
                  {manageLabel}
                </button>
              </div>
            </div>

            <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-[var(--border-subtle)] pt-4 sm:grid-cols-4">
              <Fact label="端口" value={String(servicePort)} mono />
              <Fact label="访问范围" value={exposureLabel} />
              <Fact
                label="请求槽位"
                value={serviceRunning ? `${slotUsed} / ${slotTotal}` : `— / ${slotTotal}`}
                hint={slotHint}
              />
              <Fact label="兼容协议" value={serviceStandards} />
            </dl>

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
                    到 NiNfer 页重启引擎
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            )}

            {!engineMode && result?.error && (
              <div className="mt-4 break-words text-[length:var(--font-caption)] text-[var(--state-danger)]">{result.error}</div>
            )}
            {!engineMode && !serviceRunning && (
              <div className="mt-4 flex items-center gap-2 text-[length:var(--font-caption)] text-[var(--text-secondary)]">
                <WifiOff className="h-3.5 w-3.5 flex-shrink-0" />
                服务未运行：先到模型页加载模型，服务会随模型启动。
              </div>
            )}
          </section>

          {/* ---- 用量：与对话同一端点，口径一致 ---- */}
          <div className="mt-3.5">
            <ServiceUsageCard stats={usageStats} note={usageNote} />
          </div>

          {/* ---- 连接信息：外部客户端需要的一切都在这一张卡里 ---- */}
          <section className="panel mt-3.5 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-[length:var(--font-body)] font-bold tracking-[var(--tracking-tight)] text-[var(--text-primary)]">连接信息</h2>
                <p className="mt-0.5 text-[length:var(--font-caption)] text-[var(--text-secondary)]">
                  外部客户端填 Base URL 即可调用；鉴权开启时另需 Bearer Token。
                </p>
              </div>
              <span className={`inline-flex flex-shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[length:var(--font-eyebrow)] font-bold ${
                serviceAuthRequired
                  ? 'bg-[var(--state-success-bg)] text-[var(--state-success)]'
                  : 'border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text-secondary)]'
              }`}>
                <KeyRound className="h-3.5 w-3.5" />
                {serviceAuthRequired ? 'API Key 已启用' : '无需鉴权'}
              </span>
            </div>

            <div className="accent-soft mt-3.5 flex items-center justify-between gap-3 rounded-[var(--radius-field)] px-3.5 py-3">
              <code className="mono-font min-w-0 truncate text-[length:var(--font-body)] text-[var(--accent)]" title={serviceBaseUrl}>{serviceBaseUrl}</code>
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

            <div className="mt-3 grid gap-x-8 sm:grid-cols-2">
              <DetailRow label="聊天接口" value="/v1/chat/completions" mono />
              <DetailRow label="当前模型" value={serviceModelName} mono />
              <DetailRow label="兼容协议" value={serviceStandards} />
              <DetailRow
                label="访问范围"
                value={exposureLabel}
                action={(
                  <button
                    type="button"
                    onClick={manageTarget}
                    className="flex-shrink-0 text-[length:var(--font-eyebrow)] font-bold text-[var(--accent)] transition-opacity hover:opacity-75"
                  >
                    修改
                  </button>
                )}
              />
            </div>
          </section>

          {/* 引擎模式的配置都在 NiNfer 页：这里不再重复参数表，只保留一句指引。 */}
          {engineMode ? (
            <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-[var(--radius-field)] border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-[length:var(--font-caption)] text-[var(--text-secondary)]">
              <Globe2 className="h-3.5 w-3.5 flex-shrink-0 text-[var(--accent)]" />
              引擎的端口、局域网访问与 API Key 都在 NiNfer 页配置。
              <button
                type="button"
                onClick={openFast27bPage}
                className="inline-flex items-center gap-1 font-bold text-[var(--accent)] transition-opacity hover:opacity-75"
              >
                前往 NiNfer 页
                <ArrowUpRight className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <details ref={advancedRef} className="panel group mt-3.5 overflow-hidden">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-[var(--surface-muted)] [&::-webkit-details-marker]:hidden">
                <span className="flex min-w-0 items-center gap-2.5">
                  <Globe2 className="h-4 w-4 flex-shrink-0 text-[var(--accent)]" />
                  <strong className="text-[length:var(--font-body)] font-semibold text-[var(--text-primary)]">高级设置</strong>
                  <span className="truncate text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">
                    监听范围、端口、API Key 与调用示例
                  </span>
                </span>
                <ChevronDown className="h-4 w-4 flex-shrink-0 text-[var(--text-tertiary)] transition-transform group-open:rotate-180" />
              </summary>
              <div className="border-t border-[var(--border-subtle)] px-5 py-4">
                <ExternalApiSection embedded />
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}
