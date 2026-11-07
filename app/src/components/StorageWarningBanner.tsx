import { useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { STORAGE_WARNING_EVENT } from '@/context/AppContext';

/**
 * 本地持久化失败的全局警告条。
 *
 * 聊天历史与设置都压在 localStorage 的一个键里，配额写满后 `setItem` 会抛错；
 * 以前这个错误被空 catch 吞掉，用户在毫无感知的情况下丢数据。现在持久化失败
 * 会广播 {@link STORAGE_WARNING_EVENT}，这里把它渲染成可关闭的警告条，
 * 直到下一次成功落盘或用户清理存储。
 */
export default function StorageWarningBanner() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const onWarning = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      if (detail) setMessage(detail);
    };
    window.addEventListener(STORAGE_WARNING_EVENT, onWarning);
    return () => window.removeEventListener(STORAGE_WARNING_EVENT, onWarning);
  }, []);

  if (!message) return null;
  return (
    <div
      role="alert"
      className="fixed bottom-4 left-1/2 z-[100] flex max-w-xl -translate-x-1/2 items-start gap-2 rounded-[var(--radius-panel)] border border-[var(--state-warning-border)] bg-[var(--surface)] px-3 py-2 shadow-[var(--shadow-card)]"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-[var(--state-warning)]" />
      <p className="min-w-0 flex-1 text-[length:var(--font-caption)] leading-relaxed text-[var(--text-primary)]">
        {message}
      </p>
      <button
        type="button"
        onClick={() => setMessage(null)}
        aria-label="关闭存储警告"
        title="关闭"
        className="flex-shrink-0 rounded p-0.5 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-secondary)]"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
