import { clipboard, ipcMain } from 'electron'
import { INVOKE } from '@shared/channels'
import { toStr } from './helpers'

/**
 * 剪贴板文字读写（v2.1：会话的「复制 / 粘贴」）。
 *
 * 为什么不经渲染层的 `navigator.clipboard`：
 * - `writeText` 要求文档处于**焦点**，Electron 各版本的授权策略也不一致；
 * - `readText` 需要 clipboard-read 权限（渲染层会走权限请求链路）；
 * - 打包后页面是 `file://`，与开发模式（http://localhost）行为还有差异。
 * 主进程的 `clipboard` 模块没有这些门槛，且行为在两种模式下完全一致 ——
 * 渲染层那两个按钮因此只需要「调通道」一件事。
 *
 * 边界：只做**纯文本**。富文本/HTML 剪贴板与「粘贴截图」不在这里 ——
 * 后者要把位图落成临时文件再走附件归档（AttachmentStore），属另一件事；
 * 剪贴板里的图片目前由渲染层给出明确提示，不做静默忽略。
 *
 * 校验纪律（ARCHITECTURE §3.2）：写入内容按字符串收敛，非字符串一律当空，
 * 不把渲染层传来的任意值直接塞给 Electron。
 */
export function registerClipboardIpc(): void {
  ipcMain.handle(INVOKE.clipboardReadText, async () => ({ text: clipboard.readText() }))

  ipcMain.handle(INVOKE.clipboardWriteText, async (_e, args: { text?: unknown } = {}) => {
    const text = toStr(args?.text)
    if (!text) return { ok: false }
    clipboard.writeText(text)
    return { ok: true }
  })
}
