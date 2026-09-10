// 插件接线集成测试：用一个 mock ctx 跑 apply()，验证工具注册、
// agent/pre-step 注入、miss→gap 记录、turn/end 钩子都真的挂上了。
// 目的：不必重启 DSH 就能抓出事件名拼错 / API 用错这类错误。
import { rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureRepo } from '../lib/wiki.js'

const ROOT = '.tmp-plugin-test'
let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

await rm(ROOT, { recursive: true, force: true })
await ensureRepo(ROOT)

// 放一页已固化知识，用于验证 hit 路径
await writeFile(join(ROOT, 'pages', 'fact', 'widget-protocol.md'), `---
id: widget-protocol
title: Widget 协议约定
category: fact
confidence: 0.9
status: committed
sources:
  - https://example.com/widget
created: 2026-09-10T00:00:00Z
updated: 2026-09-10T00:00:00Z
hits: 0
tags: [widget, protocol]
---

Widget 协议使用长度前缀分帧，魔数为 0x57 0x47。
`, 'utf8')

// ── mock ctx ──
const registered = []
const handlers = {}
const sections = []
const mockCtx = {
  tools: { register: (def) => { registered.push(def); return () => {} } },
  llm: {
    listProviders: () => [{ id: 'mock' }],
    listModels: async () => [{ id: 'mock-model' }],
    stream: async function* () {},
  },
  web: { search: async () => ({ content: 'c', sources: [{ url: 'https://e.com', title: 't', snippet: 's' }] }) },
  // 只接受真实存在的 live 事件名。此前的 mock 对任何名字都照单全收，
  // 于是 ctx.on('turn/end', ...) 这种永不触发的订阅也能"通过"测试——
  // 结果整个补料路径在生产里是死的。mock 必须能证伪。
  on: (ev, h) => {
    const KNOWN = ['agent/pre-step', 'session/event', 'agent/created', 'agent/disposed', 'tools/result']
    if (!KNOWN.includes(ev)) throw new Error('mock: 未知 live 事件名 "' + ev + '"（订阅它永远收不到通知）')
    ;(handlers[ev] ||= []).push(h)
    return () => {}
  },
  effect: (fn) => fn(),
  inject: (services, cb) => { cb({ systemPrompt: { section: (s) => { sections.push(s); return () => {} } } }) },
}

const mod = await import('../index.js')
check('导出 name / inject / apply', mod.name === 'dsh-learn-wiki' && Array.isArray(mod.inject) && typeof mod.apply === 'function')
check('声明了 tools/llm/web 依赖', ['tools', 'llm', 'web'].every(s => mod.inject.includes(s)), JSON.stringify(mod.inject))

// ── apply 不应抛异常 ──
try { mod.apply(mockCtx, { wikiRoot: ROOT }); check('apply(ctx) 执行成功', true) }
catch (e) { check('apply(ctx) 执行成功', false, e.message) }

// ── 工具 ──
const names = registered.map(t => t.name).sort()
check('注册了 5 个工具', registered.length === 5, names.join(', '))
check('工具名符合预期', JSON.stringify(names) === JSON.stringify(['wiki_acquire', 'wiki_commit', 'wiki_learn', 'wiki_recall', 'wiki_review']), names.join(', '))
check('每个工具都有 output 声明', registered.every(t => t.output && t.output.schema && typeof t.output.render === 'function'))
check('每个工具都有 execute', registered.every(t => typeof t.execute === 'function'))

// ── 钩子 ──
check('挂上 agent/pre-step', Array.isArray(handlers['agent/pre-step']) && handlers['agent/pre-step'].length === 1)
check('订阅 session/event（轮次边界的正确来源）', Array.isArray(handlers['session/event']) && handlers['session/event'].length === 1)
check('未订阅不存在的 turn/end live 事件', handlers['turn/end'] === undefined)

// 事件处理器必须能安全处理非 turn/end 事件（过滤正确、不抛异常）
try {
  handlers['session/event'][0]({ id: 'sess' }, { type: 'turn/start' })
  handlers['session/event'][0]({ id: 'sess' }, undefined)
  check('session/event 处理器过滤非 turn/end 且不抛', true)
} catch (e) {
  check('session/event 处理器过滤非 turn/end 且不抛', false, e.message)
}

// ── 系统提示词段 ──
check('贡献了 systemPrompt 段', sections.length === 1 && sections[0].name === 'app:dsh-learn-wiki', sections.map(s => s.name).join(','))
if (sections[0]) check('提示词段文本非空', typeof sections[0].text === 'function' && sections[0].text().length > 50)

// ── pre-step：命中应注入 ──
const preStep = handlers['agent/pre-step'][0]
const userMsg = { role: 'user', content: [{ type: 'text', text: 'Widget 协议的分帧和魔数是什么' }] }
const agent = {}
const decision = { kind: 'enter', messages: [userMsg] }
const res = await preStep({ agent, messages: [userMsg], step: 1, signal: { throwIfAborted() {} } }, async () => decision)

check('pre-step 返回 enter 决策', res && res.kind === 'enter')
check('命中时注入了 1 条消息', Array.isArray(res.messages) && res.messages.length === 2, 'len=' + (res.messages?.length ?? 'n/a'))
const injected = res.messages?.[1]
const injectedText = JSON.stringify(injected?.content ?? '')
check('注入内容引用了命中页 id', injectedText.includes('widget-protocol'), injectedText.slice(0, 160))
check('注入内容带 system-reminder 包裹', injectedText.includes('system-reminder'))
check('注入消息排在用户消息之后', res.messages?.[0] === userMsg)

// ── pre-step：非第一步不注入 ──
const res2 = await preStep({ agent: {}, messages: [userMsg], step: 2, signal: { throwIfAborted() {} } }, async () => ({ kind: 'enter', messages: [userMsg] }))
check('step !== 1 时不动消息', res2.messages.length === 1)

// ── pre-step：未命中应记 gap，且不注入 ──
const missMsg = { role: 'user', content: [{ type: 'text', text: 'kubernetes sidecar 注入与 istio 流量劫持怎么配' }] }
const res3 = await preStep({ agent: {}, messages: [missMsg], step: 1, signal: { throwIfAborted() {} } }, async () => ({ kind: 'enter', messages: [missMsg] }))
check('未命中时不注入', res3.messages.length === 1)
const { readGaps } = await import('../lib/acquire.js')
const gaps = await readGaps(ROOT)
check('未命中时记入 gap 队列', gaps.length === 1, JSON.stringify(gaps.map(g => ({ q: g.query.slice(0, 30), s: g.status }))))

// ── 工具输出必须是 lossless JSON ──
// 这是真踩过的坑：wiki_recall 在非 miss 分支返回了 `note: undefined`，
// 运行时报 "tool ... returned invalid output: value is not lossless JSON"，
// 整个工具不可用。所以对每个工具都做一次"JSON 往返必须等价"的检查。
const findBadValue = (v, path = '$') => {
  if (v === undefined) return path + ' = undefined'
  if (typeof v === 'function') return path + ' = function'
  if (v === null || typeof v !== 'object') return null
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) { const b = findBadValue(v[i], path + '[' + i + ']'); if (b) return b }
    return null
  }
  for (const [k, val] of Object.entries(v)) { const b = findBadValue(val, path + '.' + k); if (b) return b }
  return null
}
const byName = Object.fromEntries(registered.map(t => [t.name, t]))
const callTool = async (n, args) => {
  const def = byName[n]
  if (!def) return { label: n, ok: false, detail: '工具未注册' }
  try {
    const v = await def.execute(args, { signal: { throwIfAborted() {} } })
    const bad = findBadValue(v)
    const roundTrip = JSON.stringify(JSON.parse(JSON.stringify(v))) === JSON.stringify(v)
    return { label: n, ok: !bad && roundTrip, detail: bad ? '含非法值 ' + bad : (roundTrip ? '' : 'JSON 往返不等价') }
  } catch (e) { return { label: n, ok: false, detail: 'execute 抛异常: ' + e.message } }
}

console.log('\n=== 工具输出 lossless JSON ===')
// 关键用例：走 hit 分支（就是当初带 note:undefined 崩掉的那条路径）
for (const r of [
  await callTool('wiki_recall', { query: 'Widget 协议的分帧和魔数是什么' }),
  await callTool('wiki_recall', { query: '完全不相关的 kubernetes istio 问题' }),
  await callTool('wiki_review', {}),
  await callTool('wiki_learn', { title: '临时测试页', body: '内容', sources: 'https://e.com' }),
  await callTool('wiki_commit', { id: '根本不存在的页面' }),
  await callTool('wiki_acquire', { dryRun: true }),
]) {
  check('输出合法: ' + r.label, r.ok, r.detail)
}

await rm(ROOT, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS — 插件接线正确' : '\n' + failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
