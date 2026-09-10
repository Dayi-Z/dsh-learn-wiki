// 使用证据与强化因子自检。
//
// 核心不变量：**无证据 = 中性（因子 1.0）**。
// 如果新知识因为"还没被确认过"就被惩罚，冷启动永远起不来，
// 整个系统会固化成只有旧知识能被召回。
import { emptyUsage, recordHit, recordConfirmed, recordSuspect, reinforcementFactor, usageLabel } from '../lib/usage.js'
import { buildCorpus, scoreQuery, triage } from '../lib/recall.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

const NOW = Date.parse('2026-09-10T12:00:00Z')
const ago = (days) => new Date(NOW - days * 86400000).toISOString()

console.log('=== 无证据必须中性 ===')
check('无记录 -> 因子 1.0', reinforcementFactor(undefined, NOW) === 1)
check('全新记录 -> 因子 1.0', reinforcementFactor({ hits: 0, confirmed: 0, suspect: 0 }, NOW) === 1)
check('只有 hits、无确认无嫌疑 -> 仍为 1.0（命中不等于确认）',
  reinforcementFactor({ hits: 99, confirmed: 0, suspect: 0, lastHit: ago(1) }, NOW) === 1)

console.log('\n=== 确认抬升 ===')
const c1 = reinforcementFactor({ confirmed: 1, suspect: 0, lastConfirmed: ago(0) }, NOW)
const c5 = reinforcementFactor({ confirmed: 5, suspect: 0, lastConfirmed: ago(0) }, NOW)
const c99 = reinforcementFactor({ confirmed: 99, suspect: 0, lastConfirmed: ago(0) }, NOW)
check('1 次确认 > 1.0', c1 > 1, c1.toFixed(3))
check('5 次确认 = 1.5（封顶 +50%）', Math.abs(c5 - 1.5) < 1e-9, c5.toFixed(3))
check('确认次数封顶，不会无限涨', Math.abs(c99 - 1.5) < 1e-9, c99.toFixed(3))

console.log('\n=== 确认加成随时间衰减 ===')
const fresh = reinforcementFactor({ confirmed: 5, suspect: 0, lastConfirmed: ago(0) }, NOW)
const stale = reinforcementFactor({ confirmed: 5, suspect: 0, lastConfirmed: ago(45) }, NOW)
const ancient = reinforcementFactor({ confirmed: 5, suspect: 0, lastConfirmed: ago(200) }, NOW)
check('90 天前的确认加成归零', Math.abs(ancient - 1.0) < 1e-9, ancient.toFixed(3))
check('中年份衰减到中间值', stale > 1 && stale < fresh, 'fresh=' + fresh.toFixed(3) + ' stale=' + stale.toFixed(3))

console.log('\n=== 嫌疑降权（降权而非删除）===')
const s1 = reinforcementFactor({ confirmed: 0, suspect: 1 }, NOW)
const s5 = reinforcementFactor({ confirmed: 0, suspect: 5 }, NOW)
check('1 次嫌疑 < 1.0', s1 < 1, s1.toFixed(3))
check('5 次嫌疑触及下限 0.15', Math.abs(s5 - 0.15) < 1e-9, s5.toFixed(3))
check('★ 有嫌疑时永不归零（可逆，不是删除）', s5 > 0, s5.toFixed(3))

console.log('\n=== 确认与嫌疑叠加 ===')
const mixed = reinforcementFactor({ confirmed: 5, suspect: 1, lastConfirmed: ago(0) }, NOW)
check('★ 有嫌疑时不许被抬升（封顶 1.0）', mixed <= 1, mixed.toFixed(3))
const heavy = reinforcementFactor({ confirmed: 99, suspect: 1, lastConfirmed: ago(0) }, NOW)
check('再多确认也不能突破嫌疑的封顶', heavy <= 1, heavy.toFixed(3))
check('嫌疑解除后确认重新生效',
  reinforcementFactor({ confirmed: 5, suspect: 0, lastConfirmed: ago(0) }, NOW) > 1)

console.log('\n=== 标签 ===')
check('从没命中 -> dead', usageLabel(undefined) === 'dead')
check('命中无证据 -> unconfirmed', usageLabel({ hits: 3, confirmed: 0, suspect: 0 }) === 'unconfirmed')
check('命中且确认 -> confirmed', usageLabel({ hits: 3, confirmed: 1, suspect: 0 }) === 'confirmed')
check('命中后仍挣扎 -> suspect（优先于 confirmed）', usageLabel({ hits: 3, confirmed: 9, suspect: 1 }) === 'suspect')

console.log('\n=== 记录不串味 ===')
let u = emptyUsage()
recordHit(u, ['a']); recordHit(u, ['a']); recordConfirmed(u, ['a']); recordSuspect(u, ['b'])
check('hits 累加', u.pages.a.hits === 2, JSON.stringify(u.pages.a))
check('确认只写给了 a', u.pages.a.confirmed === 1 && (u.pages.b?.confirmed ?? 0) === 0)
check('嫌疑只写给了 b', u.pages.b.suspect === 1 && u.pages.a.suspect === 0)

console.log('\n=== 排序集成：嫌疑页必须下沉 ===')
const pages = [
  { id: 'good', title: 'Widget 协议约定', body: 'Widget 协议使用长度前缀分帧，魔数为 0x57 0x47。', tags: [], category: 'fact', confidence: 0.9, status: 'committed', sources: ['x'] },
  { id: 'bad', title: 'Widget 协议约定', body: 'Widget 协议使用长度前缀分帧，魔数为 0x57 0x47。', tags: [], category: 'fact', confidence: 0.9, status: 'committed', sources: ['x'] },
]
const corpus = buildCorpus(pages)
const noStats = scoreQuery(corpus, 'Widget 协议的分帧魔数')
check('无证据时两页同分（纯相似度）', noStats[0].score === noStats[1].score, JSON.stringify(noStats.map(h => h.score)))

const withStats = scoreQuery(corpus, 'Widget 协议的分帧魔数', {
  stats: { bad: { hits: 5, confirmed: 0, suspect: 2 }, good: { hits: 5, confirmed: 3, suspect: 0 } },
  explain: true,
  now: NOW,
})
check('★ 有嫌疑的页排到最后', withStats[withStats.length - 1].page.id === 'bad', JSON.stringify(withStats.map(h => h.page.id + ':' + h.score)))
check('★ 被确认的页排到第一', withStats[0].page.id === 'good', JSON.stringify(withStats.map(h => h.page.id + ':' + h.score)))
check('分量被保留（便于诊断）', withStats[0].similarity !== undefined && withStats[0].factor !== undefined,
  JSON.stringify({ sim: withStats[0].similarity, factor: withStats[0].factor }))

console.log(failures === 0 ? '\nALL PASS — 使用证据与强化因子正确' : '\n' + failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
