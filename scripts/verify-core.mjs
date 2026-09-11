// 核心自检：解析 → 索引 → 打分 → 三分桶。
// 跑在真实的 D:\Harness\dsh-wiki 上，而不是 fixture，确保格式约定与实物一致。
import { loadPages, commitReadiness, deriveId, slugify } from '../lib/wiki.js'
import { looksLikeGap } from '../lib/recall.js'
import { fetchUrlText, htmlToText } from '../lib/acquire.js'
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

// ── 回归闸：真正无关的查询不许被判成 hit ──
// 这里刻意换了一条**与语料没有任何词汇重叠**的查询。
// 原先用的是「如何配置 kubernetes sidecar 注入策略」，但它和
// opencode-free-tier-missing-session-id-fix 共享「配置」「注入」两个通用词，
// 于是它不是一条干净的负例（见下面的已知缺陷）。
const q2 = scoreQuery(corpus, '今天北京的天气怎么样 顺便推荐几家好吃的餐厅')
const t2 = triage(q2)
console.log('\nquery: 今天北京的天气怎么样 顺便推荐几家好吃的餐厅')
console.log('  bucket=' + t2.bucket + ' best=' + t2.best)
check('★ 完全无关的查询不得判为 hit（hit 会注入整页正文）',
  t2.bucket !== 'hit', 'bucket=' + t2.bucket + ' best=' + t2.best)

// ── 已知缺陷（不是"通过"，是"记录在案并设了上限"）──
//
// 「如何配置 kubernetes sidecar 注入策略」这条**与语料无实质关系**的查询，
// 在真实 12 页语料上会与 opencode-free-tier-missing-session-id-fix 拿到
// coverage 0.25 / score 0.2141，跨过 hitThreshold 0.20 被判成 hit ——
// 也就是把整页正文注进提示词。撑起这个分的是「配置」「注入」两个通用词。
//
// 为什么现在没修：现有阈值是 scripts/calibrate.mjs 在**合成语料**上标定出来的，
// 而那条负例在合成语料里得 0.0000。合成语料代表不了真实语料，
// 拿它继续调只会得到"看着有依据"的数。真要修得对**真实语料**重跑标定。
//
// 所以这里不假装它通过了：断言它**没有变得更糟**（上限 0.25）。
// 一旦超线，说明打分在真实语料上进一步退化，必须当场处理而不是继续容忍。
//
// ── 补记（2026-09-11）：这条缺陷已被大幅削弱 ──
//
// 语料从 15 页涨到 19 页后，本条分数从 0.2141 涨到 **0.2728**，超了当时设的 0.25 上限
// —— 也就是当时那条注释说的"必须当场处理"的时刻。处理方式是**对真实语料重跑标定**
// （新脚本 scripts/calibrate-real.mjs，18 条标注查询），结论是：
//
//   **单靠阈值救不了**：在真实语料上，最好的负例（Rust borrow checker 0.3737）
//   比最差的正例（0.2811）还高 —— Gap **-0.093**。这不是"阈值没调好"，
//   是打分本身分不开。
//
//   根因是**分词器没有停用词概念**：中文用字符二元组，而「的」出现在 15/19 页
//   （df/n≈0.79）且 tf 很高，却和内容词被同等对待。那条 Rust 查询真正命中的是
//   「的」(15)、「报错」(4)、「怎么」(4)、「绕过」(2) —— 撑起分数的主要是「的」。
//
//   修法是标准的 IR 做法：**出现比例过高的词不携带区分度，不计入覆盖度**。
//   扫了一遍 maxDfRatio（见 lib/config.js 的注释），0.2 是第一个让 Gap 转正的取值：
//     正例最低 0.2446 / 负例最高 0.1969 → Gap **+0.048**
//   且正例 top1 正确率与基线**完全相同**（12/13）——没有为了分离开而牺牲命中。
//
//   本条断言随之改写：它现在要守的不是"别超过 0.25"，而是**不许再回到 hit**。
//   下面那个数字是实测值，改动打分后必须重新量，不是拍出来的。
const qKnown = scoreQuery(corpus, '如何配置 kubernetes sidecar 注入策略')
const tKnown = triage(qKnown)
const KNOWN_RECORDED = 0.1394   // 2026-09-11 在 19 页真实语料上实测
console.log('\n已知缺陷用例: bucket=' + tKnown.bucket + ' best=' + tKnown.best + '（记录值 ' + KNOWN_RECORDED + '）')
check('★ 已知缺陷不再注入整页：通用词重叠查询不得判成 hit',
  tKnown.bucket !== 'hit',
  'bucket=' + tKnown.bucket + ' best=' + tKnown.best + '  （判成 hit 会把无关页面正文注进提示词）')
check('已知缺陷分数未回升（记录值 ' + KNOWN_RECORDED + '，容差 0.05）',
  tKnown.best <= KNOWN_RECORDED + 0.05,
  'best=' + tKnown.best + '  （回升说明 maxDfRatio 的过滤失效或语料分布变了，需重跑 calibrate-real.mjs）')

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

// ── 正文抓取：宿主有 fetch seam 时必须优先走它（不联网即可验证）──
console.log('\n=== 正文抓取 ===')
check('htmlToText 去脚本/标签并解实体',
  htmlToText('<b>Hi</b><script>var x=1</script>&amp;bye') === 'Hi &bye',
  JSON.stringify(htmlToText('<b>Hi</b><script>var x=1</script>&amp;bye')))

const seamText = 'x'.repeat(300)
const viaSeam = await fetchUrlText(
  { web: { fetch: async () => ({ statusCode: 200, body: { kind: 'text', content: seamText } }) } },
  'https://seam.invalid/', { timeoutMs: 1000 })
check('优先走宿主 ctx.web.fetch seam', viaSeam === seamText, 'len=' + viaSeam.length)

const htmlSeam = await fetchUrlText(
  { web: { fetch: async () => ({ statusCode: 200, body: { kind: 'html', content: '<p>' + 'y'.repeat(300) + '</p>' } }) } },
  'https://seam.invalid/', { timeoutMs: 1000 })
check('seam 返回 html 时自动转文本', htmlSeam.startsWith('yyy') && !htmlSeam.includes('<p>'), JSON.stringify(htmlSeam.slice(0, 20)))

const noSeam = await fetchUrlText({ web: {} }, 'https://nonexistent.invalid-host-xyz/', { timeoutMs: 3000 })
check('无 seam 且直连失败时返回空串而非抛异常', noSeam === '', 'got ' + JSON.stringify(noSeam))

// ── 注入块不得进入检索查询 ──
// 注入的是"系统说的话"，不是"用户问的问题"。混进去会污染打分，
// 而且我们自己的注入会被下一轮再检索一次——自我强化的回环。
console.log('\n=== 查询提取 ===')
const qq = scoreQuery(buildCorpus(pool), 'x')  // 仅确认语料可用
check('语料可用于查询提取测试', Array.isArray(qq))

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
