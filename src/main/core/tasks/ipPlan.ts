/**
 * IP 规划纯函数（参照 JWM0203/ensp-skills 的地址规划约定）：
 * - 互联链路：10.0.AB.x/24，A、B 为相邻两台设备编号（R1–R2 用 10.0.12.0/24）
 * - 回环口：X.X.X.X/32，X 为设备编号（R1 用 1.1.1.1/32）
 *
 * 全部为纯函数，供 execute_task / export_lab_guide 等工具与单测复用。
 * 与 src/main/skills/builtin.ts 里 ip-planning 技能的规范保持一致。
 */

export interface Octet {
  ip: string
  mask: string
  prefix: number
}

/** 把前缀长度转点分十进制掩码（/24 → 255.255.255.0） */
export function dottedMask(prefix: number): string {
  const p = Math.max(0, Math.min(32, Math.trunc(prefix)))
  // JS 位移按 31 位取模：/32 时 (32-p)=0 合法，/0 时 (32-p)=32 会被折算成 0，
  // 必须先判 0，避免 0xffffffff<<32 变成 <<0 返回全 1
  const bits = p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0
  return [24, 16, 8, 0].map((shift) => (bits >>> shift) & 0xff).join('.')
}

export interface InterlinkPlan {
  scheme: string
  network: string
  mask: string
  a: Octet
  b: Octet
}

/**
 * 生成一对互连设备的地址规划。
 * @param a 低编号设备（规划取 .1，loopback 用 a.a.a.a）
 * @param b 高编号设备（规划取 .2）
 */
export function interlinkPair(a: number, b: number): InterlinkPlan {
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 1 || hi < 1) {
    throw new Error(`设备编号须为正整数（收到 ${a}/${b}）`)
  }
  const seg = `${lo}${hi}`
  // v1.8：拼接出的第三个八位组必须 ≤255 —— 12 与 13 会拼出 1213 → 10.0.1213.0 非法网段，
  // 是模型照抄的经典坏地址。此处 fail-fast，不让错误静默进入下发的命令。
  const segNum = Number(seg)
  if (!Number.isInteger(segNum) || segNum < 1 || segNum > 255) {
    throw new Error(
      `设备编号 ${a}/${b} 拼出的网段 10.0.${seg}.0 不是合法 IPv4 网段（编号过大），请改用 1..9 或 10..15 等能拼出 ≤255 的编号`
    )
  }
  const network = `10.0.${seg}.0`
  return {
    scheme: `10.0.${seg}.0/24`,
    network,
    mask: dottedMask(24),
    a: { ip: `10.0.${seg}.1`, mask: dottedMask(24), prefix: 24 },
    b: { ip: `10.0.${seg}.2`, mask: dottedMask(24), prefix: 24 }
  }
}

/** 回环口规划：X.X.X.X/32 */
export function loopbackIp(n: number): Octet {
  // v1.8：n>255 时会产出 4 位数，不再是合法 IPv4；fail-fast 兜住模型传坏编号
  if (!Number.isInteger(n) || n < 1 || n > 255) {
    throw new Error(`回环口编号须是 1..255 的整数（收到 ${n}）`)
  }
  return { ip: `${n}.${n}.${n}.${n}`, mask: '255.255.255.255', prefix: 32 }
}

/** 单台设备一个网段的主机地址规划（如 PC 侧：网关取 .254，主机从 .1 起） */
export function hostInNetwork(network: string, prefix: number, host: number): Octet {
  const base = network.split('.').map(Number)
  return {
    ip: `${base[0]}.${base[1]}.${base[2]}.${host}`,
    mask: dottedMask(prefix),
    prefix
  }
}