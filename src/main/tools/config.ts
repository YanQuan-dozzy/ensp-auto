import type {
  CommandResult,
  DeviceId,
  Expectation,
  ExpectationMode,
  ToolResult
} from '@shared/types'
import { classifyDanger, isReadOnlyCommand, isUserViewCommand, isViewNavigationCommand } from '@shared/risk'
import { planCommandGate } from '@shared/gate-policy'
import { genRollbackCommands } from '../core/rollback'
import { explainVrpError, preflightCommands } from '../core/knowledge/vrp-errors'
import { ensureSystemView, ensureUserView, type NavSession } from '../core/session/viewNav'
import { matchPromptTail } from '../core/telnet/prompt'
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
  /** v2.28：被策略放行的危险命令（确认框已关闭时），供调用方留痕 */
  skippedCommand?: string
  /** 视图导航失败：哪一步（用户视图 / 系统视图）+ 原因 */
  navError?: { view: 'system' | 'user'; error: string }
  awaitingConfirm?: StepAwaitingConfirm
  /**
   * v2.30：命令回显已结束但**设备没有回到提示符** —— 无法确认它真的执行完了。
   *
   * 实测翻车点（2026-09-30）：AR 路由器的确认提示写作 `(y/n)[n]`，旧 `CONFIRM_RE` 只认
   * `[Y/N]` → 通信层既不判「等待确认」也不判「回到提示符」，于是走静默兜底收尾、`ok=true`；
   * 工具随即报「下发成功」，而设备实际停在提示上，配置一个字都没清。必须把这种
   * 「收尾了但没有提示符」的状态当成未知（既不是成功也不是失败），并停止后续下发。
   */
  unsettled?: { index: number; command: string }
}

/** 下发/校验管道共用的最小会话面（见 core/session/viewNav 的 NavSession） */
type ExecSession = NavSession

/** 下发批次的目标视图（apply_config 的 view 参数）。缺省 system = 老行为 */
export type TargetView = 'system' | 'user'

const TARGET_VIEWS: readonly TargetView[] = ['system', 'user']

/** 归一化模型给的 view 参数：只认 system / user，其余（含缺省）一律 system */
export function normalizeTargetView(raw: unknown): TargetView {
  return typeof raw === 'string' && (TARGET_VIEWS as readonly string[]).includes(raw.trim().toLowerCase())
    ? (raw.trim().toLowerCase() as TargetView)
    : 'system'
}

/**
 * v2.30：回显尾部**看起来像提示符**吗（与宿主名无关的形状判定）。
 *
 * 为什么需要它来兜住「状态未知」的判据：通信层的提示符判定带**宿主名约束**（防误判），
 * 而像 `[Huawei-ip-pool-vlan10]` 这种「宿主名后面还接了 '-' 段」的合法子视图提示符会被
 * 拆成 host=`Huawei-ip-pool` + suffix=`vlan10`，与锁定的宿主名不符 → 判定失败，
 * 于是这类**成功**的命令也会落到 `settled:'quiet'`、`prompt:''`。
 * 若只看「有没有 prompt」就会把它们误报成 UNSETTLED（DHCP 池视图实测如此）。
 * 形状判定是关键区分：设备停在提示符上（只是没被锁定）与设备停在未识别的交互提示上，
 * 尾部完全不同 —— 前者是一行括号/尖括号提示符，后者是 `xxx? (y/n):` 这类问句收尾。
 */
function tailLooksLikePrompt(r: CommandResult): boolean {
  const tail = (r.clean ?? '').trimEnd()
  if (!tail) return false
  return matchPromptTail(tail) !== null
}

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
 * 下发管道（apply / restore 共用）：
 * 1. 逐条危险扫描，命中即整体拦截（TOOLS.md「拦在 ToolRegistry 执行前」）
 * 2. 把设备带到目标视图（v2.30 起可指定）：
 *    - `view: 'system'`（缺省）→ `ensureSystemView`。已在系统视图则跳过，子视图先 `return`
 *    - `view: 'user'` → `ensureUserView`。用于 `reset saved-configuration` / `reboot` 这类
 *      **只认用户视图**的命令：过去它们必然在系统视图下报 Unrecognized，模型被迫自己
 *      在命令里夹一条 `return`（实测 2026-09-30 的「清空 15 台配置」为此空跑 15 次 + 8 次试错）
 * 3. 逐条下发，每条读回显判定成败，任一失败即停止
 * 4. 命中设备确认提示（[Y/N]）立即停止 —— 绝不自作主张应答（决策 D3 = 停止并上报），
 *    也不继续下发后续命令：此时设备把任何输入都当成对提示的回答。
 * 5. v2.30：回显收尾了却**没有提示符** → 判为 `unsettled` 并停止。见 ExecOutcome.unsettled
 *
 * v2.28（2026-09-28）：第 1 步的**取舍**由 `planCommandGate` 决定 ——
 * 用户关掉「危险操作需人工确认」后，命令级清单同步放行（与界面横幅一致），
 * 但**多行命令永不放行**（那是判定的前提，不是分类）。`skippedCommand` 回传被放行的
 * 那条命令，供调用方在轨迹里标注「哪一层被松开了」。
 */
async function executeCommands(
  session: ExecSession,
  commands: string[],
  signal: AbortSignal | undefined,
  /** 设置里的「危险操作需人工确认」；缺省 true = 保守拦截（fake ctx / 老调用方不受影响） */
  confirmDanger = true,
  /** 本批命令在哪个视图下发（apply_config 的 view）；缺省 system = 老行为 */
  targetView: TargetView = 'system'
): Promise<ExecOutcome> {
  // 被策略放行的危险命令（用于在轨迹里标注「命令级清单已被松开」）
  let skippedCommand: string | undefined
  for (let i = 0; i < commands.length; i++) {
    const c = commands[i]!
    const verdict = classifyDanger(c)
    const gate = planCommandGate({
      dangerous: verdict.dangerous,
      ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
      multiLine: verdict.multiLine === true,
      confirmDanger
    })
    if (gate.kind === 'block') {
      return { applied: [], blockedCommand: c }
    }
    if (gate.note) skippedCommand ??= c
  }

  const nav =
    targetView === 'user'
      ? await ensureUserView(session, signal)
      : await ensureSystemView(session, signal)
  if (!nav.ok) {
    return { applied: [], navError: { view: targetView, error: nav.error ?? '无法切换视图' } }
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
    /*
     * v2.30：收尾了但没有提示符 → 设备状态未知，立即停止。
     * 为什么不能放过：此时设备很可能停在某个未被识别的交互提示上，后续命令会被当成
     * 对该提示的应答吃掉（静默改错状态，且回显看起来完全正常）。见 ExecOutcome.unsettled。
     * `tailLooksLikePrompt` 兜住「提示符其实是好的、只是没被宿主名锁定」这一类（否则会误报）。
     */
    if (r.settled !== 'prompt' && !r.prompt && !tailLooksLikePrompt(r)) {
      return { applied, unsettled: { index: i, command: c } }
    }
    applied.push(c)
  }
  return { applied, ...(skippedCommand ? { skippedCommand } : {}) }
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
  view?: 'system' | 'user'
  expectation?: Expectation
  snapshotId?: string
}> = {
  name: 'apply_config',
  description:
    '下发配置变更集（核心写工具）。自动先采集快照 → 逐条下发 → 每条读回显判定成败 → ' +
    '全部成功后再用 expectation 校验。任一命令失败立即停止并返回失败点，不自动回滚，由你判断修正或回滚。' +
    '返回里会带 `preflight`（下发前的静态预检：反掩码/掩码互换、全角字符、trunk 未放行等）与失败时的 ' +
    '`diagnosis`（错误码 → 常见根因 → 可照做的纠正 → 相关词典主题）—— **先按它改，不要照着原样重试同一条命令**。' +
    '变更前请先用 get_device_context 了解设备现状。' +
    '⚠️ 本工具默认先把设备带到**系统视图**；`reset saved-configuration` / `reboot` 这类' +
    "**用户视图**命令必须显式传 view:'user'（或在清启动配置时改用 reset_saved_configuration），" +
    '否则必然报 Unrecognized command。',
  risk: 'write',
  scope: 'device',
  schema: Type.Object(
    {
      deviceId: Type.String({ description: '设备 ID' }),
      commands: Type.Array(Type.String(), {
        description:
          '按顺序下发的配置命令（自动把设备带到 view 指定的视图：已在则跳过；' +
          '处于子视图则先 return 回用户视图再进，无需自己带 system-view）'
      }),
      description: Type.String({ description: '变更意图说明，用于展示与变更记录' }),
      view: Type.Optional(
        Type.Union([Type.Literal('system'), Type.Literal('user')], {
          description:
            "命令将在哪个视图下发（默认 'system'）。用户视图命令（reset saved-configuration / " +
            "reset current-configuration / reboot）必须传 'user' —— 本工具会先 return 回用户视图"
        })
      ),
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

    /*
     * v2.30：本批在哪个视图下发。缺省 system（老行为不变）；
     * view:'user' 给用户视图命令（reset saved-configuration / reboot）用 ——
     * 没有这条通道时它们必然报 Unrecognized，模型只能自己往命令里夹 `return`。
     */
    const targetView = normalizeTargetView(args.view)

    // 工具选错了要当场说清，而不是照发一条含义已变的命令（见 loneViewNavCommand 的说明）。
    // 放在快照之前：这类调用根本没有变更意图，不该先浪费一次配置采集。
    const loneNav = loneViewNavCommand(commands)
    if (loneNav) {
      const navTo = targetView === 'user' ? '用户视图' : '系统视图'
      return fail(
        'BAD_PARAM',
        `本工具会先把设备带到${navTo}再逐条下发，因此单独一条「${loneNav}」在这里的含义与` +
          '「退一层视图」的意图不一致 —— 而且工具会报成功，你从结果里看不出视图已经变了。' +
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
     * —— 反掩码/掩码互换、全角字符、trunk 未放行、单臂路由漏 arp broadcast、save 会卡 [Y/N]，
     * 以及 v2.30 新增的「用户视图命令落在系统视图批次里」（必然 Unrecognized）。
     *
     * 为什么**只提示不拦截**：静态分析看不到设备上已有的配置（allow-pass 可能上一批刚配过、
     * VLAN 可能已存在），误拦一次会让正确的变更做不下去，代价远高于漏报一次。
     * 它的价值是把「可能的坑」摆到模型眼前，配合下方的错误诊断形成「配前提醒 → 配后解释」闭环。
     */
    const preflight = preflightCommands(commands, { view: targetView })

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

    /*
     * 危险扫描：在快照建立后、真正下发前拦截（写操作前置条件已满足）。
     *
     * v2.28：`commandGateRelease` 为真时命令级清单同步放行（决策 D1 的延伸）——
     * 用户已显式接受「无回滚的破坏性操作」，此时再硬拦 reboot 就是「关了开关还拦」。
     * ★ 该资格**只由应用内代理出口**给出（见 ToolContext.commandGateRelease）：
     * 对外 MCP 出口没有确认 UI，缺省 false，清单照拦 —— 否则本机的一次「关确认框」
     * 会顺带放行远程客户端的破坏性命令。
     * 多行命令例外，永远拦（见 planCommandGate）。
     * 放行的事实由 tool_end 摘要标注（`COMMAND_GATE_SKIPPED_NOTE`），变更记录只记业务结果。
     */
    const confirmDanger = ctx.commandGateRelease !== true
    const execOutcome = await executeCommands(session, commands, ctx.signal, confirmDanger, targetView)
    if (execOutcome.blockedCommand) {
      const blocked = `命令命中危险清单，已拦截：${execOutcome.blockedCommand}`
      log('blocked', { error: { code: 'DANGER_COMMAND_BLOCKED', message: blocked } })
      return fail('DANGER_COMMAND_BLOCKED', blocked, metaOf(t0, deviceId))
    }
    if (execOutcome.navError) {
      const which = execOutcome.navError.view === 'user' ? '用户视图' : '系统视图'
      return fail('FAILED', `无法切换到${which}：${execOutcome.navError.error}`, metaOf(t0, deviceId))
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

    /*
     * v2.30：回显收尾了却没有提示符 —— 既不能报成功（命令可能压根没执行），
     * 也不能当失败（设备只是慢）。按「状态未知」上报并停止，让模型先取证。
     * 实测：AR 路由器的 `(y/n)[n]` 提示漏判时，这里曾经返回 ok=true，是 AR3 假成功的出口。
     */
    if (execOutcome.unsettled) {
      const u = execOutcome.unsettled
      const diagnosis = explainVrpError('UNSETTLED', u.command)
      log('failed', {
        verified: false,
        error: { code: 'UNSETTLED', message: `设备未回到提示符，无法确认「${u.command}」已执行` }
      })
      return {
        ok: false,
        error: {
          code: 'UNSETTLED',
          message:
            `命令「${u.command}」的回显已结束，但设备**没有回到提示符** —— 无法确认它真的执行完了，` +
            '已停止后续命令。' +
            (diagnosis ? `\n诊断提示：${diagnosis.hint}` : '') +
            `\n先取证：get_device_context({ deviceId: '${deviceId}' }) 看提示符与视图是否正常；` +
            '若提示符缺失/异常，到该设备的交互终端人工确认后再继续。'
        },
        data: {
          applied: execOutcome.applied,
          unsettled: u,
          ...(diagnosis ? { diagnosis: diagnosis.guide } : {}),
          ...(preflight.length ? { preflight } : {}),
          ...snapshotInfo
        } as never,
        meta
      }
    }

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
      /*
       * v2.30：用户视图命令在系统视图下报的 Unrecognized，与「拼写错 / 版本不支持」长得一模一样，
       * 通用诊断只会让模型去改拼写。这里在通用提示**之前**点破真正的原因与改法。
       */
      const viewHint =
        targetView === 'system' && isUserViewCommand(f.command)
          ? `「${f.command}」是用户视图命令，而本批在系统视图下下发 —— 请给 apply_config 传 ` +
            "view:'user'（或在清启动配置时改用 reset_saved_configuration）后重发。\n"
          : ''
      return {
        ok: false,
        error: {
          code: f.errorCode,
          message: viewHint + f.error + (diagnosis ? `\n诊断提示：${diagnosis.hint}` : '')
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
        ...(preflight.length ? { preflight } : {}),
        // v2.28：确认框关闭时被放行的危险命令（运行时据此在 tool_end 摘要里留痕）
        ...(execOutcome.skippedCommand ? { skippedCommand: execOutcome.skippedCommand } : {})
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

    // v2.28：命令级清单同样受「危险操作需人工确认」开关管辖（与 apply_config 一致）。
    // 缺省 = 保守拦截：单测的 fake ctx / 对外 MCP 出口都没有这个资格。
    const outcome = await executeCommands(
      session,
      plan.commands,
      ctx.signal,
      ctx.commandGateRelease !== true
    )
    if (outcome.blockedCommand) {
      return fail('DANGER_COMMAND_BLOCKED', `回滚命令命中危险清单，已中断：${outcome.blockedCommand}`, meta)
    }
    if (outcome.navError) {
      const which = outcome.navError.view === 'user' ? '用户视图' : '系统视图'
      return fail('FAILED', `无法切换到${which}：${outcome.navError.error}`, meta)
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
    // v2.30：与 apply_config 同一口径 —— 回显收尾了却没有提示符，不能报回滚成功
    if (outcome.unsettled) {
      const u = outcome.unsettled
      log('failed')
      const diagnosis = explainVrpError('UNSETTLED', u.command)
      return {
        ok: false,
        error: {
          code: 'UNSETTLED',
          message:
            `回滚命令「${u.command}」的回显已结束，但设备没有回到提示符 —— 无法确认它真的执行完了，` +
            '已停止后续命令。' +
            (diagnosis ? `\n诊断提示：${diagnosis.hint}` : '') +
            `\n先取证：get_device_context({ deviceId: '${deviceId}' }) 看提示符与视图是否正常。`
        },
        data: { appliedCommands: outcome.applied.length, unsettled: u, applied: outcome.applied } as never,
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

// ———————————————————— reset_saved_configuration ————————————————————

/**
 * v2.30：清空启动配置的专属出口。
 *
 * 为什么需要它：`reset saved-configuration` 是**用户视图**命令 + 会弹 `[Y/N]` 确认，
 * 于是经 `apply_config` 走就是「先必然 Unrecognized（视图不对）→ 换了写法又停在提示上 →
 * 再补一次 answer_device_prompt」的三步，实测在 15 台设备上把一次简单任务拖成 30 次调用，
 * 还因为路由器提示写法不同（`(y/n)[n]`）在一台上假成功。这与 `save_configuration`
 * 的处境完全一样，故按同一口径做成 danger 工具：**过人工闸门 → 自己把设备带到用户视图
 * → 下发 → 应答自己触发的那次 [Y/N]**。
 *
 * 与 `answer_device_prompt` 的分工（决策 D3 不破）：本工具只应答**它自己刚触发的**提示，
 * 且必须已过闸门；应答「设备上已挂起的任意提示」仍然只能走 answer_device_prompt。
 */
export const resetSavedConfiguration: ToolSpec<{ deviceId: string; reason: string }> = {
  name: 'reset_saved_configuration',
  description:
    '清空设备的启动配置（等价手工在用户视图敲 reset saved-configuration）。' +
    '这是 danger 操作，需人工闸门批准；获批后本工具会先 return 回用户视图再下发，' +
    '并在设备弹出 [Y/N] 确认时代为应答 y。' +
    '注意语义：清空的是**启动配置**，设备重启后才会变成空配置；当前运行配置仍然生效。' +
    '若要立即清空运行配置，需另用 apply_config(view: \'user\') 发 reset current-configuration。',
  risk: 'danger',
  scope: 'device',
  schema: Type.Object(
    {
      deviceId: Type.String({ description: '设备 ID' }),
      reason: Type.String({ description: '清空原因，用于闸门弹窗与变更记录' })
    },
    { additionalProperties: false }
  ),
  summarize: (args, result) =>
    result.ok ? `清空 ${args.deviceId} 启动配置` : `清空 ${args.deviceId} 启动配置失败`,
  handler: withDeviceLock('reset_saved_configuration', async (args, ctx) => {
    const t0 = Date.now()
    const deviceId = args.deviceId
    const session = ctx.sessions.get(deviceId)
    if (!session) {
      return fail('NOT_CONNECTED', `设备未连接：${deviceId}`, metaOf(t0, deviceId))
    }
    if (!args.reason?.trim()) {
      return fail('BAD_PARAM', '请提供 reason 说明清空原因', metaOf(t0, deviceId))
    }
    const reason = args.reason.trim()
    const command = 'reset saved-configuration'

    const log = (result: 'ok' | 'failed', error?: { code: string; message: string }): void => {
      const latest = ctx.snapshots.latest(deviceId)
      ctx.changes.add({
        deviceId,
        kind: 'apply',
        actor: 'agent',
        ...(latest ? { snapshotId: latest.id } : {}),
        description: reason,
        commands: [command],
        result,
        ...(error ? { error } : {})
      })
    }

    // 第 1 步：用户视图（这条命令只认用户视图，且用户视图不认 return，故导航是幂等的）
    const nav = await ensureUserView(session, ctx.signal)
    if (!nav.ok) {
      const message = `无法切换到用户视图：${nav.error ?? '未知原因'}`
      log('failed', { code: nav.errorCode ?? 'FAILED', message })
      return fail(nav.errorCode ?? 'FAILED', message, metaOf(t0, deviceId))
    }

    // 第 2 步：下发
    const r = await session.exec(command, {
      timeoutMs: 15000,
      ...(ctx.signal ? { signal: ctx.signal } : {})
    })

    // 第 3 步：应答本条命令自己触发的确认提示（仅此一次，且只在获批后走到这里）
    let after = r
    let answered = false
    if (r.awaitingConfirm) {
      answered = true
      after = await session.exec('y', {
        timeoutMs: 15000,
        ...(ctx.signal ? { signal: ctx.signal } : {})
      })
    }

    if (after.awaitingConfirm) {
      const next = after.confirmText ?? '[Y/N]'
      const message =
        `已应答「y」，但设备随即停在另一处确认提示：${next}。设备仍处于等待应答状态，` +
        `请用 answer_device_prompt({ deviceId: '${deviceId}', answer: 'y' 或 'n', reason: '…' }) 继续应答。`
      log('failed', { code: 'INCOMPLETE', message })
      return {
        ok: false,
        error: { code: 'INCOMPLETE', message },
        data: { answered, nextPrompt: next } as never,
        meta: metaOf(t0, deviceId)
      }
    }
    if (!after.ok) {
      log('failed', { code: after.errorCode ?? 'FAILED', message: after.error ?? '清空失败' })
      return failFromCommand(after, 'FAILED', metaOf(t0, deviceId))
    }
    // 收尾了却没有提示符 → 状态未知，绝不报成功（见 ExecOutcome.unsettled 的说明）
    if (after.settled !== 'prompt' && !after.prompt && !tailLooksLikePrompt(after)) {
      const message =
        `「${command}」的回显已结束，但设备没有回到提示符 —— 无法确认启动配置真的被清空了。` +
        `请先用 get_device_context({ deviceId: '${deviceId}' }) 查看提示符与视图，` +
        '并复核 display saved-configuration。'
      log('failed', { code: 'UNSETTLED', message })
      return fail('UNSETTLED', message, metaOf(t0, deviceId))
    }

    log('ok')
    return ok({ cleared: true, answered, clean: after.clean.slice(0, 4000) } as never, metaOf(t0, deviceId))
  })
}