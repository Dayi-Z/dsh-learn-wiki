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

function distillPrompt(query, content, sources) {
  const ev = sources.map((s, i) => `[${i + 1}] ${s.title || ''} <${s.url}>\n${(s.snippet || '').slice(0, 600)}`).join('\n\n')
  return [
    '## Question that the knowledge base could not answer',
    query,
    '',
    '## Search summary',
    (content || '(none)').slice(0, 2000),
    '',
    '## Search results',
    ev.slice(0, 6000) || '(none)',
    '',
    '## Task',
    'Decide whether these results durably answer the question. If yes, write ONE concise wiki page.',
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

  let distilled
  try {
    const text = await llm.chat({
      system: DISTILL_SYSTEM,
      prompt: distillPrompt(gap.query, results.content, sources),
      maxTokens: cfg.distillMaxTokens,
      temperature: 0.1,
    })
    distilled = extractJson(text)
  } catch (e) {
    return { status: 'error', reason: 'distill failed: ' + e.message }
  }
  if (!distilled) return { status: 'skipped', reason: 'distiller returned no JSON' }
  if (distilled.skip === true) return { status: 'skipped', reason: 'distiller refused: ' + (distilled.reason ?? '') }

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
    summary.details.push({ id: gap.id, query: gap.query.slice(0, 80), status: res.status, reason: res.reason ?? '', page: res.page?.id })
    if (cfg.minIntervalMs > 0) await new Promise(r => setTimeout(r, cfg.minIntervalMs))
  }
  await writeGaps(repoRoot, gaps)
  return summary
}
