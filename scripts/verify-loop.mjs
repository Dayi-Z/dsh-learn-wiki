// 端到端闭环验证：这轮没命中 → 后台补料 → staged → commit → 下轮命中。
// 用打桩的 ctx.web 与 llm，所以不联网、不花钱、可重复。
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureRepo, loadPages, savePage, commitReadiness } from '../lib/wiki.js'
import { buildCorpus, scoreQuery, triage, recallable } from '../lib/recall.js'
import { appendGap, runAcquisition, readGaps } from '../lib/acquire.js'
import { DEFAULTS } from '../lib/config.js'

const ROOT = process.argv[2] || '.tmp-loop-test'
let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

const recallState = async () => {
  const { pages } = await loadPages(ROOT)
  const pool = recallable(pages, { minConfidence: 0.3 })
  return { pages, pool, corpus: buildCorpus(pool) }
}

await rm(ROOT, { recursive: true, force: true })
await ensureRepo(ROOT)
const cfg = { ...DEFAULTS, wikiRoot: ROOT, minIntervalMs: 0, maxAcquisitionsPerRun: 3 }

// ── 打桩 ──
const QUERY = 'CRAG 检索评估器怎么把召回分成三桶'
const fakeCtx = {
  web: {
    search: async ({ query }) => ({
      content: 'Corrective RAG uses a retrieval evaluator that scores retrieved documents.',
      sources: [
        { url: 'https://arxiv.org/abs/2401.15884', title: 'Corrective Retrieval Augmented Generation', snippet: 'A lightweight retrieval evaluator assesses the quality of retrieved documents and triggers different knowledge retrieval actions: Correct, Incorrect, Ambiguous.' },
      ],
    }),
  },
}
const llmReturning = (payload) => ({ chat: async () => JSON.stringify(payload) })

console.log('\n=== 1. 初始状态：查询应当 miss（知识库里还没有这条）===')
let { pool } = await recallState()
check('初始知识库为空', pool.length === 0, 'recallable=' + pool.length)

// ── 2. 未命中 → 入 gap 队列（此处绝不联网）──
console.log('\n=== 2. miss → 记录缺口 ===')
let hits = scoreQuery(buildCorpus(pool), QUERY)
let t = triage(hits, cfg)
check('判定为 miss', t.bucket === 'miss', 'bucket=' + t.bucket + ' best=' + t.best)
const gapId = await appendGap(ROOT, { query: QUERY, score: t.best, sessionId: 'test-session' })
let gaps = await readGaps(ROOT)
check('gap 已入队', gaps.length === 1 && gaps[0].status === 'pending', JSON.stringify(gaps[0] ?? null))

// ── 3. 同一缺口重复出现不应重复入队 ──
await appendGap(ROOT, { query: QUERY, score: t.best })
gaps = await readGaps(ROOT)
check('重复缺口去重并累加 seen', gaps.length === 1 && gaps[0].seen === 2, 'count=' + gaps.length + ' seen=' + gaps[0].seen)

// ── 4. 后台补料 → 蒸馏 → 落 staged ──
console.log('\n=== 3. 后台补料 → staged ===')
const goodLlm = llmReturning({
  skip: false, id: 'crag-three-buckets', title: 'CRAG 三分桶', category: 'fact', confidence: 0.7,
  tags: ['rag', 'retrieval'], body: 'CRAG 用一个轻量检索评估器给召回结果打分，分成三桶：Correct、Incorrect、Ambiguous。',
})
const summary = await runAcquisition({ ctx: fakeCtx, llm: goodLlm, repoRoot: ROOT, cfg, log: () => {} })
check('补料产出一页', summary.staged === 1, JSON.stringify({ staged: summary.staged, skipped: summary.skipped, errors: summary.errors }))
gaps = await readGaps(ROOT)
check('gap 标记为 done', gaps[0].status === 'done', 'status=' + gaps[0].status)

// ── 5. 关键不变量：staged 不参与召回 ──
console.log('\n=== 4. 不变量：staged 不参与召回 ===')
let st = await recallState()
check('staged 页存在于 repo', st.pages.some(p => p.id === 'crag-three-buckets' && p.status === 'staged'))
check('staged 页不在可召回池里（投毒防线）', st.pool.length === 0, 'recallable=' + st.pool.length)
hits = scoreQuery(st.corpus, QUERY)
t = triage(hits, cfg)
check('commit 前仍然 miss', t.bucket === 'miss', 'bucket=' + t.bucket)

// ── 6. commit 闸门：无 sources 必须被拒 ──
console.log('\n=== 5. commit 闸门 ===')
const noSrc = { id: 'no-src', title: 'x', category: 'fact', confidence: 0.9, sources: [], tags: [], body: 'x' }
check('无 sources 的页被 commitReadiness 拒绝', commitReadiness(noSrc).ready === false, commitReadiness(noSrc).blockers.join('; '))

// ── 7. 正常 commit → 升入 L1 ──
const staged = st.pages.find(p => p.id === 'crag-three-buckets')
const ready = commitReadiness(staged)
check('staged 页通过 commit 校验', ready.ready, ready.blockers.join('; '))
await savePage(ROOT, staged, { staged: false })
await rm(join(ROOT, 'staged', 'crag-three-buckets.md'), { force: true })

// ── 8. 闭环收口：同样的查询现在应当命中 ──
console.log('\n=== 6. 闭环：同样的查询现在命中 ===')
st = await recallState()
check('页面已升入可召回池', st.pool.some(p => p.id === 'crag-three-buckets'), 'pool=' + st.pool.length)
hits = scoreQuery(st.corpus, QUERY)
t = triage(hits, cfg)
console.log('  best=' + t.best + ' bucket=' + t.bucket)
check('同样的查询不再 miss（边做边学成立）', t.bucket !== 'miss', 'bucket=' + t.bucket + ' best=' + t.best)
check('命中正确的页', t.hit.concat(t.weak).some(h => h.page.id === 'crag-three-buckets'))

// ── 9. 防投毒：蒸馏器拒绝时不得产出任何页 ──
console.log('\n=== 7. 防投毒：蒸馏器拒绝则不落盘 ===')
await writeFile(join(ROOT, 'gaps', 'queue.jsonl'), '', 'utf8')
await appendGap(ROOT, { query: '一个根本搜不到答案的问题 xyzzy', score: 0 })
const before = (await loadPages(ROOT)).pages.length
const refuseLlm = llmReturning({ skip: true, reason: '搜索结果答不上这个问题' })
const s2 = await runAcquisition({ ctx: fakeCtx, llm: refuseLlm, repoRoot: ROOT, cfg, log: () => {} })
const after = (await loadPages(ROOT)).pages.length
check('蒸馏器拒绝 → 未产出页', s2.staged === 0 && after === before, JSON.stringify({ staged: s2.staged, skipped: s2.skipped, before, after }))

await rm(ROOT, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS — 闭环成立' : '\n' + failures + ' FAILURE(S)')
// ★ Windows 上的已知竞态：process.exit() 立即调用时，可能还有句柄处在
//   UV_HANDLE_CLOSING（close 已发起、回调未跑）状态 → libuv 断言崩溃
//   （实测偶发，exit -1073740791）。给事件循环一拍跑完 close 回调再退 ——
//   纯退出时序，不影响任何断言。
setTimeout(() => process.exit(failures === 0 ? 0 : 1), 100)
