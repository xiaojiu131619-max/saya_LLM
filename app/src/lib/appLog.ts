/**
 * 应用日志服务
 *
 * 收集并展示应用运行过程中的关键日志：
 * - API 请求/响应（发给 llama-server 的请求 body、返回的状态/错误）
 * - 多模态适配（音频转码、原生视频或旧版 server 抽帧兼容）
 * - 错误信息（网络错误、解析失败等）
 * - 调试输出（开发阶段的临时日志）
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AppLogEntry {
  id: string;
  timestamp: number;
  level: LogLevel;
  category: string;
  message: string;
  details?: string; // JSON 字符串或长文本
}

const MAX_LOG_ENTRIES = 500;
const LOG_STORAGE_KEY = 'agent-llm-app-logs-v1';

// 全局日志缓冲区（内存 + localStorage 持久化）
let logEntries: AppLogEntry[] = [];
let listeners: Array<(entries: AppLogEntry[]) => void> = [];

function generateLogId() {
  return `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadStoredLogs(): AppLogEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(LOG_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // 只保留最近 200 条持久化日志，避免 localStorage 撑爆
    return parsed.slice(-200);
  } catch {
    return [];
  }
}

function persistLogs() {
  if (typeof window === 'undefined') return;
  try {
    // 只持久化 info/warn/error 级别，debug 级别不写入
    const toStore = logEntries
      .filter((e) => e.level !== 'debug')
      .slice(-200);
    window.localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(toStore));
  } catch {
    // localStorage 写入失败时静默忽略
  }
}

function notifyListeners() {
  for (const listener of listeners) {
    listener(logEntries);
  }
}

// 初始化：从 localStorage 加载历史日志
logEntries = loadStoredLogs();

/**
 * 记录一条应用日志
 */
export function appLog(
  level: LogLevel,
  category: string,
  message: string,
  details?: string | object
): AppLogEntry {
  const entry: AppLogEntry = {
    id: generateLogId(),
    timestamp: Date.now(),
    level,
    category,
    message,
    details: typeof details === 'object' ? JSON.stringify(details, null, 2) : details,
  };

  logEntries.push(entry);

  // 超出上限时裁剪
  if (logEntries.length > MAX_LOG_ENTRIES) {
    logEntries = logEntries.slice(-MAX_LOG_ENTRIES);
  }

  // 同步到 localStorage
  persistLogs();

  // 通知订阅者
  notifyListeners();

  // 同时输出到 console（开发调试用）
  const consoleMethod = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
  const prefix = `[${category}]`;
  if (details) {
    console[consoleMethod](prefix, message, details);
  } else {
    console[consoleMethod](prefix, message);
  }

  return entry;
}

// 快捷方法
export const logDebug = (category: string, message: string, details?: string | object) =>
  appLog('debug', category, message, details);

export const logInfo = (category: string, message: string, details?: string | object) =>
  appLog('info', category, message, details);

export const logWarn = (category: string, message: string, details?: string | object) =>
  appLog('warn', category, message, details);

export const logError = (category: string, message: string, details?: string | object) =>
  appLog('error', category, message, details);

/**
 * 获取当前所有日志条目
 */
export function getAppLogs(): AppLogEntry[] {
  return logEntries;
}

/**
 * 清空所有日志
 */
export function clearAppLogs(): void {
  logEntries = [];
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(LOG_STORAGE_KEY);
  }
  notifyListeners();
}

/**
 * 订阅日志变化
 */
export function subscribeAppLogs(listener: (entries: AppLogEntry[]) => void): () => void {
  listeners.push(listener);
  // 立即通知当前状态
  listener(logEntries);
  // 返回取消订阅函数
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

/**
 * 导出日志为文本文件
 */
export function exportAppLogsAsText(): string {
  const lines = logEntries.map((entry) => {
    const time = new Date(entry.timestamp).toLocaleString('zh-CN', { hour12: false });
    const levelLabel = entry.level.toUpperCase().padEnd(5);
    const categoryLabel = `[${entry.category}]`;
    const baseLine = `${time} ${levelLabel} ${categoryLabel} ${entry.message}`;
    if (entry.details) {
      return `${baseLine}\n${entry.details}`;
    }
    return baseLine;
  });
  return lines.join('\n\n');
}

/**
 * 导出日志为 JSON
 */
export function exportAppLogsAsJson(): string {
  return JSON.stringify(logEntries, null, 2);
}

// 导出日志级别颜色映射（用于 UI 渲染）
export const LOG_LEVEL_COLORS: Record<LogLevel, { bg: string; text: string; border: string }> = {
  debug: { bg: 'bg-gray-100', text: 'text-gray-600', border: 'border-gray-300' },
  info: { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200' },
  warn: { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200' },
  error: { bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200' },
};

export const LOG_LEVEL_LABELS: Record<LogLevel, string> = {
  debug: '调试',
  info: '信息',
  warn: '警告',
  error: '错误',
};
