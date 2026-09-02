import { useCallback, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import {
  getEnvCheckDone,
  isDesktopRuntime,
  markEnvCheckDone,
  openExternalUrl,
  runDesktopEnvCheck,
  type DesktopEnvCheckItem,
} from '@/lib/desktop';
import { useApp } from '@/context/AppContext';
import type { ViewType } from '@/types';

interface EnvCheckDialogProps {
  /** 设置页手动打开时传 true；不传则按「首次启动自动检测」模式工作。 */
  manualOpen?: boolean;
  onClose: () => void;
}

/** 自动模式下的静默检测延迟：等首屏渲染完成再探测，避免抢占启动时的资源。 */
const AUTO_CHECK_DELAY_MS = 800;

type CheckPhase = 'idle' | 'checking' | 'done';

const LEVEL_ICON: Record<DesktopEnvCheckItem['level'], typeof CheckCircle2> = {
  ok: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
};

const LEVEL_ICON_COLOR: Record<DesktopEnvCheckItem['level'], string> = {
  ok: 'text-[var(--state-success)]',
  warning: 'text-[var(--state-warning)]',
  error: 'text-[var(--state-danger)]',
};

function checkResultCount(items: DesktopEnvCheckItem[]) {
  const errors = items.filter((item) => item.level === 'error').length;
  const warnings = items.filter((item) => item.level === 'warning').length;
  return { errors, warnings, failed: errors + warnings };
}

export default function EnvCheckDialog({ manualOpen = false, onClose }: EnvCheckDialogProps) {
  const { dispatch } = useApp();
  // 自动模式自带可见性：首次启动检测出未通过项才弹出；手动模式由 manualOpen 控制。
  const [autoVisible, setAutoVisible] = useState(false);
  const [phase, setPhase] = useState<CheckPhase>('idle');
  const [items, setItems] = useState<DesktopEnvCheckItem[]>([]);
  const isOpen = manualOpen || autoVisible;

  const runCheck = useCallback(async () => {
    setPhase('checking');
    try {
      const results = await runDesktopEnvCheck();
      setItems(results);
      setPhase('done');
    } catch (error) {
      setItems([]);
      setPhase('done');
      // 检测失败属于静默降级：用户仍可正常使用，具体组件问题会在使用时暴露。
      console.error('环境检测失败', error);
    }
  }, []);

  // 首次启动自动检测：未完成过检测才执行；有未通过项才弹窗，全部通过则静默标记。
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const done = await getEnvCheckDone();
          if (cancelled || done) return;
          const results = await runDesktopEnvCheck();
          if (cancelled) return;
          if (results.some((item) => item.level !== 'ok')) {
            setItems(results);
            setPhase('done');
            setAutoVisible(true);
          } else {
            void markEnvCheckDone();
          }
        } catch {
          // 自动检测失败不提示，避免首启动被误打扰。
        }
      })();
    }, AUTO_CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  // 手动打开时重新执行一次检测，保证结果反映当前状态。
  useEffect(() => {
    if (manualOpen) void runCheck();
  }, [manualOpen, runCheck]);

  const close = useCallback(() => {
    setAutoVisible(false);
    onClose();
    // 无论哪条路径关闭都置为已完成，避免下次启动重复打扰。
    void markEnvCheckDone();
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && phase !== 'checking') close();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, phase, close]);

  const goToKernelUpdate = () => {
    close();
    dispatch({ type: 'SET_VIEW', payload: 'kernel' satisfies ViewType });
  };

  const openInstallUrl = (url: string) => {
    void openExternalUrl(url);
  };

  const { errors, warnings, failed } = checkResultCount(items);

  const summaryText = phase === 'checking'
    ? '正在检测本机运行环境…'
    : failed === 0
      ? '全部通过，环境已就绪。'
      : [
          errors > 0 ? `${errors} 项必需组件未就绪` : null,
          warnings > 0 ? `${warnings} 项可选组件建议安装` : null,
        ].filter(Boolean).join('，') + '。';

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[115] flex items-center justify-center bg-white/70 p-4 dark:bg-black/75"
        >
          <motion.div
            initial={{ scale: 0.92, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.92, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 320, damping: 26 }}
            className="glass-panel-strong w-full max-w-lg overflow-hidden rounded-2xl border border-[var(--border)] dark:border-white/[0.08]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="env-check-title"
          >
            <div className="flex items-start gap-3 border-b border-black/5 p-5 dark:border-white/5">
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-[var(--accent)]/15">
                <ShieldCheck className="h-5 w-5 text-[var(--accent)]" />
              </div>
              <div className="min-w-0">
                <h2 id="env-check-title" className="text-base font-semibold text-primary-custom">
                  {manualOpen ? '环境检测' : '首次启动 · 环境检测'}
                </h2>
                <p className="mt-0.5 text-xs text-secondary-custom">
                  已检查运行本地模型所需的组件，未就绪的项可按提示安装。
                </p>
              </div>
            </div>

            <div className="max-h-[52vh] space-y-2 overflow-y-auto p-5">
              {phase === 'checking' && (
                <div className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3.5 py-3.5 dark:border-white/[0.08]">
                  <Loader2 className="h-4 w-4 animate-spin text-[var(--text-tertiary)]" />
                  <div className="text-sm text-secondary-custom">正在检测…</div>
                </div>
              )}
              {phase === 'done' && items.map((item) => {
                const Icon = LEVEL_ICON[item.level];
                return (
                  <div
                    key={item.id}
                    className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3.5 py-3 dark:border-white/[0.08]"
                  >
                    <div className="flex items-start gap-2.5">
                      <Icon className={`mt-0.5 h-4 w-4 flex-shrink-0 ${LEVEL_ICON_COLOR[item.level]}`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-primary-custom">{item.title}</span>
                          {item.level === 'warning' && (
                            <span className="rounded-full bg-[var(--state-warning)]/15 px-1.5 py-0.5 text-[10px] font-medium text-[var(--state-warning)]">
                              可选
                            </span>
                          )}
                          {item.level === 'error' && (
                            <span className="rounded-full bg-[var(--state-danger)]/15 px-1.5 py-0.5 text-[10px] font-medium text-[var(--state-danger)]">
                              必需
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 text-xs leading-relaxed text-secondary-custom">{item.detail}</p>
                        {item.install_hint && (
                          <p className="mt-1.5 text-xs leading-relaxed text-[var(--text-primary)]">
                            {item.install_hint}
                          </p>
                        )}
                        {(item.in_app_action || item.install_url) && (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {item.in_app_action === 'kernel-update' && (
                              <button
                                type="button"
                                onClick={goToKernelUpdate}
                                className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[var(--accent-hover)]"
                              >
                                <Download className="h-3.5 w-3.5" />
                                前往核心更新
                              </button>
                            )}
                            {item.install_url && (
                              <button
                                type="button"
                                onClick={() => openInstallUrl(item.install_url!)}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-medium text-primary-custom transition-colors hover:bg-[var(--surface-muted)] dark:border-white/[0.12] dark:hover:bg-white/[0.06]"
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                                打开下载页
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-black/5 px-5 py-4 dark:border-white/5">
              <div className="min-w-0 text-xs text-secondary-custom">
                {phase === 'checking' ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {summaryText}
                  </span>
                ) : (
                  summaryText
                )}
              </div>
              <div className="flex flex-shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => void runCheck()}
                  disabled={phase === 'checking'}
                  className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-secondary-custom transition-colors hover:text-primary-custom disabled:opacity-40"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${phase === 'checking' ? 'animate-spin' : ''}`} />
                  重新检测
                </button>
                <button
                  type="button"
                  onClick={close}
                  disabled={phase === 'checking'}
                  className="rounded-lg bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40"
                >
                  {manualOpen ? '完成' : failed > 0 ? '仍要继续' : '开始使用'}
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
