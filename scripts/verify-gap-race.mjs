// gap 队列并发写：**确定的**回归测试。
//
// ── 为什么需要一个专门的套件 ──
//
// queue.jsonl 是整文件读-改-写，两个调用方并发就会互相覆盖，表现为
// "挣扎了但什么都没学到"，而且不留痕迹。这个坑在项目里踩过三次：
//   1. appendGap 与 runAcquisition 互吃 -> 给 appendGap 加锁
//   2. 两个并发 appendGap 互吃        -> 把锁提到 appendGap 里面
//   3. runAcquisition 的回写始终是裸的 -> 只是把"读"挪近了"写"（重读+合并），
//      把窗口缩小了、**没有关掉**
//
// 前两次的测试都是"两个 appendGap"（已有 verify-subagent-guard 覆盖）。
//
// ── 这份测试证明什么、**不**证明什么（别把它读成比实际更强的东西）──
//
// 证明：并发登记与补料回写同时发生时，**没有 gap 会丢**，且被处理的那条
//       状态照样写得回去 —— 这条保证由 updateGaps 这把锁提供。
//
// 不证明："修好了一个会丢数据的 bug"。实测过：把 web.search 卡住、在补料
//       跑到一半时登记一条，**旧代码（未加锁的版本）同样保住了** —— 因为
//       runAcquisition 早就把"读"挪到了写回之前（重读+合并），真实的并发
//       时间差都落在合并能覆盖的范围里。真正无保护的窗口只有
//       "重读之后、写回之前"那一两个微任务，撞不上，也复现不出来。
//
//       所以这是**把保证钉住的测试**（防将来有人把锁拿掉、或把合并逻辑改回
//       旧快照覆盖），不是某个已复现故障的回归测试。写清楚这一点，是为了
//       让下一个人不会因为它一直绿就以为这里曾经有过一个修复。
//
// 做法：把 mock 的 web.search 卡在一个手动 resolve 的 promise 上，于是补料
// 必然停在"已经读过队列、还没写回"的位置，在这个确定的位置上登记新 gap。
import { rm } from 'node:fs/promises'
import { ensureRepo } from '../lib/wiki.js'
import { readGaps, appendGap, runAcquisition, updateGaps } from '../lib/acquire.js'
import { drainLocks } from '../lib/lock.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

const ROOT = '.tmp-gap-race'
await rm(ROOT, { recursive: true, force: true })
await ensureRepo(ROOT)

console.log('=== 1. 基本原语 ===')
{
  await appendGap(ROOT, { query: '第一个缺口：某个具体的错误信息', score: 0.1 })
  await appendGap(ROOT, { query: '第二个缺口：另一个具体的错误信息', score: 0.2 })
  const g = await readGaps(ROOT)
  check('两条不同的 query 各留一条', g.length === 2, 'n=' + g.length)
  await appendGap(ROOT, { query: '第一个缺口：某个具体的错误信息', score: 0.3 })
  const g2 = await readGaps(ROOT)
  check('同一 query 累加 seen 而不是新增一条', g2.length === 2 && g2[0].seen === 2, JSON.stringify(g2.map(x => x.seen)))
}

console.log('')
console.log('=== 2. runAcquisition 回写 vs 并发 appendGap（这就是那个没被测过的窗口）===')
{
  await rm(ROOT, { recursive: true, force: true })
  await ensureRepo(ROOT)
  await appendGap(ROOT, { query: '先入队的缺口：一个足够长的具体错误信息', score: 0.5 })

  // 手动闸门：让 web.search 卡住，于是 runAcquisition 一定停在
  // "已经读过队列、还没写回"的位置 —— 这是确定的，不是碰运气。
  let releaseSearch = null
  const gate = new Promise((r) => { releaseSearch = r })
  const ctx = {
    web: {
      search: async () => { await gate; return { sources: [{ url: 'https://e.com/a', title: 'A', snippet: 's' }] } },
      fetch: async () => ({ statusCode: 200, body: { kind: 'text', content: 'x'.repeat(400) } }),
    },
  }
  const llm = { chat: async () => JSON.stringify({ skip: true, reason: '测试：不产出' }) }
  const cfg = { minGapQueryChars: 4, maxAcquisitionsPerRun: 5, maxAttemptsPerGap: 2, minIntervalMs: 0, fetchTopN: 1 }

  const running = runAcquisition({ ctx, llm, repoRoot: ROOT, cfg, log: () => {} })
  // 等到 search 真的被调用了 —— 那说明"读队列"已经发生、写回还没发生。
  const dl = Date.now() + 5000
  while (Date.now() < dl && !releaseSearch) { await new Promise(r => setTimeout(r, 10)) }
  await new Promise(r => setTimeout(r, 60))   // 让 search 真正进入等待

  const lateQuery = '补料跑到一半时才登记的缺口：另一个具体的错误信息'
  await appendGap(ROOT, { query: lateQuery, score: 0.4 })
  const mid = await readGaps(ROOT)
  check('并发登记确实落盘了（否则这条测试什么也没测）', mid.length === 2, 'n=' + mid.length)

  releaseSearch()
  await running
  const after = await readGaps(ROOT)
  const survived = after.some(g => String(g.query).includes('补料跑到一半'))
  check('★ 补料回写之后，并发登记的 gap 仍然在队列里',
    survived, 'after=' + JSON.stringify(after.map(g => String(g.query).slice(0, 24))))
  check('★ 被处理的那条状态也写回去了（锁没有把功能挡住）',
    after.some(g => g.status !== 'pending'), JSON.stringify(after.map(g => g.status)))
}

console.log('')
console.log('=== 3. updateGaps 的语义 ===')
{
  const out = await updateGaps(ROOT, (gaps) => { gaps.forEach(g => { g.touched = true }) })
  const after = await readGaps(ROOT)
  check('原地修改会被写回', after.every(g => g.touched === true), JSON.stringify(after.map(g => !!g.touched)))
  check('返回值就是传进去的那个数组', Array.isArray(out) && out.length === after.length)
  await updateGaps(ROOT, () => [])
  check('返回新数组时按返回值写回', (await readGaps(ROOT)).length === 0)
}

await rm(ROOT, { recursive: true, force: true })
console.log('')
console.log(failures === 0 ? 'ALL PASS — gap 队列的读-改-写是原子的' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
