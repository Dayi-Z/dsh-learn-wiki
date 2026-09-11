// 命中率与补料收益度量。
//
// ── 为什么需要 ──
//
// 这套东西会**自动联网、自动蒸馏、自动落暂存**。但"它到底有没有用"从来
// 没有被量过 —— 而一个不被度量的自动化，最可能的结局是安静地烧资源。
// 这个模块回答三个问题：
//   1. 注入出去的上下文，有多少真的被用上了？（命中率）
//   2. 补料花的每一次联网，最终变成几条**被确认过**的知识？（漏斗）
//   3. 知识库里有多少是从没被命中过的？（利用率）
//
// ── 三条必须守住的诚实边界 ──
//
// 1. **日志是文本，不是账本**。所有日志派生的计数都是**下界**：
//    日志被轮转/截断过的话，真实发生过的只会更多。所以结果里必须报出
//    日志的时间跨度，否则那个百分比没有分母可言。
//
// 2. **confirmed 是弱信号**，不是"成功"。它的定义是"命中后该轮没再挣扎"，
//    而"没再挣扎"可能是别的原因 —— 用户换了个做法、或者干脆放弃了。
//    把它说成成功率就是在撒谎。
//
// 3. **相关不等于因果**。补料之后的页面被确认，不能证明是补料解决了问题。
//    漏斗只能说明"流量走到哪一步"，不能说明"是谁的功劳"。

const RE = {
  inject: /inject bucket=(\w+) best=([\d.]+) hit=(\d+) weak=(\d+)/,
  staged: /staged: (\S+) \(gap (\w+)\)/,
  acquire: /background acquisition \((\S+)\): (\{.*\})/,
  deliver: /deliver: (.+?) -> (\S+)\s*$/,
  usage: /usage: (.+)$/,
  fetch: /fetched (\d+) chars/,
}

/** 把日志解析成结构化事件。**只解析，不做判断**。 */
export function parseLog(text) {
  const out = { injections: [], stagings: [], acquisitions: [], deliveries: [], usage: [], fetches: [], total: 0, from: null, to: null }
  const lines = String(text ?? '').split('\n')
  for (const line of lines) {
    if (!line.trim()) continue
    out.total++
    const ts = (line.match(/^\[([^\]]+)\]/) || [])[1] || null
    if (ts) { if (!out.from) out.from = ts; out.to = ts }
    let m
    if ((m = line.match(RE.inject))) out.injections.push({ ts, bucket: m[1], best: Number(m[2]), hit: Number(m[3]), weak: Number(m[4]) })
    else if ((m = line.match(RE.staged))) out.stagings.push({ ts, page: m[1], gap: m[2] })
    else if ((m = line.match(RE.acquire))) {
      let counts = null
      try { counts = JSON.parse(m[2]) } catch { /* 日志里的 JSON 坏了就留空，不编 */ }
      out.acquisitions.push({ ts, phase: m[1], ...(counts || {}) })
    } else if ((m = line.match(RE.deliver))) out.deliveries.push({ ts, text: m[1], page: m[2] })
    else if ((m = line.match(RE.usage))) out.usage.push({ ts, text: m[1] })
    else if ((m = line.match(RE.fetch))) out.fetches.push({ ts, chars: Number(m[1]) })
  }
  return out
}

/** 注入命中率：三分桶各占多少。 */
export function injectionStats(injections) {
  const by = {}
  for (const i of injections) by[i.bucket] = (by[i.bucket] ?? 0) + 1
  const n = injections.length
  const hits = by.hit ?? 0
  const weak = by.weak ?? 0
  return {
    total: n,
    byBucket: by,
    hitRate: n ? Number((hits / n).toFixed(4)) : null,
    weakRate: n ? Number((weak / n).toFixed(4)) : null,
    // miss 不进日志（没东西可注入时不会打这行），所以这里**不下** miss 的结论。
    note: 'miss 桶不会写进日志（没东西可注入时没有这行），所以这里的比例只覆盖"有注入发生"的那些轮次。',
  }
}

/**
 * 补料漏斗：缺口 -> 落暂存 -> 固化 -> 被确认。
 *
 * @param gaps   gaps/queue.jsonl 的条目
 * @param log    parseLog() 的结果
 * @param pages  已加载的全部页面
 * @param usage  使用账本
 */
export function acquisitionRoi({ gaps = [], log, pages = [], usage = {} }) {
  const stagedByGap = new Map()
  for (const s of log.stagings) {
    if (!stagedByGap.has(s.gap)) stagedByGap.set(s.gap, [])
    stagedByGap.get(s.gap).push(s.page)
  }
  const byId = new Map(pages.map(p => [p.id, p]))
  const committedIds = new Set(pages.filter(p => p.status === 'committed').map(p => p.id))

  const seen = new Set()
  const rows = []
  for (const g of gaps) {
    if (seen.has(g.id)) continue
    seen.add(g.id)
    const produced = stagedByGap.get(g.id) ?? []
    const gotCommitted = produced.filter(id => committedIds.has(id))
    const confirmed = gotCommitted.filter(id => (usage.pages?.[id]?.confirmed ?? 0) > 0)
    const hitAtLeastOnce = gotCommitted.filter(id => (usage.pages?.[id]?.hits ?? 0) > 0)
    rows.push({
      gap: g.id,
      status: g.status,
      seen: g.seen ?? null,
      attempts: g.attempts ?? null,
      produced,
      committed: gotCommitted,
      confirmed,
      hit: hitAtLeastOnce,
      reason: (g.lastReason || '').slice(0, 160),
    })
  }

  const attempts = rows.reduce((n, r) => n + (r.attempts ?? 0), 0)
  const producedN = rows.reduce((n, r) => n + r.produced.length, 0)
  const committedN = rows.reduce((n, r) => n + r.committed.length, 0)
  const confirmedN = rows.reduce((n, r) => n + r.confirmed.length, 0)

  // 拒绝原因归类：蒸馏器**允许拒绝**，这是防稀释的第一道闸。
  // 所以"拒绝"不是失败 —— 但拒绝的理由分布能说明**查询质量**。
  const why = { noFetch: 0, refused: 0, other: 0 }
  for (const r of rows) {
    if (r.produced.length) continue
    if (/没有抓取到任何页面|0 page\(s\) fetched|fetched page content 为空/.test(r.reason)) why.noFetch++
    else if (r.reason) why.refused++
    else why.other++
  }

  return {
    gaps: rows.length,
    attempts,
    produced: producedN,
    committed: committedN,
    confirmed: confirmedN,
    funnel: { gap: rows.length, produced: producedN, committed: committedN, confirmed: confirmedN },
    skipReasons: why,
    rows,
    note: 'confirmed 是弱信号（"命中后没再挣扎"），不是成功率；补料之后的页被确认也不能证明是补料解决了问题。',
  }
}

/** 知识库利用率：多少页从没被命中过。 */
export function libraryUsage(pages, usage = {}, { now = Date.now() } = {}) {
  const committed = pages.filter(p => p.status === 'committed')
  let hit = 0, confirmed = 0, suspect = 0, never = 0
  const neverIds = []
  for (const p of committed) {
    const st = usage.pages?.[p.id]
    const h = st?.hits ?? 0
    if (h > 0) hit++; else { never++; neverIds.push(p.id) }
    if ((st?.confirmed ?? 0) > 0) confirmed++
    if ((st?.suspect ?? 0) > 0) suspect++
  }
  return {
    committed: committed.length,
    everHit: hit,
    neverHit: never,
    neverHitIds: neverIds.slice(0, 20),
    confirmed: confirmed,
    suspect: suspect,
    utilization: committed.length ? Number((hit / committed.length).toFixed(4)) : null,
  }
}

/** 汇总。**不编数字**：拿不到的分母一律给 null，而不是给 0。 */
export function buildMetrics({ logText, gaps = [], pages = [], usage = {}, now = Date.now() } = {}) {
  const log = parseLog(logText)
  const inj = injectionStats(log.injections)
  const roi = acquisitionRoi({ gaps, log, pages, usage })
  const lib = libraryUsage(pages, usage, { now })
  return {
    window: { from: log.from, to: log.to, logLines: log.total },
    injections: inj,
    acquisition: roi,
    library: lib,
    // ★ 这三个数字必须跟着结果一起走。没有它们，上面每个比例都可能被
    //   当成"全部发生过的事"，而实际上只是"日志里还留着的事"。
    caveats: [
      '日志派生的计数是**下界**：日志若被轮转或截断，真实发生过的只会更多（本次窗口 ' + (log.from ?? '?') + ' ~ ' + (log.to ?? '?') + '）',
      'miss 桶不写日志，所以注入比例只覆盖"有注入发生"的轮次',
      'confirmed 是弱信号，不等于"补料有用"；相关不等于因果',
      gaps.some(g => g.status === 'pending') ? '队列里还有 pending 的缺口没跑完，漏斗未封口' : null,
    ].filter(Boolean),
  }
}

/** 渲染成人读文本。 */
export function renderMetrics(m) {
  const L = []
  const pct = (x) => x === null || x === undefined ? '—' : (x * 100).toFixed(1) + '%'
  L.push('日志窗口 ' + (m.window.from ?? '?') + ' ~ ' + (m.window.to ?? '?') + '（' + m.window.logLines + ' 行）')
  L.push('')
  L.push('── 注入 ──')
  L.push('  共 ' + m.injections.total + ' 次有内容的注入：hit ' + (m.injections.byBucket.hit ?? 0)
    + ' / weak ' + (m.injections.byBucket.weak ?? 0) + '（hit 占 ' + pct(m.injections.hitRate) + '）')
  L.push('')
  L.push('── 补料漏斗 ──')
  const f = m.acquisition.funnel
  L.push('  缺口 ' + m.acquisition.gaps + '（尝试 ' + m.acquisition.attempts + ' 次）'
    + ' → 落暂存 ' + f.produced + ' → 固化 ' + f.committed + ' → 被确认 ' + f.confirmed)
  L.push('  没产出的缺口：抓不到正文 ' + m.acquisition.skipReasons.noFetch
    + ' / 蒸馏器拒绝 ' + m.acquisition.skipReasons.refused
    + ' / 其它 ' + m.acquisition.skipReasons.other)
  const refused = m.acquisition.rows.filter(r => !r.produced.length && r.reason).slice(0, 3)
  for (const r of refused) L.push('    · ' + r.gap + '：' + r.reason.slice(0, 90))
  L.push('')
  L.push('── 知识库利用率 ──')
  L.push('  已固化 ' + m.library.committed + ' 页；被命中过 ' + m.library.everHit
    + '，从没命中过 ' + m.library.neverHit + '（利用率 ' + pct(m.library.utilization) + '）')
  L.push('  有确认证据 ' + m.library.confirmed + ' / 有反证 ' + m.library.suspect)
  if (m.library.neverHitIds.length) L.push('    · 从没命中过：' + m.library.neverHitIds.slice(0, 8).join(', ') + (m.library.neverHit > 8 ? ' …' : ''))
  L.push('')
  L.push('── 这些数字不能说明什么 ──')
  for (const c of m.caveats) L.push('  · ' + c)
  return L.join('\n')
}
