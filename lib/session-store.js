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
//
//   * 每一行是一个 JSON 事件，含 { type, seq, time, data } 或带 message。
//   * 文件是**多帧 zstd 拼接**（每次追加写一帧）。实测一个 3.6MB 的文件有
//     3,497 帧、解出 11M 字符。
//   * ★ **不能用 zlib.createZstdDecompress() 流式解** —— 它和 gzip 不一样，
//     遇到第二帧就停（实测只解出第一帧的 170 字符）。必须自己按魔数切帧。
import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const FILE = 'session.jsonl.zstd'

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
      else if (e.isFile() && e.name === FILE) out.push(p)
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
    })
  }
  rows.sort((a, b) => b.createdAt - a.createdAt)
  return limit > 0 ? rows.slice(0, limit) : rows
}
