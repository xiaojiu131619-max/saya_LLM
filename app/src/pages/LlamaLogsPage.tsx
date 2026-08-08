import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Terminal,
  Trash2,
  Download,
  Copy,
  Check,
  ArrowDown,
  Pause,
  Play,
} from 'lucide-react';
import { useApp } from '@/context/AppContext';
import PageHeader from '@/components/PageHeader';
import {
  clearDesktopServerLogs,
  getDesktopServerLogs,
  isDesktopRuntime,
} from '@/lib/desktop';

type LineTone = 'error' | 'warn' | 'accent' | 'muted' | 'default';

function classifyLine(line: string): LineTone {
  const lower = line.toLowerCase();
  if (
    lower.includes('error')
    || lower.includes('failed')
    || lower.includes('失败')
    || lower.includes('ggml_assert')
    || lower.includes('abort')
  ) {
    return 'error';
  }
  if (lower.includes('warn') || lower.includes('warning')) return 'warn';
  if (line.startsWith('[server] spawn') || line.includes('server is listening')) return 'accent';
  if (
    lower.startsWith('[multimodal]')
    || lower.includes('offload')
    || lower.includes('system info')
  ) {
    return 'muted';
  }
  return 'default';
}

const TONE_CLASS: Record<LineTone, string> = {
  error: 'text-[#FF8A70]',
  warn: 'text-[#F5C56B]',
  accent: 'text-[#7EE0A3]',
  muted: 'text-[#5E6B7E]',
  default: 'text-[#AEBBD0]',
};

export default function LlamaLogsPage() {
  const { state } = useApp();
  const [lines, setLines] = useState<string[]>([]);
  const [live, setLive] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);
  const [pinnedBottom, setPinnedBottom] = useState(true);
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const next = await getDesktopServerLogs();
        if (!disposed) setLines(next);
      } catch {
        if (!disposed) setLines([]);
      }
    };
    void refresh();
    const timer = window.setInterval(() => {
      if (live) void refresh();
    }, 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [live]);

  useEffect(() => {
    const el = viewportRef.current;
    if (el && autoScroll) el.scrollTop = el.scrollHeight;
  }, [lines, autoScroll]);

  const handleScroll = () => {
    const el = viewportRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setPinnedBottom(nearBottom);
    if (nearBottom && !autoScroll) setAutoScroll(true);
  };

  const jumpToBottom = () => {
    const el = viewportRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setAutoScroll(true);
    setPinnedBottom(true);
  };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(lines.join('\n'));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const handleExport = () => {
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `llama-server-${new Date().toISOString().slice(0, 10)}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleClear = () => {
    if (confirm('确定要清空 llama-server 日志吗？此操作无法撤销。')) {
      void clearDesktopServerLogs().finally(() => setLines([]));
    }
  };

  const running = state.serverRunning;
  const rendered = useMemo(() => lines.slice(-600), [lines]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[#FBFAF6] text-[#2F2C26] dark:bg-[#141720] dark:text-[#E2E8F2]">
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-6">
        <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col">
          <PageHeader
            icon={Terminal}
            title="llama-server 日志"
            description="推理内核的实时输出：启动命令、模型加载、显存分配与运行错误都在这里。"
            className="mb-5"
          />

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold ${
                running
                  ? 'border-[#CFE1C8] bg-[#F2F8EF] text-[#4E7751] dark:border-[#2D5632] dark:bg-[#1A2E28] dark:text-[#7EC8A0]'
                  : 'border-[#E1DCD0] bg-[#FAF9F5] text-[#8C8576] dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-[#8E99AD]'
              }`}
            >
              <span className="relative flex h-2 w-2">
                {running && (
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#2C8B58] opacity-60" />
                )}
                <span className={`relative inline-flex h-2 w-2 rounded-full ${running ? 'bg-[#2C8B58]' : 'bg-[#A49B8C]'}`} />
              </span>
              {running ? `运行中 · 端口 ${state.serverPort}` : '未运行'}
            </span>
            <span className="mono-font rounded-full border border-[#E1DCD0] bg-[#FAF9F5] px-3 py-1.5 text-xs text-[#7D766B] dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-[#8E99AD]">
              {lines.length} 行
            </span>
            <span className="rounded-full border border-[#E1DCD0] bg-[#FAF9F5] px-3 py-1.5 text-xs text-[#8C8576] dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-[#8E99AD]">
              每秒刷新
            </span>

            <div className="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setLive((v) => !v)}
                className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  live
                    ? 'border-[#CFE1C8] bg-[#F2F8EF] text-[#4E7751] hover:bg-[#E9F3E4] dark:border-[#2D5632] dark:bg-[#1A2E28] dark:text-[#7EC8A0]'
                    : 'border-[#E1DCD0] bg-[#FAF9F5] text-[#7D766B] hover:bg-[#F1EEE7] dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-[#8E99AD]'
                }`}
                title={live ? '暂停自动刷新' : '恢复自动刷新'}
              >
                {live ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                {live ? '实时' : '已暂停'}
              </button>
              <button
                type="button"
                onClick={() => void handleCopy()}
                disabled={lines.length === 0}
                className="flex items-center gap-1.5 rounded-md border border-[#E1DCD0] bg-[#FAF9F5] px-2.5 py-1.5 text-xs text-[#6F685A] transition-colors hover:bg-[#F1EEE7] disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-[#B8C2D4] dark:hover:bg-white/[0.08]"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-[#2C8B58]" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? '已复制' : '复制'}
              </button>
              <button
                type="button"
                onClick={handleExport}
                disabled={lines.length === 0}
                className="flex items-center gap-1.5 rounded-md border border-[#E1DCD0] bg-[#FAF9F5] px-2.5 py-1.5 text-xs text-[#6F685A] transition-colors hover:bg-[#F1EEE7] disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-[#B8C2D4] dark:hover:bg-white/[0.08]"
              >
                <Download className="h-3.5 w-3.5" />
                导出
              </button>
              <button
                type="button"
                onClick={handleClear}
                disabled={lines.length === 0}
                className="flex items-center gap-1.5 rounded-md border border-[#E9C7BC] bg-[#FFF1EC] px-2.5 py-1.5 text-xs font-medium text-[#C44E36] transition-colors hover:bg-[#F6E4DE] disabled:cursor-not-allowed disabled:opacity-40 dark:border-[#3A5570] dark:bg-[#1E2A3A] dark:text-[#6EA8DC]"
              >
                <Trash2 className="h-3.5 w-3.5" />
                清空
              </button>
            </div>
          </div>

          <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-[#1E2430] bg-[#0B0E14] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            <div className="flex items-center gap-1.5 border-b border-white/[0.06] bg-[#0E1219] px-3 py-2">
              <span className="h-2.5 w-2.5 rounded-full bg-[#FF5F57]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#FEBC2E]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#28C840]" />
              <span className="mono-font ml-2 text-[11px] text-[#5E6B7E]">llama-server · stdout / stderr</span>
            </div>

            <div
              ref={viewportRef}
              onScroll={handleScroll}
              className="mono-font h-[calc(100%-36px)] overflow-y-auto overflow-x-hidden px-4 py-3 text-[12px] leading-[1.7]"
            >
              {rendered.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center text-[#4A5568]">
                  <Terminal className="mb-3 h-10 w-10 opacity-40" />
                  <p className="text-sm">暂无 llama-server 输出</p>
                  <p className="mt-1 text-xs">加载模型后，推理内核的日志会实时显示在这里</p>
                </div>
              ) : (
                rendered.map((line, index) => {
                  const tone = classifyLine(line);
                  return (
                    <div key={`${lines.length - rendered.length + index}`} className="flex gap-3 whitespace-pre-wrap break-all hover:bg-white/[0.03]">
                      <span className="w-10 flex-shrink-0 select-none text-right text-[#3A4557]">
                        {lines.length - rendered.length + index + 1}
                      </span>
                      <span className={`min-w-0 flex-1 ${TONE_CLASS[tone]}`}>{line || ' '}</span>
                    </div>
                  );
                })
              )}
            </div>

            <AnimatePresence>
              {!pinnedBottom && rendered.length > 0 && (
                <motion.button
                  type="button"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 8 }}
                  onClick={jumpToBottom}
                  className="absolute bottom-3 right-3 flex items-center gap-1.5 rounded-full border border-white/[0.12] bg-[#1A2130]/95 px-3 py-1.5 text-xs font-medium text-[#AEBBD0] shadow-lg backdrop-blur transition-colors hover:bg-[#232C3E]"
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                  回到最新
                </motion.button>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}
