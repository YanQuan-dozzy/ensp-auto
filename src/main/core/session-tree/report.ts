import type { SessionNode, SessionNodeMeta } from '@shared/types'

/**
 * 报告导出（v0.4 / TOOLS.md §4.5）纯函数。
 * 只做「节点列表 → 文本/json」的格式化，写盘与路径决策在调用方（工具/IPC 共用）。
 */

export function buildJson(root: SessionNodeMeta, nodes: SessionNode[]): string {
  return JSON.stringify({ root, nodes }, null, 2)
}

/** 按树的深度优先（根在前、同层按创建顺序）把节点渲染成 Markdown */
export function buildMarkdown(root: SessionNodeMeta, nodes: SessionNode[]): string {
  const byParent = new Map<string | null, SessionNode[]>()
  for (const n of nodes) {
    const list = byParent.get(n.parentId) ?? []
    list.push(n)
    byParent.set(n.parentId, list)
  }

  const lines: string[] = []
  lines.push(`# ${root.title}`)
  lines.push(`> 会话 ${root.id} · ${root.nodeCount} 条消息 · 生成于 ${new Date().toLocaleString('zh-CN')}`)
  lines.push('')

  const emit = (node: SessionNode): void => {
    const isRoot = node.parentId === null
    const children = (byParent.get(node.id) ?? []).sort((a, b) => a.createdAt - b.createdAt)

    if (node.role === 'user') {
      if (!isRoot) lines.push('## 用户')
      lines.push(node.content)
      lines.push('')
    } else if (node.role === 'assistant') {
      lines.push('## 代理')
      lines.push(node.content)
      lines.push('')
    } else if (node.role === 'tool') {
      const tc = node.toolCall
      const status = tc ? (tc.ok === false ? '失败' : tc.ok ? '成功' : '执行中') : ''
      const ms = tc && tc.ms !== undefined ? ` · ${tc.ms}ms` : ''
      lines.push(`> 工具 **${tc?.name ?? node.content}** ${status}${ms}`)
      lines.push(`> \`${safeJson(tc?.args)}\``)
      lines.push('')
    }

    for (const c of children) emit(c)
  }

  const roots = nodes.filter((n) => n.parentId === null).sort((a, b) => a.createdAt - b.createdAt)
  for (const r of roots) emit(r)
  return lines.join('\n').trimEnd() + '\n'
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}