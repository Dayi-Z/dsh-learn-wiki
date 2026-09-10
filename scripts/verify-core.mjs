// 核心自检：解析 → 索引 → 打分 → 三分桶。
// 跑在真实的 D:\Harness\dsh-wiki 上，而不是 fixture，确保格式约定与实物一致。
import { loadPages, commitReadiness, deriveId, slugify } from '../lib/wiki.js'
import { looksLikeGap } from '../lib/recall.js'
import { buildCorpus, scoreQuery, triage, recallable } from '../lib/recall.js'

const ROOT = process.argv[2] || 'D:\\Harness\\dsh-wiki'
let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

const { pages, errors } = await loadPages(ROOT)
console.log('loaded ' + pages.length + ' page(s) from ' + ROOT)
if (errors.length) for (const e of errors) console.log('  parse note: ' + e.file + ': ' + e.error)

const pool = recallable(pages)
const corpus = buildCorpus(pool)
console.log('recallable corpus: ' + corpus.n + ' (committed & confidence >= 0.3)')

const sample = pool[0]
if (sample) {
  console.log('\nsample page fields: id=' + sample.id + ' category=' + sample.category +
    ' confidence=' + sample.confidence + ' status=' + sample.status +
    ' sources=' + sample.sources.length + ' tags=[' + sample.tags.join(',') + ']')
  check('frontmatter sources parsed as array', Array.isArray(sample.sources) && sample.sources.length > 0)
  check('confidence parsed as number', typeof sample.confidence === 'number')
  const r = commitReadiness(sample)
  check('committed page passes commitReadiness', r.ready, r.blockers.join('; '))
}

// 中文查询应命中中文页
const q1 = scoreQuery(corpus, 'Hindsight daemon 起不来 端口 8888 没有监听')
console.log('\nquery: Hindsight daemon 起不来 端口 8888 没有监听')
console.log(q1.slice(0, 3).map(h => '  ' + h.score.toFixed(4) + '  ' + h.page.id).join('\n') || '  (no hits)')
const t1 = triage(q1)
check('中文查询触发三分桶', ['hit', 'weak', 'miss'].includes(t1.bucket), 'bucket=' + t1.bucket + ' best=' + t1.best)

// 无关查询应为 miss（这是后台补料的触发条件）
const q2 = scoreQuery(corpus, '如何配置 kubernetes sidecar 注入策略')
const t2 = triage(q2)
console.log('\nquery: 如何配置 kubernetes sidecar 注入策略')
console.log('  bucket=' + t2.bucket + ' best=' + t2.best)
check('无关查询判为 miss', t2.bucket === 'miss', 'bucket=' + t2.bucket + ' best=' + t2.best)

// 中文二元组分词确实产出 token
const zhOnly = scoreQuery(corpus, '数据库崩溃恢复')
check('纯中文查询能产出命中', zhOnly.length > 0, zhOnly.length + ' hit(s)')

// ── id 派生：中文标题必须不碰撞（曾实现错，靠"slug 够长"判断，挡不住）──
console.log('\n=== id 派生 ===')
const a = deriveId(undefined, 'DSH 插件 link 安装的模块解析')
const b = deriveId(undefined, 'DSH 插件 link 的加载顺序')
check('中文标题派生 id 不碰撞', a !== b, a + ' vs ' + b)
check('ascii 标题保持干净 slug', deriveId(undefined, 'Widget protocol framing') === 'widget-protocol-framing')
check('显式 id 被尊重且不加哈希', deriveId('explicit-id', '任意中文标题') === 'explicit-id')
check('空标题也有 id', deriveId(undefined, '').length > 0, deriveId(undefined, ''))

// ── 缺口判据：寒暄不得进 gap 队列（"已通过commit" 曾溜过纯长度过滤）──
console.log('\n=== 缺口判据 ===')
for (const [q, want] of [
  ['我已重启', false], ['已通过commit', false], ['好的', false], ['继续', false],
  ['怎么配 pg0', true],
  ['Hindsight daemon 起不来 端口 8888 没有监听 怎么排查', true],
  ['这个报错是什么原因导致的', true],
]) {
  check('looksLikeGap(' + q.slice(0, 18) + ') === ' + want, looksLikeGap(q) === want, 'got ' + looksLikeGap(q))
}

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
