import type { ReactNode } from 'react';

/**
 * 侧边栏底部的「运行状态卡」。
 *
 * 四项固定顺序：ctx、显存、内存、GPU（对话场景最关心上下文水位，排首位）。
 * 宽度适配是两档而不是「按像素微调」：
 * - 常规宽度（默认）：2×2 网格，每格一个「标签 + 百分比 + 细进度条」；
 * - 窄侧边栏：1×4 单列，每项压成一行（标签在左、数值在右），进度条降到 1px，
 *   否则 200px 宽下四格网格会把标签和数字挤成两行。
 *
 * 这项是容器查询驱动的：用 CSS `@container` 而不是窗口断点——侧边栏宽度可以由
 * 用户拖动改变，跟窗口宽度不是一回事。
 */
export interface StatusMetric {
  label: string;
  /** 百分比 0-100；undefined = 无数据（显示 `--`，条为空）。 */
  percent?: number;
  /** 悬停说明（已用 / 容量、设备名等）。 */
  detail?: string;
  /** 进度条颜色。 */
  color: string;
}

export default function RuntimeStatusCard({
  metrics,
  footer,
}: {
  metrics: StatusMetric[];
  footer?: ReactNode;
}) {
  return (
    <div className="runtime-status-card mt-2" aria-label="运行状态">
      <div className="runtime-status-grid">
        {metrics.map((metric) => (
          <RuntimeStatusCell key={metric.label} metric={metric} />
        ))}
      </div>
      {footer}
    </div>
  );
}

function RuntimeStatusCell({ metric }: { metric: StatusMetric }) {
  const has = metric.percent !== undefined && Number.isFinite(metric.percent) && metric.percent >= 0;
  const clamped = has ? Math.min(100, Math.max(0, metric.percent!)) : 0;
  return (
    <div className="runtime-status-cell" title={`${metric.label}：${has ? `${Math.round(clamped)}%` : '无数据'}${metric.detail ? ` · ${metric.detail}` : ''}`}>
      <span className="runtime-status-label">{metric.label}</span>
      <span className="runtime-status-value">{has ? `${Math.round(clamped)}%` : '--'}</span>
      <span className="runtime-status-bar" aria-hidden="true">
        <span style={{ width: `${clamped}%`, background: metric.color }} />
      </span>
    </div>
  );
}
