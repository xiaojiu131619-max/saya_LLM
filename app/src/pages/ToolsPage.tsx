import { AlertTriangle, Check, RotateCcw, ShieldAlert, Wrench } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import PageHeader from '@/components/PageHeader';
import McpServersSection from '@/features/settings/McpServersSection';
import { LLAMA_CPP_TOOLS, toolLabel, toolScopeLabel } from '@/lib/llamaTools';

function riskClass(risk: string) {
  if (risk === '高') return 'border-[var(--state-danger-border)] bg-[var(--state-danger-bg)] text-[var(--state-danger)] dark:border-[var(--state-danger-border)] dark:bg-[var(--surface-raised)] dark:text-[var(--state-danger)]';
  if (risk === '中') return 'border-[var(--state-warning-border)] bg-[var(--state-warning-bg)] text-[var(--state-warning)] dark:border-[var(--state-danger-border)] dark:bg-[var(--surface-raised)] dark:text-[var(--state-warning)]';
  return 'border-[var(--state-success-border)] bg-[var(--state-success-bg)] text-[var(--state-success)] dark:border-[var(--state-success-border)] dark:bg-[var(--state-success-bg)] dark:text-[var(--state-success)]';
}

export default function ToolsPage() {
  const { state, dispatch } = useApp();
  const enabledTools = state.chatConfig.enabledTools;
  const enabledToolSet = new Set(enabledTools);
  const enabledLabels = enabledTools.map(toolLabel).join('、') || '未启用';
  const hasEnabledServerTools = LLAMA_CPP_TOOLS.some((tool) => tool.serverBuiltin && enabledToolSet.has(tool.id));
  const configuredHost = state.apiConfig.host.trim() || '0.0.0.0';
  const isLoopbackHost = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(configuredHost.toLowerCase());
  // 用 hasApiKey 判断：apiKey 不落盘，冷启动且服务未运行时它是 undefined，会误报“未受保护”。
  const serverToolsNeedApiKey = state.apiConfig.enabled
    && !isLoopbackHost
    && !state.apiConfig.hasApiKey
    && hasEnabledServerTools;

  const updateTools = (nextTools: string[]) => {
    dispatch({ type: 'SET_CHAT_CONFIG', payload: { enabledTools: nextTools } });
  };

  const toggleTool = (toolId: string) => {
    updateTools(enabledToolSet.has(toolId)
      ? enabledTools.filter((item) => item !== toolId)
      : [...enabledTools, toolId]);
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto mb-6 max-w-3xl">
          <PageHeader
            icon={Wrench}
            title="工具"
            description="选择允许模型调用的 llama.cpp 原生工具，并接入 MCP 服务器。"
          />
        </div>

        <div className="mx-auto max-w-3xl pb-12">
          <section className="border-b border-[var(--border-subtle)] py-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <div className="mb-2 flex items-center gap-2">
                  <Wrench className="h-4.5 w-4.5 text-[var(--accent)]" />
                  <h2 className="text-[15px] font-semibold text-primary-custom">模型工具调用</h2>
                </div>
                <p className="text-sm leading-6 text-secondary-custom">
                  当前启用：{enabledLabels}
                </p>
                {state.serverRunning && (
                  <p className="mt-2 flex items-start gap-2 text-xs leading-5 text-[var(--state-warning)] dark:text-[var(--accent)]">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                    工具开关需要重新加载模型后才会同步到服务器。
                  </p>
                )}
                {serverToolsNeedApiKey && (
                  <p className="mt-2 flex items-start gap-2 text-xs leading-5 text-[var(--state-danger)] dark:text-[var(--state-danger)]">
                    <ShieldAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                    远程 API 未设置 API key。为避免局域网暴露文件或命令接口，llama.cpp 原生工具不会公开。
                  </p>
                )}
              </div>
              <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => updateTools(LLAMA_CPP_TOOLS.map((tool) => tool.id))}
                  className="flex h-9 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)] dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[var(--text-secondary)] dark:hover:bg-white/[0.09]"
                >
                  <Check className="h-4 w-4" />
                  全部开启
                </button>
                <button
                  type="button"
                  onClick={() => updateTools([])}
                  className="flex h-9 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)] dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[var(--text-secondary)] dark:hover:bg-white/[0.09]"
                >
                  <RotateCcw className="h-4 w-4" />
                  全部关闭
                </button>
              </div>
            </div>
          </section>

          <section className="overflow-hidden">
            <div className="border-b border-[var(--border-subtle)] py-4">
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-4.5 w-4.5 text-[var(--accent)]" />
                <h2 className="text-[15px] font-semibold text-primary-custom">可用工具</h2>
              </div>
              <p className="mt-1 text-xs leading-5 text-secondary-custom">
                高风险工具会允许模型执行命令或修改文件，只建议在可信模型和明确任务中开启。
              </p>
            </div>

            <div className="divide-y divide-[var(--border-subtle)]">
              {LLAMA_CPP_TOOLS.map((tool) => {
                const selected = enabledToolSet.has(tool.id);
                return (
                  <button
                    key={tool.id}
                    type="button"
                    role="switch"
                    aria-checked={selected}
                    onClick={() => toggleTool(tool.id)}
                    className="grid w-full gap-3 py-4 text-left transition-colors hover:bg-[var(--surface-muted)]/40 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                  >
                    <span className="min-w-0">
                      <span className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-primary-custom">{tool.label}</span>
                        <span className="mono-font rounded-md bg-black/[0.04] px-1.5 py-0.5 text-[11px] text-secondary-custom dark:bg-white/[0.06]">{tool.id}</span>
                        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${riskClass(tool.risk)}`}>
                          {tool.risk}风险
                        </span>
                        <span className="rounded-md bg-black/[0.04] px-1.5 py-0.5 text-[11px] text-secondary-custom dark:bg-white/[0.06]">
                          {toolScopeLabel(tool.id)}
                        </span>
                      </span>
                      <span className="mt-1 block text-sm leading-6 text-secondary-custom">{tool.description}</span>
                    </span>
                    <span
                      aria-hidden="true"
                      className={`flex h-6 w-11 flex-shrink-0 items-center rounded-full border p-0.5 transition-colors sm:justify-self-end ${
                        selected
                          ? 'justify-end border-[var(--state-success)] bg-[var(--state-success)]'
                          : 'justify-start border-[var(--border)] bg-[var(--border)] dark:border-white/[0.18] dark:bg-white/[0.10]'
                      }`}
                    >
                      <span className="h-4.5 w-4.5 rounded-full bg-white shadow-sm" />
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <McpServersSection />
        </div>
      </div>
    </div>
  );
}
