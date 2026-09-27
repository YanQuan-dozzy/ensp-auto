import fs from 'node:fs'
import path from 'node:path'
import { analyzeReferenceConfig, type ReferenceAnalysis } from '../core/reference/analyze'
import { decode, detectEncoding } from '../core/telnet/encoding'
import { fail, ok, Type, type ToolSpec } from './registry'
import { atomicWriteJsonSync } from '../core/fs/atomic'

/** 参考配置文本文件的字节上限 */
const MAX_REFERENCE_BYTES = 512 * 1024

/**
 * 读参考配置文本文件（v2.13）。
 *
 * 为什么不能直接 `readFileSync(path, 'utf8')`：中文的实验指导书 / 标准配置样例大量是
 * GBK，硬解 UTF-8 会整份变成 U+FFFD，而模型随后会「照此摘要配置真机」—— 乱码直接
 * 变成错误配置。这里复用通信层与附件预览同一套判据：UTF-8 严格校验优先，失败回退 GBK。
 *
 * 含 NUL 视为二进制直接拒绝：否则一个改名为 .cfg 的 zip/exe 会被分析出一份毫无意义的
 * 「能力摘要」，比明确报错更糟。
 */
export function readReferenceTextFile(
  filePath: string
): { ok: true; text: string; encoding: 'utf8' | 'gbk' } | { ok: false; error: string } {
  const buf = fs.readFileSync(filePath)
  if (buf.includes(0)) {
    return {
      ok: false,
      error: '内容看起来是二进制（含 NUL），无法作为配置文本分析；请提供 txt/md/cfg 等文本文件'
    }
  }
  const encoding = detectEncoding(buf)
  return { ok: true, text: decode(buf, encoding).text, encoding }
}

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
    '分析参考配置（文本或文本文件）并提取配置能力摘要：OSPF/VLAN/DHCP/VRRP/NAT/ACL/' +
    'IPSec/WiFi 等按协议归类，标注所属设备并抽出代表性命令。' +
    '当用户给出实验指导书样例或标准配置要求「照此配置」时，先用本工具学习，再按摘要执行。' +
    '返回能力列表与可落盘的工件路径。',
  risk: 'read',
  scope: 'local',
  concurrencySafe: true,
  schema: Type.Object(
    {
      text: Type.Optional(Type.String({ description: '参考配置原文（与 path 二选一）' })),
      path: Type.Optional(
        Type.String({ description: '参考配置文件的绝对路径（文本文件，≤512KB，扩展名不限，UTF-8/GBK 自动识别；与 text 二选一）' })
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
      // —— 路径准入：刻意**不做扩展名白名单**（用户会指任意位置的参考配置，.bak /
      //    无扩展名的片段都合法）。真正的门是「≤512KB + 内容为文本（无 NUL）」，
      //    约束见 readReferenceTextFile。
      const resolved = path.resolve(pathArg)
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        return fail('BAD_PARAM', `文件不存在：${resolved}`, { ms: Date.now() - t0 })
      }
      if (fs.statSync(resolved).size > MAX_REFERENCE_BYTES) {
        return fail('BAD_PARAM', '参考配置文件超过 512KB', { ms: Date.now() - t0 })
      }
      // v2.13：按内容判编码（UTF-8 优先 / GBK 回退），不再硬解 UTF-8 把中文配置读成乱码
      const read = readReferenceTextFile(resolved)
      if (!read.ok) return fail('NOT_TEXT', read.error, { ms: Date.now() - t0 })
      content = read.text
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