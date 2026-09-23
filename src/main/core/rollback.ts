/**
 * 回滚命令生成（纯函数，无 IO）。
 *
 * 目标：给定「快照配置」与「当前配置」，生成尽可能还原到快照的命令序列。
 *
 * 策略是对 VRP 配置做**分段解析**（每段 = 一个视图头 + 其缩进子行），
 * 再按段做行级差异，原因：
 * - 配置里的 `undo ip address ...` 之类子行必须在其所属视图（interface/ospf…）里执行，
 *   纯行集合 diff 会丢失视图上下文，生成出一堆从系统视图跑必失败的裸命令。
 * - 以「段」为粒度 diff，新加的整个段**只有在段头本身可被 undo 时**才能整体移除
 *   （`undo vlan 10` / `undo ospf 1`）；`interface GigabitEthernet0/0/0` 这类
 *   视图入口在 VRP 里**没有** `undo interface` 命令，必须走「进段 + 逐行 undo」
 *   的等价路径，见 UNDOABLE_HEADER_RE 与 genRollbackCommands 第 3 步。
 *
 * 明确的边界（v0.2 的可接受范围，TOOLS.md 已声明「best-effort」）：
 * - 顶层散命令的 undo 是尽力而为（如 `sysname`、`snmp-agent`），部分命令的撤销
 *   语义不收敛，失败时靠逐条命令的 ok=false 判定暴露给代理，由代理决定改道。
 * - 段头正则覆盖 VRP 常见视图命令；遇到未收录的段头时该段会被当成顶层行处理，
 *   回归为纯行 diff 行为，不会静默出错。
 */

export interface ConfigStanza {
  header: string
  lines: string[]
}

export interface ParsedConfig {
  /** 无缩进的顶层命令（含未被识别为段头的行） */
  top: string[]
  /** 视图段：header + 缩进子行 */
  stanzas: ConfigStanza[]
}

/**
 * 常见 VRP 视图入口。顺序：更具体的写法在前（acl number / acl name 先于通用 acl）。
 * 命中即认为后面的缩进行属于该视图。
 */
export const STANZA_HEADER_RE =
  /^(?:interface\s+\S+|ospf\s+\d+|vlan\s+\d+|acl\s+number\s+\d+|acl\s+name\s+\S+|acl\s+\S+|route-policy\s+\S+\s+\S+|isis\s+\d+|rip\s+\d+|bgp\s+\S+|ip\s+ip-prefix\s+\S+|traffic\s+(?:classifier|behavior)\s+\S+|firewall\s+zone\s+name\s+\S+|nat\s+address-group\s+\S+|dhcp\s+server\s+ip-pool\s+\S+|keychain\s+\S+|user-interface\s+\S+|aaa|mpls|bridge-domain)\b/i

/**
 * 「段头本身可被 undo」的视图入口白名单（D1）。
 *
 * 为什么必须区分：`genRollbackCommands` 对**新增的整段**原本一律发 `undo <段头>`，
 * 但 VRP 里只有一部分视图入口存在 `undo` 形式（`undo vlan 10` / `undo ospf 1` /
 * `undo acl 3000`…）。`interface GigabitEthernet0/0/0`、`firewall zone name X`、
 * `nat address-group N`、`dhcp server ip-pool X`、`keychain`、`user-interface`、
 * `aaa`、`mpls` 这些**都没有** `undo interface` 一类命令。
 *
 * 而 executeCommands 是「任一命令失败即整体停止」，于是回滚会在第一条上中断，
 * 设备停在半回滚状态、只报一条 failed —— 比不提供回滚更危险（人会以为回滚过了）。
 *
 * 未命中本白名单的段头走「进段 + 逐行 undo」，与「段内新增行」的处理同构。
 */
export const UNDOABLE_HEADER_RE =
  /^(?:vlan\s+\d+|ospf\s+\d+|acl\s+(?:number\s+)?\d+|acl\s+name\s+\S+|rip\s+\d+|isis\s+\d+|bgp\s+\S+|ip\s+ip-prefix\s+\S+|route-policy\s+\S+\s+\S+|traffic\s+(?:classifier|behavior)\s+\S+|bridge-domain\s+\S+)\b/i

export function parseConfigStanzas(text: string): ParsedConfig {
  const out: ParsedConfig = { top: [], stanzas: [] }
  let cur: ConfigStanza | null = null
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    const trimmed = line.trim()
    if (!trimmed) continue
    // 段分隔符与结束标记：清空当前段上下文
    if (trimmed === '#' || (/^return\b/.test(trimmed) && !/^\s/.test(line))) {
      cur = null
      continue
    }
    if (/^\s/.test(line)) {
      // 缩进行：属于当前段（若无段上下文则属于顶层段，按原样补回顶层）
      if (cur) cur.lines.push(trimmed)
      else out.top.push(trimmed)
      continue
    }
    if (STANZA_HEADER_RE.test(trimmed)) {
      cur = { header: trimmed, lines: [] }
      out.stanzas.push(cur)
      continue
    }
    cur = null
    out.top.push(trimmed)
  }
  return out
}

/** 同一行文本反转：undo X → X；X → undo X */
export function invertCommand(cmd: string): string {
  const c = cmd.trim()
  return /^undo\s+/i.test(c) ? c.replace(/^undo\s+/i, '') : `undo ${c}`
}

export interface RollbackPlan {
  commands: string[]
  added: string[]
  removed: string[]
}

type Stanzakey = string

function keyOf(header: string): Stanzakey {
  return header.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** 行多重集差：a 中行数量减去 b 中数量，剩余 >0 的按插入序输出 */
function minus(a: readonly string[], b: readonly string[]): string[] {
  const count = new Map<string, number>()
  for (const l of a) count.set(l, (count.get(l) ?? 0) + 1)
  for (const l of b) {
    const n = (count.get(l) ?? 0) - 1
    if (n <= 0) count.delete(l)
    else count.set(l, n)
  }
  return [...count.keys()].flatMap((l) => Array(count.get(l)!).fill(l))
}

export function genRollbackCommands(snapshotText: string, currentText: string): RollbackPlan {
  const old = parseConfigStanzas(snapshotText)
  const now = parseConfigStanzas(currentText)

  const oldStanza = new Map(old.stanzas.map((s) => [keyOf(s.header), s]))
  const nowStanza = new Map(now.stanzas.map((s) => [keyOf(s.header), s]))

  const commands: string[] = []
  const added: string[] = []
  const removed: string[] = []

  // 1) 仍存在的段：先撤销段内新增行，再补回段内被删行（顺序不能反，防止同参覆盖）。
  //    这里发的是「进段 + 逐行 undo」——它同时也是**所有**段的统一撤销路径，
  //    第 3 步对不可 undo 的段头会复用同一种写法。
  for (const [k, s] of oldStanza) {
    const n = nowStanza.get(k)
    if (!n) continue
    const addLines = minus(n.lines, s.lines)
    if (addLines.length) {
      commands.push(s.header, ...addLines.map(invertCommand))
      added.push(...addLines)
    }
    const rmLines = minus(s.lines, n.lines)
    if (rmLines.length) {
      commands.push(s.header, ...rmLines)
      removed.push(...rmLines)
    }
  }

  // 2) 整段被删的段：按快照原样补回（header + 全部子行）
  for (const s of old.stanzas) {
    if (nowStanza.has(keyOf(s.header))) continue
    commands.push(s.header, ...s.lines)
    removed.push(s.header, ...s.lines)
  }

  // 3) 新增的整段：能整体 undo 的段头（vlan / ospf / acl…）只发 `undo <段头>`，
  //    子行随段消失；其余（interface / firewall zone / nat address-group / aaa…）
  //    没有 `undo <段头>` 这条命令，改为「进段 + 逐行 undo」，否则回滚会在第一条
  //    就因 `Error: Unrecognized command` 中断，设备停在半回滚状态（D1）。
  for (const n of now.stanzas) {
    if (oldStanza.has(keyOf(n.header))) continue
    if (UNDOABLE_HEADER_RE.test(n.header)) {
      commands.push(`undo ${n.header}`)
    } else {
      commands.push(n.header, ...n.lines.map(invertCommand))
    }
    added.push(n.header, ...n.lines)
  }

  // 4) 顶层散命令：先撤销新增、再补回被删
  const addTop = minus(now.top, old.top)
  if (addTop.length) {
    commands.push(...addTop.map(invertCommand))
    added.push(...addTop)
  }
  const rmTop = minus(old.top, now.top)
  if (rmTop.length) {
    commands.push(...rmTop)
    removed.push(...rmTop)
  }

  return { commands, added, removed }
}