import { Type } from './registry'
import { fail, ok, type ToolSpec, type ToolContext } from './registry'
import { restoreSnapshot } from './config'

/**
 * 一键整体回滚（F5，2026-09-26）。
 *
 * 为什么需要它：`execute_task` / `batch_configure` 多台设备任一失败返回 `TASK_FAILED`，
 * 但失败前**已成功（甚至部分生效）的设备**没有整体回收入口 —— 只能人工逐台
 * `restore_snapshot`，还会逐台弹闸门。本工具把「任务结果里的 snapshotId 清单」
 * 直接喂进来，一次批准、逐台走 `restore_snapshot` 的既有内部路径。
 *
 * 两个关键决定：
 * - **只弹一次闸门**：闸门是「人被打断」的成本，N 台设备弹 N 次等于把恢复现场这件事
 *   变得比出错本身更烦。这里在批次级别问一次，批准后逐台执行不再问。
 * - **复用 restore_snapshot 的 handler 而不是重写**：D3 快照完整性校验、危险命令拦截、
 *   `[Y/N]` 半途中止上报、变更记录落库（审计时间线 F6 的数据源）全在那条路径上，
 *   重写一遍必然漏掉其中几条，而漏掉的都是「报成功但没回到现场」这类静默错误。
 */
export const rollbackTask: ToolSpec<{
  snapshots: Array<{ deviceId: string; snapshotId: string }>
  reason: string
}> = {
  name: 'rollback_task',
  description:
    '一键整体回滚：把 execute_task / batch_configure 结果里的 snapshots（每台 deviceId + snapshotId）' +
    '一次性传进来，逐台回滚到各自变更前的快照。批量只弹一次确认闸门；每台仍走 restore_snapshot 的' +
    '完整性校验与危险命令拦截。用于「任务失败后整体回到现场」。',
  risk: 'write',
  scope: 'device',
  schema: Type.Object(
    {
      snapshots: Type.Array(
        Type.Object(
          {
            deviceId: Type.String({ description: '设备 ID' }),
            snapshotId: Type.String({ description: '该设备要回滚到的快照 ID（变更前快照）' })
          },
          { additionalProperties: false }
        ),
        { description: '回滚清单；通常直接取自 execute_task / batch_configure 结果的 snapshots 字段' }
      ),
      reason: Type.String({ description: '回滚原因，用于变更记录与闸门提示' })
    },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    const d = result.data as { succeeded?: number; total?: number } | undefined
    if (!d?.total) return `整体回滚 ${args?.snapshots?.length ?? 0} 台（未执行）`
    return `整体回滚：${d.succeeded ?? 0}/${d.total} 台成功`
  },
  handler: async (args, ctx) => {
    const t0 = Date.now()
    const raw = Array.isArray(args?.snapshots) ? args.snapshots : []
    const reason = (args?.reason ?? '').trim()
    if (!reason) {
      return fail('BAD_PARAM', '请提供 reason 说明回滚原因', { ms: Date.now() - t0 })
    }

    // 同一设备只保留第一条（重复回滚同一台没有意义，且会白白多走一遍事务）
    const seen = new Set<string>()
    const targets: Array<{ deviceId: string; snapshotId: string }> = []
    for (const s of raw) {
      const deviceId = typeof s?.deviceId === 'string' ? s.deviceId.trim() : ''
      const snapshotId = typeof s?.snapshotId === 'string' ? s.snapshotId.trim() : ''
      if (!deviceId || !snapshotId || seen.has(deviceId)) continue
      seen.add(deviceId)
      targets.push({ deviceId, snapshotId })
    }
    if (targets.length === 0) {
      return fail(
        'BAD_PARAM',
        'snapshots 不能为空：请传入 [{ deviceId, snapshotId }]，通常取自 execute_task / batch_configure 结果的 snapshots 字段',
        { ms: Date.now() - t0 }
      )
    }

    // 批次级闸门：一次批准覆盖全部设备
    const approved = await ctx.requestGate({
      toolName: 'rollback_task',
      args,
      reason: `整体回滚 ${targets.length} 台设备：${targets.map((t) => t.deviceId).join('、')}`,
      consequence:
        '将撤销这些设备自各自快照以来的全部配置变更（含期间的手工改动），一次性回到变更前现场。'
    })
    if (!approved) {
      return fail(
        'GATE_REJECTED',
        '整体回滚未获批准：用户拒绝了本次回滚，或任务已中止 / 当前出口（如 MCP）不支持人工确认',
        { ms: Date.now() - t0 }
      )
    }

    // 逐台走 restore_snapshot 的内部路径；内层闸门已被外层覆盖，故置为恒批准
    const innerCtx: ToolContext = { ...ctx, requestGate: async () => true }
    const results: Array<{
      deviceId: string
      snapshotId: string
      ok: boolean
      appliedCommands?: number
      upToDate?: boolean
      error?: { code: string; message: string }
    }> = []
    for (const t of targets) {
      const r = await restoreSnapshot.handler(
        { deviceId: t.deviceId, snapshotId: t.snapshotId, reason },
        innerCtx
      )
      const d = r.data as { appliedCommands?: number; upToDate?: boolean } | undefined
      results.push({
        deviceId: t.deviceId,
        snapshotId: t.snapshotId,
        ok: r.ok,
        ...(d?.appliedCommands !== undefined ? { appliedCommands: d.appliedCommands } : {}),
        ...(d?.upToDate !== undefined ? { upToDate: d.upToDate } : {}),
        ...(r.ok
          ? {}
          : { error: { code: r.error?.code ?? 'UNKNOWN', message: r.error?.message ?? '回滚失败' } })
      })
    }

    const succeeded = results.filter((r) => r.ok).length
    const failed = results.filter((r) => !r.ok)
    const meta = { ms: Date.now() - t0 }
    if (failed.length) {
      return {
        ok: false,
        error: {
          code: 'ROLLBACK_INCOMPLETE',
          message:
            `整体回滚 ${succeeded}/${results.length} 台成功；失败：` +
            failed.map((f) => `${f.deviceId}(${f.error?.message ?? 'failed'})`).join('；')
        },
        data: { total: results.length, succeeded, failed: failed.length, results } as never,
        meta
      }
    }
    return ok(
      { total: results.length, succeeded, failed: 0, results } as never,
      meta
    )
  }
}