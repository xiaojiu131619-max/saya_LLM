import { useState } from 'react';
import { Check, Copy, KeyRound, MessageSquare, Radio } from 'lucide-react';
import type { Fast27bStatus } from '@/lib/desktop';

export default function Fast27bConnection({ status, desktop, onOpenChat }: {
  status: Fast27bStatus | null; desktop: boolean; onOpenChat: () => void;
}) {
  const [copied, setCopied] = useState<'url' | 'model' | null>(null);
  const port = status?.port ?? 8094;
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const modelId = status?.model_id ?? 'qwen3.8-27b';
  const copy = async (kind: 'url' | 'model', value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(kind);
    window.setTimeout(() => setCopied(null), 1500);
  };
  const facts = [
    { label: 'API 基础地址', value: baseUrl, kind: 'url' as const },
    { label: '模型 ID', value: modelId, kind: 'model' as const },
  ];
  return <section className="fast27b-chart-panel space-y-5" aria-label="API 接入信息">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="flex items-center gap-2 text-[length:var(--font-body)] font-semibold text-primary-custom"><Radio className="h-4 w-4 text-[var(--accent)]" />OpenAI 兼容 API</h2>
        <p className="mt-1 text-[length:var(--font-caption)] text-secondary-custom">聊天、DSH 和外部客户端共用同一个引擎服务。</p>
      </div>
      <span className={`rounded-full px-2.5 py-1 text-[length:var(--font-eyebrow)] ${status?.api_ready ? 'bg-[var(--state-success-bg)] text-[var(--state-success)]' : 'bg-[var(--surface-muted)] text-secondary-custom'}`}>{status?.api_ready ? 'API 已就绪' : '等待引擎启动'}</span>
    </div>
    <div className="space-y-3">{facts.map(({ label, value, kind }) => <div key={kind}>
      <div className="mb-1.5 text-[length:var(--font-caption)] text-secondary-custom">{label}</div>
      <div className="flex items-center gap-2 rounded-[var(--radius-field)] border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5">
        <code className="mono-font min-w-0 flex-1 break-all text-[length:var(--font-caption)] text-primary-custom">{value}</code>
        <button type="button" aria-label={`复制${label}`} onClick={() => void copy(kind, value)} className="shrink-0 rounded p-1 text-secondary-custom hover:bg-[var(--surface-hover)]">{copied === kind ? <Check className="h-4 w-4 text-[var(--state-success)]" /> : <Copy className="h-4 w-4" />}</button>
      </div>
    </div>)}</div>
    <div className="flex items-start gap-2 rounded-[var(--radius-lg)] bg-[var(--surface-muted)] p-3 text-[length:var(--font-caption)] leading-relaxed text-secondary-custom"><KeyRound className="mt-0.5 h-4 w-4 shrink-0" /><p>API key 使用高级配置中保存的值，客户端以 <code className="mono-font">Authorization: Bearer &lt;API key&gt;</code> 发送。{status?.lan ? `已开放局域网：其他设备使用本机局域网 IP 和端口 ${port}。` : '当前仅本机可访问；需要局域网接入时可在高级配置中开启。'}</p></div>
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] pt-4">
      <p className="text-[length:var(--font-caption)] text-secondary-custom">单并发 · 推理性能可在“性能”标签中查看</p>
      <button type="button" onClick={onOpenChat} disabled={!desktop || !status?.api_ready} className="inline-flex items-center gap-2 rounded-[var(--radius-lg)] bg-[var(--accent)] px-4 py-2 text-[length:var(--font-caption)] font-medium text-[var(--text-on-accent)] disabled:cursor-not-allowed disabled:opacity-40"><MessageSquare className="h-4 w-4" />使用 fast-27b 对话</button>
    </div>
  </section>;
}
