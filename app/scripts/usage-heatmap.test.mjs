import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

/**
 * 使用统计热力图的时间缩放（年 / 月 / 日）。
 *
 * 用 TypeScript 现场转译后直接测纯函数：
 * buildHeatmapView 决定每个粒度下铺哪些格子、汇总怎么算；
 * 重点验证「日视图不伪造小时数据」这条约定。
 */

const source = readFileSync(new URL('../src/lib/usageHeatmap.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const {
  buildHeatmapView,
  dayKey,
  parseDayKey,
  heatmapCellSize,
  heatmapWidth,
  HEATMAP_SCALES,
} = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

const daily = (entries) => Object.fromEntries(entries.map(([day, tokens]) => [day, tokens]));

// ---------------------------------------------------------------------------
// 三档粒度的基本形状
// ---------------------------------------------------------------------------

test('三档粒度都有中文标签与说明', () => {
  assert.deepEqual(HEATMAP_SCALES.map((item) => item.id), ['year', 'month', 'day']);
  for (const item of HEATMAP_SCALES) {
    assert.ok(item.label.length > 0);
    assert.ok(item.hint.length > 0);
  }
});

test('年视图：覆盖整年，标题与日期范围正确', () => {
  const view = buildHeatmapView({}, 'year', new Date(2026, 9, 30));
  assert.equal(view.title, '2026 年');
  assert.equal(view.startDay, '2026-01-01');
  assert.equal(view.endDay, '2026-12-31');
  // 2026 有 365 天；第一条周列前面按 1 月 1 日的星期补位
  const cells = view.columns.flatMap((column) => column.cells).filter((cell) => cell.day);
  assert.equal(cells.length, 365);
});

test('年视图：闰年 366 天', () => {
  const view = buildHeatmapView({}, 'year', new Date(2024, 5, 1));
  const cells = view.columns.flatMap((column) => column.cells).filter((cell) => cell.day);
  assert.equal(cells.length, 366);
});

test('月视图：覆盖当月并给出正确标题', () => {
  const view = buildHeatmapView({}, 'month', new Date(2026, 9, 30));
  assert.equal(view.title, '2026 年 10 月');
  assert.equal(view.startDay, '2026-10-01');
  assert.equal(view.endDay, '2026-10-31');
  const cells = view.columns.flatMap((column) => column.cells).filter((cell) => cell.day);
  assert.equal(cells.length, 31);
});

test('月视图：2 月按真实天数（平年 28 / 闰年 29）', () => {
  const flat = (view) => view.columns.flatMap((c) => c.cells).filter((cell) => cell.day).length;
  assert.equal(flat(buildHeatmapView({}, 'month', new Date(2026, 1, 10))), 28);
  assert.equal(flat(buildHeatmapView({}, 'month', new Date(2024, 1, 10))), 29);
});

// ---------------------------------------------------------------------------
// 数据映射与汇总
// ---------------------------------------------------------------------------

test('年视图：token 落到正确的日期格子上', () => {
  const view = buildHeatmapView(daily([['2026-03-15', 1234]]), 'year', new Date(2026, 2, 1));
  const cells = view.columns.flatMap((column) => column.cells);
  const target = cells.find((cell) => cell.day === '2026-03-15');
  assert.ok(target);
  assert.equal(target.tokens, 1234);
  assert.ok(target.level > 0, '有 token 的格子应至少 1 级');
});

test('汇总：总量与有记录天数只统计视图范围内', () => {
  const data = daily([
    ['2026-01-01', 100],
    ['2026-12-31', 50],
    ['2025-12-31', 9999],  // 上一年，不该计入
    ['2026-06-01', 0],     // 零值不算有记录
  ]);
  const view = buildHeatmapView(data, 'year', new Date(2026, 5, 1));
  assert.equal(view.totalTokens, 150);
  assert.equal(view.activeDays, 2);
});

test('月视图：只统计当月，不含邻月', () => {
  const data = daily([
    ['2026-09-30', 111],
    ['2026-10-01', 10],
    ['2026-10-31', 20],
    ['2026-11-01', 222],
  ]);
  const view = buildHeatmapView(data, 'month', new Date(2026, 9, 15));
  assert.equal(view.totalTokens, 30);
  assert.equal(view.activeDays, 2);
  assert.equal(view.maxDayTokens, 20);
});

test('配色分档：峰值按视图内最大值，不是全局最大值', () => {
  const data = daily([['2026-10-01', 100], ['2026-03-01', 1_000_000]]);
  const monthView = buildHeatmapView(data, 'month', new Date(2026, 9, 15));
  const cells = monthView.columns.flatMap((c) => c.cells).filter((cell) => cell.day);
  const peak = cells.find((cell) => cell.day === '2026-10-01');
  // 月视图里 100 就是当月峰值，应当落在最高档
  assert.equal(peak.level, 4);
  assert.equal(monthView.maxDayTokens, 100);
});

// ---------------------------------------------------------------------------
// 日视图：不伪造小时数据
// ---------------------------------------------------------------------------

test('日视图：不给 columns（不铺 24 小时格）', () => {
  const view = buildHeatmapView(daily([['2026-10-30', 500]]), 'day', new Date(2026, 9, 30));
  assert.deepEqual(view.columns, [], '日视图不应生成小时格子');
});

test('日视图：给当日读数与当月上下文', () => {
  const data = daily([['2026-10-01', 100], ['2026-10-30', 500], ['2026-10-31', 300]]);
  const view = buildHeatmapView(data, 'day', new Date(2026, 9, 30));
  assert.equal(view.title, '2026 年 10 月 30 日');
  assert.equal(view.totalTokens, 500);
  const detail = view.dayDetail;
  assert.ok(detail);
  assert.equal(detail.day, '2026-10-30');
  assert.equal(detail.tokens, 500);
  assert.equal(detail.monthDays.length, 31);
  assert.equal(detail.monthTotal, 900);
  // 日均只按有记录的天算：(100 + 500 + 300) / 3
  assert.ok(Math.abs(detail.monthAverage - 300) < 1e-9);
});

test('日视图：当月没有任何记录时日均是 null（不是 0）', () => {
  const view = buildHeatmapView({}, 'day', new Date(2026, 9, 30));
  assert.equal(view.dayDetail.tokens, 0);
  assert.equal(view.dayDetail.monthTotal, 0);
  assert.equal(view.dayDetail.monthAverage, null, '无记录应明确为 null，不能伪装成 0');
});

test('日视图：零 token 的日子 activeDays 为 0', () => {
  const view = buildHeatmapView({}, 'day', new Date(2026, 9, 30));
  assert.equal(view.activeDays, 0);
});

// ---------------------------------------------------------------------------
// 渲染尺寸
// ---------------------------------------------------------------------------

test('格子尺寸：月视图比年视图大，日视图不参与', () => {
  const year = heatmapCellSize('year');
  const month = heatmapCellSize('month');
  assert.ok(month.cell > year.cell, '月视图格子应更大');
  assert.ok(month.gap >= year.gap);
});

test('整幅宽度：月视图按放大的格子算，日视图为 0', () => {
  const yearView = buildHeatmapView({}, 'year', new Date(2026, 0, 1));
  const monthView = buildHeatmapView({}, 'month', new Date(2026, 9, 1));
  assert.ok(heatmapWidth(yearView) > 0);
  assert.ok(heatmapWidth(monthView) > 0);
  // 年视图列数远多于月视图，即使格子更小，总宽也更大
  assert.ok(heatmapWidth(yearView) > heatmapWidth(monthView));
  assert.equal(heatmapWidth(buildHeatmapView({}, 'day', new Date(2026, 9, 30))), 0);
});

// ---------------------------------------------------------------------------
// 日期工具
// ---------------------------------------------------------------------------

test('dayKey / parseDayKey 互为逆运算，且用本地日期不跨时区', () => {
  const date = new Date(2026, 9, 5, 23, 59, 59);
  const key = dayKey(date);
  assert.equal(key, '2026-10-05');
  const back = parseDayKey(key);
  assert.equal(back.getFullYear(), 2026);
  assert.equal(back.getMonth(), 9);
  assert.equal(back.getDate(), 5);
});

test('跨月的日视图翻页边界：月末日期不变形', () => {
  // 1 月 31 日往前一天是 1 月 30 日（不能跳成 12 月 31 日）
  const anchor = new Date(2026, 0, 31);
  const prev = new Date(anchor);
  prev.setDate(prev.getDate() - 1);
  assert.equal(dayKey(prev), '2026-01-30');
});
