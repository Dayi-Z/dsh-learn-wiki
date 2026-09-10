// 能力包：按需装配模型可见的工具集。
//
// 为什么值得做（M0 实测）：
//   71 个可见工具 = 7,061 token，每个请求都携带。
//   其中 workflow(633) + ralph(125) = 758 token —— 而 DSH 自己的工具描述里
//   明确写着「ONLY when the user explicitly asks」。模型被反复告知"别主动用"，
//   却每轮都为它们的说明书付费。
//
// 机制（来自 @deepseek-ai/dsh-tools 的契约，三个坑都已验证）：
//   1. restrict() 必须在 agent 作用域调用（agent.ctx），从全局调用会抛
//   2. restrict({}) 空筛选器会抛 —— 空配置几乎总是 bug，所以先判空
//   3. **多个掩码取交集** —— 想放宽就必须先 dispose 旧的，不能叠加
//   4. deny 掩码会接纳「之后才注册」的全局工具；allow 掩码会排斥它们。
//      所以能力包一律用 deny：它不会因为插件加载顺序而误伤。
//   5. 不能点名 run_code（保留的 Code Mode 传输）
//
// 与"权限"无关：DSH 文档明说这是实时可见性组合，不是安全边界。

const RESERVED = 'run_code'

/** 从配置算出要 deny 的名字。只保留当前真实注册过的全局工具——点名未知工具会抛。 */
export function computeDeny(cfg, knownNames) {
  const caps = cfg.capabilities ?? {}
  if (caps.enabled !== true) return []
  const known = new Set(knownNames)
  const explicit = Array.isArray(caps.explicitOnly) ? caps.explicitOnly : []
  const extra = Array.isArray(caps.deny) ? caps.deny : []
  const out = []
  for (const n of [...explicit, ...extra]) {
    if (typeof n !== 'string' || n.length === 0) continue
    if (n === RESERVED) continue          // 保留传输，点了必抛
    if (!known.has(n)) continue           // 未注册的名字会抛，静默跳过
    if (!out.includes(n)) out.push(n)
  }
  return out
}

export function createCapabilityManager({ ctx, getCfg, log = () => {} }) {
  // agent -> { dispose, denied:Set }
  const state = new WeakMap()
  // agent -> Set<string> 被 find_tools 拉回来的工具
  const lifted = new WeakMap()

  /** 全局作用域下的完整工具目录（不受任何 agent 掩码影响）。 */
  const catalog = () => {
    try { return ctx.tools.schemas() ?? [] } catch { return [] }
  }
  const knownNames = () => catalog().map(s => s.name)

  /** 给一个 agent 装配能力包。agent/created 时调用一次。 */
  const applyTo = (agent) => {
    try {
      const scoped = agent?.ctx
      if (!scoped?.tools?.restrict) { log('capabilities: agent.ctx.tools.restrict 不可用，跳过'); return }
      const cfgNow = getCfg()
      const known = knownNames()
      // 静默 no-op 是本项目反复踩的坑（ctx.web.fetch / turn/end / 属性探测）。
      // 能力包"什么都没做"必须留下痕迹，否则我们又会以为它在工作。
      if (known.length === 0) { log('capabilities: 工具目录为空（ctx.tools.schemas() 不可用），未装配'); return }
      const deny = computeDeny(cfgNow, known)
      if (deny.length === 0) {
        log('capabilities: 无需裁剪（enabled=' + (cfgNow?.capabilities?.enabled === true) + ', 目录 ' + known.length + ' 个工具）')
        return
      }
      const prev = state.get(agent)
      if (prev) { try { prev.dispose() } catch {} }
      const dispose = scoped.tools.restrict({ deny })
      state.set(agent, { dispose, denied: new Set(deny) })
      log('capabilities: deny ' + deny.length + ' 个工具 -> ' + deny.join(', '))
    } catch (e) {
      log('capabilities apply failed (non-fatal):', e?.message ?? e)
    }
  }

  /** 把若干工具拉回来：dispose 旧掩码 -> 用更窄的 deny 重新装配。 */
  const lift = (agent, names) => {
    try {
      const scoped = agent?.ctx
      const prev = state.get(agent)
      if (!scoped?.tools?.restrict) return { lifted: [], reason: '作用域不可用' }
      const set = lifted.get(agent) ?? new Set()
      for (const n of names) set.add(n)
      lifted.set(agent, set)
      const cfgNow = getCfg()
      const base = computeDeny(cfgNow, knownNames())
      const next = base.filter(n => !set.has(n))
      if (prev) { try { prev.dispose() } catch {} }
      state.delete(agent)
      if (next.length > 0) {
        const dispose = scoped.tools.restrict({ deny: next })
        state.set(agent, { dispose, denied: new Set(next) })
      }
      return { lifted: [...set], stillDenied: next }
    } catch (e) {
      log('capabilities lift failed (non-fatal):', e?.message ?? e)
      return { lifted: [], reason: String(e?.message ?? e) }
    }
  }

  /** 在当前可见工具之外，按关键词搜索完整目录。用于 find_tools。 */
  const search = (query, limit = 8) => {
    const q = String(query ?? '').toLowerCase().trim()
    const all = catalog()
    if (!q) return all.slice(0, limit).map(s => ({ name: s.name, description: s.description }))
    const terms = q.split(/\s+/).filter(Boolean)
    const scored = []
    for (const s of all) {
      const hay = (s.name + ' ' + (s.description ?? '')).toLowerCase()
      let score = 0
      for (const t of terms) if (hay.includes(t)) score += 1
      if (s.name.toLowerCase().includes(q)) score += 2
      if (score > 0) scored.push({ name: s.name, description: s.description, score })
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(({ score, ...r }) => r)
  }

  const deniedFor = (agent) => [...(state.get(agent)?.denied ?? [])]

  return { applyTo, lift, search, deniedFor, knownNames }
}
