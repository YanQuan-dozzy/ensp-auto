import { createRoot } from 'react-dom/client'
import './styles/global.css'
import './styles/app.css'
import { App } from './App'
import { useApp } from './stores/app'

// 不用 StrictMode：开发环境下的双次 effect 会让 xterm 实例被创建两次，
// 终端这类有副作用的组件不值得为它承担这个调试噪音。
const container = document.getElementById('root')
if (!container) throw new Error('找不到挂载点 #root')

createRoot(container).render(<App />)
void useApp.getState().init().catch(() => {
  /* init 内部已捕获并写入 startupError，这里只是兜底防未处理拒绝 */
})
