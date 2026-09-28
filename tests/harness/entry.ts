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
  createIacStripper,
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
  encode,
  EncodeError,
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
// 终端字节 → 文本的流式解码器（渲染层终端用它，见 shared/terminal-decode.ts 的说明）
export { createStreamDecoder, type StreamDecoder } from '../../src/shared/terminal-decode'

export { parseInterfaces, diffLines } from '../../src/main/tools/command'
export { saveTopoFile, importTopologyFile } from '../../src/main/tools/topology'
export { parseVersion, DeviceSession } from '../../src/main/core/session/DeviceSession'
export {
  TerminalBuffer,
  DEFAULT_TERMINAL_BUFFER_BYTES
} from '../../src/main/core/session/TerminalBuffer'
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
export { classifyDanger, isReadOnlyCommand, isViewNavigationCommand, DANGEROUS_COMMANDS } from '../../src/shared/risk'
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
  checkExpectation,
  // v2.24：单一视图切换命令的「工具选错了」护栏
  loneViewNavCommand
} from '../../src/main/tools/config'
// D2（2026-09-23）：[Y/N] 应答通道（含 NO_PENDING_PROMPT 不变量）
export { answerDevicePrompt, changeView, runShowCommand, saveConfigSnapshot } from '../../src/main/tools/command'
// v2.24：视图导航（ensureSystemView 同时被 apply_config 与 change_view 复用）
export {
  ensureSystemView,
  ensureUserView,
  enterInterfaceView,
  normalizeViewTarget,
  isSafeInterfaceName,
  INTERFACE_NAME_RE,
  MAX_INTERFACE_NAME_LEN
} from '../../src/main/core/session/viewNav'

// —— v0.3：pi-ai 翻译层 + 拓扑 ——

export { consumeEvent, newTurn } from '../../src/main/agent/llm/translate'
export { parseLldpNeighbors, deriveTopology } from '../../src/main/core/topology/fromNeighbors'
export { guessRole, mergeTopology, mergeLayers, emptyTopology, linkKey } from '../../src/main/core/topology/model'
export { TopologyStore } from '../../src/main/core/topology/store'
export { decodeTopo, parseTopoXml, readTopoFile, parseDeviceInterfaces, resolveInterfaceName, MAX_TOPO_FILE_BYTES } from '../../src/main/core/topology/fromProjectFile'
export { topologyToXml, writeTopoFile, stableGuid } from '../../src/main/core/topology/toProjectFile'
export { findTopologyFiles, defaultSearchRoots } from '../../src/main/core/topology/findFiles'
export { TOOLS } from '../../src/main/tools/index'
export { toLLMTools, toMcpTools, normalizeToolSchema, Type } from '../../src/main/tools/registry'

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
  parseOspfPeers,
  ipToInt,
  isIpv4Address,
  isTolerablePingFailure,
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
export { rollbackTask } from '../../src/main/tools/rollback-task'
export { registerDevice, autoDiscoverDevices, unregisterDevice } from '../../src/main/tools/register'

// —— v0.4：会话树 + 报告 + 消息队列 + MCP ——

export { SessionTreeStore } from '../../src/main/core/session-tree/store'
export { buildMarkdown, buildJson } from '../../src/main/core/session-tree/report'
// v2.12（F8）：分支对比（工具调用序列逐项 diff）+ 书签
export {
  stableArgsKey,
  toolStepsOf,
  compareBranches,
  renderComparisonMarkdown,
  branchLabelOf
} from '../../src/main/core/session-tree/compare'
export { writeCompareReport } from '../../src/main/tools/sessions'
// v2.20：设备配置命令报告（纯函数正文 + 与 IPC 共用的写盘 helper）
export { buildChangeReport, parseAddressPools, parseInterfaceIps, prefixOfMask } from '../../src/main/core/store/change-report'
export { collectChangeReport, deviceLabelsOf } from '../../src/main/tools/changes'
// v2.12（F13）：经验沉淀 —— 从会话轨迹抽「失败 → 修正」片段
export {
  findTroubleshootEpisodes,
  fixedEpisodes,
  buildTroubleshootTranscript,
  troubleshootDraftTitle,
  troubleshootDraftDescription,
  cleanDistilled
} from '../../src/main/core/session-tree/troubleshoot'
// v2.2：会话树节点 → 界面消息（历史载入时「思考」行能否还原，靠这条映射）
export { nodesToMessages, formatMessageTime } from '../../src/renderer/stores/storeUtil'
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
  firstLine,
  // v2.12（F12）：绑定目录（scope）的解析 / 序列化
  parseScopeValue,
  formatScopeValue
} from '../../src/main/skills/parse'
export {
  buildSkillPrompt,
  SKILL_PROMPT_MAX_CHARS,
  // v2.12（F12）：按上下文目录过滤技能
  normalizeDir,
  scopeMatches,
  skillsForContext,
  contextDirsOf
} from '../../src/main/skills/prompt'
export { DEFAULT_SETTINGS, DEFAULT_PROFILES } from '../../src/shared/types'
export { BUILTIN_SKILLS } from '../../src/main/skills/builtin'

// —— v1.4：eNSP 定位与环境体检 ——

export {
  parseExeFromRegOutput,
  detectEnspFromRegistry,
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
export { runDiagnostics, probeModelEndpoint, probePort } from '../../src/main/core/diagnose'

// —— v2.3：逐模型思考能力表 ——

export {
  modelCapability,
  capabilityOf,
  capabilityNote,
  supportsEffort,
  normalizeThinkingFields,
  availableEfforts,
  thinkingLevelMap
} from '../../src/shared/model-thinking'

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
  upgradeAgentDefaults,
  activeProfile,
  activeProfileOf,
  withActiveProfile,
  removeProfile,
  enabledProfiles,
  withProfileEnabled,
  newProfileDraft
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
  composeUserMessage,
  // v2.22（F17）：多模态用户消息（有图才返回 parts 数组，无图仍是字符串）
  composeUserContent,
  READABLE_DOC_EXTS
} from '../../src/shared/attachments'

// —— v2.22（F17）：图片读取（嗅探 / 尺寸 / 闸门 / 读取 + read_image 工具） ——

export {
  MODEL_IMAGE_MIMES,
  IMAGE_MIME_BY_EXT,
  UNSUPPORTED_IMAGE_EXTS,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
  modelImageGate,
  imageAttachmentsOf,
  imageMimeOfExt,
  sniffImageMime,
  parseImageSize,
  checkImageLimits,
  unsupportedFormatHint,
  planUserImages,
  blockedImagesForSend,
  type ImageGateCode,
  type ImageGateResult,
  type ImageSendPlan
} from '../../src/shared/image-attach'
export { encodeImageFile, readImageForModel, readImagesForModel } from '../../src/main/core/attachments/image'
export { readImage } from '../../src/main/tools/image'
// 工具结果里「随本结果附一张图」的约定载荷解析（运行时不认识具体工具名，只认这个字段）
export { toolImageRef } from '../../src/main/agent/runtime.iface'

export { AttachmentStore } from '../../src/main/core/attachments/store'
// v2.14：溢出归档的子目录名（read_attachment 与清理都靠附件根，这里只补常量）
export { SPILL_DIR } from '../../src/main/core/attachments/store'
export {
  readLineWindow,
  windowLineArray,
  isOffsetOutOfRange,
  READ_MAX_LINE_CHARS,
  READ_MAX_OUTPUT_BYTES,
  READ_LIMIT_DEFAULT,
  READ_LIMIT_MAX
} from '../../src/main/core/attachments/lineReader'
// v2.1：PDF 文本抽取（附件里的 .pdf 也能按行读了）
export {
  extractPdfText,
  parseCMap,
  runContentStream,
  tokenize,
  normalizeText
} from '../../src/main/core/attachments/pdf'
// v2.1：文档抽取（OOXML / ODF / 老式 doc / RTF）
export { readZip, type ZipEntry, type ZipReadResult } from '../../src/main/core/attachments/documents/zip'
export {
  scanXml,
  decodeXmlEntities,
  xmlToText
} from '../../src/main/core/attachments/documents/xmlText'
export {
  sniffZipKind,
  extractDocx,
  docxBodyToText,
  extractXlsx,
  parseSharedStrings,
  sheetToText,
  extractPptx,
  slideToText,
  extractOdf,
  odfContentToText
} from '../../src/main/core/attachments/documents/ooxml'
export {
  readCfb,
  classifyCfb,
  extractLegacyDoc,
  parseClx,
  parsePlcPcd,
  piecesToText,
  filterWordControls
} from '../../src/main/core/attachments/documents/legacyDoc'
export { extractRtf, rtfToText } from '../../src/main/core/attachments/documents/rtf'
export {
  sniffDocumentKind,
  extractDocumentText,
  isDocumentBuffer,
  documentToLines,
  DOC_KIND_LABEL
} from '../../src/main/core/attachments/documents/index'
export { decodeCp1252, cp1252Char } from '../../src/main/core/charset/cp1252'
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
// v2.13：参考配置文本读取（按内容判编码，GBK 不再读出乱码）
export { readReferenceTextFile, analyzeReferenceConfigs } from '../../src/main/tools/reference'

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
  describeCompaction,
  upgradeCompactionDefaults,
  roundsLeftWarnAt,
  roundsLeftNotice,
  REPRUNE_RATIO,
  REPRUNE_MIN_CHARS,
  REPRUNE_MIN_SAVING,
  repruneBudgetOf,
  planToolResultReprune
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
// v2.12（F10）：任务生命周期抓包（工具名识别 + 起停编排）
export {
  pickCaptureTools,
  startCapture,
  stopCapture,
  attachCapture
} from '../../src/main/core/wireshark/capture'

export { DEFAULT_SHORTCUTS,
  DEFAULT_SHORTCUTS_MAP,
  INPUT_SCOPED_SHORTCUT_IDS,
  getEffectiveShortcuts,
  terminalPassthroughShortcuts,
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

// —— v2.5：跨设备只读并发（调度计划 + 分组有界并发） ——

export {
  DEFAULT_CONCURRENCY,
  CONCURRENCY_BOUNDS,
  UNKNOWN_DEVICE_KEY,
  LOCAL_DEVICE_KEY,
  sanitizeConcurrency,
  maxParallelOf,
  deviceKeyOf,
  scheduleKeyOf,
  isParallelSafe,
  planToolBatches,
  runGroupedBounded
} from '../../src/shared/concurrency'

// —— v2.14：重复工具调用防护 ——

export {
  DEFAULT_REPEAT_GUARD,
  REPEAT_GUARD_THRESHOLDS,
  REPEAT_ARGS_PREVIEW_CHARS,
  EMPTY_REPEAT_CHAIN,
  sanitizeRepeatGuard,
  repeatGuardEnabledOf,
  canonicalizeArgs,
  observeToolCall
} from '../../src/shared/repeat-guard'

// —— v2.14：工具结果溢出落盘（行可寻址归档 + 定位符） ——

export {
  SPILL_HEADER_TITLE,
  SPILL_MAX_LINE_CHARS,
  renderSpillDump,
  spillLocatorNotice,
  repruneLocatorNotice,
  extractSpillPath
} from '../../src/shared/spill'

// —— v2.6：真实 token 计量 + 摘要式压缩（L3） ——

export {
  DEFAULT_CHARS_PER_TOKEN,
  CHARS_PER_TOKEN_BOUNDS,
  SUMMARY_BOUNDS,
  DEFAULT_SUMMARY_MAX_INPUT_CHARS,
  SUMMARY_MESSAGE_PREFIX,
  IMAGE_PART_CHARS,
  promptTokensOf,
  charsPerToken,
  estimatePromptTokens,
  measurePressure,
  perMessageBudget,
  renderSummaryBody,
  planSummaryCompaction,
  applySummary,
  describeSummaryCompaction,
  describePressure
} from '../../src/shared/runtime-policy'
export { SUMMARY_SYSTEM_PROMPT, buildSummaryUserMessage } from '../../src/main/agent/llm/prompt'

// —— v2.7：轮内交互（结构化提问 / 任务清单 / 计划模式） ——

export {
  MAX_QUESTION_OPTIONS,
  MAX_QUESTIONS_PER_REQUEST,
  MAX_TODOS,
  MAX_TODO_CONTENT,
  PLAN_APPROVE,
  PLAN_REVISE,
  PLAN_STOP,
  sanitizeQuestions,
  sanitizeAnswers,
  unansweredQuestions,
  sanitizeTodos,
  todoProgress,
  formatTodos,
  describeTodos,
  buildTodoPromptBlock
} from '../../src/shared/interaction'
export {
  PLAN_MODE_BLOCK_CODE,
  PLAN_REVIEW_QUESTION_ID,
  planModeToolDecision,
  buildPlanReviewOptions
} from '../../src/shared/plan-mode'
export { TodoStore } from '../../src/main/core/todo/store'
export { PLAN_MODE_PROMPT_BLOCK } from '../../src/main/agent/llm/prompt'

// —— v2.8：会话标题（AI 起名） + 断点续跑 ——

export {
  TITLE_MAX_CHARS,
  TITLE_TARGET_CHARS,
  TITLE_FALLBACK_CHARS,
  TITLE_MAX_TOKENS,
  DEFAULT_TITLE_TIMEOUT_MS,
  TITLE_TIMEOUT_BOUNDS,
  TITLE_BOUNDS,
  DEFAULT_TITLE_SETTINGS,
  cleanTitleText,
  truncateCodePoints,
  normalizeTitle,
  fallbackTitle,
  isUsefulTitle,
  titleSystemPrompt,
  buildTitleUserMessage,
  sanitizeTitleSettings,
  canGenerateTitle
} from '../../src/shared/session-title'

// —— v2.9：展示组件（消息切段 / 长回显折叠 / 结构化结果卡） ——

export {
  groupMessages,
  segmentKey,
  hasRenderableContent,
  dropEmptyMessages,
  hoistTrailingThinking,
  planRawCollapse,
  RAW_COLLAPSE_LINES,
  resolveTurnBoundary,
  splitTurns
} from '../../src/renderer/features/agent/messageSegments'
export {
  DIFF_PREVIEW_LINES,
  buildStructuredView,
  describeDiff,
  lineTotalOf
} from '../../src/renderer/features/agent/structuredResult'
export { smallToolData, CARD_META_MAX_CHARS, cardMetaOf } from '../../src/main/agent/runtime.iface'
// H（v2.14）：两个已实现卡片投影的工具所做的截断上限（用例据此断言边界）
export { DIFF_CARD_LIMIT, diffWithSnapshot } from '../../src/main/tools/command'
export { CHECK_CARD_LIMIT } from '../../src/main/tools/check'

// —— v2.10：本轮用量归集 ——

export {
  EMPTY_TURN_USAGE,
  accumulateUsage,
  formatTokens,
  describeTurnUsage,
  shouldShowUsage
} from '../../src/shared/turn-usage'

// —— v2.11：工具调用归类汇总 ——

export {
  categoryOf,
  isRegisteredTool,
  summarizeTools,
  describeCategory,
  describeToolSummary
} from '../../src/shared/tool-summary'

// —— v2.12：命令知识库（F1）+ 实验规划器（F4）+ 消息删除/重新生成的纯函数 ——

export {
  VRP_TOPICS,
  listTopics,
  lookupVrpTopic,
  type VrpTopicEntry,
  type VrpCommandFact,
  type LookupOutcome,
  type VrpMatchKind
} from '../../src/main/core/knowledge/vrp-commands'
// v2.27：报错诊断表 + 下发前静态预检（apply_config / run_show_command 的失败引导来源）
export {
  VRP_ERROR_GUIDE,
  listVrpErrorCodes,
  explainVrpError,
  preflightCommands,
  type VrpErrorGuide,
  type PreflightFinding,
  type PreflightLevel
} from '../../src/main/core/knowledge/vrp-errors'
export {
  inferKind,
  deviceNumber,
  parseLinkPorts,
  routeFirstHop,
  buildExperimentPlan,
  type TaskKind,
  type ExperimentPlan,
  type NumberedDevice,
  type PlannedLink,
  type PlannedHostSegment
} from '../../src/main/core/tasks/experiment-plan'
export {
  stripAttachmentNote,
  matchTreeNodes,
  nearestUserAncestor,
  mergeTouchedSettings
} from '../../src/renderer/stores/storeUtil'
// B5（N66）：Esc 归属登记表（纯计数器，App 据此让行）
export { claimEscLayer, escLayerOpen, resetEscLayers } from '../../src/renderer/features/shortcuts/escLayers'

// —— v2.12（F7）：实验验收检查（目标清单 → 逐项 ✔/✘ + 证据，纯只读，不打分） ——

export {
  commandsForCheck,
  checkInputError,
  evaluateCheck,
  describeCheck,
  checkExperiment,
  type AcceptanceCheck,
  type CheckKind,
  type CheckOutcome,
  type CheckStatus
} from '../../src/main/tools/check'

// —— B6（N23）：凭据加解密里不依赖 electron 的部分 ——
// secrets.ts / sshSecrets.ts 顶层 import electron（safeStorage / app.getPath），
// 故把「拿适配器打包/解包 + 形状归一化」抽到 secretCodec，生产注入真实 safeStorage、
// 测试注入假适配器 —— 这条安全关键路径才有回归网。

export {
  packSecret,
  unpackSecret,
  normalizeKeyEntries,
  normalizeSshMeta,
  type KeyEntry,
  type SecretCrypto
} from '../../src/main/settings/secretCodec'
