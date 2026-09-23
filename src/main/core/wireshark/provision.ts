import fs from 'node:fs'
import path from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import type { McpServerConfig } from '@shared/types'

const execFileAsync = promisify(execFile)

/**
 * Wireshark / tshark 抓包分析接入（v1.9）。
 *
 * eNSP 仿真里最常见的排障动作就是「抓包看流量」——但原先的代理只能看配置，看不到
 * 报文本身。这里把 Wireshark 的 CLI 工具链（tshark 及配套 capinfos/mergecap/...）
 * 挂进外部 MCP 通道，代理就能自主分析 .pcap：协议分层、会话矩阵、DNS/HTTP 提取、
 * 异常（端口扫描/DNS 隧道/明文口令）一整套。
 *
 * 设计口径：
 * - **不引 Node 侧的抓包依赖**。Wireshark 是用户自己装的，我们只负责「找到它」，
 *   分析全部交给 MCP 服务器（Python 侧跑 tshark）——这样协议解析永远是 Wireshark
 *   官方的，不会因为我们的解析器版本落后而误判。
 * - **探测 ≠ 安装**。本模块只做只读探测，找不到就如实回报候选路径与缺失项，
 *   由 UI 引导用户装 Wireshark，绝不静默下载（装驱动级组件必须用户知情）。
 * - 与 `core/ensp/launcher.ts` 同构：设置项 → 环境变量 → 注册表 → 常见路径。
 */

/** Wireshark CLI 工具在命令行的名字（Windows 带 .exe，由 resolveTool 补） */
export type WiresharkTool = 'tshark' | 'capinfos' | 'mergecap' | 'editcap' | 'dumpcap' | 'text2pcap'

/** 工具的重要程度：只有 tshark 是硬需求，其余缺失只损失部分功能 */
export type ToolRequirement = 'required' | 'recommended' | 'optional'

export const TOOL_REQUIREMENT: Record<WiresharkTool, ToolRequirement> = {
  tshark: 'required',
  capinfos: 'recommended',
  mergecap: 'recommended',
  editcap: 'optional',
  dumpcap: 'optional',
  text2pcap: 'optional'
}

/**
 * wireshark-mcp 读取的工具路径环境变量。
 * 注意名字带 `_MCP_` 中缀：这是那个包的约定（不是 Wireshark 自己的），照抄即可。
 */
export const TOOL_ENV_VAR: Record<WiresharkTool, string> = {
  tshark: 'WIRESHARK_MCP_TSHARK_PATH',
  capinfos: 'WIRESHARK_MCP_CAPINFOS_PATH',
  mergecap: 'WIRESHARK_MCP_MERGECAP_PATH',
  editcap: 'WIRESHARK_MCP_EDITCAP_PATH',
  dumpcap: 'WIRESHARK_MCP_DUMPCAP_PATH',
  text2pcap: 'WIRESHARK_MCP_TEXT2PCAP_PATH'
}

/** 工具的用途说明（UI 解释「缺了它会少什么功能」用） */
export const TOOL_PURPOSE: Record<WiresharkTool, string> = {
  tshark: '核心解析引擎：读懂 pcap、按协议拆包、导出字段',
  capinfos: '抓包文件概览：时长/包数/链路类型',
  mergecap: '合并多个抓包文件',
  editcap: '裁剪、切分、去重、平移时间戳',
  dumpcap: '底层实时抓包（tshark 实时抓包走它）',
  text2pcap: '十六进制文本转 pcap（手工构造测试包）'
}

export interface WiresharkToolHit {
  tool: WiresharkTool
  requirement: ToolRequirement
  /** 找到的绝对路径；未找到为 null */
  path: string | null
  purpose: string
}

export interface WiresharkProbe {
  /** 全部工具都命中才算 ready；tshark 命中则 canAnalyze=true */
  ready: boolean
  /** 具备离线分析能力（tshark 在） */
  canAnalyze: boolean
  /** 具备实时抓包能力（tshark + dumpcap 都在） */
  canCapture: boolean
  tools: WiresharkToolHit[]
  /** Wireshark 安装根目录（由 tshark 反推）；找不到为 null */
  suiteDir: string | null
  /** 探测来源，用于向用户解释「我是从哪儿找到的」 */
  source: 'setting' | 'env' | 'registry' | 'common' | 'none'
  /** tshark 版本字符串（探测成功时） */
  version: string | null
  /** 缺失的必装/推荐工具名，用于给出修复建议 */
  missing: WiresharkTool[]
}

const WS_ENV = 'WIRESHARK_DIR'
const WS_EXE_ENV = 'TSHARK_PATH'

const COMMON_DIRS = [
  'C:\\Program Files\\Wireshark',
  'C:\\Program Files (x86)\\Wireshark',
  'D:\\Program Files\\Wireshark',
  'D:\\Wireshark',
  'E:\\Wireshark',
  'E:\\Netexe\\Wireshark',
  'F:\\Wireshark'
]

const exeName = (t: WiresharkTool): string => (process.platform === 'win32' ? `${t}.exe` : t)

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** 从「已知的某个工具绝对路径」推出安装根目录（同级目录即根） */
function dirOfTool(toolPath: string): string | null {
  // v1.8：原实现三元两分支相同（死分支），即目录自身就是根
  return path.dirname(toolPath)
}

/**
 * 从注册表读取 Wireshark 安装目录。
 *
 * 与 eNSP 定位踩过的坑一致：中文 Windows 上默认值名是「(默认)」而不是英文，
 * 不能按「值名行」去取；这里改为全文匹配冒号后的绝对路径。
 */
function probeRegistryDir(): string | null {
  if (process.platform !== 'win32') return null
  const keys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Wireshark',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Wireshark'
  ]
  for (const key of keys) {
    try {
      const out = execFileSync('reg', ['query', key, '/v', 'InstallLocation'], {
        encoding: 'latin1',
        timeout: 1500,
        windowsHide: true
      })
      const m = out.match(/REG_SZ\s+(.+?)\s*$/m)
      if (m?.[1]) {
        const dir = m[1].trim().replace(/^"|"$/g, '')
        if (isFile(path.join(dir, exeName('tshark')))) return dir
      }
    } catch {
      // 键不存在很正常（注册版才写），继续下一处
    }
  }
  return null
}

/** 读 tshark 版本：`TShark (Wireshark) 2.6.7 (...)` 取第一段 */
function readTsharkVersion(tsharkPath: string): string | null {
  try {
    const out = execFileSync(tsharkPath, ['-v'], {
      encoding: 'latin1',
      timeout: 4000,
      windowsHide: true
    })
    const m = out.match(/TShark\s*\(Wireshark\)\s*([\w.]+)/i)
    return m?.[1] ?? null
  } catch {
    return null
  }
}

export interface ProbeOptions {
  /** 设置里用户显式指定的 Wireshark 目录（优先级最高） */
  overrideDir?: string
  /**
   * 已由异步路径预先查好的注册表目录。
   * `undefined` = 没预查（本函数自己同步查）；`null` = 查过了但没找到。
   * 有它才能让异步路径完全避开同步 `reg query`（T4.4）。
   */
  preResolvedRegDir?: string | null
  /** 跳过版本读取（tshark -v 要跑几秒），由异步路径稍后补齐 */
  skipVersion?: boolean
}

/**
 * 探测结果 TTL 缓存（T4.4）。
 *
 * 一次冷探测要跑 `reg query`（timeout 1.5s）+ `tshark -v`（timeout 4s），
 * 而 Wireshark 面板每次打开、每次挂载/卸载都会探一次。
 * 30 秒内复用同一份结果，界面就不会因为「切个 Tab」而卡住。
 */
const PROBE_TTL_MS = 30_000
let probeCache: { key: string; at: number; value: WiresharkProbe } | null = null

/** 显式失效缓存（用户改了目录 / 装完组件后调用） */
export function invalidateWiresharkProbeCache(): void {
  probeCache = null
}

/**
 * 探测本机 Wireshark 工具链。纯只读，任何异常都吞掉转成「未找到」。
 */
export function probeWireshark(opts: ProbeOptions = {}): WiresharkProbe {
  const cacheKey = (opts.overrideDir ?? '').trim()
  if (!opts.preResolvedRegDir && !opts.skipVersion && probeCache && probeCache.key === cacheKey) {
    if (Date.now() - probeCache.at < PROBE_TTL_MS) return probeCache.value
  }

  let suiteDir: string | null = null
  let source: WiresharkProbe['source'] = 'none'

  // ① 设置项指定的目录
  const override = (opts.overrideDir ?? '').trim()
  if (override && isFile(path.join(override, exeName('tshark')))) {
    suiteDir = override
    source = 'setting'
  }

  // ② 环境变量：WIRESHARK_DIR 指目录；TSHARK_PATH 指文件
  if (!suiteDir) {
    const envDir = (process.env[WS_ENV] ?? '').trim()
    if (envDir && isFile(path.join(envDir, exeName('tshark')))) {
      suiteDir = envDir
      source = 'env'
    }
  }
  if (!suiteDir) {
    const tsharkEnv = (process.env[WS_EXE_ENV] ?? '').trim()
    if (tsharkEnv && isFile(tsharkEnv)) {
      suiteDir = dirOfTool(tsharkEnv)
      source = 'env'
    }
  }

  // ③ 注册表（异步路径会预查好传进来，避免同步阻塞）
  if (!suiteDir) {
    const regDir = opts.preResolvedRegDir !== undefined ? opts.preResolvedRegDir : probeRegistryDir()
    if (regDir) {
      suiteDir = regDir
      source = 'registry'
    }
  }

  // ④ 常见安装路径
  if (!suiteDir) {
    for (const d of COMMON_DIRS) {
      if (isFile(path.join(d, exeName('tshark')))) {
        suiteDir = d
        source = 'common'
        break
      }
    }
  }

  const tools: WiresharkToolHit[] = (Object.keys(TOOL_REQUIREMENT) as WiresharkTool[]).map((tool) => {
    const p = suiteDir ? path.join(suiteDir, exeName(tool)) : ''
    return {
      tool,
      requirement: TOOL_REQUIREMENT[tool],
      path: p && isFile(p) ? p : null,
      purpose: TOOL_PURPOSE[tool]
    }
  })

  const tsharkHit = tools.find((t) => t.tool === 'tshark')
  const dumpcapHit = tools.find((t) => t.tool === 'dumpcap')
  const canAnalyze = Boolean(tsharkHit?.path)
  const canCapture = canAnalyze && Boolean(dumpcapHit?.path)
  const missing = tools.filter((t) => !t.path && t.requirement !== 'optional').map((t) => t.tool)

  const result: WiresharkProbe = {
    ready: canAnalyze,
    canAnalyze,
    canCapture,
    tools,
    suiteDir,
    source,
    version:
      !opts.skipVersion && tsharkHit?.path ? readTsharkVersion(tsharkHit.path) : null,
    missing
  }
  if (!opts.preResolvedRegDir && !opts.skipVersion) {
    probeCache = { key: cacheKey, at: Date.now(), value: result }
  }
  return result
}

/** 异步版 `reg query`：不再阻塞主进程事件循环 */
async function probeRegistryDirAsync(): Promise<string | null> {
  if (process.platform !== 'win32') return null
  const keys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Wireshark',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Wireshark'
  ]
  for (const key of keys) {
    try {
      const { stdout } = await execFileAsync('reg', ['query', key, '/v', 'InstallLocation'], {
        encoding: 'latin1',
        timeout: 1500,
        windowsHide: true
      })
      const m = stdout.match(/REG_SZ\s+(.+?)\s*$/m)
      if (m?.[1]) {
        const dir = m[1].trim().replace(/^"|"$/g, '')
        if (isFile(path.join(dir, exeName('tshark')))) return dir
      }
    } catch {
      // 键不存在很正常，继续下一处
    }
  }
  return null
}

/** 异步版版本读取 */
async function readTsharkVersionAsync(tsharkPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(tsharkPath, ['-v'], {
      encoding: 'latin1',
      timeout: 4000,
      windowsHide: true
    })
    const m = stdout.match(/TShark\s*\(Wireshark\)\s*([\w.]+)/i)
    return m?.[1] ?? null
  } catch {
    return null
  }
}

/**
 * 异步探测（T4.4）：与同步版结果一致，但**不阻塞事件循环**。
 *
 * 做法是把两处慢 IO（`reg query` 与 `tshark -v`）挪到异步分支：
 * 同步版负责纯文件系统判定（快），慢步骤由这里补齐后合并结果。
 */
export async function probeWiresharkAsync(opts: ProbeOptions = {}): Promise<WiresharkProbe> {
  const cacheKey = (opts.overrideDir ?? '').trim()
  if (!opts.overrideDir && probeCache && probeCache.key === cacheKey) {
    if (Date.now() - probeCache.at < PROBE_TTL_MS) return probeCache.value
  }

  const regDir = await probeRegistryDirAsync()
  const probe = probeWireshark({ ...opts, preResolvedRegDir: regDir, skipVersion: true })
  const tsharkHit = probe.tools.find((t) => t.tool === 'tshark')
  const version = tsharkHit?.path ? await readTsharkVersionAsync(tsharkHit.path) : null
  const result: WiresharkProbe = { ...probe, version }
  probeCache = { key: cacheKey, at: Date.now(), value: result }
  return result
}

/** 探测来源的中文说明（UI 与日志共用，避免文案漂移） */
export const WS_SOURCE_LABEL: Record<WiresharkProbe['source'], string> = {
  setting: '设置指定',
  env: '环境变量',
  registry: '注册表安装记录',
  common: '常见安装路径',
  none: ''
}

// —— MCP 服务器供给 ——
//
// 上游包 `wireshark-mcp`（MIT，bx33661/Wireshark-MCP）是 Python 的 stdio MCP 服务器，
// 52 个工具、官方 tshark 背书。我们不 vendor 它的代码，只在首次使用时准备一个隔离
// venv 装它（见 provisionWiresharkMcp），配置成外部 MCP 服务器交给既有的
// McpClientManager —— 复用「工具注入 + 人工闸门 + 信任降级」一整套现成机制。

/** MCP 服务器注册名（会进工具名 mcp__<name>__<tool>，须短） */
export const WS_MCP_SERVER_NAME = 'wireshark'

/** MCP 服务器 id（固定，便于幂等 upsert） */
export const WS_MCP_SERVER_ID = 'm-wireshark'

/**
 * 工具面档位。
 * - analysis：40 个工具，砍掉实时抓包与写文件 —— eNSP 场景绝大多数是「分析别人给
 *   的 pcap」，用不着拨网卡；顺带把每个请求固定多付的 ~17KB 工具 schema 降下来。
 * - full：52 个，要实时抓包时用。
 */
export type WsMcpProfile = 'analysis' | 'full'

export interface WsMcpPaths {
  /** 隔离 venv 的 python 解释器 */
  python: string
  /** 已安装的 wireshark-mcp 入口脚本（不存在则需先 provision） */
  entry: string | null
}

/** 默认安装位置：userData 下的 py 目录（不与项目 node_modules 混在一起） */
export function wiresharkMcpPaths(userDataDir: string): WsMcpPaths {
  const base = path.join(userDataDir, 'py', 'wireshark-mcp')
  const python =
    process.platform === 'win32'
      ? path.join(base, 'Scripts', 'python.exe')
      : path.join(base, 'bin', 'python')
  const entry =
    process.platform === 'win32'
      ? path.join(base, 'Scripts', 'wireshark-mcp.exe')
      : path.join(base, 'bin', 'wireshark-mcp')
  return { python, entry: isFile(entry) ? entry : null }
}

export interface WsMcpAvailability {
  /** 是否已装好（venv + 入口脚本都在） */
  installed: boolean
  /** 能否直接注册使用（装好了 且 tshark 在） */
  usable: boolean
  paths: WsMcpPaths
  probe: WiresharkProbe
  /** 不可用时的原因（中文，UI 直接展示） */
  reason: string | null
}

export function checkWiresharkMcp(userDataDir: string, overrideDir?: string): WsMcpAvailability {
  const probe = probeWireshark({ overrideDir })
  const paths = wiresharkMcpPaths(userDataDir)
  const installed = Boolean(paths.entry) && isFile(paths.python)

  let reason: string | null = null
  if (!installed) reason = '尚未安装 Wireshark 分析组件（需一次性联网安装）'
  else if (!probe.canAnalyze) reason = '未找到 tshark，请先安装 Wireshark'

  return { installed, usable: installed && probe.canAnalyze, paths, probe, reason }
}

/** 异步版 checkWiresharkMcp（IPC 热路径用，避免同步探测阻塞） */
export async function checkWiresharkMcpAsync(
  userDataDir: string,
  overrideDir?: string
): Promise<WsMcpAvailability> {
  const probe = await probeWiresharkAsync({ overrideDir })
  const paths = wiresharkMcpPaths(userDataDir)
  const installed = Boolean(paths.entry) && isFile(paths.python)

  let reason: string | null = null
  if (!installed) reason = '尚未安装 Wireshark 分析组件（需一次性联网安装）'
  else if (!probe.canAnalyze) reason = '未找到 tshark，请先安装 Wireshark'

  return { installed, usable: installed && probe.canAnalyze, paths, probe, reason }
}

/**
 * 由探测结果生成 MCP 服务器配置。
 *
 * 工具路径全部走 env 显式传入：这不只是「顺便」，而是必需的 —— Wireshark 装到
 * 非默认目录时它自己的目录未必在 PATH 上，包自带的环境变量是最可靠的通道。
 * 另外 profile 用命令行参数选，避免为两档维护两份配置。
 */
export function buildWiresharkMcpConfig(
  availability: WsMcpAvailability,
  opts: { profile?: WsMcpProfile; enabled?: boolean; trusted?: boolean } = {}
): McpServerConfig | null {
  if (!availability.installed || !availability.paths.entry) return null
  if (!availability.probe.canAnalyze) return null

  const profile: WsMcpProfile = opts.profile === 'full' ? 'full' : 'analysis'
  return {
    id: WS_MCP_SERVER_ID,
    name: WS_MCP_SERVER_NAME,
    transport: 'stdio',
    url: '',
    command: availability.paths.entry,
    args: ['serve', '--profile', profile],
    enabled: opts.enabled ?? true,
    // 默认**不信任**：外部工具一律走人工闸门。抓包分析多为只读，但 profile=full 时
    // 含实时抓包与写文件工具，让用户显式点头更稳妥。
    trusted: opts.trusted ?? false
  }
}

/**
 * 分析档位下**只读**的典型工具名，供 UI 提示「这些是免风险的分析动作」。
 * 服务器侧另有 readOnlyHint 注解，这里只用于文案。
 */
export const WS_READONLY_HIGHLIGHTS = [
  'wireshark_open_file',
  'wireshark_quick_analysis',
  'wireshark_stats_protocol_hierarchy',
  'wireshark_stats_conversations',
  'wireshark_stats_expert_info',
  'wireshark_extract_dns_queries',
  'wireshark_extract_http_requests'
] as const

/** 供依赖注入的类型（避免 ipc 层直接 mock 子进程） */
export type { McpServerConfig }