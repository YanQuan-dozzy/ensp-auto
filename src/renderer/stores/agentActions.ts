/**
 * 代理会话 / 附件 / MCP 客户端 / 闸门域 actions（T5.8 拆分 —— 自 app.ts 原样搬移，无行为变化）。
 */
import type { GateDecision } from '@shared/types'
import type { AgentEventPayload } from '@shared/api'
import type { AppState, SliceGet, SliceSet } from './appState'
import { SESSION_ID, errText, mergeAttachments, nextId, rejectionText, systemNote } from './storeUtil'

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
  | 'abort'
  | 'setShortcutRecording'
  | 'noteSystemMessage'
  | 'resolveGate'
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
      const bubble = attachments.length
        ? `${trimmed}\n\n📎 ${attachments.map((a) => a.name).join('、')}`
        : trimmed

      set((s) => ({
        messages: [...s.messages, { kind: 'user', id: nextId(), text: bubble }],
        agentRunning: true,
        attachments: []
      }))
      try {
        await window.api.agent.run(SESSION_ID, trimmed, {
          rootId: get().activeRootId,
          startNodeId: get().activeStartNodeId,
          attachments
        })
        // 本次已消费回溯起点，后续新消息从会话尾部继续
        if (get().activeStartNodeId) set({ activeStartNodeId: null })
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
      } finally {
        set({ mcpBusy: false })
      }
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

    clearConversation() {
      set({ messages: [], gate: null, queueHint: 0 })
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
                  ...(event.errorCode ? { errorCode: event.errorCode } : {})
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
        case 'error':
          set((s) => ({
            messages: [
              ...s.messages,
              { kind: 'system', id: nextId(), text: event.message, tone: 'error' }
            ]
          }))
          break
        case 'done':
          set({ agentRunning: false, gate: null, queueHint: 0, queueCount: 0 })
          break
        default:
          break
      }
    }
  }
}