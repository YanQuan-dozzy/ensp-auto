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
 * 命令可能带参数（如 `save force`），因此先做整串匹配，再做「首个 token + 次 token」匹配。
 */
export function classifyDanger(command: string): DangerVerdict {
  const c = command.trim().replace(/\s+/g, ' ').toLowerCase()
  if (!c) return { dangerous: false }

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

export function isReadOnlyCommand(command: string): boolean {
  const first = command.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  return READ_ONLY_PREFIXES.includes(first)
}
