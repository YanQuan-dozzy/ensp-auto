import fs from 'node:fs'
import path from 'node:path'
import type { Device } from '@shared/types'
import { deriveTopology, type TopologyProbe } from '../core/topology/fromNeighbors'
import { readTopoFile } from '../core/topology/fromProjectFile'
import { findTopologyFiles, type FindTopologyResult } from '../core/topology/findFiles'
import { writeTopoFile } from '../core/topology/toProjectFile'
import { launchTopologyFile, resolveEnspExe } from '../core/ensp/launcher'
import { emptyTopology, type Topology } from '../core/topology/model'
import { assertInsideOrEqual } from '../core/storage/usage'
import type { SessionManager } from '../core/session/SessionManager'
import { fail, ok, Type, type ToolSpec } from './registry'

/**
 * 拓扑类工具（v0.3 / F-5.5：拓扑数据可被代理读取，作为推理上下文）。
 *
 * - get_topology：只读当前合并结果（实采 + 手动补画）
 * - refresh_topology：对已连接设备实采 `display lldp neighbor` 重新推导并写回 store
 *
 * 工程文件解析（F-5.2，P2）与实时链路状态（F-5.6，P2）暂未实现，见 README 已知限制。
 */

/** 从会话管理器收集「已连接、可探测」的设备探针（工具与 IPC 共用，避免两处实现） */
export function probesFromSessions(
  sessions: SessionManager
): TopologyProbe[] {
  return sessions
    .list()
    .filter((d: Device) => d.connected)
    .map((d) => sessions.get(d.id))
    .filter((s): s is NonNullable<typeof s> => !!s)
    .map((s) => ({
      id: s.id,
      name: s.name,
      ...(s.model ? { model: s.model } : {}),
      exec: (cmd: string, opts?: { timeoutMs?: number; signal?: AbortSignal }) =>
        s.exec(cmd, opts)
    }))
}

export const getTopology: ToolSpec<Record<string, never>> = {
  name: 'get_topology',
  description:
    '读取当前网络拓扑（结构化数据：设备节点、角色、链路与端口标签）。' +
    '拓扑来自实采推导与手动补画的合并结果。需要了解设备间连接关系时先用本工具。',
  risk: 'read',
  scope: 'device',
  schema: Type.Object({}),
  summarize: (_args, result) => {
    const t = result.data as Topology | undefined
    return `拓扑：${t?.nodes?.length ?? 0} 节点 / ${t?.links?.length ?? 0} 链路`
  },
  handler: async (_args, ctx) => {
    const t0 = Date.now()
    const t = ctx.topology.snapshot()
    if (!t.nodes.length && !t.links.length) {
      return ok(
        { ...emptyTopology(), hint: '拓扑为空，可用 refresh_topology 从已连接设备实采推导' },
        { ms: Date.now() - t0 }
      )
    }
    return ok(t, { ms: Date.now() - t0 })
  }
}

export const refreshTopology: ToolSpec<Record<string, never>> = {
  name: 'refresh_topology',
  description:
    '对当前已连接的设备执行 display lldp neighbor 重新推导拓扑并保存。' +
    'LLDP 未开启的设备会自动跳过。适合设备连接情况变化后刷新。',
  risk: 'read',
  scope: 'device',
  schema: Type.Object({}),
  summarize: (_args, result) => {
    const t = result.data as Topology | undefined
    return `重推拓扑：${t?.nodes?.length ?? 0} 节点 / ${t?.links?.length ?? 0} 链路`
  },
  handler: async (_args, ctx) => {
    const t0 = Date.now()
    const t = await deriveTopology(probesFromSessions(ctx.sessions), {
      ...(ctx.signal ? { signal: ctx.signal } : {})
    })
    ctx.topology.set(t)
    return ok(t, { ms: Date.now() - t0 })
  }
}

/**
 * 拓扑发现（v1.2，参照 ensp-mcp find_topology_files）：在本机常用目录或指定目录
 * 递归寻找 *.topo，返回结构化候选列表（路径/来源/修改时间/是否活动/是否目录同名），
 * 用于「目录混乱时先定位环境」与 UI 快捷导入。只读元数据，不读文件内容。
 */
export const findTopologyFilesTool: ToolSpec<{
  directory?: string
  maxDepth?: number
  maxResults?: number
}> = {
  name: 'find_topology_files',
  description:
    '在本机查找 eNSP 工程文件（.topo）：缺省扫描桌面/文档/下载，也可指定目录。' +
    '返回结构化候选列表（路径、来源、修改时间、是否当前活动拓扑）。' +
    '不知道拓扑在哪里时优先用本工具定位，再配合 import_topology_file 导入。',
  risk: 'read',
  scope: 'local',
  schema: Type.Object(
    {
      directory: Type.Optional(
        Type.String({ description: '限定搜索的目录；缺省扫描桌面/文档/下载' })
      ),
      maxDepth: Type.Optional(
        Type.Integer({
          description: '递归深度（1-10，默认 3）。模型可能被诱导扫大型目录树，深度要主动收敛',
          default: 3
        })
      ),
      maxResults: Type.Optional(
        Type.Integer({ description: '返回数量上限，默认 20', default: 20 })
      )
    },
    { additionalProperties: false }
  ),
  summarize: (_args, result) => {
    const d = result.data as FindTopologyResult | undefined
    return `发现拓扑文件 ${d?.count ?? 0} 个${d?.truncated ? '（已截断）' : ''}`
  },
  handler: async (args, ctx) => {
    const t0 = Date.now()
    const directory = (args.directory ?? '').trim()
    if (directory && (path.extname(directory) || !fs.existsSync(directory) || !fs.statSync(directory).isDirectory())) {
      return fail('BAD_PARAM', `目录不存在或不是目录：${directory}`, { ms: Date.now() - t0 })
    }
    const result = findTopologyFiles({
      ...(directory ? { directory } : {}),
      activePath: ctx.topology.fileSourcePath,
      // v1.8：maxDepth 显式收敛（原实现默认 4 层，指定目录扫描大型目录树仍可能很慢）
      ...(args.maxDepth !== undefined ? { maxDepth: args.maxDepth } : { maxDepth: 3 }),
      ...(args.maxResults ? { maxResults: args.maxResults } : {})
    })
    return ok(result, { ms: Date.now() - t0 })
  }
}

/**
 * 工程文件解析（F-5.2，来源一）：导入 eNSP .topo 作为拓扑第一来源。
 * 白名单：仅 .topo 扩展、resolve 后不逃逸出任意目录、文件存在。
 */
export const importTopologyFile: ToolSpec<{ path: string }> = {
  name: 'import_topology_file',
  description:
    '解析 eNSP 工程文件（.topo）作为拓扑的第一来源并保存：设备（name/model/坐标/com_port）与接口链路。' +
    '与 LLDP 实采、画布手补三层降级合并，文件最权威。返回拓扑与解析结构报告（设备/链路数、警告）。',
  risk: 'read',
  scope: 'local',
  schema: Type.Object(
    { path: Type.String({ description: '.topo 文件的绝对路径' }) },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    const d = result.data as { report?: { devices?: number; links?: number; warnings?: string[] } } | undefined
    return `导入 ${path.basename(args.path)}（${d?.report?.devices ?? 0} 设备 / ${d?.report?.links ?? 0} 链路${d?.report?.warnings?.length ? `，${d.report.warnings.length} 条警告` : ''}）`
  },
  handler: async (args, ctx) => {
    const t0 = Date.now()
    const filePath = args.path?.trim() ?? ''
    // —— 白名单校验（防目录穿越/伪造扩展）——
    if (path.extname(filePath).toLowerCase() !== '.topo') {
      return fail('BAD_PARAM', '只支持 .topo 文件', { ms: Date.now() - t0 })
    }
    const resolved = path.resolve(filePath)
    // v1.8：path.resolve 已把 `..` 归一化，旧检查恒为 false（徒增安心感）。
    // 唯一有效的防线是下方扩展名白名单 + 存在性检查
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return fail('BAD_PARAM', `文件不存在：${resolved}`, { ms: Date.now() - t0 })
    }

    try {
      const { topology, report } = readTopoFile(resolved)
      if (report.devices === 0) {
        return fail('UNKNOWN', `未能从 .topo 中识别设备（${report.warnings[0] ?? '格式未知'}）`, { ms: Date.now() - t0 })
      }
      ctx.topology.setFile(topology)
      ctx.topology.setFileSource(resolved)
      return ok({ topology, report, path: resolved }, { ms: Date.now() - t0 })
    } catch (e) {
      return fail('UNKNOWN', `解析 ${path.basename(resolved)} 失败：${e instanceof Error ? e.message : String(e)}`, { ms: Date.now() - t0 })
    }
  }
}

/**
 * 工程文件写回（F-5.7）：把当前合并拓扑（工程文件 / LLDP 实采 / 画布手补）保存为
 * eNSP .topo 工程文件，可选调用 eNSP 打开 —— 让 AI 生成/修改的拓扑落到 eNSP 可见。
 */
export const saveTopoFile: ToolSpec<{ path?: string; openInEnsp?: boolean }> = {
  name: 'save_topo_file',
  description:
    '把当前拓扑（工程文件/实采/手补的合并结果）保存为 eNSP 工程文件（.topo）：设备、端口分配、坐标与链路。' +
    'openInEnsp=true 时保存后调用本机 eNSP 打开该工程（画布一次性加载，不会热更新）。' +
    '适用于需要把修改后的拓扑落到 eNSP 中打开的场景。返回文件路径、设备/链路数与端口分配表。' +
    'path 必须位于导出目录（设置 → 通用 → 报告导出目录）内且目标文件不存在 —— 越界或同名一律拒绝，避免覆盖用户已有工程。',
  risk: 'write',
  scope: 'local',
  schema: Type.Object(
    {
      path: Type.Optional(
        Type.String({
          description:
            '输出 .topo 的路径，必须位于导出目录内且以 .topo 结尾；缺省自动生成到导出目录'
        })
      ),
      openInEnsp: Type.Optional(
        Type.Boolean({ description: '保存后调用 eNSP 打开该工程（默认 false）。仅本机已安装 eNSP 时有效' })
      )
    },
    { additionalProperties: false }
  ),
  summarize: (_args, result) => {
    const d = result.data as
      | { path?: string; devices?: number; links?: number; opened?: boolean }
      | undefined
    return `保存拓扑 → ${d?.path ? path.basename(d.path) : '?'}（${d?.devices ?? 0} 设备 / ${d?.links ?? 0} 链路${d?.opened ? '，已打开 eNSP' : ''}）`
  },
  handler: async (args, ctx) => {
    const t0 = Date.now()
    const topo = ctx.topology.snapshot()
    if (!topo.nodes.length) {
      return fail('UNKNOWN', '拓扑为空，无内容可保存（可先用 import_topology_file 或 refresh_topology 生成拓扑）', {
        ms: Date.now() - t0
      })
    }

    // —— 输出路径：必须落在导出目录内（D5，2026-09-23）——
    //
    // v1.8 删掉了「限制在 exportsDir 内」的检查，理由是 path.resolve 已归一化 `..`。
    // 但 path.resolve **不是边界校验**，它只把相对路径拼成绝对路径 ——
    // 于是 path 参数实际可以指向磁盘任意位置，而该工具 risk 是 write、handler 里
    // 也不请求闸门，落盘走 renameSync 且目标存在时静默覆盖：
    // 一条 `save_topo_file({path:'D:\\实验\\旧工程.topo'})` 就能无声覆盖用户攒的工程文件。
    let outPath = (args.path ?? '').trim()
    if (outPath) {
      if (path.extname(outPath).toLowerCase() !== '.topo') {
        return fail('BAD_PARAM', '输出路径必须以 .topo 结尾', { ms: Date.now() - t0 })
      }
      const resolved = path.resolve(outPath)
      try {
        assertInsideOrEqual(ctx.exportsDir, resolved)
      } catch {
        return fail(
          'BAD_PARAM',
          `输出路径必须位于导出目录内：${ctx.exportsDir}（收到 ${resolved}）`,
          { ms: Date.now() - t0 }
        )
      }
      if (fs.existsSync(resolved)) {
        return fail(
          'BAD_PARAM',
          `目标文件已存在，为避免覆盖请换一个文件名或先删除：${resolved}`,
          { ms: Date.now() - t0 }
        )
      }
      outPath = resolved
    } else {
      outPath = path.join(ctx.exportsDir, `topo-${Date.now()}.topo`)
    }

    try {
      const { report } = writeTopoFile(outPath, topo, { startPort: ctx.settings.scanStart })
      const data: { path: string; devices: number; links: number; ports: Record<string, number>; opened: boolean; warnings: string[] } = {
        path: outPath,
        devices: report.devices,
        links: report.links,
        ports: report.ports,
        opened: false,
        warnings: report.warnings
      }
      if (args.openInEnsp) {
        // v1.4：优先用设置里指定的 eNSP 路径，未指定时走自动探测（注册表关联 → 常见路径）
        const exeRes = resolveEnspExe(ctx.settings.ensp.exePath)
        if (!exeRes.ok) {
          data.warnings.push(exeRes.error)
        } else {
          const launch = launchTopologyFile(exeRes.exe, outPath)
          if (!launch.ok) data.warnings.push(`打开 eNSP 失败：${launch.error ?? '未知错误'}`)
          else data.opened = true
        }
      }
      return ok(data, { ms: Date.now() - t0 })
    } catch (e) {
      return fail('UNKNOWN', `保存 .topo 失败：${e instanceof Error ? e.message : String(e)}`, { ms: Date.now() - t0 })
    }
  }
}