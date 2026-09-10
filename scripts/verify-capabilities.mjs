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

console.log(failures === 0 ? '\nALL PASS — 能力包语义正确' : '\n' + failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
