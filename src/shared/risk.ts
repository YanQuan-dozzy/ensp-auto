/**
 * 危险命令拦截。
 *
 * 设计要点：拦截发生在 ToolRegistry 执行之前，而不是提示词层。
 * 提示词可以被模型绕过，代码不会。
 */

/** 显式清单：命中即拦截（比较时去空白、转小写） */
export const DANGEROUS_COMMANDS: readonly string[] = [
  'reboot',
  'reset saved-configuration',
  'reset current-configuration',
  'erase startup-config',
  'delete /unreserved',
  'format',
  'startup saved-configuration',
  'undo startup saved-configuration',
  'rollback configuration',
  'save',
  'factory-configuration'
]

/**
 * VRP 命令缩写展开表（决策 D5：只覆盖高频缩写，按需扩展）。
 *
 * 为什么必须展开：设备认 `reb` = `reboot`、`sa` = `save`，而拦截表是整串/前缀匹配，
 * 缩写形式会整条漏过去（R7）—— `reb` 能重启设备却判不出危险。
 *
 * 收词原则：只收 VRP 中**唯一可解析**的缩写；歧义前缀（如 `re`、`s`）一律不收 ——
 * 宁可让罕见缩写漏判（会被后续人工闸门或设备拒绝兜住），也不要误杀正常配置命令。
 */
const COMMAND_ABBREVIATIONS: Readonly<Record<string, string>> = {
  // 只读
  dis: 'display',
  disp: 'display',
  displ: 'display',
  displa: 'display',
  sho: 'show',
  mor: 'more',
  pin: 'ping',
  trac: 'tracert',
  tracer: 'tracert',
  // 破坏性
  reb: 'reboot',
  rebo: 'reboot',
  reboo: 'reboot',
  sa: 'save',
  sav: 'save',
  res: 'reset',
  rese: 'reset',
  del: 'delete',
  und: 'undo',
  cle: 'clear',
  roll: 'rollback'
}

/**
 * 按 \r / \n 拆成逻辑行。
 *
 * 设备收到 `display version\rreset saved-configuration` 会**逐行执行**两条命令，
 * 而 `\s+` 归一化会把多行压成一行、判定期失去"多行"语义 —— 这是 R4 的绕过路径。
 * 因此所有判定入口都必须先拆行。
 */
function splitCommandLines(command: string): string[] {
  return command
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

/** 归一化：去首尾空白、折叠内部空白、转小写 */
function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** 归一化 + 首个 token 缩写展开（`sa force` → `save force`） */
function canonicalizeCommand(command: string): string {
  const norm = normalizeCommand(command)
  if (!norm) return norm
  const sp = norm.indexOf(' ')
  const head = sp < 0 ? norm : norm.slice(0, sp)
  const rest = sp < 0 ? '' : norm.slice(sp)
  const full = COMMAND_ABBREVIATIONS[head]
  return full ? `${full}${rest}` : norm
}

/** 结构规则：匹配即拦截。覆盖显式清单难以穷举的写法 */
export const DANGEROUS_PATTERNS: readonly RegExp[] = [
  /^\s*undo\s+startup\b/i,
  /^\s*(clear|reset)\s+configuration\b/i,
  /^\s*delete\b.*\s\/unreserved\b/i,
  /^\s*stop\s+/i,
  /^\s*undo\s+save\b/i
]

export interface DangerVerdict {
  dangerous: boolean
  /** 命中的规则说明，用于闸门弹窗展示 */
  reason?: string
  /** 后果说明，用于闸门弹窗展示 */
  consequence?: string
}

const CONSEQUENCES: Record<string, string> = {
  reboot: '设备将重启，当前实验会话中断，未保存的配置丢失。',
  'reset saved-configuration': '将清空设备启动配置，设备重启后配置全部丢失。',
  'reset current-configuration': '将清空设备当前运行配置，设备立即变为初始状态。',
  'erase startup-config': '将清空设备启动配置文件，重启后配置丢失。',
  'delete /unreserved': '将永久删除文件，无法从回收站恢复。',
  format: '将格式化设备存储，其中所有文件丢失。',
  'startup saved-configuration': '将改变设备启动时加载的配置文件，可能使重启后进入非预期配置。',
  'undo startup saved-configuration': '将移除设备启动配置指向，重启后设备回到出厂状态。',
  'rollback configuration': '将整机配置回退到历史版本，当前所有配置被覆盖。',
  save: '将把当前（可能错误的）运行配置固化为启动配置，使错误持久化。',
  'factory-configuration': '将恢复设备出厂配置，全部配置丢失。'
}

/**
 * 判定单条命令是否危险。
 *
 * 三道闸口，缺一不可：
 * 1. 多行（含 \r / \n）直接视为危险 —— 设备会逐行执行，单条判定管不住第二行；
 * 2. 首个 token 缩写展开（`reb` → `reboot`），否则缩写能整条绕过清单；
 * 3. 展开后再走结构规则 + 显式清单（命令可能带参数，如 `save force`，故整串与「首 token」双匹配）。
 */
export function classifyDanger(command: string): DangerVerdict {
  const lines = splitCommandLines(command)
  if (lines.length === 0) return { dangerous: false }

  if (lines.length > 1) {
    return {
      dangerous: true,
      reason: `命令包含 ${lines.length} 行（\\r / \\n 分隔），设备会逐行依次执行`,
      consequence: `多行命令绕过了单条命令的判定，第二行起的内容未经审查。逐行内容：${lines
        .slice(1)
        .map((l) => `「${l.slice(0, 40)}」`)
        .join('')}`
    }
  }

  const c = canonicalizeCommand(lines[0]!)

  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(c)) {
      return {
        dangerous: true,
        reason: `命中结构规则 ${pattern.source}`,
        consequence: '该命令涉及启动配置或不可恢复操作，执行后可能无法回退。'
      }
    }
  }

  for (const item of DANGEROUS_COMMANDS) {
    if (c === item || c.startsWith(item + ' ')) {
      return {
        dangerous: true,
        reason: `命中危险命令清单：${item}`,
        consequence: CONSEQUENCES[item] ?? '该命令属于破坏性操作，执行后可能无法回退。'
      }
    }
  }

  return { dangerous: false }
}

/** 只读命令白名单前缀，用于 run_show_command 的硬约束 */
export const READ_ONLY_PREFIXES: readonly string[] = [
  'display',
  'show',
  'dir',
  'more',
  'ping',
  'tracert'
]

/**
 * 是否只读命令。
 *
 * - 多行一律不放行（否则第二行可以是任何东西）；
 * - 首个 token 先按缩写展开再比对（`dis ver` = `display ver`，决策 D5），
 *   展开表本身就是白名单的缩写形式，比裸前缀匹配更不容易放过未知命令。
 */
export function isReadOnlyCommand(command: string): boolean {
  const lines = splitCommandLines(command)
  if (lines.length !== 1) return false
  const first = canonicalizeCommand(lines[0]!).split(' ')[0] ?? ''
  return READ_ONLY_PREFIXES.includes(first)
}
