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
import { registerTools } from './lib/tools.js'

export const name = 'dsh-learn-wiki'
export const inject = ['tools', 'llm', 'web']

/**
 * 构造注入用的 user 消息。
 * 优先用宿主自己的 createUserMessage（保证消息形状与宿主版本一致）；
 * 若导入失败或形状漂移，退化为最小可用形状，而不是让整轮崩掉。
 */
function buildUserMessage(text) {
  const payload = { content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: name } }
  try {
    if (typeof hostCreateUserMessage === 'function') return hostCreateUserMessage(payload)
  } catch (e) {
    console.warn('[dsh-learn-wiki] createUserMessage failed, using minimal shape:', e?.message ?? e)
  }
  return { role: 'user', ...payload }
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
  return parts.join('\n').trim().slice(0, 1500)
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
  const getCfg = () => loadConfig(baseRoot, pluginConfig)
  const llm = createLlm(ctx, { provider: pluginConfig?.llmProvider, model: pluginConfig?.llmModel })

  // 每会话的注入去重（KV cache 友好）：内容不变则不再重复注入
  const injectedDigest = new WeakMap()
  // 后台补料互斥 + 冷却
  let acquiring = false
  let lastAcquire = 0

  const log = (...a) => console.log('[dsh-learn-wiki]', ...a)

  // ── 工具注册 ──
  ctx.effect(() => {
    // 传 getCfg 而不是快照：每次工具调用都重读配置，wiki.config.json 热生效
    const dispose = registerTools(ctx, { getCfg })
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

  // ── 旋钮 A：工作前自动注入（命中则注入；未命中则记 gap）──
  ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
    const decision = await next()
    let cfg
    try { cfg = await getCfg() } catch { return decision }
    if (!cfg.enabled) return decision
    if (step !== 1) return decision                                  // 每轮第一步 = "工作前"
    if (decision.kind === 'reject') return decision
    if (!decision.messages || decision.messages.length === 0) return decision

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
  try { ctx.on('turn/end', scheduleAcquire) } catch (e) { log('turn/end hook unavailable:', e?.message ?? e) }
}

async function repoExistsSafe(root) {
  try { const { repoExists } = await import('./lib/wiki.js'); return repoExists(root) } catch { return false }
}

export default { name, apply, inject }
