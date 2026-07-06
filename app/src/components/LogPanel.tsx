import { useEffect, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Terminal,
  Trash2,
  Download,
  Filter,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  FileJson,
  FileText,
} from 'lucide-react';
import type { AppLogEntry, LogLevel } from '@/lib/appLog';
import {
  clearAppLogs,
  subscribeAppLogs,
  exportAppLogsAsText,
  exportAppLogsAsJson,
  LOG_LEVEL_COLORS,
  LOG_LEVEL_LABELS,
} from '@/lib/appLog';

const LOG_LEVEL_OPTIONS: Array<LogLevel | 'all'> = ['all', 'debug', 'info', 'warn', 'error'];

function formatLogTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function LogEntryCard({ entry, expanded, onToggle }: {
  entry: AppLogEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const colors = LOG_LEVEL_COLORS[entry.level];

  const handleCopy = async () => {
    const text = entry.details
      ? `${entry.message}\n\n${entry.details}`
      : entry.message;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      className={`rounded-lg border ${colors.border} ${colors.bg} overflow-hidden`}
    >
      <button
        onClick={onToggle}
        className="w-full flex items-start gap-3 px-3 py-2 text-left"
      >
        <span
          className={`flex-shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded ${colors.text} bg-white/50`}
        >
          {LOG_LEVEL_LABELS[entry.level]}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-[10px] text-gray-500 font-mono">
              {formatLogTime(entry.timestamp)}
            </span>
            <span className="text-[10px] text-gray-400 font-mono">
              [{entry.category}]
            </span>
          </div>
          <p className={`text-sm ${colors.text} break-words`}>{entry.message}</p>
        </div>
        {entry.details && (
          <motion.div
            animate={{ rotate: expanded ? 90 : 0 }}
            transition={{ duration: 0.15 }}
          >
            <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />
          </motion.div>
        )}
      </button>

      <AnimatePresence>
        {expanded && entry.details && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <div className="px-3 pb-2 pt-1 border-t border-gray-200/50">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-gray-400">详细信息</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleCopy();
                  }}
                  className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-gray-700"
                >
                  {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                  {copied ? '已复制' : '复制'}
                </button>
              </div>
              <pre className="text-[11px] font-mono text-gray-700 bg-white/50 rounded p-2 overflow-x-auto whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
                {entry.details}
              </pre>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function LogPanel() {
  const [logs, setLogs] = useState<AppLogEntry[]>([]);
  const [levelFilter, setLevelFilter] = useState<LogLevel | 'all'>('all');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [showExportMenu, setShowExportMenu] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  // 订阅日志变化
  useEffect(() => {
    const unsubscribe = subscribeAppLogs(setLogs);
    return unsubscribe;
  }, []);

  // 自动滚动到底部
  useEffect(() => {
    if (autoScrollRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [logs]);

  // 过滤日志
  const filteredLogs = levelFilter === 'all'
    ? logs
    : logs.filter((entry) => entry.level === levelFilter);

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleClear = () => {
    if (confirm('确定要清空所有日志吗？此操作无法撤销。')) {
      clearAppLogs();
      setExpandedIds(new Set());
    }
  };

  const handleExport = (format: 'text' | 'json') => {
    const content = format === 'text' ? exportAppLogsAsText() : exportAppLogsAsJson();
    const blob = new Blob([content], { type: format === 'text' ? 'text/plain' : 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `agent-llm-logs-${new Date().toISOString().slice(0, 10)}.${format === 'text' ? 'txt' : 'json'}`;
    a.click();
    URL.revokeObjectURL(url);
    setShowExportMenu(false);
  };

  return (
    <div className="flex flex-col h-full">
      {/* 工具栏 */}
      <div className="flex items-center justify-between gap-3 pb-3 border-b border-gray-200/50">
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-gray-400" />
          <select
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value as LogLevel | 'all')}
            className="text-xs bg-transparent border border-gray-200 rounded px-2 py-1 outline-none focus:ring-1 focus:ring-[#5A6CFF]/50"
          >
            {LOG_LEVEL_OPTIONS.map((level) => (
              <option key={level} value={level}>
                {level === 'all' ? '全部级别' : LOG_LEVEL_LABELS[level]}
              </option>
            ))}
          </select>
          <span className="text-xs text-gray-400">
            {filteredLogs.length} 条
          </span>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative">
            <button
              onClick={() => setShowExportMenu((v) => !v)}
              className="flex items-center gap-1 text-xs text-gray-600 hover:text-gray-800 px-2 py-1 rounded hover:bg-gray-100"
            >
              <Download className="w-3.5 h-3.5" />
              导出
              <ChevronDown className="w-3 h-3" />
            </button>
            <AnimatePresence>
              {showExportMenu && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  className="absolute right-0 top-full mt-1 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 overflow-hidden z-10"
                >
                  <button
                    onClick={() => handleExport('text')}
                    className="flex items-center gap-2 w-full px-3 py-2 text-xs text-left hover:bg-gray-100 dark:hover:bg-gray-700"
                  >
                    <FileText className="w-3.5 h-3.5" />
                    导出为 TXT
                  </button>
                  <button
                    onClick={() => handleExport('json')}
                    className="flex items-center gap-2 w-full px-3 py-2 text-xs text-left hover:bg-gray-100 dark:hover:bg-gray-700"
                  >
                    <FileJson className="w-3.5 h-3.5" />
                    导出为 JSON
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <button
            onClick={handleClear}
            disabled={logs.length === 0}
            className="flex items-center gap-1 text-xs text-red-600 hover:text-red-700 px-2 py-1 rounded hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Trash2 className="w-3.5 h-3.5" />
            清空
          </button>
        </div>
      </div>

      {/* 日志列表 */}
      <div
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
        }}
        className="flex-1 overflow-y-auto py-3 space-y-2"
      >
        {filteredLogs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-400">
            <Terminal className="w-12 h-12 mb-3 opacity-30" />
            <p className="text-sm">暂无日志</p>
            <p className="text-xs mt-1">应用运行时的日志会显示在这里</p>
          </div>
        ) : (
          filteredLogs.map((entry) => (
            <LogEntryCard
              key={entry.id}
              entry={entry}
              expanded={expandedIds.has(entry.id)}
              onToggle={() => toggleExpand(entry.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}