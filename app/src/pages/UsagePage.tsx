import { useMemo } from 'react';
import { Activity, BarChart3, CalendarDays, Gauge, Hash, PieChart, Trophy } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import type { LucideIcon } from 'lucide-react';

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
const HEATMAP_LEVELS_LIGHT = ['#EBE6DB', '#F4C9B5', '#E89B79', '#DA744D', '#C4502E'];
const HEATMAP_LEVELS_DARK = ['rgba(255,255,255,0.06)', '#5C3322', '#8A4A2E', '#BC6038', '#E68A57'];

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
        color: model?.themeColorSolid ?? usage.modelColor ?? '#D06646',
        usage,
      };
    })
    .filter((item) => item.usage.totalTokens > 0)
    .sort((a, b) => b.usage.totalTokens - a.usage.totalTokens);

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-[#FBFAF6] text-[#2F2C26] dark:bg-[#171512] dark:text-[#F3EBDD]">
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-[1100px]">
          <div className="anim-fade-rise mb-6 flex min-w-0 items-center gap-3">
            <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg border border-[#DCD8CF] bg-[#FAF9F5] text-[#D06646] dark:border-white/[0.08] dark:bg-white/[0.04]">
              <BarChart3 className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-xl font-bold leading-tight text-[#2F2C26] dark:text-[#F3EBDD]">使用详情</h1>
              <p className="mt-0.5 truncate text-xs text-[#7D766B] dark:text-[#A9A095]">真实 usage 数据来自 llama.cpp 响应。</p>
            </div>
          </div>

          <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricCard icon={Hash} label="总 Token" value={totals.totalTokens.toLocaleString()} delay={0} />
            <MetricCard icon={Activity} label="输入 Token" value={totals.promptTokens.toLocaleString()} delay={40} />
            <MetricCard icon={CalendarDays} label="输出 Token" value={totals.completionTokens.toLocaleString()} delay={80} />
            <MetricCard icon={Gauge} label="平均 tok/s" value={avgTokensPerSec > 0 ? avgTokensPerSec.toFixed(1) : '暂无'} delay={120} />
          </div>

          <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <MetricCard icon={Activity} label="真实响应次数" value={totals.responseCount.toLocaleString()} delay={160} />
            <MetricCard icon={Gauge} label="平均首字延迟" value={avgFirstTokenDelay > 0 ? `${avgFirstTokenDelay.toFixed(2)}s` : '暂无'} delay={200} />
            <MetricCard icon={CalendarDays} label="平均输出用时" value={avgGenTime > 0 ? `${avgGenTime.toFixed(2)}s` : '暂无'} delay={240} />
          </div>

          <div className="anim-fade-rise mb-5 rounded-xl border border-[#DCD8CF] bg-[#FAF9F5] p-5 dark:border-white/[0.08] dark:bg-white/[0.03]" style={{ animationDelay: '120ms' }}>
            <div className="mb-5 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <CalendarDays className="h-4 w-4 flex-shrink-0 text-[#D06646]" />
                <h2 className="text-sm font-semibold text-[#2F2C26] dark:text-[#F3EBDD]">全年 Token 热力图</h2>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-[#7D766B] dark:text-[#A9A095]">{activeDayCount} 天有记录</span>
                <span className="rounded-full border border-[#E3DFD6] bg-[#FBFAF6] px-2 py-0.5 text-[11px] text-[#7D766B] dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[#A9A095]">{new Date().getFullYear()}</span>
              </div>
            </div>
            <div className="overflow-x-auto pb-1">
              <div className="w-max">
                {/* 月份标签 */}
                <div className="mb-1.5 flex pl-9 text-[10px] leading-none text-[#9A9082] dark:text-[#7A7264]">
                  {heatmapWeeks.map((week, weekIndex) => (
                    <div key={weekIndex} className="w-[15px] flex-shrink-0">
                      {week.monthLabel ? <span className="relative -left-px">{week.monthLabel}</span> : null}
                    </div>
                  ))}
                </div>
                <div className="flex">
                  {/* 星期标签 */}
                  <div className="mr-1.5 flex w-7 flex-shrink-0 flex-col gap-[3px] text-[10px] leading-[12px] text-[#9A9082] dark:text-[#7A7264]">
                    {WEEKDAY_LABELS.map((label, rowIndex) => (
                      <div key={rowIndex} className="flex h-[12px] items-center justify-end pr-0.5">{rowIndex % 2 === 1 ? label : ''}</div>
                    ))}
                  </div>
                  {/* 格子 */}
                  <div className="flex gap-[3px]">
                    {heatmapWeeks.map((week, weekIndex) => (
                      <div key={weekIndex} className="flex flex-col gap-[3px]">
                        {week.days.map((day, rowIndex) => {
                          if (!day) {
                            return <div key={`blank-${weekIndex}-${rowIndex}`} className="h-[12px] w-[12px]" />;
                          }
                          const tokens = dailyTokensByDay.get(day) ?? 0;
                          const level = tokenLevel(tokens, maxDayTokens);
                          return (
                            <div
                              key={day}
                              title={`${day}：${tokens.toLocaleString()} 个 Token`}
                              className="h-[12px] w-[12px] flex-shrink-0 rounded-[2px] transition-transform duration-150 hover:scale-125 hover:ring-1 hover:ring-[#D06646]/60"
                              style={{ background: heatmapPalette[level] }}
                            />
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>
                {/* 图例 */}
                <div className="mt-3 flex items-center justify-end gap-1.5 pr-0.5 text-[10px] leading-none text-[#9A9082] dark:text-[#7A7264]">
                  <span>少</span>
                  {heatmapPalette.map((color, index) => (
                    <span
                      key={index}
                      className="h-[11px] w-[11px] rounded-[2px]"
                      style={{ background: color }}
                    />
                  ))}
                  <span>多</span>
                </div>
              </div>
            </div>
          </div>

          <div className="anim-fade-rise rounded-xl border border-[#DCD8CF] bg-[#FAF9F5] p-5 dark:border-white/[0.08] dark:bg-white/[0.03]" style={{ animationDelay: '180ms' }}>
            <div className="mb-5 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <PieChart className="h-4 w-4 flex-shrink-0 text-[#D06646]" />
                <h2 className="text-sm font-semibold text-[#2F2C26] dark:text-[#F3EBDD]">模型使用占比</h2>
              </div>
              <span className="text-[11px] text-[#7D766B] dark:text-[#A9A095]">按真实 token 总量排序</span>
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
                  {modelUsage.map(({ id, name, color, usage }, index) => (
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
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-[#E3DFD6] bg-[#FBFAF6] p-8 text-center text-sm text-[#7D766B] dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-[#A9A095]">
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
        className="relative flex h-44 w-44 items-center justify-center rounded-full"
        style={{ background: total > 0 ? `conic-gradient(${segments.join(', ')})` : 'rgba(128,128,128,0.12)' }}
      >
        <div className="flex h-28 w-28 flex-col items-center justify-center rounded-full border border-[#DCD8CF] bg-[#FBFAF6] px-3 text-center shadow-sm dark:border-white/[0.08] dark:bg-[#1C1A16]">
          <Trophy className="mb-1 h-4 w-4 text-[#D9A324]" />
          <div className="text-[11px] text-[#7D766B] dark:text-[#A9A095]">最多使用</div>
          <div className="max-w-full truncate text-xs font-semibold text-[#2F2C26] dark:text-[#F3EBDD]">{top?.label ?? '暂无'}</div>
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
    <div className="rounded-lg border border-[#E3DFD6] bg-[#FBFAF6] p-3 transition-colors hover:border-[#D06646]/30 dark:border-white/[0.08] dark:bg-white/[0.04] dark:hover:border-[#D06646]/40">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-xs font-semibold text-white"
            style={{ background: color }}
          >
            {rank}
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-[#2F2C26] dark:text-[#F3EBDD]">{name}</div>
            <div className="mt-0.5 truncate text-[11px] text-[#7D766B] dark:text-[#A9A095]">
              {percent.toFixed(1)}% · {responseCount} 次 · {avgTokensPerSec > 0 ? `${avgTokensPerSec.toFixed(1)} tok/s` : 'tok/s 暂无'} · {lastUsedText}
            </div>
          </div>
        </div>
        <div className="mono-font flex-shrink-0 text-sm font-semibold text-[#2F2C26] dark:text-[#F3EBDD]">{tokens.toLocaleString()}</div>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-[#E6E1D8] dark:bg-white/[0.08]">
        <div className="h-full rounded-full transition-[width] duration-500 ease-out" style={{ width: `${percent}%`, background: color }} />
      </div>
    </div>
  );
}

function MetricCard({ icon: Icon, label, value, delay = 0 }: { icon: LucideIcon; label: string; value: string; delay?: number }) {
  return (
    <div
      className="anim-fade-rise rounded-xl border border-[#DCD8CF] bg-[#FAF9F5] p-4 transition-colors hover:border-[#D06646]/30 dark:border-white/[0.08] dark:bg-white/[0.03] dark:hover:border-[#D06646]/40"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="mb-2.5 flex h-7 w-7 items-center justify-center rounded-md bg-[#F0E7E1] text-[#D06646] dark:bg-white/[0.06]">
        <Icon className="h-4 w-4" />
      </div>
      <div className="mb-1 truncate text-xs text-[#7D766B] dark:text-[#A9A095]">{label}</div>
      <div className="mono-font truncate text-lg font-semibold leading-tight text-[#2F2C26] dark:text-[#F3EBDD]">{value}</div>
    </div>
  );
}
