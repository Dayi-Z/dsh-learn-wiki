// 补料「时机/预算」质量闸自检：不可检索查询必须在花钱之前被挡掉。
//
// ── 为什么值得单独一个脚本 ──
//
// 实测队列（2026-09）：24 条缺口 16 条 skipped。逐条翻 lastReason 发现
// 大头不是"蒸馏器太保守"，而是**查询本身不可检索**：
//   脱敏占位符（DSH 侧把路径/数字显示成 <path>/<n>，https:/<path> 这种）、
//   终端输出片段（"Press Ctrl+C to quit"）、JSON 转储、DSH 内部契约错误、
//   "run_code settled"（命令正常结束被误当错误）。
// 这些查询去搜就是烧 maxAcquisitionsPerRun（默认 2/轮）里的名额，然后必然
// skipped —— 真正的缺口反而排队。
//
// 本脚本钉三层：
//   1. unsearchableGapReason 认得队列里**真实出现过的**垃圾（而不是我编的）；
//   2. 真缺口（含脱敏占位符但核心短语可检索的）不被误杀；
//   3. runAcquisition 预算保护：不可检索的绝不出现在 ctx.web.search 里，
//      且 seen 高的缺口先拿预算。
import { rm } from 'node:fs/promises'
import { appendGap, readGaps, runAcquisition, unsearchableGapReason } from '../lib/acquire.js'
import { ensureRepo } from '../lib/wiki.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

const ROOT = '.tmp-gap-gate'
await rm(ROOT, { recursive: true, force: true })
await ensureRepo(ROOT)

console.log('=== 1. 队列里真实出现过的垃圾查询（必须被认出）===')
{
  const junk = [
    ['{"stamp":"<n>:<n>","digest":{"id":"session-809fec8c-c04f-4e3","stamp":"<n>:<n>"}}', 'JSON 转储'],
    ['shing checks status every <n> seconds. Press Ctrl+C to quit.', '终端片段'],
    ['invalid arguments: missing required property "description"（当前任务：重新提交）', '契约错误'],
    ['workspace not registered: <path>（当前任务：检查目前我github）', '工作区错误'],
    ['check pending 0 https:/<path> [exit code: 1] 常见故障原因 解决办法', '脱敏 URL'],
    ['all engines failed: ddg: run_code settled; bing: run_code settled', '引擎失败链'],
    ['run_code settled 常见故障原因 解决办法（当前任务：https://www.kaggle.com/com）', 'settled 误报'],
  ]
  for (const [q, label] of junk) {
    const r = unsearchableGapReason(q)
    check('认得：' + label, r !== '', JSON.stringify(q.slice(0, 40)) + ' -> ' + (r || '（放行了）'))
  }
}

console.log('')
console.log('=== 2. 真缺口不被误杀（宁可多试一轮，不可烧错）===')
{
  const good = [
    'old_string was not found in "<path>"（当前任务：检测到上次会话因重启被中断）',
    'pwsh 连续失败 常见故障原因 解决办法（当前任务：更新失败: @vectorize-io/hindsight）',
    '反复修改 client.js 仍不成功 常见原因',
    'web fetch failed: TypeError: fetch failed 常见故障原因 解决办法',
    '自 web_fetch_pro 起连续 5 次失败 常见故障原因 解决办法',
  ]
  for (const q of good) {
    const r = unsearchableGapReason(q)
    check('放行：' + q.slice(0, 34) + '…', r === '', r || '')
  }
}

console.log('')
console.log('=== 3. 预算保护：垃圾绝不进 ctx.web.search，seen 高的先拿名额 ===')
{
  const searched = []
  const ctx = {
    web: { search: async ({ query }) => { searched.push(query); return { sources: [] } } },
  }
  const cfg = {
    webMaxResults: 5, maxAttemptsPerGap: 2, maxAcquisitionsPerRun: 1,
    minIntervalMs: 0, minGapQueryChars: 8, fetchSources: false,
    offline: false, normalizeSearchQuery: true,
  }

  const junkQ = '{"stamp":"<n>:<n>","digest":{"id":"session-x","stamp":"<n>:<n>"}}'
  await appendGap(ROOT, { query: junkQ, score: 0 })
  await appendGap(ROOT, { query: 'zstd 多帧边界 怎么解', score: 0.1 })
  await appendGap(ROOT, { query: 'zstd 多帧边界 怎么解', score: 0.1 })
  await appendGap(ROOT, { query: 'web 搜索结果去重 最佳实践', score: 0.1 })

  const before = await readGaps(ROOT)
  const junkEntry = before.find(g => g.query === junkQ)
  check('入队即预标记 skipped（不占预算）', junkEntry.status === 'skipped',
    'status=' + junkEntry.status + ' reason=' + (junkEntry.lastReason || ''))
  check('预标记带原因', /JSON|不可检索/.test(junkEntry.lastReason ?? ''), junkEntry.lastReason)

  const summary = await runAcquisition({ ctx, llm: {}, repoRoot: ROOT, cfg, log: () => {} })

  check('垃圾查询从未进入 ctx.web.search', !searched.some(q => q.includes('stamp')), 'searched=' + JSON.stringify(searched))
  check('只搜了一次（预算=1）', searched.length === 1, 'n=' + searched.length)
  check('seen 高的缺口先拿到预算', (searched[0] ?? '').includes('zstd'),
    JSON.stringify((searched[0] ?? '').slice(0, 40)))
  const after = await readGaps(ROOT)
  const doneJunk = after.find(g => g.query === junkQ)
  check('垃圾条目仍留在台账（诚实）且是 skipped', doneJunk && doneJunk.status === 'skipped')
}

console.log('')
console.log(failures === 0 ? '✓ verify-gap-gate ALL CHECKS PASSED' : '✗ ' + failures + ' FAILURES')
process.exit(failures === 0 ? 0 : 1)
