/**
 * IPC 通道名常量。主进程与 preload 共用，避免字符串拼写漂移。
 */

export const INVOKE = {
  deviceScan: 'device:scan',
  deviceConnect: 'device:connect',
  deviceDisconnect: 'device:disconnect',
  deviceRename: 'device:rename',
  deviceForget: 'device:forget',
  deviceList: 'device:list',

  /** SSH 连接凭据与连接（凭据加密存储在主进程，密码/私钥不经 IPC 回传） */
  deviceSshList: 'device:ssh:list',
  deviceSshSave: 'device:ssh:save',
  deviceSshDelete: 'device:ssh:delete',
  deviceSshConnect: 'device:ssh:connect',

  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalBuffer: 'terminal:buffer',
  terminalClear: 'terminal:clear',

  agentRun: 'agent:run',
  agentAbort: 'agent:abort',
  agentGate: 'agent:gate',
  /** v2.7：裁决一次结构化提问（ask_user_question / 计划模式方案评审） */
  agentQuestion: 'agent:question',
  agentEnqueue: 'agent:enqueue',
  /** v1.5：弹文件选择框导入附件 */
  agentPickAttachments: 'agent:pick-attachments',
  /** v1.5：按路径导入附件（拖拽/粘贴走这条，校验在主进程） */
  agentImportAttachments: 'agent:import-attachments',
  /** v1.5：一键增强提示词（用当前档案重写草稿） */
  agentEnhancePrompt: 'agent:enhance-prompt',

  /** v1.5：外部 MCP 服务器列表（含连接状态与工具清单） */
  mcpServers: 'mcp:servers',
  /** v1.5：重连外部 MCP 服务器 */
  mcpSync: 'mcp:sync',
  /** v1.5：测试单个外部 MCP 服务器 */
  mcpTestServer: 'mcp:test-server',
  /** v1.9：探测 Wireshark 工具链（只读，不装任何东西） */
  wiresharkProbe: 'wireshark:probe',
  /** v1.9：安装 Wireshark 分析组件（隔离 venv，联网） */
  wiresharkInstall: 'wireshark:install',
  /** v1.9：把 Wireshark 分析挂成一个外部 MCP 服务器（幂等） */
  wiresharkAttach: 'wireshark:attach',
  /** T3.4：卸载（把 m-wireshark 条目停用并断开，配置保留） */
  wiresharkDetach: 'wireshark:detach',
  /** v1.9：选 Wireshark 安装目录 */
  wiresharkPickDir: 'wireshark:pick-dir',

  sessionList: 'session:list',
  sessionGet: 'session:get',
  sessionExport: 'session:export',
  /** v2.2：删除单个历史会话（不可撤销） */
  sessionDelete: 'session:delete',
  /** v2.12：从某消息节点起截断分支（消息删除 / 重新生成的底层；根节点不可删） */
  sessionDeleteNode: 'session:delete-node',
  /** v2.2：重命名会话标题 */
  sessionRename: 'session:rename',
  /** v2.2：置顶 / 取消置顶会话 */
  sessionPin: 'session:pin',
  /** v2.2：在资源管理器打开该会话的数据文件 */
  sessionOpenInExplorer: 'session:open-in-explorer',
  /** v2.2：打开会话数据目录 */
  sessionOpenDir: 'session:open-dir',
  /** v2.7：读某会话的任务清单（切入历史会话时恢复进度） */
  todoGet: 'todo:get',
  /** v2.8：列出可续跑的会话（上次任务未收尾就被关掉/崩溃） */
  sessionResumable: 'session:resumable',
  /** F8：把消息节点标记 / 取消标记为书签（阶段完成点） */
  sessionBookmark: 'session:bookmark',
  /** F8：同一起点两条分支的调用序列对比（export=true 时另存 Markdown 报告） */
  sessionCompare: 'session:compare',

  /** F6：跨设备的配置变更时间线（只读；纯消费 ChangeStore） */
  changesList: 'changes:list',
  /** F6：删除单条变更记录（审计流水清理，不影响设备状态与会话） */
  changesRemove: 'changes:remove',
  /** F6：清空全部变更记录 */
  changesClear: 'changes:clear',
  /** v2.20：把变更记录导出为「设备配置命令报告」markdown（与 export_change_report 工具同口径） */
  changesExport: 'changes:export',

  topologyClear: 'topology:clear',
  topologyGet: 'topology:get',
  topologyRefresh: 'topology:refresh',
  topologySaveManual: 'topology:save-manual',
  topologyRemove: 'topology:remove',
  topologyImportFile: 'topology:import-file',
  topologyFindFiles: 'topology:find-files',
  topologyImportPath: 'topology:import-path',

  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  /** v2.3：对某一档模型档案做一次真实连通性测试（模型管理页的「测试」按钮） */
  settingsTestProfile: 'settings:test-profile',

  /** v1.10：一句话实验目标存档（内置丰富预设，只读给渲染层随机展示） */
  goalsGet: 'goals:get',

  skillList: 'skills:list',
  skillGet: 'skills:get',
  skillSave: 'skills:save',
  skillRemove: 'skills:remove',
  skillSetEnabled: 'skills:set-enabled',
  skillImportFiles: 'skills:import-files',
  skillImportDirectory: 'skills:import-directory',
  skillImportPath: 'skills:import-path',
  /** F13：从会话的「失败 → 修正」轨迹自动沉淀一份排障技能（默认不启用） */
  skillDistill: 'skills:distill',

  secretHas: 'secret:has',
  secretSet: 'secret:set',

  enspLocate: 'ensp:locate',
  enspPickExe: 'ensp:pick-exe',
  diagRun: 'diag:run',

  /** v1.6：应用信息（版本/运行环境/数据目录），设置 → 通用 → 关于 */
  appInfo: 'app:info',
  /** v1.6：数据占用统计 */
  appStorage: 'app:storage',
  /** v1.6：在系统文件管理器里打开数据/导出目录 */
  appOpenPath: 'app:open-path',
  /** v1.6：清理自管数据（会话 / 附件 / 导出），主进程弹原生确认框 */
  appClearData: 'app:clear-data',
  /** 弹出系统原生文件夹选择对话框 */
  appPickDir: 'app:pick-dir',
  /** 切换数据主目录（支持数据迁移与重启引导） */
  appChangeUserDataDir: 'app:change-user-data-dir',
  /** 恢复默认数据主目录 */
  appResetUserDataDir: 'app:reset-user-data-dir',
  /** 重启应用 */
  appRelaunch: 'app:relaunch',
  /** v2.3：在系统默认浏览器打开外部链接（服务商密钥申请页） */
  appOpenExternal: 'app:open-external',

  windowMinimize: 'window:minimize',
  windowMaximize: 'window:maximize',
  windowClose: 'window:close',
  windowIsMaximized: 'window:is-maximized',
  windowSetAlwaysOnTop: 'window:set-always-on-top',
  windowIsAlwaysOnTop: 'window:is-always-on-top',

  /** v2.1：剪贴板文字读写（会话的复制/粘贴按钮）——
   *  走主进程 Electron clipboard，免受渲染层权限与文档焦点限制 */
  clipboardReadText: 'clipboard:read-text',
  clipboardWriteText: 'clipboard:write-text'
} as const

export const EVENT = {
  scanProgress: 'device:scan-progress',
  deviceStateChanged: 'device:state-changed',
  terminalData: 'terminal:data',
  terminalClosed: 'terminal:closed',
  /** 终端被要求清屏（主进程已清回放缓冲，渲染层负责清 xterm 画面） */
  terminalClear: 'terminal:cleared',
  agentEvent: 'agent:event',
  topologyUpdated: 'topology:updated',
  sessionListUpdated: 'session:list-updated',
  skillsUpdated: 'skills:updated',
  mcpStatus: 'mcp:status',
  /** v1.5：外部 MCP 服务器状态变更 */
  mcpServersUpdated: 'mcp:servers-updated',
  /** v1.9：Wireshark 组件安装进度 */
  wiresharkInstallProgress: 'wireshark:install-progress',
  /** T4.4：数据目录迁移进度（大目录迁移不再冻住界面） */
  storageMigrateProgress: 'app:storage-migrate-progress',
  /** D9：设置已变更（主进程任何来源 —— 渲染层写回 / Wireshark 挂载 / 数据目录切换 —— 都广播），
   *  界面据此刷新，避免「别处改的设置在界面上不可见、被下一次写回静默抹掉」 */
  settingsUpdated: 'settings:updated',
  windowStateChanged: 'window:state-changed'
} as const

// 事件载荷类型统一由 @shared/api 定义，这里只放通道名，避免两处漂移。

