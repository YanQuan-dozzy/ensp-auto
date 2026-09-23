import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type OnConnect,
  type OnEdgesChange,
  type OnNodesChange
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useApp } from '@/stores/app'
import type { TopologyLink, TopologyNode, TopologyRole } from '@shared/types'
import { computeAutoLayout } from './autoLayout'
import {
  TopoNodeData,
  TopoNodeMemo,
  TopoEdge,
  linkKeyStr,
  computeUsedHandles,
  toFlowNodes,
  toFlowEdges
} from './TopoRender'
import './topology.css'
import { useTopoEditing } from './useTopoEditing'
import { useTopoFinder } from './useTopoFinder'
import { TopologyToolbar } from './TopologyToolbar'
import { TopologyStage } from './TopologyStage'
import { TopoContextMenu, TopoDetailPanel, TopoFinderPanel } from './TopoOverlays'

function FlowInner(): ReactNode {
  const topology = useApp((s) => s.topology)
  const refreshing = useApp((s) => s.topologyRefreshing)
  const refresh = useApp((s) => s.refreshTopology)
  const saveManual = useApp((s) => s.saveManualTopology)
  const removeTopology = useApp((s) => s.removeTopology)
  const importTopology = useApp((s) => s.importTopology)
  const discoverTopoFiles = useApp((s) => s.discoverTopoFiles)
  const importTopoPath = useApp((s) => s.importTopoPath)
  const connect = useApp((s) => s.connect)
  const { fitView } = useReactFlow()

  const [nodes, setNodes] = useState<Node[]>(() => toFlowNodes(topology.nodes))
  const [edges, setEdges] = useState<Edge[]>([])
  const [dragging, setDragging] = useState(false)
  const [addName, setAddName] = useState('')
  const [addRole, setAddRole] = useState<TopologyRole>('unknown')
  const canvasRef = useRef<HTMLDivElement>(null)
  const addInputRef = useRef<HTMLInputElement>(null)

  const roleOf = useMemo(
    () => new Map(topology.nodes.map((n) => [n.id, n.role])),
    [topology.nodes]
  )

  // 节点中心位置（与 toFlowNodes 相同的 x/y 兜底），用于为连线挑选上下/左右连接点
  const positionsOf = useMemo(
    () =>
      new Map(
        topology.nodes.map((n, i) => [
          n.id,
          {
            x: Number.isFinite(n.x) ? (n.x as number) : (i % 4) * 240 + 40,
            y: Number.isFinite(n.y) ? (n.y as number) : Math.floor(i / 4) * 130 + 40
          }
        ])
      ),
    [topology.nodes]
  )

  // 拓扑数据变化（刷新 / 合并 / 加载 / 手动保存）时重建画布
  useEffect(() => {
    setNodes(toFlowNodes(topology.nodes))
    setEdges(toFlowEdges(topology.links, roleOf, positionsOf))
  }, [topology, roleOf, positionsOf])

  const onNodesChange: OnNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((ns) => applyNodeChanges(changes, ns))
  }, [])

  const onEdgesChange: OnEdgesChange = useCallback((changes) => {
    setEdges((es) => applyEdgeChanges(changes, es))
  }, [])

  const manualNodes = useMemo(
    () => topology.nodes.filter((n) => n.source === 'manual'),
    [topology]
  )
  const manualLinks = useMemo(
    () => topology.links.filter((l) => l.source === 'manual'),
    [topology]
  )

  // 编辑交互与导入/发现均外提为 hook（useTopoEditing.ts / useTopoFinder.ts），FlowInner 只做装配
  const editing = useTopoEditing({
    topology,
    flowNodes: nodes,
    flowEdges: edges,
    manualNodes,
    manualLinks,
    saveManual,
    removeTopology,
    endDrag: () => setDragging(false),
    canvasRef
  })
  const finder = useTopoFinder({ importTopology, discoverTopoFiles, importTopoPath })

  /**
   * 几何快照（T4.5）：只在「非拖动」时跟随最新 nodes/edges。
   * version 是 useMemo 的稳定判据 —— 拖动期间它不变，于是「未使用连接点」不会每帧重算。
   */
  const geomRef = useRef({ nodes, edges, version: 0 })
  if (!dragging && (geomRef.current.nodes !== nodes || geomRef.current.edges !== edges)) {
    geomRef.current = { nodes, edges, version: geomRef.current.version + 1 }
  }

  // 未使用连接点：按几何计算。拖动中冻结（version 不变），拖动结束后刷新一次（T4.5）
  const usedByNode = useMemo(
    () => computeUsedHandles(geomRef.current.nodes, geomRef.current.edges),
    [geomRef.current.version, dragging]
  )

  /**
   * 节点 data 复用缓存（T4.5）：拖动一帧就是一次 nodes 变化，过去每个节点都会拿到
   * 全新的 data 对象，React Flow 于是重渲所有节点。现在只有「used 变了 / 进入退出编辑 /
   * 上游 data 换了引用」的节点才换 data。
   */
  const dataCacheRef = useRef(new Map<string, { key: string; data: TopoNodeData; source: unknown }>())

  const renderNodes = useMemo<Node[]>(() => {
    const nextCache = new Map<string, { key: string; data: TopoNodeData; source: unknown }>()
    const out = nodes.map((n) => {
      const used = usedByNode.get(n.id)
      const editingFlag = editing.editingId === n.id
      const usedKey = used ? `${+used.left}${+used.right}${+used.top}${+used.bottom}` : ''
      const key = `${editingFlag ? 1 : 0}|${usedKey}`
      const cached = dataCacheRef.current.get(n.id)
      const data =
        cached && cached.key === key && cached.source === n.data
          ? cached.data
          : {
              ...(n.data as TopoNodeData),
              used,
              editing: editingFlag,
              commitRename: (name: string) => editing.commitRename(n.id, name),
              cancelRename: editing.cancelRename
            }
      nextCache.set(n.id, { key, data, source: n.data })
      return { ...n, data }
    })
    dataCacheRef.current = nextCache
    return out
  }, [nodes, usedByNode, editing.editingId, editing.commitRename, editing.cancelRename])

  const onConnect: OnConnect = useCallback(
    (conn: Connection) => {
      if (editing.locked) return
      // 自环（起点＝终点）无意义，丢弃避免生成坏边
      if (!conn.source || !conn.target || conn.source === conn.target) return
      const key = linkKeyStr(conn.source, conn.target)
      // 该端点对已有链路（live）→ 忽略重复拖线，避免叠线
      if (topology.links.some((l) => linkKeyStr(l.from, l.to) === key)) return
      // 手动链路基于「当前 store 的手动集」追加（而非 memo 快照），
      // 连续快速拖线互相不覆盖；墓碑由主进程 applyManual 按 id 合并并复活
      const baseLinks = topology.links.filter((l) => l.source === 'manual')
      const linkId = `m-${Date.now()}`
      const link: TopologyLink = {
        id: linkId,
        from: conn.source,
        to: conn.target,
        label: '手动连线',
        source: 'manual'
      }
      setEdges((es) => addEdge({ ...conn, id: linkId, type: 'smoothstep' }, es))
      void saveManual({ nodes: manualNodes, links: [...baseLinks, link] })
    },
    [editing.locked, topology, manualNodes, saveManual]
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
    editing.setMenu(null)
  }, [addName, addRole, manualNodes, manualLinks, saveManual])

  // —— 自适应布局 ——
  const runAutoLayout = useCallback(() => {
    const pos = computeAutoLayout(topology.nodes, topology.links)
    const next: TopologyNode[] = topology.nodes.map((n) => {
      const p = pos.get(n.id)
      return {
        id: n.id,
        name: n.name,
        role: n.role,
        ...(n.model ? { model: n.model } : {}),
        ...(p ? { x: Math.round(p.x), y: Math.round(p.y) } : {}),
        source: 'manual'
      }
    })
    editing.setMenu(null)
    void saveManual({ nodes: next, links: manualLinks }).then(() => {
      window.setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 50)
    })
  }, [topology.nodes, topology.links, manualLinks, saveManual, fitView])

  const menuNode =
    editing.menu?.kind === 'node' ? topology.nodes.find((n) => n.id === editing.menu?.nodeId) : undefined

  // —— 设备详情面板数据 ——
  const detailNode = editing.detailId ? topology.nodes.find((n) => n.id === editing.detailId) : undefined
  const detailLinks = detailNode
    ? topology.links
        .filter((l) => l.from === detailNode.id || l.to === detailNode.id)
        .map((l) => ({
          peer: (l.from === detailNode.id ? l.to : l.from).split(':').pop() ?? '',
          label: l.label
        }))
    : []
  const detailPort = detailNode?.deviceId ? Number.parseInt(detailNode.deviceId.split(':').slice(-1)[0] ?? '', 10) : NaN

  return (
    <div className="topology-wrap">
      <TopologyToolbar
        addInputRef={addInputRef}
        addName={addName}
        setAddName={setAddName}
        addRole={addRole}
        setAddRole={setAddRole}
        addNode={addNode}
        locked={editing.locked}
        importNotice={finder.importNotice}
        runAutoLayout={runAutoLayout}
        onImportFile={finder.onImportFile}
        openFinder={finder.openFinder}
        refreshing={refreshing}
        refresh={refresh}
      />
      <TopologyStage
        canvasRef={canvasRef}
        renderNodes={renderNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStart={() => setDragging(true)}
        onNodeDragStop={editing.onNodeDragStop}
        onConnect={onConnect}
        onSelectionChange={editing.onSelectionChange}
        onNodeContextMenu={editing.onNodeContextMenu}
        onEdgeContextMenu={editing.onEdgeContextMenu}
        onPaneContextMenu={editing.onPaneContextMenu}
        onNodeClick={editing.onNodeClick}
        onNodeDoubleClick={editing.onNodeDoubleClick}
        onPaneClick={() => {
          editing.setMenu(null)
          editing.closeDetail()
        }}
        locked={editing.locked}
        toggleLock={editing.toggleLock}
      >
        {detailNode ? (
          <TopoDetailPanel
            node={detailNode}
            port={detailPort}
            links={detailLinks}
            onClose={editing.closeDetail}
            onConnect={(port) => void connect(port)}
          />
        ) : null}
        {finder.finderOpen ? (
          <TopoFinderPanel
            finder={finder.finder}
            loading={finder.finderLoading}
            onClose={() => finder.setFinderOpen(false)}
            onRefresh={() => void finder.refreshFinder()}
            onImport={(path) => void finder.importFromFinder(path)}
          />
        ) : null}
        {editing.menu ? (
          <TopoContextMenu
            menu={editing.menu}
            nodeName={menuNode?.name}
            locked={editing.locked}
            onRename={(id) => editing.setEditingId(id)}
            onSetSub={(sub) => {
              if (editing.menu) editing.setMenu({ ...editing.menu, sub })
            }}
            onDisconnect={(id) => {
              if (id) editing.disconnectNode(id)
            }}
            onDeleteNode={(id) => {
              if (id) editing.deleteNodes([id])
            }}
            onChangeRole={(id, r) => {
              if (id) editing.changeRole(id, r)
            }}
            onDeleteEdge={(id) => {
              if (id) editing.deleteEdges([id])
            }}
            onClose={() => editing.setMenu(null)}
            onFocusAdd={() => {
              editing.setMenu(null)
              addInputRef.current?.focus()
            }}
            onRunLayout={runAutoLayout}
            onFitView={() => {
              editing.setMenu(null)
              void fitView({ padding: 0.2, duration: 250 })
            }}
          />
        ) : null}
      </TopologyStage>
    </div>
  )
}

export function TopologyCanvas(): ReactNode {
  return (
    <ReactFlowProvider>
      <FlowInner />
    </ReactFlowProvider>
  )
}

const nodeTypes = { topo: TopoNodeMemo }
const edgeTypes = { topo: TopoEdge }