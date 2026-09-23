export interface ShortcutItem {
  id: string
  name: string
  desc: string
  category: '全局' | '工作台' | '导航' | 'AI 代理' | '终端'
  keys: string[]
  keyDisplay: string
  scope?: string
}

export const DEFAULT_SHORTCUTS: ShortcutItem[] = [
  {
    id: 'app:settings',
    name: '打开/关闭设置',
    desc: '快速呼出或关闭应用设置对话框',
    category: '全局',
    keys: ['Ctrl', ','],
    keyDisplay: 'Ctrl+,',
    scope: '全局'
  },
  {
    id: 'workbench:toggle-left',
    name: '切换设备列表',
    desc: '展开或折叠左侧设备树与发现栏',
    category: '工作台',
    keys: ['Ctrl', 'B'],
    keyDisplay: 'Ctrl+B',
    scope: '全局'
  },
  {
    id: 'workbench:toggle-right',
    name: '切换 AI 面板',
    desc: '展开或折叠右侧 AI 代理执行与会话面板',
    category: '工作台',
    keys: ['Ctrl', 'Shift', 'B'],
    keyDisplay: 'Ctrl+Shift+B',
    scope: '全局'
  },
  {
    id: 'nav:terminal',
    name: '切换到终端面板',
    desc: '切换主工作区为设备交互终端',
    category: '导航',
    keys: ['Ctrl', '1'],
    keyDisplay: 'Ctrl+1',
    scope: '全局'
  },
  {
    id: 'nav:topology',
    name: '切换到拓扑画布',
    desc: '切换主工作区为网络拓扑交互图',
    category: '导航',
    keys: ['Ctrl', '2'],
    keyDisplay: 'Ctrl+2',
    scope: '全局'
  },
  {
    id: 'nav:skills',
    name: '切换到技能管理',
    desc: '切换主工作区为技能库与提示词管理',
    category: '导航',
    keys: ['Ctrl', '3'],
    keyDisplay: 'Ctrl+3',
    scope: '全局'
  },
  {
    id: 'agent:new-session',
    name: '新建对话',
    desc: '新建空白会话并保留历史记录',
    category: 'AI 代理',
    keys: ['Ctrl', 'N'],
    keyDisplay: 'Ctrl+N',
    scope: '全局'
  },
  {
    id: 'agent:stop',
    name: '停止生成 / 取消',
    desc: '中断正在执行的 AI 代理或关闭当前浮层',
    category: 'AI 代理',
    keys: ['Esc'],
    keyDisplay: 'Esc',
    scope: '全局'
  },
  {
    id: 'agent:send',
    name: '发送消息',
    desc: '在 AI 指令输入框中提交任务',
    category: 'AI 代理',
    keys: ['Enter'],
    keyDisplay: 'Enter',
    scope: '输入框'
  },
  {
    id: 'agent:newline',
    name: '输入时换行',
    desc: '在输入框中换行而不发送',
    category: 'AI 代理',
    keys: ['Shift', 'Enter'],
    keyDisplay: 'Shift+Enter',
    scope: '输入框'
  },
  {
    id: 'window:maximize',
    name: '进入/退出最大化',
    desc: '最大化或向下还原工作台主窗口',
    category: '全局',
    keys: ['F11'],
    keyDisplay: 'F11',
    scope: '全局'
  },
  {
    id: 'terminal:clear',
    name: '清空当前终端',
    desc: '清屏并复位当前设备终端的滚动区',
    category: '终端',
    keys: ['Ctrl', 'K'],
    keyDisplay: 'Ctrl+K',
    scope: '终端面板'
  }
]

export const DEFAULT_SHORTCUTS_MAP: Record<string, string[]> = Object.fromEntries(
  DEFAULT_SHORTCUTS.map((s) => [s.id, s.keys])
)

/** 获取生效的按键映射列表（合并用户自定义与默认预设） */
export function getEffectiveShortcuts(
  customShortcuts?: Record<string, string[]>
): Record<string, string[]> {
  const map: Record<string, string[]> = { ...DEFAULT_SHORTCUTS_MAP }
  if (customShortcuts && typeof customShortcuts === 'object') {
    for (const [id, keys] of Object.entries(customShortcuts)) {
      if (Array.isArray(keys) && keys.length > 0) {
        map[id] = keys
      }
    }
  }
  return map
}

/** 将按键数组格式化为可读字符串（如 'Ctrl+Shift+B'） */
export function formatKeys(keys: string[]): string {
  return keys.join('+')
}

/** 比较两组按键是否完全一致 */
export function isKeyEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((k, idx) => k.toLowerCase() === b[idx]?.toLowerCase())
}

/** 判断键盘事件是否与指定的快捷键数组相匹配 */
export function matchesShortcut(e: KeyboardEvent, keys: string[]): boolean {
  if (!keys || keys.length === 0) return false

  const needCtrl = keys.includes('Ctrl')
  const needShift = keys.includes('Shift')
  const needAlt = keys.includes('Alt')
  const needCmd = keys.includes('Cmd') || keys.includes('Meta')

  const hasCtrl = e.ctrlKey || (!needCmd && e.metaKey)
  const hasShift = e.shiftKey
  const hasAlt = e.altKey

  if (needCtrl !== hasCtrl) return false
  if (needShift !== hasShift) return false
  if (needAlt !== hasAlt) return false

  const main = keys.find((k) => !['Ctrl', 'Shift', 'Alt', 'Cmd', 'Meta'].includes(k))
  if (!main) return false

  const upperMain = main.toUpperCase()
  const key = e.key
  const code = e.code

  if (upperMain === 'ESC' || upperMain === 'ESCAPE') {
    return key === 'Escape' || code === 'Escape'
  }
  if (upperMain === 'ENTER') {
    return key === 'Enter' || code === 'Enter'
  }
  if (main === ',') {
    return key === ',' || code === 'Comma'
  }
  if (main === '.') {
    return key === '.' || code === 'Period'
  }
  if (upperMain.startsWith('F') && /^F\d+$/i.test(upperMain)) {
    return key.toUpperCase() === upperMain || code.toUpperCase() === upperMain
  }
  if (main.length === 1 && main >= '0' && main <= '9') {
    return key === main || code === `Digit${main}` || code === `Numpad${main}`
  }
  if (main.length === 1 && /[a-zA-Z]/.test(main)) {
    return key.toLowerCase() === main.toLowerCase() || code === `Key${upperMain}`
  }

  return key.toLowerCase() === main.toLowerCase()
}

/** 从按键事件解析出格式化的快捷键数组（用于录制修改按键） */
export function eventToKeys(e: KeyboardEvent): string[] | null {
  // 忽略单按修饰键
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
    return null
  }

  const keys: string[] = []
  if (e.ctrlKey) keys.push('Ctrl')
  if (e.altKey) keys.push('Alt')
  if (e.shiftKey) keys.push('Shift')
  if (e.metaKey && !e.ctrlKey) keys.push('Cmd')

  let main = e.key
  if (e.key === 'Escape') main = 'Esc'
  else if (e.key === 'Enter') main = 'Enter'
  else if (e.key === ' ') main = 'Space'
  else if (e.key.length === 1) main = e.key.toUpperCase()

  // 必须包含非修饰键主体
  keys.push(main)
  return keys
}
