import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  SessionTreeStore,
  mergeTouchedSettings,
  claimEscLayer,
  escLayerOpen,
  resetEscLayers
} from '../.build/harness.mjs'
import { tmpDirFactory } from '../harness/tmp.mjs'

/**
 * B5（性能与交互）守卫：N16 / N17 / N18 / N19 / N64 / N65 / N66 / N67 / N68 / N69 / N70 / N71。
 *
 * 分两类：
 * - **行为**用例：可直接执行的纯逻辑（设置合并、Esc 层计数、列表广播合流）；
 * - **静态**用例：只存在于渲染层 JSX / 组件结构里的约束（memo 化、折叠时不构造过程段、
 *   Esc 让行……）。这类约束没有编译期信号，只能从源码对账 —— 与
 *   `esc-guards` / `main-hardening` / `ipc-payload` 同一路子（本项目既有实践）。
 */

const ROOT = path.resolve(import.meta.dirname, '../..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// ———————————————————— N64：设置保存只回写本次 patch 的键 ————————————————————

test('N64 mergeTouchedSettings：未涉及的顶层字段保留本地现值（并发调用不互相抹除）', () => {
  const current = { theme: 'dark', scanStart: 2000, notify: { onGate: true } }
  // 另一次并发请求刚把 theme 改成 light，而本地已经写入了 scanStart=3000
  const returned = { theme: 'light', scanStart: 2000, notify: { onGate: true } }
  const next = mergeTouchedSettings(current, { scanStart: 3000 }, returned)

  assert.equal(next.scanStart, returned.scanStart, 'patch 涉及的键要采纳服务端返回值')
  assert.equal(next.theme, 'dark', '未涉及的键必须保留本地现值 —— 否则刚改的 theme 被旧响应抹掉')
  assert.deepEqual(next.notify, current.notify)
  assert.notEqual(next, current, '必须返回新对象（zustand 需要引用变化）')
  assert.equal(current.scanStart, 2000, '不得就地修改入参')
})

test('N64 mergeTouchedSettings：空 patch 等价于什么都不改', () => {
  const current = { theme: 'dark' }
  const next = mergeTouchedSettings(current, {}, { theme: 'light' })
  assert.equal(next.theme, 'dark')
})

// ———————————————————— N66：Esc 归属登记表 ————————————————————

test('N66 escLayers：认领/释放成对，深度不会为负，重复释放幂等', () => {
  resetEscLayers()
  assert.equal(escLayerOpen(), false, '没有浮层时 App 应当处理 Esc')

  const releaseA = claimEscLayer()
  const releaseB = claimEscLayer()
  assert.equal(escLayerOpen(), true)

  releaseA()
  assert.equal(escLayerOpen(), true, '还有一层认领时必须仍然让行（嵌套浮层）')

  releaseA() // 幂等：重复释放不重复扣减
  assert.equal(escLayerOpen(), true)

  releaseB()
  assert.equal(escLayerOpen(), false)

  releaseB()
  assert.equal(escLayerOpen(), false, '多释放不得把深度扣成负数（否则后续永远不让行）')
})

test('N66 App.tsx：agent:stop 分支必须先让行给认领了 Esc 的浮层', () => {
  const src = read('src/renderer/App.tsx')
  const start = src.indexOf("eff['agent:stop']")
  assert.ok(start >= 0, "未找到 agent:stop 分支（App.tsx 结构变了？）")
  const rest = src.slice(start)
  const end = rest.indexOf("eff['app:settings']")
  const block = end >= 0 ? rest.slice(0, end) : rest
  assert.match(
    block,
    /if \(escLayerOpen\(\)\) return/,
    '必须有 escLayerOpen() 让行 —— stopPropagation 拦不住同节点上先注册的 App 监听'
  )
})

test('N66 三个嵌套弹窗都认领了 Esc（模型编辑 / MCP 管理 / MCP 手动配置）', () => {
  for (const rel of [
    'src/renderer/features/settings/ModelEditorDialog.tsx',
    'src/renderer/features/agent/McpDialog.tsx',
    'src/renderer/features/agent/McpImportDialog.tsx'
  ]) {
    assert.match(read(rel), /useEscLayer\(/, `${rel} 必须用 useEscLayer 认领 Esc`)
  }
  // 认领后不得再自己挂一份监听，否则一次按键会关两层
  assert.doesNotMatch(
    read('src/renderer/features/settings/ModelEditorDialog.tsx'),
    /addEventListener\('keydown'/,
    'ModelEditorDialog 不应再自己注册 keydown'
  )
  // SettingsDialog 的兜底：内层认领时也要让行
  assert.match(
    read('src/renderer/features/settings/SettingsDialog.tsx'),
    /!escLayerOpen\(\)/,
    'SettingsDialog 的 Esc 兜底必须检查 escLayerOpen()'
  )
})

// ———————————————————— N16：折叠轮不重渲染 ————————————————————

test('N16 AgentPanel：折叠的轮不构造过程段，且回调引用稳定', () => {
  const src = read('src/renderer/features/agent/AgentPanel.tsx')

  assert.match(
    src,
    /const processNodes = folded\s*\n?\s*\? null\s*\n?\s*: turn\.body\.map/,
    '折叠的轮必须短路成 null —— 否则每个流式 delta 都白建 O(段数) 个元素对象'
  )
  assert.match(src, /const toggleTurn = useCallback\(/, 'toggleTurn 必须是稳定引用（否则透传后 memo 全废）')
  assert.doesNotMatch(
    src,
    /onToggleProcess=\{\(\) => toggleTurn\(/,
    '不得向 memo 组件传内联闭包（那是 memo 失效的直接原因）'
  )
})

test('N16 重渲染热点组件都 memo 化了（回答视图 / 收尾行 / 状态行 / 工具组 / 工具卡）', () => {
  const src = read('src/renderer/features/agent/AgentPanel.tsx')
  for (const name of [
    'FinalResponseView',
    'TurnCompleteBanner',
    'TurnStatusLine',
    'ToolGroup',
    'ToolCard'
  ]) {
    const re = new RegExp(`const ${name} = memo\\(`)
    assert.match(src, re, `${name} 应当 memo 化（流式期间历史轮不应重渲染）`)
  }
  // 回答视图里传给状态行的两个回调也必须是稳定引用
  assert.match(src, /const copyReply = useCallback\(/, 'copyReply 必须稳定，否则 TurnStatusLine 的 memo 白挂')
})

// ———————————————————— N18：会话切换竞态 ————————————————————

test('N18 dataActions：会话载入有请求序号，过期响应被丢弃', () => {
  const src = read('src/renderer/stores/dataActions.ts')
  assert.match(src, /let sessionLoadSeq = 0/, '必须有模块级请求序号')
  assert.match(src, /const seq = \+\+sessionLoadSeq/, '每次载入必须先取号')
  assert.match(src, /if \(seq !== sessionLoadSeq\) return false/, 'await 之后必须比对序号')
  // 三个入口都走同一入口（漏一个就还有一条竞态路径）
  for (const fn of ['continueFrom', 'openSession', 'resumeSession']) {
    const idx = src.indexOf(`async ${fn}(`)
    assert.ok(idx >= 0, `未找到 ${fn}`)
    const body = src.slice(idx, idx + 400)
    assert.match(body, /loadSessionView\(/, `${fn} 应复用 loadSessionView（统一竞态防护）`)
  }
})

// ———————————————————— N19：会话列表广播合流 ————————————————————

test('N19 SessionTreeStore：一个合流窗口内多次写入只广播一份列表', async () => {
  const makeTmp = tmpDirFactory('ensp-b5-tree-')
  const dir = makeTmp()
  const calls = []
  const store = new SessionTreeStore({ dir, onChange: (list) => calls.push(list) })

  const root = store.createRoot('测试会话')
  store.append(root.id, { id: 'n-a1', role: 'assistant', content: '一' })
  store.append(root.id, { id: 'n-u1', role: 'user', content: '二' })
  store.append(root.id, { id: 'n-a2', role: 'assistant', content: '三' })

  assert.equal(calls.length, 0, '合流窗口内不应立即广播（同步阶段零推送）')
  await new Promise((r) => setTimeout(r, 160))
  assert.equal(calls.length, 1, '四次写入只推一份 —— 否则长任务里每次 append 都整份推列表')
  assert.equal(calls[0].length, 1)
  assert.equal(calls[0][0].nodeCount, 4, '推送的必须是「最新那一份」')

  // 窗口关闭后再次写入 → 再推一份
  store.append(root.id, { id: 'n-a3', role: 'assistant', content: '四' })
  await new Promise((r) => setTimeout(r, 160))
  assert.equal(calls.length, 2)
  assert.equal(calls[1][0].nodeCount, 5)
})

// ———————————————————— N17 / N68 / N69 / N70 / N71：静态约束 ————————————————————

test('N17 变更时间线与轨迹面板都有首屏条数上限 + 「显示更多」', () => {
  const changes = read('src/renderer/features/changes/ChangeTimeline.tsx')
  assert.match(changes, /const PAGE_SIZE = \d+/, '变更时间线应有分页常量')
  assert.match(changes, /shown\.slice\(0, limit\)/, '应只渲染首屏切片')
  assert.match(changes, /显示更多（还有 \{hiddenCount\} 条）/, '必须给出「还有多少条」的明确出口')

  const trace = read('src/renderer/features/trace/TracePanel.tsx')
  assert.match(trace, /const TRACE_PAGE_SIZE = \d+/)
  assert.match(trace, /visibleSteps\.slice\(0, limit\)/)
  assert.match(trace, /显示更多（还有 \{hiddenSteps\} 步）/)
})

test('N68 autoLayout：对等网络布局不再用数组 includes 做成员判定', () => {
  const src = read('src/renderer/features/topology/autoLayout.ts')
  const idx = src.indexOf('function layoutPeerNetwork(')
  assert.ok(idx >= 0)
  const next = src.indexOf('\nfunction ', idx + 1)
  const body = src.slice(idx, next > 0 ? next : undefined)
  assert.doesNotMatch(
    body,
    /compNodeIds\.includes\(/,
    'BFS 双层循环里的 compNodeIds.includes 是 O(n²)，必须换 Set'
  )
  assert.match(body, /new Set\(compNodeIds\)/, 'layoutPeerNetwork 内应预建成员 Set')
})

test('N69 AdaptiveContainer：初始宽度在绘制前同步测量（useLayoutEffect）', () => {
  const src = read('src/renderer/components/AdaptiveContainer.tsx')
  assert.match(src, /useLayoutEffect\(\(\) => \{/, '首帧必须在绘制前量宽，否则档位会跳一下')
  assert.doesNotMatch(src, /\n  useEffect\(/, '不应再留着 useEffect 的惰性测量（会闪）')
})

test('N70 拓扑画布：手动新建连线的 edge type 与全局一致（topo）', () => {
  const src = read('src/renderer/features/topology/TopologyCanvas.tsx')
  assert.doesNotMatch(src, /type: 'smoothstep'/, "新建连线不得用 'smoothstep'")
  assert.match(src, /type: 'topo'/, "新建连线应与 toFlowEdges 一致用 'topo'")
})

test('N71 ShortcutsPanel：反馈条定时器可撤销（卸载即清）', () => {
  const src = read('src/renderer/features/settings/ShortcutsPanel.tsx')
  assert.match(src, /noticeTimer = useRef/, '必须有定时器 ref')
  assert.match(src, /window\.clearTimeout\(noticeTimer\.current\)/, '必须有 clearTimeout')
  assert.doesNotMatch(
    src,
    /setTimeout\(\(\) => setNotice\(null\)/,
    '不得再留裸 setTimeout（卸载后仍会 setState）'
  )
})

test('N67 App.tsx：设置快捷键的兜底值与默认表一致（不再悬空）', () => {
  const src = read('src/renderer/App.tsx')
  assert.doesNotMatch(src, /\[\s*'Ctrl',\s*','\s*\]/, "悬空兜底 ['Ctrl', ','] 必须删掉")
  assert.match(src, /DEFAULT_SHORTCUTS_MAP\['app:settings'\]/, '兜底应取默认表里的真实默认值')
})

test('N65 四处面板补齐 catch（SSH 删除 / eNSP 检测 / 扫描范围 / MCP 测试）', () => {
  assert.match(
    read('src/renderer/features/settings/SshConnectionsPanel.tsx'),
    /删除连接 .*失败/,
    'SSH 删除失败必须在面板里可见'
  )
  assert.match(
    read('src/renderer/features/settings/IntegrationSettings.tsx'),
    /自动检测失败/,
    'eNSP 自动检测失败必须可见'
  )
  assert.match(
    read('src/renderer/features/devices/DevicePanel.tsx'),
    /保存扫描范围失败/,
    '保存扫描范围失败必须可见'
  )
  assert.match(
    read('src/renderer/stores/agentActions.ts'),
    /测试 MCP 连接失败/,
    'MCP 测试连接失败必须可见'
  )
})
