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

/** 配置里点名要裁的工具（未过滤）。 */
export function configuredNames(cfg) {
  const caps = cfg?.capabilities ?? {}
  if (caps.enabled !== true) return []
  const out = []
  for (const n of [...(caps.explicitOnly ?? []), ...(caps.deny ?? [])]) {
    if (typeof n === 'string' && n.length > 0 && n !== RESERVED && !out.includes(n)) out.push(n)
  }
  return out
}

export function createCapabilityManager({ ctx, getCfg, log = () => {} }) {
  // agent -> { dispose, denied:Set }
  const state = new WeakMap()
  // agent -> Set<string> 被 find_tools 拉回来的工具
  const lifted = new WeakMap()
  // agent -> 是否已按完整目录成功装配。用于"目录不完整时稍后重试"。
  const settled = new WeakMap()

  /**
   * 工具目录。
   *
   * 关键坑（实测）：**必须传 agent**。
   *   ctx.tools.schemas(agent) -> agent 可见集（72 个）
   *   ctx.tools.schemas()      -> 全局集（46 个，是个更小的子集）
   * 我一开始没传，于是 workflow/ralph 被判为"未注册"而滤掉，
   * 能力包静默 no-op 了两轮重启。context_audit 之所以数得对，
   * 正是因为它在降级前先试了 schemas(agent)。
   */
  const catalog = (agent) => {
    if (agent !== undefined) {
      try { const s = ctx.tools.schemas(agent); if (Array.isArray(s) && s.length) return s } catch {}
    }
    try { return ctx.tools.schemas() ?? [] } catch { return [] }
  }

  /**
   * 已知工具名 = 当前可见 ∪ 本 agent 已被我 deny 的。
   *
   * 后一项不能省：重算时掩码可能已经生效，被 deny 的工具不在可见集里，
   * 若当成"缺失"丢掉，旧掩码 dispose 后它们反而会恢复可见 ——
   * 一个"放宽"操作会意外变成"放行"。
   */
  const knownNames = (agent) => {
    const cur = new Set(catalog(agent).map(s => s.name))
    for (const n of state.get(agent)?.denied ?? []) cur.add(n)
    return [...cur]
  }

  /**
   * 给一个 agent 装配能力包。
   *
   * 关键教训（实测踩到）：**恢复会话时 agent 在启动早期就创建了，那一刻
   * ctx.tools.schemas() 只返回 46 个工具**，workflow/ralph 还没注册进来，
   * 于是被"未注册就跳过"的逻辑滤掉、deny 为空、静默 no-op ——
   * 而 agent/created 只触发一次，没有第二次机会。
   *
   * 所以这里改成：目录不完整就返回 false，由 ensure() 在第一步 pre-step 再试。
   * pre-step 发生在提示词组装之前，所以补装仍然能影响本轮的请求。
   */
  const applyTo = (agent) => {
    try {
      const scoped = agent?.ctx
      if (!scoped?.tools?.restrict) { log('capabilities: agent.ctx.tools.restrict 不可用，跳过'); return false }
      const cfgNow = getCfg()
      const want = configuredNames(cfgNow)
      if (want.length === 0) { settled.set(agent, true); return true }

      const known = knownNames(agent)
      const found = want.filter(n => known.includes(n))
      const missing = want.filter(n => !known.includes(n))

      if (known.length === 0) { log('capabilities: 工具目录为空（ctx.tools.schemas() 不可用），未装配'); return false }
      if (found.length === 0) {
        // 目录还没长全——这是"启动早期"的特征，稍后由 pre-step 重试
        log('capabilities: 目录暂不完整（' + known.length + ' 个工具，缺 ' + missing.join(',') + '），稍后重试')
        return false
      }

      const prev = state.get(agent)
      if (prev) { try { prev.dispose() } catch {} }
      const dispose = scoped.tools.restrict({ deny: found })
      state.set(agent, { dispose, denied: new Set(found) })
      // 仍有缺失 => 下次再补一次
      settled.set(agent, missing.length === 0)
      log('capabilities: deny ' + found.length + ' 个工具 -> ' + found.join(', ')
        + (missing.length ? '  (目录仅 ' + known.length + ' 个，待补: ' + missing.join(',') + ')' : ''))
      return true
    } catch (e) {
      log('capabilities apply failed (non-fatal):', e?.message ?? e)
      return false
    }
  }

  /** 幂等装配：已按完整目录装好就不再重复。agent/created 与 pre-step 都调它。 */
  const ensure = (agent) => {
    if (settled.get(agent) === true) return true
    return applyTo(agent)
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
  const search = (query, limit = 8, agent) => {
    const q = String(query ?? '').toLowerCase().trim()
    const all = catalog(agent)
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

  return { applyTo, ensure, lift, search, deniedFor, knownNames }
}
