import { useEffect, useState } from 'react';
import {
  ChevronRight,
  Database,
  FolderPlus,
  Globe2,
  Keyboard,
  Loader2,
  Monitor,
  MonitorSmartphone,
  Moon,
  Palette,
  SlidersHorizontal,
  Sun,
} from 'lucide-react';
import { useApp } from '@/context/AppContext';
import ToggleSwitch from '@/components/ToggleSwitch';
import BrandLogo from '@/components/BrandLogo';
import { SettingRow, SettingSection } from '@/components/SettingSection';
import PageHeader from '@/components/PageHeader';
import type { ThemeMode } from '@/types';
import {
  addDesktopModelDir,
  detectSystemProxy,
  getDesktopConfig,
  isDesktopRuntime,
  pickModelDirectory,
  scanDesktopModels,
  setCloseToTray,
  setDesktopProxyUrl,
  toFrontendModel,
} from '@/lib/desktop';
import { FONT_SCALE_LEVELS, fontScaleToIndex, normalizeFontScale } from '@/lib/uiScale';

/**
 * 通用分段选择器：2~3 个互斥选项。
 * 外观与 ThemeModeSelector 原先的内联实现保持一致，避免同页出现两套控件语言。
 */
function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: Array<{ value: T; label: string; icon?: typeof Sun }>;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="flex items-center gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-0.5 dark:border-white/[0.08] dark:bg-white/[0.04]"
    >
      {options.map((option) => {
        const Icon = option.icon;
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={active}
            className={`flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors ${
              active
                ? 'bg-[var(--surface)] text-[var(--accent)] shadow-sm dark:bg-[var(--surface-raised)] dark:text-[var(--accent)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] dark:text-[var(--text-secondary)] dark:hover:text-[var(--text-primary)]'
            }`}
          >
            {Icon && <Icon className="h-3.5 w-3.5" />}
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// 主题模式三选段控件：浅色 / 深色 / 跟随系统。
function ThemeModeSelector({ value, onChange }: { value: ThemeMode; onChange: (mode: ThemeMode) => void }) {
  return (
    <SegmentedControl
      value={value}
      ariaLabel="主题模式"
      onChange={onChange}
      options={[
        { value: 'light', label: '浅色', icon: Sun },
        { value: 'dark', label: '深色', icon: Moon },
        { value: 'system', label: '跟随系统', icon: MonitorSmartphone },
      ]}
    />
  );
}

export default function SettingsPage() {
  const { state, dispatch } = useApp();
  // 网络代理（对核心更新检查与下载生效）。空 = 直连。
  const [proxyInput, setProxyInput] = useState('');
  const [proxyMessage, setProxyMessage] = useState<string | null>(null);
  // 模型目录：设置页直接选择，免去先跳数据管理页再选目录。
  const [dirBusy, setDirBusy] = useState(false);
  const [dirMessage, setDirMessage] = useState<string | null>(null);
  // 字体档位：拖动只改草稿，点「确定」才真正应用，避免一边拖动一边整页跳字号。
  // null = 没有草稿，直接跟随已应用值；外部重置时也会自动回到当前值。
  const [fontScaleDraft, setFontScaleDraft] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getDesktopConfig()
      .then(async (config) => {
        if (cancelled || !config) return;
        const saved = (config.proxy_url ?? '').trim();
        if (saved) {
          setProxyInput(saved);
          return;
        }
        // 没有显式配置时，沿用 Windows 系统代理：用户已经在系统里挂好梯子，
        // 不该再让他在应用里重复填一遍端口。
        try {
          const detected = await detectSystemProxy();
          if (cancelled || !detected) return;
          setProxyInput(detected);
          await setDesktopProxyUrl(detected);
          if (!cancelled) setProxyMessage(`已自动读取并应用 Windows 系统代理：${detected}`);
        } catch {
          // 读不到系统代理就保持直连，不影响其它设置。
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCloseToTrayChange = async (enabled: boolean) => {
    dispatch({ type: 'SET_CLOSE_TO_TRAY', payload: enabled });
    if (!isDesktopRuntime()) return;
    try {
      await setCloseToTray(enabled);
    } catch {
      // 后端保存失败时保留界面状态，以 config.json 为准。
    }
  };

  const handleSaveProxy = async () => {
    const value = proxyInput.trim();
    try {
      await setDesktopProxyUrl(value || null);
      setProxyMessage(value
        ? '网络代理已保存，核心更新检查与下载会立即使用该代理。'
        : '已清空手动代理配置；下次启动会重新读取 Windows 系统代理。');
    } catch (error) {
      setProxyMessage(`网络代理保存失败：${String(error)}`);
    }
  };

  const handleUseSystemProxy = async () => {
    try {
      const detected = await detectSystemProxy();
      if (!detected) {
        setProxyMessage('没有检测到 Windows 系统代理（系统设置里未启用），当前为直连。');
        return;
      }
      setProxyInput(detected);
      await setDesktopProxyUrl(detected);
      setProxyMessage(`已应用系统代理：${detected}`);
    } catch (error) {
      setProxyMessage(`读取系统代理失败：${String(error)}`);
    }
  };

  // 字体滑块按档位索引移动；百分比始终取档位表，避免直接写 number 时出现刻度外值。
  const fontScaleDraftValue = fontScaleDraft ?? state.fontScale;
  const fontScaleIndex = fontScaleToIndex(fontScaleDraftValue);
  const fontScalePercent = FONT_SCALE_LEVELS[fontScaleIndex];
  const fontScaleDirty = fontScaleDraftValue !== state.fontScale;

  const handleFontScaleChange = (index: number) => {
    const next = FONT_SCALE_LEVELS[Math.min(FONT_SCALE_LEVELS.length - 1, Math.max(0, Math.round(index)))];
    setFontScaleDraft(normalizeFontScale(next));
  };

  const handleApplyFontScale = () => {
    dispatch({ type: 'SET_FONT_SCALE', payload: normalizeFontScale(fontScaleDraftValue) });
    setFontScaleDraft(null);
  };

  const handleAddModelDir = async () => {
    if (!isDesktopRuntime()) {
      setDirMessage('选择本地模型目录需要在桌面版中使用。');
      return;
    }
    const selected = await pickModelDirectory();
    if (!selected) return;
    setDirBusy(true);
    try {
      const dirs = await addDesktopModelDir(selected);
      dispatch({ type: 'SET_MODEL_DIRS', payload: dirs });
      const models = (await scanDesktopModels(true)).map(toFrontendModel);
      dispatch({ type: 'UPSERT_MODELS', payload: models });
      dispatch({ type: 'PRUNE_USAGE', payload: models.map((model) => model.id) });
      setDirMessage(models.length > 0
        ? `已添加目录并重新扫描，共发现 ${models.length} 个本地模型。`
        : '目录已添加，但暂未发现 GGUF 模型。');
    } catch (error) {
      setDirMessage(`添加模型目录失败：${String(error)}`);
    } finally {
      setDirBusy(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto mb-6 max-w-[1360px]">
          <PageHeader icon={SlidersHorizontal} title="软件设置" description="配置拾壹启动器和模型运行参数" />
        </div>

        <div className="mx-auto max-w-[1360px] pb-12">
        {/* 双列：左列是日常交互相关（外观 / 输入 / 窗口），右列是运行与维护（模型 / 代理 / 数据）。 */}
        <div className="grid items-start gap-x-8 lg:grid-cols-2">
          <div className="min-w-0">
          <SettingSection title="界面与外观" icon={Palette} delay={0}>
            <SettingRow
              label="主题模式"
              description={state.themeMode === 'system' ? '跟随 Windows 亮/暗设置自动切换' : `当前固定为${state.themeMode === 'dark' ? '深色' : '浅色'}主题`}
            >
              <ThemeModeSelector
                value={state.themeMode}
                onChange={(mode) => dispatch({ type: 'SET_THEME_MODE', payload: mode })}
              />
            </SettingRow>
            <div className="border-t border-[var(--border-subtle)]" />
            <SettingRow
              label="字体大小"
              description={`当前 ${state.fontScale}%；拖动后点「确定」生效，15 级调节，范围 75%–150%。`}
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <div className="w-36 flex-shrink-0">
                  <input
                    type="range"
                    min={0}
                    max={FONT_SCALE_LEVELS.length - 1}
                    step={1}
                    value={fontScaleIndex}
                    onChange={(event) => handleFontScaleChange(Number(event.target.value))}
                    aria-label="字体大小"
                    title={`字体大小：${fontScalePercent}%`}
                    className="ui-range w-full cursor-pointer"
                    style={{
                      background: `linear-gradient(to right, var(--accent) ${(fontScaleIndex / (FONT_SCALE_LEVELS.length - 1)) * 100}%, var(--surface-hover) ${(fontScaleIndex / (FONT_SCALE_LEVELS.length - 1)) * 100}%)`,
                    }}
                  />
                  <div className="mt-1 flex items-center justify-between text-[length:var(--font-micro)] text-[var(--text-tertiary)]">
                    <span>小</span>
                    <span>正常</span>
                    <span>大</span>
                  </div>
                </div>
                <span className="mono-font w-11 flex-shrink-0 text-right text-xs font-medium text-[var(--text-primary)]">
                  {fontScalePercent}%
                </span>
                <button
                  type="button"
                  onClick={handleApplyFontScale}
                  disabled={!fontScaleDirty}
                  className="flex h-8 flex-shrink-0 items-center rounded-md bg-[var(--accent)] px-3 text-xs font-medium text-[var(--text-on-accent)] transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  确定
                </button>
              </div>
            </SettingRow>
            <div className="border-t border-[var(--border-subtle)]" />
            <SettingRow
              label="自动同步系统主题色"
              description={state.syncSystemAccent ? '强调色跟随 Windows 个性化设置的主题色' : '使用 Fluent 默认蓝色作为强调色'}
            >
              <ToggleSwitch
                checked={state.syncSystemAccent}
                onChange={(v) => dispatch({ type: 'SET_SYNC_SYSTEM_ACCENT', payload: v })}
                label="自动同步系统主题色"
              />
            </SettingRow>
            <div className="border-t border-[var(--border-subtle)]" />
            <SettingRow
              label="毛玻璃效果"
              description={'开启后使用系统亚克力毛玻璃：能透出桌面壁纸的颜色变化，并保留一层半透明霜化，保证文字可读。系统开启「减少透明度」时自动退回不透明。'}
            >
              <ToggleSwitch
                checked={state.acrylicMode}
                onChange={(v) => dispatch({ type: 'SET_ACRYLIC_MODE', payload: v })}
                label="毛玻璃效果"
              />
            </SettingRow>
            <div className="border-t border-[var(--border-subtle)]" />
            <SettingRow
              label="减少动画"
              description="关闭界面过渡与入场动画，操作瞬间完成。适合晕动敏感或远程桌面场景；加载指示器仍会转动，不会让人误以为卡死。"
            >
              <ToggleSwitch
                checked={state.reduceMotion}
                onChange={(v) => dispatch({ type: 'SET_REDUCE_MOTION', payload: v })}
                label="减少动画"
              />
            </SettingRow>
          </SettingSection>

          <SettingSection title="对话与输入" icon={Keyboard} delay={0.03}>
            <SettingRow
              label="发送快捷键"
              description={state.enterToSend
                ? 'Enter 直接发送，Shift+Enter 换行。适合一问一答的短提示词。'
                : 'Enter 换行，Ctrl/⌘+Enter 发送。适合需要分段书写的长提示词。'}
            >
              <SegmentedControl
                value={state.enterToSend ? 'enter' : 'modifier'}
                ariaLabel="发送快捷键"
                onChange={(v) => dispatch({ type: 'SET_ENTER_TO_SEND', payload: v === 'enter' })}
                options={[
                  { value: 'enter', label: 'Enter 发送' },
                  { value: 'modifier', label: 'Ctrl+Enter 发送' },
                ]}
              />
            </SettingRow>
          </SettingSection>

          </div>

          <div className="min-w-0">
          <SettingSection title="本地模型运行" icon={FolderPlus} delay={0.05}>
            {/* 模型目录的增删与三个可配置目录统一收到「数据管理」页：
                这里只做只读摘要 + 跳转，避免同一件事在设置里有两套入口。 */}
            <SettingRow
              label="模型目录"
              description={state.modelDirs.length > 0
                ? `已配置 ${state.modelDirs.length} 个模型目录；可直接在此继续添加，增删详情在数据管理页。`
                : '尚未配置模型目录，点击「选择目录」添加包含 .gguf 文件的目录。'}
            >
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleAddModelDir()}
                  disabled={dirBusy}
                  className="flex min-h-9 items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 text-xs font-medium text-[var(--text-on-accent)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
                >
                  {dirBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderPlus className="h-3.5 w-3.5" />}
                  选择目录
                </button>
                <button
                  type="button"
                  onClick={() => dispatch({ type: 'SET_VIEW', payload: 'data' })}
                  className="flex min-h-9 items-center gap-1 rounded-md px-2 text-xs text-[var(--accent)] transition-colors hover:bg-[var(--surface-muted)] dark:hover:bg-[var(--surface-raised)]"
                >
                  数据管理 <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </SettingRow>
            {dirMessage && (
              <p className="break-words text-xs text-secondary-custom">{dirMessage}</p>
            )}
            {state.modelDirs.length > 0 && (
              <>
                <div className="border-t border-[var(--border-subtle)]" />
                <div className="space-y-1">
                  {state.modelDirs.map((dir) => (
                    <div key={dir} className="truncate rounded-md bg-[var(--surface-muted)] px-2.5 py-1.5 text-xs text-[var(--text-secondary)]" title={dir}>
                      {dir}
                    </div>
                  ))}
                </div>
              </>
            )}
          </SettingSection>

          <SettingSection title="网络代理" icon={Globe2} delay={0.12}>
            <SettingRow
              label="网络代理"
              description="默认自动读取 Windows 系统代理；手动填写后优先使用填入的地址。留空保存会清空手动配置，下次启动仍按系统代理读取。"
            >
              <div className="flex items-center gap-2">
                <input
                  value={proxyInput}
                  onChange={(event) => setProxyInput(event.target.value)}
                  placeholder="http://127.0.0.1:7890"
                  className="mono-font h-9 w-56 rounded-md border border-[var(--border)] bg-[var(--app-bg)] px-3 text-xs text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--accent)] dark:border-white/[0.08] dark:bg-black/20"
                  aria-label="网络代理地址"
                />
                <button
                  type="button"
                  onClick={() => void handleUseSystemProxy()}
                  className="flex h-9 flex-shrink-0 items-center rounded-md border border-[var(--border)] px-3 text-xs font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--accent)]"
                >
                  读取系统代理
                </button>
                <button
                  onClick={() => void handleSaveProxy()}
                  className="flex h-9 flex-shrink-0 items-center rounded-md bg-[var(--accent)] px-3 text-xs font-medium text-[var(--text-on-accent)] transition-colors hover:bg-[var(--accent-hover)]"
                >
                  保存
                </button>
              </div>
            </SettingRow>
            {proxyMessage && (
              <p className="break-words text-xs text-secondary-custom">{proxyMessage}</p>
            )}
          </SettingSection>

          <SettingSection title="窗口与托盘" icon={Monitor} delay={0.14}>
            <SettingRow
              label="托盘模式"
              description={state.closeToTray ? '关闭窗口时隐藏到系统托盘，后台保持运行' : '关闭窗口时直接退出应用'}
            >
              <ToggleSwitch
                checked={state.closeToTray}
                onChange={(v) => void handleCloseToTrayChange(v)}
                label="托盘模式"
              />
            </SettingRow>
          </SettingSection>

          <SettingSection title="数据与维护" icon={Database} delay={0.16}>
            {/* 清除与重置类动作全部收进「数据管理」页（对话/统计/缓存/配置/出厂重置），
                这里只保留一个跳转入口，避免两处各有一套按钮。 */}
            <SettingRow
              label="数据管理"
              description="模型目录、引擎目录、日志目录、归档目录，以及对话历史/使用统计/缓存的清除与出厂重置。"
            >
              <button
                type="button"
                onClick={() => dispatch({ type: 'SET_VIEW', payload: 'data' })}
                className="flex min-h-9 items-center gap-1 rounded-md px-2 text-sm text-[var(--accent)] transition-colors hover:bg-[var(--surface-muted)] dark:hover:bg-[var(--surface-raised)]"
              >
                前往数据管理 <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </SettingRow>
            <div className="border-t border-[var(--border-subtle)]" />
            <SettingRow
              label="核心更新"
              description="检查 llama.cpp 内核与运行组件的可用版本，并管理下载。"
            >
              <button
                type="button"
                onClick={() => dispatch({ type: 'SET_VIEW', payload: 'kernel' })}
                className="flex min-h-9 items-center gap-1 rounded-md px-2 text-sm text-[var(--accent)] transition-colors hover:bg-[var(--surface-muted)] dark:hover:bg-[var(--surface-raised)]"
              >
                前往更新 <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </SettingRow>
          </SettingSection>
          </div>
        </div>

          {/* 关于 */}
          <div className="border-b border-[var(--border-subtle)] py-6">
            <div className="text-center">
              <div className="mx-auto mb-3">
                <BrandLogo size={44} variant="mark" />
              </div>
              <h3 className="text-base font-semibold text-primary-custom mb-1">拾壹</h3>
              <p className="text-xs text-secondary-custom mb-3">v{__APP_VERSION__} · 本地大模型管理启动器</p>
              <div className="flex items-center justify-center gap-4 text-xs text-secondary-custom">
                <span>React 19</span>
                <span>·</span>
                <span>Tailwind CSS</span>
                <span>·</span>
                <span>llama.cpp</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
