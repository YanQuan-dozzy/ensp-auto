/**
 * 链路的「身份」与「线型」口径（主进程 + 渲染层共用）—— 数据侧的唯一事实源。
 *
 * 为什么单独一个模块：这两件事被**两侧同时**使用，口径必须一致 ——
 * ① 主进程（解析、三层合并、手动层/墓碑落盘）判断「这是不是同一条线」；
 * ② 渲染层（连线 id → 删除目标、标注偏移落库）判断同一条线。
 * 口径不一致的后果是「删了这条，掉的是那条」或「拖完标签刷新即丢」。
 *
 * 关键概念区分（多线并接的前提）：
 * - **设备对**（`linkPairKey`）：两台设备之间的无向端点对，`Core1|Core2`；
 * - **线**（`linkKey` + `linkIdentity`）：设备对内的一条物理连线。eNSP 里两台设备
 *   可以并接多条线（同一个 `<line>` 下的多个 `<interfacePair>`，或同一对设备的多个
 *   `<line>`），它们必须各自成一条链路实体 —— 否则就会像修复前那样被合并成一根线、
 *   接口标注挤在一起。
 */
import type { TopologyLink } from './types'

/** 无向端点对 key（设备对）：`Core1|Core2`。与主进程历史口径一致。 */
export function linkPairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

/** 端口对 → 线标识（文件解析与 LLDP 实采用同一构造，两侧上报的同一条线才会去重成一条） */
export function lineKeyOfPorts(fromIf: string, toIf: string): string {
  return `${fromIf}->${toIf}`
}

/**
 * 链路标识 = 设备对 + 线标识（`Core1|Core2|GE0/0/1->GE0/0/1`）。
 *
 * `lineKey` 缺省（历史数据）时退化为 `设备对|`，此时调用方应按**设备对**语义处理
 * （见 `mergeLayers` / `store.ts#remove`）—— 所以不要在缺省时拿它做「按条」判定。
 */
export function linkIdentity(l: Pick<TopologyLink, 'from' | 'to' | 'lineKey'>): string {
  return `${linkPairKey(l.from, l.to)}|${l.lineKey ?? ''}`
}

/** eNSP 工程文件里的链路类型（`<line>` / `<interfacePair>` 的 lineName） */
export const LINE_TYPE_COPPER = 'Copper'
export const LINE_TYPE_SERIAL = 'Serial'

/**
 * 以**虚线**绘制的链路类型（广域网串口族）。
 *
 * 依据：eNSP 链路类型面板里 Copper（双绞线）/ Auto 是实线，Serial 一族（串口 / POS /
 * E1 / ATM / CTL）走虚线 —— 画布上据此区分「局域网铜缆」与「广域网串口」，多线并接时
 * 也能一眼看出哪条是串口链路。要增删类型只改这一张表。
 */
const DASHED_LINE_TYPES = new Set(['SERIAL', 'POS', 'E1', 'ATM', 'CTL'])

/**
 * 归一化链路类型字符串（大小写/空白容错）；空值 → undefined（不落该字段）。
 * 已知类型归一到 eNSP 面板的写法（Copper/Serial/Auto/POS/E1/ATM/CTL），未知值原样保留
 * —— 未知类型只是不参与线型映射，仍要能被展示与写回。
 */
export function normalizeLineType(raw?: string | null): string | undefined {
  const t = (raw ?? '').trim()
  if (!t) return undefined
  return KNOWN_LINE_TYPES[t.toUpperCase()] ?? t
}

/** eNSP 面板里的链路类型写法（首字母命名的按面板原样，避免把 POS/ATM/CTL 写成 Pos/Atm/Ctl） */
const KNOWN_LINE_TYPES: Record<string, string> = {
  AUTO: 'Auto',
  COPPER: 'Copper',
  SERIAL: 'Serial',
  POS: 'POS',
  E1: 'E1',
  ATM: 'ATM',
  CTL: 'CTL'
}

/** 该链路类型是否以虚线绘制（缺省/未知 → 实线） */
export function isDashedLineType(type?: string | null): boolean {
  const t = (type ?? '').trim().toUpperCase()
  return t.length > 0 && DASHED_LINE_TYPES.has(t)
}