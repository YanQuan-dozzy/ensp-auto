/**
 * 拓扑画布主舞台（T5.8 从 TopologyCanvas.tsx 外提）：ReactFlow + 背景 + 控件 + MiniMap。
 * 纯视图 —— 全部交互回调由父组件传入；overlays（详情/发现/右键菜单）作为 children 透传，
 * 保持它们在画布容器内的绝对定位层级不变。
 */
import type { ReactNode, RefObject } from 'react'
import type {
  Edge,
  Node,
  OnConnect,
  OnEdgesChange,
  OnNodesChange,
  OnSelectionChangeParams
} from '@xyflow/react'
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MiniMap,
  ReactFlow
} from '@xyflow/react'
import type { TopologyRole } from '@shared/types'
import { LockGlyph, NODE_COLOR_HEX, TopoNodeData, UnlockGlyph } from './TopoRender'

export interface TopologyStageProps {
  canvasRef: RefObject<HTMLDivElement | null>
  renderNodes: Node[]
  edges: Edge[]
  nodeTypes: Record<string, unknown>
  edgeTypes: Record<string, unknown>
  onNodesChange: OnNodesChange
  onEdgesChange: OnEdgesChange
  onNodeDragStart: () => void
  onNodeDragStop: (event: unknown, node: Node) => void
  onConnect: OnConnect
  onSelectionChange: (p: OnSelectionChangeParams) => void
  onNodeContextMenu: (e: React.MouseEvent, node: Node) => void
  onEdgeContextMenu: (e: React.MouseEvent, edge: Edge) => void
  onPaneContextMenu: (e: React.MouseEvent | MouseEvent) => void
  onNodeClick: (e: React.MouseEvent, node: Node) => void
  onNodeDoubleClick: (e: React.MouseEvent, node: Node) => void
  onPaneClick: () => void
  locked: boolean
  toggleLock: () => void
  children?: ReactNode
}

/** MiniMap 节点着色与 ReactFlow 内部逻辑同用 NODE_COLOR_HEX */
function miniMapColor(n: Node): string {
  const data = n.data as TopoNodeData | undefined
  return NODE_COLOR_HEX[(data?.role ?? 'router') as TopologyRole] ?? '#6c7086'
}

export function TopologyStage(p: TopologyStageProps): React.ReactNode {
  return (
    <div className={`topology-canvas${p.locked ? ' locked' : ''}`} ref={p.canvasRef}>
      <ReactFlow
        nodes={p.renderNodes}
        edges={p.edges}
        nodeTypes={p.nodeTypes as never}
        edgeTypes={p.edgeTypes as never}
        connectionMode={ConnectionMode.Loose}
        onNodesChange={p.onNodesChange}
        onEdgesChange={p.onEdgesChange}
        onNodeDragStart={p.onNodeDragStart}
        onNodeDragStop={p.onNodeDragStop}
        onConnect={p.onConnect}
        onSelectionChange={p.onSelectionChange}
        onNodeContextMenu={p.onNodeContextMenu}
        onEdgeContextMenu={p.onEdgeContextMenu}
        onPaneContextMenu={p.onPaneContextMenu}
        onNodeClick={p.onNodeClick}
        onNodeDoubleClick={p.onNodeDoubleClick}
        onPaneClick={p.onPaneClick}
        /* 锁定 = 只读：节点不可拖/不可连线/不可选中，画布不可平移（缩放仍可用） */
        nodesDraggable={!p.locked}
        nodesConnectable={!p.locked}
        elementsSelectable={!p.locked}
        panOnDrag={!p.locked}
        fitView
        minZoom={0.15}
        maxZoom={2.5}
        zoomOnDoubleClick={false}
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="var(--border-subtle)" />
        <Controls position="bottom-left" showInteractive={false}>
          <button
            type="button"
            className={`react-flow__controls-button topo-lock-btn${p.locked ? ' locked' : ''}`}
            onClick={p.toggleLock}
            aria-pressed={p.locked}
            aria-label={p.locked ? '解锁画布' : '锁定画布'}
            title={
              p.locked
                ? '已锁定：节点与画布不可拖动/平移，编辑入口收起。点击解锁'
                : '锁定画布：冻结拖动、平移与编辑，避免查看时误改拓扑（缩放不受影响）'
            }
          >
            {p.locked ? <LockGlyph /> : <UnlockGlyph />}
          </button>
        </Controls>
        <MiniMap
          pannable={!p.locked}
          zoomable
          position="top-left"
          nodeColor={miniMapColor}
          maskColor="rgba(17, 17, 27, 0.6)"
          bgColor="var(--bg-surface)"
        />
      </ReactFlow>
      {p.children}
    </div>
  )
}