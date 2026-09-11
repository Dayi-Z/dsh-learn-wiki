// 技能盘点（只读）。
//
// 为什么单独做这一块：技能和工具一样，是"每一轮都要背着的固定成本"，
// 但技能从来没在界面上露过面——用户看不到自己装了什么、要付多少。
//
// 关键是把两笔账分开算，混在一起会把事情说错：
//   常驻成本 = name + description + whenToUse。这份摘要每轮都在目录里，
//              无论是否调用都要付。
//   触发成本 = SKILL.md 正文。只有真正 skill() 调用时才付一次。
// 一个描述写得很长的技能可能常驻很贵却从不用；一个正文很长的技能常驻便宜、
// 偶尔用一次也不亏。界面必须能区分，否则"优化技能"就是瞎猜。

const CJK = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/

/**
 * 估算 token。
 * 系数来自本插件自己的标定：中文 ~2.56 字符/token，技术英文 ~6.5 字符/token。
 * 分开算是必要的——整段按 4 字符/token 会把中文低估近一倍。
 */
export function estimateTokens(s) {
  const t = String(s ?? '')
  if (!t) return 0
  let cjk = 0
  for (const ch of t) if (CJK.test(ch)) cjk += 1
  return Math.round(cjk / 2.56 + (t.length - cjk) / 6.5)
}

/**
 * 从 agent 上下文里取出**作用域键**。
 *
 * 为什么必须有这个东西：技能 provider 通常挂在 **agent preset 的作用域层**，
 * 而注册表合并层的规则是 [global, ...scopeChain(options.scope)]。
 * 不带 scope 去查，看到的只有全局层 —— 结果是**空列表，而且不报错**。
 *
 * 实测（真 Cordis + 真 dsh-skill-filesystem，provider 挂进作用域）：
 *   list({})          -> 0 项
 *   list({ scope })   -> 11 项
 * 界面上那句「0 个 · 常驻目录 — token」就是这么来的。
 *
 * 作用域键是 dsh-scope 内部 Symbol(dsh.scope) 上的值。插件解析不到
 * @deepseek-ai/dsh-scope（它不在插件的 node_modules 里），但这个 symbol 是
 * ctx 的**自有属性**，可以直接读出来——不需要引依赖。
 */
export function scopeKeyOf(agent) {
  const ctx = agent && agent.ctx
  if (!ctx) return undefined
  try {
    for (const s of Object.getOwnPropertySymbols(ctx)) {
      if (String(s) === 'Symbol(dsh.scope)') return ctx[s]
    }
  } catch { /* 读不到就算了，退化成不带 scope 的查询 */ }
  return undefined
}

/**
 * 枚举注册表里**已经存在的作用域层**。
 *
 * 为什么必须有这个：UI 路由不在任何 agent 作用域里，而技能 provider 挂在
 * preset 的作用域层。之前的做法是"借用最近一次会话的作用域"——结果是
 * **不发一条消息就看不到自己装了什么技能**。这显然反直觉：
 * 这一页要回答的恰恰是"我现在装了什么"。
 *
 * 注册表的 ScopedLayers 把每个作用域层放在一个 Map 里（dsh-scope/lib/index.js:137），
 * 直接枚举即可，不需要任何活跃会话。字段是内部结构，所以整段有 try/catch 兜底——
 * 结构变了就退化成只靠实时 agent 作用域，而不是崩掉。
 */
export function scopeKeysOf(registry) {
  const out = []
  try {
    const map = registry && registry.layers && registry.layers.scoped
    if (map && typeof map.keys === 'function') {
      for (const k of map.keys()) if (k !== undefined) out.push(k)
    }
  } catch { /* 内部结构变了，交给调用方的实时作用域兜底 */ }
  return out
}

/** 从摘要里取一个能显示来源的短路径。取不到就退回 provider 名。 */
function sourceOf(sum) {
  // 真实摘要字段（探针实测）：name, description, invocation, source, provider, resourceBase。
  // resourceBase 是 { kind: 'directory', path }，那个 path 才是真来源。
  const raw = sum?.resourceBase?.path ?? sum?.locator?.path ?? sum?.path ?? sum?.directory ?? ''
  if (raw) {
    // 只留最后两段，路径太长会把表格撑破
    const parts = String(raw).split(/[\\/]/).filter(Boolean)
    return parts.slice(-2).join('/')
  }
  return String(sum?.provider ?? '')
}

/**
 * 技能目录快照器。
 *
 * ctx.skills 是通过注入拿到的注册表；这里**不写进 inject 数组**——
 * 那样会让整个插件在缺少 skill 注册表的宿主上装配失败，代价远大于收益。
 * 拿不到就如实报告"不可用"，而不是假装目录是空的（空目录和没目录是两回事）。
 */
export function createSkillInventory({ ctx, log, ttlMs = 30000, timeoutMs = 2500, getScope } = {}) {
  let cache = null
  let inflight = null
  let probed = false
  let scopeProbed = false

  /**
   * 取 skill 注册表。
   *
   * ★ 不能直接写 ctx.skills：Cordis 的反射代理对**未声明 inject** 的服务
   * 不是返回 undefined，而是**抛错** —— cannot get property "skills" without inject。
   * 而我又不能把 skills 写进 inject 数组：那样在没有 skill 注册表的宿主上，
   * 整个插件都装不起来（工具、钩子、UI 全都一起没），代价远大于收益。
   *
   * 正规路径是 ctx.reflect.get(name, false)。它的文档原文就是
   * "Read a service from the store without the inject requirement"。
   * 下面的 try/catch 是兜底：反射本身不可用时退回直接读，仍然拿不到就算了。
   */
  const svc = () => {
    try {
      const viaReflect = ctx && ctx.reflect && typeof ctx.reflect.get === 'function'
        ? ctx.reflect.get('skills', false)
        : null
      if (viaReflect) return viaReflect
    } catch { /* 反射不可用，走下面的兜底 */ }
    try { return (ctx && ctx.skills) || null } catch { return null }
  }

  const EMPTY = Object.freeze({
    available: false,
    reason: '',
    items: [],
    totals: { count: 0, catalogTokens: 0, bodyTokens: 0, modelInvocable: 0 },
    capturedAt: false,
  })

  function withTimeout(p, label) {
    return Promise.race([
      Promise.resolve(p),
      new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' 超时 ' + timeoutMs + 'ms')), timeoutMs)),
    ])
  }

  async function collect() {
    const s = svc()
    if (!s || typeof s.list !== 'function') {
      return { ...EMPTY, reason: 'ctx.skills 不可用：宿主未装配 skill 注册表' }
    }

    // ★ 必须带 scope 查。provider 挂在 agent preset 的作用域层，
    // 不带 scope 只能看到全局层 —— 返回空列表且不报错（实测 0 vs 11）。
    // 逐级退让并记录命中的是哪一级：真出问题时日志里能直接看出来。
    const live = typeof getScope === 'function' ? getScope() : undefined
    // 候选作用域：实时 agent 的作用域优先（那是"当前这个会话看到的"），
    // 然后是注册表里**已经存在的所有层**——这样不依赖会话也能列出来。
    const scopes = []
    if (live !== undefined) scopes.push({ label: 'live', scope: live })
    for (const k of scopeKeysOf(s)) {
      if (k === live) continue
      scopes.push({ label: 'layer', scope: k })
    }
    const variants = []
    for (const sc of scopes) {
      variants.push({ label: sc.label + '+cwd', opts: { cwd: process.cwd(), scope: sc.scope } })
      variants.push({ label: sc.label, opts: { scope: sc.scope } })
    }
    variants.push({ label: 'no-scope', opts: {} })
    const scope = live

    let listed = null
    const tried = []
    let answered = 0     // 有多少个候选**成功返回**（哪怕是空数组）
    // 跨作用域层求**并集**，按名字去重。
    // 取"第一个非空的"会漏：技能可能分散在多个 preset 的作用域层里，
    // 而这一页要回答的是"我现在装了什么"，不是"某一个作用域碰巧看到什么"。
    const found = new Map()   // name -> { sum, opts }
    for (const v of variants) {
      try {
        const got = await withTimeout(s.list(v.opts), 'skills.list')
        const arr = Array.isArray(got) ? got : (got?.skills ?? [])
        answered++
        tried.push(v.label + '=' + arr.length)
        for (const sum of arr) {
          const name = String(sum?.name ?? '')
          if (!name || found.has(name)) continue
          // 记住这条是从哪个 opts 来的：list() 和 get() 必须用**同一套作用域**，
          // 否则列表有 11 条、正文却全是空（实测踩到：bodyTokens 全 0）。
          found.set(name, { sum, opts: v.opts })
        }
      } catch (e) {
        tried.push(v.label + '=抛错(' + String(e?.message ?? e).slice(0, 40) + ')')
      }
    }
    // 只打一次：作用域这件事出过一次无声的空列表，值得留证据
    if (!scopeProbed) {
      scopeProbed = true
      log?.('skills 作用域: 实时=' + (scope === undefined ? '无' : String(scope))
        + ' 层数=' + scopes.length + ' 尝试=[' + tried.join(', ') + '] 合计=' + found.size)
    }

    // ★ 一个候选都答不上来（全抛错）时，必须回到"不可用"这个诚实状态。
    // 逐级退让很容易写成"吞掉异常继续走"，那样坏的 provider 会被显示成
    // 「0 个」——看起来像"你没装技能"，而不是"读失败了"。实测被这条测试抓住过。
    if (answered === 0) {
      return { ...EMPTY, reason: '技能注册表读取失败：' + (tried.join('; ') || '未知原因'), error: true }
    }

    const summaries = [...found.values()]
    const items = []

    for (const entry of summaries) {
      const sum = entry.sum
      const name = String(sum?.name ?? '')
      if (!name) continue

      const catalogText = [sum.description, sum.whenToUse].filter(Boolean).join('\n')
      let bodyText = ''
      let bodyError = ''
      try {
        if (typeof s.get === 'function') {
          // 与 list() 用同一套 opts（含 scope）——少一个 scope 就整列读空
          const def = await withTimeout(s.get(name, entry.opts), 'skills.get')
          bodyText = String(def?.content ?? def?.body ?? def?.instructions ?? '')
        }
      } catch (e) {
        // 取不到正文不算失败：常驻成本仍然可以如实显示。
        bodyError = String(e?.message ?? e)
      }

      const inv = sum?.invocation ?? {}
      items.push({
        name,
        description: String(sum?.description ?? ''),
        whenToUse: String(sum?.whenToUse ?? ''),
        source: sourceOf(sum),
        modelInvocable: inv.modelInvocable !== false,
        userInvocable: inv.userInvocable !== false,
        catalogTokens: estimateTokens(name + '\n' + catalogText),
        bodyTokens: bodyText ? estimateTokens(bodyText) : 0,
        bodyKnown: Boolean(bodyText),
        bodyError,
        // 正文前 600 字符随目录一起带回去：展开某一行时不必再往返一次。
        // 600 字符 ≈ 230 token，十个技能也就 2K，比多开一条读路径划算。
        bodyPreview: bodyText.slice(0, 600),
      })
    }

    // 只打一次，证伪用：ctx.skills 是我没有亲手验证过的 API，字段名是从
    // dsh-skill 源码里读出来的。万一形状不对，这里直接把真实键名暴露出来，
    // 而不是让我对着一张空表猜。
    if (!probed) {
      probed = true
      const first = summaries[0]?.sum
      log?.('skills 探针: ' + items.length + ' 个技能, 首个真实键=[' + Object.keys(first ?? {}).join(',') + ']')
    }

    items.sort((a, b) => b.catalogTokens - a.catalogTokens || a.name.localeCompare(b.name))

    return {
      available: true,
      reason: '',
      items,
      totals: {
        count: items.length,
        catalogTokens: items.reduce((n, i) => n + i.catalogTokens, 0),
        bodyTokens: items.reduce((n, i) => n + i.bodyTokens, 0),
        modelInvocable: items.filter(i => i.modelInvocable).length,
      },
      capturedAt: new Date().toISOString(),
    }
  }

  /** 带 TTL 缓存的快照。并发调用共享同一次采集，避免 UI 轮询把磁盘打爆。 */
  async function snapshot({ fresh = false } = {}) {
    const now = Date.now()
    if (!fresh && cache && now - cache.at < ttlMs) return cache.data
    if (inflight) return inflight
    inflight = (async () => {
      try {
        const data = await collect()
        cache = { at: Date.now(), data }
        return data
      } catch (e) {
        const msg = String(e?.message ?? e)
        log?.('skills 盘点失败（非致命）: ' + msg)
        // 失败也要缓存，但短一些——否则一个坏掉的 provider 会被 UI 反复重试。
        const data = { ...EMPTY, reason: msg, error: true }
        cache = { at: Date.now() - ttlMs + 5000, data }
        return data
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  return { snapshot, estimateTokens }
}
