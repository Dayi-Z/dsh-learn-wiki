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

export const SIGNAL_TYPES = ['repeat-identical', 'repeat-failure', 'edit-churn', 'recurring-error']

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
    out.push({ type: 'repeat-identical', count: bestRun, detail: bestTool + ' × ' + bestRun })
  }

  // 连续失败（工具/参数可以一直变，但每次都以错误收场）
  let bestFail = 0, curFail = 0, failFrom = ''
  for (const e of windowEvents) {
    if (e.isError) { if (curFail === 0) failFrom = e.tool; curFail++; if (curFail > bestFail) bestFail = curFail }
    else curFail = 0
  }
  if (bestFail >= cfg.struggleRepeatFailure) {
    out.push({ type: 'repeat-failure', count: bestFail, detail: '自 ' + failFrom + ' 起连续 ' + bestFail + ' 次失败' })
  }

  // 同一文件被反复改写（"反复修改走进死胡同"）
  const byFile = new Map()
  for (const e of windowEvents) if (e.file) byFile.set(e.file, (byFile.get(e.file) ?? 0) + 1)
  let topFile = null, topCount = 0
  for (const [f, c] of byFile) if (c > topCount) { topFile = f; topCount = c }
  if (topCount >= cfg.struggleEditChurn) {
    out.push({ type: 'edit-churn', count: topCount, detail: topFile + ' 改了 ' + topCount + ' 次', file: topFile })
  }

  // 同一堵墙反复出现
  const byErr = new Map()
  for (const e of windowEvents) if (e.errorSig) byErr.set(e.errorSig, (byErr.get(e.errorSig) ?? 0) + 1)
  let topErr = null, topErrCount = 0
  for (const [sig, c] of byErr) if (c > topErrCount) { topErr = sig; topErrCount = c }
  if (topErrCount >= cfg.struggleRecurringError) {
    out.push({ type: 'recurring-error', count: topErrCount, detail: topErr, errorSig: topErr })
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
      s.events.push({
        ts: Date.now(),
        tool: exec?.name ?? '?',
        key: (exec?.name ?? '?') + '|' + canonicalArgs(exec?.arguments),
        isError: result?.isError === true,
        errorSig: result?.isError === true ? normalizeError(errText) : '',
        file: fileFromExec(exec),
      })
      if (s.events.length > cfg.struggleWindow) s.events.splice(0, s.events.length - cfg.struggleWindow)

      const now = Date.now()
      const fired = []
      for (const sig of detect(s.events, cfg)) {
        // 去重键必须包含**具体对象**，不能只用类型。
        // 只用类型的话，"edit-churn 报过一次"会让接下来 2 分钟内
        // **换一个文件反复改也不再报警** —— 那是两个不同的问题。
        // 按"同一堵墙"去重：同一个文件/同一个报错抑制，不同的放行。
        const dedupeKey = sig.type + '|' + String(sig.file ?? sig.errorSig ?? sig.detail ?? '').slice(0, 80)
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
      parts.push('反复修改 ' + baseName(s.file) + ' 仍不成功 常见原因')
    } else if (s.type === 'repeat-failure') {
      parts.push(String(s.detail || '').slice(0, 120) + ' 常见故障原因 解决办法')
    } else if (s.type === 'repeat-identical') {
      parts.push(String(s.detail || '').slice(0, 120) + ' 重复调用无进展 正确用法')
    }
  }
  const head = parts.join('；')
  const ctx = String(context ?? '').trim().slice(0, 80)
  return (head + (ctx ? '（当前任务：' + ctx + '）' : '')).slice(0, 400)
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
