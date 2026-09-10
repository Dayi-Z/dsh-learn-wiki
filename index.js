// dsh-learn-wiki —— DSH 的「边做边学」知识库插件。
//
// 三条设计铁律（来自架构评审）：
//   1. 自动的不阻塞，阻塞的必须显式。
//      自动注入走 pre-step；自动补料走 turn/end 之后的后台 worker；
//      真正"现在就要"的检索由模型显式调 wiki_recall，那一次阻塞天经地义。
//   2. staged/ 永不参与召回。这是投毒防线——自动产出必须经 commit 才升入 L1。
//   3. 无 sources 不 commit。每条知识必须可溯源到 URL / 文件。
//
// 与既有 hindsight 插件的关系：不重复实现 L2。
// 现有 hindsight 插件已经负责情景记忆的每轮 recall；本插件只管 L1（Markdown wiki）、
// 未命中判定，以及 L3 联网补料。避免两套注入互相打架。
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage as hostCreateUserMessage } from '@deepseek-ai/dsh-llm'
import { loadConfig, DEFAULTS } from './lib/config.js'
import { loadPages, ensureRepo } from './lib/wiki.js'
import { buildCorpus, scoreQuery, triage, recallable, looksLikeGap } from './lib/recall.js'
import { appendGap, runAcquisition } from './lib/acquire.js'
import { createLlm } from './lib/llm.js'
import { createLogger } from './lib/log.js'
import { createStruggleTracker, recordStruggle, symptomQuery } from './lib/struggle.js'
import { createCapabilityManager } from './lib/capabilities.js'
import { loadUsage, saveUsage, recordHit, recordConfirmed, recordSuspect, usageLabel } from './lib/usage.js'
import { registerTools } from './lib/tools.js'

export const name = 'dsh-learn-wiki'
export const inject = ['tools', 'llm', 'web']

/**
 * 构造注入用的 user 消息。
 * 优先用宿主自己的 createUserMessage（保证消息形状与宿主版本一致）；
 * 若导入失败或形状漂移，退化为最小可用形状，而不是让整轮崩掉。
 */
function buildUserMessage(text, source) {
  const payload = { content: [{ type: 'text', text }], source: source ?? { kind: 'plugin', plugin: name } }
  try {
    if (typeof hostCreateUserMessage === 'function') return hostCreateUserMessage(payload)
  } catch (e) {
    console.warn('[dsh-learn-wiki] createUserMessage failed, using minimal shape:', e?.message ?? e)
  }
  return { role: 'user', ...payload }
}

const HINDSIGHT_MARK = '<hindsight_knowledge>'
/**
 * 把 hindsight 的注入块换成短指针。
 *
 * 为什么：该块约 1,900 字符，其中 TOOL_GUIDE 逐条重述了 8 个工具的用途，
 * 而那些描述**已经在工具 schema 里**（那 8 个工具本身占 1,285 token）。
 * 纯重复，而且它的知识页清单目前还是坏的（永远显示"No knowledge pages yet"）。
 *
 * 保留一行指针的原因是：工具 schema 只说明"怎么用"，不说明"现在该用"。
 * 那一句时机提示是有价值的，所以留 ~50 token 而不是全删。
 */
/**
 * 把刚补到的知识投递进**当前这一轮**。
 *
 * 这是整个闭环的最后一环，也是最初那句诉求的落点：
 * "agent 反复修改走进死胡同，永远不会去网上搜一下有没有更简单的方法"。
 *
 * 机制：agent.inject() 把消息排进 next-step 上下文，运行中的驱动器会在
 * 最近的后续 pre-step 边界领取 —— 所以模型在**自己下一步**就看到，
 * 而不是等下一轮。这是唯一能真正打断循环的时点。
 *
 * 关于 staged：两段式设计让 staged 不参与**自动召回**（防投毒）。
 * 但挣扎时的主动投递是另一回事 —— 等人来 commit 意味着循环继续。
 * 所以照投，但**明确标注未核实**，让模型自己判断可信度。
 */
async function deliverToCurrentTurn(agent, page, log) {
  if (!agent || typeof agent.inject !== 'function') {
    log('deliver: agent.inject 不可用，跳过')
    return false
  }
  const body = String(page.body ?? '').trim().slice(0, 1800)
  const src = (page.sources ?? []).slice(0, 3).join('\n  ')
  const text = [
    '<system-reminder>',
    '你似乎在同一处反复尝试。下面是刚从网络上找到的相关资料，**尚未核实、未提交审核**，仅供你判断参考：',
    '',
    '## ' + page.title,
    body,
    '',
    src ? '来源:\n  ' + src : '',
    '',
    '如果与当前情况不符，忽略它并继续你自己的判断。',
    '</system-reminder>',
  ].filter(Boolean).join('\n')
  try {
    agent.inject(buildUserMessage(text, { kind: 'plugin', plugin: name }))
    log('deliver: 已投递到当前轮 -> ' + page.id)
    return true
  } catch (e) {
    log('deliver failed (non-fatal):', e?.message ?? e)
    return false
  }
}

const HINDSIGHT_COMPACT = HINDSIGHT_MARK
  + '本仓库有 Hindsight 长期记忆与知识页。回答项目相关问题前先用 hindsight_search_knowledge_pages 检索并引用页面；'
  + '开始非平凡任务前用 hindsight_list_knowledge_pages 看项目已知什么。详见各 hindsight_* 工具的 schema。'
  + '</hindsight_knowledge>'

function compactHindsight(messages) {
  let changed = false
  const out = messages.map((m) => {
    const parts = m?.content
    if (!Array.isArray(parts)) return m
    let hit = false
    const next = parts.map((p) => {
      if (p && p.type === 'text' && typeof p.text === 'string' && p.text.includes(HINDSIGHT_MARK)) {
        hit = true
        return { ...p, text: HINDSIGHT_COMPACT }
      }
      return p
    })
    if (!hit) return m
    changed = true
    // 保留原来源归属，只换正文
    return buildUserMessage(HINDSIGHT_COMPACT, m.source)
  })
  return changed ? { messages: out, changed: true } : { messages, changed: false }
}

/**
 * 剥掉注入块再当查询用。
 *
 * 为什么：注入的 <system-reminder> / <hindsight_knowledge> 是"系统说的话"，
 * 不是"用户问的问题"。拿它们去检索会污染打分，而且我们自己的注入会被
 * 下一轮再检索一次——一个自我强化的回环。
 */
function stripInjected(text) {
  return String(text ?? '')
    .replace(/<hindsight_knowledge>[\s\S]*?<\/hindsight_knowledge>/g, ' ')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/<[a-z_]+_knowledge>[\s\S]*?<\/[a-z_]+_knowledge>/g, ' ')
    .trim()
}

/** 从已领取的用户消息里抽出纯文本查询。 */
function queryFrom(messages) {
  const parts = []
  for (const m of messages ?? []) {
    const content = m?.content
    if (typeof content === 'string') { parts.push(content); continue }
    if (Array.isArray(content)) {
      for (const p of content) if (p && p.type === 'text' && typeof p.text === 'string') parts.push(p.text)
    }
  }
  return stripInjected(parts.join('\n')).slice(0, 1500)
}

/** 渲染注入块：hit 给正文（可信），weak 只给标题索引（低置信，按需自取）。 */
function renderInjection(t, cfg) {
  const L = []
  L.push('<system-reminder>')
  if (t.hit.length) {
    L.push('L1 知识库命中以下已固化知识（可直接采信，引用时标注 id）：')
    let used = 0
    for (const h of t.hit.slice(0, cfg.maxInjectPages)) {
      const p = h.page
      const block = `\n### [${p.id}] ${p.title}\n（${p.category}, confidence ${p.confidence}, 来源 ${p.sources.length} 条）\n${p.body.trim()}`
      if (used + block.length > cfg.maxInjectChars) break
      used += block.length
      L.push(block)
    }
  }
  if (t.weak.length) {
    L.push('\n以下条目弱相关且置信度较低，**不要直接采信**；需要时用 wiki_recall 取全文自行判断：')
    for (const h of t.weak.slice(0, cfg.maxInjectPages)) L.push(`- [${h.page.id}] ${h.page.title} (score ${h.score})`)
  }
  L.push('\n这些来自项目自己的知识库（dsh-wiki）。与当前任务无关就忽略。')
  L.push('</system-reminder>')
  return L.join('\n')
}

export function apply(ctx, pluginConfig = {}) {
  const baseRoot = pluginConfig?.wikiRoot || DEFAULTS.wikiRoot
  // 挣扎检测器跑在 tools/result 的同步回调里，那里没法 await 配置。
  // 所以维护一份"活的"配置快照：getCfg 每次解析后原地更新它，
  // 检测器始终读到最新阈值（阈值调了不用重启）。
  const liveCfg = { ...DEFAULTS, wikiRoot: baseRoot }
  const getCfg = async () => {
    const c = await loadConfig(baseRoot, pluginConfig)
    Object.assign(liveCfg, c)
    return c
  }
  const llm = createLlm(ctx, { provider: pluginConfig?.llmProvider, model: pluginConfig?.llmModel })
  const tracker = createStruggleTracker(liveCfg)
  const caps = createCapabilityManager({ ctx, getCfg: () => liveCfg, log: (...a) => log(...a) })

  // 每会话的注入去重（KV cache 友好）：内容不变则不再重复注入
  const injectedDigest = new WeakMap()
  // agent -> 最近一次用户查询。挣扎时用它给症状查询补一点任务上下文。
  const lastQuery = new WeakMap()
  // 后台补料互斥 + 冷却
  let acquiring = false
  let lastAcquire = 0
  // 最近一个卡住的 agent。补料是异步的，完成时要把结果投回它那一轮。
  let strugglingAgent = null
  // 补料进行中又来了新请求 -> 结束后补跑一次
  let rerunAfterAcquire = false

  // 证据采集：agentId -> { pages:Set, struggled:boolean }
  //   命中不算确认。确认要看这一轮后来**有没有再挣扎**。
  //   命中后仍挣扎 = 疑似有害知识 —— 这是自动沉淀最致命、也最可测的盲区。
  const turnInjections = new Map()

  // 落盘日志：桌面版里插件 stdout 基本不可见，诊断只能靠文件
  const log = createLogger(baseRoot)

  // ── 工具注册 ──
  ctx.effect(() => {
    // 传 getCfg 而不是快照：每次工具调用都重读配置，wiki.config.json 热生效
    const dispose = registerTools(ctx, { getCfg, llm, caps, log })
    return () => { try { dispose() } catch { /* noop */ } }
  }, 'dsh-learn-wiki: tools')

  // ── 系统提示词：告知模型这套能力的存在 ──
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: 'app:dsh-learn-wiki',
      order: -95,
      text: () => 'The dsh-learn-wiki plugin maintains a curated Markdown knowledge base (L1) of durable project knowledge. '
        + 'Relevant pages are injected automatically before a turn when they exist. '
        + 'Use wiki_recall to explicitly search it before answering project questions; '
        + 'use wiki_learn to record durable, non-obvious findings (always with sources); '
        + 'use wiki_review to inspect pending staged pages and unanswered gaps; '
        + 'use wiki_commit to promote a staged page into the knowledge base after verifying it. '
        + 'Never commit a page without sources.',
    })
  })

  // ── 能力包装配 ──
  // agent/created 在作用域 setup 之后、驱动器启动之前触发，
  // 所以掩码能赶上第一次提示词组装。每个 agent 只装一次。
  ctx.on('agent/created', ({ agent }) => {
    try { caps.ensure(agent) } catch (e) { log('capabilities hook failed (non-fatal):', e?.message ?? e) }
  })

  // ── 挣扎检测：真正的触发器 ──
  // 为什么不是"检索未命中"：那个信号太廉价，任何新话题都会未命中，
  // 于是为每件新鲜事都去联网。真正值钱的是"卡住了"——稀有、昂贵、
  // 且必须当场兑现。
  //
  // 这里刻意只做**观测**（observe 模式）：先记录它什么时候报警、报得准不准，
  // 观察够了再开自动联网。理由很简单——这一轮开发里我已经数次用想象
  // 替代证据，不能再犯。
  ctx.on('tools/result', (exec, result) => {
    try {
      const agent = exec?.agent
      if (!agent) return                       // 无 agent 的调用没有需要提醒的模型
      const fired = tracker.observe(agent, exec, result)
      if (fired.length === 0) return
      log('struggle: ' + fired.map(f => f.type + '×' + f.count).join(', ') + '  (' + (fired[0].detail ?? '') + ')')

      // ★ 最有价值的一类证据：这一轮的注入**没能阻止**挣扎。
      // 那条知识要么没用，要么有害。降权它（不是删除 —— 降权可逆）。
      const inj = agent.id ? turnInjections.get(agent.id) : null
      if (inj && !inj.struggled && inj.pages.size > 0) {
        inj.struggled = true
        void loadUsage(liveCfg.wikiRoot)
          .then(u => { recordSuspect(u, [...inj.pages]); return saveUsage(liveCfg.wikiRoot, u) })
          .then(() => log('usage: 记为嫌疑 ' + [...inj.pages].join(',')))
          .catch((e) => log('usage suspect failed (non-fatal):', e?.message ?? e))
      } else if (agent.id && !inj) {
        // 没注入过就没得判 —— 不要伪造证据
      }
      void recordStruggle(liveCfg.wikiRoot, {
        ts: new Date().toISOString(),
        sessionId: agent.id ?? '',   // 必须是字符串：undefined 会让工具输出非 lossless JSON
        mode: liveCfg.struggleMode,
        signals: fired,
      })
      if (liveCfg.struggleMode === 'active'
          && (liveCfg.gapTrigger === 'struggle' || liveCfg.gapTrigger === 'both')) {
        // 把挣扎翻译成**症状查询**再登记 —— 不是用户的原话。
        // 原话是意图（"ok 按你的倾向来"），搜索引擎只能给出噪声；
        // 症状（报错文本、改不动的文件、反复失败的工具）才是网上真有人写过的。
        const q = symptomQuery(fired, lastQuery.get(agent) ?? '')
        if (q && q.length >= 6) {
          log('struggle -> gap: ' + q.slice(0, 90))
          // 记住是哪个 agent 卡住了 —— 补料完成后要把结果投递回**它**的这一轮
          strugglingAgent = agent
          void appendGap(liveCfg.wikiRoot, { query: q, score: 0, sessionId: agent.id ?? '' })
            .then(() => scheduleAcquire())   // 立刻推一次，不等轮次结束
            .catch((e) => log('struggle gap failed (non-fatal):', e?.message ?? e))
        }
      }
    } catch (e) {
      log('struggle observer failed (non-fatal):', e?.message ?? e)
    }
  })

  // ── 旋钮 A：工作前自动注入（命中则注入；未命中则记 gap）──
  ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
    // let（不是 const）：压缩 hindsight 块时要替换整个决策对象
    let decision = await next()
    let cfg
    try { cfg = await getCfg() } catch { return decision }
    if (!cfg.enabled) return decision
    // 用户新提示词到达 = 新任务，上一轮的挣扎不该污染这一次的判定
    // 压缩 hindsight 注入块：它在 prepend 的钩子里已进入批次，这里后处理
    if (liveCfg.compactHindsightBlock !== false && decision.messages?.length) {
      const c = compactHindsight(decision.messages)
      if (c.changed) {
        decision = { ...decision, messages: c.messages }
        log('compact: hindsight 注入块已压缩为指针')
      }
    }

    // 能力包在**每一步** ensure（幂等：装好后立即返回）。
    //
    // 为什么不能只在 step===1：find_tools 登记放宽后，需要**下一步**就重算完，
    // 否则同一轮内后续的 step 仍然看不到被找回的工具 —— 实测就是这样，
    // 放宽登记了却始终不生效。pre-step 在提示词组装之前，所以这里重算能赶上本步请求。
    try { caps.ensure(agent) } catch (e) { log('capabilities ensure failed (non-fatal):', e?.message ?? e) }

    if (step === 1) tracker.reset(agent)
    if (step !== 1) return decision                                  // 每轮第一步 = "工作前"
    if (decision.kind === 'reject') return decision
    if (!decision.messages || decision.messages.length === 0) return decision

    // 兜底触发：即使 session/event 那条路因宿主版本差异失效，
    // 补料仍会在下一轮开始时被推动。acquiring 锁 + 冷却保证不会重复烧钱。
    scheduleAcquire()

    const query = queryFrom(messages)
    if (!query || query.length < 4) return decision
    lastQuery.set(agent, query.slice(0, 200))

    try {
      if (!(await repoExistsSafe(cfg.wikiRoot))) await ensureRepo(cfg.wikiRoot)
      const { pages } = await loadPages(cfg.wikiRoot)
      // 自动注入路径：跳过被隔离的页（嫌疑 >= N 且多于确认）
      const usage = await loadUsage(cfg.wikiRoot)
      const pool = recallable(pages, {
        minConfidence: cfg.minConfidence,
        usage: usage.pages,
        policy: cfg.usagePolicy,
      })
      if (pool.length === 0) return decision
      const corpus = buildCorpus(pool)
      // 排序 = 相似度 × 强化因子（无证据时因子为 1，阈值语义不变）
      const hits = scoreQuery(corpus, query, { stats: usage.pages })
      const t = triage(hits, cfg)
      signal?.throwIfAborted?.()

      if (t.bucket === 'miss') {
        // 旋钮 B2：只入队，绝不在此处阻塞去联网。
        // 但寒暄类短输入不是知识缺口，记进去只会污染队列并触发无意义联网。
        // 触发器开关：默认只认"卡住了"，不再因为"检索未命中"就补料。
        // 实测 19 条 gap 全是对话原话，零真缺口 —— 那个信号的噪声率是 100%。
        const missTriggerOn = cfg.gapTrigger === 'miss' || cfg.gapTrigger === 'both'
        if (missTriggerOn && cfg.autoAcquire && looksLikeGap(query, { minChars: cfg.minGapQueryChars })) {
          await appendGap(cfg.wikiRoot, { query, score: t.best, sessionId: agent?.id })
          log('gap recorded, bucket=miss score=' + t.best)
        }
        return decision
      }

      const text = renderInjection(t, cfg)
      if (cfg.injectOncePerSession && injectedDigest.get(agent) === text) return decision
      injectedDigest.set(agent, text)

      const msg = buildUserMessage(text)
      const lastClaimed = decision.messages.findLastIndex(m => m && messages && messages.includes(m))
      const at = lastClaimed >= 0 ? lastClaimed + 1 : decision.messages.length

      // hits = liveness，两个桶都算（"这条被检索到过吗"）
      const allInjected = [...t.hit, ...t.weak].map(h => h.page.id)
      // 但**确认/嫌疑只认 hit 桶**。
      // 实测教训：weak 桶注入时我们明确写了"弱相关，不要直接采信" ——
      // 那么模型后来挣扎就不是它的责任。第一次真实触发时，
      // 一条被标为 weak 的页因为后续挣扎被判成"疑似有害"，
      // 那是错的归因。只有我们说过"可直接采信"的页，才为后续结果负责。
      const trustedIds = t.hit.map(h => h.page.id)
      recordHit(usage, allInjected)
      void saveUsage(cfg.wikiRoot, usage).catch(() => {})
      if (agent?.id) turnInjections.set(agent.id, { pages: new Set(trustedIds), struggled: false })

      log('inject bucket=' + t.bucket + ' best=' + t.best + ' hit=' + t.hit.length + ' weak=' + t.weak.length)
      return { kind: 'enter', messages: decision.messages.toSpliced(at, 0, msg) }
    } catch (e) {
      log('pre-step recall failed (non-fatal):', e?.message ?? e)
      return decision
    }
  })

  // ── 旋钮 B2：轮次结束后后台补料（非阻塞）──
  const scheduleAcquire = () => {
    setTimeout(() => { void acquireNow('turn-end') }, 0)
  }
  const acquireNow = async (why) => {
    // 正在补料时不能直接丢弃这次的请求 —— 那样"卡住时正好有补料在跑"
    // 就会让这次挣扎白登记（gap 留着但没人处理，也不会投递）。
    // 记一个待办，等当前这轮结束后自动再跑一次。
    if (acquiring) { rerunAfterAcquire = true; return }
    let cfg
    try { cfg = await getCfg() } catch { return }
    if (!cfg.enabled || !cfg.autoAcquire) return
    const now = Date.now()
    if (now - lastAcquire < cfg.acquireCooldownMs) return
    acquiring = true
    lastAcquire = now
    // 本轮卡住的那个 agent（可能被 turn/end 的调用抢先，所以用模块级变量记住）
    const target = strugglingAgent
    strugglingAgent = null
    let consumed = false
    try {
      const summary = await runAcquisition({
        ctx, llm, repoRoot: cfg.wikiRoot, cfg, log,
        // 投递：把刚蒸馏出来的页面推进**正在进行的那一轮**
        onStaged: target ? (page) => deliverToCurrentTurn(target, page, log) : null,
      })
      consumed = summary.considered > 0
      if (summary.considered > 0) log('background acquisition (' + why + '):', JSON.stringify({ considered: summary.considered, staged: summary.staged, skipped: summary.skipped, errors: summary.errors }))
    } catch (e) {
      log('background acquisition failed (non-fatal):', e?.message ?? e)
    } finally {
      // 一次都没处理到东西，就把 agent 还回去 —— 否则"空跑一次"会把它吃掉，
      // 紧接着那次真正处理 gap 的补料就拿不到投递目标了（实测踩到）。
      if (!consumed && target) strugglingAgent = target
      acquiring = false
      if (rerunAfterAcquire) {
        rerunAfterAcquire = false
        log('acquire: 补跑一次（期间有新的挣扎登记）')
        setTimeout(() => { void acquireNow('rerun') }, 0)
      }
    }
  }
  // 轮次边界是「持久 session/event」，不是可 ctx.on 的 live 事件。
  // 早先写成 ctx.on('turn/end', ...) 不会报错、也永远不触发 ——
  // 整个 L3 补料路径因此是死的（gap 永远停在 pending）。
  // 正确签名是 (session, event)，事件类型在 event.type 上。
  try {
    ctx.on('session/event', (session, event) => {
      if (!event || event.type !== 'turn/end') return
      // ★ 该轮没有挣扎 -> 本轮注入的知识算一次**弱确认**。
      // 这不是"它是对的"的证明，只是"它没坏事"的证据 —— 所以叫弱确认，
      // 而且只用来做排序加权，不当作提交依据。
      if (turnInjections.size > 0) {
        const toConfirm = []
        for (const [agentId, rec] of turnInjections.entries()) {
          if (!rec.struggled && rec.pages.size > 0) toConfirm.push(...rec.pages)
          turnInjections.delete(agentId)
        }
        if (toConfirm.length > 0) {
          void loadUsage(liveCfg.wikiRoot)
            .then(u => { recordConfirmed(u, toConfirm); return saveUsage(liveCfg.wikiRoot, u) })
            .then(() => log('usage: 记为确认 ' + toConfirm.join(',')))
            .catch((e) => log('usage confirm failed (non-fatal):', e?.message ?? e))
        }
      }
      scheduleAcquire()
    })
  } catch (e) { log('session/event hook unavailable:', e?.message ?? e) }
}

async function repoExistsSafe(root) {
  try { const { repoExists } = await import('./lib/wiki.js'); return repoExists(root) } catch { return false }
}

export default { name, apply, inject }
