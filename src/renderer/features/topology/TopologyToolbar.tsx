/**
 * 拓扑画布顶栏（T5.8 从 TopologyCanvas.tsx 外提）。纯视图 —— 只粘表单状态与回调。
 */
import type { RefObject } from 'react'
import type { TopologyRole } from '@shared/types'
import {
  AdaptiveToolbar,
  AdaptiveButton,
  IconPlus,
  IconUpload,
  IconSearch,
  IconRefresh,
  IconTrash
} from '@/components/ui'
import { ROLE_LABEL } from './TopoRender'
import { TopologyHelpTooltip } from './TopologyHelpTooltip'

export interface TopologyToolbarProps {
  addInputRef: RefObject<HTMLInputElement | null>
  addName: string
  setAddName: (v: string) => void
  addRole: TopologyRole
  setAddRole: (v: TopologyRole) => void
  addNode: () => void
  locked: boolean
  importNotice: string
  runAutoLayout: () => void
  /** v2.31：把坐标恢复成 eNSP 工程里的原始摆布（撤销自适应布局/拖动造成的坐标覆盖） */
  runRestoreSource: () => void
  /** 背景网格显隐：开 = 160px 方格（= 布局格点），关 = 点阵 */
  gridVisible: boolean
  onToggleGrid: () => void
  /** 全部设备对齐到网格 */
  onAlignAll: () => void
  onImportFile: () => Promise<void>
  openFinder: () => void
  refreshing: boolean
  refresh: () => Promise<void>
  onClear: () => Promise<void>
}

/** 网格图标（三横三竖的方格） */
function IconGrid({ size = 13 }: { size?: number }): React.ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <rect x="3" y="3" width="18" height="18" rx="1" />
      <line x1="9" y1="3" x2="9" y2="21" />
      <line x1="15" y1="3" x2="15" y2="21" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="3" y1="15" x2="21" y2="15" />
    </svg>
  )
}

/** 对齐图标（磁吸到栅格的方块） */
function IconAlignGrid({ size = 13 }: { size?: number }): React.ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="8" y="8" width="8" height="8" rx="1" />
      <path d="M3 3v3M3 3h3M21 3v3M21 3h-3M3 21v-3M3 21h3M21 21v-3M21 21h-3" />
    </svg>
  )
}

/**
 * 层级布局图标（自顶向下的设备层级树）—— 「自适应布局」专用。
 *
 * 为什么不用 `IconRotateCcw`（圈箭头）：隔壁「恢复原始布局」用的是 `IconRestore`（也是圈箭头），
 * 两者在 13px 下都是「一个带箭头的圆」，并排放在一起根本分不出哪个是重排、哪个是撤销。
 * 层级树既与「按网络层级与骨干自适应排布」的语义对得上，也和圆圈系图标在轮廓上彻底分开。
 */
function IconHierarchy({ size = 13 }: { size?: number }): React.ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="4" rx="1" />
      <rect x="2" y="17" width="6" height="4" rx="1" />
      <rect x="16" y="17" width="6" height="4" rx="1" />
      <path d="M12 7v7" />
      <path d="M5 17v-3h14v3" />
    </svg>
  )
}

/** 恢复原样图标（回到起点的箭头） */
function IconRestore({ size = 13 }: { size?: number }): React.ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  )
}

export function TopologyToolbar(p: TopologyToolbarProps): React.ReactNode {
  /**
   * N73：全部按钮改用 `collapseBelow="auto"` —— 阈值由工具栏实测预算推算。
   *
   * 之前是 9 个手写像素阈值（620/680/760/840/850/880/950…），它们只在「6 个按钮」
   * 的旧形态下成立；加按钮后阈值不会跟着变，于是空间不够却仍显示文字 →
   * Flex 把按钮压扁 = 用户看到的「宽度自适应失效」。
   * 现在预算由 `AdaptiveToolbar` 按实际 DOM 量出（收成图标的固宽 vs 全展开固宽），
   * 以后再加按钮也不必回来改数字。
   */
  const AUTO = 'auto' as const
  return (
    <AdaptiveToolbar
      className="topology-toolbar-adaptive"
      left={
        <>
          <input
            ref={p.addInputRef}
            className="topology-input adaptive-node-input"
            value={p.addName}
            onChange={(e) => p.setAddName(e.target.value)}
            placeholder="新节点名（如 PC-1）"
            disabled={p.locked}
            onKeyDown={(e) => {
              if (e.key === 'Enter') p.addNode()
            }}
          />
          <select
            className="topology-input adaptive-role-select"
            value={p.addRole}
            disabled={p.locked}
            onChange={(e) => p.setAddRole(e.target.value as TopologyRole)}
          >
            {(Object.keys(ROLE_LABEL) as TopologyRole[]).map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
          <AdaptiveButton
            icon={<IconPlus size={13} />}
            label="添加节点"
            priority="high"
            collapseBelow={AUTO}
            onClick={p.addNode}
            disabled={p.locked}
            tooltip="添加节点到拓扑画布"
          />
          <TopologyHelpTooltip locked={p.locked} importNotice={p.importNotice} />
        </>
      }
      right={
        <>
          <AdaptiveButton
            icon={<IconHierarchy size={13} />}
            label="自适应布局"
            priority="medium"
            collapseBelow={AUTO}
            onClick={p.runAutoLayout}
            disabled={p.locked}
            tooltip="按网络层级与骨干自适应排布并居中"
          />
          <AdaptiveButton
            icon={<IconRestore size={13} />}
            label="恢复原始布局"
            priority="low"
            collapseBelow={AUTO}
            onClick={p.runRestoreSource}
            disabled={p.locked}
            tooltip="撤销布局改动，回到 eNSP 工程文件里的原始摆布"
          />
          <AdaptiveButton
            icon={<IconGrid size={13} />}
            label={p.gridVisible ? '隐藏网格' : '显示网格'}
            priority="low"
            collapseBelow={AUTO}
            onClick={p.onToggleGrid}
            aria-pressed={p.gridVisible}
            tooltip="背景方格（160px，一格一台设备位）显隐"
          />
          <AdaptiveButton
            icon={<IconAlignGrid size={13} />}
            label="对齐网格"
            priority="low"
            collapseBelow={AUTO}
            onClick={p.onAlignAll}
            disabled={p.locked}
            tooltip="把全部设备坐标对齐到 160px 网格（分组框与连线随之重算）"
          />
          <AdaptiveButton
            icon={<IconUpload size={13} />}
            label="导入工程"
            priority="medium"
            collapseBelow={AUTO}
            onClick={() => void p.onImportFile()}
            tooltip="从 .topo 工程 / .paper 实验包导入拓扑"
          />
          <AdaptiveButton
            icon={<IconSearch size={13} />}
            label="发现拓扑"
            priority="low"
            collapseBelow={AUTO}
            onClick={() => void p.openFinder()}
            tooltip="扫描桌面/文档/下载中的 .topo 与 .paper"
          />
          <AdaptiveButton
            icon={<IconTrash size={13} />}
            label="清空画布"
            priority="low"
            collapseBelow={AUTO}
            onClick={() => void p.onClear()}
            disabled={p.locked}
            tooltip="清空当前拓扑画布并重置工程状态"
          />
          <AdaptiveButton
            icon={<IconRefresh size={13} className={p.refreshing ? 'dot pending' : ''} />}
            label={p.refreshing ? '刷新中…' : '从设备刷新'}
            variant="primary"
            priority="critical"
            collapseBelow={AUTO}
            onClick={() => void p.refresh()}
            disabled={p.refreshing}
            tooltip="向设备发送采集指令并更新拓扑连线"
          />
        </>
      }
    />
  )
}