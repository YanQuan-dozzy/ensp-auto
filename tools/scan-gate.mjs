/** 一次性检索脚本：定位闸门/快照相关调用点（用完即删） */
import fs from 'node:fs'
import path from 'node:path'

const RE = /allowDangerousWithGate|snapshots\.\w+|risk: '(danger|write)'|trusted/

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

for (const f of walk('src')) {
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/)
  lines.forEach((l, i) => {
    if (RE.test(l)) console.log(`${f}:${i + 1}: ${l.trim()}`)
  })
}
