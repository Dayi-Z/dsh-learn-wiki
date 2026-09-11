// 会话索引：把历史会话的摘要缓存到 <wikiRoot>/.index/sessions.json。
//
// ── 为什么必须有缓存 ──
//
// 全量摘要一个会话实测约 400ms–2.5s（大会话要解 5.8 万个事件）。53 个会话 = 20+ 秒 ——
// 工具调用等不起，而且每次调用都重算等于把同一份工作做无数遍。
//
// 所以：按文件 (mtimeMs, size) 判断哪些变了，只摘新的那些，其余读缓存。
// **每次调用有预算**（maxNewDigests），超出的如实报"还有 N 个没索引"，
// 而不是要么卡住要么假装全都索引了。
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { listSessions, streamSessionEvents } from './session-store.js'
import { digestSessionFile } from './session-digest.js'

const SNAP = '.index/sessions.json'
const DEFAULT_MAX_NEW = 6
// 单次调用最多占用主线程多久。实测每个会话 5–900ms，所以这个值决定的是
// "最多阻塞宿主多久"，而不是"能摘几个"。
const DEFAULT_MAX_MS = 1500

async function readSnap(wikiRoot) {
  try {
    const j = JSON.parse(await readFile(join(wikiRoot, SNAP), 'utf8'))
    return j && typeof j === 'object' && j.entries && typeof j.entries === 'object'
      ? j
      : { version: 1, entries: {} }
  } catch {
    // 没有就是没有。缓存是派生物，任何时候都可以删掉重建 —— 它不是真相来源。
    return { version: 1, entries: {} }
  }
}

async function writeSnap(wikiRoot, snap) {
  try {
    await mkdir(join(wikiRoot, '.index'), { recursive: true })
    await writeFile(join(wikiRoot, SNAP), JSON.stringify(snap, null, 1), 'utf8')
    return true
  } catch { return false }
}

/**
 * 取会话索引。
 *
 * @returns { digests, scanned, cached, digested, pending, errors }
 *   digests  —— 已索引的摘要（新的在前）
 *   pending  —— 这次没来得及摘要的数量（**必须报出去**，不能假装没有）
 */
export async function loadSessionIndex(wikiRoot, {
  cwd = null,
  includeSubagents = false,
  maxNew = DEFAULT_MAX_NEW,
  // ★ 单次调用在宿主主线程上的时间上界。见下方注释。
  maxMs = DEFAULT_MAX_MS,
  sessionsRoot = undefined,
} = {}) {
  const snap = await readSnap(wikiRoot)
  const files = listSessions({ cwd, includeSubagents, root: sessionsRoot })

  const digests = []
  const pendingFiles = []
  const errors = []
  let cached = 0, digested = 0

  for (const s of files) {
    let st = null
    try { st = await stat(s.file) } catch { continue }
    const stamp = st.size + ':' + Math.round(st.mtimeMs)
    const hit = snap.entries[s.id]
    if (hit && hit.stamp === stamp && hit.digest) {
      digests.push(hit.digest)
      cached++
      continue
    }
    pendingFiles.push({ s, stamp })
  }

  // ★ 双预算：**条数**与**时间**，谁先到就停。
  //
  //   为什么必须有时间预算：摘要一个会话是同步的重活（读文件 + 解多帧 zstd +
  //   JSON.parse 上万行），而这段代码跑在**宿主进程的主线程**上。
  //   实测：maxNew=8 ≈ 3.9 秒，refresh=60 时约 18 秒 —— 那期间整个宿主是卡住的。
  //   条数预算管不住它，因为单个会话的成本可以差两个数量级（小会话 5ms，
  //   大会话 900ms+）。时间预算才能给出**可预测的上界**。
  //
  //   超预算就停，剩下的如实报在 pending 里，下次调用继续 —— 宁可多调几次，
  //   也不要在别人的主线程上闷头干十几秒。
  const budget = Math.max(0, Number(maxNew) || 0)
  const deadline = Date.now() + Math.max(0, Number(maxMs) || 0)
  let timeUp = false
  for (const { s, stamp } of pendingFiles.slice(0, budget)) {
    if (Date.now() >= deadline) { timeUp = true; break }
    // ★ 每个会话之间**显式让出事件循环**。
    //
    //   这段代码跑在宿主进程的主线程上，而单个会话的摘要是同步重活
    //   （读文件 → 解多帧 zstd → JSON.parse 上万行）。连着做 6 个就是几秒钟
    //   不停的同步执行 —— 期间宿主的定时器、IPC、渲染进程消息全都排不进来。
    //   await stat() 只让出微任务队列，**不足以**让事件循环喘气。
    //   加了这一行之后，最长连续占用 ≈ 单个会话的耗时（实测 5–900ms），
    //   而不是"整批的总和"。
    await new Promise(r => setImmediate(r))
    try {
      // ★ 流式：解一帧喂一帧。原来这里是一把 readSessionEvents（整个会话进内存），
      //   实测最大 13.66 MB → 58,566 事件 → 堆峰值 ~370 MB、阻塞 2.5 秒，
      //   而这段代码跑在宿主主线程上。流式之后峰值降到压缩文件级别。
      const d = digestSessionFile(s.file, s, streamSessionEvents)
      digests.push(d)
      snap.entries[s.id] = { stamp, digest: d, at: new Date().toISOString() }
      digested++
    } catch (e) {
      errors.push({ id: s.id, error: String(e?.message ?? e) })
    }
  }

  if (digested > 0) await writeSnap(wikiRoot, snap)
  digests.sort((a, b) => b.createdAt - a.createdAt)

  return {
    digests,
    scanned: files.length,
    cached,
    digested,
    pending: Math.max(0, pendingFiles.length - digested),
    // 报了预算耗尽，调用方就不该把 pending 当成"还有很多历史"，
    // 而应理解成"这次没干完，再调一次"。
    ...(timeUp ? { timeBudgetExhausted: true } : {}),
    errors,
  }
}

/** 把跨会话的"同一堵墙"聚起来。 */
export function collectWalls(digests, { minSessions = 1 } = {}) {
  const bySig = new Map()
  for (const d of digests) {
    for (const w of d.walls ?? []) {
      let e = bySig.get(w.sig)
      if (!e) { e = { sig: w.sig, sessions: [], hits: 0, resolved: 0, tools: {} }; bySig.set(w.sig, e) }
      e.sessions.push({ id: d.id, at: d.createdAt, count: w.count, resolved: w.resolvedAfter, esc: w.afterLastFailure })
      e.hits += w.count
      if (w.resolvedAfter) e.resolved++
      for (const [t, n] of Object.entries(w.tools ?? {})) e.tools[t] = (e.tools[t] ?? 0) + n
    }
  }
  const rows = [...bySig.values()].filter(e => e.sessions.length >= minSessions)
  rows.sort((a, b) => b.sessions.length - a.sessions.length || b.hits - a.hits)
  return rows
}
