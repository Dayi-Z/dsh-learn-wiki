// 会话提炼（/learn 的等价物）自检。
//
// 三条最要紧的性质：
//   1. **注入物不是人说的话**。会话里混着我们自己塞进去的东西（知识注入块、
//      技能目录、子代理回执）。把它们当成人说的话提炼，就是把自己的输出再学
//      一遍 —— 一个自我强化的回音室，而且越跑越偏。
//   2. **草稿不是结论**。assistant 消息里的 reasoning 段不能进提炼源。
//   3. **无源不沉淀**。每条都要带会话锚点，否则将来 commit 时会被闸门挡住，
//      而那时候已经没人记得它是从哪来的了。
import { rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureRepo } from '../lib/wiki.js'
import { extractSessionText, runHarvest, buildHarvestPrompt, HARVEST_SYSTEM } from '../lib/harvest.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

// ── 真实事件形状（解出真实会话确认过）──
//
// ★ 形状**不许再自己编**。下面每个事件都带全真信封里的五个字段
//   （type / seq / time / data / surfaceOp）。少写几个字段的"大概就是这个形状"，
//   正是上一轮把这个功能埋掉的做法。
const AT = 1789578600000
const ev = (type, seq, data) => ({ type, seq, time: AT + seq, data, surfaceOp: 'append' })
// ★ `id` 不是可有可无的装饰：真 Session 类会**拒绝**没有 id 的消息
//   （"lacks an identified message"）。旧夹具把它省了，于是夹具「看起来对」，
//   直到拿真类一对质才发现它连装都装不进去 —— 又一个"夹具照抄假设"的实例。
const userMsg = (text, kind = 'user', seq = 0) => ev('user/message', seq, { role: 'user', id: 'm-user-' + kind + '-' + seq, source: { kind }, content: [{ type: 'text', text }] })
// 真 Session 类还要求助手消息带 `source.kind === 'model'` 且给得出 provider/model
// （"message has invalid source" / "must have model source"）。这些字段对取材本身
// 毫无影响 —— 它们**只是**为了让夹具真的能装进真类里。可见"大概形状"是不够的。
// 还要 `stream` 是数组（结算字段校验）—— 真事件里它是那条流式记录。
const asstMsg = (parts, seq = 1) => ev('assistant/message', seq, {
  turn: 1, step: 1,
  message: { role: 'assistant', id: 'm-asst-' + seq, source: { kind: 'model', provider: 'mock', model: 'mock-model' }, content: parts },
  stream: [],
})
const text = (t) => ({ type: 'text', text: t })
const reasoning = (t) => ({ type: 'reasoning', text: t })
const toolCall = (n) => ({ type: 'tool-call', name: n, arguments: {} })

/**
 * 造一个**与宿主同形**的会话对象。
 *
 * ★ 这里原来写的是 `{ events }` —— 复述的是**代码的假设**，不是宿主的形状。
 *   于是 17 条自检全绿，而功能在真宿主里恒为 0 字符（2026-09-17 查实：
 *   宿主的 `export class Session` 只有 snapshotEvents() / ownEvents() /
 *   eventAt()，`'events' in session` 为 false）。
 *   **夹具照抄代码的假设，测试就只是把那个假设又念了一遍。**
 *   所以现在严格按宿主的类声明来造，并且**刻意不给 events 属性**。
 */
const sessionOf = (evs, id = 'sess-1') => ({
  header: { id, version: 3, cwd: 'D:\\Harness', isSeeded: false, delegationDepth: 0 },
  get id() { return id },
  get seq() { return evs.length },
  snapshotEvents: () => evs,
  ownEvents: () => evs,
  eventAt: (s) => evs[s],
})
const agentOf = (evs, id = 'sess-1') => ({ id, session: sessionOf(evs, id) })

// ★ 夹具要够长。runHarvest 有"会话太短就拒绝"的下限（200 字符）——
//   第一版夹具只写了 100 字符，于是后面六条断言一起红，而它们红的原因
//   和被测逻辑毫无关系。**夹具的规模也是测试的一部分。**
const events = [
  userMsg('第一个问题：为什么我点这个方框，行会跑到别的位置去？我连着点两下就总是点错，第二下点到的已经不是我想点的那一行了。'),
  asstMsg([
    reasoning('让我先想想……这段是草稿，不该被当成结论。真实会话里 reasoning 往往比正文长得多，但它不是结论。'),
    text('因为排序键里含了由勾选状态决定的字段。你把"已裁掉的"排到最前面，于是点一下方框，这一行就从指针底下消失了——顺序一旦随交互变化，连续操作就断了。修法是让排序只用不随交互变化的字段：族和名字。'),
    toolCall('read'),
  ]),
  userMsg('<system-reminder>这是我们自己的知识注入块，里面还带着一个 session:// 锚点，绝不能被当成人说的话。</system-reminder>', 'plugin'),
  userMsg('这是技能目录，同样是我们自己塞进去的，也不能当成人说的话。', 'skill-catalog'),
  userMsg('子代理报告：已完成，改了三个文件。', 'subagent-settled'),
  userMsg('第二个问题：那知识页签为什么会变？我展开一行读正文，过一会儿它自己换位置了。这两个是不是同一个毛病？'),
  asstMsg([text('是同一个毛病。知识页签原来按"需关注度"排——隔离 > 有嫌疑 > 未确认 > 其余，而这四档全部由证据决定，证据每 8 秒轮询刷新一次。所以结论是一条通则：位置不能表达状态。要强调"哪些需要我看"，应该用筛选器，而不是把行搬走。')]),
]
// seq 必须从 0 起连续（真 Session 的种子校验会较真），所以统一重排一遍。
for (const [i, e] of events.entries()) { e.seq = i; e.time = AT + i }

console.log('=== 会话抽取 ===')
const ex = extractSessionText(agentOf(events), {})
check('抽出了内容', ex.text.length > 0, ex.chars + ' 字符 / ' + ex.turns + ' 轮')
check('★ 只取 source.kind=user 的消息（注入块不算人说的话）',
  ex.text.includes('第一个问题') && !ex.text.includes('知识注入块') && !ex.text.includes('技能目录') && !ex.text.includes('子代理报告'))
check('★ 不取 reasoning 段（草稿不是结论）', !ex.text.includes('这段是草稿'))
check('取到了助手的 text 段', ex.text.includes('排序键里含了由勾选状态决定的字段'))
check('带会话锚点（无源不沉淀）', ex.sessionRef === 'session://sess-1', ex.sessionRef)
check('按时间正序（先问先出现）', ex.text.indexOf('第一个问题') < ex.text.indexOf('第二个问题'))

const exFew = extractSessionText(agentOf(events, 's'), { maxTurns: 1 })
check('maxTurns 只留最近的一轮', exFew.turns === 1 && exFew.text.includes('第二个问题') && !exFew.text.includes('第一个问题'))
const exSmall = extractSessionText(agentOf(events, 's'), { maxChars: 60 })
check('maxChars 截到最近的内容并标注截断', exSmall.truncated === true && exSmall.chars <= 200, 'chars=' + exSmall.chars)
check('没有会话时不抛异常', extractSessionText({}, {}).text === '' && extractSessionText(null, {}).text === '')

console.log('')
console.log('=== extractJson（模型输出污染与截断）===')
const { extractJson } = await import('../lib/llm.js')
const answer = {"skip":false,"items":[{"title":"位置不能表达状态","category":"lesson","confidence":0.8,"tags":[],"sources":[],"body":"排序键含交互相关字段会导致行从指针下消失。"}]}
const answerStr = JSON.stringify(answer)

check('普通干净的 JSON 直接抠出', JSON.stringify(extractJson(answerStr)) === answerStr)
check('前后废话挡不住', JSON.stringify(extractJson('好的，这是结果：' + answerStr + '（完毕）')) === answerStr)

const thinking = "Here's a thinking process:\n\n1.  **Analyze User Request:**  需要从这个对话里提炼出值得长期保留的知识，最多 2 条。\n\n我需要按这样的形状输出：{\"skip\": false, \"items\": [{\"title\": \"...\"}]}。\n\n让我分析各个要点……\n\n{\"skip\":false,\"items\":[{\"title\":\"位置不能表达状态\",\"category\":\"lesson\",\"confidence\":0.8,\"tags\":[],\"sources\":[],\"body\":\"排序键含交互相关字段会导致行从指针下消失。\"}]}"
const gotThinking = extractJson(thinking)
check('★ 思考过程开头（含示例 {…} 散文）也能抠出最后的答案', JSON.stringify(gotThinking) === answerStr, JSON.stringify(gotThinking).slice(0, 80))

const fenced = "```json\n{\"skip\":false,\"items\":[{\"title\":\"位置不能表达状态\",\"category\":\"lesson\",\"confidence\":0.8,\"tags\":[],\"sources\":[],\"body\":\"排序键含交互相关字段会导致行从指针下消失。\"}]}\n```"
check('★ ```json 围栏块抠出（旧正则是坏的，等于永远抠不出）', JSON.stringify(extractJson(fenced)) === answerStr)

// 截断：末尾缺了配平 —— 不应误吞思考里的示例对象
// ★ harvest 的契约（skip 布尔 + skip:true 带 reason / skip:false 带 items）。
const okShape = (v) => typeof v?.skip === 'boolean'
  && (v.skip === true ? typeof v.reason === 'string' : Array.isArray(v.items))
const truncated = "Here's a thinking process: 我要按 {\"skip\": true} 这种形状来。\n最终输出：{\"skip\": false, \"items\": [{\"title\": \"位置\""
check('★ 截断（没有完整对象）+ 契约过滤 → null，思考里的示例 {\"skip\":true} 不合契约（缺 reason）',
  extractJson(truncated, okShape) === null, JSON.stringify(extractJson(truncated, okShape)))

// 思考里带**完整可解析**的示例对象，答案在后面 —— 契约过滤也必须选答案而不是示例。
// （示例 {\"skip\": true} 完整可解析；旧规则会因"闭合最靠后"选中它 —— 错。）
const polluted = "我需要按这样的形状输出：{\"skip\": true, \"reason\": \"这只是一个形状示例\"}。\n现在给出真正的结果：\n" + answerStr
const gotPolluted = extractJson(polluted, okShape)
check('★ 思考里带完整示例对象时，契约过滤选中答案而不是示例',
  JSON.stringify(gotPolluted) === answerStr, JSON.stringify(gotPolluted).slice(0, 90))

check('纯散文无 JSON 返回 null', extractJson('完全没有任何结构的内容') === null)
check('空输入返回 null', extractJson('') === null)

console.log('')
console.log('=== 提示词 ===')
const p = buildHarvestPrompt({ transcript: 'X', focus: '只看设计规则', maxItems: 2 })
check('提示词带 focus', p.includes('只看设计规则'))
// STRICT JSON 在 system 里，不在 user prompt 里 —— 第一版断言查错了地方。
check('提示词给出 JSON 形状并允许拒绝', p.includes('"skip": true') && p.includes('"items"'))
check('★ system 要求严格 JSON 且明确要求可溯源（不许编造来源）',
  /STRICT JSON/.test(HARVEST_SYSTEM) && /Do not invent/.test(HARVEST_SYSTEM))
check('★ system 明确排除"这次做了什么"（那是历史不是知识）', /that is history, not knowledge/.test(HARVEST_SYSTEM))

console.log('')
console.log('=== 提炼（mock llm）===')
const llmSaying = (obj) => ({ chat: async () => JSON.stringify(obj) })

const ok = await runHarvest({
  agent: agentOf(events),
  llm: llmSaying({ skip: false, items: [
    { title: '位置不能表达状态', category: 'lesson', confidence: 0.85, tags: ['ui'], sources: ['D:/Harness/dsh-learn-wiki/client/client.js'], body: '排序键必须是身份，不能是证据。' },
    { title: '', body: '没有标题的条目应当被丢掉' },
  ] }),
})
check('产出可用条目', ok.items.length === 1, JSON.stringify(ok.items.map(i => i.title)))
check('★ 会话锚点永远在 sources 里（模型给的文件路径是补充不是替代）',
  ok.items[0]?.sources.includes('session://sess-1') && ok.items[0]?.sources.some(s => s.includes('client.js')),
  JSON.stringify(ok.items[0]?.sources))
check('丢掉标题为空/正文为空的条目', ok.considered === 2 && ok.items.length === 1)

const badCat = await runHarvest({
  agent: agentOf(events, 's'),
  llm: llmSaying({ skip: false, items: [{ title: 't', body: 'b', category: '瞎写的' }] }),
})
check('category 不在白名单 → fact', badCat.items[0]?.category === 'fact', badCat.items[0]?.category)

const skipRes = await runHarvest({
  agent: agentOf(events, 's'),
  llm: llmSaying({ skip: true, reason: '这段对话没有值得长期保留的东西' }),
})
check('★ 模型拒绝时不产出任何东西', skipRes.skipped === true && skipRes.items.length === 0, skipRes.reason)

const shortRes = await runHarvest({ agent: agentOf([userMsg('嗯', 'user', 0)], 's'), llm: llmSaying({ skip: false, items: [] }) })
check('会话太短时直接拒绝，不浪费一次 LLM 调用', shortRes.skipped === true && /太少/.test(shortRes.reason), shortRes.reason)

// ── ★ 取材接口（2026-09-17 的真故障，这一组就是为它立的）──
//
// 旧实现读的是 `agent.session.events` —— 一个真宿主**根本没有**的成员。
// 后果：取材恒为 0 字符，而工具回的是 ok:true + 「会话内容太少」+「这是正常的」。
// 一条故障伪装成了一个业务结论。下面这几条必须钉住"这两件事分得开"。
console.log('')
console.log('=== 取材接口（读不到 ≠ 没内容）===')
const { readSessionEvents } = await import('../lib/harvest.js')

check('★ 夹具与真宿主同形：没有 events 属性、只有 snapshotEvents()',
  sessionOf(events).events === undefined && typeof sessionOf(events).snapshotEvents === 'function')
const picked = readSessionEvents(agentOf(events))
check('从 snapshotEvents() 取到事件', picked.events?.length === events.length && /snapshotEvents/.test(picked.via), picked.via)

const realShape = extractSessionText(agentOf(events), {})
check('★ 只有 snapshotEvents() 时也能取到内容（旧实现在这里恒为 0 字符）',
  realShape.text.length > 0 && realShape.unreadable === undefined, realShape.chars + ' 字符 / via=' + realShape.via)

const noApiRes = await runHarvest({ agent: { id: 's', session: { header: { id: 's' } } }, llm: llmSaying({ skip: false, items: [] }) })
check('★ 取不到事件时报 failed，而不是"会话内容太少"',
  noApiRes.failed === true && noApiRes.skipped === true, String(noApiRes.reason).slice(0, 130))
check('★ failed 的理由要点明是接口问题（不许退化成一句"内容太少"）',
  /读不到当前会话的事件/.test(noApiRes.reason) && /snapshotEvents/.test(noApiRes.reason))
check('failed 时如实报告一条事件都没扫到', noApiRes.diag?.eventsScanned === null && noApiRes.transcriptChars === 0, JSON.stringify(noApiRes.diag))
check('★ 两条路径在报告里分得开（太短那条带着 eventsScanned，且不是 failed）',
  shortRes.failed === undefined && shortRes.diag?.eventsScanned === 1, JSON.stringify(shortRes.diag))

const legacy = extractSessionText({ id: 's', session: { events } }, {})
check('兼容旧宿主：events 属性还在时照样取到内容', legacy.text.length > 0 && /旧属性/.test(legacy.via), legacy.via)
check('★ 真接口优先于旧属性（两者都在时走 snapshotEvents()）',
  /snapshotEvents/.test(readSessionEvents({ id: 's', session: { ...sessionOf(events), events } }).via))

const nanRes = await runHarvest({
  agent: agentOf(events, 's'),
  llm: llmSaying({ skip: false, items: [{ title: 't', body: 'b', confidence: 'abc' }] }),
})
check('confidence 非数字时退回 0.5（不能变成 NaN 污染 frontmatter）', nanRes.items[0]?.confidence === 0.5, String(nanRes.items[0]?.confidence))

// ── 端到端：真的写进 staged，且不覆盖同 id 的既有页 ──
console.log('')
console.log('=== 端到端（mock ctx + 真 apply）===')
const ROOT = '.tmp-harvest-test'
await rm(ROOT, { recursive: true, force: true })
await ensureRepo(ROOT)
await writeFile(join(ROOT, 'wiki.config.json'), JSON.stringify({ autoAcquire: false }), 'utf8')
// 先手工放一页，稍后用同名标题去提炼，验证不会被静默覆盖
await writeFile(join(ROOT, 'staged', 'position-not-state.md'), '---\nid: position-not-state\ntitle: 位置不能表达状态\ncategory: lesson\nconfidence: 0.9\nstatus: staged\nsources:\n  - https://example.com/x\ncreated: 2026-09-01T00:00:00Z\nupdated: 2026-09-01T00:00:00Z\nhits: 0\n---\n\n人手写的版本，不许被自动提炼盖掉。\n', 'utf8')

const registered = []
const mockCtx = {
  tools: { register: (d) => { registered.push(d); return () => {} }, schemas: () => [{ name: 'read', description: 'r' }] },
  llm: {
    listProviders: () => [{ id: 'mock' }],
    listModels: async () => [{ id: 'mock-model' }],
    stream: async function* () {
      yield { type: 'text-delta', text: JSON.stringify({ skip: false, items: [
        { title: '位置不能表达状态', category: 'lesson', confidence: 0.8, body: '自动提炼的版本' },
        { title: '闸门必须在人工手里', category: 'decision', confidence: 0.7, body: '自动产出只落 staged。' },
      ] }) }
    },
  },
  web: { search: async () => ({ sources: [] }) },
  webServer: { register: () => () => {} },
  on: () => () => {}, effect: (fn) => { try { fn() } catch {} },
  inject: (s, cb) => cb({ systemPrompt: { section: () => {} } }),
}
const mod = await import('../index.js')
mod.apply(mockCtx, { wikiRoot: ROOT })
const tool = registered.find(t => t.name === 'wiki_harvest')
check('注册了 wiki_harvest', !!tool)
check('工具描述里写明了"落 staged、需人工固化"', /staged/.test(tool?.description ?? ''))
check('没有提供 commit 参数（自动产出不自我放行）', !(tool?.parameters ?? {}).commit)

const agent = { ...agentOf(events, 'sess-e2e'), ctx: {} }
const out = await tool.execute({}, { agent })
check('执行成功', out.ok === true, JSON.stringify(out).slice(0, 160))
check('写入了 1 页（同 id 的那条被跳过，不覆盖）', out.staged?.length === 1, JSON.stringify(out.staged?.map(s => s.id)))
// ★ 这条是本测试最有价值的一条：人手写的页 id 是 position-not-state，
//   而自动提炼的中文标题派生出的 id 是 note-<hash> —— **id 不同、标题相同**。
//   只按 id 判重会漏掉它，同一个知识点在库里躺两份。
check('★ 同名（标题相同、id 不同）时如实报告重复，而不是写第二份',
  (out.duplicates?.length ?? 0) === 1, JSON.stringify(out.duplicates))
check('重复原因说清楚是"同名"而不是"同 id"', /同名/.test(out.duplicates?.[0]?.reason ?? ''), out.duplicates?.[0]?.reason)
const kept = await readFile(join(ROOT, 'staged', 'position-not-state.md'), 'utf8')
check('★ 人手写的那页内容没被改', kept.includes('人手写的版本'), kept.slice(0, 60).replace(/\n/g, ' '))
check('新页确实落在 staged/', out.staged?.[0]?.path?.includes('staged') === true, out.staged?.[0]?.path)
const newPage = await readFile(out.staged[0].path, 'utf8')
check('新页带会话锚点', newPage.includes('session://sess-e2e'))
check('新页 status=staged（不参与召回）', /status:\s*staged/.test(newPage))

const noAgent = await tool.execute({}, {})
check('没有 agent 上下文时如实报错，而不是抛异常', noAgent.ok === false && /agent/.test(noAgent.error ?? ''), noAgent.error)

// ── 落盘函数本身：工具与界面按钮共用这一份 ──
//
// 它被抽出来的理由就是"只能有一份"：按钮和工具各写一遍判重，迟早会漂成
// "按钮出来的页和工具出来的页不一样"，而那种故障极难发现。
// 上面那条端到端走的是工具；这里直接测函数，补上端到端覆盖不到的一种情形：
// **同一次返回里两条标题相同**的条目。
console.log('')
console.log('=== stageHarvestItems（工具与按钮共用的那一份）===')
{
  const { stageHarvestItems } = await import('../lib/harvest.js')
  const r1 = await stageHarvestItems({
    wikiRoot: ROOT,
    items: [
      { title: '重复标题', category: 'fact', confidence: 0.5, tags: [], sources: ['a'], body: '第一份' },
      { title: '重复标题', category: 'fact', confidence: 0.5, tags: [], sources: ['b'], body: '第二份' },
      { title: '另一个标题', category: 'fact', confidence: 0.5, tags: [], sources: ['c'], body: '第三份' },
    ],
  })
  check('★ 同一次返回里标题相同的两条，只写第一份（边写边登记，不是只跟旧文件比）',
    r1.written.length === 2 && r1.duplicates.length === 1, JSON.stringify({ w: r1.written.map(x => x.title), d: r1.duplicates.map(x => x.title) }))
  check('写出来的一律是 staged', r1.written.every(x => String(x.path).includes('staged')), JSON.stringify(r1.written.map(x => x.path)))
  const r2 = await stageHarvestItems({ wikiRoot: ROOT, items: [{ title: '重复标题', category: 'fact', confidence: 0.5, tags: [], sources: [], body: '再来一次' }] })
  check('★ 第二次调用同样被挡住（不是只在同一批内判重）',
    r2.written.length === 0 && r2.duplicates.length === 1, JSON.stringify(r2.duplicates))
  const r3 = await stageHarvestItems({ wikiRoot: ROOT, items: [] })
  check('空输入返回空结果而不是抛异常', r3.written.length === 0 && r3.duplicates.length === 0)
  const r4 = await stageHarvestItems({ wikiRoot: ROOT, items: null })
  check('null 输入也不抛', r4.written.length === 0)
}

// ── 与真宿主的类对质（找得到就做，找不到就如实说跳过）──
//
// 这套自检曾经全绿，而功能在真宿主里恒为 0 字符。根因不是断言不够多，
// 是**夹具复述了代码的假设**。所以只要本机能找到宿主的 dsh-session 包，
// 就拿它自己的 Session 类再验一遍：真类上没有的成员，夹具里也不许有。
console.log('')
console.log('=== 与真宿主的 Session 类对质（可选）===')
const SESSION_PKG = process.env.DSH_SESSION_PKG
  || 'file:///D:/Harness/dsh-desktop/DSH%20Desktop/resources/app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
let Session = null
try { ({ Session } = await import(SESSION_PKG)) } catch (e) {
  // 诚实跳过：没找到就是没找到，不许把"没验"说成"验过了"。
  console.log('  SKIP  没找到宿主的 dsh-session 包（可用 DSH_SESSION_PKG 指定），这次**没有**对质真类')
}
if (Session) {
  let real = null
  try {
    real = Session.create('sess-real', events, { id: 'sess-real', version: 3, createdAt: AT, cwd: 'D:\\Harness', isSeeded: false, delegationDepth: 0, agentPreset: 'ptc' })
  } catch (e) {
    // 夹具被真类拒绝 = 夹具自己就不真实，这必须红，不能吞。
    check('夹具能被真 Session 类接受', false, '种子被真类拒绝：' + String(e?.message ?? e).slice(0, 140))
  }
  if (real) {
    check('★ 真 Session 类上没有 events 属性 —— 旧实现恒取到 0 字符的根因', real.events === undefined, 'events=' + String(real.events))
    const exReal = extractSessionText({ id: real.id, session: real }, {})
    check('★ 用**真 Session 类**（真信封、真接口）也能取到内容', exReal.text.length > 0, exReal.chars + ' 字符 / via=' + exReal.via)
  }
}

await rm(ROOT, { recursive: true, force: true })
console.log('')
if (failures === 0) console.log('ALL PASS — 会话提炼可用，且不把自己的注入物当成人的话')
else console.log(failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
