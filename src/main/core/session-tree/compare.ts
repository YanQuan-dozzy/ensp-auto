import type {
  BranchComparison,
  BranchSide,
  DiffKind,
  DiffRow,
  SessionNode,
  ToolStep
} from '@shared/types'

/**
 * 分支对比（F8，2026-09-26）—— 纯函数，无 IO。
 *
 * 会话树是真正的树：同一起点可以走多条路线（回溯换路）。教学场景最想回答的问题是
 * 「为什么方案 B 更好」—— 而这个问题可以被降解成一次**工具调用序列的逐项对比**：
 * 哪条路线调用更少、哪条有失败调用、哪条更慢。
 *
 * 刻意不做「文本 diff」：轨迹的文本（模型措辞）每次都不同，diff 出来全是噪声；
 * 真正稳定可比的是**工具调用的签名**（name + 参数），所以对齐的粒度是调用而不是字符。
 *
 * 类型（ToolStep / BranchSide / DiffRow / BranchComparison）定义在 `@shared/types` ——
 * 渲染层要展示同一份结构，放 shared 才不用抄第二份。
 */

export type { BranchComparison, BranchSide, DiffKind, DiffRow, ToolStep } from '@shared/types'

/** 稳定序列化：对象键排序，保证同一份参数在任何场合得到同一签名 */
export function stableArgsKey(v: unknown): string {
  const s = stableJson(v)
  return s.length > 200 ? s.slice(0, 200) : s
}

function stableJson(v: unknown): string {
  if (v === undefined) return 'null'
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  const obj = v as Record<string, unknown>
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`)
    .join(',')}}`
}

/** 把一棵子树（或整棵树）里的工具节点按时间抽成调用序列 */
export function toolStepsOf(nodes: readonly SessionNode[]): ToolStep[] {
  return nodes
    .filter((n) => n.role === 'tool')
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((n) => ({
      nodeId: n.id,
      at: n.createdAt,
      name: n.toolCall?.name ?? n.content,
      ...(n.toolCall?.ok !== undefined ? { ok: n.toolCall.ok } : {}),
      ...(n.toolCall?.ms !== undefined ? { ms: n.toolCall.ms } : {}),
      ...(n.toolCall?.summary ? { summary: n.toolCall.summary } : {}),
      ...(n.toolCall?.errorCode ? { errorCode: n.toolCall.errorCode } : {}),
      argKey: stableArgsKey(n.toolCall?.args)
    }))
}

function signature(s: ToolStep): string {
  return `${s.name}#${s.argKey}`
}

/** 标准 LCS 对齐：返回按顺序的操作序列（同序项成对，其余标为单侧独有） */
function alignSequences(a: string[], b: string[]): Array<{ kind: DiffKind; ai?: number; bi?: number }> {
  const n = a.length
  const m = b.length
  // dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const ops: Array<{ kind: DiffKind; ai?: number; bi?: number }> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'same', ai: i, bi: j })
      i += 1
      j += 1
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ kind: 'onlyA', ai: i })
      i += 1
    } else {
      ops.push({ kind: 'onlyB', bi: j })
      j += 1
    }
  }
  while (i < n) ops.push({ kind: 'onlyA', ai: i++ })
  while (j < m) ops.push({ kind: 'onlyB', bi: j++ })
  return ops
}

function sideOf(head: SessionNode, label: string, nodes: readonly SessionNode[]): BranchSide {
  const steps = toolStepsOf(nodes)
  return {
    headId: head.id,
    label,
    steps,
    tools: steps.length,
    failed: steps.filter((s) => s.ok === false).length,
    totalMs: steps.reduce((sum, s) => sum + (s.ms ?? 0), 0)
  }
}

/**
 * 对比两个分支。
 *
 * 入参是两侧各自的节点集合（调用方负责按分支起点切子树），函数只做对齐与结论 ——
 * 「谁更优」的判据顺序：失败调用更少 → 工具调用更少 → 总耗时更短；
 * 三者都一样就如实说「无显著优劣」，不硬凑一个赢家。
 */
export function compareBranches(
  aHead: SessionNode,
  aNodes: readonly SessionNode[],
  bHead: SessionNode,
  bNodes: readonly SessionNode[],
  labels: { a: string; b: string } = { a: 'A', b: 'B' }
): BranchComparison {
  const a = sideOf(aHead, labels.a, aNodes)
  const b = sideOf(bHead, labels.b, bNodes)
  const ops = alignSequences(a.steps.map(signature), b.steps.map(signature))
  const rows: DiffRow[] = ops.map((op) => ({
    kind: op.kind,
    ...(op.ai !== undefined ? { a: a.steps[op.ai]! } : {}),
    ...(op.bi !== undefined ? { b: b.steps[op.bi]! } : {})
  }))

  let verdict: string
  if (a.failed !== b.failed) {
    const win = a.failed < b.failed ? a.label : b.label
    verdict = `${win} 更优：失败调用更少（${a.failed} vs ${b.failed}）`
  } else if (a.tools !== b.tools) {
    const win = a.tools < b.tools ? a.label : b.label
    verdict = `${win} 更优：工具调用更少（${a.tools} vs ${b.tools}）`
  } else if (a.totalMs !== b.totalMs) {
    const win = a.totalMs < b.totalMs ? a.label : b.label
    verdict = `${win} 更优：总耗时更短（${a.totalMs}ms vs ${b.totalMs}ms）`
  } else {
    verdict = '两条分支的工具调用数量、失败数与耗时一致，无显著优劣'
  }
  return { a, b, rows, verdict }
}

const ROW_MARK: Record<DiffKind, string> = { same: '=', onlyA: '-', onlyB: '+' }

function stepText(s: ToolStep | undefined): string {
  if (!s) return '—'
  const status = s.ok === false ? '✘' : s.ok === true ? '✔' : '…'
  return `${status} ${s.name}(${s.argKey})${s.ms !== undefined ? ` ${s.ms}ms` : ''}`
}

/** 分支起点的可读标签：取该节点内容首行（截断），空则用 fallback */
export function branchLabelOf(head: { content?: string }, fallback: string): string {
  const first = (head.content ?? '').split('\n')[0]?.trim() ?? ''
  if (!first) return fallback
  return first.length > 24 ? `${first.slice(0, 24)}…` : first
}

/** 把对比结果渲染成可导出的 Markdown 报告 */
export function renderComparisonMarkdown(c: BranchComparison, title: string): string {
  const lines: string[] = []
  lines.push(`# 分支对比：${title}`)
  lines.push('')
  lines.push(`> 生成于 ${new Date().toLocaleString('zh-CN')}`)
  lines.push('')
  lines.push(`**结论**：${c.verdict}`)
  lines.push('')
  lines.push('| 指标 | ' + c.a.label + ' | ' + c.b.label + ' |')
  lines.push('|---|---|---|')
  lines.push(`| 工具调用 | ${c.a.tools} | ${c.b.tools} |`)
  lines.push(`| 失败调用 | ${c.a.failed} | ${c.b.failed} |`)
  lines.push(`| 总耗时 | ${c.a.totalMs}ms | ${c.b.totalMs}ms |`)
  lines.push('')
  lines.push('## 调用序列对比')
  lines.push('')
  lines.push(`- \`=\` 两侧一致 · \`-\` 仅 ${c.a.label} · \`+\` 仅 ${c.b.label}`)
  lines.push('')
  lines.push('| | ' + c.a.label + ' | ' + c.b.label + ' |')
  lines.push('|---|---|---|')
  for (const r of c.rows) {
    lines.push(`| ${ROW_MARK[r.kind]} | ${escapeCell(stepText(r.a))} | ${escapeCell(stepText(r.b))} |`)
  }
  lines.push('')
  return lines.join('\n')
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|')
}