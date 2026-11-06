/**
 * 使用统计热力图的时间缩放。
 *
 * 三档粒度，同一份 `dailyTokens`（日期 → token）数据源：
 * - 年（year）：一整年按「天」铺开，GitHub 贡献图样式；
 * - 月（month）：单月按「天」铺开，7 列 × N 行，格子放大到看得清日期；
 * - 日（day）：单日按「小时」铺开——但逐小时 token 并没有落盘（dailyTokens 只有天粒度），
 *   所以日视图不伪造小时数据，而是给出那一天的汇总读数 + 当月的周边上下文。
 *
 * 关键约定：日视图绝不用日均值或随机数去"填"24 个小时格——那会让用户以为
 * 数据本来就有小时粒度。没有的数据就明确说没有。
 */

/** 热力图粒度。 */
export type HeatmapScale = 'year' | 'month' | 'day';

export const HEATMAP_SCALES: Array<{ id: HeatmapScale; label: string; hint: string }> = [
  { id: 'year', label: '年', hint: '按年展示，每格一天' },
  { id: 'month', label: '月', hint: '按月展示，每格一天，格子更大' },
  { id: 'day', label: '日', hint: '单日汇总；小时级用量尚未落盘，不做推算' },
];

/**
 * 一列（竖向 7 天）在年视图里占的宽度，含间隔。
 *
 * 全年约 53 列，卡片内容区常见宽度约 676px；13/3 会横向溢出并把 11–12 月
 * 推到屏幕外。收到 10/2 后整年刚好落在一屏内，当前月份不再需要手动横向滚动。
 */
const YEAR_CELL = 10;
const YEAR_GAP = 2;
/** 月视图格子放大倍数：单月最多 6 列，格子可以明显更大。 */
const MONTH_SCALE = 2.1;

export interface HeatmapCell {
  /** 日期键 `YYYY-MM-DD`；null = 前置占位（让首日落在正确的星期行）。 */
  day: string | null;
  tokens: number;
  level: number;
}

export interface HeatmapColumn {
  /** 这一列第一天的月份标签（跨月时才有值）。 */
  monthLabel: string | null;
  cells: HeatmapCell[];
}

export interface HeatmapView {
  scale: HeatmapScale;
  /** 标题（如「2026 年」「2026 年 10 月」「2026 年 10 月 30 日」）。 */
  title: string;
  /** 该视图覆盖的日期范围（含端点）。 */
  startDay: string;
  endDay: string;
  /** 按「周列」组织：年/月视图用它渲染格子。 */
  columns: HeatmapColumn[];
  /** 视图内 token 总量。 */
  totalTokens: number;
  /** 有记录的天数。 */
  activeDays: number;
  /** 单日最大值（配色分档用）。 */
  maxDayTokens: number;
  /** 日视图专用：该日的汇总与当月日序列（用于「同日对比」的上下文）。 */
  dayDetail?: {
    day: string;
    tokens: number;
    /** 当月每天（1..N）的 token，用于显示该日在月内的位置。 */
    monthDays: Array<{ day: string; tokens: number }>;
    /** 当月总量。 */
    monthTotal: number;
    /** 当月平均（只按有记录的天算；无记录为 null）。 */
    monthAverage: number | null;
  };
}

function pad2(value: number) {
  return String(value).padStart(2, '0');
}

/** 日期 → `YYYY-MM-DD`（本地时区，与 dailyTokens 的落盘口径一致）。 */
export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function parseDayKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1);
}

/** 把 [start, end] 之间每一天列出来。 */
function eachDay(startDay: string, endDay: string): string[] {
  const days: string[] = [];
  const cursor = parseDayKey(startDay);
  const end = parseDayKey(endDay);
  while (cursor.getTime() <= end.getTime()) {
    days.push(dayKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

function levelFor(tokens: number, maxTokens: number): number {
  if (tokens <= 0) return 0;
  const ratio = tokens / Math.max(1, maxTokens);
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

/** 把日期序列切成「周列」（每列 7 天，行 = 周日..周六）。 */
function toColumns(days: string[], daily: Record<string, number>, maxTokens: number, withLeadingPad: boolean): HeatmapColumn[] {
  const padded: Array<string | null> = [...days];
  if (withLeadingPad && days.length > 0) {
    const firstWeekday = parseDayKey(days[0]).getDay();
    for (let i = 0; i < firstWeekday; i += 1) padded.unshift(null);
  }
  const columns: HeatmapColumn[] = [];
  let lastMonth = -1;
  for (let i = 0; i < padded.length; i += 7) {
    const slice = padded.slice(i, i + 7);
    while (slice.length < 7) slice.push(null);
    const firstReal = slice.find((day): day is string => Boolean(day));
    let monthLabel: string | null = null;
    if (firstReal) {
      const month = parseDayKey(firstReal).getMonth();
      if (month !== lastMonth) {
        monthLabel = `${month + 1}月`;
        lastMonth = month;
      }
    }
    columns.push({
      monthLabel,
      cells: slice.map((day) => ({
        day,
        tokens: day ? (daily[day] ?? 0) : 0,
        level: day ? levelFor(daily[day] ?? 0, maxTokens) : 0,
      })),
    });
  }
  return columns;
}

/**
 * 构建某个粒度下的热力图视图。
 *
 * @param dailyTokens 所有后端合并后的「日期 → token」。
 * @param scale 粒度。
 * @param anchor 锚点日期（年/月/日各自的「看哪一段」由它决定）。
 */
export function buildHeatmapView(
  dailyTokens: Record<string, number>,
  scale: HeatmapScale,
  anchor: Date,
): HeatmapView {
  const year = anchor.getFullYear();
  const month = anchor.getMonth();

  if (scale === 'year') {
    const startDay = dayKey(new Date(year, 0, 1));
    const endDay = dayKey(new Date(year, 11, 31));
    const days = eachDay(startDay, endDay);
    const inRange = days.filter((day) => (dailyTokens[day] ?? 0) > 0);
    const totalTokens = days.reduce((sum, day) => sum + (dailyTokens[day] ?? 0), 0);
    const maxDayTokens = Math.max(1, ...days.map((day) => dailyTokens[day] ?? 0));
    return {
      scale,
      title: `${year} 年`,
      startDay,
      endDay,
      columns: toColumns(days, dailyTokens, maxDayTokens, true),
      totalTokens,
      activeDays: inRange.length,
      maxDayTokens,
    };
  }

  if (scale === 'month') {
    const startDay = dayKey(new Date(year, month, 1));
    const endDay = dayKey(new Date(year, month + 1, 0));
    const days = eachDay(startDay, endDay);
    const totalTokens = days.reduce((sum, day) => sum + (dailyTokens[day] ?? 0), 0);
    const maxDayTokens = Math.max(1, ...days.map((day) => dailyTokens[day] ?? 0));
    const activeDays = days.filter((day) => (dailyTokens[day] ?? 0) > 0).length;
    return {
      scale,
      title: `${year} 年 ${month + 1} 月`,
      startDay,
      endDay,
      columns: toColumns(days, dailyTokens, maxDayTokens, true),
      totalTokens,
      activeDays,
      maxDayTokens,
    };
  }

  // 日视图：不做小时推算，只给单日汇总 + 当月上下文。
  const dayOfMonth = anchor.getDate();
  const targetDay = dayKey(new Date(year, month, dayOfMonth));
  const monthStart = dayKey(new Date(year, month, 1));
  const monthEnd = dayKey(new Date(year, month + 1, 0));
  const monthDayKeys = eachDay(monthStart, monthEnd);
  const monthDays = monthDayKeys.map((day) => ({ day, tokens: dailyTokens[day] ?? 0 }));
  const monthTotal = monthDays.reduce((sum, item) => sum + item.tokens, 0);
  const activeMonthDays = monthDays.filter((item) => item.tokens > 0);
  const monthAverage = activeMonthDays.length > 0
    ? activeMonthDays.reduce((sum, item) => sum + item.tokens, 0) / activeMonthDays.length
    : null;
  const tokens = dailyTokens[targetDay] ?? 0;
  return {
    scale,
    title: `${year} 年 ${month + 1} 月 ${dayOfMonth} 日`,
    startDay: targetDay,
    endDay: targetDay,
    // 日视图不铺 24 小时格，columns 给空数组；界面改渲染汇总卡片。
    columns: [],
    totalTokens: tokens,
    activeDays: tokens > 0 ? 1 : 0,
    maxDayTokens: Math.max(1, tokens),
    dayDetail: {
      day: targetDay,
      tokens,
      monthDays,
      monthTotal,
      monthAverage,
    },
  };
}

/** 年视图整幅宽度（px）：列数 × 列宽。月视图按同一算式的格子放大 MONTH_SCALE 倍。 */
export function heatmapWidth(view: HeatmapView): number {
  if (view.scale === 'day') return 0;
  const { cell, gap } = heatmapCellSize(view.scale);
  return view.columns.length * (cell + gap);
}

export function heatmapCellSize(scale: HeatmapScale): { cell: number; gap: number } {
  if (scale === 'month') {
    return { cell: Math.round(YEAR_CELL * MONTH_SCALE), gap: YEAR_GAP + 2 };
  }
  return { cell: YEAR_CELL, gap: YEAR_GAP };
}
