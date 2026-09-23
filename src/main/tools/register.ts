import type { Device } from '@shared/types'
import {
  DEFAULT_SCAN_END,
  DEFAULT_SCAN_START,
  describePortValue,
  parsePort,
  parsePortOr
} from '@shared/ports'
import { fail, ok, Type, type ToolSpec } from './registry'

/**
 * 无 .topo 时的设备注册模式（v1.8 / 参照 jmsgfc/ensp-mcp 的 register_device /
 * auto_discover_devices / unregister_device）。
 *
 * 与 scan_devices 只「探测不连接」不同：
 * - register_device：连接指定端口并把别名持久化（供后续工具按名字引用）。
 * - auto_discover_devices：扫描端口区间，对每个发现的端口建立会话并持久化别名，
 *   一次调用即可把全部在线设备纳入工作台。
 * - unregister_device：从工作台移除（断开 + 清别名 + 不再列入已知设备），下次扫描可重新发现。
 *
 * 全部 risk=read（只建立连接，不修改设备配置）；主机地址始终 127.0.0.1。
 */

export const registerDevice: ToolSpec<{ port: number; name?: string }> = {
  name: 'register_device',
  description:
    '注册设备（无 .topo 的临时模式）：连接指定端口的 eNSP 设备并把别名持久化，' +
    '之后可通过名字引用。设备已连接时只补别名，不会重复建连。',
  risk: 'read',
  scope: 'device',
  schema: Type.Object(
    {
      port: Type.Integer({ description: '设备端口号，如 2004' }),
      name: Type.Optional(Type.String({ description: '持久化别名，如 R1；缺省用设备宿主名/型号' }))
    },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    const d = result.data as Device | undefined
    return `注册 ${d?.name ?? args.port}（port ${args.port}）`
  },
  handler: async (args, ctx) => {
    const t0 = Date.now()
    // 与 connect_device 同一口径：端口缺失/非法一律 BAD_PARAM，不兜底到 2000
    const port = parsePort(args.port)
    if (port === null) {
      return fail(
        'BAD_PARAM',
        `port 非法：需为 1~65535 的整数，收到 ${describePortValue(args.port)}`,
        { ms: Date.now() - t0 }
      )
    }
    try {
      const device = await ctx.sessions.connect(port, args.name)
      if (args.name?.trim()) {
        const renamed = ctx.sessions.rename(device.id, args.name.trim())
        device.name = renamed?.name ?? device.name
      }
      return ok(device, { ms: Date.now() - t0, deviceId: device.id })
    } catch (e) {
      return fail('NOT_CONNECTED', `注册失败：${(e as Error).message}`, { ms: Date.now() - t0 })
    }
  }
}

export const autoDiscoverDevices: ToolSpec<{ start?: number; end?: number }> = {
  name: 'auto_discover_devices',
  description:
    '自动发现并注册设备：扫描 127.0.0.1 上指定端口区间（默认 2000-2050），' +
    '对每个在线端口建立会话并持久化别名，一次调用把全部设备纳入工作台。' +
    '返回已注册设备清单（含连接失败的端口及其原因）。',
  risk: 'read',
  scope: 'device',
  schema: Type.Object(
    {
      start: Type.Optional(Type.Integer({ description: '起始端口，默认 2000', default: 2000 })),
      end: Type.Optional(Type.Integer({ description: '结束端口，默认 2050', default: 2050 }))
    },
    { additionalProperties: false }
  ),
  summarize: (_args, result) => {
    const d = result.data as { registered?: unknown[]; failed?: number } | undefined
    return `自动发现 ${d?.registered?.length ?? 0} 台设备${d?.failed ? `（${d.failed} 台失败）` : ''}`
  },
  handler: async (args, ctx) => {
    const t0 = Date.now()
    const start = parsePortOr(args.start, DEFAULT_SCAN_START)
    if (start === null) {
      return fail('BAD_PARAM', `start 非法：需为 1~65535 的整数，收到 ${describePortValue(args.start)}`, {
        ms: Date.now() - t0
      })
    }
    const end = parsePortOr(args.end, DEFAULT_SCAN_END)
    if (end === null) {
      return fail('BAD_PARAM', `end 非法：需为 1~65535 的整数，收到 ${describePortValue(args.end)}`, {
        ms: Date.now() - t0
      })
    }
    if (end < start) {
      return fail('BAD_PARAM', `端口范围非法：${start}-${end}`, { ms: Date.now() - t0 })
    }
    // v1.8：范围跨度兜底 —— 模型被诱导扫 1..65535 会拖住运行时并堆积数千个常驻连接
    const span = end - start + 1
    if (span > 512) {
      return fail('UNKNOWN', `端口范围过大（${start}-${end}，共 ${span} 个），单次最多扫描 512 个端口`, {
        ms: Date.now() - t0
      })
    }
    const found = await ctx.sessions.scan(start, end, {
      ...(ctx.signal ? { signal: ctx.signal } : {})
    })

    const registered: Array<Record<string, unknown>> = []
    const errors: Array<Record<string, unknown>> = []
    for (const d of found) {
      const name = `Device-${d.port}`
      try {
        const device = await ctx.sessions.connect(d.port, name)
        // 探测型号，让别名更可读（失败不阻塞）
        try {
          await ctx.sessions.probeDevice(device.id)
        } catch {
          /* 型号探测失败不影响注册 */
        }
        registered.push({
          deviceId: device.id,
          port: device.port,
          name: device.name,
          model: device.model,
          connected: true
        })
      } catch (e) {
        errors.push({
          port: d.port,
          deviceId: d.id,
          error: (e as Error).message
        })
      }
    }

    if (registered.length === 0 && errors.length) {
      return ok(
        {
          registered: [],
          failed: errors.length,
          errors,
          message: '没有可注册的端口（或全部连接失败）'
        } as never,
        { ms: Date.now() - t0 }
      )
    }
    return ok({ registered, failed: errors.length, errors } as never, { ms: Date.now() - t0 })
  }
}

export const unregisterDevice: ToolSpec<{ deviceId: string }> = {
  name: 'unregister_device',
  description:
    '把设备从工作台移除：断开会话 + 清除持久化别名 + 不再列入已知设备。' +
    '设备在 eNSP 中仍然在线，重新 scan 或 register 可再次接入。',
  risk: 'read',
  scope: 'device',
  schema: Type.Object(
    { deviceId: Type.String({ description: '设备 ID，形如 127.0.0.1:2004' }) },
    { additionalProperties: false }
  ),
  summarize: (args) => `注销 ${args.deviceId}`,
  handler: async (args, ctx) => {
    const t0 = Date.now()
    ctx.sessions.forget(args.deviceId)
    return ok({ unregistered: args.deviceId }, { ms: Date.now() - t0 })
  }
}