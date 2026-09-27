import { Type, fail, ok, type ToolSpec } from './registry'

/**
 * 附件 / 导出文件读取工具（v1.5；v2.2 起也读导出目录）。
 *
 * 为什么需要它：用户在输入框导入的配置文件/日志可能有几千行，若全量内联进消息，
 * 上下文会被撑爆且模型注意力被稀释。所以消息里只带「清单 + 前 4000 字符」，
 * 完整内容留在归档目录，由代理按需翻页读取 —— 这也是网络排障时的真实工作方式。
 *
 * 安全：路径必须落在应用自己的受管目录内 —— 附件归档目录，或导出目录
 * （`AttachmentStore.resolveReadable` 做 realpath 校验），
 * 因此代理无法借这个工具去读系统里任意文件。
 *
 * v2.2（2026-09-25 实测）：只认附件归档时，代理用 export_session_report 导出报告、
 * 拿到路径后**读不回来**（这是它唯一的文本读取工具），只能绕路去连拓扑文件并覆盖掉
 * activeTopology。导出目录与应用同属受管目录，读它不新增越界风险。
 */

export const readAttachment: ToolSpec<{ path: string; offset?: number; limit?: number }> = {
  name: 'read_attachment',
  description:
    '读取文件正文（按行分页）：用户导入的附件、**应用导出目录里的文件**' +
    '（export_session_report / export_lab_guide / save_topo_file 等返回的路径），' +
    '或**工具结果溢出归档**——某条大回显被截断时，那条消息里会给出 spills/ 下的完整归档路径，' +
    '用本工具按行翻页就能读到被省略的中段（此时**不要重跑原命令**，归档里就是那一次的完整输出）。' +
    '附件清单与路径在用户消息的「本次附加文件」里给出。' +
    '文本类附件优先用它读取完整内容；文档类会自动抽取成文本并可用同一套 offset/limit 翻页：' +
    'PDF、Word（.docx/.doc）、Excel（.xlsx）、PowerPoint（.pptx）、ODF（.odt/.ods/.odp）、RTF —— ' +
    '抽取只保文字与段落/表格边界，版式与图片不保留。' +
    '每次返回有上限：单行超长会截断（正文里标注），整页正文约 10 KB 封顶。' +
    '返回的 nextOffset 是下一页起点、atEnd 表示已到文件末尾、truncatedByBytes 表示本页被体积上限截断；' +
    '未读完时用 offset=nextOffset 续读，**不要从头重读，也不要反复翻同一页**。' +
    '图片、压缩包、加密文档、老式 .xls/.ppt 读不了，会返回明确原因；' +
    '受管目录之外的路径一律拒绝（别拿它当通用文件读取工具）。',
  risk: 'read',
  scope: 'local',
  concurrencySafe: true,
  schema: Type.Object(
    {
      path: Type.String({
        description: '文件绝对路径（用户消息里给出的附件路径，或导出类工具返回的路径）'
      }),
      offset: Type.Optional(Type.Number({ description: '起始行号，从 0 开始，默认 0' })),
      limit: Type.Optional(Type.Number({ description: '读取行数，默认 400，最多 4000' }))
    },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    const d = result.data as
      | { from?: number; to?: number; totalLines?: number; formatLabel?: string; atEnd?: boolean }
      | undefined
    const name = args.path.split(/[\\/]/).pop() ?? args.path
    if (!result.ok) return `读取失败：${args.path}`
    const from = d?.from ?? 0
    const to = d?.to ?? 0
    // v2.13：to 是**左闭右开**区间的右端，展示要减 1（旧实现当成闭区间，显示行数偏 1）
    const range = to > from ? `第 ${from}-${to - 1} 行` : `第 ${from} 行起无内容`
    return `读取 ${name}${d?.formatLabel ? `（${d.formatLabel} 抽取）` : ''} ${range}（共 ${d?.totalLines ?? '?'} 行${d?.atEnd === false ? `，未完，nextOffset=${to}` : ''}）`
  },
  handler: async (args, ctx) => {
    const t0 = Date.now()
    const res = await ctx.attachments.readText(args.path, args.offset ?? 0, args.limit ?? 400, {
      // 导出目录在设置里可自定义，取 ctx 的实时值（buildContext 每轮重建）
      extraRoots: ctx.exportsDir ? [ctx.exportsDir] : []
    })
    if (!res.ok) {
      // v2.1：把失败原因**原样带出来**（NOT_TEXT / PDF_ENCRYPTED / DOC_UNREADABLE…）——
      // 旧实现一律报 BAD_PARAM，代理会以为是自己参数写错，于是对着读不了的文件反复重试
      return fail(res.code, res.error, { ms: Date.now() - t0 })
    }
    return ok(
      {
        path: args.path,
        encoding: res.encoding,
        totalLines: res.totalLines,
        from: res.from,
        to: res.to,
        hasMore: res.truncated,
        // v2.13：续读元数据排在 text 之前 —— 工具结果后续会被 truncateToolResult 做
        // 「保头 60% + 保尾 40%」截断，元数据只有落在头部才能在模型手里存活
        nextOffset: res.nextOffset,
        atEnd: res.atEnd,
        truncatedByBytes: res.truncatedByBytes,
        ...(res.format ? { format: res.format } : {}),
        ...(res.formatLabel ? { formatLabel: res.formatLabel } : {}),
        ...(res.note ? { note: res.note } : {}),
        text: res.text
      },
      { ms: Date.now() - t0 }
    )
  }
}
