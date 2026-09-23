/**
 * 测试用入口：把主进程里「纯逻辑、不依赖 Electron」的模块集中导出。
 *
 * 为什么需要这一层：通信层是 TS，且用了路径别名与无扩展名相对导入，
 * Node 无法直接跑。用 esbuild 打成一个 ESM 包后，node:test 就能直接消费。
 * 这样通信层的测试完全不依赖 Electron 与真实 eNSP 设备，可进 CI。
 */

export { TelnetClient } from '../../src/main/core/telnet/TelnetClient'
export type { ConnectResult, TelnetClientOptions } from '../../src/main/core/telnet/TelnetClient'

// —— v2.0：SSH 传输层 ——

export { connectTcp } from '../../src/main/core/transport/ByteChannel'
export type { ByteChannel } from '../../src/main/core/transport/ByteChannel'
export { connectSsh } from '../../src/main/core/transport/SshChannel'
export type { SshConnectConfig } from '../../src/main/core/transport/SshChannel'
export {
  parseDeviceId,
  deviceIdForSsh,
  deviceIdForTelnet,
  isValidSshHost
} from '../../src/shared/transport'

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
  trimIncompleteTail,
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
export { saveTopoFile } from '../../src/main/tools/topology'
export { parseVersion, DeviceSession } from '../../src/main/core/session/DeviceSession'
export {
  SessionManager,
  DEVICE_LOCK_TTL_MS,
  type DeviceLockInfo
} from '../../src/main/core/session/SessionManager'
export {
  acquireDeviceLock,
  releaseDeviceLock,
  withDeviceLock
} from '../../src/main/tools/registry'
// D7：两份工具集合的具名出口（toolsets 刻意零 electron 依赖，可进 harness）
export { builtinTools, agentTools } from '../../src/main/tools/toolsets'
export { classifyDanger, isReadOnlyCommand, DANGEROUS_COMMANDS } from '../../src/shared/risk'
export {
  planDangerGate,
  GATE_DENIED_REASON,
  GATE_DENIED_SUMMARY,
  GATE_SKIPPED_NOTE
} from '../../src/shared/gate-policy'
export {
  parsePort,
  parsePortOr,
  describePortValue,
  DEFAULT_SCAN_START,
  DEFAULT_SCAN_END,
  DEFAULT_SSH_PORT
} from '../../src/shared/ports'

// —— v0.2：配置变更 ——

export { SnapshotStore } from '../../src/main/core/store/snapshots'
export { ChangeStore } from '../../src/main/core/store/changes'
// T2.5：统一原子写（唯一临时名 / rename / 退避重试 / 失败清理）
export {
  atomicWriteFileSync,
  atomicWriteJsonSync,
  tempNameFor
} from '../../src/main/core/fs/atomic'
export {
  genRollbackCommands,
  parseConfigStanzas,
  invertCommand,
  STANZA_HEADER_RE,
  UNDOABLE_HEADER_RE
} from '../../src/main/core/rollback'
export {
  applyConfig,
  verifyExpectation,
  restoreSnapshot,
  saveConfiguration,
  checkExpectation
} from '../../src/main/tools/config'
// D2（2026-09-23）：[Y/N] 应答通道（含 NO_PENDING_PROMPT 不变量）
export { answerDevicePrompt, runShowCommand, saveConfigSnapshot } from '../../src/main/tools/command'

// —— v0.3：pi-ai 翻译层 + 拓扑 ——

export { consumeEvent, newTurn } from '../../src/main/agent/llm/translate'
export { parseLldpNeighbors, deriveTopology } from '../../src/main/core/topology/fromNeighbors'
export { guessRole, mergeTopology, mergeLayers, emptyTopology, linkKey } from '../../src/main/core/topology/model'
export { TopologyStore } from '../../src/main/core/topology/store'
export { decodeTopo, parseTopoXml, readTopoFile, parseDeviceInterfaces, resolveInterfaceName } from '../../src/main/core/topology/fromProjectFile'
export { topologyToXml, writeTopoFile, stableGuid } from '../../src/main/core/topology/toProjectFile'
export { findTopologyFiles, defaultSearchRoots } from '../../src/main/core/topology/findFiles'
export { TOOLS } from '../../src/main/tools/index'
export { toLLMTools, toMcpTools } from '../../src/main/tools/registry'

// —— v1.2：ensp-mcp 借鉴（参考配置学习 + 结构化验证） ——

export {
  splitConfigSegments,
  classifySegment,
  analyzeReferenceConfig,
  deviceFromLine
} from '../../src/main/core/reference/analyze'
export {
  parsePingOutput,
  parseInterfaceBrief,
  parseDhcpPools,
  hasDhcpConfig,
  parseRoutingTable,
  parseArpTable,
  parseNatOutbound,
  parseNatServer,
  parseEthTrunk,
  ipToInt,
  parseNetwork,
  routeMatches,
  networkPrefix
} from '../../src/main/core/verify/parsers'

// —— v1.8：任务级封装 + IP 规划 + 备课文档（ensp-mcp / ensp-skills 学习） ——

export {
  dottedMask,
  interlinkPair,
  loopbackIp,
  hostInNetwork
} from '../../src/main/core/tasks/ipPlan'
export {
  planOspf,
  planVlan,
  planDhcp,
  planPcConnectivity,
  planStaticRoute,
  planRip,
  planAclNat,
  planEthTrunk
} from '../../src/main/core/tasks/plans'
export { buildLabGuide } from '../../src/main/core/lab/guide'
export {
  LAB_TEMPLATES,
  buildTemplateTaskSteps,
  findLabTemplate
} from '../../src/main/core/lab/templates'
export { executeTask, batchConfigure } from '../../src/main/tools/tasks'
export { registerDevice, autoDiscoverDevices, unregisterDevice } from '../../src/main/tools/register'

// —— v0.4：会话树 + 报告 + 消息队列 + MCP ——

export { SessionTreeStore } from '../../src/main/core/session-tree/store'
export { buildMarkdown, buildJson } from '../../src/main/core/session-tree/report'
export { historyToMessages, appendQueuedUserMessages, extractPlan, buildAgentSystemPrompt } from '../../src/main/agent/react.runtime'
export { ReactRuntime } from '../../src/main/agent/react.runtime'
export type { ReactRuntimeOptions } from '../../src/main/agent/react.runtime'
export { createMcpServer } from '../../src/main/mcp/server'
export { computeAutoLayout } from '../../src/renderer/features/topology/autoLayout'
// T5.5：三栏布局 / 自适应档位 / 工具条折叠的纯函数（测试直接验证生产实现，不抄抄件）
export {
  CENTER_MIN_WIDTH,
  LEFT_MIN_WIDTH,
  LEFT_MAX_WIDTH,
  RIGHT_MIN_WIDTH,
  RIGHT_MAX_WIDTH,
  SPLITTERS_TOTAL_GAP,
  getAdaptiveTier,
  computeClampedLeft,
  computeClampedRight,
  computeWindowResizeShrink,
  shouldCollapseButton
} from '../../src/renderer/features/layout/panelSizing'
export { splitPortLabel, shortIf } from '../../src/renderer/features/topology/portLabel'

// —— v1.3：技能模块 ——

export { SkillStore } from '../../src/main/skills/store'
export { walkMarkdown } from '../../src/main/skills/store'
export {
  parseSkillContent,
  deriveSkillMeta,
  fileNameToSkillName,
  slugify,
  skillIdBase,
  uniqueSkillId,
  isValidSkillId,
  stripFrontmatter,
  buildSkillMarkdown,
  firstHeading,
  firstLine
} from '../../src/main/skills/parse'
export { buildSkillPrompt, SKILL_PROMPT_MAX_CHARS } from '../../src/main/skills/prompt'
export { DEFAULT_SETTINGS, DEFAULT_PROFILES } from '../../src/shared/types'
export { BUILTIN_SKILLS } from '../../src/main/skills/builtin'

// —— v1.4：eNSP 定位与环境体检 ——

export {
  parseExeFromRegOutput,
  locateEnsp,
  resolveEnspExe,
  ENSP_COMMON_PATHS
} from '../../src/main/core/ensp/launcher'
export {
  normalizeBaseUrl,
  buildProbePlan,
  extractErrorMessage,
  classifyHttpStatus,
  classifyNetworkError
} from '../../src/main/core/diagnose/probe'
export { runDiagnostics } from '../../src/main/core/diagnose'

// —— v1.5：模型档案 / 附件 / 提示词增强 / 外部 MCP ——

export {
  PROFILE_ID_RE,
  MCP_SERVER_ID_RE,
  LEGACY_PROFILE_ID,
  newProfileId,
  newMcpServerId,
  isProfileId,
  isMcpServerId,
  labelFor,
  sanitizeProfile,
  sanitizeProfiles,
  normalizeAgentSettings,
  activeProfile,
  activeProfileOf,
  withActiveProfile,
  removeProfile
} from '../../src/shared/profiles'

export {
  TEXT_EXTS,
  IMAGE_EXTS,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_INLINE_CHARS,
  extOf,
  classifyAttachment,
  kindLabel,
  formatBytes,
  truncatePreview,
  sanitizeFileName,
  archivedFileName,
  attachmentNoteLine,
  buildAttachmentBlock,
  composeUserMessage
} from '../../src/shared/attachments'

export { AttachmentStore } from '../../src/main/core/attachments/store'
export { readLineWindow } from '../../src/main/core/attachments/lineReader'
export { JsonStore } from '../../src/main/core/store/store'

export { BASE_SYSTEM_PROMPT, CUSTOM_PROMPT_HEADING } from '../../src/main/agent/llm/prompt'
export { ENHANCE_SYSTEM_PROMPT, buildEnhanceUserPrompt, cleanEnhanced } from '../../src/main/agent/llm/enhance'

export {
  MCP_TOOL_PREFIX,
  sanitizeNameSegment,
  namespaceToolName,
  dedupeToolName,
  isExternalToolName,
  splitExternalToolName,
  signatureOf,
  McpClientManager
} from '../../src/main/core/mcp/client'
export { externalToolSpecs, fitExternalTools } from '../../src/main/core/mcp/tools'
export { readAttachment } from '../../src/main/tools/attachments'

// —— v1.6：通用设置（数据占用与清理）+ 权限口径 + 手动配置（粘贴 JSON） ——

export {
  MCP_SERVER_SEGMENT_MAX,
  MCP_TOOL_SEGMENT_MAX
} from '../../src/shared/naming'
export {
  MCP_IMPORT_EXAMPLE,
  relaxJson,
  parseMcpServersJson
} from '../../src/shared/mcp-import'
export {
  SCOPE_DIR,
  scopeDir,
  dirUsage,
  measureStorage,
  assertInside,
  assertInsideOrEqual,
  isDriveRoot,
  validateUserDataTarget,
  sanitizeStorageSettings,
  checkClearTarget,
  MAX_DIR_PATH_LEN,
  emptyDir
} from '../../src/main/core/storage/usage'
// 迁移实现是纯 Node 模块（不含 electron），可以直接进 harness
export { migrateDirectory, EXCLUDED_NAMES } from '../../src/main/core/storage/migrate'
export { DEFAULT_STORAGE } from '../../src/shared/types'

// —— v1.7：运行时韧性（失败分类 + 重试退避 + 上下文压缩） ——

export {
  DEFAULT_RETRY,
  DEFAULT_COMPACTION,
  MAX_BACKOFF_MS,
  RETRY_BOUNDS,
  COMPACTION_BOUNDS,
  sanitizeRetry,
  sanitizeCompaction,
  backoffDelay,
  planRetry,
  messageChars,
  estimateChars,
  truncateToolResult,
  planCompaction,
  describeCompaction
} from '../../src/shared/runtime-policy'
export {
  synthError,
  isRetryableFailure,
  isOverflowFailure,
  isLengthStarved,
  explainFailure
} from '../../src/main/agent/llm/failure'

// —— v1.9：Wireshark 抓包分析接入 ——

export {
  probeWireshark,
  checkWiresharkMcp,
  buildWiresharkMcpConfig,
  wiresharkMcpPaths,
  WS_MCP_SERVER_ID,
  WS_MCP_SERVER_NAME,
  TOOL_ENV_VAR,
  TOOL_REQUIREMENT
} from '../../src/main/core/wireshark/provision'

export { DEFAULT_SHORTCUTS,
  DEFAULT_SHORTCUTS_MAP,
  getEffectiveShortcuts,
  formatKeys,
  isKeyEqual,
  matchesShortcut,
  eventToKeys
} from '../../src/renderer/features/shortcuts/shortcutsData'

// —— v1.10：一句话实验目标存档（内置预设库 + 随机抽三条；AI 续写已取消） ——

export { GoalArchiveStore } from '../../src/main/goals/store'
export {
  QUICK_PROMPT_COUNT,
  MAX_GOALS,
  MAX_GOAL_LENGTH,
  PRESET_GOALS,
  sanitizeGoals,
  pickRandomGoals
} from '../../src/shared/goals'
