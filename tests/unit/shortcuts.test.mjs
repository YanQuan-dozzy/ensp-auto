import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_SHORTCUTS,
  DEFAULT_SHORTCUTS_MAP,
  getEffectiveShortcuts,
  formatKeys,
  isKeyEqual,
  matchesShortcut,
  eventToKeys
} from '../.build/harness.mjs'

test('快捷键清单：所有项具有唯一 ID 且字段完整', () => {
  assert.ok(Array.isArray(DEFAULT_SHORTCUTS))
  assert.ok(DEFAULT_SHORTCUTS.length >= 10)

  const ids = new Set()
  for (const it of DEFAULT_SHORTCUTS) {
    assert.ok(it.id, '必须具备 id')
    assert.ok(!ids.has(it.id), `ID 必须唯一：重复项 ${it.id}`)
    ids.add(it.id)

    assert.ok(it.name, `${it.id} 必须具备 name`)
    assert.ok(it.desc, `${it.id} 必须具备 desc`)
    assert.ok(it.category, `${it.id} 必须具备 category`)
    assert.ok(Array.isArray(it.keys) && it.keys.length > 0, `${it.id} 必须定义按键 keys`)
    assert.ok(it.keyDisplay, `${it.id} 必须具备 keyDisplay`)
  }
})

test('快捷键覆盖高频操作：设置、导航、侧栏、AI 对话与终端', () => {
  const byId = Object.fromEntries(DEFAULT_SHORTCUTS.map((s) => [s.id, s]))

  // 设置面板
  assert.equal(byId['app:settings']?.keyDisplay, 'Ctrl+,')

  // 工作台侧栏
  assert.equal(byId['workbench:toggle-left']?.keyDisplay, 'Ctrl+B')
  assert.equal(byId['workbench:toggle-right']?.keyDisplay, 'Ctrl+Shift+B')

  // 导航
  assert.equal(byId['nav:terminal']?.keyDisplay, 'Ctrl+1')
  assert.equal(byId['nav:topology']?.keyDisplay, 'Ctrl+2')
  assert.equal(byId['nav:skills']?.keyDisplay, 'Ctrl+3')

  // AI 代理
  assert.equal(byId['agent:new-session']?.keyDisplay, 'Ctrl+N')
  assert.equal(byId['agent:stop']?.keyDisplay, 'Esc')
  assert.equal(byId['agent:send']?.keyDisplay, 'Enter')
  assert.equal(byId['agent:newline']?.keyDisplay, 'Shift+Enter')

  // 全局与终端
  assert.equal(byId['window:maximize']?.keyDisplay, 'F11')
  assert.equal(byId['terminal:clear']?.keyDisplay, 'Ctrl+K')
})

test('自定义修改与生效合并：用户自定义按键覆盖默认预设', () => {
  // 无自定义时完全等于默认
  const base = getEffectiveShortcuts()
  assert.deepEqual(base['workbench:toggle-left'], ['Ctrl', 'B'])

  // 用户修改后
  const custom = {
    'workbench:toggle-left': ['Ctrl', 'Shift', 'L'],
    'app:settings': ['Ctrl', 'Alt', 'S']
  }
  const eff = getEffectiveShortcuts(custom)
  assert.deepEqual(eff['workbench:toggle-left'], ['Ctrl', 'Shift', 'L'])
  assert.deepEqual(eff['app:settings'], ['Ctrl', 'Alt', 'S'])
  // 未修改项仍保持默认
  assert.deepEqual(eff['nav:terminal'], ['Ctrl', '1'])
})

test('matchesShortcut：键盘事件与按键绑定精确比对', () => {
  // 匹配 Ctrl+B
  assert.ok(matchesShortcut({ ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, key: 'b', code: 'KeyB' }, ['Ctrl', 'B']))
  assert.ok(matchesShortcut({ ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, key: 'B', code: 'KeyB' }, ['Ctrl', 'B']))

  // Shift 状态不匹配应拒绝
  assert.equal(matchesShortcut({ ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, key: 'B', code: 'KeyB' }, ['Ctrl', 'B']), false)

  // 匹配 Ctrl+Shift+B
  assert.ok(matchesShortcut({ ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, key: 'B', code: 'KeyB' }, ['Ctrl', 'Shift', 'B']))

  // 匹配 Ctrl+,
  assert.ok(matchesShortcut({ ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, key: ',', code: 'Comma' }, ['Ctrl', ',']))

  // 匹配 F11
  assert.ok(matchesShortcut({ ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, key: 'F11', code: 'F11' }, ['F11']))

  // 匹配 Esc
  assert.ok(matchesShortcut({ ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, key: 'Escape', code: 'Escape' }, ['Esc']))
})

test('eventToKeys 与 formatKeys：按键解析与格式化', () => {
  // 单按修饰键应被过滤
  assert.equal(eventToKeys({ key: 'Control', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }), null)

  // 组合键 Ctrl+D
  const keys = eventToKeys({ key: 'd', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false })
  assert.deepEqual(keys, ['Ctrl', 'D'])
  assert.equal(formatKeys(keys), 'Ctrl+D')

  // 比对 isKeyEqual
  assert.ok(isKeyEqual(['Ctrl', 'b'], ['Ctrl', 'B']))
  assert.equal(isKeyEqual(['Ctrl', 'b'], ['Ctrl', 'Shift', 'B']), false)
})
