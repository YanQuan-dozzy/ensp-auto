/**
 * 拓扑编辑交互 hook（T5.8 从 TopologyCanvas.tsx 外提）：
 * 选中 / 锁定 / 重命名 / 角色 / 删除 / 断开 / 右键菜单 / 单击详情 / 键盘快捷键。
 * 画布节点视图状态仍由 FlowInner 持有，本 hook 经参数读取最新值（含 T4.5 的 ref 引用稳定技巧）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Edge, Node, OnSelectionChangeParams } from '@xyflow/react'
import type { TopologyLink, TopologyNode, TopologyRole } from '@shared/types'
import { alignNodeSizes, centerToTopLeft, topLeftToCenter } from './layoutGrid'
import { linkKeyStr, type MenuState, type TopoEdgeData, type TopoNodeData } from './TopoRender'

export interface UseTopoEditingArgs {
  /** store 里的合并拓扑（实采 + 手动） */
  topology: { nodes: TopologyNode[]; links: TopologyLink[] }
  /** 画布中当前节点视图（含拖动中的实时位置） */
  flowNodes: Node[]
  /** 画布中当前边视图（删除时需要 id → 端点对） */
  flowEdges: Edge[]
  manualNodes: TopologyNode[]
  manualLinks: TopologyLink[]
  saveManual: (input: { nodes: TopologyNode[]; links: TopologyLink[] }) => Promise<void>
  removeTopology: (input: { nodeIds?: string[]; linkKeys?: string[] }) => Promise<void>
  /** 拖动结束回调：FlowInner 用它解冻拖动中冻结的几何派生量 */
  endDrag: () => void
  canvasRef: React.RefObject<HTMLDivElement | null>
}

export interface TopoEditingApi {
  editingId: string | null
  setEditingId: (id: string | null) => void
  menu: MenuState | null
  setMenu: (menu: MenuState | null) => void
  locked: boolean
  toggleLock: () => void
  detailId: string | null
  onSelectionChange: (params: OnSelectionChangeParams) => void
  commitRename: (id: string, name: string) => void
  cancelRename: () => void
  changeRole: (id: string, role: TopologyRole) => void
  deleteNodes: (ids: string[]) => void
  deleteEdges: (edgeIds: string[]) => void
  disconnectNode: (id: string) => void
  onNodeDragStop: (event: unknown, node: Node) => void
  onNodeContextMenu: (e: React.MouseEvent, node: Node) => void
  onEdgeContextMenu: (e: React.MouseEvent, edge: Edge) => void
  onPaneContextMenu: (e: React.MouseEvent | MouseEvent) => void
  onNodeDoubleClick: (e: React.MouseEvent, node: Node) => void
  onNodeClick: (e: React.MouseEvent, node: Node) => void
  closeDetail: () => void
}

/**
 * 画布坐标（React Flow 的**左上角**）→ store 坐标（**设备框中心**）。
 *
 * 为什么必须换算：store 与布局内核统一用中心口径（背景方格的十字交点要压在设备中心），
 * 而 React Flow 只认左上角。不换算的后果是「改一次名 / 拖一次设备，设备就整体挪半个框」。
 *
 * 尺寸取**偶数口径**（`alignNodeSizes`）与画布渲染同源 —— 换角色后尺寸会变，
 * `roleOverride` 让调用方按新角色取尺寸，避免用旧尺寸换算又偏一次。
 */
function centerOf(
  id: string,
  topLeft: { x: number; y: number },
  nodes: TopologyNode[],
  roleOverride?: TopologyRole
): { x: number; y: number } {
  const node = nodes.find((n) => n.id === id)
  const sizes = alignNodeSizes(
    roleOverride && node ? [{ ...node, id: `${id}`, role: roleOverride }] : node ? [node] : []
  )
  const size = sizes.get(id) ?? { w: 130, h: 52 }
  return topLeftToCenter(topLeft, size)
}

/** 仅用于类型自检：确认 centerToTopLeft 与 centerOf 互为逆运算（编译期即可发现漂移） */
export const __centerHelpers = { centerToTopLeft, centerOf }

export function useTopoEditing(args: UseTopoEditingArgs): TopoEditingApi {
  const { topology, flowNodes, flowEdges, manualNodes, manualLinks, saveManual, removeTopology, endDrag, canvasRef } =
    args

  const [selection, setSelection] = useState<{ nodes: Set<string>; edges: Set<string> }>({
    nodes: new Set(),
    edges: new Set()
  })
  const [editingId, setEditingId] = useState<string | null>(null)
  const [locked, setLocked] = useState(false)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)

  /**
   * 事件回调读取的最新值（T4.5）。
   *
   * commitRename 过去把 topology.nodes / flowNodes / manualNodes / manualLinks 全列进
   * 依赖数组，于是「拖动一帧 → 节点换引用 → 回调换引用 → renderNodes 重建 → 所有节点
   * data 换引用」。改成经 ref 读最新值后，回调引用恒定，节点 data 才能被复用。
   */
  const latestRef = useRef({ topologyNodes: topology.nodes, flowNodes, manualNodes, manualLinks, saveManual })
  latestRef.current = { topologyNodes: topology.nodes, flowNodes, manualNodes, manualLinks, saveManual }

  /** 切换锁定；上锁时顺手关掉右键菜单与重命名输入，避免残留可编辑入口 */
  const toggleLock = useCallback(() => {
    const next = !locked
    setLocked(next)
    if (next) {
      setMenu(null)
      setEditingId(null)
    }
  }, [locked])

  const onSelectionChange = useCallback((params: OnSelectionChangeParams) => {
    setSelection({
      nodes: new Set(params.nodes.map((n) => n.id)),
      edges: new Set(params.edges.map((e) => e.id))
    })
  }, [])

  const commitRename = useCallback((id: string, name: string) => {
    setEditingId(null)
    // 经 ref 读最新值：依赖数组清空后引用恒定，节点 data 才能被复用（T4.5）
    const { topologyNodes, flowNodes: flow, manualNodes: mNodes, manualLinks: mLinks, saveManual: save } =
      latestRef.current
    const trimmed = name.trim()
    const node = topologyNodes.find((n) => n.id === id)
    if (!node || !trimmed || trimmed === node.name) return
    const cur = flow.find((n) => n.id === id)?.position
    const moved: TopologyNode = {
      id: node.id,
      name: trimmed,
      role: node.role,
      ...(node.model ? { model: node.model } : {}),
      // 画布坐标（左上角）→ store 坐标（中心）：不换算会把设备整体挪半个框
      ...(cur ? centerOf(id, cur, topologyNodes) : {}),
      source: 'manual'
    }
    const others = mNodes.filter((n) => n.id !== id)
    void save({ nodes: [...others, moved], links: mLinks })
  }, [])

  /** 取消重命名（引用恒定，供节点 data 复用） */
  const cancelRename = useCallback(() => setEditingId(null), [])

  const changeRole = useCallback(
    (id: string, role: TopologyRole) => {
      setMenu(null)
      const node = topology.nodes.find((n) => n.id === id)
      if (!node || node.role === role) return
      const cur = flowNodes.find((n) => n.id === id)?.position
      const moved: TopologyNode = {
        id: node.id,
        name: node.name,
        role,
        ...(node.model ? { model: node.model } : {}),
        // 画布坐标（左上角）→ store 坐标（中心）；角色变了尺寸可能变，用**新角色**的尺寸
        ...(cur ? centerOf(id, cur, topology.nodes, role) : {}),
        source: 'manual'
      }
      const others = manualNodes.filter((n) => n.id !== id)
      void saveManual({ nodes: [...others, moved], links: manualLinks })
    },
    [topology.nodes, flowNodes, manualNodes, manualLinks, saveManual]
  )

  const deleteNodes = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return
      void removeTopology({ nodeIds: ids })
      setSelection({ nodes: new Set(), edges: new Set() })
      setMenu(null)
    },
    [removeTopology]
  )

  const deleteEdges = useCallback(
    (edgeIds: string[]) => {
      // 删除粒度 = **一条线**（`data.identity` = 设备对 + 线标识）：同设备对并接的其它线
      // 不该被连坐删掉。旧边（手拖出来还未经过 store 重建的）没有 identity 时退回设备对。
      const keys = edgeIds
        .map((eid) => {
          const e = flowEdges.find((x) => x.id === eid)
          if (!e) return null
          const identity = (e.data as TopoEdgeData | undefined)?.identity
          return identity ?? linkKeyStr(e.source, e.target)
        })
        .filter((k): k is string => !!k)
      if (keys.length === 0) return
      void removeTopology({ linkKeys: keys })
      setSelection({ nodes: new Set(), edges: new Set() })
      setMenu(null)
    },
    [flowEdges, removeTopology]
  )

  /** 断开一台设备的**全部**连线：按设备对粒度（同对多条线一起断开） */
  const disconnectNode = useCallback(
    (id: string) => {
      const keys = topology.links
        .filter((l) => l.from === id || l.to === id)
        .map((l) => linkKeyStr(l.from, l.to))
      setMenu(null)
      if (keys.length === 0) return
      void removeTopology({ linkKeys: [...new Set(keys)] })
    },
    [topology.links, removeTopology]
  )

  // 拖动落位即保存：被拖过的节点（无论来源）并入手动集，写入主进程
  const onNodeDragStop = useCallback(
    (_e: unknown, node: Node) => {
      // 拖动结束：解冻几何派生量（T4.5）
      endDrag()
      const d = node.data as TopoNodeData
      const others = manualNodes.filter((n) => n.id !== node.id)
      const moved: TopologyNode = {
        id: node.id,
        name: d.label,
        role: d.role,
        ...(typeof d.model === 'string' && d.model ? { model: d.model } : {}),
        // 画布左上角 → store 中心口径（见 centerOf 注释）
        ...centerOf(node.id, node.position, topology.nodes),
        source: 'manual'
      }
      void saveManual({ nodes: [...others, moved], links: manualLinks })
    },
    [manualNodes, manualLinks, saveManual, endDrag, topology.nodes]
  )

  /** 右键菜单定位：菜单弹在画布内（贴边时收回，不溢出） */
  const openMenu = useCallback(
    (
      e: { clientX: number; clientY: number; preventDefault: () => void },
      kind: MenuState['kind'],
      extra: Partial<MenuState> = {}
    ) => {
      e.preventDefault()
      const rect = canvasRef.current?.getBoundingClientRect()
      const x = Math.max(8, Math.min(e.clientX - (rect?.left ?? 0), (rect?.width ?? 400) - 180))
      const y = Math.max(8, Math.min(e.clientY - (rect?.top ?? 0), (rect?.height ?? 400) - 220))
      setMenu({ x, y, kind, ...extra })
    },
    []
  )

  const onNodeContextMenu = useCallback(
    (e: React.MouseEvent, node: Node) => {
      if (locked) return
      openMenu(e, 'node', { nodeId: node.id })
    },
    [locked, openMenu]
  )
  const onEdgeContextMenu = useCallback(
    (e: React.MouseEvent, edge: Edge) => {
      if (locked) return
      openMenu(e, 'edge', { edgeId: edge.id })
    },
    [locked, openMenu]
  )
  const onPaneContextMenu = useCallback((e: React.MouseEvent | MouseEvent) => openMenu(e, 'pane'), [openMenu])
  const onNodeDoubleClick = useCallback(
    (_e: React.MouseEvent, node: Node) => {
      if (locked) return
      setEditingId(node.id)
    },
    [locked]
  )

  // 单击节点 → 详情面板；空白/Esc 关闭（双击重命名优先，不因单击触发详情关闭冲突）
  const onNodeClick = useCallback((_e: React.MouseEvent, node: Node) => setDetailId(node.id), [])
  const closeDetail = useCallback(() => setDetailId(null), [])

  // Delete / Backspace：删除选中节点与连线（输入框内不触发）；Esc 关闭详情面板
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setDetailId(null)
        return
      }
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      if (locked) return
      const el = document.activeElement
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      ) {
        return
      }
      const ns = [...selection.nodes]
      const es = [...selection.edges]
      if (ns.length > 0) deleteNodes(ns)
      else if (es.length > 0) deleteEdges(es)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [locked, selection, deleteNodes, deleteEdges])

  return {
    editingId,
    setEditingId,
    menu,
    setMenu,
    locked,
    toggleLock,
    detailId,
    onSelectionChange,
    commitRename,
    cancelRename,
    changeRole,
    deleteNodes,
    deleteEdges,
    disconnectNode,
    onNodeDragStop,
    onNodeContextMenu,
    onEdgeContextMenu,
    onPaneContextMenu,
    onNodeDoubleClick,
    onNodeClick,
    closeDetail
  }
}