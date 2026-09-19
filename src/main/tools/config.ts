import type { CommandResult, DeviceId, Expectation, ExpectationMode, ToolResult } from '@shared/types'
import { classifyDanger } from '@shared/risk'
import { genRollbackCommands } from '../core/rollback'
import { diffLines } from './command'
import { fail, failFromCommand, ok, Type, type ToolSpec } from './registry'

/**
 * 配置变更类工具（v0.2/F-4.x）。
 *
 * 与只读工具的分层原则（TOOLS.md §3）：
 * | risk    | 策略 |
 * |---------|------|
 * | write   | 强制先快照 → 事务下发 → 期望校验 → 失败可回滚 |
 * | danger  | 人工闸门，等待显式批准 |
 *
 * apply_config 与 restore_snapshot 共用同一条「下发」管道（executeCommands）：
 * 危险扫描 → 进系统视图 → 逐条下发读回显判定 → 任一失败即停。
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const EXPECTATION_MODES: readonly ExpectationMode[] = ['contains', 'notContains', 'regex']

const expectationMode = Type.Union([
  Type.Literal('contains'),
  Type.Literal('notContains'),
  Type.Literal('regex')
])

/** 判断回显是否满足期望。模式非法抛出，正则非法抛出 SyntaxError。 */
export function checkExpectation(
  clean: string,
  exp: { expect: string; mode: ExpectationMode }
): boolean {
  switch (exp.mode) {
    case 'contains':
      return clean.includes(exp.expect)
    case 'notContains':
      return !clean.includes(exp.expect)
    case 'regex':
      return new RegExp(exp.expect, 'i').test(clean)
  }
}

function isExpectation(v: unknown): v is Expectation {
  if (!v || typeof v !== 'object') return false
  const e = v as Expectation
  if (typeof e.command !== 'string' || !e.command.trim()) return false
  if (typeof e.expect !== 'string' || !e.expect.trim()) return false
  return EXPECTATION_MODES.includes(e.mode)
}

interface StepFailed {
  index: number
  command: string
  errorCode: string
  error: string
}

interface ExecOutcome {
  applied: string[]
  failed?: StepFailed
  blockedCommand?: string
  sysViewError?: string
}

/**
 * 下发管道（apply / restore 共用）：
 * 1. 逐条危险扫描，命中即整体拦截（TOOLS.md「拦在 ToolRegistry 执行前」）
 * 2. 进入系统视图（幂等；已在该视图时重复进入无害）
 * 3. 逐条下发，每条读回显判定成败，任一失败即停止
 */
async function executeCommands(
  session: { exec(cmd: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<CommandResult> },
  commands: string[],
  signal: AbortSignal | undefined
): Promise<ExecOutcome> {
  for (let i = 0; i < commands.length; i++) {
    const c = commands[i]!
    if (classifyDanger(c).dangerous) {
      return { applied: [], blockedCommand: c }
    }
  }

  const sys = await session.exec('system-view', { ...(signal ? { signal } : {}) })
  if (!sys.ok) {
    return { applied: [], sysViewError: sys.error ?? '无法进入系统视图' }
  }

  const applied: string[] = []
  for (let i = 0; i < commands.length; i++) {
    const c = commands[i]!
    const r = await session.exec(c, {
      timeoutMs: 15000,
      ...(signal ? { signal } : {})
    })
    if (!r.ok) {
      return {
        applied,
        failed: { index: i, command: c, errorCode: r.errorCode ?? 'FAILED', error: r.error ?? '命令执行失败' }
      }
    }
    applied.push(c)
  }
  return { applied }
}

/** 跑期望校验：按 times 重试（用于等待协议收敛），返回最终判定与原始回显 */
async function runExpectation(
  session: { exec(cmd: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<CommandResult> },
  exp: Expectation,
  signal: AbortSignal | undefined
): Promise<{ pass: boolean; actual: string; invalid?: boolean }> {
  const times = Math.max(1, Math.min(10, exp.times ?? 1))
  let last = ''
  for (let i = 0; i < times; i++) {
    const r = await session.exec(exp.command, {
      timeoutMs: 15000,
      ...(signal ? { signal } : {})
    })
    if (r.ok) {
      last = r.clean
      let pass: boolean
      try {
        pass = checkExpectation(r.clean, exp)
      } catch {
        return { pass: false, actual: r.clean, invalid: true }
      }
      if (pass) return { pass: true, actual: r.clean }
    }
    if (i < times - 1) await sleep(500)
  }
  return { pass: false, actual: last }
}

const metaOf = (t0: number, deviceId: DeviceId, settled?: CommandResult['settled']): ToolResult['meta'] => ({
  ms: Date.now() - t0,
  ...(deviceId ? { deviceId } : {}),
  ...(settled ? { settled } : {})
})

// ———————————————————— apply_config ————————————————————

export const applyConfig: ToolSpec<{
  deviceId: string
  commands: string[]
  description: string
  expectation?: Expectation
  snapshotId?: string
}> = {
  name: 'apply_config',
  description:
    '下发配置变更集（核心写工具）。自动先采集快照 → 逐条下发 → 每条读回显判定成败 → ' +
    '全部成功后再用 expectation 校验。任一命令失败立即停止并返回失败点，不自动回滚，由你判断修正或回滚。' +
    '变更前请先用 get_device_context 了解设备现状。',
  risk: 'write',
  scope: 'device',
  schema: Type.Object(
    {
      deviceId: Type.String({ description: '设备 ID' }),
      commands: Type.Array(Type.String(), {
        description: '按顺序下发的配置命令（会先自动进入系统视图，无需带 system-view）'
      }),
      description: Type.String({ description: '变更意图说明，用于展示与变更记录' }),
      expectation: Type.Optional(
        Type.Object(
          {
            command: Type.String({ description: '校验命令，如 display ospf peer' }),
            expect: Type.String({ description: '期望内容（contains 子串 / regex 正则）' }),
            mode: expectationMode,
            times: Type.Optional(Type.Number({ description: '重试次数（含首次），用于等待收敛' }))
          },
          { description: '期望校验：全部命令下发成功后执行的验证' }
        )
      ),
      snapshotId: Type.Optional(Type.String({ description: '指定作为回滚依据的快照 ID；不传则自动采集一份' }))
    },
    { additionalProperties: false }
  ),
  summarize: (_args, result) => {
    if (!result.ok) return result.error?.message ?? '下发失败'
    const d = result.data as { applied?: unknown[]; verified?: boolean } | undefined
    const verifiedFlag = d?.verified === false ? '，未达期望' : ''
    return `下发 ${d?.applied?.length ?? 0} 条配置 → 成功${verifiedFlag}`
  },
  handler: async (args, ctx) => {
    const t0 = Date.now()
    const deviceId = args.deviceId
    const session = ctx.sessions.get(deviceId)
    if (!session) {
      return fail('NOT_CONNECTED', `设备未连接：${deviceId}`, metaOf(t0, deviceId))
    }

    const commands = Array.isArray(args.commands)
      ? args.commands.map((c) => String(c).trim()).filter((c) => c.length > 0)
      : []
    if (!commands.length) return fail('BAD_PARAM', 'commands 不能为空', metaOf(t0, deviceId))
    if (!args.description?.trim()) {
      return fail('BAD_PARAM', '请提供 description 说明变更意图', metaOf(t0, deviceId))
    }
    if (args.expectation !== undefined && !isExpectation(args.expectation)) {
      return fail('BAD_PARAM', 'expectation 非法：需提供 command/expect/mode', metaOf(t0, deviceId))
    }

    const description = args.description.trim()
    let snapshotId = args.snapshotId
    let snapshotText: string | null = null
    if (!snapshotId) {
      const cur = await session.exec('display current-configuration', {
        timeoutMs: 30000,
        ...(ctx.signal ? { signal: ctx.signal } : {})
      })
      if (!cur.ok) {
        return fail('NO_SNAPSHOT', `快照采集失败：${cur.error ?? '命令执行失败'}`, metaOf(t0, deviceId))
      }
      snapshotText = cur.clean
      snapshotId = ctx.snapshots.save(
        deviceId,
        cur.clean,
        `变更前快照：${description.slice(0, 40)}`
      ).id
    } else if (!ctx.snapshots.get(deviceId, snapshotId)) {
      return fail('NO_SNAPSHOT', `快照不存在：${snapshotId}`, metaOf(t0, deviceId))
    } else {
      snapshotText = ctx.snapshots.read(deviceId, snapshotId)
    }

    const log = (result: 'ok' | 'failed' | 'blocked', extra?: Partial<Parameters<typeof ctx.changes.add>[0]>): void => {
      ctx.changes.add({
        deviceId,
        kind: 'apply',
        actor: 'agent',
        description,
        snapshotId,
        commands,
        ...(args.expectation ? { expectation: args.expectation } : {}),
        result,
        ...(extra ?? {})
      })
    }

    // 危险扫描：在快照建立后、真正下发前拦截（写操作前置条件已满足）
    const execOutcome = await executeCommands(session, commands, ctx.signal)
    if (execOutcome.blockedCommand) {
      log('blocked', {
        error: { code: 'DANGER_COMMAND_BLOCKED', message: `命令命中危险清单，已拦截：${execOutcome.blockedCommand}` }
      })
      return fail(
        'DANGER_COMMAND_BLOCKED',
        `命令命中危险清单，已拦截：${execOutcome.blockedCommand}`,
        metaOf(t0, deviceId)
      )
    }
    if (execOutcome.sysViewError) {
      return fail('FAILED', `无法进入系统视图：${execOutcome.sysViewError}`, metaOf(t0, deviceId))
    }

    const meta = metaOf(t0, deviceId)
    if (execOutcome.failed) {
      const f = execOutcome.failed
      log('failed', {
        verified: false,
        error: { code: f.errorCode, message: f.error }
      })
      return {
        ok: false,
        error: { code: f.errorCode, message: f.error },
        data: {
          applied: execOutcome.applied,
          failed: f,
          snapshotId
        } as never,
        meta
      }
    }

    // 全部下发成功 → 期望校验
    let verified: boolean | undefined
    let actual: string | undefined
    if (args.expectation) {
      const e = await runExpectation(session, args.expectation, ctx.signal)
      verified = e.pass
      actual = e.actual
      if (e.invalid) {
        log('failed', { verified: false, error: { code: 'BAD_PARAM', message: '期望校验的命令无法执行或正则非法' } })
        return fail('BAD_PARAM', 'expectation 非法：校验命令无法执行或正则非法', meta)
      }
      if (!e.pass) {
        log('failed', { verified: false, error: { code: 'EXPECTATION_UNMET', message: '期望校验未通过' } })
        return {
          ok: false,
          error: { code: 'EXPECTATION_UNMET', message: '配置已下发但未达到期望状态，请修正或回滚' },
          data: { applied: execOutcome.applied, snapshotId, verified: false, actual } as never,
          meta
        }
      }
    }

    // 变更前后 diff（供变更记录与报告）
    let diff: { added: string[]; removed: string[] } | undefined
    if (snapshotText !== null) {
      const after = await session.exec('display current-configuration', {
        timeoutMs: 30000,
        ...(ctx.signal ? { signal: ctx.signal } : {})
      })
      if (after.ok) diff = diffLines(snapshotText, after.clean)
    }

    log('ok', { verified: verified ?? true })
    return ok(
      {
        applied: execOutcome.applied,
        snapshotId,
        ...(args.expectation ? { verified: verified ?? false } : {}),
        ...(diff ? { diff } : {})
      } as never,
      meta
    )
  }
}

// ———————————————————— verify_expectation ————————————————————

export const verifyExpectation: ToolSpec<{
  deviceId: string
  command: string
  expect: string
  mode: ExpectationMode
  times?: number
}> = {
  name: 'verify_expectation',
  description:
    '执行一条命令并断言回显是否满足期望（contains / notContains / regex），' +
    '可选重试等待协议收敛。用于变更后的状态验证。',
  risk: 'read',
  scope: 'device',
  schema: Type.Object(
    {
      deviceId: Type.String({ description: '设备 ID' }),
      command: Type.String({ description: '校验命令，如 display ospf peer' }),
      expect: Type.String({ description: '期望内容' }),
      mode: expectationMode,
      times: Type.Optional(Type.Number({ description: '重试次数（含首次），默认 1' }))
    },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    const d = result.data as { pass?: boolean } | undefined
    return `校验 ${args.command} → ${d?.pass ? '通过' : '未通过'}`
  },
  handler: async (args, ctx) => {
    const t0 = Date.now()
    const deviceId = args.deviceId
    const session = ctx.sessions.get(deviceId)
    if (!session) {
      return fail('NOT_CONNECTED', `设备未连接：${deviceId}`, metaOf(t0, deviceId))
    }
    if (!EXPECTATION_MODES.includes(args.mode)) {
      return fail('BAD_PARAM', `mode 非法：${args.mode}`, metaOf(t0, deviceId))
    }
    const exp: Expectation = {
      command: args.command,
      expect: args.expect,
      mode: args.mode,
      ...(Number.isFinite(args.times) ? { times: args.times } : {})
    }
    const r = await runExpectation(session, exp, ctx.signal)
    if (r.invalid) {
      return fail('BAD_PARAM', '正则表达式无效，无法校验', metaOf(t0, deviceId))
    }
    return ok({ pass: r.pass, actual: r.actual.slice(0, 8000) } as never, metaOf(t0, deviceId))
  }
}

// ———————————————————— restore_snapshot ————————————————————

export const restoreSnapshot: ToolSpec<{ deviceId: string; snapshotId?: string; reason: string }> = {
  name: 'restore_snapshot',
  description:
    '把设备配置回滚到指定快照（默认最近一份）。自动对比当前配置生成撤销命令并下发。' +
    '主动回滚会触发人工确认闸门；同一任务内 apply_config 失败后的自动回滚走内部路径不弹窗。',
  risk: 'write',
  scope: 'device',
  schema: Type.Object(
    {
      deviceId: Type.String({ description: '设备 ID' }),
      snapshotId: Type.Optional(Type.String({ description: '目标快照 ID，不传则用最近一份' })),
      reason: Type.String({ description: '回滚原因，用于变更记录' })
    },
    { additionalProperties: false }
  ),
  summarize: (args, result) =>
    result.ok ? `回滚 ${args.deviceId}（应用 ${((result.data as { appliedCommands?: number })?.appliedCommands ?? 0)} 条）` : '回滚失败',
  handler: async (args, ctx) => {
    const t0 = Date.now()
    const deviceId = args.deviceId
    const session = ctx.sessions.get(deviceId)
    if (!session) {
      return fail('NOT_CONNECTED', `设备未连接：${deviceId}`, metaOf(t0, deviceId))
    }
    if (!args.reason?.trim()) {
      return fail('BAD_PARAM', '请提供 reason 说明回滚原因', metaOf(t0, deviceId))
    }

    const snap = args.snapshotId
      ? ctx.snapshots.get(deviceId, args.snapshotId)
      : ctx.snapshots.latest(deviceId)
    if (!snap) {
      return fail('NO_SNAPSHOT', '该设备没有可用快照，无法回滚', metaOf(t0, deviceId))
    }
    const snapText = ctx.snapshots.read(deviceId, snap.id)
    if (snapText === null) {
      return fail('NO_SNAPSHOT', `快照正文缺失：${snap.id}`, metaOf(t0, deviceId))
    }

    const cur = await session.exec('display current-configuration', {
      timeoutMs: 30000,
      ...(ctx.signal ? { signal: ctx.signal } : {})
    })
    if (!cur.ok) {
      return failFromCommand(cur, 'FAILED', metaOf(t0, deviceId))
    }

    const plan = genRollbackCommands(snapText, cur.clean)
    const meta = metaOf(t0, deviceId)

    const log = (result: 'ok' | 'failed' | 'rejected'): void => {
      ctx.changes.add({
        deviceId,
        kind: 'restore',
        actor: 'agent',
        snapshotId: snap.id,
        description: args.reason.trim(),
        commands: plan.commands,
        result,
        verified: result === 'ok',
        ...(result === 'failed'
          ? { error: { code: 'FAILED', message: '回滚命令执行失败' } }
          : {})
      })
    }

    if (!plan.commands.length) {
      log('ok')
      return ok({ ok: true, appliedCommands: 0, upToDate: true } as never, meta)
    }

    // 主动回滚必须经人工确认（TOOLS.md §4.3 restore_snapshot 的闸门策略）
    const approved = await ctx.requestGate({
      toolName: 'restore_snapshot',
      deviceId,
      args,
      reason: `回滚 ${deviceId} 到快照「${snap.label}」`,
      consequence:
        '将撤销自该快照以来此设备上的全部配置变更。若期间有人手工改动过配置，也会被一并覆盖。'
    })
    if (!approved) {
      log('rejected')
      return fail('GATE_REJECTED', '用户拒绝了回滚操作', meta)
    }

    const outcome = await executeCommands(session, plan.commands, ctx.signal)
    if (outcome.blockedCommand) {
      return fail('DANGER_COMMAND_BLOCKED', `回滚命令命中危险清单，已中断：${outcome.blockedCommand}`, meta)
    }
    if (outcome.sysViewError) {
      return fail('FAILED', `无法进入系统视图：${outcome.sysViewError}`, meta)
    }
    if (outcome.failed) {
      const f = outcome.failed
      log('failed')
      return {
        ok: false,
        error: { code: f.errorCode, message: f.error },
        data: { appliedCommands: outcome.applied.length, failed: f, applied: outcome.applied } as never,
        meta
      }
    }

    log('ok')
    return ok(
      {
        ok: true,
        appliedCommands: outcome.applied.length,
        applied: outcome.applied,
        diff: { added: plan.added, removed: plan.removed }
      } as never,
      meta
    )
  }
}

// ———————————————————— save_configuration ————————————————————

export const saveConfiguration: ToolSpec<{ deviceId: string }> = {
  name: 'save_configuration',
  description:
    '把当前运行配置保存为启动配置（danger 操作，需人工闸门批准）。' +
    'VRP 的 save 会触发 [Y/N] 确认，本工具获批后代为应答。',
  risk: 'danger',
  scope: 'device',
  schema: Type.Object(
    { deviceId: Type.String({ description: '设备 ID' }) },
    { additionalProperties: false }
  ),
  summarize: () => '保存配置到启动配置',
  handler: async (args, ctx) => {
    const t0 = Date.now()
    const deviceId = args.deviceId
    const session = ctx.sessions.get(deviceId)
    if (!session) {
      return fail('NOT_CONNECTED', `设备未连接：${deviceId}`, metaOf(t0, deviceId))
    }

    const r = await session.exec('save', {
      timeoutMs: 15000,
      ...(ctx.signal ? { signal: ctx.signal } : {})
    })
    let okFlag = r.ok
    let errorText = r.error
    let errorCode = r.errorCode
    if (okFlag && r.awaitingConfirm) {
      const y = await session.exec('y', {
        timeoutMs: 5000,
        ...(ctx.signal ? { signal: ctx.signal } : {})
      })
      okFlag = y.ok
      errorText = y.error
      errorCode = y.errorCode
    }

    const latest = ctx.snapshots.latest(deviceId)
    ctx.changes.add({
      deviceId,
      kind: 'save',
      actor: 'agent',
      ...(latest ? { snapshotId: latest.id } : {}),
      description: '保存配置到启动配置',
      commands: ['save'],
      result: okFlag ? 'ok' : 'failed',
      ...(okFlag ? {} : { error: { code: errorCode ?? 'FAILED', message: errorText ?? '保存失败' } })
    })

    if (!okFlag) {
      return fail(errorCode ?? 'FAILED', errorText ?? '保存失败', metaOf(t0, deviceId))
    }
    return ok({ saved: true } as never, metaOf(t0, deviceId))
  }
}