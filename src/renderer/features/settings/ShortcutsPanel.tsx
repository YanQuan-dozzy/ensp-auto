import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useApp } from '@/stores/app'
import { IconSearch, IconClose, IconRotateCcw, IconTrash, IconKey } from '@/components/ui'
import {
  DEFAULT_SHORTCUTS,
  DEFAULT_SHORTCUTS_MAP,
  eventToKeys,
  formatKeys,
  isKeyEqual,
  type ShortcutItem
} from '../shortcuts/shortcutsData'

export function ShortcutsPanel(): ReactNode {
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  const setShortcutRecording = useApp((s) => s.setShortcutRecording)

  const customShortcuts = settings.shortcuts ?? {}

  const [query, setQuery] = useState('')
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // 监听按键录制
  useEffect(() => {
    if (!recordingId) return
    // R24：把「正在录制」提升为共享状态，让 App 的全局快捷键监听早退 ——
    // 两边都是 window 捕获阶段监听，而我们后注册，stopPropagation 拦不住 App
    setShortcutRecording(true)

    const onRecordKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()

      // 按 Esc 取消录制
      if (e.key === 'Escape' && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        setRecordingId(null)
        setNotice('已取消修改')
        setTimeout(() => setNotice(null), 2000)
        return
      }

      const keys = eventToKeys(e)
      if (!keys) {
        // 用户只按下了修饰键（如单独按 Ctrl），继续等待组合键
        return
      }

      // 检查是否与默认按键相同；相同则清除自定义覆盖
      const def = DEFAULT_SHORTCUTS_MAP[recordingId] ?? []
      const next = { ...(useApp.getState().settings.shortcuts ?? {}) }

      if (isKeyEqual(keys, def)) {
        delete next[recordingId]
      } else {
        next[recordingId] = keys
      }

      void updateSettings({ shortcuts: next })
      const targetItem = DEFAULT_SHORTCUTS.find((it) => it.id === recordingId)
      setNotice(`已将「${targetItem?.name ?? recordingId}」修改为 ${formatKeys(keys)}`)
      setTimeout(() => setNotice(null), 2500)
      setRecordingId(null)
    }

    window.addEventListener('keydown', onRecordKey, true)
    return () => {
      window.removeEventListener('keydown', onRecordKey, true)
      setShortcutRecording(false)
    }
  }, [recordingId, updateSettings, setShortcutRecording])

  // 过滤快捷键列表（支持命令名、描述、分类与按键文本搜索）
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return DEFAULT_SHORTCUTS
    return DEFAULT_SHORTCUTS.filter((it) => {
      const activeKeys = customShortcuts[it.id] ?? it.keys
      const keysStr = activeKeys.join('+').toLowerCase()
      return (
        it.name.toLowerCase().includes(q) ||
        it.desc.toLowerCase().includes(q) ||
        it.category.toLowerCase().includes(q) ||
        keysStr.includes(q) ||
        formatKeys(activeKeys).toLowerCase().includes(q)
      )
    })
  }, [query, customShortcuts])

  const handleResetAll = async (): Promise<void> => {
    await updateSettings({ shortcuts: {} })
    setNotice('已全部恢复默认按键绑定')
    setTimeout(() => setNotice(null), 2500)
  }

  const handleResetSingle = async (id: string): Promise<void> => {
    const next = { ...(settings.shortcuts ?? {}) }
    delete next[id]
    await updateSettings({ shortcuts: next })
    const targetItem = DEFAULT_SHORTCUTS.find((it) => it.id === id)
    setNotice(`已恢复「${targetItem?.name ?? id}」为默认按键`)
    setTimeout(() => setNotice(null), 2500)
  }

  return (
    <div className="shortcuts-panel">
      {/* 顶部搜索栏与全量恢复默认按钮 */}
      <div className="shortcuts-toolbar">
        <div className="shortcuts-search-wrap">
          <IconSearch size={14} className="shortcuts-search-icon" />
          <input
            type="text"
            className="shortcuts-search-input"
            placeholder="搜索快捷键"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query ? (
            <button
              className="btn ghost icon sm shortcuts-search-clear"
              onClick={() => setQuery('')}
              title="清空搜索"
            >
              <IconClose size={12} />
            </button>
          ) : null}
        </div>

        <button
          type="button"
          className="btn sm shortcuts-reset-btn"
          onClick={() => void handleResetAll()}
          title="将所有按键映射恢复为系统出厂预设"
        >
          <IconRotateCcw size={13} />
          全部恢复默认
        </button>
      </div>

      {notice ? <div className="banner info shortcuts-banner">{notice}</div> : null}

      {/* 快捷键表格列表 */}
      <div className="shortcuts-table-container">
        <table className="shortcuts-table">
          <thead>
            <tr>
              <th style={{ width: '40%' }}>命令</th>
              <th style={{ width: '18%' }}>分类</th>
              <th style={{ width: '30%' }}>按键绑定（点击可修改）</th>
              <th style={{ width: '12%', textAlign: 'center' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length > 0 ? (
              filtered.map((item: ShortcutItem) => {
                const isCustom =
                  customShortcuts[item.id] !== undefined &&
                  !isKeyEqual(customShortcuts[item.id]!, item.keys)
                const activeKeys = customShortcuts[item.id] ?? item.keys
                const isRecording = recordingId === item.id

                return (
                  <tr key={item.id} className="shortcut-row">
                    <td>
                      <div className="shortcut-cmd-name">
                        {item.name}
                        {isCustom ? <span className="shortcut-modified-badge">已修改</span> : null}
                      </div>
                      <div className="shortcut-cmd-desc">{item.desc}</div>
                    </td>
                    <td>
                      <span className="shortcut-category-tag">{item.category}</span>
                    </td>
                    <td>
                      {isRecording ? (
                        <div
                          className="shortcut-record-btn active"
                          onClick={() => setRecordingId(null)}
                          title="请按下新组合键，按 Esc 取消"
                        >
                          <span className="shortcut-pulse-dot" />
                          <span className="shortcut-recording-hint">请按下新快捷键 (Esc 取消)...</span>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className={`shortcut-record-btn${isCustom ? ' custom' : ''}`}
                          onClick={() => setRecordingId(item.id)}
                          title="点击修改按键绑定"
                        >
                          <div className="shortcut-badges-wrap">
                            {activeKeys.map((k, idx) => (
                              <span key={idx} className="shortcut-key-item">
                                {idx > 0 ? <span className="shortcut-key-plus">+</span> : null}
                                <kbd className="shortcut-kbd">{k}</kbd>
                              </span>
                            ))}
                          </div>
                          <IconKey size={12} className="shortcut-edit-icon" />
                        </button>
                      )}
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <button
                        type="button"
                        className="btn ghost icon sm shortcut-action-btn"
                        onClick={() => void handleResetSingle(item.id)}
                        disabled={!isCustom}
                        title={isCustom ? '恢复为该命令的默认按键' : '已是默认按键'}
                      >
                        <IconTrash size={14} />
                      </button>
                    </td>
                  </tr>
                )
              })
            ) : (
              <tr>
                <td colSpan={4} className="shortcuts-empty">
                  <div className="empty-content">未搜索到与「{query}」匹配的快捷键</div>
                  <button className="btn sm ghost" onClick={() => setQuery('')} style={{ marginTop: 8 }}>
                    清空搜索条件
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
