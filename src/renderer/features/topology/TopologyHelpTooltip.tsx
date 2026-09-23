/**
 * 拓扑操作指南浮窗（T5.8 从 TopologyCanvas.tsx 外提）。
 */
import { useState, type ReactNode } from 'react'
import { IconInfo, useAdaptive } from '@/components/ui'

export function TopologyHelpTooltip({ locked, importNotice }: { locked: boolean; importNotice: string }): ReactNode {
  const [open, setOpen] = useState(false)
  const { width } = useAdaptive()
  const showText = width >= 800

  return (
    <div
      className="topo-help-wrap"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className={`btn sm topo-help-trigger${open ? ' active' : ''}`}
        onClick={() => setOpen((prev) => !prev)}
        aria-label="拓扑画布操作指南"
        title="拓扑画布操作指南与使用说明"
      >
        <IconInfo size={13} style={{ color: 'var(--accent)' }} />
        {showText && <span className="topo-help-trigger-text">操作指南</span>}
      </button>

      {open ? (
        <div className="topo-help-popover" role="tooltip">
          <div className="topo-help-header">
            <span className="topo-help-title">拓扑画布操作指南</span>
            {locked && <span className="chip warning" style={{ fontSize: 10, height: 18, padding: '0 6px' }}>画布已锁定</span>}
          </div>

          {importNotice ? (
            <div className="topo-help-notice">
              {importNotice}
            </div>
          ) : null}

          <div className="topo-help-grid">
            <div className="topo-help-item">
              <span className="topo-help-badge">添加</span>
              <span className="topo-help-desc">输入名称和角色后点击「添加」，或右键空白处添加</span>
            </div>
            <div className="topo-help-item">
              <span className="topo-help-badge">连线</span>
              <span className="topo-help-desc">鼠标悬停于节点四周圆点，按住拖拽至目标节点连线</span>
            </div>
            <div className="topo-help-item">
              <span className="topo-help-badge">编辑</span>
              <span className="topo-help-desc">双击节点可内联重命名；右键可修改角色或断开链路</span>
            </div>
            <div className="topo-help-item">
              <span className="topo-help-badge">删除</span>
              <span className="topo-help-desc">选中节点或连线后，直接按键盘 <kbd>Delete</kbd> 键</span>
            </div>
            <div className="topo-help-item">
              <span className="topo-help-badge">排版</span>
              <span className="topo-help-desc">点击「自适应布局」自动分层居中，支持导入与发现工程</span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

