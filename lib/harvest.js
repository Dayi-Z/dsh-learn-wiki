// 从**当前会话**里提炼可复用的知识 —— /learn 的等价物。
//
// ── 为什么需要这一块（这是这套插件目前最大的缺口）──
//
// 现有两个触发器都是关于"我们自己失败"的信号：
//   * 检索未命中 —— 我不知道
//   * 挣扎      —— 我卡住了
// 它们发现不了第三种，也是最值钱的一种：**我们刚刚想清楚了一件事**。
//
// 实测（2026-09-11）：一次会话里用户亲口说出了一条设计规则
// （"位置表达状态是个陷阱"），而它一行都没有被沉淀 —— 因为它不经过任何一个
// 触发器。同一次会话自动闭环产出的，却是一页关于**另一个撞名项目**的内容。
// 信号选错了，产出就是反的。
//
// Hermes Agent 用 \`/learn\` 解决这个：它的输入可以是**刚走完的这段对话**
// （"how I just deployed the staging server"）。这一份是它的等价物 ——
// 把"刚刚谈出来的东西"变成 staged 页，仍然经过同一个人工闸。
//
// ── 一个有意的差异 ──
// Hermes 学的是**技能**（可复用过程），我们学的是**知识页**（事实 + 教训）。
// 本期不引入"过程"这个新单元：阶段优先做成同一个 staged→commit 闸门下的
// 一个**新入口**，而不是一个新物种。多一个物种的代价是召回、证据账、
// 界面全都要分叉 —— 那是一次大得多的改动。
import { extractJson } from './llm.js'
import { CATEGORIES, deriveId, loadPages, savePage } from './wiki.js'
// 取材规则**只有一份**：当前会话与历史会话必须用同一套取舍。
// 否则"同一段对话，实时提炼和事后提炼得到不同的东西"——那种不一致极难发现，
// 而且会让人以为是模型不稳定。sessionTranscript() 是那条唯一的路。
import { sessionTranscript } from './session-digest.js'

/** 会话里哪些消息是**人真正说的话**。其余全是注入物，不是证据。 */
const HUMAN_SOURCE = 'user'

/**
 * 把会话事件压成一段人可以读的对话记录。
 *
 * 只取两类东西：
 *   * \`user/message\` 且 \`data.source.kind === 'user'\` —— 人说的话
 *   * \`assistant/message\` 里的 text 段 —— 助手说出口的话
 *
 * **刻意不要**的：
 *   * reasoning 段：那是模型的草稿，不是结论。把草稿当证据提炼，等于把
 *     想歪的过程也一起沉淀下来。
 *   * tool-call / 工具结果：体积巨大且大部分与结论无关。
 *   * source.kind 为 plugin / skill-catalog / subagent-settled 的 user 消息：
 *     它们是我们自己注入的（知识块、技能目录、子代理回执）。**把它们当成人
 *     说的话，就会把我们自己的输出再学一遍** —— 一个自我强化的回音室。
 *
 * 真实形状（解出真实会话确认过，别照猜）：
 *   user/message      data = { content:[{type:'text',text}], source:{kind}, role, id }
 *   assistant/message data = { turn, step, message:{ role, content:[...] }, usage }
 */
export function extractSessionText(agent, opts = {}) {
  const events = Array.isArray(agent?.session?.events) ? agent.session.events : []
  return { ...sessionTranscript(events, opts), sessionRef: agent?.id ? 'session://' + agent.id : '' }
}

/** 从**历史会话**的事件里取材（与实时路径共用同一套取舍规则）。 */
export function extractEventsText(events, sessionRef, opts = {}) {
  return { ...sessionTranscript(Array.isArray(events) ? events : [], opts), sessionRef: sessionRef ?? '' }
}

export const HARVEST_SYSTEM = [
  'You extract durable, reusable knowledge from a development conversation for a project knowledge base.',
  'The conversation is the ONLY source. Never add facts from your own memory or from general world knowledge.',
  'Extract only what would still be true and useful in a FUTURE session: design rules, root causes,',
  'hard-won constraints, decisions with their rationale, non-obvious pitfalls.',
  'Do NOT extract: what was done in this session (that is history, not knowledge), restatements of the',
  'conversation, TODO items, or anything already obvious from reading the code.',
  'Most conversations contain at most 1-3 durable items. If nothing qualifies, you MUST refuse by',
  'returning {"skip": true, "reason": "..."}. Refusing is always better than writing a weak page.',
  'For sources, list only concrete references actually present in the conversation: file paths, URLs,',
  'or commands. Do not invent them. If there are none, return an empty list.',
  'Output STRICT JSON only, no prose, no markdown fences.',
].join(' ')

export function buildHarvestPrompt({ transcript, focus, maxItems }) {
  const lines = [
    'Extract at most ' + maxItems + ' durable knowledge items from this conversation.',
    focus ? 'Focus specifically on: ' + focus : '',
    '',
    'Return JSON of exactly this shape:',
    '{"skip": false, "items": [{"title": "...", "category": "fact|decision|lesson|howto",',
    '  "confidence": 0.0-1.0, "tags": ["..."], "sources": ["..."], "body": "markdown"}]}',
    'or {"skip": true, "reason": "..."} when nothing qualifies.',
    '',
    'The body should be self-contained: someone who was not in this conversation must be able to act on it.',
    'Write it in the same language the conversation is in.',
    '',
    '--- CONVERSATION START ---',
    transcript,
    '--- CONVERSATION END ---',
  ]
  return lines.filter(Boolean).join('\n')
}

/**
 * 跑一次提炼。返回 { items, skipped, reason, considered, transcriptChars }。
 *
 * 与 L3 补料的蒸馏器共享同一条纪律：**允许拒绝，而且拒绝优于写一页弱的**。
 * 区别只在来源 —— 这里是人说过的话，不是搜来的网页。
 */
export async function runHarvest({ agent, events, transcript, sessionRef, llm, focus = '', maxItems = 3, maxTokens = 3000, log = () => {} } = {}) {
  // 三条取材路径，**同一套取舍规则**（都出自 sessionTranscript）：
  //   agent      —— 当前会话（agent.session.events 就在手上）
  //   events     —— 历史会话，调用方已经把事件数组拿在手上
  //   transcript —— 历史会话，调用方**流式**抽好了取材、没把整个会话读进内存
  //                 （大会话一次读进来实测要 ~370 MB 堆和 2.5 秒阻塞，
  //                   而这段跑在宿主主线程上）
  const ex = transcript
    ? { text: transcript.text, turns: transcript.turns ?? 0, chars: transcript.chars ?? 0, sessionRef: sessionRef ?? '' }
    : Array.isArray(events)
      ? extractEventsText(events, sessionRef, {})
      : extractSessionText(agent, {})
  if (!ex.text || ex.text.length < 200) {
    return { items: [], skipped: true, reason: '会话内容太少，不值得提炼（至少 200 字符）', considered: 0, transcriptChars: ex.text.length }
  }
  const capped = Math.max(1, Math.min(6, Number(maxItems) || 3))
  const raw = await llm.chat({
    site: 'harvest',
    system: HARVEST_SYSTEM,
    prompt: buildHarvestPrompt({ transcript: ex.text, focus, maxItems: capped }),
    // 走参数（默认值见 config 的 harvestMaxTokens），不写死在这里：
    // 与 acquire.js 的 distillMaxTokens 保持同样的可调性。
    maxTokens: Math.max(256, Number(maxTokens) || 3000),
    temperature: 0.15,
  })
  const j = extractJson(raw)
  if (!j) {
    // ★ 解析失败必须**把原始输出带出来**，否则这条失败是不可诊断的。
    //
    //   实测（本功能第一次真实调用）：返回的就是这一句「模型没有返回合法 JSON」，
    //   而原始输出被丢掉了 —— 于是完全无法判断是**截断**（撞 maxTokens）、
    //   是**格式**（没用严格 JSON）、还是**空回复**。三种原因的修法完全不同：
    //   截断要调 maxTokens，格式要改 prompt，空回复要查 provider。
    //   这个项目的复发型故障就是「静默失败」，所以这里连同长度一起记下来。
    const text = String(raw ?? '')
    log('harvest: 解析失败 len=' + text.length + ' 开头=' + JSON.stringify(text.slice(0, 160)))
    return {
      items: [], skipped: true, reason: '模型没有返回合法 JSON',
      considered: 0, transcriptChars: ex.text.length,
      rawLength: text.length,
      rawPreview: text.slice(0, 600),
    }
  }
  if (j.skip === true) {
    return { items: [], skipped: true, reason: String(j.reason ?? '模型认为这段对话没有值得长期保留的东西'), considered: 0, transcriptChars: ex.text.length }
  }
  const list = Array.isArray(j.items) ? j.items : []
  const items = []
  for (const it of list.slice(0, capped)) {
    if (!it || typeof it !== 'object') continue
    const title = String(it.title ?? '').trim()
    const body = String(it.body ?? '').trim()
    if (!title || !body) continue
    const category = CATEGORIES.includes(it.category) ? it.category : 'fact'
    const conf = Number(it.confidence)
    items.push({
      title,
      body,
      category,
      confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5,
      tags: Array.isArray(it.tags) ? it.tags.map(String).filter(Boolean) : [],
      // 会话锚点**永远**在 sources 里：这一页的来源首先是"某次对话"，
      // 模型额外认出来的文件/URL 是补充，不是替代。
      sources: [
        ...(Array.isArray(it.sources) ? it.sources.map(String).filter(Boolean) : []),
        ...(ex.sessionRef ? [ex.sessionRef] : []),
      ],
    })
  }
  log('harvest: ' + items.length + ' 条候选（会话 ' + ex.chars + ' 字符 / ' + ex.turns + ' 轮）')
  return { items, skipped: items.length === 0, reason: items.length === 0 ? '模型没有给出可用的条目' : '', considered: list.length, transcriptChars: ex.text.length }
}

/**
 * 把提炼出的条目落进 staged/。
 *
 * ★ 抽出来是为了**只有一份**：wiki_harvest 工具和界面上的「从会话提炼」按钮
 *   必须走同一套判重与落盘。各写一份的话，"按钮出来的页和工具出来的页不一样"
 *   会是一个极难发现的故障 —— 两边的判重规则会各自漂。
 *
 * 判重**同时**按 id 和标题：
 *   实测踩到过 —— deriveId() 对含 CJK 的标题会退化成 note-<hash>
 *   （slugify 把中文整个剥掉），于是人手写的 position-not-state 与自动提炼出的
 *   note-6a26bd **标题一模一样、id 完全不同**，只按 id 判重形同虚设，
 *   同一个知识点在库里躺两份。id 只是文件名，**标题才是给人看的身份**。
 *
 * 一律落 staged，不提供 commit —— 自动产出必须经人工闸，这条路径不例外。
 */
export async function stageHarvestItems({ wikiRoot, items, log = () => {} } = {}) {
  const { pages } = await loadPages(wikiRoot)
  const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, '')
  const existingIds = new Set(pages.map(p => p.id))
  const existingTitles = new Set(pages.map(p => norm(p.title)))
  const now = new Date().toISOString()
  const written = []
  const duplicates = []
  for (const it of (Array.isArray(items) ? items : [])) {
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
    const file = await savePage(wikiRoot, page, { staged: true })
    written.push({ id, title: it.title, category: it.category, confidence: it.confidence, sources: (it.sources ?? []).length, path: file })
  }
  if (duplicates.length) log('harvest: 跳过 ' + duplicates.length + ' 条重复（' + duplicates.map(d => d.title).join('、') + '）')
  return { written, duplicates }
}
