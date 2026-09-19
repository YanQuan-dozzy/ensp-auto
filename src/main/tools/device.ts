import type { Device } from '@shared/types'
import { fail, ok, Type, type ToolSpec } from './registry'

/**
 * 设备发现与连接类工具（全部 risk=read）。
 *
 * 注意 scan_devices 的 schema 不含 host 参数 —— 主机地址硬编码 127.0.0.1，
 * 从接口层面杜绝本工具被改造成网络扫描器。
 */

export const scanDevices: ToolSpec<{ start?: number; end?: number }> = {
  name: 'scan_devices',
  description:
    '扫描本机 eNSP 虚拟设备。只能扫描 127.0.0.1，端口范围默认 2000-2050。返回发现的设备端口列表。',
  risk: 'read',
  scope: 'local',
  schema: Type.Object(
    {
      start: Type.Optional(Type.Integer({ description: '起始端口，默认 2000', default: 2000 })),
      end: Type.Optional(Type.Integer({ description: '结束端口，默认 2050', default: 2050 }))
    },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    const n = (result.data as { devices?: unknown[] } | undefined)?.devices?.length ?? 0
    return `扫描 ${args.start ?? 2000}-${args.end ?? 2050}，发现 ${n} 个设备`
  },
  handler: async (args, ctx) => {
    const t0 = Date.now()
    const settings = ctx.settings
    const start = clampPort(args.start ?? settings.scanStart ?? 2000)
    const end = clampPort(args.end ?? settings.scanEnd ?? 2050)
    if (end < start) {
      return fail('UNKNOWN', `端口范围非法：${start}-${end}`, { ms: Date.now() - t0 })
    }
    const devices = await ctx.sessions.scan(start, end, {
      ...(ctx.signal ? { signal: ctx.signal } : {})
    })
    return ok(
      {
        devices: devices.map((d) => ({ port: d.port, id: d.id, name: d.name }))
      },
      { ms: Date.now() - t0 }
    )
  }
}

export const connectDevice: ToolSpec<{ port: number; name?: string }> = {
  name: 'connect_device',
  description: '连接指定端口的 eNSP 设备，建立会话。返回设备型号、当前提示符与视图。',
  risk: 'read',
  scope: 'device',
  schema: Type.Object(
    {
      port: Type.Integer({ description: '设备端口号，如 2008' }),
      name: Type.Optional(Type.String({ description: '可选，设备别名' }))
    },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    const d = result.data as Device | undefined
    return `连接 ${d?.name ?? args.port}${d?.model ? `（${d.model}）` : ''}`
  },
  handler: async (args, ctx) => {
    const t0 = Date.now()
    const port = clampPort(args.port)
    try {
      const device = await ctx.sessions.connect(port, args.name)
      return ok(device, { ms: Date.now() - t0, deviceId: device.id })
    } catch (e) {
      return fail('NOT_CONNECTED', (e as Error).message, { ms: Date.now() - t0 })
    }
  }
}

export const listDevices: ToolSpec<Record<string, never>> = {
  name: 'list_devices',
  description: '列出已知设备及其连接状态、型号、当前视图。',
  risk: 'read',
  scope: 'local',
  schema: Type.Object({}),
  summarize: (_args, result) => {
    const d = result.data as { devices?: Device[] } | undefined
    return `已知设备 ${d?.devices?.length ?? 0} 个`
  },
  handler: async (_args, ctx) => {
    const t0 = Date.now()
    return ok({ devices: ctx.sessions.list() }, { ms: Date.now() - t0 })
  }
}

export const disconnectDevice: ToolSpec<{ deviceId: string }> = {
  name: 'disconnect_device',
  description: '断开指定设备的会话（仅关闭连接，不修改设备配置）。',
  risk: 'read',
  scope: 'device',
  schema: Type.Object(
    { deviceId: Type.String({ description: '设备 ID，形如 127.0.0.1:2008' }) },
    { additionalProperties: false }
  ),
  summarize: (args) => `断开 ${args.deviceId}`,
  handler: async (args, ctx) => {
    const t0 = Date.now()
    ctx.sessions.disconnect(args.deviceId)
    return ok({ disconnected: args.deviceId }, { ms: Date.now() - t0 })
  }
}

export const renameDevice: ToolSpec<{ deviceId: string; name: string }> = {
  name: 'rename_device',
  description: '为设备设置别名，便于后续识别。别名会被持久化。',
  risk: 'read',
  scope: 'local',
  schema: Type.Object(
    {
      deviceId: Type.String({ description: '设备 ID' }),
      name: Type.String({ description: '新别名' })
    },
    { additionalProperties: false }
  ),
  summarize: (args) => `重命名 ${args.deviceId} → ${args.name}`,
  handler: async (args, ctx) => {
    const t0 = Date.now()
    const d = ctx.sessions.rename(args.deviceId, args.name)
    if (!d) return fail('UNKNOWN', '别名不能为空', { ms: Date.now() - t0 })
    return ok(d, { ms: Date.now() - t0, deviceId: d.id })
  }
}

function clampPort(p: number): number {
  if (!Number.isFinite(p)) return 2000
  return Math.max(1, Math.min(65535, Math.trunc(p)))
}
