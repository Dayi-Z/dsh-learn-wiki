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
import { listSessions } from './session-store.js'
import { sessionIndexRemote } from './session-remote.js'

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

  // ★ 条数预算还在，时间预算降级成**保险丝**。
  //
  //   原委：这里曾经是宿主主线程上逐个同步摘要，靠 setImmediate 让出事件循环，
  //   并用 maxMs 当"主线程占用上界"。**那样仍会杀死宿主** —— refresh=60 的 brief、
  //   refresh=40 的 list 都崩过，而且是原生崩溃（只有 crashpad 一行、没有 JS 堆栈）。
  //   既然重活已经不在主线程上，时间预算就不再承担"保护主线程"的职责，
  //   只用来防止子进程卡死（子进程侧另有独立超时，这里是外层兜底）。
  const budget = Math.max(0, Number(maxNew) || 0)
  const batch = pendingFiles.slice(0, budget)
  let timeUp = false
  if (batch.length > 0) {
    // ★ 整批交给**一个**子进程。
    //
    //   为什么整批而不是每个会话一个进程：起进程本身有开销（实测几十毫秒），
    //   53 个会话逐个起会把预算吃光；一个进程跑完整批则只付一次。
    const items = batch.map(({ s }) => ({ id: s.id, file: s.file, header: s }))
    const r = await sessionIndexRemote(items, {
      timeoutMs: Math.min(300000, 30000 + items.length * 8000),
    })
    if (!r.ok) {
      // 子进程整体失败（崩了/超时）。如实报出去，**不要**假装没有会话。
      errors.push({ id: '*', error: r.error })
      timeUp = true
    } else {
      const stampById = new Map(batch.map(({ s, stamp }) => [s.id, stamp]))
      for (const one of r.result) {
        if (!one.ok) { errors.push({ id: one.id, error: one.error }); continue }
        digests.push(one.digest)
        snap.entries[one.id] = { stamp: stampById.get(one.id), digest: one.digest, at: new Date().toISOString() }
        digested++
      }
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
