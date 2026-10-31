import { useState } from 'react';
import { ChevronDown, ChevronUp, Database } from 'lucide-react';
import type {
  ServiceUsageStats,
  UsageTimelineRow,
} from '@/lib/serviceUsage';

type UsageTimeline = NonNullable<ServiceUsageStats['timeline']>;

/** 三大指标块：小标签 + 大数字 + 单位。 */
function StatTile({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="min-w-0 rounded-[var(--radius-field)] border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-4 py-3">
      <div className="text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">{label}</div>
      <div className="mt-1 flex items-baseline gap-1.5 overflow-hidden">
        <span className="mono-font truncate text-[20px] font-bold leading-tight tracking-[var(--tracking-tight)] text-[var(--text-primary)]">
          {value}
        </span>
        {unit && (
          <span className="flex-shrink-0 text-[length:var(--font-caption)] font-medium text-[var(--text-secondary)]">
            {unit}
          </span>
        )}
      </div>
    </div>
  );
}

/** 运行时间分布的一行：左侧标签 + 右侧时间轴条。 */
function TimelineRow({ row, windowStart, windowEnd }: {
  row: UsageTimelineRow;
  windowStart: number;
  windowEnd: number;
}) {
  const total = Math.max(1, windowEnd - windowStart);
  // 模型=品牌色，工具=成功绿，其他=中性灰；与截图的分行时间轴同构。
  const barColor = row.key === 'model'
    ? 'bg-[var(--accent)]'
    : row.key === 'tool'
      ? 'bg-[var(--state-success)]'
      : 'bg-[var(--text-tertiary)]';
  return (
    <div className="flex items-center gap-3">
      <span className="w-8 flex-shrink-0 text-[length:var(--font-eyebrow)] text-[var(--text-secondary)]">
        {row.label}
      </span>
      <div
        className="relative h-3 min-w-0 flex-1 overflow-hidden rounded-[3px] bg-[var(--surface-muted)]"
        aria-hidden="true"
      >
        {row.spans.map((span, index) => {
          const left = Math.max(0, ((span.start - windowStart) / total) * 100);
          const width = Math.min(
            100 - left,
            Math.max(((span.end - span.start) / total) * 100, 0.35),
          );
          if (width <= 0) return null;
          return (
            <span
              key={`${span.start}-${index}`}
              className={`absolute inset-y-[2px] rounded-[1px] ${barColor}`}
              style={{ left: `${left}%`, width: `${width}%` }}
              title={span.note}
            />
          );
        })}
      </div>
    </div>
  );
}

/** 运行时间分布区块：模型 / 工具 / 其他三行时间轴。 */
function TimelineSection({ timeline }: { timeline: UsageTimeline }) {
  return (
    <div className="mt-5 border-t border-[var(--border-subtle)] pt-4">
      <h3 className="text-[length:var(--font-caption)] font-semibold text-[var(--text-primary)]">
        运行时间分布
      </h3>
      <div className="mt-3 space-y-2.5">
        {timeline.rows.map((row) => (
          <TimelineRow
            key={row.key}
            row={row}
            windowStart={timeline.windowStart}
            windowEnd={timeline.windowEnd}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * API 服务页的数据模块（用量统计卡）。
 *
 * 只消费 ServiceUsageStats 中立视图模型，与具体引擎解耦；NiNfer / 主模型
 * 各自的聚合函数在 lib/serviceUsage.ts。无数据时渲染空态面板。
 */
export default function ServiceUsageCard({ stats, note }: {
  stats: ServiceUsageStats | null;
  /** 底部说明：统计口径（数据来源、时间窗）。 */
  note?: string;
}) {
  const [expanded, setExpanded] = useState(true);

  if (!stats) {
    return (
      <section className="panel p-6" aria-label="API 用量统计">
        <div className="flex items-center gap-3">
          <Database className="h-5 w-5 flex-shrink-0 text-[var(--text-tertiary)]" />
          <div className="min-w-0">
            <div className="text-[length:var(--font-body)] font-semibold text-[var(--text-primary)]">
              暂无运行数据
            </div>
            <p className="mt-0.5 text-[length:var(--font-caption)] text-[var(--text-secondary)]">
              {note ?? '完成一次请求后，这里会显示真实 token 用量。'}
            </p>
          </div>
        </div>
      </section>
    );
  }

  const hasBody = stats.details.some((detail) => detail.value !== null)
    || stats.inputTokens !== null
    || stats.outputTokens !== null
    || stats.timeline !== null;
  const updatedAtText = stats.updatedAt
    ? new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).format(new Date(stats.updatedAt))
    : null;

  return (
    <section className="panel p-6" aria-label="API 用量统计">
      <header className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-full bg-[var(--surface-muted)] text-[length:var(--font-body)] font-bold text-[var(--accent)]">
            {stats.initial}
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-[length:var(--font-title)] font-bold tracking-[var(--tracking-tight)] text-[var(--text-primary)]">
              {stats.title}
            </h2>
            <div className="mt-0.5 flex items-center gap-2 text-[length:var(--font-caption)] text-[var(--text-secondary)]">
              <span className="truncate">{stats.subtitle}</span>
              {stats.activeRequests > 0 && (
                <span className="flex-shrink-0 rounded-full bg-[var(--state-warning-bg)] px-2 py-0.5 text-[length:var(--font-eyebrow)] font-bold text-[var(--state-warning)]">
                  {stats.activeRequests} 个请求进行中
                </span>
              )}
            </div>
          </div>
        </div>
        {updatedAtText && (
          <time className="flex-shrink-0 text-[length:var(--font-caption)] text-[var(--text-tertiary)]">
            {updatedAtText}
          </time>
        )}
      </header>

      {hasBody ? (
        <>
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <StatTile
              label="输入"
              value={stats.inputTokens === null ? '—' : stats.inputTokens.toLocaleString('zh-CN')}
              unit="Tokens"
            />
            <StatTile
              label="输出"
              value={stats.outputTokens === null ? '—' : stats.outputTokens.toLocaleString('zh-CN')}
              unit="Tokens"
            />
            <StatTile
              label="模型生成 TPS"
              value={stats.generationTps === null ? '—' : stats.generationTps.toFixed(1)}
              unit="Token/秒"
            />
          </div>

          {expanded && (
            <div className="mt-5">
              <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
                {stats.details.map((detail) => (
                  <div key={detail.label} className="min-w-0">
                    <div className="text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">
                      {detail.label}
                    </div>
                    <div className="mono-font mt-0.5 flex items-baseline gap-1.5 truncate text-[14px] font-semibold text-[var(--text-primary)]">
                      <span className="truncate">{detail.value ?? '—'}</span>
                      {detail.value !== null && detail.unit && (
                        <span className="flex-shrink-0 text-[length:var(--font-caption)] font-normal text-[var(--text-secondary)]">
                          {detail.unit}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {stats.timeline && <TimelineSection timeline={stats.timeline} />}
            </div>
          )}

          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            className="mt-4 flex w-full items-center justify-center gap-1.5 border-t border-[var(--border-subtle)] pt-3 text-[length:var(--font-caption)] font-semibold text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
          >
            {expanded ? '收起信息' : '展开信息'}
            {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        </>
      ) : (
        <p className="mt-4 text-[length:var(--font-caption)] text-[var(--text-secondary)]">
          暂无可统计的请求读数。
        </p>
      )}

      {note && (
        <p className="mt-3 text-[length:var(--font-eyebrow)] leading-relaxed text-[var(--text-tertiary)]">
          {note}
        </p>
      )}
    </section>
  );
}
