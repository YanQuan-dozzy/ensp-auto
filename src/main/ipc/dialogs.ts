import { dialog, type BrowserWindow, type OpenDialogOptions } from 'electron'

/**
 * 调用点常用 `as const` 声明 properties（为了拿到字面量类型），
 * 那会得到 readonly 元组 —— 与 Electron 的可变数组类型不兼容，这里显式放宽。
 */
export type OpenDialogArgs = Omit<OpenDialogOptions, 'properties'> & {
  properties?: OpenDialogOptions['properties'] | readonly NonNullable<OpenDialogOptions['properties']>[number][]
}

/**
 * 原生文件选择框的统一点（T5.3）。
 *
 * 每个调用点都写一遍 `win ? dialog.showX(win, opts) : dialog.showX(opts)` 的后果是：
 * 有人忘了取 `getWindow()` 就变成非模态（对话框跑到主窗口后面，用户以为卡死），
 * 有人把 opts 对象直接复用又踩到 Electron 会改写入参的坑。
 * 收敛到这里之后，调用点只需关心「要什么筛选与标题」。
 */

/** 取父窗口失败时退回无父窗口调用，保证对话框一定能弹出来 */
export async function showOpenDialogSafe(
  win: BrowserWindow | null,
  opts: OpenDialogArgs
): Promise<{ canceled: boolean; filePaths: string[] }> {
  // 深拷贝 opts：Electron 会按平台规则就地改写/规范化这些字段，
  // 复用同一个对象字面量会在第二次调用时出现「筛选条件消失了」这类怪象
  const safe = {
    ...opts,
    ...(opts.properties ? { properties: [...opts.properties] } : {})
  } as OpenDialogOptions
  return win ? dialog.showOpenDialog(win, safe) : dialog.showOpenDialog(safe)
}

/** 选单个目录（7 处调用里最常见的形态之一） */
export async function pickDirectory(
  win: BrowserWindow | null,
  title: string
): Promise<string | null> {
  const r = await showOpenDialogSafe(win, { title, properties: ['openDirectory'] })
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
}
