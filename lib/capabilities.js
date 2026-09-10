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
  for (const n of [...(caps.explicitOnly ?? []), ...(caps.diagnostics ?? []), ...(caps.deny ?? [])]) {
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
  // agent -> 掩码生效**之前**的完整目录。
  //
  // 为什么必须缓存：find_tools 的职责就是找回被裁掉的工具，而掩码一旦生效，
  // schemas(agent) 里就没有它们了 —— 在受限视图里搜受限的东西，永远搜不到。
  // 所以要在第一次装配（尚未受限）时把目录抓下来。
  const fullCatalog = new WeakMap()

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
      // 减去 find_tools 已放回的。**所有掩码变更都收敛到这一个函数**，
      // 因为它是唯一在已验证上下文（agent/created 与 pre-step）里跑过的路径。
      const liftedSet = lifted.get(agent) ?? new Set()
      const want = configuredNames(cfgNow).filter(n => !liftedSet.has(n))
      if (want.length === 0) {
        // 没有要裁的了：若之前装过，撤掉，并留下痕迹
        const prev0 = state.get(agent)
        if (prev0) {
          try { prev0.dispose() } catch {}
          state.delete(agent)
          log('capabilities: 已放宽全部，掩码撤销')
        }
        settled.set(agent, true)
        return true
      }

      const known = knownNames(agent)
      const found = want.filter(n => known.includes(n))
      const missing = want.filter(n => !known.includes(n))

      if (known.length === 0) { log('capabilities: 工具目录为空（ctx.tools.schemas() 不可用），未装配'); return false }
      if (found.length === 0) {
        // 目录还没长全——这是"启动早期"的特征，稍后由 pre-step 重试
        log('capabilities: 目录暂不完整（' + known.length + ' 个工具，缺 ' + missing.join(',') + '），稍后重试')
        return false
      }

      // 目录看起来完整时才缓存（否则会缓存下一份残缺的）
      if (missing.length === 0 && !fullCatalog.has(agent)) {
        fullCatalog.set(agent, catalog(agent))
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

  /**
   * 把若干工具拉回来：只**登记意图**，真正的重算交给下一步的 applyTo()。
   *
   * 为什么不在工具调用里直接 dispose+重装（实测踩到）：
   * 这里曾经调用 computeDeny(cfg, knownNames()) —— **漏传 agent**，
   * 于是拿到的是 46 个的全局集，workflow/ralph 不在其中，base 算成空，
   * 既不重装也不保留，旧掩码又被 dispose 掉 —— **限制整体丢失**，
   * workflow 意外变成可调用。而且它不报错。
   *
   * 教训是"所有掩码变更必须收敛到已被验证的路径"：只有 applyTo()
   * 在 agent/created 与 pre-step 两个上下文里跑通过。lift 只登记。
   * 代价：放宽在**下一步**可见 —— 这本就是提示词组装的自然粒度。
   */
  const lift = (agent, names) => {
    // WeakMap 的键必须是个对象：没有 agent（例如非模型发起的直接调用）时
    // 直接 set 会抛 "Invalid value used as weak map key"。
    if (!agent || typeof agent !== 'object') {
      return { lifted: [], reason: '无 agent 作用域，放宽未登记' }
    }
    const set = lifted.get(agent) ?? new Set()
    for (const n of names) if (typeof n === 'string' && n.length > 0) set.add(n)
    lifted.set(agent, set)
    settled.set(agent, false)          // 让下一步的 ensure() 重算
    log('capabilities: 登记放宽 ' + [...set].join(',') + '（下一步生效）')
    return { lifted: [...set], effectiveFromNextStep: true }
  }

  /** 当前实际生效的 deny（供诊断，也让测试能断言掩码没丢）。 */
  const currentDeny = (agent) => [...(state.get(agent)?.denied ?? [])]

  /**
   * 按关键词搜索目录。用于 find_tools。
   *
   * 优先用缓存的"受限前目录"——否则被裁掉的工具搜不到，
   * find_tools 就失去了它唯一的存在理由。
   */
  const search = (query, limit = 8, agent) => {
    const q = String(query ?? '').toLowerCase().trim()
    const all = fullCatalog.get(agent) ?? catalog(agent)
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

  return { applyTo, ensure, lift, search, deniedFor, currentDeny, knownNames }
}
