import { loadPages } from '../lib/wiki.js'
import { buildCorpus, scoreQuery, recallable } from '../lib/recall.js'
const { pages } = await loadPages('D:/Harness/dsh-wiki')
const pool = recallable(pages, { includeMeta: false, includeQuarantined: false })
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
  ['Rust 的 borrow checker 报错怎么绕过', 'note-ca2525'],
  '我家的猫最近不爱吃东西怎么办',
]
const pos = POS.map(function (p) { const h = scoreQuery(corpus, p[0]); return { q: p[0], want: p[1], best: h[0] ? h[0].score : 0, top1: h[0] ? h[0].page.id : '-' } })
const neg = NEG.map(function (n) { const isPair = Array.isArray(n); const q = isPair ? n[0] : n; const h = scoreQuery(corpus, q); return { q: q, want: isPair ? n[1] : '', best: h[0] ? h[0].score : 0, top1: h[0] ? h[0].page.id : '-' } })
console.log('== 负例逐条 ==')
for (const n of neg) console.log('  ' + n.best.toFixed(4) + '  top1=' + (n.top1 || '-') + '  ' + (n.want ? '(曾误命中 ' + n.want + ') ' : '') + n.q)
console.log('')
console.log('== 正例最低 5 条 ==')
for (const p of pos.slice().sort(function (a, b) { return a.best - b.best }).slice(0, 5)) console.log('  ' + p.best.toFixed(4) + '  top1=' + p.top1 + '  期望=' + p.want + '  ' + p.q.slice(0, 30))
console.log('')
const negMax = Math.max.apply(null, neg.map(function (n) { return n.best }))
for (const w of [0.12, 0.13, 0.15, 0.16, 0.18, 0.20]) {
  const posInj = pos.filter(function (p) { return p.best >= w }).length
  const negInj = neg.filter(function (n) { return n.best >= w }).length
  console.log('weak=' + w.toFixed(2) + ' -> 正例注入 ' + posInj + '/' + pos.length + ' | 负例注入 ' + negInj + '/' + neg.length + (negInj === 0 && posInj === pos.length ? '   <== 全中' : ''))
}
console.log('负例最高 ' + negMax.toFixed(4) + ' | 正例最低 ' + Math.min.apply(null, pos.map(function (p) { return p.best })).toFixed(4))