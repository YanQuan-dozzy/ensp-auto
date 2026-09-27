import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 操作反馈条「点击别处即消失」的守卫（v2.21）。
 *
 * 为什么需要：提示条是各面板自己写的 `<div className="banner …">`，没有公共组件约束 ——
 * 新增一个按钮反馈时极易又写成裸 div，于是「导出报告」「清空记录」这类一次性反馈
 * 就一直挂在面板顶部。这里从**源码**做静态对账，和 `ipc-coverage.test.mjs` 一个路子。
 *
 * 判据：以 `banner` 作为**首个类名**的 JSX 只有两种合法形态 ——
 *   ① 用 `<DismissibleBanner>` 渲染（组件内部持 ref 并监听外部点击）；
 *   ② 登记进白名单，并写明**为什么它不该消失**（常驻状态：运行中 / 开关说明 / 排队提示）。
 * 白名单按条数精确对账：多一条少一条都要显式改这里，避免"新写的裸 banner 静默通过"。
 */

const ROOT = 'src/renderer'
const SELF = path.join('src', 'renderer', 'components', 'DismissibleBanner.tsx')

/** 允许保留裸 banner 的位置 → [条数, 理由] */
const ALLOWED = {
  'features/agent/AgentPanel.tsx': [
    2,
    '未配置 API Key 提示 + 断点续跑横幅：都带操作按钮，是「当前状态」不是一次性反馈，消失会让用户丢掉入口'
  ],
  'features/settings/PermissionPanel.tsx': [
    2,
    '危险操作确认开关的状态说明：跟着开关值变，不是某次点击的结果'
  ],
  'features/settings/IntegrationSettings.tsx': [
    2,
    'eNSP 检测结论的两种分支：ref 挂在外层容器上（结论 + 候选路径折叠是一块），走 useDismissOnOutside'
  ],
  'features/terminal/TerminalPane.tsx': [
    1,
    '设备忙、命令排队中的实时提示：刷新频率高，消失与否由队列状态决定'
  ],
  'features/trace/TracePanel.tsx': [
    1,
    '轨迹读取失败时的整页错误占位：清掉会渲染成「空轨迹」，等于假装加载成功'
  ]
}

/** 必须接入的操作反馈（改回裸 banner 就直接挂），盯住用户最常踩的那几个 */
const MUST_WIRE = [
  'features/changes/ChangeTimeline.tsx',
  'features/settings/GeneralPanel.tsx',
  'features/settings/ProfileSettings.tsx',
  'features/skills/SkillsPanel.tsx',
  'features/trace/TracePanel.tsx',
  'features/devices/DevicePanel.tsx',
  'features/agent/McpDialog.tsx'
]

function tsxFiles() {
  const out = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.tsx')) out.push(p)
    }
  }
  walk(ROOT)
  return out
}

function bareBannerCounts() {
  const counts = new Map()
  for (const file of tsxFiles()) {
    if (path.normalize(file) === path.normalize(SELF)) continue
    const src = fs.readFileSync(file, 'utf8')
    // 正则就地新建：带 g 的常量在多处复用会踩 lastIndex
    const n = [...src.matchAll(/className=(?:"|\{['"`])\s*banner(?![-\w])/g)].length
    if (n > 0) counts.set(path.relative(ROOT, file).split(path.sep).join('/'), n)
  }
  return counts
}

test('v2.21 提示条：裸 banner 必须接 DismissibleBanner，或在白名单里写明理由', () => {
  const counts = bareBannerCounts()
  const unlisted = []
  for (const [file, n] of counts) {
    const entry = ALLOWED[file]
    if (!entry) {
      unlisted.push(`${file}（${n} 条）`)
      continue
    }
    assert.equal(
      n,
      entry[0],
      `${file} 的裸 banner 条数变了（白名单 ${entry[0]}，实际 ${n}）—— 新增的请接 DismissibleBanner，`
    )
    assert.ok(entry[1] && entry[1].length > 10, `${file} 的白名单条目必须写明「为什么它不该消失」`)
  }
  assert.deepEqual(
    unlisted,
    [],
    `以下文件的 banner 没接 DismissibleBanner 也没登记白名单：\n  ${unlisted.join('\n  ')}\n` +
      '一次性反馈请改用 <DismissibleBanner tone=… onDismiss={…}>；常驻状态请登记并写明理由。'
  )
})

test('v2.21 提示条：白名单不养僵尸条目', () => {
  const counts = bareBannerCounts()
  const stale = Object.keys(ALLOWED).filter((f) => !counts.has(f))
  assert.deepEqual(stale, [], `白名单里的这些文件已经不再有裸 banner，请删掉条目：${stale.join('、')}`)
})

test('v2.21 提示条：手动接管外点关闭的文件真的用了 hook', () => {
  const src = fs.readFileSync(path.join(ROOT, 'features/settings/IntegrationSettings.tsx'), 'utf8')
  assert.match(src, /useDismissOnOutside\(/, 'IntegrationSettings 登记为「手动接管」，但没调用 useDismissOnOutside')
  assert.match(src, /ref=\{locateRef\}/, 'locateRef 没挂到 DOM 上，外部点击监听会永远拿不到元素')
})

test('v2.21 提示条：高频反馈点都接了组件', () => {
  for (const rel of MUST_WIRE) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    assert.match(src, /<DismissibleBanner/, `${rel} 少了 <DismissibleBanner>`)
    assert.match(src, /onDismiss=\{/, `${rel} 的 DismissibleBanner 没给 onDismiss，点了别处也关不掉`)
  }
})
