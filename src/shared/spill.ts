/**
 * 工具结果溢出落盘（v2.14）。
 *
 * **要解决的问题**：本仓对超大工具结果的处理是「保头 60% + 保尾 40%，中段丢弃，
 * 提示模型换个更精确的命令重取」。这个提示在 eNSP 场景下经常不成立 ——
 * 分页 `---- More ----` 已被通信层消费、视图栈状态会变、`display` 重跑结果未必一致、
 * 配置类回显更不能重取。结果是：**那截中段对模型和用户都永久消失了**
 * （`smallToolData` 的 8000 字符闸门还会让界面连 `data` 都拿不到）。
 *
 * **做法**：把完整结果归档成一个**行可寻址**的文本文件，模型侧给 head + 定位符 + tail，
 * 需要中段时用 `read_attachment` 按行翻页读回来（机制取自 dsh 的 spill-policy）。
 *
 * **为什么必须是行可寻址**：`read_attachment` 是**按行**分页的，且单行超过
 * `READ_MAX_LINE_CHARS`(2000) 会被截断。而 `JSON.stringify(result)` 会把回显里的换行
 * 全部转义成 `\n`，把一份几十行的配置压成**一整行** —— 那种文件翻页永远翻不到中段。
 * 所以这里不走 JSON，而是逐字段展开：字符串里的真实换行原样落行。
 *
 * 纯函数，不碰 fs、不读时钟（时间由调用方传入），因此可以被直接单测。
 */

/** 归档文件的标题行（模型读回时先看到它，说明这是什么、怎么读） */
export const SPILL_HEADER_TITLE = '# 工具结果完整输出（溢出归档）'

/**
 * 单行字符上限。
 *
 * 取 `READ_MAX_LINE_CHARS`(2000) 的一半：落盘的**唯一目的**就是「能被逐行读回来」，
 * 留足余量比榨满一行的容量重要得多。超过这个长度的行会被硬折行，
 * 连续若干行首尾相接即为原行（约定写在文件头里）。
 */
export const SPILL_MAX_LINE_CHARS = 1000

/** 缩进单位（字段层级用两格，字符串正文的续行再加一层，便于与字段行区分） */
const INDENT = '  '

export interface SpillDumpMeta {
  /** 工具名（写进文件头，读回时知道这是哪次调用） */
  toolName: string
  /** 调用 id（同一轮里可能有多次同类调用） */
  callId: string
  /** 归档时间戳（毫秒）。由调用方传入 —— 纯函数不读时钟，测试才能断言稳定输出 */
  at: number
}

function isPlainObjectLike(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

/**
 * 逐字段展开：`路径: 值`。
 * - 字符串含换行 → 换行处真的落行（这是整个模块存在的理由）；
 * - 其它标量 → 内联；
 * - 对象 / 数组 → 递归，路径用 `.key` / `[i]` 拼接。
 */
function writeValue(pathText: string, value: unknown, depth: number, out: string[]): void {
  const pad = INDENT.repeat(depth)
  if (typeof value === 'string') {
    if (value.includes('\n')) {
      out.push(`${pad}${pathText}:`)
      for (const line of value.split('\n')) out.push(`${pad}${INDENT}${line}`)
    } else {
      out.push(`${pad}${pathText}: ${value}`)
    }
    return
  }
  if (!isPlainObjectLike(value)) {
    // 纯函数不引 JSON 之外的东西；undefined / 函数等进不来（工具结果来自 JSON 往返）
    out.push(`${pad}${pathText}: ${JSON.stringify(value)}`)
    return
  }
  const isArray = Array.isArray(value)
  const entries: Array<[string, unknown]> = isArray
    ? value.map((item, i) => [String(i), item] as [string, unknown])
    : Object.entries(value)
  if (entries.length === 0) {
    out.push(`${pad}${pathText}: ${isArray ? '[]' : '{}'}`)
    return
  }
  out.push(`${pad}${pathText}:`)
  for (const [key, child] of entries) {
    writeValue(isArray ? `${pathText}[${key}]` : `${pathText}.${key}`, child, depth + 1, out)
  }
}

/** 把超长行硬折行（拼接即原行，约定写在文件头里） */
function wrapLongLines(lines: readonly string[]): string[] {
  const out: string[] = []
  for (const line of lines) {
    if (line.length <= SPILL_MAX_LINE_CHARS) {
      out.push(line)
      continue
    }
    for (let i = 0; i < line.length; i += SPILL_MAX_LINE_CHARS) {
      out.push(line.slice(i, i + SPILL_MAX_LINE_CHARS))
    }
  }
  return out
}

/**
 * 把一次工具结果渲染成归档文件正文。
 *
 * 输出是**行可寻址**的纯文本（这也是它不能直接用 `JSON.stringify` 的原因）。
 */
export function renderSpillDump(result: unknown, meta: SpillDumpMeta): string {
  const body: string[] = []
  writeValue('result', result, 0, body)
  const header = [
    SPILL_HEADER_TITLE,
    `# 工具: ${meta.toolName} | 调用: ${meta.callId} | 归档时间: ${new Date(meta.at).toISOString()}`,
    '# 格式: 每行「字段路径: 值」；字符串里的换行按原文展开（缩进两格）。',
    `# 超过 ${SPILL_MAX_LINE_CHARS} 字符的行被硬折行 —— 连续若干行首尾相接即为原来的那一行。`
  ]
  return [...header, '', ...wrapLongLines(body)].join('\n') + '\n'
}

/**
 * 归档路径在定位符里的标记文案。
 *
 * 识别（`extractSpillPath`）与生成（`spillLocatorNotice` / `repruneLocatorNotice`）
 * 共用同一个常量 —— 两处各写一遍文案，改一处就会让「认得出来」静默失效，
 * 而失效的表现是「压缩时把定位符切掉了却没人发现」。
 */
const SPILL_PATH_LABEL = '**完整内容已归档**：'

/** 定位符里那一行「完整内容已归档：<path>」 */
function spillLocatorLabel(path: string): string {
  return `${SPILL_PATH_LABEL}${path}`
}

/**
 * 从一段文本里认出溢出归档的路径；没有归档过则返回 null。
 *
 * 关键用途：L1.5 重剪（`planToolResultReprune`）**只允许动带定位符的结果** ——
 * 定位符在，说明完整原文在磁盘上、中段随时可取回，重剪只是「换一份更短的视图」；
 * 没有定位符的结果从没被归档过，重剪就是真丢数据。
 */
export function extractSpillPath(text: string): string | null {
  const at = text.indexOf(SPILL_PATH_LABEL)
  if (at < 0) return null
  const rest = text.slice(at + SPILL_PATH_LABEL.length)
  const end = rest.indexOf('\n')
  const path = (end < 0 ? rest : rest.slice(0, end)).trim()
  return path || null
}

/**
 * 归档后的定位符（插在 head 与 tail 之间，替换 `truncateToolResult` 的默认文案）。
 *
 * 措辞刻意避开「重新获取」：归档里**就是**这一次的完整输出，
 * 让模型重跑一遍既可能拿到不一样的结果（display 类），也可能是不能重取的操作。
 */
export function spillLocatorNotice(path: string, totalChars: number, omittedChars: number): string {
  return (
    `\n\n…（本条结果共 ${totalChars} 字符，中段 ${omittedChars} 字符已省略。` +
    `${spillLocatorLabel(path)}\n` +
    '用 read_attachment 按行翻页读它（offset/limit，默认每页 400 行），' +
    '先看文件头的字段格式说明再翻页。不要重跑同一条命令 —— 归档里就是这一次的完整输出。）\n\n'
  )
}

/**
 * L1.5 重剪用的定位符（E，v2.14）。
 *
 * 与首次截断的文案刻意不同：首次截断时「已归档」是**新信息**；重剪时这条结果
 * 早就带着上一版定位符进过上下文了，再说一遍「完整内容已归档」等于复读。
 * 这里要说清的是「**又**省了一次、原文仍在原处」，并**重新给出路径** ——
 * 而上一版定位符恰好落在这次被切掉的中间段里。
 */
export function repruneLocatorNotice(path: string, omittedChars: number): string {
  return (
    `\n\n…（压缩时又省略了本条回显中间的 ${omittedChars} 字符。` +
    `${spillLocatorLabel(path)}\n` +
    '需要中段时用 read_attachment 按行翻页读它 —— 归档里始终是**完整**的那一份。）\n\n'
  )
}
