// 会话摘要：把一坨原始事件压成可比较、可检索、可喂给模型的结构。
//
// 设计原则：**抽取确定性的事实，把判断留给后面那一步**。
// 摘要里不放"这次解决了什么"这种结论 —— 那是模型的活，而模型需要的是
// "同一堵墙在事件 120 出现、230 又出现、310 之后不再出现，紧接着成功的是
// 这个调用"这样的事实。把判断混进抽取，后面就没法复核了。
import { looksLikeFailure, normalizeError } from './struggle.js'

const FILE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])

/** 事件里的"人真正说的话"（其余是我们自己注入的：知识块、技能目录、子代理回执）。 */
function isHumanMessage(ev) {
  return ev?.type === 'user/message' && ev?.data?.source?.kind === 'user'
}

function textOf(content, onlyType) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const out = []
  for (const p of content) {
    if (!p || typeof p !== 'object') continue
    if (p.type !== (onlyType ?? 'text')) continue
    if (typeof p.text === 'string' && p.text.trim()) out.push(p.text.trim())
  }
  return out.join('\n').trim()
}

/** 把 tool/call 的 arguments（**是 JSON 字符串**）解析成对象。 */
function parseArgs(a) {
  if (a && typeof a === 'object') return a
  if (typeof a !== 'string') return {}
  try { const v = JSON.parse(a); return v && typeof v === 'object' ? v : {} } catch { return {} }
}

function fileOf(name, args) {
  if (!FILE_TOOLS.has(name)) return ''
  const p = args?.file_path ?? args?.path
  return typeof p === 'string' ? p.trim() : ''
}

/**
 * 摘要一个会话。
 *
 * @param events  readSessionEvents() 的结果（按时间正序）
 * @param header  会话头（可选；没有就用 events 里第一条 session 事件）
 */
/**
 * 累加器：**逐个事件喂**，最后出摘要。
 *
 * 为什么要拆出来：一次把整个会话读进内存代价很大（实测最大 13.66 MB
 * → 58,566 事件 → 堆峰值 ~370 MB、阻塞 2.5 秒），而这段代码跑在宿主主线程上。
 * 拆成累加器之后，流式路径可以"解一帧、喂进去、丢掉"，峰值内存降到压缩文件级别。
 *
 * array 路径（digestSession）与 stream 路径（digestSessionFile）都走这一个实现，
 * 所以两条路的**判据不可能漂移**。
 */
export function createDigestAccumulator(header = null) {
  const h = header ?? {}
  const out = {
    id: String(h.id ?? ''),
    cwd: String(h.cwd ?? ''),
    createdAt: Number(h.createdAt ?? 0),
    agentPreset: String(h.agentPreset ?? ''),
    isSubagent: (Number(h.delegationDepth) || 0) > 0 || h.origin === 'subagent',
    title: '',
    counts: { turns: 0, steps: 0, humanMessages: 0, assistantMessages: 0, toolCalls: 0, failures: 0 },
    toolsUsed: {},
    filesTouched: {},
    walls: [],
    firstAsk: '',
    lastAsk: '',
    signal: null,          // { kind: 'unfinished' | 'moved-on' }
  }

  const outcomes = []
  const humanTexts = []
  // 工具调用的配对状态也要留在累加器里 —— 流式路径下事件是一条条来的，
  // 不能事后回头再配一次。
  const calls = new Map()
  const failedRoots = new Set()

  const noteOutcome = (o) => {
    outcomes.push(o)
    out.counts.toolCalls++
    out.toolsUsed[o.name] = (out.toolsUsed[o.name] ?? 0) + 1
    const f = fileOf(o.name, o.args)
    if (f) out.filesTouched[f] = (out.filesTouched[f] ?? 0) + 1
    if (o.failed) out.counts.failures++
  }

  // 自己数被喂进来的事件数 —— 数组路径和流式路径由此得到同一个 eventsScanned，
  // 否则同一份会话经两个入口摘要出来会差一个字段，调用方无从判断该信谁。
  let scanned = 0

  const push = (ev) => {
    scanned++
    const d = ev?.data
    switch (ev?.type) {
      case 'session/title': {
        const t = d?.title ?? d
        if (typeof t === 'string' && t.trim()) out.title = t.trim()
        break
      }
      case 'turn/start': out.counts.turns++; break
      case 'step/start': out.counts.steps++; break
      case 'assistant/message': out.counts.assistantMessages++; break
      case 'user/message': {
        if (!isHumanMessage(ev)) break
        const t = textOf(d.content)
        if (!t) break
        out.counts.humanMessages++
        humanTexts.push(t)
        break
      }
      case 'tool/call': {
        if (d) calls.set(d.callId, { name: String(d.name ?? '?'), args: parseArgs(d.arguments) })
        break
      }
      // Code Mode 的内层派发。**两个名字都要认**：
      //   tool/code-dispatch —— 老会话（v0/v1/v2）
      //   tool/ptc-dispatch  —— 宿主 0.1.5-rc.2 起（v3 会话实测就是这个）
      // 载荷结构几乎相同（rootCallId / parentCallId / name / arguments /
      // isError / content），所以只是改了个名字，判据一个字都不用动。
      //
      // ★ 漏掉它的后果不是"少几张卡片"，而是**摘要会反过来说话**：
      //   PTC 模式会话里所有真实工具调用都藏在这一层，漏掉之后
      //   toolsUsed 只剩 run_code、filesTouched 全空、failures 为 0 ——
      //   读起来像"这次会话没改过文件也没踩过坑"，而事实正相反。
      //   而 v3 会话不再写 assistant/chunk 等流式事件，这些派发事件是**唯一**线索。
      case 'tool/code-dispatch':
      case 'tool/ptc-dispatch': {
        if (!d) break
        const name = String(d.name ?? '?')
        const failed = looksLikeFailure(d, name)
        if (failed && d.rootCallId) failedRoots.add(String(d.rootCallId))
        noteOutcome({
          seq: ev.seq, name, args: parseArgs(d.arguments), failed,
          errorSig: failed ? normalizeError(textOf(d.content)) : '',
          inner: true,
        })
        break
      }
      case 'tool/result': {
        const item = Array.isArray(d?.message?.content) ? d.message.content[0] : null
        if (!item) break
        const callId = String(item.toolCallId ?? '')
        const c = calls.get(callId)
        if (!c) break
        const failed = looksLikeFailure(item, c.name)
        // ★ 跳过**复述**：外层 run_code 的失败结果里包着的，往往是它内部某次派发的同一个错误。
        //   两个都记，同一堵墙就被数了两次 —— 实测 124 次内层失败对应 122 次外层失败，几乎 1:1。
        //   关联是**精确的**：dispatch.rootCallId === tool/call.callId。
        if (failed && c.name === 'run_code' && failedRoots.has(callId)) break
        noteOutcome({
          seq: ev.seq, name: c.name, args: c.args, failed,
          errorSig: failed ? normalizeError(textOf(item.content)) : '',
          inner: false,
        })
        break
      }
      default: break
    }
  }

  const finish = () => {
  out.eventsScanned = scanned
  out.firstAsk = (humanTexts[0] ?? '').slice(0, 300)
  out.lastAsk = (humanTexts[humanTexts.length - 1] ?? '').slice(0, 300)

  // ── 撞过的墙 ──
  //
  // 按错误指纹归组。只有出现 ≥2 次的才算"墙"：一次失败是正常试错，
  // 反复撞同一个才是卡住 —— 和挣扎检测器同一个判据。
  //
  // ★ afterLastFailure 是**候选**修正，不是证明过的修正。
  //   "最后一次失败之后第一个成功的调用"只是时间上的相邻，因果是模型要去判断的。
  //   字段名刻意不叫 fix，就是不希望后来的人把它当成结论。
  const bySig = new Map()
  let weakFailures = 0
  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i]
    if (!o.failed) continue
    // ★ 只有**带可描述症状**的失败才成墙。
    //
    //   实测：一个命令以非零退出、但输出全是 PASS 行时，"指纹"就是那堆无关日志
    //   （出现过的真实例子：指纹是 "ui: /learn-wiki 已注册 … PASS"）。
    //   这种墙既搜不出来、也无从推理 —— 留着只会稀释真正有价值的那些。
    //   但它**不能被静默丢掉**：计数进 weakFailures，界面上看得到。
    if (!o.errorSig || !looksLikeSymptom(o.errorSig)) { weakFailures++; continue }
    let w = bySig.get(o.errorSig)
    if (!w) { w = { sig: o.errorSig, indices: [], tools: {} }; bySig.set(o.errorSig, w) }
    w.indices.push(i)
    w.tools[o.name] = (w.tools[o.name] ?? 0) + 1
  }
  out.counts.weakFailures = weakFailures
  for (const w of bySig.values()) {
    if (w.indices.length < 2) continue
    const lastIdx = w.indices[w.indices.length - 1]
    const later = outcomes.slice(lastIdx + 1)
    // ★ 找"最后一次失败之后第一步做了什么"时，**跳过 run_code**。
    //   它包着几乎所有调用，说"之后第一步是 run_code"等于什么都没说
    //   —— 实测第一次跑出来的摘要里，每一堵墙后面都写着同一句话。
    //   取第一个内层调用，那才是真正干了什么的那一下。
    const after = later.find(x => !x.failed && x.inner) ?? later.find(x => !x.failed) ?? null
    out.walls.push({
      sig: w.sig,
      count: w.indices.length,
      tools: w.tools,
      atSeq: outcomes[lastIdx]?.seq ?? 0,
      // 之后还有没有继续撞：没有 = 从这一堵墙里出来了
      afterLastFailure: after
        ? { name: after.name, failed: after.failed, file: fileOf(after.name, after.args) || '', argsPreview: previewArgs(after.args) }
        : null,
      resolvedAfter: later.length > 0 && !later.some(x => x.failed && x.errorSig === w.sig),
    })
  }
  out.walls.sort((a, b) => b.count - a.count)

  // 会话层面的信号：最后一堵墙到结束之间还有多少步。剩得多 = 大概率解决了；
  // 贴着结尾 = 大概率是带着问题收场的。这是**信号**，不是结论。
  const lastWall = out.walls[out.walls.length - 1]
  if (lastWall) {
    const idx = outcomes.findIndex(o => o.seq === lastWall.atSeq)
    const rest = idx >= 0 ? outcomes.length - idx - 1 : 0
    out.signal = { kind: rest >= 3 ? 'moved-on' : 'unfinished', eventsAfterLastWall: rest }
  }

  return out
  }   // finish

  return { push, finish, out }
}

/**
 * 摘要一个会话（数组路径）。
 *
 * @param events  readSessionEvents() 的结果（按时间正序）
 * @param header  会话头（可选；没有就用 events 里第一条 session 事件）
 */
export function digestSession(events, header = null) {
  const h = header ?? events.find(e => e?.type === 'session') ?? {}
  const acc = createDigestAccumulator(h)
  for (const ev of events) acc.push(ev)
  return acc.finish()
}

/** 摘要一个会话（**流式**路径：解一帧喂一帧，不把事件攒成数组）。 */
export async function digestSessionFile(file, header, streamFn) {
  const acc = createDigestAccumulator(header ?? {})
  await streamFn(file, (ev) => acc.push(ev))
  return acc.finish()
}

/**
 * 摘要 **和** 取材一次扫完。
 *
 * 为什么要合：两者都要把整个会话解一遍，而解一遍在大会话上实测 **2.8 秒**
 * —— 且这 2.8 秒在解压期间无法中断。分成两次调用等于把代价翻倍
 * （wiki_sessions show 原来就是 2.8+2.1=4.9 秒主线程无响应）。
 * 两个累加器互不干扰，喂同一串事件即可。
 */
export async function digestAndTranscriptFile(file, header, streamFn, opts = {}) {
  const acc = createDigestAccumulator(header ?? {})
  const col = createTranscriptCollector(opts)
  await streamFn(file, (ev) => { acc.push(ev); col.push(ev) })
  const d = acc.finish()
  return { digest: d, transcript: { ...col.finish(), eventsScanned: d.eventsScanned } }
}

/**
 * 这段指纹像不像一个**可描述的症状**。
 *
 * 判据故意宽（有一点点错误特征就算过）：这里要挡的是"完全不像错误"的东西
 * （一堆 PASS 行、一片日志），不是要精确分类错误类型。
 * 宁可多留几个可疑的，也不要靠一个狭窄的正则把真症状筛掉。
 *
 * 但**必须排除退出码标记本身** —— 见下面的注释，那是自检抓到的一个真错误。
 */
// ★ 这里**不能**包含 exit / exit code：那个标记出现在**每一条** shell 失败的
//   指纹里，把它当症状特征等于这个过滤器没写。
//   实测（自检抓到）：一条输出全是 "✓ PASS" 的失败因此被判成"有症状"，
//   于是它的"墙"就以一堆 PASS 行的样子挂在了列表上。
const SYMPTOM_HINT = /error|fail|exception|timed out|timeout|not found|refus|crash|cannot|can't|undefined|denied|missing|invalid|unknown|unexpected|E[A-Z]{4,}/i

function looksLikeSymptom(sig) {
  return SYMPTOM_HINT.test(String(sig ?? ''))
}

function previewArgs(args) {
  if (!args || typeof args !== 'object') return ''
  const k = args.file_path ?? args.command ?? args.query ?? args.description
  return typeof k === 'string' ? k.slice(0, 120) : Object.keys(args).slice(0, 4).join(',')
}

/** 从会话事件里抽一段"人能读的对话"（复用 wiki_harvest 的取舍规则）。 */
export function createTranscriptCollector({ maxChars = 6000, maxTurns = 8, maxMessageChars = 1200 } = {}) {
  const turns = []
  let cur = null
  // ★ 单条消息要有上限，否则**一条巨长的助手消息就能吃掉整个预算**。
  //   实测：一个 5 轮的历史会话，按轮数上限 8 / 字符上限 3000 取，
  //   最终只取到 **1 轮** —— 前面那条长回复把额度占满了。
  //   而"事后复盘"恰恰要看过程，只看最后一轮等于只看结论。
  //   截断单条、保住轮数，是这里更对的取舍。
  const clip = (t) => (t.length > maxMessageChars ? t.slice(0, maxMessageChars) + '\n…(本条截断)' : t)

  const push = (ev) => {
    if (isHumanMessage(ev)) {
      const t = textOf(ev.data.content)
      if (!t) return
      cur = [{ who: '用户', text: clip(t) }]
      turns.push(cur)
      return
    }
    if (ev?.type === 'assistant/message') {
      const t = textOf(ev.data?.message?.content, 'text')
      if (!t) return
      if (!cur) { cur = []; turns.push(cur) }
      cur.push({ who: '助手', text: clip(t) })
    }
  }

  const finish = () => {
  const picked = []
  let used = 0
  let truncated = false
  for (let i = turns.length - 1; i >= 0 && picked.length < maxTurns; i--) {
    const block = turns[i].map(m => '[' + m.who + '] ' + m.text).join('\n')
    if (used + block.length > maxChars && picked.length > 0) { truncated = true; break }
    picked.unshift(block)
    used += block.length
    if (used >= maxChars) { truncated = i > 0; break }
  }
  return { text: picked.join('\n\n'), turns: picked.length, chars: used, truncated }
  }   // finish

  return { push, finish }
}

/** 取材（数组路径）。 */
export function sessionTranscript(events, opts = {}) {
  const c = createTranscriptCollector(opts)
  for (const ev of events) c.push(ev)
  return c.finish()
}

/** 取材（**流式**路径：解一帧喂一帧，不把事件攒成数组）。 */
export async function sessionTranscriptFile(file, streamFn, opts = {}) {
  const c = createTranscriptCollector(opts)
  const n = await streamFn(file, (ev) => c.push(ev))
  return { ...c.finish(), eventsScanned: n }
}

/** 把一次会话的摘要渲染成一段紧凑文本（给模型看，也给 wiki_sessions 工具返回）。 */
export function renderDigest(d, { maxWalls = 5 } = {}) {
  const L = []
  L.push('会话 ' + d.id)
  L.push('  时间 ' + (d.createdAt ? new Date(d.createdAt).toISOString().slice(0, 16).replace('T', ' ') : '?')
    + '  轮次 ' + d.counts.turns + '  步 ' + d.counts.steps + '  工具调用 ' + d.counts.toolCalls
    + (d.counts.failures ? '（失败 ' + d.counts.failures
      + (d.counts.weakFailures ? '，其中 ' + d.counts.weakFailures + ' 次无可描述症状' : '') + '）' : ''))
  if (d.title) L.push('  标题 ' + d.title)
  if (d.firstAsk) L.push('  开场 ' + d.firstAsk.replace(/\s+/g, ' ').slice(0, 120))
  if (d.lastAsk && d.lastAsk !== d.firstAsk) L.push('  收场 ' + d.lastAsk.replace(/\s+/g, ' ').slice(0, 120))
  const files = Object.keys(d.filesTouched)
  if (files.length) L.push('  改过 ' + files.slice(0, 4).map(f => f.split(/[\\/]/).pop()).join(', ') + (files.length > 4 ? ' 等 ' + files.length + ' 个' : ''))
  for (const w of d.walls.slice(0, maxWalls)) {
    L.push('  ✕ ' + w.count + '×  ' + w.sig.slice(0, 100))
    L.push('      ' + (w.resolvedAfter ? '之后没再撞 → 可能解决了' : '之后再没机会验证')
      + (w.afterLastFailure ? '；最后一次失败后第一步是 ' + w.afterLastFailure.name
        + (w.afterLastFailure.file ? ' ' + w.afterLastFailure.file.split(/[\\/]/).pop() : '') : ''))
  }
  if (d.walls.length > maxWalls) L.push('  … 另有 ' + (d.walls.length - maxWalls) + ' 堵墙')
  return L.join('\n')
}
