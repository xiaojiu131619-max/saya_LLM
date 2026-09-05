import { useEffect, useState } from 'react';
import {
  ChevronRight,
  FolderPlus,
  FolderX,
  Globe2,
  Monitor,
  MonitorSmartphone,
  Moon,
  Palette,
  SlidersHorizontal,
  Sun,
} from 'lucide-react';
import { useApp } from '@/context/AppContext';
import ToggleSwitch from '@/components/ToggleSwitch';
import { SettingRow, SettingSection } from '@/components/SettingSection';
import PageHeader from '@/components/PageHeader';
import ExternalApiSection from '@/features/apiStatus/ExternalApiSection';
import type { ThemeMode } from '@/types';
import {
  addDesktopModelDir,
  clearModelRunRecords,
  getDesktopConfig,
  isDesktopRuntime,
  pickModelDirectory,
  removeDesktopModelDir,
  scanDesktopModels,
  setCloseToTray,
  setDesktopProxyUrl,
  toFrontendModel,
} from '@/lib/desktop';

// 主题模式三选段控件：浅色 / 深色 / 跟随系统。
function ThemeModeSelector({ value, onChange }: { value: ThemeMode; onChange: (mode: ThemeMode) => void }) {
  const options: Array<{ value: ThemeMode; label: string; icon: typeof Sun }> = [
    { value: 'light', label: '浅色', icon: Sun },
    { value: 'dark', label: '深色', icon: Moon },
    { value: 'system', label: '跟随系统', icon: MonitorSmartphone },
  ];
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-0.5 dark:border-white/[0.08] dark:bg-white/[0.04]">
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
            <Icon className="h-3.5 w-3.5" />
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export default function SettingsPage() {
  const { state, dispatch } = useApp();
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  // 软件代理（对核心更新检查/下载与 dsh 安装下载生效）。空 = 直连。
  const [proxyInput, setProxyInput] = useState('');
  const [proxyMessage, setProxyMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getDesktopConfig()
      .then((config) => {
        if (!cancelled && config) setProxyInput(config.proxy_url ?? '');
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshLocalModels = async () => {
    if (!isDesktopRuntime()) {
      setScanMessage('请在 Tauri 桌面版中使用本地模型扫描。');
      return;
    }

    setScanMessage('正在扫描 GGUF 模型...');
    try {
      const models = (await scanDesktopModels(true)).map(toFrontendModel);
      dispatch({ type: 'UPSERT_MODELS', payload: models });
      dispatch({ type: 'PRUNE_USAGE', payload: models.map((model) => model.id) });
      // 已删除模型的独立运行记录也一并清掉。
      const keepIds = new Set(models.map((model) => model.id));
      void Promise.all(
        Object.keys(state.usageByModel)
          .filter((id) => !keepIds.has(id) && !id.startsWith('api-'))
          .map((id) => clearModelRunRecords(id).catch(() => undefined)),
      );
      const message = models.length > 0 ? `已发现 ${models.length} 个本地 GGUF 模型。` : '没有发现 GGUF 文件。';
      dispatch({ type: 'SET_APP_STATUS', payload: message });
      setScanMessage(message);
    } catch (error) {
      setScanMessage(`扫描失败：${String(error)}`);
    }
  };

  const handleAddModelDir = async () => {
    if (!isDesktopRuntime()) {
      setScanMessage('请在 Tauri 桌面版中选择本地目录。');
      return;
    }

    const selected = await pickModelDirectory();
    if (!selected) return;

    const dirs = await addDesktopModelDir(selected);
    dispatch({ type: 'SET_MODEL_DIRS', payload: dirs });
    await refreshLocalModels();
  };

  const handleRemoveModelDir = async (dir: string) => {
    if (!isDesktopRuntime()) {
      setScanMessage('请在 Tauri 桌面版中管理本地目录。');
      return;
    }

    const dirs = await removeDesktopModelDir(dir);
    dispatch({ type: 'SET_MODEL_DIRS', payload: dirs });
    await refreshLocalModels();
  };

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
        ? '软件代理已保存，对核心更新检查/下载与 dsh 安装下载立即生效。'
        : '软件代理已清除，恢复直连。');
    } catch (error) {
      setProxyMessage(`软件代理保存失败：${String(error)}`);
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto mb-6 max-w-2xl">
          <PageHeader icon={SlidersHorizontal} title="软件设置" description="配置 Agent LLM 启动器和模型运行参数" />
        </div>

        <div className="mx-auto max-w-2xl pb-12">
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
          </SettingSection>

          <SettingSection title="本地模型运行" icon={FolderPlus} delay={0.05}>
            <SettingRow
              label="模型目录"
              description={state.modelDirs.length > 0 ? `已配置 ${state.modelDirs.length} 个模型目录` : '选择包含 .gguf 文件的本地目录'}
            >
              <button
                onClick={handleAddModelDir}
                className="flex min-h-9 items-center gap-1 rounded-md px-2 text-sm text-[var(--accent)] hover:bg-[var(--surface-muted)] dark:hover:bg-[var(--surface-raised)]"
              >
                选择目录 <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </SettingRow>
            {state.modelDirs.length > 0 && (
              <>
                <div className="border-t border-[var(--border-subtle)]" />
                <div className="space-y-2">
                  {state.modelDirs.map((dir) => (
                    <div key={dir} className="flex items-center justify-between gap-3 text-xs text-secondary-custom">
                      <span className="truncate">{dir}</span>
                      <button
                        onClick={() => void handleRemoveModelDir(dir)}
                        className="flex min-h-8 flex-shrink-0 items-center gap-1 rounded-md px-2 text-[var(--state-danger)] hover:bg-[var(--state-danger-border)] dark:hover:bg-[var(--surface-raised)]"
                      >
                        <FolderX className="w-3.5 h-3.5" />
                        移除
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
            {scanMessage && (
              <>
                <div className="border-t border-[var(--border-subtle)]" />
                <p className="text-xs text-secondary-custom">{scanMessage}</p>
              </>
            )}
          </SettingSection>

          <SettingSection title="对外 API" icon={Globe2} delay={0.1}>
            <ExternalApiSection embedded />
          </SettingSection>

          <SettingSection title="网络代理" icon={Globe2} delay={0.12}>
            <SettingRow
              label="软件代理"
              description="核心更新检查/下载与 dsh 安装下载不走系统代理；挂了梯子但下载仍慢时，填入本机代理端口（如 http://127.0.0.1:7890）。留空为直连。"
            >
              <div className="flex items-center gap-2">
                <input
                  value={proxyInput}
                  onChange={(event) => setProxyInput(event.target.value)}
                  placeholder="http://127.0.0.1:7890"
                  className="mono-font h-9 w-56 rounded-md border border-[var(--border)] bg-[var(--app-bg)] px-3 text-xs text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--accent)] dark:border-white/[0.08] dark:bg-black/20"
                  aria-label="软件代理地址"
                />
                <button
                  onClick={() => void handleSaveProxy()}
                  className="flex h-9 flex-shrink-0 items-center rounded-md bg-[var(--accent)] px-3 text-xs font-medium text-white transition-colors hover:bg-[var(--accent-hover)]"
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

          {/* 关于 */}
          <div className="border-b border-[var(--border-subtle)] py-6">
            <div className="text-center">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-lg bg-[var(--accent)]">
                <span className="text-xl font-bold text-white">L</span>
              </div>
              <h3 className="text-base font-semibold text-primary-custom mb-1">Agent LLM</h3>
              <p className="text-xs text-secondary-custom mb-3">v0.1.0 · 本地大模型管理启动器</p>
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
