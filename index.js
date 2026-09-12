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
import {
  loadPages, ensureRepo, savePage, commitReadiness, readStagedBrief, countTriage,
  listTriage, readTriageBody, restoreTriage, discardTriage,
} from './lib/wiki.js'
import { readFile, writeFile, unlink, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { buildCorpus, scoreQuery, triage, recallable, looksLikeGap } from './lib/recall.js'
import { appendGap, runAcquisition, readGaps } from './lib/acquire.js'
import { createLlm, SITES, SITE_LABEL, normalizeLlmConfig } from './lib/llm.js'
import { runHarvest, stageHarvestItems } from './lib/harvest.js'
import { listSessions } from './lib/session-store.js'
import { sessionTranscriptRemote } from './lib/session-remote.js'
import { createLogger } from './lib/log.js'
import { applySkillTrim, agentKeyOf } from './lib/skills-trim.js'
import { looksLikeCorrection, correctionRecord } from './lib/correction.js'
import { compatReport, readPluginVersions, readHostVersions, checkHostApis } from './lib/compat.js'
import { createStruggleTracker, recordStruggle, symptomQuery, readStruggles } from './lib/struggle.js'
import { createCapabilityManager, loadCatalogSnapshot } from './lib/capabilities.js'
// updateUsage 而不是 loadUsage+saveUsage：证据账的读-改-写必须整段串行，
// 否则并发的记录会互相覆盖丢失（详见 lib/usage.js 与 lib/lock.js 的注释）。
import { loadUsage, updateUsage, recordHit, recordConfirmed, recordSuspect, usageLabel, classify, shouldQuarantine, reinforcementFactor, DEFAULT_POLICY } from './lib/usage.js'
import { createSkillInventory, scopeKeyOf } from './lib/skills.js'
import { registerTools } from './lib/tools.js'

export const name = 'dsh-learn-wiki'
export const inject = ['tools', 'llm', 'web', 'webServer']

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

/**
 * 委托深度 > 0 就是一个子代理。
 *
 * 判据照抄 @deepseek-ai/dsh-subagent 的 delegationDepthOf()：
 *   max(agent.session.header.delegationDepth, agent.options.subagentDepth)
 * 但不引那个包 —— 这两个都是 agent 对象上的普通属性，为一个判断加一条依赖
 * 不划算（同 lib/skills.js 读 Symbol(dsh.scope) 的做法）。
 *
 * 实测（解出真实会话 header 对比）：
 *   子代理： origin="subagent"  delegationDepth=1  parentSession=session-...
 *   根会话： delegationDepth=0（无 origin、无 parentSession）
 *
 * 读不到就当 0。这个方向的误判是安全的：
 *   把子代理当主代理 = 退回旧行为（已知的坏行为，但不会更坏）；
 *   把主代理当子代理 = 主代理从此不再积累任何证据 —— 那才是真事故。
 */
/**
 * 插件声明的宿主可接受范围。
 *
 * ★ **唯一真源**：package.json 的 peerDependencies 是给人看的，这里是给运行时判的。
 *   两处不一致就会得出相反的结论 —— 这个项目为「阈值两处各写一份」栽过一次
 *   （见 lib/config.js 里 recall 阈值那段注释）。
 */
const HOST_RANGE = '>=0.1.0-rc.6 <0.2.0'

function delegationDepth(agent) {
  try {
    const h = agent?.session?.header?.delegationDepth
    const o = agent?.options?.subagentDepth
    const hn = Number.isSafeInteger(h) && h > 0 ? h : 0
    const on = Number.isSafeInteger(o) && o > 0 ? o : 0
    return Math.max(hn, on)
  } catch { return 0 }
}
function isSubagent(agent) { return delegationDepth(agent) > 0 }

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
  const tracker = createStruggleTracker(liveCfg)
  const caps = createCapabilityManager({ ctx, getCfg: () => liveCfg, log: (...a) => log(...a), wikiRoot: baseRoot })
  // 技能盘点：只读，带 TTL 缓存。刻意不进 inject —— 拿不到就如实说不可用。
  // 技能 provider 挂在 agent preset 的作用域层，不带 scope 查只能看到空的全局层。
  // 这里保存最近一次见过的 agent 作用域键，供 UI 路由（没有 agent 上下文）使用。
  let lastAgentScope
  // 最近一个活着的 agent。界面上那个「从会话提炼」按钮**没有 agent 上下文**
  // （它在 frame 级的座位里，不属于任何会话），只能借用最近一个 —— 与
  // lastAgentScope 同一个思路。
  //
  // ★ 用 WeakRef 而不是强引用：强引用会把整个会话（实测有 10MB 的）钉在内存里，
  //   这个插件已经因为大会话把宿主拖崩过。deref() 拿不到就退到磁盘上最近的会话。
  let lastAgentRef = null
  const skills = createSkillInventory({ ctx, log: (...a) => log(...a), getScope: () => lastAgentScope })

  // 每会话的注入去重（KV cache 友好）：内容不变则不再重复注入
  const injectedDigest = new WeakMap()
  // agent -> 最近一次用户查询。挣扎时用它给症状查询补一点任务上下文。
  const lastQuery = new WeakMap()
  /** 记住 agent 的作用域键：UI 路由不在任何 agent 作用域里，只能借用最近一个。 */
  const noteAgentScope = (agent) => {
    try {
      const k = scopeKeyOf(agent)
      if (k !== undefined) lastAgentScope = k
    } catch { /* 取不到就退化成不带 scope 的查询 */ }
    try { if (agent && typeof WeakRef === 'function') lastAgentRef = new WeakRef(agent) } catch { /* 退到磁盘路径 */ }
  }
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

  // 投递路径的证据追踪。**刻意与 turnInjections 分开**：
  // 投递发生在挣扎**之后**，若塞进上面那个容器，会因为 "struggled 已为 true"
  // 而立刻被记成嫌疑 —— 那是错误归因（它压根没赶上那次挣扎）。
  // 这里要观察的是：**投递之后有没有新的挣扎**。
  const pendingDeliveries = new Map()   // agentId -> Set<pageId>

  // 落盘日志：桌面版里插件 stdout 基本不可见，诊断只能靠文件
  const log = createLogger(baseRoot)
  // 同步档：只在**重路径的阶段边界**用。默认的异步写盘在原生崩溃时会丢，
  // 而宿主崩过三次、每次都只剩 crashpad 一行 —— 没有这档就等于没有证据。
  const trace = createLogger(baseRoot, { sync: true })
  // ★ 传 getCfg 而不是快照：每次调用重读 wiki.config.json，换模型不用重载插件。
  //   以前这里读的是 apply() 的参数，于是写进配置文件的 llmProvider/llmModel
  //   毫无反应 —— 一个"配了但没生效、也不报错"的坑。
  const llm = createLlm(ctx, { getCfg, log: (...a) => log(...a) })
  // 手动提炼的互斥闸 + 最近一次结果（界面按钮据此显示"上次干了什么"）。
  // 并发两次提炼会各自读一遍 staged 再各写一批，判重互相看不见对方 —— 会写出重复页。
  let harvesting = false
  let lastHarvest = null

  // ── 宿主兼容性自检 ──
  //
  // 实测（2026-09-11）：插件自带 dsh-tools@**rc.8**，宿主跑 **rc.12**，
  // 而 import 解析到的是**插件自带那份** —— 同一进程里两份实现。
  // 它现在能跑通，但那是运气；rc 阶段任何内部形状变化都可能让它悄悄失效，
  // 且不会有任何报错。
  //
  // 所以这里只做一件事：**把它摆出来**。不自动切换实现 ——
  // 没有证据表明两份有行为差异，为想象中的差异写兼容层只会多一条
  // 没人走过、也没人敢删的路径。
  void (async () => {
    try {
      const report = compatReport({
        pluginVersions: readPluginVersions(),
        hostVersions: await readHostVersions(),
        range: HOST_RANGE,
        apis: checkHostApis(ctx),
      })
      log('compat:\n' + report.rendered)
      if (report.differs.length) {
        log('compat: ★ 插件自带与宿主实际版本不一致 —— import 加载的是插件自带那份（见 lib/compat.js 说明）')
      }
      if (report.inRange === false) log('compat: ★ 宿主版本超出声明范围 ' + HOST_RANGE + '，可能有破坏性变更')
      if (report.apis && report.apis.missing && report.apis.missing.length) {
        log('compat: ★ 缺少必需的宿主 API: ' + report.apis.missing.map(m => m.path).join(', '))
      }
    } catch (e) { log('compat check failed (non-fatal):', e?.message ?? e) }
  })()

  // ── 工具注册 ──
  ctx.effect(() => {
    // 传 getCfg 而不是快照：每次工具调用都重读配置，wiki.config.json 热生效
    const dispose = registerTools(ctx, { getCfg, llm, caps, log, trace })
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

  // ── UI 数据接口 ──
  // 浏览器半（client/client.js）通过这一个只读端点拿全部状态。
  // 一个端点而不是多个：状态小、变化快、且 UI 只做展示，不需要细粒度刷新。
  ctx.effect(() => {
    const handler = async (req, res) => {
      try {
        const cfg = await getCfg()
        const send = (code, obj) => {
          const body = JSON.stringify(obj)
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(body)
        }
        const url = new URL(req.url, 'http://127.0.0.1')
        // 读请求体。
        //
        // ★ 桌面端（app://）的 req 是 fetch Request 的**垫片**，它的 on() 只处理
        //   close / aborted，对 'data' 和 'end' **静默返回**——body 只能靠异步迭代读
        //   （dsh-host-desktop-carrier/lib/index.js:272）。
        //   所以只挂 'data'/'end' 的话，这个 Promise 永远不 resolve，
        //   handler 一直挂着，前端收到的是 "Failed to fetch"（请求根本没拿到响应）。
        //   实测踩到：点任意一个工具前的方框就报保存失败。
        //
        //   node:http 的 IncomingMessage 同样可异步迭代，所以优先走迭代这条路，
        //   两条载体都覆盖；真到了不支持迭代的实现再退回事件。
        const readBody = () => new Promise((resolve) => {
          let b = ''
          const finish = () => { try { resolve(JSON.parse(b || '{}')) } catch { resolve(null) } }
          const take = (c) => {
            b += typeof c === 'string' ? c : Buffer.from(c).toString('utf8')
            if (b.length > 1e6) { try { req.destroy() } catch {} }
          }
          if (typeof req[Symbol.asyncIterator] === 'function') {
            void (async () => {
              try { for await (const c of req) take(c) } catch { /* 读失败按空体处理 */ }
              finish()
            })()
            return
          }
          req.on('data', take)
          req.on('end', finish)
          req.on('error', () => resolve(null))
        })

        // ── 写路径 1：改能力包配置 ──
        // 写进 <wikiRoot>/wiki.config.json（可 git、可手改），下次装配即生效。
        if (url.pathname === '/learn-wiki/api/capabilities' && req.method === 'POST') {
          const body = await readBody()
          if (!body || !Array.isArray(body.explicitOnly)) { send(400, { ok: false, error: '需要 { explicitOnly: string[] }' }); return }
          const cfgPath = join(cfg.wikiRoot, 'wiki.config.json')
          let fileCfg = {}
          try { fileCfg = JSON.parse(await readFile(cfgPath, 'utf8')) } catch { /* 首次创建 */ }
          fileCfg.capabilities = {
            ...(fileCfg.capabilities ?? {}),
            enabled: body.enabled !== false,
            explicitOnly: body.explicitOnly.filter(n => typeof n === 'string' && n),
            diagnostics: Array.isArray(body.diagnostics) ? body.diagnostics.filter(n => typeof n === 'string' && n) : (fileCfg.capabilities?.diagnostics ?? []),
            deny: fileCfg.capabilities?.deny ?? [],
          }
          await writeFile(cfgPath, JSON.stringify(fileCfg, null, 2) + '\n', 'utf8')
          log('ui: 能力包配置已更新 -> ' + JSON.stringify(fileCfg.capabilities.explicitOnly))
          send(200, { ok: true, saved: fileCfg.capabilities, note: '已写入 wiki.config.json，下一次装配生效' })
          return
        }

        // ── 写路径 2：commit 一个暂存页 ──
        // 复用与 wiki_commit 工具同一套闸门（无 sources 不许 commit）。
        if (url.pathname === '/learn-wiki/api/commit' && req.method === 'POST') {
          const body = await readBody()
          const id = body && body.id
          if (!id) { send(400, { ok: false, error: '需要 { id }' }); return }
          const all = (await loadPages(cfg.wikiRoot)).pages
          const page = all.find(p => p.id === id && p.status === 'staged')
          if (!page) { send(404, { ok: false, error: 'staged 中找不到: ' + id }); return }
          const ready = commitReadiness(page)
          if (!ready.ready) { send(409, { ok: false, error: '不满足 commit 条件', blockers: ready.blockers }); return }
          page.updated = new Date().toISOString()
          const file = await savePage(cfg.wikiRoot, page, { staged: false })
          try { await unlink(page.path) } catch { /* staged 原文件删不掉不致命 */ }
          log('ui: 已 commit ' + id)
          send(200, { ok: true, id, path: file })
          return
        }

        // ── 读路径 3：单页正文 ──
        // 列表刻意不带正文：八页正文几十 KB，每次轮询都传一遍是浪费。
        // 展开某一行时才按 id 取一次——这是"行是活的、列是死的"能成立的前提。
        if (url.pathname === '/learn-wiki/api/page' && req.method === 'GET') {
          const id = url.searchParams.get('id') || ''
          if (!id) { send(400, { ok: false, error: '需要 ?id=' }); return }
          const { pages } = await loadPages(cfg.wikiRoot)
          const page = pages.find(p => p.id === id)
          if (!page) { send(404, { ok: false, error: '找不到页面: ' + id }); return }
          const usage = await loadUsage(cfg.wikiRoot)
          const st = usage.pages[page.id]
          send(200, {
            ok: true,
            id: page.id,
            title: page.title ?? '',
            category: page.category ?? '',
            status: page.status ?? '',
            confidence: typeof page.confidence === 'number' ? page.confidence : null,
            created: page.created ?? null,
            updated: page.updated ?? null,
            tags: Array.isArray(page.tags) ? page.tags : [],
            sources: Array.isArray(page.sources) ? page.sources : [],
            body: String(page.body ?? ''),
            blockers: commitReadiness(page).blockers ?? [],
            usage: { hits: st?.hits ?? 0, confirmed: st?.confirmed ?? 0, suspect: st?.suspect ?? 0 },
          })
          return
        }

        // ── 读路径 4：待办计数（**轻量**，供常驻界面轮询）──
        //
        // 为什么不复用 /api/state：那条路径会把整个知识库（pages/ 全部正文）、
        // 使用账本、缺口队列、挣扎记录都读一遍再返回。输入框上方那条提示条是
        // **常驻**的，让它每 30 秒触发一次全库读取，就是拿用户的磁盘换一个数字。
        // 这里只读 staged/ 的 frontmatter 并数两个目录。
        if (url.pathname === '/learn-wiki/api/pending' && req.method === 'GET') {
          const brief = await readStagedBrief(cfg.wikiRoot)
          const triageCounts = await countTriage(cfg.wikiRoot)
          const items = brief.map(p => {
            // 用与 wiki_commit / api/commit 同一个闸门算 ready，
            // 否则界面会显示"可固化"而真按下时被 409 拒掉。
            const r0 = commitReadiness(p)
            return {
              id: p.id, title: p.title, category: p.category, confidence: p.confidence,
              sources: (p.sources ?? []).length, ready: r0.ready, blockers: r0.blockers ?? [],
            }
          })
          send(200, {
            ok: true,
            ts: new Date().toISOString(),
            staged: items,
            stagedTotal: items.length,
            stagedReady: items.filter(i => i.ready).length,
            trash: triageCounts.trash,
            rejected: triageCounts.rejected,
          })
          return
        }

        // ── 分拣：回收站 / 已拒绝 ──
        //
        // 这两类条目原先**没有任何界面**，只能靠读文件分拣。而它们恰恰是最需要
        // 看内容才能决定的东西，所以列表带摘录、全文按需另取（与知识页签同一个
        // 取舍：列表不带正文，八篇正文几十 KB 每次轮询都传一遍是浪费）。
        if (url.pathname === '/learn-wiki/api/triage' && req.method === 'GET') {
          const one = url.searchParams.get('rel')
          if (one) {
            const r0 = await readTriageBody(cfg.wikiRoot, one)
            send(r0.ok ? 200 : 400, r0)
            return
          }
          send(200, { ok: true, ts: new Date().toISOString(), items: await listTriage(cfg.wikiRoot) })
          return
        }

        if (url.pathname === '/learn-wiki/api/triage' && req.method === 'POST') {
          const body = await readBody()
          const action = body && body.action
          const rel = body && body.rel
          if (action !== 'restore' && action !== 'discard') {
            send(400, { ok: false, error: 'action 必须是 restore 或 discard' }); return
          }
          // ★ 永久删除是**不可逆**的，必须显式确认。
          //   前端的两段式是给人看的，服务端这一道才是真的闸 ——
          //   它同时挡住误触和"别的调用方"。
          if (action === 'discard' && body.confirm !== true) {
            send(400, { ok: false, error: '永久删除需要 confirm:true（不可逆）' }); return
          }
          const r0 = action === 'restore'
            ? await restoreTriage(cfg.wikiRoot, rel)
            : await discardTriage(cfg.wikiRoot, rel)
          log('ui: ' + action + ' ' + String(rel) + (r0.ok ? ' 成功' : ' 失败 ' + r0.error))
          send(r0.ok ? 200 : 400, r0)
          return
        }

        // ── 读路径 5：可用模型目录 + 各站点当前路由 ──
        //
        // 刻意**不**并进 /api/state：那条路径每 8 秒被轮询一次，而列模型
        // 可能打网络（适配器自己决定）。界面只在打开「模型」页签时取一次。
        if (url.pathname === '/learn-wiki/api/models' && req.method === 'GET') {
          const regs = (typeof ctx.llm?.listProviders === 'function' ? ctx.llm.listProviders() : []) ?? []
          const providers = []
          for (const p of regs) {
            let models = []
            try {
              const got = await ctx.llm.listModels(p.id)
              if (Array.isArray(got)) models = got.filter(m => m && m.id).map(m => ({ id: String(m.id), name: String(m.name ?? m.id) }))
            } catch { /* 列不出模型不是错误：适配器允许接受未列出的 id */ }
            providers.push({ id: String(p.id), name: String(p.name ?? p.id), models })
          }
          let routes = {}
          try { routes = await llm.routes() } catch (e) { routes = { error: String(e?.message ?? e) } }
          send(200, {
            ok: true,
            providers,
            llm: cfg.llm,
            sites: SITES.map(s => ({ id: s, label: SITE_LABEL[s] ?? s })),
            routes,
            lastHarvest,
          })
          return
        }

        // ── 写路径 3：改模型配置 ──
        // 与能力包同一套做法：写进 <wikiRoot>/wiki.config.json，可 git、可手改。
        // 与能力包**不同的**一点：改完立刻生效，不用重载 —— createLlm 每次调用重读。
        if (url.pathname === '/learn-wiki/api/llm' && req.method === 'POST') {
          const body = await readBody()
          if (!body || typeof body !== 'object') { send(400, { ok: false, error: '需要 JSON 体' }); return }
          const cfgPath = join(cfg.wikiRoot, 'wiki.config.json')
          let fileCfg = {}
          try { fileCfg = JSON.parse(await readFile(cfgPath, 'utf8')) } catch { /* 首次创建 */ }
          // ★ 落盘前**先过同一套归一化**（lib/llm.js 的 normalizeLlmConfig）。
          //   界面与运行时对配置的解释只有一份：否则界面能存进一个 mode 拼错的
          //   块，运行时读到时悄悄退回 single —— 存进去的和生效的不是一回事。
          const next = normalizeLlmConfig({
            mode: body.mode,
            models: body.models,
            onError: body.onError,
            sites: body.sites,
          }, { provider: fileCfg.llmProvider, model: fileCfg.llmModel })
          fileCfg.llm = next
          await writeFile(cfgPath, JSON.stringify(fileCfg, null, 2) + '\n', 'utf8')
          log('ui: 模型配置已更新 -> ' + JSON.stringify({ mode: next.mode, onError: next.onError, models: next.models.map(m => m.provider + '/' + (m.model || '*')), sites: Object.keys(next.sites) }))
          let routes = {}
          try { routes = await llm.routes() } catch { /* 目录取不到不影响保存 */ }
          send(200, { ok: true, saved: next, routes, note: '已写入 wiki.config.json，**下一次模型调用即生效**（不需要重载）' })
          return
        }

        // ── 写路径 4：手动跑一次会话提炼（界面上那个按钮）──
        //
        // 与 wiki_harvest 工具**同一份实现**：runHarvest 取材 + stageHarvestItems 落盘。
        // 落盘仍然只到 staged/ —— 按钮不是免检通道，固化照样要人去点。
        if (url.pathname === '/learn-wiki/api/harvest' && req.method === 'POST') {
          if (harvesting) { send(409, { ok: false, error: '上一次提炼还在跑，等它结束再点' }); return }
          const body = (await readBody()) ?? {}
          harvesting = true
          try {
            const focus = String(body.focus ?? '').slice(0, 300)
            const wantSession = String(body.session ?? '').trim()
            let agent = null, transcript = null, sessionRef = ''
            let targetLabel = ''
            if (wantSession) {
              const all = listSessions({ includeSubagents: true })
              const hit = all.find(s => s.id === wantSession) ?? all.find(s => s.id.startsWith(wantSession))
              if (!hit) { send(404, { ok: false, error: '没找到会话 ' + wantSession }); return }
              const trRes = await sessionTranscriptRemote(hit.file, hit, {})
              if (!trRes.ok) { send(502, { ok: false, error: '读取会话失败：' + trRes.error }); return }
              transcript = trRes.result
              sessionRef = 'session://' + hit.id
              targetLabel = hit.id
            } else {
              agent = lastAgentRef && typeof lastAgentRef.deref === 'function' ? (lastAgentRef.deref() ?? null) : null
              if (agent) {
                targetLabel = '当前会话（内存中）'
              } else {
                // 退到磁盘上**最近写过**的那个会话。按 createdAt 排序不够：
                // 一个几小时前开始、现在还在用的会话会被排到新会话后面。
                const cands = listSessions({ includeSubagents: false, limit: 20 })
                let best = null
                for (const s of cands) {
                  try {
                    const st = await stat(s.file)
                    if (!best || st.mtimeMs > best.mtimeMs) best = { ...s, mtimeMs: st.mtimeMs }
                  } catch { /* 文件没了就跳过 */ }
                }
                if (!best) { send(409, { ok: false, error: '没有可提炼的会话：内存里没有活着的会话，磁盘上也没有会话文件' }); return }
                const trRes = await sessionTranscriptRemote(best.file, best, {})
                if (!trRes.ok) { send(502, { ok: false, error: '读取会话失败：' + trRes.error }); return }
                transcript = trRes.result
                sessionRef = 'session://' + best.id
                targetLabel = best.id + '（磁盘，宿主里没有活着的会话）'
              }
            }

            const res = await runHarvest({
              agent, transcript, sessionRef, llm, focus,
              maxItems: body.maxItems,
              maxTokens: cfg.harvestMaxTokens,
              log,
            })
            if (res.skipped) {
              lastHarvest = { at: new Date().toISOString(), target: targetLabel, skipped: true, reason: res.reason, staged: 0, transcriptChars: res.transcriptChars }
              log('ui: 提炼未产出（' + targetLabel + '）：' + res.reason)
              send(200, { ok: true, skipped: true, reason: res.reason, transcriptChars: res.transcriptChars, target: targetLabel, note: '这是正常结果 —— 拒绝优于写一页没有依据的东西。' })
              return
            }
            const { written, duplicates } = await stageHarvestItems({ wikiRoot: cfg.wikiRoot, items: res.items, log })
            lastHarvest = { at: new Date().toISOString(), target: targetLabel, skipped: false, staged: written.length, duplicates: duplicates.length, transcriptChars: res.transcriptChars }
            log('ui: 提炼产出 ' + written.length + ' 页（' + targetLabel + '），跳过重复 ' + duplicates.length)
            send(200, {
              ok: true, skipped: false, staged: written,
              ...(duplicates.length ? { duplicates } : {}),
              transcriptChars: res.transcriptChars,
              target: targetLabel,
              note: '已落 staged/，去「知识」页签固化 —— 固化前不参与任何自动召回。',
            })
            return
          } catch (e) {
            log('ui: 提炼失败 ' + String(e?.message ?? e))
            send(500, { ok: false, error: '提炼失败：' + String(e?.message ?? e) })
            return
          } finally {
            harvesting = false
          }
        }

        if (url.pathname !== '/learn-wiki/api/state') { send(404, { ok: false, error: 'not found' }); return }

        const { pages } = await loadPages(cfg.wikiRoot)
        const usage = await loadUsage(cfg.wikiRoot)
        const policy = { ...DEFAULT_POLICY, ...(cfg.usagePolicy ?? {}) }
        const now = Date.now()

        const committed = pages.filter(p => p.status === 'committed').map(p => {
          const st = usage.pages[p.id]
          return {
            id: p.id, title: p.title, category: p.category, confidence: p.confidence,
            created: p.created ?? null,
            updated: p.updated ?? p.created ?? null,
            sources: (p.sources ?? []).length,
            cls: classify(st, p, { now, policy }),
            hits: st?.hits ?? 0, confirmed: st?.confirmed ?? 0, suspect: st?.suspect ?? 0,
            factor: Number(reinforcementFactor(st, now).toFixed(3)),
            quarantined: shouldQuarantine(st, policy),
          }
        })
        // staged 带上 blockers：不然 UI 只能显示一个"不能提交"的灰按钮，
        // 用户得自己去猜差什么。差什么就写什么。
        const staged = pages.filter(p => p.status === 'staged').map(p => ({
          id: p.id, title: p.title, category: p.category, confidence: p.confidence,
          sources: (p.sources ?? []).length,
          blockers: commitReadiness(p).blockers ?? [],
        }))
        const counts = {}
        for (const p of committed) counts[p.cls] = (counts[p.cls] ?? 0) + 1

        const triageCounts = await countTriage(cfg.wikiRoot)
        const gaps = await readGaps(cfg.wikiRoot)
        const gapCounts = {}
        for (const g of gaps) gapCounts[g.status] = (gapCounts[g.status] ?? 0) + 1
        const struggles = await readStruggles(cfg.wikiRoot, 200)
        const sigCounts = {}
        for (const r of struggles) for (const s of (r.signals ?? [])) sigCounts[s.type] = (sigCounts[s.type] ?? 0) + 1
        // 子代理的挣扎单独数一份。它们照记（观测要诚实），但**不产生后果** ——
        // 界面上必须能看出"这 N 条不代表项目知识不够用"。
        // 旧记录没有 origin 字段（守卫是后加的），一律算主代理，不倒推。
        const subagentStruggles = struggles.filter(r => r.origin === 'subagent').length

        // 能力包：把"看得见的成本"和"裁掉的成本"分开报。
        // UI 只拿这两个数和总数，不做四则运算——省得有一天两边口径不一致还要人去对账。
        const configuredDeny = [
          ...(cfg.capabilities?.explicitOnly ?? []),
          ...(cfg.capabilities?.diagnostics ?? []),
          ...(cfg.capabilities?.deny ?? []),
        ]
        const catalog = caps.catalogSnapshot?.(
          configuredDeny,
          // 内存里没有就回退到磁盘快照 —— 否则重启后 UI 会显示"尚未捕获"
          await loadCatalogSnapshot(cfg.wikiRoot),
        ) ?? { items: [], total: 0, capturedAt: false }
        const kept = catalog.items.filter(i => !i.denied)

        send(200, {
          ok: true,
          ts: new Date().toISOString(),
          app: { wikiRoot: cfg.wikiRoot, version: '0.1.0' },
          capabilities: {
            enabled: cfg.capabilities?.enabled === true,
            configuredDeny,
            catalog,
            totals: {
              total: catalog.items.length,
              kept: kept.length,
              denied: catalog.items.length - kept.length,
              keptTokens: kept.reduce((n, i) => n + (i.approxTokens ?? 0), 0),
              deniedTokens: catalog.items.reduce((n, i) => (i.denied ? n + (i.approxTokens ?? 0) : n), 0),
            },
          },
          skills: await skills.snapshot(),
          // 模型：只给**配置**与**上次实际用过谁**。
          // 刻意不在这里列 provider/模型 —— 那条路径每 8 秒轮询一次，
          // 而列模型可能打网络。要完整目录就打开「模型」页签（/api/models）。
          llm: {
            mode: cfg.llm?.mode ?? 'single',
            onError: cfg.llm?.onError ?? 'next',
            models: (cfg.llm?.models ?? []).map(m => ({ provider: m.provider, model: m.model })),
            sites: cfg.llm?.sites ?? {},
            siteList: SITES.map(s => ({ id: s, label: SITE_LABEL[s] ?? s })),
            lastUsed: Object.fromEntries(SITES.map(s => [s, llm.used(s)])),
            lastHarvest,
          },
          knowledge: { committed, staged, counts, threshold: { hit: cfg.hitThreshold, weak: cfg.weakThreshold } },
          gaps: { counts: gapCounts, total: gaps.length, recent: gaps.slice(-12).map(g => ({ query: String(g.query).slice(0, 90), status: g.status })) },
          // 分拣计数顺手带上（两次 readdir，可以忽略）。面板打开时 /api/state 每 8 秒
          // 轮询一次，界面据此在页签头上写字。
          triage: { ...triageCounts, total: triageCounts.trash + triageCounts.rejected },
          struggles: {
            total: struggles.length,
            counts: sigCounts,
            subagent: subagentStruggles,
            recent: struggles.slice(-8).map(r => ({
              ts: r.ts,
              signals: (r.signals ?? []).map(s => s.type),
              origin: r.origin ?? 'agent',
            })),
          },
        })
      } catch (e) {
        try { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) })) } catch {}
      }
    }
    // 必须用 prefix，不能用 exact。
    //
    // 一个 handler 要服务四条路径：/api/state、/api/page、/api/commit、/api/capabilities。
    // exact 只会把 /api/state 放进来，其余路径**根本到不了这个 handler**，
    // 前端于是收到宿主自己的 404（HTML），JSON.parse 直接炸成
    // 「Unexpected token '<' ... is not valid JSON」。
    // 实测踩到了：单页接口在界面上永远显示"读不到正文"。
    // 而当时的测试是直接调 route.handler 的，绕过了路由匹配，所以测不出来。
    //
    // path **不能带尾斜杠**。宿主（dsh-host-webserver/lib/index.js:199）的匹配是：
    //     if (pathname !== prefix && !pathname.startsWith(prefix + '/')) continue
    // 也就是它拿 prefix 和 prefix+'/' 两种形态去比。写成 '/learn-wiki/' 之后
    // 它会去找 '/learn-wiki//api/state'——永远不匹配，请求落到 SPA 兜底路由，
    // 前端拿到 index.html（**HTTP 200**，content-type: text/html）。
    // 这个比 404 更难查：状态码是成功的。
    const dispose = ctx.webServer.register({ kind: 'prefix', path: '/learn-wiki', handler })
    // 覆盖清单**手写**在这里，所以它会随着加端点而过时 —— 实测就过时过一次
    // （加了 models/llm/harvest 之后这行还在报旧的六条）。日志说假话比不写更糟，
    // 所以清单与路由放在一起，加路由时顺手改。
    log('ui: /learn-wiki 已注册（prefix，覆盖 api/state|page|commit|capabilities|pending|triage|models|llm|harvest）')
    return () => { try { dispose() } catch {} }
  }, 'dsh-learn-wiki: ui route')

  // ── 能力包装配 ──
  // agent/created 在作用域 setup 之后、驱动器启动之前触发，
  // 所以掩码能赶上第一次提示词组装。每个 agent 只装一次。
  ctx.on('agent/created', ({ agent }) => {
    noteAgentScope(agent)
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

      // ★ 子代理的挣扎**不是**关于我们知识的证据。
      //
      // 实测踩到（2026-09-11）：派出去做调研的子代理因为不知道"工具只能从
      // run_code 里调"，连续 5 次调 read 失败 -> 触发 repeat-failure ->
      // 插件把它的**任务提示词**当成知识缺口写进共享 gap 队列并联网搜索，
      // 还把子代理会话 id 记了进去。同一批里另一条 gap 最终沉淀出了一页
      // 关于**完全另一个撞名项目**的内容。
      //
      // 结构性原因：子代理是临时工。它的挣扎多半来自我们给它的提示词写得
      // 不好、或者任务本身超出它拿到的上下文 —— 这两者都不该记到项目知识
      // 的账上。拿子代理的挣扎去降权一条好知识，等于让临时工给正式员工
      // 打绩效。
      //
      // 所以：子代理的挣扎**照记**（观测数据要诚实，也要能量化这个现象的
      // 规模），但**不产生任何后果** —— 不记嫌疑、不进 gap 队列、不触发联网。
      const sub = isSubagent(agent)

      // ★ 投递路径：投递之后**仍然**挣扎 -> 这条补料没帮上忙。
      // 这是最有价值也最贵的一类证据 —— 补料是花钱搜来的，而且比 L1 召回更主动。
      const pend = agent.id ? pendingDeliveries.get(agent.id) : null
      if (pend && pend.size > 0) {
        pendingDeliveries.delete(agent.id)
        const ids = [...pend.keys()]
        if (sub) {
          log('usage: 子代理投递后仍挣扎，不记嫌疑（仅记录）: ' + ids.join(','))
        } else {
          void updateUsage(liveCfg.wikiRoot, u => recordSuspect(u, ids))
            .then(() => log('usage: 投递后仍挣扎，记嫌疑 ' + ids.join(',')))
            .catch((e) => log('usage suspect(deliver) failed (non-fatal):', e?.message ?? e))
        }
      }

      // ★ 最有价值的一类证据：这一轮的注入**没能阻止**挣扎。
      // 那条知识要么没用，要么有害。降权它（不是删除 —— 降权可逆）。
      const inj = agent.id ? turnInjections.get(agent.id) : null
      if (inj && !inj.struggled && inj.pages.size > 0) {
        inj.struggled = true
        if (sub) {
          log('usage: 子代理挣扎，不记嫌疑（保留原级）: ' + [...inj.pages].join(','))
        } else {
          void updateUsage(liveCfg.wikiRoot, u => recordSuspect(u, [...inj.pages]))
            .then(() => log('usage: 记为嫌疑 ' + [...inj.pages].join(',')))
            .catch((e) => log('usage suspect failed (non-fatal):', e?.message ?? e))
        }
      } else if (agent.id && !inj) {
        // 没注入过就没得判 —— 不要伪造证据
      }
      void recordStruggle(liveCfg.wikiRoot, {
        ts: new Date().toISOString(),
        sessionId: agent.id ?? '',   // 必须是字符串：undefined 会让工具输出非 lossless JSON
        mode: liveCfg.struggleMode,
        signals: fired,
        // ★ 来源必须标出来。不标的话，子代理的记录和主代理的记录在界面上
        //   长得一模一样，而两者的含义完全不同 —— 一个说明"项目知识不够用"，
        //   另一个只说明"我派活的提示词没写好"。
        origin: sub ? 'subagent' : 'agent',
        depth: delegationDepth(agent),
      })
      const gapWanted = liveCfg.struggleMode === 'active'
        && (liveCfg.gapTrigger === 'struggle' || liveCfg.gapTrigger === 'both')
      if (gapWanted && sub) {
        // 明说跳过。这个项目的复发型故障是"静默 no-op"——一个悄悄不干活的
        // 分支，比一个干错活的分支更难查。
        log('struggle -> gap: 跳过（子代理，它的工具误用不是项目知识缺口）')
      } else if (gapWanted) {
        // ★ 只有"这个查询在网上存在"的信号才配去联网。
        //
        //   repeat-failure / recurring-error 带的是**错误文本**，可搜 ——
        //     网上真的有人踩过同一堵墙并写下来。
        //   edit-churn 带的只是一个**本地文件名**："反复修改 client.js 仍不成功"
        //     这句话网上不存在。检索它最坏的结果是撞上同名项目 —— 实测它沉淀出过
        //     一页关于**另一个叫 llm-wiki 的 npm 包**的内容，只因为都在改 client.js。
        //
        //   不适用的信号仍然**照常记录**（观测要诚实），只是不产生 gap。
        const usable = fired.filter(s => (liveCfg.gapTriggerSignals ?? []).includes(s.type))
        if (usable.length === 0) {
          // 明说跳过。不留静默 no-op：这个分支以前会去联网搜一个网上不存在的字符串，
          // 而"悄悄不干活"和"干错活"一样难查。
          log('struggle -> gap: 跳过（' + fired.map(s => s.type).join(',') + ' 不适合联网检索）')
        } else {
          // 把挣扎翻译成**症状查询**再登记 —— 不是用户的原话。
          // 原话是意图（"ok 按你的倾向来"），搜索引擎只能给出噪声；
          // 症状（报错文本、反复失败的工具）才是网上真有人写过的。
          const q = symptomQuery(usable, lastQuery.get(agent) ?? '')
          if (q && q.length >= 6) {
            log('struggle -> gap: ' + q.slice(0, 90))
            // 记住是哪个 agent 卡住了 —— 补料完成后要把结果投递回**它**的这一轮
            strugglingAgent = agent
            void appendGap(liveCfg.wikiRoot, { query: q, score: 0, sessionId: agent.id ?? '' })
              .then(() => scheduleAcquire())   // 立刻推一次，不等轮次结束
              .catch((e) => log('struggle gap failed (non-fatal):', e?.message ?? e))
          }
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

    // ── 技能目录按 agent 裁剪 ──
    //
    // ★ 位置是关键：必须在 step!==1 的提前 return **之前**。
    //   技能目录那条消息是**留在会话历史里**的，每一步组装提示词时都会带上，
    //   所以只裁第一步等于没裁（后续每一步又原样带全量）。
    //
    // ★ 只改渲染文本，绝不碰 source.entries —— 宿主的 digest 覆盖 entries，
    //   动它会让宿主判定目录变化并**每一步重发一遍**。
    if (cfg.skills?.enabled === true && decision.messages?.length) {
      try {
        const t = applySkillTrim(decision.messages, { cfg, agentKey: agentKeyOf(agent), log })
        if (t.changed) {
          decision = { ...decision, messages: t.messages }
          log('skills: 已按 ' + agentKeyOf(agent) + ' 裁剪目录（去掉 ' + t.removed + ' 条）')
        }
      } catch (e) { log('skills trim failed (non-fatal):', e?.message ?? e) }
    }

    // ── 第三个触发器：被纠正 ──
    //
    // 补的是另外两个触发器共同的盲区：**工具全都成功、但答案是错的**。
    // 那一刻没有报错、挣扎检测器一声不响，而用户说"不对" —— 这是唯一能看见它的信号。
    //
    // 动作**不是**补料：答案来自用户，联网去搜用户刚说过的话是最糟的反应。
    // 动作是两件：把上一轮注入过的那条知识标成嫌疑，并把用户原话记下来。
    if (step === 1 && !isSubagent(agent)) {
      try {
        const c = looksLikeCorrection(queryFrom(messages))
        if (c.yes) {
          const prev = agent.id ? turnInjections.get(agent.id) : null
          // ★ 只在**上一轮工具层看起来没问题**时才归因。
          //   如果上一轮已经因为挣扎记过嫌疑，再记一次就是同一件事数两遍 ——
          //   而那会让"撞了几次"这类阈值整体失真。
          //   反过来，"没挣扎却被纠正"才是这里唯一的新信息。
          const ids = prev && !prev.struggled ? [...prev.pages] : []
          if (ids.length) {
            void updateUsage(cfg.wikiRoot, u => recordSuspect(u, ids))
              .then(() => log('correction: 用户纠正，记嫌疑 ' + ids.join(',')))
              .catch((e) => log('correction suspect failed (non-fatal):', e?.message ?? e))
          }
          void recordStruggle(cfg.wikiRoot, correctionRecord({
            agent, text: queryFrom(messages), markers: c.markers, corrected: ids,
            origin: 'agent', depth: delegationDepth(agent),
          }))
          if (agent.id) turnInjections.delete(agent.id)
          log('correction: 检测到纠正（' + c.markers.join(',') + '）'
            + (ids.length ? ' -> 上一轮注入的 ' + ids.length + ' 页记嫌疑' : '（上一轮无可归因的注入）'))
        }
      } catch (e) { log('correction check failed (non-fatal):', e?.message ?? e) }
    }

    if (step === 1) tracker.reset(agent)
    if (step !== 1) return decision                                  // 每轮第一步 = "工作前"
    if (decision.kind === 'reject') return decision
    if (!decision.messages || decision.messages.length === 0) return decision

    // 兜底触发：即使 session/event 那条路因宿主版本差异失效，
    // 补料仍会在下一轮开始时被推动。acquiring 锁 + 冷却保证不会重复烧钱。
    scheduleAcquire()

    // 记 agent 作用域。放在提前 return **之前**——短查询也要记，
    // 否则用户连着发几条短消息时，UI 那边的作用域就会一直是旧的。
    noteAgentScope(agent)

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
      // ★ 命中记录走原子更新，**不能**复用上面那份 usage 快照。
      //   那份快照是几百毫秒前读的，只用来打分；拿它整体写回会抹掉这段时间里
      //   别人（另一个 agent 的 pre-step、后台补料）刚记下的 suspect/confirm。
      void updateUsage(cfg.wikiRoot, u => recordHit(u, allInjected)).catch(() => {})
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
        onStaged: target ? async (page) => {
          const ok = await deliverToCurrentTurn(target, page, log)
          if (!ok || !target.id) return
          // 投递本身也是一次"曝光" —— 它确实进了模型上下文
          // 存 { id -> 投递时刻 }，用于判断"有没有给模型留出使用它的时间"
          const map = pendingDeliveries.get(target.id) ?? new Map()
          map.set(page.id, Date.now())
          pendingDeliveries.set(target.id, map)
          try {
            await updateUsage(liveCfg.wikiRoot, u => recordHit(u, [page.id]))
          } catch (e) { log('usage hit(deliver) failed (non-fatal):', e?.message ?? e) }
        } : null,
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
          void updateUsage(liveCfg.wikiRoot, u => recordConfirmed(u, toConfirm))
            .then(() => log('usage: 记为确认 ' + toConfirm.join(',')))
            .catch((e) => log('usage confirm failed (non-fatal):', e?.message ?? e))
        }
      }
      // 投递过的页：这一轮结束时没被记嫌疑 -> 弱确认（它至少没让情况更糟）
      if (pendingDeliveries.size > 0) {
        const nowMs = Date.now()
        const dwell = liveCfg.deliveryConfirmMinDwellMs ?? 10000
        const okIds = []
        const tooEarly = []
        for (const [, map] of pendingDeliveries.entries()) {
          for (const [id, at] of map.entries()) {
            // 只给"投递后确实又工作了一段时间"的记确认；刚投递就结束轮次的，什么都不记
            if (nowMs - at >= dwell) okIds.push(id); else tooEarly.push(id)
          }
        }
        pendingDeliveries.clear()
        if (tooEarly.length > 0) log('usage: 投递后观察期不足，不作判定 ' + tooEarly.join(','))
        if (okIds.length > 0) {
          void updateUsage(liveCfg.wikiRoot, u => recordConfirmed(u, okIds))
            .then(() => log('usage: 投递后无新挣扎，记确认 ' + okIds.join(',')))
            .catch((e) => log('usage confirm(deliver) failed (non-fatal):', e?.message ?? e))
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
