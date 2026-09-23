import type { ToolResult } from '@shared/types'
import { isReadOnlyCommand } from '@shared/risk'
import { fail, failFromCommand, ok, Type, type ToolSpec } from './registry'

/**
 * 只读交互类工具。
 *
 * 与源项目 send_command 的关键区别：
 * 1. run_show_command 有**白名单前缀硬约束**，不依赖提示词约束模型
 * 2. 返回的是结构化 CommandResult（含 settled / view / errorCode），不是裸字符串
 * 3. get_device_context 是聚合工具，一次拿全上下文，省代理往返与 token
 */

interface InterfaceRow {
  name: string
  ip?: string
  mask?: string
  status: string
  protocol: string
}

/** 解析 `display ip interface brief` 的表格行 */
export function parseInterfaces(text: string): InterfaceRow[] {
  const rows: InterfaceRow[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    if (/^Interface\s/i.test(t)) continue
    if (/^[-=]+$/.test(t)) continue
    const m = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*$/.exec(t)
    if (!m) continue
    const [, name, ipRaw, status, protocol] = m
    if (!name || !/^[A-Za-z]/.test(name)) continue
    const ipPart = ipRaw === 'unassigned' ? undefined : ipRaw
    const [ip, mask] = ipPart ? ipPart.split('/') : [undefined, undefined]
    rows.push({
      name,
      ...(ip ? { ip } : {}),
      ...(mask ? { mask } : {}),
      status: status ?? '',
      protocol: protocol ?? ''
    })
  }
  return rows
}

export const getDeviceContext: ToolSpec<{ deviceId: string }> = {
  name: 'get_device_context',
  description:
    '一次获取设备的完整上下文：型号、VRP 版本、当前提示符与视图、接口列表与状态。' +
    '需要了解设备现状时优先用本工具，不要逐条发 display 命令。',
  risk: 'read',
  scope: 'device',
  schema: Type.Object(
    { deviceId: Type.String({ description: '设备 ID，形如 127.0.0.1:2008' }) },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    const d = result.data as { model?: string; interfaces?: unknown[] } | undefined
    return `读取 ${args.deviceId} 上下文${d?.model ? `（${d.model}）` : ''}`
  },
  handler: async (args, ctx) => {
    const t0 = Date.now()
    const session = ctx.sessions.get(args.deviceId)
    if (!session) {
      return fail('NOT_CONNECTED', `设备未连接：${args.deviceId}`, { ms: Date.now() - t0 })
    }

    const version = await session.exec('display version', { ...(ctx.signal ? { signal: ctx.signal } : {}) })
    const ifBrief = await session.exec('display ip interface brief', {
      ...(ctx.signal ? { signal: ctx.signal } : {})
    })

    if (!version.ok) {
      return failFromCommand(version, 'UNKNOWN', {
        ms: Date.now() - t0,
        deviceId: args.deviceId,
        settled: version.settled
      })
    }

    const model = session.model ?? ''
    const vrpVersion = session.vrpVersion ?? ''
    const interfaces = ifBrief.ok ? parseInterfaces(ifBrief.clean) : []

    return ok(
      {
        id: session.id,
        name: session.name,
        ...(model ? { model } : {}),
        ...(vrpVersion ? { vrpVersion } : {}),
        prompt: version.prompt,
        view: version.view,
        encoding: session.encoding,
        interfaceBriefOk: ifBrief.ok,
        interfaces
      },
      { ms: Date.now() - t0, deviceId: args.deviceId, settled: version.settled }
    )
  }
}

export const runShowCommand: ToolSpec<{ deviceId: string; command: string }> = {
  name: 'run_show_command',
  description:
    '在设备上执行只读命令（display / show / dir / more / ping / tracert 开头）。' +
    '返回清洗后的回显、当前视图与成败判定。修改配置需使用配置类工具。',
  risk: 'read',
  scope: 'device',
  schema: Type.Object(
    {
      deviceId: Type.String({ description: '设备 ID' }),
      command: Type.String({ description: '只读命令，如 display ospf peer' })
    },
    { additionalProperties: false }
  ),
  summarize: (args, result) => `${args.command} → ${result.ok ? '成功' : '失败'}`,
  handler: async (args, ctx) => {
    const t0 = Date.now()
    const session = ctx.sessions.get(args.deviceId)
    if (!session) {
      return fail('NOT_CONNECTED', `设备未连接：${args.deviceId}`, { ms: Date.now() - t0 })
    }

    // 硬约束：不依赖提示词约束模型
    if (!isReadOnlyCommand(args.command)) {
      return fail(
        'NOT_ALLOWED_IN_READ_MODE',
        `只读模式不允许该命令：${args.command.slice(0, 40)}。如需修改配置，请使用配置类工具。`,
        { ms: Date.now() - t0, deviceId: args.deviceId }
      )
    }

    const r = await session.exec(args.command, { ...(ctx.signal ? { signal: ctx.signal } : {}) })
    const meta = { ms: Date.now() - t0, deviceId: args.deviceId, settled: r.settled }

    if (!r.ok) {
      return {
        ok: false,
        error: { code: r.errorCode ?? 'UNKNOWN', message: r.error ?? '命令执行失败', raw: r.clean },
        meta
      }
    }

    return ok(
      {
        clean: r.clean,
        prompt: r.prompt,
        view: r.view,
        settled: r.settled,
        ...(r.hasWarning ? { hasWarning: true } : {}),
        ...(r.truncated ? { truncated: true } : {}),
        ...(r.decodeIssues ? { decodeIssues: true } : {}),
        ...(r.awaitingConfirm ? { awaitingConfirm: true, confirmText: r.confirmText } : {})
      },
      meta
    )
  }
}

export const answerDevicePrompt: ToolSpec<{ deviceId: string; answer: 'y' | 'n'; reason: string }> = {
  name: 'answer_device_prompt',
  description:
    '应答设备当前的交互确认提示（[Y/N]、[Y/N]: 一类）。' +
    '仅当上一条工具结果带 awaitingConfirm=true 时使用：无挂起提示时调用会被拒绝（NO_PENDING_PROMPT），' +
    '以免把 y / n 当成普通命令打进当前视图。' +
    '应答 y 可能触发不可逆操作（删文件 / 清配置），属 danger，需人工闸门批准。',
  risk: 'danger',
  scope: 'device',
  schema: Type.Object(
    {
      deviceId: Type.String({ description: '设备 ID' }),
      answer: Type.Union([Type.Literal('y'), Type.Literal('n')], {
        description: '应答内容：y 继续执行该操作，n 取消'
      }),
      reason: Type.String({ description: '应答意图说明，用于闸门弹窗与执行轨迹' })
    },
    { additionalProperties: false }
  ),
  summarize: (args, result) =>
    result.ok ? `应答 ${args.deviceId} 确认提示：${args.answer}` : `应答 ${args.deviceId} 失败`,
  handler: async (args, ctx) => {
    const t0 = Date.now()
    const session = ctx.sessions.get(args.deviceId)
    if (!session) {
      return fail('NOT_CONNECTED', `设备未连接：${args.deviceId}`, { ms: Date.now() - t0 })
    }

    const raw = typeof args.answer === 'string' ? args.answer.trim().toLowerCase() : ''
    if (raw !== 'y' && raw !== 'n') {
      return fail('BAD_PARAM', `answer 必须为 'y' 或 'n'，收到 ${JSON.stringify(args.answer)}`, {
        ms: Date.now() - t0,
        deviceId: args.deviceId
      })
    }
    if (!args.reason?.trim()) {
      return fail('BAD_PARAM', '请提供 reason 说明本次应答的意图', {
        ms: Date.now() - t0,
        deviceId: args.deviceId
      })
    }

    /*
     * 关键不变量：没有挂起提示时绝不下发。
     *
     * 通信层把「confirmPaused 状态下的下一次 exec」当成显式应答并插到队首（R6），
     * 所以只有在挂起时这条命令才真的是「对该提示的回答」；否则它会被当成一条
     * 普通命令打进当前视图（`y` → Error: Unrecognized command），并顺带污染队列顺序。
     */
    if (!session.isAwaitingConfirm) {
      return fail(
        'NO_PENDING_PROMPT',
        '设备当前没有等待应答的确认提示。请先执行触发提示的命令，并确认其返回 awaitingConfirm=true 后再应答。',
        { ms: Date.now() - t0, deviceId: args.deviceId }
      )
    }

    const confirmText = session.awaitingConfirmText
    const r = await session.exec(raw, {
      timeoutMs: 15000,
      ...(ctx.signal ? { signal: ctx.signal } : {})
    })

    // 应答后设备又停在另一处提示（例如二次确认）：如实上报，让代理决定是否再应答
    if (r.awaitingConfirm) {
      return {
        ok: false,
        error: {
          code: 'INCOMPLETE',
          message:
            `已应答「${raw}」，但设备随即停在另一处确认提示：${r.confirmText ?? '[Y/N]'}。` +
            '设备仍处于等待应答状态，请确认后再用本工具应答。'
        },
        data: {
          answered: raw,
          confirmText,
          nextPrompt: r.confirmText,
          clean: r.clean.slice(0, 8000)
        } as never,
        meta: { ms: Date.now() - t0, deviceId: args.deviceId, settled: r.settled }
      }
    }
    if (!r.ok) {
      return failFromCommand(r, 'FAILED', {
        ms: Date.now() - t0,
        deviceId: args.deviceId,
        settled: r.settled
      })
    }

    return ok(
      {
        answered: raw,
        confirmText,
        clean: r.clean.slice(0, 8000),
        prompt: r.prompt,
        view: r.view
      } as never,
      { ms: Date.now() - t0, deviceId: args.deviceId, settled: r.settled }
    )
  }
}

export const saveConfigSnapshot: ToolSpec<{ deviceId: string; label?: string }> = {
  name: 'save_config_snapshot',

  description:
    '采集设备当前运行配置并存为快照（只读设备，写本地库）。任何配置变更前都应先做快照。' +
    '若回显超过设备上限被截断，快照会标注 snapshotComplete:false —— 这类快照不能作为回滚基线。',
  risk: 'read',
  scope: 'local',
  schema: Type.Object(
    {
      deviceId: Type.String({ description: '设备 ID' }),
      label: Type.Optional(Type.String({ description: '快照标签，说明这是什么时候的配置' }))
    },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    const d = result.data as { hashShort?: string } | undefined
    return `快照 ${args.deviceId}${d?.hashShort ? ` (${d.hashShort})` : ''}`
  },
  handler: async (args, ctx) => {
    const t0 = Date.now()
    const session = ctx.sessions.get(args.deviceId)
    if (!session) {
      return fail('NOT_CONNECTED', `设备未连接：${args.deviceId}`, { ms: Date.now() - t0 })
    }
    const r = await session.exec('display current-configuration', {
      timeoutMs: 30000,
      ...(ctx.signal ? { signal: ctx.signal } : {})
    })
    if (!r.ok) {
      return failFromCommand(r, 'FAILED', { ms: Date.now() - t0, deviceId: args.deviceId })
    }
    // D3：截断 / 解码有损的快照仍入库，但标注为不可作回滚基线
    const complete = !r.truncated && !r.decodeIssues
    const meta = ctx.snapshots.save(
      args.deviceId,
      r.clean,
      args.label ?? `自动快照 ${new Date().toLocaleString('zh-CN')}`,
      { complete }
    )
    return ok({ ...meta, snapshotComplete: meta.complete }, {
      ms: Date.now() - t0,
      deviceId: args.deviceId
    })
  }
}

export const listSnapshots: ToolSpec<{ deviceId: string }> = {
  name: 'list_snapshots',
  description: '列出指定设备的配置快照。',
  risk: 'read',
  scope: 'local',
  schema: Type.Object(
    { deviceId: Type.String({ description: '设备 ID' }) },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    const d = result.data as { snapshots?: unknown[] } | undefined
    return `${args.deviceId} 快照 ${d?.snapshots?.length ?? 0} 份`
  },
  handler: async (args, ctx) => {
    const t0 = Date.now()
    return ok({ snapshots: ctx.snapshots.list(args.deviceId) }, { ms: Date.now() - t0 })
  }
}

/**
 * 与快照做行级 diff。
 * 用朴素的最长公共子序列太重，这里用「行集合差 + 顺序保持」的轻量算法：
 * 对配置这种以行为独立语义单位的文本足够准确，且不会在大文件上爆性能。
 */
export function diffLines(oldText: string, newText: string): { added: string[]; removed: string[] } {
  const oldLines = oldText.split('\n').map((l) => l.trimEnd())
  const newLines = newText.split('\n').map((l) => l.trimEnd())
  const oldSet = new Map<string, number>()
  for (const l of oldLines) oldSet.set(l, (oldSet.get(l) ?? 0) + 1)
  const newSet = new Map<string, number>()
  for (const l of newLines) newSet.set(l, (newSet.get(l) ?? 0) + 1)

  const added: string[] = []
  for (const [line, count] of newSet) {
    const before = oldSet.get(line) ?? 0
    if (count > before) added.push(line)
  }
  const removed: string[] = []
  for (const [line, count] of oldSet) {
    const after = newSet.get(line) ?? 0
    if (count > after) removed.push(line)
  }
  return { added, removed }
}

export const diffWithSnapshot: ToolSpec<{ deviceId: string; snapshotId?: string }> = {
  name: 'diff_with_snapshot',
  description: '把设备当前运行配置与指定快照（默认最近一份）做对比，看出改了什么。',
  risk: 'read',
  scope: 'device',
  schema: Type.Object(
    {
      deviceId: Type.String({ description: '设备 ID' }),
      snapshotId: Type.Optional(Type.String({ description: '快照 ID，不传则用最近一份' }))
    },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    const d = result.data as { changed?: boolean } | undefined
    return `对比 ${args.deviceId}：${d?.changed ? '有变化' : '无变化'}`
  },
  handler: async (args, ctx) => {
    const t0 = Date.now()
    const session = ctx.sessions.get(args.deviceId)
    if (!session) {
      return fail('NOT_CONNECTED', `设备未连接：${args.deviceId}`, { ms: Date.now() - t0 })
    }
    const snap = args.snapshotId
      ? ctx.snapshots.get(args.deviceId, args.snapshotId)
      : ctx.snapshots.latest(args.deviceId)
    if (!snap) {
      return fail('NO_SNAPSHOT', '该设备还没有任何快照，请先采集快照', {
        ms: Date.now() - t0,
        deviceId: args.deviceId
      })
    }
    const oldText = ctx.snapshots.read(args.deviceId, snap.id)
    if (oldText === null) {
      return fail('NO_SNAPSHOT', `快照正文缺失：${snap.id}`, {
        ms: Date.now() - t0,
        deviceId: args.deviceId
      })
    }
    const r = await session.exec('display current-configuration', {
      timeoutMs: 30000,
      ...(ctx.signal ? { signal: ctx.signal } : {})
    })
    if (!r.ok) {
      return failFromCommand(r, 'FAILED', { ms: Date.now() - t0, deviceId: args.deviceId })
    }
    const { added, removed } = diffLines(oldText, r.clean)
    return ok(
      {
        snapshotId: snap.id,
        changed: added.length > 0 || removed.length > 0,
        added,
        removed
      } as ToolResult['data'],
      { ms: Date.now() - t0, deviceId: args.deviceId }
    )
  }
}
