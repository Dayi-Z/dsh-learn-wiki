// 离线变体对比：在**同一份标注集**上试几个相似度公式，看哪个能把正负例分开。
// 只打印，不改任何东西 —— 决定要基于数据，不是基于我说得像不像。
import { loadPages } from '../lib/wiki.js'
import { buildCorpus, tokenize, scoreQuery } from '../lib/recall.js'
import { DEFAULTS } from '../lib/config.js'

const { pages } = await loadPages('D:/Harness/dsh-wiki')
const pool = pages.filter(p => p.status === 'committed')
const corpus = buildCorpus(pool)
const POS = [
  ['edit requires reading the file first 为什么 resume 之后必然出现', 'edit-requires-reading-first-mechanism'],
  ['DSH 的上下文压缩为什么触发不了', 'compaction-not-triggering-two-root-causes'],
  ['headroom 到底能省多少 token', 'headroom-token-savings-vs-prefix-cache'],
  ['hindsight 重启之后配置没生效 还说端口已经开了', 'hindsight-pid-c5783a'],
  ['Hindsight daemon 起不来 端口 8888 没有监听', 'hindsight-daemon-pg0-crash-recovery'],
  ['skill 和 MCP 工具能不能放在一个库里统一管', 'capability-library-skill-mcp-management'],
  ['DSH 客户端 UI 原语有哪些 主题变量叫什么', 'dsh-client-ui-primitives-contract'],
  ['Cordis 里没 inject 的服务怎么读', 'cordis-optional-service-access'],
  ['workflow 有什么用 agent 必须用吗', 'workflow-purpose-and-agent-necessity'],
  ['桌面端 POST 报 Failed to fetch 怎么查', 'desktop-req-shim-body-events'],
  ['Hermes 是怎么做到自己学习的', 'hermes-agent-self-improving-loop'],
  ['路由注册成 exact 导致接口 404 返回 HTML', 'root-cause-masking-bugs'],
  ['分层作用域下技能列表查到是空的', 'scoped-registry-empty-result'],
]
const NEG = [
  '如何配置 kubernetes sidecar 注入策略',
  '今天北京的天气怎么样 顺便推荐几家好吃的餐厅',
  'Python 里怎么用 asyncio 并发下载图片',
  'Rust 的 borrow checker 报错怎么绕过',
  '我家的猫最近不爱吃东西怎么办',
]
const maxDf = Math.max(2, Math.floor(corpus.n * (DEFAULTS.maxDfRatio || 0.2)))
const K1 = 1.2
const idf = (t) => { const d = corpus.df.get(t) || 0; return Math.log(1 + (corpus.n - d + 0.5) / (d + 0.5)) }

function components(query) {
  const uniq = [...new Set(tokenize(query))].filter(t => (corpus.df.get(t) || 0) <= maxDf)
  if (uniq.length === 0) return null
  const present = uniq.filter(t => (corpus.df.get(t) || 0) > 0)
  if (present.length === 0) return null
  const neutral = present.reduce((s, t) => s + idf(t), 0) / present.length
  const w = (t) => ((corpus.df.get(t) || 0) > 0 ? idf(t) : neutral)
  return { uniq, present, neutral, w, total: uniq.reduce((s, t) => s + w(t), 0) }
}

function scoreWith(query, page, variant) {
  const c = components(query)
  if (!c) return 0
  const tf = new Map()
  for (const t of tokenize(page.body)) tf.set(t, (tf.get(t) || 0) + 1)
  let matched = 0, sat = 0
  for (const t of c.uniq) {
    const f = tf.get(t) || 0
    if (!f) continue
    const w = c.w(t)
    matched += w
    sat += w * (f / (f + K1))
  }
  if (matched <= 0) return 0
  const coverage = matched / c.total
  const saturation = sat / c.total
  const absent = c.uniq.length - c.present.length
  const absentPenalty = (c.present.length + 1) / (c.uniq.length + 1)
  switch (variant) {
    case 'current': return 0.7 * coverage + 0.3 * saturation
    case 'floor': return Math.max(0, 0.7 * coverage + 0.3 * saturation - 0.15 * absentPenalty)
    case 'absent': return (0.7 * coverage + 0.3 * saturation) * absentPenalty
    default: return 0
  }
}

const variants = ['current', 'floor', 'absent']
for (const v of variants) {
  const pos = POS.map(([q, want]) => {
    const hits = corpus.docs.map(d => ({ id: d.page.id, s: scoreWith(q, d.page, v) })).sort((a, b) => b.s - a.s)
    return { best: hits[0].s, top1: hits[0].id, ok: hits[0].id === want }
  })
  const neg = NEG.map(q => {
    const hits = corpus.docs.map(d => ({ id: d.page.id, s: scoreWith(q, d.page, v) })).sort((a, b) => b.s - a.s)
    return { q, best: hits[0].s, top1: hits[0].id }
  })
  const posMin = Math.min(...pos.map(p => p.best))
  const negMax = Math.max(...neg.map(n => n.best))
  const top1ok = pos.filter(p => p.ok).length
  console.log('')
  console.log('=== ' + v + ' ===')
  console.log('  正例最低 ' + posMin.toFixed(3) + ' | 负例最高 ' + negMax.toFixed(3) + ' | gap ' + (posMin - negMax).toFixed(3) + ' | top1 正确 ' + top1ok + '/' + pos.length)
  console.log('  负例: ' + neg.map(n => n.best.toFixed(3)).join(', '))
}