import { readStruggles } from '../lib/struggle.js'
import { readGaps } from '../lib/acquire.js'

const ROOT = 'D:/Harness/dsh-wiki'
const s = await readStruggles(ROOT, 500)
console.log('=== 挣扎检测器（observe 模式）记录 ' + s.length + ' 条 ===')
const byType = {}
for (const r of s) for (const g of (r.signals ?? [])) byType[g.type] = (byType[g.type] ?? 0) + 1
for (const [k, v] of Object.entries(byType)) console.log('  ' + k.padEnd(20) + v + ' 次')
if (s.length === 0) console.log('  (还没有任何检测记录)')
for (const r of s.slice(-8)) {
  console.log('  [' + r.ts + '] ' + (r.signals ?? []).map(g => g.type + ' x' + g.count + ' :: ' + String(g.detail).slice(0, 50)).join(' | '))
}

console.log('')
const gaps = await readGaps(ROOT)
console.log('=== gap 队列 ' + gaps.length + ' 条 ===')
const gs = {}
for (const g of gaps) gs[g.status] = (gs[g.status] ?? 0) + 1
console.log('  ' + JSON.stringify(gs))
console.log('')
console.log('  最近 6 条（注意它们是什么）：')
for (const g of gaps.slice(-6)) console.log('    [' + g.status + '] ' + JSON.stringify(String(g.query).slice(0, 62)))
