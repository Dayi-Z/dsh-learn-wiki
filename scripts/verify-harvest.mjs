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
const userMsg = (text, kind = 'user') => ({ type: 'user/message', seq: 1, data: { role: 'user', source: { kind }, content: [{ type: 'text', text }] } })
const asstMsg = (parts) => ({ type: 'assistant/message', seq: 2, data: { turn: 1, step: 1, message: { role: 'assistant', content: parts } } })
const text = (t) => ({ type: 'text', text: t })
const reasoning = (t) => ({ type: 'reasoning', text: t })
const toolCall = (n) => ({ type: 'tool-call', name: n, arguments: {} })

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

console.log('=== 会话抽取 ===')
const ex = extractSessionText({ id: 'sess-1', session: { events } }, {})
check('抽出了内容', ex.text.length > 0, ex.chars + ' 字符 / ' + ex.turns + ' 轮')
check('★ 只取 source.kind=user 的消息（注入块不算人说的话）',
  ex.text.includes('第一个问题') && !ex.text.includes('知识注入块') && !ex.text.includes('技能目录') && !ex.text.includes('子代理报告'))
check('★ 不取 reasoning 段（草稿不是结论）', !ex.text.includes('这段是草稿'))
check('取到了助手的 text 段', ex.text.includes('排序键里含了由勾选状态决定的字段'))
check('带会话锚点（无源不沉淀）', ex.sessionRef === 'session://sess-1', ex.sessionRef)
check('按时间正序（先问先出现）', ex.text.indexOf('第一个问题') < ex.text.indexOf('第二个问题'))

const exFew = extractSessionText({ id: 's', session: { events } }, { maxTurns: 1 })
check('maxTurns 只留最近的一轮', exFew.turns === 1 && exFew.text.includes('第二个问题') && !exFew.text.includes('第一个问题'))
const exSmall = extractSessionText({ id: 's', session: { events } }, { maxChars: 60 })
check('maxChars 截到最近的内容并标注截断', exSmall.truncated === true && exSmall.chars <= 200, 'chars=' + exSmall.chars)
check('没有会话时不抛异常', extractSessionText({}, {}).text === '' && extractSessionText(null, {}).text === '')

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
  agent: { id: 'sess-1', session: { events } },
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
  agent: { id: 's', session: { events } },
  llm: llmSaying({ skip: false, items: [{ title: 't', body: 'b', category: '瞎写的' }] }),
})
check('category 不在白名单 → fact', badCat.items[0]?.category === 'fact', badCat.items[0]?.category)

const skipRes = await runHarvest({
  agent: { id: 's', session: { events } },
  llm: llmSaying({ skip: true, reason: '这段对话没有值得长期保留的东西' }),
})
check('★ 模型拒绝时不产出任何东西', skipRes.skipped === true && skipRes.items.length === 0, skipRes.reason)

const shortRes = await runHarvest({ agent: { id: 's', session: { events: [userMsg('嗯')] } }, llm: llmSaying({ skip: false, items: [] }) })
check('会话太短时直接拒绝，不浪费一次 LLM 调用', shortRes.skipped === true && /太少/.test(shortRes.reason), shortRes.reason)

const nanRes = await runHarvest({
  agent: { id: 's', session: { events } },
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

const agent = { id: 'sess-e2e', session: { events }, ctx: {} }
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

await rm(ROOT, { recursive: true, force: true })
console.log('')
if (failures === 0) console.log('ALL PASS — 会话提炼可用，且不把自己的注入物当成人的话')
else console.log(failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
