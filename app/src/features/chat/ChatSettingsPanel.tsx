import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronDown, SlidersHorizontal, Tag, X } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import { ChatNumberSetting } from '@/features/chat/chatControls';

/** 对话参数面板（工作区侧栏内容）：系统提示词预设 + 温度 / Top P / 惩罚 / 输出上限。 */
export default function ChatSettingsPanel({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useApp();
  const [savingPreset, setSavingPreset] = useState(false);
  const [presetTitle, setPresetTitle] = useState('');
  const [presetMenuOpen, setPresetMenuOpen] = useState(false);
  const presetMenuRef = useRef<HTMLDivElement>(null);
  const currentPrompt = state.chatConfig.systemPrompt.trim();
  const activePreset = state.systemPromptPresets.find((preset) => preset.prompt === state.chatConfig.systemPrompt);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (presetMenuRef.current && !presetMenuRef.current.contains(e.target as Node)) {
        setPresetMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const applyPresetPrompt = (prompt: string) => {
    dispatch({ type: 'SET_CHAT_CONFIG', payload: { systemPrompt: prompt } });
    setPresetMenuOpen(false);
  };

  const cancelSavePreset = () => {
    setSavingPreset(false);
    setPresetTitle('');
  };

  const confirmSavePreset = () => {
    if (!currentPrompt) return;
    dispatch({
      type: 'SAVE_SYSTEM_PROMPT_PRESET',
      payload: { title: presetTitle, prompt: state.chatConfig.systemPrompt },
    });
    setPresetTitle('');
    setSavingPreset(false);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-4 flex items-center justify-between">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 truncate text-[length:var(--font-subtitle)] font-semibold tracking-[var(--tracking-tight)] text-[var(--text-primary)]">
            <SlidersHorizontal className="h-4 w-4 flex-shrink-0 text-[var(--accent)]" />
            对话参数
          </h2>
          <p className="mt-1 truncate text-[length:var(--font-caption)] text-[var(--text-secondary)]">当前会话 · 默认预设</p>
        </div>
        <button
          onClick={onClose}
          aria-label="关闭对话参数"
          title="关闭对话参数"
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[var(--radius-field)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--border)] dark:hover:bg-white/[0.08]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div>
          <div className="border-b border-black/[0.06] pb-5 dark:border-white/[0.06]">
            <div className="mb-2 flex items-center justify-between gap-2">
              <label className="text-[length:var(--font-body)] font-medium text-[var(--text-primary)]">系统提示词</label>
              {activePreset ? (
                <span className="flex min-w-0 items-center gap-1 text-[length:var(--font-caption)] text-[var(--accent)]" title={`使用标签「${activePreset.title}」`}>
                  <Tag className="h-3 w-3 flex-shrink-0" />
                  <span className="truncate">{activePreset.title}</span>
                </span>
              ) : (
                <span className="flex-shrink-0 text-[length:var(--font-caption)] text-[var(--text-tertiary)]">
                  {state.chatConfig.systemPrompt.length > 0 ? `${state.chatConfig.systemPrompt.length} 字` : '未设置'}
                </span>
              )}
            </div>
            <textarea
              value={state.chatConfig.systemPrompt}
              onChange={(event) => dispatch({ type: 'SET_CHAT_CONFIG', payload: { systemPrompt: event.target.value } })}
              rows={7}
              placeholder="为当前对话设置角色、规则或输出格式"
              className="w-full resize-none rounded-[var(--radius-field)] border border-[var(--border)] bg-[var(--app-bg)] px-3 py-2 text-[length:var(--font-body)] leading-[var(--leading-ui)] text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--accent)] dark:border-white/[0.08] dark:placeholder:text-[var(--text-tertiary)]"
            />

            <div className="mt-3 flex min-w-0 items-center gap-2">
              <div ref={presetMenuRef} className="relative min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => setPresetMenuOpen((value) => !value)}
                  disabled={state.systemPromptPresets.length === 0}
                  aria-expanded={presetMenuOpen}
                  className="flex h-10 w-full min-w-0 items-center gap-2 rounded-[var(--radius-field)] border border-[var(--border)] bg-[var(--app-bg)] px-3 text-[length:var(--font-body)] transition-colors hover:bg-[var(--surface-muted)] disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/[0.08] dark:hover:bg-white/[0.05]"
                  title={state.systemPromptPresets.length === 0 ? '暂无预设，保存后可在此快速切换' : '选择已保存的预设'}
                >
                  <ChevronDown className="h-4 w-4 flex-shrink-0 text-[var(--text-secondary)]" />
                  <span className={`min-w-0 truncate ${activePreset ? 'font-medium text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>
                    {state.systemPromptPresets.length === 0
                      ? '暂无预设'
                      : activePreset
                        ? activePreset.title
                        : '选择预设'}
                  </span>
                  <span className="ml-auto flex-shrink-0 text-[length:var(--font-caption)] text-[var(--text-tertiary)]">
                    {state.systemPromptPresets.length} 个
                  </span>
                </button>
                <AnimatePresence>
                  {presetMenuOpen && (
                    <motion.div
                      initial={false}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -4, scale: 0.98 }}
                      className="anim-enter-pop absolute left-0 top-full z-30 mt-1.5 max-h-64 w-full overflow-y-auto rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--app-bg)] p-1 shadow-xl dark:border-white/[0.08] dark:bg-[var(--surface-raised)]"
                    >
                      {state.systemPromptPresets.map((preset) => {
                        const selected = preset.prompt === state.chatConfig.systemPrompt;
                        return (
                          <button
                            key={preset.id}
                            type="button"
                            onClick={() => applyPresetPrompt(preset.prompt)}
                            title={preset.prompt}
                            className={`w-full rounded-[var(--radius-field)] px-3 py-2 text-left transition-colors ${
                              selected
                                ? 'bg-[var(--surface-muted)] text-[var(--accent)] dark:bg-white/[0.07] dark:text-[var(--accent)]'
                                : 'text-[var(--text-primary)] hover:bg-[var(--surface-muted)] dark:hover:bg-white/[0.07]'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate text-[length:var(--font-body)] font-semibold">{preset.title}</span>
                              {selected && <Check className="h-3.5 w-3.5 flex-shrink-0" />}
                            </div>
                            <div className="mt-0.5 truncate text-[length:var(--font-caption)] text-[var(--text-secondary)]">
                              {preset.prompt || '（空）'}
                            </div>
                          </button>
                        );
                      })}
                      <div className="px-3 pb-1 pt-2 text-[length:var(--font-eyebrow)] leading-4 text-[var(--text-tertiary)]">
                        点击应用，同名保存会覆盖更新；删除请使用下方标签。
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
              {!savingPreset && (
                <button
                  type="button"
                  onClick={() => setSavingPreset(true)}
                  disabled={!currentPrompt}
                  className="h-10 flex-shrink-0 rounded-[var(--radius-field)] bg-[var(--text-primary)] px-3 text-[length:var(--font-body)] font-medium text-[var(--app-bg)] transition-colors hover:bg-[var(--text-primary)] disabled:cursor-not-allowed disabled:bg-[var(--border)] disabled:text-[var(--text-secondary)] dark:bg-[var(--accent)] dark:hover:bg-[var(--accent-hover)] dark:disabled:bg-white/[0.08] dark:disabled:text-[var(--text-tertiary)]"
                >
                  存为标签
                </button>
              )}
            </div>

            <AnimatePresence initial={false}>
              {savingPreset && (
                <motion.div
                  key="save-preset-row"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.16 }}
                  className="overflow-hidden"
                >
                  <div className="mt-2 flex min-w-0 gap-2">
                    <input
                      autoFocus
                      value={presetTitle}
                      onChange={(event) => setPresetTitle(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') confirmSavePreset();
                        else if (event.key === 'Escape') cancelSavePreset();
                      }}
                      placeholder="输入标签名称，留空自动编号"
                      className="min-w-0 flex-1 rounded-[var(--radius-field)] border border-[var(--border)] bg-[var(--app-bg)] px-3 py-2 text-[length:var(--font-body)] text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--accent)] dark:border-white/[0.08] dark:placeholder:text-[var(--text-tertiary)]"
                    />
                    <button
                      type="button"
                      onClick={confirmSavePreset}
                      disabled={!currentPrompt}
                      className="h-9 flex-shrink-0 rounded-[var(--radius-field)] bg-[var(--text-primary)] px-3 text-[length:var(--font-body)] font-medium text-[var(--app-bg)] transition-colors hover:bg-[var(--text-primary)] disabled:cursor-not-allowed disabled:bg-[var(--border)] disabled:text-[var(--text-secondary)] dark:bg-[var(--accent)] dark:hover:bg-[var(--accent-hover)] disabled:dark:bg-white/[0.08] disabled:dark:text-[var(--text-tertiary)]"
                    >
                      确认
                    </button>
                    <button
                      type="button"
                      onClick={cancelSavePreset}
                      className="h-9 flex-shrink-0 rounded-[var(--radius-field)] px-3 text-[length:var(--font-body)] text-[var(--text-secondary)] transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
                    >
                      取消
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {state.systemPromptPresets.length > 0 && (
              <div className="mt-4">
                <div className="mb-2 text-[length:var(--font-caption)] font-medium text-[var(--text-secondary)]">预设标签 · 点击应用</div>
                <div className="flex flex-wrap gap-1.5">
                  {state.systemPromptPresets.map((preset) => {
                    const selected = preset.prompt === state.chatConfig.systemPrompt;
                    return (
                      <span
                        key={preset.id}
                        className={`group/tag inline-flex max-w-full items-center gap-1 rounded-full border py-1 pl-2.5 pr-1 transition-colors ${
                          selected
                            ? 'border-[var(--accent)]/55 bg-[var(--accent-subtle)] text-[var(--accent)] hover:bg-[var(--accent-subtle)] dark:border-[var(--accent)]/35 dark:bg-[var(--accent-subtle)] dark:text-[var(--accent)]'
                            : 'border-[var(--border)] bg-black/[0.025] text-[var(--text-primary)] hover:border-black/20 hover:bg-black/[0.05] dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-[var(--text-primary)] dark:hover:bg-white/[0.07]'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => applyPresetPrompt(preset.prompt)}
                          className="max-w-[160px] truncate text-[length:var(--font-caption)]"
                          title={selected ? `当前使用：${preset.title}` : `${preset.title}：${preset.prompt}`}
                        >
                          {preset.title}
                        </button>
                        <button
                          type="button"
                          onClick={() => dispatch({ type: 'DELETE_SYSTEM_PROMPT_PRESET', payload: { presetId: preset.id } })}
                          aria-label={`删除标签 ${preset.title}`}
                          title="删除该标签"
                          className="grid h-5 w-5 flex-shrink-0 place-items-center rounded-full text-current opacity-40 transition-all hover:bg-[var(--state-danger-border)] hover:text-[var(--state-danger)] hover:opacity-100 group-hover/tag:opacity-70 dark:hover:bg-[var(--surface-raised)] dark:hover:text-[var(--state-danger)]"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <ChatNumberSetting
            label="温度"
            value={state.chatConfig.temperature}
            min={0}
            max={2}
            step={0.05}
            onChange={(value) => dispatch({ type: 'SET_CHAT_CONFIG', payload: { temperature: value } })}
          />
          <ChatNumberSetting
            label="Top P"
            value={state.chatConfig.topP}
            min={0.01}
            max={1}
            step={0.01}
            onChange={(value) => dispatch({ type: 'SET_CHAT_CONFIG', payload: { topP: value } })}
          />
          <ChatNumberSetting
            label="重复惩罚"
            value={state.chatConfig.repeatPenalty}
            min={1}
            max={2}
            step={0.01}
            onChange={(value) => dispatch({ type: 'SET_CHAT_CONFIG', payload: { repeatPenalty: value } })}
          />
          <ChatNumberSetting
            label="最大输出 Token（0 不限制）"
            value={state.chatConfig.maxTokens}
            min={0}
            max={8192}
            step={16}
            onChange={(value) => dispatch({ type: 'SET_CHAT_CONFIG', payload: { maxTokens: Math.round(value) } })}
          />
        </div>
      </div>
    </div>
  );
}
