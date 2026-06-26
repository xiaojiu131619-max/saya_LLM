import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, X } from 'lucide-react';

export type ConfirmDialogTone = 'warning' | 'danger';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** 主体说明，可传字符串或自定义节点（用于列出会被清除的具体项）。 */
  description?: React.ReactNode;
  /** 危险动作清单，每一项会被独立列出，使用 disc list 样式。 */
  bullets?: string[];
  /** 额外的备注或免责声明，渲染在 bullets 下方。 */
  footnote?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmDialogTone;
  /** 要求用户原样输入这串文字才能启用「确认」按钮。留空则不要求二次输入。 */
  confirmPhrase?: string;
  /** 异步确认动作的执行函数；返回的 Promise 解析后对话框会自动关闭。 */
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
}

const TONE_STYLES: Record<ConfirmDialogTone, {
  iconBg: string;
  iconColor: string;
  confirmBg: string;
  confirmText: string;
  border: string;
}> = {
  warning: {
    iconBg: 'bg-[#F59E0B]/15',
    iconColor: 'text-[#F59E0B]',
    confirmBg: 'bg-[#F59E0B] hover:bg-[#D97706]',
    confirmText: 'text-white',
    border: 'border-[#F59E0B]/30',
  },
  danger: {
    iconBg: 'bg-[#F87171]/15',
    iconColor: 'text-[#F87171]',
    confirmBg: 'bg-[#F87171] hover:bg-[#DC2626]',
    confirmText: 'text-white',
    border: 'border-[#F87171]/40',
  },
};

// 实际承载输入和确认状态的内部组件：仅在 open=true 时挂载，
// 关闭时由 AnimatePresence 直接卸载，状态自然销毁，避免在 useEffect 中 setState 重置。
function ConfirmDialogContent({
  title,
  description,
  bullets,
  footnote,
  confirmLabel = '确认',
  cancelLabel = '取消',
  tone = 'warning',
  confirmPhrase,
  onConfirm,
  onCancel,
}: Omit<ConfirmDialogProps, 'open'>) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const styles = TONE_STYLES[tone];

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        onCancel();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [busy, onCancel]);

  const phraseMatches = !confirmPhrase || typed.trim() === confirmPhrase;
  const canConfirm = !busy && phraseMatches;

  const handleConfirm = async () => {
    if (!canConfirm) return;
    setErrorMessage(null);
    setBusy(true);
    try {
      await onConfirm();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      setBusy(false);
      return;
    }
    setBusy(false);
  };

  return (
    <motion.div
      ref={overlayRef}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[120] flex items-center justify-center bg-white/70 dark:bg-black/75 p-4"
      onClick={(event) => {
        if (event.target === overlayRef.current && !busy) onCancel();
      }}
    >
      <motion.div
        initial={{ scale: 0.92, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.92, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 320, damping: 26 }}
        className={`glass-panel-strong w-full max-w-md overflow-hidden border ${styles.border}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
      >
        <div className="flex items-start justify-between gap-3 p-5 border-b border-black/5 dark:border-white/5">
          <div className="flex items-start gap-3">
            <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${styles.iconBg}`}>
              <AlertTriangle className={`w-5 h-5 ${styles.iconColor}`} />
            </div>
            <div className="min-w-0">
              <h2 id="confirm-dialog-title" className="text-base font-semibold text-primary-custom">
                {title}
              </h2>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            aria-label="关闭"
            className="text-secondary-custom hover:text-primary-custom transition-colors disabled:opacity-40"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-3 text-sm text-primary-custom">
          {description && <div className="text-secondary-custom leading-relaxed">{description}</div>}
          {bullets && bullets.length > 0 && (
            <ul className="list-disc list-inside space-y-1 text-secondary-custom">
              {bullets.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
          {footnote && <div className="text-xs text-secondary-custom leading-relaxed">{footnote}</div>}

          {confirmPhrase && (
            <div className="pt-1">
              <label className="block text-xs text-secondary-custom mb-1.5">
                请输入 <span className="text-primary-custom font-mono">{confirmPhrase}</span> 以继续
              </label>
              <input
                type="text"
                autoFocus
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                disabled={busy}
                className="w-full glass-panel px-3 py-2 text-sm text-primary-custom bg-transparent outline-none disabled:opacity-50"
                placeholder={confirmPhrase}
              />
            </div>
          )}

          {errorMessage && (
            <div className="text-xs text-[#F87171] bg-[#F87171]/10 rounded-lg px-3 py-2">
              操作失败：{errorMessage}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 pb-5">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 text-sm text-secondary-custom hover:text-primary-custom transition-colors disabled:opacity-40"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={!canConfirm}
            className={`px-4 py-2 text-sm rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${styles.confirmBg} ${styles.confirmText}`}
          >
            {busy ? '处理中…' : confirmLabel}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

export default function ConfirmDialog({ open, ...rest }: ConfirmDialogProps) {
  return (
    <AnimatePresence>{open && <ConfirmDialogContent {...rest} />}</AnimatePresence>
  );
}
