import { useEffect, useMemo, useState } from 'react';
import { Boxes, Cpu, Play, RefreshCw, Square, Terminal } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import ToggleSwitch from '@/components/ToggleSwitch';
import { useApp } from '@/context/AppContext';
import {
  clearEmbeddingLogs,
  getDesktopConfig,
  getEmbeddingLogs,
  getEmbeddingStatus,
  isDesktopRuntime,
  listenDesktopEvent,
  saveDesktopRuntimeSettings,
  startEmbeddingServer,
  stopEmbeddingServer,
  type DesktopEmbeddingStatus,
} from '@/lib/desktop';
import type { ModelInfo } from '@/types';

type PoolingMode = 'auto' | 'mean' | 'cls' | 'last' | 'rank';

const POOLING_OPTIONS: Array<{ value: PoolingMode; label: string }> = [
  { value: 'auto', label: '跟随模型默认' },
  { value: 'mean', label: 'mean（均值池化）' },
  { value: 'cls', label: 'cls（首 token）' },
  { value: 'last', label: 'last（末 token）' },
  { value: 'rank', label: 'rank（重排）' },
];

const DEFAULT_EMBEDDING_PORT = 8081;

function clampPort(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_EMBEDDING_PORT;
  return Math.min(65535, Math.max(1, Math.round(value)));
}

function isVectorModel(model: ModelInfo) {
  return model.modelTask === 'embedding' || model.modelTask === 'rerank';
}

export default function EmbeddingWorkspace() {
  const { state, dispatch } = useApp();
  const vectorModels = useMemo(() => state.models.filter(isVectorModel), [state.models]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [port, setPort] = useState<number>(DEFAULT_EMBEDDING_PORT);
  const [pooling, setPooling] = useState<PoolingMode>('auto');
  const [embdNormalize, setEmbdNormalize] = useState<number>(2);
  const [normalizeEnabled, setNormalizeEnabled] = useState(false);
  const [status, setStatus] = useState<DesktopEmbeddingStatus | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [progress, setProgress] = useState<number>(0);

  const selected = vectorModels.find((model) => model.id === selectedId) ?? vectorModels[0] ?? null;

  // 端口从后端配置读取一次。
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    void getDesktopConfig()
      .then((config) => {
        if (config?.embedding_port) setPort(clampPort(config.embedding_port));
      })
      .catch(() => undefined);
  }, []);

  // 切换模型时重置池化方式：不同模型的默认 pooling 不同，沿用上一个模型的选择
  // 容易造成「看起来是自动、实际带着旧值启动」。放在选择动作里而不是 effect 里，
  // 避免 effect 内同步 setState 引发的级联渲染。
  const handleSelectModel = (id: string) => {
    setSelectedId(id);
    setPooling('auto');
  };

  // 状态轮询 + 日志轮询：未运行时 1.5s 一次（能立刻看到启动/停止结果），
  // 运行中降到 5s（状态稳定，日志增长也很慢），避免长期开着空转的 IPC。
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let disposed = false;
    let timer: number | undefined;

    const refresh = async () => {
      let running = false;
      try {
        const next = await getEmbeddingStatus();
        if (!disposed) setStatus(next);
        running = Boolean(next?.running);
      } catch {
        if (!disposed) setStatus(null);
      }
      try {
        const lines = await getEmbeddingLogs();
        if (!disposed) setLogs(lines.slice(-200));
      } catch {
        if (!disposed) setLogs([]);
      }
      if (!disposed) {
        timer = window.setTimeout(() => void refresh(), running ? 5000 : 1500);
      }
    };

    void refresh();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  // 启动进度/就绪/错误事件。
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    const unlisteners: Array<() => void> = [];
    void listenDesktopEvent<{ progress: number; stage: string }>('embedding:progress', (event) => {
      setProgress(Math.max(0, Math.min(100, Number(event?.progress ?? 0))));
      if (event?.stage) setMessage(event.stage);
    }).then((unlisten) => unlisteners.push(unlisten));
    void listenDesktopEvent<{ message?: string }>('embedding:ready', () => {
      setProgress(100);
      setBusy(false);
      setMessage('向量服务已就绪。');
    }).then((unlisten) => unlisteners.push(unlisten));
    void listenDesktopEvent<{ title?: string; details?: string }>('embedding:error', (error) => {
      setBusy(false);
      setMessage(`启动失败：${error?.title ?? ''} ${error?.details ?? ''}`.trim());
    }).then((unlisten) => unlisteners.push(unlisten));
    void listenDesktopEvent('embedding:stopped', () => {
      setBusy(false);
      setProgress(0);
      setMessage('向量服务已停止。');
    }).then((unlisten) => unlisteners.push(unlisten));
    return () => unlisteners.forEach((unlisten) => unlisten());
  }, []);

  const handleStart = async () => {
    if (!selected || !isDesktopRuntime() || busy) return;
    setBusy(true);
    setMessage('正在启动向量服务...');
    setProgress(4);
    try {
      await saveDesktopRuntimeSettings({ embeddingPort: clampPort(port) });
      await startEmbeddingServer(
        selected,
        clampPort(port),
        'resources/llama-server.exe',
        state.apiConfig,
        pooling === 'auto' ? undefined : pooling,
        normalizeEnabled ? embdNormalize : undefined,
      );
    } catch (error) {
      setBusy(false);
      setMessage(`启动失败：${String(error instanceof Error ? error.message : error)}`);
    }
  };

  const handleStop = async () => {
    if (!isDesktopRuntime()) return;
    try {
      await stopEmbeddingServer();
      setBusy(false);
      setProgress(0);
      setMessage('向量服务已停止。');
    } catch (error) {
      setMessage(`停止失败：${String(error)}`);
    }
  };

  const running = Boolean(status?.running);
  const activePort = status?.port ?? clampPort(port);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--app-bg)]">
      <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        <div className="mx-auto max-w-[1180px] min-[1600px]:max-w-[1520px] space-y-5">
          <PageHeader
            icon={Boxes}
            title="向量服务"
            description="Embedding / Rerank 模型独立运行，可与对话模型同时使用。"
          />

          {vectorModels.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface-muted)] px-4 py-10 text-center dark:bg-white/[0.03]">
              <Boxes className="mx-auto mb-3 h-8 w-8 text-[var(--text-tertiary)]" />
              <div className="text-sm font-medium text-[var(--text-primary)]">未发现向量 / 重排模型</div>
              <p className="mx-auto mt-2 max-w-xl text-xs leading-5 text-[var(--text-tertiary)]">
                把向量或重排模型的 GGUF 放进模型目录后重新扫描。
              </p>
              <button
                type="button"
                onClick={() => dispatch({ type: 'SET_VIEW', payload: 'home' })}
                className="mt-4 inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)]"
              >
                <RefreshCw className="h-4 w-4" />
                去模型列表
              </button>
            </div>
          ) : (
            <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
              <div className="space-y-5">
                {/* 模型选择 */}
                <section className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4 dark:border-white/[0.08] dark:bg-white/[0.03]">
                  <h2 className="mb-3 text-sm font-semibold text-[var(--text-primary)]">选择向量模型</h2>
                  <div className="space-y-2">
                    {vectorModels.map((model) => {
                      const active = model.id === selected?.id;
                      return (
                        <button
                          key={model.id}
                          type="button"
                          onClick={() => handleSelectModel(model.id)}
                          className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                            active
                              ? 'border-[var(--accent)] bg-[var(--accent-subtle)]'
                              : 'border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)]'
                          }`}
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-medium text-[var(--text-primary)]">{model.name}</span>
                              <span
                                className={`flex-shrink-0 rounded-md px-1.5 py-0.5 text-[length:var(--font-micro)] font-medium ${
                                  model.modelTask === 'rerank'
                                    ? 'bg-[var(--accent-subtle)] text-[var(--accent)]'
                                    : 'bg-[var(--state-success-bg)] text-[var(--state-success)]'
                                }`}
                              >
                                {model.modelTask === 'rerank' ? '重排' : '向量'}
                              </span>
                            </div>

                          </div>
                          {active && <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[var(--accent)]" />}
                        </button>
                      );
                    })}
                  </div>
                </section>

                {/* 参数 */}
                <section className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4 dark:border-white/[0.08] dark:bg-white/[0.03]">
                  <h2 className="mb-3 text-sm font-semibold text-[var(--text-primary)]">服务参数</h2>
                  <div className="space-y-3">
                    <label className="flex items-center justify-between gap-3">
                      <span className="text-sm text-[var(--text-secondary)]">服务端口</span>
                      <input
                        type="number"
                        min={1}
                        max={65535}
                        value={port}
                        disabled={running}
                        onChange={(event) => setPort(clampPort(Number(event.target.value)))}
                        className="mono-font h-8 w-28 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)] disabled:opacity-60"
                      />
                    </label>
                    <label className="flex items-center justify-between gap-3">
                      <span className="text-sm text-[var(--text-secondary)]">
                        池化方式
                        <span className="mono-font ml-1 text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">--pooling</span>
                      </span>
                      <select
                        value={pooling}
                        disabled={running}
                        onChange={(event) => setPooling(event.target.value as PoolingMode)}
                        className="h-8 w-44 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)] disabled:opacity-60"
                      >
                        {POOLING_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </label>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm text-[var(--text-secondary)]">
                        自定义归一化
                        <span className="mono-font ml-1 text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">--embd-normalize</span>
                      </span>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min={-1}
                          max={8}
                          value={embdNormalize}
                          disabled={running || !normalizeEnabled}
                          onChange={(event) => setEmbdNormalize(Math.round(Number(event.target.value)))}
                          className="mono-font h-8 w-20 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)] disabled:opacity-50"
                        />
                        <ToggleSwitch checked={normalizeEnabled} onChange={setNormalizeEnabled} label="自定义归一化" />
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleStart()}
                      disabled={!selected || busy || running}
                      className="flex h-9 items-center gap-2 rounded-lg bg-[var(--accent)] px-4 text-sm font-medium text-[var(--text-on-accent)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-60"
                    >
                      <Play className="h-4 w-4" />
                      {running ? '运行中' : '启动向量服务'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleStop()}
                      disabled={!running}
                      className="flex h-9 items-center gap-2 rounded-lg border border-[var(--state-danger-border)] bg-[var(--state-danger-bg)] px-3 text-sm text-[var(--state-danger)] transition-colors hover:bg-[var(--state-danger-border)] disabled:opacity-50"
                    >
                      <Square className="h-3.5 w-3.5 fill-current" />
                      停止
                    </button>
                  </div>

                  {busy && !running && (
                    <div className="mt-3">
                      <div className="h-1 overflow-hidden rounded-full bg-[var(--surface-muted)]">
                        <div className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300" style={{ width: `${progress}%` }} />
                      </div>
                    </div>
                  )}
                  {message && <p className="mt-2 break-words text-xs text-[var(--text-secondary)]">{message}</p>}
                </section>
              </div>

              <div className="space-y-5">
                {/* 状态 */}
                <section className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4 dark:border-white/[0.08] dark:bg-white/[0.03]">
                  <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
                    <Cpu className="h-4 w-4 text-[var(--accent)]" />
                    运行状态
                  </h2>
                  <div className="space-y-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-[var(--text-tertiary)]">服务</span>
                      <span className={`font-medium ${running ? 'text-[var(--state-success)]' : 'text-[var(--text-tertiary)]'}`}>
                        {running ? '运行中' : '未运行'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[var(--text-tertiary)]">端口</span>
                      <span className="mono-font text-[var(--text-primary)]">{running ? `:${activePort}` : '--'}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex-shrink-0 text-[var(--text-tertiary)]">模型</span>
                      <span className="truncate text-[var(--text-primary)]" title={status?.modelPath ?? selected?.filePath}>
                        {status?.modelName ?? '--'}
                      </span>
                    </div>
                  </div>
                </section>

                {/* 日志 */}
                <section className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4 dark:border-white/[0.08] dark:bg-white/[0.03]">
                  <div className="mb-3 flex items-center justify-between">
                    <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
                      <Terminal className="h-4 w-4 text-[var(--accent)]" />
                      向量服务日志
                    </h2>
                    <button
                      type="button"
                      onClick={() => { void clearEmbeddingLogs(); setLogs([]); }}
                      className="h-7 rounded-md border border-[var(--border)] px-2 text-[length:var(--font-eyebrow)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface)]"
                    >
                      清空
                    </button>
                  </div>
                  <pre className="mono-font max-h-64 min-h-[80px] overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[var(--surface)] p-2.5 text-[length:var(--font-eyebrow)] leading-5 text-[var(--text-secondary)]">
{logs.length > 0 ? logs.join('\n') : '暂无日志。'}
                  </pre>
                </section>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
