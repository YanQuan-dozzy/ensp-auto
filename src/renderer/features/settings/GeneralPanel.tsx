import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { EVENT } from '@shared/channels'
import { formatBytes } from '@shared/attachments'
import type {
  AppInfoPayload,
  ClearDataPayload,
  StorageEntryPayload,
  StorageReportPayload,
  StorageScopeId
} from '@shared/api'
import { useApp } from '@/stores/app'
import { Row, Section } from '@/components/settings-kit'
import { Chip, IconFolder, IconInfo, IconRefresh, IconTrash, Switch } from '@/components/ui'

/**
 * 设置 → 通用（v1.6）。
 *
 * 三块内容，都是「应用本身」而不是「实验怎么做」的事：
 * 1. 数据与存储 —— 数据写在哪、占了多少、怎么清。原来这些信息只能靠翻 AppData 猜；
 * 2. 通知 —— 代理一轮任务可能跑几分钟，跑完得有个回执；
 * 3. 关于 —— 版本、运行环境、数据目录、开源组件。
 *
 * 交互口径：
 * - 占用统计是**一次性读取**，不是实时监控（实时统计要递归扫盘，代价与收益不成比例），
 *   所以给一个显式的「重新统计」按钮，并在清理后自动重算；
 * - 清理是不可撤销动作，二次确认交给**主进程的原生对话框**（按钮不在网页里连点两次就生效）。
 */

const CLEAR_HINT: Record<StorageScopeId, string> = {
  sessions: '删除全部会话记录（含每个会话的树文件），代理对话历史将无法再打开。',
  attachments: '删除导入过的附件副本。原始文件不受影响，只是代理不能再引用它们。',
  exports: '删除导出的实验报告（Markdown / JSON）。'
}

function UsageBar({ entries, total }: { entries: StorageEntryPayload[]; total: number }): ReactNode {
  const sum = total > 0 ? total : 1
  return (
    <div className="usage-bar" role="img" aria-label="数据占用分布">
      {entries.map((e, i) => (
        <span
          key={e.key}
          className={`usage-seg usage-seg-${i % 5}`}
          style={{ width: `${Math.max(e.bytes > 0 ? 0.5 : 0, (e.bytes / sum) * 100)}%` }}
          title={`${e.label} ${formatBytes(e.bytes)}`}
        />
      ))}
    </div>
  )
}

/** 一个数据分类：色点 + 名称 + 「多大 / 几个文件」 + 可清理时的按钮 */
function StorageRow({
  entry,
  index,
  busy,
  onClear
}: {
  entry: StorageEntryPayload
  index: number
  busy: boolean
  onClear: (scope: StorageScopeId) => void
}): ReactNode {
  return (
    <div className="storage-row">
      <span className={`usage-dot dot-${index % 5}`} />
      <span className="storage-name">{entry.label}</span>
      <span className="storage-size mono">
        {formatBytes(entry.bytes)} · {entry.files} 个文件
      </span>
      {entry.clearable ? (
        <button
          className="btn sm"
          disabled={busy || entry.files === 0}
          title={entry.files === 0 ? '已为空' : CLEAR_HINT[entry.key as StorageScopeId]}
          onClick={() => onClear(entry.key as StorageScopeId)}
        >
          <IconTrash size={11} />
          清理
        </button>
      ) : (
        <span className="storage-noclear">不可清理</span>
      )}
    </div>
  )
}

export function GeneralPanel(): ReactNode {
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)

  const [info, setInfo] = useState<AppInfoPayload | null>(null)
  const [storage, setStorage] = useState<StorageReportPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [busyScope, setBusyScope] = useState<StorageScopeId | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const [i, s] = await Promise.all([window.api.app.info(), window.api.app.storage()])
      setInfo(i)
      setStorage(s)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  // 打开分区即取一次：占用数字不主动刷新会让人以为「刚才清的没生效」
  useEffect(() => {
    void load()
  }, [load])

  const clear = useCallback(
    async (scope: StorageScopeId): Promise<void> => {
      setBusyScope(scope)
      setNotice('')
      setError('')
      try {
        const r: ClearDataPayload = await window.api.app.clearData(scope)
        if (r.cancelled) {
          setNotice('已取消，未删除任何文件。')
        } else {
          setNotice(`已清理 ${r.removedFiles} 项，回收 ${formatBytes(r.freedBytes)}。`)
          // 会话被清空后主进程会推送新列表，这里只需重算占用
          const s = await window.api.app.storage()
          setStorage(s)
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusyScope(null)
      }
    },
    []
  )

  const openDir = async (target: 'userData' | 'exports' | 'attachments' | 'snapshots'): Promise<void> => {
    try {
      await window.api.app.openPath(target)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const [pendingUserDataDir, setPendingUserDataDir] = useState<string | null>(null)
  const [migrating, setMigrating] = useState(false)
  /** T4.4：迁移进度（done/total + 当前文件），让「换目录」期间界面不是假死 */
  const [migrateProgress, setMigrateProgress] = useState<{ done: number; total: number } | null>(null)

  const pickUserDataDir = async (): Promise<void> => {
    try {
      const picked = await window.api.app.pickDirectory('选择数据主目录')
      if (!picked || picked === (info?.userDataDir ?? '')) return
      setPendingUserDataDir(picked)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const confirmUserDataDirChange = async (migrate: boolean): Promise<void> => {
    if (!pendingUserDataDir) return
    setMigrating(true)
    setMigrateProgress(null)
    setError('')
    try {
      const res = await window.api.app.changeUserDataDir({
        targetDir: pendingUserDataDir,
        migrateData: migrate
      })
      if (res.success) {
        await window.api.app.relaunch()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setMigrating(false)
      setMigrateProgress(null)
      setPendingUserDataDir(null)
    }
  }

  // T4.4：订阅主进程的迁移进度事件（没有它，大目录迁移时界面只有一句"正在迁移"）
  useEffect(() => {
    return window.api.on<{ done: number; total: number }>(EVENT.storageMigrateProgress, (p) => {
      setMigrateProgress({ done: p.done, total: p.total })
    })
  }, [])

  const resetUserDataDir = async (): Promise<void> => {
    if (!window.confirm('确认恢复默认数据主目录（AppData）？应用将立即重启以生效。')) {
      return
    }
    try {
      await window.api.app.resetUserDataDir()
      await window.api.app.relaunch()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const pickSubDir = async (
    key: 'exportsDir' | 'attachmentsDir' | 'snapshotsDir',
    label: string
  ): Promise<void> => {
    try {
      const picked = await window.api.app.pickDirectory(`选择${label}`)
      if (!picked) return
      const curStorage = settings.storage ?? {
        userDataDir: '',
        exportsDir: '',
        attachmentsDir: '',
        snapshotsDir: ''
      }
      await updateSettings({
        storage: {
          ...curStorage,
          [key]: picked
        }
      })
      setNotice(`已将${label}更新为：${picked}（即时生效）`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const resetSubDir = async (
    key: 'exportsDir' | 'attachmentsDir' | 'snapshotsDir',
    label: string
  ): Promise<void> => {
    try {
      const curStorage = settings.storage ?? {
        userDataDir: '',
        exportsDir: '',
        attachmentsDir: '',
        snapshotsDir: ''
      }
      await updateSettings({
        storage: {
          ...curStorage,
          [key]: ''
        }
      })
      setNotice(`已恢复${label}为默认目录`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const entries = storage?.entries ?? []
  const diskTotal = storage?.diskTotalBytes ?? 0
  const diskFree = storage?.diskFreeBytes ?? 0

  return (
    <>
      <Section
        label="数据与存储"
        action={
          <button className="btn sm" disabled={loading} onClick={() => void load()}>
            <IconRefresh size={11} />
            {loading ? '统计中…' : '重新统计'}
          </button>
        }
      >
        <Row
          title="数据主目录"
          desc="会话历史、配置快照与技能的基础存储位置；更改主目录需重启应用生效。"
          stacked
          control={
            <div className="set-ctl-line">
              <input readOnly value={storage?.userDataDir ?? info?.userDataDir ?? ''} />
              <button className="btn sm" onClick={() => void pickUserDataDir()}>
                选择目录
              </button>
              <button className="btn sm" onClick={() => void openDir('userData')}>
                <IconFolder size={11} />
                打开目录
              </button>
              {info?.isCustomUserData ? (
                <button className="btn sm ghost" onClick={() => void resetUserDataDir()}>
                  恢复默认
                </button>
              ) : null}
            </div>
          }
        />

        <Row
          title="报告导出目录"
          desc="会话报告（Markdown / JSON）与导出的拓扑工件保存在此；即时生效。"
          stacked
          control={
            <div className="set-ctl-line">
              <input readOnly value={info?.exportsDir ?? ''} />
              <button className="btn sm" onClick={() => void pickSubDir('exportsDir', '报告导出目录')}>
                选择目录
              </button>
              <button className="btn sm" onClick={() => void openDir('exports')}>
                <IconFolder size={11} />
                打开目录
              </button>
              {settings.storage?.exportsDir ? (
                <button className="btn sm ghost" onClick={() => void resetSubDir('exportsDir', '报告导出目录')}>
                  恢复默认
                </button>
              ) : null}
            </div>
          }
        />

        <Row
          title="附件归档目录"
          desc="对话中导入的配置附件、参考文档与抓包副本保存在此；即时生效。"
          stacked
          control={
            <div className="set-ctl-line">
              <input readOnly value={info?.attachmentsDir ?? ''} />
              <button className="btn sm" onClick={() => void pickSubDir('attachmentsDir', '附件归档目录')}>
                选择目录
              </button>
              <button className="btn sm" onClick={() => void openDir('attachments')}>
                <IconFolder size={11} />
                打开目录
              </button>
              {settings.storage?.attachmentsDir ? (
                <button className="btn sm ghost" onClick={() => void resetSubDir('attachmentsDir', '附件归档目录')}>
                  恢复默认
                </button>
              ) : null}
            </div>
          }
        />

        <Row
          title="配置快照目录"
          desc="设备变更前自动采集的运行配置备份与快照索引保存在此；即时生效。"
          stacked
          control={
            <div className="set-ctl-line">
              <input readOnly value={info?.snapshotsDir ?? ''} />
              <button className="btn sm" onClick={() => void pickSubDir('snapshotsDir', '配置快照目录')}>
                选择目录
              </button>
              <button className="btn sm" onClick={() => void openDir('snapshots')}>
                <IconFolder size={11} />
                打开目录
              </button>
              {settings.storage?.snapshotsDir ? (
                <button className="btn sm ghost" onClick={() => void resetSubDir('snapshotsDir', '配置快照目录')}>
                  恢复默认
                </button>
              ) : null}
            </div>
          }
        />

        <Row
          title="占用分布"
          desc="只统计本应用自管的数据，不含浏览器内核缓存（那部分不可清理，算进来只会让数字无法解释）。"
          stacked
          control={
            <>
              <UsageBar entries={entries} total={storage?.totalBytes ?? 0} />
              <div className="usage-head">
                <span>
                  本应用数据 <strong className="mono">{formatBytes(storage?.totalBytes ?? 0)}</strong>
                </span>
                {diskTotal > 0 ? (
                  <span className="mono">
                    磁盘可用 {formatBytes(diskFree)} / 共 {formatBytes(diskTotal)}
                  </span>
                ) : null}
              </div>
              <div className="storage-list">
                {entries.map((e, i) => (
                  <StorageRow
                    key={e.key}
                    entry={e}
                    index={i}
                    busy={busyScope !== null}
                    onClear={(scope) => void clear(scope)}
                  />
                ))}
              </div>
            </>
          }
        />

        {notice ? <div className="banner info">{notice}</div> : null}
        {error ? <div className="banner danger">{error}</div> : null}
      </Section>

      <Section label="通知">
        <Row
          title="任务完成时通知"
          desc="代理一轮任务结束时弹系统通知（完成 / 失败 / 中止都会通知）。只在窗口不在前台时弹 —— 正在看的人不需要被眼前的进度再提醒一次。"
          control={
            <Switch
              checked={settings.notify.onTaskEnd}
              onChange={(v) => {
                // D9：读实时值，避免旧闭包把同页其它开关刚写的值抹掉
                const cur = useApp.getState().settings.notify
                void updateSettings({ notify: { ...cur, onTaskEnd: v } })
              }}
            />
          }
        />
        <Row
          title="需要人工确认时通知"
          desc="代理停在危险操作闸门上等你点「执行」时提醒。这类等待如果不提醒，任务会一直挂着。"
          control={
            <Switch
              checked={settings.notify.onGate}
              onChange={(v) => {
                const cur = useApp.getState().settings.notify
                void updateSettings({ notify: { ...cur, onGate: v } })
              }}
            />
          }
        />
        <Row
          title="通知提示音"
          desc="仅影响本应用发出的系统通知；系统「专注助手」等设置可能仍然会压掉声音。"
          control={
            <select
              value={settings.notify.sound}
              onChange={(e) => {
                const cur = useApp.getState().settings.notify
                void updateSettings({
                  notify: { ...cur, sound: e.target.value as 'none' | 'default' }
                })
              }}
            >
              <option value="default">系统默认提示音</option>
              <option value="none">无音效</option>
            </select>
          }
        />
      </Section>

      <Section label="关于">
        <Row
          title="版本"
          desc="本应用是 eNSP 实验的 AI 代理工作台：自然语言下目标，代理自己完成扫描、连接、配置、验证与报告。"
          control={
            <>
              <Chip tone="agent">v{info?.version ?? '—'}</Chip>
              {info ? <Chip>Electron {info.electron}</Chip> : null}
            </>
          }
        />
        <Row
          title="运行环境"
          desc="出现「某个功能在你机器上不工作」时，这一行是排查的第一个线索。"
          wide
          control={
            <span className="mono set-inline-detail">
              Chromium {info?.chrome ?? '—'} · Node {info?.node ?? '—'} · {info?.platform ?? '—'}
            </span>
          }
        />
        <Row
          title="开源组件"
          desc="@earendil-works/pi-ai（多厂商 LLM 统一接口与工具调用）、@modelcontextprotocol/sdk（MCP 客户端/服务端）、@xyflow/react（拓扑画布）、@xterm/xterm（终端渲染）。"
          wide
          control={<span className="set-inline-detail">MIT / Apache-2.0</span>}
        />
        <div className="hint">
          <IconInfo size={11} /> 数据目录里的文件都是纯本地数据，删掉应用目录内的任何文件都不会影响设备上的配置。
        </div>
      </Section>

      {pendingUserDataDir ? (
        <div className="overlay" role="dialog" aria-modal="true" aria-label="更改数据主目录">
          <div className="dialog">
            <div className="dialog-body">
              <div className="dialog-title">
                <IconFolder size={18} />
                更改数据主目录
              </div>
              <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', margin: '8px 0 16px' }}>
                已选择新的主存储根目录。更改数据主目录后，工作台需要重启以加载新目录。
              </p>
              <dl className="kv">
                <dt>当前主目录</dt>
                <dd className="mono" style={{ wordBreak: 'break-all' }}>{info?.userDataDir ?? ''}</dd>
                <dt>目标新目录</dt>
                <dd className="mono" style={{ wordBreak: 'break-all', color: 'var(--accent, #60a5fa)' }}>
                  {pendingUserDataDir}
                </dd>
              </dl>
              <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 12 }}>
                💡 推荐选择「复制数据并重启」：自动把当前会话记录、快照、配置和自定义技能复制到新目录。
              </p>
              <div className="dialog-actions" style={{ marginTop: 20 }}>
                <button className="btn" disabled={migrating} onClick={() => setPendingUserDataDir(null)}>
                  取消
                </button>
                <button
                  className="btn ghost"
                  disabled={migrating}
                  onClick={() => void confirmUserDataDirChange(false)}
                >
                  仅切换为空目录并重启
                </button>
                <button
                  className="btn primary"
                  disabled={migrating}
                  onClick={() => void confirmUserDataDirChange(true)}
                >
                  {migrating
                    ? migrateProgress && migrateProgress.total > 0
                      ? `正在迁移 ${migrateProgress.done}/${migrateProgress.total}…`
                      : '正在迁移数据并重启…'
                    : '复制数据并重启'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
