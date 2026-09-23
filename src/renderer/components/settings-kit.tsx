import type { ReactNode } from 'react'

/**
 * 设置类界面的行式版式组件（设置弹窗 / 连接 MCP 弹窗共用）。
 *
 * 为什么抽出来：v1.5 起「配置」不再只有一个弹窗 —— 连接 MCP 是另一个弹窗，
 * 但它必须和设置页长一样，否则同一件事在两处出现两套排版。
 * 这里只有版式（分组小标题 + 卡片 + 一行配置项），不含任何业务逻辑。
 */

/** 一行配置项：左侧标题 + 说明，右侧控件 */
export function Row({
  title,
  desc,
  control,
  stacked,
  wide
}: {
  title: ReactNode
  desc?: ReactNode
  control?: ReactNode
  /** 控件需要整行宽度时（路径输入 + 多按钮）用竖排 */
  stacked?: boolean
  /** 详情文本较长时给控件区更大份量 */
  wide?: boolean
}): ReactNode {
  const cls = `set-row${stacked ? ' stacked' : ''}${wide ? ' wide' : ''}`
  return (
    <div className={cls}>
      <div className="set-info">
        <div className="set-title">{title}</div>
        {desc ? <div className="set-desc">{desc}</div> : null}
      </div>
      {control ? <div className={`set-ctl${stacked ? ' stacked' : ''}`}>{control}</div> : null}
    </div>
  )
}

/** 分组小标题 + 卡片容器 */
export function Section({
  label,
  action,
  children
}: {
  label: string
  action?: ReactNode
  children: ReactNode
}): ReactNode {
  return (
    <section className="set-section">
      <div className="set-section-head">
        <span className="set-section-label">{label}</span>
        {action}
      </div>
      <div className="settings-card">{children}</div>
    </section>
  )
}
