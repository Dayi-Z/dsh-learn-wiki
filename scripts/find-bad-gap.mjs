import { readGaps } from '../lib/acquire.js'
const ROOT = 'D:/Harness/dsh-wiki'
const gaps = await readGaps(ROOT)
console.log('gap 总数: ' + gaps.length)
const bad = []
gaps.forEach((g, i) => {
  for (const k of ['id', 'query', 'status', 'seen', 'attempts', 'score']) {
    if (g[k] === undefined) bad.push('gaps[' + i + '].' + k + ' = undefined  (id=' + g.id + ')')
  }
})
console.log('')
console.log('缺失字段:')
console.log(bad.length ? bad.join('\n') : '  (无)')
console.log('')
console.log('前 6 条的字段形状:')
for (const g of gaps.slice(0, 6)) {
  console.log('  ' + JSON.stringify({ id: g.id, status: g.status, seen: g.seen, attempts: g.attempts, score: g.score, q: String(g.query).slice(0, 30) }))
}
