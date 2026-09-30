import fs from 'node:fs'
import path from 'node:path'
import { buildJson, buildMarkdown } from '../core/session-tree/report'
import { atomicWriteFileSync } from '../core/fs/atomic'
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
  // D15（PERF-MEM-REVIEW-2026-09-29 §五）：必须走原子写。
  // 报告**紧接着就会被 read_attachment 读回喂给模型** —— 裸 writeFileSync 在
  // 写到一半时崩掉/被杀，留下半截文件会被当成正文读进上下文（且没有任何
  // 语法标记能让人看出它是残缺的）。core/fs/atomic.ts:8-10 自立的规矩就是
  // 全仓只有那一份实现，这里不再另开一套。
  atomicWriteFileSync(file, body)
  return { path: file, ext }
}

/**
 * F8：把分支对比报告写入导出目录。
 *
 * 与 `collectSessionReport` 同规矩（导出目录、文件名安全化、时间戳）。
 * 对比正文由 `core/session-tree/compare.ts` 的纯函数生成 —— 这里只负责写盘，
 * 这样「预览（不落盘）」与「导出（落盘）」共用同一份正文，不会两种口径。
 */
export function writeCompareReport(exportsDir: string, title: string, markdown: string): { path: string } {
  const safe = safeFileName(title, { fallback: 'session', maxLen: 40 })
  const dir = path.join(exportsDir, safe)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${safe}-compare-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.md`)
  // 同上：对比报告也是给模型读回的文件，裸写会留下半截正文
  atomicWriteFileSync(file, markdown)
  return { path: file }
}

export const listSessions: ToolSpec<Record<string, never>> = {
  name: 'list_sessions',
  description: '列出所有会话（历史对话树）的摘要：标题、创建时间、最近活动时间、消息数。用于挑选要回溯或导出的会话。',
  risk: 'read',
  scope: 'local',
  concurrencySafe: true,
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
    '把指定会话导出为报告文件（markdown 或 json），写入应用导出目录，返回文件路径' +
    '（需要看内容时用 read_attachment 按行读回该路径）。先 list_sessions 拿到 rootId。',
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