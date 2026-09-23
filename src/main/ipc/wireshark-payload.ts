import type { WiresharkAvailabilityPayload } from '@shared/api'
import type { WsMcpAvailability } from '../core/wireshark/provision'

/**
 * 把主进程的可用性结论转成渲染层载荷（T5.3）。
 *
 * 过去这段映射在 ipc/index.ts 里抄了三份（探测 / 安装后写缓存 / 手选目录后写缓存），
 * 任何一次字段增删都得记得改三处 —— 漏一处就会出现「刚装完显示缺 tshark」这类怪象。
 */
export function toWiresharkAvailability(
  avail: WsMcpAvailability,
  attached: boolean
): WiresharkAvailabilityPayload {
  return {
    installed: avail.installed,
    usable: avail.usable,
    attached,
    probe: {
      ready: avail.probe.ready,
      canAnalyze: avail.probe.canAnalyze,
      canCapture: avail.probe.canCapture,
      tools: avail.probe.tools,
      suiteDir: avail.probe.suiteDir,
      source: avail.probe.source,
      version: avail.probe.version,
      missing: avail.probe.missing
    },
    reason: avail.reason,
    tsharkDir: avail.probe.suiteDir
  }
}
