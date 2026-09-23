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

  topologyGet: 'topology:get',
  topologyRefresh: 'topology:refresh',
  topologySaveManual: 'topology:save-manual',
  topologyRemove: 'topology:remove',
  topologyImportFile: 'topology:import-file',
  topologyFindFiles: 'topology:find-files',
  topologyImportPath: 'topology:import-path',

  settingsGet: 'settings:get',
  settingsSet: 'settings:set',

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

  windowMinimize: 'window:minimize',
  windowMaximize: 'window:maximize',
  windowClose: 'window:close',
  windowIsMaximized: 'window:is-maximized',
  windowSetAlwaysOnTop: 'window:set-always-on-top',
  windowIsAlwaysOnTop: 'window:is-always-on-top'
} as const

export const EVENT = {
  scanProgress: 'device:scan-progress',
  deviceStateChanged: 'device:state-changed',
  terminalData: 'terminal:data',
  terminalClosed: 'terminal:closed',
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

