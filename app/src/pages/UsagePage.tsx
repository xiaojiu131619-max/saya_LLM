import { useMemo, useState } from 'react';
import { Activity, BarChart3, CalendarDays, ChevronDown, ChevronUp, Gauge, Hash, PieChart, Trophy } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import type { LucideIcon } from 'lucide-react';
import PageHeader from '@/components/PageHeader';

function yearDays() {
  const now = new Date();
  const year = now.getFullYear();
  const days = Math.floor((new Date(year + 1, 0, 1).getTime() - new Date(year, 0, 1).getTime()) / 86400000);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(year, 0, index + 1);
    return date.toISOString().slice(0, 10);
  });
}

function heatmapCells(days: string[]) {
  const firstDay = new Date(`${days[0]}T00:00:00`).getDay();
  const leading = Array.from({ length: firstDay }, () => null);
  return [...leading, ...days];
}

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];
const MONTH_LABELS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

// 离散色阶：0=无记录，1-4 由浅到深。GitHub 贡献图风格，避免连续 opacity 发灰。
const HEATMAP_LEVELS_LIGHT = ['var(--border)', 'var(--state-danger-border)', 'var(--state-danger-border)', 'var(--accent-hover)', 'var(--accent-hover)'];
const HEATMAP_LEVELS_DARK = ['rgba(255,255,255,0.06)', 'var(--accent)', 'var(--accent)', 'var(--accent)', 'var(--accent)'];

// 大数字计数：>=1e9 用 B，>=1e6 用 M，>=1e3 用 K，否则原样。1.24M / 512K / 8K 风格。
function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(abs >= 1e10 ? 0 : 2).replace(/\.?0+$/, '')}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(abs >= 1e7 ? 1 : 2).replace(/\.?0+$/, '')}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(abs >= 1e4 ? 1 : 2).replace(/\.?0+$/, '')}K`;
  return value.toLocaleString();
}

function tokenLevel(tokens: number, maxTokens: number): number {
  if (tokens <= 0) return 0;
  const ratio = tokens / maxTokens;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

interface HeatmapWeek {
  days: Array<string | null>;
  monthLabel: string | null;
}

// 把按天排列的格子切成「周列」（每列 7 天，行=星期日..六），
// 并为每个月第一次出现的周列标注月份标签。
function buildHeatmapWeeks(cells: Array<string | null>): HeatmapWeek[] {
  const weeks: HeatmapWeek[] = [];
  let lastMonth = -1;
  for (let i = 0; i < cells.length; i += 7) {
    const days = cells.slice(i, i + 7);
    while (days.length < 7) days.push(null);
    const firstRealDay = days.find((day): day is string => Boolean(day));
    let monthLabel: string | null = null;
    if (firstRealDay) {
      const month = new Date(`${firstRealDay}T00:00:00`).getMonth();
      if (month !== lastMonth) {
        monthLabel = MONTH_LABELS[month];
        lastMonth = month;
      }
    }
    weeks.push({ days, monthLabel });
  }
  return weeks;
}

export default function UsagePage() {
  const { state } = useApp();
  const [usageExpanded, setUsageExpanded] = useState(false);
  const days = useMemo(() => yearDays(), []);
  const cells = useMemo(() => heatmapCells(days), [days]);
  const heatmapWeeks = useMemo(() => buildHeatmapWeeks(cells), [cells]);
  const heatmapPalette = state.theme === 'dark' ? HEATMAP_LEVELS_DARK : HEATMAP_LEVELS_LIGHT;
  const usageEntries = Object.entries(state.usageByModel);
  const usageValues = usageEntries.map(([, usage]) => usage);
  const modelById = new Map(state.models.map((model) => [model.id, model]));
  const totals = usageValues.reduce(
    (acc, usage) => ({
      promptTokens: acc.promptTokens + usage.promptTokens,
      completionTokens: acc.completionTokens + usage.completionTokens,
      totalTokens: acc.totalTokens + usage.totalTokens,
      responseCount: acc.responseCount + usage.responseCount,
      totalTokensPerSec: acc.totalTokensPerSec + usage.totalTokensPerSec,
      totalFirstTokenDelay: acc.totalFirstTokenDelay + (usage.totalFirstTokenDelay ?? 0),
      totalGenTime: acc.totalGenTime + (usage.totalGenTime ?? 0),
    }),
    { promptTokens: 0, completionTokens: 0, totalTokens: 0, responseCount: 0, totalTokensPerSec: 0, totalFirstTokenDelay: 0, totalGenTime: 0 }
  );

  const dailyTotals = days.map((day) => ({
    day,
    tokens: usageValues.reduce((sum, usage) => sum + (usage.dailyTokens[day] ?? 0), 0),
  }));
  const maxDayTokens = Math.max(1, ...dailyTotals.map((day) => day.tokens));
  const dailyTokensByDay = new Map(dailyTotals.map((item) => [item.day, item.tokens]));
  const activeDayCount = dailyTotals.filter((item) => item.tokens > 0).length;
  const avgTokensPerSec = totals.responseCount > 0 && totals.totalTokensPerSec > 0
    ? totals.totalTokensPerSec / totals.responseCount
    : 0;
  const avgFirstTokenDelay = totals.responseCount > 0 && totals.totalFirstTokenDelay > 0
    ? totals.totalFirstTokenDelay / totals.responseCount
    : 0;
  const avgGenTime = totals.responseCount > 0 && totals.totalGenTime > 0
    ? totals.totalGenTime / totals.responseCount
    : 0;
  const modelUsage = usageEntries
    .map(([modelId, usage]) => {
      const model = modelById.get(modelId);
      return {
        id: modelId,
        name: model?.name ?? usage.modelName ?? modelId,
        color: model?.themeColorSolid ?? usage.modelColor ?? 'var(--accent)',
        usage,
      };
    })
    .filter((item) => item.usage.totalTokens > 0)
    .sort((a, b) => b.usage.totalTokens - a.usage.totalTokens);
  const currentYear = new Date().getFullYear();

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-[var(--app-bg)] text-[var(--text-primary)] dark:bg-[var(--app-bg)] dark:text-[var(--text-primary)]">
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-[1100px]">
          <PageHeader icon={BarChart3} title="使用详情" description="真实用量数据来自 llama.cpp 响应。" className="anim-fade-rise mb-6" />

          <div className="mb-1 grid grid-cols-2 lg:grid-cols-4">
            <MetricCard icon={Hash} label="总令牌数（Token）" value={formatCount(totals.totalTokens)} delay={0} />
            <MetricCard icon={Activity} label="输入令牌" value={formatCount(totals.promptTokens)} delay={40} />
            <MetricCard icon={CalendarDays} label="输出令牌" value={formatCount(totals.completionTokens)} delay={80} />
            <MetricCard icon={Gauge} label="平均速度（tok/s）" value={avgTokensPerSec > 0 ? avgTokensPerSec.toFixed(1) : '暂无'} delay={120} />
          </div>

          <div className="mb-2 grid grid-cols-1 sm:grid-cols-3">
            <MetricCard icon={Activity} label="真实响应次数" value={totals.responseCount.toLocaleString()} delay={160} />
            <MetricCard icon={Gauge} label="平均首字延迟" value={avgFirstTokenDelay > 0 ? `${avgFirstTokenDelay.toFixed(2)}s` : '暂无'} delay={200} />
            <MetricCard icon={CalendarDays} label="平均输出用时" value={avgGenTime > 0 ? `${avgGenTime.toFixed(2)}s` : '暂无'} delay={240} />
          </div>

          <div className="anim-fade-rise mb-5 border-b border-[var(--border-subtle)] py-5" style={{ animationDelay: '120ms' }}>
            <div className="mb-5 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <CalendarDays className="h-4 w-4 flex-shrink-0 text-[var(--accent)]" />
                <h2 className="text-sm font-semibold text-[var(--text-primary)] dark:text-[var(--text-primary)]">{currentYear} 年 Token 热力图</h2>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">{activeDayCount} 天有记录</span>
              </div>
            </div>
            <div className="overflow-x-auto overscroll-x-contain pb-3 [scrollbar-color:var(--accent)_var(--surface-muted)] [scrollbar-width:thin] dark:[scrollbar-color:var(--accent)_var(--surface-muted)">
              <div className="w-max min-w-[820px]">
                {/* 月份标签 */}
                <div className="mb-1.5 flex pl-9 text-[10px] leading-none text-[var(--text-tertiary)] dark:text-[var(--text-tertiary)]">
                  {heatmapWeeks.map((week, weekIndex) => (
                    <div key={weekIndex} className="w-[15px] flex-shrink-0">
                      {week.monthLabel ? <span className="relative -left-px whitespace-nowrap">{week.monthLabel}</span> : null}
                    </div>
                  ))}
                </div>
                <div className="flex">
                  {/* 星期标签 */}
                  <div className="mr-1.5 flex w-9 flex-shrink-0 flex-col gap-[3px] text-[10px] leading-[12px] text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">
                    {WEEKDAY_LABELS.map((label, rowIndex) => (
                      <div key={rowIndex} className="flex h-3 items-center justify-end pr-0.5">{rowIndex % 2 === 1 ? label : ''}</div>
                    ))}
                  </div>
                  {/* 格子 */}
                  <div className="flex gap-[3px]">
                    {heatmapWeeks.map((week, weekIndex) => (
                      <div key={weekIndex} className="flex flex-col gap-[3px]">
                        {week.days.map((day, rowIndex) => {
                          if (!day) {
                            return <div key={`blank-${weekIndex}-${rowIndex}`} className="h-3 w-3" />;
                          }
                          const tokens = dailyTokensByDay.get(day) ?? 0;
                          const level = tokenLevel(tokens, maxDayTokens);
                          return (
                            <div
                              key={day}
                              title={`${day}：${formatCount(tokens)} 个 Token`}
                              className="h-3 w-3 flex-shrink-0 rounded-[3px] transition-transform duration-150 hover:scale-125 hover:ring-1 hover:ring-[var(--accent)]/60"
                              style={{ background: heatmapPalette[level] }}
                            />
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>
                {/* 图例 */}
                <div className="mt-3 flex items-center justify-end gap-1.5 pr-0.5 text-[10px] leading-none text-[var(--text-tertiary)] dark:text-[var(--text-tertiary)]">
                  <span>少</span>
                  {heatmapPalette.map((color, index) => (
                    <span
                      key={index}
                      className="h-[14px] w-[14px] rounded-[3px]"
                      style={{ background: color }}
                    />
                  ))}
                  <span>多</span>
                </div>
              </div>
            </div>
          </div>

          <div className="anim-fade-rise border-b border-[var(--border-subtle)] py-5" style={{ animationDelay: '180ms' }}>
            <div className="mb-5 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <PieChart className="h-4 w-4 flex-shrink-0 text-[var(--accent)]" />
                <h2 className="text-sm font-semibold text-[var(--text-primary)] dark:text-[var(--text-primary)]">模型使用占比</h2>
              </div>
              <span className="text-[11px] text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">按真实 token 总量排序</span>
            </div>
            {modelUsage.length > 0 ? (
              <div className="grid grid-cols-1 items-center gap-6 lg:grid-cols-[220px_1fr]">
                <DonutChart items={modelUsage.map(({ id, name, color, usage }) => ({
                  id,
                  label: name,
                  value: usage.totalTokens,
                  color,
                }))} />
                <div className="space-y-2.5">
                  {(usageExpanded ? modelUsage : modelUsage.slice(0, 5)).map(({ id, name, color, usage }, index) => (
                    <UsageRankRow
                      key={id}
                      rank={index + 1}
                      name={name}
                      tokens={usage.totalTokens}
                      total={totals.totalTokens}
                      color={color}
                      responseCount={usage.responseCount}
                      avgTokensPerSec={usage.responseCount > 0 ? usage.totalTokensPerSec / usage.responseCount : 0}
                      lastUsedAt={usage.lastUsedAt}
                    />
                  ))}
                  {modelUsage.length > 5 && (
                    <button
                      type="button"
                      onClick={() => setUsageExpanded((value) => !value)}
                      className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--app-bg)] py-2 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-[var(--text-secondary)] dark:hover:bg-white/[0.07]"
                    >
                      {usageExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                      {usageExpanded ? '收起' : `展开全部（共 ${modelUsage.length} 个）`}
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="py-8 text-center text-sm text-[var(--text-secondary)]">
                暂无真实 token 使用记录。
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function DonutChart({ items }: { items: Array<{ id: string; label: string; value: number; color: string }> }) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  let cursor = 0;
  const segments = items.map((item) => {
    const start = total > 0 ? (cursor / total) * 100 : 0;
    cursor += item.value;
    const end = total > 0 ? (cursor / total) * 100 : 0;
    return `${item.color} ${start}% ${end}%`;
  });
  const top = items[0];

  return (
    <div className="flex flex-col items-center justify-center">
      <div
        title={items.map((item) => `${item.label}：${formatCount(item.value)} Token`).join('\n')}
        className="relative flex h-44 w-44 items-center justify-center rounded-full"
        style={{ background: total > 0 ? `conic-gradient(${segments.join(', ')})` : 'rgba(128,128,128,0.12)' }}
      >
        <div className="flex h-28 w-28 flex-col items-center justify-center rounded-full border border-[var(--border)] bg-[var(--app-bg)] px-3 text-center shadow-sm dark:border-white/[0.08] dark:bg-[var(--surface-raised)]">
          <Trophy className="mb-1 h-4 w-4 text-[var(--state-warning)]" />
          <div className="text-[11px] text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">最多使用</div>
          <div className="max-w-full truncate text-xs font-semibold text-[var(--text-primary)] dark:text-[var(--text-primary)]">{top?.label ?? '暂无'}</div>
        </div>
      </div>
    </div>
  );
}

function UsageRankRow({ rank, name, tokens, total, color, responseCount, avgTokensPerSec, lastUsedAt }: {
  rank: number;
  name: string;
  tokens: number;
  total: number;
  color: string;
  responseCount: number;
  avgTokensPerSec: number;
  lastUsedAt?: number;
}) {
  const percent = total > 0 ? (tokens / total) * 100 : 0;
  const lastUsedText = lastUsedAt ? new Date(lastUsedAt).toLocaleString() : '暂无时间';

  return (
    <div title={name} className="border-b border-[var(--border-subtle)] py-3 last:border-b-0">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-xs font-semibold text-white"
            style={{ background: color }}
          >
            {rank}
          </div>
          <div className="min-w-0">
            <div title={name} className="truncate text-sm font-medium text-[var(--text-primary)] dark:text-[var(--text-primary)]">{name}</div>
            <div className="mt-0.5 truncate text-[11px] text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">
              {percent.toFixed(1)}% · {responseCount} 次 · {avgTokensPerSec > 0 ? `${avgTokensPerSec.toFixed(1)} tok/s` : 'tok/s 暂无'} · {lastUsedText}
            </div>
          </div>
        </div>
        <div className="mono-font flex-shrink-0 text-sm font-semibold text-[var(--text-primary)] dark:text-[var(--text-primary)]">{formatCount(tokens)}</div>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-muted)] dark:bg-white/[0.08]">
        <div className="h-full rounded-full transition-[width] duration-500 ease-out" style={{ width: `${percent}%`, background: color }} />
      </div>
    </div>
  );
}

function MetricCard({ icon: Icon, label, value, delay = 0 }: { icon: LucideIcon; label: string; value: string; delay?: number }) {
  return (
    <div
      className="anim-fade-rise border-b border-[var(--border-subtle)] px-1 py-4 sm:px-3"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="mb-2.5 flex h-7 w-7 items-center justify-center rounded-md bg-[var(--surface-muted)] text-[var(--accent)] dark:bg-white/[0.06]">
        <Icon className="h-4 w-4" />
      </div>
      <div className="mb-1 truncate text-xs text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">{label}</div>
      <div className="mono-font truncate text-lg font-semibold leading-tight text-[var(--text-primary)] dark:text-[var(--text-primary)]">{value}</div>
    </div>
  );
}
