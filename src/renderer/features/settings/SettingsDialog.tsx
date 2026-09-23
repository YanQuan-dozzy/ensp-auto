import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useApp } from '@/stores/app'
import {
  Switch,
  IconSettings,
  IconClose,
  IconCpu,
  IconPlug,
  IconPalette,
  IconKeyboard,
  IconActivity,
  IconShield,
  IconSearch,
  IconKey
} from '@/components/ui'
import { Row, Section } from '@/components/settings-kit'
import { McpDialog } from '@/features/agent/McpDialog'
import { DiagPanel } from './DiagPanel'
import { GeneralPanel } from './GeneralPanel'
import { PermissionPanel } from './PermissionPanel'
import { WiresharkPanel } from './WiresharkPanel'
import { ShortcutsPanel } from './ShortcutsPanel'
import { SshConnectionsPanel } from './SshConnectionsPanel'
import { ProfileSettings } from './ProfileSettings'
import { IntegrationSettings } from './IntegrationSettings'

/**
 * 设置面板。分区：通用 / 模型 / 集成 / 外观 / 环境诊断 / 权限与审批。
 *
 * 版式：左侧竖排导航（分组 + 图标）+ 右侧分区内容（分组小标题 + 卡片式行条目，
 * 行内左侧是「标题 + 说明」，右侧是控件）。与主工作台的三栏语言保持一致：
 * 设置本身也是一个「导航 + 内容」结构，而不是一列堆叠的表单字段。
 *
 * v1.5 模型档案：模型配置不再是全局唯一的三件套，而是「档案」列表 ——
 * 每档自带 provider / 端点 / 模型 / 轮次 / 温度，并且**每档独立保管密钥**。
 * 因此「模型」分区的主语是「当前选中的那一档」，改字段前先选档。
 *
 * v1.6 补上三类「与实验无关、但用起来会碰到」的设置：通用（数据与存储 / 通知 / 关于）、
 * 权限与审批（危险操作闸门与外部工具口径）。导航分组也从两组扩到三组，
 * 对齐成熟客户端的「设置 / 运行 / 数据与安全」三段式。
 *
 * 密钥处理：输入框永远是「只写」的 —— 存进去之后不再回显，
 * 界面只显示「已配置 / 未配置」。密钥本身存在主进程的系统凭据库里，
 * 从不由 IPC 回传渲染层（只回传「哪些档案有密钥」）。
 *
 * 保存语义刻意分成两类，并在底栏明说：
 * - 模型 / 集成：点「保存」才落盘，适合一次改多项
 * - 外观 / 诊断 / 通用 / 权限：即时生效，适合边调边看
 */
type SettingsTab =
  | 'general'
  | 'model'
  | 'integration'
  | 'appearance'
  | 'shortcuts'
  | 'diag'
  | 'wireshark'
  | 'ssh'
  | 'permission'

const NAV_GROUPS: ReadonlyArray<{
  group: string
  items: ReadonlyArray<{ id: SettingsTab; label: string; icon: ReactNode }>
}> = [
  {
    group: '设置',
    items: [
      { id: 'general', label: '通用', icon: <IconSettings size={15} /> },
      { id: 'model', label: '模型', icon: <IconCpu size={15} /> },
      { id: 'integration', label: '集成', icon: <IconPlug size={15} /> },
      { id: 'appearance', label: '外观', icon: <IconPalette size={15} /> },
      { id: 'shortcuts', label: '快捷键', icon: <IconKeyboard size={15} /> }
    ]
  },
  {
    group: '运行',
    items: [
      { id: 'diag', label: '环境诊断', icon: <IconActivity size={15} /> },
      { id: 'wireshark', label: '抓包分析', icon: <IconSearch size={15} /> },
      { id: 'ssh', label: 'SSH 连接', icon: <IconKey size={15} /> }
    ]
  },
  {
    group: '数据与安全',
    items: [{ id: 'permission', label: '权限与审批', icon: <IconShield size={15} /> }]
  }
]

const TAB_META: Record<SettingsTab, { title: string; desc: string; foot: string }> = {
  general: {
    title: '通用',
    desc: '数据存放位置、通知与版本信息',
    foot: '通知设置即时生效；清理数据会先弹系统确认框'
  },
  model: {
    title: '模型',
    desc: '模型档案、密钥与运行参数',
    foot: '所有配置改动即时生效'
  },
  integration: {
    title: '集成',
    desc: '对外 MCP 服务与本机 eNSP 客户端',
    foot: '服务与路径改动即时生效'
  },
  appearance: {
    title: '外观',
    desc: '主题与终端显示偏好',
    foot: '主题与外观改动即时生效'
  },
  shortcuts: {
    title: '快捷键',
    desc: '全局操作、工作台布局、AI 代理与终端按键映射',
    foot: '快捷键全局生效；可在当前页面检索或查看按键绑定'
  },
  diag: {
    title: '环境诊断',
    desc: '一次性体检端点、密钥、客户端路径与服务端口',
    foot: '体检只做只读探测，不改动任何配置'
  },
  wireshark: {
    title: '抓包分析',
    desc: '让代理读懂 .pcap —— 接入本机 Wireshark 的分析能力',
    foot: '抓包分析设置即时生效'
  },
  ssh: {
    title: 'SSH 连接',
    desc: '管理 SSH 连接并手动连接多台设备（含 eNSP 与真实实验设备）',
    foot: '连接即建立会话；断开/删除与连接状态均在第一时间反映到设备列表'
  },
  permission: {
    title: '权限与审批',
    desc: '代理能干到哪一步 —— 破坏性操作与外部工具的口径',
    foot: '权限设置即时生效，且只影响后续操作'
  }
}

export function SettingsDialog({ onClose }: { onClose: () => void }): ReactNode {
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  const setTheme = useApp((s) => s.setTheme)

  const [tab, setTab] = useState<SettingsTab>('model')
  /** 外部 MCP 服务器管理弹窗（与 AI 面板复用同一个组件；集成分区的「管理…」从这里弹出） */
  const [mcpOpen, setMcpOpen] = useState(false)

  // v1.8：onClose 是父组件内联箭头函数，每次 render 新引用 —— 用 ref 存最新回调，
  // 让 Esc 监听 effect 不随每次渲染反复 remove/add（与 McpDialog 同一修法）
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // 连接 MCP 弹窗开着时，Esc 归它 —— 否则一次按键会连着关掉两层
      if (e.key === 'Escape' && !mcpOpen) onCloseRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mcpOpen])

  const meta = TAB_META[tab]

  return (
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-label="设置"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="dialog settings-dialog">
        <div className="settings-layout">
          {/* 左栏：分组导航 */}
          <nav className="settings-nav">
            <div className="settings-nav-brand">
              <IconSettings size={16} style={{ color: 'var(--accent)' }} />
              工作台设置
            </div>
            {NAV_GROUPS.map((g) => (
              <div className="nav-group" key={g.group}>
                <div className="nav-group-label">{g.group}</div>
                {g.items.map((it) => (
                  <button
                    key={it.id}
                    type="button"
                    className={`nav-item${tab === it.id ? ' active' : ''}`}
                    onClick={() => setTab(it.id)}
                  >
                    <span className="nav-item-icon">{it.icon}</span>
                    {it.label}
                  </button>
                ))}
              </div>
            ))}
          </nav>

          {/* 右栏：分区内容 */}
          <div className="settings-main">
            <div className="settings-main-head">
              <div>
                <div className="settings-main-title">{meta.title}</div>
                <div className="settings-main-desc">{meta.desc}</div>
              </div>
              <button className="btn ghost icon sm" onClick={onClose} title="关闭 (Esc)">
                <IconClose size={15} />
              </button>
            </div>

            <div className="settings-scroll">
              {tab === 'general' ? (
                <GeneralPanel />
              ) : tab === 'model' ? (
                <ProfileSettings />
              ) : tab === 'integration' ? (
                <IntegrationSettings onManage={() => setMcpOpen(true)} />

              ) : tab === 'appearance' ? (
                <>
                  <Section label="界面">
                    <Row
                      title="主题"
                      desc="切换会同步终端配色与滚动条；终端与拓扑不读 CSS 变量，需要显式同步。"
                      control={
                        <div className="seg">
                          <button
                            type="button"
                            className={`seg-item${settings.theme === 'dark' ? ' active' : ''}`}
                            onClick={() => void setTheme('dark')}
                          >
                            深色
                          </button>
                          <button
                            type="button"
                            className={`seg-item${settings.theme === 'light' ? ' active' : ''}`}
                            onClick={() => void setTheme('light')}
                          >
                            浅色
                          </button>
                        </div>
                      }
                    />
                  </Section>

                  <Section label="终端">
                    <Row
                      title="设备回显编码"
                      desc="仅影响主进程对回显的「业务解码」（供代理理解与解析）；终端显示始终按设备原始字节渲染。"
                      control={
                        <select
                          value={settings.deviceEncoding}
                          onChange={(e) =>
                            void updateSettings({
                              deviceEncoding: e.target.value as 'auto' | 'utf8' | 'gbk'
                            })
                          }
                        >
                          <option value="auto">自动（UTF-8 优先，失败回退 GBK）</option>
                          <option value="utf8">强制 UTF-8</option>
                          <option value="gbk">强制 GBK</option>
                        </select>
                      }
                    />
                    <Row
                      title="显示代理命令"
                      desc="关闭后，代理下发的命令及其回显不再写入终端，适合「一边看 AI 干活一边自己敲命令」而不被刷屏；代理每一步做了什么仍可在右侧 AI 面板的执行轨迹里逐条查看。"
                      control={
                        <Switch
                          checked={settings.terminalEchoAgentCommands}
                          onChange={(v) => void updateSettings({ terminalEchoAgentCommands: v })}
                        />
                      }
                    />
                  </Section>
                </>
              ) : tab === 'shortcuts' ? (
                <ShortcutsPanel />
              ) : tab === 'permission' ? (
                <PermissionPanel />
              ) : tab === 'wireshark' ? (
                <WiresharkPanel />
              ) : tab === 'ssh' ? (
                <SshConnectionsPanel />
              ) : (
                <DiagPanel />
              )}
            </div>

            <div className="settings-foot">
              <span className="settings-foot-hint">{meta.foot}</span>
            </div>
          </div>
        </div>
      </div>

      {/* 外部 MCP 服务器的增删/测试/授权放在同一套版式里，从设置页也能直接进 */}
      {mcpOpen ? <McpDialog onClose={() => setMcpOpen(false)} /> : null}
    </div>
  )
}
