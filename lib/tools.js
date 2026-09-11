// 4 个 agent 工具。其中只有 wiki_recall / wiki_learn 是「显式调用」路径——
// 按设计铁律：自动的不阻塞，阻塞的必须显式。显式调用可以阻塞等待结果。
import { defineTool } from '@deepseek-ai/dsh-tools'
import { loadPages, savePage, commitReadiness, deriveId, CATEGORIES, serializeFrontmatter } from './wiki.js'
import { buildCorpus, scoreQuery, triage, recallable } from './recall.js'
import { readGaps, writeGaps, runAcquisition } from './acquire.js'
import { readStruggles, SIGNAL_TYPES } from './struggle.js'
import { loadUsage, usageLabel, reinforcementFactor, classify, shouldQuarantine, DEFAULT_POLICY } from './usage.js'
import { lintWiki, renderLint } from './lint.js'
import { proposeMerge, applyMerge, findOverlaps } from './merge.js'
import { runHarvest } from './harvest.js'
import { loadSessionIndex, collectWalls } from './session-index.js'
import { listSessions } from './session-store.js'
import { renderDigest } from './session-digest.js'
// ★ 重会话解析一律走**独立进程**，不在宿主里做。原因见 session-remote.js 的注释：
//   宿主在这条路径上原生崩过四次（没有 JS 堆栈）。隔离层是唯一能在
//   "找不到原生触发点"的前提下保住宿主的手段。
import { sessionTranscriptRemote, sessionBothRemote } from './session-remote.js'
import { withSanitizedOutput } from './json-safe.js'

/**
 * 「当前工作目录」= **agent 会话头里的 cwd**，不是 process.cwd()。
 *
 * ★ 这个坑犯过两次，所以抽成函数。
 *   实测：插件的 process.cwd() 是 D:\Harness\dsh-desktop —— 那是 Electron
 *   应用自己的安装目录，而会话记录的 cwd 是工作区 D:\Harness。两者永不相等，
 *   于是任何按 cwd 过滤的地方都会**静默返回空**，看起来像"你没有历史会话"。
 *
 *   第一次犯：wiki_sessions 的列表。
 *   第二次犯：wiki_harvest 按 session= 取历史会话时又写了一遍 process.cwd()
 *             —— 结果是 known=[]，报了"没找到会话"，而那个会话明明存在。
 *
 *   修一处漏一处正是这类 bug 的形态。所以现在只有这一个定义点。
 */
function agentCwdOf(exec) {
  try {
    const c = String(exec?.agent?.session?.header?.cwd ?? '').trim()
    if (c) return c
  } catch { /* 读不到就退回进程 cwd */ }
  return process.cwd()
}

const objectOutput = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}
const prop = (type, required, description) => ({ type, description, ...(required ? { required: true } : {}) })

export function registerTools(ctx, { getCfg, llm, caps, log = () => {}, trace = log }) {
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

  // ★ /learn 的等价物：从**刚刚这段对话**里提炼，而不是从网上搜。
  //
  // 现有两个触发器（检索未命中、挣扎）都是关于"我们自己失败"的信号，发现不了
  // 第三种也是最值钱的一种：**我们刚刚想清楚了一件事**。实测那次会话里，
  // 用户亲口说出的设计规则一条都没被沉淀，而自动闭环产出的却是一页关于
  // 另一个撞名项目的内容 —— 信号选错，产出就是反的。
  //
  // 一律落 staged：这条路径**不提供 commit 参数**。自动产出必须经人工闸升入
  // L1，这是本项目的铁律；"由模型发起"不构成免检理由。要固化就去界面上点。
  disposers.push(reg(defineTool({
    name: 'wiki_harvest',
    description: '把一段已经发生的对话里值得长期保留的东西提炼成待审知识页（落 staged/，不参与召回，需人工固化）。默认读**当前这段对话**；给 session 则读**历史会话**（先 wiki_sessions 找到 id）。当你们想清楚了一条设计规则、一个根因、一个非显然的约束或一个带理由的决定时用它 —— 这些恰恰是"检索未命中"和"挣扎"两个自动触发器都发现不了的。不需要你复述内容，它自己读。不要为了凑数调用：没有值得留的东西时它会如实拒绝。',
    parameters: {
      focus: prop('string', false, '只提炼某个具体方面，例如"位置表达状态这条设计规则"。留空则由模型自行判断。'),
      maxItems: prop('number', false, '最多提炼几条（默认 3，上限 6）。'),
      session: prop('string', false, '从**历史会话**提炼（会话 id 或前缀）。省略则提炼当前这段对话。'),
    },
    output: objectOutput,
    async execute(args, exec) {
      const cfg = await getCfg()
      const agent = exec?.agent
      const wantSession = String(args.session ?? '').trim()

      // 历史会话路径：不需要 agent（内容来自磁盘），但需要先定位到那个会话。
      let events = null, transcript = null, sessionRef = ''
      if (wantSession) {
        // 先按 agent 的工作区找；**一条都没有时退回全部**并说明 ——
        // "查不到"和"没有"必须分得开（第三次遇到这个模式了）。
        const cwdWant = agentCwdOf(exec)
        let all = listSessions({ cwd: cwdWant, includeSubagents: true })
        const cwdFallback = all.length === 0
        if (cwdFallback) all = listSessions({ includeSubagents: true })
        const hit = all.find(s => s.id === wantSession) ?? all.find(s => s.id.startsWith(wantSession))
        if (!hit) {
          return {
            ok: false,
            error: '没找到会话 ' + wantSession,
            ...(cwdFallback ? { cwdNote: '当前工作区（' + cwdWant + '）下没有会话记录，已放宽到全部再找。' } : {}),
            known: all.slice(0, 10).map(s => s.id),
          }
        }
        // ★ 取材走独立进程。宿主在这条路径上崩过（session= 那个 10.14MB 会话），
        //   而且原生崩溃没有 JS 堆栈可查 —— 所以不在这里算。
        const trRes = await sessionTranscriptRemote(hit.file, hit, {})
        if (!trRes.ok) {
          log('harvest: 取材失败 ' + trRes.error)
          return { ok: false, error: '读取会话失败：' + trRes.error }
        }
        transcript = trRes.result
        // 锚点指向被提炼的那个历史会话，**不是**当前会话 ——
        // 否则这一页的"来源"会指错地方，而溯源是这套东西的全部意义。
        sessionRef = 'session://' + hit.id
      } else if (!agent) {
        return { ok: false, error: '这个工具需要 agent 上下文才能读到当前会话（exec.agent 为空）。想提炼历史会话就传 session。' }
      }

      let res
      try {
        res = await runHarvest({
          agent, events, transcript, sessionRef, llm,
          focus: String(args.focus ?? ''),
          maxItems: args.maxItems,
          maxTokens: cfg.harvestMaxTokens,
          log,
        })
      } catch (e) {
        return { ok: false, error: '提炼调用失败：' + String(e?.message ?? e) }
      }
      if (res.skipped) {
        return {
          ok: true, skipped: true, reason: res.reason,
          transcriptChars: res.transcriptChars,
          hint: '这是正常的 —— 拒绝优于写一页没有依据的东西。如果确实有想留的，用 focus 指明是哪一个点再试一次。',
        }
      }
      // 已存在就不写。savePage 是整文件替换，静默盖掉一页（可能是人改过的）
      // 是本项目最忌讳的那类"看起来成功了"的操作。
      //
      // ★ 必须**同时**按 id 和标题判重。
      //   实测踩到：只按 id 判，中文标题永远避不开重复 ——
      //   deriveId() 对含 CJK 的标题会退化成 note-<hash>（slugify 把中文整个剥掉，
      //   有损就不能当标识），所以人手写的 position-not-state 和自动提炼出的
      //   note-6a26bd **标题一模一样、id 完全不同**，判重形同虚设，
      //   结果是同一个知识点在库里躺两份。
      //   id 只是文件名；**标题才是给人看的身份**。
      const { pages } = await loadPages(cfg.wikiRoot)
      const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, '')
      const existingIds = new Set(pages.map(p => p.id))
      const existingTitles = new Set(pages.map(p => norm(p.title)))
      const now = new Date().toISOString()
      const written = []
      const duplicates = []
      for (const it of res.items) {
        const id = deriveId('', it.title)
        const dupId = existingIds.has(id)
        const dupTitle = existingTitles.has(norm(it.title))
        if (dupId || dupTitle) {
          duplicates.push({
            id, title: it.title,
            reason: dupTitle ? '已存在同名页（标题相同，id 可能不同）' : '已存在同 id 页',
          })
          continue
        }
        existingIds.add(id)
        existingTitles.add(norm(it.title))
        const page = {
          id, title: it.title, category: it.category, confidence: it.confidence,
          sources: it.sources, tags: it.tags,
          created: now, updated: now, hits: 0, body: it.body,
        }
        const file = await savePage(cfg.wikiRoot, page, { staged: true })
        written.push({ id, title: it.title, category: it.category, confidence: it.confidence, sources: it.sources.length, path: file })
      }
      return {
        ok: true,
        skipped: false,
        staged: written,
        ...(duplicates.length ? { duplicates } : {}),
        transcriptChars: res.transcriptChars,
        note: '已落 staged/。它在界面的「知识」页签里等你固化 —— 固化前不参与任何自动召回。',
      }
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

  disposers.push(reg(defineTool({
    name: 'wiki_merge',
    description: '把两页合并成一页。默认**只出提案不落盘**（返回合并稿、来源并集、注意事项），confirm 后才写：合并稿落 staged/ 等审、被并入的页移入 .rejected/ 并附原因。合并稿是**机械拼接、不是成稿** —— 它给人和模型一个起点，不是终点。用法：先用 wiki_lint 看"主题重叠"那一段挑候选。',
    parameters: {
      keep: prop('string', true, '保留哪一页（它的 id 与使用证据 hits/confirmed/suspect 都会保留）。'),
      absorb: prop('string', true, '被并入哪一页。应用后会移入 .rejected/，不会删除。'),
      apply: prop('boolean', false, '真正落盘（默认 false，只给提案）。'),
    },
    output: objectOutput,
    async execute(args) {
      const cfg = await getCfg()
      const { pages } = await loadPages(cfg.wikiRoot)
      const keepId = String(args.keep ?? '').trim()
      const absorbId = String(args.absorb ?? '').trim()
      const proposal = proposeMerge(pages, keepId, absorbId)
      if (!proposal.ok) return proposal

      if (args.apply !== true) {
        return {
          ok: true, dryRun: true,
          keep: proposal.keep, absorb: proposal.absorb,
          merged: { id: proposal.merged.id, title: proposal.merged.title, sources: proposal.merged.sources.length, bodyChars: proposal.merged.body.length },
          preview: String(proposal.merged.body).slice(0, 800),
          notes: proposal.notes,
          hint: '确认无误后带 apply:true 再调一次。落盘只写 staged/ 与 .rejected/，不会直接进 pages/。',
        }
      }

      const absorbPage = pages.find(p => p.id === absorbId)
      const r = await applyMerge(cfg.wikiRoot, { ...proposal, absorbPath: absorbPage?.path }, { serializeFrontmatter })
      if (!r.ok) return r
      return {
        ok: true, dryRun: false,
        keep: proposal.keep, absorb: proposal.absorb,
        staged: r.staged, rejected: r.rejected,
        hint: '合并稿在 staged/，它**还没进召回**。看过、改过之后再 wiki_commit 固化。',
      }
    },
  })))

  disposers.push(reg(defineTool({
    name: 'wiki_lint',
    description: '体检知识库：死链（指向不存在的页）、来源失效（本地路径/会话已不在）、来源不像指针（整句话被塞进 sources）、疑似重复（正文两两余弦相似）、过期（零命中且超过页龄阈值）。**只读**，不改任何文件。URL 来源离线无法验证，结果里会如实列出"这次没查什么"。',
    parameters: {
      threshold: prop('number', false, '重复判定阈值（默认 0.72）。调低更敏感、更容易报出"像是重复"。'),
      staleOnly: prop('boolean', false, '只看过期，跳过其余检查（页多时更快）。'),
    },
    output: objectOutput,
    async execute(args) {
      const cfg = await getCfg()
      const { pages } = await loadPages(cfg.wikiRoot)
      const usage = await loadUsage(cfg.wikiRoot)
      const r = await lintWiki(cfg.wikiRoot, {
        pages, usage,
        policy: { ...DEFAULT_POLICY, ...(cfg.usagePolicy ?? {}) },
        pluginRoot: process.cwd(),
        ...(args.threshold !== undefined ? { threshold: args.threshold } : {}),
      })
      // staleOnly 只是给"页很多、只想扫过期"的场景省一点算力。
      // 注意它**不会**把结果伪装成"全绿" —— notChecked 里会写明跳过。
      if (args.staleOnly === true) {
        return {
          ok: true, scanned: r.scanned, findings: r.stale.length, stale: r.stale,
          skipped: ['死链', '来源检查', '重复检测'],
          rendered: '扫描 ' + r.scanned + ' 页，过期 ' + r.stale.length + ' 条。\n（本次只查了过期：死链 / 来源 / 重复未检查）',
        }
      }
      return { ...r, rendered: renderLint(r) }
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

  // ★ 历史会话：这个仓库最被低估的资产。
  //
  // 本地躺着几十个会话、完整的对话与工具调用记录，而在此之前**没有任何路径读它** ——
  // 预注入、挣扎检测、wiki_harvest 全都只看得到"现在"。于是"上次我是怎么解决的"
  // 这个问题在整个系统里没有位置，只能靠人去记。
  //
  // （Hermes 生态里有一模一样的功能叫 headroom learn：挖历史会话的失败模式、
  //   与"最终成功的那次修正"做关联。它内置的 adapter 只有 ClaudeCode/Codex/Gemini
  //   —— 没有 DSH。这个工具就是补上那个缺口。）
  disposers.push(reg(defineTool({
    name: 'wiki_sessions',
    description: '查看本机**历史会话**：每个会话干了什么、改过哪些文件、撞过哪几堵墙、那堵墙后来有没有走出去。当你怀疑"这个问题以前遇到过"、想知道某个文件历史上踩过什么坑、或者要复盘一段工作是怎么绕出来的，用它。action=walls 会把跨会话重复出现的同一堵墙聚在一起 —— 那是"这个项目反复卡在哪"最直接的证据。只读，不改任何东西。',
    parameters: {
      action: prop('string', false, 'list（默认，列最近会话）| brief（接手简报：最近做了什么、改过哪些文件、哪些坑还在）| walls（跨会话重复出现的墙）| show（看某一个会话的详情）。'),
      limit: prop('number', false, 'list / walls 返回条数（默认 10，上限 50）。'),
      session: prop('string', false, 'show 时要看的会话 id，或它的前缀。'),
      includeSubagents: prop('boolean', false, '是否包含子代理会话（默认 false —— 它们是临时工的工作记录，不算项目经历）。'),
      refresh: prop('number', false, '本次最多新摘要几个会话（默认 6）。摘要会在宿主主线程上跑，所以另有 1.5 秒的总时间预算；没摘完的会在 notYetIndexed 里如实报出来，再调一次继续。'),
    },
    output: objectOutput,
    async execute(args, exec) {
      const cfg = await getCfg()
      const raw = String(args.action ?? 'list')
      const action = ['list', 'brief', 'walls', 'show'].includes(raw) ? raw : 'list'
      const limit = Math.max(1, Math.min(50, Number(args.limit) || 10))
      const withSubs = args.includeSubagents === true
      // 「当前工作目录」走共享的 agentCwdOf —— 见它的注释（这个坑犯过两次）。
      const cwd = agentCwdOf(exec)

      // ★ cwd 过滤**不能静默地过滤成空**。
      //
      //   这个项目已经学过一课（见知识页 scoped-registry-empty-result）：
      //   分层作用域下"查不到"和"没有"必须分得开。这里同理 ——
      //   插件的进程 cwd 未必等于会话记录里的 cwd（实测：从插件目录里跑，
      //   process.cwd() 是 .../dsh-learn-wiki，而会话的 cwd 是 D:\Harness，
      //   于是列表静默变成 0 条，看起来像"你没有历史会话"）。
      //
      //   所以：先用 cwd 过滤；**一条都没有**时退回全部，并把这件事报出去。
      const inCwd = listSessions({ cwd, includeSubagents: withSubs })
      const cwdFallback = inCwd.length === 0
      const scopeCwd = cwdFallback ? null : cwd

      if (action === 'show') {
        const q = String(args.session ?? '').trim()
        if (!q) return { ok: false, error: 'show 需要 session 参数（会话 id 或前缀）。先用 action=list 看有哪些。' }
        const all = listSessions({ cwd: scopeCwd, includeSubagents: withSubs })
        const hit = all.find(s => s.id === q) ?? all.find(s => s.id.startsWith(q))
        if (!hit) {
          return {
            ok: false,
            error: '没找到会话 ' + q,
            ...(cwdFallback ? { cwdNote: '当前工作目录（' + cwd + '）下没有任何会话记录，已放宽到全部会话再找。' } : {}),
            known: all.slice(0, 10).map(s => s.id),
          }
        }
        // ★ 扫描在**独立进程**里做。
        //
        //   这条路径在宿主里原生崩过四次，实测崩在"开始扫描"之后约 1 秒、
        //   也就是扫描**内部**（同步阶段标记只写出了"开始扫描"）；
        //   而同样的计算在应用之外全部正常：Node 24 与 Electron-as-Node 22.16
        //   都能跑完 14MB / 58566 事件，即使把 RSS 顶到 1.3GB。
        //   找不到宿主里的原生触发点，就不在宿主里做这件事。
        //
        //   摘要与取材**一次扫完**：两遍就是双倍代价，且都在同一个子进程里。
        trace('show: 开始扫描(子进程) ' + hit.id)
        const res = await sessionBothRemote(hit.file, hit, { maxChars: 3000, maxTurns: 4 })
        if (!res.ok) {
          trace('show: 子进程失败 ' + res.error)
          return { ok: false, error: res.error, id: hit.id }
        }
        const d = res.result.digest
        const tr = res.result.transcript
        trace('show: 扫描完成 events=' + d.eventsScanned + ' walls=' + d.walls.length + ' chars=' + tr.chars)
        const rendered = renderDigest(d, { maxWalls: 10 })
        const out = {
          ok: true, action: 'show', id: d.id,
          digest: d,
          rendered,
          transcriptExcerpt: tr.text,
          transcriptChars: tr.chars,
          hint: '想把这段会话里的东西沉淀下来：wiki_harvest 带上 session="' + d.id + '"。',
        }
        trace('show: 构造完成 payload=' + JSON.stringify(out).length)
        return out
      }

      const idx = await loadSessionIndex(cfg.wikiRoot, {
        cwd: scopeCwd,
        includeSubagents: withSubs,
        // 没给 refresh 就用默认值（8）；给 0 表示"只读缓存，不要现摘"。
        maxNew: args.refresh === undefined ? undefined : Math.max(0, Number(args.refresh) || 0),
      })
      // 注：loadSessionIndex 内部另有 1.5 秒时间预算兜底。传再大的 refresh
      // 也不会让宿主被占住更久 —— 那是**上界**，不是目标。

      // ★「还有多少没索引」必须报出去。假装全都索引了，等于让人以为历史就这么多
      //   —— 而漏掉的那部分恰恰可能是他要找的那一次。
      const coverage = {
        cwd,
        ...(cwdFallback ? { cwdNote: '这个工作目录下没有会话记录，已放宽到全部会话 —— 列表里可能包含别的项目的会话。' } : {}),
        sessionsFound: idx.scanned,
        indexed: idx.digests.length,
        notYetIndexed: idx.pending,
        ...(idx.pending > 0 ? { coverageNote: '还有 ' + idx.pending + ' 个会话没摘要（本次新摘了 ' + idx.digested + ' 个，其余读的是缓存）。再调一次会继续推进。' } : {}),
        // 时间预算耗尽要**说出来**。不说的话，"本次只摘了 3 个"会被读成
        // "只有 3 个可摘"——又是一次静默的语义丢失。
        ...(idx.timeBudgetExhausted ? { timeBudgetNote: '本次到达时间预算就停了（摘要跑在宿主主线程上，不能占太久），剩下的下次继续。' } : {}),
        ...(idx.errors.length ? { errors: idx.errors.slice(0, 5) } : {}),
      }

      // ★ 接手简报：这是"跨会话继承项目进度"的直接答案。
      //
      //   不是原始转储，而是按"人接手时需要知道什么"排序：
      //     最近在做什么 → 碰了哪些文件 → 哪些坑反复出现且没走出去 → 哪些经验还在队列里
      //   它刻意**不**做总结陈词（"项目已完成 X"）—— 那是判断，模型读了原始事实
      //   自己会形成判断，而写死的判断一旦过时就变成了误导。
      if (action === 'brief') {
        const recent = idx.digests.slice(0, limit)
        const fileScore = new Map()
        for (let i = 0; i < recent.length; i++) {
          const weight = recent.length - i          // 越近权重越高
          for (const [f, n] of Object.entries(recent[i].filesTouched ?? {})) {
            fileScore.set(f, (fileScore.get(f) ?? 0) + n * weight)
          }
        }
        const topFiles = [...fileScore.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
          .map(([f, w]) => ({ file: f, weight: w, name: f.split(/[\\/]/).pop() }))

        const allWalls = collectWalls(idx.digests)
        const recurring = allWalls.filter(e => e.sessions.length >= 2)

        return {
          ok: true, action: 'brief', ...coverage,
          recentSessions: recent.map(d => ({
            id: d.id,
            at: d.createdAt ? new Date(d.createdAt).toISOString().slice(0, 16).replace('T', ' ') : '',
            title: d.title,
            firstAsk: d.firstAsk.replace(/\s+/g, ' ').slice(0, 160),
            lastAsk: d.lastAsk.replace(/\s+/g, ' ').slice(0, 160),
            files: Object.keys(d.filesTouched).map(f => f.split(/[\\/]/).pop()).slice(0, 8),
            unresolvedWalls: (d.walls ?? []).filter(w => !w.resolvedAfter).map(w => w.sig.slice(0, 120)),
          })),
          hotFiles: topFiles,
          recurringWalls: recurring.slice(0, 8).map(e => ({
            sig: e.sig,
            inSessions: e.sessions.length,
            hits: e.hits,
            tools: e.tools,
          })),
          readme: [
            '这份简报只列事实，不做结论 —— 最近几次在做什么、碰了哪些文件、哪些坑反复出现。',
            'recurringWalls 是**多个会话都撞到过**的墙，最值得先看一眼：那通常意味着有个结构性原因没被解决。',
            '想知道某一次具体怎么绕出来的：action=show 看那个会话，或 wiki_harvest 带 session 把它的经验沉淀下来。',
          ],
        }
      }

      if (action === 'walls') {
        const rows = collectWalls(idx.digests)
        return {
          ok: true, action: 'walls', ...coverage,
          walls: rows.slice(0, limit).map(e => ({
            sig: e.sig,
            inSessions: e.sessions.length,
            hits: e.hits,
            resolvedInSessions: e.resolved,
            tools: e.tools,
            recent: e.sessions.slice(0, 2).map(s => ({
              id: s.id,
              at: s.at ? new Date(s.at).toISOString().slice(0, 10) : '',
              count: s.count,
              resolved: s.resolved,
              afterLastFailure: s.esc ? (s.esc.name + (s.esc.file ? ' ' + s.esc.file.split(/[\\/]/).pop() : '')) : '',
            })),
          })),
          note: '同一堵墙出现在多个会话里 = 这个项目反复卡在同一个地方。resolvedInSessions 统计的是"最后一次撞墙之后又继续干了不少活"的会话数 —— 那多半意味着当时绕出去了，值得回头看当时是怎么做的。',
        }
      }

      return {
        ok: true, action: 'list', ...coverage,
        sessions: idx.digests.slice(0, limit).map(d => ({
          id: d.id,
          at: d.createdAt ? new Date(d.createdAt).toISOString().slice(0, 16).replace('T', ' ') : '',
          title: d.title,
          turns: d.counts.turns,
          toolCalls: d.counts.toolCalls,
          failures: d.counts.failures,
          walls: d.walls.length,
          files: Object.keys(d.filesTouched).slice(0, 6).map(f => f.split(/[\\/]/).pop()),
          firstAsk: d.firstAsk.replace(/\s+/g, ' ').slice(0, 100),
        })),
        rendered: idx.digests.slice(0, limit).map(d => renderDigest(d, { maxWalls: 3 })),
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
