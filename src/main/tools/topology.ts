import fs from 'node:fs'
import path from 'node:path'
import type { Device } from '@shared/types'
import { deriveTopology, type TopologyProbe } from '../core/topology/fromNeighbors'
import { readTopoFile } from '../core/topology/fromProjectFile'
import { emptyTopology, type Topology } from '../core/topology/model'
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
    if (resolved.includes('..')) {
      return fail('BAD_PARAM', '路径不允许包含 ..', { ms: Date.now() - t0 })
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return fail('BAD_PARAM', `文件不存在：${resolved}`, { ms: Date.now() - t0 })
    }

    try {
      const { topology, report } = readTopoFile(resolved)
      if (report.devices === 0) {
        return fail('UNKNOWN', `未能从 .topo 中识别设备（${report.warnings[0] ?? '格式未知'}）`, { ms: Date.now() - t0 })
      }
      ctx.topology.setFile(topology)
      return ok({ topology, report, path: resolved }, { ms: Date.now() - t0 })
    } catch (e) {
      return fail('UNKNOWN', `解析 ${path.basename(resolved)} 失败：${e instanceof Error ? e.message : String(e)}`, { ms: Date.now() - t0 })
    }
  }
}