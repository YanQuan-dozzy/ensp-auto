import path from 'node:path'
import { EVENT } from '@shared/channels'
import { activeProfile, LEGACY_PROFILE_ID } from '@shared/profiles'
import type { Settings } from '@shared/types'
import { JsonStore } from '../core/store/store'
import { SnapshotStore } from '../core/store/snapshots'
import { ChangeStore } from '../core/store/changes'
import { SessionManager } from '../core/session/SessionManager'
import { TopologyStore } from '../core/topology/store'
import { SessionTreeStore } from '../core/session-tree/store'
import { SkillStore } from '../skills/store'
import { GoalArchiveStore } from '../goals/store'
import { AttachmentStore } from '../core/attachments/store'
import { McpClientManager } from '../core/mcp/client'
import { initSshSecrets } from '../settings/sshSecrets'
import { migrateLegacyApiKey } from '../settings/secrets'

/**
 * 存储层装配（T5.2 从 services.ts 抽出）。
 *
 * 抽出的理由：`Services` 的构造函数里躺着 10 个 store 的创建顺序与互相依赖
 * （快照/附件目录取决于设置项、每个 store 都要把变更事件桥到渲染层），
 * 而「顺序」在这里是有语义的 —— 混在业务方法中间，改动风险看不见。
 * 现在这一处集中表达装配，`Services` 只负责持有与转发。
 */

export interface StoreBundle {
  store: JsonStore
  snapshots: SnapshotStore
  changes: ChangeStore
  sessions: SessionManager
  topology: TopologyStore
  sessionTree: SessionTreeStore
  skills: SkillStore
  goals: GoalArchiveStore
  attachments: AttachmentStore
  mcpClients: McpClientManager
}

export interface CreateStoresOptions {
  /** 数据根目录（app.getPath('userData')） */
  userDataDir: string
  /** 主进程 → 渲染层的事件推送 */
  emit: (channel: string, payload: unknown) => void
}

/**
 * 解析「可自定义」的受管目录：设置里有值就用自定义（解析为绝对路径），否则落在 userData 下。
 * 与 Services 的同名 getter 共用同一份口径 —— 三处（快照/附件/导出）规则必须一致。
 */
export function resolveStorageDir(
  settings: Settings,
  key: 'exportsDir' | 'attachmentsDir' | 'snapshotsDir',
  fallback: string
): string {
  const custom = settings.storage?.[key]
  return custom && custom.trim() ? path.resolve(custom.trim()) : fallback
}

/**
 * v1.5：把 v1.4 的单把密钥迁到「它原本属于的那档」。
 * 若设置里存在迁移档案（p-legacy，说明确实是老配置迁移过来的），就挂到它上面；
 * 否则挂到当前活跃档案。幂等：密钥文件已存在时不执行。
 */
function migrateLegacyKey(store: JsonStore): void {
  try {
    const agent = store.getSettings().agent
    const target = agent.profiles.some((p) => p.id === LEGACY_PROFILE_ID)
      ? LEGACY_PROFILE_ID
      : activeProfile(agent).id
    migrateLegacyApiKey(target)
  } catch {
    /* 迁移失败不阻塞启动：用户仍可在设置里重新填一次 */
  }
}

/** 三个受管目录的实时解析（设置项可覆盖；Services 的 getter 直接复用，避免两处口径） */
export function storageDirs(
  userDataDir: string,
  settings: Settings
): { exportsDir: string; attachmentsDir: string; snapshotsDir: string } {
  return {
    exportsDir: resolveStorageDir(settings, 'exportsDir', path.join(userDataDir, 'exports')),
    attachmentsDir: resolveStorageDir(settings, 'attachmentsDir', path.join(userDataDir, 'attachments')),
    snapshotsDir: resolveStorageDir(settings, 'snapshotsDir', path.join(userDataDir, 'snapshots-data'))
  }
}

/**
 * 按固定顺序创建全部 store。
 *
 * **顺序是有意义的**（T5.2 验收要求冷启动行为逐项不变）：
 * JsonStore 先落地 → SSH 凭据初始化 → 依赖设置项的目录逐个解析 → 各 store 注册事件桥
 * → SessionManager 最后（它要读设置、也要往外推终端事件）→ 收尾做一次旧密钥迁移。
 */
export function createStores(opts: CreateStoresOptions): StoreBundle {
  const { userDataDir, emit } = opts
  const store = new JsonStore(path.join(userDataDir, 'ensp-auto.json'))
  const getSettings = (): Settings => store.getSettings()
  const attachmentsDir = (): string =>
    resolveStorageDir(getSettings(), 'attachmentsDir', path.join(userDataDir, 'attachments'))
  const snapshotsDir = (): string =>
    resolveStorageDir(getSettings(), 'snapshotsDir', path.join(userDataDir, 'snapshots-data'))

  // v2.0：SSH 连接凭据（safeStorage 加密）挂在 userData 下
  initSshSecrets(userDataDir)

  const snapshots = new SnapshotStore(snapshotsDir())
  const changes = new ChangeStore(snapshotsDir())
  const attachments = new AttachmentStore(attachmentsDir())
  const mcpClients = new McpClientManager({
    onChange: (statuses) => emit(EVENT.mcpServersUpdated, statuses)
  })
  const topology = new TopologyStore({
    file: path.join(userDataDir, 'topology.json'),
    onChange: (t) => emit(EVENT.topologyUpdated, t)
  })
  const sessionTree = new SessionTreeStore({
    dir: path.join(userDataDir, 'sessions'),
    onChange: (list) => emit(EVENT.sessionListUpdated, list)
  })
  const skills = new SkillStore({
    dir: path.join(userDataDir, 'skills'),
    onChange: (list) => emit(EVENT.skillsUpdated, list)
  })
  const goals = new GoalArchiveStore(path.join(userDataDir, 'goals.json'))
  const sessions = new SessionManager(store, {
    getSettings: () => store.getSettings(),
    onRaw: (deviceId, chunk, fromAgent) => {
      emit(EVENT.terminalData, { deviceId, chunk, fromAgent })
    },
    onClosed: (deviceId, reason) => {
      emit(EVENT.terminalClosed, { deviceId, reason })
    },
    onStateChanged: (device) => {
      emit(EVENT.deviceStateChanged, device)
    }
  })

  // 旧格式（单把密钥）迁移到对应档案：老用户不该在升级后发现「模型在、密钥没了」
  migrateLegacyKey(store)

  return { store, snapshots, changes, sessions, topology, sessionTree, skills, goals, attachments, mcpClients }
}

