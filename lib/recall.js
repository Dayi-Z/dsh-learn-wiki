// L1 检索与 CRAG 三分桶。
//
// 为什么不用嵌入：MVP 要零依赖、确定性、可离线、且对中文有效。
// 中文没有词边界，所以这里用「CJK 字符二元组 + 拉丁词」混合分词。
//
// 打分刻意归一到 [0,1]，让阈值可解释、可调：
//   coverage   —— 查询词中被命中的 IDF 占比（"查到了多少"）
//   saturation —— 命中词在文档里的词频饱和程度（"讲得多透"）
//   score = 0.7 * coverage + 0.3 * saturation
// 字段加权：title ×3、tags ×2.5、body ×1。

import { reinforcementFactor, shouldQuarantine, DEFAULT_POLICY } from './usage.js'
// 阈值的唯一真源。config.js 不反向依赖本模块，所以这里没有环。
import { DEFAULTS } from './config.js'

const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/
const LATIN = /[a-z0-9_]/

export function tokenize(text) {
  const s = String(text ?? '').toLowerCase()
  const tokens = []
  for (const m of s.matchAll(/[a-z0-9_]+/g)) {
    if (m[0].length > 1) tokens.push(m[0])
    else if (LATIN.test(m[0])) tokens.push(m[0])
  }
  // CJK 连续段 → 二元组（单字段落保留单字）
  let run = ''
  const flush = () => {
    if (!run) return
    if (run.length === 1) tokens.push(run)
    else for (let i = 0; i + 1 < run.length; i++) tokens.push(run.slice(i, i + 2))
    run = ''
  }
  for (const ch of s) {
    if (CJK.test(ch)) run += ch
    else flush()
  }
  flush()
  return tokens
}

function termFreq(tokens) {
  const tf = new Map()
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
  return tf
}

/** 为一个页面构造带字段加权的词频表。 */
function pageTf(page) {
  const tf = new Map()
  const add = (tokens, weight) => { for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + weight) }
  add(tokenize(page.title), 3)
  add(tokenize((page.tags ?? []).join(' ')), 2.5)
  add(tokenize(page.body), 1)
  return tf
}

// 疑问/任务意图标记。中文里"怎么/如何/为什么"这类词是比长度可靠得多的信号。
const GAP_MARKERS = /[?？]|怎么|如何|为何|为什么|什么|哪个|哪些|是否|能否|能不能|有没有|是不是|报错|失败|区别|原理|为什么/

/**
 * 判断一条输入是不是「真的知识缺口」，而不是寒暄。
 *
 * 长度阈值单独用是不够的——实测"已通过commit"（9 字符，含英文词）
 * 和"我已重启"都溜过了纯长度过滤，然后各自触发一次无意义的联网。
 * 所以这里用两个互补的信号：
 *   * 带疑问/任务标记且不太短  → 是缺口（"怎么配 pg0" 这种短问句也要放行）
 *   * 否则要求足够长且词足够多 → 是缺口
 * 目的是宁可漏记（不学），也不要让闲聊把 gap 队列和联网预算吃掉。
 */
export function looksLikeGap(query, { minChars = 10, minTokens = 4 } = {}) {
  const q = String(query ?? '').trim()
  if (!q) return false
  const chars = [...q].length
  if (GAP_MARKERS.test(q) && chars >= 6) return true
  const tokens = new Set(tokenize(q)).size
  return chars >= minChars && tokens >= minTokens
}

export function buildCorpus(pages) {
  const docs = pages.map(p => ({ page: p, tf: pageTf(p), len: tokenize(p.body).length || 1 }))
  const df = new Map()
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1)
  return { docs, df, n: docs.length }
}

const K1 = 1.2
function idf(df, n, term) {
  const d = df.get(term) ?? 0
  return Math.log(1 + (n - d + 0.5) / (d + 0.5))
}

/**
 * 对查询打分。返回按 score 降序的命中数组。
 *
 * opts.stats —— 每页的使用证据（usage.json）。有它时最终分数是
 *   **相似度 × 强化因子**
 * 而不是纯相似度：命中后仍挣扎过的页会被降权，被反复确认的页会被抬升。
 * 无证据时因子恒为 1.0（新知识不受惩罚）。
 * opts.explain —— 为 true 时保留 similarity / factor 两个分量，供诊断。
 */
/**
 * 这一页是不是**把这条查询原样引用了**（而不是回答它）。
 *
 * ── 为什么必须挡（实测，2026-09-16）──
 *
 * 用真实语料重跑标定（scripts/calibrate-real.mjs，66 页）时，负例
 * 「Rust 的 borrow checker 报错怎么绕过」拿到 **0.8364**，比最高正例（0.785）还高 ——
 * 看着像"打分退化了"，实际是**它检索到了自己**：
 *
 *   pages/lesson/note-ca2525.md 那一页讲的就是"高频字污染覆盖度打分"这个缺陷，
 *   正文里逐字引用了这条标定查询当例子。
 *
 * 后果与项目里已经记过的那条同源：无关页面的正文被注进提示词，比不注入更糟 ——
 * 而这次更糟一层，因为被注进去的是**测试语料自己**，于是标定会变得不可信
 * （分数被自己抬高），下一次谁也不知道真实分布是什么样。
 *
 * ── 判据为什么是"连续窗口"而不是"覆盖率"──
 *
 * 覆盖率天然会到 1：一条短查询在长正文里零星出现，也可能恰好用上全部稀有关键词
 * ——那正是**好答案**的样子（每一点都答到了）。引用则不一样：引用会把查询词
 * **按原顺序挤在相邻的几个词里**。所以这里量的是"有没有一个连续窗口装下了
 * 大部分查询词"。
 *
 * 保守起见只在证据足够时判定：至少 5 个不同查询词，且引用率 >= 0.8。
 *
 * ── ★ 它抓不到刚才那个真实案例，这一点必须写下来 ──
 *
 * 实测（66 页语料）：note-ca2525 的正文里那条查询是**逐字出现**的，但
 *   · 两条 uniq 词（rust / borrow）在**正文里根本没有**（只在 frontmatter）；
 *   · 剩余的 7 个 uniq 词在正文里散落在 **308 个词**的范围上 —— 因为页面是
 *     "先引原句、再用自己的话复述一遍"，复述那遍的顺序是反的（「报错怎么绕过」
 *     → 正文里的「报错怎么」+「怎么绕过」分词不同）。
 *   实测窗口从 14 加到 120 词，覆盖率**始终是 4/7**。
 *
 * 所以这个函数是**未启用**的纯工具：它量的是"有没有一处把查询词挤在一起"，
 * 而那个真实案例是"散着复述"。要真正解决它得换判据（例如查询里出现
 * 语料中不存在的技术名词时，要求该名词也命中）—— 那是另一件事，不能顺手塞进
 * 这里然后声称修好了。
 */
export function looksSelfQuoted(bodyText, qTokens, { minTokens = 5, ratio = 0.8, spanFactor = 3 } = {}) {
  const want = [...new Set(qTokens)].filter(Boolean)
  if (want.length < minTokens) return false
  const body = tokenize(bodyText)
  if (body.length === 0) return false
  const need = Math.ceil(want.length * ratio)
  const wanted = new Set(want)
  const span = Math.max(want.length, 1) * spanFactor   // 窗口宽度：词序会因二元组分词略有错位
  const counts = new Map()
  let have = 0
  for (let i = 0; i < body.length; i++) {
    const add = body[i]
    if (wanted.has(add)) {
      const n = (counts.get(add) ?? 0) + 1
      counts.set(add, n)
      if (n === 1) have++
    }
    if (i >= span) {
      const drop = body[i - span]
      if (wanted.has(drop)) {
        const n = (counts.get(drop) ?? 0) - 1
        counts.set(drop, n)
        if (n === 0) have--
      }
    }
    if (have >= need) return true
  }
  return false
}

export function scoreQuery(corpus, query, opts = {}) {
  const qTokens = tokenize(query)
  if (qTokens.length === 0 || corpus.n === 0) return []
  const idfOf = t => idf(corpus.df, corpus.n, t)

  // ★ 去掉**通用词**：在语料里出现比例过高的查询词不携带区分度。
  //
  //   为什么要有这一步：中文没有词边界，分词器输出的是字符二元组，而「的」
  //   是最常见的汉字——实测在 19 页真实语料里出现在 **15 页**（df=15/19≈0.79），
  //   而且 tf 很高。它和内容词被同等对待，于是：
  //
  //     查询「Rust 的 borrow checker 报错怎么绕过」→ top1 得 0.3737，
  //     比 13 条真实正例里的 4 条还高。它真正命中的词是
  //     「的」(df=15)、「报错」(4)、「怎么」(4)、「绕过」(2) ——
  //     撑起分数的主要是「的」。
  //
  //   后果不是"排名不理想"，而是**把无关页面的正文注进提示词**：
  //   既浪费上下文，又误导模型。这比不注入更糟。
  //
  //   判据用**比例**而不是绝对 df，因为它必须随语料规模缩放。
  //   阈值 0.5 的含义：出现在超过一半文档里的词，以及问句里的万能词
  //   （怎么/如何/报错）在真实语料里通常也落在这一带。它只过滤掉
  //   "几乎哪一页都有"的那几个词，不碰真正的领域词。
  //
  //   ★ 全部词都被滤掉时直接返回空：一个只由通用词组成的查询
  //     本来就无法区分任何东西，返回命中才是错的。
  //
  //   ★ 下限必须是 2，不能是 1。
  //     纯比例的做法在小语料上会退化：n=2 时 floor(2×0.2)=0 → 所有词都被滤掉
  //     → 检索永远返回空。而插件**冷启动时正是这个状态**（0–5 页），
  //     那等于"刚装上的头几天什么都召回不了"。
  //     实测：加了下限之后，verify-usage 的 2 页夹具恢复正常，
  //     而 n=19 的真实语料上 maxDf 仍然是 3 —— **已标定的行为一字未变**。
  const maxDf = Math.max(2, Math.floor(corpus.n * (opts.maxDfRatio ?? DEFAULTS.maxDfRatio ?? 0.2)))
  const uniq = [...new Set(qTokens)].filter(t => (corpus.df.get(t) ?? 0) <= maxDf)
  if (uniq.length === 0) return []

  // 语料里不存在的查询词只能拿到「中性权重」，不能拿最大 IDF。
  //
  // 这是一个真实的坑：idf() 对 df=0 的词返回的是上界
  // （ln(1+(N+0.5)/0.5)，N=1 时约 1.386），而语料内常见词只有约 0.288 ——
  // 差 5 倍。于是每个自然语言查询里那些永远不可能命中的词（中文二元组分词
  // 产生的"议的/的分/帧和"这类跨边界噪声）反而主导了分母，
  // 把所有查询的分数系统性压到接近 0，导致几乎每轮都判 miss、
  // 反复触发联网补料。实测"Widget 协议的分帧和魔数是什么"因此从 0.094
  // （误判 miss）回到命中区间。
  //
  // 中性权重取语料内词的平均 IDF：既不因为"没见过"而被夸大，
  // 也仍然让"大量词都对不上"真实地拉低覆盖率（这正是我们要的区分度——
  // 单靠一个常见词命中的查询不该拿高分）。
  const present = uniq.filter(t => (corpus.df.get(t) ?? 0) > 0)
  if (present.length === 0) return []
  const neutralIdf = present.reduce((s, t) => s + idfOf(t), 0) / present.length
  const weightOf = t => ((corpus.df.get(t) ?? 0) > 0 ? idfOf(t) : neutralIdf)
  const totalIdf = uniq.reduce((s, t) => s + weightOf(t), 0)
  if (totalIdf <= 0) return []
  const out = []
  for (const d of corpus.docs) {
    let matchedIdf = 0, satNum = 0
    for (const t of uniq) {
      const w = idf(corpus.df, corpus.n, t)
      const f = d.tf.get(t)
      if (!f) continue
      matchedIdf += w
      satNum += w * (f / (f + K1))
    }
    if (matchedIdf <= 0) continue
    const coverage = matchedIdf / totalIdf
    const saturation = satNum / totalIdf
    // ★ 再乘一个"查询里有多少词**语料里根本没有**"的折扣。
    //
    //   为什么单靠覆盖率不够（实测 2026-09-16，66 页语料）：
    //     负例「如何配置 kubernetes sidecar 注入策略」的 7 个稀有关键词里，
    //     kubernetes / 如何 / 何配 三个**整个语料里都不存在**，而
    //     sidecar(1) + 注入(13) + 策略(2) 三个恰好都出现在同一页里 ——
    //     于是覆盖率 0.2665、总分 0.223，越过 0.20 判成 hit，
    //     而全语料里**没有任何一页提到 kubernetes**。
    //   乘上折扣后它掉到 0.111（miss），正例几乎不动（它们问的是语料里真有的东西）。
    //
    //   ★ 折扣只算**标识符型**的缺词（拉丁字母/数字/下划线跑出来的词），
    //     不算中文二元组的缺词。这一条是被自检逼出来的：
    //     第一版对**所有**缺词一视同仁，结果中文正例被误伤 ——
    //     中文查询靠字符二元组分词，本来就会切出一堆语料里不存在的组合
    //     （「何配」「入策」这种），把那些也算成"语料里没有这个词"，
    //     等于系统性惩罚所有中文查询（实测 verify-subagent-guard 里一条
    //     真实正例从 hit 掉到 weak）。
    //     而真正要挡的是 **kubernetes** 这种"用户问了一个语料里根本没有的技术名词"。
    const isIdentifier = (t) => /^[a-z0-9_]+$/.test(t)
    const missingIds = uniq.filter(t => isIdentifier(t) && (corpus.df.get(t) ?? 0) === 0).length
    const idTokens = uniq.filter(isIdentifier).length
    const absentRatio = (idTokens + 1 - missingIds) / (idTokens + 1)
    const similarity = (0.7 * coverage + 0.3 * saturation) * absentRatio
    // 强化因子只做乘法，所以相似度排序在无证据时完全不变 ——
    // 阈值标定的语义不被破坏。
    const factor = opts.stats ? reinforcementFactor(opts.stats[d.page.id], opts.now) : 1
    const score = similarity * factor
    const hit = {
      page: d.page,
      score: Number(score.toFixed(4)),
      coverage: Number(coverage.toFixed(4)),
    }
    if (opts.explain) {
      hit.similarity = Number(similarity.toFixed(4))
      hit.factor = Number(factor.toFixed(4))
    }
    out.push(hit)
  }
  return out.sort((a, b) => b.score - a.score)
}

/**
 * CRAG 三分桶。
 *   hit  score >= hitThreshold          → 直接注入
 *   weak weakThreshold <= score < hit   → 注入但标注低置信
 *   miss score < weakThreshold          → 进 gap 队列，触发后台补料
 */
// 阈值**只从 config 取**，这里不再自带一份默认值。
// 曾经两处各写一份 0.20/0.13，改了一处另一处静默不动——测试走的是这一份，
// 于是"调了阈值但行为没变"，查起来毫无线索。
// 打分依赖语料规模，换语料/语料显著增长后必须重跑标定（scripts/calibrate.mjs）。
export function triage(hits, { hitThreshold = DEFAULTS.hitThreshold, weakThreshold = DEFAULTS.weakThreshold } = {}) {
  // 防呆：阈值一旦不是有限数，score >= undefined 恒为 false，
  // 三分桶会静默退化成"永远 miss"，没有任何报错。
  if (!Number.isFinite(hitThreshold) || !Number.isFinite(weakThreshold)) {
    throw new Error('triage: 阈值必须是有限数，收到 hit=' + hitThreshold + ' weak=' + weakThreshold)
  }
  const hit = [], weak = []
  for (const h of hits) {
    if (h.score >= hitThreshold) hit.push(h)
    else if (h.score >= weakThreshold) weak.push(h)
  }
  const bucket = hit.length > 0 ? 'hit' : (weak.length > 0 ? 'weak' : 'miss')
  const best = hits[0]?.score ?? 0
  return { bucket, hit, weak, best }
}

/**
 * 过滤出允许参与召回的页。
 *
 * includeQuarantined 的默认值是 false —— 也就是**自动注入会跳过被隔离的页**。
 * 但显式 wiki_recall 应传 true：被隔离只意味着"不再自动塞给模型"，
 * 不意味着"不许查"。我们没能力断定一条知识是错的，所以只掐自动那条路。
 */
export function recallable(pages, {
  minConfidence = 0.3,
  usage = null,
  policy = DEFAULT_POLICY,
  includeQuarantined = false,
  includeMeta = false,
} = {}) {
  return pages.filter(p => {
    if (p.status !== 'committed') return false
    if (Number(p.confidence) < minConfidence) return false
    // ★ 自省页（meta）默认不参与**自动注入**。
    //
    //   为什么（实测 2026-09-16）：note-ca2525 那一页讲的是"高频字污染覆盖度打分"
    //   这个缺陷，正文里引用了标定用的负例查询当例子。于是那条负例拿到了
    //   **7/7 稀有关键词全中、0.836 分** —— 比 13 条正例里的**最高分**还高。
    //
    //   分数本身没错：那一页确实在讲同一批词。错的是**去向**：它是"关于这个
    //   检索系统自己"的页，把它的正文注进提示词，既占了上下文，又是在用
    //   测试语料回答用户；更糟的是它会**抬高标定本身**——度量被度量对象污染。
    //
    //   与小节里"隔离"的处理方式一致：只掐自动那条路。显式 wiki_recall 传
    //   includeMeta: true，仍然查得到（问答"检索打分是怎么标定的"时它正是答案）。
    if (!includeMeta && Array.isArray(p.tags) && p.tags.includes('meta')) return false
    if (!includeQuarantined && usage && shouldQuarantine(usage[p.id], policy)) return false
    return true
  })
}

/** 渲染注入块（给模型看的 Markdown）。 */
export function renderContext(triageResult, { maxChars = 4000 } = {}) {
  const lines = []
  const take = (arr, label) => {
    for (const h of arr) {
      const p = h.page
      lines.push(`- [${p.id}] (${p.category}, conf ${p.confidence}, score ${h.score}) ${p.title}`)
    }
  }
  if (triageResult.hit.length) { lines.push('## 已确认知识'); take(triageResult.hit) }
  if (triageResult.weak.length) { lines.push('## 弱相关（低置信，需自行判断）'); take(triageResult.weak) }
  let text = lines.join('\n')
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…(截断)'
  return text
}
