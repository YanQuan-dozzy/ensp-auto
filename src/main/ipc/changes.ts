import { ipcMain } from 'electron'
import { INVOKE } from '@shared/channels'
import { MAX_TIMELINE_ITEMS } from '../core/store/changes'
import { collectChangeReport, deviceLabelsOf } from '../tools/changes'
import type { ChangeRecord, ChangeResult } from '@shared/types'
import type { Services } from '../services'

/**
 * 配置变更时间线（F6，2026-09-26）+ 命令报告导出（v2.20）。
 *
 * 只读：跨设备的变更记录统一视图，纯消费 `ChangeStore`（不新增任何存储）。
 * 本模块只做「校验 → 调服务 → 回传」，业务在 core/store/changes.ts。
 */

const RESULTS: readonly ChangeResult[] = ['ok', 'failed', 'rejected', 'blocked']

/** 渲染层传来的 limit 不可信：夹到 [1, MAX_TIMELINE_ITEMS]，非数字一律用上限 */
function clampLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : undefined
  if (n === undefined || !Number.isFinite(n)) return MAX_TIMELINE_ITEMS
  return Math.max(1, Math.min(MAX_TIMELINE_ITEMS, Math.floor(n)))
}

function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

export function registerChangesIpc(services: Services): void {
  ipcMain.handle(INVOKE.changesList, async (_e, args: { limit?: unknown }): Promise<ChangeRecord[]> => {
    return services.changes.recent(clampLimit(args?.limit))
  })

  // 删除单条：只接受字符串 id；找不到返回 removed:false（不抛错，界面无需区分「已删过」）
  ipcMain.handle(INVOKE.changesRemove, async (_e, args: { id?: unknown }) => {
    const id = typeof args?.id === 'string' ? args.id : ''
    if (!id) throw new Error('缺少要删除的记录 id')
    return { removed: services.changes.remove(id) }
  })

  // 清空全部：返回清掉的条数，界面据此给反馈
  ipcMain.handle(INVOKE.changesClear, async () => {
    return { removed: services.changes.clear() }
  })

  /**
   * v2.20：导出「设备配置命令报告」。
   *
   * 与 `export_change_report` 工具共用 `collectChangeReport` —— 两条出口的正文与文件名
   * 规则因此完全一致。`result` 来自时间线的筛选按钮，白名单校验后再往下传，
   * 避免渲染层塞进一个非法值让报告静默变成空列表。
   */
  ipcMain.handle(
    INVOKE.changesExport,
    async (
      _e,
      args: { title?: unknown; deviceId?: unknown; result?: unknown; limit?: unknown }
    ): Promise<{ path: string; count: number }> => {
      const raw = args?.result
      const result = typeof raw === 'string' && (RESULTS as readonly string[]).includes(raw) ? (raw as ChangeResult) : undefined
      return collectChangeReport(
        services.changes.recent(clampLimit(args?.limit)),
        services.exportsDir,
        deviceLabelsOf(services.sessions.list()),
        {
          ...(optionalString(args?.title) ? { title: optionalString(args?.title) as string } : {}),
          ...(optionalString(args?.deviceId) ? { deviceId: optionalString(args?.deviceId) as string } : {}),
          ...(result ? { result } : {})
        }
      )
    }
  )
}