import { INVOKE } from '@shared/channels'
import { MAX_ATTACHMENTS } from '@shared/attachments'
import { activeProfile } from '@shared/profiles'
import { ipcMain } from 'electron'
import { enhancePrompt } from '../agent/llm/enhance'
import { getApiKey } from '../settings/secrets'
import { showOpenDialogSafe } from './dialogs'
import type { GateDecision } from '@shared/types'
import { describeAttachments, toStr } from './helpers'
import type { Services } from '../services'
import type { BrowserWindow } from 'electron'

/**
 * 代理与会话：起任务 / 附件 / 增强 / 中止 / 入队 / 闸门，以及会话树列举与导出。
 *
 * 本模块只做「校验 → 调服务 → 回传」，业务逻辑在 services / core。
 */
export function registerAgentIpc(services: Services, getWindow: () => BrowserWindow | null): void {

  ipcMain.handle(INVOKE.agentRun, async (_e, args: { sessionId?: string; text?: string; rootId?: string | null; startNodeId?: string | null; attachments?: unknown }) => {
    const sessionId = toStr(args?.sessionId)
    const text = toStr(args?.text).trim()
    if (!sessionId) throw new Error('缺少会话 ID')
    if (!text) throw new Error('指令不能为空')
    if (services.isAgentRunning(sessionId)) throw new Error('该会话已有任务在运行')
    const rootId = args?.rootId && /^s-[0-9a-f]{8}$/.test(args.rootId) ? args.rootId : null
    const startNodeId = args?.startNodeId && /^n-/.test(toStr(args.startNodeId)) ? toStr(args.startNodeId) : null
    // v1.5：附件以磁盘为准重建 —— 渲染层回传的 size/kind/preview 一律不采信
    const attachments = describeAttachments(services, args?.attachments)
    // v1.8：启动失败（会话树落盘 / 运行时装配等）不能静默吞掉 —— fire-and-forget 挂了
    // catch，把错误转成 error + done 事件回执，避免 unhandled rejection + 渲染层
    // agentRunning 卡死在 true。
    void services
      .startAgent(sessionId, text, { rootId, startNodeId, attachments })
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

  // ————————————————— 拓扑 —————————————————
}

