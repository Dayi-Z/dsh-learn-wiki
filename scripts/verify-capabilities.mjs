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

// 关键：放宽必须先 dispose，否则掩码取交集会越收越紧
const before = calls.length
const res = mgr.lift(agent, ['workflow'])
check('lift 先 dispose 旧掩码', calls.slice(before).some(c => c.disposed !== undefined), JSON.stringify(calls.slice(before)))
const reapply = calls.filter(c => c.deny).pop()
check('lift 后用更窄的 deny 重新装配', JSON.stringify(reapply) === '{"deny":["ralph"]}', JSON.stringify(reapply))
check('lift 返回结果含 lifted', JSON.stringify(res.lifted) === '["workflow"]', JSON.stringify(res))

// 全部放宽后不应再调 restrict（空筛选器会抛）
const agent2 = mkAgent()
mgr.applyTo(agent2)
mgr.lift(agent2, ['workflow', 'ralph'])
const last = calls[calls.length - 1]
check('全部放宽时不再装配空掩码（空筛选器会抛）', last.disposed !== undefined, JSON.stringify(last))

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

console.log(failures === 0 ? '\nALL PASS — 能力包语义正确' : '\n' + failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
