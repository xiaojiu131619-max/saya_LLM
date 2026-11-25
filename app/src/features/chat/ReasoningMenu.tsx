import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Sparkles } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import { fetchServerReasoningEffortCap } from '@/lib/desktop';
import { planReasoning, reasoningProfileFromModel } from '@/lib/reasoningGears';
import type { ReasoningProfile } from '@/types';
import type { ModelInfo } from '@/types';
import { REASONING_OPTIONS } from '@/features/chat/chatOptions';
import { ENGINE_REASONING_PROFILE, type ChatEngineTarget } from '@/features/chat/chatEngineTarget';
import { useMenuKeyboard } from '@/hooks/useMenuKeyboard';

/**
 * 思考挡位菜单：按钮 + 上弹选项。
 *
 * 挡位自动识别：按模型对话模板（GGUF 原文，或加载配置里覆盖的自定义模板）
 * 判断该模型到底认哪些挡位，再把界面四挡意图翻译成实际下发的参数。
 * 界面与发送链路（streamChatCompletion）共用同一份档案，保证「显示的就是发出的」。
 */
export default function ReasoningMenu({ canChat, reqPort, reqApiKey, reqReasoningBudget, reqReasoningSupported, engineTarget, activeModel }: {
  canChat: boolean;
  reqPort: number;
  reqApiKey: string | undefined;
  reqReasoningBudget: number;
  reqReasoningSupported: boolean;
  engineTarget: ChatEngineTarget | null;
  activeModel: ModelInfo | null;
}) {
  const { state, dispatch } = useApp();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useMenuKeyboard({ open, menuRef, triggerRef, onClose: () => setOpen(false) });

  const reasoningProfile = useMemo<ReasoningProfile>(
    () => (engineTarget ? ENGINE_REASONING_PROFILE : reasoningProfileFromModel(activeModel)),
    [engineTarget, activeModel],
  );
  // 运行中的服务端对模板能力有最终发言权：打开菜单时就地读一次 /props 的
  // chat_template_caps，与服务端判定不一致时（自定义模板、内核差异）按服务端结果展示，
  // 避免界面写着「effort 高」而请求里已经把 reasoning_effort 撤掉。
  const [runtimeCaps, setRuntimeCaps] = useState<{ key: string; supportsReasoningEffort?: boolean } | null>(null);
  // 引擎目标的身份 ID 与主模型的模型 id 合一：缓存 key 用「端口|身份」即可区分。
  const runtimeCapsKey = `${reqPort}|${engineTarget ? engineTarget.runtimeModelId : (activeModel?.id ?? '')}`;
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void fetchServerReasoningEffortCap(reqPort, reqApiKey).then((supportsReasoningEffort) => {
      if (!cancelled) setRuntimeCaps({ key: runtimeCapsKey, supportsReasoningEffort });
    });
    return () => { cancelled = true; };
  }, [open, reqPort, reqApiKey, runtimeCapsKey]);
  // 服务端明确说模板不认 reasoning_effort 时，退回按思考预算展示。
  const displayReasoningProfile = useMemo<ReasoningProfile>(() => {
    const supported = runtimeCaps?.key === runtimeCapsKey ? runtimeCaps.supportsReasoningEffort : undefined;
    if (supported !== false || reasoningProfile.efforts.length === 0) return reasoningProfile;
    return {
      ...reasoningProfile,
      efforts: [],
      summary: `${reasoningProfile.summary}（服务端复核：当前模板不支持 reasoning_effort，已退回思考预算）`,
    };
  }, [reasoningProfile, runtimeCaps, runtimeCapsKey]);
  const reasoningPlan = useMemo(
    () => planReasoning(state.chatConfig.reasoningMode, displayReasoningProfile, reqReasoningBudget, reqReasoningSupported),
    [state.chatConfig.reasoningMode, displayReasoningProfile, reqReasoningBudget, reqReasoningSupported],
  );
  const reasoningMenuItems = useMemo(
    () => REASONING_OPTIONS.map((item) => ({
      ...item,
      plan: planReasoning(item.mode, displayReasoningProfile, reqReasoningBudget, reqReasoningSupported),
    })),
    [displayReasoningProfile, reqReasoningBudget, reqReasoningSupported],
  );

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

  const currentReasoningOption = REASONING_OPTIONS.find((item) => item.mode === state.chatConfig.reasoningMode) ?? REASONING_OPTIONS[1];

  return (
    <div ref={menuRef} className="relative flex-shrink-0">
      <button
        ref={triggerRef}
        onClick={() => {
          setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          // ↓ 直接展开并进入菜单：键盘用户不必先 Enter 再 Tab。
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        disabled={!canChat}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex h-9 items-center gap-1.5 rounded-[var(--radius-field)] border px-2.5 text-[length:var(--font-caption)] font-medium transition-colors disabled:opacity-40 ${
          state.chatConfig.reasoningMode === 'deep'
            ? 'border-[var(--accent)]/55 bg-[var(--accent-subtle)] text-[var(--accent)] hover:bg-[var(--accent-subtle)] dark:border-[var(--accent)]/35 dark:bg-[var(--accent-subtle)] dark:text-[var(--accent)] dark:hover:bg-[var(--accent-subtle)]'
            : 'border-transparent bg-transparent text-[var(--text-primary)] hover:bg-black/[0.055] dark:text-[var(--text-secondary)] dark:hover:bg-[var(--surface-raised)]'
        }`}
        title={canChat ? `思考强度：${reasoningPlan.requestLabel}` : '加载模型或启动引擎后可调整思考强度'}
      >
        <Sparkles className="h-4 w-4" />
        <span>{currentReasoningOption.label}</span>
        {/* 自动识别出的实际挡位：与请求里真正下发的参数一致 */}
        <span
          className={`rounded-[var(--radius-sm)] border px-1.5 py-0.5 text-[length:var(--font-eyebrow)] font-normal ${
            reasoningPlan.honored
              ? 'border-[var(--border)] bg-[var(--app-bg)] text-[var(--text-secondary)] dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-[var(--text-secondary)]'
              : 'border-[var(--state-warning-border)] bg-[var(--state-warning-bg)] text-[var(--state-warning)]'
          }`}
        >
          {reasoningPlan.gearLabel}
        </span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={false}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            role="menu"
            aria-label="思考强度"
            className="anim-enter-pop absolute bottom-10 left-0 z-20 w-72 overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--app-bg)] p-1 shadow-xl dark:border-white/[0.08] dark:bg-[var(--surface-raised)]"
          >
            {reasoningMenuItems.map((item) => (
              <button
                key={item.mode}
                type="button"
                role="menuitem"
                title={item.description}
                onClick={() => {
                  dispatch({ type: 'SET_CHAT_CONFIG', payload: { reasoningMode: item.mode } });
                  setOpen(false);
                }}
                className={`w-full rounded-[var(--radius-field)] px-3 py-2 text-left transition-colors ${
                  state.chatConfig.reasoningMode === item.mode
                    ? 'bg-[var(--surface-muted)] text-[var(--accent)] dark:bg-[var(--surface-raised)] dark:text-[var(--accent)]'
                    : 'text-[var(--text-primary)] hover:bg-[var(--surface-muted)] dark:hover:bg-white/[0.07]'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-[length:var(--font-body)] font-semibold">{item.label}</span>
                  {!item.plan.honored && (
                    <span className="rounded-[var(--radius-sm)] border border-[var(--state-warning-border)] bg-[var(--state-warning-bg)] px-1.5 py-0.5 text-[length:var(--font-eyebrow)] font-medium text-[var(--state-warning)]">
                      模型不支持
                    </span>
                  )}
                </div>
                <div className="mt-0.5 font-mono text-[length:var(--font-eyebrow)] text-[var(--text-secondary)]">{item.plan.requestLabel}</div>
                {item.plan.note && (
                  <div className="mt-0.5 text-[length:var(--font-eyebrow)] leading-4 text-[var(--state-warning)]">{item.plan.note}</div>
                )}
              </button>
            ))}
            <div className="mt-1 border-t border-[var(--border)] px-3 py-2 text-[length:var(--font-eyebrow)] leading-4 text-[var(--text-tertiary)] dark:border-white/[0.08]">
              自动识别（{displayReasoningProfile.source === 'template' ? '对话模板' : displayReasoningProfile.source === 'none' ? '无证据' : '架构/名字兜底'}）：{displayReasoningProfile.summary}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
