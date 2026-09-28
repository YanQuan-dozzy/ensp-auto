import type { CommandResult, ViewKind } from '@shared/types'

/**
 * 视图导航（v2.24）—— 「把设备带到某个视图」这件事的唯一实现。
 *
 * 为什么单独成模块：`quit` / `return` / `system-view` 是**相对导航命令**，
 * 它们不属于只读白名单（`isReadOnlyCommand`），也不属于配置变更。过去只有
 * `apply_config` 的下发管道内部会用到它们（`ensureSystemView`），于是：
 * - 模型在探索期想「退一层视图」，只能去调 `run_show_command` → 被只读白名单拒绝；
 * - 改用 `apply_config(['quit'])` 又会先被 `ensureSystemView` 顶到系统视图，
 *   再执行 `quit` —— 从系统视图退到用户视图，**报成功但去错地方**（静默配错状态）。
 *
 * 现在 `ensureSystemView`（写入管道用）与 `change_view`（模型显式导航用）共用本模块，
 * 保证「怎么算到了系统视图」只有一份判定。
 *
 * 边界：本模块只做「下发导航命令 + 判定结果」，不碰 ToolContext、不写日志。
 */

/** 导航所需的最小会话面（真会话与单测桩会话都满足） */
export interface NavSession {
  exec(cmd: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<CommandResult>
  /** 会话跟踪的当前视图；桩会话可缺省（缺省视为未知视图，退化为旧行为） */
  view?: ViewKind
}

/** 导航结果：即使失败也把「已经发出去的命令」带回去，便于上报与排错 */
export interface NavOutcome {
  ok: boolean
  /** 本次实际下发的命令（幂等跳过时为空数组） */
  commands: string[]
  /** 最后一条命令的结果（未下发任何命令时为 null） */
  last: CommandResult | null
  /**
   * 视图跟踪与设备实际不一致、靠设备回 `Unrecognized` 兜回来的。
   *
   * 出现它说明「本地以为在某视图、设备其实在另一处」——不影响本次导航正确性，
   * 但值得让上层告诉模型一声（例如它随后要发依赖视图的命令时）。
   */
  stale?: boolean
  error?: string
  errorCode?: string
}

const optsOf = (signal: AbortSignal | undefined): { signal?: AbortSignal } =>
  signal ? { signal } : {}

/**
 * 把设备带到系统视图（写入管道的第 2 步）。
 *
 * 为什么不能无脑发 `system-view`：VRP 只在**用户视图**才认这条命令。设备若已停在
 * 系统视图或某个子视图（eNSP 设备常被上一次会话留在 `[Huawei]` / 接口视图），
 * 再发 `system-view` 会回 `Error: Unrecognized command` —— 整条下发管道在第一步就
 * 失败，报「无法进入系统视图」，而设备其实早就在系统视图里。
 *
 * 按会话跟踪到的当前视图选最少命令：
 * - `system`      → 已在系统视图，跳过
 * - `user`        → 直接 `system-view`
 * - 其它子视图     → 先 `return` 回用户视图（`quit` 只能退一层，嵌套深度未知），再 `system-view`
 *
 * 视图跟踪可能滞后（如用户在交互终端里手动切过视图）：此时 `system-view` 报
 * “命令不存在”，说明设备其实不在用户视图 —— 退回用户视图重试一次，而不是直接判失败。
 */
export async function ensureSystemView(
  session: NavSession,
  signal: AbortSignal | undefined
): Promise<NavOutcome> {
  const opts = optsOf(signal)
  if (session.view === 'system') return { ok: true, commands: [], last: null }

  const commands: string[] = []
  let last: CommandResult | null = null

  if (session.view && session.view !== 'user') {
    const back = await session.exec('return', opts)
    commands.push('return')
    last = back
    if (!back.ok) {
      return {
        ok: false,
        commands,
        last,
        error: back.error ?? '无法退回到用户视图',
        ...(back.errorCode ? { errorCode: back.errorCode } : {})
      }
    }
  }

  const sys = await session.exec('system-view', opts)
  commands.push('system-view')
  last = sys
  if (sys.ok) return { ok: true, commands, last }

  if (sys.errorCode === 'UNRECOGNIZED') {
    // 跟踪滞后：设备已在系统/子视图 → 退回用户视图再进一次
    const back = await session.exec('return', opts)
    commands.push('return')
    last = back
    if (back.ok) {
      const retry = await session.exec('system-view', opts)
      commands.push('system-view')
      last = retry
      if (retry.ok) return { ok: true, commands, last, stale: true }
      return {
        ok: false,
        commands,
        last,
        error: retry.error ?? '无法进入系统视图',
        ...(retry.errorCode ? { errorCode: retry.errorCode } : {})
      }
    }
  }

  return {
    ok: false,
    commands,
    last,
    error: sys.error ?? '无法进入系统视图',
    ...(sys.errorCode ? { errorCode: sys.errorCode } : {})
  }
}

/**
 * 把设备带回用户视图。
 *
 * 幂等的关键在 `return` 本身：它是**绝对**导航（任意视图一步回用户视图），
 * 但**用户视图不认这条命令**（设备回 `Error: Unrecognized command`）。于是：
 * - 跟踪显示已在用户视图 → 一个字都不发（否则必然报错）；
 * - 跟踪显示在子视图 → 发 `return`；
 * - 发了却回 `Unrecognized` → 设备本来就在用户视图（跟踪滞后），**按成功处理**，
 *   不把这个必然结果报成故障（否则模型会反复重试同一个徒劳的调用）。
 */
export async function ensureUserView(
  session: NavSession,
  signal: AbortSignal | undefined
): Promise<NavOutcome> {
  if (session.view === 'user') return { ok: true, commands: [], last: null }

  const back = await session.exec('return', optsOf(signal))
  const commands = ['return']
  if (back.ok) return { ok: true, commands, last: back }
  if (back.errorCode === 'UNRECOGNIZED') {
    return { ok: true, commands, last: back, stale: true }
  }
  return {
    ok: false,
    commands,
    last: back,
    error: back.error ?? '无法退回到用户视图',
    ...(back.errorCode ? { errorCode: back.errorCode } : {})
  }
}

/** 进入指定接口视图（先确保处于系统视图，`interface` 只在系统视图有效） */
export async function enterInterfaceView(
  session: NavSession,
  interfaceName: string,
  signal: AbortSignal | undefined
): Promise<NavOutcome> {
  const sys = await ensureSystemView(session, signal)
  if (!sys.ok) return sys

  const cmd = `interface ${interfaceName}`
  const r = await session.exec(cmd, optsOf(signal))
  const commands = [...sys.commands, cmd]
  if (!r.ok) {
    return {
      ok: false,
      commands,
      last: r,
      error: r.error ?? '无法进入接口视图',
      ...(r.errorCode ? { errorCode: r.errorCode } : {})
    }
  }
  return {
    ok: true,
    commands,
    last: r,
    ...(sys.stale ? { stale: true } : {})
  }
}

/** `change_view` 的目标视图（刻意只这三档：用户 / 系统 / 某个接口） */
export type ViewTarget = 'user' | 'system' | 'interface'

const VIEW_TARGETS: readonly ViewTarget[] = ['user', 'system', 'interface']

/**
 * 归一化模型给的目标视图。
 *
 * 只做「大小写 + 首尾空白 + 几个常见别名」的归一，**不做模糊猜测**：
 * 猜错会让工具把设备带到错误的视图（而下游命令是否有效完全取决于视图），
 * 这类错误在回显里看不出来 —— 宁可返回 BAD_PARAM 让模型重写一次。
 */
export function normalizeViewTarget(raw: unknown): ViewTarget | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim().toLowerCase()
  if ((VIEW_TARGETS as readonly string[]).includes(v)) return v as ViewTarget
  // 常见别称（中文/工程口语）：只接受无歧义的几个
  if (v === '用户' || v === '用户视图' || v === 'user-view') return 'user'
  if (v === '系统' || v === '系统视图' || v === 'system-view' || v === 'config') return 'system'
  if (v === '接口' || v === '接口视图') return 'interface'
  return null
}

/**
 * 接口名白名单（会拼进 `interface <name>` 下发）。
 *
 * 只允许 VRP 接口名里真实存在的字符（字母、数字、`/ . - :` 与词间空格），
 * 且必须以字母开头 —— `\r` / `\n` / `|` / `;` / `?` / `^` 全不在字符集内，
 * 因此**无法**借接口名塞第二条命令或分页过滤管道（N2/N13 的同类防线：
 * 凡是「把模型参数拼进设备命令」的地方，都要在拼之前判）。
 */
export const INTERFACE_NAME_RE = /^[A-Za-z][A-Za-z0-9:./-]*(?: [A-Za-z0-9:./-]+){0,3}$/

/** 接口名长度上限（真实接口名远短于此，超了必是臆造） */
export const MAX_INTERFACE_NAME_LEN = 40

/** 接口名是否安全可下发 */
export function isSafeInterfaceName(name: string): boolean {
  const n = name.trim()
  if (!n || n.length > MAX_INTERFACE_NAME_LEN) return false
  return INTERFACE_NAME_RE.test(n)
}
