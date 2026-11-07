import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Gauge,
  HardDrive,
  MemoryStick,
  Monitor,
  RefreshCw,
  Sparkles,
  Zap,
} from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import { getDeviceProfile, type DeviceProfile } from '@/lib/ipc/system';
import { getBackendTuningAdvice, type BackendTuningAdvice } from '@/lib/ipc/hardware';
import { isDesktopRuntime } from '@/lib/desktopRuntime';

function formatGb(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '未知';
  return `${value.toFixed(value >= 10 ? 1 : 2)} GB`;
}

function formatPct(value: number) {
  return Number.isFinite(value) ? `${Math.min(100, Math.max(0, value)).toFixed(0)}%` : '未知';
}

function StatCard({ icon: Icon, label, value, detail }: {
  icon: typeof Cpu;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="panel min-w-0 p-4">
      <div className="flex items-center gap-2 text-[length:var(--font-eyebrow)] text-[var(--text-secondary)]">
        <Icon className="h-4 w-4 text-[var(--accent)]" />
        <span>{label}</span>
      </div>
      <div className="mono-font mt-2 truncate text-[length:var(--font-title)] font-semibold text-[var(--text-primary)]" title={value}>{value}</div>
      <div className="mt-1 truncate text-[length:var(--font-caption)] text-[var(--text-secondary)]" title={detail}>{detail}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-3 border-b border-[var(--border-subtle)] py-2 last:border-b-0">
      <span className="flex-shrink-0 text-[length:var(--font-caption)] text-[var(--text-secondary)]">{label}</span>
      <span className="mono-font min-w-0 break-words text-right text-[length:var(--font-caption)] text-[var(--text-primary)]">{value}</span>
    </div>
  );
}

export default function DevicePage() {
  const [profile, setProfile] = useState<DeviceProfile | null>(null);
  const [advice, setAdvice] = useState<BackendTuningAdvice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextProfile, nextAdvice] = await Promise.all([
        getDeviceProfile(),
        isDesktopRuntime() ? getBackendTuningAdvice().catch(() => null) : Promise.resolve(null),
      ]);
      setProfile(nextProfile);
      setAdvice(nextAdvice);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getDeviceProfile()
      .then((value) => {
        if (!cancelled) {
          setProfile(value);
          setError(null);
        }
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const kernelReady = profile?.kernel.exists === true;
  const gpu = profile?.gpus.find((item) => item.selected) ?? profile?.gpus[0] ?? null;
  const osLabel = profile
    ? profile.osVersion.toLowerCase().startsWith(profile.osName.toLowerCase())
      ? profile.osVersion
      : `${profile.osName} ${profile.osVersion}`
    : '';
  const ramUsed = profile ? Math.max(0, profile.memoryTotalGb - profile.memoryAvailableGb) : 0;
  const ramPercent = profile && profile.memoryTotalGb > 0 ? (ramUsed / profile.memoryTotalGb) * 100 : 0;
  const vramPercent = gpu && gpu.totalVramGb > 0 ? (gpu.usedVramGb / gpu.totalVramGb) * 100 : 0;

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-[var(--app-bg)] text-[var(--text-primary)]">
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-[1160px]">
          <PageHeader
            icon={Monitor}
            title="设备详情"
            description="自动调参前先探测本机处理器、内存、显卡、磁盘与 llama.cpp 内核能力；这里的 90% 显存预算就是自动调参的准入上限。"
            className="anim-fade-rise"
            actions={(
              <button
                type="button"
                onClick={() => void refresh()}
                disabled={loading}
                className="action-button inline-flex h-8 items-center gap-1.5 px-3 text-xs disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                {loading ? '探测中…' : '重新探测'}
              </button>
            )}
          />

          {error && (
            <div className="mt-4 flex items-start gap-2 rounded-[var(--radius-field)] border border-[var(--state-danger-border)] bg-[var(--state-danger-bg)] p-3 text-[length:var(--font-caption)] text-[var(--state-danger)]">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>设备探测失败：{error}</span>
            </div>
          )}

          {!profile && loading && (
            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {[0, 1, 2, 3].map((item) => <div key={item} className="panel h-24 animate-pulse bg-[var(--surface-muted)]" />)}
            </div>
          )}

          {profile && (
            <>
              <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <StatCard
                  icon={Cpu}
                  label="处理器"
                  value={profile.cpuBrand}
                  detail={`${profile.physicalCores} 物理核心 / ${profile.logicalCores} 逻辑线程`}
                />
                <StatCard
                  icon={MemoryStick}
                  label="系统内存"
                  value={`${formatGb(profile.memoryAvailableGb)} 可用`}
                  detail={`共 ${formatGb(profile.memoryTotalGb)} · 已用 ${formatPct(ramPercent)}`}
                />
                <StatCard
                  icon={Monitor}
                  label="显卡"
                  value={gpu?.name ?? '未检测到 GPU'}
                  detail={gpu ? `${formatGb(gpu.usedVramGb)} / ${formatGb(gpu.totalVramGb)} · ${formatPct(vramPercent)}` : '自动调参将只能使用 CPU'}
                />
                <StatCard
                  icon={kernelReady ? CheckCircle2 : AlertTriangle}
                  label="llama.cpp 内核"
                  value={profile.kernel.version ?? '未检测'}
                  detail={kernelReady ? `${profile.kernel.runtimeBackend ?? profile.kernel.hostBackend ?? '未知后端'} · ${profile.kernel.runtimeDevices.join(' / ') || '无设备列表'}` : '未找到可执行内核'}
                />
              </div>

              <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
                <section className="panel p-5">
                  <div className="flex items-center gap-2">
                    <Gauge className="h-4 w-4 text-[var(--accent)]" />
                    <h2 className="text-[length:var(--font-subtitle)] font-semibold">显卡与显存</h2>
                  </div>
                  {profile.gpus.length === 0 ? (
                    <p className="mt-3 text-sm text-[var(--text-secondary)]">未检测到可用显卡；自动调参会跳过 GPU 候选。</p>
                  ) : (
                    <div className="mt-3 space-y-3">
                      {profile.gpus.map((item) => {
                        const percent = item.totalVramGb > 0 ? (item.usedVramGb / item.totalVramGb) * 100 : 0;
                        return (
                          <div key={item.index} className="rounded-[var(--radius-field)] border border-[var(--border-subtle)] p-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.name}</span>
                              {item.selected && <span className="rounded bg-[var(--accent-subtle)] px-1.5 py-0.5 text-[length:var(--font-micro)] text-[var(--accent)]">当前使用</span>}
                              <span className="text-[length:var(--font-micro)] text-[var(--text-tertiary)]">{item.source}</span>
                            </div>
                            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--surface-muted)]">
                              <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${Math.min(100, percent)}%` }} />
                            </div>
                            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[length:var(--font-caption)] text-[var(--text-secondary)] sm:grid-cols-4">
                              <span>显存 <b className="mono-font text-[var(--text-primary)]">{formatGb(item.usedVramGb)} / {formatGb(item.totalVramGb)}</b></span>
                              <span>利用率 <b className="mono-font text-[var(--text-primary)]">{formatPct(item.utilization)}</b></span>
                              <span>温度 <b className="mono-font text-[var(--text-primary)]">{item.temperature > 0 ? `${item.temperature.toFixed(0)}°C` : '未知'}</b></span>
                              <span>驱动 <b className="mono-font text-[var(--text-primary)]">{item.driverVersion ?? '未读取'}</b></span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div className="mt-4 grid gap-x-6 sm:grid-cols-2">
                    <div>
                      <Row label="显卡厂商" value={profile.gpuVendor} />
                      <Row label="运行后端" value={profile.gpuBackend} />
                      <Row label="CUDA 版本" value={profile.cudaVersion ?? profile.kernel.cudaVersion ?? '未检测'} />
                    </div>
                    <div>
                      <Row label="AMD 架构" value={profile.amdArch ?? '不适用'} />
                      <Row label="SM 架构" value={profile.kernel.smArchitecture ?? '未读取'} />
                      <Row label="计算图加速" value={profile.kernel.cudaGraphsEnabled ? '已启用' : '未启用'} />
                    </div>
                  </div>
                </section>

                <section className="panel p-5">
                  <div className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-[var(--accent)]" />
                    <h2 className="text-[length:var(--font-subtitle)] font-semibold">自动调参依据</h2>
                  </div>
                  <div className="mt-3">
                    <Row label="90% 显存预算" value={formatGb(profile.recommendations.vramBudgetGb)} />
                    <Row label="当前可用余量" value={formatGb(profile.recommendations.vramHeadroomGb)} />
                    <Row label="建议线程数" value={`${profile.recommendations.recommendedThreads}`} />
                    <Row label="建议上下文" value={profile.recommendations.recommendedCtx.toLocaleString()} />
                  </div>
                  <ul className="mt-3 space-y-1.5 text-[length:var(--font-caption)] leading-relaxed text-[var(--text-secondary)]">
                    {profile.recommendations.notes.map((note) => (
                      <li key={note} className="flex gap-1.5">
                        <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-[var(--accent)]" />
                        <span>{note}</span>
                      </li>
                    ))}
                  </ul>
                  {advice && advice.notes.length > 0 && (
                    <div className="mt-4 border-t border-[var(--border-subtle)] pt-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[length:var(--font-caption)] font-semibold text-[var(--text-primary)]">后端调优建议</span>
                        <span className="rounded bg-[var(--accent-subtle)] px-1.5 py-0.5 text-[length:var(--font-micro)] text-[var(--accent)]">{advice.backend}</span>
                        {advice.amdArch && (
                          <span className="rounded bg-[var(--surface-muted)] px-1.5 py-0.5 text-[length:var(--font-micro)] text-[var(--text-secondary)]">{advice.amdArch}</span>
                        )}
                        <span className="mono-font text-[length:var(--font-micro)] text-[var(--text-tertiary)]">
                          -ub {advice.recommendedUbatch} · -b {advice.recommendedBatch}
                          {advice.recommendedKvQuant ? ` · KV ${advice.recommendedKvQuant}` : ''}
                        </span>
                      </div>
                      <ul className="mt-2 space-y-1.5 text-[length:var(--font-caption)] leading-relaxed text-[var(--text-secondary)]">
                        {advice.notes.map((note) => (
                          <li key={note} className="flex gap-1.5">
                            <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-[var(--state-success)]" />
                            <span>{note}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </section>
              </div>

              <div className="mt-4 grid gap-4 xl:grid-cols-2">
                <section className="panel p-5">
                  <div className="flex items-center gap-2">
                    <Cpu className="h-4 w-4 text-[var(--accent)]" />
                    <h2 className="text-[length:var(--font-subtitle)] font-semibold">处理器与内存</h2>
                  </div>
                  <div className="mt-3">
                    <Row label="处理器型号" value={profile.cpuBrand} />
                    <Row label="物理核心 / 逻辑线程" value={`${profile.physicalCores} / ${profile.logicalCores}`} />
                    <Row label="内存总量" value={formatGb(profile.memoryTotalGb)} />
                    <Row label="当前可用" value={formatGb(profile.memoryAvailableGb)} />
                    <Row label="系统" value={`${osLabel} · ${profile.arch}`} />
                    <Row label="主机名" value={profile.hostname} />
                  </div>
                </section>

                <section className="panel p-5">
                  <div className="flex items-center gap-2">
                    <Zap className="h-4 w-4 text-[var(--accent)]" />
                    <h2 className="text-[length:var(--font-subtitle)] font-semibold">内核与存储</h2>
                  </div>
                  <div className="mt-3">
                    <Row label="内核路径" value={profile.kernel.exePath} />
                    <Row label="内核版本" value={profile.kernel.version ?? '未检测'} />
                    <Row label="运行设备" value={profile.kernel.runtimeDevices.join(' / ') || '无'} />
                    <Row label="内核能力" value={profile.kernel.features.length > 0 ? profile.kernel.features.join('、') : '未报告新参数能力'} />
                  </div>
                  {profile.modelDirs.length > 0 && (
                    <div className="mt-3 border-t border-[var(--border-subtle)] pt-3">
                      <div className="mb-1 flex items-center gap-1.5 text-[length:var(--font-caption)] text-[var(--text-secondary)]">
                        <HardDrive className="h-3.5 w-3.5" />
                        模型目录
                      </div>
                      {profile.modelDirs.map((dir) => (
                        <div key={dir.path} className="flex min-w-0 items-start justify-between gap-3 py-1 text-[length:var(--font-caption)]">
                          <span className="mono-font min-w-0 break-all text-[var(--text-secondary)]">{dir.path}</span>
                          <span className="mono-font flex-shrink-0 text-[var(--text-primary)]">
                            {dir.exists ? `${formatGb(dir.freeGb)} 可用 / ${formatGb(dir.totalGb)}` : '目录不存在'}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
