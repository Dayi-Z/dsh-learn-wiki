// 自动沉淀要面对什么？先用现有数据把问题量化。
import { loadPages } from '../lib/wiki.js'
import { readGaps } from '../lib/acquire.js'
import { readStruggles } from '../lib/struggle.js'
import { buildCorpus, recallable } from '../lib/recall.js'

const ROOT = 'D:/Harness/dsh-wiki'
const { pages } = await loadPages(ROOT)
const pool = recallable(pages)
const corpus = buildCorpus(pool)

console.log('=== L1 现状 ===')
console.log('  总页数      : ' + pages.length)
console.log('  可召回      : ' + pool.length)
console.log('  hits 字段   : ' + JSON.stringify(pool.map(p => p.hits ?? 0)))
console.log('  （全部为 0 = 命中次数从未被累加过）')
console.log('')
console.log('  来源分布:')
const bySrc = {}
for (const p of pool) {
  const kind = (p.sources ?? []).some(s => String(s).startsWith('file://')) ? 'file:// (本地实测)'
    : (p.sources ?? []).some(s => String(s).includes('github') || String(s).includes('npmjs')) ? 'github/npm (网络)'
    : (p.sources ?? []).some(s => String(s).includes('context_audit') || String(s).includes('.learn-wiki')) ? '会话内实测'
    : '其他网络'
  bySrc[kind] = (bySrc[kind] ?? 0) + 1
}
for (const [k, v] of Object.entries(bySrc)) console.log('    ' + k.padEnd(22) + v)

console.log('')
console.log('=== 蒸馏器的真实通过率（gap 队列）===')
const gaps = await readGaps(ROOT)
const done = gaps.filter(g => g.status === 'done')
const skipped = gaps.filter(g => g.status === 'skipped')
console.log('  处理过      : ' + gaps.length)
console.log('  产出页面    : ' + done.length + '  (' + Math.round(done.length / gaps.length * 100) + '%)')
console.log('  拒绝        : ' + skipped.length + '  (' + Math.round(skipped.length / gaps.length * 100) + '%)')
console.log('')
console.log('  产出的都是什么:')
for (const g of done) console.log('    ' + JSON.stringify(String(g.query).slice(0, 66)))

console.log('')
console.log('=== 阈值标定距今 ===')
console.log('  当前语料: ' + corpus.n + ' 页')
console.log('  标定时  : 7 页（scripts/calibrate.mjs 的内置语料）')
console.log('  → 标定脚本自己写着"语料显著变化后必须重跑"')

console.log('')
console.log('=== 挣扎记录（自动沉淀的触发源）===')
const s = await readStruggles(ROOT, 200)
console.log('  累计 ' + s.length + ' 次挣扎，涉及 ' + new Set(s.flatMap(r => (r.signals ?? []).map(g => g.file).filter(Boolean))).size + ' 个不同文件')
