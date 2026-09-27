import type { ToolSpec } from './registry'
import {
  connectDevice,
  disconnectDevice,
  listDevices,
  renameDevice,
  scanDevices,
  sshConnect,
  sshList
} from './device'
import {
  answerDevicePrompt,
  diffWithSnapshot,
  getDeviceContext,
  listSnapshots,
  runShowCommand,
  saveConfigSnapshot
} from './command'
import { applyConfig, restoreSnapshot, saveConfiguration, verifyExpectation } from './config'
import { findTopologyFilesTool, getTopology, importTopologyFile, refreshTopology, saveTopoFile } from './topology'
import { exportSessionReport, listSessions } from './sessions'
import { analyzeReferenceConfigs } from './reference'
import { verifyConnectivity, verifyDhcp, verifyEthTrunk, verifyArp, verifyNat, verifyPing, verifyRoute } from './verify'
import { readAttachment } from './attachments'
import { batchConfigure, executeTask } from './tasks'
import { autoDiscoverDevices, registerDevice, unregisterDevice } from './register'
import { exportLabGuide } from './lab'
import { listLabTemplates, runLabTemplate } from './lab-template'
import { collectDeviceDiagnostics } from './diagnose'
import { exportChangeReport } from './changes'
import { askUserQuestion, todoWrite } from './interaction'
import { lookupVrpCommand } from './vrp-knowledge'
import { planExperiment } from './experiment'
import { checkExperiment } from './check'
import { rollbackTask } from './rollback-task'
import { readImage } from './image'

/**
 * 注册的工具集。
 *
 * 按版本分期注册，不一次性把全部工具塞给模型 ——
 * v0.1 只读 10 个；v0.2 追加 config.* 4 个；v0.3 追加 topology.* 2 个；v0.4 追加 session.* 2 个；
 * v1.0 前置追加 import_topology_file（F-5.2）；v1.1 追加 save_topo_file（F-5.7 写回）。
 * v1.2（ensp-mcp 学习）追加 find_topology_files / analyze_reference_configs / verify_ping /
 *   verify_connectivity / verify_dhcp。token 预算保持低位。
 * v1.5 追加 read_attachment（读取用户导入的附件；外部 MCP 工具不在这个静态表里，
 *   它们在运行期由 core/mcp/tools.ts 动态并入）。
 * v1.8（ensp-mcp + ensp-skills 学习）追加 任务级封装与批量、设备注册模式、备课文档：
 *   execute_task / batch_configure / register_device / auto_discover_devices /
 *   unregister_device / export_lab_guide。
 * v2.22（F17）追加 read_image（把图片本身交给模型；要求模型声明图片输入能力，
 *   沙箱边界与 read_attachment 一致，不外露给外部 MCP 出口）。
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
  // D2（2026-09-23）：[Y/N] 挂起后唯一可用的应答通道（risk danger，过闸门）
  answerDevicePrompt,
  getTopology,
  refreshTopology,
  importTopologyFile,
  saveTopoFile,
  findTopologyFilesTool,
  analyzeReferenceConfigs,
  verifyPing,
  verifyConnectivity,
  verifyDhcp,
  verifyRoute,
  verifyArp,
  verifyNat,
  verifyEthTrunk,
  collectDeviceDiagnostics,
  listSessions,
  exportSessionReport,
  readAttachment,
  // v2.22：图片读取（与 read_attachment 同一沙箱口径；仅当本轮模型声明支持图片输入时可用）
  readImage,
  executeTask,
  batchConfigure,
  registerDevice,
  autoDiscoverDevices,
  unregisterDevice,
  exportLabGuide,
  listLabTemplates,
  runLabTemplate,
  // v2.0：SSH 连接与自动化
  sshConnect,
  sshList,
  // v2.7：轮内交互（结构化提问 / 可见任务清单）
  askUserQuestion,
  todoWrite,
  // v2.12（F1）：VRP 命令知识库（防幻觉，纯本地查询）
  lookupVrpCommand,
  // v2.12（F4）：实验规划（拓扑+目标 → execute_task 参数包，纯只读）
  planExperiment,
  // v2.12（F7）：实验验收检查（目标清单 → 逐项 ✔/✘ + 证据，纯只读，不打分）
  checkExperiment,
  // v2.12（F5）：一键整体回滚（任务快照清单 → 单次闸门 + 逐台回滚）
  rollbackTask,
  // v2.20：设备配置命令报告导出（只读变更记录 → 实验交付物 markdown）
  exportChangeReport
] as readonly ToolSpec[]

export function toolMap(): Map<string, ToolSpec> {
  return new Map(TOOLS.map((t) => [t.name, t]))
}
