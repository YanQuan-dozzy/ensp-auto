/**
 * 链路接口标注的展示辅助（参考 ensp- 参考实现的展示方式）：
 *
 * 1. splitPortLabel：把链路 label 拆成两端各自的接口名。
 *    label 约定：「from 端接口 ↔ to 端接口」，多条成对标注用「 / 」（空格+斜杠+空格）分隔，最多 2 对，
 *    例：`GE0/0/1 ↔ GE0/0/9 / GE0/0/2 ↔ GE0/0/10`（构造见 fromProjectFile.ts 的 label 合并器、fromNeighbors.ts）。
 *    注意：必须按「 / 」切分多对，绝不能按「 / 」切分 —— 接口名自带斜杠（如 GE0/0/10），
 *    按 / 切分会把单对标注打散成 GE0 / 0 / 10 / 0 / 1 这样的碎片（拓扑图上表现为接口名混乱）。
 *
 * 2. shortIf：接口名简写（与 ensp- 参考实现 TopoView 的 shortIf 同构），
 *    GigabitEthernet → GE，Ethernet → Eth，其余（GE / Serial 等）原样保留。
 */
export function splitPortLabel(label?: string): { from: string[]; to: string[] } | null {
  if (!label || !label.includes('↔')) return null
  const from: string[] = []
  const to: string[] = []
  for (const pair of label.split(' / ')) {
    const parts = pair
      .split('↔')
      .map((s) => s.trim())
      .filter(Boolean)
    if (parts.length === 0) continue
    from.push(parts[0]!)
    if (parts.length > 1) to.push(parts[1]!)
  }
  if (from.length === 0 && to.length === 0) return null
  return { from, to }
}

export function shortIf(name: string): string {
  return name.replace(/GigabitEthernet/g, 'GE').replace(/Ethernet/g, 'Eth')
}