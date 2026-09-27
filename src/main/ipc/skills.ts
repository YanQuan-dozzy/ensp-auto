import { INVOKE } from '@shared/channels'
import { activeProfile } from '@shared/profiles'
import { ipcMain } from 'electron'
import { showOpenDialogSafe } from './dialogs'
import { walkMarkdown } from '../skills/store'
import {
  buildTroubleshootTranscript,
  findTroubleshootEpisodes,
  fixedEpisodes,
  troubleshootDraftDescription,
  troubleshootDraftTitle
} from '../core/session-tree/troubleshoot'
import { distillSkill } from '../agent/llm/distill'
import { getApiKey } from '../settings/secrets'
import { toStr } from './helpers'
import type { Services } from '../services'
import type { BrowserWindow } from 'electron'

/**
 * 技能库：列举 / 读取 / 保存 / 删除 / 启停 / 导入。
 *
 * 本模块只做「校验 → 调服务 → 回传」，业务逻辑在 services / core。
 */
export function registerSkillsIpc(services: Services, getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(INVOKE.skillList, async () => services.skills.list())

  ipcMain.handle(INVOKE.skillGet, async (_e, args: { id?: string }) => {
    const id = toStr(args?.id)
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error('非法技能 ID')
    return services.skills.get(id)
  })

  ipcMain.handle(
    INVOKE.skillSave,
    async (
      _e,
      args: {
        id?: string
        name?: string
        description?: string
        content?: string
        scope?: unknown
      }
    ) => {
      const content = toStr(args?.content)
      if (!content.trim()) throw new Error('技能内容不能为空')
      // 显式 id 若提供则必须是合法格式（命中已存在的 id 由 store 判断是新建/更新）
      if (args?.id && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(args.id)) throw new Error('非法技能 ID')
      // F12：绑定目录是路径字符串数组；非数组 = 不改动（undefined），空数组 = 设为全局技能。
      // 这里不收路径长度/合法性硬校验 —— 目录可能尚未创建，绑定先写后建是正常用法。
      const scope = Array.isArray(args?.scope)
        ? args.scope.filter((v): v is string => typeof v === 'string')
        : undefined
      return services.skills.save({
        ...(args?.id ? { id: args.id } : {}),
        ...(toStr(args?.name) ? { name: toStr(args.name) } : {}),
        ...(toStr(args?.description) ? { description: toStr(args.description) } : {}),
        ...(scope !== undefined ? { scope } : {}),
        content
      })
    }
  )

  ipcMain.handle(INVOKE.skillRemove, async (_e, args: { id?: string }) => {
    const id = toStr(args?.id)
    return services.skills.remove(id)
  })

  // 整体替换启用集合（渲染层勾选后整表提交）
  ipcMain.handle(INVOKE.skillSetEnabled, async (_e, args: { ids?: unknown }) => {
    const ids = Array.isArray(args?.ids)
      ? args.ids.filter((v): v is string => typeof v === 'string')
      : []
    return services.skills.setEnabled(ids)
  })

  // 弹系统文件多选框导入 .md 技能
  ipcMain.handle(INVOKE.skillImportFiles, async () => {
    const win = getWindow()
    const result = await showOpenDialogSafe(win, {
          title: '导入技能文档（.md / .skill.md）',
          filters: [{ name: 'Markdown 技能', extensions: ['md'] }],
          properties: ['openFile', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return services.skills.importFromPaths(result.filePaths)
  })

  // 弹目录选择框：递归收集目录内 .md 作为技能（覆盖 SKILL.md / *.skill.md 场景）
  ipcMain.handle(INVOKE.skillImportDirectory, async () => {
    const win = getWindow()
    const result = await showOpenDialogSafe(win, {
      title: '导入技能目录（递归收集 .md）',
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    // 目录导入：递归收集 .md 后再走导入（与「选文件」共用同一条导入语义）
    return services.skills.importFromPaths(walkMarkdown(result.filePaths[0]))
  })

  // 按路径导入单个技能（与 import-path 同款的 UI 自由入口，校验在主进程）
  ipcMain.handle(INVOKE.skillImportPath, async (_e, args: { filePath?: string }) => {
    const filePath = toStr(args?.filePath)
    if (!filePath) return null
    return services.skills.importFromPaths([filePath])
  })

  /**
   * F13：从某会话的「失败 → 修正」轨迹自动沉淀一份排障技能。
   *
   * 生成即保存、但**默认不启用**（enabled 是独立的勾选集合）：模型产出直接生效
   * 太危险 —— 排障手册里一条编造的命令会真的改错设备配置，必须人工核对后再启用。
   */
  ipcMain.handle(INVOKE.skillDistill, async (_e, args: { rootId?: string }) => {
    const rootId = toStr(args?.rootId)
    if (!/^s-[0-9a-f]{8}$/.test(rootId)) throw new Error('非法会话 ID')

    const nodes = services.sessionTree.getTree(rootId)
    const episodes = fixedEpisodes(findTroubleshootEpisodes(nodes))
    if (episodes.length === 0) {
      throw new Error('这段会话里没有「失败后修好」的轨迹，暂无可沉淀的经验')
    }

    const transcript = buildTroubleshootTranscript(episodes)
    const settings = services.getSettings()
    const profile = activeProfile(settings.agent)
    const apiKey = getApiKey(profile.id)
    const body = await distillSkill(transcript, { profile, apiKey: apiKey ?? '' })

    const skill = services.skills.save({
      name: troubleshootDraftTitle(episodes),
      description: troubleshootDraftDescription(episodes),
      content: body
    })
    return { skill, episodes: episodes.length }
  })

  // ————————————————— v1.6：应用信息与数据目录 —————————————————
}

