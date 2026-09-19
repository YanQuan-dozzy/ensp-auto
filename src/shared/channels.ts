/**
 * IPC 通道名常量。主进程与 preload 共用，避免字符串拼写漂移。
 */

export const INVOKE = {
  deviceScan: 'device:scan',
  deviceConnect: 'device:connect',
  deviceDisconnect: 'device:disconnect',
  deviceRename: 'device:rename',
  deviceList: 'device:list',

  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalBuffer: 'terminal:buffer',
  terminalClear: 'terminal:clear',

  agentRun: 'agent:run',
  agentAbort: 'agent:abort',
  agentGate: 'agent:gate',
  agentEnqueue: 'agent:enqueue',

  sessionList: 'session:list',
  sessionGet: 'session:get',
  sessionExport: 'session:export',

  topologyGet: 'topology:get',
  topologyRefresh: 'topology:refresh',
  topologySaveManual: 'topology:save-manual',
  topologyImportFile: 'topology:import-file',

  settingsGet: 'settings:get',
  settingsSet: 'settings:set',

  secretHas: 'secret:has',
  secretSet: 'secret:set'
} as const

export const EVENT = {
  scanProgress: 'device:scan-progress',
  deviceStateChanged: 'device:state-changed',
  terminalData: 'terminal:data',
  terminalClosed: 'terminal:closed',
  agentEvent: 'agent:event',
  topologyUpdated: 'topology:updated',
  sessionListUpdated: 'session:list-updated',
  mcpStatus: 'mcp:status'
} as const

// 事件载荷类型统一由 @shared/api 定义，这里只放通道名，避免两处漂移。

