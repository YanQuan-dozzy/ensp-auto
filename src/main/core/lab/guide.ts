/**
 * 教学设计文档生成（纯函数，v1.8 / 参照 JWM0203/ensp-skills 的 ensp-lab-authoring 产出物）。
 *
 * export_lab_guide 工具负责「取数据 + 写盘」，这里只负责「把结构化信息排版成 markdown」。
 * 菜谱文档具备稳定骨架：
 *   实验目标 → 拓扑概览（设备 + 链路）→ 设备清单 → IP 规划 → 配置步骤 → 验证清单
 * 纯函数可单测；文档默认包含 mermaid 拓扑图，便于在支持 mermaid 的编辑器里直接预览。
 */

export interface LabGuideDevice {
  deviceId: string
  name?: string
  model?: string
  role?: string
}

export interface LabGuideLink {
  from: string
  to: string
}

export interface LabGuideIpRow {
  device: string
  iface: string
  ip: string
  purpose?: string
}

export interface LabGuideInput {
  title: string
  objective?: string
  devices?: LabGuideDevice[]
  links?: LabGuideLink[]
  ipPlan?: LabGuideIpRow[]
  steps?: string[]
  checks?: Array<{ from: string; target: string }>
}

const esc = (s: string): string => s.replace(/\|/g, '\\|')

// v1.8：mermaid 节点 label 需转义反斜杠与 `[` `]`，否则设备名/型号带有这些字符时
// 会提前终止节点方块、破坏整个图块（`( )` 在 mermaid flow 的 [label] 内是合法字符，勿转）
const mermaidLabel = (s: string): string => s.replace(/[[\]\\]/g, '\\$&')

export function buildLabGuide(input: LabGuideInput): string {
  const lines: string[] = []
  lines.push(`# ${input.title}`)
  lines.push('')

  if (input.objective) {
    lines.push('## 实验目标', '', input.objective.trim(), '')
  }

  lines.push('## 拓扑概览', '')
  const devices = input.devices ?? []
  if (devices.length) {
    lines.push('```mermaid', 'graph LR')
    const ids = new Set<string>()
    const safeId = (n: string): string => n.replace(/\W/g, '_') || 'node'
    for (const d of devices) {
      const label = `${d.name ?? d.deviceId}${d.model ? `(${d.model})` : ''}`
      lines.push(`  ${safeId(d.deviceId)}[${mermaidLabel(label)}]`)
      ids.add(d.deviceId)
    }
    for (const l of input.links ?? []) {
      if (!ids.has(l.from) || !ids.has(l.to)) continue
      lines.push(`  ${safeId(l.from)} --- ${safeId(l.to)}`)
    }
    lines.push('```', '')
  }

  if (devices.length) {
    lines.push('## 设备清单', '', '| 设备 ID | 名称 | 型号 | 角色 |', '|---|---|---|---|')
    for (const d of devices) {
      lines.push(`| ${esc(d.deviceId)} | ${esc(d.name ?? '')} | ${esc(d.model ?? '')} | ${esc(d.role ?? '')} |`)
    }
    lines.push('')
  }

  const ipPlan = input.ipPlan ?? []
  if (ipPlan.length) {
    lines.push('## IP 地址规划', '', '| 设备 | 接口 | IP/掩码 | 用途 |', '|---|---|---|---|')
    for (const r of ipPlan) {
      lines.push(`| ${esc(r.device)} | ${esc(r.iface)} | ${esc(r.ip)} | ${esc(r.purpose ?? '')} |`)
    }
    lines.push('')
  }

  const steps = input.steps ?? []
  if (steps.length) {
    lines.push('## 配置步骤', '')
    steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`))
    lines.push('')
  }

  const checks = input.checks ?? []
  if (checks.length) {
    lines.push('## 验证清单', '', '| 源设备 | 目标 | 判定方法 |', '|---|---|---|')
    for (const c of checks) {
      lines.push(`| ${esc(c.from)} | ${esc(c.target)} | verify_ping 应 reachable |`)
    }
    lines.push('')
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n')
}