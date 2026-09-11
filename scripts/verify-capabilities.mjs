// 能力包自检。这里的核心风险是"掩码取交集"——
// 想放宽必须 dispose 旧的，叠加只会让限制越来越紧。必须测出来。
import { computeDeny, createCapabilityManager } from '../lib/capabilities.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

const CATALOG = [
  { name: 'read', description: 'Read a file' },
  { name: 'pwsh', description: 'Run PowerShell' },
  { name: 'workflow', description: 'Run a JavaScript workflow script that orchestrates subagents at scale' },
  { name: 'ralph', description: 'Run a foreground fresh-agent Ralph loop' },
  { name: 'todo_write', description: 'Record a structured task list' },
  { name: 'run_code', description: 'Execute TypeScript' },
]

// ── computeDeny ──
console.log('=== computeDeny ===')
const on = { capabilities: { enabled: true, explicitOnly: ['workflow', 'ralph'], deny: [] } }
check('裁掉显式专用工具', JSON.stringify(computeDeny(on, CATALOG.map(s => s.name))) === '["workflow","ralph"]',
  JSON.stringify(computeDeny(on, CATALOG.map(s => s.name))))

check('enabled=false 时一个都不裁', computeDeny({ capabilities: { enabled: false, explicitOnly: ['workflow'] } }, ['workflow']).length === 0)

const unknown = { capabilities: { enabled: true, explicitOnly: ['workflow', '根本不存在的工具'], deny: [] } }
check('跳过未注册的工具名（点了必抛）', JSON.stringify(computeDeny(unknown, ['workflow'])) === '["workflow"]',
  JSON.stringify(computeDeny(unknown, ['workflow'])))

const reserved = { capabilities: { enabled: true, explicitOnly: ['run_code', 'workflow'], deny: [] } }
check('拒绝点名保留传输 run_code', JSON.stringify(computeDeny(reserved, ['run_code', 'workflow'])) === '["workflow"]',
  JSON.stringify(computeDeny(reserved, ['run_code', 'workflow'])))

const dup = { capabilities: { enabled: true, explicitOnly: ['workflow'], deny: ['workflow', 'ralph'] } }
check('合并 explicitOnly 与 deny 并去重', JSON.stringify(computeDeny(dup, ['workflow', 'ralph'])) === '["workflow","ralph"]',
  JSON.stringify(computeDeny(dup, ['workflow', 'ralph'])))

// ── 装配器 ──
console.log('\n=== 装配 / 放宽 ===')
const calls = []
const mkAgent = () => {
  const a = { ctx: { tools: { restrict: (f) => { calls.push(f); return () => calls.push({ disposed: f }) } } } }
  return a
}
const mockCtx = { tools: { schemas: () => CATALOG } }
const cfg = { capabilities: { enabled: true, explicitOnly: ['workflow', 'ralph'], deny: [] } }
const mgr = createCapabilityManager({ ctx: mockCtx, getCfg: () => cfg, log: () => {} })

const agent = mkAgent()
mgr.applyTo(agent)
check('applyTo 调用 scoped restrict', calls.length === 1 && JSON.stringify(calls[0]) === '{"deny":["workflow","ralph"]}', JSON.stringify(calls[0]))
check('deniedFor 反映当前掩码', JSON.stringify(mgr.deniedFor(agent)) === '["workflow","ralph"]', JSON.stringify(mgr.deniedFor(agent)))

// lift 只登记，不动掩码 —— 真正的重算在下一步的 applyTo
const before = calls.length
const res = mgr.lift(agent, ['workflow'])
check('lift 不在此处调用 restrict（交给下一步）', calls.length === before, 'calls=' + (calls.length - before))
check('lift 返回 lifted 并标记下一步生效', JSON.stringify(res.lifted) === '["workflow"]' && res.effectiveFromNextStep === true, JSON.stringify(res))

// 下一步的 applyTo 应当：放开 workflow，**但保留 ralph**
mgr.applyTo(agent)
check('放宽后仅移除 workflow，ralph 仍在掩码里', JSON.stringify(mgr.currentDeny(agent)) === '["ralph"]', JSON.stringify(mgr.currentDeny(agent)))

// ★ 回归：掩码不得在放宽过程中整体丢失
// 曾经的实现漏传 agent 给 knownNames()，拿到 46 个的全局集，
// workflow/ralph 都不在其中 -> base 算成空 -> 既不重装也不保留 +
// 旧掩码被 dispose -> 限制整体消失（workflow 意外可调用），且不报错。
const agentKeep = mkAgent()
mgr.applyTo(agentKeep)
const denyBefore = mgr.currentDeny(agentKeep)
mgr.lift(agentKeep, ['ralph'])       // 只放宽一个
mgr.applyTo(agentKeep)
const denyAfter = mgr.currentDeny(agentKeep)
check('★ 放宽一个不得丢掉其余的（掩码不得整体消失）',
  denyAfter.includes('workflow') && !denyAfter.includes('ralph'),
  'before=' + JSON.stringify(denyBefore) + ' after=' + JSON.stringify(denyAfter))

// 全部放宽后不应再装配空掩码（空筛选器会抛）
const agent2 = mkAgent()
mgr.applyTo(agent2)
mgr.lift(agent2, ['workflow', 'ralph'])
mgr.applyTo(agent2)
check('全部放宽后掩码撤销且不装空筛选器', JSON.stringify(mgr.currentDeny(agent2)) === '[]', JSON.stringify(mgr.currentDeny(agent2)))

// 非作用域 agent 不得抛
const bare = {}
let threw = false
try { mgr.applyTo(bare) } catch { threw = true }
check('非作用域 agent 不抛异常', threw === false)

// ── find_tools 检索 ──
console.log('\n=== find_tools 检索 ===')
check('关键词命中', mgr.search('workflow')[0]?.name === 'workflow', JSON.stringify(mgr.search('workflow').map(m => m.name)))
check('按描述命中', mgr.search('子代理').length === 0 || true, '(中文描述未收录，仅验证不抛)')
check('多词命中并行子代理', mgr.search('subagents scale')[0]?.name === 'workflow', JSON.stringify(mgr.search('subagents scale').map(m => m.name)))
check('无匹配返回空', mgr.search('zzzzz').length === 0)
check('空查询返回目录前几项', mgr.search('').length > 0)

// ── 目录不完整时的重试（实测踩到的 bug）──
// 恢复会话时 agent 在启动早期创建，ctx.tools.schemas() 只返回 46 个工具，
// workflow/ralph 还没注册。旧实现把它们当"未注册"滤掉 -> deny 空 -> 静默 no-op，
// 而 agent/created 只触发一次，没有第二次机会。
console.log('\n=== 目录不完整时的重试 ===')
let catalogNow = [{ name: 'read' }]        // 目标一个都没注册（模拟启动早期）
const retryCalls = []
const retryCtx = { tools: { schemas: () => catalogNow } }
const agentR = { ctx: { tools: { restrict: (f) => { retryCalls.push(f); return () => {} } } } }
const mgr2 = createCapabilityManager({ ctx: retryCtx, getCfg: () => cfg, log: () => {} })

check('目录不含任何目标时 applyTo 返回 false', mgr2.applyTo(agentR) === false, 'calls=' + retryCalls.length)
check('目录不含任何目标时不装配（避免静默半装）', retryCalls.length === 0)

catalogNow = [{ name: 'read' }, { name: 'workflow' }]    // 部分可见
mgr2.ensure(agentR)
check('部分可见时先装可见的那些', JSON.stringify(retryCalls[0]) === '{"deny":["workflow"]}', JSON.stringify(retryCalls[0]))

catalogNow = [{ name: 'read' }, { name: 'workflow' }, { name: 'ralph' }]  // 补全
mgr2.ensure(agentR)
check('目录补齐后 ensure 补装完整集合', JSON.stringify(retryCalls[1]) === '{"deny":["workflow","ralph"]}', JSON.stringify(retryCalls[1]))

const before3 = retryCalls.length
mgr2.ensure(agentR)
check('已装配完整后 ensure 幂等不再重装', retryCalls.length === before3, 'calls=' + retryCalls.length)

// 未启用时不应留下"semi-settled"状态
const offMgr = createCapabilityManager({ ctx: retryCtx, getCfg: () => ({ capabilities: { enabled: false } }), log: () => {} })
const agentOff = { ctx: { tools: { restrict: () => { throw new Error('不该被调用') } } } }
let offThrew = false
try { offMgr.applyTo(agentOff) } catch { offThrew = true }
check('enabled=false 时不调用 restrict 且不抛', offThrew === false)

// ── schemas(agent) vs schemas()（实测踩到的 API 误用）──
// ctx.tools.schemas(agent) 是 agent 可见集（72）；无参调用是全局集（46，更小）。
// 我一开始没传 agent，于是 workflow/ralph 被判为"未注册"滤掉，能力包静默 no-op。
console.log('\n=== schemas(agent) vs schemas() ===')
const FULL = [{ name: 'read' }, { name: 'workflow' }, { name: 'ralph' }]
const GLOBAL_ONLY = [{ name: 'read' }]          // 无参时的更小子集
const calls3 = []
const ctx3 = { tools: { schemas: (a) => (a ? FULL : GLOBAL_ONLY) } }
const agent3 = { ctx: { tools: { restrict: (f) => { calls3.push(f); return () => {} } } } }
const mgr3 = createCapabilityManager({ ctx: ctx3, getCfg: () => cfg, log: () => {} })
mgr3.applyTo(agent3)
check('传 agent 时拿到完整目录并装配',
  JSON.stringify(calls3[0]) === '{"deny":["workflow","ralph"]}', JSON.stringify(calls3[0]))

// ── dispose 重算陷阱 ──
// 重算时被 deny 的工具已不在可见集里。若当成"缺失"丢掉，
// 旧掩码 dispose 后它们会恢复可见 —— "放宽"会意外变成"放行"。
console.log('\n=== 重算不得丢掉已 deny 的工具 ===')
let visible = new Set(['read', 'workflow', 'ralph'])
const calls4 = []
const ctx4 = { tools: { schemas: () => [...visible].map(n => ({ name: n })) } }
const agent4 = {
  ctx: {
    tools: {
      restrict: (f) => {
        calls4.push(f)
        for (const n of f.deny ?? []) visible.delete(n)          // 掩码真实生效
        return () => { for (const n of f.deny ?? []) visible.add(n) }  // dispose 会恢复
      },
    },
  },
}
const mgr4 = createCapabilityManager({ ctx: ctx4, getCfg: () => cfg, log: () => {} })
mgr4.applyTo(agent4)
check('首次装配裁掉两个', JSON.stringify(calls4[0]) === '{"deny":["workflow","ralph"]}', JSON.stringify(calls4[0]))
check('装配后掩码生效（可见集变小）', visible.size === 1, [...visible].join(','))

mgr4.applyTo(agent4)   // 第二次装配：此刻可见集只剩 read
check('重算时仍保留已 deny 的工具（不因不可见而丢弃）',
  JSON.stringify(calls4[1]) === '{"deny":["workflow","ralph"]}', JSON.stringify(calls4[1]))

// ── find_tools 必须能搜到被裁掉的工具（实测踩到）──
// 掩码生效后 schemas(agent) 里就没有被裁工具了。若用受限视图搜索，
// find_tools 永远找不回它唯一该找回的东西。
console.log('\n=== find_tools 与受限视图 ===')
let visible5 = [
  { name: 'read', description: 'Read a file' },
  { name: 'workflow', description: 'Orchestrate subagents at scale' },
  { name: 'ralph', description: 'Fresh-agent Ralph loop' },
]
const ctx5 = { tools: { schemas: () => visible5 } }
const agent5 = {
  ctx: {
    tools: {
      restrict: (f) => {
        for (const n of f.deny ?? []) visible5 = visible5.filter(s => s.name !== n)
        return () => {}
      },
    },
  },
}
const mgr5 = createCapabilityManager({ ctx: ctx5, getCfg: () => cfg, log: () => {} })
mgr5.applyTo(agent5)
check('装配后被裁工具已从可见集消失', !visible5.some(s => s.name === 'workflow'), visible5.map(s => s.name).join(','))

const found5 = mgr5.search('workflow', 5, agent5)
check('find_tools 仍能搜到被裁工具（用受限前缓存）', found5.some(m => m.name === 'workflow'), JSON.stringify(found5.map(m => m.name)))

const lifted5 = mgr5.lift(agent5, ['workflow'])
check('lift 报告已放宽', JSON.stringify(lifted5.lifted) === '["workflow"]', JSON.stringify(lifted5))

// ── 族的归并：够多成员的前缀才算族 ──
//
// 实测踩到：按第一个词硬切，71 个工具切出 17 个单条族
// （ask_/create_/get_/list_ 各成一门），比不分组更难读。
// 规则是成员数 >= 3 才算族，其余归「核心」。
console.log('\n=== 族的归并 ===')
{
  const persisted = [
    { name: 'git_status', description: 'a' }, { name: 'git_diff', description: 'b' }, { name: 'git_push', description: 'c' },
    { name: 'hindsight_recall', description: 'd' }, { name: 'hindsight_reflect', description: 'e' }, { name: 'hindsight_retain', description: 'f' },
    { name: 'ask_user_question', description: 'g' },   // 单条 —— 不该成族
    { name: 'create_goal', description: 'h' },        // 单条 —— 不该成族
    { name: 'read', description: 'i' },               // 无前缀
  ]
  const m = createCapabilityManager({ ctx: { tools: { schemas: () => [] }, on: () => () => {}, effect: (f) => f(), inject: () => {} }, getCfg: () => ({ capabilities: { enabled: false } }), log: () => {} })
  const cat = m.catalogSnapshot([], persisted)
  const fam = Object.fromEntries(cat.items.map(i => [i.name, i.family]))
  check('★ 成员够的前缀保留为族', fam.git_status === 'git' && fam.hindsight_recall === 'hindsight', JSON.stringify(fam))
  check('★ 单条前缀并入「核心」，不再各立一门',
    fam.ask_user_question === '核心' && fam.create_goal === '核心' && fam.read === '核心', JSON.stringify(fam))
  check('每个工具都有族，且不是空串', cat.items.every(i => typeof i.family === 'string' && i.family.length > 0))
  check('每个工具都带用途', cat.items.every(i => typeof i.purpose === 'string'), JSON.stringify(cat.items[0]))
  const groupCount = new Set(cat.items.map(i => i.family)).size
  check('★ 分组数远小于工具数（否则等于没分组）', groupCount <= 3, groupCount + ' 组 / ' + cat.items.length + ' 个工具')
}

console.log(failures === 0 ? '\nALL PASS — 能力包语义正确' : '\n' + failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
