/**
 * 通信层全部正则与常量的集中地。
 *
 * TELNET-SPEC.md 明确要求：所有模式集中在一处，
 * 因为 eNSP 各版本模拟的 VRP 行为可能有差异，实测校准只改这个文件。
 */

export const DEFAULT_HOST = '127.0.0.1'

export interface TelnetOptions {
  /** 单条命令总时限（含分页续读） */
  timeoutMs: number
  /** 静默兜底窗口：距上次收到数据超过该值即认为输出结束 */
  quietMs: number
  /**
   * 停顿兜底窗口。
   *
   * 为什么还需要这个：设备回显命令之后可能停顿一下才开始吐输出
   * （display current-configuration 这类尤其明显）。此时缓冲区里只有回显行、
   * 没有内容也没有提示符，若仅凭 quietMs 就会把命令判成提前结束。
   * 因此弱判定要求「已有内容且以换行收尾」，否则继续等到 stallMs。
   */
  stallMs: number
  /** 单条命令输出上限 */
  maxBytes: number
  /** >0 时逐字符发送并延迟，用于兼容对输入速率敏感的设备 */
  charDelayMs: number
  /** 单条命令允许的分页续读次数上限 */
  maxPagingHops: number
  /** 连接后是否主动执行 screen-length 0 temporary 关闭分页 */
  disablePagingOnConnect: boolean
  /** 连接阶段的超时（等待首个提示符） */
  connectTimeoutMs: number
}

export const DEFAULT_TELNET_OPTIONS: TelnetOptions = {
  timeoutMs: 15000,
  quietMs: 300,
  stallMs: 2000,
  maxBytes: 512 * 1024,
  charDelayMs: 0,
  maxPagingHops: 200,
  disablePagingOnConnect: true,
  connectTimeoutMs: 10000
}

// ——————————————————————————————————————————————
// 提示符
// ——————————————————————————————————————————————

/**
 * 从缓冲区尾部匹配提示符。
 * 组：1=前括号 2=内容（可能带 ~ 前缀） 3=后括号
 * 要求提示符位于缓冲区最末（尾部只允许空白），这是「强判定」的基础。
 */
export const PROMPT_TAIL_RE = /(?:^|\n)[ \t]*([<[])([^\n<>[\]]{1,80})([>\]])[ \t]*$/

/** 提示符内容中不允许出现的字符（出现则基本可断定是输出正文而非提示符） */
export const PROMPT_REJECT_RE = /[\s=,;:'"]/

/**
 * 视图关键字表。识别到关键字时，宿主名 = 关键字之前的全部文本。
 * 顺序有意义：接口类必须排在 vlan 之前，否则 Vlanif10 会被误判为 vlan。
 */
export const VIEW_KEYWORDS: ReadonlyArray<{ re: RegExp; view: string }> = [
  {
    re: /(?:^|-)(?:gigabitethernet|ethernet|serial|vlanif|loopback|tunnel|meth|null|pos|virtual-template|inloopback)\d/i,
    view: 'interface'
  },
  { re: /(?:^|-)vlan\d/i, view: 'vlan' },
  { re: /(?:^|-)ospf/i, view: 'ospf' },
  { re: /(?:^|-)acl/i, view: 'acl' },
  {
    re: /(?:^|-)(?:rip|isis|bgp|aaa|ui|user-interface|radius|ip-pool|nat|dhcp|firewall|zone|policy|ike|ipsec|sysname)\b/i,
    view: 'other'
  }
]

// ——————————————————————————————————————————————
// 分页 / 交互确认 / 认证
// ——————————————————————————————————————————————

/** 分页标记，如 "---- More ----"（允许被 ANSI 包裹，故检测前先剥 ANSI） */
export const PAGING_RE = /-{2,}\s*More\s*-{2,}/i

/**
 * 行尾分页标记。设备在等待按键时，缓冲区末尾就是分页标记。
 * 只判尾部（而不是全文搜索）是刻意的：否则每来一点新数据都会重新命中同一处标记，
 * 导致重复发送推进键。
 */
export const PAGING_TAIL_RE = /-{2,}\s*More\s*-{2,}[ \t]*$/i

/** 交互确认提示，如 "[Y/N]:"。命中后绝不自动应答 */
export const CONFIRM_RE = /\[\s*[Yy]\s*\/\s*[Nn]\s*\]\s*[:：]?\s*$/

/** 认证提示 */
export const AUTH_RE = /(?:Username|Password)\s*[:：]\s*$/i

/** 分页推进键（空格推一页） */
export const PAGING_ADVANCE = ' '

// ——————————————————————————————————————————————
// 设备错误
// ——————————————————————————————————————————————

export interface ErrorPattern {
  re: RegExp
  code: string
  meaning: string
}

/**
 * 设备错误模式。全部以行首锚定（多行模式）。
 *
 * 为什么必须锚定行首：`display interface` 之类的正常回显里会出现
 * 「Input error: 0」这类字段。不锚定就会把正常输出判成失败。
 * VRP 的错误信息一律独立成行且以 Error: 开头。
 *
 * 顺序有意义：具体的模式在前，`Error:` 兜底在后。
 */
export const ERROR_PATTERNS: readonly ErrorPattern[] = [
  { re: /^\s*Error:\s*Unrecognized command/im, code: 'UNRECOGNIZED', meaning: '命令不存在' },
  { re: /^\s*%\s*Unrecognized command/im, code: 'UNRECOGNIZED', meaning: '命令不存在' },
  { re: /^\s*Error:\s*Incomplete command/im, code: 'INCOMPLETE', meaning: '命令不完整' },
  { re: /^\s*%\s*Incomplete command/im, code: 'INCOMPLETE', meaning: '命令不完整' },
  { re: /^\s*Error:\s*Ambiguous command/im, code: 'AMBIGUOUS', meaning: '命令有歧义' },
  { re: /^\s*%\s*Ambiguous command/im, code: 'AMBIGUOUS', meaning: '命令有歧义' },
  { re: /^\s*Error:\s*Wrong parameter/im, code: 'BAD_PARAM', meaning: '参数非法' },
  { re: /^\s*%\s*Wrong parameter/im, code: 'BAD_PARAM', meaning: '参数非法' },
  { re: /^\s*Error:\s*Too many parameters/im, code: 'TOO_MANY_PARAMS', meaning: '参数过多' },
  { re: /^\s*%\s*Invalid input detected/im, code: 'INVALID_INPUT', meaning: '输入非法' },
  {
    re: /^\s*Error:\s*The command is being executed,\s*please wait/im,
    code: 'BUSY',
    meaning: '上一条命令尚未执行完'
  },
  { re: /^\s*Error:\s*You do not have permission/im, code: 'NO_PERMISSION', meaning: '权限不足' },
  { re: /^\s*Error:\s*Permission denied/im, code: 'NO_PERMISSION', meaning: '权限不足' },
  { re: /^\s*Error:\s*(?:Failed|Failure)\b/im, code: 'FAILED', meaning: '操作失败' },
  { re: /^\s*Error:\s*\S/im, code: 'FAILED', meaning: '命令执行报错' }
]

/** 含 Warning 但不算失败 */
export const WARNING_RE = /^\s*Warning:/im

/** 错误定位标记行（单独一个 ^），与上一条错误配合指认位置 */
export const CARET_MARKER_RE = /^\s*\^+\s*$/m

// ——————————————————————————————————————————————
// 清洗
// ——————————————————————————————————————————————

/** Telnet IAC = 0xFF */
export const IAC = 0xff

/** ANSI CSI / OSC / 单字符转义 */
export const ANSI_CSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
export const ANSI_OSC_RE = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g
export const ANSI_SINGLE_RE = /\u001b[@-Z\\-_]/g

/** 解码失败时出现的替换符 */
export const REPLACEMENT_CHAR = '\uFFFD'
