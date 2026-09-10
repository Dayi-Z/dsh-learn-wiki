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
  on: (ev, h) => { (handlers[ev] ||= []).push(h); return () => {} },
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
check('注册了 4 个工具', registered.length === 4, names.join(', '))
check('工具名符合预期', JSON.stringify(names) === JSON.stringify(['wiki_commit', 'wiki_learn', 'wiki_recall', 'wiki_review']), names.join(', '))
check('每个工具都有 output 声明', registered.every(t => t.output && t.output.schema && typeof t.output.render === 'function'))
check('每个工具都有 execute', registered.every(t => typeof t.execute === 'function'))

// ── 钩子 ──
check('挂上 agent/pre-step', Array.isArray(handlers['agent/pre-step']) && handlers['agent/pre-step'].length === 1)
check('挂上 turn/end', Array.isArray(handlers['turn/end']) && handlers['turn/end'].length === 1)

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

await rm(ROOT, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS — 插件接线正确' : '\n' + failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
