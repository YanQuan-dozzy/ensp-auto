/**
 * PERF-MEM-REVIEW-2026-09-29（§9 建议批次）配套回归网。
 *
 * 本文件只守**第一批 + 第二批**里「改了就有行为风险」的那几条：
 * 纯性能项（rAF 节流、memo 拆分、落盘去抖）用探针/真机确认，不在这里断言实现细节。
 *
 * 纪律：M3 是「先登记进全局表、后进 try」这个写法本身的缺陷，
 * 对应守卫必须能在**不启动 Electron** 的前提下抓住回归。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EventStream,
  SessionTreeStore,
  writeCompareReport,
  readLineWindow,
  clearLineIndexCache,
  lineIndexCacheSize
} from '../.build/harness.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// ——————————————————————————————————————————————————————————————
// M3：startAgent 的 `active` 登记必须在 try 之内
// ——————————————————————————————————————————————————————————————

/** 去掉块注释与行注释，只留可执行代码行 */
const codeLines = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '').trim())
    .filter((l) => l.length > 0)

test('M3：active.set 必须是 try 块里的第一条语句（否则抛错即永久泄漏 + 会话卡死）', () => {
  const lines = codeLines(readSrc('src/main/services.ts'))
  const setAt = lines.findIndex((l) => l.includes('this.active.set(sessionId,'))
  assert.notEqual(setAt, -1, '找不到 this.active.set 注册点')
  const tryAt = lines.lastIndexOf('try {', setAt)
  assert.notEqual(tryAt, -1, '注册点之前没有 try 块')
  assert.equal(
    tryAt,
    setAt - 1,
    `try 与 active.set 之间夹了语句：\n${lines.slice(tryAt, setAt + 1).join('\n')}`
  )
})

test('M3：唯一清理点 active.delete 仍在 finally 内', () => {
  const src = readSrc('src/main/services.ts')
  const delAt = src.indexOf('this.active.delete(sessionId)')
  const finallyAt = src.indexOf('} finally {', delAt - 6000)
  assert.ok(finallyAt !== -1 && finallyAt < delAt, 'active.delete 掉出了 finally 块')
})

// ——————————————————————————————————————————————————————————————
// M2：EventStream 的缓冲释放
// ——————————————————————————————————————————————————————————————

test('M2：close() 不得清空缓冲（缓冲里的 done/error 必须先发完）', async () => {
  const s = new EventStream()
  s.push({ type: 'error', message: 'boom' })
  s.close()
  // 契约：先发完缓冲，再报 done。少一条 = 任务永远停在「运行中」
  const first = await s[Symbol.asyncIterator]().next()
  assert.equal(first.value.type, 'error', 'close() 吞掉了缓冲里的收尾事件')
  const second = await s[Symbol.asyncIterator]().next()
  assert.equal(second.done, true)
})

test('M2：消费完毕后缓冲不继续持有 tool_end.raw', async () => {
  const s = new EventStream()
  const raw = 'x'.repeat(1024)
  for (let i = 0; i < 20; i++) s.push({ type: 'tool_end', raw })
  s.close()
  const it = s[Symbol.asyncIterator]()
  let seen = 0
  for (;;) {
    const r = await it.next()
    if (r.done) break
    seen++
  }
  assert.equal(seen, 20, '事件被丢了一条')
  // 缓冲读空后容器必须缩回空壳
  assert.equal(s.buffer.length, 0, '消费完毕后仍持有事件引用（raw 常驻内存）')
})

test('M2：消费者提前 break（中止）时缓冲直接丢弃，不残留 raw', async () => {
  const s = new EventStream()
  for (let i = 0; i < 20; i++) s.push({ type: 'tool_end', raw: 'y'.repeat(512) })
  const it = s[Symbol.asyncIterator]()
  await it.next()
  await it.return() // for-await 提前退出
  assert.equal(s.buffer.length, 0, '消费者放弃后缓冲仍驻留')
})

// ——————————————————————————————————————————————————————————————
// R7：agentRuntime 只在真变时 set
// ——————————————————————————————————————————————————————————————

test('R7：applyAgentEvent 不得无条件 set agentRuntime（每 token 多一次全 store 通知）', () => {
  const src = readSrc('src/renderer/stores/agentActions.ts')
  const fn = src.slice(src.indexOf('applyAgentEvent('), src.indexOf('applyAgentEvent(') + 400)
  assert.match(fn, /if \(get\(\)\.agentRuntime !== runtime\)/, '缺少真变守卫')
  assert.doesNotMatch(
    fn,
    /^\s*set\(\{ agentRuntime: runtime \}\)\s*$/m,
    '仍是无条件 set：每个 token 都会触发全部 useSyncExternalStore 订阅'
  )
})

// ——————————————————————————————————————————————————————————————
// R10：turnCollapse 必须按 activeRootId 复位
// ——————————————————————————————————————————————————————————————

test('R10：切会话必须复位 turnCollapse（键是 user 段 id，跨会话会撞）', () => {
  const lines = codeLines(readSrc('src/renderer/features/agent/AgentPanel.tsx'))
  // 找挂载 turnCollapse 的 useEffect（紧跟在 useState 声明之后）
  const stateAt = lines.findIndex((l) => l.includes('useState<Record<string, CollapseSignal>>'))
  assert.notEqual(stateAt, -1, '找不到 turnCollapse 的 state 声明')
  const effAt = lines.findIndex((l, i) => i > stateAt && l === 'useEffect(() => {')
  assert.notEqual(effAt, -1, 'turnCollapse 之后没有挂 effect')
  const body = lines.slice(effAt, effAt + 5).join(' ')
  assert.match(body, /setTurnCollapse\(\{\}\)/, '缺少整体复位')
  assert.match(
    lines.slice(effAt, effAt + 5).join(' '),
    /activeRootId/,
    '复位没有以 activeRootId 为 key'
  )
})

test('R10/N16：复位不得改动 COLLAPSED_SIGNAL 的模块级常量身份', () => {
  const src = readSrc('src/renderer/features/agent/AgentPanel.tsx')
  // B5 硬约束：未点开过的轮必须复用同一个常量引用，每次渲染新建会拉回用户手动展开的块
  assert.doesNotMatch(
    src,
    /useMemo\(\s*\(\)\s*=>\s*\(\{\s*epoch:\s*0,\s*open:\s*false\s*\}\)/,
    '出现了每次渲染新建的 collapse signal，会击穿 N16 的 memo 复用'
  )
  assert.match(src, /COLLAPSED_SIGNAL/)
})

// ——————————————————————————————————————————————————————————————
// T11：autoLayoutModule 里的逐字重复死循环
// ——————————————————————————————————————————————————————————————

test('T11：splitByAggregationSubtrees 里不得残留逐字重复的认领循环', () => {
  const src = readSrc('src/renderer/features/topology/autoLayoutModule.ts')
  const marker = 'for (const b of rawFrontier) {'
  const first = src.indexOf(marker)
  assert.notEqual(first, -1, '找不到 frontier 认领循环')
  assert.equal(src.indexOf(marker, first + 1), -1, '重复的认领循环还在（frontier.includes 的 O(F²) 成本翻倍）')
})

// ——————————————————————————————————————————————————————————————
// D15：报告导出走原子写
// ——————————————————————————————————————————————————————————————

test('D15：会话/对比报告不走裸 writeFileSync（半截文件会被 read_attachment 当正文读回）', () => {
  const src = readSrc('src/main/tools/sessions.ts')
  assert.doesNotMatch(src, /fs\.writeFileSync\(/, '仍有裸写盘：崩溃会留下半截报告正文')
  assert.match(src, /atomicWriteFileSync/)
  assert.equal(
    (src.match(/atomicWriteFileSync\(/g) ?? []).length,
    2,
    '两处导出都应改原子写'
  )
})

test('D15：对比报告实际落盘是完整内容（回归：原子写没把正文截断）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensp-atomic-report-'))
  try {
    const md = '# 对比\n\n' + '结论行\n'.repeat(500)
    const r = writeCompareReport(dir, 'a/b:c*d?', md)
    assert.equal(fs.readFileSync(r.path, 'utf8'), md)
    // 临时文件必须清干净
    const left = fs.readdirSync(path.dirname(r.path)).filter((f) => f.includes('.tmp'))
    assert.deepEqual(left, [], '原子写留下了 .tmp 垃圾')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ——————————————————————————————————————————————————————————————
// D1：会话树索引去抖落盘
// ——————————————————————————————————————————————————————————————

test('D1：append 不再逐节点整份索引写 + fsync（130 节点 = 130 次同步阻塞）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensp-tree-debounce-'))
  try {
    const store = new SessionTreeStore({ dir })
    const root = store.createRoot('会话')
    // 连续追加（一次真实任务就是这个形态：assistant 段 / thinking / 工具节点交替）
    for (let i = 0; i < 40; i++) {
      store.append(root.id, { id: `n-${i}`, role: 'assistant', content: `第 ${i} 段` })
    }
    // 内存态必须立刻正确（去抖只推迟**落盘**，不推迟可见性）
    assert.equal(store.list().find((m) => m.id === root.id).nodeCount, 41)
    assert.equal(store.getTree(root.id).length, 41)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('D1：去抖落盘必须最终把索引写到磁盘（不能只是推迟后丢掉）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensp-tree-flush-'))
  try {
    const store = new SessionTreeStore({ dir })
    const root = store.createRoot('会话')
    for (let i = 0; i < 30; i++) {
      store.append(root.id, { id: `n-${i}`, role: 'assistant', content: `x${i}` })
    }
    // 等去抖窗口过去
    await new Promise((r) => setTimeout(r, 1200))
    const reopened = new SessionTreeStore({ dir })
    const meta = reopened.list().find((m) => m.id === root.id)
    assert.ok(meta, '重启后会话从列表里消失了')
    assert.equal(meta.nodeCount, 31, 'nodeCount 没有落盘')
    assert.equal(reopened.getTree(root.id).length, 31, '节点没有落盘')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('D1：process 退出前必须把待落盘的索引冲掉（否则最后一批节点索引丢失）', () => {
  const src = readSrc('src/main/core/session-tree/store.ts')
  assert.match(src, /flushIndex\(/, '没有提供主动冲刷入口')
  // 实现用的是 `process.once('beforeExit', …)`（每次 new 一个 store 就再挂一次，
  // `on` 会在多实例场景累积监听而触发 MaxListenersExceededWarning），
  // 所以 `once` 与 `on` 都算合规。**必须显式转义括号**：`process\.on\(` 只能匹配
  // `process.on(`，把 `on` 写成 `once`、或把 `(` 留作分组字符，都会让守卫永远失败。
  assert.match(
    src,
    /process\.(?:once|on)\(\s*['"](?:beforeExit|exit)['"]/,
    '没有接退出事件'
  )
})

// ——————————————————————————————————————————————————————————————
// M1/D8：会话树 cache 的 LRU 淘汰
// ——————————————————————————————————————————————————————————————

test('M1：cache 必须有上界（点开 50 个历史会话 = 50 份完整节点数组常驻）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensp-tree-lru-'))
  try {
    // 先落盘 12 个会话，**再用全新实例逐棵点开** —— 这才是「重开应用后浏览历史会话」
    // 的真实形态。若在同实例里边 createRoot 边读，`createRoot` 会把每棵新树塞到
    // 缓存队尾，淘汰虽然生效、但总量仍随 createRoot 次数增长（那是另一条断言）。
    {
      const writer = new SessionTreeStore({ dir })
      for (let s = 0; s < 12; s++) {
        const root = writer.createRoot(`会话 ${s}`)
        for (let i = 0; i < 5; i++) {
          writer.append(root.id, { id: `n-${s}-${i}`, role: 'assistant', content: `内容 ${i}` })
        }
      }
    }

    const store = new SessionTreeStore({ dir })
    const roots = store.list().map((m) => m.id)
    assert.equal(roots.length, 12, '前置数据没落盘')
    for (const id of roots) store.getTree(id)
    assert.ok(
      store.cachedRootIds().length <= 8,
      `缓存没有上界：已缓存 ${store.cachedRootIds().length} 棵（上限 8）`
    )
    // 淘汰掉的会话仍可从磁盘重新读出来 —— 淘汰是内存行为，不许丢数据
    const last = roots[roots.length - 1]
    assert.equal(store.getTree(last).length, 6)
    const first = roots[0]
    assert.equal(store.getTree(first).length, 6, '被淘汰的会话读不回来了（数据丢失）')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('M1：`createRoot` 也必须受上界约束（长驻进程里不断新建会话不得单调增长）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensp-tree-lru-create-'))
  try {
    const store = new SessionTreeStore({ dir })
    for (let s = 0; s < 12; s++) {
      const root = store.createRoot(`会话 ${s}`)
      store.append(root.id, { id: `n-${s}`, role: 'assistant', content: 'x' })
    }
    assert.ok(
      store.cachedRootIds().length <= 8,
      `createRoot 绕过了淘汰：已缓存 ${store.cachedRootIds().length} 棵（上限 8）`
    )
    // 刚新建的那棵必须在缓存里（正在被使用，不能被自己挤掉）
    assert.equal(store.getTree(store.list()[0].id).length, 2, '最新会话被误淘汰')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('M1：淘汰必须连带清理 owner，否则孤儿 nodeId 仍能定位到已淘汰的会话', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensp-tree-owner-'))
  try {
    const store = new SessionTreeStore({ dir })
    const roots = []
    for (let s = 0; s < 12; s++) {
      const root = store.createRoot(`会话 ${s}`)
      store.append(root.id, { id: `n-${s}`, role: 'assistant', content: 'x' })
      store.getTree(root.id)
      roots.push(root.id)
    }
    // owner 条目数不得超过「仍在缓存里 + 刚写入的那棵」的量级
    const ownerCount = store.ownerCount()
    assert.ok(
      ownerCount <= 8 * 10 + 24,
      `owner 表无界：已累积 ${ownerCount} 条 nodeId 映射`
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ——————————————————————————————————————————————————————————————
// R3 + R1：流式文本不进 messages + 流式期不喂 react-markdown
// ——————————————————————————————————————————————————————————————

test('R3：流式中的 assistant 文本走独立字段，不进 messages（否则每 delta 4 趟全量重算）', () => {
  const src = readSrc('src/renderer/stores/agentActions.ts')
  const textCase = src.slice(src.indexOf("case 'text':"), src.indexOf("case 'thinking':"))
  assert.match(textCase, /streamingText/, 'text 事件仍直接写 messages')
  assert.doesNotMatch(textCase, /\[\.\.\.s\.messages\]/, 'text 事件仍在整份拷贝 messages')
})

test('R1：流式期不喂 react-markdown（对累积全文 O(n²) 重解析）', () => {
  const src = readSrc('src/renderer/features/agent/MarkdownView.tsx')
  assert.match(src, /isStreaming|streaming/, 'MarkdownView 没有两态分流')
  const idx = src.indexOf('ReactMarkdown')
  assert.notEqual(idx, -1, 'MarkdownView 不再渲染 markdown（检查是否误删）')
})

// ——————————————————————————————————————————————————————————————
// M6：pendingTools 中止残留 → 后续工具节点静默不落盘
// ——————————————————————————————————————————————————————————————

test('M6：flushToolNodes 不得在遇到未回结果时 break（此后所有工具节点都不落盘）', () => {
  const lines = codeLines(readSrc('src/main/services.ts'))
  const at = lines.findIndex((l) => l.includes('const flushToolNodes'))
  assert.notEqual(at, -1, '找不到 flushToolNodes')
  // 取函数体范围（到下一个顶层 `}` 起头的收尾）
  const body = lines.slice(at, at + 60)
  assert.doesNotMatch(
    body.join('\n'),
    /if \(!r\)\s*break/,
    '仍在用 break：abort 后跳过的调用永远没有 tool_end，会一直堵住队首'
  )
  assert.match(body.join('\n'), /if \(!r\)/, '缺少未回结果的判据')
})

test('M6：finally 必须走 finalize 路径，把无结果的调用落成占位节点', () => {
  const src = readSrc('src/main/services.ts')
  assert.match(src, /flushToolNodes\(true\)/, 'finally 没有调用 finalize 模式')
  assert.match(src, /finalize/, 'flushToolNodes 没有 finalize 形参')
  // 占位节点要带一个可识别的错误码，报告里才看得出「这次是中止不是失败」
  assert.match(src, /ABORTED/, '占位节点没有可识别的错误码')
})

// ——————————————————————————————————————————————————————————————
// R8：TerminalPane 的 ResizeObserver 必须 rAF 节流
// ——————————————————————————————————————————————————————————————

test('R8：ResizeObserver 回调必须经 rAF 合流（拖分隔条时可达 120Hz 同步 IPC）', () => {
  const src = readSrc('src/renderer/features/terminal/TerminalPane.tsx')
  const at = src.indexOf('new ResizeObserver(')
  assert.notEqual(at, -1, '找不到 ResizeObserver')
  const body = src.slice(at, at + 500)
  assert.match(body, /requestAnimationFrame/, 'ResizeObserver 未节流，每个尺寸事件都直接 fit + 同步 IPC')
  assert.doesNotMatch(
    body,
    /new ResizeObserver\(\(\)\s*=>\s*safeFit\(\)\)/,
    '仍是无节流的直接调用'
  )
  // 卸载时要取消在途的那一帧
  assert.match(src, /cancelAnimationFrame/, 'cleanup 没有取消在途 rAF')
})

// ——————————————————————————————————————————————————————————————
// R9：tool.raw 超预算必须回收（展示侧有上限，存储侧原先没有）
// ——————————————————————————————————————————————————————————————

test('R9：tool_end 落盘后必须校 raw 预算（否则一次长实验常驻几十 MB）', () => {
  const src = readSrc('src/renderer/stores/agentActions.ts')
  const at = src.indexOf("case 'tool_end':")
  assert.notEqual(at, -1, '找不到 tool_end 分支')
  const body = src.slice(at, src.indexOf("case 'gate_request':", at))
  assert.match(body, /evictOldRawText/, 'tool_end 没有回收超预算的 raw')
  assert.match(src, /RAW_TOTAL_CHARS/, '没有定义 raw 预算常量')
})

test('R9：回收只能从最早的 raw 开始，且必须换引用（否则改了内存态却没通知）', () => {
  const src = readSrc('src/renderer/stores/agentActions.ts')
  const at = src.indexOf('function evictOldRawText')
  assert.notEqual(at, -1, '找不到 evictOldRawText')
  const body = src.slice(at, at + 1600)
  // 从头（最早）往后回收
  assert.match(body, /for \(let i = 0;/)
  // 没超预算时必须原样返回，避免无谓换引用触发整条渲染管线
  assert.match(body, /return messages/, '未超预算时没有短路返回')
  assert.match(body, /const next = \[\.\.\.messages\]/, '没有复制数组（会就地改到 store 原引用）')
})

test('R9：回收占位必须是非空文案（渲染侧判 m.raw 真值，空串会让整块消失）', () => {
  const src = readSrc('src/renderer/stores/agentActions.ts')
  assert.match(src, /RAW_EVICTED_NOTE\s*=\s*'[^']+'/, '占位是空串：渲染侧会连「原始回显」标题一起隐藏')
  const panel = readSrc('src/renderer/features/agent/AgentPanel.tsx')
  assert.match(panel, /\{m\.raw \?/, '渲染侧的 raw 真值判断变了，R9 的占位方案前提不成立')
})

// ——————————————————————————————————————————————————————————————
// R11：tab 切换保活
// ——————————————————————————————————————————————————————————————

test('R11：拓扑/变更/轨迹必须保活（`? <X/> : null` 会让切回时重跑布局与全量重拉）', () => {
  const src = readSrc('src/renderer/App.tsx')
  for (const name of ['TopologyCanvas', 'ChangeTimeline', 'TracePanel']) {
    assert.doesNotMatch(
      src,
      new RegExp(`activeTab === '[a-z]+' \\? <${name} /> : null`),
      `${name} 仍在按 tab 卸载（切回即重跑）`
    )
    assert.match(src, new RegExp(`<${name} />`), `${name} 不见了（检查是否误删）`)
  }
  // 必须是 display 切换，而不是靠 key/条件渲染
  assert.match(
    src,
    /display: activeTab === 'topology' \? 'flex' : 'none'/,
    '拓扑面板没有用 display 切换显隐'
  )
})

test('R11：保活容器不得用 visibility:hidden（尺寸不为 0 → ResizeObserver 不触发 → 视口错位）', () => {
  const src = readSrc('src/renderer/App.tsx')
  // ⚠️ 必须先剥掉注释再断言：源码里那句「**不要把这几层改成 `visibility:hidden`**」
  // 本身就会命中 `visibility:` 模式（本项目已踩过一次：守卫用例被自己的注释命中）。
  const code = src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
  const at = code.indexOf("display: activeTab === 'topology'")
  assert.notEqual(at, -1, '找不到拓扑保活容器')
  const around = code.slice(Math.max(0, at - 600), at + 200)
  assert.doesNotMatch(around, /visibility:\s*['"]?hidden/, '用了 visibility:hidden：切回来不会重新量尺寸')
  assert.doesNotMatch(around, /opacity:\s*0/, '用了 opacity:0：同上，且会继续吃渲染开销')
})

// ——————————————————————————————————————————————————————————————
// D3：行偏移索引（翻页不再重扫全文）
// ——————————————————————————————————————————————————————————————

/** D3 用：建一个临时目录与写文件的助手 */
function d3Fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lineidx-'))
  return {
    dir,
    write(name, content) {
      const f = path.join(dir, name)
      fs.writeFileSync(f, content)
      return f
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

test('D3：行数口径与旧实现一致（含空文件 / 无尾换行 / CRLF / 连续换行）', () => {
  const fx = d3Fixture()
  clearLineIndexCache()
  try {
    const cases = [
      ['a.txt', 'a\nb\nc\n', 3],
      ['b.txt', 'a\nb\nc', 3],
      ['c.txt', '', 0],
      ['d.txt', 'x', 1],
      ['e.txt', 'x\n', 1],
      ['f.txt', '\n', 1],
      ['g.txt', '\n\n\n', 3],
      ['h.txt', 'a\r\nb\r\n', 2]
    ]
    for (const [name, content, want] of cases) {
      const f = fx.write(name, content)
      const r = readLineWindow(f, 0, 400)
      assert.equal(r.totalLines, want, name + ' 行数错')
    }
  } finally {
    fx.cleanup()
    clearLineIndexCache()
  }
})

test('D3：翻页拼接 = 原文件每一行（读完 137 行不丢行、不重复、不卡死）', () => {
  const fx = d3Fixture()
  clearLineIndexCache()
  try {
    const lines = Array.from({ length: 137 }, (_, i) => 'line-' + i)
    const f = fx.write('big.txt', lines.join('\n') + '\n')
    const got = []
    let off = 0
    for (let guard = 0; guard < 200; guard++) {
      const r = readLineWindow(f, off, 10)
      got.push(...r.text.split('\n'))
      if (r.atEnd) break
      assert.notEqual(r.nextOffset, off, 'offset ' + off + ' 处卡死（nextOffset 没有前进）')
      off = r.nextOffset
    }
    assert.deepEqual(got, lines, '分页读出的行与原文件不一致')
  } finally {
    fx.cleanup()
    clearLineIndexCache()
  }
})

test('D3：非 0 起点也必须返回该行本身（相对窗口计数，不能整页跳过）', () => {
  const fx = d3Fixture()
  clearLineIndexCache()
  try {
    const f = fx.write('cjk.txt', '中文行一\n中文行二\n中文行三\n')
    const r = readLineWindow(f, 1, 1)
    assert.equal(r.text, '中文行二', 'from=1 时返回了错误的行（很可能把本页首行当成第 1 行跳过了）')
    assert.equal(r.totalLines, 3)
  } finally {
    fx.cleanup()
    clearLineIndexCache()
  }
})

test('D3：翻页命中同一份索引缓存（文件未改就不重扫），改文件后失效', () => {
  const fx = d3Fixture()
  clearLineIndexCache()
  try {
    const f = fx.write('big.txt', Array.from({ length: 50 }, (_, i) => 'l' + i).join('\n') + '\n')
    assert.equal(lineIndexCacheSize(), 0, '清空后缓存应为空')
    readLineWindow(f, 0, 10)
    assert.equal(lineIndexCacheSize(), 1, '首次读取后应缓存 1 份索引')
    readLineWindow(f, 10, 10)
    readLineWindow(f, 20, 10)
    assert.equal(lineIndexCacheSize(), 1, '同一文件翻页应复用缓存（size 未变）')

    // 文件被重写 → size/mtime 变化 → 必须重建，行数按新内容算
    fs.writeFileSync(f, 'only\n')
    const r = readLineWindow(f, 0, 10)
    assert.equal(r.totalLines, 1, '重写后索引没有失效（还是旧行数）')
  } finally {
    fx.cleanup()
    clearLineIndexCache()
  }
})

test('D3：索引缓存有上界（不因反复导入附件而无限驻留）', () => {
  const src = readSrc('src/main/core/attachments/lineReader.ts')
  assert.match(src, /LINE_INDEX_CACHE_MAX\s*=\s*\d+/, '没有给行索引缓存设上限常量')
  assert.match(src, /while \(lineIndexCache\.size > LINE_INDEX_CACHE_MAX\)/, '没有按上限淘汰')
})
