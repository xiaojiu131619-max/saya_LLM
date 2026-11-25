import { createContext, useCallback, useContext, useEffect, useReducer, useRef, type ReactNode } from 'react';
import type { AppState, ThemeType } from '@/types';
import { getDesktopSystemAppearance, isDesktopRuntime, setDesktopWindowMaterial } from '@/lib/desktop';
import { autoTuneManager, ensureAutoTuneRuntime } from '@/lib/autoTuneRuntime';
import { DEMO_MODELS } from '@/lib/demoModels';
import type { Action } from './appState/appActions';
import { STORAGE_KEY, THEME_MANUAL_FLAG, forgetStoredModelPreferences } from './appState/appStorage';
import { createInitialState } from './appState/appDefaults';
import { appReducer } from './appState/appReducer';
import { suspendAppStatePersistence } from './appState/persistenceControl';
import { useDesktopEffects } from './appState/useDesktopEffects';
import { usePersistState } from './appState/usePersistState';

// ---- 公共 API（保持原 AppContext 导出不变，调用方无需改动）----
export { STORAGE_WARNING_EVENT, SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, clampSidebarWidth } from './appState/appStorage';
// 「清空本地数据」类操作若不走 RESET_ALL，可在刷新前调用它阻止 beforeunload 写回。
export { suspendAppStatePersistence } from './appState/persistenceControl';
export type { Action } from './appState/appActions';

/**
 * 把 hex 颜色朝白（amount > 0）或黑（amount < 0）线性混合。
 * 用于根据系统 accent 实时推算 hover/pressed/subtle 派生色。
 */
function mixAccent(hex: string, amount: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const target = amount > 0 ? 255 : 0;
  const t = Math.min(1, Math.abs(amount));
  const mix = (c: number) => Math.round(c + (target - c) * t);
  return `#${[mix(r), mix(g), mix(b)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

const initialState = createInitialState();

interface AppContextType { state: AppState; dispatch: React.Dispatch<Action>; }

const AppContext = createContext<AppContextType | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, baseDispatch] = useReducer(appReducer, initialState);
  const stateRef = useRef(state);

  /**
   * 包装 dispatch：用户手动改主题时打 localStorage 标记，
   * 之后 matchMedia 跟随系统的 effect 看到这个标记就不再覆盖用户选择。
   */
  const dispatch = useCallback((action: Action) => {
    if (action.type === 'RESET_ALL') {
      // 出厂重置：先暂停落盘并删除本地快照。刷新触发的 beforeunload 会用
      // 内存 state 重建快照并写回同一个 key，不在这里拦下就会「清了又回来」。
      suspendAppStatePersistence();
      try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* best-effort */ }
    }
    if (action.type === 'RESET_MODEL_PREFERENCES') {
      // 只删模型预设相关字段；对话记录、统计与界面偏好仍要正常保存。
      forgetStoredModelPreferences();
    }
    if (action.type === 'SET_THEME' || action.type === 'TOGGLE_THEME' || action.type === 'SET_THEME_MODE') {
      try { window.localStorage.setItem(THEME_MANUAL_FLAG, '1'); } catch { /* best-effort */ }
    }
    baseDispatch(action);
  }, []);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // 浏览器开发预览：`?demo=1` 注入示例模型，方便在没有 GGUF 的机器上检查卡片样式。
  // 桌面端不注入，真实模型列表不受影响。
  useEffect(() => {
    if (typeof window === 'undefined' || isDesktopRuntime()) return;
    if (new URLSearchParams(window.location.search).get('demo') !== '1') return;
    dispatch({ type: 'UPSERT_MODELS', payload: DEMO_MODELS });
    // UPSERT 会合并本地保存的分组主题色；示例数据要按脚本里的颜色展示，逐卡再定一次。
    for (const model of DEMO_MODELS) {
      dispatch({ type: 'SET_MODEL_THEME_COLOR', payload: { modelId: model.id, color: model.themeColorSolid } });
    }
    dispatch({ type: 'MARK_MODEL_RECENTLY_USED', payload: { modelId: 'demo-llama' } });
    dispatch({ type: 'REMEMBER_MODEL_LAUNCH_CONFIG', payload: { modelId: 'demo-qwen', config: DEMO_MODELS[0].loadConfig } });
  }, [dispatch]);

  useEffect(() => {
    autoTuneManager.setApplicationHandler((authorization, result) => {
      dispatch({ type: 'APPLY_AUTO_TUNE', payload: { authorization, result } });
    });
    void ensureAutoTuneRuntime().catch((error) => {
      dispatch({ type: 'SET_APP_STATUS', payload: `自动调参状态连接失败：${String(error)}` });
    });
    return () => autoTuneManager.setApplicationHandler(undefined);
  }, [dispatch]);

  useEffect(() => {
    const receipt = state.autoTuneApplication;
    if (receipt) autoTuneManager.reportApplication(receipt.runId, receipt.applied);
  }, [state.autoTuneApplication]);

  /**
   * 把 Rust 端读到的 Windows accent color 注入到 CSS 变量。
   *
   * 直接写 <html style="--accent: #xxx"> 比放在 React state 更稳——避免
   * "主题切换 → 整树 re-render"。同时按当前亮/暗算出 hover/pressed/subtle 派生色。
   * syncSystemAccent 关闭时移除内联覆盖，回落到 index.css 里的 Fluent 默认蓝。
   */
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement.style;
    if (!state.syncSystemAccent) {
      root.removeProperty('--accent');
      root.removeProperty('--accent-hover');
      root.removeProperty('--accent-pressed');
      root.removeProperty('--accent-subtle');
      return;
    }
    let cancelled = false;
    void (async () => {
      const appearance = await getDesktopSystemAppearance();
      if (cancelled || !appearance) return;
      const accent = appearance.accent_color;
      if (!accent || !/^#[0-9A-Fa-f]{6}$/.test(accent)) return;
      const dark = document.documentElement.classList.contains('dark');
      const hover = dark ? mixAccent(accent, 0.18) : mixAccent(accent, -0.12);
      const pressed = dark ? mixAccent(accent, 0.08) : mixAccent(accent, -0.22);
      const subtle = `${accent}26`; // ~15% alpha
      root.setProperty('--accent', accent);
      root.setProperty('--accent-hover', hover);
      root.setProperty('--accent-pressed', pressed);
      root.setProperty('--accent-subtle', subtle);
    })();
    return () => { cancelled = true; };
  }, [state.theme, state.syncSystemAccent]);

  /**
   * 跟随系统亮/暗：themeMode 为 system 时跟随 matchMedia，否则尊重用户显式选择。
   * - Tauri 桌面端 + 浏览器都启用，prefers-color-scheme 在 WebView2 上自动可用。
   * - 系统触发的切换直接走 baseDispatch，避免写 manual flag。
   */
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    if (state.themeMode !== 'system') return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = (e: MediaQueryListEvent | MediaQueryList) => {
      const dark = e.matches;
      const next: ThemeType = dark ? 'dark' : 'light';
      if (state.theme !== next) {
        // 直接调 baseDispatch，跳过 manual flag（这是系统不是用户）
        baseDispatch({ type: 'SET_THEME', payload: next });
      }
    };
    apply(mql);
    if (mql.addEventListener) {
      mql.addEventListener('change', apply);
      return () => mql.removeEventListener('change', apply);
    }
    mql.addListener(apply);
    return () => mql.removeListener(apply);
  }, [state.theme, state.themeMode]);

  /**
   * 毛玻璃模式：
   * - html.acrylic-mode 交给 CSS 铺一层可读的半透明霜化罩
   * - 桌面运行时把窗口从 Mica 切到系统 Acrylic，才能真正透出壁纸颜色变化
   * - html.tauri-desktop 用来关掉浏览器假壁纸，避免盖住系统材质
   */
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (isDesktopRuntime()) root.classList.add('tauri-desktop');
    root.classList.toggle('acrylic-mode', state.acrylicMode);
    if (!isDesktopRuntime()) return;
    void setDesktopWindowMaterial(state.acrylicMode ? 'acrylic' : 'mica');
  }, [state.acrylicMode]);

  /**
   * 减少动画：html.reduce-motion 让 CSS 过渡/动画瞬间完成（index.css 里有对应规则）；
   * framer-motion 侧由 App 根节点的 MotionConfig 读取同一开关，两边口径一致。
   */
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.classList.toggle('reduce-motion', state.reduceMotion);
  }, [state.reduceMotion]);

  /**
   * 字体缩放：只改根字号，token 与 Tailwind 的 rem 字号一起缩放，
   * 避免「令牌字号变了、text-sm 没变」的分裂。
   */
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.style.setProperty('--ui-font-scale', String(state.fontScale / 100));
  }, [state.fontScale]);

  // 桌面运行时集成：启动 hydrate、空闲自动卸载、server 事件、API 用量轮询。
  useDesktopEffects(state, stateRef, dispatch);
  // 全局状态防抖落盘（600ms + 页面隐藏/卸载立即写）。
  usePersistState(state);

  return <AppContext.Provider value={{ state, dispatch }}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used within AppProvider');
  return context;
}
