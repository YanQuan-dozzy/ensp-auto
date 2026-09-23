import fs from 'node:fs'
import path from 'node:path'
import { analyzeReferenceConfig, type ReferenceAnalysis } from '../core/reference/analyze'
import { fail, ok, Type, type ToolSpec } from './registry'
import { atomicWriteJsonSync } from '../core/fs/atomic'

/**
 * 参考配置能力学习工具（v1.2 / F-：参照 ensp-mcp analyze_reference_configs）。
 *
 * 把用户提供的参考配置（实验指导书样例 / 标准配置的文本或文件）解析为结构化能力摘要：
 * 按协议归类、标注所属设备、抽出代表性命令。代理拿到摘要后即可「按参考配置执行」，
 * 而不用从零摸索。结果同时落盘为 exportsDir/reference_capabilities.json 工件，供报告复用。
 */
export const analyzeReferenceConfigs: ToolSpec<{ text?: string; path?: string }> = {
  name: 'analyze_reference_configs',
  description:
    '分析参考配置（文本或 .txt/.cfg 文件）并提取配置能力摘要：OSPF/VLAN/DHCP/VRRP/NAT/ACL/' +
    'IPSec/WiFi 等按协议归类，标注所属设备并抽出代表性命令。' +
    '当用户给出实验指导书样例或标准配置要求「照此配置」时，先用本工具学习，再按摘要执行。' +
    '返回能力列表与可落盘的工件路径。',
  risk: 'read',
  scope: 'local',
  schema: Type.Object(
    {
      text: Type.Optional(Type.String({ description: '参考配置原文（与 path 二选一）' })),
      path: Type.Optional(
        Type.String({ description: '参考配置文件的绝对路径（.txt/.cfg/.conf，≤512KB；与 text 二选一）' })
      )
    },
    { additionalProperties: false }
  ),
  summarize: (_args, result) => {
    const d = result.data as Partial<ReferenceAnalysis> | undefined
    const kinds = (d?.capabilities ?? []).map((c) => c.kind).join('/')
    return `参考配置分析：${d?.capabilities?.length ?? 0} 类能力${kinds ? `（${kinds}）` : ''}`
  },
  handler: async (args, ctx) => {
    const t0 = Date.now()
    const textArg = (args.text ?? '').trim()
    const pathArg = (args.path ?? '').trim()

    if (textArg && pathArg) {
      return fail('BAD_PARAM', 'text 与 path 只能二选一', { ms: Date.now() - t0 })
    }
    if (!textArg && !pathArg) {
      return fail('BAD_PARAM', '缺少参考配置：请提供 text 或 path', { ms: Date.now() - t0 })
    }

    let content: string
    if (pathArg) {
      // —— 路径白名单（与 import_topology_file 同规则）——
      const resolved = path.resolve(pathArg)
      // v1.8：path.resolve 已归一化 `..`，防穿越只依赖下方扩展/存在/大小检查
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        return fail('BAD_PARAM', `文件不存在：${resolved}`, { ms: Date.now() - t0 })
      }
      if (fs.statSync(resolved).size > 512 * 1024) {
        return fail('BAD_PARAM', '参考配置文件超过 512KB', { ms: Date.now() - t0 })
      }
      content = fs.readFileSync(resolved, 'utf8')
    } else {
      content = textArg
    }

    const analysis = analyzeReferenceConfig(content)
    // 落盘工件：供报告导出与后续任务复用（与 ensp-mcp 的 reference_capabilities.json 对齐）
    let artifactPath: string | null = null
    try {
      artifactPath = path.join(ctx.exportsDir, 'reference_capabilities.json')
      atomicWriteJsonSync(artifactPath, analysis)
    } catch {
      artifactPath = null // 工件落盘失败不阻断核心返回
    }

    return ok(
      { ...analysis, ...(artifactPath ? { artifact: artifactPath } : {}) },
      { ms: Date.now() - t0 }
    )
  }
}