import { AlertTriangle, Check, RotateCcw, ShieldAlert, Sparkles, Wrench } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import PageHeader from '@/components/PageHeader';
import McpServersSection from '@/features/settings/McpServersSection';
import { LLAMA_CPP_TOOLS, toolLabel, toolScopeLabel } from '@/lib/llamaTools';

function riskClass(risk: string) {
  if (risk === '高') return 'border-[var(--state-danger-border)] bg-[var(--state-danger-bg)] text-[var(--state-danger)]';
  if (risk === '中') return 'border-[var(--state-warning-border)] bg-[var(--state-warning-bg)] text-[var(--state-warning)]';
  return 'border-[var(--state-success-border)] bg-[var(--state-success-bg)] text-[var(--state-success)]';
}

/** 左/右栏的统一卡片外壳：标题 + 一句说明 + 主体。 */
function ToolColumn({ icon: Icon, title, description, summary, children }: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  summary?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-4 dark:border-white/[0.08]">
      <div className="mb-3 flex items-start gap-2 border-b border-[var(--border-subtle)] pb-3">
        <Icon className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--accent)]" />
        <div className="min-w-0 flex-1">
          <h2 className="text-[length:var(--font-subtitle)] font-semibold text-[var(--text-primary)]">{title}</h2>
          <p className="mt-0.5 text-[length:var(--font-caption)] leading-5 text-[var(--text-secondary)]">{description}</p>
          {summary}
        </div>
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </section>
  );
}

/**
 * 工具页：左原生工具 / 右 MCP 工具，一左一右并排。
 *
 * 两类工具对模型的暴露方式不同（原生工具是 llama.cpp 进程内的能力开关，
 * MCP 是外部服务器进程），但它们在对话里最终合成同一份 tools 清单，
 * 所以放在同一页对照查看：左边定「给模型哪些内置能力」，右边定「再接哪些外部能力」。
 *
 * 窄屏（<1100px）自动堆成上下两栏：并排时每列不足 480px，MCP 表单会挤成一团。
 */
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
      <div className="flex-1 overflow-y-auto px-5 py-5">
        <div className="mx-auto mb-4 max-w-[1500px]">
          <PageHeader
            icon={Wrench}
            title="工具"
            description="左侧是随模型进程运行的原生工具，右侧是外部 MCP 服务器提供的工具；两者会合并成对话里的同一份工具清单。"
          />
        </div>

        <div className="mx-auto grid max-w-[1500px] gap-4 pb-8 min-[1100px]:grid-cols-2">
          {/* 左：原生工具 */}
          <ToolColumn
            icon={Wrench}
            title="原生工具"
            description="由 llama.cpp 进程自身提供，随模型一起加载；开启后模型可直接读写文件或执行命令。"
            summary={(
              <div className="mt-2 space-y-1.5">
                <p className="text-[length:var(--font-caption)] text-[var(--text-secondary)]">
                  已启用 {enabledTools.length} / {LLAMA_CPP_TOOLS.length}：{enabledLabels}
                </p>
                {state.serverRunning && (
                  <p className="flex items-start gap-1.5 text-[length:var(--font-caption)] leading-5 text-[var(--state-warning)]">
                    <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" />
                    工具开关需要重新加载模型后才会同步到服务器。
                  </p>
                )}
                {serverToolsNeedApiKey && (
                  <p className="flex items-start gap-1.5 text-[length:var(--font-caption)] leading-5 text-[var(--state-danger)]">
                    <ShieldAlert className="mt-0.5 h-3 w-3 flex-shrink-0" />
                    远程 API 未设置 API key：为避免局域网暴露文件或命令接口，原生工具不会公开。
                  </p>
                )}
              </div>
            )}
          >
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => updateTools(LLAMA_CPP_TOOLS.map((tool) => tool.id))}
                className="flex h-8 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 text-[length:var(--font-caption)] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)] dark:border-white/[0.08]"
              >
                <Check className="h-3.5 w-3.5" />
                全部开启
              </button>
              <button
                type="button"
                onClick={() => updateTools([])}
                className="flex h-8 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 text-[length:var(--font-caption)] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)] dark:border-white/[0.08]"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                全部关闭
              </button>
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
                    className="flex w-full items-start gap-3 py-2.5 text-left transition-colors hover:bg-[var(--surface-muted)]/50"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <span className="text-[length:var(--font-body)] font-semibold text-[var(--text-primary)]">{tool.label}</span>
                        <span className="mono-font rounded-[var(--radius-sm)] bg-black/[0.04] px-1.5 py-0.5 text-[length:var(--font-eyebrow)] text-[var(--text-secondary)] dark:bg-white/[0.06]">{tool.id}</span>
                        <span className={`rounded-full border px-1.5 py-0.5 text-[length:var(--font-eyebrow)] font-medium ${riskClass(tool.risk)}`}>
                          {tool.risk}风险
                        </span>
                        <span className="rounded-[var(--radius-sm)] bg-black/[0.04] px-1.5 py-0.5 text-[length:var(--font-eyebrow)] text-[var(--text-secondary)] dark:bg-white/[0.06]">
                          {toolScopeLabel(tool.id)}
                        </span>
                      </span>
                      <span className="mt-0.5 block text-[length:var(--font-caption)] leading-5 text-[var(--text-secondary)]">{tool.description}</span>
                    </span>
                    <span
                      aria-hidden="true"
                      className={`mt-0.5 flex h-5 w-9 flex-shrink-0 items-center rounded-full border p-0.5 transition-colors ${
                        selected
                          ? 'justify-end border-[var(--state-success)] bg-[var(--state-success)]'
                          : 'justify-start border-[var(--border)] bg-[var(--border)] dark:border-white/[0.18] dark:bg-white/[0.10]'
                      }`}
                    >
                      <span className="h-3.5 w-3.5 rounded-full bg-white shadow-sm" />
                    </span>
                  </button>
                );
              })}
            </div>
          </ToolColumn>

          {/* 右：MCP 工具 */}
          <div className="min-w-0 rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-4 dark:border-white/[0.08]">
            <McpServersSection embedded />
          </div>
        </div>

        <div className="mx-auto flex max-w-[1500px] items-start gap-2 border-t border-[var(--border-subtle)] pt-3 text-[length:var(--font-caption)] leading-5 text-[var(--text-tertiary)]">
          <Sparkles className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span>两类工具的调用记录都会出现在对话气泡的「工具调用」面板里；MCP 工具名带 <span className="mono-font">mcp__服务器名__工具名</span> 前缀以区分来源。</span>
        </div>
      </div>
    </div>
  );
}
