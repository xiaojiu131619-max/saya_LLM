import { useEffect, useState, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Terminal,
  Trash2,
  Download,
  Filter,
  ChevronDown,
  FileJson,
  FileText,
} from 'lucide-react';
import type { SystemLogEntry } from '@/lib/desktop';
import {
  clearDesktopSystemLogs,
  getDesktopSystemLogs,
  isDesktopRuntime,
} from '@/lib/desktop';

const LOG_LEVEL_OPTIONS: Array<SystemLogEntry['level'] | 'all'> = ['all', 'debug', 'info', 'warn', 'error'];
const LOG_LEVEL_LABELS: Record<SystemLogEntry['level'], string> = {
  debug: '调试',
  info: '信息',
  warn: '警告',
  error: '错误',
};
const LOG_CATEGORY_OPTIONS: Array<SystemLogEntry['category'] | 'all'> = ['all', 'server', 'llama', 'api', 'app'];
const LOG_CATEGORY_LABELS: Record<SystemLogEntry['category'], string> = {
  llama: 'llama-server',
  server: '服务生命周期',
  api: 'API 请求',
  app: '应用',
};

// 前端最多保留的日志条数，超出后淘汰最旧记录。
const MAX_RENDERED_LOGS = 3000;

function formatLogTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

const LEVEL_COLORS: Record<SystemLogEntry['level'], string> = {
  debug: 'border-[var(--border)] bg-[var(--app-bg)] text-[var(--text-secondary)] dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-[var(--text-secondary)]',
  info: 'border-[var(--state-success-border)] bg-[var(--state-success-bg)] text-[var(--state-success)] dark:border-[var(--state-success-border)] dark:bg-[var(--state-success-bg)] dark:text-[var(--state-success)]',
  warn: 'border-[var(--state-warning-border)] bg-[var(--state-warning-bg)] text-[var(--state-warning)] dark:border-[var(--state-warning)] dark:bg-[var(--state-danger-bg)] dark:text-[var(--state-warning)]',
  error: 'border-[var(--state-danger-border)] bg-[var(--state-danger-bg)] text-[var(--accent-hover)] dark:border-[var(--state-danger-border)] dark:bg-[var(--state-danger-bg)] dark:text-[var(--accent)]',
};

function LogEntryRow({ entry }: { entry: SystemLogEntry }) {
  return (
    <div className={`flex items-start gap-2 rounded-lg border px-3 py-1.5 ${LEVEL_COLORS[entry.level]}`}>
      <span className="mono-font mt-0.5 flex-shrink-0 text-[10px] opacity-70">{formatLogTime(entry.timestamp)}</span>
      <span className="mt-0.5 flex-shrink-0 rounded bg-white/55 px-1.5 py-0.5 text-[10px] font-semibold dark:bg-black/20">
        {LOG_LEVEL_LABELS[entry.level]}
      </span>
      <span className="mono-font mt-0.5 flex-shrink-0 rounded bg-white/40 px-1.5 py-0.5 text-[10px] opacity-80 dark:bg-black/15">
        {LOG_CATEGORY_LABELS[entry.category]}
      </span>
      <p className="min-w-0 flex-1 break-words text-sm leading-6">{entry.message}</p>
    </div>
  );
}

export default function LogPanel() {
  const [logs, setLogs] = useState<SystemLogEntry[]>([]);
  const [levelFilter, setLevelFilter] = useState<SystemLogEntry['level'] | 'all'>('all');
  const [categoryFilter, setCategoryFilter] = useState<SystemLogEntry['category'] | 'all'>('all');
  const [showExportMenu, setShowExportMenu] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const cursorRef = useRef(0);

  // 增量轮询统一日志中枢：首次取全量，之后只取上次时间戳之后的新条目。
  const refresh = useCallback(async () => {
    if (!isDesktopRuntime()) return;
    try {
      const incoming = await getDesktopSystemLogs(cursorRef.current);
      if (incoming.length === 0) return;
      cursorRef.current = incoming[incoming.length - 1].timestamp;
      setLogs((prev) => {
        const merged = [...prev, ...incoming];
        return merged.length > MAX_RENDERED_LOGS ? merged.slice(merged.length - MAX_RENDERED_LOGS) : merged;
      });
    } catch {
      // 日志中枢不可用时保持现有内容，不打断页面。
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (autoScrollRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [logs]);

  const filteredLogs = logs.filter((entry) => {
    if (levelFilter !== 'all' && entry.level !== levelFilter) return false;
    if (categoryFilter !== 'all' && entry.category !== categoryFilter) return false;
    return true;
  });

  const handleClear = () => {
    if (confirm('确定要清空系统日志吗？此操作无法撤销。')) {
      void clearDesktopSystemLogs();
      cursorRef.current = 0;
      setLogs([]);
    }
  };

  const handleExport = (format: 'text' | 'json') => {
    const content = format === 'text'
      ? filteredLogs.map((entry) =>
          `[${new Date(entry.timestamp).toISOString()}] [${entry.level}] [${entry.category}] ${entry.message}`
        ).join('\n')
      : JSON.stringify(filteredLogs, null, 2);
    const blob = new Blob([content], { type: format === 'text' ? 'text/plain' : 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `agent-llm-system-logs-${new Date().toISOString().slice(0, 10)}.${format === 'text' ? 'txt' : 'json'}`;
    a.click();
    URL.revokeObjectURL(url);
    setShowExportMenu(false);
  };

  return (
    <div className="flex h-full flex-col text-[var(--text-primary)] dark:text-[var(--text-primary)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] pb-3 dark:border-white/[0.08]">
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-[var(--accent)]" />
          <select
            aria-label="日志级别"
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value as SystemLogEntry['level'] | 'all')}
            className="rounded-md border border-[var(--border)] bg-[var(--app-bg)] px-2 py-1 text-xs outline-none focus:border-[var(--accent)] dark:border-white/[0.08] dark:bg-[var(--app-bg)]"
          >
            {LOG_LEVEL_OPTIONS.map((level) => (
              <option key={level} value={level}>
                {level === 'all' ? '全部级别' : LOG_LEVEL_LABELS[level]}
              </option>
            ))}
          </select>
          <select
            aria-label="日志来源"
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value as SystemLogEntry['category'] | 'all')}
            className="rounded-md border border-[var(--border)] bg-[var(--app-bg)] px-2 py-1 text-xs outline-none focus:border-[var(--accent)] dark:border-white/[0.08] dark:bg-[var(--app-bg)]"
          >
            {LOG_CATEGORY_OPTIONS.map((category) => (
              <option key={category} value={category}>
                {category === 'all' ? '全部来源' : LOG_CATEGORY_LABELS[category]}
              </option>
            ))}
          </select>
          <span className="text-xs text-[var(--text-secondary)] dark:text-[var(--text-secondary)]">{filteredLogs.length} 条</span>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative">
            <button
              onClick={() => setShowExportMenu((v) => !v)}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)] dark:text-[var(--text-secondary)] dark:hover:bg-white/[0.08]"
            >
              <Download className="h-3.5 w-3.5" />
              导出
              <ChevronDown className="h-3 w-3" />
            </button>
            <AnimatePresence>
              {showExportMenu && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  className="absolute right-0 top-full z-10 mt-1 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--app-bg)] shadow-lg dark:border-white/[0.08] dark:bg-[var(--app-bg)]"
                >
                  <button
                    onClick={() => handleExport('text')}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-[var(--surface-muted)] dark:hover:bg-white/[0.07]"
                  >
                    <FileText className="h-3.5 w-3.5" />
                    导出为 TXT
                  </button>
                  <button
                    onClick={() => handleExport('json')}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-[var(--surface-muted)] dark:hover:bg-white/[0.07]"
                  >
                    <FileJson className="h-3.5 w-3.5" />
                    导出为 JSON
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <button
            onClick={handleClear}
            disabled={logs.length === 0}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--state-danger)] transition-colors hover:bg-[var(--state-danger-bg)] hover:text-[var(--state-danger)] disabled:cursor-not-allowed disabled:opacity-40 dark:text-[var(--state-danger)] dark:hover:bg-[var(--surface-raised)]"
          >
            <Trash2 className="h-3.5 w-3.5" />
            清空
          </button>
        </div>
      </div>

      <div
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
        }}
        className="flex-1 space-y-1.5 overflow-y-auto py-3"
      >
        {filteredLogs.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center rounded-xl border border-dashed border-[var(--border)] text-[var(--text-secondary)] dark:border-white/[0.08] dark:text-[var(--text-secondary)]">
            <Terminal className="mb-3 h-12 w-12 opacity-30" />
            <p className="text-sm">暂无系统日志</p>
            <p className="mt-1 text-xs">服务生命周期、llama-server 输出与 API 请求会按时间顺序显示在这里</p>
          </div>
        ) : (
          filteredLogs.map((entry, index) => (
            <LogEntryRow key={`${entry.timestamp}-${index}`} entry={entry} />
          ))
        )}
      </div>
    </div>
  );
}
