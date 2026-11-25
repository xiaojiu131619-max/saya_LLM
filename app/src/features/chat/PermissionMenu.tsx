import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ShieldCheck } from 'lucide-react';
import type { PiPermissionMode } from '@/lib/ipc/pi';
import { PI_PERMISSION_OPTIONS, PERMISSION_LABELS } from '@/features/chat/chatOptions';
import { useMenuKeyboard } from '@/hooks/useMenuKeyboard';

/** Pi 权限档选择：就在输入框里改，不再跳设置页。权限档随工作区记忆。 */
export default function PermissionMenu({ currentPermissionMode, onSelect }: {
  currentPermissionMode: PiPermissionMode;
  onSelect: (mode: PiPermissionMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useMenuKeyboard({ open, menuRef, triggerRef, onClose: () => setOpen(false) });

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  return (
    <div ref={menuRef} className="relative flex-shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className={`flex h-9 items-center gap-1.5 rounded-[var(--radius-field)] border px-2.5 text-[length:var(--font-caption)] font-medium transition-colors ${
          currentPermissionMode === 'full'
            ? 'border-[var(--state-warning-border)] bg-[var(--state-warning-bg)] text-[var(--state-warning)]'
            : currentPermissionMode === 'plan'
              ? 'border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text-secondary)]'
              : 'border-transparent bg-transparent text-[var(--text-primary)] hover:bg-black/[0.055] dark:text-[var(--text-secondary)] dark:hover:bg-[var(--surface-raised)]'
        }`}
        title={`Pi 权限档：${PERMISSION_LABELS[currentPermissionMode]}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <ShieldCheck className="h-4 w-4" />
        <span>{PERMISSION_LABELS[currentPermissionMode]}</span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={false}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            role="menu"
            aria-label="Pi 权限档"
            className="anim-enter-pop absolute bottom-10 left-0 z-20 w-64 overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--app-bg)] p-1 shadow-xl dark:border-white/[0.08] dark:bg-[var(--surface-raised)]"
          >
            {PI_PERMISSION_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onSelect(option.value);
                }}
                className={`w-full rounded-[var(--radius-field)] px-2.5 py-2 text-left transition-colors ${
                  currentPermissionMode === option.value
                    ? 'bg-[var(--accent-subtle)] text-[var(--accent)]'
                    : 'text-[var(--text-primary)] hover:bg-[var(--surface-muted)] dark:hover:bg-white/[0.07]'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-[length:var(--font-body)] font-semibold">{option.label}</span>
                  {currentPermissionMode === option.value ? <Check className="h-3.5 w-3.5" /> : null}
                </div>
                <div className="mt-0.5 text-[length:var(--font-eyebrow)] leading-4 text-[var(--text-secondary)]">{option.hint}</div>
              </button>
            ))}
            <div className="mt-1 border-t border-[var(--border)] px-2.5 py-2 text-[length:var(--font-eyebrow)] leading-4 text-[var(--text-tertiary)] dark:border-white/[0.08]">
              只有当前工作区文件夹内的文件与命令受此档控制。
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
