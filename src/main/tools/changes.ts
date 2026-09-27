import fs from 'node:fs'
import path from 'node:path'
import { buildChangeReport, type ChangeReportOptions } from '../core/store/change-report'
import { MAX_TIMELINE_ITEMS } from '../core/store/changes'
import type { ChangeRecord, Device } from '@shared/types'
import type { ChangeReportRequest, ChangeReportResult } from '@shared/api'
import { fail, ok, Type, type ToolSpec } from './registry'
import { safeFileName } from '@shared/naming'

/**
 * 设备配置命令报告（v2.20）。
 *
 * - export_change_report：把本地变更记录（`ChangeStore`）导出为实验交付物 markdown。
 *
 * 报告正文生成在 `core/store/change-report.ts`（纯函数），本模块只做「取数据 + 写盘」，
 * 与 `changes:export` IPC 共用 `collectChangeReport` —— 否则 agent 看到的和用户点按钮
 * 拿到的会是两份不同口径的东西。
 *
 * 数据源边界（详见 change-report.ts 的模块注释）：只读变更记录，不含设备回显。
 */

/** 把 deviceId → 别名的映射拍平成报告用的查表函数数据 */
export function deviceLabelsOf(devices: readonly Device[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const d of devices) if (d.name) map[d.id] = d.name
  return map
}

/**
 * 生成报告并写盘。正文由纯函数产出，这里只负责目录与文件名。
 *
 * 落盘规矩与 `collectSessionReport` / `writeCompareReport` 一致：
 * `exportsDir/<安全标题>/<安全标题>-changes-<ISO时间戳>.md`（Windows 保留名与结尾点走 safeFileName）。
 * 带上 `-changes-` 中缀是为了不和同名会话报告撞在同一个目录里。
 */
export function collectChangeReport(
  records: readonly ChangeRecord[],
  exportsDir: string,
  labels: Readonly<Record<string, string>>,
  req: ChangeReportRequest
): ChangeReportResult {
  const title = req.title?.trim() || '设备配置命令报告'
  const options: ChangeReportOptions = {
    title,
    deviceLabels: labels,
    ...(req.deviceId ? { deviceId: req.deviceId } : {}),
    ...(req.result ? { result: req.result } : {})
  }
  const markdown = buildChangeReport({ records, options })

  const safe = safeFileName(title, { fallback: 'changes', maxLen: 40 })
  const dir = path.join(exportsDir, safe)
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const file = path.join(dir, `${safe}-changes-${stamp}.md`)
  fs.writeFileSync(file, markdown, 'utf8')

  // 回传给 UI/agent 的条数是**应用筛选后**的数量，不是传入的记录总数
  const count = records.filter(
    (r) => (!req.deviceId || r.deviceId === req.deviceId) && (!req.result || r.result === req.result)
  ).length
  return { path: file, count }
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return MAX_TIMELINE_ITEMS
  return Math.max(1, Math.min(MAX_TIMELINE_ITEMS, Math.floor(raw)))
}

export const exportChangeReport: ToolSpec<{ title?: string; deviceId?: string; limit?: number }> = {
  name: 'export_change_report',
  description:
    '把本地配置变更记录导出为「设备配置命令报告」（markdown）写入应用导出目录，返回文件路径' +
    '（需要看内容时用 read_attachment 按行读回该路径）。' +
    '报告含：概览统计、IP 地址规划（从已成功下发的命令推导的 DHCP 地址池与接口 IP）、' +
    '按设备分组的配置实施过程（命令可直接照抄）、失败与拦截记录。' +
    '适用场景：实验/课程设计收尾时交付配置过程记录。只读本地记录，不连接设备。',
  risk: 'read',
  scope: 'local',
  concurrencySafe: true,
  schema: Type.Object(
    {
      title: Type.Optional(Type.String({ description: '报告标题，缺省「设备配置命令报告」' })),
      deviceId: Type.Optional(Type.String({ description: '只导出该设备（如 127.0.0.1:2004），缺省导出全部设备' })),
      limit: Type.Optional(
        Type.Integer({ description: `参与生成的记录条数上限，缺省 ${MAX_TIMELINE_ITEMS}（上限）` })
      )
    },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    const d = result.data as { path?: string; count?: number } | undefined
    return `导出命令报告 ${d?.count ?? 0} 条 → ${d?.path ?? '失败'}${args.deviceId ? `（${args.deviceId}）` : ''}`
  },
  handler: async (args, ctx) => {
    const t0 = Date.now()
    try {
      const records = ctx.changes.recent(clampLimit(args.limit))
      const { path: filePath, count } = collectChangeReport(
        records,
        ctx.exportsDir,
        deviceLabelsOf(ctx.sessions.list()),
        {
          ...(args.title ? { title: args.title } : {}),
          ...(args.deviceId ? { deviceId: args.deviceId } : {})
        }
      )
      return ok({ path: filePath, count }, { ms: Date.now() - t0 })
    } catch (e) {
      return fail('UNKNOWN', e instanceof Error ? e.message : String(e), { ms: Date.now() - t0 })
    }
  }
}
