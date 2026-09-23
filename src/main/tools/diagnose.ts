import type { Device } from '@shared/types'
import { fail, ok, Type, type ToolSpec } from './registry'

/**
 * 设备运行状态一键采集（v2.0）。
 *
 * 与 core/diagnose（设置页的环境体检：eNSP 客户端/模型端点/MCP 端口）互补：
 * 这里做的是「对已连接设备的运行状态快照」——批量执行一组常用只读 display 命令，
 * 截断后汇总返回，供排障第一步取证（CPU/内存/接口/路由/ARP）。全部 risk=read。
 *
 * 输出刻意保持「采集」而非「判定」：解析交给 verify_* 工具按需做结构化判定，
 * 这里只保证一次调用把要看的都抓回来，回显截断上限避免吃爆 token。
 */

const DIAG_CHECKS: ReadonlyArray<{ key: string; label: string; command: string; limit: number }> = [
  { key: 'cpu', label: 'CPU 占用', command: 'display cpu-usage', limit: 400 },
  { key: 'memory', label: '内存占用', command: 'display memory-usage', limit: 300 },
  { key: 'ip-interfaces', label: '三层接口', command: 'display ip interface brief', limit: 600 },
  { key: 'interfaces', label: '接口状态', command: 'display interface brief', limit: 800 },
  { key: 'routing', label: '路由表', command: 'display ip routing-table', limit: 700 },
  { key: 'arp', label: 'ARP 表', command: 'display arp', limit: 500 },
  { key: 'logbuffer', label: '日志缓冲区', command: 'display logbuffer', limit: 600 }
]

const SLICE_CMD_RE = /^display\s+\S+/i

export const collectDeviceDiagnostics: ToolSpec<{ deviceIds?: string[] }> = {
  name: 'collect_device_diagnostics',
  description:
    '设备运行状态一键采集：对一台或多台设备批量执行常用只读 `display` 命令' +
    '（cpu-usage / memory-usage / ip interface brief / interface brief / ip routing-table / arp / logbuffer），' +
    '逐条截断返回回显。用于排障第一步取证，不判定、不改配置。',
  risk: 'read',
  scope: 'device',
  schema: Type.Object(
    {
      deviceIds: Type.Optional(
        Type.Array(Type.String({ description: '设备 ID 列表；缺省为所有已连接设备' }))
      )
    },
    { additionalProperties: false }
  ),
  summarize: (_args, result) => {
    const d = result.data as { devices?: unknown[] } | undefined
    return `诊断采集：${d?.devices?.length ?? 0} 台设备`
  },
  handler: async (args, ctx) => {
    const t0 = Date.now()
    const sessions = args.deviceIds?.length
      ? args.deviceIds
          .map((id) => ctx.sessions.get(id))
          .filter((s): s is NonNullable<typeof s> => !!s)
      : ctx.sessions
          .list()
          .filter((d: Device) => d.connected)
          .map((d) => ctx.sessions.get(d.id))
          .filter((s): s is NonNullable<typeof s> => !!s)

    if (sessions.length === 0) {
      return fail('NOT_CONNECTED', '没有可采集的已连接设备（或用 deviceIds 显式指定）', { ms: Date.now() - t0 })
    }

    const report: Array<Record<string, unknown>> = []
    for (const s of sessions) {
      const checks: Array<Record<string, unknown>> = []
      for (const c of DIAG_CHECKS) {
        const r = await s.exec(c.command, {
          timeoutMs: 10000,
          ...(ctx.signal ? { signal: ctx.signal } : {})
        })
        if (!r.ok) {
          checks.push({ key: c.key, label: c.label, ok: false, error: r.error ?? '命令执行失败' })
          continue
        }
        const excerpt = r.clean
          .split('\n')
          // 回显第一行通常是命令本身回显 echo，跳过会占篇幅
          .filter((line) => !SLICE_CMD_RE.test(line.trim()))
          .join('\n')
          .trim()
          .slice(0, c.limit)
        checks.push({ key: c.key, label: c.label, ok: true, excerpt })
      }
      report.push({ deviceId: s.id, name: s.name, checks })
    }

    return ok(
      {
        devices: report,
        summary: `采集 ${report.length} 台设备 × ${DIAG_CHECKS.length} 项只读状态`,
        checkKeys: DIAG_CHECKS.map((c) => c.key)
      } as never,
      { ms: Date.now() - t0 }
    )
  }
}