/**
 * 代理会话 / 附件 / MCP 客户端 / 闸门域 actions（T5.8 拆分 —— 自 app.ts 原样搬移，无行为变化）。
 */
import type { GateDecision } from '@shared/types'
import type { QuestionAnswers } from '@shared/interaction'
import type { AgentEventPayload } from '@shared/api'
import type { AppState, SliceGet, SliceSet } from './appState'
import { SESSION_ID, errText, mergeAttachments, nextId, rejectionText, systemNote } from './storeUtil'
import { EMPTY_TURN_USAGE, accumulateUsage, type TurnUsage } from '@shared/turn-usage'
import { activeProfile } from '@shared/profiles'
import { blockedImagesForSend } from '@shared/image-attach'

/**
 * 本轮用量累加器（v2.10，P6）。
 *
 * 为什么放模块级而不是 store state：它只在「本轮进行中」有意义，
 * 且每收到一个 `usage` 事件就更新一次 —— 塞进 zustand 会让每次模型往返
 * 都触发一轮无关的组件重渲染（用量行要到本轮结束才显示）。
 * 收尾时把它折进 `finish` 消息（那一刻才进 store），之后就没人再读它。
 */
let turnUsage: TurnUsage = EMPTY_TURN_USAGE

export function agentActions(
  set: SliceSet,
  get: SliceGet
): Pick<
  AppState,
  | 'send'
  | 'pickAttachments'
  | 'importAttachmentPaths'
  | 'removeAttachment'
  | 'clearAttachments'
  | 'setActiveProfile'
  | 'enhanceDraft'
  | 'loadMcpServers'
  | 'syncMcpServers'
  | 'testMcpServer'
  | 'clearMcpServerError'
  | 'abort'
  | 'setShortcutRecording'
  | 'noteSystemMessage'
  | 'resolveGate'
  | 'answerQuestion'
  | 'setPlanMode'
  | 'quoteIntoInput'
  | 'clearQuoteDraft'
  | 'clearConversation'
  | 'applyAgentEvent'
> {
  return {
    async send(text) {
      const trimmed = text.trim()
      if (!trimmed) return

      // v0.4：执行中插话 → 入队，不另开新任务
      if (get().agentRunning) {
        let queued = false
        try {
          ;({ queued } = await window.api.agent.enqueue(SESSION_ID, trimmed))
        } catch {
          queued = false
        }
        set((s) => ({
          queueCount: queued ? s.queueCount + 1 : s.queueCount,
          messages: [
            ...s.messages,
            {
              kind: 'system',
              id: nextId(),
              text: queued ? '已加入执行队列，将在当前任务下一步处理' : '任务即将结束，消息未入队，请稍后重发',
              tone: queued ? 'info' : 'error'
            }
          ]
        }))
        return
      }

      // v1.5：附件随本轮一起提交，气泡里把文件名显出来（正文内容不进消息流）
      const attachments = get().attachments
      /**
       * v2.22（F17）：图片 + 不支持图片的模型 → **不发**。
       *
       * 界面在 submit() 里已经拦过一道（那里能保住输入框里的字），这里是
       * 「发送」这个动作的兜底：不管谁调 `send`，都不该把「发出去必然被端点 400」
       * 的一轮请求真的发出去 —— 那种失败在用户眼里是一句与图片毫无关系的报错。
       */
      const blockedImages = blockedImagesForSend(attachments, activeProfile(get().settings.agent))
      if (blockedImages) {
        set((s) => ({
          messages: [
            ...s.messages,
            { kind: 'system', id: nextId(), text: blockedImages.message, tone: 'error' }
          ]
        }))
        return
      }
      const bubble = attachments.length
        ? `${trimmed}\n\n📎 ${attachments.map((a) => a.name).join('、')}`
        : trimmed

      set((s) => ({
        messages: [...s.messages, { kind: 'user', id: nextId(), text: bubble, createdAt: Date.now() }],
        agentRunning: true,
        attachments: []
      }))
      // v2.10：新一轮开始 —— 用量累加器必须清零，否则上一轮的数字会串到本轮尾部
      turnUsage = EMPTY_TURN_USAGE
      try {
        await window.api.agent.run(SESSION_ID, trimmed, {
          rootId: get().activeRootId,
          startNodeId: get().activeStartNodeId,
          attachments,
          // v2.7：计划模式是「本轮指令」的属性，不是全局设置 —— 开着它发一条就只探索不出手，
          // 发完自动关掉，免得用户忘关之后每条指令都变成只出方案。
          planMode: get().planMode
        })
        // 本次已消费回溯起点，后续新消息从会话尾部继续
        if (get().activeStartNodeId) set({ activeStartNodeId: null })
        if (get().planMode) set({ planMode: false })
      } catch (e) {
        set((s) => ({
          agentRunning: false,
          messages: [
            ...s.messages,
            { kind: 'system', id: nextId(), text: e instanceof Error ? e.message : String(e), tone: 'error' }
          ]
        }))
      }
    },

    async pickAttachments() {
      try {
        const r = await window.api.agent.pickAttachments(SESSION_ID)
        if (!r) return
        set((s) => ({
          attachments: mergeAttachments(s.attachments, r.attachments),
          messages:
            r.rejected.length > 0
              ? [...s.messages, { kind: 'system', id: nextId(), text: rejectionText(r.rejected), tone: 'error' }]
              : s.messages
        }))
      } catch (e) {
        set((s) => ({
          messages: [...s.messages, { kind: 'system', id: nextId(), text: `导入附件失败：${errText(e)}`, tone: 'error' }]
        }))
      }
    },

    async importAttachmentPaths(paths) {
      if (paths.length === 0) return
      try {
        const r = await window.api.agent.importAttachments(SESSION_ID, paths)
        if (!r) return
        set((s) => ({
          attachments: mergeAttachments(s.attachments, r.attachments),
          messages:
            r.rejected.length > 0
              ? [...s.messages, { kind: 'system', id: nextId(), text: rejectionText(r.rejected), tone: 'error' }]
              : s.messages
        }))
      } catch (e) {
        set((s) => ({
          messages: [...s.messages, { kind: 'system', id: nextId(), text: `导入附件失败：${errText(e)}`, tone: 'error' }]
        }))
      }
    },

    removeAttachment(id) {
      set((s) => ({ attachments: s.attachments.filter((a) => a.id !== id) }))
    },

    clearAttachments() {
      set({ attachments: [] })
    },

    async setActiveProfile(profileId) {
      // 只改 activeProfileId；档案细节由设置面板负责，避免两处都能改出分歧
      await get().updateSettings({ agent: { ...get().settings.agent, activeProfileId: profileId } })
    },

    async enhanceDraft(draft) {
      const t = draft.trim()
      if (!t) return null
      set({ enhancing: true })
      try {
        const { text } = await window.api.agent.enhancePrompt(t)
        return text
      } catch (e) {
        // 失败不阻塞输入：把原因写进消息流，草稿原样留在输入框里
        set((s) => ({
          messages: [...s.messages, { kind: 'system', id: nextId(), text: `提示词增强失败：${errText(e)}`, tone: 'error' }]
        }))
        return null
      } finally {
        set({ enhancing: false })
      }
    },

    async loadMcpServers() {
      try {
        set({ mcpServers: await window.api.mcp.servers() })
      } catch {
        /* MCP 状态读取失败不阻塞主流程 */
      }
    },

    async syncMcpServers() {
      set({ mcpBusy: true })
      try {
        set({ mcpServers: await window.api.mcp.sync() })
      } catch (e) {
        set((s) => ({
          messages: [...s.messages, { kind: 'system', id: nextId(), text: `MCP 重连失败：${errText(e)}`, tone: 'error' }]
        }))
      } finally {
        set({ mcpBusy: false })
      }
    },

    async testMcpServer(id) {
      set({ mcpBusy: true })
      try {
        const st = await window.api.mcp.testServer(id)
        if (!st) return null
        set((s) => ({
          mcpServers: s.mcpServers.some((x) => x.id === st.id)
            ? s.mcpServers.map((x) => (x.id === st.id ? st : x))
            : [...s.mcpServers, st]
        }))
        return st
      } catch (e) {
        // N65：测试连接失败必须落到界面上 —— 过去只有 try/finally，
        // 「测试连接」点了没反应（原因只在控制台里）
        set((s) => ({
          messages: [
            ...s.messages,
            { kind: 'system', id: nextId(), text: `测试 MCP 连接失败：${errText(e)}`, tone: 'error' }
          ]
        }))
        return null
      } finally {
        set({ mcpBusy: false })
      }
    },

    /**
     * v2.21：只收起「上次连接失败」的那行结论，**不动连接状态与工具清单** ——
     * 这条错误挂在服务器条目下方，看完即弃；用户去点别的地方时把它收掉。
     */
    clearMcpServerError(id) {
      set((s) => ({
        mcpServers: s.mcpServers.map((x) => (x.id === id && x.error ? { ...x, error: null } : x))
      }))
    },

    abort() {
      void window.api.agent.abort(SESSION_ID)
    },

    setShortcutRecording(recording) {
      set({ shortcutRecording: recording })
    },

    noteSystemMessage(text, tone = 'error') {
      set((s) => ({ messages: [...s.messages, systemNote(text, tone)] }))
    },

    async resolveGate(decision: GateDecision) {
      const gate = get().gate
      if (!gate) return
      set({ gate: null })
      await window.api.agent.gate(SESSION_ID, gate.gateId, decision)
    },

    /**
     * v2.7：回答一次结构化提问。
     * 传 null = 取消 —— 主进程会把它转成「按最合理假设继续」，而不是让任务挂住。
     */
    async answerQuestion(answers: QuestionAnswers | null) {
      const q = get().question
      if (!q) return
      set({ question: null })
      await window.api.agent.question(SESSION_ID, q.questionId, answers)
    },

    setPlanMode(on: boolean) {
      set({ planMode: on })
    },

    quoteIntoInput(text: string) {
      const t = text.trim()
      if (!t) return
      set({ quoteDraft: t })
    },

    clearQuoteDraft() {
      set({ quoteDraft: null })
    },

    clearConversation() {
      set({ messages: [], gate: null, question: null, queueHint: 0 })
    },

    applyAgentEvent({ event, runtime }: AgentEventPayload) {
      set({ agentRuntime: runtime })
      switch (event.type) {
        case 'plan':
          set((s) => ({ messages: [...s.messages, { kind: 'plan', id: nextId(), steps: event.steps }] }))
          break
        case 'text':
          set((s) => {
            const last = s.messages[s.messages.length - 1]
            if (last && last.kind === 'assistant') {
              const next = [...s.messages]
              next[next.length - 1] = { ...last, text: last.text + event.delta }
              return { messages: next }
            }
            return { messages: [...s.messages, { kind: 'assistant', id: nextId(), text: event.delta }] }
          })
          break
        case 'thinking':
          // v2.2：一段思考结束 —— 独立的可折叠「思考」行
          set((s) => ({
            messages: [...s.messages, { kind: 'thinking', id: nextId(), text: event.text }]
          }))
          break
        case 'tool_start':
          set((s) => ({
            messages: [
              ...s.messages,
              {
                kind: 'tool',
                id: nextId(),
                callId: event.callId,
                name: event.name,
                args: event.args,
                risk: event.risk,
                status: 'running'
              }
            ]
          }))
          break
        case 'tool_end':
          set((s) => {
            const next = [...s.messages]
            for (let i = next.length - 1; i >= 0; i--) {
              const m = next[i]!
              if (m.kind === 'tool' && m.callId === event.callId) {
                next[i] = {
                  ...m,
                  status: event.ok ? 'ok' : 'fail',
                  ms: event.ms,
                  summary: event.summary,
                  ...(event.raw ? { raw: event.raw } : {}),
                  ...(event.errorCode ? { errorCode: event.errorCode } : {}),
                  // v2.9：结构化载荷只走「活事件」这条路，不透传到会话树
                  //（重放时 summary 已足够，树里不该塞结果正文）
                  ...(event.data !== undefined ? { data: event.data } : {})
                }
                break
              }
            }
            return { messages: next }
          })
          break
        case 'gate_request':
          set({ gate: { gateId: event.gateId, name: event.name, args: event.args, reason: event.reason } })
          break
        case 'gate_resolved':
          set((s) => ({
            gate: null,
            messages: [
              ...s.messages,
              {
                kind: 'system',
                id: nextId(),
                text: event.decision === 'approve' ? '已批准危险操作' : '已拒绝危险操作',
                tone: event.decision === 'approve' ? 'info' : 'error'
              }
            ]
          }))
          break
        case 'retry':
          set((s) => ({
            messages: [
              ...s.messages,
              {
                kind: 'system',
                id: nextId(),
                text: `请求失败，${(event.delayMs / 1000).toFixed(1)}s 后重试（第 ${event.attempt}/${event.maxAttempts} 次）：${event.reason}`,
                tone: 'info'
              }
            ]
          }))
          break
        case 'compact':
          set((s) => ({
            messages: [...s.messages, { kind: 'system', id: nextId(), text: event.detail, tone: 'info' }]
          }))
          break
        case 'usage':
          // v2.10：不论占比高低都要累加 —— 尾部用量行展示的是「本轮累计」，
          // 只在过半时才记会把小任务的数字算漏（老逻辑的过半提示仍保留）。
          turnUsage = accumulateUsage(
            turnUsage,
            { promptTokens: event.promptTokens, outputTokens: event.outputTokens },
            { measured: event.measured, contextWindow: event.contextWindow, ratio: event.ratio }
          )
          // v2.6：真实用量。只在过半时才提示，否则每一轮都插一行会把对话淹掉。
          // （展示形态是 P5 的事，这里先保证「测到的数字用户看得见」。）
          if (event.ratio >= 0.5) {
            set((s) => ({
              messages: [
                ...s.messages,
                {
                  kind: 'system',
                  id: nextId(),
                  text:
                    `上下文占用 ${Math.round(event.ratio * 100)}%` +
                    `（${event.promptTokens.toLocaleString('en-US')} / ${event.contextWindow.toLocaleString('en-US')} tokens` +
                    `${event.measured ? '' : '，估算'}）`,
                  tone: 'info'
                }
              ]
            }))
          }
          break
        case 'question_request':
          // v2.7：任务在这里暂停等用户 —— 与闸门同等地位，卡片会打断界面
          set({
            question: {
              questionId: event.questionId,
              questions: event.questions,
              source: event.source
            }
          })
          break
        case 'question_resolved':
          // 只清「同一个提问」——用户可能已经手动关掉卡片并发了新指令，
          // 无条件清空会把那次新提问的卡片一起抹掉。
          set((s) =>
            s.question?.questionId === event.questionId ? { question: null } : {}
          )
          if (event.cancelled && event.source === 'tool') {
            set((s) => ({
              messages: [
                ...s.messages,
                {
                  kind: 'system',
                  id: nextId(),
                  // plan 的取消由 plan_reviewed 负责措辞 —— 两处都写会给出两句矛盾的话
                  // （一句「本轮结束」一句「继续修订」）。
                  text: '提问已取消，代理将按最合理的假设继续并在结论里说明',
                  tone: 'info'
                }
              ]
            }))
          }
          break
        case 'todo_update':
          set({ agentTodos: event.todos })
          break
        case 'title_updated':
          // v2.8：就地更新列表里那一行的标题，不必等整表广播（那个也会到，但有先后差）。
          // 会话尚未出现在列表里时（极端时序）什么都不做 —— 广播随后会把它补上。
          set((s) => ({
            sessions: s.sessions.map((m) =>
              m.id === event.rootId ? { ...m, title: event.title } : m
            )
          }))
          break
        case 'session_bound':
          // v2.12：本轮任务的会话根 ID。新建会话时 root 由主进程 createRoot 产生，
          // 渲染层此前无从得知 —— 消息删除/重新生成都依赖它定位会话树。
          set({ activeRootId: event.rootId })
          break
        case 'plan_reviewed':
          set((s) => ({
            messages: [
              ...s.messages,
              {
                kind: 'system',
                id: nextId(),
                text:
                  event.action === 'approved'
                    ? `方案已批准，转入执行（探索用掉的 ${event.rounds} 轮已补回执行预算）`
                    : event.action === 'revising'
                      ? '方案未获批准，继续修订方案'
                      : '方案未获批准，本轮结束（方案文本已保留在对话里）',
                tone: 'info'
              }
            ]
          }))
          break
        case 'error':
          set((s) => ({
            messages: [
              ...s.messages,
              { kind: 'system', id: nextId(), text: event.message, tone: 'error' }
            ]
          }))
          break
        case 'done': {
          // v2.10：把本轮累计用量与所用模型折进收尾消息 —— 用量行只在这条上渲染。
          // 模型取收尾当刻的活跃档案（切档发生在两轮之间，本轮用的是哪个就是哪个）。
          const profile = activeProfile(get().settings.agent)
          const usage = turnUsage
          turnUsage = EMPTY_TURN_USAGE
          set((s) => ({
            agentRunning: false,
            gate: null,
            // v2.7：任务结束时若还挂着一张提问卡，它已经不可能再被回答（主进程那边
            // 的 Promise 随中止一起 resolve 了）—— 留着就是一张点了没反应的卡
            question: null,
            queueHint: 0,
            queueCount: 0,
            // v2.2：任务收尾卡（完成 / 中止 / 失败 + 耗时），参考任务面板的收尾样式
            messages: [
              ...s.messages,
              {
                kind: 'finish',
                id: nextId(),
                reason: event.reason,
                ms: event.ms,
                usage,
                model: profile.label
              }
            ]
          }))
          break
        }
        default:
          break
      }
    }
  }
}