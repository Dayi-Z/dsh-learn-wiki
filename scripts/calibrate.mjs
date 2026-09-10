// 阈值标定：用一组标注查询（正例应命中、负例应 miss）实测分数分布，
// 给出有数据支撑的 hitThreshold / weakThreshold 建议。
//
// 用这个而不是拍脑袋定阈值——打分依赖语料规模，阈值必须随语料重新标定。
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureRepo } from '../lib/wiki.js'
import { buildCorpus, scoreQuery, triage, recallable } from '../lib/recall.js'
import { loadPages } from '../lib/wiki.js'

const ROOT = '.tmp-calib'

const PAGES = [
  ['widget-protocol', 'fact', 'Widget 协议约定', 'Widget 协议使用长度前缀分帧，魔数为 0x57 0x47。解析时先读 4 字节长度头，再按长度取载荷。'],
  ['widget-retry', 'decision', 'Widget 重连退避策略', 'Widget 断线后采用指数退避重连，基数 500ms，上限 30s，最多重试 8 次。放弃后上报 telemetry。'],
  ['pg0-recovery', 'lesson', 'pg0 崩溃恢复', 'pg0 实例非正常退出会残留 postmaster.pid，导致端口无人监听。清掉 pid 后用 pg_ctl start 启动，会做自动恢复。'],
  ['recall-thresholds', 'decision', '检索阈值标定', '三分桶阈值依赖语料规模，换语料必须重新标定。语料很小的时候 IDF 退化，阈值不可跨语料复用。'],
  ['hindsight-bank', 'fact', 'Hindsight bank 命名', '每个项目一个 bank，命名格式是 coding-agent::<项目名>。retain 时带 session 标签。'],
  ['vector-store', 'decision', '向量库选型', '小规模知识库用 SQLite + sqlite-vec 即可，不必上独立向量数据库。规模过万再考虑 Qdrant。'],
  ['crag-buckets', 'howto', 'CRAG 三分桶实现', '用一个检索评估器给召回打分，分成 Correct / Incorrect / Ambiguous 三桶，Incorrect 时触发外部检索。'],
]

await rm(ROOT, { recursive: true, force: true })
await ensureRepo(ROOT)
for (const [id, category, title, body] of PAGES) {
  await writeFile(join(ROOT, 'pages', category, id + '.md'), `---
id: ${id}
title: ${title}
category: ${category}
confidence: 0.8
status: committed
sources:
  - https://example.com/${id}
created: 2026-09-10T00:00:00Z
updated: 2026-09-10T00:00:00Z
hits: 0
tags: []
---

${body}
`, 'utf8')
}

const { pages } = await loadPages(ROOT)
const pool = recallable(pages)
const corpus = buildCorpus(pool)

// 正例：期望命中括号里的页
const POS = [
  ['Widget 协议的分帧和魔数是什么', 'widget-protocol'],
  ['widget 断开之后怎么重连', 'widget-retry'],
  ['pg0 数据库起不来 端口没人监听', 'pg0-recovery'],
  ['检索阈值应该怎么定', 'recall-thresholds'],
  ['hindsight 的 bank 怎么命名', 'hindsight-bank'],
  ['知识库要不要上 Qdrant 向量数据库', 'vector-store'],
  ['CRAG 的做法是什么', 'crag-buckets'],
]
// 负例：知识库里没有，应当 miss
const NEG = [
  ['kubernetes sidecar 注入与 istio 流量劫持怎么配', null],
  ['今天北京的天气怎么样', null],
  ['react 的 useEffect 依赖数组陷阱', null],
  ['如何申请营业执照', null],
  ['golang 的 channel 死锁排查', null],
]

const run = (label, qs, expectHit) => {
  const rows = []
  for (const [q, want] of qs) {
    const hits = scoreQuery(corpus, q)
    const t = triage(hits, { hitThreshold: -1, weakThreshold: -1 }) // 只取分数，不判桶
    const best = hits[0]
    rows.push({ q, best: best?.score ?? 0, id: best?.page.id, want, ok: want === null ? true : best?.page.id === want })
  }
  console.log('\n== ' + label + ' ==')
  for (const r of rows) {
    const mark = r.want === null ? '   ' : (r.ok ? ' ok' : ' XX')
    console.log('  ' + mark + '  ' + r.best.toFixed(4) + '  ' + String(r.id ?? '-').padEnd(22) + ' ' + r.q.slice(0, 34))
  }
  return rows
}

const pos = run('正例（应命中标注页）', POS)
const neg = run('负例（语料里没有，应 miss）', NEG)

const posScores = pos.map(r => r.best).sort((a, b) => a - b)
const negScores = neg.map(r => r.best).sort((a, b) => a - b)
const wrong = pos.filter(r => !r.ok)

console.log('\n== 分布 ==')
console.log('  正例 min=' + posScores[0].toFixed(4) + ' 中位=' + posScores[Math.floor(posScores.length / 2)].toFixed(4) + ' max=' + posScores[posScores.length - 1].toFixed(4))
console.log('  负例 min=' + negScores[0].toFixed(4) + ' 中位=' + negScores[Math.floor(negScores.length / 2)].toFixed(4) + ' max=' + negScores[negScores.length - 1].toFixed(4))
if (wrong.length) console.log('  正例中排序失败的: ' + wrong.map(r => r.q.slice(0, 24) + '→' + r.id).join('; '))

const weakestPos = posScores[0]
const strongestNeg = negScores[negScores.length - 1]
console.log('\n== 建议阈值 ==')
if (weakestPos > strongestNeg) {
  const mid = (weakestPos + strongestNeg) / 2
  console.log('  可分离。weakThreshold 取 ' + mid.toFixed(3) + '（正例最弱 ' + weakestPos.toFixed(3) + ' vs 负例最强 ' + strongestNeg.toFixed(3) + '）')
  console.log('  hitThreshold 建议 ' + Math.max(mid + 0.05, weakestPos * 1.05).toFixed(3) + '（保正例全部落 hit）')
} else {
  console.log('  ⚠ 不可分离：正例最弱 ' + weakestPos.toFixed(3) + ' <= 负例最强 ' + strongestNeg.toFixed(3))
  console.log('  建议 weakThreshold=' + Math.max(0.01, strongestNeg * 0.9).toFixed(3) + ' 以优先保召回（宁可注入弱相关，也不要每轮都判 miss 去联网）')
  console.log('  hitThreshold=' + Math.max(0.15, weakestPos * 0.95).toFixed(3))
}

await rm(ROOT, { recursive: true, force: true })
