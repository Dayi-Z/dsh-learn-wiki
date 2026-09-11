// 用真实会话回放，量化 edit-churn 修复的效果。
//
// 为什么值得做：这条规则的整改依据是"35 次触发零正确产出"，但那是**信号计数**，
// 不是"改建之后会拦住多少"。真实数据里存着完整的工具调用序列，可以真的跑一遍
// 新旧两套判据，把差别量出来 —— 而不是靠推理说"应该能拦住"。
//
// 事件形状（解真实会话确认，别照猜）：
//   tool/code-dispatch  { name, arguments(对象), isError, content }   ← Code Mode 内层派发，
//                        形状与插件 tools/result 收到的一模一样
//   tool/call           { callId, name, arguments(JSON 字符串) }      ← 外层
//   tool/result         data.message.content[0] = { toolCallId, content, isError }
import { readFileSync, readdirSync, statSync } from 'node:fs'
import zlib from 'node:zlib'
import { join } from 'node:path'
import { detect, canonicalArgs, looksLikeFailure, fileFromExec } from '../lib/struggle.js'
import { DEFAULTS } from '../lib/config.js'

function decode(p) {
  const buf = readFileSync(p)
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i++) if (buf[i]===0x28&&buf[i+1]===0xb5&&buf[i+2]===0x2f&&buf[i+3]===0xfd) starts.push(i)
  let out = ''
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k+1] : buf.length
    try { out += zlib.zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8') } catch {}
  }
  return out
}

function replay(path) {
  const calls = new Map()
  const obs = []
  for (const l of decode(path).split('\n')) {
    if (!l) continue
    let j; try { j = JSON.parse(l) } catch { continue }
    const d = j.data
    if (!d) continue

    // 内层派发：直接就是一次观测
    if (j.type === 'tool/code-dispatch') {
      const exec = { name: d.name, arguments: d.arguments }
      obs.push({ tool: d.name, key: d.name + '|' + canonicalArgs(d.arguments), failed: looksLikeFailure(d), file: fileFromExec(exec) })
      continue
    }
    // 外层：先记调用，等结果
    if (j.type === 'tool/call') {
      let args = d.arguments
      if (typeof args === 'string') { try { args = JSON.parse(args) } catch { args = {} } }
      calls.set(d.callId, { name: d.name, arguments: args })
      continue
    }
    if (j.type === 'tool/result') {
      const item = Array.isArray(d.message?.content) ? d.message.content[0] : null
      if (!item) continue
      const c = calls.get(item.toolCallId)
      if (!c) continue
      const exec = { name: c.name, arguments: c.arguments }
      obs.push({ tool: c.name, key: c.name + '|' + canonicalArgs(c.arguments), failed: looksLikeFailure(item), file: fileFromExec(exec) })
    }
  }
  return obs
}

const base = process.argv[2]
const sessions = []
for (const d of readdirSync(base)) {
  if (!statSync(join(base, d)).isDirectory()) continue
  try { statSync(join(base, d, 'session.jsonl.zstd')) } catch { continue }
  let obs = []
  try { obs = replay(join(base, d, 'session.jsonl.zstd')) } catch { continue }
  if (obs.length >= 10) sessions.push({ id: d, obs })
}

/**
 * 按 tracker 的滑动窗口逐次调用 detect，统计两件事：
 *   churn   —— edit-churn 信号会触发多少次（记录层面）
 *   gaps    —— 其中有多少次会产生**一条缺口并去联网**（行动层面）
 * 两者分开数是有意的：本次整改要的不是"少记录"，而是"别拿不可搜的东西去搜网"。
 */
function countChurn(obs, cfg) {
  const W = cfg.struggleWindow
  const allow = new Set(cfg.gapTriggerSignals ?? [])
  const win = []
  let churn = 0, gaps = 0, eligibleGaps = 0
  for (const o of obs) {
    win.push(o)
    if (win.length > W) win.shift()
    const fired = detect(win, cfg)
    if (fired.some(s => s.type === 'edit-churn')) churn++
    if (fired.length > 0) gaps++                       // 旧规则：任何信号都去联网
    if (fired.some(s => allow.has(s.type))) eligibleGaps++  // 新规则：只有白名单里的
  }
  return { churn, gaps, eligibleGaps }
}

const newCfg = { ...DEFAULTS }
const oldCfg = { ...DEFAULTS, struggleEditChurnNeedsFailure: false }
console.log('会话数:', sessions.length, ' 工具观测总数:', sessions.reduce((n, s) => n + s.obs.length, 0))
console.log('')
const rows = []
const T = { churnOld: 0, churnNew: 0, gapOld: 0, gapNew: 0 }
for (const s of sessions) {
  const a = countChurn(s.obs, oldCfg)
  const b = countChurn(s.obs, newCfg)
  T.churnOld += a.churn; T.churnNew += b.churn
  T.gapOld += a.gaps; T.gapNew += b.eligibleGaps
  if (a.churn > 0) rows.push({ id: s.id, n: s.obs.length, a: a.churn, b: b.churn })
}
rows.sort((x, y) => y.a - x.a)
console.log('信号层（edit-churn 被记录的次数）')
for (const r of rows.slice(0, 10)) {
  console.log('  ' + r.id.slice(0, 22).padEnd(26) + String(r.n).padStart(6) + String(r.a).padStart(9) + String(r.b).padStart(9))
}
if (rows.length > 10) console.log('  … 余下 ' + (rows.length - 10) + ' 个会话')
console.log('')
console.log('记录（观测）：' + T.churnOld + ' → ' + T.churnNew
  + '  压掉 ' + Math.round((1 - T.churnNew / T.churnOld) * 100) + '%')
console.log('联网（行动）：' + T.gapOld + ' → ' + T.gapNew
  + '  压掉 ' + Math.round((1 - T.gapNew / T.gapOld) * 100) + '%')
const all = sessions.flatMap(s => s.obs)
console.log('')
console.log('失败判定的覆盖：全量 ' + all.length + ' 次调用中，被判为失败 ' + all.filter(o => o.failed).length + ' 次')
console.log('  其中靠 harness isError 的（工具误用类）：' + all.filter(o => o.failed && /unknown tool/.test('')).length + '（此处无法区分，见下）')
