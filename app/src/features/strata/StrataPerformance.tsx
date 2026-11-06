import { useId, useMemo, useState, type ReactNode } from 'react';
import { Activity, Clock3, Gauge, Layers3, Timer, Zap } from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { StrataMetricsSnapshot } from '@/lib/ipc/strata';
import {
  finishLabel,
  formatStrataLatency,
  formatStrataRate,
  strataPerformanceData,
  type StrataTimeRange,
} from '@/lib/strataMetrics';

/**
 * Strata 的性能监测面板——与 NiNfer 页那块同一套版式与读数口径，
 * 直接复用 `fast27b-*` 的卡片/图表样式（同一套设计语言，两份 CSS 迟早会漂移）。
 *
 * 数据来自网关 `/metrics` 的请求历史，由 Rust 侧增量采集后下发；
 * 这里只做汇总与绘制，不推算任何网关没报的读数。
 */

const tooltipStyle = {
  background: 'var(--surface-raised)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-lg)',
  color: 'var(--text-primary)',
  fontSize: 'var(--font-caption)',
};
const axisStyle = {
  fill: 'var(--text-tertiary)',
  fontSize: 'var(--font-eyebrow)',
  fontFamily: 'var(--font-mono)',
};

function timeLabel(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function tooltipTime(timestamp: number) {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function MetricRow({
  icon,
  label,
  value,
  unit,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  unit?: string;
}) {
  return (
    <div className="fast27b-metric-row">
      <span className="flex items-center gap-1.5 text-secondary-custom">
        {icon}
        {label}
      </span>
      <strong className="mono-font text-primary-custom">
        {value}
        {unit && <small className="ml-1 font-normal text-secondary-custom">{unit}</small>}
      </strong>
    </div>
  );
}

function ChartSection({
  title,
  note,
  icon,
  children,
}: {
  title: string;
  note: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="fast27b-chart-panel" aria-label={title}>
      <div className="mb-3 flex items-start gap-2">
        <span className="mt-0.5 text-secondary-custom">{icon}</span>
        <div className="min-w-0">
          <h3 className="text-[length:var(--font-caption)] font-semibold text-primary-custom">{title}</h3>
          <p className="mt-0.5 text-[length:var(--font-eyebrow)] text-secondary-custom">{note}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function EmptyChart({ title }: { title: string }) {
  return (
    <div className="fast27b-empty-chart" role="status">
      <Activity className="h-5 w-5 text-[var(--accent)] opacity-70" />
      <p className="text-center text-[length:var(--font-eyebrow)] text-secondary-custom">{title}</p>
      <p className="text-center text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">
        请求完成后自动绘制
      </p>
    </div>
  );
}

export default function StrataPerformance({
  metrics,
  desktop,
  compact = false,
  modelLabel = 'Gyro-M',
}: {
  metrics: StrataMetricsSnapshot | null;
  desktop: boolean;
  compact?: boolean;
  modelLabel?: string;
}) {
  const [range, setRange] = useState<StrataTimeRange>(compact ? 1 : 24);
  const [openedAt] = useState(() => Date.now());
  const id = useId().replace(/:/g, '');
  const now = metrics?.collected_at ?? openedAt;
  const data = useMemo(
    () => strataPerformanceData(metrics?.requests ?? [], now, range),
    [metrics, now, range],
  );
  const { summary, trends } = data;
  const hasLatency = trends.some((point) => point.ttftMs !== null);
  const hasThroughput = trends.some((point) => point.decodeTps !== null);
  const recent = [...data.requests].reverse().slice(0, 8);
  const rangeLabel = `最近 ${range} 小时`;
  const formatTps = (value: number | null) => (value === null ? '—' : value.toFixed(1));

  return (
    <div className="fast27b-performance space-y-3">
      <div className="fast27b-performance-toolbar">
        <div>
          <h2 className="flex items-center gap-2 text-[length:var(--font-body)] font-semibold text-primary-custom">
            <Activity className="h-4 w-4 text-[var(--accent)]" />
            Strata · 性能监测
          </h2>
          <p className="mt-1 text-[length:var(--font-eyebrow)] text-secondary-custom">
            {desktop ? '对话与外部 API 的真实运行数据' : '桌面端启动引擎后开始采集'}
            {(metrics?.active_requests ?? 0) > 0 && (
              <span className="ml-2 text-[var(--accent)]">{metrics?.active_requests} 个请求进行中</span>
            )}
          </p>
        </div>
        <div className="fast27b-range" role="group" aria-label="统计时间范围">
          {([1, 6, 24] as const).map((hours) => (
            <button key={hours} type="button" aria-pressed={range === hours} onClick={() => setRange(hours)}>
              {hours} 小时
            </button>
          ))}
        </div>
      </div>

      <div className="fast27b-summary-grid">
        <section className="fast27b-chart-panel fast27b-metrics-panel" aria-label="运行指标">
          <h3 className="mb-1 text-[length:var(--font-caption)] font-semibold text-primary-custom">
            运行指标 <span className="ml-1 font-normal text-secondary-custom">{rangeLabel}</span>
          </h3>
          <MetricRow
            icon={<Gauge className="h-3.5 w-3.5" />}
            label="生成速度"
            value={formatTps(summary.decodeTps)}
            unit={summary.decodeTps === null ? undefined : 'tok/s'}
          />
          <MetricRow
            icon={<Timer className="h-3.5 w-3.5" />}
            label="首字延迟"
            value={formatStrataLatency(summary.ttftMs)}
          />
          <MetricRow
            icon={<Clock3 className="h-3.5 w-3.5" />}
            label="平均耗时"
            value={formatStrataLatency(summary.totalMs)}
          />
        </section>
        <section className="fast27b-chart-panel fast27b-model-performance" aria-label="当前模型性能">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-[length:var(--font-caption)] font-semibold text-primary-custom">
              <Layers3 className="h-3.5 w-3.5 text-[var(--accent)]" />
              {modelLabel}
            </h3>
            <span className="fast27b-spec-badge">MoE</span>
          </div>
          <div className="fast27b-model-facts">
            <div>
              <span>草稿接受率</span>
              <strong>{formatStrataRate(summary.draftRate)}</strong>
            </div>
            <div>
              <span>缓存命中率</span>
              <strong>{formatStrataRate(summary.cacheRate)}</strong>
            </div>
            <div>
              <span>累计输出</span>
              <strong>
                {summary.outputTokens.toLocaleString()} <small>token</small>
              </strong>
            </div>
            <div>
              <span>请求数</span>
              <strong>
                {data.requests.length.toLocaleString()} <small>次</small>
              </strong>
            </div>
          </div>
        </section>
      </div>

      <div className="fast27b-trend-grid">
        <ChartSection
          title="生成速度趋势"
          note={`${rangeLabel} · ${data.bucketMinutes} 分钟平均 TPS`}
          icon={<Zap className="h-3.5 w-3.5" />}
        >
          {hasThroughput ? (
            <div
              className="fast27b-chart"
              role="img"
              aria-label={`Strata 生成速度折线图，平均 ${formatTps(summary.decodeTps)} tok/s`}
            >
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trends} margin={{ top: 8, right: 5, bottom: 0, left: -8 }}>
                  <defs>
                    <linearGradient id={`${id}-speed`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.18} />
                      <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 5" vertical={false} />
                  <XAxis
                    dataKey="timestamp"
                    tickFormatter={timeLabel}
                    tick={axisStyle}
                    axisLine={{ stroke: 'var(--border)' }}
                    tickLine={false}
                    minTickGap={32}
                  />
                  <YAxis tick={axisStyle} tickLine={false} axisLine={false} width={40} tickCount={4} />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    labelFormatter={(value) => tooltipTime(Number(value))}
                    formatter={(value: number) => [`${value.toFixed(1)} tok/s`, '平均 TPS']}
                  />
                  <Area
                    name="平均 TPS"
                    type="linear"
                    dataKey="decodeTps"
                    stroke="var(--accent)"
                    strokeWidth={2}
                    fill={`url(#${id}-speed)`}
                    dot={{ r: 2.5, fill: 'var(--accent)', stroke: 'var(--surface)', strokeWidth: 1 }}
                    activeDot={{ r: 4 }}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <EmptyChart title="所选时段暂无速度数据" />
          )}
        </ChartSection>
        <ChartSection
          title="首字延迟趋势"
          note={`${rangeLabel} · ${data.bucketMinutes} 分钟平均 TTFT`}
          icon={<Timer className="h-3.5 w-3.5" />}
        >
          {hasLatency ? (
            <div
              className="fast27b-chart"
              role="img"
              aria-label={`Strata 首字延迟折线图，平均 ${formatStrataLatency(summary.ttftMs)}`}
            >
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trends} margin={{ top: 8, right: 5, bottom: 0, left: -8 }}>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 5" vertical={false} />
                  <XAxis
                    dataKey="timestamp"
                    tickFormatter={timeLabel}
                    tick={axisStyle}
                    axisLine={{ stroke: 'var(--border)' }}
                    tickLine={false}
                    minTickGap={32}
                  />
                  <YAxis
                    tickFormatter={formatStrataLatency}
                    tick={axisStyle}
                    tickLine={false}
                    axisLine={false}
                    width={40}
                    tickCount={4}
                  />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    labelFormatter={(value) => tooltipTime(Number(value))}
                    formatter={(value: number) => [formatStrataLatency(value), '平均首字延迟']}
                  />
                  <Line
                    name="平均首字延迟"
                    type="linear"
                    dataKey="ttftMs"
                    stroke="var(--accent)"
                    strokeWidth={2}
                    dot={{ r: 2.5, fill: 'var(--accent)', stroke: 'var(--surface)', strokeWidth: 1 }}
                    activeDot={{ r: 4 }}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <EmptyChart title="所选时段暂无延迟数据" />
          )}
        </ChartSection>
      </div>

      {!compact && recent.length > 0 && (
        <details className="fast27b-chart-panel">
          <summary className="cursor-pointer text-[length:var(--font-caption)] font-medium text-primary-custom">
            最近请求 <span className="ml-2 font-normal text-secondary-custom">查看耗时与收尾原因</span>
          </summary>
          <div className="mt-3 overflow-x-auto">
            <table className="fast27b-performance-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>状态</th>
                  <th>TPS</th>
                  <th>首字延迟</th>
                  <th>总耗时</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((request) => (
                  <tr key={request.id}>
                    <th>
                      <span className="mono-font">{timeLabel(request.finished_at)}</span>
                      <span className="ml-2 font-normal text-secondary-custom">#{request.request_id}</span>
                    </th>
                    <td>
                      <span
                        className={
                          request.outcome === 'success'
                            ? 'text-[var(--state-success)]'
                            : request.outcome === 'failed'
                              ? 'text-[var(--state-danger)]'
                              : 'text-secondary-custom'
                        }
                      >
                        {request.outcome === 'success'
                          ? '完成'
                          : request.outcome === 'failed'
                            ? '失败'
                            : '已取消'}
                      </span>
                      {request.finish && (
                        <span className="mt-1 block text-[length:var(--font-eyebrow)] text-secondary-custom">
                          {finishLabel(request.finish)}
                        </span>
                      )}
                    </td>
                    <td>{formatTps(request.decode_tps)}</td>
                    <td>{formatStrataLatency(request.ttft_ms)}</td>
                    <td>{formatStrataLatency(request.total_ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      <p className="text-[length:var(--font-eyebrow)] leading-relaxed text-[var(--text-tertiary)]">
        保留最近 24 小时最多 5,000 条请求，数据来自网关 `/metrics` 的请求历史（网关重启会清空它自己那份，
        本机已采集的部分不受影响）。速度与延迟只统计完成请求；空白时段表示没有样本。
      </p>
    </div>
  );
}
