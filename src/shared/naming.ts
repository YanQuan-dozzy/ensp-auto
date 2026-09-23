/**
 * 模型侧可见的名字约束（v1.6 从 main/core/mcp/client.ts 提上来）。
 *
 * 为什么放 shared：这条规则有两个消费者 —— 主进程拼 `mcp__<服务器>__<工具>`
 * 时要用它收敛字符集与长度；渲染层的「粘贴 JSON 导入」也要用它**提前**告诉用户
 * 「你起的这个名字落到模型眼里会变成什么」。
 * 规则只允许存在一份，否则两边迟早漂移（模型看到的工具名和界面上显示的对不上）。
 */

/** 允许的字符：字母数字下划线连字符（对齐 OpenAI 函数名约束）。
 *  刻意不导出：带 `g` 的正则被跨模块复用时会带 lastIndex 状态，是个坑。 */
const MODEL_NAME_SAFE_RE = /[^A-Za-z0-9_-]+/g

/**
 * 纯 JS 稳定短哈希（FNV-1a 双累加器混合），用于两个场景：
 * ① 全非法字符名（如纯中文服务器名）差异化兜底 —— 否则两台中文名服务器都会塌缩成 'x'；
 * ② 工具名碰撞后缀 —— 后缀混入工具名，同服务器内截断后重名的工具也能区分。
 * 刻意不用 node:crypto：本模块同时被主进程(node)与渲染层(web)消费，不能引入平台依赖。
 */
export function shortHashOf(raw: string, len = 6): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = (Math.imul(h2 + c, 0x85ebca6b) ^ (h2 >>> 13)) >>> 0
  }
  return `${h1.toString(36)}${h2.toString(36)}`.slice(0, len)
}

/**
 * 收敛一段名字：非法字符换成下划线、去掉首尾下划线、截断到 maxLen。
 * 全非法字符时按原始串的短哈希兜底（`h<6位36进制>`），保证非空且不塌缩：
 * 纯中文服务器名对 `[A-Za-z0-9_-]` 全是非法字符，若统一回落成 'x'，
 * 多台中文名服务器会拼出完全相同的工具名前缀（D8）。
 */
export function sanitizeNameSegment(raw: string, maxLen: number): string {
  const s = raw.replace(MODEL_NAME_SAFE_RE, '_').replace(/^_+|_+$/g, '')
  if (s) return s.slice(0, maxLen)
  return `h${shortHashOf(raw, 6)}`.slice(0, maxLen)
}

/** 长度预算：`mcp__`(5) + 服务器段(≤16) + `__`(2) + 工具段(≤41) = 64，正好卡在约束上 */
export const MCP_SERVER_SEGMENT_MAX = 16
export const MCP_TOOL_SEGMENT_MAX = 41

// ———————————————————— 文件名安全化（T5.3 统一口径） ————————————————————

/**
 * Windows 文件名里的非法字符：路径分隔、通配、引号、冒号、竖线、控制字符。
 * 之所以按 Windows 最严的那套来收：macOS/Linux 允许的字符更多，
 * 用严格集不会误伤，反过来在 Windows 上会直接建不出文件。
 */
const ILLEGAL_FILE_CHARS_RE = /[\\/:*?"<>|\u0000-\u001f\u007f]+/g

/** Windows 保留设备名。带扩展名同样非法（`con.txt` 也建不出来） */
const WINDOWS_RESERVED_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

export interface SafeFileNameOptions {
  /** 清洗后为空时的兜底名 */
  fallback?: string
  /** 长度上限（默认 60） */
  maxLen?: number
}

/**
 * 把任意字符串收敛成**能真正落盘**的文件/目录名。
 *
 * 过去这段逻辑在本仓有三套（attachments / lab / sessions），区别只在
 * 「去不去结尾点、管不管保留设备名」，于是同一份用户输入在不同功能里
 * 表现不同：导出报告用 `con` 会失败，导入附件却能过。
 * 统一到这里后：非法字符 → `_`、折叠空白、去掉结尾的点与空格（Windows 会静默截断）、
 * 保留设备名加前缀、截断到 maxLen。长度截断后要再削一次结尾点。
 */
export function safeFileName(raw: string, opts: SafeFileNameOptions = {}): string {
  const fallback = opts.fallback ?? 'file'
  const maxLen = Math.max(1, opts.maxLen ?? 60)
  let s = String(raw ?? '')
    .replace(ILLEGAL_FILE_CHARS_RE, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+/, '')
  // 截断后再削一次结尾——截断可能刚好切在点上
  s = s.slice(0, maxLen).replace(/[. ]+$/, '')
  if (WINDOWS_RESERVED_RE.test(s)) s = `_${s}`
  return s || fallback
}
