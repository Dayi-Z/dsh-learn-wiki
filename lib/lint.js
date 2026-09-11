// wiki lint：死链 / 重复 / 过期。
//
// 三条设计原则，都是这个项目已经交过学费的：
//
//   1. **查不到 ≠ 没有**（知识页 scoped-registry-empty-result）。
//      URL 来源离线**无法验证**。那就必须报"没查"，不能报"正常" ——
//      "看起来全绿"和"真的全绿"是两件事，混起来比不做检查更危险。
//
//   2. **口径只能有一套**。"过期"直接复用 usage.js 的 classify()，
//      不另造阈值。否则界面说 A、lint 说 B，人就得自己去对账。
//
//   3. **lint 只读**。它报告，不改任何文件。要改由人来按。
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { tokenize } from './recall.js'
import { classify, DEFAULT_POLICY } from './usage.js'
import { listSessions } from './session-store.js'

/** 一张页面的全部 id（pages/ + staged/），死链判据的唯一来源。 */
export function knownIds(pages) {
  const s = new Set()
  for (const p of pages) if (p.id) s.add(p.id)
  return s
}

/**
 * 抽出正文里的 wiki 链接。
 *
 * 支持两种写法，因为两种都在用：\`[[page:<id>]]\` 和 \`[[<id>]]\`。
 * （实测本机 25 页里只出现 1 条 —— 约定在，但几乎没人用。
 *  所以 lint 报出来的死链数量天然会很少，这不是检查失效。）
 */
export function extractWikiLinks(body) {
  const out = []
  for (const m of String(body ?? '').matchAll(/\[\[([^\]]+)\]\]/g)) {
    const raw = m[1].trim()
    const target = raw.replace(/^page\s*[:：]\s*/i, '').trim()
    if (target) out.push({ raw, target })
  }
  return out
}

/** 死链：指向了不存在的页。**离线可判定**，所以这条结论是硬的。 */
export function findBrokenLinks(pages) {
  const known = knownIds(pages)
  const out = []
  for (const p of pages) {
    for (const l of extractWikiLinks(p.body)) {
      if (known.has(l.target)) continue
      out.push({ from: p.id, link: l.raw, target: l.target, reason: '没有这个 id 的页面' })
    }
  }
  return out
}

/**
 * 来源可溯性。
 *
 * ★ 分类是**故意的**，因为三类证据强度完全不同：
 *
 *   url        —— 离线无法验证。计入 unchecked，**永远不报 ok**。
 *   session:// —— 能查（会话文件在不在）。
 *   本地路径   —— 能查。但**只有绝对路径**的失败才算 dead：
 *                 裸文件名（如 \`acquire.js\`）不知道相对谁，解析不出来是
 *                 "我不知道"，不是"它不见了"。把后者报成死链就是诬告。
 */
/**
 * 一条 source 是什么**种类**的东西。
 *
 * ★ 为什么需要分型：真实数据里混着四种完全不同的东西，而它们的修法各不相同：
 *     url    —— 网页。离线不验证。
 *     page   —— **指向另一页的 id**（如 \`hindsight-pid-c5783a\`）。这是合法的
 *               内部交叉引用，**不是**"不像指针"。第一版把它误报了 ——
 *               语法判据（有没有斜杠/扩展名）看不出它其实有含义。
 *     path   —— 文件路径或带扩展名的文件名。
 *     weak   —— 确实不是来源。实测本机有整句话被塞进 sources：
 *               \`"context_audit detail=developer receipt (71 tools"\`。
 *
 *   把 weak 和"路径没找到"混在一起报，人就分不清该修哪个 ——
 *   前者要补来源，后者要改基准目录。
 */
export function classifySource(s, { known = new Set() } = {}) {
  const str = String(s ?? '').trim()
  if (!str) return { kind: 'weak', why: '空字符串' }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(str)) return { kind: 'url' }
  if (known.has(str)) return { kind: 'page' }                  // 内部交叉引用
  if (isAbsolute(str)) return { kind: 'path' }
  if (/;/.test(str)) return { kind: 'weak', why: '多个来源挤在一个字符串里（应当是列表的多项）' }
  if (/[\/\\]/.test(str)) return { kind: 'path' }
  if (/\.[a-z0-9]{1,6}$/i.test(str)) return { kind: 'path' }
  if (/\s/.test(str)) return { kind: 'weak', why: '像一句话，不是来源' }
  return { kind: 'weak', why: '既不是 URL / 路径 / 扩展名，也不是已知的页面 id' }
}

export function inspectSources(pages, { exists = existsSync, wikiRoot = null, pluginRoot = null, sessionIds = null, known = knownIds(pages) } = {}) {
  const dead = []
  const unresolved = []
  const weak = []
  let urls = 0
  let ok = 0

  const checkPath = (s) => {
    if (isAbsolute(s)) return exists(resolve(s))
    // 相对路径与裸文件名：在**已知的两个基准**下找。找到就算数；
    // 找不到也只能说"解析不出来"，不能断言它没了。
    const bases = [wikiRoot, pluginRoot].filter(Boolean)
    for (const b of bases) if (exists(resolve(b, s))) return true
    return null
  }

  for (const p of pages) {
    for (const s of (p.sources ?? [])) {
      const str = String(s)
      const cls = classifySource(str, { known })
      // 分型之后各走各的。weak 说明"这里压根没给线索"，
      // 对它做存在性检查毫无意义，报成"无法解析"会把人引到错误的修法上。
      if (cls.kind === 'weak') { weak.push({ page: p.id, source: str, why: cls.why }); continue }
      // 指向另一页的 id：合法来源，直接算数（它指的是知识库内部的东西）
      if (cls.kind === 'page') { ok++; continue }
      if (/^https?:\/\//i.test(str)) { urls++; continue }
      if (/^session:\/\//i.test(str)) {
        const id = str.replace(/^session:\/\//i, '').trim()
        if (!sessionIds) { unresolved.push({ page: p.id, source: str, why: '拿不到会话清单' }); continue }
        if (sessionIds.has(id) || sessionIds.has(id.slice(0, 8))) ok++
        else dead.push({ page: p.id, source: str, why: '没有这个会话' })
        continue
      }
      const r = checkPath(str)
      if (r === true) ok++
      else if (r === false) dead.push({ page: p.id, source: str, why: '文件不存在' })
      else unresolved.push({ page: p.id, source: str, why: '裸文件名/相对名，无法确定基准目录' })
    }
  }
  return { dead, unresolved, weak, urls, ok }
}

function tfOf(page) {
  const tf = new Map()
  const add = (toks, w) => { for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + w) }
  add(tokenize(page.title), 3)
  add(tokenize((page.tags ?? []).join(' ')), 2.5)
  add(tokenize(page.body), 1)
  return tf
}

function cosine(a, b) {
  let dot = 0
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  for (const [t, v] of small) { const w = big.get(t); if (w) dot += v * w }
  let na = 0; for (const v of a.values()) na += v * v
  let nb = 0; for (const v of b.values()) nb += v * v
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * 重复：两两余弦相似度超过阈值。
 *
 * 为什么用余弦而不是"标题一样"：自动沉淀最常见的坏形态不是抄标题，
 * 而是**同一件事从不同角度写了两遍**，措辞不同、标题也不同。
 *
 * 复杂度 O(n²)。本机 25 页 ≈ 300 对，可以忽略；真到几千页要换分桶，
 * 那时候再说 —— 现在为它上倒排索引是过度设计。
 */
export function findDuplicates(pages, { threshold = 0.72 } = {}) {
  const tfs = pages.map(p => ({ id: p.id, tf: tfOf(p) }))
  const pairs = []
  for (let i = 0; i < tfs.length; i++) {
    for (let j = i + 1; j < tfs.length; j++) {
      const s = cosine(tfs[i].tf, tfs[j].tf)
      if (s >= threshold) pairs.push({ a: tfs[i].id, b: tfs[j].id, score: Number(s.toFixed(4)) })
    }
  }
  pairs.sort((x, y) => y.score - x.score)
  return pairs
}

/**
 * 过期：**复用 classify()**，不另造阈值。
 *
 * classify 已经把"零命中 + 页龄 ≥ deadAfterDays"判成 dead，并且特意
 * 区分了"昨天刚写的零命中"（正常）与"三周前的零命中"（没价值）。
 * lint 只是把它跑一遍、把 dead 挑出来。
 */
export function findStale(pages, usage, { now = Date.now(), policy = DEFAULT_POLICY } = {}) {
  const out = []
  for (const p of pages) {
    const st = usage?.pages?.[p.id]
    if (classify(st, p, { now, policy }) !== 'dead') continue
    const ts = Date.parse(p.created ?? '')
    out.push({
      id: p.id,
      ageDays: Number.isFinite(ts) ? Math.round((now - ts) / 86400000) : null,
      hits: st?.hits ?? 0,
      created: p.created ?? null,
    })
  }
  out.sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0))
  return out
}

/**
 * 跑全套。**只读**。
 *
 * @returns 一份结构化报告 + 一段人读的渲染
 */
export async function lintWiki(wikiRoot, { pages, usage, policy = DEFAULT_POLICY, now = Date.now(), exists = existsSync, pluginRoot = null, sessionIds = null } = {}) {
  let ids = sessionIds
  if (!ids) {
    ids = new Set()
    try {
      for (const s of listSessions({})) ids.add(s.id)
    } catch { ids = null }   // 拿不到就如实报"没查"，不假装干净
  }
  const brokenLinks = findBrokenLinks(pages)
  const sources = inspectSources(pages, { exists, wikiRoot, pluginRoot, sessionIds: ids })
  const duplicates = findDuplicates(pages)
  const stale = findStale(pages, usage, { now, policy })

  const findings = brokenLinks.length + sources.dead.length + sources.weak.length + duplicates.length + stale.length
  return {
    ok: true,
    scanned: pages.length,
    brokenLinks, deadSources: sources.dead, weakSources: sources.weak, duplicates, stale,
    sources: { ok: sources.ok, urlsUnchecked: sources.urls, unresolved: sources.unresolved },
    findings,
    // ★ 必须把"这次没查什么"写在结果里。一个只报"0 个问题"的 lint
    //   会让人以为全都检查过了 —— 而 URL 那 72 条一条都没查。
    notChecked: [
      sources.urls ? sources.urls + ' 条 URL 来源未验证（离线无法验证；要查需联网）' : null,
      sources.unresolved.length ? sources.unresolved.length + ' 条裸文件名/相对名无法确定基准目录' : null,
      ids === null ? '会话清单拿不到，session:// 来源未验证' : null,
    ].filter(Boolean),
  }
}

/** 渲染成人读文本。findings 为 0 时也要说清"没查什么"。 */
export function renderLint(r) {
  const L = []
  L.push('扫描 ' + r.scanned + ' 页，发现 ' + r.findings + ' 处问题。')
  const sec = (title, rows, fmt) => {
    if (!rows.length) return
    L.push('')
    L.push('── ' + title + '（' + rows.length + '）──')
    for (const x of rows) L.push('  ' + fmt(x))
  }
  sec('死链', r.brokenLinks, x => x.from + ' → ' + x.link + '：' + x.reason)
  sec('来源失效', r.deadSources, x => x.page + ' → ' + x.source + '：' + x.why)
  sec('来源不像指针', r.weakSources, x => x.page + ' → ' + JSON.stringify(String(x.source).slice(0, 60)))
  sec('疑似重复', r.duplicates, x => x.a + ' ≈ ' + x.b + '（' + x.score + '）')
  sec('过期（零命中且超过页龄阈值）', r.stale, x => x.id + '：' + (x.ageDays ?? '?') + ' 天，命中 ' + x.hits + ' 次')
  if (r.notChecked.length) {
    L.push('')
    L.push('── 这次**没有**检查的 ──')
    for (const n of r.notChecked) L.push('  · ' + n)
  }
  if (r.findings === 0) L.push('没有发现问题。注意上面"没有检查的"那一段 —— 它决定了这个"没有问题"能覆盖多少。')
  return L.join('\n')
}
