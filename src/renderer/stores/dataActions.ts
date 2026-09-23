/**
 * 启动 / 设置 / 会话树 / 拓扑 / 技能 域 actions（T5.8 拆分 —— 自 app.ts 原样搬移，无行为变化）。
 */
import type { SessionNode, Settings, TopologyLink, TopologyNode } from '@shared/types'
import type { ScanProgress } from '@shared/api'
import { EVENT } from '@shared/channels'
import type { AppState, SliceGet, SliceSet } from './appState'
import { applyTheme, errorText, nodesToMessages, sortDevices, systemNote } from './storeUtil'

export function dataActions(
  set: SliceSet,
  get: SliceGet
): Pick<
  AppState,
  | 'init'
  | 'retryStartup'
  | 'loadSessions'
  | 'newSession'
  | 'continueFrom'
  | 'setTheme'
  | 'updateSettings'
  | 'setProfileKey'
  | 'refreshTopology'
  | 'saveManualTopology'
  | 'removeTopology'
  | 'importTopology'
  | 'discoverTopoFiles'
  | 'importTopoPath'
  | 'loadSkills'
  | 'saveSkill'
  | 'removeSkill'
  | 'toggleSkill'
  | 'importSkillFiles'
  | 'importSkillDir'
  | 'importSkillPath'
> {
  return {
    async init() {
      ensureSubscribed(set, get)
      try {
        const { settings, hasApiKey, configuredProfileIds } = await window.api.settings.get()
        applyTheme(settings.theme)
        set({ settings, hasApiKey, configuredProfileIds, ready: true })

        const topology = await window.api.topology.get()
        set({ topology })
        await get().loadSessions()
        await get().loadSkills()
        await get().loadMcpServers()
        await get().refreshDevices()
      } catch (e) {
        // 启动失败不白屏：把错误亮给用户并提供重试
        set({ startupError: e instanceof Error ? e.message : String(e), ready: false })
      }
    },

    retryStartup() {
      set({ startupError: null, ready: false })
      void get().init()
    },

    async loadSessions() {
      try {
        const sessions = await window.api.session.list()
        set({ sessions })
      } catch {
        /* 历史读取失败不阻塞主流程 */
      }
    },

    newSession() {
      set({ activeRootId: null, activeStartNodeId: null, messages: [], queueCount: 0 })
    },

    async continueFrom(rootId: string, node: SessionNode) {
      const nodes = await window.api.session.get(rootId)
      set({
        activeRootId: rootId,
        activeStartNodeId: node.id,
        messages: nodesToMessages(nodes),
        queueCount: 0
      })
    },

    async setTheme(theme: 'dark' | 'light') {
      applyTheme(theme)
      await get().updateSettings({ theme })
    },

    async updateSettings(patch: Partial<Settings>) {
      const { settings, hasApiKey, configuredProfileIds } = await window.api.settings.set(patch)
      set({ settings, hasApiKey, configuredProfileIds })
    },

    async setProfileKey(profileId: string, key: string) {
      const { settings, hasApiKey, configuredProfileIds } = await window.api.settings.setApiKey(
        profileId,
        key
      )
      set({ settings, hasApiKey, configuredProfileIds })
    },

    async refreshTopology() {
      set({ topologyRefreshing: true })
      try {
        const t = await window.api.topology.refresh()
        set({ topology: t })
      } finally {
        set({ topologyRefreshing: false })
      }
    },

    async saveManualTopology(input: { nodes: TopologyNode[]; links: TopologyLink[] }) {
      // R27：写盘失败不能静默 —— 节点会停在拖过去的位置，看起来"保存好了"，
      // 下次打开却回到原样。这里给可见反馈，并把拓扑刷回磁盘上的真实状态。
      try {
        const t = await window.api.topology.saveManual(input)
        set({ topology: t })
      } catch (e) {
        set((s) => ({
          messages: [...s.messages, systemNote(`拓扑保存失败：${errorText(e)}（已回退到磁盘上的版本）`)]
        }))
        await get()
          .refreshTopology()
          .catch(() => undefined)
      }
    },

    async removeTopology(input: { nodeIds?: string[]; linkKeys?: string[] }) {
      try {
        const t = await window.api.topology.remove(input)
        set({ topology: t })
      } catch (e) {
        set((s) => ({
          messages: [...s.messages, systemNote(`拓扑删除失败：${errorText(e)}（已回退到磁盘上的版本）`)]
        }))
        await get()
          .refreshTopology()
          .catch(() => undefined)
      }
    },

    async importTopology() {
      try {
        const r = await window.api.topology.importFile()
        if (r) set({ topology: r.topology })
        return r
      } catch (e) {
        return null
      }
    },

    async discoverTopoFiles(directory?: string) {
      try {
        return await window.api.topology.findFiles(directory)
      } catch (e) {
        return null
      }
    },

    async importTopoPath(filePath: string) {
      try {
        const r = await window.api.topology.importPath(filePath)
        if (r) set({ topology: r.topology })
        return r
      } catch (e) {
        return null
      }
    },

    async loadSkills() {
      try {
        const skills = await window.api.skill.list()
        set({ skills })
      } catch {
        /* 技能读取失败不阻塞主流程 */
      }
    },

    async saveSkill(input: { id?: string; name?: string; description?: string; content: string }) {
      try {
        const saved = await window.api.skill.save(input)
        await get().loadSkills()
        return { id: saved.id }
      } catch (e) {
        throw e
      }
    },

    async removeSkill(id: string) {
      const ok = await window.api.skill.remove(id)
      await get().loadSkills()
      return ok
    },

    async toggleSkill(id: string, enabled: boolean) {
      const next = get().skills.map((s) => s.id)
      const set2 = new Set(next)
      if (enabled) set2.add(id)
      else set2.delete(id)
      await window.api.skill.setEnabled([...set2])
      await get().loadSkills()
    },

    async importSkillFiles() {
      const r = await window.api.skill.importFiles()
      if (r) await get().loadSkills()
      return r
    },

    async importSkillDir() {
      const r = await window.api.skill.importDirectory()
      if (r) await get().loadSkills()
      return r
    },

    async importSkillPath(filePath: string) {
      const r = await window.api.skill.importPath(filePath)
      if (r) await get().loadSkills()
      return r
    }
  }
}

/**
 * 主进程事件订阅（v1.8）：
 * 只执行一次 —— init() 可被「重试启动」再次调用，若每次重注册，agentEvent/终端等
 * 事件会拿到双份回调（消息重复入流、状态抖动）。终端数据由 TerminalPane 直接消费
 * （xterm 实例在组件内），这里不再订阅 terminalData（v1.8，原为 no-op 浪费）。
 */
let subscribed = false
function ensureSubscribed(set: SliceSet, get: SliceGet): void {
  if (subscribed) return
  subscribed = true
  window.api.on<ScanProgress>(EVENT.scanProgress, (p) => {
    set({ scanProgress: p, scanning: !p.done })
    if (p.done) void get().refreshDevices()
  })
  window.api.on<import('@shared/types').Device>(EVENT.deviceStateChanged, (d) => {
    set((s) => {
      const idx = s.devices.findIndex((x) => x.id === d.id)
      const next = [...s.devices]
      if (idx >= 0) next[idx] = d
      else next.push(d)
      return {
        devices: sortDevices(next),
        connectedIds: next.filter((x) => x.connected).map((x) => x.id)
      }
    })
  })
  window.api.on<import('@shared/api').AgentEventPayload>(EVENT.agentEvent, (p) => get().applyAgentEvent(p))
  window.api.on<import('@shared/api').TerminalClosedPayload>(EVENT.terminalClosed, (p) =>
    get().markTerminalClosed(p)
  )
  window.api.on<import('@shared/types').Topology>(EVENT.topologyUpdated, (t) => set({ topology: t }))
  window.api.on<import('@shared/types').SessionNodeMeta[]>(EVENT.sessionListUpdated, (list) =>
    set({ sessions: list })
  )
  window.api.on<import('@shared/types').SkillSummary[]>(EVENT.skillsUpdated, (list) => set({ skills: list }))
  window.api.on<import('@shared/types').McpServerStatus[]>(EVENT.mcpServersUpdated, (list) =>
    set({ mcpServers: list })
  )
  window.api.on<import('@shared/api').McpStatusPayload>(EVENT.mcpStatus, (s) =>
    set({ mcpStatus: { running: s.running, url: s.url, error: s.error } })
  )
  // D9：主进程任何来源的设置变更都广播到这里，界面 state 保持与主进程一致。
  // 旧实现只靠「自己发起 updateSettings 的返回值」刷新，别处（Wireshark 挂载、
  // 数据目录切换）改的设置既不可见、又会被同窗口的旧闭包写回抹掉。
  window.api.on<Settings>(EVENT.settingsUpdated, (s) => set({ settings: s }))
}