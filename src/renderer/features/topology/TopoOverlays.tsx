/**
 * 拓扑画布浮层（T5.8 从 TopologyCanvas.tsx 外提）：节点详情 / 发现工程 / 右键菜单。
 * 全部是纯视图 —— 只粘展示数据与回调，交互逻辑留在 FlowInner。
 */
import type { TopologyRole } from '@shared/types'
import type { TopoFindPayload } from '@shared/api'
import { ROLE_LABEL, NODE_COLOR, type MenuState } from './TopoRender'
import { fmtDate } from './TopoRender'
import { shortIf } from './portLabel'

// ———————————————————— 节点详情 ————————————————————

export interface DetailLink {
  peer: string
  label?: string
}

export interface TopoDetailPanelProps {
  node: { id: string; name: string; role: TopologyRole; model?: string; interfaces?: string[] }
  port: number | null
  links: DetailLink[]
  onClose: () => void
  onConnect: (port: number) => void
}

export function TopoDetailPanel(p: TopoDetailPanelProps): React.ReactNode {
  const { node, port, links, onClose, onConnect } = p
  return (
    <div className="topo-detail" onClick={(e) => e.stopPropagation()}>
      <div className="topo-detail-head">
        <span className="topo-detail-name" title={node.name}>
          {node.name}
        </span>
        <span className="topo-detail-role" style={{ color: NODE_COLOR[node.role] ?? 'var(--text-muted)' }}>
          {ROLE_LABEL[node.role] ?? node.role}
        </span>
        <button className="topo-detail-close" onClick={onClose} aria-label="关闭">
          ✕
        </button>
      </div>
      <div className="topo-detail-body">
        {node.model ? (
          <div className="topo-detail-row">
            <span className="topo-detail-k">型号</span>
            <span className="topo-detail-v">{node.model}</span>
          </div>
        ) : null}
        <div className="topo-detail-row">
          <span className="topo-detail-k">Telnet</span>
          <span className="topo-detail-v">
            {Number.isFinite(port) && (port ?? 0) > 0 ? `127.0.0.1:${port}` : '未配置端口'}
          </span>
        </div>
        {(node.interfaces?.length ?? 0) > 0 ? (
          <div className="topo-detail-section">
            <div className="topo-detail-sec-title">接口（{node.interfaces!.length}）</div>
            <div className="topo-detail-ifaces">
              {node.interfaces!.map((itf) => (
                <span key={itf} className="topo-detail-iface">
                  {itf}
                </span>
              ))}
            </div>
          </div>
        ) : null}
        {links.length > 0 ? (
          <div className="topo-detail-section">
            <div className="topo-detail-sec-title">连接（{links.length}）</div>
            <div className="topo-detail-links">
              {links.map((l) => (
                <span key={`${node.id}:${l.peer}`} className="topo-detail-link">
                  → {l.peer}
                  {l.label ? <em className="topo-detail-link-iface">{shortIf(l.label)}</em> : null}
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      {Number.isFinite(port) && (port ?? 0) > 0 ? (
        <div className="topo-detail-foot">
          <button className="btn primary" onClick={() => onConnect(port!)}>
            打开终端
          </button>
        </div>
      ) : null}
    </div>
  )
}

// ———————————————————— 发现拓扑工程 ————————————————————

export interface TopoFinderPanelProps {
  finder: TopoFindPayload | null
  loading: boolean
  onClose: () => void
  onRefresh: () => void
  onImport: (path: string) => void
}

export function TopoFinderPanel(p: TopoFinderPanelProps): React.ReactNode {
  const { finder, loading, onClose, onRefresh, onImport } = p
  return (
    <>
      <div
        className="topo-menu-backdrop"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div className="topo-finder">
        <div className="topo-finder-head">
          <span className="topo-finder-title">发现拓扑工程</span>
          <button className="topo-finder-refresh" onClick={() => void onRefresh()} disabled={loading}>
            {loading ? '扫描中…' : '重新扫描'}
          </button>
          <button className="topo-detail-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="topo-finder-body">
          {!finder ? (
            <div className="topo-finder-empty">扫描桌面/文档/下载…</div>
          ) : finder.candidates.length === 0 ? (
            <div className="topo-finder-empty">
              没有找到 .topo 文件（已扫描桌面/文档/下载）。可点「导入工程文件」手动选择。
            </div>
          ) : (
            <>
              {finder.candidates.map((c) => (
                <button
                  key={c.path}
                  className="topo-finder-item"
                  onClick={() => onImport(c.path)}
                  title={c.path}
                >
                  <span className="topo-finder-item-name">
                    {c.name}
                    {c.isActive ? (
                      <em className="topo-finder-badge">当前</em>
                    ) : c.isNamedAfterDirectory ? (
                      <em className="topo-finder-badge dim">目录同名</em>
                    ) : null}
                  </span>
                  <span className="topo-finder-item-sub">
                    @{c.source} · {fmtDate(c.modifiedAt)}
                  </span>
                </button>
              ))}
              {finder.truncated ? (
                <div className="topo-finder-empty">
                  结果已截断（仅显示前 {finder.count} 个），可用 find_topology_files 查看更多
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </>
  )
}

// ———————————————————— 右键菜单 ————————————————————

export interface TopoContextMenuProps {
  menu: MenuState
  nodeName?: string
  locked: boolean
  onRename: (nodeId: string | null) => void
  onSetSub: (sub: 'roles' | undefined) => void
  onDisconnect: (nodeId: string | null) => void
  onDeleteNode: (nodeId: string | null) => void
  onChangeRole: (nodeId: string | null, role: TopologyRole) => void
  onDeleteEdge: (edgeId: string | null) => void
  onClose: () => void
  onFocusAdd: () => void
  onRunLayout: () => void
  onFitView: () => void
}

export function TopoContextMenu(p: TopoContextMenuProps): React.ReactNode {
  const { menu, nodeName, locked } = p
  return (
    <>
      <div
        className="topo-menu-backdrop"
        onClick={p.onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          p.onClose()
        }}
      />
      <div className="topo-menu" style={{ left: menu.x, top: menu.y }}>
        {menu.kind === 'node' && menu.sub !== 'roles' ? (
          <>
            <div className="topo-menu-title">{nodeName ?? '节点'}</div>
            <button
              className="topo-menu-item"
              onClick={() => {
                p.onRename(menu.nodeId ?? null)
                p.onClose()
              }}
            >
              重命名
            </button>
            <button className="topo-menu-item" onClick={() => p.onSetSub('roles')}>
              修改角色 ▸
            </button>
            <div className="topo-menu-sep" />
            <button className="topo-menu-item" onClick={() => p.onDisconnect(menu.nodeId ?? null)}>
              断开全部链路
            </button>
            <button
              className="topo-menu-item danger"
              onClick={() => p.onDeleteNode(menu.nodeId ?? null)}
            >
              删除节点
            </button>
          </>
        ) : menu.kind === 'node' && menu.sub === 'roles' ? (
          <>
            <div className="topo-menu-title">选择角色</div>
            {(Object.keys(ROLE_LABEL) as TopologyRole[]).map((r) => (
              <button
                key={r}
                className="topo-menu-item"
                style={{ color: NODE_COLOR[r] }}
                onClick={() => p.onChangeRole(menu.nodeId ?? null, r)}
              >
                {ROLE_LABEL[r]}
              </button>
            ))}
            <div className="topo-menu-sep" />
            <button className="topo-menu-item" onClick={() => p.onSetSub(undefined)}>
              ← 返回
            </button>
          </>
        ) : menu.kind === 'edge' ? (
          <>
            <div className="topo-menu-title">链路</div>
            <button
              className="topo-menu-item danger"
              onClick={() => p.onDeleteEdge(menu.edgeId ?? null)}
            >
              删除链路
            </button>
          </>
        ) : (
          <>
            <div className="topo-menu-title">画布</div>
            {locked ? (
              <div className="topo-menu-note">已锁定：仅可缩放 / 适应画布</div>
            ) : (
              <>
                <button className="topo-menu-item" onClick={p.onFocusAdd}>
                  添加节点…
                </button>
                <button className="topo-menu-item" onClick={p.onRunLayout}>
                  自适应布局
                </button>
              </>
            )}
            <button className="topo-menu-item" onClick={p.onFitView}>
              适应画布
            </button>
          </>
        )}
      </div>
    </>
  )
}