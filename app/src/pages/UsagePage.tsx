import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  BarChart3,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  TrendingUp,
} from 'lucide-react';
import { useApp } from '@/context/AppContext';
import { useEngineUsageSync } from '@/hooks/useEngineUsageSync';
import { FAST27B_SERVICE_ID } from '@/hooks/useEngineStatuses';
import { STRATA_SERVICE_ID } from '@/hooks/useStrataStatus';
import PageHeader from '@/components/PageHeader';
import {
  HEATMAP_SCALES,
  buildHeatmapView,
  dayKey,
  heatmapCellSize,
  heatmapWidth,
  type HeatmapScale,
} from '@/lib/usageHeatmap';

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

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

/** 次级指标：标签 + 数值 + 单位，横排紧凑。 */
function SubMetric({ label, value, unit, hint }: { label: string; value: string; unit?: string; hint?: string }) {
  return (
    <div className="min-w-0" title={hint}>
      <div className="truncate text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span className="mono-font truncate text-[length:var(--font-title)] font-semibold leading-tight text-[var(--text-primary)]">{value}</span>
        {unit && <span className="flex-shrink-0 text-[length:var(--font-eyebrow)] text-[var(--text-secondary)]">{unit}</span>}
      </div>
    </div>
  );
}

/** 来源配色：主模型=品牌色，对外 API=成功绿，引擎=加载中黄。 */
const SOURCE_COLORS: Record<string, string> = {
  '主模型': 'var(--accent)',
  '对外 API': 'var(--state-success)',
  '引擎': 'var(--status-loading)',
};
const SOURCE_ORDER = ['主模型', '对外 API', '引擎'] as const;

/**
 * token 统计页。
 *
 * 原来的七张孤立指标卡 + 环形图 + 排行的组合里，同一份 token 被拆在四五处重复呈现，
 * 且「环形图第一」与「排行第一」说的是同一件事。现在按三个问题重排：
 * 1. 一共用了多少、从哪来（总览卡 + 来源堆叠条）；
 * 2. 什么时候用的（热力图，保留年/月/日缩放）；
 * 3. 谁用得最多（模型排行，横向条）。
 * 速度 / 首字延迟 / 输出用时降级为总览卡右侧的次级指标，不再各占一张卡。
 */
export default function UsagePage() {
  const { state } = useApp();
  // 引擎（NiNfer / Strata）的 token 用量在这里同步进 state.usageByModel：
  // 它们的指标快照只在统计页订阅，避免其他页面也起两个每秒一次的 IPC 轮询。
  useEngineUsageSync();
  const [usageExpanded, setUsageExpanded] = useState(false);
  const heatmapPalette = state.theme === 'dark' ? HEATMAP_LEVELS_DARK : HEATMAP_LEVELS_LIGHT;
  // 热力图缩放：粒度 + 锚点（年/月/日各自由锚点决定看哪一段）。
  const [heatmapScale, setHeatmapScale] = useState<HeatmapScale>('year');
  const [heatmapAnchor, setHeatmapAnchor] = useState<Date>(() => new Date());
  // 切换粒度时用 ref 读最新值，避免把 scale 塞进回调依赖导致翻页函数每帧重建。
  const heatmapScaleRef = useRef<HeatmapScale>('year');
  const usageEntries = Object.entries(state.usageByModel);
  // usageValues 作为 useMemo 依赖，必须是稳定引用：每次渲染新建数组会让下面的
  // memo 全部失效（React Compiler 也会因此拒绝编译整个组件）。
  const usageValues = useMemo(() => usageEntries.map(([, usage]) => usage), [usageEntries]);
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

  // 所有后端合并后的「日期 → token」，热力图三档粒度共用这一份。
  const dailyTokens = useMemo(() => {
    const merged: Record<string, number> = {};
    for (const usage of usageValues) {
      for (const [day, tokens] of Object.entries(usage.dailyTokens ?? {})) {
        merged[day] = (merged[day] ?? 0) + tokens;
      }
    }
    return merged;
  }, [usageValues]);

  // 缩放视图：数据 + 粒度 + 锚点 → 可以直接渲染的格子。
  const heatmapView = useMemo(
    () => buildHeatmapView(dailyTokens, heatmapScale, heatmapAnchor),
    [dailyTokens, heatmapScale, heatmapAnchor],
  );
  /**
   * 年 / 月 / 日三档共用同一张「年度日历热力图」。
   *
   * 参考截图里的用量热力图始终是同一块 53 周左右的网格：切换时间范围只换汇总与高亮，
   * 网格本身不换形态。这里保持同样的口径——格子永远是当前年份，月/日视图用高亮圈出
   * 所选月份或所选那一天，不再把月份放大、也不再给日视图单独做一张汇总卡。
   */
  const calendarView = useMemo(
    () => buildHeatmapView(dailyTokens, 'year', heatmapAnchor),
    [dailyTokens, heatmapAnchor],
  );
  const focusDay = heatmapScale === 'day' ? heatmapView.dayDetail?.day : undefined;
  const gridCell = heatmapCellSize('year');

  // 翻页单位的中文名（按钮 tooltip 与 aria-label 用）。
  const scaleUnitLabel = heatmapScale === 'year' ? '年' : heatmapScale === 'month' ? '月' : '日';

  // 区间标签三档统一使用同一套中文年月日，避免年写 2026、月写 2026-11、日写 11-04 的割裂。
  const heatmapRangeLabel = heatmapScale === 'year'
    ? `${heatmapAnchor.getFullYear()} 年`
    : heatmapScale === 'month'
      ? `${heatmapAnchor.getFullYear()} 年 ${heatmapAnchor.getMonth() + 1} 月`
      : `${heatmapAnchor.getFullYear()} 年 ${heatmapAnchor.getMonth() + 1} 月 ${heatmapAnchor.getDate()} 日`;

  // 不能往后翻到未来：年视图到今年为止，月/日视图到今月/今日为止。
  const canShiftForward = useMemo(() => {
    const now = new Date();
    if (heatmapScale === 'year') return heatmapAnchor.getFullYear() < now.getFullYear();
    if (heatmapScale === 'month') {
      return heatmapAnchor.getFullYear() < now.getFullYear()
        || (heatmapAnchor.getFullYear() === now.getFullYear() && heatmapAnchor.getMonth() < now.getMonth());
    }
    return heatmapAnchor.getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }, [heatmapScale, heatmapAnchor]);

  // 锚点是否仍在「当前年 / 当前月 / 今天」：决定「回到当前」按钮是否出现。
  const anchorIsCurrent = useMemo(() => {
    const now = new Date();
    if (heatmapScale === 'year') return heatmapAnchor.getFullYear() === now.getFullYear();
    if (heatmapScale === 'month') {
      return heatmapAnchor.getFullYear() === now.getFullYear() && heatmapAnchor.getMonth() === now.getMonth();
    }
    return heatmapAnchor.getFullYear() === now.getFullYear()
      && heatmapAnchor.getMonth() === now.getMonth()
      && heatmapAnchor.getDate() === now.getDate();
  }, [heatmapScale, heatmapAnchor]);

  const shiftHeatmapAnchor = (step: 1 | -1) => {
    const scale = heatmapScaleRef.current;
    setHeatmapAnchor((current) => {
      const next = new Date(current);
      if (scale === 'year') {
        // 闰日（2-29）翻到平年会溢出成 3-01；统一先把日号钳到目标年的当月最后一天。
        const targetYear = current.getFullYear() + step;
        const lastDay = new Date(targetYear, current.getMonth() + 1, 0).getDate();
        next.setFullYear(targetYear, current.getMonth(), Math.min(current.getDate(), lastDay));
      } else if (scale === 'month') {
        // 直接 setMonth 会把 31 日溢出到下个月（10-31 点“上个月”变成 10-01）。
        // 先把日号钳到目标月的最后一天，再落锚点。
        const targetMonth = current.getMonth() + step;
        const lastDay = new Date(current.getFullYear(), targetMonth + 1, 0).getDate();
        next.setFullYear(current.getFullYear(), targetMonth, Math.min(current.getDate(), lastDay));
      } else next.setDate(current.getDate() + step);
      return next;
    });
  };

  /**
   * 切换年/月/日粒度时把锚点归到今天。
   *
   * 旧实现保留锚点：在年视图翻到 2023 后切「日」，会落在 2023 年的某一天，
   * 用户以为切档没生效。三档统一以「当前时间」为入口，翻页后再各自移动。
   */
  const switchHeatmapScale = (scale: HeatmapScale) => {
    heatmapScaleRef.current = scale;
    setHeatmapScale(scale);
    setHeatmapAnchor(new Date());
  };

  // 粒度切换时同步 ref，翻页用最新粒度。
  useEffect(() => {
    heatmapScaleRef.current = heatmapScale;
  }, [heatmapScale]);

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
      // 主模型：从模型列表取名字与颜色；引擎 / API 行没有对应模型，用统计条目自带的快照。
      const engineLabel = modelId === FAST27B_SERVICE_ID
        ? 'NiNfer 引擎'
        : modelId === STRATA_SERVICE_ID
          ? 'Strata 引擎'
          : null;
      return {
        id: modelId,
        name: model?.name ?? engineLabel ?? usage.modelName ?? modelId,
        color: model?.themeColorSolid ?? usage.modelColor ?? 'var(--accent)',
        usage,
        /** 会话侧「来源」标签：主模型 / 引擎 / 对外 API。 */
        source: modelId.startsWith('engine:') ? '引擎' : modelId.startsWith('api-') ? '对外 API' : '主模型',
      };
    })
    .filter((item) => item.usage.totalTokens > 0)
    .sort((a, b) => b.usage.totalTokens - a.usage.totalTokens);

  // 按来源汇总：让「所有 token 都统计到了」这件事在页面上直接可核对。
  const bySource = modelUsage.reduce<Record<string, number>>((acc, item) => {
    acc[item.source] = (acc[item.source] ?? 0) + item.usage.totalTokens;
    return acc;
  }, {});
  const sourceRows = SOURCE_ORDER
    .map((source) => ({ source, tokens: bySource[source] ?? 0 }))
    .filter((row) => row.tokens > 0);

  /**
   * 按模型拆开的每日用量：月视图叠成「每天一根、按模型分段」的柱状图，
   * 日视图按模型各画一根柱。年度热力图仍只关心当日总量，不在这里拆。
   */
  const modelDailyUsage = useMemo(() => {
    const byId = new Map(state.models.map((model) => [model.id, model]));
    return Object.entries(state.usageByModel)
      .map(([id, usage]) => {
        const model = byId.get(id);
        const engineLabel = id === FAST27B_SERVICE_ID
          ? 'NiNfer 引擎'
          : id === STRATA_SERVICE_ID
            ? 'Strata 引擎'
            : null;
        const dailyTokens = usage.dailyTokens ?? {};
        return {
          id,
          name: model?.name ?? engineLabel ?? usage.modelName ?? id,
          color: model?.themeColorSolid ?? usage.modelColor ?? 'var(--accent)',
          dailyTokens,
          total: Object.values(dailyTokens).reduce((sum, tokens) => sum + tokens, 0),
        };
      })
      .filter((model) => model.total > 0)
      .sort((a, b) => b.total - a.total);
  }, [state.models, state.usageByModel]);

  // 月视图：当月每天的总量 + 按模型拆分的分段。
  const monthChart = useMemo(() => {
    const year = heatmapAnchor.getFullYear();
    const month = heatmapAnchor.getMonth();
    const dayCount = new Date(year, month + 1, 0).getDate();
    const rows = Array.from({ length: dayCount }, (_, index) => {
      const day = dayKey(new Date(year, month, index + 1));
      const segments = modelDailyUsage
        .map((model) => ({
          id: model.id,
          name: model.name,
          color: model.color,
          tokens: model.dailyTokens[day] ?? 0,
        }))
        .filter((segment) => segment.tokens > 0);
      return {
        day,
        total: segments.reduce((sum, segment) => sum + segment.tokens, 0),
        segments,
      };
    });
    const modelTotals = new Map<string, { name: string; color: string; tokens: number }>();
    for (const row of rows) {
      for (const segment of row.segments) {
        const current = modelTotals.get(segment.id);
        modelTotals.set(segment.id, {
          name: segment.name,
          color: segment.color,
          tokens: (current?.tokens ?? 0) + segment.tokens,
        });
      }
    }
    return {
      rows,
      max: Math.max(1, ...rows.map((row) => row.total)),
      models: [...modelTotals.values()].sort((a, b) => b.tokens - a.tokens),
    };
  }, [heatmapAnchor, modelDailyUsage]);

  // 日视图：只显示所选日期里出现过的模型。
  const dayChart = useMemo(() => {
    if (!focusDay) return { rows: [], max: 1 };
    const rows = modelDailyUsage
      .map((model) => ({
        id: model.id,
        name: model.name,
        color: model.color,
        tokens: model.dailyTokens[focusDay] ?? 0,
      }))
      .filter((row) => row.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens);
    return { rows, max: Math.max(1, ...rows.map((row) => row.tokens)) };
  }, [focusDay, modelDailyUsage]);

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-[var(--app-bg)] text-[var(--text-primary)]">
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-[1160px]">
          <PageHeader
            icon={BarChart3}
            title="使用详情"
            description="统计所有后端（主模型 / 对外 API / NiNfer / Strata）的真实 token 用量。"
            className="anim-fade-rise"
          />

          {/* ---- 总览：总量 + 来源构成 + 次级性能指标 ---- */}
          <section className="panel anim-fade-rise mt-4 p-5 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-6">
              <div className="min-w-0 flex-1">
                <div className="eyebrow flex items-center gap-1.5">
                  <TrendingUp className="h-3.5 w-3.5" />
                  累计消耗
                </div>
                <div className="mono-font mt-2 flex items-baseline gap-2">
                  <span className="text-[length:var(--font-hero)] font-bold leading-none tracking-[var(--tracking-display)] text-[var(--text-primary)]">
                    {formatCount(totals.totalTokens)}
                  </span>
                  <span className="text-[length:var(--font-caption)] text-[var(--text-secondary)]">Token</span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[length:var(--font-caption)] text-[var(--text-secondary)]">
                  <span>输入 <span className="mono-font font-semibold text-[var(--text-primary)]">{formatCount(totals.promptTokens)}</span></span>
                  <span>输出 <span className="mono-font font-semibold text-[var(--text-primary)]">{formatCount(totals.completionTokens)}</span></span>
                  <span><span className="mono-font font-semibold text-[var(--text-primary)]">{totals.responseCount.toLocaleString()}</span> 次响应</span>
                </div>

                {/* 来源堆叠条：一条就能看出 token 从哪来，替代原来单独一行的文字拆分。 */}
                {sourceRows.length > 0 && totals.totalTokens > 0 && (
                  <div className="mt-4 max-w-xl">
                    <div className="flex h-2 w-full overflow-hidden rounded-full bg-[var(--surface-muted)]">
                      {sourceRows.map((row) => (
                        <div
                          key={row.source}
                          title={`${row.source}：${formatCount(row.tokens)} Token`}
                          style={{ width: `${(row.tokens / totals.totalTokens) * 100}%`, background: SOURCE_COLORS[row.source] }}
                        />
                      ))}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[length:var(--font-eyebrow)] text-[var(--text-secondary)]">
                      {sourceRows.map((row) => (
                        <span key={row.source} className="inline-flex items-center gap-1.5">
                          <span className="h-2 w-2 rounded-full" style={{ background: SOURCE_COLORS[row.source] }} />
                          {row.source}
                          <span className="mono-font font-medium text-[var(--text-primary)]">{formatCount(row.tokens)}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="grid flex-shrink-0 grid-cols-3 gap-x-6 gap-y-4 sm:gap-x-8">
                <SubMetric
                  label="平均速度"
                  value={avgTokensPerSec > 0 ? avgTokensPerSec.toFixed(1) : '—'}
                  unit="tok/s"
                  hint="每次响应速度的算术平均"
                />
                <SubMetric
                  label="平均首字"
                  value={avgFirstTokenDelay > 0 ? avgFirstTokenDelay.toFixed(2) : '—'}
                  unit="s"
                  hint="从请求到第一个 token 的平均等待"
                />
                <SubMetric
                  label="平均输出"
                  value={avgGenTime > 0 ? avgGenTime.toFixed(1) : '—'}
                  unit="s"
                  hint="单次回答的平均生成耗时"
                />
              </div>
            </div>
          </section>

          {/* ---- 时间维度（左） + 模型维度（右） ---- */}
          <div className="mt-3.5 grid items-start gap-3.5 xl:grid-cols-[minmax(0,1.5fr)_minmax(320px,0.9fr)]">
            {/* 左：Token 热力图（带缩放） */}
            <section className="panel anim-fade-rise min-w-0 p-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <CalendarDays className="h-4 w-4 flex-shrink-0 text-[var(--accent)]" />
                  <h2 className="truncate text-sm font-semibold text-[var(--text-primary)]">Token 用量</h2>
                </div>
                {/* 缩放：年 / 月 / 日 三档，外加前后翻页 */}
                <div className="flex flex-wrap items-center gap-1.5">
                  <div role="group" aria-label="热力图时间粒度" className="flex items-center gap-0.5 rounded-[var(--radius-field)] border border-[var(--border)] bg-[var(--surface-muted)] p-0.5">
                    {HEATMAP_SCALES.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => switchHeatmapScale(item.id)}
                        aria-pressed={heatmapScale === item.id}
                        title={item.hint}
                        className={`h-7 rounded-[var(--radius-sm)] px-2.5 text-[length:var(--font-caption)] font-medium transition-colors ${
                          heatmapScale === item.id
                            ? 'bg-[var(--surface)] text-[var(--accent)] shadow-sm'
                            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                        }`}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => shiftHeatmapAnchor(-1)}
                      className="grid h-7 w-7 place-items-center rounded-[var(--radius-field)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]"
                      title={`上一${scaleUnitLabel}`}
                      aria-label={`上一${scaleUnitLabel}`}
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </button>
                    <span className="mono-font min-w-[5.5rem] text-center text-[length:var(--font-caption)] text-[var(--text-secondary)]">
                      {heatmapRangeLabel}
                    </span>
                    <button
                      type="button"
                      onClick={() => shiftHeatmapAnchor(1)}
                      disabled={!canShiftForward}
                      className="grid h-7 w-7 place-items-center rounded-[var(--radius-field)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-35"
                      title={canShiftForward ? `下一${scaleUnitLabel}` : '已经是最近的区间'}
                      aria-label={`下一${scaleUnitLabel}`}
                    >
                      <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                    {!anchorIsCurrent && (
                      <button
                        type="button"
                        onClick={() => setHeatmapAnchor(new Date())}
                        className="h-7 rounded-[var(--radius-field)] px-2 text-[length:var(--font-eyebrow)] text-[var(--accent)] transition-colors hover:bg-[var(--accent-subtle)]"
                        title="回到当前时间"
                      >
                        回到当前
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* 视图内汇总 */}
              <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[length:var(--font-caption)] text-[var(--text-secondary)]">
                <span>合计 <span className="mono-font font-medium text-[var(--text-primary)]">{formatCount(heatmapView.totalTokens)}</span></span>
                <span>有记录 <span className="mono-font font-medium text-[var(--text-primary)]">{heatmapView.activeDays}</span> 天</span>
                {heatmapView.maxDayTokens > 1 && (
                  <span>单日峰值 <span className="mono-font font-medium text-[var(--text-primary)]">{formatCount(heatmapView.maxDayTokens)}</span></span>
                )}
              </div>

              {/*
                固定高度框架：年视图铺日历热力图，月/日视图换成柱状图。
                切换粒度时外框大小不变，只换图形与图例。
              */}
              <div className="h-[220px]">
                {heatmapScale === 'year' ? (
                  <div className="flex h-full flex-col justify-center">
                    <div className="overflow-x-auto overscroll-x-contain pb-1 [scrollbar-width:thin]">
                      <div style={{ width: heatmapWidth(calendarView) + 42, minWidth: '100%' }}>
                        {/* 月份标签 */}
                        <div className="mb-1.5 flex pl-9 text-[length:var(--font-micro)] leading-none text-[var(--text-tertiary)]">
                          {calendarView.columns.map((column, index) => (
                            <div key={index} style={{ width: gridCell.cell + gridCell.gap, flexShrink: 0 }}>
                              {column.monthLabel ? <span className="relative -left-px whitespace-nowrap">{column.monthLabel}</span> : null}
                            </div>
                          ))}
                        </div>
                        {/* items-start：否则两列被拉伸到同高，星期标签行距会与格子错开 */}
                        <div className="flex items-start">
                          {/* 星期标签 */}
                          <div className="mr-1.5 flex w-9 flex-shrink-0 flex-col text-[length:var(--font-micro)] text-[var(--text-secondary)]" style={{ gap: gridCell.gap }}>
                            {WEEKDAY_LABELS.map((label, rowIndex) => (
                              <div
                                key={rowIndex}
                                className="flex flex-shrink-0 items-center justify-end pr-0.5"
                                style={{ height: gridCell.cell }}
                              >
                                {rowIndex % 2 === 1 ? label : ''}
                              </div>
                            ))}
                          </div>
                          {/* 格子 */}
                          <div className="flex" style={{ gap: gridCell.gap }}>
                            {calendarView.columns.map((column, columnIndex) => (
                              <div
                                key={columnIndex}
                                className="flex flex-shrink-0 flex-col"
                                style={{ gap: gridCell.gap }}
                              >
                                {column.cells.map((cell, rowIndex) => {
                                  if (!cell.day) {
                                    return <div key={`blank-${columnIndex}-${rowIndex}`} style={{ width: gridCell.cell, height: gridCell.cell }} />;
                                  }
                                  return (
                                    <div
                                      key={cell.day}
                                      title={`${cell.day}：${formatCount(cell.tokens)} 个 Token`}
                                      className="flex-shrink-0 rounded-[3px] transition-transform duration-150 hover:scale-125 hover:ring-1 hover:ring-[var(--accent)]/60"
                                      style={{
                                        width: gridCell.cell,
                                        height: gridCell.cell,
                                        background: cell.tokens > 0 ? heatmapPalette[cell.level] : (state.theme === 'dark' ? 'rgba(255,255,255,0.06)' : 'var(--border)'),
                                      }}
                                    />
                                  );
                                })}
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : heatmapScale === 'month' ? (
                  <MonthModelBars rows={monthChart.rows} max={monthChart.max} />
                ) : (
                  <DayModelBars rows={dayChart.rows} max={dayChart.max} />
                )}
              </div>

              {/* 图例：年视图是色阶，月/日视图换成模型颜色与用量。 */}
              {heatmapScale === 'year' ? (
                <div className="mt-2 flex h-7 items-center justify-end gap-1.5 pr-0.5 text-[length:var(--font-micro)] leading-none text-[var(--text-tertiary)]">
                  <span>少</span>
                  {heatmapPalette.map((color, index) => (
                    <span key={index} className="h-[14px] w-[14px] rounded-[3px]" style={{ background: color }} />
                  ))}
                  <span>多</span>
                </div>
              ) : (
                <ModelLegend models={heatmapScale === 'month' ? monthChart.models : dayChart.rows} />
              )}
            </section>

            {/* 右：模型排行（横向条，与上方来源构成互补：这里是按模型拆分） */}
            <section className="panel anim-fade-rise min-w-0 p-5">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <Activity className="h-4 w-4 flex-shrink-0 text-[var(--accent)]" />
                  <h2 className="truncate text-sm font-semibold text-[var(--text-primary)]">模型用量</h2>
                </div>
                <span className="flex-shrink-0 text-[length:var(--font-eyebrow)] text-[var(--text-secondary)]">按 token 排序</span>
              </div>
              {modelUsage.length > 0 ? (
                <>
                  <div className="space-y-1">
                    {(usageExpanded ? modelUsage : modelUsage.slice(0, 6)).map(({ id, name, color, usage, source }, index) => (
                      <UsageRankRow
                        key={id}
                        rank={index + 1}
                        name={name}
                        source={source}
                        tokens={usage.totalTokens}
                        total={totals.totalTokens}
                        color={color}
                        responseCount={usage.responseCount}
                        avgTokensPerSec={usage.responseCount > 0 ? usage.totalTokensPerSec / usage.responseCount : 0}
                        lastUsedAt={usage.lastUsedAt}
                      />
                    ))}
                  </div>
                  {modelUsage.length > 6 && (
                    <button
                      type="button"
                      onClick={() => setUsageExpanded((value) => !value)}
                      className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-[var(--radius-field)] border border-[var(--border)] bg-[var(--app-bg)] py-2 text-[length:var(--font-caption)] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)]"
                    >
                      {usageExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                      {usageExpanded ? '收起' : `展开全部（共 ${modelUsage.length} 个）`}
                    </button>
                  )}
                </>
              ) : (
                <div className="py-10 text-center text-[length:var(--font-caption)] text-[var(--text-secondary)]">
                  暂无真实 token 使用记录。
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

interface MonthBarRow {
  day: string;
  total: number;
  segments: Array<{ id: string; name: string; color: string; tokens: number }>;
}

interface DayBarRow {
  id: string;
  name: string;
  color: string;
  tokens: number;
}

function ChartEmpty({ label }: { label: string }) {
  return (
    <div className="grid h-full place-items-center text-[length:var(--font-caption)] text-[var(--text-secondary)]">
      {label}
    </div>
  );
}

/** 月视图：每天一根柱，柱内按模型分段；同一天用了哪些模型一眼可见。 */
function MonthModelBars({ rows, max }: { rows: MonthBarRow[]; max: number }) {
  if (!rows.some((row) => row.total > 0)) {
    return <ChartEmpty label="本月没有记录" />;
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 items-stretch gap-1 overflow-x-auto pb-1 [scrollbar-width:thin]">
        {rows.map((row) => (
          <div
            key={row.day}
            className="flex h-full min-w-[12px] flex-1 flex-col"
            title={`${row.day}：${formatCount(row.total)} 个 Token`}
          >
            <div className="flex min-h-0 flex-1 items-end">
              <div
                className="flex w-full flex-col-reverse overflow-hidden rounded-t-[2px] transition-opacity hover:opacity-85"
                style={{ height: `${(row.total / max) * 100}%` }}
              >
                {row.segments.map((segment) => (
                  <div
                    key={segment.id}
                    style={{
                      height: `${(segment.tokens / row.total) * 100}%`,
                      background: segment.color,
                    }}
                    title={`${segment.name}：${formatCount(segment.tokens)} 个 Token`}
                  />
                ))}
              </div>
            </div>
            <span className="mt-1 h-4 flex-shrink-0 text-center text-[length:var(--font-micro)] leading-4 text-[var(--text-tertiary)]">
              {Number(row.day.slice(-2))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 日视图：每个模型一根柱，直接对比当天各模型用量。 */
function DayModelBars({ rows, max }: { rows: DayBarRow[]; max: number }) {
  if (rows.length === 0) {
    return <ChartEmpty label="当天没有记录" />;
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 items-stretch gap-3 overflow-x-auto pb-1 [scrollbar-width:thin]">
        {rows.map((row) => (
          <div
            key={row.id}
            className="flex h-full min-w-[72px] max-w-[180px] flex-1 flex-col"
            title={`${row.name}：${formatCount(row.tokens)} 个 Token`}
          >
            <div className="flex min-h-0 flex-1 items-end">
              <div
                className="w-full rounded-t-[3px] transition-opacity hover:opacity-85"
                style={{ height: `${(row.tokens / max) * 100}%`, background: row.color }}
              />
            </div>
            <span
              className="mt-1 line-clamp-2 h-9 flex-shrink-0 text-[length:var(--font-micro)] leading-4 text-[var(--text-secondary)]"
              title={row.name}
            >
              {row.name}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 模型图例：颜色 + 名称 + 当前区间用量。 */
function ModelLegend({ models }: { models: Array<{ name: string; color: string; tokens: number }> }) {
  if (models.length === 0) return <div className="mt-2 h-7" />;
  return (
    <div className="mt-2 flex h-7 items-center gap-3 overflow-x-auto whitespace-nowrap pr-0.5 text-[length:var(--font-micro)] leading-none text-[var(--text-tertiary)] [scrollbar-width:thin]">
      {models.map((model, index) => (
        <span
          key={`${model.name}-${index}`}
          className="inline-flex flex-shrink-0 items-center gap-1.5"
          title={`${model.name}：${formatCount(model.tokens)} 个 Token`}
        >
          <span className="h-2.5 w-2.5 flex-shrink-0 rounded-[2px]" style={{ background: model.color }} />
          <span className="max-w-[12rem] truncate text-[var(--text-secondary)]">{model.name}</span>
          <span className="mono-font">{formatCount(model.tokens)}</span>
        </span>
      ))}
    </div>
  );
}

function UsageRankRow({ rank, name, source, tokens, total, color, responseCount, avgTokensPerSec, lastUsedAt }: {
  rank: number;
  name: string;
  source: string;
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
    <div
      className="rounded-[var(--radius-field)] px-2 py-2 transition-colors hover:bg-[var(--surface-muted)]"
      title={`${name}\n${percent.toFixed(1)}% · ${responseCount} 次 · ${avgTokensPerSec > 0 ? `${avgTokensPerSec.toFixed(1)} tok/s` : 'tok/s 暂无'}\n最近使用：${lastUsedText}`}
    >
      <div className="flex items-center gap-2">
        <span className="mono-font w-4 flex-shrink-0 text-[length:var(--font-eyebrow)] font-semibold text-[var(--text-tertiary)]">{rank}</span>
        <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: color }} />
        <span className="min-w-0 flex-1 truncate text-[length:var(--font-caption)] font-medium text-[var(--text-primary)]">{name}</span>
        <span className="flex-shrink-0 rounded-[var(--radius-sm)] bg-[var(--surface-muted)] px-1.5 py-0.5 text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">{source}</span>
        <span className="mono-font w-14 flex-shrink-0 text-right text-[length:var(--font-caption)] font-semibold text-[var(--text-primary)]">{formatCount(tokens)}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-2 pl-6">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--surface-muted)]">
          <div className="h-full rounded-full transition-[width] duration-200 ease-out" style={{ width: `${percent}%`, background: color }} />
        </div>
        <span className="mono-font w-10 flex-shrink-0 text-right text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">{percent.toFixed(0)}%</span>
      </div>
    </div>
  );
}
