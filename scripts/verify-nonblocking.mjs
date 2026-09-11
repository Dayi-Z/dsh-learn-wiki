// 会话读取**不能饿死事件循环**的自检。
//
// ── 为什么单独有这一个文件 ──
//
// 2026-09-11 实测到的事故形态：wiki_sessions show 在最大的会话（14.32 MB /
// 58,566 事件）上**稳定把宿主进程搞崩**，连崩两次；而同一段代码在子进程里
// 跑得好好的，毫无症状。差别是宿主有 Electron 主线程在等它。
//
// 根因不是内存（那个我早先已经优化过，堆峰值 141MB → 10MB，摘要输出逐字节相同，
// 但崩溃照旧），而是**阻塞**：readFileSync 整个文件 + 一口气解到底，
// 单次调用把主线程按住约 2.8 秒，show 扫两遍就是 4.9 秒全程无响应。
//
// 所以这里钉的不是"快"，而是**最长连续阻塞有上界**：
//   * 新实现：心跳定时器必须一直跑得动（yield 生效）
//   * 对照组：关掉 yield 时必须**真的饿死**，否则这个测试根本测不出东西
//     —— 一个永远不会失败的测试比没有测试更糟，它给人虚假的安全感。
import { rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { streamSessionEvents } from '../lib/session-store.js'
import { digestSessionFile } from '../lib/session-digest.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

const ROOT = '.tmp-nonblocking'
await rm(ROOT, { recursive: true, force: true })
await mkdir(ROOT, { recursive: true })

// ── 造一个够大的多帧会话：够大到"一口气解完"会明显占住主线程 ──
const HEADER = { type: 'session', version: 0, id: 'sess-block', createdAt: 1, cwd: 'D:\\Proj', delegationDepth: 0 }
const LINES_PER_FRAME = 40
const TOTAL = 80000
// ★ 头部那一行**也会**作为事件投递出来（streamSessionEvents 不区分头与正文），
//   所以回调收到的是 TOTAL + 1。这不是 bug，但期望值少算它就会误报。
const EXPECTED = TOTAL + 1
const frames = []
let lines = [JSON.stringify(HEADER)]
for (let i = 0; i < TOTAL; i++) {
  // 造得像真实事件：有点体积，逼 JSON.parse 真干活
  lines.push(JSON.stringify({
    type: i % 3 === 0 ? 'tool/code-dispatch' : 'assistant/message',
    seq: i, time: 1700000000000 + i,
    data: { name: 'run_code', pad: 'x'.repeat(120), text: 'p'.repeat(80) },
  }))
  if (lines.length >= LINES_PER_FRAME) {
    frames.push(zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8')))
    lines = []
  }
}
if (lines.length) frames.push(zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8')))
const file = join(ROOT, 'session.jsonl.zstd')
await (await import('node:fs/promises')).writeFile(file, Buffer.concat(frames))
const mb = (Buffer.concat(frames).length / 1e6).toFixed(2)
console.log('  合成会话: ' + TOTAL + ' 事件 / ' + frames.length + ' 帧 / ' + mb + ' MB')

// 心跳：每 5ms 一次，记录最长间隔 —— 那就是**事件循环被按住的最长时间**
function heartbeat() {
  const gaps = []
  let last = Date.now()
  let ticks = 0
  const t = setInterval(() => { const n = Date.now(); gaps.push(n - last); last = n; ticks++ }, 5)
  return { stop: () => { clearInterval(t); return { gaps, ticks } } }
}

// ── 1) 对照组：关掉 yield，必须真的饿死 ──
{
  const hb = heartbeat()
  const n = await streamSessionEvents(file, () => {}, { yieldEveryMs: 1e9 })
  const { gaps, ticks } = hb.stop()
  const maxGap = gaps.length ? Math.max(...gaps) : Infinity
  check('对照组：关掉 yield 时事件循环确实被饿死', ticks <= 2 && n === EXPECTED,
    'ticks=' + ticks + ' maxGap=' + (maxGap === Infinity ? '整个耗时内一次都没跑成' : maxGap + 'ms') + ' events=' + n)
}

// ── 2) 新实现：心跳必须一直跑得动 ──
{
  const hb = heartbeat()
  const t0 = Date.now()
  const n = await streamSessionEvents(file, () => {}, { yieldEveryMs: 12 })
  const ms = Date.now() - t0
  const { gaps, ticks } = hb.stop()
  const maxGap = Math.max(...gaps)
  check('新实现：最长连续阻塞有上界（<150ms）', maxGap < 150, 'maxGap=' + maxGap + 'ms 总耗时=' + ms + 'ms')
  check('新实现：期间事件循环跑了很多次（yield 真生效）', ticks >= 5, 'ticks=' + ticks)
  check('新实现：事件一条不少', n === EXPECTED, 'events=' + n + ' 期望=' + EXPECTED)
}

// ── 3) 摘要路径也走同一条流，不能因为 await 漏掉而静默变空 ──
{
  const d = await digestSessionFile(file, { id: 'sess-block' }, streamSessionEvents)
  check('摘要路径：await 已接上（eventsScanned 不为 0）', d.eventsScanned === EXPECTED,
    'eventsScanned=' + d.eventsScanned + ' 期望=' + EXPECTED)
}

await rm(ROOT, { recursive: true, force: true })
console.log(failures === 0 ? '\n非阻塞自检全部通过' : '\n有 ' + failures + ' 项未通过')
process.exit(failures === 0 ? 0 : 1)