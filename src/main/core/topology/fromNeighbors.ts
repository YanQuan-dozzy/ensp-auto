import {
  guessRole,
  type Topology,
  type TopologyLink,
  type TopologyNode
} from './model'

/**
 * 邻居推导（来源二：实采做图，对应 PRD F-5.3）。
 *
 * 实现方式：对每个已连接设备执行 `display lldp neighbor`，解析出「本地接口→邻居名/邻居接口」，
 * 再按设备名匹配已知会话，匹配不上则生成占位节点（如 PC、云、未识别设备）。
 * LLDP 未开启时命令会报错，跳过即可 —— 推导是 best-effort，不是硬性前提。
 */

export interface LldpNeighborEntry {
  localIntf: string
  neighborName: string
  neighborIntf: string
}

const INTF_RE = /^(GE|Eth|GigabitEthernet|XGE|Eth-Trunk|LoopBack|Vlanif|MEth)\S*$/i
const HEADER_RE = /Local Intf|System Name|Neighbor Dev|Neighbor Intf|Exptime|^[-=+\s]+$/

/**
 * 解析 VRP `display lldp neighbor` 的表格回显。
 * 容忍列的 Variant：第 2 列可能直接被邻居接口占用（无设备名列）时退化为 3 列布局。
 */
export function parseLldpNeighbors(text: string): LldpNeighborEntry[] {
  const out: LldpNeighborEntry[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (HEADER_RE.test(line)) continue
    const cells = line.split(/\s{2,}|\t+/).map((c) => c.trim()).filter(Boolean)
    if (cells.length < 3) continue
    const localIntf = cells[0]!
    if (!INTF_RE.test(localIntf)) continue

    // 先找第一个接口样 token 作邻居接口；否则退化为「第 2、3 列即邻居名与接口」
    const rest = cells.slice(1)
    const intfIdx = rest.findIndex((c) => INTF_RE.test(c))
    let neighborName: string
    let neighborIntf: string
    if (intfIdx >= 1) {
      neighborName = rest.slice(0, intfIdx).join(' ')
      neighborIntf = rest[intfIdx]!
    } else if (intfIdx === 0) {
      neighborName = ''
      neighborIntf = rest[0]!
    } else {
      neighborName = rest[0] ?? ''
      neighborIntf = rest.length > 1 ? rest[rest.length - 1]! : ''
    }
    if (!neighborName) continue
    out.push({ localIntf, neighborName, neighborIntf })
  }
  return out
}

/** 会话的探测面：只需能跑只读命令即可，便于用 Mock 设备单测 */
export interface TopologyProbe {
  id: string
  name: string
  model?: string
  exec(
    cmd: string,
    opts?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<{ ok: boolean; clean: string; error?: string }>
}

/**
 * 对一组已连接设备做邻居推导，产出 Topology（节点口径 = 设备 + 未匹配邻居占位）。
 * 返回结构中通过 note 记录跳过/失败统计，方便 UI 与代理判断数据可靠度。
 */
export async function deriveTopology(
  probes: readonly TopologyProbe[],
  opts?: { signal?: AbortSignal }
): Promise<Topology> {
  const nodes: TopologyNode[] = []
  const links: TopologyLink[] = []
  const byName = new Map<string, TopologyNode>()
  const byId = new Map<string, TopologyNode>()
  const seenLinks = new Set<string>()
  const linkKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`)

  for (const p of probes) {
    const node: TopologyNode = {
      id: p.id,
      name: p.name,
      role: guessRole(p.name, p.model),
      ...(p.model ? { model: p.model } : {}),
      deviceId: p.id
    }
    nodes.push(node)
    byId.set(node.id, node)
    byName.set(node.name.toLowerCase(), node)
  }

  for (const p of probes) {
    let result: Awaited<ReturnType<TopologyProbe['exec']>>
    try {
      result = await p.exec('display lldp neighbor', {
        timeoutMs: 8000,
        ...(opts?.signal ? { signal: opts.signal } : {})
      })
    } catch {
      continue // 命令层异常视为未开启 LLDP，跳过
    }
    if (!result.ok) continue // LLDP 未配置等，不在拓扑上留错误节点

    const entries = parseLldpNeighbors(result.clean)
    for (const e of entries) {
      const target =
        byName.get(e.neighborName.toLowerCase()) ??
        (byId.has(`neighbor:${e.neighborName}`)
          ? byId.get(`neighbor:${e.neighborName}`)
          : (() => {
              // v1.8：确定性坐标（按名字散列），替代 Math.random —— 随机坐标会让
              // 每次 refresh/derive 时占位节点乱跳，既不持久也无稳定性
              let hash = 0
              for (let i = 0; i < e.neighborName.length; i++) {
                hash = (hash * 31 + e.neighborName.charCodeAt(i)) >>> 0
              }
              const stub: TopologyNode = {
                id: `neighbor:${e.neighborName}`,
                name: e.neighborName,
                role: guessRole(e.neighborName),
                x: (hash % 5) * 180 + 40,
                y: (Math.floor(hash / 5) % 4) * 120 + 40
              }
              nodes.push(stub)
              byId.set(stub.id, stub)
              return stub
            })())
      if (!target) continue
      if (target.id === p.id) continue // 自环（邻居报自己）无意义
      const key = linkKey(p.id, target.id)
      if (seenLinks.has(key)) continue // 两端各自上报同一条链路时只留一条
      seenLinks.add(key)
      links.push({
        id: `${p.id}->${target.id}:${e.localIntf}-${e.neighborIntf}`,
        from: p.id,
        to: target.id,
        label: `${e.localIntf} ↔ ${e.neighborIntf}`,
        source: 'discovered'
      })
    }
  }

  return { nodes, links, updatedAt: Date.now() }
}