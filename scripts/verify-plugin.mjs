// 插件接线集成测试：用一个 mock ctx 跑 apply()，验证工具注册、
// agent/pre-step 注入、miss→gap 记录、turn/end 钩子都真的挂上了。
// 目的：不必重启 DSH 就能抓出事件名拼错 / API 用错这类错误。
import { rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { ensureRepo } from '../lib/wiki.js'
import { DEFAULTS } from '../lib/config.js'

// 触发 edit-churn 需要的次数**从配置读**，不写死。
// 写死过一次：阈值从 4 调到 8 之后，下面所有造挣扎的循环都不够长了，
// 于是六条断言一起变红——而它们红的原因和被测逻辑毫无关系。
const CHURN = DEFAULTS.struggleEditChurn
const IDENTICAL = DEFAULTS.struggleRepeatIdentical

const ROOT = '.tmp-plugin-test'
let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

/**
 * 有界轮询等**真实条件**，而不是写死 sleep。
 *
 * 为什么必须换：这几处等的是 fire-and-forget 的异步路径（appendGap 不阻塞回调、
 * 补料 worker 在后台跑）。写死 300ms / 2500ms 单独跑够用，整套跑机器一忙就红，
 * 而且每次红的是不同断言——看着像逻辑坏了，其实只是等得不够久。
 * 轮询条件本身，所以不会掩盖真问题：真坏了会一直等到超时，然后如实报红。
 */
/**
 * 制造一次 edit-churn。
 *
 * **参数必须每次都不同**：真实编辑的 old_string 从来不一样，而如果这里传完全相同的
 * 参数，repeat-identical（阈值 5）会在第 5 次就命中，到 edit-churn 的阈值 8 时
 * 两条信号会**同时**触发——测的就不再是 edit-churn 这一条路径了。
 * 实测踩到：编辑链路的 suspect 断言因此在整套跑里时红时绿，查了半天才定位到这里。
 */
const churn = (observe, agent, file) => {
  for (let i = 0; i < CHURN; i++) {
    observe({ name: 'edit', arguments: { file_path: file, old_string: 'v' + i }, agent }, { isError: false })
  }
  // ★ 光"改得多"已经不再算卡住 —— edit-churn 现在要求窗口里有**失败证据**。
  //   理由（实测）：43 条挣扎记录里 35 条是 edit-churn，全部来自正常迭代
  //   （同一个 client.js 改了十几次、每次都跑通），产出的唯一一页还是错的。
  //   "反复修改"是努力，"反复修改并且撞墙"才是死胡同。
  //   这里补一次真实的命令失败 —— 形状照抄 DSH 的约定（非零退出写进结果正文），
  //   而不是自己编一个 isError：编出来的形状恰恰是原来漏检的那一半。
  observe({ name: 'pwsh', arguments: { command: 'npm test' }, agent }, {
    isError: false,
    content: [{ type: 'tool-result', content: [{ type: 'text', text: 'FAIL src/x.test.js\n[exit code: 1]' }], isError: false }],
  })
}

/**
 * 制造一次"撞同一堵墙"：同一错误签名反复出现。
 *
 * 这是**允许联网**的那一类信号 —— 它带着**错误文本**，而错误文本网上真的有人写过。
 * edit-churn 已不在联网白名单里：它的症状查询里只有一个**本地文件名**
 * （"反复修改 client.js 仍不成功"），这句话网上不存在，检索它最坏会撞上同名项目。
 * 实测它沉淀出过一页关于另一个 llm-wiki 包的内容，只因为都在改 client.js。
 */
const sameWall = (observe, agent, tag, msg) => {
  const RECUR = DEFAULTS.struggleRecurringError
  const error = msg ?? ('Error: ' + tag + '_FAILURE at src/x.js:12')
  for (let i = 0; i < RECUR; i++) {
    observe({ name: 'pwsh', arguments: { command: 'check ' + tag + ' ' + i }, agent }, { isError: true, error: { message: error } })
  }
}

async function waitFor(fn, ms = 20000, step = 100) {
  const dl = Date.now() + ms
  for (;;) {
    let v = null
    try { v = await fn() } catch { v = null }
    if (v || Date.now() >= dl) return v
    await new Promise(r => setTimeout(r, step))
  }
}

await rm(ROOT, { recursive: true, force: true })
await ensureRepo(ROOT)
// 测试里关掉补料的冷却与间隔，否则第二条挣扎会撞上 20s 冷却而不触发补料
await writeFile(join(ROOT, 'wiki.config.json'), JSON.stringify({
  acquireCooldownMs: 0,
  minIntervalMs: 0,
  maxAcquisitionsPerRun: 5,
  struggleCooldownMs: 0,
  // 测试里把观察期压到 1.2s，既能让场景 B 通过，也还能测出场景 C 的"太早"
  deliveryConfirmMinDwellMs: 1200,
}), 'utf8')

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
const registeredRoutes = []
const handlers = {}
const sections = []
const mockCtx = {
  tools: {
    register: (def) => { registered.push(def); return () => {} },
    // 能力包要读完整目录；补齐这个 mock，否则 find_tools 走的是空目录的降级路径
    schemas: () => ([
      { name: 'read', description: 'Read a file' },
      { name: 'workflow', description: 'Run a JavaScript workflow script that orchestrates subagents at scale' },
      { name: 'ralph', description: 'Run a foreground fresh-agent Ralph loop' },
      { name: 'hindsight_sync_status', description: 'Report memory bank sync state' },
      { name: 'hindsight_diagnose', description: 'Report runtime diagnostics' },
      { name: 'hindsight_search_knowledge_pages', description: 'Search knowledge pages' },
    ]),
  },
  llm: {
    listProviders: () => [{ id: 'mock' }],
    listModels: async () => [{ id: 'mock-model' }],
    // 让蒸馏器真的产出一页，才能测到"投递回当前轮"这条链路
    stream: async function* () {
      yield { type: 'text-delta', text: JSON.stringify({
        skip: false,
        id: 'widget-churn-fix',
        title: 'Widget 反复修改不生效的常见原因',
        category: 'lesson',
        confidence: 0.75,
        tags: ['widget'],
        body: 'Widget 的改动需要先清缓存再重建，否则旧产物会被继续加载。',
      }) }
    },
  },
  web: {
    search: async () => ({ content: 'c', sources: [{ url: 'https://e.com/doc', title: 'Doc', snippet: 'snippet text here' }] }),
    // 桩掉 fetch，避免测试真的走网络（fetchEvidence 会优先用 ctx.web.fetch）
    fetch: async () => ({ statusCode: 200, body: { kind: 'text', content: 'y'.repeat(400) } }),
  },
  // UI 数据接口需要它；缺了会让整个 apply 抛异常（整轮挂掉）
  webServer: { register: (r) => { registeredRoutes.push(r); return () => {} } },
  // 只接受真实存在的 live 事件名。此前的 mock 对任何名字都照单全收，
  // 于是 ctx.on('turn/end', ...) 这种永不触发的订阅也能"通过"测试——
  // 结果整个补料路径在生产里是死的。mock 必须能证伪。
  on: (ev, h) => {
    const KNOWN = ['agent/pre-step', 'session/event', 'agent/created', 'agent/disposed', 'tools/result', 'tools/post-execute']
    if (!KNOWN.includes(ev)) throw new Error('mock: 未知 live 事件名 "' + ev + '"（订阅它永远收不到通知）')
    ;(handlers[ev] ||= []).push(h)
    return () => {}
  },
  effect: (fn) => fn(),
  inject: (services, cb) => { cb({ systemPrompt: { section: (s) => { sections.push(s); return () => {} } } }) },
}

const mod = await import('../index.js')
check('导出 name / inject / apply', mod.name === 'dsh-learn-wiki' && Array.isArray(mod.inject) && typeof mod.apply === 'function')
check('声明了 tools/llm/web/webServer 依赖',
  ['tools', 'llm', 'web', 'webServer'].every(s => mod.inject.includes(s)), JSON.stringify(mod.inject))

// ── apply 不应抛异常 ──
try { mod.apply(mockCtx, { wikiRoot: ROOT }); check('apply(ctx) 执行成功', true) }
catch (e) { check('apply(ctx) 执行成功', false, e.message) }

// ── 工具 ──
// 精确相等是**故意**的：它同时卡住"少注册一个"（工具静默消失，模型忽然
// 没有这个能力）和"多注册一个"（没想清楚就加工具，每个请求都多付 token）。
// 代价是加工具时必须来这里改一次 —— 那正是我们希望被提醒的时刻。
const names = registered.map(t => t.name).sort()
check('注册了 11 个工具', registered.length === 11, names.join(', '))
check('工具名符合预期', JSON.stringify(names) === JSON.stringify(['find_tools', 'wiki_acquire', 'wiki_commit', 'wiki_harvest', 'wiki_learn', 'wiki_lint', 'wiki_merge', 'wiki_recall', 'wiki_review', 'wiki_sessions', 'wiki_struggle']), names.join(', '))
check('每个工具都有 output 声明', registered.every(t => t.output && t.output.schema && typeof t.output.render === 'function'))
check('每个工具都有 execute', registered.every(t => typeof t.execute === 'function'))

// ── 钩子 ──
check('挂上 agent/pre-step', Array.isArray(handlers['agent/pre-step']) && handlers['agent/pre-step'].length === 1)
check('订阅 session/event（轮次边界的正确来源）', Array.isArray(handlers['session/event']) && handlers['session/event'].length === 1)
check('订阅 tools/result（挣扎检测）', Array.isArray(handlers['tools/result']) && handlers['tools/result'].length === 1)
check('订阅 agent/created（能力包装配）', Array.isArray(handlers['agent/created']) && handlers['agent/created'].length === 1)
// 匹配规则照抄宿主（dsh-host-webserver/lib/index.js:199）。
// 尾斜杠写错时 kind/path 看着都对，但永远匹配不上，而症状是 HTTP 200 + index.html。
const matchesPrefix = (prefix, pathname) => pathname === prefix || pathname.startsWith(prefix + '/')
const uiRoute = registeredRoutes.find(r => r.kind === 'prefix')
check('★ 注册了 UI 数据路由（prefix，覆盖全部四条 api 路径）',
  !!uiRoute && ['/learn-wiki/api/state', '/learn-wiki/api/page', '/learn-wiki/api/commit', '/learn-wiki/api/capabilities']
    .every(p => matchesPrefix(uiRoute.path, p)),
  JSON.stringify(registeredRoutes.map(r => r.kind + ':' + r.path)))

// 能力包必须真的能对 agent 装配掩码
if (handlers['agent/created']?.[0]) {
  const restrictCalls = []
  const agent = { ctx: { tools: { restrict: (f) => { restrictCalls.push(f); return () => {} } } } }
  try { handlers['agent/created'][0]({ agent }) } catch (e) { check('agent/created 钩子不抛', false, e.message) }
  check('能力包对 agent 装配了 deny 掩码', restrictCalls.length === 1, JSON.stringify(restrictCalls))
  const d0 = restrictCalls[0]?.deny ?? []
  check('默认裁掉 workflow 与 ralph', d0.includes('workflow') && d0.includes('ralph'), JSON.stringify(d0))

  // 记忆族：只裁诊断工具，工作用工具必须保留
  const restrictCalls2 = []
  const agent2 = { ctx: { tools: { restrict: (f) => { restrictCalls2.push(f); return () => {} } } } }
  handlers['agent/created'][0]({ agent: agent2 })
  const denied = restrictCalls2[0]?.deny ?? []
  check('记忆族诊断工具被裁', denied.includes('hindsight_sync_status') && denied.includes('hindsight_diagnose'), JSON.stringify(denied))
  check('记忆族工作用工具保留', !denied.includes('hindsight_search_knowledge_pages'), JSON.stringify(denied))
}

// 挣扎检测必须真的能从工具流里认出一堵墙
if (handlers['tools/result']?.[0]) {
  const obs = handlers['tools/result'][0]
  const ag = {}
  const toolExec = { name: 'read', arguments: { file_path: 'x' }, agent: ag }
  for (let i = 0; i < IDENTICAL; i++) obs(toolExec, { isError: false })
  const { readStruggles } = await import('../lib/struggle.js')
  const recs = await readStruggles(ROOT)
  check('连续相同调用被记录进 struggle.jsonl', recs.length >= 1, 'records=' + recs.length)
  check('记录里含 repeat-identical', recs.some(r => (r.signals ?? []).some(s => s.type === 'repeat-identical')),
    JSON.stringify(recs.slice(-1).map(r => (r.signals ?? []).map(s => s.type))))

  // ★ 触发器换向：挣扎信号必须**自动登记一条症状 gap**
  // 这是整个改造的核心 —— 从"检索未命中"换成"卡住了"。
  //
  // ★ 2026-09-11 整改：**edit-churn 不再登记 gap**。
  //   它的症状查询里只有一个本地文件名（"反复修改 client.js 仍不成功"），
  //   这句话网上不存在；检索它最坏的结果是撞上同名项目 —— 实测它沉淀出过
  //   一页关于**另一个叫 llm-wiki 的 npm 包**的内容，只因为都在改 client.js。
  //   允许联网的信号现在由 cfg.gapTriggerSignals 决定，只留带**错误文本**的那些。
  const { readGaps } = await import('../lib/acquire.js')
  const { drainLocks } = await import('../lib/lock.js')
  const baseGaps = (await readGaps(ROOT)).length

  // 先证明第一半：改得多、但没撞同一堵墙 → 不登记 gap。
  const ag2 = {}
  churn(obs, ag2, 'D:/x/widget.js')
  // drainLocks 比 sleep 轮询可靠：appendGap 的锁在 fire-and-forget 调用里
  // **同步**登记的，所以把它排空之后，写盘一定已完成。
  await drainLocks()
  const afterChurn = await readGaps(ROOT)
  check('★ edit-churn 不再登记 gap（它带的只是本地文件名，网上没有这句话）',
    afterChurn.length === baseGaps, 'before=' + baseGaps + ' after=' + afterChurn.length)

  // 再证明第二半：撞同一堵墙（recurring-error，带着错误文本）→ 登记。
  const ag3 = {}
  sameWall(obs, ag3, 'WIDGET', 'Error: WIDGET_OVERFLOW at src/widget.js:12')
  await drainLocks()
  const afterGaps = await readGaps(ROOT)
  check('★ 撞同一堵墙 → 自动登记了 gap', afterGaps.length > baseGaps, 'before=' + baseGaps + ' after=' + afterGaps.length)
  const widgetGap = afterGaps.find(g => String(g.query).includes('WIDGET_OVERFLOW'))
  check('★ 登记的是症状查询（带错误文本，可搜）而非用户原话',
    !!widgetGap && !/ok|好的|继续/.test(String(widgetGap.query)),
    JSON.stringify(String(widgetGap?.query ?? '')))
}
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

// ── ★ 端到端：挣扎 → 症状 gap → 补料 → 投递回**当前这一轮** ──
// 放在最前面跑：后面的 wiki_acquire 测试会直接消费 gap（不走投递路径），
// 先跑才能隔离出投递这条链路的真实行为。
// 这是最初那句诉求的落点："agent 反复修改走进死胡同，永远不会去网上搜一下"。
if (handlers['tools/result']?.[0]) {
  const injected = []
  const agD = {
    id: 'sess-deliver',
    inject: (msg) => { injected.push(msg); return 'msg-id' },
    ctx: { tools: { restrict: () => () => {} } },
  }
  const um = { role: 'user', content: [{ type: 'text', text: 'Gadget 改动后不生效，帮我看看' }] }
  await preStep({ agent: agD, messages: [um], step: 1, signal: { throwIfAborted() {} } }, async () => ({ kind: 'enter', messages: [um] }))
  // 用"撞同一堵墙"而不是 edit-churn 驱动：后者已经不再登记 gap，
  // 用它驱动这条链路会让测试静默地什么都没测到（投递永远不发生）。
  sameWall(handlers['tools/result'][0], agD, 'GADGET', 'Error: GADGET_CHURN at D:/x/gadget.js:12')
  // 等的是后台补料 worker，真异步。整套跑时机器负载高，10 秒上限会偶发撞线。
// 放宽到 40 秒：放宽的是耐心不是断言。
const dl = Date.now() + 40000
while (Date.now() < dl && injected.length === 0) await new Promise(r => setTimeout(r, 250))

  if (injected.length === 0) {
    // 失败必须能自证。光说"没投递"等于让下一个人重跑一遍才知道卡在哪一环。
    try {
      // ★ 这里**不能**用裸 readGaps：本文件下面（顶层）还有一个
      //   const { readGaps } = await import(...)，它在模块作用域里遮蔽了这一处，
      //   于是诊断代码本身抛 "Cannot access 'readGaps' before initialization" ——
      //   而诊断只在**断言已经失败之后**才跑，所以这个 bug 平时永远看不见，
      //   真出事时却把"没有投递"换成一个看不懂的 TDZ 报错（实测踩到）。
      //   直接 inline import，绕开作用域。
      const q = await (await import('../lib/acquire.js')).readGaps(ROOT)
      const last = q.slice(-3).map(g => ({ s: g.status, q: String(g.query).slice(0, 60) }))
      console.log('    诊断：等了 40s 仍无投递。gap 总数=' + q.length + ' 最近=' + JSON.stringify(last))
      const { readStruggles: rs } = await import('../lib/struggle.js')
      const st = await rs(ROOT, 50)
      console.log('    诊断：挣扎记录 ' + st.length + ' 条，最近=' + JSON.stringify(st.slice(-3).map(r => (r.signals || []).map(s => s.type))))
    } catch (e) { console.log('    诊断：读 gap 队列也失败了 — ' + e.message) }
  }
  check('★ 补料完成后投递回当前轮（agent.inject 被调用）', injected.length >= 1, 'injected=' + injected.length)
  const msgText = JSON.stringify(injected[0]?.content ?? '')
  check('★ 投递内容含找到的知识', msgText.includes('widget-churn-fix') || msgText.includes('Widget 反复修改'), msgText.slice(0, 160))
  check('★ 投递内容明确标注未核实', msgText.includes('未核实'), msgText.slice(0, 120))
  check('★ 投递用 system-reminder 包裹', msgText.includes('system-reminder'))
}
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

// ── pre-step：hindsight 注入块必须被压成短指针 ──
const bigBlock = '<hindsight_knowledge>This repository has a Hindsight memory and knowledge base. '
  + 'The tools below are registered, but you must actually CALL them at the right moments: ' + 'x'.repeat(1800) + '</hindsight_knowledge>'
const hsMsg = { role: 'user', content: [{ type: 'text', text: bigBlock }], source: { kind: 'plugin', plugin: 'hindsight-coding-agents' } }
// 标为 step 2 以避免把这段合成文本写成 gap（污染共享队列）
const resHs = await preStep({ agent: {}, messages: [hsMsg], step: 2, signal: { throwIfAborted() {} } }, async () => ({ kind: 'enter', messages: [hsMsg] }))
const hsText = JSON.stringify(resHs.messages?.[0]?.content ?? '')
check('hindsight 块被压缩', hsText.length < 600, 'len=' + hsText.length + ' (原始 ' + bigBlock.length + ')')
check('压缩后仍保留检索时机提示', hsText.includes('hindsight_search_knowledge_pages'))

// ── pre-step：非第一步不注入 ──
const res2 = await preStep({ agent: {}, messages: [userMsg], step: 2, signal: { throwIfAborted() {} } }, async () => ({ kind: 'enter', messages: [userMsg] }))
check('step !== 1 时不动消息', res2.messages.length === 1)

// ── pre-step：未命中应记 gap，且不注入 ──
const missMsg = { role: 'user', content: [{ type: 'text', text: 'kubernetes sidecar 注入与 istio 流量劫持怎么配' }] }
const res3 = await preStep({ agent: {}, messages: [missMsg], step: 1, signal: { throwIfAborted() {} } }, async () => ({ kind: 'enter', messages: [missMsg] }))
check('未命中时不注入', res3.messages.length === 1)
const { readGaps } = await import('../lib/acquire.js')
const gaps = await readGaps(ROOT)
// ★ 触发器已换成 'struggle'：检索未命中**不再**记 gap。
// 实测 19 条 miss-gap 全是用户对话原话，零真缺口 —— 噪声率 100%。
check('★ 未命中不再记 gap（触发器已换成 struggle）',
  !gaps.some(g => String(g.query).includes('kubernetes')), JSON.stringify(gaps.map(g => String(g.query).slice(0, 34))))

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
  // 必须测非 dryRun 路径：details 的 page 字段只在 staged 时存在，
  // 之前只测 dryRun，让它带着 undefined 溜了过去。
  await callTool('wiki_acquire', { limit: 1 }),
  await callTool('wiki_struggle', { limit: 5 }),
  await callTool('wiki_struggle', { type: 'repeat-failure' }),
  await callTool('find_tools', { query: 'workflow' }),
  await callTool('find_tools', { query: 'zzz-nothing' }),
  await callTool('wiki_learn', { title: '临时', body: 'x', sources: 'https://e.com' }),
]) {
  check('输出合法: ' + r.label, r.ok, r.detail)
}

// ── ★ 证据链的完整闭环：同一个 agent 先被注入命中，然后仍然挣扎 ──
// 这是"疑似有害知识"的唯一采集路径，必须端到端验证。
// （前面的注入测试用的是无 id 的 agent，凑不出这条链路。）
if (handlers['tools/result']?.[0]) {
  const agS = { id: 'sess-suspect', ctx: { tools: { restrict: () => () => {} } } }
  const wm = { role: 'user', content: [{ type: 'text', text: 'Widget 协议的分帧和魔数是什么' }] }
  const r1 = await preStep({ agent: agS, messages: [wm], step: 1, signal: { throwIfAborted() {} } }, async () => ({ kind: 'enter', messages: [wm] }))
  check('★ 同轮先发生了一次命中注入', r1.messages.length === 2, 'len=' + r1.messages.length)
  churn(handlers['tools/result'][0], agS, 'D:/x/widget.js')
  await new Promise(r => setTimeout(r, 600))
}

// ROOT 在本文件是常量，这里只是给它一个好读的别名
const ROOT_REF = () => ROOT
const { loadUsage: loadUsageHere } = await import('../lib/usage.js')
const loadUsage = loadUsageHere

// ── ★ 投递路径的证据追踪 ──
// 投递发生在挣扎**之后**，所以要观察"投递之后有没有新的挣扎"。
// 这一段专门验证这条时序，因为它最容易被写成错误归因。
if (handlers['tools/result']?.[0] && handlers['session/event']?.[0]) {
  const obs = handlers['tools/result'][0]

  // 场景 A：投递后**仍然**挣扎 -> 那条补料没帮上忙
  const agA = { id: 'sess-deliver-a', inject: () => 'id', ctx: { tools: { restrict: () => () => {} } } }
  const mq = { role: 'user', content: [{ type: 'text', text: 'Alpha 改动不生效' }] }
  await preStep({ agent: agA, messages: [mq], step: 1, signal: { throwIfAborted() {} } }, async () => ({ kind: 'enter', messages: [mq] }))
  // 先取基线再挣扎：命中计数是**按页**的全局值，不能只看 "> 0"。
  const hitsBefore = (await loadUsage(ROOT_REF())).pages['widget-churn-fix']?.hits ?? 0
  sameWall(obs, agA, 'ALPHA')
  const ua1 = await waitFor(async () => {
    const u = await loadUsage(ROOT_REF())
    return (u.pages['widget-churn-fix']?.hits ?? 0) > hitsBefore ? u : null
  }, 20000)
  check('★ 投递被记成 hits', (ua1?.pages['widget-churn-fix']?.hits ?? 0) > hitsBefore, JSON.stringify(ua1?.pages['widget-churn-fix']))
  // 投递之后再挣扎一次
  sameWall(obs, agA, 'BETA')
  const ua2 = await waitFor(async () => {
    const u = await loadUsage(ROOT_REF())
    return (u.pages['widget-churn-fix']?.suspect ?? 0) > 0 ? u : null
  }, 20000)
  check('★ 投递后仍挣扎 -> 记嫌疑（这条补料没帮上忙）',
    (ua2?.pages['widget-churn-fix']?.suspect ?? 0) > 0,
    JSON.stringify(ua2?.pages))

  // 场景 B：投递后没再挣扎，轮次结束 -> 弱确认
  const agB = { id: 'sess-deliver-b', inject: () => 'id', ctx: { tools: { restrict: () => () => {} } } }
  const mq2 = { role: 'user', content: [{ type: 'text', text: 'Gamma 改动不生效' }] }
  await preStep({ agent: agB, messages: [mq2], step: 1, signal: { throwIfAborted() {} } }, async () => ({ kind: 'enter', messages: [mq2] }))
  const hitsBeforeB = (await loadUsage(ROOT_REF())).pages['widget-churn-fix']?.hits ?? 0
  sameWall(obs, agB, 'GAMMA')
  // 等**这一次**投递落地，而不是"命中数 > 0"（那可能来自上一个 agent）。
  await waitFor(async () => ((await loadUsage(ROOT_REF())).pages['widget-churn-fix']?.hits ?? 0) > hitsBeforeB ? true : null, 20000)
  const beforeB = (await loadUsage(ROOT_REF())).pages['widget-churn-fix']?.confirmed ?? 0
  handlers['session/event'][0]({ id: 'sess' }, { type: 'turn/end' })
  const ub2 = await waitFor(async () => {
    const u = await loadUsage(ROOT_REF())
    return (u.pages['widget-churn-fix']?.confirmed ?? 0) > beforeB ? u : null
  }, 15000)
  check('★ 投递后无新挣扎 -> 轮次结束记确认',
    (ub2.pages['widget-churn-fix']?.confirmed ?? 0) > beforeB,
    'before=' + beforeB + ' after=' + (ub2.pages['widget-churn-fix']?.confirmed ?? 0))

  // 场景 C：投递后**立刻**结束轮次 -> 什么都不记
  // 模型根本没机会用它，此时记确认是假阳性，会抬高一条从未被检验过的知识。
  const agC = { id: 'sess-deliver-c', inject: () => 'id', ctx: { tools: { restrict: () => () => {} } } }
  const mq3 = { role: 'user', content: [{ type: 'text', text: 'Delta 改动不生效' }] }
  await preStep({ agent: agC, messages: [mq3], step: 1, signal: { throwIfAborted() {} } }, async () => ({ kind: 'enter', messages: [mq3] }))
  sameWall(obs, agC, 'DELTA')
  // 等投递完成。这一处无法轮询出一个明确条件（紧接着就要把观察期调到极大），
  // 所以给足余量——整套跑时机器负载高，2.5 秒会偶发不够。
  await new Promise(r => setTimeout(r, 8000))
  // 关键：把观察期调大，让"刚投递就结束轮次"成为确定性的场景。
  // 否则等补料的那 2.5 秒本身就可能超过观察期，测试前提不成立（实测踩到）。
  await writeFile(join(ROOT, 'wiki.config.json'), JSON.stringify({
    acquireCooldownMs: 0, minIntervalMs: 0, maxAcquisitionsPerRun: 5, struggleCooldownMs: 0,
    deliveryConfirmMinDwellMs: 600000,
  }), 'utf8')
  // liveCfg 只在 pre-step / 补料时刷新，所以要触发一次读取才能让新配置生效
  const rq = { role: 'user', content: [{ type: 'text', text: 'Delta 再看一次' }] }
  await preStep({ agent: agC, messages: [rq], step: 1, signal: { throwIfAborted() {} } }, async () => ({ kind: 'enter', messages: [rq] }))
  const uc1 = await loadUsage(ROOT_REF())
  const beforeC = uc1.pages['widget-churn-fix']?.confirmed ?? 0
  handlers['session/event'][0]({ id: 'sess' }, { type: 'turn/end' })   // 观察期远未满足
  await new Promise(r => setTimeout(r, 500))
  const uc2 = await loadUsage(ROOT_REF())
  check('★ 投递后观察期不足 -> 不记确认（宁可少记，不要记错）',
    (uc2.pages['widget-churn-fix']?.confirmed ?? 0) === beforeC,
    'before=' + beforeC + ' after=' + (uc2.pages['widget-churn-fix']?.confirmed ?? 0))
}

// ── ★ 证据链：注入记 hits；命中后仍挣扎记 suspect ──
// 这张图是"要不要自动沉淀"的唯一依据，所以必须端到端验证它真的在采。
// 注意：必须在 rm(ROOT) **之前** —— 目录一删就读不到了。
{
  const { loadUsage } = await import('../lib/usage.js')
  const u = await loadUsage(ROOT)
  const ids = Object.keys(u.pages ?? {})
  check('★ 使用证据已落盘（usage.json）', ids.length > 0, 'pages=' + ids.length)
  const withHits = ids.filter(id => (u.pages[id].hits ?? 0) > 0)
  check('★ 注入被记成 hits', withHits.length > 0, JSON.stringify(withHits.map(id => id + ':hits=' + u.pages[id].hits)))
  const withSuspect = ids.filter(id => (u.pages[id].suspect ?? 0) > 0)
  check('★ 命中后仍挣扎被记成 suspect（最关键的一类证据）', withSuspect.length > 0,
    JSON.stringify(withSuspect.map(id => id + ':suspect=' + u.pages[id].suspect)))

  // ── ★ weak 桶不算证据 ──
  // 实测教训：第一次真实触发时，一条走 weak 桶注入的页（我们明确标注了
  // "弱相关，不要直接采信"）因为后续挣扎被判成"疑似有害" —— 那是错误归因。
  // 模型被告知别信它，它就不该为后续失败负责。
  // 这里把阈值抬高，让同一条查询落进 weak 桶，再复现一次挣扎，断言不产生证据。
  const cfgPath = join(ROOT, 'wiki.config.json')
  await writeFile(cfgPath, JSON.stringify({
    acquireCooldownMs: 0, minIntervalMs: 0, maxAcquisitionsPerRun: 5, struggleCooldownMs: 0,
    hitThreshold: 0.99, weakThreshold: 0.01,   // 什么都进 weak
  }), 'utf8')
  // 记下**增量基线** —— 这条页在前面的 hit 桶测试里已经记过一次嫌疑了，
  // 断言累计值会误判，必须断言"这次没有新增"。
  const beforeW = (await loadUsage(ROOT)).pages['widget-protocol']?.suspect ?? 0
  const agW = { id: 'sess-weak', ctx: { tools: { restrict: () => () => {} } } }
  const wq = { role: 'user', content: [{ type: 'text', text: 'Widget 协议的分帧和魔数是什么' }] }
  const rw = await preStep({ agent: agW, messages: [wq], step: 1, signal: { throwIfAborted() {} } }, async () => ({ kind: 'enter', messages: [wq] }))
  const injectedWeak = rw.messages.length === 2
  churn(handlers['tools/result'][0], agW, 'D:/x/weak.js')
  await new Promise(r => setTimeout(r, 600))
  const u2 = await loadUsage(ROOT)
  const wp = u2.pages['widget-protocol']
  check('★ weak 桶确实注入了', injectedWeak, 'len=' + rw.messages.length)
  const afterW = wp?.suspect ?? 0
  check('★ weak 桶注入后仍挣扎 -> suspect 不增加（避免错误归因）', afterW === beforeW,
    'before=' + beforeW + ' after=' + afterW + '  ' + JSON.stringify(wp))
  check('★ weak 桶仍计入 hits（liveness 两个桶都算）', (wp?.hits ?? 0) > 0, 'hits=' + wp?.hits)
  // 恢复配置，避免影响后续断言
  await writeFile(cfgPath, JSON.stringify({ acquireCooldownMs: 0, minIntervalMs: 0, maxAcquisitionsPerRun: 5, struggleCooldownMs: 0 }), 'utf8')
}

await rm(ROOT, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS — 插件接线正确' : '\n' + failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
