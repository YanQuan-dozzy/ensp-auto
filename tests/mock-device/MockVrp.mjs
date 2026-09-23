import net from 'node:net'
import { once } from 'node:events'

/**
 * 可编程 Mock VRP 设备。
 *
 * 存在的意义：通信层是本项目最容易做错的一层（分页、编码、静默兜底、
 * 确认提示、并发串包），而这些恰恰最难用真机稳定复现。
 * 有了它，这 11 个集成测试用例可以在没有 eNSP 的环境下反复跑。
 *
 * 它模拟的行为：
 * - 连接后先发 banner，再发首个提示符
 * - 回显收到的命令（真实设备就会这么做）
 * - 按 pageSize 分页并停等空格
 * - 返回错误文本、[Y/N] 确认提示、慢响应、GBK 字节、中途断线
 */

const GBK_ZHONGWEN = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])

export class MockVrp {
  /**
   * @param {object} opts
   * @param {string} [opts.host] 宿主名
   * @param {string} [opts.banner]
   * @param {number} [opts.pageSize] 每页行数，0 表示不分页
   * @param {number} [opts.delayMs] 每条响应前的延迟
   * @param {boolean} [opts.requireAuth] 是否先要认证
   * @param {Array} [opts.handlers] 额外/覆盖的处理器
   */
  constructor(opts = {}) {
    this.host = opts.host ?? 'Huawei'
    this.banner = opts.banner ?? 'Info: The max number of VTY users is 10.\r\n'
    this.pageSize = opts.pageSize ?? 0
    this.delayMs = opts.delayMs ?? 0
    this.requireAuth = opts.requireAuth ?? false
    this.handlers = [...(opts.handlers ?? []), ...this.defaultHandlers()]
    this.server = null
    this.port = 0
    /** 收到的完整命令行，供测试断言并发顺序 */
    this.receivedCommands = []
    this.closeNow = null
    /** 当前提示符。可被 spec.prompt 改写（模拟进入 system-view / 接口视图） */
    this.prompt = `<${this.host}>`
  }

  promptText() {
    return this.prompt
  }

  /** 切换视图提示符，如进入系统视图后设为 [Huawei] */
  setPrompt(p) {
    this.prompt = p
  }

  async listen() {
    this.server = net.createServer((sock) => this.handle(sock))
    this.server.listen(0, '127.0.0.1')
    await once(this.server, 'listening')
    const addr = this.server.address()
    this.port = typeof addr === 'object' && addr ? addr.port : 0
    return this.port
  }

  async close() {
    for (const s of this.sockets ?? []) s.destroy()
    if (this.server) {
      this.server.close()
      this.server = null
    }
  }

  /** 立即掐断所有连接，用于模拟中途断线 */
  killConnections() {
    for (const s of this.sockets ?? []) s.destroy()
  }

  handle(sock) {
    this.sockets ??= new Set()
    this.sockets.add(sock)

    const state = {
      buffer: '',
      awaitingMore: false,
      pages: [],
      pageIndex: 0,
      pagingDisabled: false,
      authed: !this.requireAuth
    }

    sock.on('error', () => {})
    sock.on('close', () => this.sockets.delete(sock))

    if (this.requireAuth) {
      sock.write('Username:')
    } else {
      sock.write(this.banner)
      sock.write(this.promptText())
    }

    sock.on('data', (chunk) => {
      const text = chunk.toString('utf8')

      // VRP 中断键（Ctrl+C，D11）：打断当前执行、清掉半行输入、回到当前提示符。
      // 真实设备就是这么表现的 —— 客户端中止长输出命令时会发 \x03；
      // 若不在此清掉 buffer，\x03 会和新的一行命令粘在一起被解析成一条未知命令。
      if (text.includes('\x03')) {
        state.buffer = ''
        sock.write(`\r\n${this.promptText()}`)
        return
      }

      if (state.awaitingMore) {
        if (text.includes(' ')) this.sendNextPage(sock, state)
        return
      }

      if (!state.authed) {
        if (/^admin\s*$/i.test(text.trim())) {
          state.authed = true
          sock.write(`\r\n${this.promptText()}`)
        } else {
          sock.write('\r\nPassword:')
        }
        return
      }

      state.buffer += text
      let idx
      while ((idx = state.buffer.indexOf('\n')) >= 0) {
        const line = state.buffer.slice(0, idx).replace(/\r$/, '')
        state.buffer = state.buffer.slice(idx + 1)
        this.onLine(sock, state, line)
      }
    })
  }

  onLine(sock, state, line) {
    this.receivedCommands.push(line)
    // 真实 VRP 会先把命令回显出来
    sock.write(`${line}\r\n`)

    if (line.trim() === '') {
      sock.write(this.promptText())
      return
    }

    if (/^screen-length\s+0\s+temporary$/i.test(line.trim())) {
      state.pagingDisabled = true
      sock.write(this.promptText())
      return
    }

    const handler = this.handlers.find((h) => h.match.test(line.trim()))
    const spec = handler ? handler.respond(line.trim(), { state }) : { text: '', unknown: true }

    if (spec.unknown) {
      sock.write(`                    ^\r\nError: Unrecognized command found at '^' position.\r\n`)
      sock.write(this.promptText())
      return
    }

    const emit = () => this.emitSpec(sock, state, spec)
    if (spec.delayMs ?? this.delayMs) {
      setTimeout(emit, spec.delayMs ?? this.delayMs)
    } else {
      emit()
    }
  }

  emitSpec(sock, state, spec) {
    if (spec.closeNow) {
      sock.destroy()
      return
    }

    // 视图切换：spec.prompt 会改写后续提示符（如 system-view → [Huawei]）
    if (spec.prompt) this.setPrompt(spec.prompt)

    if (spec.rawBytes) {
      sock.write(spec.rawBytes)
      sock.write(`\r\n${this.promptText()}`)
      return
    }

    const text = spec.text ?? ''
    const lines = text.split('\r\n')

    if (this.pageSize > 0 && !state.pagingDisabled && lines.length > this.pageSize) {
      state.pages = []
      for (let i = 0; i < lines.length; i += this.pageSize) {
        state.pages.push(lines.slice(i, i + this.pageSize))
      }
      state.pageIndex = 1
      state.awaitingMore = true
      sock.write(state.pages[0].join('\r\n'))
      sock.write('\r\n  ---- More ----')
      return
    }

    if (text) sock.write(`${text}\r\n`)
    // 停在确认提示或完全静默的场景下，不能补提示符 —— 真实设备此时确实不发提示符
    if (!spec.noPrompt) sock.write(this.promptText())
  }

  sendNextPage(sock, state) {
    const page = state.pages[state.pageIndex]
    state.pageIndex++
    if (!page) {
      state.awaitingMore = false
      sock.write(`\r\n${this.promptText()}`)
      return
    }
    sock.write(`\r\n${page.join('\r\n')}`)
    if (state.pageIndex >= state.pages.length) {
      state.awaitingMore = false
      sock.write(`\r\n${this.promptText()}`)
    } else {
      sock.write('\r\n  ---- More ----')
    }
  }

  defaultHandlers() {
    return [
      {
        match: /^display version$/i,
        respond: () => ({
          text: [
            'Huawei Versatile Routing Platform Software',
            'VRP (R) software, Version 5.170 (AR2220 V300R003C00SPC200)',
            'Copyright (C) 2012 Huawei Technologies Co., Ltd.'
          ].join('\r\n')
        })
      },
      {
        match: /^display ip interface brief$/i,
        respond: () => ({
          text: [
            'Interface                   IP Address      Physical Status   Protocol Status',
            'GigabitEthernet0/0/0        10.0.0.1/24     up                up',
            'GigabitEthernet0/0/1        unassigned      down              down'
          ].join('\r\n')
        })
      },
      {
        match: /^display current-configuration$/i,
        respond: () => ({
          text: [
            'sysname Huawei',
            '#',
            'interface GigabitEthernet0/0/0',
            ' ip address 10.0.0.1 255.255.255.0',
            '#',
            'return'
          ].join('\r\n')
        })
      },
      {
        match: /^display ospf peer$/i,
        respond: () => ({
          text: [
            'OSPF Process 1 with Router ID 1.1.1.1',
            ' Neighbors',
            ' Area 0.0.0.0 interface 10.0.0.1(GigabitEthernet0/0/0)',
            ' Router ID: 2.2.2.2   Address: 10.0.0.2',
            ' State: Full  Mode: Nbr is Master'
          ].join('\r\n')
        })
      },
      {
        match: /^display error-counters$/i,
        respond: () => ({
          text: [
            'Interface GigabitEthernet0/0/0',
            'Input error: 0',
            'Output error: 0'
          ].join('\r\n')
        })
      },
      {
        match: /^display chinese$/i,
        respond: () => ({ rawBytes: GBK_ZHONGWEN })
      },
      {
        match: /^displa$/i,
        respond: () => ({
          text: "                    ^\r\nError: Unrecognized command found at '^' position."
        })
      },
      {
        match: /^bad param test$/i,
        respond: () => ({ text: "Error: Wrong parameter found at '^' position." })
      },
      {
        match: /^reboot$/i,
        respond: () => ({
          text: 'Warning: All the configuration will be saved to the configuration file.\r\nAre you sure to continue? [Y/N]:',
          noPrompt: true
        })
      },
      {
        // 只回显、不给提示符，用于验证静默兜底的「弱判定」
        match: /^silent$/i,
        respond: () => ({ text: '', noPrompt: true })
      }
    ]
  }
}

export { GBK_ZHONGWEN }
