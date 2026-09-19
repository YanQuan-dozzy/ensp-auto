import type { ToolSpec } from './registry'
import { connectDevice, disconnectDevice, listDevices, renameDevice, scanDevices } from './device'
import {
  diffWithSnapshot,
  getDeviceContext,
  listSnapshots,
  runShowCommand,
  saveConfigSnapshot
} from './command'
import { applyConfig, restoreSnapshot, saveConfiguration, verifyExpectation } from './config'
import { getTopology, importTopologyFile, refreshTopology } from './topology'
import { exportSessionReport, listSessions } from './sessions'

/**
 * 注册的工具集。
 *
 * 按版本分期注册，不一次性把全部工具塞给模型 ——
 * v0.1 只读 10 个；v0.2 追加 config.* 4 个；v0.3 追加 topology.* 2 个；v0.4 追加 session.* 2 个；
 * v1.0 前置追加 import_topology_file（F-5.2）。token 预算保持低位（约 3300）。
 */
export const TOOLS: readonly ToolSpec[] = [
  scanDevices,
  connectDevice,
  listDevices,
  disconnectDevice,
  renameDevice,
  getDeviceContext,
  runShowCommand,
  saveConfigSnapshot,
  listSnapshots,
  diffWithSnapshot,
  applyConfig,
  verifyExpectation,
  restoreSnapshot,
  saveConfiguration,
  getTopology,
  refreshTopology,
  importTopologyFile,
  listSessions,
  exportSessionReport
] as readonly ToolSpec[]

export function toolMap(): Map<string, ToolSpec> {
  return new Map(TOOLS.map((t) => [t.name, t]))
}
