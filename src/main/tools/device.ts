import type { Device } from '@shared/types'
import {
  DEFAULT_SCAN_END,
  DEFAULT_SCAN_START,
  DEFAULT_SSH_PORT,
  describePortValue,
  parsePort,
  parsePortOr
} from '@shared/ports'
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
    const start = parsePortOr(args.start ?? settings.scanStart, DEFAULT_SCAN_START)
    if (start === null) {
      return fail('BAD_PARAM', `start 非法：需为 1~65535 的整数，收到 ${describePortValue(args.start)}`, {
        ms: Date.now() - t0
      })
    }
    const end = parsePortOr(args.end ?? settings.scanEnd, DEFAULT_SCAN_END)
    if (end === null) {
      return fail('BAD_PARAM', `end 非法：需为 1~65535 的整数，收到 ${describePortValue(args.end)}`, {
        ms: Date.now() - t0
      })
    }
    if (end < start) {
      return fail('BAD_PARAM', `端口范围非法：${start}-${end}`, { ms: Date.now() - t0 })
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
    // 端口必须显式且合法：缺失时不再兜底到 2000（那会静默连上一台不是你想要的设备）
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

export const sshConnect: ToolSpec<{
  host: string
  port?: number
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
  name?: string
}> = {
  name: 'ssh_connect',
  description:
    '通过 SSH 连接设备（可连 eNSP 虚拟设备 127.0.0.1 端口 或任意实验设备）。' +
    '认证用 password 或 privateKey（OpenSSH/PEM 文本），二选一。' +
    '返回设备信息；连接成功的设备 id 形如 ssh:host:port，后续 exec_command 等按设备 id 工作。',
  risk: 'read',
  scope: 'device',
  schema: Type.Object(
    {
      host: Type.String({ description: 'SSH 主机地址，如 192.168.1.10 或 127.0.0.1' }),
      port: Type.Optional(Type.Integer({ description: 'SSH 端口，默认 22', default: 22 })),
      username: Type.String({ description: 'SSH 登录用户名' }),
      password: Type.Optional(Type.String({ description: '密码认证；与 privateKey 二选一' })),
      privateKey: Type.Optional(
        Type.String({ description: '私钥文本（OpenSSH/PEM）；与 password 二选一' })
      ),
      passphrase: Type.Optional(Type.String({ description: '私钥口令（私钥已加密时）' })),
      name: Type.Optional(Type.String({ description: '可选设备别名' }))
    },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    const d = result.data as Device | undefined
    return `SSH 连接 ${args.username}@${args.host}:${args.port ?? 22}${d?.model ? `（${d.model}）` : ''}`
  },
  handler: async (args, ctx) => {
    const t0 = Date.now()
    const host = args.host.trim()
    const password = args.password?.trim() ?? ''
    const key = args.privateKey?.trim() ?? ''
    if (!host) return fail('BAD_PARAM', 'SSH 主机地址不能为空', { ms: Date.now() - t0 })
    if (!args.username.trim()) return fail('BAD_PARAM', 'SSH 用户名不能为空', { ms: Date.now() - t0 })
    if (!password && !key) {
      return fail('BAD_PARAM', 'SSH 认证需要 password 或 privateKey', { ms: Date.now() - t0 })
    }
    const port = parsePortOr(args.port, DEFAULT_SSH_PORT)
    if (port === null) {
      return fail(
        'BAD_PARAM',
        `port 非法：需为 1~65535 的整数，收到 ${describePortValue(args.port)}`,
        { ms: Date.now() - t0 }
      )
    }
    const auth = key
      ? {
          type: 'privateKey' as const,
          key,
          ...(args.passphrase ? { passphrase: args.passphrase } : {})
        }
      : { type: 'password' as const, password }
    try {
      const device = await ctx.sessions.connectSsh({
        host,
        port,
        username: args.username.trim(),
        auth,
        ...(args.name ? { name: args.name } : {})
      })
      return ok(device, { ms: Date.now() - t0, deviceId: device.id })
    } catch (e) {
      return fail('NOT_CONNECTED', (e as Error).message, { ms: Date.now() - t0 })
    }
  }
}

export const sshList: ToolSpec<Record<string, never>> = {
  name: 'ssh_list',
  description: '列出已保存的 SSH 连接（只返回名称/主机/端口/用户名，不含密码）。',
  risk: 'read',
  scope: 'local',
  schema: Type.Object({}),
  summarize: (result) => {
    const c = result.data as { connections?: unknown[] } | undefined
    return `已保存 SSH 连接 ${c?.connections?.length ?? 0} 条`
  },
  handler: async (_args, ctx) => {
    const t0 = Date.now()
    return ok(
      { connections: ctx.sshCredentials?.() ?? [] },
      { ms: Date.now() - t0 }
    )
  }
}
