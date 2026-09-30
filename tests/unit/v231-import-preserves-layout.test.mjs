/**
 * v2.31：导入工程「按 eNSP 原样排布」+ 进度条起点。
 *
 * 两条用户可见的行为约定，容易在后续改动里被静默改回去，故固化成用例：
 *
 * ① **导入不自动重排**：导入 eNSP 工程后画布显示的是工程里的原始摆放；
 *    只有用户点「自适应布局」（或把设置里的开关打开）才重排。
 *    与此配套的硬约束是 default 必须为 `false` —— 光改调用点、不改默认值，
 *    用户那边的旧配置/新装默认仍会重排，等于没改。
 *
 * ② **进度条从「选完文件」开始**：弹文件选择框期间不亮（用户还在挑文件，
 *    主进程什么都没做）；用户确定后、解析开始的那一刻才点亮。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_SETTINGS, TopologyStore } from '../.build/harness.mjs'

const ROOT = path.resolve(import.meta.dirname, '../..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

// ————————————————— ① 导入保留原样 —————————————————

test('默认设置：导入后自动重排 = 关闭（改回 true 会让「导入保原样」整体失效）', () => {
  assert.equal(
    DEFAULT_SETTINGS.ensp.autoLayoutOnImport,
    false,
    '导入工程必须默认保留 eNSP 原始摆放；要重排请让用户点「自适应布局」或自行打开开关'
  )
})

test('设置页白名单仍收该开关（关掉 ≠ 删掉；用户可自行打开）', () => {
  const src = read('src/main/ipc/settings.ts')
  assert.match(src, /autoLayoutOnImport/, 'settings:set 白名单必须保留 autoLayoutOnImport，否则开关置真会被静默丢弃')
})

test('eNSP 工程解析：源坐标另存 srcX/srcY，x/y 直接取自工程文件', () => {
  const src = read('src/main/core/topology/fromProjectFile.ts')
  // x/y 取自 d.x / d.y（工程文件里的摆放）
  assert.match(src, /\.\.\.\(d\.x !== undefined \? \{ x: d\.x \} : \{\}\)/, 'x 必须直接取工程文件的摆放')
  assert.match(src, /\.\.\.\(d\.y !== undefined \? \{ y: d\.y \} : \{\}\)/, 'y 必须直接取工程文件的摆放')
  // 源坐标单独留档（重排后仍能回到原样 / 供「源图保真」内核使用）
  assert.match(src, /srcX: d\.x/, '源坐标必须另存 srcX')
  assert.match(src, /srcY: d\.y/, '源坐标必须另存 srcY')
})

test('新工程导入：手动层被重置为空 → 画布显示的是工程原样，不是上次重排的坐标', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensp-v231-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const store = new TopologyStore({ file: path.join(dir, 'topo.json') })

  // 工程 A：导入 → 用户在画布上「重排」过（坐标写进 manual 层）
  const projA = {
    nodes: [
      { id: 'AR1', name: 'AR1', role: 'router', x: 100, y: 50, srcX: 100, srcY: 50 },
      { id: 'SW1', name: 'SW1', role: 'switch', x: 300, y: 50, srcX: 300, srcY: 50 }
    ],
    links: [{ id: 'f1', from: 'AR1', to: 'SW1', source: 'file' }],
    updatedAt: 1
  }
  store.setFile(projA, path.join(dir, 'a.topo'))
  store.applyManual({
    nodes: [
      { id: 'AR1', name: 'AR1', role: 'router', x: 40, y: 900, source: 'manual' },
      { id: 'SW1', name: 'SW1', role: 'switch', x: 40, y: 1100, source: 'manual' }
    ],
    links: []
  })
  assert.equal(store.snapshot().nodes.find((n) => n.id === 'AR1').y, 900, '重排后坐标应生效')

  // 工程 B：另开一个工程 —— 不能被 A 的重排坐标污染
  const projB = {
    nodes: [{ id: 'RT9', name: 'RT9', role: 'router', x: 77, y: 88, srcX: 77, srcY: 88 }],
    links: [],
    updatedAt: 2
  }
  store.setFile(projB, path.join(dir, 'b.topo'))
  const rt = store.snapshot().nodes.find((n) => n.id === 'RT9')
  assert.equal(rt.x, 77, '新工程首次导入必须按工程里的原样摆放')
  assert.equal(rt.y, 88, '新工程首次导入必须按工程里的原样摆放')
})

// ————————————————— ② 进度条起点 —————————————————

test('导入文件：进度条不在调 IPC 之前点亮（弹框期间不该显示「正在解析」）', () => {
  const src = read('src/renderer/stores/dataActions.ts')
  const body = /async importTopology\(\)[\s\S]*?\n {4}\},/.exec(src)
  assert.ok(body, '找不到 importTopology 实现')
  const head = body[0].split('await window.api.topology.importFile()')[0]
  assert.doesNotMatch(
    head,
    /topoLoading/,
    'importTopology 在 invoke 之前不得置 topoLoading —— 弹文件框期间主进程还没开始解析'
  )
})

test('导入文件：主进程在「开始解析」处推 import-started 事件（弹框之后、解析之前）', () => {
  const src = read('src/main/ipc/topology.ts')
  const body = /INVOKE\.topologyImportFile[\s\S]*?\n {2}\}\)/.exec(src)
  assert.ok(body, '找不到 topologyImportFile handler')
  const text = body[0]
  const dialogAt = text.indexOf('showOpenDialogSafe')
  const emitAt = text.indexOf('topologyImportStarted')
  const parseAt = text.indexOf('importTopoPath(services')
  assert.ok(dialogAt >= 0 && emitAt >= 0 && parseAt >= 0, '三段都应存在')
  assert.ok(dialogAt < emitAt, '事件必须在弹框之后（用户选完文件）才推')
  assert.ok(emitAt < parseAt, '事件必须在开始解析之前推，否则进度条盖不住解析耗时')
})

test('导入文件：渲染层订阅该事件并置为 read 阶段', () => {
  const src = read('src/renderer/stores/dataActions.ts')
  assert.match(src, /EVENT\.topologyImportStarted/, '渲染层必须订阅 topologyImportStarted')
  assert.match(src, /import-started|topologyImportStarted/, '通道名应来自 EVENT 表')
})

test('事件通道已声明且自动进 preload 白名单', () => {
  const channels = read('src/shared/channels.ts')
  const preload = read('src/preload/index.ts')
  assert.match(channels, /topologyImportStarted:\s*'topology:import-started'/)
  // 白名单由 Object.values(EVENT) 生成 —— 只要进了 EVENT 表就自动可订阅
  assert.match(preload, /EVENT_WHITELIST = new Set<string>\(Object\.values\(EVENT\)\)/)
})

test('发现面板按路径导入：点击即解析，进度条就地置位（无文件框环节）', () => {
  const src = read('src/renderer/stores/dataActions.ts')
  const body = /async importTopoPath\(filePath: string\)[\s\S]*?\n {4}\},/.exec(src)
  assert.ok(body, '找不到 importTopoPath 实现')
  const head = body[0].split('await window.api.topology.importPath')[0]
  assert.match(head, /topoLoading/, 'importTopoPath 应在 invoke 之前点亮进度条（点击即解析）')
})
