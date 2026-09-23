import fs from 'node:fs'
import path from 'node:path'
import { buildJson, buildMarkdown } from '../core/session-tree/report'
import type { SessionTreeStore } from '../core/session-tree/store'
import { fail, ok, Type, type ToolSpec } from './registry'
import { safeFileName } from '@shared/naming'

/**
 * 会话与报告工具（v0.4 / TOOLS.md §4.5）。
 *
 * - list_sessions：会话摘要列表（历史 tab 与代理共用同一数据源）
 * - export_session_report：把一棵会话树导出为 md / json 落到 userData/exports
 *
 * 报告内容生成在 core/session-tree/report.ts（纯函数），这里只做「取数据 + 写盘」。
 */

/** 生成报告并写盘（工具 handler 与 IPC 共用，避免两处实现） */
export function collectSessionReport(
  store: SessionTreeStore,
  exportsDir: string,
  rootId: string,
  format: 'md' | 'json'
): { path: string; ext: string } {
  const meta = store.list().find((m) => m.id === rootId)
  if (!meta) throw new Error(`会话不存在：${rootId}`)
  const nodes = store.getTree(rootId)
  const body = format === 'json' ? buildJson(meta, nodes) : buildMarkdown(meta, nodes)

  // T5.3 / R48：导出目录名与其它文件名走同一套规则（含 Windows 保留名与结尾点）
  const safe = safeFileName(meta.title, { fallback: 'session', maxLen: 40 })
  const ext = format === 'json' ? 'json' : 'md'
  const dir = path.join(exportsDir, safe)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${safe}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${ext}`)
  fs.writeFileSync(file, body, 'utf8')
  return { path: file, ext }
}

export const listSessions: ToolSpec<Record<string, never>> = {
  name: 'list_sessions',
  description: '列出所有会话（历史对话树）的摘要：标题、创建时间、最近活动时间、消息数。用于挑选要回溯或导出的会话。',
  risk: 'read',
  scope: 'local',
  schema: Type.Object({}),
  summarize: (_args, result) => {
    const d = result.data as { sessions?: unknown[] } | undefined
    return `会话 ${d?.sessions?.length ?? 0} 个`
  },
  handler: async (_args, ctx) => {
    const t0 = Date.now()
    return ok({ sessions: ctx.sessionTree.list() }, { ms: Date.now() - t0 })
  }
}

export const exportSessionReport: ToolSpec<{ rootId: string; format?: 'md' | 'json' }> = {
  name: 'export_session_report',
  description:
    '把指定会话导出为报告文件（markdown 或 json），写入应用导出目录，返回文件路径。' +
    '先 list_sessions 拿到 rootId。',
  risk: 'read',
  scope: 'local',
  schema: Type.Object(
    {
      rootId: Type.String({ description: '会话 ID（list_sessions 返回的根节点 id）' }),
      format: Type.Optional(Type.Union([Type.Literal('md'), Type.Literal('json')]))
    },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    const d = result.data as { path?: string } | undefined
    return `导出 ${args.rootId} → ${d?.path ?? '失败'}`
  },
  handler: async (args, ctx) => {
    const t0 = Date.now()
    const format = args.format === 'json' ? 'json' : 'md'
    try {
      const { path: filePath } = collectSessionReport(ctx.sessionTree, ctx.exportsDir, args.rootId, format)
      return ok({ path: filePath }, { ms: Date.now() - t0 })
    } catch (e) {
      return fail('UNKNOWN', e instanceof Error ? e.message : String(e), { ms: Date.now() - t0 })
    }
  }
}