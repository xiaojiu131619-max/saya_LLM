import { useEffect, useRef, useState, type ComponentType } from 'react';
import { Activity, CheckCircle2, Clock3, KeyRound, Loader2, RefreshCw, Server, ShieldCheck, WifiOff, XCircle } from 'lucide-react';
import { getDesktopServerLogs, pingLocalApi, type PingResult } from '@/lib/desktop';
import { useApp } from '@/context/AppContext';

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

function StatusPill({ ok, text }: { ok: boolean; text: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${ok ? 'bg-[#E7F1E4] text-[#4E7751] dark:bg-[#1F3224] dark:text-[#98D19C]' : 'bg-[#F6E4DE] text-[#B4563B] dark:bg-[#3A241C] dark:text-[#F0987C]'}`}>
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
    <div className="rounded-xl border border-[#E1DCD0] bg-[#FAF9F5] p-4 dark:border-white/[0.08] dark:bg-white/[0.04]">
      <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-[#7D766B] dark:text-[#BDB4A7]">
        <Icon className="h-4 w-4 text-[#D7663E]" />
        {label}
      </div>
      <div className="mono-font break-all text-lg font-semibold text-[#2F2C26] dark:text-[#F3EBDD]">{value}</div>
      {note && <div className="mt-1 text-xs text-[#8D867A] dark:text-[#A9A095]">{note}</div>}
    </div>
  );
}

export default function ApiStatusPage() {
  const { state } = useApp();
  const [result, setResult] = useState<PingResult | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);
  const checkingRef = useRef(false);

  const runCheck = async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    try {
      const [nextResult, nextLogs] = await Promise.all([
        pingLocalApi(),
        getDesktopServerLogs(),
      ]);
      setResult(nextResult);
      setLogs(nextLogs.slice(-8));
      setLastCheckedAt(new Date());
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
  };

  useEffect(() => {
    void runCheck();
    const timer = window.setInterval(() => void runCheck(), 5000);
    return () => window.clearInterval(timer);
  }, []);

  const apiBase = `http://${state.apiConfig.host === '0.0.0.0' ? '127.0.0.1' : state.apiConfig.host}:${state.serverPort}`;
  const healthy = Boolean(result?.reachable);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[#FBFAF6] text-[#2F2C26] dark:bg-[#171512] dark:text-[#F3EBDD]">
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-5xl">
          <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h1 className="text-2xl font-bold text-primary-custom">API 状态</h1>
              <p className="mt-1 text-sm leading-6 text-secondary-custom">
                每 5 秒自动检测本地 OpenAI 兼容接口，展示端点可达性、延迟和模型列表。
              </p>
            </div>
            <button
              type="button"
              onClick={() => void runCheck()}
              disabled={checking}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-[#DED8CC] bg-[#FAF9F5] px-4 py-2 text-sm font-semibold text-[#403C32] transition-colors hover:bg-[#F1EEE7] focus:outline-none focus:ring-2 focus:ring-[#D7663E]/40 disabled:opacity-60 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[#F3EBDD] dark:hover:bg-white/[0.08]"
            >
              {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              立即检测
            </button>
          </div>

          <section className="mb-4 rounded-2xl border border-[#E1DCD0] bg-[#F8F6F1] p-5 shadow-sm dark:border-white/[0.08] dark:bg-[#1C1A16]">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex items-start gap-3">
                <div className={`grid h-11 w-11 flex-shrink-0 place-items-center rounded-xl ${healthy ? 'bg-[#E7F1E4] text-[#4E7751] dark:bg-[#1F3224] dark:text-[#98D19C]' : 'bg-[#F6E4DE] text-[#B4563B] dark:bg-[#3A241C] dark:text-[#F0987C]'}`}>
                  {healthy ? <Activity className="h-5 w-5" /> : <WifiOff className="h-5 w-5" />}
                </div>
                <div>
                  <div className="text-lg font-semibold text-[#2F2C26] dark:text-[#F3EBDD]">{statusText(result, state.serverRunning)}</div>
                  <div className="mt-1 text-sm text-[#8D867A] dark:text-[#A9A095]">上次检测：{formatTime(lastCheckedAt)}</div>
                  {result?.error && <div className="mt-2 text-sm text-[#B4563B] dark:text-[#F0987C]">{result.error}</div>}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <StatusPill ok={state.serverRunning} text={state.serverRunning ? '服务运行中' : '服务未运行'} />
                <StatusPill ok={Boolean(result?.healthOk)} text="/health" />
                <StatusPill ok={Boolean(result?.modelsOk)} text="/v1/models" />
              </div>
            </div>
          </section>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <InfoCard icon={Server} label="接口地址" value={apiBase} note={state.apiConfig.enabled ? '已允许对外访问' : '仅本机访问'} />
            <InfoCard icon={Clock3} label="响应延迟" value={result?.latencyMs != null ? `${result.latencyMs} ms` : '--'} note="基于 /health 请求" />
            <InfoCard icon={ShieldCheck} label="状态码" value={result?.statusCode ? String(result.statusCode) : '--'} note="/health HTTP 状态" />
            <InfoCard icon={KeyRound} label="API Key" value={state.apiConfig.hasApiKey ? '已设置' : '未设置'} note={state.apiConfig.hasApiKey ? '外部请求需携带 Bearer Token' : '局域网开放时不建议留空'} />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]">
            <section className="rounded-2xl border border-[#E1DCD0] bg-[#FAF9F5] p-5 dark:border-white/[0.08] dark:bg-white/[0.04]">
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className="text-[15px] font-semibold text-primary-custom">模型端点</h2>
                <span className="text-xs text-secondary-custom">{result?.models.length ?? 0} 个模型</span>
              </div>
              {result?.models.length ? (
                <div className="space-y-2">
                  {result.models.map((model) => (
                    <div key={model} className="mono-font rounded-lg bg-black/[0.04] px-3 py-2 text-xs text-[#403C32] dark:bg-white/[0.05] dark:text-[#F3EBDD]">
                      {model}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-[#DCD8CF] px-4 py-8 text-center text-sm text-secondary-custom dark:border-white/[0.10]">
                  {state.serverRunning ? '暂无模型数据，等待 /v1/models 返回有效结果。' : '加载模型并启动服务后会显示模型列表。'}
                </div>
              )}
            </section>

            <section className="rounded-2xl border border-[#E1DCD0] bg-[#FAF9F5] p-5 dark:border-white/[0.08] dark:bg-white/[0.04]">
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className="text-[15px] font-semibold text-primary-custom">服务日志摘要</h2>
                <span className="text-xs text-secondary-custom">最近 {logs.length} 条</span>
              </div>
              {logs.length ? (
                <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                  {logs.map((line, index) => (
                    <div key={`${index}-${line}`} className="mono-font rounded-lg bg-black/[0.04] px-3 py-2 text-[11px] leading-5 text-[#625B50] dark:bg-white/[0.05] dark:text-[#BDB4A7]">
                      {line}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-[#DCD8CF] px-4 py-8 text-center text-sm text-secondary-custom dark:border-white/[0.10]">
                  暂无服务日志。
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
