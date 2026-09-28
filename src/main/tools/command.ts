import type { ToolResult, ViewKind } from '@shared/types'
import { isReadOnlyCommand, isViewNavigationCommand } from '@shared/risk'
import { viewLabel } from '../core/telnet/prompt'
import {
  ensureSystemView,
  ensureUserView,
  enterInterfaceView,
  isSafeInterfaceName,
  normalizeViewTarget
} from '../core/session/viewNav'
import { fail, failFromCommand, ok, withDeviceLock, Type, type ToolSpec } from './registry'
import { explainVrpError } from '../core/knowledge/vrp-errors'

/**
 * 只读交互类工具。
 *
 * 与源项目 send_command 的关键区别：
 * 1. run_show_command 有**白名单前缀硬约束**，不依赖提示词约束模型
 * 2. 返回的是结构化 CommandResult（含 settled / view / errorCode），不是裸字符串
 * 3. get_device_context 是聚合工具，一次拿全上下文，省代理往返与 token
 * 4. v2.24 起视图切换有专属工具 change_view —— quit / return 不再无处可去
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
  concurrencySafe: true,
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
  concurrencySafe: true,
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
      /*
       * v2.24：`quit` / `return` 是视图切换命令，模型想退视图时最容易把它们塞进本工具。
       * 直接回「只读模式不允许」等于把模型堵死（它会反复换工具试），所以这里把它
       * 明确指到 change_view —— 那条路会按**当前视图**生成最少命令，而裸下发做不到
       * （同一句 `quit` 在系统视图与接口视图里去的地方不同）。
       */
      if (isViewNavigationCommand(args.command)) {
        return fail(
          'NOT_ALLOWED_IN_READ_MODE',
          `「${args.command.trim().slice(0, 20)}」是视图切换命令，本工具只收只读命令` +
            '（display / show / dir / more / ping / tracert）。' +
            "请改用 change_view 工具：target 取 'user'（回用户视图）/ 'system'（进系统视图）/" +
            "'interface'（进指定接口视图，需给 interfaceName）；它按当前视图生成最少命令且幂等。",
          { ms: Date.now() - t0, deviceId: args.deviceId }
        )
      }
      return fail(
        'NOT_ALLOWED_IN_READ_MODE',
        `只读模式不允许该命令：${args.command.slice(0, 40)}。如需修改配置，请使用配置类工具。`,
        { ms: Date.now() - t0, deviceId: args.deviceId }
      )
    }

    const r = await session.exec(args.command, { ...(ctx.signal ? { signal: ctx.signal } : {}) })
    const meta = { ms: Date.now() - t0, deviceId: args.deviceId, settled: r.settled }

    if (!r.ok) {
      /*
       * v2.27：只读查询失败同样带修正线索。`display` 命令报 Unrecognized 的高频原因是
       * 「该型号/版本没有这条 display」或「命令拼写不对」，而模型的默认反应是把同一句
       * 再发一遍 —— 附上错误码对应的根因与纠正，让它换个查法（或换 lookup_vrp_command 查证）。
       */
      const diagnosis = explainVrpError(r.errorCode, args.command)
      const failed: ToolResult = {
        ok: false,
        error: {
          code: r.errorCode ?? 'UNKNOWN',
          message: (r.error ?? '命令执行失败') + (diagnosis ? `\n诊断提示：${diagnosis.hint}` : ''),
          raw: r.clean
        },
        meta
      }
      return diagnosis ? { ...failed, data: { diagnosis: diagnosis.guide } } : failed
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

/**
 * 视图切换（v2.24）。
 *
 * 存在的理由：`quit` / `return` / `system-view` 是**相对导航**，而模型过去的两个选择都不对 ——
 * `run_show_command` 把它们挡在只读白名单外（报错），`apply_config` 会先被顶到系统视图
 * 再执行 `quit`（于是「退一层」变成「回用户视图」，报成功但去错地方）。
 *
 * 这里刻意收**语义目标**而不是裸命令（target = user / system / interface）：
 * 从目标视图反推「现在要发哪几条命令」是工具的责任 —— 它知道会话跟踪的当前视图，
 * 模型不知道（它只看到上一次调用返回的 view 字符串，可能已被交互终端改掉）。
 */
export const changeView: ToolSpec<{
  deviceId: string
  target: 'user' | 'system' | 'interface'
  interfaceName?: string
}> = {
  name: 'change_view',
  description:
    '切换设备的当前视图（等价于手工敲 quit / return / system-view / interface）。' +
    "target='user' → 用户视图（return）；'system' → 系统视图（system-view，已在则跳过）；" +
    "'interface' → 指定接口视图（需同时给 interfaceName，如 GigabitEthernet 0/0/1）。" +
    '幂等：已在目标视图时不发任何命令（返回 changed=false）。' +
    '视图切换不修改任何配置，只读探索阶段也能调用。' +
    '注意 run_show_command 只收 display / show / dir / more / ping / tracert，不要用它发 quit / return。',
  risk: 'read',
  scope: 'device',
  /*
   * 刻意**不声明** concurrencySafe：视图是有状态的东西 ——
   * 若允许它与相邻的只读调用并行，同一批里「导航 + 读」的先后就不再确定，
   * 而下游命令是否有效完全取决于当前视图。缺省 false = 并发屏障（见 registry 的说明）。
   */
  schema: Type.Object(
    {
      deviceId: Type.String({ description: '设备 ID，形如 127.0.0.1:2008' }),
      target: Type.Union(
        [Type.Literal('user'), Type.Literal('system'), Type.Literal('interface')],
        {
          description:
            "目标视图：'user' 用户视图 / 'system' 系统视图 / 'interface' 接口视图（需配 interfaceName）"
        }
      ),
      interfaceName: Type.Optional(
        Type.String({
          description: "target='interface' 时的接口名，如 GigabitEthernet 0/0/1（也接受 GE0/0/1）"
        })
      )
    },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    if (!result.ok) return result.error?.message ?? '切换视图失败'
    const d = result.data as { changed?: boolean; view?: ViewKind } | undefined
    const label =
      args?.target === 'interface' && args?.interfaceName
        ? `接口视图 ${args.interfaceName}`
        : viewLabel(d?.view ?? 'other')
    return d?.changed ? `切到${label}` : `已在${label}，无需切换`
  },
  // 多步导航（可能要 return → system-view → interface），必须独占设备：
  // 否则与 apply_config 的事务交错会让事务的下一条命令落在错误的视图里
  handler: withDeviceLock('change_view', async (args, ctx) => {
    const t0 = Date.now()
    const deviceId = typeof args?.deviceId === 'string' ? args.deviceId.trim() : ''
    if (!deviceId) return fail('BAD_PARAM', '缺少 deviceId', { ms: Date.now() - t0 })

    const session = ctx.sessions.get(deviceId)
    if (!session) return fail('NOT_CONNECTED', `设备未连接：${deviceId}`, { ms: Date.now() - t0, deviceId })

    const target = normalizeViewTarget(args?.target)
    if (!target) {
      return fail(
        'BAD_PARAM',
        `target 非法：${JSON.stringify(args?.target)}。只能是 user / system / interface`,
        { ms: Date.now() - t0, deviceId }
      )
    }

    // 接口名会被拼进下发命令 —— 先校验再发任何字节（连 ensureSystemView 也不许提前跑）
    const ifaceName = typeof args?.interfaceName === 'string' ? args.interfaceName.trim() : ''
    if (target === 'interface') {
      if (!ifaceName) {
        return fail(
          'BAD_PARAM',
          "target='interface' 时必须给 interfaceName，如 GigabitEthernet 0/0/1",
          { ms: Date.now() - t0, deviceId }
        )
      }
      if (!isSafeInterfaceName(ifaceName)) {
        return fail(
          'BAD_PARAM',
          `接口名不合法：${ifaceName.slice(0, 60)}。只接受形如 GigabitEthernet 0/0/1 / GE0/0/1 的` +
            '接口名（字母开头，可含数字与 / . - : 及词间空格），不得含换行、管道符、分号等字符。',
          { ms: Date.now() - t0, deviceId }
        )
      }
    }

    const from: ViewKind = session.view ?? 'other'
    const outcome =
      target === 'user'
        ? await ensureUserView(session, ctx.signal)
        : target === 'interface'
          ? await enterInterfaceView(session, ifaceName, ctx.signal)
          : await ensureSystemView(session, ctx.signal)

    const view: ViewKind = outcome.last?.view ?? session.view ?? 'other'
    const meta = {
      ms: Date.now() - t0,
      deviceId,
      ...(outcome.last ? { settled: outcome.last.settled } : {})
    }

    if (!outcome.ok) {
      return {
        ok: false,
        error: {
          code: outcome.errorCode ?? 'FAILED',
          message:
            `切换视图失败（当前 ${viewLabel(from)} → 目标 ${viewLabel(viewOfTarget(target))}）：` +
            `${outcome.error ?? '未知原因'}。已下发的命令：${outcome.commands.join(' → ') || '无'}。` +
            '请用 get_device_context 确认设备当前视图与提示符后再决定下一步。',
          ...(outcome.last?.clean ? { raw: outcome.last.clean } : {})
        },
        data: {
          deviceId,
          from,
          target,
          view,
          commands: outcome.commands
        } as never,
        meta
      }
    }

    return ok(
      {
        deviceId,
        from,
        target,
        view,
        /** 是否真的下发了命令（false = 设备本来就在目标视图，幂等跳过） */
        changed: outcome.commands.length > 0,
        commands: outcome.commands,
        ...(outcome.last?.prompt ? { prompt: outcome.last.prompt } : {}),
        ...(outcome.stale ? { trackingStale: true } : {}),
        clean: (outcome.last?.clean ?? '').slice(0, 4000)
      } as never,
      meta
    )
  })
}

/** 目标视图 → ViewKind（只为错误文案里的中文标签） */
function viewOfTarget(target: 'user' | 'system' | 'interface'): ViewKind {
  return target === 'interface' ? 'interface' : target
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
  concurrencySafe: true,
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

/** H（v2.14）：分色对比卡落盘的**单侧最大行数**（超过则只留前 N 行 + 总数） */
export const DIFF_CARD_LIMIT = 40

export const diffWithSnapshot: ToolSpec<{ deviceId: string; snapshotId?: string }> = {
  name: 'diff_with_snapshot',
  description: '把设备当前运行配置与指定快照（默认最近一份）做对比，看出改了什么。',
  risk: 'read',
  scope: 'device',
  concurrencySafe: true,
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
  /**
   * H（v2.14）：把「改了哪几行」落进会话树，供回放/演示模式重画分色对比卡。
   *
   * 为什么要截断：整份配置全换时 `added`/`removed` 可能有上千行，超过 `cardMetaOf`
   * 的 4000 字符上限会被**整块丢弃** —— 卡片凭空消失，比「只显示前 40 行 + 总数」糟得多。
   */
  presentationMeta: (args, result) => {
    const d = result.data as
      | { snapshotId?: string; changed?: boolean; added?: string[]; removed?: string[] }
      | undefined
    if (!result.ok || !d) return undefined
    const added = d.added ?? []
    const removed = d.removed ?? []
    return {
      deviceId: args.deviceId,
      ...(d.snapshotId ? { snapshotId: d.snapshotId } : {}),
      changed: d.changed === true,
      added: added.slice(0, DIFF_CARD_LIMIT),
      removed: removed.slice(0, DIFF_CARD_LIMIT),
      addedTotal: added.length,
      removedTotal: removed.length
    }
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
