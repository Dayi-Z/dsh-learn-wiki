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

/** 对查询打分。返回按 score 降序的命中数组。 */
export function scoreQuery(corpus, query) {
  const qTokens = tokenize(query)
  if (qTokens.length === 0 || corpus.n === 0) return []
  const uniq = [...new Set(qTokens)]
  const idfOf = t => idf(corpus.df, corpus.n, t)

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
    const score = 0.7 * coverage + 0.3 * saturation
    out.push({ page: d.page, score: Number(score.toFixed(4)), coverage: Number(coverage.toFixed(4)) })
  }
  return out.sort((a, b) => b.score - a.score)
}

/**
 * CRAG 三分桶。
 *   hit  score >= hitThreshold          → 直接注入
 *   weak weakThreshold <= score < hit   → 注入但标注低置信
 *   miss score < weakThreshold          → 进 gap 队列，触发后台补料
 */
// 阈值来自 scripts/calibrate.mjs 的实测标定（7 正例 / 5 负例）：
//   正例 0.152–0.541，负例 0.000–0.105 → weak=0.13 分开两类，hit=0.20 留余量。
// 打分依赖语料规模，换语料/语料显著增长后必须重跑标定。
export function triage(hits, { hitThreshold = 0.20, weakThreshold = 0.13 } = {}) {
  const hit = [], weak = []
  for (const h of hits) {
    if (h.score >= hitThreshold) hit.push(h)
    else if (h.score >= weakThreshold) weak.push(h)
  }
  const bucket = hit.length > 0 ? 'hit' : (weak.length > 0 ? 'weak' : 'miss')
  const best = hits[0]?.score ?? 0
  return { bucket, hit, weak, best }
}

/** 过滤出允许参与召回的页，并构造语料。 */
export function recallable(pages, { minConfidence = 0.3 } = {}) {
  return pages.filter(p => p.status === 'committed' && Number(p.confidence) >= minConfidence)
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
