import { INVOKE } from '@shared/channels'
import { MAX_ATTACHMENTS } from '@shared/attachments'
import { activeProfile } from '@shared/profiles'
import { ipcMain, shell } from 'electron'
import { enhancePrompt } from '../agent/llm/enhance'
import { getApiKey } from '../settings/secrets'
import { showOpenDialogSafe } from './dialogs'
import type { GateDecision } from '@shared/types'
import type { QuestionAnswers } from '@shared/interaction'
import { describeAttachments, toStr } from './helpers'
import type { Services } from '../services'
import type { BrowserWindow } from 'electron'

/**
 * 代理与会话：起任务 / 附件 / 增强 / 中止 / 入队 / 闸门，以及会话树列举与导出。
 *
 * 本模块只做「校验 → 调服务 → 回传」，业务逻辑在 services / core。
 */
export function registerAgentIpc(services: Services, getWindow: () => BrowserWindow | null): void {

  ipcMain.handle(INVOKE.agentRun, async (_e, args: { sessionId?: string; text?: string; rootId?: string | null; startNodeId?: string | null; attachments?: unknown; planMode?: unknown }) => {
    const sessionId = toStr(args?.sessionId)
    const text = toStr(args?.text).trim()
    if (!sessionId) throw new Error('缺少会话 ID')
    if (!text) throw new Error('指令不能为空')
    if (services.isAgentRunning(sessionId)) throw new Error('该会话已有任务在运行')
    const rootId = args?.rootId && /^s-[0-9a-f]{8}$/.test(args.rootId) ? args.rootId : null
    const startNodeId = args?.startNodeId && /^n-/.test(toStr(args.startNodeId)) ? toStr(args.startNodeId) : null
    // v1.5：附件以磁盘为准重建 —— 渲染层回传的 size/kind/preview 一律不采信
    const attachments = describeAttachments(services, args?.attachments)
    // v2.7：计划模式。只接受严格 true，渲染层传别的字符串一律当关（安全侧默认）
    const planMode = args?.planMode === true
    // v1.8：启动失败（会话树落盘 / 运行时装配等）不能静默吞掉 —— fire-and-forget 挂了
    // catch，把错误转成 error + done 事件回执，避免 unhandled rejection + 渲染层
    // agentRunning 卡死在 true。
    void services
      .startAgent(sessionId, text, { rootId, startNodeId, attachments, planMode })
      .catch((e: unknown) => services.emitAgentFailure(sessionId, e))
    return { started: true }
  })

  // v1.5：弹系统文件多选框导入附件（dialog 天然限定用户选中的文件）
  ipcMain.handle(INVOKE.agentPickAttachments, async (_e, args: { sessionId?: string }) => {
    const sessionId = toStr(args?.sessionId) || 'main'
    const win = getWindow()
    const opts = {
      title: '导入附件（配置/日志/截图等）',
      properties: ['openFile', 'multiSelections'] as const
    }
    const result = await showOpenDialogSafe(win, opts)
    if (result.canceled || result.filePaths.length === 0) return null
    return services.attachments.import(sessionId, result.filePaths)
  })

  // v1.5：按路径导入（拖拽/粘贴走这条）。只接受存在的文件绝对路径，
  // 复制动作与体积/数量校验都在 AttachmentStore 内完成。
  ipcMain.handle(INVOKE.agentImportAttachments, async (_e, args: { sessionId?: string; paths?: unknown }) => {
    const sessionId = toStr(args?.sessionId) || 'main'
    const paths = Array.isArray(args?.paths)
      ? args.paths.filter((p): p is string => typeof p === 'string' && p.length > 0).slice(0, MAX_ATTACHMENTS)
      : []
    if (paths.length === 0) return null
    return services.attachments.import(sessionId, paths)
  })

  // v1.5：一键增强提示词 —— 用当前活跃档案重写草稿（不改设置、不执行任何实验动作）
  ipcMain.handle(INVOKE.agentEnhancePrompt, async (_e, args: { draft?: string }) => {
    const draft = toStr(args?.draft)
    if (!draft.trim()) throw new Error('请先输入实验目标再点增强')
    if (draft.length > 8000) throw new Error('草稿过长（上限 8000 字），请精简后再增强')
    const settings = services.getSettings()
    const profile = activeProfile(settings.agent)
    const apiKey = getApiKey(profile.id)
    const text = await enhancePrompt(draft, {
      profile,
      apiKey: apiKey ?? ''
    })
    return { text }
  })

  ipcMain.handle(INVOKE.agentAbort, async (_e, args: { sessionId?: string }) => ({
    aborted: services.abortAgent(toStr(args?.sessionId))
  }))

  ipcMain.handle(INVOKE.agentEnqueue, async (_e, args: { sessionId?: string; text?: string }) => {
    const sessionId = toStr(args?.sessionId)
    const text = toStr(args?.text).trim()
    if (!sessionId || !text) return { queued: false }
    return { queued: services.enqueueInput(sessionId, text) }
  })

  ipcMain.handle(
    INVOKE.agentGate,
    async (_e, args: { sessionId?: string; gateId?: string; decision?: string }) => {
      const decision: GateDecision = args?.decision === 'approve' ? 'approve' : 'reject'
      return {
        resolved: services.resolveGate(toStr(args?.sessionId), toStr(args?.gateId), decision)
      }
    }
  )

  // v2.7：裁决一次结构化提问。
  // `answers === null` 是**合法输入**（用户关掉卡片 = 取消），不能当成「没传值」丢掉 ——
  // 丢了它就变成一个永不 resolve 的 Promise，任务会卡在「等待回答」直到用户点停止。
  ipcMain.handle(
    INVOKE.agentQuestion,
    async (_e, args: { sessionId?: string; questionId?: string; answers?: unknown }) => {
      const sessionId = toStr(args?.sessionId)
      const questionId = toStr(args?.questionId)
      if (!sessionId || !questionId) return { resolved: false }
      const answers =
        args?.answers === null || args?.answers === undefined
          ? null
          : (args.answers as QuestionAnswers)
      return { resolved: services.resolveQuestion(sessionId, questionId, answers) }
    }
  )

  // ————————————————— 会话树与报告 —————————————————

  ipcMain.handle(INVOKE.sessionList, async () => services.sessionTree.list())

  ipcMain.handle(INVOKE.sessionGet, async (_e, args: { rootId?: string }) => {
    const rootId = toStr(args?.rootId)
    if (!/^s-[0-9a-f]{8}$/.test(rootId)) throw new Error('非法会话 ID')
    return services.sessionTree.getTree(rootId)
  })

  ipcMain.handle(INVOKE.sessionExport, async (_e, args: { rootId?: string; format?: string }) => {
    const rootId = toStr(args?.rootId)
    if (!/^s-[0-9a-f]{8}$/.test(rootId)) throw new Error('非法会话 ID')
    const format = args?.format === 'json' ? 'json' : 'md'
    return services.exportSessionReport(rootId, format)
  })

  // ————————————————— v2.2：会话管理（历史列表右键菜单） —————————————————

  ipcMain.handle(INVOKE.sessionDelete, async (_e, args: { rootId?: string }) => {
    const rootId = toStr(args?.rootId)
    if (!/^s-[0-9a-f]{8}$/.test(rootId)) throw new Error('非法会话 ID')
    const removed = services.sessionTree.deleteSession(rootId)
    // v2.7：连带清掉该会话的任务清单，避免 todos.json 里留孤儿条目
    if (removed) services.todos.remove(rootId)
    return { removed }
  })

  // v2.12：从某消息节点起截断整条分支（消息删除 / 重新生成的底层）。
  // keepSelf=true 只删后代保留节点自身 —— 用于「重新生成第一条指令的回答」
  // （root 是会话本体不可删，只能清它下面的旧回答分支）。
  ipcMain.handle(
    INVOKE.sessionDeleteNode,
    async (_e, args: { rootId?: string; nodeId?: string; keepSelf?: boolean }) => {
      const rootId = toStr(args?.rootId)
      const nodeId = toStr(args?.nodeId)
      if (!/^s-[0-9a-f]{8}$/.test(rootId)) throw new Error('非法会话 ID')
      if (!/^n-/.test(nodeId)) throw new Error('非法节点 ID')
      return services.sessionTree.deleteFromNode(rootId, nodeId, {
        keepSelf: args?.keepSelf === true
      })
    }
  )

  ipcMain.handle(INVOKE.todoGet, async (_e, args: { rootId?: string }) => {
    const rootId = toStr(args?.rootId)
    if (!rootId) return []
    return services.todoList(rootId)
  })

  // ————————————————— F8：书签与分支对比 —————————————————

  // 书签（阶段完成点）：节点字段落盘，重开会话后仍在
  ipcMain.handle(
    INVOKE.sessionBookmark,
    async (_e, args: { rootId?: string; nodeId?: string; bookmarked?: boolean }) => {
      const rootId = toStr(args?.rootId)
      const nodeId = toStr(args?.nodeId)
      if (!/^s-[0-9a-f]{8}$/.test(rootId)) throw new Error('非法会话 ID')
      if (!/^n-/.test(nodeId)) throw new Error('非法节点 ID')
      const bookmarked = args?.bookmarked === true
      return { ok: services.sessionTree.setBookmark(rootId, nodeId, bookmarked), bookmarked }
    }
  )

  // 分支对比：预览（只算不落盘）/ 导出（写 Markdown 到 exports）
  ipcMain.handle(
    INVOKE.sessionCompare,
    async (
      _e,
      args: { rootId?: string; aNodeId?: string; bNodeId?: string; export?: boolean }
    ) => {
      const rootId = toStr(args?.rootId)
      const aNodeId = toStr(args?.aNodeId)
      const bNodeId = toStr(args?.bNodeId)
      if (!/^s-[0-9a-f]{8}$/.test(rootId)) throw new Error('非法会话 ID')
      if (!/^n-/.test(aNodeId) || !/^n-/.test(bNodeId)) throw new Error('非法节点 ID')
      if (aNodeId === bNodeId) throw new Error('两条分支不能是同一个节点')
      return services.compareSessionBranches(rootId, aNodeId, bNodeId, args?.export === true)
    }
  )

  // v2.8：可续跑会话（上次任务未收尾 = 进程在任务中途被关掉或崩溃）。
  // 只读；界面启动时取最近一条提示「继续上次任务」。
  ipcMain.handle(INVOKE.sessionResumable, async () => services.sessionTree.resumable())

  ipcMain.handle(INVOKE.sessionRename, async (_e, args: { rootId?: string; title?: string }) => {
    const rootId = toStr(args?.rootId)
    if (!/^s-[0-9a-f]{8}$/.test(rootId)) throw new Error('非法会话 ID')
    return { renamed: services.sessionTree.renameSession(rootId, toStr(args?.title)) }
  })

  ipcMain.handle(INVOKE.sessionPin, async (_e, args: { rootId?: string; pinned?: boolean }) => {
    const rootId = toStr(args?.rootId)
    if (!/^s-[0-9a-f]{8}$/.test(rootId)) throw new Error('非法会话 ID')
    const pinned = args?.pinned === true
    services.sessionTree.setSessionPinned(rootId, pinned)
    return { pinned }
  })

  ipcMain.handle(INVOKE.sessionOpenInExplorer, async (_e, args: { rootId?: string }) => {
    const rootId = toStr(args?.rootId)
    if (!/^s-[0-9a-f]{8}$/.test(rootId)) throw new Error('非法会话 ID')
    const file = services.sessionFileOf(rootId)
    if (!file) return { opened: false }
    shell.showItemInFolder(file)
    return { opened: true }
  })

  ipcMain.handle(INVOKE.sessionOpenDir, async () => {
    await shell.openPath(services.sessionDir)
    return { opened: true }
  })

  // ————————————————— 拓扑 —————————————————
}

