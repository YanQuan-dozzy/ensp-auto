import type { Attachment } from './attachments'
import type { QuestionAnswers, TodoItem } from './interaction'
import type { AgentEvent, BranchComparison, ChangeRecord, ChangeResult, Device, DeviceId, DiagLevel, DiagReport, EnspLocatePayload, GateDecision, McpServerStatus, SessionNode, SessionNodeMeta, Settings, Skill, SkillSummary, TerminalBufferSegment, Topology, TopologyLink, TopologyNode, WiresharkAvailabilityPayload } from './types'

/**
 * preload 暴露给渲染进程的 API 契约。
 *
 * 放在 shared 而不是 preload 里，是为了让渲染层能拿到类型但**不引入 electron 依赖** ——
 * 渲染层的 tsconfig 只包含 DOM 类型，一旦从 preload 导入，electron 的类型就会漏进来。
 */

/**
 * v2.20：命令报告导出请求。
 *
 * 主进程工具层（`tools/changes.ts`）与渲染层共用这一份形状 —— 两条出口
 * （agent 工具 / UI 按钮）参数一致，报告才不会长成两个样子。
 */
export interface ChangeReportRequest {
  /** 报告标题，缺省「设备配置命令报告」 */
  title?: string
  /** 只导出该设备的记录 */
  deviceId?: string
  /** 只导出该结果的记录；`'all'` 或缺省 = 全部 */
  result?: ChangeResult | 'all'
  /** 参与生成的记录条数上限 */
  limit?: number
}

export interface ChangeReportResult {
  /** 报告落盘路径 */
  path: string
  /** **应用筛选后**的记录条数（不是传入的记录总数） */
  count: number
}

export interface TerminalWriteResult {
  accepted: boolean
  queued: boolean
}

export interface TerminalBufferPayload {
  segments: TerminalBufferSegment[]
  /** 快照水位：渲染层只回放 `seq > 该值` 的实时事件 */
  seq: number
}

export interface SettingsPayload {
  settings: Settings
  /** 当前活跃档案是否已配置密钥 */
  hasApiKey: boolean
  /** v1.5：已配置密钥的档案 id（界面上逐档标「已配置」，但不回传密钥本身） */
  configuredProfileIds: string[]
}

/**
 * 单档连通性测试结果。
 *
 * 刻意复用体检的 DiagLevel / 结论文案口径：同一次探活在两处（体检 / 模型档案页）
 * 必须给出同一句话，否则用户会以为测的是两件事。
 */
export interface ProfileTestResult {
  level: DiagLevel
  detail: string
  hint?: string
  /** 耗时毫秒 */
  ms?: number
}

/** v1.5：附件导入结果。rejected 里是被拒绝的文件与原因（超限/不存在/是目录） */
export interface AttachmentImportPayload {
  attachments: Attachment[]
  rejected: Array<{ name: string; reason: string }>
}

export interface AgentEventPayload {
  sessionId: string
  event: AgentEvent
  runtime: 'react' | 'mock'
}

export interface ScanProgress {
  scanned: number
  total: number
  found: number
  done: boolean
}

export interface TerminalDataPayload {
  deviceId: string
  chunk: Uint8Array
  fromAgent: boolean
  /** 该段在设备回放缓冲中的序号，用于与快照水位对齐去重 */
  seq: number
}

export interface TerminalClosedPayload {
  deviceId: string
  reason: string
}

export interface TerminalClearPayload {
  deviceId: string
}

/** v0.4：MCP 服务运行态（EVENT.mcpStatus 载荷） */
export interface McpStatusPayload {
  running: boolean
  url: string
  error: string | null
}

// —— v1.9：Wireshark 抓包分析（IPC wireshark:* 载荷） ——
export type { WiresharkAvailabilityPayload, WiresharkToolHitPayload } from './types'

export interface WiresharkInstallPayload {
  ok: boolean
  error?: string
}

/** EVENT.storageMigrateProgress 载荷（T4.4） */
export interface StorageMigrateProgressPayload {
  /** 已处理文件数（含跳过与失败） */
  done: number
  /** 待处理总数 */
  total: number
  /** 已拷贝字节数 */
  bytes: number
  /** 当前处理的相对路径 */
  current: string
}

/** EVENT.wiresharkInstallProgress 载荷 */
export interface WiresharkInstallProgressPayload {
  stage: 'detect-python' | 'create-venv' | 'install-package' | 'verify' | 'done'
  message: string
  percent: number | null
}

export interface WiresharkAttachPayload {
  ok: boolean
  /** ok=false 时的原因 */
  error?: string
  /** 挂上后的 MCP 服务器状态（含工具数），便于 UI 立即展示 */
  server: McpServerStatus | null
}

/** v0.5 前置：.topo 解析结果（IPC topology:import-file 载荷） */
export interface TopoImportPayload {
  topology: Topology
  report: {
    devices: number
    links: number
    encoding: string
    gzipped: boolean
    warnings: string[]
  }
}

/** v1.2：拓扑发现候选文件（IPC topology:find-files 载荷元素） */
export interface TopoFileCandidatePayload {
  path: string
  name: string
  directory: string
  source: string
  modifiedAt: number
  isNamedAfterDirectory: boolean
  isActive: boolean
}

/** v1.2：find_topology_files 结果（IPC topology:find-files 载荷） */
export interface TopoFindPayload {
  count: number
  truncated: boolean
  activeTopology: string | null
  candidates: TopoFileCandidatePayload[]
}

/** 窗口状态变更事件载荷（EVENT.windowStateChanged） */
export interface WindowStatePayload {
  isMaximized: boolean
}

/** v1.3：技能导入结果（IPC skills:import-* 载荷） */
export interface SkillImportPayload {
  created: SkillSummary[]
  skipped: string[]
}

/** v1.4：选择 eNSP 可执行文件的返回值（取消返回 null） */
export interface EnspPickPayload {
  exePath: string | null
}

/** v1.10：一句话实验目标存档（IPC goals:get 载荷；渲染层本地随机抽三条展示） */
export interface GoalArchivePayload {
  goals: string[]
  /** 存档时间戳；0 = 内置预设 */
  updatedAt: number
}

/** v1.6：关于页用的运行环境信息 */
export interface AppInfoPayload {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  userDataDir: string
  defaultUserDataDir: string
  isCustomUserData: boolean
  exportsDir: string
  attachmentsDir: string
  snapshotsDir: string
  topologyDir: string
}

export interface PickDirResult {
  canceled: boolean
  path: string | null
}

export interface ChangeUserDataArgs {
  targetDir: string
  migrateData: boolean
}

export interface ChangeUserDataResult {
  success: boolean
  needsRestart: boolean
  migratedFiles?: number
  migratedBytes?: number
  error?: string
}

/** v1.6：可清理的数据范围（主进程白名单，渲染层传来的值只用来查表） */
export type StorageScopeId = 'sessions' | 'attachments' | 'exports'

/** v1.6：单个数据分类的占用 */
export interface StorageEntryPayload {
  key: string
  label: string
  bytes: number
  files: number
  /** 该分类是否支持一键清理（快照/设置在界面上只展示不可清） */
  clearable?: boolean
}

export interface StorageReportPayload {
  entries: StorageEntryPayload[]
  totalBytes: number
  diskFreeBytes: number
  diskTotalBytes: number
  userDataDir: string
}

/** v1.6：清理结果；用户在原生确认框里点了取消时 cancelled = true */
export interface ClearDataPayload {
  cancelled: boolean
  scope: StorageScopeId | null
  removedFiles: number
  freedBytes: number
}

// —— SSH 连接凭据与连接（v2.0：密码/私钥加密存主进程，不发渲染层） ——

/** SSH 连接条目摘要（列表展示用，不含密码/私钥） */
export interface SshCredentialMeta {
  id: string
  name: string
  host: string
  port: number
  username: string
}

/** 渲染层提交的认证载荷；主进程校验后整体加密落盘 */
export type SshAuthInput =
  | { type: 'password'; password: string }
  | { type: 'privateKey'; key: string; passphrase?: string }

/** 连接入参：用已存条目（credentialId）或直接填主机与认证（save 时落盘） */
export interface SshConnectInput {
  credentialId?: string
  save?: boolean
  name?: string
  host?: string
  port?: number
  username?: string
  auth?: SshAuthInput
}

export interface SshSaveInput {
  name: string
  host: string
  port: number
  username: string
  auth: SshAuthInput
}

export interface RendererApi {
  device: {
    scan(start: number, end: number): Promise<Device[]>
    connect(port: number, name?: string): Promise<Device>
    disconnect(deviceId: DeviceId): Promise<void>
    rename(deviceId: DeviceId, name: string): Promise<Device>
    /** 从设备列表移除（断开连接 + 清除别名，下次扫描仍可能重新发现） */
    forget(deviceId: DeviceId): Promise<void>
    list(): Promise<Device[]>
    /** v2.0：SSH 连接凭据与连接（凭据加密存储在主进程，密码/私钥不经 IPC 回传） */
    ssh: {
      list(): Promise<SshCredentialMeta[]>
      save(input: SshSaveInput): Promise<SshCredentialMeta>
      remove(id: string): Promise<void>
      connect(input: SshConnectInput): Promise<Device>
    }
  }
  terminal: {
    write(deviceId: DeviceId, data: string): Promise<TerminalWriteResult>
    resize(deviceId: DeviceId, cols: number, rows: number): Promise<unknown>
    /** 拉取最近输出快照（回放用）；设备未连接时 segments 为空 */
    buffer(deviceId: DeviceId): Promise<TerminalBufferPayload>
    clear(deviceId: DeviceId): Promise<boolean>
  }
  agent: {
    run(
      sessionId: string,
      text: string,
      opts?: {
        rootId?: string | null
        startNodeId?: string | null
        attachments?: Attachment[]
        /** v2.7：计划模式（只读探索 + 方案评审批准后才允许写操作） */
        planMode?: boolean
      }
    ): Promise<{ started: boolean }>
    abort(sessionId: string): Promise<{ aborted: boolean }>
    gate(sessionId: string, gateId: string, decision: GateDecision): Promise<unknown>
    /** v2.7：裁决一次结构化提问；answers 传 null = 取消（模型会退回按最合理假设继续） */
    question(
      sessionId: string,
      questionId: string,
      answers: QuestionAnswers | null
    ): Promise<{ resolved: boolean }>
    enqueue(sessionId: string, text: string): Promise<{ queued: boolean }>
    /** v1.5：弹系统文件多选框导入附件；取消返回 null */
    pickAttachments(sessionId: string): Promise<AttachmentImportPayload | null>
    /** v1.5：按绝对路径导入附件（拖拽/粘贴），主进程校验后复制归档 */
    importAttachments(sessionId: string, paths: string[]): Promise<AttachmentImportPayload | null>
    /** v1.5：一键增强提示词（用当前活跃档案重写草稿）；失败抛错 */
    enhancePrompt(draft: string): Promise<{ text: string }>
  }
  session: {
    list(): Promise<SessionNodeMeta[]>
    get(rootId: string): Promise<SessionNode[]>
    export(rootId: string, format: 'md' | 'json'): Promise<{ path: string }>
    /** v2.2：删除单个历史会话（不可撤销） */
    delete(rootId: string): Promise<{ removed: boolean }>
    /** v2.12：从某消息节点起截断分支（消息删除 / 重新生成的底层）；返回删除的节点数与新尾部 */
    deleteNode(rootId: string, nodeId: string, keepSelf?: boolean): Promise<{ removed: number; newTailId: string | null }>
    /** v2.2：重命名会话标题 */
    rename(rootId: string, title: string): Promise<{ renamed: boolean }>
    /** v2.2：置顶 / 取消置顶 */
    pin(rootId: string, pinned: boolean): Promise<{ pinned: boolean }>
    /** v2.2：在资源管理器打开该会话的数据文件 */
    openInExplorer(rootId: string): Promise<{ opened: boolean }>
    /** v2.2：打开会话数据目录 */
    openDir(): Promise<{ opened: boolean }>
    /** v2.7：读该会话的任务清单（切入历史会话时恢复进度显示） */
    todos(rootId: string): Promise<TodoItem[]>
    /**
     * v2.8：可续跑会话（未收尾的），按更新时间降序。
     * 界面启动时取最近一条提示「继续上次任务」；一次崩溃可能留下多条，
     * 故返回数组而不是单条。
     */
    resumable(): Promise<SessionNodeMeta[]>
    /** F8：标记 / 取消标记书签（阶段完成点）；ok=false 表示节点不存在 */
    setBookmark(
      rootId: string,
      nodeId: string,
      bookmarked: boolean
    ): Promise<{ ok: boolean; bookmarked: boolean }>
    /**
     * F8：同一起点两条分支的调用序列对比。
     * exportFile=true 时把 Markdown 报告写入导出目录并由 path 返回（预览不落盘）。
     */
    compare(
      rootId: string,
      aNodeId: string,
      bNodeId: string,
      exportFile?: boolean
    ): Promise<{ comparison: BranchComparison; markdown: string; path: string | null }>
  }
  /** F6：跨设备的配置变更时间线（只读，按时间倒序，最多 MAX_TIMELINE_ITEMS 条） */
  changes: {
    list(limit?: number): Promise<ChangeRecord[]>
    /** 删除单条变更记录；removed=false 表示该条已不存在 */
    remove(id: string): Promise<{ removed: boolean }>
    /** 清空全部变更记录，removed 为清掉的条数 */
    clear(): Promise<{ removed: number }>
    /**
     * v2.20：导出「设备配置命令报告」（markdown）到导出目录。
     *
     * 与 agent 工具 `export_change_report` 共用同一份正文生成逻辑，
     * 因此点按钮导出和让代理导出拿到的内容一致。
     */
    exportReport(req?: ChangeReportRequest): Promise<ChangeReportResult>
  }
  topology: {
    /** 清空拓扑画布并重置所有层 */
    clear(): Promise<Topology>
    get(): Promise<Topology>
    refresh(): Promise<Topology>
    saveManual(input: { nodes: TopologyNode[]; links: TopologyLink[] }): Promise<Topology>
    /** v0.6 F-5.6：删除节点/链路（打墓碑，跨刷新持久生效） */
    remove(input: { nodeIds?: string[]; linkKeys?: string[] }): Promise<Topology>
    importFile(): Promise<TopoImportPayload | null>
    /** v1.2：发现本机 .topo（桌面/文档/下载或指定目录） */
    findFiles(directory?: string): Promise<TopoFindPayload>
    /** v1.2：按路径导入 .topo（校验由主进程做） */
    importPath(filePath: string): Promise<TopoImportPayload | null>
  }
  settings: {
    get(): Promise<SettingsPayload>
    set(patch: Partial<Settings>): Promise<SettingsPayload>
    /** 不传 profileId 时查活跃档案 */
    hasApiKey(profileId?: string): Promise<{ has: boolean }>
    /** v1.5：密钥按档案分档保管；key 传空串表示删除该档密钥 */
    setApiKey(profileId: string, key: string): Promise<SettingsPayload>
    /** 对某一档发一次最小真实请求（验端点 + 密钥 + 模型名三件事） */
    testProfile(profileId: string): Promise<ProfileTestResult>
  }
  /** v1.5：外部 MCP 服务器（本应用作为客户端连出去） */
  mcp: {
    servers(): Promise<McpServerStatus[]>
    /** 按当前设置重连（幂等） */
    sync(): Promise<McpServerStatus[]>
    /** 测试单个服务器：连接 + 列工具；失败信息在 status.error 里 */
    testServer(id: string): Promise<McpServerStatus | null>
  }
  /**
   * v1.10：一句话实验目标存档。内置丰富场景预设，读完本地随机抽 QUICK_PROMPT_COUNT 条展示。
   */
  goals: {
    list(): Promise<GoalArchivePayload>
  }
  /**
   * v1.4：eNSP 客户端定位（自动探测 .topo 注册表关联与常见安装路径）
   */
  ensp: {
    locate(): Promise<EnspLocatePayload>
    /** 弹系统文件选择框选 eNSP_Client.exe；用户取消返回 null */
    pickExe(): Promise<EnspPickPayload | null>
  }
  /** v1.4：环境体检（模型端点探活、eNSP、MCP 端口、数据目录） */
  diag: {
    run(): Promise<DiagReport>
  }
  /**
   * v1.9：Wireshark 抓包分析接入。
   * 探测（probe）纯只读；install 会联网装组件；attach 幂等地把分析能力
   * 挂成一个外部 MCP 服务器，随后代理就能自主分析 .pcap。
   */
  wireshark: {
    probe(opts?: { force?: boolean }): Promise<WiresharkAvailabilityPayload>
    /** 安装分析组件（隔离 venv）；进度通过 EVENT.wiresharkInstallProgress 推送 */
    install(): Promise<WiresharkInstallPayload>
    /** 把 Wireshark 分析挂成外部 MCP 服务器；profile=full 时含实时抓包 */
    attach(opts?: { profile?: 'analysis' | 'full' }): Promise<WiresharkAttachPayload>
    /** 卸载：停用 m-wireshark 条目并断开连接（配置保留，下次可一键重挂） */
    detach(): Promise<WiresharkAttachPayload>
    /** 弹目录选择框指定 Wireshark 安装位置；取消返回 null */
    pickDir(): Promise<string | null>
  }  /**
   * v1.6：应用级信息与数据目录维护（设置 → 通用）。
   * clearData 会在主进程弹原生确认框；用户取消时 cancelled = true。
   */
  app: {
    info(): Promise<AppInfoPayload>
    storage(): Promise<StorageReportPayload>
    /** 在系统文件管理器里打开某个受管目录（'userData' | 'exports' | 'attachments' | 'snapshots' | 'topology'） */
    openPath(target: 'userData' | 'exports' | 'attachments' | 'snapshots' | 'topology'): Promise<boolean>
    clearData(scope: StorageScopeId): Promise<ClearDataPayload>
    /** 弹系统原生文件夹选择对话框 */
    pickDirectory(title?: string): Promise<string | null>
    /** 切换数据主目录并可选迁移现有数据 */
    changeUserDataDir(args: ChangeUserDataArgs): Promise<ChangeUserDataResult>
    /** 重置数据主目录为系统默认 AppData 路径 */
    resetUserDataDir(): Promise<{ success: boolean; needsRestart: boolean }>
    /** 重启应用 */
    relaunch(): Promise<void>
    /**
     * 在系统默认浏览器打开外部链接（服务商控制台的密钥申请页）。
     * 只接受 http/https，其余协议一律拒绝。
     */
    openExternal(url: string): Promise<boolean>
  }
  skill: {
    list(): Promise<SkillSummary[]>
    get(id: string): Promise<Skill | null>
    /** id 为空 → 新建（主进程生成 id）；否则更新该 id 对应技能。
     *  F12：scope 缺省 = 不改动现有绑定；空数组 = 设为全局技能 */
    save(input: {
      id?: string
      name?: string
      description?: string
      content: string
      scope?: string[]
    }): Promise<Skill>
    remove(id: string): Promise<boolean>
    /** 整体替换启用集合，返回最新列表 */
    setEnabled(ids: string[]): Promise<SkillSummary[]>
    /** 弹系统文件多选框导入 .md 技能；取消返回 null */
    importFiles(): Promise<SkillImportPayload | null>
    /** 弹目录选择框，递归收集 .md 导入；取消返回 null */
    importDirectory(): Promise<SkillImportPayload | null>
    /** 按路径导入单个 .md 技能 */
    importPath(filePath: string): Promise<SkillImportPayload | null>
    /**
     * F13：从该会话的「失败 → 修正」轨迹自动沉淀一份排障技能。
     * 生成即保存但**默认未启用**；无可用轨迹时抛错（文案可直接展示给用户）。
     */
    distill(rootId: string): Promise<{ skill: Skill; episodes: number }>
  }
  window: {
    minimize(): Promise<void>
    maximize(): Promise<boolean>
    close(): Promise<void>
    isMaximized(): Promise<boolean>
    /** 窗口置顶开关；enabled 不传时切换，返回操作后的状态 */
    setAlwaysOnTop(enabled?: boolean): Promise<boolean>
    isAlwaysOnTop(): Promise<boolean>
  }
  /**
   * v2.1：剪贴板纯文本读写（会话里的「复制」/「粘贴」按钮）。
   *
   * 走主进程的 Electron clipboard，而不是渲染层的 navigator.clipboard：
   * 后者写要求文档有焦点、读要走权限申请，且打包后 file:// 与开发态 http 行为不一致。
   * 只做纯文本 —— 剪贴板里的位图不在这条通道上。
   */
  clipboard: {
    readText(): Promise<{ text: string }>
    /** 空串返回 { ok: false }（不做清空剪贴板的隐式行为） */
    writeText(text: string): Promise<{ ok: boolean }>
  }
  /**
   * v1.5：拖拽文件取真实路径。
   * Electron 32 起 File.path 已移除，官方推荐 webUtils.getPathForFile，
   * 它在 preload 里可用但不在 DOM 类型里，所以这里用 unknown 收参（渲染层传 File）。
   */
  files: {
    pathFor(file: unknown): string
  }
  on<T>(channel: string, cb: (payload: T) => void): () => void
}
