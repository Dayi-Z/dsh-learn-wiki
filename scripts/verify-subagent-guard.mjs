// 子代理守卫自检。
//
// 为什么值得单独一个测试：这条守卫的**两个方向**都会出错，而且错法不对称。
//   漏掉（把子代理当主代理）→ 临时工往长期记忆里写字：实测发生过，
//     一个派出去做调研的子代理因为"工具只能从 run_code 里调"连试 5 次 read
//     全失败，插件的挣扎检测把它的**任务提示词**当成项目知识缺口写进共享
//     gap 队列去联网搜索，同批里另一条最终沉了一页关于**另一个撞名项目**的内容。
//   过头（把主代理当子代理）→ 主代理从此不再积累任何证据，知识库停止进化。
//     这个方向更致命，所以"读不到深度"必须一律按主代理处理。
//
// 所以这里两侧都要测：子代理必须不产生后果，主代理必须照常产生后果。
import { rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureRepo } from '../lib/wiki.js'
import { DEFAULTS } from '../lib/config.js'


const ROOT = '.tmp-subagent-guard'
let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

async function waitFor(fn, ms = 8000, step = 100) {
  const dl = Date.now() + ms
  for (;;) {
    let v = null
    try { v = await fn() } catch { v = null }
    if (v || Date.now() >= dl) return v
    await new Promise(r => setTimeout(r, step))
  }
}

const readJson = async (p) => { try { return JSON.parse(await readFile(p, 'utf8')) } catch { return null } }
const readLines = async (p) => {
  try { return (await readFile(p, 'utf8')).split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l)) } catch { return [] }
}

await rm(ROOT, { recursive: true, force: true })
await ensureRepo(ROOT)
// autoAcquire 关掉：本测试只关心"要不要把这件事记下来"，
// 不关心后续联网。开着会让测试去真的搜网、并往临时目录里沉页。
await writeFile(join(ROOT, 'wiki.config.json'), JSON.stringify({
  autoAcquire: false,
  struggleCooldownMs: 0,
}), 'utf8')

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
const handlers = {}
const mockCtx = {
  tools: {
    register: () => () => {},
    schemas: () => ([
      { name: 'read', description: 'Read a file' },
      { name: 'edit', description: 'Edit a file' },
      { name: 'widget_tool', description: 'A widget tool' },
    ]),
  },
  llm: { listProviders: () => [{ id: 'mock' }], listModels: async () => [{ id: 'mock-model' }], stream: async function* () {} },
  web: { search: async () => ({ sources: [] }) },
  webServer: { register: () => () => {} },
  on: (name, fn) => { handlers[name] = fn; return () => {} },
  effect: (fn) => { try { fn() } catch {} },
  inject: (svc, cb) => cb({ systemPrompt: { section: () => {} } }),
}

const mod = await import('../index.js')
mod.apply(mockCtx, { wikiRoot: ROOT })

check('挂上了 tools/result 与 agent/pre-step',
  typeof handlers['tools/result'] === 'function' && typeof handlers['agent/pre-step'] === 'function',
  Object.keys(handlers).join(','))

// ── 两个 agent：只差 delegationDepth ──
// 字段形状照抄真实会话 header（实测解出来的）：
//   子代理 origin="subagent" delegationDepth=1，根会话 delegationDepth=0
const mkAgent = (id, depth, extra = {}) => ({
  id,
  session: { header: { delegationDepth: depth, ...(depth > 0 ? { origin: 'subagent' } : {}) } },
  ...(depth > 0 ? { options: { subagentDepth: depth } } : {}),
  ctx: {},
  ...extra,
})

const rootAgent = mkAgent('root-guard-test', 0)
// ★ 故意只在 session.header 上带深度、**不带** options.subagentDepth ——
//   真实宿主两处都带，但守卫必须任一处能认出来，否则将来宿主只保留一处时会静默失效。
const subAgent = { id: 'sub-guard-test', session: { header: { delegationDepth: 1, origin: 'subagent' } }, ctx: {} }
// 完全读不到深度的 agent（宿主结构变了 / mock 不完整）
const unknownAgent = { id: 'unknown-guard-test', ctx: {} }

const userMsg = (text) => ({ role: 'user', content: [{ type: 'text', text }] })
const QUERY = 'Widget 协议的分帧和魔数是什么'
// ★ 子代理的"当前任务"里塞一个独一无二的标记。
//   这样"子代理的提示词有没有漏进共享 gap 队列"是可以**直接判定**的，
//   而不是靠正则去猜哪些词像任务描述 —— 第一版我用 /任务：/ 去匹配，
//   结果所有正常 gap 都带"（当前任务：…）"，断言反过来红了。
const SUB_MARKER = 'SUBPROMPTMARKER7f3a'

async function drivePreStep(agent, query = QUERY) {
  const messages = [userMsg(query)]
  return handlers['agent/pre-step']({ agent, messages, step: 1 }, async () => ({ kind: 'enter', messages }))
}

/**
 * 制造一次**允许联网**的挣扎：撞同一堵墙（recurring-error）。
 *
 * 为什么不用 edit-churn：它已经被移出联网白名单 —— 症状查询里只有一个本地
 * 文件名，那种字符串网上不存在，检索它最坏会撞上同名项目（实测撞出过一页
 * 关于另一个 llm-wiki 包的内容）。本测试要验的是"主代理的挣扎会去联网、
 * 子代理的不会"，所以得用一个真的会去联网的信号。
 */
const RECUR = DEFAULTS.struggleRecurringError
function sameWall(agent, tag) {
  for (let i = 0; i < RECUR; i++) {
    handlers['tools/result']({ name: 'pwsh', arguments: { command: 'check ' + tag + ' ' + i }, agent },
      { isError: true, error: { message: 'Error: WALL_' + tag + ' at src/x.js:12' } })
  }
}

// ── 场景 A/B：先注入，再挣扎 ──
//
// ★ 三个 pre-step **串行**驱动，每个之间等一下。
//   为什么：pre-step 里是 loadUsage → recordHit → void saveUsage 的
//   读-改-写，而 saveUsage 用的是整文件 writeFile（非原子的）。
//   三个并排跑会互相覆盖，测试自己就把 usage.json 写坏 —— 我第一版并行跑，
//   两次结果不一样（一次 hits=3，一次 hits=undefined）。
//   这是**测试**要避开的东西，不是被测逻辑的错；真实宿主里并发写入的
//   风险另记（见文件末尾的备注）。
const settle = () => new Promise(r => setTimeout(r, 250))
const decRoot = await drivePreStep(rootAgent)
await settle()
const decSub = await drivePreStep(subAgent, QUERY + '（' + SUB_MARKER + '）')
await settle()
const decUnknown = await drivePreStep(unknownAgent)
await settle()

const injected = (d, before) => (d?.messages?.length ?? 0) > before
check('主代理：命中知识并被注入', injected(decRoot, 1), 'messages=' + (decRoot?.messages?.length))
check('子代理：同样被注入（子代理**该**拿到知识，守卫只掐写入不掐读取）',
  injected(decSub, 1), 'messages=' + (decSub?.messages?.length))

// 等到 hits 真的到 3 再断言，并把**那一次读到的东西**拿回来用 ——
// 不能在 waitFor 之后再读一遍：那次读可能正好撞上另一个写，拿到半截文件。
const used = await waitFor(async () => {
  const u = await readJson(join(ROOT, 'usage.json'))
  return (u?.pages?.['widget-protocol']?.hits ?? 0) >= 3 ? u : null
}, 8000)
check('三个 agent 的命中都计数了（hits 是 liveness，与来源无关）',
  used !== null, 'hits=' + (used?.pages?.['widget-protocol']?.hits))

sameWall(rootAgent, 'ROOT')
sameWall(subAgent, 'SUB')
sameWall(unknownAgent, 'UNK')

// 等异步写盘。
//
// ★ 三条都要等，缺一条就是竞态：struggle.jsonl、usage.json、gap 队列
//   分别由三个互相独立的 fire-and-forget 路径写（appendGap 不阻塞回调、
//   recordSuspect 在 promise 里）。只等其中两条，第三条就在读的时候还没落盘 ——
//   断红的位置和真正的 bug 毫无关系。第一次跑就是栽在这里。
// ★ 三份产物在**同一次读**里取齐，且只在这一遍全部满足时才采用。
//   分开读三遍，任何一遍都可能撞上写盘（第一次跑就是这么红的）。
const snap = await waitFor(async () => {
  const st = await readLines(join(ROOT, 'struggle.jsonl'))
  const u = await readJson(join(ROOT, 'usage.json'))
  const g = await readLines(join(ROOT, 'gaps', 'queue.jsonl'))
  const ok = st.length >= 3 && (u?.pages?.['widget-protocol']?.suspect ?? 0) >= 1 && g.length >= 2
  return ok ? { st, u, g } : null
}, 10000)

const struggles = snap ? snap.st : await readLines(join(ROOT, 'struggle.jsonl'))
const usage = snap ? snap.u : await readJson(join(ROOT, 'usage.json'))
const gaps = snap ? snap.g : await readLines(join(ROOT, 'gaps', 'queue.jsonl'))
check('三份产物在超时前都落盘了（否则下面的断言读的是半截状态）', snap !== null,
  'struggles=' + struggles.length + ' gaps=' + gaps.length + ' suspect=' + (usage?.pages?.['widget-protocol']?.suspect))
if (snap === null) {
  // 诊断：把原始状态摊开，别让人对着 "gaps=0" 猜
  const { existsSync } = await import('node:fs')
  const qp = join(ROOT, 'gaps', 'queue.jsonl')
  console.log('    [诊断] queue.jsonl 存在=', existsSync(qp))
  try { console.log('    [诊断] 原文=', JSON.stringify(await readFile(qp, 'utf8'))) } catch (e) { console.log('    [诊断] 读失败', e.message) }
  try { console.log('    [诊断] 插件日志尾=', (await readFile(join(ROOT, '.learn-wiki.log'), 'utf8')).split('\n').slice(-12).join(' / ')) } catch (e) { console.log('    [诊断] 无日志', e.message) }
}

console.log('')
console.log('── A. 嫌疑账本（谁被降权）──')
check('主代理挣扎 → 知识被记嫌疑（这是它该干的事，不能被守卫误伤）',
  (usage?.pages?.['widget-protocol']?.suspect ?? 0) >= 1,
  'suspect=' + (usage?.pages?.['widget-protocol']?.suspect))
check('子代理挣扎 → **不**记嫌疑',
  !struggles.some(s => s.sessionId === subAgent.id && s.origin !== 'subagent'),
  '子代理记录数=' + struggles.filter(s => s.sessionId === subAgent.id).length)
check('读不到深度的 agent → 按主代理处理（方向安全：宁可漏拦，不可误拦）',
  struggles.some(s => s.sessionId === unknownAgent.id && s.origin === 'agent'),
  JSON.stringify(struggles.map(s => ({ id: s.sessionId, o: s.origin }))))

console.log('')
console.log('── B. gap 队列（谁去联网）──')
const subGaps = gaps.filter(g => g.sessionId === subAgent.id)
const rootGaps = gaps.filter(g => g.sessionId === rootAgent.id)
check('子代理 → 一条 gap 都没有（它的工具误用不是项目知识缺口）', subGaps.length === 0,
  JSON.stringify(subGaps.map(g => g.query)))
check('主代理 → 正常进 gap 队列', rootGaps.length >= 1, JSON.stringify(rootGaps.map(g => g.query.slice(0, 50))))
check('gap 里不出现子代理的提示词标记（它连一个字符都不该漏进共享队列）',
  !gaps.some(g => String(g.query).includes(SUB_MARKER)),
  gaps.map(g => String(g.query).slice(0, 60)).join(' | '))

console.log('')
console.log('── C. 观测记录仍然诚实（照记，但标注来源）──')
const subRec = struggles.filter(s => s.sessionId === subAgent.id)
check('子代理的挣扎**照记**（观测数据不能因为不产生后果就丢掉）', subRec.length >= 1, 'n=' + subRec.length)
check('子代理记录带 origin=subagent', subRec.length > 0 && subRec.every(s => s.origin === 'subagent'),
  JSON.stringify(subRec.map(s => s.origin)))
check('子代理记录带 depth', subRec.length > 0 && subRec.every(s => s.depth === 1),
  JSON.stringify(subRec.map(s => s.depth)))
const rootRec = struggles.filter(s => s.sessionId === rootAgent.id)
check('主代理记录带 origin=agent', rootRec.length > 0 && rootRec.every(s => s.origin === 'agent'),
  JSON.stringify(rootRec.map(s => s.origin)))

console.log('')
console.log('── D. 状态接口如实拆分两类 ──')
let route = null
const ctx2 = { ...mockCtx, webServer: { register: (r) => { route = r; return () => {} } } }
const mod2 = await import('../index.js?guard2')
mod2.apply(ctx2, { wikiRoot: ROOT })
const body = await new Promise((res) => route.handler({ url: '/learn-wiki/api/state', method: 'GET' }, { writeHead: () => {}, end: (b) => res(b) }))
const st = JSON.parse(body).struggles
check('接口给出 struggles.subagent', typeof st.subagent === 'number', 'subagent=' + st.subagent)
check('subagent 计数与实际记录一致', st.subagent === struggles.filter(s => s.origin === 'subagent').length,
  st.subagent + ' vs ' + struggles.filter(s => s.origin === 'subagent').length)
check('total 含子代理（分母诚实，不偷偷减掉）', st.total === struggles.length, st.total + ' vs ' + struggles.length)
check('recent 每条都带 origin', (st.recent || []).every(r => r.origin === 'agent' || r.origin === 'subagent'),
  JSON.stringify((st.recent || []).map(r => r.origin)))

await rm(ROOT, { recursive: true, force: true })
console.log('')
if (failures === 0) console.log('ALL PASS — 子代理不产生后果，主代理照常产生后果')
else console.log(failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
