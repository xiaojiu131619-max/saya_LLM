import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Cpu,
  Gauge,
  HardDrive,
  Layers,
  MemoryStick,
  Monitor,
  Thermometer,
  Zap,
} from 'lucide-react';
import { getDesktopSystemStats, getDesktopVramSnapshot, isDesktopRuntime } from '@/lib/desktop';
import { getHardwareInfo } from '@/lib/ipc/hardware';
import type { SystemStats } from '@/types';

const HISTORY_SECONDS = 120;
const SAMPLE_INTERVAL_MS = 1000;

/** 一条历史样本；null 表示该轮没有读到有效读数。 */
interface PerfSample {
  t: number;
  gpuUtil: number | null;
  vramUsed: number | null;
  temperature: number | null;
  cpuUtil: number | null;
  ramUsed: number | null;
}

const emptySample = (t: number): PerfSample => ({
  t, gpuUtil: null, vramUsed: null, temperature: null, cpuUtil: null, ramUsed: null,
});

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 简易面积曲线：把最近 HISTORY_SECONDS 的样本画成 SVG 折线 + 渐变填充。
 * 缺测样本直接跳过（不补零），两端有效值连线。
 */
function Sparkline({ samples, pick, color, max }: {
  samples: PerfSample[];
  pick: (sample: PerfSample) => number | null;
  color: string;
  max?: number;
}) {
  const points = samples
    .map((sample, index) => ({ value: pick(sample), index }))
    .filter((entry): entry is { value: number; index: number } => finite(entry.value));
  if (points.length < 2) {
    return <div className="h-10 rounded-[var(--radius-sm)] bg-[var(--surface-muted)]" aria-hidden="true" />;
  }
  const upper = Math.max(1e-6, max ?? Math.max(...points.map((point) => point.value)) * 1.15);
  const path = points
    .map((point, position) => `${position === 0 ? 'M' : 'L'}${(point.index / Math.max(1, samples.length - 1)) * 100},${40 - (point.value / upper) * 36 - 2}`)
    .join(' ');
  const area = `${path} L100,40 L0,40 Z`;
  const gradientId = `spark-${color.replace(/[^a-z]/gi, '')}`;
  return (
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-10 w-full" aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <path d={path} fill="none" stroke={color} strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** 单块实时指标卡：标签 + 当前值 + 简史曲线。 */
function PerfCard({ icon: Icon, label, value, unit, detail, samples, pick, color, max }: {
  icon: typeof Cpu;
  label: string;
  value: string;
  unit?: string;
  detail?: string;
  samples: PerfSample[];
  pick: (sample: PerfSample) => number | null;
  color: string;
  max?: number;
}) {
  return (
    <div className="panel flex min-w-0 flex-col p-4">
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="h-4 w-4 flex-shrink-0 text-[var(--accent)]" />
        <span className="min-w-0 flex-1 truncate text-[length:var(--font-caption)] font-semibold text-[var(--text-secondary)]">{label}</span>
        <span className="flex-shrink-0 text-[length:var(--font-micro)] text-[var(--text-tertiary)]">实时</span>
      </div>
      <div className="mt-2 flex items-baseline gap-1.5 overflow-hidden">
        <span className="mono-font truncate text-[length:var(--font-display)] font-bold leading-tight text-[var(--text-primary)]">{value}</span>
        {unit && <span className="flex-shrink-0 text-[length:var(--font-caption)] text-[var(--text-secondary)]">{unit}</span>}
      </div>
      {detail && <div className="mt-0.5 truncate text-[length:var(--font-micro)] text-[var(--text-tertiary)]" title={detail}>{detail}</div>}
      <div className="mt-auto pt-3">
        <Sparkline samples={samples} pick={pick} color={color} max={max} />
      </div>
    </div>
  );
}

/**
 * API 服务页的实时性能面板：每秒采样 GPU 利用率、显存、温度、CPU 与内存，
 * 保留最近两分钟历史画成曲线；上下文占用与最近请求交给 API 服务面板，不在这里重复。
 */
export default function PerformancePanel() {
  const [samples, setSamples] = useState<PerfSample[]>([]);
  const [gpuName, setGpuName] = useState<string | null>(null);
  const [vramTotal, setVramTotal] = useState<number | null>(null);
  const [ramTotal, setRamTotal] = useState<number | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let disposed = false;
    void getHardwareInfo()
      .then((info) => {
        if (disposed) return;
        setGpuName(info.gpu_name || null);
        setVramTotal(Number.isFinite(info.total_vram) && info.total_vram > 0 ? info.total_vram : null);
      })
      .catch(() => undefined);

    const sample = async () => {
      const stamp = Date.now();
      try {
        const hardware = await getHardwareInfo();
        const stats = await getDesktopSystemStats({
          gpuUsage: 0, vramUsed: 0, vramTotal: 0, ramUsage: 0, ramTotal: 0,
          computeScores: [], gpuName: '', hostName: '',
        } as SystemStats);
        if (disposed) return;
        const snapshot = await getDesktopVramSnapshot().catch(() => null);
        setGpuName((current) => current ?? (hardware.gpu_name || null));
        setVramTotal((current) => current ?? (Number.isFinite(hardware.total_vram) && hardware.total_vram > 0 ? hardware.total_vram : null));
        setRamTotal((current) => current ?? (finite(stats?.ramTotal) && stats.ramTotal > 0 ? stats.ramTotal : null));
        setSamples((history) => {
          const next = [
            ...history,
            {
              t: stamp,
              gpuUtil: finite(stats?.gpuUsage) ? stats.gpuUsage : finite(hardware.utilization) ? hardware.utilization : null,
              vramUsed: finite(stats?.vramUsed) && stats.vramUsed > 0
                ? stats.vramUsed
                : finite(snapshot?.used_gb) ? snapshot.used_gb : null,
              temperature: finite(hardware.temperature) && hardware.temperature > 0 ? hardware.temperature : null,
              cpuUtil: null,
              ramUsed: finite(stats?.ramTotal) && finite(stats?.ramUsage)
                ? (stats.ramTotal * stats.ramUsage) / 100
                : null,
            },
          ];
          const cutoff = stamp - HISTORY_SECONDS * 1000;
          return next.filter((entry) => entry.t >= cutoff).slice(-HISTORY_SECONDS);
        });
      } catch {
        if (!disposed) setSamples((history) => [...history.slice(-HISTORY_SECONDS + 1), emptySample(stamp)]);
      }
    };
    void sample();
    timerRef.current = window.setInterval(() => void sample(), SAMPLE_INTERVAL_MS);
    return () => {
      disposed = true;
      if (timerRef.current != null) window.clearInterval(timerRef.current);
    };
  }, []);

  const latest = samples.length > 0 ? samples[samples.length - 1] : null;
  const cpuSample = useMemo(() => (samples.length > 0 ? samples : []), [samples]);
  const gpuColor = 'var(--accent)';
  const vramColor = 'var(--state-success)';
  const tempColor = 'var(--state-warning)';
  const ramColor = 'var(--text-secondary)';
  const vramPercent = latest?.vramUsed != null && vramTotal ? Math.min(100, (latest.vramUsed / vramTotal) * 100) : null;
  const ramPercent = latest?.ramUsed != null && ramTotal ? Math.min(100, (latest.ramUsed / ramTotal) * 100) : null;

  return (
    <section className="panel p-5" aria-label="实时性能">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[length:var(--font-body)] font-bold tracking-[var(--tracking-tight)] text-[var(--text-primary)]">实时性能</h2>
          <p className="mt-0.5 text-[length:var(--font-caption)] text-[var(--text-secondary)]">
            每秒采样，保留最近 {Math.round(HISTORY_SECONDS / 60)} 分钟历史；模型负载时曲线会立即响应。
          </p>
        </div>
        <span className="flex flex-shrink-0 items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface-muted)] px-2.5 py-1 text-[length:var(--font-eyebrow)] font-bold text-[var(--text-secondary)]">
          <Gauge className="h-3.5 w-3.5" />
          {gpuName ?? '未检测到 GPU'}
        </span>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <PerfCard
          icon={Zap}
          label="GPU 负载"
          value={latest?.gpuUtil != null ? latest.gpuUtil.toFixed(0) : '—'}
          unit="%"
          detail={gpuName ?? undefined}
          samples={cpuSample}
          pick={(entry) => entry.gpuUtil}
          color={gpuColor}
          max={100}
        />
        <PerfCard
          icon={Layers}
          label="显存占用"
          value={latest?.vramUsed != null ? latest.vramUsed.toFixed(1) : '—'}
          unit={vramTotal ? `/ ${vramTotal.toFixed(0)} GB` : 'GB'}
          detail={vramPercent != null ? `已用 ${vramPercent.toFixed(0)}%` : undefined}
          samples={cpuSample}
          pick={(entry) => entry.vramUsed}
          color={vramColor}
          max={vramTotal ?? undefined}
        />
        <PerfCard
          icon={Thermometer}
          label="GPU 温度"
          value={latest?.temperature != null ? latest.temperature.toFixed(0) : '—'}
          unit="°C"
          detail={latest?.temperature != null && latest.temperature >= 80 ? '温度偏高，注意散热' : undefined}
          samples={cpuSample}
          pick={(entry) => entry.temperature}
          color={tempColor}
          max={100}
        />
        <PerfCard
          icon={Cpu}
          label="系统内存"
          value={latest?.ramUsed != null ? latest.ramUsed.toFixed(1) : '—'}
          unit={ramTotal ? `/ ${ramTotal.toFixed(0)} GB` : 'GB'}
          detail={ramPercent != null ? `已用 ${ramPercent.toFixed(0)}%` : undefined}
          samples={cpuSample}
          pick={(entry) => entry.ramUsed}
          color={ramColor}
          max={ramTotal ?? undefined}
        />
        <PerfCard
          icon={MemoryStick}
          label="显存带宽压力"
          value={vramPercent != null ? vramPercent.toFixed(0) : '—'}
          unit="%"
          detail="按显存占用比例近似，观察 KV 增长趋势"
          samples={cpuSample}
          pick={(entry) => (entry.vramUsed != null && vramTotal ? (entry.vramUsed / vramTotal) * 100 : null)}
          color={vramColor}
          max={100}
        />
        <PerfCard
          icon={HardDrive}
          label="显存余量"
          value={latest?.vramUsed != null && vramTotal ? Math.max(0, vramTotal - latest.vramUsed).toFixed(1) : '—'}
          unit="GB"
          detail="可再容纳的 KV / 草稿模型空间"
          samples={cpuSample}
          pick={(entry) => (entry.vramUsed != null && vramTotal ? Math.max(0, vramTotal - entry.vramUsed) : null)}
          color={gpuColor}
          max={vramTotal ?? undefined}
        />
      </div>

      {samples.length === 0 && (
        <div className="mt-3 flex items-center gap-2 text-[length:var(--font-caption)] text-[var(--text-secondary)]">
          <Monitor className="h-3.5 w-3.5 flex-shrink-0" />
          正在采集第一批样本；桌面运行环境下每秒刷新一次。
        </div>
      )}
    </section>
  );
}
