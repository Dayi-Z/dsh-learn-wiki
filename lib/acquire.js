// L3 采集层：gap 队列 → 限流联网 → 蒸馏 → 落 staged。
//
// 关键设计：
//   * 非阻塞 —— 本层只在 turn/end 之后后台跑，绝不打断正在进行的轮次
//   * 可拒绝 —— 蒸馏允许返回 {skip:true}。搜到的东西答不上这个缺口就不写，
//               这是防止知识库被稀释/投毒的第一道闸
//   * 不直接进 L1 —— 一律落 staged/，要经 commit 才升入 pages/
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { extractJson } from './llm.js'
import { savePage, deriveId } from './wiki.js'
import { looksLikeGap } from './recall.js'

const GAPS = 'gaps/queue.jsonl'

export function hashQuery(q) {
  const norm = String(q ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
  return createHash('sha256').update(norm).digest('hex').slice(0, 12)
}

export async function readGaps(repoRoot) {
  try {
    const raw = await readFile(join(repoRoot, GAPS), 'utf8')
    return raw.split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

export async function writeGaps(repoRoot, gaps) {
  await mkdir(join(repoRoot, 'gaps'), { recursive: true })
  await writeFile(join(repoRoot, GAPS), gaps.map(g => JSON.stringify(g)).join('\n') + (gaps.length ? '\n' : ''), 'utf8')
}

/** 记一条检索未命中。同一 query 只保留一条，重复出现累加 seen。 */
export async function appendGap(repoRoot, { query, score, sessionId = '' }) {
  const id = hashQuery(query)
  const gaps = await readGaps(repoRoot)
  const now = new Date().toISOString()
  const existing = gaps.find(g => g.id === id)
  if (existing) {
    existing.seen = (existing.seen ?? 1) + 1
    existing.lastSeen = now
    existing.score = score
    // 刻意不把 done/skipped/abandoned 复位为 pending：
    // 否则一个查不到的缺口会每轮重新触发联网，费用与噪声都会失控。
    // 需要重查时走 wiki_review 显式重置。
  } else {
    gaps.push({ id, query: String(query).slice(0, 500), score, sessionId, status: 'pending', attempts: 0, seen: 1, firstSeen: now, lastSeen: now })
  }
  await writeGaps(repoRoot, gaps)
  return id
}

const DISTILL_SYSTEM = [
  'You distill durable, reusable knowledge from web search results for a developer knowledge base.',
  'You are strictly grounded: use ONLY the provided search results. Never add facts from your own memory.',
  'If the results do not actually answer the question, you MUST refuse by returning {"skip": true, "reason": "..."}.',
  'Refusing is always better than writing a weakly-supported page. Most gaps should NOT produce a page.',
  'Output STRICT JSON only, no prose, no markdown fences.',
].join(' ')

/** 极简 HTML → 文本。只求够蒸馏用，不追求完美还原。 */
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const MAX_RAW = 800000

/**
 * 取一个 URL 的正文。
 *
 * 两级策略，因为宿主未必有 fetch 能力：@deepseek-ai/dsh-web 里有
 * registerFetchProvider 这套 seam，但随包发布的只有 dsh-web-search-deepseek，
 * 没有 *-fetch-* 实现。本 profile 实测 ctx.web.fetch 不是函数 ——
 * 于是"直连兜底"在这里是常态而非例外。
 *
 * 之前把 fetch 缺失当成"取不到正文"直接返回空数组，结果两条 gap 都因为
 * "0 page(s) fetched" 被蒸馏器正确拒绝。缺的从来不是判断力，是料。
 */
export async function fetchUrlText(ctx, url, { timeoutMs = 15000 } = {}) {
  // 1) 优先走宿主 seam：将来若注册了 fetch provider，可复用其合规策略与配置
  if (typeof ctx?.web?.fetch === 'function') {
    try {
      const r = await ctx.web.fetch({ url })
      if (r && (r.statusCode === undefined || r.statusCode < 400)) {
        const content = r.body?.content ?? ''
        const text = r.body?.kind === 'text' ? content : htmlToText(content)
        if (String(text).trim()) return String(text)
      }
    } catch { /* 无 provider 时会抛，落到直连兜底 */ }
  }
  // 2) 直连兜底
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'text/html,text/plain,*/*;q=0.8' },
      signal: ctrl.signal,
    })
    if (!res.ok) return ''
    const raw = (await res.text()).slice(0, MAX_RAW)
    if (!raw) return ''
    const ct = res.headers.get('content-type') ?? ''
    return /html/i.test(ct) ? htmlToText(raw) : raw.trim()
  } catch {
    return ''
  } finally {
    clearTimeout(timer)
  }
}

/** 抓取若干来源的正文。任一页失败都不影响整体——蒸馏器仍可基于其余证据判断或拒绝。 */
async function fetchEvidence(ctx, sources, cfg, log) {
  if (!cfg.fetchSources) return []
  const out = []
  for (const s of sources.slice(0, cfg.fetchTopN)) {
    const text = await fetchUrlText(ctx, s.url, { timeoutMs: cfg.fetchTimeoutMs })
    if (text.trim().length > 200) {
      out.push({ url: s.url, title: s.title, text: text.slice(0, cfg.fetchMaxChars) })
      log('fetched ' + text.length + ' chars: ' + s.url)
    } else {
      log('fetch unusable (' + text.trim().length + ' chars): ' + s.url)
    }
  }
  return out
}

function distillPrompt(query, content, sources, evidence) {
  const ev = sources.map((s, i) => `[${i + 1}] ${s.title || ''} <${s.url}>\n${(s.snippet || '').slice(0, 600)}`).join('\n\n')
  const pages = evidence.length
    ? evidence.map((e, i) => `### [P${i + 1}] ${e.title || ''} <${e.url}>\n${e.text}`).join('\n\n')
    : '(no page content could be fetched)'
  return [
    '## Question that the knowledge base could not answer',
    query,
    '',
    '## Search summary',
    (content || '(none)').slice(0, 2000),
    '',
    '## Fetched page content  ← PRIMARY evidence',
    pages.slice(0, 14000),
    '',
    '## Search result list (titles/snippets only — NOT sufficient evidence on their own)',
    ev.slice(0, 4000) || '(none)',
    '',
    '## Task',
    'Decide whether the FETCHED PAGE CONTENT durably answers the question. If yes, write ONE concise wiki page.',
    'Base every claim on the fetched page content. Titles and snippets alone are NOT sufficient — if the fetched content is missing or does not answer the question, you MUST refuse.',
    'Return JSON exactly in this shape:',
    '{ "skip": false,',
    '  "id": "kebab-case-ascii-slug",',
    '  "title": "short title (may be Chinese)",',
    '  "category": "fact" | "decision" | "lesson" | "howto",',
    '  "confidence": 0.0-1.0,',
    '  "tags": ["..."],',
    '  "body": "markdown body, 3-15 lines, concrete and self-contained" }',
    'Or if the results do not answer it: { "skip": true, "reason": "..." }',
    'confidence must reflect how well the sources support the claim, not how plausible it sounds.',
  ].join('\n')
}

/**
 * 处理一个 gap：联网 → 蒸馏 → 落 staged。
 * 返回 { status, page?, reason? }，不抛异常（失败只记状态）。
 */
export async function acquireOne({ ctx, llm, repoRoot, gap, cfg, log = () => {} }) {
  const now = new Date().toISOString()
  if (!ctx?.web?.search) return { status: 'error', reason: 'ctx.web 不可用' }

  let results
  try {
    results = await ctx.web.search({ query: gap.query, maxResults: cfg.webMaxResults })
  } catch (e) {
    return { status: 'error', reason: 'search failed: ' + e.message }
  }
  const sources = (results?.sources ?? []).filter(s => s && s.url).map(s => ({ url: s.url, title: s.title, snippet: s.snippet }))
  if (sources.length === 0) return { status: 'skipped', reason: 'no search results' }

  // 先抓正文：只有标题和 snippet 的话蒸馏器只能拒绝（实测如此）
  const evidence = await fetchEvidence(ctx, sources, cfg, log)

  let distilled
  // rawText 必须声明在 try 之外：诊断信息要在 catch 之后仍然可读。
  // （曾经把它写成 try 内的 const，导致非 JSON 分支抛 ReferenceError，
  //   把一次本可优雅跳过的结果变成整轮失败。）
  let rawText = ''
  try {
    rawText = await llm.chat({
      system: DISTILL_SYSTEM,
      prompt: distillPrompt(gap.query, results.content, sources, evidence),
      maxTokens: cfg.distillMaxTokens,
      temperature: 0.1,
    })
    distilled = extractJson(rawText)
  } catch (e) {
    return { status: 'error', reason: 'distill failed: ' + e.message }
  }
  if (!distilled) {
    // 把原始输出带出来：没有它就只能猜"是模型没回、还是回了非 JSON"
    const raw = String(rawText ?? '')
    return { status: 'skipped', reason: 'distiller returned no JSON (' + evidence.length + ' page(s) fetched, rawLen=' + raw.length + ', raw=' + JSON.stringify(raw.slice(0, 200)) + ')' }
  }
  // 记下取到几页正文：这是判断"是没料可写还是模型太保守"的关键区分
  if (distilled.skip === true) {
    return { status: 'skipped', reason: 'distiller refused (' + evidence.length + ' page(s) fetched): ' + (distilled.reason ?? '') }
  }

  const id = deriveId(distilled.id, distilled.title ?? gap.query, 'gap')
  const body = String(distilled.body ?? '').trim()
  if (!body) return { status: 'skipped', reason: 'empty body' }

  const page = {
    id,
    title: String(distilled.title ?? id),
    category: ['fact', 'decision', 'lesson', 'howto'].includes(distilled.category) ? distilled.category : 'fact',
    confidence: Math.max(0, Math.min(1, Number(distilled.confidence ?? 0.5) || 0.5)),
    sources: sources.map(s => s.url).slice(0, cfg.maxSourcesPerPage),
    tags: Array.isArray(distilled.tags) ? distilled.tags.map(String).slice(0, 8) : [],
    created: now,
    updated: now,
    hits: 0,
    body: body + '\n\n> 缺口: ' + gap.query.slice(0, 200),
  }
  const file = await savePage(repoRoot, page, { staged: true })
  log('staged: ' + id + ' (gap ' + gap.id + ')')
  return { status: 'staged', page, file }
}

/**
 * 后台补料 worker：跑一批 pending gap。
 * 非阻塞的兑现——调用方 await 它也不会卡住模型轮次（它在 turn/end 之后跑）。
 */
export async function runAcquisition({ ctx, llm, repoRoot, cfg, log = () => {} }) {
  const gaps = await readGaps(repoRoot)
  // 花钱联网之前再确认一次：队列里可能有历史遗留或被手工写入的条目，
  // 记录侧的过滤挡不住它们。
  const pending = gaps
    .filter(g => g.status === 'pending')
    .filter((g) => {
      if (looksLikeGap(g.query, { minChars: cfg.minGapQueryChars })) return true
      g.status = 'skipped'
      g.lastStatus = 'skipped'
      g.lastReason = '不像真缺口（意图判据未通过），未消耗联网预算'
      g.lastAttempt = new Date().toISOString()
      log('gap 不像真缺口，跳过：' + String(g.query).slice(0, 40))
      return false
    })
    .slice(0, cfg.maxAcquisitionsPerRun)
  const summary = { considered: pending.length, staged: 0, skipped: 0, errors: 0, details: [] }
  for (const gap of pending) {
    if (gap.attempts >= cfg.maxAttemptsPerGap) { gap.status = 'abandoned'; continue }
    gap.attempts = (gap.attempts ?? 0) + 1
    gap.lastAttempt = new Date().toISOString()
    const res = await acquireOne({ ctx, llm, repoRoot, gap, cfg, log })
    if (res.status === 'staged') { gap.status = 'done'; summary.staged++ }
    else if (res.status === 'skipped') { gap.status = 'skipped'; summary.skipped++ }
    else { gap.status = gap.attempts >= cfg.maxAttemptsPerGap ? 'abandoned' : 'pending'; summary.errors++ }
    // 把结果持久化回 gap 本身 —— 否则下次看队列只知道"skipped"，
    // 不知道是没搜到、模型拒绝、还是模型没回合法 JSON。
    gap.lastStatus = res.status
    gap.lastReason = res.reason ?? ''
    // res.page 只在 staged 时存在；写成 page: res.page?.id 会让值为 undefined，
    // 而工具输出必须是 lossless JSON → 整个 wiki_acquire 调用失败。
    const detail = { id: gap.id, query: gap.query.slice(0, 80), status: res.status, reason: res.reason ?? '' }
    if (res.page?.id) detail.page = res.page.id
    summary.details.push(detail)
    if (cfg.minIntervalMs > 0) await new Promise(r => setTimeout(r, cfg.minIntervalMs))
  }
  await writeGaps(repoRoot, gaps)
  return summary
}
