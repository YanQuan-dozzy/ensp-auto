/**
 * 一轮收尾的底部操作栏文案与提示词（v2.10，P6）—— 纯函数，供 UI 与单测共用。
 *
 * 为什么单独成模块：这四个动作里有三个（重试 / 发散思考 / 导出报告）都要**拼一段文本
 * 或调一个 IPC**，最容易在两处（TurnCompleteBanner 与 FinalResponseView）各写一遍
 * 然后慢慢长歪。文案本身就是协议的一部分（发散思考的提示词决定模型怎么答），
 * 抽出来单测住，改的时候只改一处。
 */

/** 底部操作栏的动作标识 */
export type TurnFooterAction = 'retry' | 'copy' | 'export' | 'diverge'

export interface TurnFooterItem {
  action: TurnFooterAction
  /** 按钮文案 */
  label: string
  /** hover 提示（同时给屏幕阅读器用） */
  title: string
}

/**
 * 操作栏按钮清单与顺序。
 *
 * 顺序即主次：重试（失败时最需要）→ 复制回答（最常用）→ 导出报告（交付物）→
 * 发散思考（本项目特有，探索下一步）。导出与发散是 el-hide-sm 在窄屏折叠的目标。
 */
export const TURN_FOOTER_ITEMS: TurnFooterItem[] = [
  { action: 'retry', label: '重试', title: '用上一条指令重新执行这一轮' },
  { action: 'copy', label: '复制回答', title: '复制本轮最终回答' },
  { action: 'export', label: '导出报告', title: '把本会话导出为 Markdown 报告' },
  { action: 'diverge', label: '发散思考', title: '基于本轮结论，让代理给出下一步可探索的方向' }
]

/**
 * 「发散思考」真正发给模型的那句话。
 *
 * 为什么要写这么具体：只说「发散思考」模型会给一堆泛泛的建议。这里把约束写死 ——
 * **基于已经落地的结论**、**给可执行的方向**、**不要再重复已经做过的事**，
 * 才能得到能直接接着干的东西（正是本项目「扫描→连接→配置→验证」之外最缺的一环）。
 */
export function buildDivergePrompt(topic: string): string {
  const t = topic.trim()
  const head = t ? `结合刚才的结论（${t}）` : '结合刚才这轮任务的结论'
  return (
    `${head}，发散思考下一步还有哪些值得探索的方向。要求：\n\n` +
    '1. 至少给出 3 个方向，每个方向一句话说清「做什么」和「为什么值得做」；\n' +
    '2. 只列**还没做过**的事，已经完成/已经验证过的不算；\n' +
    '3. 优先给**在本项目能力范围内可执行**的方向（能落到扫描/连接/配置/验证/报告这些动作上）；\n' +
    '4. 如果某个方向有风险或依赖前置条件，顺带标出来。\n\n' +
    '不要现在执行，只给方向和理由。'
  )
}

/**
 * 从会话消息里取「本轮的用户指令」—— 用于「重试」。
 *
 * 取**最后一条 user 消息**：本轮必然由它触发，重试就是把它再发一次。
 * 找不到（例如回溯打开的历史会话）时返回 null，按钮据此禁用。
 *
 * 注意要**剥掉附件摘要后缀**：气泡里那句 `📎 a、b` 只是给人看的（见 `send()`），
 * 它不是指令的一部分；原样重发等于告诉模型有两个附件，而附件其实并不随重试再带上。
 */
export function lastUserInstruction(
  messages: Array<{ kind: string; text?: string }>
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.kind === 'user' && typeof m.text === 'string' && m.text.trim()) {
      const stripped = m.text.split(/\n\n📎 /)[0]!.trim()
      return stripped || null
    }
  }
  return null
}
