/**
 * 端口号的统一校验（主进程与渲染层共用）。
 *
 * 为什么不做兜底：早期实现里 `clampPort` 在参数缺失/非法时静默返回 2000，
 * 于是「漏传 port」表现为「连上了一台不是你想要的设备」—— 这种失败比直接报错危险得多，
 * 因为调用方（模型）会拿着错误的连接继续往下做配置。此模块只做校验，不做补默认值。
 */

/** 扫描区间的默认端点（仅在调用方未提供时使用，不用于兜底非法值） */
export const DEFAULT_SCAN_START = 2000
export const DEFAULT_SCAN_END = 2050

/** SSH 默认端口 */
export const DEFAULT_SSH_PORT = 22

/**
 * 严格解析端口：必须是 1~65535 的**整数**。
 * 返回 null 表示调用方必须回报 BAD_PARAM —— 不要在这里塞一个默认值。
 */
export function parsePort(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  if (value < 1 || value > 65535) return null
  return value
}

/** 解析端点：`undefined` 走 fallback（这才是「默认值」的合法入口），其余必须合法 */
export function parsePortOr(value: unknown, fallback: number): number | null {
  if (value === undefined || value === null) return fallback
  return parsePort(value)
}

/** 供报错文案复用的可读化输出 */
export function describePortValue(value: unknown): string {
  if (value === undefined) return '未提供'
  if (typeof value === 'string') return `字符串 "${value}"`
  if (typeof value === 'number') return `数值 ${value}`
  return typeof value
}
