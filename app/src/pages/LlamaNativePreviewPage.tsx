import { useMemo, useState } from 'react';
import {
  ArrowUp,
  BrainCircuit,
  Check,
  ChevronDown,
  Copy,
  Gauge,
  Menu,
  MessageSquare,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  SquareTerminal,
  Sun,
  Trash2,
  X,
} from 'lucide-react';

type PreviewMessage = {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  code?: string;
};

const INITIAL_MESSAGES: PreviewMessage[] = [
  {
    id: 1,
    role: 'user',
    content: '请用简单的方式解释一下 KV cache 的作用。',
  },
  {
    id: 2,
    role: 'assistant',
    content:
      'KV cache 可以理解为模型在生成文本时保留的“短期记忆”。每生成一个新 Token，模型不必重新计算前面所有内容，而是直接复用已经缓存的 Key 和 Value，因此生成速度会明显更快。\n\n它的代价是占用内存或显存；上下文越长、并行请求越多，KV cache 通常就越大。',
    code: '上下文长度 ↑  →  KV cache 占用 ↑\n重复计算 ↓    →  生成速度 ↑',
  },
];

const HISTORY = [
  { id: 'kv', title: 'KV cache 是什么', time: '刚刚' },
  { id: 'quant', title: 'GGUF 量化选择建议', time: '今天' },
  { id: 'api', title: 'OpenAI API 兼容接口', time: '昨天' },
  { id: 'context', title: '上下文长度测试', time: '7 月 24 日' },
];

export default function LlamaNativePreviewPage() {
  const [dark, setDark] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeHistory, setActiveHistory] = useState('kv');
  const [messages, setMessages] = useState<PreviewMessage[]>(INITIAL_MESSAGES);
  const [input, setInput] = useState('');
  const [copied, setCopied] = useState(false);
  const [temperature, setTemperature] = useState(0.8);
  const [topP, setTopP] = useState(0.95);
  const [maxTokens, setMaxTokens] = useState(2048);

  const activeTitle = useMemo(
    () => HISTORY.find((item) => item.id === activeHistory)?.title ?? '新对话',
    [activeHistory]
  );

  const sendMessage = () => {
    const content = input.trim();
    if (!content) return;
    setMessages((current) => [
      ...current,
      { id: Date.now(), role: 'user', content },
      {
        id: Date.now() + 1,
        role: 'assistant',
        content: '这是一个界面预览回复。正式接入时会继续使用当前项目已有的 llama-server 流式对话逻辑。',
      },
    ]);
    setInput('');
  };

  const newChat = () => {
    setActiveHistory('');
    setMessages([]);
    setInput('');
  };

  return (
    <div className={dark ? 'dark' : ''}>
      <main className="flex h-screen min-h-[620px] overflow-hidden bg-[#f7f7f8] text-[#202123] dark:bg-[#171717] dark:text-[#ececec]">
        <aside
          className={`relative flex h-full flex-shrink-0 flex-col border-r border-black/10 bg-[#ececf1] transition-[width] duration-200 dark:border-white/10 dark:bg-[#101010] ${
            sidebarOpen ? 'w-[272px]' : 'w-[68px]'
          }`}
        >
          <div className="flex h-16 items-center gap-3 px-3">
            <button
              type="button"
              onClick={() => setSidebarOpen((value) => !value)}
              className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-lg text-[#5d5d65] transition-colors hover:bg-black/[0.06] dark:text-[#b4b4b4] dark:hover:bg-white/10"
              title={sidebarOpen ? '折叠侧边栏' : '展开侧边栏'}
            >
              {sidebarOpen ? <PanelLeftClose className="h-5 w-5" /> : <PanelLeftOpen className="h-5 w-5" />}
            </button>
            {sidebarOpen && (
              <div className="flex min-w-0 items-center gap-2">
                <div className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-lg bg-[#242424] text-white shadow-sm dark:bg-[#f4f4f4] dark:text-[#171717]">
                  <span className="font-mono text-[11px] font-bold">L</span>
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold tracking-tight">llama.cpp</div>
                  <div className="truncate text-[11px] text-[#777780] dark:text-[#8d8d8d]">本地网页聊天</div>
                </div>
              </div>
            )}
          </div>

          <div className="px-3">
            <button
              type="button"
              onClick={newChat}
              className={`flex h-11 items-center rounded-lg border border-black/10 bg-white text-sm font-medium shadow-sm transition-colors hover:bg-[#f7f7f8] dark:border-white/10 dark:bg-[#202020] dark:hover:bg-[#292929] ${
                sidebarOpen ? 'w-full gap-3 px-3' : 'w-11 justify-center px-0'
              }`}
              title="新建对话"
            >
              <Plus className="h-4 w-4" />
              {sidebarOpen && <span>新建对话</span>}
            </button>

            {sidebarOpen && (
              <label className="mt-3 flex h-9 items-center gap-2 rounded-lg px-3 text-[#777780] transition-colors focus-within:bg-white dark:text-[#8d8d8d] dark:focus-within:bg-[#202020]">
                <Search className="h-4 w-4" />
                <input
                  className="min-w-0 flex-1 bg-transparent text-sm text-[#202123] outline-none placeholder:text-[#8b8b94] dark:text-[#ececec]"
                  placeholder="搜索对话"
                />
              </label>
            )}
          </div>

          <div className="mt-4 min-h-0 flex-1 overflow-y-auto px-2">
            {sidebarOpen ? (
              <>
                <div className="mb-1 px-3 text-[11px] font-medium uppercase tracking-[0.12em] text-[#8b8b94] dark:text-[#737373]">最近</div>
                <div className="space-y-0.5">
                  {HISTORY.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        setActiveHistory(item.id);
                        setMessages(INITIAL_MESSAGES);
                      }}
                      className={`group flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left transition-colors ${
                        activeHistory === item.id
                          ? 'bg-white shadow-sm dark:bg-[#242424]'
                          : 'hover:bg-black/[0.045] dark:hover:bg-white/[0.06]'
                      }`}
                    >
                      <MessageSquare className="h-4 w-4 flex-shrink-0 text-[#777780] dark:text-[#9b9b9b]" />
                      <span className="min-w-0 flex-1 truncate text-[13px]">{item.title}</span>
                      <MoreHorizontal className="h-4 w-4 flex-shrink-0 opacity-0 group-hover:opacity-100" />
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div className="space-y-1">
                {HISTORY.slice(0, 4).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setActiveHistory(item.id)}
                    className={`grid h-11 w-11 place-items-center rounded-lg ${
                      activeHistory === item.id ? 'bg-white dark:bg-[#242424]' : 'hover:bg-black/5 dark:hover:bg-white/[0.06]'
                    }`}
                    title={item.title}
                  >
                    <MessageSquare className="h-4 w-4" />
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="border-t border-black/10 p-3 dark:border-white/10">
            <div className={`flex items-center ${sidebarOpen ? 'gap-2' : 'flex-col gap-2'}`}>
              <button
                type="button"
                onClick={() => setDark((value) => !value)}
                className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-lg text-[#5d5d65] hover:bg-black/[0.06] dark:text-[#b4b4b4] dark:hover:bg-white/10"
                title={dark ? '切换到浅色' : '切换到深色'}
              >
                {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </button>
              {sidebarOpen && (
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium">Qwen3.5-35B-A3B</div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[#777780] dark:text-[#8d8d8d]">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    llama-server 已连接
                  </div>
                </div>
              )}
              <button
                type="button"
                className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-lg text-[#5d5d65] hover:bg-black/[0.06] dark:text-[#b4b4b4] dark:hover:bg-white/10"
                title="设置"
              >
                <Settings2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        </aside>

        <section className="relative flex min-w-0 flex-1 flex-col bg-white dark:bg-[#171717]">
          <header className="flex h-16 flex-shrink-0 items-center justify-between border-b border-black/[0.08] px-4 sm:px-6 dark:border-white/[0.08]">
            <div className="flex min-w-0 items-center gap-3">
              {!sidebarOpen && <Menu className="h-5 w-5 text-[#777780] md:hidden" />}
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h1 className="truncate text-sm font-semibold sm:text-[15px]">{activeTitle}</h1>
                  <button type="button" className="rounded-md p-1 text-[#777780] hover:bg-black/5 dark:hover:bg-white/10" title="切换模型">
                    <ChevronDown className="h-4 w-4" />
                  </button>
                </div>
                <div className="mt-0.5 hidden items-center gap-2 text-[11px] text-[#777780] dark:text-[#8d8d8d] sm:flex">
                  <span>Qwen3.5-35B-A3B-Q4_K_M.gguf</span>
                  <span>·</span>
                  <span className="text-emerald-600 dark:text-emerald-400">运行中</span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-1">
              <div className="mr-2 hidden items-center gap-2 rounded-lg bg-[#f4f4f4] px-2.5 py-1.5 text-[11px] text-[#66666e] lg:flex dark:bg-[#242424] dark:text-[#a5a5a5]">
                <Gauge className="h-3.5 w-3.5" />
                <span>上下文 1,284 / 32,768</span>
              </div>
              <button
                type="button"
                onClick={() => setSettingsOpen((value) => !value)}
                className={`grid h-10 w-10 place-items-center rounded-lg transition-colors ${
                  settingsOpen ? 'bg-[#e7e7e9] dark:bg-[#303030]' : 'hover:bg-black/5 dark:hover:bg-white/10'
                }`}
                title="生成参数"
              >
                <SlidersHorizontal className="h-4 w-4" />
              </button>
              <button type="button" className="grid h-10 w-10 place-items-center rounded-lg hover:bg-black/5 dark:hover:bg-white/10" title="清空对话">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {messages.length === 0 ? (
              <div className="flex h-full items-center justify-center px-6 pb-24 text-center">
                <div className="max-w-lg">
                  <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-black/10 bg-[#f4f4f4] dark:border-white/10 dark:bg-[#242424]">
                    <SquareTerminal className="h-7 w-7" />
                  </div>
                  <h2 className="mt-5 text-2xl font-semibold tracking-tight">开始本地对话</h2>
                  <p className="mt-2 text-sm leading-6 text-[#6f6f78] dark:text-[#999]">当前模型已通过 llama-server 加载。输入消息，或从左侧打开历史对话。</p>
                </div>
              </div>
            ) : (
              <div className="mx-auto w-full max-w-[820px] px-5 pb-44 pt-8 sm:px-8">
                {messages.map((message) => (
                  <article key={message.id} className="group mb-9 grid grid-cols-[32px_minmax(0,1fr)] gap-3 sm:grid-cols-[36px_minmax(0,1fr)] sm:gap-4">
                    <div
                      className={`grid h-8 w-8 place-items-center rounded-lg text-xs font-semibold sm:h-9 sm:w-9 ${
                        message.role === 'assistant'
                          ? 'bg-[#202020] text-white dark:bg-[#ececec] dark:text-[#171717]'
                          : 'border border-black/10 bg-[#f4f4f4] text-[#555] dark:border-white/10 dark:bg-[#292929] dark:text-[#ddd]'
                      }`}
                    >
                      {message.role === 'assistant' ? 'L' : '你'}
                    </div>
                    <div className="min-w-0 pt-0.5">
                      <div className="mb-2 flex items-center gap-2 text-[13px]">
                        <strong>{message.role === 'assistant' ? 'llama.cpp' : '你'}</strong>
                        {message.role === 'assistant' && <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">本地</span>}
                      </div>
                      <div className="whitespace-pre-wrap text-[15px] leading-7 text-[#34343a] dark:text-[#e3e3e3]">{message.content}</div>
                      {message.code && (
                        <pre className="mt-4 overflow-x-auto rounded-xl border border-black/10 bg-[#f4f4f4] p-4 font-mono text-[13px] leading-6 text-[#3c3c43] dark:border-white/10 dark:bg-[#0d0d0d] dark:text-[#d8d8d8]">
                          {message.code}
                        </pre>
                      )}
                      <div className="mt-3 flex items-center gap-1 text-[#777780] opacity-0 transition-opacity group-hover:opacity-100 dark:text-[#8d8d8d]">
                        <button
                          type="button"
                          onClick={() => {
                            void navigator.clipboard?.writeText(message.content);
                            setCopied(true);
                            window.setTimeout(() => setCopied(false), 1200);
                          }}
                          className="grid h-8 w-8 place-items-center rounded-md hover:bg-black/5 dark:hover:bg-white/10"
                          title="复制"
                        >
                          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                        </button>
                        {message.role === 'assistant' && (
                          <button type="button" className="grid h-8 w-8 place-items-center rounded-md hover:bg-black/5 dark:hover:bg-white/10" title="重新生成">
                            <RotateCcw className="h-3.5 w-3.5" />
                          </button>
                        )}
                        <span className="ml-1 text-[11px]">{message.role === 'assistant' ? '36.4 tok/s · 2.1 秒' : '刚刚'}</span>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>

          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-white via-white/95 to-transparent px-4 pb-5 pt-12 dark:from-[#171717] dark:via-[#171717]/95">
            <div className="pointer-events-auto mx-auto max-w-[820px]">
              <div className="rounded-2xl border border-black/15 bg-white shadow-[0_10px_35px_rgba(0,0,0,0.10)] transition-colors focus-within:border-black/30 dark:border-white/15 dark:bg-[#242424] dark:shadow-[0_10px_40px_rgba(0,0,0,0.35)] dark:focus-within:border-white/30">
                <textarea
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      sendMessage();
                    }
                  }}
                  rows={2}
                  placeholder="向本地模型发送消息…"
                  className="chat-composer-input max-h-44 min-h-[62px] w-full resize-none bg-transparent px-4 pt-4 text-[15px] leading-6 outline-none placeholder:text-[#92929a]"
                />
                <div className="flex items-center gap-1.5 px-3 pb-3">
                  <button type="button" className="grid h-9 w-9 place-items-center rounded-lg text-[#66666e] hover:bg-black/5 dark:text-[#aaa] dark:hover:bg-white/10" title="添加附件">
                    <Paperclip className="h-4 w-4" />
                  </button>
                  <button type="button" className="flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs text-[#55555d] hover:bg-black/5 dark:text-[#b4b4b4] dark:hover:bg-white/10" title="思考模式">
                    <BrainCircuit className="h-4 w-4" />
                    自动思考
                  </button>
                  <button type="button" className="hidden h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs text-[#55555d] hover:bg-black/5 sm:flex dark:text-[#b4b4b4] dark:hover:bg-white/10" title="工具调用">
                    <Sparkles className="h-4 w-4" />
                    工具
                  </button>
                  <span className="ml-auto hidden text-[11px] text-[#888890] sm:block">Enter 发送 · Shift + Enter 换行</span>
                  <button
                    type="button"
                    onClick={sendMessage}
                    disabled={!input.trim()}
                    className="ml-1 grid h-9 w-9 place-items-center rounded-xl bg-[#202020] text-white transition-colors hover:bg-black disabled:bg-[#dedee2] disabled:text-[#999] dark:bg-[#ececec] dark:text-[#171717] dark:hover:bg-white dark:disabled:bg-[#3a3a3a] dark:disabled:text-[#777]"
                    title="发送"
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <p className="mt-2 text-center text-[10px] text-[#8b8b94] dark:text-[#747474]">本地模型可能生成不准确内容，请核对重要信息</p>
            </div>
          </div>
        </section>

        <aside
          className={`absolute inset-y-0 right-0 z-30 w-[min(360px,calc(100vw-32px))] border-l border-black/10 bg-[#f7f7f8] shadow-2xl transition-transform duration-200 dark:border-white/10 dark:bg-[#101010] lg:relative lg:shadow-none ${
            settingsOpen ? 'translate-x-0' : 'translate-x-full lg:hidden'
          }`}
        >
          <div className="flex h-16 items-center justify-between border-b border-black/10 px-5 dark:border-white/10">
            <div>
              <h2 className="text-sm font-semibold">生成参数</h2>
              <p className="mt-0.5 text-[11px] text-[#777780] dark:text-[#8d8d8d]">仅用于界面预览，不会修改默认值</p>
            </div>
            <button type="button" onClick={() => setSettingsOpen(false)} className="grid h-9 w-9 place-items-center rounded-lg hover:bg-black/5 dark:hover:bg-white/10" title="关闭参数面板">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="h-[calc(100%-64px)] overflow-y-auto p-5">
            <div className="rounded-xl border border-black/10 bg-white p-4 dark:border-white/10 dark:bg-[#1b1b1b]">
              <label className="text-xs font-medium">系统提示词</label>
              <textarea
                rows={5}
                defaultValue="你是一个严谨、简洁的本地 AI 助手。"
                className="mt-2 w-full resize-none rounded-lg border border-black/10 bg-[#f7f7f8] p-3 text-xs leading-5 outline-none focus:border-black/25 dark:border-white/10 dark:bg-[#101010] dark:focus:border-white/25"
              />
            </div>
            <ParameterRow label="温度" hint="temperature" value={temperature} display={temperature.toFixed(2)} min={0} max={2} step={0.05} onChange={setTemperature} />
            <ParameterRow label="核采样" hint="top_p" value={topP} display={topP.toFixed(2)} min={0} max={1} step={0.01} onChange={setTopP} />
            <ParameterRow label="最大输出 Token" hint="n_predict" value={maxTokens} display={String(maxTokens)} min={0} max={8192} step={128} onChange={setMaxTokens} />
            <div className="mt-4 rounded-xl border border-black/10 bg-white p-4 text-xs dark:border-white/10 dark:bg-[#1b1b1b]">
              <div className="flex items-center justify-between">
                <span className="font-medium">模型状态</span>
                <span className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400"><span className="h-1.5 w-1.5 rounded-full bg-current" />运行中</span>
              </div>
              <dl className="mt-3 space-y-2 text-[#6f6f78] dark:text-[#999]">
                <div className="flex justify-between gap-4"><dt>上下文长度（ctx）</dt><dd className="font-mono text-[#333] dark:text-[#ddd]">32768</dd></div>
                <div className="flex justify-between gap-4"><dt>GPU 卸载（ngl）</dt><dd className="font-mono text-[#333] dark:text-[#ddd]">99</dd></div>
                <div className="flex justify-between gap-4"><dt>并行数（parallel）</dt><dd className="font-mono text-[#333] dark:text-[#ddd]">1</dd></div>
              </dl>
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}

function ParameterRow({ label, hint, value, display, min, max, step, onChange }: {
  label: string;
  hint: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="mt-4 rounded-xl border border-black/10 bg-white p-4 dark:border-white/10 dark:bg-[#1b1b1b]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-medium">{label}</div>
          <div className="mt-0.5 font-mono text-[10px] text-[#8b8b94] dark:text-[#777]">{hint}</div>
        </div>
        <output className="rounded-md bg-[#f0f0f2] px-2 py-1 font-mono text-[11px] dark:bg-[#2a2a2a]">{display}</output>
      </div>
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
        className="mt-4 h-1.5 w-full cursor-pointer accent-[#202020] dark:accent-[#ececec]"
      />
    </div>
  );
}
