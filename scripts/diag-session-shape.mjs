// 一次性诊断：会话事件的**真实形状**是什么（别再照猜）。
//
// 起因（2026-09-17）：wiki_harvest 读当前会话时返回 transcriptChars=0，
// 而同一段对话按会话 id 从磁盘提炼是好的。差别只在取材那一步：
//   harvest.js 读的是 agent?.session?.events —— 一个**假定存在**的属性。
// 这个脚本回答：磁盘上真实的 user/message 与 assistant/message 长什么样，
// 以及 Session 对象到底暴露了什么。
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { decodeSession, FILE_RE } from '../lib/session-store.js'

const root = process.env.DSH_SESSIONS_ROOT || join(homedir(), '.dsh', 'sessions')

function walk(dir, out = []) {
  let ents = []
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (FILE_RE.test(e.name)) { try { out.push({ p, m: statSync(p).mtimeMs, s: statSync(p).size }) } catch {} }
  }
  return out
}

const files = walk(root).sort((a, b) => b.m - a.m)
console.log('sessions root: ' + root)
console.log('session files: ' + files.length)
if (!files.length) process.exit(0)
const top = files[0]
console.log('newest: ' + top.p)
console.log('  size=' + top.s + ' mtime=' + new Date(top.m).toISOString())

const text = decodeSession((await import('node:fs')).readFileSync(top.p))
const lines = text.split('\n').filter(Boolean)
console.log('decoded events: ' + lines.length)

const hist = {}
const samples = {}
const humanKinds = {}
let humanOk = 0, assistantTextOk = 0
for (const line of lines) {
  let ev
  try { ev = JSON.parse(line) } catch { continue }
  hist[ev.type] = (hist[ev.type] ?? 0) + 1
  if (samples[ev.type] === undefined) {
    samples[ev.type] = JSON.stringify(ev).slice(0, 300)
  }
  if (ev.type === 'user/message') {
    const k = ev?.data?.source?.kind
    humanKinds[String(k)] = (humanKinds[String(k)] ?? 0) + 1
    if (k === 'user') humanOk++
  }
  if (ev.type === 'assistant/message') {
    const c = ev?.data?.message?.content
    if (Array.isArray(c) && c.some(x => x?.type === 'text' && String(x.text ?? '').trim())) assistantTextOk++
  }
}
console.log('\n=== type histogram ===')
for (const [k, v] of Object.entries(hist).sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log('  ' + v + '  ' + k)
console.log('\n=== user/message source.kind ===')
console.log('  ' + JSON.stringify(humanKinds))
console.log('  isHumanMessage(旧判据 source.kind==="user") 命中: ' + humanOk)
console.log('  assistant/message 有 text 段: ' + assistantTextOk)
console.log('\n=== samples ===')
for (const k of ['session', 'user/message', 'assistant/message']) {
  if (samples[k]) console.log('  ' + k + ': ' + samples[k])
}
