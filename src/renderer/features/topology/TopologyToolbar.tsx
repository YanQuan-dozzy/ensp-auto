/**
 * 拓扑画布顶栏（T5.8 从 TopologyCanvas.tsx 外提）。纯视图 —— 只粘表单状态与回调。
 */
import type { RefObject } from 'react'
import type { TopologyRole } from '@shared/types'
import {
  AdaptiveToolbar,
  AdaptiveButton,
  IconPlus,
  IconRotateCcw,
  IconUpload,
  IconSearch,
  IconRefresh
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
  onImportFile: () => Promise<void>
  openFinder: () => void
  refreshing: boolean
  refresh: () => Promise<void>
}

export function TopologyToolbar(p: TopologyToolbarProps): React.ReactNode {
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
            collapseBelow={620}
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
            icon={<IconRotateCcw size={13} />}
            label="自适应布局"
            collapseBelow={680}
            onClick={p.runAutoLayout}
            disabled={p.locked}
            tooltip="按网络层级与骨干自适应排布并居中"
          />
          <AdaptiveButton
            icon={<IconUpload size={13} />}
            label="导入工程"
            collapseBelow={760}
            onClick={() => void p.onImportFile()}
            tooltip="从 .topo / 华为工程文件导入拓扑"
          />
          <AdaptiveButton
            icon={<IconSearch size={13} />}
            label="发现拓扑"
            collapseBelow={850}
            onClick={() => void p.openFinder()}
            tooltip="扫描桌面/文档/下载中的 .topo"
          />
          <AdaptiveButton
            icon={<IconRefresh size={13} className={p.refreshing ? 'dot pending' : ''} />}
            label={p.refreshing ? '刷新中…' : '从设备刷新'}
            variant="primary"
            collapseBelow={460}
            onClick={() => void p.refresh()}
            disabled={p.refreshing}
            tooltip="向设备发送采集指令并更新拓扑连线"
          />
        </>
      }
    />
  )
}