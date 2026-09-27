import { Type, fail, ok, type ToolSpec } from './registry'
import { formatBytes } from '@shared/attachments'
import { MAX_IMAGE_BYTES, MODEL_IMAGE_MIMES, modelImageGate } from '@shared/image-attach'
import { activeProfile } from '@shared/profiles'
import { readImageForModel } from '../core/attachments/image'

/**
 * `read_image`（v2.22，F17）—— 把受管目录里的一张图片**本身**交给模型。
 *
 * 对标 deepseek-harness 的同名工具，四件事逐条对齐：
 *
 * ① **能力闸门在最前面**（`assertImageCapableRoute` 的等价物）。pi-ai 对
 *    `model.input` 不含 `image` 的模型会在适配层**静默丢弃**图片块 —— 于是
 *    「读到了但模型没看见」会表现成「模型反复重试同一个调用」，是最难查的一类故障。
 *    所以在读盘之前就按当前档案的能力拒绝，并给出可执行的出路（换模型 / 开开关）。
 * ② **沙箱与 read_attachment 同界**：只认附件归档目录 + 导出目录
 *    （`AttachmentStore.resolveReadable`，realpath 前后各校验一次）。
 *    图片不能成为绕过文本读取边界的后门。
 * ③ **以文件签名判格式，不信扩展名**；四种模型可接受格式之外的图片给出「转存」建议。
 * ④ **结果只带元数据，不带 base64**。base64 由运行时在读工具结果时另外取一次
 *    （见 `ReactRuntime.readToolImage`）：把 2MB 的图塞进 `ToolResult.data` 会让
 *    它跟着进会话树的 jsonl 与溢出归档，一份图会被复制进每一次整份重写。
 *
 * 与用户附件图片的分工：用户在输入框导入的图片**已经**随用户消息直接附给模型了，
 * 不需要（也不该）再对本工具读一遍 —— 提示词里写明了这一点。
 */
export const readImage: ToolSpec<{ path: string }> = {
  name: 'read_image',
  description:
    '读取一张图片并把它**本身**交给模型（返回图片像素，不只是路径）。' +
    '支持 PNG / JPEG / WebP / GIF，按文件内容判格式（扩展名不可信）。' +
    '用途：用户导入的截图、导出目录里的拓扑图、抓包/界面截图、参考图等需要“看”的文件。' +
    `限制：单张不超过 ${formatBytes(MAX_IMAGE_BYTES)}、单边不超过 8000px、总像素不超过 3200 万；` +
    '超过会明确报错，请先裁剪或压缩再读，**不要**为此安装图像库或自己写缩略图脚本。' +
    '只接受可读目录内的路径（附件归档目录与导出目录），其它位置一律拒绝；' +
    '路径在用户消息的「本次附加文件」里给出。' +
    '注意：用户随消息导入的图片若已直接附给你（提示词里会写明），**不要再调本工具读一遍**，' +
    '那会白花一次往返与一份 token；只有当需要按路径重新定位、或图片当时没能附上时才用它。' +
    '本工具要求当前模型支持图片输入；不支持时会在读盘前直接拒绝并说明如何切换。',
  risk: 'read',
  scope: 'local',
  concurrencySafe: true,
  /**
   * 不外露给外部 MCP 客户端：本工具的产物是**图片本身**，而「客户端那头的模型能不能看图」
   * 在这里无法判定（本进程只知道自己的档案）。未知能力即拒绝 —— 否则等于把
   * 「对面模型不支持视觉就 400」的后果交给运气（见 registry.ts#mcpExposed）。
   */
  mcpExposed: false,
  schema: Type.Object(
    {
      path: Type.String({
        description: '图片文件的绝对路径（用户消息里给出的附件路径，或导出类工具返回的路径）'
      })
    },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    const name = args.path.split(/[\\/]/).pop() ?? args.path
    const d = result.data as { width?: number; height?: number; bytes?: number } | undefined
    if (!result.ok) return `读取图片失败：${name}`
    const dim = d?.width && d?.height ? `${d.width}×${d.height}px` : '尺寸未知'
    return `读取图片 ${name}（${dim}${d?.bytes ? `，${formatBytes(d.bytes)}` : ''}）`
  },
  // H（v2.14）：回放时卡片仍需展示「读了哪张图、多大」—— 这是当轮事实，事件流里没有
  presentationMeta: (_args, result) => {
    if (!result.ok) return undefined
    const d = result.data as
      | { path?: string; name?: string; width?: number; height?: number; bytes?: number; mimeType?: string }
      | undefined
    if (!d?.path) return undefined
    return {
      path: d.path,
      name: d.name,
      width: d.width,
      height: d.height,
      bytes: d.bytes,
      mimeType: d.mimeType
    }
  },
  handler: async (args, ctx) => {
    const t0 = Date.now()
    const path = typeof args?.path === 'string' ? args.path.trim() : ''
    if (!path) {
      return fail('BAD_PARAM', 'path 必须是非空字符串（图片的绝对路径）', { ms: Date.now() - t0 })
    }

    // ① 能力闸门 —— 必须在任何磁盘 IO 之前。判错方向也要保守：
    //    未知能力时拒绝（模型看不到图的代价远大于多一次切换模型的提示）。
    const gate = modelImageGate(activeProfile(ctx.settings.agent))
    if (!gate.ok) {
      return fail(gate.code, `${gate.message}（本次未读取任何文件）`, { ms: Date.now() - t0 })
    }

    const res = readImageForModel(ctx.attachments, path, ctx.exportsDir ? [ctx.exportsDir] : [])
    if (!res.ok) {
      return fail(res.code, res.error, { ms: Date.now() - t0 })
    }

    return ok(
      {
        path: res.path,
        name: res.name,
        mimeType: res.mimeType,
        width: res.width,
        height: res.height,
        bytes: res.bytes,
        /**
         * 运行时的「附图约定」载荷（见 `runtime.iface#toolImageRef`）。
         * 放在 `image` 下而不是平铺：它是给运行时看的结构化指令，
         * 与「给模型看的元数据」分开，将来加字段不会互相污染。
         */
        image: {
          path: res.path,
          name: res.name,
          mimeType: res.mimeType,
          width: res.width,
          height: res.height,
          bytes: res.bytes
        },
        note:
          `图片已按 ${res.mimeType} 读取，尺寸 ${res.width || '?'}×${res.height || '?'}px。` +
          `可用格式：${MODEL_IMAGE_MIMES.map((m) => m.replace('image/', '')).join(' / ')}。` +
          '坐标直接按这张图片的像素计（原图未被裁剪或缩放）。'
      },
      { ms: Date.now() - t0 }
    )
  }
}
