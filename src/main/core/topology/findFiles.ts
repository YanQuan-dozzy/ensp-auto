import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 拓扑文件发现（v1.2，参照 ensp-mcp find_topology_files）。
 *
 * 在用户常用目录（桌面 / 文档 / 下载）或指定目录下递归寻找 *.topo，返回结构化候选列表，
 * 供 UI 快捷导入与 AI 代理自选拓扑。只读文件元数据（mtime），不读文件内容。
 *
 * 排序：活动拓扑 > 目录同名（<dir>.topo）> 最近修改 > 路径字典序；结果截断到 maxResults。
 */

export interface TopoFileCandidate {
  path: string
  name: string
  directory: string
  source: string
  modifiedAt: number
  isNamedAfterDirectory: boolean
  isActive: boolean
}

export interface FindTopologyResult {
  count: number
  truncated: boolean
  activeTopology: string | null
  candidates: TopoFileCandidate[]
}

export interface FindTopologyOptions {
  /** 指定目录（相对路径按用户主目录解析）；缺省扫描桌面/文档/下载 */
  directory?: string
  /** 当前活动拓扑路径，命中者排最前并标 is_active */
  activePath?: string | null
  /** 递归深度（默认 4，防误扫大型目录树） */
  maxDepth?: number
  /** 返回数量上限（默认 20，范围 1-200） */
  maxResults?: number
}

/** 扫描时跳过的目录（避免深入依赖/构建产物） */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'out', 'dist', 'build', '.build',
  '.cache', '.idea', '.vscode', '__pycache__', '.next', 'backup'
])

export function defaultSearchRoots(): { source: string; path: string }[] {
  const home = os.homedir()
  const out: { source: string; path: string }[] = []
  const add = (source: string, dir: string): void => {
    if (!dir) return
    let resolved: string
    try {
      resolved = path.resolve(dir)
    } catch {
      return
    }
    try {
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        out.push({ source, path: resolved })
      }
    } catch {
      /* 无权限/不存在则跳过 */
    }
  }
  add('desktop', path.join(home, 'Desktop'))
  add('desktop', path.join(home, '桌面'))
  add('documents', path.join(home, 'Documents'))
  add('documents', path.join(home, '文档'))
  add('downloads', path.join(home, 'Downloads'))
  add('downloads', path.join(home, '下载'))
  return out
}

export function findTopologyFiles(opts?: FindTopologyOptions): FindTopologyResult {
  const maxDepth = Math.max(1, Math.min(10, opts?.maxDepth ?? 4))
  const maxResults = Math.max(1, Math.min(200, opts?.maxResults ?? 20))

  let roots: { source: string; path: string }[]
  if (opts?.directory) {
    roots = [{ source: 'custom', path: path.resolve(opts.directory) }]
  } else {
    roots = defaultSearchRoots()
  }

  const activePath = opts?.activePath ? path.resolve(opts.activePath) : null
  const candidatePaths = new Set<string>()
  const candidates: TopoFileCandidate[] = []

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return // 无权限目录跳过
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue
      const full = path.join(dir, ent.name)
      try {
        if (ent.isDirectory()) {
          if (!SKIP_DIRS.has(ent.name.toLowerCase())) walk(full, depth + 1)
        } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.topo')) {
          const resolved = path.resolve(full)
          if (candidatePaths.has(resolved)) continue
          candidatePaths.add(resolved)
          const stat = fs.statSync(resolved)
          candidates.push({
            path: resolved,
            name: ent.name,
            directory: dir,
            source: dir,
            modifiedAt: Math.trunc(stat.mtimeMs),
            isNamedAfterDirectory: safeStem(ent.name) === path.basename(dir),
            isActive: activePath !== null && resolved.toLowerCase() === activePath.toLowerCase()
          })
        }
      } catch {
        /* 单个条目 stat 失败跳过 */
      }
    }
  }

  for (const root of roots) {
    try {
      if (fs.existsSync(root.path) && fs.statSync(root.path).isDirectory()) walk(root.path, 1)
    } catch {
      /* 根目录不可读则跳过 */
    }
  }

  candidates.sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1
    if (a.isNamedAfterDirectory !== b.isNamedAfterDirectory) return a.isNamedAfterDirectory ? -1 : 1
    if (b.modifiedAt !== a.modifiedAt) return b.modifiedAt - a.modifiedAt
    return a.path.toLowerCase() < b.path.toLowerCase() ? -1 : 1
  })

  const limited = candidates.slice(0, maxResults)
  // source 收敛为根目录名（路径太长对 UI/AI 噪声大）
  const rootSet = new Set(roots.map((r) => r.path))
  for (const c of limited) {
    c.source = narrowSource(c.source, rootSet)
  }

  return {
    count: limited.length,
    truncated: candidates.length > limited.length,
    activeTopology: activePath,
    candidates: limited
  }
}

function safeStem(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/** 候选目录名太长时收缩为最近一个匹配搜索根的目录名 */
function narrowSource(dir: string, rootSet: Set<string>): string {
  let cur = dir
  for (let guard = 0; guard < 8; guard++) {
    if (rootSet.has(cur)) return path.basename(cur) || cur
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return path.basename(dir) || dir
}