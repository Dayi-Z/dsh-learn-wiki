// 会话存储读层：读 DSH 落盘的历史会话。
//
// ── 为什么需要这一块 ──
//
// 这个项目原来的"学习"只会从**当前这一轮**里取东西：预注入看当前消息，
// 挣扎检测看当前工具流，wiki_harvest 看当前会话的 events。**过去的会话是死的**。
//
// 而本地躺着 77 个会话、完整的对话与工具调用记录。这是这个仓库最被低估的资产：
// 它是唯一能回答"上次我是怎么解决的"的地方，而那个问题在自动触发器里没有位置
// —— 它们都只看得到"现在"。
//
// （顺带：Hermes 生态里有一模一样的功能叫 headroom learn，它挖历史会话的失败模式
//   并与"最终成功的那次修正"做关联，写回 agent 原生的记忆文件。而它内置的 adapter
//   只有 ClaudeCode / Codex / Gemini —— 没有 DSH。这一块就是补上那个缺口。）
//
// ── 文件格式（解真实文件确认过，别照猜）──
//
//   ~/.dsh/sessions/<mangled-cwd>/<session-id>/session.jsonl.zstd
//   ~/.dsh/sessions/<mangled-cwd>/<session-id>/session.v3.jsonl.zstd   ← 新版（实测 2026-09-16）
//
//   * 每一行是一个 JSON 事件，含 { type, seq, time, data } 或带 message。
//   * 文件是**多帧 zstd 拼接**（每次追加写一帧）。实测一个 3.6MB 的文件有
//     3,497 帧、解出 11M 字符。
//   * ★ **不能用 zlib.createZstdDecompress() 流式解** —— 它和 gzip 不一样，
//     遇到第二帧就停（实测只解出第一帧的 170 字符）。必须自己按魔数切帧。
//   * ★★ **文件名里带了会话格式版本**（宿主 0.1.5-rc.2 起）：无版本的
//     `session.jsonl.zstd` 是 v0，`session.v3.jsonl.zstd` 是 v3。
//     这一条是用精确字符串匹配漏掉的 —— 后果实测如下（2026-09-16）：
//       磁盘上 2026-09-15 20:30 之后新建的会话全是 vN 命名，
//       listSessions() 返回 63 个、最新一条的 createdAt 停在 2026-09-16T05:28Z，
//       而当前会话（session-6ced35ec）根本查不到。
//     **不报错、不告警，只是历史从某一天起不再增长** —— 正是这个项目最忌讳的形态。
//     所以判定一律走**正则**，并且**不**从文件名反推版本（下面 readSessionHeader
//     从事件流头部读 `version`，那里才是真源；文件名只是它的一份副本）。
import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/**
 * 会话文件名：`session.jsonl.zstd`（v0）或 `session.v3.jsonl.zstd`（v3）。
 *
 * ★ 锚定 **整个名字**（^...$）而不是 includes：目录里躺着
 *   `session.jsonl.zstd.bak-20260915`、`...frame-broken-bak` 这些备份，
 *   用 includes 会把它们当成会话读进来 —— 那等于把**已经判定损坏的文件**
 *   重新塞回历史。实测这两个备份文件确实存在于 sessions 树里。
 */
export const FILE_RE = /^session(?:\.v(\d+))?\.jsonl\.zstd$/

export function sessionsRoot() {
  return process.env.DSH_SESSIONS_ROOT || join(homedir(), '.dsh', 'sessions')
}

/**
 * 找出 buffer 里所有 zstd 帧的起始偏移。
 *
 * 压缩数据里**有可能**凑巧出现这四个字节。所以调用方必须对每个切片做解压尝试，
 * 失败了就用 mergeFrames 把相邻切片并回去重试 —— 直接丢弃会**静默丢事件**，
 * 而静默丢数据正是这个项目最忌讳的故障形态。
 */
/**
 * 只读文件开头的一段。
 *
 * 为什么不用 readFileSync 再 slice：那是"把 147MB 全读进来，只为看前 64KB"。
 * 会话文件动辄几 MB，而列表操作要扫全部文件 —— 差别在这里是数量级的。
 * （实测：79 个文件合计 147 MB，头部却只有几百字节。）
 */
function readHead(file, bytes) {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(bytes)
    const n = readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, n)
  } finally { closeSync(fd) }
}

function frameOffsets(buf, limit = buf.length) {
  const out = []
  const end = Math.min(buf.length, limit)
  for (let i = 0; i + 4 <= end; i++) {
    if (buf[i] === MAGIC[0] && buf[i+1] === MAGIC[1] && buf[i+2] === MAGIC[2] && buf[i+3] === MAGIC[3]) out.push(i)
  }
  return out
}

/** 解码一个多帧 zstd 文件。切片解不开时向后合并重试，最多并 MERGE_MAX 次。 */
export function decodeSession(buf) {
  const starts = frameOffsets(buf)
  if (starts.length === 0) return ''
  const MERGE_MAX = 4
  const parts = []
  let k = 0
  while (k < starts.length) {
    let done = false
    for (let span = 1; span <= MERGE_MAX && k + span <= starts.length; span++) {
      const from = starts[k]
      const to = k + span < starts.length ? starts[k + span] : buf.length
      try {
        parts.push(zlib.zstdDecompressSync(buf.subarray(from, to)).toString('utf8'))
        k += span
        done = true
        break
      } catch { /* 合并下一个切片再试 */ }
    }
    if (!done) k += 1   // 这段确实坏掉了，跳过而不是卡住
  }
  return parts.join('')
}

/**
 * 只读**第一帧**拿会话头。
 *
 * 为什么单独做：列会话只需要头部（id / cwd / 创建时间 / 委托深度 / 来源），
 * 而全量解码一个会话实测要解 11M 字符。列表动作用不起。
 * 第一帧很小，所以只在开头一段里扫边界。
 */
export function readSessionHeader(file, { scanBytes = 65536 } = {}) {
  try {
    // ★ 只读开头一段，**不要整文件读**。头部只有几百字节，
    //   而会话文件动辄几 MB —— 列表要扫全部文件，差别是数量级的。
    const buf = readHead(file, scanBytes)
    const starts = frameOffsets(buf, buf.length)
    if (starts.length === 0) return null
    const to = starts.length > 1 ? starts[1] : buf.length
    const text = zlib.zstdDecompressSync(buf.subarray(starts[0], to)).toString('utf8')
    const first = text.split('\n').find(Boolean)
    if (!first) return null
    const h = JSON.parse(first)
    return h.type === 'session' ? h : null
  } catch {
    // 头部读不出来不算致命：可能这一帧刚好跨过 scanBytes。
    // 退回全量解码，慢一次也好过把整个会话从列表里漏掉。
    try {
      const text = decodeSession(readFileSync(file))
      const first = text.split('\n').find(Boolean)
      if (!first) return null
      const h = JSON.parse(first)
      return h.type === 'session' ? h : null
    } catch { return null }
  }
}

/**
 * 会话的**格式版本**：优先取事件流头部里的 `version`，取不到才退回文件名。
 *
 * 为什么是这个顺序（不是反过来）：文件名是版本的**副本**，副本会与内容漂移，
 * 而事件流头部就是宿主自己写下的那个数。真源与副本不一致时，信真源。
 *
 * 为什么还要留文件名这条退路：头部读不出来（帧损坏、扫描窗口跨帧）时，
 * 文件名仍然是一个证据 —— 总比报"未知"更有用，只是它排在后面。
 *
 * 取不到时返回 **null 而不是 0**：0 是一个具体版本（v0），"不知道"不是。
 * 把不知道写成 0 会让下游把 v3 当成 v0 处理，而且不会有任何迹象。
 */
export function sessionFormatVersion(header, file = '') {
  const v = header?.version
  if (Number.isSafeInteger(v) && v >= 0) return v
  const m = String(file).match(/^session\.v(\d+)\.jsonl\.zstd$/)
  if (m) { const n = Number(m[1]); return Number.isSafeInteger(n) ? n : null }
  return /^session\.jsonl\.zstd$/.test(String(file)) ? 0 : null
}

/**
 * ★ 流式读会话事件：解一帧、喂回调、丢掉，不把事件攒成数组。
 *
 * ── 这个函数到底修了什么（实测数据，别照着旧注释理解）──
 *
 * 本机最大的会话 14.32 MB，解出 **58,566 个事件**。
 *
 *   旧实现（readSessionEvents）：先把全部事件攒成数组再返回
 *     —— 堆峰值 +141 MB，且全程同步。
 *   本实现：逐帧解、喂给回调即丢
 *     —— 堆峰值 +10 MB，同一份摘要输出**逐字节相同**。
 *
 * ★ 但**省内存不等于不阻塞**，这一点我一开始想错了。
 *   即使改成本实现，仍然是 readFileSync 整个文件 + 一口气解到底：
 *   单次调用把宿主主线程按住 **约 2.8 秒**。而 wiki_sessions show
 *   要扫两遍（摘要一遍、取材一遍），实测**合计 4.9 秒**完全无响应。
 *   同一段代码在**子进程里毫无症状**，在宿主里却稳定把进程搞崩 ——
 *   差别就在于宿主有 Electron 主线程在等它。
 *
 *   所以这里按 yieldEveryMs 周期性地 await setImmediate 让出事件循环：
 *   总时长几乎不变，但**最长连续阻塞被切成 ≤yieldEveryMs 的小片**。
 *   宿主全程可响应，调用方的时间预算也才真正有意义
 *   （旧预算只在**会话之间**检查，单个大会话就能一口气吃光全部）。
 *
 * 仍然保留按魔数切帧时"切片解不开就向后合并重试"的兜底 —— 直接丢弃会静默丢事件。
 *
 * @returns 成功回调的事件条数（Promise）
 */
export async function streamSessionEvents(file, onEvent, { yieldEveryMs = 12 } = {}) {
  const buf = readFileSync(file)
  const starts = frameOffsets(buf)
  if (starts.length === 0) return 0
  const MERGE_MAX = 4
  let carry = ''      // 跨帧的不完整行（帧边界未必落在行边界上）
  let count = 0
  let k = 0
  let lastYield = Date.now()
  while (k < starts.length) {
    let text = null
    for (let span = 1; span <= MERGE_MAX && k + span <= starts.length; span++) {
      const from = starts[k]
      const to = k + span < starts.length ? starts[k + span] : buf.length
      try { text = zlib.zstdDecompressSync(buf.subarray(from, to)).toString('utf8'); k += span; break } catch { /* 合并下一片再试 */ }
    }
    if (text === null) { k += 1; continue }
    const lines = (carry + text).split('\n')
    carry = lines.pop() ?? ''
    for (const line of lines) {
      if (!line) continue
      let ev
      try { ev = JSON.parse(line) } catch { continue }
      count++
      onEvent(ev)
    }
    // ★ 让出事件循环。单帧很小（本机实测约 1KB/帧），所以这里
    //   检查的间隔就是**最长连续阻塞时间**的上界。
    if (Date.now() - lastYield >= yieldEveryMs) {
      await new Promise((r) => setImmediate(r))
      lastYield = Date.now()
    }
  }
  if (carry) {
    try { onEvent(JSON.parse(carry)); count++ } catch { /* 尾部残行，忽略 */ }
  }
  return count
}

/** 全量读一个会话的事件（逐行 JSON.parse，坏行跳过）。 */
export function readSessionEvents(file) {
  const text = decodeSession(readFileSync(file))
  const out = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try { out.push(JSON.parse(line)) } catch { /* 坏行跳过，不影响其余 */ }
  }
  return out
}

/** 递归找出所有会话文件。 */
export function listSessionFiles(root = sessionsRoot()) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > 3) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (e.isFile() && FILE_RE.test(e.name)) out.push(p)
    }
  }
  if (!existsSync(root)) return []
  walk(root, 0)
  return out
}

/** 子代理会话不算"项目历史"：它们是临时工的工作记录，不是项目的经历。 */
export function isSubagentHeader(h) {
  const d = h?.delegationDepth
  return (Number.isSafeInteger(d) && d > 0) || h?.origin === 'subagent'
}

/**
 * 列会话（只读头，快）。
 *
 * cwd 过滤走的是**会话头里的 cwd 字段**，不是目录名的反推 ——
 * 目录名是被 mangle 过的（D:\Harness -> --D-Harness--），反推规则一旦变就会
 * 静默漏掉会话，而"查不到"和"没有"必须分得开。
 */
export function listSessions({ root = sessionsRoot(), cwd = null, includeSubagents = false, limit = 0 } = {}) {
  const rows = []
  for (const file of listSessionFiles(root)) {
    const h = readSessionHeader(file)
    if (!h) continue
    if (!includeSubagents && isSubagentHeader(h)) continue
    if (cwd && String(h.cwd ?? '').toLowerCase() !== String(cwd).toLowerCase()) continue
    rows.push({
      id: h.id,
      file,
      cwd: h.cwd ?? '',
      createdAt: h.createdAt ?? 0,
      delegationDepth: Number.isSafeInteger(h.delegationDepth) ? h.delegationDepth : 0,
      agentPreset: h.agentPreset ?? '',
      parentSession: h.parentSession ?? '',
      isSubagent: isSubagentHeader(h),
      // 会话格式版本（v0 / v3 / …）。**读得到就有，读不到是 null** ——
      // 下游据此判断该会话的事件形状（例如 v3 用 tool/ptc-dispatch）。
      version: sessionFormatVersion(h, file),
    })
  }
  rows.sort((a, b) => b.createdAt - a.createdAt)
  return limit > 0 ? rows.slice(0, limit) : rows
}
