import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type { Services } from '../services'
import { registerDeviceIpc } from './device'
import { registerAgentIpc } from './agent'
import { registerTopologyIpc } from './topology'
import { registerSettingsIpc } from './settings'
import { registerMcpIpc } from './mcp'
import { registerWiresharkIpc } from './wireshark'
import { registerEnspIpc } from './ensp'
import { registerSkillsIpc } from './skills'
import { registerAppIpc } from './app'

/**
 * IPC 路由层的装配入口（T5.1：按域拆到同目录的兄弟模块）。
 *
 * 两条纪律（ARCHITECTURE.md §3.2）：
 * 1. 渲染层传入的任何参数都在这里重新校验，绝不信任
 * 2. 本层不含业务逻辑，只做「校验 → 调服务 → 回传」
 *
 * 拆分的理由不是「文件太长不好看」，而是：1100 行里同时躺着设备、代理、设置、
 * Wireshark、窗口控制五件事，改任何一件都要在整文件里找上下文，评审时也看不出
 * 「这次改动只碰了哪个域」。按域拆开后每块 < 300 行，边界一眼可见。
 */
export function registerIpc(services: Services, getWindow: () => BrowserWindow | null): void {
  /** 主进程 → 渲染层的事件推送（统一判窗口存活，避免往已销毁窗口发消息） */
  const emit = (channel: string, payload: unknown): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }

  registerDeviceIpc(services, emit)
  registerAgentIpc(services, getWindow)
  registerTopologyIpc(services, getWindow)
  registerSettingsIpc(services)
  registerMcpIpc(services)
  registerWiresharkIpc(services, getWindow)
  registerEnspIpc(services, getWindow)
  registerSkillsIpc(services, getWindow)
  registerAppIpc(services, getWindow)
}

// 保持既有导入路径可用（index 曾是这些名字的唯一出处）
export { ipcMain }
