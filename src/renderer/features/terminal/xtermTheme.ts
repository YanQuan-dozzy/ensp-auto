import type { ITheme } from '@xterm/xterm'

/**
 * xterm 主题桥接。
 *
 * 这是双主题实现里必须手动同步的三处之一（另两处是 React Flow 与 color-scheme）：
 * xterm 的主题通过 setOption('theme', ...) 传入，**不读 CSS 变量**。
 * 漏掉这里，切换浅色后终端会保持黑底，正是验收项里那条「无残留深色块」。
 *
 * 做法：主题变化时从 getComputedStyle 读令牌值，组装成 ITheme 再灌给 xterm。
 */

function readVar(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  const v = styles.getPropertyValue(name).trim()
  return v || fallback
}

export function readXtermTheme(): ITheme {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string): string => readVar(cs, name, fallback)

  return {
    background: v('--terminal-bg', '#11111b'),
    foreground: v('--terminal-fg', '#cdd6f4'),
    cursor: v('--accent', '#89b4fa'),
    cursorAccent: v('--terminal-bg', '#11111b'),
    selectionBackground: v('--terminal-selection', '#45475a'),

    black: v('--bg-base', '#11111b'),
    red: v('--danger', '#f38ba8'),
    green: v('--success', '#a6e3a1'),
    yellow: v('--warning', '#f9e2af'),
    blue: v('--accent', '#89b4fa'),
    magenta: v('--agent', '#cba6f7'),
    cyan: v('--info', '#89dceb'),
    white: v('--text-primary', '#cdd6f4'),

    brightBlack: v('--text-muted', '#6c7086'),
    brightRed: v('--danger', '#f38ba8'),
    brightGreen: v('--success', '#a6e3a1'),
    brightYellow: v('--warning', '#f9e2af'),
    brightBlue: v('--accent-hover', '#b4befe'),
    brightMagenta: v('--agent', '#cba6f7'),
    brightCyan: v('--info', '#89dceb'),
    brightWhite: v('--text-primary', '#cdd6f4')
  }
}

/**
 * 终端字体。必须显式带上 CJK 等宽字体回退，
 * 否则中文回显在等宽网格里会错位（UI-SPEC §5.2 的隐藏验收点）。
 */
export function readTerminalFont(): { fontFamily: string; fontSize: number; lineHeight: number } {
  const cs = getComputedStyle(document.documentElement)
  const mono = readVar(cs, '--font-mono', 'Consolas, monospace')
  return {
    fontFamily: `${mono}, 'Microsoft YaHei', 'PingFang SC', monospace`,
    fontSize: 13,
    lineHeight: 1.4
  }
}
