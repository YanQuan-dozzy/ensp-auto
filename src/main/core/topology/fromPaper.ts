import fs from 'node:fs'
import path from 'node:path'
import { decodeText, decodeTopo, parseTopoXml, type TopoParseResult } from './fromProjectFile'

/**
 * eNSP 实验包解析（.paper）：工程文件解析（来源一）的第二入口，复用 .topo 解析器。
 *
 * .paper 是 eNSP 的**实验/试卷包**：把一份 .topo 工程、实验说明 instruction.txt 与
 * 每台设备的启动配置 vrpcfg.cfg 打包成单文件。格式为定长目录 + 连续数据区：
 *
 *   [8B 包头]  u32 memberCount | u32 version(=1)
 *   [目录]     memberCount × 304B 定长条目：
 *                +0  u32  数据长度
 *                +4  char 归属 GUID[36]（vrpcfg.cfg 为设备 id，其余为空）
 *                +40 u32  保留
 *                +44 char 文件名[64]（GBK，空格 0 填充）
 *                +108 196B 保留
 *   [数据区]   各成员内容按目录顺序首尾相接，长度取自目录中的「数据长度」
 *
 * 解析策略：只做定长目录读取 + 边界校验，**不整体信任文件**（长度越界即停并告警）；
 * 拓扑仍交给 fromProjectFile 的 parseTopoXml，接口/链路/端口标注全部复用，不重复实现。
 */

export const PAPER_HEADER_BYTES = 8
export const PAPER_ENTRY_BYTES = 304
/** 归并包（多张试卷）才有较多成员；单包实测 13 个，4096 已是宽松上限 */
export const MAX_PAPER_MEMBERS = 4096

const ENTRY_SIZE_OFFSET = 0
const ENTRY_OWNER_OFFSET = 4
const ENTRY_OWNER_LEN = 36
const ENTRY_NAME_OFFSET = 44
const ENTRY_NAME_LEN = 64

export interface PaperMember {
  /** 文件名（GBK 解码后去除 0 填充），如 instruction.txt / xxx.topo / vrpcfg.cfg */
  name: string
  /** 归属设备 GUID（仅 vrpcfg.cfg 有值，与 .topo 内 <dev id> 同源） */
  owner: string
  size: number
  /** 数据在包内的偏移（调试/报告用） */
  offset: number
  data: Buffer
}

export interface PaperArchive {
  version: number
  members: PaperMember[]
  warnings: string[]
}

/** 定长字段解码：截到首个 0，再按 UTF-8/GBK 严格判据解码 */
function decodeField(buf: Buffer): string {
  const nul = buf.indexOf(0)
  return decodeText(nul >= 0 ? buf.subarray(0, nul) : buf).text.trim()
}

/**
 * 解析 .paper 容器 → 成员列表。
 * 长度/数量异常（非 .paper、目录区越界、成员数超限）直接抛错；
 * 单个成员数据越界则停止解析并记 warning（后续成员一并放弃，避免错位误读）。
 */
export function parsePaper(buf: Buffer): PaperArchive {
  if (buf.length < PAPER_HEADER_BYTES) throw new Error('.paper 文件过小，缺少包头')
  const count = buf.readUInt32LE(0)
  const version = buf.readUInt32LE(4)
  if (count <= 0 || count > MAX_PAPER_MEMBERS) throw new Error(`.paper 成员数量异常（${count}）`)
  const dirEnd = PAPER_HEADER_BYTES + count * PAPER_ENTRY_BYTES
  if (dirEnd > buf.length) throw new Error('.paper 目录区超出文件长度，文件可能损坏')

  const warnings: string[] = []
  if (version !== 1) warnings.push(`.paper 版本号 ${version} 与预期（1）不符，已按现有格式尝试解析`)

  const members: PaperMember[] = []
  let offset = dirEnd
  for (let i = 0; i < count; i++) {
    const base = PAPER_HEADER_BYTES + i * PAPER_ENTRY_BYTES
    const size = buf.readUInt32LE(base + ENTRY_SIZE_OFFSET)
    if (offset + size > buf.length) {
      warnings.push(`成员 #${i} 数据长度 ${size} 超出包长，其后成员已跳过（文件截断？）`)
      break
    }
    members.push({
      name: decodeField(buf.subarray(base + ENTRY_NAME_OFFSET, base + ENTRY_NAME_OFFSET + ENTRY_NAME_LEN)),
      owner: decodeField(buf.subarray(base + ENTRY_OWNER_OFFSET, base + ENTRY_OWNER_OFFSET + ENTRY_OWNER_LEN)),
      size,
      offset,
      data: buf.subarray(offset, offset + size)
    })
    offset += size
  }
  return { version, members, warnings }
}

/** 按扩展名取成员（.topo 等），比较用小写 */
export function findPaperMember(archive: PaperArchive, ext: string): PaperMember | undefined {
  const want = ext.toLowerCase()
  return archive.members.find((m) => path.extname(m.name).toLowerCase() === want)
}

/** 兜底：目录里没有 .topo 扩展名时，用内容特征认拓扑成员（真机变体可能改名） */
function sniffTopoMember(archive: PaperArchive): PaperMember | undefined {
  return archive.members.find((m) => {
    const head = m.data.subarray(0, 512).toString('latin1').toUpperCase()
    return head.includes('<TOPO') || head.includes('<?XML')
  })
}

/**
 * 读 .paper 并解析其中的 .topo → Topology。
 * 成员数据同样走 decodeTopo（gzip / BOM / UTF-8→GBK 自动识别），与独立 .topo 文件一致。
 */
export function readPaperFile(filePath: string): TopoParseResult {
  const archive = parsePaper(fs.readFileSync(filePath))
  const member = findPaperMember(archive, '.topo') ?? sniffTopoMember(archive)
  if (!member) throw new Error('未在 .paper 中找到 .topo 拓扑成员')
  const decoded = decodeTopo(member.data)
  const result = parseTopoXml(decoded.xml)
  result.report.gzipped = decoded.gzipped
  result.report.encoding = decoded.encoding
  result.report.warnings.unshift(...archive.warnings)
  return result
}