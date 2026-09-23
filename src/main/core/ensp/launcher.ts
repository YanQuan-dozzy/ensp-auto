import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import type { EnspCandidate, EnspSource } from '@shared/types'

/**
 * eNSP 客户端定位（v1.4 重做）。
 *
 * 背景：v1.1 只认环境变量 ENSP_EXE_PATH + 写死的 `E:\eNSP\eNSP_Client.exe`，
 * 用户把 eNSP 装在别处就完全打不开拓扑。现在给出完整的优先级链：
 *
 *   设置面板指定 → ENSP_EXE_PATH → 注册表 .topo 文件关联 → 常见安装路径
 *
 * 注册表那条最可靠：eNSP 安装时会注册 `.topo` 关联，命令形如
 *   `"<eNSP>\eNSP_Client.exe" "%1"`
 * 反查它就能拿到用户真实的安装位置，不靠猜。
 *
 * 已知边界（留注释，避免过度工程）：
 * - eNSP 打开拓扑是一次性加载，不监听文件变化——AI 改完 .topo 后需重新「打开」才会
 *   刷新画布；若 eNSP 已打开其它未保存拓扑，会弹确认框（本模块不帮点，提示用户）。
 * - 设备「启动」仍是 eNSP GUI 内操作（社区共识：eNSP 无公开画布控制 API），本模块
 *   只负责打开工程。
 */

/** 环境变量覆盖：CI / 便携部署下不改设置也能指定 */
export const ENSP_ENV_PATH = process.env.ENSP_EXE_PATH?.trim() || ''

/** 历史默认路径，保留导出以免破坏既有引用；作为常见路径之一参与探测 */
export const DEFAULT_ENSP_EXE = ENSP_ENV_PATH || 'E:\\eNSP\\eNSP_Client.exe'

/** 常见安装位置。官方安装器默认落 C:\Program Files\Huawei\eNSP，社区版常放 D/E 盘根目录 */
export const ENSP_COMMON_PATHS: readonly string[] = [
  'C:\\Program Files\\Huawei\\eNSP\\eNSP_Client.exe',
  'C:\\Program Files (x86)\\Huawei\\eNSP\\eNSP_Client.exe',
  'D:\\Program Files\\Huawei\\eNSP\\eNSP_Client.exe',
  'E:\\Program Files\\Huawei\\eNSP\\eNSP_Client.exe',
  'D:\\eNSP\\eNSP_Client.exe',
  'E:\\eNSP\\eNSP_Client.exe',
  'F:\\eNSP\\eNSP_Client.exe'
]

function isExeFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * 从 `reg query` 的输出里抠出第一个 .exe 路径。
 *
 * 为什么不按「默认值那一行」取：中文 Windows 下该值名显示为「(默认)」而非
 * "(Default)"，且 ProgID 可能嵌套多层。全篇匹配第一个 .exe 路径与语言无关，
 * 也不受行序影响。
 *
 * 编码说明：reg 输出含 GBK 字节，这里按 utf8 解码——非 ASCII 字节会变成替换符，
 * 但路径本身是 ASCII，不受影响。
 */
export function parseExeFromRegOutput(raw: string): string | null {
  if (!raw) return null
  const quoted = /"([^"\r\n]*?\.exe)"/i.exec(raw)
  if (quoted?.[1]) return quoted[1].trim()
  const bare = /([A-Za-z]:\\[^\s\r\n"]*?\.exe)/i.exec(raw)
  return bare?.[1]?.trim() ?? null
}

function queryReg(args: readonly string[]): string {
  try {
    return execFileSync('reg', args as string[], {
      encoding: 'utf8',
      // 主进程是单线程的，同步查询会阻塞 IPC —— 键不存在时 reg 在数十毫秒内返回，
      // 这个上限只为兜住「reg 本身卡住」的极端情况，避免整个应用失去响应。
      timeout: 1500,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch {
    // 键不存在 / reg 不可用 / 超时：一律视为「没查到」，不影响其它候选
    return ''
  }
}

/** 读某个注册表键的默认值（REG_SZ），查不到返回空串 */
function queryRegDefault(key: string): string {
  const ve = queryReg(['query', key, '/ve'])
  const v = /REG_SZ\s+(.+?)\s*$/m.exec(ve)?.[1]?.trim()
  if (v) return v
  // 有些键没有默认值，退化为读首个 REG_SZ
  const any = queryReg(['query', key])
  return /REG_SZ\s+(.+?)\s*$/m.exec(any)?.[1]?.trim() ?? ''
}

/**
 * 通过 .topo 文件关联反查 eNSP_Client.exe。
 * 非 Windows 或未安装 eNSP 时返回 null（调用方继续走常见路径候选）。
 */
export function detectEnspFromRegistry(): string | null {
  if (process.platform !== 'win32') return null

  // 1) HKCR\.topo 的默认值 = ProgID
  const progId = queryRegDefault('HKCR\\.topo')
  if (progId && !progId.includes('\\')) {
    const cmd = queryRegDefault(`HKCR\\${progId}\\shell\\open\\command`)
    const exe = parseExeFromRegOutput(cmd)
    if (exe) return exe
  }

  // 2) 兜底：Applications 下的命令注册
  return parseExeFromRegOutput(
    queryRegDefault('HKCR\\Applications\\eNSP_Client.exe\\shell\\open\\command')
  )
}

export interface EnspLocateResult {
  found: string | null
  source: EnspSource
  /** 探测过的全部候选（含未命中的），供 UI 展开说明「我都找过哪儿」 */
  candidates: EnspCandidate[]
}

/**
 * 按优先级链定位 eNSP 客户端，并返回完整探测过程。
 * 这里刻意不抛错：定位失败是可预期的常态，由调用方决定怎么提示。
 */
export function locateEnsp(configuredPath?: string): EnspLocateResult {
  const candidates: EnspCandidate[] = []
  const seen = new Set<string>()
  const push = (p: string | null | undefined, source: EnspSource): void => {
    const t = (p ?? '').trim()
    if (!t) return
    const k = t.toLowerCase()
    if (seen.has(k)) return
    seen.add(k)
    candidates.push({ path: t, source, exists: isExeFile(t) })
  }

  push(configuredPath, 'setting')
  push(ENSP_ENV_PATH, 'env')
  push(detectEnspFromRegistry(), 'registry')
  for (const p of ENSP_COMMON_PATHS) push(p, 'common')

  const hit = candidates.find((c) => c.exists)
  return { found: hit?.path ?? null, source: hit?.source ?? 'none', candidates }
}

export type ResolveEnspResult =
  | { ok: true; exe: string; source: EnspSource }
  | { ok: false; error: string }

/** 解析 eNSP 可执行文件绝对路径；configuredPath（来自设置）优先，否则走自动探测 */
export function resolveEnspExe(configuredPath?: string): ResolveEnspResult {
  const r = locateEnsp(configuredPath)
  if (r.found) return { ok: true, exe: r.found, source: r.source }
  return {
    ok: false,
    error:
      '未找到 eNSP 客户端（eNSP_Client.exe）。可在「设置 → 集成 → eNSP 客户端」指定安装路径，' +
      '或用环境变量 ENSP_EXE_PATH 指定。'
  }
}

export interface LaunchResult {
  ok: boolean
  pid?: number
  error?: string
}

/** 拉起 eNSP 打开指定拓扑文件（detached，调用方不等待进程退出） */
export function launchTopologyFile(exePath: string, topoPath: string): LaunchResult {
  try {
    const child = spawn(exePath, [topoPath], { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
    // spawn 的同步错误（如被系统拦截）会以 error 事件异步到达；detached 下无法可靠拿回，
    // 记录到 stderr 即可（resolve 时已做存在性校验，此路径极罕见）。
    child.on('error', (e) => {
      console.error(`[ensp] 拉起 eNSP 失败：${e.message}`)
    })
    return { ok: true, pid: child.pid }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
