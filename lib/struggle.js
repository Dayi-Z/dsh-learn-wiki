// 挣扎检测器：判断 agent 是不是"卡住了"。
//
// 为什么需要它：原先的触发器是"检索未命中"，那个信号太廉价——任何新话题都会
// 未命中，于是系统为聊到的每件新鲜事都去联网，噪声大、烧钱、而且只能帮到下一次。
// 真正值钱的信号是"卡住了"：稀有、昂贵，且必须当场兑现。
//
// 与 @deepseek-ai/dsh-repeat-tool-reminder 的关系：它已经做了一半——
// 检测连续相同调用并提醒模型"换个办法"。但它只说到"换个办法"为止，
// 从不告诉你换成什么。本模块提供它缺的那一半的**触发条件**：
// 认出"提醒过了、还在打转"的那一刻，才动用外部知识检索预算。
//
// 判据刻意比它更严（它 3 我就 5）：它负责提醒，我负责花钱。

import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'

// ★ user-correction 与其余四种**来源不同**：那四种是工具层观测到的（失败、重复、churn），
//   这一种是**用户说的**。它补的正是它们共同的盲区：工具全都成功、但答案是错的。
//   刻意**不**加进 gapTriggerSignals 白名单 —— 纠正的答案来自用户，
//   联网去搜用户刚说过的话，最可能的结局是搜到一堆无关内容。
export const SIGNAL_TYPES = ['repeat-identical', 'repeat-failure', 'edit-churn', 'recurring-error', 'user-correction']

const FILE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])

/** 规范化参数：深度排序后序列化，所以仅属性顺序不同的调用视为相同。 */
export function canonicalArgs(args) {
  if (args === null || typeof args !== 'object') return String(args)
  try {
    const out = {}
    for (const k of Object.keys(args).sort()) {
      const v = args[k]
      out[k] = typeof v === 'string' && v.length > 300 ? v.slice(0, 300) + '…' : v
    }
    return JSON.stringify(out)
  } catch {
    return String(args)
  }
}

/**
 * 把报错文本压成"同一堵墙"的指纹。
 * 关键：路径、行号、十六进制地址、数字都会变，但**墙是同一堵**。
 * 不归一化的话，"同一个错误重试三次"会被看成三个不同错误。
 */
export function normalizeError(text) {
  return String(text ?? '')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<path>')
    .replace(/\/(?:[^\s"'/]+\/)+[^\s"']*/g, '<path>')
    .replace(/0x[0-9a-f]+/gi, '<hex>')
    .replace(/\b\d{2,}\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

/**
 * 把一次工具结果里的正文抠出来（递归找 type==='text'）。
 *
 * 为什么需要：判"这次是不是失败了"不能只看 result.isError。
 * 实测 15868 条真实 tool/result：
 *   isError=true 的 1228 条，**全部是 "unknown tool" 这类 harness 层错误**；
 *   正文里带 "[exit code: N]"(N≠0) 的 588 条，**没有一条**置了 isError。
 * 也就是说"跑了检查、失败了"这件事，对原来的检测器完全不可见 ——
 * 两个号称零误报的低噪信号（repeat-failure / recurring-error）只会在模型
 * 用错工具接口时响，真正卡在失败测试上时一声不吭。
 *
 * 这也解释了 edit-churn 为什么噪声那么高：它是唯一会响的信号，
 * 于是独自承担了全部触发。
 */
export function resultText(result, { maxChars = 4000 } = {}) {
  const out = []
  let used = 0
  const walk = (node, depth) => {
    if (used >= maxChars || depth > 6 || node == null) return
    if (typeof node === 'string') return
    if (Array.isArray(node)) { for (const it of node) walk(it, depth + 1); return }
    if (typeof node !== 'object') return
    if (node.type === 'text' && typeof node.text === 'string') {
      out.push(node.text)
      used += node.text.length
      return
    }
    if (node.content !== undefined) walk(node.content, depth + 1)
    if (node.error !== undefined) walk(node.error, depth + 1)
    if (typeof node.message === 'string' && node.message) { out.push(node.message); used += node.message.length }
  }
  walk(result, 0)
  return out.join('\n').slice(0, maxChars)
}

/** DSH 的约定：命令非零退出会以 `[exit code: N]` 的形式落在结果正文里。 */
const EXIT_MARKER = /\[exit code: (-?\d+)\]/g

/**
 * 只有**这些工具**的结果里，`[exit code: N]` 才代表它**自己**的退出码。
 *
 * ★ 其他工具的结果里出现这个标记，是在**回显别人的输出**，不是自己失败。
 *   实测（77 个会话）：759 条带非零退出标记的结果里，51 条来自非 shell 工具 ——
 *   最多的是 job_output（35 条，它返回的就是另一个进程的 stdout），
 *   还有 edit / grep / run_code。把它们算成失败，会让检测器在**回显一段报错**时报警，
 *   而那正是"读日志"这件事本身。
 */
const SHELL_TOOLS = new Set(['pwsh', 'bash', 'shell', 'sh'])

/**
 * 这次调用算不算**失败**。
 *
 * isError 是 harness 层的语义（工具没找到、参数非法、执行抛异常）。
 * 它**不覆盖**"命令跑了但失败" —— 而那恰恰是开发里最常见的死胡同：
 * 改代码 → 跑检查 → 退出码非 0 → 再改。
 *
 * 判据刻意保守：只认证据，不认语气。
 *   * result.isError === true                              → 失败（任何工具）
 *   * **shell 工具**的正文含 [exit code: N] 且 N ≠ 0        → 失败
 * 不把 "Error:" 之类的字眼当判据 —— 讨论错误的输出里到处都是它，
 * 那会把"正在读一段报错日志"误判成"我们自己失败了"。
 * 同理，退出码标记也只对 shell 工具自己算数（见 SHELL_TOOLS）。
 *
 * @param result DSH 的工具结果（{isError, content} 或其包装）
 * @param tool   工具名。**省略时只认 isError** —— 退化成更保守的那一半，
 *               而不是更激进的那一半：宁可漏判失败，也不要把回显当失败。
 */
export function looksLikeFailure(result, tool) {
  if (result?.isError === true) return true
  if (!SHELL_TOOLS.has(String(tool ?? ''))) return false
  const text = resultText(result, { maxChars: 6000 })
  if (!text) return false
  for (const m of text.matchAll(EXIT_MARKER)) {
    const code = Number(m[1])
    if (Number.isFinite(code) && code !== 0) return true
  }
  return false
}

/**
 * 从失败结果里取一个"同一堵墙"的指纹。
 *
 * 命令失败时 result.error 往往是空的，指纹只能从正文里取。
 * 取尾部而不是头部：命令输出的**结尾**才是结论（错误摘要、失败断言），
 * 头部通常是它在做什么。归一化之后同样的墙会撞出同样的指纹。
 */
export function failureSignature(text) {
  const t = String(text ?? '').trim()
  if (!t) return ''
  // 优先取 stderr 段：DSH 用 [stderr] 标出错误输出，那才是"同一堵墙"的本体。
  // 直接取尾部会把恰好打印在它后面的无关日志当成指纹 —— 实测出现过一堵墙的
  // 指纹是 "ui: /learn-wiki 已注册 … PASS"，既不是错误也不可搜。
  const i = t.lastIndexOf('[stderr]')
  return normalizeError(i >= 0 ? t.slice(i) : t.slice(-400))
}

export function fileFromExec(exec) {
  if (!FILE_TOOLS.has(exec?.name)) return undefined
  const a = exec?.arguments
  if (!a || typeof a !== 'object') return undefined
  const p = typeof a.file_path === 'string' ? a.file_path : (typeof a.path === 'string' ? a.path : undefined)
  return p && p.trim() ? p.trim() : undefined
}

/** 从窗口里找出全部触发的信号。纯函数，便于单测。 */
export function detect(windowEvents, cfg) {
  const out = []
  if (!windowEvents.length) return out

  // 连续完全相同的调用
  let bestRun = 0, bestTool = '', curKey = null, curRun = 0, curTool = ''
  for (const e of windowEvents) {
    if (e.key === curKey) curRun++
    else { curKey = e.key; curRun = 1; curTool = e.tool }
    if (curRun > bestRun) { bestRun = curRun; bestTool = curTool }
  }
  if (bestRun >= cfg.struggleRepeatIdentical) {
    out.push({ type: 'repeat-identical', count: bestRun, detail: bestTool + ' × ' + bestRun, identity: bestTool })
  }

  // 连续失败（工具/参数可以一直变，但每次都以错误收场）
  let bestFail = 0, curFail = 0, failFrom = '', lastFailSig = ''
  for (const e of windowEvents) {
    if (e.failed) {
      if (curFail === 0) failFrom = e.tool
      curFail++
      if (curFail > bestFail) bestFail = curFail
      if (e.errorSig) lastFailSig = e.errorSig
    } else {
      curFail = 0
      lastFailSig = ''
    }
  }
  if (bestFail >= cfg.struggleRepeatFailure) {
    // identity 必须是**稳定的**：这里用起始工具而不是 detail。
    // detail 里带计数，用它做去重键会让"连续 3 次 / 4 次 / 5 次"各算一次事故——
    // 实测一次探测被记成了 3 条记录、触发了 3 次。identity 不随计数变化。
    //
    // ★ 但**查询文本**同样不能带计数 —— 同一个坑的第二半。
    //   symptomQuery() 取的是 detail，而 detail 里写着"连续 5 次失败"。
    //   失败连着涨的时候，同一个错误会依次变成 5、6、7、8 次失败，
    //   每次都生成一个**不同的查询**，于是每次都是一个新 hash、新 gap 条目 ——
    //   同一堵墙在队列里躺成好几条，每一条都可能独立触发一次联网。
    //   实测（verify-plugin 日志）：一次连续失败在队列里生成了 5/6/7/8 四条。
    //   所以把**最后那次失败的错误指纹**一起带上：它是稳定的，而且可搜。
    out.push({
      type: 'repeat-failure',
      count: bestFail,
      detail: '自 ' + failFrom + ' 起连续 ' + bestFail + ' 次失败',
      identity: failFrom,
      // 稳定且可检索的部分（symptomQuery 优先用它）
      ...(lastFailSig ? { errorSig: lastFailSig } : {}),
    })
  }

  // 同一文件被反复改写 —— 但**只有配上失败证据**才算"走进死胡同"。
  //
  // 为什么加这个条件（实测数据）：43 条挣扎记录里 35 条是 edit-churn，
  // 全部来自正常的迭代开发（同一个 client.js 改了十几次、每次都跑通了）。
  // 它登记的两条 gap 里，一条被蒸馏器拒绝、另一条沉淀出了一页关于
  // **另一个撞名项目**的内容 —— 35 次触发，零正确产出。
  //
  // "反复修改"本身只是**努力**，不是失败。死胡同的字面证据是**撞了墙**：
  // 改了、跑了、不行、再来。所以要求和失败共现。
  const byFile = new Map()
  for (const e of windowEvents) if (e.file) byFile.set(e.file, (byFile.get(e.file) ?? 0) + 1)
  let topFile = null, topCount = 0
  for (const [f, c] of byFile) if (c > topCount) { topFile = f; topCount = c }
  if (topCount >= cfg.struggleEditChurn) {
    const fails = windowEvents.filter(e => e.failed)
    // 开关的默认值是 true；写成 !== false 是为了让"没配这一项"的旧配置
    // 也拿到新行为 —— 否则一次升级会静默退回旧语义。
    const needFail = cfg.struggleEditChurnNeedsFailure !== false
    if (!needFail || fails.length > 0) {
      out.push({
        type: 'edit-churn',
        count: topCount,
        detail: topFile + ' 改了 ' + topCount + ' 次' + (fails.length ? '，其间 ' + fails.length + ' 次失败' : ''),
        file: topFile,
        identity: topFile,
        // 把证据随信号一起记下来。将来判断"这条规则到底有没有用"，
        // 靠的就是这些数字，而不是回头再猜一遍。
        failCount: fails.length,
      })
    }
  }

  // 同一堵墙反复出现
  const byErr = new Map()
  for (const e of windowEvents) if (e.errorSig) byErr.set(e.errorSig, (byErr.get(e.errorSig) ?? 0) + 1)
  let topErr = null, topErrCount = 0
  for (const [sig, c] of byErr) if (c > topErrCount) { topErr = sig; topErrCount = c }
  if (topErrCount >= cfg.struggleRecurringError) {
    out.push({ type: 'recurring-error', count: topErrCount, detail: topErr, errorSig: topErr, identity: topErr })
  }

  return out
}

export function createStruggleTracker(cfg) {
  const states = new WeakMap()

  const stateFor = (agent) => {
    let s = states.get(agent)
    if (!s) { s = { events: [], lastReported: new Map() }; states.set(agent, s) }
    return s
  }

  return {
    /** 观察一次工具结果，返回本次新触发的信号（含冷却去重）。 */
    observe(agent, exec, result) {
      const s = stateFor(agent)
      const errText = result?.error?.message ?? result?.error?.name ?? ''
      const failed = looksLikeFailure(result, exec?.name)
      // 字段名刻意**不叫** isError：它比 isError 宽（多算了"命令非零退出"）。
      // 沿用原名会让人以为语义没变，而语义变了正是这次修复的全部内容。
      const errorSig = failed
        ? (normalizeError(errText) || failureSignature(resultText(result)))
        : ''
      s.events.push({
        ts: Date.now(),
        tool: exec?.name ?? '?',
        key: (exec?.name ?? '?') + '|' + canonicalArgs(exec?.arguments),
        failed,
        errorSig,
        file: fileFromExec(exec),
      })
      if (s.events.length > cfg.struggleWindow) s.events.splice(0, s.events.length - cfg.struggleWindow)

      const now = Date.now()
      const fired = []
      for (const sig of detect(s.events, cfg)) {
        // 去重键必须同时满足两条，缺一条都不行：
        //   1. 含**具体对象**：只用类型的话，"edit-churn 报过一次"会让接下来几分钟内
        //      换一个文件反复改也不再报警——那是两个不同的问题。
        //   2. 只用**稳定**的字段：曾经这里回退到 detail，而 detail 里带计数，
        //      于是同一个事故随着计数增长不断换键、冷却形同虚设。
        //      实测一次探测被记了 3 条、触发了 3 次。identity 就是为这条存在的。
        const dedupeKey = sig.type + '|' + String(sig.identity ?? sig.file ?? sig.errorSig ?? '')
        const last = s.lastReported.get(dedupeKey) ?? 0
        if (now - last < cfg.struggleCooldownMs) continue
        s.lastReported.set(dedupeKey, now)
        fired.push(sig)
      }
      return fired
    },
    /** 用户新提示词到达时清空窗口——上一轮的挣扎不该污染新任务。 */
    reset(agent) {
      const s = states.get(agent)
      if (s) { s.events.length = 0; s.lastReported.clear() }
    },
  }
}

const baseName = (p) => String(p ?? '').split(/[\\/]/).pop() || String(p ?? '')

/**
 * 把挣扎信号翻译成**症状查询**。
 *
 * 这是整个改造的关键一步：原来的查询是用户的原话（"ok 按你的倾向来"），
 * 那是**意图**不是**症状** —— 搜索引擎对前者只能给出噪声。
 * 症状（报错文本、反复失败的工具、改不动的文件）才是网上真的有人写过的。
 */
export function symptomQuery(signals, context = '') {
  const parts = []
  for (const s of signals) {
    if (s.type === 'recurring-error') {
      parts.push(String(s.errorSig || s.detail || '').slice(0, 160))
    } else if (s.type === 'edit-churn') {
      // 本地文件名不是"网上真有人写过"的症状：网上不存在"反复修改 client.js
      // 仍不成功"（只会撞上同名项目 —— 实测 35 次触发零产出）。只有配上
      // **失败证据**才值得一搜（改了、跑了、不行 —— 死胡同的字面证据）；
      // 无失败证据就是正常迭代，不生成查询。
      const n = Number(s.failCount) || 0
      if (n > 0) parts.push('反复修改 ' + baseName(s.file) + ' 仍不成功 常见原因')
    } else if (s.type === 'repeat-failure') {
      // ★ 只认**错误指纹**。没有 errorSig 时退回"工具名 + 连续失败"是查询撒谎
      //   的另一种：网上没有针对性的内容（有也是泛化教程），蒸馏器必然拒绝，
      //   白白烧掉一轮 maxAcquisitionsPerRun 预算（实测 33 个 refused 里大量是
      //   这种退化查询）。没有可搜的墙，就不生成查询。
      const sig = String(s.errorSig || '').slice(0, 120)
      if (!sig) continue
      parts.push(sig + ' 常见故障原因 解决办法')
    } else if (s.type === 'repeat-identical') {
      // identity 是稳定工具名；detail 带计数（"tool × N"）会让同一现象随 N 变化
      // 生成不同 hash、在队列里躺成多条 gap。
      parts.push(String(s.identity || s.tool || s.detail || '').slice(0, 60) + ' 重复调用无进展 正确用法')
    }
  }
  const head = parts.join('；').trim()
  if (!head) return ''
  // ★ 任务上下文不进查询：中文长指令对搜索引擎是纯噪声，而且 appendGap 用整条
  //   查询做 hash id —— 同一错误 + 不同任务 = 不同 hash = 同一堵墙躺成多条 gap，
  //   每一条都可能独立触发一次联网。投递回灌定位用的是 sessionId，不是查询文本。
  return head.slice(0, 400)
}

export function struggleLogPath(wikiRoot) {
  return join(wikiRoot, 'struggle.jsonl')
}

/** 落一条检测记录。观察模式下这是唯一产物——先看它报得准不准，再决定要不要自动联网。 */
export async function recordStruggle(wikiRoot, entry) {
  try {
    await appendFile(struggleLogPath(wikiRoot), JSON.stringify(entry) + '\n', 'utf8')
  } catch { /* 记录失败绝不能影响主流程 */ }
}

export async function readStruggles(wikiRoot, limit = 200) {
  try {
    const raw = await readFile(struggleLogPath(wikiRoot), 'utf8')
    const rows = raw.split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    return rows.slice(-limit)
  } catch { return [] }
}
