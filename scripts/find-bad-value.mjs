// 用真实 wiki 数据跑一遍 wiki_review 的 execute，找出 undefined 到底在哪个字段。
import { loadPages } from '../lib/wiki.js'
import { loadUsage, classify, reinforcementFactor, shouldQuarantine, DEFAULT_POLICY } from '../lib/usage.js'
import { readGaps } from '../lib/acquire.js'

const ROOT = 'D:/Harness/dsh-wiki'
const cfg = { wikiRoot: ROOT, minConfidence: 0.3, usagePolicy: { ...DEFAULT_POLICY } }

const { pages } = await loadPages(ROOT)
const usage = await loadUsage(ROOT)
const policy = { ...DEFAULT_POLICY, ...(cfg.usagePolicy ?? {}) }
const committed = pages.filter(p => p.status === 'committed')
const now = Date.now()
const buckets = { confirmed: [], 'suspect-watch': [], suspect: [], unconfirmed: [], new: [], dead: [] }
for (const p of committed) {
  const st = usage.pages[p.id]
  const cls = classify(st, p, { now, policy })
  const ageDays = Number.isFinite(Date.parse(p.created ?? '')) ? Math.round((now - Date.parse(p.created)) / 86400000) : null
  ;(buckets[cls] ??= []).push({
    id: p.id, cls,
    hits: st?.hits ?? 0, confirmed: st?.confirmed ?? 0, suspect: st?.suspect ?? 0,
    factor: Number(reinforcementFactor(st, now).toFixed(3)),
    ageDays,
    quarantined: shouldQuarantine(st, policy),
  })
}
const usageSummary = {
  说明: 'x',
  policy,
  counts: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
  quarantined: Object.values(buckets).flat().filter(x => x.quarantined).map(x => ({ id: x.id, suspect: x.suspect, confirmed: x.confirmed })),
  suspect: [...buckets.suspect, ...buckets['suspect-watch']].sort((a, b) => b.suspect - a.suspect).slice(0, 20),
  confirmed: buckets.confirmed.sort((a, b) => b.confirmed - a.confirmed).slice(0, 20),
  dead: buckets.dead.map(x => ({ id: x.id, ageDays: x.ageDays })),
  newPages: buckets.new.map(x => ({ id: x.id, ageDays: x.ageDays })),
}

// 递归找 undefined
const bad = []
const walk = (v, path) => {
  if (v === undefined) { bad.push(path + ' = undefined'); return }
  if (v === null || typeof v !== 'object') return
  if (Array.isArray(v)) { v.forEach((x, i) => walk(x, path + '[' + i + ']')); return }
  for (const [k, val] of Object.entries(v)) walk(val, path + '.' + k)
}
walk(usageSummary, 'usage')
console.log('usageSummary 里的非法值:')
console.log(bad.length ? bad.join('\n') : '  (无)')

// 也查 staged 与 gaps
const { loadPages: _lp } = await import('../lib/wiki.js')
const staged = pages.filter(p => p.status === 'staged').map(p => ({
  id: p.id, title: p.title, category: p.category,
  confidence: p.confidence, sources: p.sources.length, path: p.relPath,
}))
const bad2 = []
const walk2 = (v, path) => {
  if (v === undefined) { bad2.push(path + ' = undefined'); return }
  if (v === null || typeof v !== 'object') return
  if (Array.isArray(v)) { v.forEach((x, i) => walk2(x, path + '[' + i + ']')); return }
  for (const [k, val] of Object.entries(v)) walk2(val, path + '.' + k)
}
walk2(staged, 'staged')
console.log('')
console.log('staged 里的非法值:')
console.log(bad2.length ? bad2.join('\n') : '  (无)')
console.log('')
console.log('counts: ' + JSON.stringify(usageSummary.counts))
