import { Type, fail, ok, type ToolSpec } from './registry'

/**
 * 附件读取工具（v1.5）。
 *
 * 为什么需要它：用户在输入框导入的配置文件/日志可能有几千行，若全量内联进消息，
 * 上下文会被撑爆且模型注意力被稀释。所以消息里只带「清单 + 前 4000 字符」，
 * 完整内容留在归档目录，由代理按需翻页读取 —— 这也是网络排障时的真实工作方式。
 *
 * 安全：路径必须落在应用自己的附件归档目录内（AttachmentStore.resolve 做 realpath 校验），
 * 因此代理无法借这个工具去读系统里任意文件。
 */

export const readAttachment: ToolSpec<{ path: string; offset?: number; limit?: number }> = {
  name: 'read_attachment',
  description:
    '读取用户导入的附件内容（按行分页）。附件清单与路径在用户消息的「本次附加文件」里给出。' +
    '文本类附件优先用它读取完整内容；已被内联的前若干字符不必重复读。',
  risk: 'read',
  scope: 'local',
  schema: Type.Object(
    {
      path: Type.String({ description: '附件绝对路径（必须是用户消息里给出的路径）' }),
      offset: Type.Optional(Type.Number({ description: '起始行号，从 0 开始，默认 0' })),
      limit: Type.Optional(Type.Number({ description: '读取行数，默认 400，最多 4000' }))
    },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    const d = result.data as { from?: number; to?: number; totalLines?: number } | undefined
    if (!result.ok) return `读取附件失败：${args.path}`
    return `读取附件 ${args.path.split(/[\\/]/).pop() ?? args.path} 第 ${d?.from ?? 0}-${d?.to ?? 0} 行（共 ${d?.totalLines ?? '?'} 行）`
  },
  handler: async (args, ctx) => {
    const t0 = Date.now()
    const res = await ctx.attachments.readText(args.path, args.offset ?? 0, args.limit ?? 400)
    if (!res.ok) {
      return fail('BAD_PARAM', res.error, { ms: Date.now() - t0 })
    }
    return ok(
      {
        path: args.path,
        encoding: res.encoding,
        totalLines: res.totalLines,
        from: res.from,
        to: res.to,
        hasMore: res.truncated,
        text: res.text
      },
      { ms: Date.now() - t0 }
    )
  }
}
