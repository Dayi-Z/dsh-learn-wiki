// 所有需要调用模型的环节都从这里走 —— 一个入口，一处可配。
//
// ── 为什么要有这一层 ──
//
// 之前 createLlm 只在 apply() 时解析**一次**路由，并把结果永久缓存（routePromise）。
// 后果有三个，都是实测出来的：
//
//   1. 换模型必须重载插件。而 wiki.config.json 里明明有 llmProvider/llmModel 两个键
//      —— 它们读的是 apply() 的第二参数，**不是配置文件**，所以写进 JSON 根本没反应。
//      这是一个"配了但没生效、而且不报错"的坑。
//   2. 只有一条路由。后台补料（蒸馏）和会话提炼（harvest）用同一个模型，
//      而这两件事对模型的要求并不一样。
//   3. 换不了、也就测不了："哪个模型蒸馏得更好"没法用数据回答。
//
// 现在：mode=single 用列表里的第一个；mode=rotate 每次调用换下一个。
// 两者都可配，且**每次调用重读配置** —— 改完 JSON 立刻生效，不用重载。
//
// ── 站点 ──
//
// 每个调用点声明自己是哪个 site，于是"哪些环节用了哪个模型"是可回答的。
// 站点列表是**显式**的：加一个调用点就要来这里加一行，否则它会被归到 default，
// 而 default 在界面上是看得见的 —— 不会悄悄用上一个谁也没配过的模型。
export const SITES = ['distill', 'harvest']

/** 站点的人话名字。界面直接显示，不再各自翻译一份。 */
export const SITE_LABEL = {
  distill: '蒸馏（联网补料）',
  harvest: '提炼（会话）',
  default: '默认',
}

/**
 * 把配置里的一个模型条目解析成 { provider, model }。
 *
 * 三种写法都收，因为这是一个人手编辑的 JSON 文件：
 *   "deepseek/deepseek-chat"   provider + model
 *   "deepseek"                 只有 provider（model 取该 provider 列出的第一个）
 *   { provider, model }        显式对象
 * 解析不出来返回 null（调用方负责丢掉），**不抛** —— 配置文件里多写一行
 * 不该让整个插件加载失败。
 */
export function parseModelSpec(x) {
  if (x === null || x === undefined) return null
  if (typeof x === 'string') {
    const s = x.trim()
    if (!s) return null
    const i = s.indexOf('/')
    if (i < 0) return { provider: s, model: '' }
    return { provider: s.slice(0, i).trim(), model: s.slice(i + 1).trim() }
  }
  if (typeof x === 'object' && !Array.isArray(x)) {
    const provider = String(x.provider ?? '').trim()
    const model = String(x.model ?? '').trim()
    if (!provider && !model) return null
    return { provider, model }
  }
  return null
}

/** 把任意输入收敛成一份**可执行**的 llm 配置：mode/models/onError 三件套。 */
function normalizeBlock(raw) {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {}
  const models = Array.isArray(r.models) ? r.models.map(parseModelSpec).filter(Boolean) : []
  return {
    // 认不出来的 mode 一律退回 single：轮换是**主动选择**的行为，
    // 不该因为一个拼错的字符串就悄悄开始轮换。
    mode: r.mode === 'rotate' ? 'rotate' : 'single',
    // onError 反过来：默认 next（换下一个再试），因为后台补料失败一次
    // 就丢掉一次采集机会；要"只问一个、失败就认"就显式写 fail。
    onError: r.onError === 'fail' ? 'fail' : 'next',
    models,
  }
}

/**
 * 归一化整个 llm 配置块。
 *
 * legacy 是旧的 llmProvider/llmModel 两个键 —— 保留它们是为了不让已有的
 * wiki.config.json 静默失效。**并且这次真的读配置文件了**（以前只读 apply 参数）。
 * 只有在 models 为空时才采纳 legacy：显式写了 models 就以 models 为准，
 * 否则"删掉旧键"和"新键生效"两件事会互相打架。
 */
export function normalizeLlmConfig(raw, legacy = {}) {
  const base = normalizeBlock(raw)
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {}
  if (base.models.length === 0) {
    const lp = String(legacy?.provider ?? '').trim()
    const lm = String(legacy?.model ?? '').trim()
    if (lp || lm) base.models = [{ provider: lp, model: lm }]
  }
  const sites = {}
  const rs = (r.sites && typeof r.sites === 'object' && !Array.isArray(r.sites)) ? r.sites : {}
  for (const k of Object.keys(rs)) {
    const b = normalizeBlock(rs[k])
    // 站点块只覆盖它**写了**的部分：只想给 harvest 指定一个模型，
    // 不必把 mode/onError 再抄一遍。
    const rawB = (rs[k] && typeof rs[k] === 'object') ? rs[k] : {}
    const part = {}
    if (rawB.mode !== undefined) part.mode = b.mode
    if (rawB.onError !== undefined) part.onError = b.onError
    if (rawB.models !== undefined) part.models = b.models
    if (Object.keys(part).length) sites[k] = part
  }
  return { mode: base.mode, models: base.models, onError: base.onError, sites }
}

/**
 * 建一个带站点、可轮换的 LLM 客户端。
 *
 * 与宿主的契约（实测确认，别照猜）：
 *   ctx.llm.listProviders() -> [{ id, name }]
 *   ctx.llm.listModels(id)  -> [{ provider, id, name }]   ★ 收**字符串 id**，不是 provider 对象
 *   ctx.llm.stream({ provider, model, messages, system, temperature, maxTokens })
 */
export function createLlm(ctx, { getCfg, log = () => {} } = {}) {
  const llm = ctx?.llm
  /** 轮换游标：site -> 下一次从第几个候选开始。取消配置后不会漂。 */
  const cursor = new Map()
  /** 每个站点**真正用过**的最后一次路由。界面显示的是它，不是"配置里写了什么"。 */
  const lastUsed = new Map()
  let providersCache = { at: 0, list: [] }
  const modelCache = new Map()
  /** 列模型可能打网络，不能每次调用都列。 */
  const TTL = 30000

  const fresh = (at) => Date.now() - at < TTL

  async function providers() {
    if (providersCache.list.length && fresh(providersCache.at)) return providersCache.list
    let list = []
    try {
      const got = typeof llm?.listProviders === 'function' ? llm.listProviders() : []
      if (Array.isArray(got)) list = got.filter(p => p && typeof p.id === 'string' && p.id)
    } catch (e) { log('llm: listProviders 失败 ' + (e?.message ?? e)) }
    providersCache = { at: Date.now(), list }
    return list
  }

  async function modelsOf(pid) {
    const c = modelCache.get(pid)
    if (c && fresh(c.at)) return c.models
    let models = []
    try {
      const got = await llm.listModels(pid)
      if (Array.isArray(got)) models = got.filter(m => m && typeof m.id === 'string' && m.id)
    } catch { /* 列不出模型不是错误：适配器允许接受未列出的 id */ }
    modelCache.set(pid, { at: Date.now(), models })
    return models
  }

  /** 应用站点覆盖，得到这个站点**实际生效**的配置。 */
  async function effective(site) {
    let cfg = {}
    try { cfg = (await getCfg()) ?? {} } catch (e) { log('llm: 读配置失败 ' + (e?.message ?? e)) }
    const norm = normalizeLlmConfig(cfg.llm, { provider: cfg.llmProvider, model: cfg.llmModel })
    const ov = norm.sites[site]
    return ov ? { ...norm, ...ov } : norm
  }

  /**
   * 算出这次调用可以问哪些模型（有序），以及哪些配置项**被丢掉了、为什么**。
   * rejected 必须报出去：一个写错 provider 名字的条目如果悄悄消失，
   * 用户会以为轮换在用三个模型，实际只有一个。
   */
  async function plan(site) {
    const eff = await effective(site)
    const regs = await providers()
    const ids = new Set(regs.map(p => p.id))
    const candidates = []
    const rejected = []
    for (const m of eff.models) {
      if (!m.provider) { candidates.push({ provider: '', model: m.model, auto: true }); continue }
      if (!ids.has(m.provider)) { rejected.push({ ...m, why: 'provider 未注册' }); continue }
      candidates.push({ ...m })
    }
    if (candidates.length === 0) {
      // 跟随宿主默认：挑第一个列得出模型的 provider。列不出模型的（适配器允许）
      // 再退到"用 provider id 当模型 id"——这是本插件一直以来的兜底，实测可用。
      for (const p of regs) {
        const ms = await modelsOf(p.id)
        if (ms.length) { candidates.push({ provider: p.id, model: ms[0].id, auto: true }); break }
      }
      if (candidates.length === 0 && regs.length) candidates.push({ provider: regs[0].id, model: regs[0].id, auto: true })
    }
    return { mode: eff.mode, onError: eff.onError, candidates, rejected, configured: eff.models.length > 0, available: regs }
  }

  /** 把 { provider, model:'' } 补全成具体模型（取该 provider 列出的第一个）。 */
  async function concretize(c) {
    if (!c) return null
    if (!c.provider) {
      const regs = await providers()
      const p = regs[0]
      if (!p) return null
      const ms = await modelsOf(p.id)
      return { provider: p.id, model: ms[0]?.id ?? p.id, auto: true }
    }
    if (c.model) return { provider: c.provider, model: c.model, auto: !!c.auto }
    const ms = await modelsOf(c.provider)
    return { provider: c.provider, model: ms[0]?.id ?? c.provider, auto: !!c.auto }
  }

  /** 只看不改：给诊断和界面用。**绝不推进轮换游标**。 */
  async function route(site = SITES[0]) {
    const p = await plan(site)
    const n = p.candidates.length
    const start = p.mode === 'rotate' && n ? (cursor.get(site) ?? 0) % n : 0
    const next = n ? await concretize(p.candidates[start]) : null
    // 同样给副本：route() 的输出会和 used() 的输出一起进同一个 JSON。
    const raw = lastUsed.get(site)
    const at = raw ? { ...raw } : null
    return {
      site,
      siteLabel: SITE_LABEL[site] ?? site,
      mode: p.mode,
      onError: p.onError,
      configured: p.configured,
      candidates: p.candidates.map(c => (c.provider ? c.provider + '/' + (c.model || '(第一个)') : '(跟随宿主默认)')),
      rejected: p.rejected,
      next,
      lastUsed: at,
    }
  }

  return {
    /** 供诊断：某站点**下一次**会问谁、以及上一次实际问了谁。 */
    route,
    /**
     * 最近一次**实际**用过的路由。刻意不做任何枚举（不列 provider、不列模型），
     * 所以可以放进每 8 秒被轮询一次 /api/state —— 而 route() 不行。
     *
     * ★ 必须返回**副本**。返回内部对象本身的话，同一个引用会同时出现在
     *   wiki_acquire 的 routes 与 used 两处，而 json-safe 用 WeakSet 按对象身份
     *   判重（它分不清"共享引用"和"真环"），于是把 used.distill 判成 circular
     *   并置空 —— 一次静默的诊断降级，还会在每次调用时打一行 warning。
     */
    used(site) {
      const v = lastUsed.get(site)
      return v ? { ...v } : null
    },
    /** 所有站点的路由快照。 */
    async routes(sites = SITES) {
      const out = {}
      for (const s of sites) { try { out[s] = await route(s) } catch (e) { out[s] = { site: s, error: String(e?.message ?? e) } } }
      return out
    },
    async chat({ site = 'distill', system, prompt, maxTokens = 2048, temperature = 0.2 } = {}) {
      if (!llm || typeof llm.stream !== 'function') throw new Error('DSH 未提供 ctx.llm.stream')
      const p = await plan(site)
      const n = p.candidates.length
      if (n === 0) throw new Error('DSH 未注册任何可用的 LLM provider')
      if (p.rejected.length) {
        log('llm[' + site + ']: 丢掉 ' + p.rejected.length + ' 个配置项 —— ' + JSON.stringify(p.rejected))
      }
      const start = p.mode === 'rotate' ? (cursor.get(site) ?? 0) % n : 0
      // onError=next 时把列表走完再认输；fail 时只问第一个。
      const attempts = p.onError === 'next' ? n : 1
      const failures = []
      for (let i = 0; i < attempts; i++) {
        const idx = p.mode === 'rotate' ? (start + i) % n : Math.min(i, n - 1)
        const r = await concretize(p.candidates[idx])
        if (!r) continue
        try {
          const stream = llm.stream({
            provider: r.provider,
            model: r.model,
            messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
            system,
            temperature,
            maxTokens,
          })
          let text = ''
          for await (const chunk of stream) {
            // 流中途失败也要能被接住 —— 半截输出当成功会更糟：它会被当成
            // 一次完整的蒸馏结果去解析 JSON，然后以"模型没按格式输出"的样子失败。
            if (chunk && chunk.type === 'error') throw new Error(String(chunk.error?.message ?? chunk.error ?? 'stream error'))
            if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
          }
          if (p.mode === 'rotate') cursor.set(site, (start + i + 1) % n)
          lastUsed.set(site, { provider: r.provider, model: r.model, at: new Date().toISOString(), tries: i + 1 })
          if (i > 0 || failures.length) {
            log('llm[' + site + ']: 第 ' + (i + 1) + ' 个候选成功 ' + r.provider + '/' + r.model
              + (failures.length ? '（前面失败：' + failures.join(' | ') + '）' : ''))
          }
          return text
        } catch (e) {
          const why = r.provider + '/' + r.model + ': ' + String(e?.message ?? e)
          failures.push(why)
          log('llm[' + site + ']: 调用失败 ' + why)
          // 轮换模式下失败也算"用过了"：否则一个坏模型会被无限重试，
          // 每次调用都先浪费一轮超时。
          if (p.mode === 'rotate') cursor.set(site, (start + i + 1) % n)
        }
      }
      throw new Error('所有候选模型都失败了：' + failures.join(' | '))
    },
  }
}

/** 从模型输出里抠出第一个 JSON 对象——容忍 ```json 围栏和前后废话。 */
export function extractJson(text) {
  const s = String(text ?? '')
  const fenced = s.match(/```(?:json)?s*([sS]*?)```/)
  const candidates = []
  if (fenced) candidates.push(fenced[1])
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start !== -1 && end > start) candidates.push(s.slice(start, end + 1))
  for (const c of candidates) {
    try { const v = JSON.parse(c); if (v && typeof v === 'object') return v } catch { /* 试下一个 */ }
  }
  return null
}
