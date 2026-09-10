// 直接从模块算真实分布（不依赖重启后的插件）。
import { loadPages } from '../lib/wiki.js'
import { loadUsage, classify, reinforcementFactor, shouldQuarantine, DEFAULT_POLICY } from '../lib/usage.js'

const ROOT = 'D:/Harness/dsh-wiki'
const { pages } = await loadPages(ROOT)
const usage = await loadUsage(ROOT)
const policy = DEFAULT_POLICY
const now = Date.now()
const committed = pages.filter(p => p.status === 'committed')

const buckets = {}
for (const p of committed) {
  const st = usage.pages[p.id]
  const cls = classify(st, p, { now, policy })
  ;(buckets[cls] ??= []).push({
    id: p.id,
    hits: st?.hits ?? 0, confirmed: st?.confirmed ?? 0, suspect: st?.suspect ?? 0,
    factor: Number(reinforcementFactor(st, now).toFixed(2)),
    quarantined: shouldQuarantine(st, policy),
    ageDays: Number.isFinite(Date.parse(p.created ?? '')) ? Math.round((now - Date.parse(p.created)) / 86400000) : null,
  })
}

console.log('=== L1 使用证据分布（' + committed.length + ' 页已固化）===')
console.log('usage.json 记录数: ' + Object.keys(usage.pages ?? {}).length)
console.log('')
const order = ['confirmed', 'unconfirmed', 'suspect-watch', 'suspect', 'new', 'dead']
for (const k of order) {
  const v = buckets[k] ?? []
  if (v.length === 0) continue
  console.log(k.padEnd(16) + v.length + ' 页')
  for (const x of v) {
    console.log('    ' + x.id.padEnd(46)
      + ' hits=' + String(x.hits).padEnd(3)
      + ' conf=' + String(x.confirmed).padEnd(3)
      + ' susp=' + String(x.suspect).padEnd(3)
      + ' factor=' + String(x.factor).padEnd(5)
      + (x.ageDays !== null ? x.ageDays + 'd' : '?')
      + (x.quarantined ? '  [已隔离]' : ''))
  }
}
console.log('')
console.log('处置策略: 嫌疑 >= ' + policy.suspectFlagAt + ' 且多于确认 -> 隔离出自动注入')
console.log('          零命中且页龄 >= ' + policy.deadAfterDays + ' 天 -> 死知识')
