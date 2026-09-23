import { createRoot } from 'react-dom/client'
import './styles/global.css'
import './styles/app.css'
import { App } from './App'
import { useApp } from './stores/app'

// 不用 StrictMode：开发环境下的双次 effect 会让 xterm 实例被创建两次，
// 终端这类有副作用的组件不值得为它承担这个调试噪音。
const container = document.getElementById('root')
if (!container) throw new Error('找不到挂载点 #root')

// T3.5：未处理的 Promise 拒绝必须留下痕迹。
// 界面上的「按了没反应」大多源于某个被吞掉的 async 失败，
// 没有这条兜底就只能靠猜（而且用户不会打开 DevTools）。
window.addEventListener('unhandledrejection', (e) => {
  const reason: unknown = e.reason
  const message = reason instanceof Error ? reason.message : String(reason)
  console.error('[unhandledrejection]', reason)
  useApp.getState().noteSystemMessage(`出现未处理的错误：${message}`)
})

createRoot(container).render(<App />)
void useApp.getState().init().catch(() => {
  /* init 内部已捕获并写入 startupError，这里只是兜底防未处理拒绝 */
})
