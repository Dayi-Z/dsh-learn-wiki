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
import { createStruggleTracker, recordStruggle } from './lib/struggle.js'
import { createCapabilityManager } from './lib/capabilities.js'
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
  // 后台补料互斥 + 冷却
  let acquiring = false
  let lastAcquire = 0

  // 落盘日志：桌面版里插件 stdout 基本不可见，诊断只能靠文件
  const log = createLogger(baseRoot)

  // ── 工具注册 ──
  ctx.effect(() => {
    // 传 getCfg 而不是快照：每次工具调用都重读配置，wiki.config.json 热生效
    const dispose = registerTools(ctx, { getCfg, llm, caps })
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
      void recordStruggle(liveCfg.wikiRoot, {
        ts: new Date().toISOString(),
        sessionId: agent.id ?? '',   // 必须是字符串：undefined 会让工具输出非 lossless JSON
        mode: liveCfg.struggleMode,
        signals: fired,
      })
      if (liveCfg.struggleMode === 'active') {
        // Phase 2：命中后走 L1 → L2 → L3，并用 agent.inject() 把结果
        // 推进**当前这一轮**（不是下一轮），才能真正打断循环。
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

    if (step === 1) {
      tracker.reset(agent)
      // 补装能力包：恢复会话时 agent 在启动早期创建，那一刻工具目录还不全
      // （实测只有 46 个）。pre-step 在提示词组装之前，所以这里补装仍能生效。
      try { caps.ensure(agent) } catch (e) { log('capabilities ensure failed (non-fatal):', e?.message ?? e) }
    }
    if (step !== 1) return decision                                  // 每轮第一步 = "工作前"
    if (decision.kind === 'reject') return decision
    if (!decision.messages || decision.messages.length === 0) return decision

    // 兜底触发：即使 session/event 那条路因宿主版本差异失效，
    // 补料仍会在下一轮开始时被推动。acquiring 锁 + 冷却保证不会重复烧钱。
    scheduleAcquire()

    const query = queryFrom(messages)
    if (!query || query.length < 4) return decision

    try {
      if (!(await repoExistsSafe(cfg.wikiRoot))) await ensureRepo(cfg.wikiRoot)
      const { pages } = await loadPages(cfg.wikiRoot)
      const pool = recallable(pages, { minConfidence: cfg.minConfidence })
      if (pool.length === 0) return decision
      const corpus = buildCorpus(pool)
      const hits = scoreQuery(corpus, query)
      const t = triage(hits, cfg)
      signal?.throwIfAborted?.()

      if (t.bucket === 'miss') {
        // 旋钮 B2：只入队，绝不在此处阻塞去联网。
        // 但寒暄类短输入不是知识缺口，记进去只会污染队列并触发无意义联网。
        if (cfg.autoAcquire && looksLikeGap(query, { minChars: cfg.minGapQueryChars })) {
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
    if (acquiring) return
    let cfg
    try { cfg = await getCfg() } catch { return }
    if (!cfg.enabled || !cfg.autoAcquire) return
    const now = Date.now()
    if (now - lastAcquire < cfg.acquireCooldownMs) return
    acquiring = true
    lastAcquire = now
    try {
      const summary = await runAcquisition({ ctx, llm, repoRoot: cfg.wikiRoot, cfg, log })
      if (summary.considered > 0) log('background acquisition (' + why + '):', JSON.stringify({ considered: summary.considered, staged: summary.staged, skipped: summary.skipped, errors: summary.errors }))
    } catch (e) {
      log('background acquisition failed (non-fatal):', e?.message ?? e)
    } finally {
      acquiring = false
    }
  }
  // 轮次边界是「持久 session/event」，不是可 ctx.on 的 live 事件。
  // 早先写成 ctx.on('turn/end', ...) 不会报错、也永远不触发 ——
  // 整个 L3 补料路径因此是死的（gap 永远停在 pending）。
  // 正确签名是 (session, event)，事件类型在 event.type 上。
  try {
    ctx.on('session/event', (session, event) => {
      if (event && event.type === 'turn/end') scheduleAcquire()
    })
  } catch (e) { log('session/event hook unavailable:', e?.message ?? e) }
}

async function repoExistsSafe(root) {
  try { const { repoExists } = await import('./lib/wiki.js'); return repoExists(root) } catch { return false }
}

export default { name, apply, inject }
