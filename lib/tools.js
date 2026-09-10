// 4 个 agent 工具。其中只有 wiki_recall / wiki_learn 是「显式调用」路径——
// 按设计铁律：自动的不阻塞，阻塞的必须显式。显式调用可以阻塞等待结果。
import { defineTool } from '@deepseek-ai/dsh-tools'
import { loadPages, savePage, commitReadiness, deriveId, CATEGORIES } from './wiki.js'
import { buildCorpus, scoreQuery, triage, recallable } from './recall.js'
import { readGaps, writeGaps, runAcquisition } from './acquire.js'
import { readStruggles, SIGNAL_TYPES } from './struggle.js'
import { loadUsage, usageLabel, reinforcementFactor, classify, shouldQuarantine, DEFAULT_POLICY } from './usage.js'
import { withSanitizedOutput } from './json-safe.js'

const objectOutput = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}
const prop = (type, required, description) => ({ type, description, ...(required ? { required: true } : {}) })

export function registerTools(ctx, { getCfg, llm, caps, log = () => {} }) {
  const disposers = []
  // 统一给每个工具的 execute 套上 lossless 清洗。
  // undefined / NaN / Infinity 都不是合法 JSON，而 DSH 会直接拒绝整个调用。
  // 这个坑踩了四次（每次都只在某种数据形状下才触发），结构性兜底比逐处修可靠。
  // 清洗发生时记日志 —— 它是兜底，不该成为常态。
  const reg = (def) => ctx.tools.register({ ...def, execute: withSanitizedOutput(def.execute, log, def.name) })

  disposers.push(reg(defineTool({
    name: 'wiki_recall',
    description: '在 L1 Markdown 知识库中检索已固化的知识页（混合词法打分 + CRAG 三分桶）。这是工作中随时可用的显式检索入口，会返回 hit/weak/miss 判定与命中的页面正文。回答项目相关问题时先用它取证据，再作答并标注页面 id。',
    parameters: {
      query: prop('string', true, '检索意图，自然语言即可。'),
      topK: prop('number', false, '返回条数（默认 5）。'),
      includeBody: prop('boolean', false, '是否返回页面正文（默认 true）。'),
    },
    output: objectOutput,
    async execute(args) {
      const cfg = await getCfg()
      const { pages } = await loadPages(cfg.wikiRoot)
      const usage = await loadUsage(cfg.wikiRoot)
      // 显式检索包含被隔离的页 —— 隔离只挡自动注入，不挡显式查询
      const pool = recallable(pages, {
        minConfidence: cfg.minConfidence,
        usage: usage.pages,
        policy: cfg.usagePolicy,
        includeQuarantined: true,
      })
      const corpus = buildCorpus(pool)
      const hits = scoreQuery(corpus, args.query, { stats: usage.pages, explain: true })
      const t = triage(hits, cfg)
      const topK = Math.max(1, Math.min(20, Number(args.topK) || 5))
      const withBody = args.includeBody !== false
      const shape = h => {
        const st = usage.pages[h.page.id]
        const cls = classify(st, h.page)
        return {
          id: h.page.id, title: h.page.title, category: h.page.category,
          confidence: h.page.confidence, score: h.score,
          // 排序 = 相似度 × 强化因子。两个分量都给出，便于判断"它为什么排在这里"。
          similarity: h.similarity, reinforcement: h.factor,
          usage: st ? { hits: st.hits ?? 0, confirmed: st.confirmed ?? 0, suspect: st.suspect ?? 0, class: cls } : { class: 'new' },
          // 被隔离的页显式检索仍能看到 —— 但要提醒模型：别不加判断地采信
          ...(shouldQuarantine(st, cfg.usagePolicy) ? { warning: '此页历史上被命中后任务仍然失败过（疑似有害），请自行核实后再采信' } : {}),
          sources: h.page.sources, tags: h.page.tags,
          ...(withBody ? { body: h.page.body } : {}),
        }
      }
      // 注意：工具输出必须是 lossless JSON —— 值为 undefined 的键会让整次调用失败
      // ("value is not lossless JSON")。可选字段要条件性加入，不能写成 undefined。
      const result = {
        bucket: t.bucket,
        bestScore: t.best,
        hit: t.hit.slice(0, topK).map(shape),
        weak: t.weak.slice(0, topK).map(shape),
        totalRecallable: pool.length,
      }
      if (t.bucket === 'miss') {
        result.note = '未命中：没有已固化知识。可考虑 wiki_learn 沉淀，或让后续轮次的自动补料处理。'
      }
      return result
    },
  })))

  disposers.push(reg(defineTool({
    name: 'wiki_learn',
    description: '把一条值得长期保留的知识沉淀进 L1 知识库。默认写入 staged/（暂存区，不参与召回），只有 commit=true 时才直接进 pages/。必须提供 sources（可溯源），无可溯源来源的条目会在 commit 时被拒绝。',
    parameters: {
      title: prop('string', true, '页面标题。'),
      body: prop('string', true, 'Markdown 正文。'),
      category: prop('string', false, 'fact | decision | lesson | howto（默认 fact）。'),
      confidence: prop('number', false, '0.0-1.0，默认 0.5。'),
      sources: prop('string', false, '来源 URL 列表，逗号分隔。强烈建议提供。'),
      tags: prop('string', false, '标签，逗号分隔。'),
      id: prop('string', false, '页面 id（kebab-case）。留空则从标题派生。'),
      commit: prop('boolean', false, 'true 直接进 pages/；默认 false 进 staged/。'),
    },
    output: objectOutput,
    async execute(args) {
      const cfg = await getCfg()
      const now = new Date().toISOString()
      const id = deriveId(args.id, args.title)
      const sources = String(args.sources ?? '').split(',').map(s => s.trim()).filter(Boolean)
      const page = {
        id,
        title: String(args.title),
        category: CATEGORIES.includes(args.category) ? args.category : 'fact',
        confidence: Math.max(0, Math.min(1, Number(args.confidence ?? 0.5) || 0.5)),
        sources,
        tags: String(args.tags ?? '').split(',').map(s => s.trim()).filter(Boolean),
        created: now, updated: now, hits: 0,
        body: String(args.body),
      }
      const wantCommit = args.commit === true
      if (wantCommit) {
        const r = commitReadiness(page)
        if (!r.ready) return { ok: false, blocked: true, blockers: r.blockers, hint: '补上 sources 后重试，或省略 commit 先落 staged。' }
      }
      const file = await savePage(cfg.wikiRoot, page, { staged: !wantCommit })
      return { ok: true, id, committed: wantCommit, path: file, status: wantCommit ? 'committed' : 'staged' }
    },
  })))

  disposers.push(reg(defineTool({
    name: 'wiki_review',
    description: '查看知识库的两段式流水线状态：staged/ 里等待 commit 的暂存页，以及 gaps/ 里检索未命中的缺口队列。用于人工审阅后台自动补料的产出。只读。',
    parameters: {
      status: prop('string', false, 'gaps 过滤：pending | done | skipped | abandoned | all（默认 all）。'),
    },
    output: objectOutput,
    async execute(args) {
      const cfg = await getCfg()
      const { pages } = await loadPages(cfg.wikiRoot)
      const staged = pages.filter(p => p.status === 'staged').map(p => ({
        id: p.id, title: p.title, category: p.category,
        confidence: p.confidence, sources: p.sources.length, path: p.relPath,
      }))
      // ── 使用证据分布：这张图是"要不要自动沉淀"的唯一依据 ──
      const usage = await loadUsage(cfg.wikiRoot)
      const policy = { ...DEFAULT_POLICY, ...(cfg.usagePolicy ?? {}) }
      const committed = pages.filter(p => p.status === 'committed')
      const now = Date.now()
      const buckets = { confirmed: [], 'suspect-watch': [], suspect: [], unconfirmed: [], new: [], dead: [] }
      for (const p of committed) {
        const st = usage.pages[p.id]
        const cls = classify(st, p, { now, policy })
        const ageDays = Number.isFinite(Date.parse(p.created ?? '')) ? Math.round((now - Date.parse(p.created)) / 86400000) : null
        ;(buckets[cls] ??= []).push({
          id: p.id, cls,
          hits: st?.hits ?? 0, confirmed: st?.confirmed ?? 0, suspect: st?.suspect ?? 0,
          factor: Number(reinforcementFactor(st, now).toFixed(3)),
          ageDays,
          // 被隔离 = 不再自动注入
          quarantined: shouldQuarantine(st, policy),
        })
      }
      const usageSummary = {
        说明: '命中≠确认。确认 = 命中后该轮没再挣扎；嫌疑 = 命中后仍然挣扎（疑似有害）。'
          + ' 隔离 = 嫌疑达阈值且多于确认 -> 停止**自动注入**，但 wiki_recall 显式检索仍可查到。',
        policy,
        counts: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
        quarantined: Object.values(buckets).flat().filter(x => x.quarantined).map(x => ({ id: x.id, suspect: x.suspect, confirmed: x.confirmed })),
        // 有嫌疑的最值得看
        suspect: [...buckets.suspect, ...buckets['suspect-watch']].sort((a, b) => b.suspect - a.suspect).slice(0, 20),
        confirmed: buckets.confirmed.sort((a, b) => b.confirmed - a.confirmed).slice(0, 20),
        // 死知识要带页龄 —— 只看 hits 会把昨天刚写的页误判成死的
        dead: buckets.dead.map(x => ({ id: x.id, ageDays: x.ageDays })),
        newPages: buckets.new.map(x => ({ id: x.id, ageDays: x.ageDays })),
      }

      let gaps = await readGaps(cfg.wikiRoot)
      const want = String(args.status ?? 'all')
      if (want !== 'all') gaps = gaps.filter(g => g.status === want)
      return {
        staged,
        stagedCount: staged.length,
        usage: usageSummary,
        gaps: gaps.slice(0, 50).map(g => ({
          id: g.id, query: g.query, status: g.status, seen: g.seen, attempts: g.attempts, score: g.score,
          // 上次处理结果与原因 —— 没有它，队列里只剩一个孤零零的 "skipped"
          ...(g.lastReason ? { lastReason: g.lastReason } : {}),
          ...(g.lastAttempt ? { lastAttempt: g.lastAttempt } : {}),
        })),
        gapCount: gaps.length,
      }
    },
  })))

  disposers.push(reg(defineTool({
    name: 'wiki_commit',
    description: '把 staged/ 里的暂存页升入 pages/（正式生效并参与召回）。会被 commitReadiness 校验拦截：无 sources 的页面不允许 commit。这是两段式沉淀的第二段，也是知识进入 L1 的唯一闸门。',
    parameters: {
      id: prop('string', true, '要 commit 的暂存页 id（用 wiki_review 查）。'),
      confidence: prop('number', false, 'commit 时可就地修正置信度（0.0-1.0）。'),
    },
    output: objectOutput,
    async execute(args) {
      const cfg = await getCfg()
      const { pages } = await loadPages(cfg.wikiRoot)
      const page = pages.find(p => p.id === args.id && p.status === 'staged')
      if (!page) return { ok: false, error: 'staged 中找不到页面: ' + args.id }
      if (args.confidence !== undefined) page.confidence = Math.max(0, Math.min(1, Number(args.confidence) || 0))
      const r = commitReadiness(page)
      if (!r.ready) return { ok: false, blocked: true, blockers: r.blockers }
      page.updated = new Date().toISOString()
      const file = await savePage(cfg.wikiRoot, page, { staged: false })
      const { unlink } = await import('node:fs/promises')
      try { await unlink(page.path) } catch { /* staged 原文件删不掉不致命 */ }
      return { ok: true, id: page.id, committed: true, path: file }
    },
  })))

  // 按需暴露的兜底：能力包裁掉了工具，模型必须能把它们找回来。
  // 模式照抄 DSH 对 MCP 工具的做法（mcp_search 只暴露相关的 schema）——
  // 内置工具缺的正是这一半。
  if (caps) disposers.push(reg(defineTool({
    name: 'find_tools',
    description: '按需查找并启用未在当前工具列表中的能力。部分工具（如 workflow、ralph）为节省每请求开销默认不装配；需要时用本工具按关键词搜索，匹配到的工具会立即启用，供后续调用。参数 query 为关键词（如 "workflow"、"并行 子代理"）。',
    parameters: {
      query: prop('string', true, '能力关键词，例如 "workflow" 或 "子代理 并行"。'),
      limit: prop('number', false, '最多返回并启用几个（默认 6）。'),
    },
    output: objectOutput,
    async execute(args, exec) {
      const limit = Math.max(1, Math.min(20, Number(args.limit) || 6))
      const matched = caps.search(args.query, limit, exec?.agent)
      if (matched.length === 0) {
        return { matched: [], enabled: [], note: '没有匹配的能力。可用 find_tools 不带关键词查看部分目录。' }
      }
      const res = caps.lift(exec?.agent, matched.map(m => m.name))
      return {
        matched: matched.map(m => ({ name: m.name, description: String(m.description ?? '').slice(0, 400) })),
        enabled: res?.lifted ?? [],
        note: '已登记启用。工具列表在每一步请求组装时刷新，所以**下一步**即可直接调用。',
      }
    },
  })))

  disposers.push(reg(defineTool({
    name: 'wiki_struggle',
    description: '查看挣扎检测器的记录：agent 在哪些地方反复调用、连续失败、反复改写同一文件、或反复撞同一堵墙。默认 observe 模式下只记录不联网——这是判断"该不该自动联网补料"的唯一依据。只读。',
    parameters: {
      limit: prop('number', false, '返回最近多少条（默认 30）。'),
      type: prop('string', false, '只看某一类信号：repeat-identical | repeat-failure | edit-churn | recurring-error。'),
    },
    output: objectOutput,
    async execute(args) {
      const cfg = await getCfg()
      const all = await readStruggles(cfg.wikiRoot, 1000)
      const byType = {}
      for (const t of SIGNAL_TYPES) byType[t] = 0
      for (const r of all) for (const s of (r.signals ?? [])) byType[s.type] = (byType[s.type] ?? 0) + 1
      let recent = all
      if (args.type) recent = recent.filter(r => (r.signals ?? []).some(s => s.type === args.type))
      const limit = Math.max(1, Math.min(200, Number(args.limit) || 30))
      return {
        mode: cfg.struggleMode,
        total: all.length,
        byType,
        recent: recent.slice(-limit).map(r => ({
          ts: r.ts ?? '', sessionId: r.sessionId ?? '',
          signals: (r.signals ?? []).map(s => ({ type: s.type, count: s.count, detail: String(s.detail ?? '').slice(0, 160) })),
        })),
        note: cfg.struggleMode === 'observe'
          ? '当前为 observe 模式：只记录，不联网。审阅这些记录后再把 struggleMode 改成 active。'
          : 'active 模式：触发时会自动检索并注入。',
      }
    },
  })))

  disposers.push(reg(defineTool({
    name: 'wiki_acquire',
    description: '显式跑一次后台补料（L3）：把 gap 队列里 pending 的缺口经 web 检索 + 蒸馏处理后落 staged。默认由 turn/end 自动触发；用本工具可随时手动推动并拿到每条的成败原因，用于诊断"为什么没学到东西"。这是阻塞调用。',
    parameters: {
      limit: prop('number', false, '本次最多处理几个缺口（默认 2）。'),
      dryRun: prop('boolean', false, 'true 只返回将要处理的缺口，不联网、不写盘。'),
    },
    output: objectOutput,
    async execute(args) {
      const cfg = await getCfg()
      const gaps = (await readGaps(cfg.wikiRoot)).filter(g => g.status === 'pending')
      if (args.dryRun === true) {
        return { dryRun: true, pending: gaps.length, willProcess: gaps.slice(0, Math.max(1, Number(args.limit) || 2)).map(g => ({ id: g.id, query: g.query, attempts: g.attempts })) }
      }
      const limit = Math.max(1, Math.min(10, Number(args.limit) || cfg.maxAcquisitionsPerRun))
      const runCfg = { ...cfg, maxAcquisitionsPerRun: limit }
      let route = 'unknown'
      try { route = JSON.stringify(await llm.route()) } catch (e) { route = 'unresolved: ' + e.message }
      const summary = await runAcquisition({ ctx, llm, repoRoot: cfg.wikiRoot, cfg: runCfg, log: cfg.__log ?? (() => {}) })
      // 处理后重新读一遍，把持久化的原因一并返回
      const after = await readGaps(cfg.wikiRoot)
      return {
        distillRoute: route,
        considered: summary.considered, staged: summary.staged, skipped: summary.skipped, errors: summary.errors,
        details: summary.details,
        gaps: after.map(g => ({ id: g.id, status: g.status, attempts: g.attempts, ...(g.lastReason ? { lastReason: g.lastReason } : {}) })),
      }
    },
  })))

  return () => { for (const d of disposers) { try { d() } catch { /* dispose 尽力而为 */ } } }
}
