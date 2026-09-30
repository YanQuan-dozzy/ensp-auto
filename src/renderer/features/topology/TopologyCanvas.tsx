import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  useOnViewportChange,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type OnConnect,
  type OnEdgesChange,
  type OnNodesChange,
  type Viewport
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useApp } from '@/stores/app'
import type { TopologyLink, TopologyNode, TopologyRole, TopologyPortOffset } from '@shared/types'
import { withPortOffset, type PortOffsetSide } from '@shared/topology-ports'
import { computeAutoLayout, computeBlockBoxes, layoutTopology, sourcePosOf, LAYOUT_GRID } from './autoLayout'
import { alignNodeSizes } from './layoutGrid'
import { planRoutes, buildRowModel } from './topoRouting'
import { assignLinkPorts } from './portSlots'
import {
  TopoNodeData,
  TopoNodeMemo,
  TopoEdge,
  TopoBlockFrames,
  linkIdentity,
  computeUsedHandles,
  toFlowNodes,
  toFlowEdges,
  assignPortSlots,
  type TopoEdgeData
} from './TopoRender'
import './topology.css'
import { useTopoEditing } from './useTopoEditing'
import { useTopoFinder } from './useTopoFinder'
import { TopologyToolbar } from './TopologyToolbar'
import { TopologyStage } from './TopologyStage'
import { TopoContextMenu, TopoDetailPanel, TopoFinderPanel } from './TopoOverlays'
import { TopoLoadingBar } from './TopoLoadingBar'

/**
 * 可读缩放下限（B4）：fitView 不再把 20 个节点硬塞进一屏缩到 0.4 —— 低于这个比例
 * 节点文字就到了看不清的地步。看不全的部分交给拖动与左上角 MiniMap 导航。
 */
const READABLE_MIN_ZOOM = 0.7
/** 背景方格间距 = 对齐粒度 = 布局格点（B4 第五/六批） */
// 网格粒度 = 布局格点：一格 ≈ 一台设备的占位，与 autoLayout 的坐标、「对齐到网格」按钮
// 共用同一常量。注意**不做拖动吸附** —— 拖动是自由落点，需要归位时点「对齐到网格」。
const GRID_SIZE = LAYOUT_GRID
/** 网格显隐的持久化键（localStorage） */
const GRID_PREF_KEY = 'topo.gridVisible'
/** 低于此缩放时接口标注收成小点（必须**低于**可读下限，否则 fitView 之后立刻全变成点） */
const LABEL_COLLAPSE_ZOOM = 0.5

/**
 * 手动连线的进程内序号。
 *
 * 为什么不用 `Math.random()` 或单靠 `Date.now()`：`lineKey` 必须唯一（并接的两条手动线
 * 若共用线标识，在手动层里会互相顶掉），而同一毫秒内连续拖两条线完全可能。
 */
let manualLineSeq = 0

function FlowInner(): ReactNode {
  const topology = useApp((s) => s.topology)
  const refreshing = useApp((s) => s.topologyRefreshing)
  // F11 回放：由「轨迹」标签页写入，这里只读并传导到节点 data 上
  const topoHighlightDeviceId = useApp((s) => s.topoHighlightDeviceId)
  const refresh = useApp((s) => s.refreshTopology)
  const saveManual = useApp((s) => s.saveManualTopology)
  const removeTopology = useApp((s) => s.removeTopology)
  const clearTopology = useApp((s) => s.clearTopology)
  const importTopology = useApp((s) => s.importTopology)
  const discoverTopoFiles = useApp((s) => s.discoverTopoFiles)
  const importTopoPath = useApp((s) => s.importTopoPath)
  const restoreSourceLayout = useApp((s) => s.restoreSourceLayout)
  const connect = useApp((s) => s.connect)
  const { fitView } = useReactFlow()

  const [nodes, setNodes] = useState<Node[]>(() => toFlowNodes(topology.nodes))
  const [edges, setEdges] = useState<Edge[]>([])
  const [dragging, setDragging] = useState(false)
  /** 当前缩放（量化到 5% 再入 state，避免缩放动画期间每帧重建链路视图） */
  const [zoom, setZoom] = useState(1)
  /** 悬停聚焦：节点聚焦 = 它自己 + 邻居；链路聚焦 = 那一条链路 + 两端设备 */
  const [focus, setFocus] = useState<{ kind: 'node' | 'edge'; id: string } | null>(null)

  const onViewportChange = useCallback((vp: Viewport) => {
    setZoom((prev) => (Math.abs(prev - vp.zoom) >= 0.05 ? vp.zoom : prev))
  }, [])
  useOnViewportChange({ onChange: onViewportChange })
  /** 接口标注是否收成小点（B4 分级显示） */
  const denseLabels = zoom < LABEL_COLLAPSE_ZOOM
  const [addName, setAddName] = useState('')
  const [addRole, setAddRole] = useState<TopologyRole>('unknown')
  const canvasRef = useRef<HTMLDivElement>(null)
  const addInputRef = useRef<HTMLInputElement>(null)

  const roleOf = useMemo(
    () => new Map(topology.nodes.map((n) => [n.id, n.role])),
    [topology.nodes]
  )

  /**
   * 设备框尺寸（**偶数口径**，与布局内核同源）—— 「中心 ↔ 左上角」换算与尺寸覆盖都用它。
   * 偶数尺寸是硬约束：布局按「中心落格点」铺放，减半个框后左上角才仍落在格点上。
   */
  const nodeSizes = useMemo(() => alignNodeSizes(topology.nodes), [topology.nodes])

  /**
   * 节点**中心**位置（store 口径 = 布局口径）——走线内核、端口点、区块包围盒都用它。
   * 无坐标设备的兜底摆位与 `toFlowNodes` 保持一致（那里也是左上角口径，故这里补半个框）。
   */
  const positionsOf = useMemo(
    () =>
      new Map(
        topology.nodes.map((n, i) => {
          const size = nodeSizes.get(n.id) ?? { w: 130, h: 52 }
          const rawX = Number.isFinite(n.x) ? (n.x as number) : (i % 4) * 240 + 40
          const rawY = Number.isFinite(n.y) ? (n.y as number) : Math.floor(i / 4) * 130 + 40
          // store 的 x/y 本就是中心；只有兜底摆位是左上角口径 → 补半个框凑成中心
          return [
            n.id,
            Number.isFinite(n.x) && Number.isFinite(n.y)
              ? { x: rawX, y: rawY }
              : { x: rawX + size.w / 2, y: rawY + size.h / 2 }
          ]
        })
      ),
    [topology.nodes, nodeSizes]
  )

  const manualNodes = useMemo(
    () => topology.nodes.filter((n) => n.source === 'manual'),
    [topology]
  )
  const manualLinks = useMemo(
    () => topology.links.filter((l) => l.source === 'manual'),
    [topology]
  )

  /**
   * 行模型（v2.32「像图片那样接线」）：连接点方位的**权威判据** —— 同层（兄弟）走左右、
   * 跨层（父/子）走上下。必须与走线内核里的 `buildRowModel` 同源：内核用行号决定打法
   * （相邻行＝树干成束、同行＝层间车道），端口若按另一套口径给方位，线就会在端口处多拐
   * 一个直角。这里是画布侧的同一口径副本（O(n log n)，与 linkPorts 同节奏重算）。
   */
  const rowOf = useMemo(
    () => buildRowModel(topology.nodes, positionsOf, nodeSizes, true).rowOf,
    [topology.nodes, positionsOf, nodeSizes]
  )

  /** 接口标注槽位（B4）：同一连接点上的端口跨链路统一编号 —— 治「标注逐字重合」 */
  const portSlots = useMemo(
    () => assignPortSlots(topology.links, positionsOf, { rowOf }),
    [topology.links, positionsOf, rowOf]
  )
  // 每条链路独立的端口点（eNSP 式）：同侧按对端方位排序后沿边框铺开（中点优先、>2 才用边角）
  const linkPorts = useMemo(
    () => assignLinkPorts(topology.links, positionsOf, { rowOf }),
    [topology.links, positionsOf, rowOf]
  )

  /**
   * 区块归属（B4 第二批）。
   *
   * T6（PERF-MEM-REVIEW-2026-09-29 §4.3）：**归属与包围盒必须拆成两级 memo**。
   *
   * 原来是一个 memo 里直接 `layoutTopology(...)` 拿 `.blocks`，而依赖里带着
   * `positionsOf` —— 于是**任何设备坐标变化**（拖动落位 / 对齐到网格 / 导入后重排）
   * 都会重跑一遍完整布局内核（含 `packModules` 的枚举），然后只用到 `.blocks`
   * 一个字段、把 `.positions` 整个丢掉。而**模块归属只由拓扑结构决定，全程不读
   * 当前布局坐标** —— 它根本没有理由跟着坐标一起重算。
   *
   * 拆开后：拖动落位只重跑 `computeBlockBoxes`（O(节点数) 的包围盒累加），
   * 布局内核只在拓扑结构变化时才跑。
   *
   * ⚠️ 不要为了「省一次 layoutTopology」把 membership 换成别的近似口径 ——
   * 分组框的成员必须与自动布局给的完全一致（用户点「自动布局」后框要正好套住
   * 同一个模块）。这里只是**缓存**它，不是改变它。
   */
  const blockMembership = useMemo(
    () => layoutTopology(topology.nodes, topology.links).blocks,
    [topology.nodes, topology.links]
  )

  const nodeMap = useMemo(() => new Map(topology.nodes.map((n) => [n.id, n])), [topology.nodes])

  /**
   * 包围盒**必须按当前坐标重算** —— 用户在画布上拖过设备之后，分组框得跟着
   * 设备走，否则框和里面的设备会错位。所以这一级仍然依赖 `positionsOf`。
   */
  const blockBoxes = useMemo(
    () => computeBlockBoxes(blockMembership, nodeMap, positionsOf),
    [blockMembership, nodeMap, positionsOf]
  )

  /**
   * 走线内核（方案 B 分层树干成束）：折线 + 标注锚点 + 区块框取舍。
   *
   * 只在拓扑变化时重算（与连线重建同一节奏）。拖动设备的过程中折线会暂时保留旧的干线
   * 位置、但首末段仍贴合实测连接点（`snapRouteToHandles`），所以拖动时看到的依然是
   * 处处轴对齐的折线，松手落库后重算到最终形态。
   *
   * `positionsAreCenters: true` —— `positionsOf` 是**设备框中心**（布局/端口点的统一口径），
   * 内核据此还原外框做障碍判定。不能省：漏了会让障碍框整体上移半个设备高。
   */
  const routeModel = useMemo(
    () =>
      planRoutes({
        nodes: topology.nodes,
        links: topology.links,
        positions: positionsOf,
        blocks: blockBoxes,
        sizes: nodeSizes,
        positionsAreCenters: true,
        // 复用画布已算好的槽位/端口表 —— 内核不再各算一遍（大图上各 0.3~1.5ms）
        slots: portSlots,
        linkPorts
      }),
    [topology.nodes, topology.links, positionsOf, nodeSizes, blockBoxes, portSlots, linkPorts]
  )

  /** 区块框标题：优先用布局给的语义名（外网 / 分校），退回区块头的设备名 */
  const blockNames = useMemo(() => new Map(topology.nodes.map((n) => [n.id, n.name])), [topology.nodes])

  /**
   * 接口标注拖拽落库（B4）。
   *
   * 偏移写进**手动层**里**同一条线**的条目，复用既有约定「手动条目覆盖 file/discovered」
   * ——与节点拖动、重命名完全一致（被加工过的对象即 source:'manual'），因此不必给
   * manual 层另开字段、也不必改 IPC 载荷形状。
   *
   * 关键：条目必须带上目标线的 `lineKey`（与 label）—— 身份 = 设备对 + 线标识。
   * 漏掉 lineKey 会被当成「按设备对」的历史条目，于是同设备对并接的几条线会串味
   * （拖第 2 条的标注，第 1 条跟着动）。先做一次乐观更新：主进程回包前标注不弹回原位。
   */
  const commitLabelOffset = useCallback(
    (linkId: string, side: PortOffsetSide, index: number, offset: TopologyPortOffset) => {
      const link = topology.links.find((l) => l.id === linkId)
      if (!link) return
      const identity = linkIdentity(link)
      const existing = manualLinks.find((l) => linkIdentity(l) === identity)
      const portOffsets = withPortOffset(existing?.portOffsets, side, index, offset)
      const entry: TopologyLink = existing
        ? { ...existing, portOffsets }
        : {
            id: link.id,
            from: link.from,
            to: link.to,
            source: 'manual',
            portOffsets,
            ...(link.label ? { label: link.label } : {}),
            ...(link.lineKey ? { lineKey: link.lineKey } : {}),
            ...(link.lineType ? { lineType: link.lineType } : {})
          }
      const nextLinks = existing
        ? manualLinks.map((l) => (linkIdentity(l) === identity ? entry : l))
        : [...manualLinks, entry]
      setEdges((es) =>
        es.map((e) => (e.id === linkId ? { ...e, data: { ...e.data, offsets: portOffsets } } : e))
      )
      void saveManual({ nodes: manualNodes, links: nextLinks })
    },
    [topology.links, manualLinks, manualNodes, saveManual]
  )

  // 拓扑数据变化（刷新 / 合并 / 加载 / 手动保存）或回放高亮变化时重建画布。
  // 高亮也走这里重建而不是改已有节点：data 是 React Flow 判断重渲的输入，
  // 就地改会把 renderNodes 的 data 缓存判据（引用相等）搅乱。
  useEffect(() => {
    setNodes(toFlowNodes(topology.nodes, topoHighlightDeviceId))
    setEdges(
      toFlowEdges(topology.links, roleOf, positionsOf, {
        slots: portSlots,
        linkPorts,
        routes: routeModel.routes,
        onLabelCommit: commitLabelOffset
      })
    )
  }, [topology, roleOf, positionsOf, topoHighlightDeviceId, portSlots, routeModel, commitLabelOffset])

  /**
   * 拓扑加载进度收尾（v2.29）—— 画布首帧画完后清掉进度条。
   *
   * 为什么在这里收：`topoLoading` 的最后一段（render）表示「正在绘制画布」，
   * 而「画完了」这件事只有画布自己知道 —— React Flow 把节点/边渲染到 DOM 之后
   * 才会走到这个 effect。于是进度条刚好覆盖「从点导入到看见图」的全过程，
   * 不会提前消失（图还没出来条就没了 = 用户仍觉得卡）。
   *
   * 只在确有加载在跑时才动（`topoLoading !== null`）—— 否则拖动设备、刷新等
   * 常规拓扑变化都会把进度条重新点亮。
   */
  const topoLoading = useApp((s) => s.topoLoading)
  const setTopoLoading = useApp((s) => s.setTopoLoading)
  useEffect(() => {
    if (!topoLoading) return
    // 到达收尾阶段（render）→ 画布已经渲染出来，下一帧关掉进度条。
    // 只认 render：中间阶段（read/layout/route）进到这里说明还早，交给 store 推进。
    if (topoLoading.phase !== 'render') return undefined
    const raf = window.requestAnimationFrame(() => setTopoLoading(null))
    return () => window.cancelAnimationFrame(raf)
    // 依赖只用 phase：同一阶段内的 ratio 推进不该让这个 effect 反复跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topoLoading?.phase, nodes.length, setTopoLoading])

  const onNodesChange: OnNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((ns) => applyNodeChanges(changes, ns))
  }, [])

  const onEdgesChange: OnEdgesChange = useCallback((changes) => {
    setEdges((es) => applyEdgeChanges(changes, es))
  }, [])

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
   * 悬停聚焦（B4）：一次算清「哪些设备/链路留在焦点内」，其余在渲染时淡化。
   * 设备聚焦 = 它自己 + 邻居；链路聚焦 = 两端设备 + 那一条链路。
   * 这是「线太多看不清」性价比最高的一招：不改几何，只改权重。
   */
  const focusView = useMemo(() => {
    if (!focus) return null
    const nodes = new Set<string>()
    const inFocus = new Set<string>()
    if (focus.kind === 'node') {
      nodes.add(focus.id)
      for (const l of topology.links) {
        if (l.from === focus.id) {
          nodes.add(l.to)
          inFocus.add(l.id)
        } else if (l.to === focus.id) {
          nodes.add(l.from)
          inFocus.add(l.id)
        }
      }
    } else {
      const hovered = edges.find((e) => e.id === focus.id)
      if (hovered) {
        nodes.add(hovered.source)
        nodes.add(hovered.target)
      }
      inFocus.add(focus.id)
    }
    return { nodes, edges: inFocus }
  }, [focus, topology.links, edges])

  const onNodeHoverEnter = useCallback((_e: React.MouseEvent, node: Node) => {
    setFocus({ kind: 'node', id: node.id })
  }, [])
  const onNodeHoverLeave = useCallback(() => setFocus(null), [])
  const onEdgeHoverEnter = useCallback((_e: React.MouseEvent, edge: Edge) => {
    setFocus({ kind: 'edge', id: edge.id })
  }, [])
  const onEdgeHoverLeave = useCallback(() => setFocus(null), [])

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
      const dimmed = focusView ? !focusView.nodes.has(n.id) : false
      const ports = linkPorts.byNode.get(n.id)
      const usedKey = used ? `${+used.left}${+used.right}${+used.top}${+used.bottom}` : ''
      // 端口签名：side+pct 变化（拖动设备导致铺开变化）必须换 data，否则 handle 位置不更新
      const portsKey = ports ? ports.map((p) => `${p.side}${p.pct.toFixed(3)}`).join(',') : ''
      // 尺寸签名：改名会改变估算宽度 → 硬钉尺寸也变，必须换 data，否则框宽停在旧值，
      // 中心换算（按新尺寸）与渲染（按旧尺寸）错开半个差量
      const size = nodeSizes.get(n.id)
      const sizeKey = size ? `${size.w}x${size.h}` : ''
      const key = `${editingFlag ? 1 : 0}|${usedKey}|${dimmed ? 1 : 0}|${portsKey}|${sizeKey}`
      const cached = dataCacheRef.current.get(n.id)
      const data =
        cached && cached.key === key && cached.source === n.data
          ? cached.data
          : {
              ...(n.data as TopoNodeData),
              used,
              ...(ports ? { ports } : {}),
              editing: editingFlag,
              dimmed,
              commitRename: (name: string) => editing.commitRename(n.id, name),
              cancelRename: editing.cancelRename
            }
      nextCache.set(n.id, { key, data, source: n.data })
      return { ...n, data }
    })
    dataCacheRef.current = nextCache
    return out
  }, [nodes, usedByNode, editing.editingId, editing.commitRename, editing.cancelRename, focusView, linkPorts, nodeSizes])

  /**
   * 链路 data 复用缓存（R6/T7，PERF-MEM-REVIEW-2026-09-29 §4.3）。
   *
   * 与 `dataCacheRef`（节点侧）同构，但此前**边侧根本没有**：`renderEdges` 每
   * 次都给每条边新建一个 data 对象 ⇒ `TopoEdge` 的 `memo` 100% 失效。
   * 而 `focusView` 在**每次鼠标悬停进出节点/连线时都变** ⇒ 悬停一次 = 全部连线
   * 重渲（每条都要 `routeToPath`/`getSmoothStepPath` + 为每个端口重建
   * `PortLabel`，后者带 3 个 useState + 3 个 useRef + 1 个 effect）。
   * 300 节点/400 链路时，每次悬停就是 400 条边 + ~800 个 `PortLabel` 重建。
   *
   * 判据（`key`）只含真正影响 data 的三项：`dense` / `dim` / `emphasized`。
   * `source` 存上游 data 引用 —— 走线结果换了（`planRoutes` 重算）也必须换 data。
   * 与节点侧一样「每次从零重建 nextCache」：被删掉的边不会在缓存里留尸。
   */
  const edgeDataCacheRef = useRef(
    new Map<string, { key: string; data: NonNullable<Edge['data']>; source: unknown }>()
  )

  /**
   * 链路视图装饰（B4）：分级显示 + 悬停聚焦。
   * 只重建 data 引用（不碰几何）；className 由 React Flow 作用到边的 <g> 上，
   * 用于把线本身一起淡化（标注走 EdgeLabelRenderer 是另一个 DOM 节点，故 dim 也进 data）。
   */
  const renderEdges = useMemo<Edge[]>(() => {
    const nextCache = new Map<string, { key: string; data: NonNullable<Edge['data']>; source: unknown }>()
    const out = edges.map((e) => {
      const emphasized = focusView ? focusView.edges.has(e.id) : false
      const dim = focusView ? !emphasized : false
      const key = `${denseLabels ? 1 : 0}|${dim ? 1 : 0}|${emphasized ? 1 : 0}`
      const cached = edgeDataCacheRef.current.get(e.id)
      const data: NonNullable<Edge['data']> =
        cached && cached.key === key && cached.source === e.data
          ? cached.data
          : { ...((e.data ?? {}) as TopoEdgeData), dense: denseLabels, dim, emphasized }
      nextCache.set(e.id, { key, data, source: e.data })
      return { ...e, data, className: dim ? 'topo-edge-dimmed' : '' }
    })
    edgeDataCacheRef.current = nextCache
    return out
  }, [edges, focusView, denseLabels])

  const onConnect: OnConnect = useCallback(
    (conn: Connection) => {
      if (editing.locked) return
      // 自环（起点＝终点）无意义，丢弃避免生成坏边
      if (!conn.source || !conn.target || conn.source === conn.target) return
      // 同设备对允许并接多条线（eNSP 里两台设备可以连多根线缆）：不再按设备对互斥。
      const baseLinks = topology.links.filter((l) => l.source === 'manual')
      // Date.now() 在同一毫秒内不唯一，而 lineKey 必须唯一 —— 否则并接的两条手动线
      // 会共用同一个「线标识」，在手动层里互相顶掉。故加进程内自增序号。
      const linkId = `m-${Date.now()}-${(manualLineSeq += 1)}`
      const link: TopologyLink = {
        id: linkId,
        from: conn.source,
        to: conn.target,
        label: '手动连线',
        lineKey: linkId,
        source: 'manual'
      }
      // N70：type 必须与 `toFlowEdges` 一致（'topo'）—— 原来写 'smoothstep'，
      // 新拖的连线在保存回包/刷新之前没有自定义接口标签（与其余链路观感不一致）。
      // data.identity 同样就地补上：删除走的是「条」粒度，缺了它会退回设备对、连坐删掉同对其它线。
      setEdges((es) =>
        addEdge({ ...conn, id: linkId, type: 'topo', data: { label: '手动连线', identity: linkIdentity(link) } }, es)
      )
      void saveManual({ nodes: manualNodes, links: [...baseLinks, link] })
    },
    [editing.locked, topology, manualNodes, saveManual]
  )

  const addNode = useCallback(() => {
    const name = addName.trim()
    if (!name) return
    // 随机撒在左上角附近，避免叠在一起；坐标是**中心**口径（与 store/布局一致），
    // 落到网格附近的随机位置后，用户点「对齐到网格」即可归位。
    const node: TopologyNode = {
      id: `m-node-${Date.now()}`,
      name,
      role: addRole,
      source: 'manual',
      x: 160 + Math.random() * 260,
      y: 160 + Math.random() * 200
    }
    void saveManual({ nodes: [...manualNodes, node], links: manualLinks })
    setAddName('')
    editing.setMenu(null)
  }, [addName, addRole, manualNodes, manualLinks, saveManual])

  // —— 自适应布局：布局给的是**设备框中心**，store 也是中心口径，直接写回 ——
  const runAutoLayout = useCallback(() => {
    const pos = computeAutoLayout(topology.nodes, topology.links, { sourcePos: sourcePosOf(topology.nodes) })
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
      window.setTimeout(() => fitView({ padding: 0.2, duration: 300, minZoom: READABLE_MIN_ZOOM }), 50)
    })
  }, [topology.nodes, topology.links, manualLinks, saveManual, fitView])

  // —— 恢复 eNSP 原始布局（v2.31）——
  // 与「自适应布局」互为反向：它把坐标改回工程文件里的 srcX/srcY。
  // 必要性：手动层的坐标覆盖是持久的，自适应布局跑过一次就永久压住工程摆放 ——
  // 用户想「回到导入时的样子」必须有个明确入口，否则只能删工程重来。
  const runRestoreSource = useCallback(() => {
    editing.setMenu(null)
    void restoreSourceLayout().then(() => {
      window.setTimeout(() => fitView({ padding: 0.2, duration: 300, minZoom: READABLE_MIN_ZOOM }), 50)
    })
  }, [restoreSourceLayout, editing, fitView])

  // —— 背景网格（B4 第五批）：160px 方格（= 布局格点），显隐持久化到 localStorage ——
  const [gridVisible, setGridVisible] = useState(() => localStorage.getItem(GRID_PREF_KEY) !== '0')
  const toggleGrid = useCallback(() => {
    setGridVisible((v) => {
      localStorage.setItem(GRID_PREF_KEY, v ? '0' : '1')
      return !v
    })
  }, [])

  /**
   * 对齐到网格：把设备**中心**取整到 LAYOUT_GRID 格点（ids 缺省 = 全部设备），写回手动层。
   *
   * 对齐的是**中心**而不是左上角 —— 因为背景方格的十字交点在格点上，只有中心压上去
   * 才算「对齐到网格」（用户口径：网格十字中心）。这正是「设备框中心」坐标口径带来的
   * 简化：store 里存的就是中心，直接取整即可，不必再加减半个框去凑。
   */
  const alignToGrid = useCallback(
    (ids?: string[]) => {
      const wanted = ids ? new Set(ids) : null
      const next: TopologyNode[] = []
      for (const n of topology.nodes) {
        if (wanted && !wanted.has(n.id)) continue
        if (typeof n.x !== 'number' || typeof n.y !== 'number') continue
        next.push({
          id: n.id,
          name: n.name,
          role: n.role,
          ...(n.model ? { model: n.model } : {}),
          x: Math.round(n.x / GRID_SIZE) * GRID_SIZE,
          y: Math.round(n.y / GRID_SIZE) * GRID_SIZE,
          source: 'manual'
        })
      }
      if (next.length === 0) return
      editing.setMenu(null)
      void saveManual({ nodes: next, links: manualLinks })
    },
    [topology.nodes, manualLinks, saveManual, editing]
  )

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

  const onClear = useCallback(async () => {
    if (editing.locked) return
    if (window.confirm('确定要清空拓扑画布吗？当前工程数据与手动连线将被重置。')) {
      editing.setMenu(null)
      editing.closeDetail()
      await clearTopology()
    }
  }, [editing, clearTopology])

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
        runRestoreSource={runRestoreSource}
        gridVisible={gridVisible}
        onToggleGrid={toggleGrid}
        onAlignAll={() => alignToGrid()}
        onImportFile={finder.onImportFile}
        openFinder={finder.openFinder}
        refreshing={refreshing}
        refresh={refresh}
        onClear={onClear}
      />
      <TopologyStage
        canvasRef={canvasRef}
        renderNodes={renderNodes}
        edges={renderEdges}
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
        onNodeHoverEnter={onNodeHoverEnter}
        onNodeHoverLeave={onNodeHoverLeave}
        onEdgeHoverEnter={onEdgeHoverEnter}
        onEdgeHoverLeave={onEdgeHoverLeave}
        fitViewMinZoom={READABLE_MIN_ZOOM}
        gridVisible={gridVisible}
        blockFrames={<TopoBlockFrames blocks={routeModel.framedBlocks} nameOf={blockNames} />}
        onPaneClick={() => {
          editing.setMenu(null)
          editing.closeDetail()
        }}
        locked={editing.locked}
        toggleLock={editing.toggleLock}
      >
        {/* 导入/加载大工程时的进度覆盖层（不抢交互，见 TopoLoadingBar） */}
        <TopoLoadingBar />
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
            onRestoreSource={runRestoreSource}
            onAlignNode={(id) => {
              if (id) alignToGrid([id])
            }}
            onAlignAll={() => alignToGrid()}
            onFitView={() => {
              editing.setMenu(null)
              void fitView({ padding: 0.2, duration: 250, minZoom: READABLE_MIN_ZOOM })
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