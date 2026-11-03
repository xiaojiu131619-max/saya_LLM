import { createRoot } from 'react-dom/client'
import './index.css'
import './workspace-design.css'
import App from './App.tsx'
import PiFloatApp from './pages/PiFloatApp.tsx'

/**
 * 入口分叉：`#/pi-float`（Pi 浮窗，宿主独立小窗加载）渲染轻量快聊视图，
 * 不挂主应用的完整工作区（AppContext / 会话存储都不需要）。
 */
const isFloatWindow =
  typeof window !== 'undefined' && window.location.hash.includes('pi-float')

createRoot(document.getElementById('root')!).render(
  isFloatWindow ? <PiFloatApp /> : <App />,
)
