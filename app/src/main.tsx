import { createRoot } from 'react-dom/client'
import './index.css'
import './workspace-design.css'
import App from './App.tsx'
import PiFloatApp from './pages/PiFloatApp.tsx'
import { normalizeFontScale } from './lib/uiScale'

// 首帧前先应用持久化的字体档位，避免 React 挂载后从 100% 跳到用户设置的大小。
try {
  const stored = JSON.parse(window.localStorage.getItem('agent-llm-local-state-v1') || '{}')
  const scale = normalizeFontScale(stored?.ui?.fontScale)
  document.documentElement.style.setProperty('--ui-font-scale', String(scale / 100))
} catch {
  // localStorage 不可用时保持默认 100%。
}

/**
 * 入口分叉：`#/pi-float`（Pi 浮窗，宿主独立小窗加载）渲染轻量快聊视图，
 * 不挂主应用的完整工作区（AppContext / 会话存储都不需要）。
 */
const isFloatWindow =
  typeof window !== 'undefined' && window.location.hash.includes('pi-float')

createRoot(document.getElementById('root')!).render(
  isFloatWindow ? <PiFloatApp /> : <App />,
)
