/**
 * 启动 / 设置 / 会话树 / 拓扑 / 技能 域 actions（T5.8 拆分 —— 自 app.ts 原样搬移，无行为变化）。
 */
import type { SessionNode, Settings, Topology, TopologyLink, TopologyNode } from '@shared/types'
import type { ScanProgress } from '@shared/api'
import { EVENT } from '@shared/channels'
import { computeAutoLayout, sourcePosOf } from '@/features/topology/autoLayout'
import type { AppState, SliceGet, SliceSet } from './appState'
import {
  applyTheme,
  errorText,
  matchTreeNodes,
  mergeTouchedSettings,
  nearestUserAncestor,
  nodesToMessages,
  sortDevices,
  stripAttachmentNote,
  systemNote
} from './storeUtil'

/**
 * N18：会话载入的请求序号。
 *
 * `openSession` / `continueFrom` / `resumeSession` 都是「发一次 IPC → await → set」，
 * 中间没有任何令牌。快速连点两个历史会话时，**先发后到**的响应会把后选会话的消息流
 * 覆盖成旧会话的内容，界面与 `activeRootId` 不一致（点 B 却看到 A 的消息）。
 * 交付时给每次载入编号，回来时比对序号，过期的响应直接丢弃。
 *
 * 放模块级而不是 store：它只是「最近一次请求」的记号，不需要触发任何重渲染；
 * 全应用只有一个 store 实例，不存在串味。
 */
let sessionLoadSeq = 0

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
  | 'openSession'
  | 'deleteSession'
  | 'renameSession'
  | 'togglePinSession'
  | 'openSessionFile'
  | 'openSessionsDir'
  | 'loadResumable'
  | 'resumeSession'
  | 'dismissResume'
  | 'deleteMessage'
  | 'regenerateMessage'
  | 'setTheme'
  | 'updateSettings'
  | 'setProfileKey'
  | 'clearTopology'
  | 'refreshTopology'
  | 'setTopoLoading'
  | 'saveManualTopology'
  | 'restoreSourceLayout'
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
  /**
   * 拉树 + 建「UI 消息 → 树节点」映射（v2.12）。失败/不可用返回 null，由调用方给提示。
   *
   * 为什么每次现拉而不是缓存：live 视图的消息 id 是渲染层自增的 `m<seq>`，
   * 与树节点 id（`n-<uuid>`）是两套；映射只能靠「同一事件序列产出、角色计数一致」
   * 来对齐，而树在任务推进中随时在变 —— 用时现拉 + 现对齐才不会拿到过期快照。
   */
  async function resolveTreeBinding(
    get: SliceGet,
    msgId: string
  ): Promise<{ rootId: string; nodeId: string; nodes: SessionNode[] } | null> {
    const rootId = get().activeRootId
    if (!rootId) return null
    const nodes = await window.api.session.get(rootId)
    const map = matchTreeNodes(get().messages, nodes)
    const nodeId = map.get(msgId)
    return nodeId ? { rootId, nodeId, nodes } : null
  }

  /**
   * N18：把某个会话载入视图（打开 / 换路重走 / 断点续跑共用同一入口）。
   *
   * 返回 `false` 表示这次载入已被更新的请求取代 —— 调用方（`resumeSession`）据此
   * 决定是否继续发「继续上次任务」的指令：若用户已经点了别的会话，就不要再往新会话里
   * 塞一条补跑指令。
   */
  async function loadSessionView(
    rootId: string,
    startNodeId: string | null,
    extra?: Partial<AppState>
  ): Promise<boolean> {
    const seq = ++sessionLoadSeq
    const nodes = await window.api.session.get(rootId)
    if (seq !== sessionLoadSeq) return false
    const todos = await window.api.session.todos(rootId).catch(() => [])
    if (seq !== sessionLoadSeq) return false
    set({
      activeRootId: rootId,
      activeStartNodeId: startNodeId,
      messages: nodesToMessages(nodes),
      // R3：切换会话时清掉上一段流式正文（它属于旧会话）
      streamingText: null,
      queueCount: 0,
      agentTodos: todos,
      ...extra
    })
    return true
  }

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
        // v2.8：查一次可续跑会话（启动提示「继续上次任务」）
        await get().loadResumable()
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
      // v2.7：新会话没有清单 —— 不清会显示上一个会话的进度
      set({
        activeRootId: null,
        activeStartNodeId: null,
        messages: [],
        // R3：同上，流式正文属于旧会话
        streamingText: null,
        queueCount: 0,
        agentTodos: [],
        // v2.8：用户主动开新会话 = 不打算续跑，收起提示
        resumable: null
      })
    },

    async continueFrom(rootId: string, node: SessionNode) {
      await loadSessionView(rootId, node.id)
    },

    /** v2.2：进入旧会话 —— 载入完整消息流，后续发送追加到该会话尾部 */
    async openSession(rootId: string) {
      // v2.8：用户主动进了某个会话 = 已做出选择，收起续跑提示
      await loadSessionView(rootId, null, { resumable: null })
    },

    // ————— v2.2：会话管理（历史列表右键菜单） —————

    /** 删除会话：若删的是当前活跃会话，同步清空当前视图 */
    async deleteSession(rootId: string) {
      await window.api.session.delete(rootId)
      if (get().activeRootId === rootId) {
        set({
          activeRootId: null,
          activeStartNodeId: null,
          messages: [],
          queueCount: 0,
          agentTodos: []
        })
      }
    },

    async renameSession(rootId: string, title: string) {
      await window.api.session.rename(rootId, title)
    },

    async togglePinSession(rootId: string) {
      const meta = get().sessions.find((s) => s.id === rootId)
      if (!meta) return
      await window.api.session.pin(rootId, !meta.pinned)
    },

    async openSessionFile(rootId: string) {
      await window.api.session.openInExplorer(rootId)
    },

    async openSessionsDir() {
      await window.api.session.openDir()
    },

    // ————— v2.8：断点续跑 —————

    async loadResumable() {
      try {
        const list = await window.api.session.resumable()
        set({ resumable: list })
      } catch {
        // 读失败按「没有可续跑的」处理：这只是启动提示，不该影响启动
        set({ resumable: [] })
      }
    },

    /**
     * v2.8：继续上次未完成的任务。
     *
     * 关键点：**不重发新指令**，而是把该会话载入视图后由用户确认目标 ——
     * 直接用祖先链当 history 起一轮 run，并把「继续」作为指令。
     * 为什么不自动重发原指令：崩溃前那次可能已经把设备改到一半，
     * 原指令再次执行会从「已经配过一半」的状态重头来一遍 —— 对 `undo` 不友好的
     * 命令（如 acl 规则）会造成重复配置。让模型看到历史（含 v2.8 落盘的
     * 工具摘要）后自己判断「哪些已经做完」，比机械重发安全得多。
     */
    async resumeSession(rootId: string) {
      // N18：载入若被更新的请求取代（用户又点了别的会话），就不要再往新会话里塞指令
      const applied = await loadSessionView(rootId, null, { resumable: null })
      if (!applied) return
      await get().send(
        '上次任务在本机中断了。请先阅读上面的历史轨迹（尤其是各次工具调用的结果摘要），' +
          '判断哪些步骤已经完成、哪些还没做，然后接着把原目标做完；不要重复执行已经生效的配置。'
      )
    },

    dismissResume() {
      set({ resumable: null })
    },

    // ————— v2.12：消息删除 / 重新生成 —————

    /** 删除一条消息：从对应节点起截断整条分支，然后把视图重载成树的现状 */
    async deleteMessage(msgId: string) {
      if (get().agentRunning) {
        get().noteSystemMessage('任务执行中不能删除消息，请先中断或等待完成', 'info')
        return
      }
      const bound = await resolveTreeBinding(get, msgId)
      if (!bound) {
        get().noteSystemMessage(
          get().activeRootId
            ? '无法定位该消息在会话树中的位置（可能是未落盘的系统提示），已跳过'
            : '当前会话尚未落盘（新会话需先完成一轮任务），暂不能删除',
          'info'
        )
        return
      }
      const target = bound.nodes.find((n) => n.id === bound.nodeId)
      if (target?.parentId === null) {
        get().noteSystemMessage('首条指令是会话根节点，不能删除；如需清空请用工具栏的清空按钮', 'info')
        return
      }
      try {
        await window.api.session.deleteNode(bound.rootId, bound.nodeId)
        // 截断后视图以树为准重载 —— 被删分支连同其后的消息一起消失
        const nodes = await window.api.session.get(bound.rootId)
        set({ messages: nodesToMessages(nodes) })
      } catch (e) {
        get().noteSystemMessage(`删除消息失败：${errorText(e)}`)
      }
    },

    /**
     * 重新生成：回到产生这条回答的用户指令，截断旧回答分支后用**原指令**重跑。
     *
     * - 对 assistant/thinking：锚点 = 最近的 user 祖先；截断锚点 + 后代（视图里指令
     *   会随重发再出现一次），然后 `send(原文)` —— 新回答从锚点的父节点开新分支。
     * - 对 user 指令本身：锚点就是它，语义 = 「这条指令重发一遍」。
     * - 锚点是 root（第一条指令）：root 不能删，改传 `keepSelf` 只删后代（旧回答），
     *   再重发。树里会多一条内容相同的 user 节点（历史回放里指令出现两次），
     *   这是「树只追加 + 复用原指令」下最小的实现代价，只影响第一条指令。
     */
    async regenerateMessage(msgId: string) {
      if (get().agentRunning) {
        get().noteSystemMessage('任务执行中不能重新生成，请先中断或等待完成', 'info')
        return
      }
      const bound = await resolveTreeBinding(get, msgId)
      if (!bound) {
        get().noteSystemMessage(
          get().activeRootId
            ? '无法定位该消息在会话树中的位置，暂不能重新生成'
            : '当前会话尚未落盘（新会话需先完成一轮任务），暂不能重新生成',
          'info'
        )
        return
      }
      const anchor = nearestUserAncestor(bound.nodes, bound.nodeId)
      if (!anchor) {
        get().noteSystemMessage('找不到产生这条回答的指令节点，暂不能重新生成', 'info')
        return
      }
      const originalText = stripAttachmentNote(anchor.content)
      if (!originalText) {
        get().noteSystemMessage('原指令内容为空，暂不能重新生成', 'info')
        return
      }
      try {
        // 锚点是 root 时传 keepSelf：只删后代（旧回答），root 自身保留
        await window.api.session.deleteNode(bound.rootId, anchor.id, anchor.parentId === null)
      } catch (e) {
        get().noteSystemMessage(`重新生成失败（截断旧回答时出错）：${errorText(e)}`)
        return
      }
      // 视图先收敛到树现状，再走正常 send —— 用户气泡与回答都会重新出现
      const nodes = await window.api.session.get(bound.rootId)
      set({ messages: nodesToMessages(nodes) })
      await get().send(originalText)
    },

    async setTheme(theme: 'dark' | 'light') {
      applyTheme(theme)
      await get().updateSettings({ theme })
    },

    /**
     * 保存设置补丁。
     *
     * **N64：只回写本 patch 涉及的顶层字段**，不再整份覆盖。
     * 主进程返回的是整份 `settings`，而多个入口（设置页多项即时生效、`doScan` 写扫描范围、
     * `setProfileKey`、面板拖拽结束）可能并发调用 —— 响应回来顺序与请求顺序不一致时，
     * 后到者的**整份**快照会抹掉另一处刚写入的字段，表现就是「刚开的开关自己弹回去」。
     * 只合并本次 patch 的键，等价于把「服务端权威值」限制在自己负责的范围内。
     *
     * **N65/N56：失败必须可见**。`settings:set` 是唯一会 reject 的 IPC 通道
     * （`sanitizeStorageSettings` 会抛），而调用点大量写成 `void updateSettings(...)`，
     * 过去失败会退化成一条泛化的未处理 rejection。这里统一就地提示。
     */
    async updateSettings(patch: Partial<Settings>) {
      try {
        const { settings, hasApiKey, configuredProfileIds } = await window.api.settings.set(patch)
        // N64：只回写本 patch 涉及的顶层字段（合并口径见 storeUtil#mergeTouchedSettings）
        set((s) => ({
          settings: mergeTouchedSettings(s.settings, patch, settings),
          hasApiKey,
          configuredProfileIds
        }))
      } catch (e) {
        get().noteSystemMessage(`保存设置失败：${errorText(e)}`, 'error')
      }
    },

    async setProfileKey(profileId: string, key: string) {
      const { settings, hasApiKey, configuredProfileIds } = await window.api.settings.setApiKey(
        profileId,
        key
      )
      set({ settings, hasApiKey, configuredProfileIds })
    },

    async clearTopology() {
      try {
        const t = await window.api.topology.clear()
        set({ topology: t })
      } catch (e) {
        set((s) => ({
          messages: [...s.messages, systemNote(`清空拓扑失败：${errorText(e)}`)]
        }))
      }
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

    /** v2.29：拓扑加载进度（null = 收尾，进度条消失） */
    setTopoLoading(p) {
      set({ topoLoading: p })
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

    /**
     * v2.31：恢复 eNSP 原始布局 —— 把全部设备坐标写回工程文件里的 `srcX`/`srcY`。
     *
     * 手动层的坐标覆盖是**持久化**的：自适应布局跑过一次，那些坐标就永久压住了工程里的摆放，
     * 之后无论关不关自动重排、甚至重新导入同一个工程（`setFile` 会命中该工程的 manual 缓存），
     * 画布都还是算法布局。这个动作就是那把「撤销」：把覆盖值改成源坐标，
     * 合并结果里的 x/y 就重新等于工程原样。
     *
     * 只对**有源坐标**的设备写（手动新建的 `m-node-` 没有 srcX/srcY，应当保留用户摆的位置）；
     * 没有源坐标可归位的设备一台都没找到时给一条提示，避免用户以为按钮坏了。
     */
    async restoreSourceLayout() {
      const t = get().topology
      const restorable = t.nodes.filter(
        (n) => typeof n.srcX === 'number' && typeof n.srcY === 'number'
      )
      if (restorable.length === 0) {
        get().noteSystemMessage(
          t.nodes.length === 0
            ? '画布上还没有设备，先从 eNSP 工程导入一份拓扑'
            : '当前画布上的设备没有 eNSP 源坐标（可能是手动添加或实采发现的），无法恢复原始布局',
          'info'
        )
        return
      }
      const nodes: TopologyNode[] = restorable.map((n) => ({
        id: n.id,
        name: n.name,
        role: n.role,
        ...(n.model ? { model: n.model } : {}),
        ...(n.deviceId ? { deviceId: n.deviceId } : {}),
        ...(n.interfaces && n.interfaces.length > 0 ? { interfaces: n.interfaces } : {}),
        x: Math.round(n.srcX as number),
        y: Math.round(n.srcY as number),
        source: 'manual'
      }))
      await get().saveManualTopology({ nodes, links: t.links.filter((l) => l.source === 'manual') })
      get().noteSystemMessage(`已恢复 ${nodes.length} 台设备到 eNSP 工程里的原始摆布`, 'info')
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
        // 进度条**只在用户选完文件之后**才开始 —— 弹系统文件选择框期间（用户还在挑文件）
        // 主进程什么都没做，此时点亮进度条等于谎报「正在解析」。
        // 故进度条的起点放在 `topologyImportFile` 的回调里：handler 一进入解析就推
        // `import-progress` 事件（见 ipc/topology.ts），渲染层据此置位。
        const r = await window.api.topology.importFile()
        if (r) {
          set({ topology: r.topology })
          await autoLayoutAfterImport(r.topology, get)
        } else {
          set({ topoLoading: null })
        }
        return r
      } catch (e) {
        set({ topoLoading: null })
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
        // 这条入口（发现面板里点某个 .topo / 拖入路径）没有文件选择框，
        // 点击即解析 —— 进度条就在此刻点亮。
        set({ topoLoading: { phase: 'read', ratio: 0, detail: '正在解析 eNSP 工程文件', startedAt: Date.now() } })
        const r = await window.api.topology.importPath(filePath)
        if (r) {
          set({ topology: r.topology })
          await autoLayoutAfterImport(r.topology, get)
        } else {
          set({ topoLoading: null })
        }
        return r
      } catch (e) {
        set({ topoLoading: null })
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

    async saveSkill(input: {
      id?: string
      name?: string
      description?: string
      content: string
      scope?: string[]
    }) {
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
      // 以「当前已启用集合」为基线增删，而不是全量技能 id ——
      // 主进程 setEnabled 是整表替换，传全量会把已停用的技能一起重新启用。
      const next = new Set(get().skills.filter((s) => s.enabled).map((s) => s.id))
      if (enabled) next.add(id)
      else next.delete(id)
      await window.api.skill.setEnabled([...next])
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
/**
 * 导入后自动重排拓扑（B4 第二批；开关 = `settings.ensp.autoLayoutOnImport`）。
 *
 * **默认关闭（2026-09-30 改）**：导入 eNSP 工程时**保留工程里的原始摆放**，
 * 想重排的用户点画布工具栏的「自适应布局」，或到设置里把这个开关打开。
 *
 * 为什么默认关：eNSP 工程里的摆放是**作者有意为之**的（分区、上下级、连线走向都带语义），
 * 自动重排会把它冲掉 —— 用户导入后第一眼看到的是「另一个图」，认不出自己的工程。
 * 而重排是一次覆盖写入（`source: 'manual'`），刷新/重启都不会回到原样，误操作成本高。
 *
 * 实现上复用「自适应布局」的同一套动作：把布局结果当作**坐标覆盖**写进手动层
 * （`source: 'manual'`，与用户拖动设备是同一种数据），因此刷新/重启后位置仍在。
 * 失败不阻断导入：重排只影响观感，用户看到原始坐标依然能用。
 */
async function autoLayoutAfterImport(t: Topology, get: SliceGet): Promise<void> {
  const set = get().setTopoLoading
  if (t.nodes.length === 0) {
    set(null)
    return
  }
  const startedAt = Date.now()
  if (!get().settings.ensp.autoLayoutOnImport) {
    // 关了自动重排也**不能**立刻收尾：真正耗时的是画布那侧的走线 + 首屏元素构建
    // （40 台 ≈ 4ms、300 台优化前 ≈ 82ms）。交给「绘制画布」阶段，由画布首帧清空。
    set({ phase: 'render', ratio: 0.4, detail: '正在绘制画布', startedAt })
    return
  }
  // —— 布局阶段：这是导入后最重的一段同步计算（源图保真内核：源坐标量化 + 模块列）——
  set({ phase: 'layout', ratio: 0, detail: `正在重排 ${t.nodes.length} 台设备`, startedAt })
  // 让出一次事件循环：进度条得先画到屏幕上，否则后面这段同步计算会把「布局中」
  // 和计算结果憋在同一个帧里一起提交 —— 用户看不到任何中间态，进度条等于白做。
  await nextFrame()
  const pos = computeAutoLayout(t.nodes, t.links, { sourcePos: sourcePosOf(t.nodes) })
  const nodes: TopologyNode[] = t.nodes.map((n) => {
    const p = pos.get(n.id)
    return {
      id: n.id,
      name: n.name,
      role: n.role,
      ...(n.model ? { model: n.model } : {}),
      ...(p ? { x: Math.round(p.x), y: Math.round(p.y) } : {}),
      source: 'manual'
    }
  })
  set({ phase: 'route', ratio: 0.2, detail: '正在保存布局并计算连线', startedAt })
  try {
    await get().saveManualTopology({ nodes, links: t.links.filter((l) => l.source === 'manual') })
  } catch {
    /* 重排失败不阻断导入 */
  }
  // 收尾交给画布首帧（见 TopologyCanvas 的收尾 effect）：最后一跳由它推进并关闭，
  // 这里不再写终态，避免出现「进度条已消失、图还没出来」的空窗。
  set({ phase: 'render', ratio: 0.4, detail: '正在绘制画布', startedAt })
}

/** 等到下一次绘制机会（rAF，退化为 setTimeout；测试环境无 rAF 也能跑） */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame
    if (typeof raf === 'function') raf(() => resolve())
    else setTimeout(resolve, 0)
  })
}

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
  // v2.31：导入工程时主进程「真正开始解析」的信号（弹框结束、选中文件之后）。
  // 进度条的起点在这里 —— 弹文件选择框期间不亮，避免谎报「正在解析」。
  window.api.on<{ filePath?: string }>(EVENT.topologyImportStarted, () => {
    set({
      topoLoading: {
        phase: 'read',
        ratio: 0,
        detail: '正在解析 eNSP 工程文件',
        startedAt: Date.now()
      }
    })
  })
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