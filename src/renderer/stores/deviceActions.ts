/**
 * 设备域 actions（T5.8 拆分 —— 自 app.ts 原样搬移，无行为变化）。
 */
import type { DeviceId } from '@shared/types'
import type { SshConnectInput, TerminalClosedPayload } from '@shared/api'
import type { AppState, SliceGet, SliceSet } from './appState'
import { nextId, sortDevices } from './storeUtil'

export function deviceActions(
  set: SliceSet,
  get: SliceGet
): Pick<
  AppState,
  | 'refreshDevices'
  | 'scan'
  | 'connect'
  | 'connectSsh'
  | 'connectAll'
  | 'disconnect'
  | 'rename'
  | 'forgetDevice'
  | 'setActiveDevice'
  | 'setTab'
  | 'markTerminalClosed'
  | 'bumpTerminalQueue'
  | 'setConnectedIds'
> {
  return {
    async refreshDevices() {
      const devices = await window.api.device.list()
      set({
        devices: sortDevices(devices),
        connectedIds: devices.filter((d) => d.connected).map((d) => d.id)
      })
    },

    async scan() {
      const { settings } = get()
      set({ scanning: true, scanError: null, scanProgress: { scanned: 0, total: 0, found: 0, done: false } })
      try {
        await window.api.device.scan(settings.scanStart, settings.scanEnd)
        await get().refreshDevices()
      } catch (e) {
        set({ scanError: e instanceof Error ? e.message : String(e) })
      } finally {
        set({ scanning: false })
      }
    },

    async connect(port) {
      try {
        const d = await window.api.device.connect(port)
        set({ activeDeviceId: d.id, activeTab: 'terminal' })
        await get().refreshDevices()
      } catch (e) {
        set({ scanError: e instanceof Error ? e.message : String(e) })
      }
    },

    /** v2.0：SSH 连接（已存凭据或直接填主机与认证）；成功后聚焦到终端。错误上抛由调用方展示 */
    async connectSsh(input: SshConnectInput) {
      const d = await window.api.device.ssh.connect(input)
      set({ activeDeviceId: d.id, activeTab: 'terminal' })
      await get().refreshDevices()
    },

    async connectAll() {
      // SSH 设备不能按端口批量连（凭据在用户保存的连接里），只批量 telnet
      const targets = get().devices.filter((d) => !d.connected && d.transport !== 'ssh')
      if (targets.length === 0 || get().connectAllProgress) return
      const total = targets.length
      const queue = [...targets]
      set({ connectAllProgress: { total, done: 0, ok: 0 } })
      let done = 0
      let ok = 0
      const failures: string[] = []
      const worker = async (): Promise<void> => {
        for (;;) {
          const d = queue.shift()
          if (!d) return
          try {
            await window.api.device.connect(d.port, d.name)
            ok++
            // 有连接成功且当前没有激活设备时，自动聚焦到第一个成功的设备
            if (get().activeDeviceId === null) set({ activeDeviceId: d.id })
          } catch (e) {
            failures.push(`:${d.port}（${e instanceof Error ? e.message : String(e)}）`)
          }
          done++
          set({ connectAllProgress: { total, done, ok } })
        }
      }
      // 小并发池，避免几十台设备同时握手；同一端口不会并发（targets 已按设备去重）
      await Promise.all(Array.from({ length: Math.min(4, total) }, worker))
      await get().refreshDevices()
      set({ connectAllProgress: null })
      if (failures.length > 0) {
        set({ scanError: `一键连接完成：成功 ${ok}/${total}，失败 ${failures.length}${failures[0]}` })
      }
    },

    async disconnect(deviceId: DeviceId) {
      await window.api.device.disconnect(deviceId)
      const remaining = get().devices.filter((d) => d.id !== deviceId && d.connected)
      set((s) => ({
        activeDeviceId: s.activeDeviceId === deviceId ? (remaining[0]?.id ?? null) : s.activeDeviceId
      }))
      await get().refreshDevices()
    },

    async rename(deviceId: DeviceId, name: string) {
      await window.api.device.rename(deviceId, name)
      await get().refreshDevices()
    },

    async forgetDevice(deviceId: DeviceId) {
      await window.api.device.forget(deviceId)
      set((s) => ({
        activeDeviceId: s.activeDeviceId === deviceId ? null : s.activeDeviceId,
        connectedIds: s.connectedIds.filter((id) => id !== deviceId)
      }))
      await get().refreshDevices()
    },

    setActiveDevice(deviceId: DeviceId | null) {
      set({ activeDeviceId: deviceId })
    },

    setTab(tab) {
      set({ activeTab: tab })
    },

    markTerminalClosed({ deviceId, reason }: TerminalClosedPayload) {
      set((s) => {
        // v1.8：提示里用设备名而非 deviceId（形如 127.0.0.1:2000），更可读
        const dev = s.devices.find((d) => d.id === deviceId)
        const label = dev?.name ?? deviceId
        return {
          connectedIds: s.connectedIds.filter((id) => id !== deviceId),
          messages: [
            ...s.messages,
            { kind: 'system', id: nextId(), text: `设备 ${label} 连接已断开：${reason}`, tone: 'error' }
          ]
        }
      })
      void get().refreshDevices()
    },

    bumpTerminalQueue(n: number) {
      set({ terminalQueueHint: n })
    },

    setConnectedIds(ids: string[]) {
      set({ connectedIds: ids })
    }
  }
}