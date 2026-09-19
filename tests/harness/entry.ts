/**
 * 测试用入口：把主进程里「纯逻辑、不依赖 Electron」的模块集中导出。
 *
 * 为什么需要这一层：通信层是 TS，且用了路径别名与无扩展名相对导入，
 * Node 无法直接跑。用 esbuild 打成一个 ESM 包后，node:test 就能直接消费。
 * 这样通信层的测试完全不依赖 Electron 与真实 eNSP 设备，可进 CI。
 */

export { TelnetClient } from '../../src/main/core/telnet/TelnetClient'
export type { ConnectResult, TelnetClientOptions } from '../../src/main/core/telnet/TelnetClient'

export { matchPromptTail, splitTrailingPrompt, extractView, viewLabel } from '../../src/main/core/telnet/prompt'
export {
  cleanResponse,
  stripIac,
  stripAnsi,
  applyBackspaces,
  normalizeNewlines,
  removeEchoLine,
  compressBlankLines,
  stripPagingMarkers
} from '../../src/main/core/telnet/cleaner'
export { detectError, hasWarning, hasCaretMarker } from '../../src/main/core/telnet/errors'
export {
  decode,
  detectEncoding,
  detectEncodingDetailed,
  tailSlice,
  probeEncodingSupport
} from '../../src/main/core/telnet/encoding'
export {
  DEFAULT_TELNET_OPTIONS,
  PAGING_TAIL_RE,
  CONFIRM_RE,
  AUTH_RE,
  ERROR_PATTERNS
} from '../../src/main/core/telnet/patterns'

export { parseInterfaces, diffLines } from '../../src/main/tools/command'
export { parseVersion, DeviceSession } from '../../src/main/core/session/DeviceSession'
export { classifyDanger, isReadOnlyCommand, DANGEROUS_COMMANDS } from '../../src/shared/risk'

// —— v0.2：配置变更 ——

export { SnapshotStore } from '../../src/main/core/store/snapshots'
export { ChangeStore } from '../../src/main/core/store/changes'
export {
  genRollbackCommands,
  parseConfigStanzas,
  invertCommand,
  STANZA_HEADER_RE
} from '../../src/main/core/rollback'
export {
  applyConfig,
  verifyExpectation,
  restoreSnapshot,
  saveConfiguration,
  checkExpectation
} from '../../src/main/tools/config'

// —— v0.3：pi-ai 翻译层 + 拓扑 ——

export { consumeEvent, newTurn } from '../../src/main/agent/llm/translate'
export { parseLldpNeighbors, deriveTopology } from '../../src/main/core/topology/fromNeighbors'
export { guessRole, mergeTopology, mergeLayers, emptyTopology } from '../../src/main/core/topology/model'
export { decodeTopo, parseTopoXml, readTopoFile } from '../../src/main/core/topology/fromProjectFile'
export { TOOLS } from '../../src/main/tools/index'
export { toLLMTools, toMcpTools } from '../../src/main/tools/registry'

// —— v0.4：会话树 + 报告 + 消息队列 + MCP ——

export { SessionTreeStore } from '../../src/main/core/session-tree/store'
export { buildMarkdown, buildJson } from '../../src/main/core/session-tree/report'
export { historyToMessages, appendQueuedUserMessages, extractPlan } from '../../src/main/agent/react.runtime'
export { createMcpServer } from '../../src/main/mcp/server'
