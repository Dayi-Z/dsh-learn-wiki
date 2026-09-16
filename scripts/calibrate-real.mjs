// 对**真实语料**标定阈值。
//
// 为什么另起一个而不是改 calibrate.mjs：那个脚本用 7 页写死的合成语料，
// 而 verify-core.mjs 的已知缺陷注释早就写明「合成语料代表不了真实语料，
// 拿它继续调只会得到'看着有依据'的数」。语料从 15 页涨到 19 页之后，
// 那条负例的分数从 0.2141 涨到 0.2728，超了记录上限——正是"必须重跑标定"的时刻。
import { loadPages } from '../lib/wiki.js'
import { buildCorpus, scoreQuery, triage } from '../lib/recall.js'
import { DEFAULTS } from '../lib/config.js'

import { recallable } from '../lib/recall.js'

const { pages } = await loadPages('D:/Harness/dsh-wiki')
// ★ 用**自动注入真正会看到的那个池**（recallable 默认排除 meta 页）：
//   标定要度量的就是线上那一步的行为，用一个更宽的池测出来的数没有对应物。
//   meta 页（"关于本工具自己"的页）会跟标定查询**共享同一批词**，把它算进来
//   等于让度量对象污染度量本身 —— 实测它就干过这件事（见 lib/recall.js 里
//   recallable 的注释）。
const pool = recallable(pages, { includeMeta: false, includeQuarantined: false })
const corpus = buildCorpus(pool)
console.log('真实语料：' + pool.length + ' 页，词表 ' + corpus.df.size)
console.log('当前阈值：hit=' + DEFAULTS.hitThreshold + ' weak=' + DEFAULTS.weakThreshold)
console.log('')

// 正例：查询 → 期望命中的页（都是这个知识库里真实存在的主题）
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
// 负例：语料里没有的主题，**应当 miss**
const NEG = [
  ['如何配置 kubernetes sidecar 注入策略', 'KNOWN-DEFECT（原本就漏）'],
  ['今天北京的天气怎么样 顺便推荐几家好吃的餐厅', '完全无关'],
  ['Python 里怎么用 asyncio 并发下载图片', '无关技术栈'],
  ['Rust 的 borrow checker 报错怎么绕过', '无关技术栈'],
  ['我家的猫最近不爱吃东西怎么办', '生活问题'],
]

const hitT = DEFAULTS.hitThreshold, weakT = DEFAULTS.weakThreshold
const rows = []
for (const [q, want] of POS) {
  const hits = scoreQuery(corpus, q)
  const top = hits[0]
  rows.push({ kind: 'POS', q, want, best: top?.score ?? 0, top1: top?.page.id ?? '-', ok: top?.page.id === want })
}
for (const [q, why] of NEG) {
  const hits = scoreQuery(corpus, q)
  const top = hits[0]
  rows.push({ kind: 'NEG', q, want: why, best: top?.score ?? 0, top1: top?.page.id ?? '-', ok: null })
}

console.log('=== 正例（应命中期望页）===')
for (const r of rows.filter(r => r.kind === 'POS')) {
  console.log('  ' + (r.ok ? '✓' : '✗') + ' ' + r.best.toFixed(4) + '  ' + (r.ok ? '' : '期望 ' + r.want + ' 实得 ') + r.top1)
  console.log('       ' + r.q)
}
console.log('')
console.log('=== 负例（应 miss）===')
for (const r of rows.filter(r => r.kind === 'NEG')) {
  console.log('  ' + r.best.toFixed(4) + '  ' + (r.best >= hitT ? '★ 判成 hit（错）' : r.best >= weakT ? '判成 weak' : '判成 miss（对）') + '   ' + r.q + '   [' + r.want + ']')
}
console.log('')
const posScores = rows.filter(r => r.kind === 'POS').map(r => r.best).sort((a, b) => a - b)
const negScores = rows.filter(r => r.kind === 'NEG').map(r => r.best).sort((a, b) => b - a)
console.log('正例分数（升序）: ' + posScores.map(x => x.toFixed(3)).join(', '))
console.log('负例分数（降序）: ' + negScores.map(x => x.toFixed(3)).join(', '))
console.log('')
console.log('正例最低 ' + posScores[0].toFixed(4) + '   负例最高 ' + negScores[0].toFixed(4))
const gap = posScores[0] - negScores[0]
console.log(gap > 0
  ? '★ 可分：建议 hitThreshold 取两者之间，例如 ' + ((posScores[0] + negScores[0]) / 2).toFixed(2) + '（间隔 ' + gap.toFixed(3) + '）'
  : '★ 不可分：最好的负例比最差的正例还高 ' + (-gap).toFixed(3) + ' —— 单靠阈值解决不了，要改打分')
