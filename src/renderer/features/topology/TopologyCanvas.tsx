import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  applyNodeChanges,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  type OnConnect,
  type OnNodesChange
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useApp } from '@/stores/app'
import type { TopologyLink, TopologyNode, TopologyRole } from '@shared/types'

/**
 * 拓扑画布（v0.3 / F-5.4 手动补画 + F-5.5 展示）。
 *
 * - 数据源：主进程 TopologyStore 的合并拓扑（实采推导 + 手动补画）
 * - 手动补画：画布内任意节点都可拖动（落位即保存）；工具栏可新增节点；
 *   任意两个节点间拖线即新增链路（F-5.4）
 * - 工具栏「从设备刷新」触发 refresh_topology 实采推导
 */

interface TopoNodeData {
  label: string
  role: TopologyRole
  model?: string
  [key: string]: unknown
}

const ROLE_LABEL: Record<TopologyRole, string> = {
  router: '路由器',
  switch: '交换机',
  pc: '终端',
  unknown: '未知'
}

const NODE_COLOR: Record<TopologyRole, string> = {
  router: 'var(--agent)',
  switch: 'var(--info)',
  pc: 'var(--success)',
  unknown: 'var(--text-muted)'
}

function TopoNode(props: NodeProps): ReactNode {
  const data = props.data as TopoNodeData
  const selected = props.selected ?? false
  const color = NODE_COLOR[data.role] ?? 'var(--text-muted)'
  return (
    <div
      className="topo-node"
      style={{
        borderColor: selected ? 'var(--accent)' : color,
        background: 'var(--bg-elevated)'
      }}
    >
      <Handle type="target" position={Position.Left} />
      <div className="topo-node-name" style={{ color: 'var(--text-primary)' }}>
        {data.label}
      </div>
      <div className="topo-node-sub" style={{ color }}>
        {ROLE_LABEL[data.role] ?? data.role}
        {data.model ? ` · ${data.model}` : ''}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

const TopoNodeMemo = memo(TopoNode)

const toFlowNodes = (nodes: TopologyNode[]): Node[] =>
  nodes.map((n, i) => ({
    id: n.id,
    position: {
      x: Number.isFinite(n.x) ? (n.x as number) : ((i % 4) * 240 + 40),
      y: Number.isFinite(n.y) ? (n.y as number) : (Math.floor(i / 4) * 130 + 40)
    },
    data: { label: n.name, role: n.role, ...(n.model ? { model: n.model } : {}) },
    type: 'topo'
  }))

const toFlowEdges = (links: TopologyLink[], nodeIds: Set<string>): Edge[] =>
  links
    .filter((l) => nodeIds.has(l.from) && nodeIds.has(l.to))
    .map((l) => ({ id: l.id, source: l.from, target: l.to, type: 'smoothstep', label: l.label }))

/** 画布节点的 data 收口成业务类型（避免在组件各处以 unknown 裸操） */
const dataOf = (node: Node): TopoNodeData => node.data as TopoNodeData

export function TopologyCanvas(): ReactNode {
  const topology = useApp((s) => s.topology)
  const refreshing = useApp((s) => s.topologyRefreshing)
  const refresh = useApp((s) => s.refreshTopology)
  const saveManual = useApp((s) => s.saveManualTopology)
  const importTopology = useApp((s) => s.importTopology)

  const [nodes, setNodes] = useState<Node[]>(() => toFlowNodes(topology.nodes))
  const [addName, setAddName] = useState('')
  const [addRole, setAddRole] = useState<TopologyRole>('unknown')
  const [importNotice, setImportNotice] = useState('')

  // 拓扑数据变化（刷新 / 合并 / 加载）时重建画布节点与连线
  useEffect(() => {
    setNodes(toFlowNodes(topology.nodes))
  }, [topology])

  const edges = useMemo(
    () => toFlowEdges(topology.links, new Set(topology.nodes.map((n) => n.id))),
    [topology]
  )

  const onNodesChange: OnNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((ns) => applyNodeChanges(changes, ns))
  }, [])

  const manualNodes = useMemo(
    () => topology.nodes.filter((n) => n.source === 'manual'),
    [topology]
  )
  const manualLinks = useMemo(
    () => topology.links.filter((l) => l.source === 'manual'),
    [topology]
  )

  // 拖动落位即保存：被拖过的节点（无论来源）并入手动集，写入主进程
  const onNodeDragStop = useCallback(
    (_e: unknown, node: Node) => {
      const d = dataOf(node)
      const others = manualNodes.filter((n) => n.id !== node.id)
      const moved: TopologyNode = {
        id: node.id,
        name: d.label,
        role: d.role,
        ...(typeof d.model === 'string' && d.model ? { model: d.model } : {}),
        x: node.position.x,
        y: node.position.y,
        source: 'manual'
      }
      void saveManual({ nodes: [...others, moved], links: manualLinks })
    },
    [manualNodes, manualLinks, saveManual]
  )

  const onConnect: OnConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target) return
      const link: TopologyLink = {
        id: `m-${Date.now()}`,
        from: conn.source,
        to: conn.target,
        label: '手动连线',
        source: 'manual'
      }
      void saveManual({ nodes: manualNodes, links: [...manualLinks, link] })
    },
    [manualNodes, manualLinks, saveManual]
  )

  const addNode = useCallback(() => {
    const name = addName.trim()
    if (!name) return
    const node: TopologyNode = {
      id: `m-node-${Date.now()}`,
      name,
      role: addRole,
      source: 'manual',
      x: 60 + Math.random() * 260,
      y: 60 + Math.random() * 200
    }
    void saveManual({ nodes: [...manualNodes, node], links: manualLinks })
    setAddName('')
  }, [addName, addRole, manualNodes, manualLinks, saveManual])

  // v1.0 前置：导入 eNSP 工程文件（F-5.2，来源一，最权威）
  const onImportFile = useCallback(async () => {
    setImportNotice('')
    const r = await importTopology()
    if (!r) {
      setImportNotice('已取消或导入失败')
      return
    }
    const w = r.report.warnings.length ? `（${r.report.warnings.length} 条警告）` : ''
    setImportNotice(`已导入 ${r.report.devices} 设备 / ${r.report.links} 链路${w}；文件层在其他来源之上优先。`)
  }, [importTopology])

  return (
    <div className="topology-wrap">
      <div className="topology-toolbar">
        <input
          className="topology-input"
          value={addName}
          onChange={(e) => setAddName(e.target.value)}
          placeholder="新节点名（如 PC-1）"
          onKeyDown={(e) => {
            if (e.key === 'Enter') addNode()
          }}
        />
        <select
          className="topology-input"
          value={addRole}
          onChange={(e) => setAddRole(e.target.value as TopologyRole)}
        >
          {(Object.keys(ROLE_LABEL) as TopologyRole[]).map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
        <button className="btn" onClick={addNode}>
          添加节点
        </button>
        <button className="btn" onClick={() => void onImportFile()}>
          导入工程文件
        </button>
        <button className="btn primary" onClick={() => void refresh()} disabled={refreshing}>
          {refreshing ? '刷新中…' : '从设备刷新'}
        </button>
        {importNotice ? (
          <span className="topology-hint" title={importNotice}>
            {importNotice}
          </span>
        ) : (
          <span className="topology-hint">拖动节点落位即保存；从节点右侧把手拖到另一节点左侧画链路</span>
        )}
      </div>
      <div className="topology-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onNodeDragStop={onNodeDragStop}
          onConnect={onConnect}
          fitView
          minZoom={0.2}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
      <style>{`
        .topology-wrap { display: flex; flex-direction: column; height: 100%; min-height: 0; }
        .topology-toolbar { display: flex; gap: 8px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--border-default); flex-wrap: wrap; }
        .topology-input { background: var(--bg-surface); color: var(--text-primary); border: 1px solid var(--border-default); border-radius: 4px; padding: 4px 8px; font-size: var(--text-sm, 12px); }
        .topology-input:focus { outline: 1px solid var(--accent); }
        .topology-hint { margin-left: auto; color: var(--text-muted); font-size: 11px; }
        .topology-canvas { flex: 1; min-height: 0; }
        .topo-node { border: 1.5px solid; border-radius: 8px; padding: 10px 14px; min-width: 120px; text-align: center; box-shadow: var(--shadow-pop); font-size: 12px; }
        .topo-node-name { font-weight: 600; white-space: nowrap; }
        .topo-node-sub { font-size: 11px; margin-top: 2px; }
        .react-flow__edge-text { fill: var(--text-muted); font-size: 10px; }
        .react-flow__controls button { background: var(--bg-elevated); color: var(--text-secondary); border-bottom: 1px solid var(--border-default); }
        .react-flow__controls button:hover { background: var(--bg-hover); }
        .react-flow__attribution { display: none; }
      `}</style>
    </div>
  )
}

const nodeTypes = { topo: TopoNodeMemo }