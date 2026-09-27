/**
 * 抽取结果的行文本收敛（PDF / Office / RTF 共用）。
 *
 * 为什么单独一层：抽取出来的文本普遍带 `\r`、多余空行、控制字符与行尾空格，
 * 而下游是「按行分页」的 read_attachment —— 不做这一步，页码对不上、模型
 * 看到的是满屏空行。三处抽取各写一遍必然漂移，所以只有这一份。
 */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f]/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
