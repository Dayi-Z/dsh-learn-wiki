import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
const P = 'D:/Harness/dsh-wiki/.index/catalog.json'
if (!existsSync(P)) { console.log('没有目录快照'); process.exit(0) }
const raw = JSON.parse(await readFile(P, 'utf8'))
const list = Array.isArray(raw) ? raw : (raw.items ?? [])
const famOf = (n) => { const i = String(n).indexOf('_'); return i > 0 ? String(n).slice(0, i) : '' }
const counts = new Map()
for (const it of list) { const f = famOf(it.name); if (f) counts.set(f, (counts.get(f) || 0) + 1) }
const fam = (n) => { const f = famOf(n); return (f && (counts.get(f) || 0) >= 3) ? f : '核心' }
const sorted = list.slice().sort((a, b) => {
  const fa = fam(a.name), fb = fam(b.name)
  if (fa !== fb) { if (fa === '核心') return -1; if (fb === '核心') return 1; return fa < fb ? -1 : 1 }
  return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0)
})
let cur = null
const out = []
const seen = new Map()
for (const it of list) seen.set(fam(it.name), (seen.get(fam(it.name)) || 0) + 1)
for (const it of sorted) {
  const f = fam(it.name)
  if (f !== cur) { cur = f; out.push(''); out.push('【' + f + '】 ' + seen.get(f) + ' 个') }
  out.push('   ' + it.name)
}
console.log('共 ' + list.length + ' 个工具，' + seen.size + ' 组')
console.log(out.join('\n'))
