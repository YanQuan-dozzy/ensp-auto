/**
 * VRP 报错诊断表 + 下发前静态预检（2026-09-28）。
 *
 * 为什么要有它：`core/knowledge/vrp-commands.ts` 解决的是「配之前先查语法」，
 * 但真实翻车更多发生在**配的当下**——模型把子网掩码塞进 `network`、把全角空格
 * 混进命令、trunk 口忘放行，然后拿到一句 `Error: Wrong parameter found at '^' position.`
 * 就**照着原样重试同一句**（可见的失败信号太弱，不足以让它改方向）。
 *
 * 本模块补上闭环的两端：
 *   ① `VRP_ERROR_GUIDE` —— 设备错误码 → 中文释义 / 常见根因 / 可照做的纠正 / 相关词典主题。
 *      接到 `apply_config` 的失败返回里，让「失败」直接携带修正线索。
 *   ② `preflightCommands` —— 下发**前**对命令集做纯静态反模式扫描（反掩码/掩码互换、
 *      全角字符、trunk 未放行、单臂路由漏 arp broadcast 等），把可预见的翻车提前说出来。
 *
 * 事实来源（2026-09-28 联网校准，官方文档）：
 *   - 华为《解读命令行的错误信息》命令行常见错误信息表（Unrecognized / Wrong parameter /
 *     Incomplete / Too many parameters / Ambiguous 的官方释义）
 *   - 配置 Dot1q 终结子接口（单臂路由：dot1q termination vid + arp broadcast enable）
 *   - 配置 DHCP 中继（dhcp select relay + dhcp relay server-ip）
 *   - 配置 VRRP 主备备份（vrrp vrid / priority / preempt-mode）
 *   - 配置 MSTP（stp mode mstp / region-configuration / instance / active region-configuration）
 *   - 配置 RIP 引入外部路由（import-route）
 *   - 配置接口二三层模式切换（undo portswitch）
 *   - 配置通过 STelnet / Telnet 登录设备（user-interface vty / authentication-mode aaa）
 *
 * 口径：纯数据 + 纯函数，不依赖 Electron、不碰设备，可直接进 harness 测试。
 * 预检结论**一律不拦截**（advisory）—— 静态分析无法知道设备上已有的配置，
 * 误拦一次比漏报一次代价高得多；它的价值是把「可能的坑」摆到模型眼前。
 */

import type { ErrorCode } from '@shared/types'

// ——————————————————————————————————————————————
// ① 错误码 → 诊断引导
// ——————————————————————————————————————————————

export interface VrpErrorGuide {
  /** 错误码。类型钉在 shared 的 ErrorCode 上 —— 写错码名 tsc 直接报错，不会变成永不命中的死条目 */
  code: ErrorCode
  /** 设备报错的中文释义（官方错误信息表的说法） */
  meaning: string
  /** 常见根因，按出现频率排序 */
  causes: string[]
  /** 可照做的纠正动作 */
  fixes: string[]
  /** 相关命令词典主题 id（模型可再用 lookup_vrp_command 深查） */
  topics: string[]
}

/**
 * 全部错误码的诊断表。**必须覆盖 `telnet/patterns.ts#ERROR_PATTERNS` 里出现过的每个 code**
 * —— 有一条设备错误码没有对应引导，那条失败就退化成「只有一句生硬报错」。
 * `tests/unit/vrp-errors.test.mjs` 对此做双向对账。
 */
export const VRP_ERROR_GUIDE: Readonly<Partial<Record<ErrorCode, VrpErrorGuide>>> = {
  UNRECOGNIZED: {
    code: 'UNRECOGNIZED',
    meaning: '命令不存在或该视图下没有这条命令（Error: Unrecognized command found at "^" position.）',
    causes: [
      '当前视图不对：在用户视图敲配置命令，或在接口视图敲系统视图命令',
      '命令拼写/缩写写错，或该设备型号与 VRP 版本不支持这条命令',
      '命令里混进了全角字符或不可见字符（从文档整段复制粘贴最常见）',
      '`^` 指向的位置就是出错处 —— 先看它指在第几个字段上'
    ],
    fixes: [
      '用 change_view 切到正确视图（system / interface）后重发；不要靠猜',
      '对照 lookup_vrp_command 的 syntax 逐字段核对拼写与参数顺序',
      '把命令整句重敲成半角（不要从 Word/网页直接粘贴）',
      '若命令确实属于该设备，用 display version 确认版本是否支持'
    ],
    topics: ['basics', 'interface', 'error_ref']
  },
  INCOMPLETE: {
    code: 'INCOMPLETE',
    meaning: '命令不完整，缺少必要参数（Error: Incomplete command found at "^" position.）',
    causes: [
      '只敲了命令字没跟参数，例如只写 `ip address`、`network`',
      '参数被引号/空格切断，后半截没发出去'
    ],
    fixes: [
      '查 lookup_vrp_command 的 syntax 补齐参数（<> 表示必填，[] 表示可选）',
      '确认命令在同一行内完整发送（不要把一条命令拆成多次调用）'
    ],
    topics: ['error_ref']
  },
  AMBIGUOUS: {
    code: 'AMBIGUOUS',
    meaning: '命令有歧义，缩写不唯一（Error: Ambiguous command found at "^" position.）',
    causes: ['用了过短的命令缩写，匹配到多条命令'],
    fixes: ['把缩写补全到唯一（例如 `dis` 改为 `display`，`int` 改为 `interface`）']
    ,
    topics: ['error_ref']
  },
  BAD_PARAM: {
    code: 'BAD_PARAM',
    meaning: '参数类型错或参数值越界（Error: Wrong parameter found at "^" position.）',
    causes: [
      '反掩码 ↔ 子网掩码写反：`network 10.0.0.0 255.255.255.0`（应为 0.0.0.255）',
      '掩码写成反掩码：`ip route-static 10.0.0.0 0.0.0.255 10.0.12.2`（应为 255.255.255.0）',
      '数值越界：VLAN ID 超出 1~4094、优先级/PID 超范围、掩码位数大于 32',
      '引用了还不存在的对象：未创建 VLAN 就配 Vlanif、未建 ACL 就 nat outbound 引用它'
    ],
    fixes: [
      'wildcard 口诀：子网掩码逐字节做 255-x（255.255.255.0 → 0.0.0.255）',
      '调用 lookup_vrp_command 核对参数取值范围与书写形式（掩码还是前缀长度）',
      '先建被引用对象再引用它（vlan batch → interface Vlanif；acl → nat outbound）'
    ],
    topics: ['ospf', 'acl', 'static_route', 'vlan', 'error_ref']
  },
  TOO_MANY_PARAMS: {
    code: 'TOO_MANY_PARAMS',
    meaning: '参数过多（Error: Too many parameters found at "^" position.）',
    causes: ['把两条命令写在了同一行，或把 IPv6 写法套用到 IPv4 命令上'],
    fixes: ['拆成多条命令分别下发（每条一个调用内用数组按顺序给出即可）']
    ,
    topics: ['error_ref']
  },
  INVALID_INPUT: {
    code: 'INVALID_INPUT',
    meaning: '输入非法（Error: Invalid input detected at "^" marker.）',
    causes: ['该位置不接受这个输入，常见于把地址/掩码写成了非法格式'],
    fixes: ['检查 IP 是否合法（四段各 0~255）、掩码是否为连续点分十进制或 0~32 的前缀长度']
    ,
    topics: ['error_ref']
  },
  BUSY: {
    code: 'BUSY',
    meaning: '上一条命令还在执行（Error: The command is being executed, please wait.）',
    causes: ['前一条命令未返回就发了下一条（本工作台对同一设备严格串行，通常是设备自己慢）'],
    fixes: ['稍等后重试同一条命令；不要把大批命令塞进同一次调用硬冲']
    ,
    topics: ['error_ref']
  },
  NO_PERMISSION: {
    code: 'NO_PERMISSION',
    meaning: '权限不足（Error: You do not have permission / Permission denied.）',
    causes: ['当前用户级别不够（未进入 system-view，或本地用户 privilege level 低于 15）'],
    fixes: [
      '先用 change_view target=system 进系统视图（该动作需要足够级别）',
      '确认登录账号的级别：aaa 视图下 local-user <名> privilege level 15'
    ],
    topics: ['basics', 'device_mgmt']
  },
  FAILED: {
    code: 'FAILED',
    meaning: '设备返回了其它 Error: 开头的失败信息（具体原因看设备原文）',
    causes: [
      '依赖未满足：接口被 shutdown、ip address 与对端不同网段、VLAN 未创建',
      '对象已存在/不存在导致 undo 失败',
      '物理层未 up（eNSP 里多为连线未接或端口未启动）'
    ],
    fixes: [
      '先取证再改：get_device_context / collect_device_diagnostics 看接口双 up、路由、ARP',
      '按「物理层 → 链路层（VLAN/放行）→ 网络层（地址/路由）」逐层排查，不要盲改配置'
    ],
    topics: ['troubleshoot', 'interface', 'vlan']
  },
  TIMEOUT: {
    code: 'TIMEOUT',
    meaning: '命令在时限内没有收到提示符（本层判定，非设备报错）',
    causes: [
      '设备正忙或该命令输出极长（如 display current-configuration）',
      '设备停在需要输入的状态（[Y/N] 提示、分页 More、认证提示）'
    ],
    fixes: [
      '确认没有待应答的 [Y/N]（用 answer_device_prompt 显式应答）',
      '减少一次下发的命令条数；超大回显改用带 limit 的采集工具'
    ],
    topics: ['basics', 'error_ref']
  },
  ABORTED: {
    code: 'ABORTED',
    meaning: '命令被中断（用户中止任务或上层取消信号）',
    causes: ['任务被取消 / 窗口关闭 / 上一条命令超时后队列被清理'],
    fixes: ['确认任务未被取消后重试；若反复中断，检查是否在计划模式下被拒（PLAN_MODE_READONLY）']
    ,
    topics: ['error_ref']
  },
  CLOSED: {
    code: 'CLOSED',
    meaning: 'Telnet/SSH 连接已断开',
    causes: ['设备侧断链、eNSP 中设备被关闭、或长时间空闲被踢'],
    fixes: ['用 list_devices 看连接状态，必要时重新 connect_device 再继续']
    ,
    topics: ['error_ref']
  },
  TRUNCATED: {
    code: 'TRUNCATED',
    meaning: '单条命令回显超过上限被截断',
    causes: ['输出过大（整份配置、大路由表）'],
    fixes: ['改用分片查看（display 指定对象）或带 limit 的采集工具；截断快照不可作为回滚基线']
    ,
    topics: ['error_ref']
  }
}

export interface VrpErrorExplanation {
  guide: VrpErrorGuide
  /** 可直接拼进工具失败信息的紧凑中文提示（2~4 行） */
  hint: string
}

/**
 * 查错误码的引导。命中返回引导与紧凑提示；未登记的码返回 null（调用方保持原样报错）。
 *
 * `command` 只用于把出错命令带进提示里 —— 让模型一眼看到「是哪一句、错在哪」。
 */
export function explainVrpError(
  code: string | undefined,
  command?: string
): VrpErrorExplanation | null {
  const guide = code ? VRP_ERROR_GUIDE[code as ErrorCode] : undefined
  if (!guide) return null
  const lines = [
    `命令${command ? `「${command}」` : ''}被设备拒绝：${guide.meaning}`,
    `常见根因：${guide.causes.slice(0, 3).join('；')}`,
    `可照做的纠正：${guide.fixes.slice(0, 3).join('；')}`,
    `相关主题（可用 lookup_vrp_command 深查）：${guide.topics.join(' / ')}`
  ]
  return { guide, hint: lines.join('\n') }
}

/** 供测试与设置页展示：字典覆盖的错误码清单 */
export function listVrpErrorCodes(): string[] {
  return Object.keys(VRP_ERROR_GUIDE).sort()
}

// ——————————————————————————————————————————————
// ② 下发前静态预检
// ——————————————————————————————————————————————

export type PreflightLevel = 'warn' | 'info'

export interface PreflightFinding {
  level: PreflightLevel
  /** 规则名（稳定标识，便于测试与去重） */
  rule: string
  /** 触发该结论的那条命令（整批级结论不带此字段） */
  command?: string
  /** 一句话说清风险 */
  message: string
  /** 建议的改法（可照做） */
  fix: string
}

const DOTTED_QUAD_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function quadOctets(s: string): number[] | null {
  const m = DOTTED_QUAD_RE.exec(s)
  if (!m) return null
  const o = [m[1]!, m[2]!, m[3]!, m[4]!].map((x) => Number(x))
  return o.some((v) => v > 255) ? null : o
}

function bitsOf(octets: number[]): string {
  return octets.map((v) => v.toString(2).padStart(8, '0')).join('')
}

/** 是不是「子网掩码」形状（左侧连续 1、右侧连续 0） */
function isNetmaskLike(s: string): boolean {
  const o = quadOctets(s)
  return o !== null && /^1*0*$/.test(bitsOf(o))
}

/** 是不是「反掩码（wildcard）」形状（补码为连续 1、0） */
function isWildcardLike(s: string): boolean {
  const o = quadOctets(s)
  return o !== null && /^1*0*$/.test(bitsOf(o.map((v) => 255 - v)))
}

/**
 * 反掩码 ↔ 掩码互写的判据。
 *
 * 为什么用「形状互斥」而不是「见到 255.255.255.0 就报」：`0.0.0.0` 既是 /0 掩码
 * 也是「匹配全部」的反掩码，`255.255.255.255` 两种形状都成立 —— 这种两可的值必须放过，
 * 否则每配一条 `ip route-static 0.0.0.0 0 ...` 都会误报，告警立刻失去可信度。
 */
function looksLikeNetmaskNotWildcard(s: string): boolean {
  return isNetmaskLike(s) && !isWildcardLike(s)
}

function looksLikeWildcardNotNetmask(s: string): boolean {
  return isWildcardLike(s) && !isNetmaskLike(s)
}

/** 全角字符判定：全角空格/标点/字母数字（U+3000 与 U+FF00~U+FFEF） */
const FULLWIDTH_RE = /[\u3000\uFF01-\uFF5E]/

/** 类主网号判定（A/B/C 类，主机位全 0 才算合法 network 声明） */
function classfulNetworkOf(ip: string): string | null {
  const o = quadOctets(ip)
  if (!o) return null
  const [a, b] = [o[0]!, o[1]!]
  if (a >= 1 && a <= 126) return `${a}.0.0.0`
  if (a === 127) return '127.0.0.0'
  if (a >= 128 && a <= 191) return `${a}.${b}.0.0`
  if (a >= 192 && a <= 223) return `${a}.${b}.${o[2]!}.0`
  return null
}

interface PreflightCtx {
  /** 当前所在的协议视图（只跟踪 ospf / rip，用于 network 语义判定） */
  proto: 'ospf' | 'rip' | ''
}

const MAX_VLAN_ID = 4094

/**
 * 下发前的纯静态反模式扫描。
 *
 * 只做**确定性**判定：规则命中即一定值得看一眼，不做需要设备现状才能断言的推断
 * （例如「该接口是否已被 shutdown」）。返回空数组表示没发现可疑写法。
 */
export function preflightCommands(commands: readonly string[]): PreflightFinding[] {
  const lines = commands.map((c) => String(c).trim()).filter((c) => c.length > 0)
  if (!lines.length) return []
  const out: PreflightFinding[] = []
  const ctx: PreflightCtx = { proto: '' }
  const lower = lines.map((l) => l.toLowerCase())

  // ① 全角字符：设备按 ASCII 解析，全角空格/标点必报 Unrecognized 或 Wrong parameter
  for (const line of lines) {
    if (FULLWIDTH_RE.test(line)) {
      out.push({
        level: 'warn',
        rule: 'fullwidth-char',
        command: line,
        message: '命令里含全角字符（全角空格/标点），设备按半角解析，几乎必定报 Unrecognized / Wrong parameter',
        fix: '把该命令整句重敲为半角（不要从 Word / 网页直接粘贴，那里常带全角空格 U+3000）'
      })
    }
  }

  // ③ vlan batch 取值域（官方范围 1~4094）
  for (const line of lines) {
    const m = /^vlan\s+batch\s+(.+)$/i.exec(line)
    if (!m) continue
    const ids = m[1]!.split(/\s+/).flatMap((tok) => {
      const to = /^(\d+)$/.exec(tok)
      return to ? [Number(to[1])] : []
    })
    const toRange = /^(\d+)\s+to\s+(\d+)$/i.exec(m[1]!.trim())
    const all = toRange ? [Number(toRange[1]), Number(toRange[2])] : ids
    const bad = all.filter((v) => !Number.isFinite(v) || v < 1 || v > MAX_VLAN_ID)
    if (bad.length) {
      out.push({
        level: 'warn',
        rule: 'vlan-id-range',
        command: line,
        message: `VLAN ID 超出合法范围 1~${MAX_VLAN_ID}：${bad.join(', ')}`,
        fix: `把 VLAN ID 改到 1~${MAX_VLAN_ID} 之间`
      })
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    const line = lower[i]!
    const tok = raw.split(/\s+/)

    // 跟踪协议视图（quit 视为退回上一层；足够预检用，不追求完整视图栈）
    if (/^ospf(\s|$)/.test(line)) ctx.proto = 'ospf'
    else if (/^rip(\s|$)/.test(line)) ctx.proto = 'rip'
    else if (/^quit$/.test(line)) ctx.proto = ''

    // ② 掩码 ↔ 反掩码互写（`network` 的语义随协议视图而变，先按视图分流）
    if (tok[0]!.toLowerCase() === 'network' && tok.length >= 2) {
      if (tok[2]?.toLowerCase() === 'mask') {
        // DHCP 地址池写法：network <网段> mask <掩码>（期望掩码）
        const arg = tok[3]
        if (arg && looksLikeWildcardNotNetmask(arg)) {
          out.push({
            level: 'warn',
            rule: 'mask-vs-wildcard',
            command: raw,
            message: `netmask 位置写成了反掩码形状 ${arg}（地址池的 network ... mask 要写子网掩码）`,
            fix: `改成 ${arg.split('.').map((v) => 255 - Number(v)).join('.')}（或直接写前缀长度，如 mask 24）`
          })
        }
      } else if (ctx.proto === 'rip') {
        // RIP 的 network 只吃主类网号，且不接受掩码参数（无论写没写第三段都要查）
        const netArg = tok[1]!
        const cls = classfulNetworkOf(netArg)
        if (cls && cls !== netArg) {
          out.push({
            level: 'warn',
            rule: 'rip-classful-network',
            command: raw,
            message: `RIP 的 network 只认主类网号，${netArg} 含主机位（会被解析成 ${cls} 或不生效）`,
            fix: `改写为 network ${cls}（RIP 不接受掩码参数，也不要写子网/接口地址）`
          })
        }
        if (tok.length > 2 && /[0-9]/.test(tok[2]!)) {
          out.push({
            level: 'warn',
            rule: 'rip-classful-network',
            command: raw,
            message: `RIP 的 network 不带掩码参数，多写的「${tok[2]}」会被拒（Wrong parameter）`,
            fix: `删掉掩码，只写主类网号，如 network ${cls ?? '10.0.0.0'}`
          })
        }
      } else if (tok.length >= 3 && looksLikeNetmaskNotWildcard(tok[2]!)) {
        // OSPF（或未标协议的片段）：第二参数应为反掩码
        const arg = tok[2]!
        out.push({
          level: 'warn',
          rule: 'wildcard-vs-mask',
          command: raw,
          message: `OSPF 的 network 第二参数是反掩码（wildcard），写成了子网掩码形状 ${arg}`,
          fix: `改成 ${arg.split('.').map((v) => (255 - Number(v)).toString()).join('.')}（逐字节 255-x）`
        })
      }
    }

    // ACL 规则里的 source / destination 反掩码
    if (tok[0]!.toLowerCase() === 'rule') {
      for (const kw of ['source', 'destination']) {
        const idx = tok.findIndex((t) => t.toLowerCase() === kw)
        const arg = idx >= 0 ? tok[idx + 2] : undefined
        if (arg && looksLikeNetmaskNotWildcard(arg)) {
          out.push({
            level: 'warn',
            rule: 'wildcard-vs-mask',
            command: raw,
            message: `ACL 的 ${kw} 第二参数是反掩码，写成了子网掩码形状 ${arg}`,
            fix: `改成 ${arg.split('.').map((v) => (255 - Number(v)).toString()).join('.')}；单主机可写 source <ip> 0`
          })
        }
      }
    }

    // 期望掩码、却给了反掩码
    if (tok[0]!.toLowerCase() === 'ip' && tok[1]?.toLowerCase() === 'address') {
      const arg = tok[3]
      if (arg && looksLikeWildcardNotNetmask(arg)) {
        out.push({
          level: 'warn',
          rule: 'mask-vs-wildcard',
          command: raw,
          message: `ip address 的掩码位置写成了反掩码形状 ${arg}`,
          fix: `改成 ${arg.split('.').map((v) => 255 - Number(v)).join('.')}，或直接写前缀长度（如 ip address ${tok[2]} 24）`
        })
      }
    }
    if (tok[0]!.toLowerCase() === 'ip' && tok[1]?.toLowerCase() === 'route-static') {
      const arg = tok[3]
      if (arg && looksLikeWildcardNotNetmask(arg)) {
        out.push({
          level: 'warn',
          rule: 'mask-vs-wildcard',
          command: raw,
          message: `ip route-static 的掩码位置写成了反掩码形状 ${arg}（静态路由用子网掩码，不是反掩码）`,
          fix: `改成 ${arg.split('.').map((v) => 255 - Number(v)).join('.')}；默认路由写 0.0.0.0 0`
        })
      }
    }

    // ⑨ save 会停在 [Y/N]，属于本工具处理不了的交互
    if (/^save(\s+force)?$/.test(line) || /^save\s/.test(line)) {
      out.push({
        level: 'warn',
        rule: 'save-in-apply',
        command: raw,
        message: 'save 会触发设备 [Y/N] 确认提示，下发管道遇到提示会立即中止（配置半途而废）',
        fix: '把 save 从本批命令里去掉，改用 save_configuration 工具（它会走人工闸门并代为应答）'
      })
    }
  }

  // ④ trunk 口忘了放行 VLAN —— VLAN 实验第一大错（词典 pitfalls 首条）
  const hasTrunk = lines.some((l) => /^port\s+link-type\s+trunk$/i.test(l))
  const hasAllowPass = lines.some((l) => /^port\s+trunk\s+allow-pass\s+vlan\b/i.test(l))
  if (hasTrunk && !hasAllowPass) {
    out.push({
      level: 'warn',
      rule: 'trunk-without-allow-pass',
      message: '本批把端口设成了 trunk，但没有一条 port trunk allow-pass vlan —— 不放行等于不通',
      fix: '补上 port trunk allow-pass vlan <需要放行的 VLAN 列表>（设备上若已放行则忽略本条）'
    })
  }
  const hasAccess = lines.some((l) => /^port\s+link-type\s+access$/i.test(l))
  const hasDefaultVlan = lines.some((l) => /^port\s+default\s+vlan\s+\d+/i.test(l))
  if (hasAccess && !hasDefaultVlan) {
    out.push({
      level: 'info',
      rule: 'access-without-default-vlan',
      message: '本批设了 access 口但没给 port default vlan —— 该口会落在 VLAN 1',
      fix: '补上 port default vlan <VLAN 名或 ID>（设备上若已配置则忽略本条）'
    })
  }

  // ⑤ 单臂路由：dot1q termination vid 之后必须 arp broadcast enable，否则 VLAN 间不通
  const hasDot1q = lines.some((l) => /^dot1q\s+termination\s+vid\s+\d+/i.test(l))
  const hasArpBroadcast = lines.some((l) => /^arp\s+broadcast\s+enable$/i.test(l))
  if (hasDot1q && !hasArpBroadcast) {
    out.push({
      level: 'warn',
      rule: 'dot1q-without-arp-broadcast',
      message: '子接口配了 dot1q termination vid，但没有 arp broadcast enable —— 子接口不发 ARP 广播，VLAN 间无法通信',
      fix: '在每个终结子接口下补 arp broadcast enable'
    })
  }

  // ⑥ DHCP 依赖：地址池/接口模式都要求先全局 dhcp enable
  const usesDhcpPool = lines.some(
    (l) => /^ip\s+pool\s+/i.test(l) || /^dhcp\s+select\s+(global|relay)$/i.test(l) || /^dhcp\s+server\s+/i.test(l)
  )
  const hasDhcpEnable = lines.some((l) => /^dhcp\s+enable$/i.test(l))
  if (usesDhcpPool && !hasDhcpEnable) {
    out.push({
      level: 'info',
      rule: 'dhcp-without-enable',
      message: '用了地址池 / dhcp select，但本批没有 dhcp enable —— 没开全局 DHCP 时这些命令不生效或直接报错',
      fix: '在本批最前面加一条 dhcp enable（设备上若已开启则忽略本条）'
    })
  }

  // ⑦ 引用了尚未创建的 VLAN
  const vlanifIds = [...new Set(
    lines
      .map((l) => /^interface\s+vlanif\s*(\d+)$/i.exec(l)?.[1])
      .filter((v): v is string => !!v)
  )]
  if (vlanifIds.length) {
    const created = new Set<number>()
    for (const l of lines) {
      const batch = /^vlan\s+batch\s+(.+)$/i.exec(l)
      if (batch) {
        for (const tok of batch[1]!.split(/\s+/)) {
          if (/^\d+$/.test(tok)) created.add(Number(tok))
        }
        const rng = /^(\d+)\s+to\s+(\d+)$/i.exec(batch[1]!.trim())
        if (rng) for (let v = Number(rng[1]); v <= Number(rng[2]); v++) created.add(v)
      }
      const single = /^vlan\s+(\d+)$/i.exec(l)
      if (single) created.add(Number(single[1]))
    }
    const missing = vlanifIds.filter((v) => !created.has(Number(v)))
    if (missing.length) {
      out.push({
        level: 'info',
        rule: 'vlanif-without-vlan',
        message: `配了 Vlanif ${missing.join('/')}，但本批没有创建对应 VLAN —— VLAN 不存在时该三层接口起不来`,
        fix: `先 vlan batch ${missing.join(' ')} 再配 Vlanif（设备上若已存在该 VLAN 则忽略本条）`
      })
    }
  }

  return out
}
