import type { Encoding } from './types'

/**
 * 终端字节 → 文本的解码器（流式，2026-09-28）。
 *
 * 为什么必须自己解：xterm.js 的输入解码器**只认 UTF-8**（lib/xterm.mjs 里的
 * `Utf8ToUtf32` 找不到续接字节就跳过该字节，既不报错也不产 U+FFFD），
 * 而华为 VRP 切到中文（`language-mode chinese`）之后回显是 **GBK**。
 * 把 GBK 字节直接喂给 xterm，解出来的是「ǷĵǰԻȷл」这类拉丁扩展/希腊/西里尔字母
 * （字形缺失时还渲染成方块或 `?`）—— 这就是用户看到的乱码，
 * 而且**与设置里的 utf8/gbk 无关**：那条设置过去只作用于主进程的「业务解码」，
 * 终端显示那条线一直是 xterm 的 UTF-8 硬解码。
 *
 * 结论：终端也得走解码，**按设备字符集解成字符串再交给 xterm**，
 * 「把原始字节丢给 xterm，让它自己按设备字节渲染」这个口径在高位字节上不成立。
 *
 * 两个必须守住的细节：
 * 1. **有状态**：一个汉字可能被 TCP 分片劈成两半（前 1~2 字节在这一片、
 *    剩下的在下一片）。`TextDecoder` 的 `{ stream: true }` 会把半截序列留在内部
 *    等后续字节；逐片 `new TextDecoder().decode(chunk)` 则每片都会吐替换符。
 * 2. **换编码必须重建解码器**：旧解码器里的待续字节属于旧编码，留着只会让边界错位。
 *
 * 与主进程 `core/telnet/encoding.ts#decode` 的口径一致（宽松解码，非法字节成替换符
 * 而不是静默丢字），区别只是那边逐段、这边流式。
 */

export interface StreamDecoder {
  /** 当前生效的编码（环境不支持 GBK 时会回落成 utf8） */
  readonly encoding: Encoding
  /** 解码一段字节；末尾不完整的多字节序列留在内部等下一段 */
  push(bytes: Uint8Array): string
  /** 切换编码。旧解码器的待续状态一律丢弃 */
  setEncoding(encoding: Encoding): void
}

function make(encoding: Encoding): { enc: Encoding; dec: TextDecoder } {
  if (encoding === 'gbk') {
    try {
      return { enc: 'gbk', dec: new TextDecoder('gbk', { fatal: false }) }
    } catch {
      // 运行环境 ICU 不全 → 退回 UTF-8：宁可这一段显示乱码，也不要抛异常把终端打死
    }
  }
  return { enc: 'utf8', dec: new TextDecoder('utf-8', { fatal: false }) }
}

export function createStreamDecoder(encoding: Encoding): StreamDecoder {
  let cur = make(encoding)
  const api: StreamDecoder = {
    get encoding(): Encoding {
      return cur.enc
    },
    push(bytes: Uint8Array): string {
      return bytes.length ? cur.dec.decode(bytes, { stream: true }) : ''
    },
    setEncoding(next: Encoding): void {
      if (next === cur.enc) return
      cur = make(next)
    }
  }
  return api
}
