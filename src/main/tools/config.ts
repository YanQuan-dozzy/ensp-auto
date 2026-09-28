import type {
  CommandResult,
  DeviceId,
  Expectation,
  ExpectationMode,
  ToolResult
} from '@shared/types'
import { classifyDanger, isReadOnlyCommand, isViewNavigationCommand } from '@shared/risk'
import { genRollbackCommands } from '../core/rollback'
import { explainVrpError, preflightCommands } from '../core/knowledge/vrp-errors'
import { ensureSystemView, type NavSession } from '../core/session/viewNav'
import { diffLines } from './command'
import {
  fail,
  failFromCommand,
  ok,
  withDeviceLock,
  Type,
  type ToolSpec
} from './registry'

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

/** N15：regex 模式期望表达式的长度上限（超长正则只可能来自模型臆造，直接拒绝） */
const MAX_EXPECT_REGEX_LEN = 200

/**
 * N15：灾难性回溯的高风险形态 —— 量词作用于「内部已含量词的分组」，如 `(a+)+`、`(\w*)*`。
 *
 * 为什么必须拦：`checkExpectation` 的正则跑在**主进程线程**上，输入是设备回显
 * （`apply_config` 的 display current-configuration 可达数十万字符，且用户可指定任意内容）。
 * 灾难性回溯会直接冻结窗口与整个任务，而且**不会抛异常** —— 现有针对非法正则的
 * `SyntaxError` 兜底挡不住它。
 *
 * 代价：少数复杂但无害的正则会被一并拒绝。对「变更后的状态校验」这种场景，期望值本该是
 * 简单子串/正则，值得用这点保守换掉一次冻结。**已知残余**：`(a|a)+` 这类重叠分支交替
 * 量词不在此启发式覆盖内（检测它需要误杀 `(up|down)+` 这类常见合法写法）。
 */
const NESTED_QUANTIFIER_RE = /\([^()]*[+*][^()]*\)\s*(?:[+*]|\{\d)/

/** regex 模式的安全闸：长度上限 + 嵌套量词启发式。不安全抛 SyntaxError（与非法正则同口径） */
function assertSafeRegex(pattern: string): void {
  if (pattern.length > MAX_EXPECT_REGEX_LEN) {
    throw new SyntaxError(`期望正则过长（${pattern.length} > ${MAX_EXPECT_REGEX_LEN} 字符）`)
  }
  if (NESTED_QUANTIFIER_RE.test(pattern)) {
    throw new SyntaxError('期望正则含嵌套量词（形如 (a+)+），可能造成灾难性回溯，已拒绝')
  }
}

const expectationMode = Type.Union([
  Type.Literal('contains'),
  Type.Literal('notContains'),
  Type.Literal('regex')
])

/** 判断回显是否满足期望。模式非法抛出，正则非法（或过于危险）抛出 SyntaxError。 */
export function checkExpectation(
  clean: string,
  exp: { expect: string; mode: ExpectationMode }
): boolean {
  switch (exp.mode) {
    case 'contains':
      return clean.includes(exp.expect)
    case 'notContains':
      return !clean.includes(exp.expect)
    case 'regex': {
      // N15：先过安全闸再编译（contains / notContains 不做正则，天然无回溯风险）
      assertSafeRegex(exp.expect)
      return new RegExp(exp.expect, 'i').test(clean)
    }
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

/** 设备停在 [Y/N] 之类的确认提示上：本条命令未生效，后续命令也不能再下发 */
interface StepAwaitingConfirm {
  index: number
  command: string
  prompt?: string
}

interface ExecOutcome {
  applied: string[]
  failed?: StepFailed
  blockedCommand?: string
  sysViewError?: string
  awaitingConfirm?: StepAwaitingConfirm
}

/** 下发/校验管道共用的最小会话面（见 core/session/viewNav 的 NavSession） */
type ExecSession = NavSession

/**
 * 「整批命令只有一条视图切换命令」= 工具选错了，必须显式拒绝（v2.24）。
 *
 * 为什么不能照发：本工具的契约是「先把设备带到系统视图，再逐条下发」，于是同一句 `quit`
 * 在这里的含义与模型写下它时的意图**不同** —— 模型想「从接口视图退一层」，实际执行的是
 * 「从系统视图退回用户视图」，而且工具**报成功**、返回里还不带视图字段，从结果里看不出来
 * （下游命令是否有效完全取决于当前视图，于是错误会以「莫名其妙 Unrecognized」的形式晚点浮现）。
 * 切视图请走 `change_view`。
 *
 * 为什么只拦「仅此一条」：批量下发**中间**的 `quit` 是合法且必要的写法
 * （`interface X` → 配置 → `quit` → 再进另一个视图，见 core/tasks/plans.ts 与
 * core/lab/templates.ts），它们相对系统视图的位置是确定的，不能一并拒掉。
 */
export function loneViewNavCommand(commands: readonly string[]): string | null {
  if (commands.length !== 1) return null
  const only = commands[0]!.trim()
  return isViewNavigationCommand(only) ? only : null
}

/**
 * 把设备带到系统视图（下发管道第 2 步）。
 *
 * v2.24：实现已抽到 `core/session/viewNav.ts#ensureSystemView` —— 与 `change_view`
 * 工具共用同一份判定（「怎么算到了系统视图」只能有一处真相），行为不变。
 */

/**
 * 下发管道（apply / restore 共用）：
 * 1. 逐条危险扫描，命中即整体拦截（TOOLS.md「拦在 ToolRegistry 执行前」）
 * 2. 确保处于系统视图（已在该视图则跳过，子视图先 `return` —— 见 ensureSystemView）
 * 3. 逐条下发，每条读回显判定成败，任一失败即停止
 * 4. 命中设备确认提示（[Y/N]）立即停止 —— 绝不自作主张应答（决策 D3 = 停止并上报），
 *    也不继续下发后续命令：此时设备把任何输入都当成对提示的回答。
 */
async function executeCommands(
  session: ExecSession,
  commands: string[],
  signal: AbortSignal | undefined
): Promise<ExecOutcome> {
  for (let i = 0; i < commands.length; i++) {
    const c = commands[i]!
    if (classifyDanger(c).dangerous) {
      return { applied: [], blockedCommand: c }
    }
  }

  const sys = await ensureSystemView(session, signal)
  if (!sys.ok) {
    return { applied: [], sysViewError: sys.error }
  }

  const applied: string[] = []
  for (let i = 0; i < commands.length; i++) {
    const c = commands[i]!
    const r = await session.exec(c, {
      timeoutMs: 15000,
      ...(signal ? { signal } : {})
    })
    if (r.awaitingConfirm) {
      return {
        applied,
        awaitingConfirm: {
          index: i,
          command: c,
          ...(r.confirmText ? { prompt: r.confirmText } : {})
        }
      }
    }
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
): Promise<{ pass: boolean; actual: string; invalid?: boolean; reason?: string }> {
  /*
   * N2 / N13：expectation.command 来自模型参数，而本函数既被 risk:'read' 的
   * verify_expectation 直接调用，也被 apply_config 复用。工具级 risk 挡不住参数级
   * 任意命令 —— 不在这里兜底，就等于「以只读身份执行任意命令」：
   * ① 计划模式的 PLAN_MODE_READONLY 硬约束被架空（它只按工具级 risk 判）；
   * ② 对外 MCP 出口只过滤 danger 工具，同一条旁路被绕过。
   * 校验命令本就只能是只读命令，这里同时做危险扫描与只读白名单两道强校验。
   */
  const danger = classifyDanger(exp.command)
  if (danger.dangerous) {
    return {
      pass: false,
      actual: '',
      invalid: true,
      reason: `校验命令命中危险清单，已拒绝：${danger.reason ?? exp.command}`
    }
  }
  if (!isReadOnlyCommand(exp.command)) {
    return {
      pass: false,
      actual: '',
      invalid: true,
      reason: `校验命令必须是只读命令（display / show / dir / more / ping / tracert）：${exp.command}`
    }
  }
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
      } catch (e) {
        // 正则非法 / 过于危险（N15）→ 带出具体原因，别只回一句「无效」
        return {
          pass: false,
          actual: r.clean,
          invalid: true,
          reason: `期望校验的表达式不可用：${e instanceof Error ? e.message : String(e)}`
        }
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
    '返回里会带 `preflight`（下发前的静态预检：反掩码/掩码互换、全角字符、trunk 未放行等）与失败时的 ' +
    '`diagnosis`（错误码 → 常见根因 → 可照做的纠正 → 相关词典主题）—— **先按它改，不要照着原样重试同一条命令**。' +
    '变更前请先用 get_device_context 了解设备现状。',
  risk: 'write',
  scope: 'device',
  schema: Type.Object(
    {
      deviceId: Type.String({ description: '设备 ID' }),
      commands: Type.Array(Type.String(), {
        description:
          '按顺序下发的配置命令（会自动确保处于系统视图：已在系统视图则跳过；' +
          '处于接口/协议等子视图则先 return 回用户视图再进，无需带 system-view）'
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
  // D6：快照 → 下发 → 校验是多步事务，必须独占设备（execute_task / batch_configure
  // 复用本 handler，自动获得同等保护）；finally 释放，异常路径不漏锁。
  handler: withDeviceLock('apply_config', async (args, ctx) => {
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

    // 工具选错了要当场说清，而不是照发一条含义已变的命令（见 loneViewNavCommand 的说明）。
    // 放在快照之前：这类调用根本没有变更意图，不该先浪费一次配置采集。
    const loneNav = loneViewNavCommand(commands)
    if (loneNav) {
      return fail(
        'BAD_PARAM',
        `本工具会先把设备带到系统视图再逐条下发，因此单独一条「${loneNav}」在这里的含义是` +
          '「从系统视图退回用户视图」，与「退一层视图」的意图不一致 —— 而且工具会报成功，' +
          '你从结果里看不出视图已经变了。' +
          "切视图请用 change_view（target: 'user' 回用户视图 / 'system' 进系统视图 / " +
          "'interface' 进指定接口视图）。" +
          '若要在批量下发中间退视图（interface X → 配置 → quit → 再进另一个视图），' +
          '把它和其它命令放在同一次调用里即可。',
        metaOf(t0, deviceId)
      )
    }

    const description = args.description.trim()

    /*
     * 下发前静态预检（v2.27）：纯本地扫描命令集，提前点出可预见的翻车写法
     * —— 反掩码/掩码互换、全角字符、trunk 未放行、单臂路由漏 arp broadcast、save 会卡 [Y/N] 等。
     *
     * 为什么**只提示不拦截**：静态分析看不到设备上已有的配置（allow-pass 可能上一批刚配过、
     * VLAN 可能已存在），误拦一次会让正确的变更做不下去，代价远高于漏报一次。
     * 它的价值是把「可能的坑」摆到模型眼前，配合下方的错误诊断形成「配前提醒 → 配后解释」闭环。
     */
    const preflight = preflightCommands(commands)

    let snapshotId = args.snapshotId
    let snapshotText: string | null = null
    /**
     * D3（2026-09-23）：这份快照是否完整。
     *
     * 设备回显超过 maxBytes 时通信层会截断（头 256KB + 尾 256KB），而 rollback 按段
     * 解析 —— 缺中间段会让「其实存在的段」被判成新增/删除，回滚**报成功却没回到现场**。
     * 不完整快照仍入库（可查看/可 diff），但不能当回滚基线。
     */
    let snapshotComplete = true
    if (!snapshotId) {
      const cur = await session.exec('display current-configuration', {
        timeoutMs: 30000,
        ...(ctx.signal ? { signal: ctx.signal } : {})
      })
      if (!cur.ok) {
        return fail('NO_SNAPSHOT', `快照采集失败：${cur.error ?? '命令执行失败'}`, metaOf(t0, deviceId))
      }
      const complete = !cur.truncated && !cur.decodeIssues
      const saved = ctx.snapshots.save(
        deviceId,
        cur.clean,
        `变更前快照：${description.slice(0, 40)}`,
        { complete }
      )
      snapshotId = saved.id
      snapshotComplete = saved.complete
      snapshotText = cur.clean
    } else {
      const existing = ctx.snapshots.get(deviceId, snapshotId)
      if (!existing) {
        return fail('NO_SNAPSHOT', `快照不存在：${snapshotId}`, metaOf(t0, deviceId))
      }
      // 显式指定了不完整快照 = 主动选择一个不可用的回滚依据，直接拒绝而不是埋雷
      if (existing.complete === false) {
        return fail(
          'SNAPSHOT_INCOMPLETE',
          `快照 ${snapshotId} 采集时不完整（超过设备回显上限），不能作为本次变更的回滚依据；` +
            '请先用 save_config_snapshot 重新采集一份完整快照',
          metaOf(t0, deviceId)
        )
      }
      snapshotId = existing.id
      // 到这里 complete 必然不是 false（上面已提前返回）
      snapshotComplete = existing.complete
      snapshotText = ctx.snapshots.read(deviceId, existing.id)
    }
    const snapshotInfo = { snapshotId, snapshotComplete }

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

    // 设备停在 [Y/N]：上报为「半途中止」，不替用户应答、也不继续下发（决策 D3）
    if (execOutcome.awaitingConfirm) {
      const ac = execOutcome.awaitingConfirm
      const prompt = ac.prompt ?? '[Y/N]'
      log('failed', {
        verified: false,
        error: { code: 'INCOMPLETE', message: `设备停在确认提示（${prompt}），已中止下发` }
      })
      return {
        ok: false,
        error: {
          code: 'INCOMPLETE',
          message:
            `配置下发在「${ac.command}」处停在设备确认提示：${prompt}。` +
            '已中止后续命令（此时设备会把任何输入都当成对该提示的回答），' +
            '配置半途中止且未自动回滚。' +
            `请用 answer_device_prompt({ deviceId: '${deviceId}', answer: 'y' 或 'n', reason: '…' }) ` +
            '显式应答该提示（y 继续 / n 取消）后再继续下发；' +
            '在此状态下下发其他命令会被设备当成应答吃掉。'
        },
        data: {
          applied: execOutcome.applied,
          awaitingConfirm: ac,
          needsUserInput: true,
          ...(preflight.length ? { preflight } : {}),
          ...snapshotInfo
        } as never,
        meta: metaOf(t0, deviceId)
      }
    }

    const meta = metaOf(t0, deviceId)
    if (execOutcome.failed) {
      const f = execOutcome.failed
      log('failed', {
        verified: false,
        error: { code: f.errorCode, message: f.error }
      })
      /*
       * 失败即带修正线索（v2.27）：设备只回一句 `Error: Wrong parameter found at '^' position.`，
       * 信息量不足以让模型改方向 —— 实测它会照着原样重试同一句。这里把「错误码 → 常见根因 →
       * 可照做的纠正 → 相关词典主题」接在失败返回里，把一次失败变成一次定位。
       */
      const diagnosis = explainVrpError(f.errorCode, f.command)
      return {
        ok: false,
        error: {
          code: f.errorCode,
          message: f.error + (diagnosis ? `\n诊断提示：${diagnosis.hint}` : '')
        },
        data: {
          applied: execOutcome.applied,
          failed: f,
          ...(diagnosis ? { diagnosis: diagnosis.guide } : {}),
          ...(preflight.length ? { preflight } : {}),
          ...snapshotInfo
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
        const msg = e.reason ?? 'expectation 非法：校验命令无法执行或正则非法'
        log('failed', { verified: false, error: { code: 'BAD_PARAM', message: msg } })
        return fail('BAD_PARAM', msg, meta)
      }
      if (!e.pass) {
        log('failed', { verified: false, error: { code: 'EXPECTATION_UNMET', message: '期望校验未通过' } })
        return {
          ok: false,
          error: { code: 'EXPECTATION_UNMET', message: '配置已下发但未达到期望状态，请修正或回滚' },
          data: {
            applied: execOutcome.applied,
            verified: false,
            actual,
            ...(preflight.length ? { preflight } : {}),
            ...snapshotInfo
          } as never,
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
        ...snapshotInfo,
        ...(args.expectation ? { verified: verified ?? false } : {}),
        ...(diff ? { diff } : {}),
        // 成功也带预检结论：这批命令没有语法层面的风险，但静态反模式仍值得模型复核
        // （例如 trunk 未放行属于「下发成功但业务不通」，只有提示才能提前拦住）
        ...(preflight.length ? { preflight } : {})
      } as never,
      meta
    )
  })
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
  // N2：risk/concurrencySafe 成立的前提是「命令已只读校验」——由 runExpectation 内的
  // classifyDanger + isReadOnlyCommand 兜底（命令来自模型参数，工具级 risk 判不到参数级）。
  concurrencySafe: true,
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
      return fail('BAD_PARAM', r.reason ?? '正则表达式无效，无法校验', metaOf(t0, deviceId))
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
  // D6：回滚同样是多步事务（对比 → 生成撤销命令 → 逐条下发），必须独占设备
  handler: withDeviceLock('restore_snapshot', async (args, ctx) => {
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
    /*
     * D3（决策 P2 = 严格）：采集时不完整的快照不能当回滚基线。
     *
     * 截断快照缺中间段，而回滚命令是按「段」diff 出来的 —— 用缺段的基线算 diff
     * 会既可能漏撤销（残留配置）又可能误撤销（把未变更的段当新增 undo 掉），
     * 且回滚会**报成功**，事后无人能发现。宁可要求先重新采集一份完整快照。
     */
    if (snap.complete === false) {
      const fallback = ctx.snapshots
        .list(deviceId)
        .find((s) => s.complete !== false)
      return fail(
        'SNAPSHOT_INCOMPLETE',
        `快照 ${snap.id}（${snap.label}）采集时不完整（超过设备回显上限），不能作为回滚基线。` +
          (fallback
            ? `可改用更早的完整快照 ${fallback.id}（${fallback.label}），或重新采集一份完整快照。`
            : '请在设备空闲时用 save_config_snapshot 重新采集一份完整快照。'),
        metaOf(t0, deviceId)
      )
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
      return fail(
        'GATE_REJECTED',
        '回滚未获批准：用户拒绝了本次回滚，或任务已中止 / 当前出口（如 MCP）不支持人工确认',
        meta
      )
    }

    const outcome = await executeCommands(session, plan.commands, ctx.signal)
    if (outcome.blockedCommand) {
      return fail('DANGER_COMMAND_BLOCKED', `回滚命令命中危险清单，已中断：${outcome.blockedCommand}`, meta)
    }
    if (outcome.sysViewError) {
      return fail('FAILED', `无法进入系统视图：${outcome.sysViewError}`, meta)
    }
    if (outcome.awaitingConfirm) {
      const ac = outcome.awaitingConfirm
      log('failed')
      return {
        ok: false,
        error: {
          code: 'INCOMPLETE',
          message:
            `回滚在「${ac.command}」处停在设备确认提示：${ac.prompt ?? '[Y/N]'}。` +
            '已中止后续命令。' +
            `请用 answer_device_prompt({ deviceId: '${deviceId}', answer: 'y' 或 'n', reason: '…' }) ` +
            '应答该提示后再继续；直接下发其他命令会被设备当成应答吃掉。'
        },
        data: {
          appliedCommands: outcome.applied.length,
          applied: outcome.applied,
          awaitingConfirm: ac,
          needsUserInput: true
        } as never,
        meta
      }
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
  })
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