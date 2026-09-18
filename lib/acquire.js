// L3 采集层：gap 队列 → 限流联网 → 蒸馏 → 落 staged。
//
// 关键设计：
//   * 非阻塞 —— 本层只在 turn/end 之后后台跑，绝不打断正在进行的轮次
//   * 可拒绝 —— 蒸馏允许返回 {skip:true}。搜到的东西答不上这个缺口就不写，
//               这是防止知识库被稀释/投毒的第一道闸
//   * 不直接进 L1 —— 一律落 staged/，要经 commit 才升入 pages/
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { extractJson } from './llm.js'
import { savePage, deriveId } from './wiki.js'
import { looksLikeGap } from './recall.js'
import { redact, looksSecret } from './redact.js'
import { withLock } from './lock.js'
import { extractReadableText, looksLikeShell } from './extract.js'

const GAPS = 'gaps/queue.jsonl'

export function hashQuery(q) {
  const norm = String(q ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
  return createHash('sha256').update(norm).digest('hex').slice(0, 12)
}

export async function readGaps(repoRoot) {
  try {
    const raw = await readFile(join(repoRoot, GAPS), 'utf8')
    return raw.split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

export async function writeGaps(repoRoot, gaps) {
  await mkdir(join(repoRoot, 'gaps'), { recursive: true })
  await writeFile(join(repoRoot, GAPS), gaps.map(g => JSON.stringify(g)).join('\n') + (gaps.length ? '\n' : ''), 'utf8')
}

/**
 * 记一条检索未命中。同一 query 只保留一条，重复出现累加 seen。
 *
 * ★ 整段读-改-写必须在锁里。
 *
 * 底下是整文件 read→改→write。两条 appendGap 并发跑时，后写的那条拿旧快照
 * 整体覆盖，前一条刚登记的 gap **静默消失** —— 表现就是"挣扎了但什么都没学到"，
 * 而且不留任何痕迹。
 *
 * 实测（verify-subagent-guard.mjs 第一次跑）：两个 agent 相隔 3ms 各登记一条，
 * 最终 queue.jsonl 里只剩一条。
 *
 * acquire.js:316 早就记过同一类坑，但当时只在 runAcquisition 里打了局部补丁
 * （重读+合并），appendGap 自己还是裸的。教训是：**逐个调用方打补丁治不了
 * 这一类 bug**，每个新调用方都是一次新的机会。所以锁加在原语上。
 */
/**
 * gap 队列的**原子**读-改-写。
 *
 * ★ 为什么必须有这个原语，而不是让各调用方自己 read→改→write：
 *
 *   queue.jsonl 是整文件读-改-写。两条这样的序列并发跑，后写的那条会拿
 *   旧快照整体覆盖，前一条刚写进去的 gap **静默消失** —— 表现是"挣扎了但
 *   什么都没学到"，而且不留痕迹。
 *
 *   这个坑在本文件里已经踩过两次，每次都只修了**当时那个调用方**：
 *     1. appendGap 与 runAcquisition 互吃 —— 给 appendGap 加了锁；
 *     2. 两个并发 appendGap 互吃 —— 把锁提到 appendGap 里面。
 *   而 runAcquisition 的回写**始终是裸的**：它只是把"读"从 293 行挪到了
 *   342 行（重读+合并），把窗口缩小了，**并没有关掉**。
 *   （lib/lock.js 的注释把这条教训写得很清楚：逐个调用方打补丁治不了这一类
 *     bug，要把原语本身做成安全的 —— 这里就是把最后那个裸调用方收进来。）
 *
 *   实测证据：verify-plugin 的"投递回当前轮"偶发失败，诊断显示挣扎日志里
 *   明明白白记了 gap、队列里却没有它 —— 就是被同一时刻启动的补料回写覆盖了。
 *
 * fn(gaps) 可以原地改，也可以返回一个新数组；返回非数组时按原地改处理。
 */
export async function updateGaps(repoRoot, fn) {
  return withLock('gaps:' + repoRoot, async () => {
    const gaps = await readGaps(repoRoot)
    const out = await fn(gaps)
    // 返回**真正写进去的那个数组**，而不是 fn 的返回值 —— 调用方拿它继续用
    // 时不该需要知道 fn 是原地改还是返回了新数组。
    const final = Array.isArray(out) ? out : gaps
    await writeGaps(repoRoot, final)
    return final
  })
}

export async function appendGap(repoRoot, { query, score, sessionId = '' }) {
  // 脱敏必须在**写盘之前**。实测发生过：用户消息里带 API key，
  // 因为"检索未命中"被记成 gap，然后带着 key 去联网搜索了。
  query = redact(query)
  const id = hashQuery(query)
  await updateGaps(repoRoot, (gaps) => {
    const now = new Date().toISOString()
    const existing = gaps.find(g => g.id === id)
    if (existing) {
      existing.seen = (existing.seen ?? 1) + 1
      existing.lastSeen = now
      existing.score = score
      // 刻意不把 done/skipped/abandoned 复位为 pending：
      // 否则一个查不到的缺口会每轮重新触发联网，费用与噪声都会失控。
      // 需要重查时走 wiki_review 显式重置。
    } else {
      // 入队即质量闸：客观不可检索的查询（脱敏占位符 / JSON 转储 / 终端片段 /
      // DSH 内部契约错误）直接以 skipped 落库 —— 记录照记（台账诚实），但永不
      // 进入 pending，也就永远不会烧掉每轮 maxAcquisitionsPerRun 的联网预算。
      const unsearchable = unsearchableGapReason(query)
      gaps.push({
        id, query: String(query).slice(0, 500), score, sessionId,
        status: unsearchable ? 'skipped' : 'pending', attempts: 0, seen: 1,
        firstSeen: now, lastSeen: now,
        lastStatus: unsearchable ? 'skipped' : undefined,
        lastReason: unsearchable || undefined,
      })
    }
  })
  return id
}

/**
 * 判断一条 gap 查询是不是「客观不可检索」——网上不可能有对应内容，
 * 联网 + 蒸馏只会烧掉预算（默认 maxAcquisitionsPerRun=2/轮）然后返回 skipped。
 *
 * 实测队列（2026-09）：16/24 是 skipped，其中大部分属于这几类：
 *   · 脱敏占位符（DSH 侧把路径/数字显示成 <path> / <n>，https:/<path> 之类）
 *   · 终端输出片段（"Press Ctrl+C to quit" 这种守护进程心跳）
 *   · 原始 JSON 转储被当成查询
 *   · DSH 内部契约/用法错误（missing required property、workspace not registered）
 *   · 命令**正常结束**被误当错误（"run_code settled"）
 * 这些要么是环境内部错误（查自己代码，不是查网上），要么连错误都不是。
 *
 * 返回 '' 表示可以联网；否则返回一句话原因（会写进 gap.lastReason）。
 * 只收录**高精度**模式：宁可让泛化的"pwsh 连续失败"多试一轮（蒸馏器会拒），
 * 也不要误杀"old_string was not found in \"<path>\"" 这种真缺口 ——
 * 它虽含脱敏占位符，但核心错误短语是可检索的（知识库里已有一页，22 次确认命中）。
 */
const UNSEARCHABLE_RE = [
  [/^\s*[{[]/m, '查询是 JSON/数组转储'],
  [/Press Ctrl\+C to quit/i, '查询是终端输出片段'],
  [/invalid arguments:\s*missing required property/i, 'DSH 工具参数契约错误'],
  [/workspace not registered/i, 'DSH 工作区内部错误'],
  [/unknown tool\s+["']/i, 'DSH 未知工具错误'],
  [/only `run_code`/i, 'DSH 工具限制错误'],
  [/run_code settled/i, '命令正常结束被误当错误'],
  [/all engines failed/i, '引擎失败链（无单点症状）'],
  [/https?:\s*\/\s*<[a-z]+>/i, '查询含脱敏 URL 占位符'],
]

export function unsearchableGapReason(query) {
  const q = String(query ?? '').trim()
  if (!q) return '查询为空'
  for (const [re, label] of UNSEARCHABLE_RE) {
    re.lastIndex = 0
    if (re.test(q)) return label
  }
  return ''
}

const DISTILL_SYSTEM = [
  'You distill durable, reusable knowledge from web search results for a developer knowledge base.',
  'You are strictly grounded: use ONLY the provided search results. Never add facts from your own memory.',
  'If the results do not actually answer the question, you MUST refuse by returning {"skip": true, "reason": "..."}.',
  'Refusing is always better than writing a weakly-supported page. Most gaps should NOT produce a page.',
  'Output STRICT JSON only, no prose, no markdown fences.',
].join(' ')

/**
 * 极简 HTML → 文本。
 *
 * ★ 现在委托给 lib/extract.js 的正文抽取。原来这里是"正则去标签 + 压空白"，
 *   实测那个做法在两件事上同时失败（详见 extract.js 顶部的实测数据）：
 *   导航噪声挤掉正文、以及"截断截在噪声上"。
 *
 * 保留这个导出名是因为它有外部调用方，改名字的代价是运行时才发现。
 * 语义变成"返回紧凑一行文本"，与原来一致。
 */
export function htmlToText(html) {
  return extractReadableText(html, { maxChars: 120000 }).text.replace(/\s+/g, ' ').trim()
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const MAX_RAW = 800000

/**
 * 取一个 URL 的正文。
 *
 * 两级策略，因为宿主未必有 fetch 能力：@deepseek-ai/dsh-web 里有
 * registerFetchProvider 这套 seam，但随包发布的只有 dsh-web-search-deepseek，
 * 没有 *-fetch-* 实现。本 profile 实测 ctx.web.fetch 不是函数 ——
 * 于是"直连兜底"在这里是常态而非例外。
 *
 * 之前把 fetch 缺失当成"取不到正文"直接返回空数组，结果两条 gap 都因为
 * "0 page(s) fetched" 被蒸馏器正确拒绝。缺的从来不是判断力，是料。
 */
/**
 * 一个 URL 的抓取结果。
 *
 * 三个字段各自回答一个不同的问题，**不能合并成一个"成没成"**：
 *   text       —— 拿到了什么（可能为空）
 *   path       —— 走的是哪条路（host / direct）。两条路的合规策略不同，
 *                 出问题时要能区分是"宿主拦了"还是"站点拦了"
 *   shell      —— 抓到了但**没渲染出正文**（实测 GitHub issue 全文 373KB
 *                 HTML、剥完只剩 874 字符的表单提示语）。它和"抓取失败"
 *                 是完全不同的故障：前者该换来源，后者该换抓取方式。
 */
export async function fetchUrlTextDetailed(ctx, url, { timeoutMs = 15000 } = {}) {
  const attempts = []
  // 1) 宿主 seam 优先。
  //
  //    ★ 这条注释以前写的是"随包发布的没有 fetch 实现，所以直连是常态"——
  //      那个前提已经过期：宿主 0.1.5-rc.2 装了 dsh-web-fetch-http，
  //      它做 DNS 钉死（解析一次、校验全部地址为公网、再交给 undici，
  //      杜绝重新解析到内网）与 SSRF 防护。自己写 fetch 就绕过了这些。
  if (typeof ctx?.web?.fetch === 'function') {
    try {
      const r = await ctx.web.fetch({ url })
      const ok = r && (r.statusCode === undefined || r.statusCode < 400)
      if (ok) {
        const content = r.body?.content ?? ''
        const text = r.body?.kind === 'text' ? String(content) : htmlToText(content)
        if (String(text).trim()) {
          return finish(text, 'host', r.statusCode ?? 200, content, attempts)
        }
        attempts.push('host:empty')
      } else {
        attempts.push('host:' + (r?.statusCode ?? '?'))
      }
    } catch (e) {
      // 没有 provider、被 SSRF 拦下、超时都会走到这里 —— 记下原因再兜底，
      // 否则"宿主这条路一直失败"这件事永远不会被人看见。
      attempts.push('host:' + String(e?.message ?? e).slice(0, 80))
    }
  } else {
    attempts.push('host:absent')
  }
  // 2) 直连兜底
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'text/html,text/plain,*/*;q=0.8' },
      signal: ctrl.signal,
    })
    if (!res.ok) { attempts.push('direct:' + res.status); return empty(attempts) }
    const raw = (await res.text()).slice(0, MAX_RAW)
    if (!raw) { attempts.push('direct:empty-body'); return empty(attempts) }
    const ct = res.headers.get('content-type') ?? ''
    const text = /html/i.test(ct) ? htmlToText(raw) : raw.trim()
    return finish(text, 'direct', res.status, raw, attempts)
  } catch (e) {
    attempts.push('direct:' + String(e?.name ?? e?.message ?? e).slice(0, 60))
    return empty(attempts)
  } finally {
    clearTimeout(timer)
  }
}

/** 组装结果，并把"壳页"判据跑一遍（对两条路都一样）。 */
function finish(text, path, status, rawForShellCheck, attempts) {
  const shellInfo = looksLikeShell(rawForShellCheck, text)
  return {
    text: String(text ?? '').trim(),
    path,
    status,
    attempts,
    ...shellInfo,
  }
}

function empty(attempts) {
  return { text: '', path: '', status: 0, attempts, shell: false, textBytes: 0, rawBytes: 0, why: '' }
}

/** 只关心文本的旧接口（外部调用方与测试在用）。 */
export async function fetchUrlText(ctx, url, opts = {}) {
  const r = await fetchUrlTextDetailed(ctx, url, opts)
  return r.text
}

// ── 抓取缓存 ──
//
// 为什么值得做：同一批 URL 会被**反复抓**——
//   · 一个 gap 两次尝试（maxAttemptsPerGap=2）抓的是同一批来源；
//   · 相似缺口（"zstd 多帧怎么解" / "zstd 帧边界"）搜出同一批页面。
// 实测单页 1.4 秒（nodejs.org 483KB），抓三页就是 4 秒多的纯等待，
// 而这段时间里 gap 队列是锁着的。
//
// 缓存**只存抽取后的文本**，不存原始 HTML：省一个数量级的磁盘，而且
// 下游本来就只用文本。失败也缓存（ttl 短得多）——否则同一个死链会被
// 反复重试，而它每次都要付一个超时。
const CACHE_FILE = '.index/fetch-cache.json'
export const FETCH_CACHE_MAX = 400

function cacheKey(url) {
  return createHash('sha256').update(String(url)).digest('hex').slice(0, 20)
}

async function readFetchCache(repoRoot) {
  try {
    const j = JSON.parse(await readFile(join(repoRoot, CACHE_FILE), 'utf8'))
    return j && typeof j === 'object' && j.entries && typeof j.entries === 'object' ? j : { version: 1, entries: {} }
  } catch { return { version: 1, entries: {} } }
}

/**
 * 写缓存：整体读-改-写，所以**必须在锁里**（同 gap 队列的理由 ——
 * 两条并发抓取各写一份快照，后写的会覆盖先写的）。
 * 修剪策略：超上限时按 lastUsed 丢最旧的。
 */
async function putFetchCache(repoRoot, url, rec) {
  try {
    await withLock('fetchcache:' + repoRoot, async () => {
      const cache = await readFetchCache(repoRoot)
      cache.entries[cacheKey(url)] = { url, ...rec }
      const keys = Object.keys(cache.entries)
      if (keys.length > FETCH_CACHE_MAX) {
        keys.sort((a, b) => Number(cache.entries[a].lastUsed ?? 0) - Number(cache.entries[b].lastUsed ?? 0))
        for (const k of keys.slice(0, keys.length - FETCH_CACHE_MAX)) delete cache.entries[k]
      }
      await mkdir(join(repoRoot, '.index'), { recursive: true })
      await writeFile(join(repoRoot, CACHE_FILE), JSON.stringify(cache), 'utf8')
    })
  } catch { /* 缓存是尽力而为：写不进去不该让一次抓取失败 */ }
}

/**
 * 带缓存的抓取。
 *
 * @returns { text, path, status, shell, cached, attempts }
 */
export async function fetchCached(ctx, repoRoot, url, cfg, log = () => {}) {
  const ttlOk = Number(cfg.fetchCacheTtlMs) || 0
  const ttlFail = Number(cfg.fetchCacheFailTtlMs) || 0
  const now = Date.now()
  const cache = await readFetchCache(repoRoot)
  const hit = cache.entries[cacheKey(url)]
  if (hit && ttlOk > 0) {
    const age = now - Number(hit.at ?? 0)
    const ttl = hit.text ? ttlOk : ttlFail
    if (age >= 0 && age < ttl) {
      log('fetch cache hit (' + Math.round(age / 1000) + 's old, ' + (hit.path || 'n/a') + '): ' + url)
      // 命中也要刷新 lastUsed —— 否则"最常被用到的"会先被修剪掉。
      // ★ await 而不是 fire-and-forget：写是**读-改-写**，飘在后台的那一次
      //   可能在别的写入之间落地。实测它会让"缓存文件不该变"这类断言随机失败
      //   （那个随机性本身就是 bug 的证据：两个写入者没有互相等待）。
      await putFetchCache(repoRoot, url, { ...hit, lastUsed: now })
      return { ...hit, cached: true, attempts: [] }
    }
  }
  const r = await fetchUrlTextDetailed(ctx, url, { timeoutMs: cfg.fetchTimeoutMs })
  if (ttlOk > 0) {
    await putFetchCache(repoRoot, url, {
      text: r.text.slice(0, Math.max(0, Number(cfg.fetchCacheMaxChars) || 40000)),
      path: r.path, status: r.status, shell: r.shell, why: r.why,
      at: now, lastUsed: now,
    })
  }
  return { ...r, cached: false }
}

/**
 * 把一条 gap 查询变成**搜索引擎里真的存在**的那种查询。
 *
 * ── 为什么需要（这是"搜得到但没用"的一个系统性来源）──
 *
 * 上游 symptomQuery 会把"我们要它干什么"写进查询本身，例如：
 *   `Error: old_string was not found in "a.js" 常见故障原因 解决办法`
 *   `反复修改 tools.js 仍不成功 常见原因`
 * 那两句中文**是为了让人读懂而加的**，可网上没有哪个页面会包含
 * "常见故障原因 解决办法" —— 它们只会稀释关键词、把召回推向泛泛而谈的页面。
 * 错误文本本身才是"真的有人写过"的那部分。
 *
 * 所以这里：剥掉指令性尾缀、压掉重复的错误文本、清掉换行与多余空白。
 * **只在查询变短了才用它**；剥完太短说明整条查询本来就是指令，那就原样返回
 * （宁可搜一条平庸的查询，也不要把查询掏空成两三个无意义的词）。
 */
const INSTRUCTION_TAIL = /(常见故障原因|常见原因|解决办法|怎么解决|如何解决|正确用法|最佳实践|的实现方式|重复调用无进展|仍不成功|常见故障|故障原因)/g

export function searchableQuery(raw, { minChars = 12, maxChars = 220 } = {}) {
  const original = String(raw ?? '').replace(/\s+/g, ' ').trim()
  let q = original
    // 全角括号也要认：上游拼的是"（当前任务：…）"，而中文输入法下括号常常是全角。
    // 第一版只写了半角，于是这条清洗**从来没生效过**（测试抓到的）。
    .replace(/[（(]当前任务：[\s\S]*?[）)]/g, ' ')
    .replace(INSTRUCTION_TAIL, ' ')
    .replace(/[；;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // 同一段错误文本被拼了两遍时只留一遍（上游是 parts.join('；') 之后又被复述）。
  // ★ 判据要能处理"分隔符已被上面替换掉"的情形 —— 第一版按标点切，
  //   而 '；' 在更早一步就被换成了空格，于是这条**从来没触发过**（测试抓到的）。
  const dup = q.match(/^(.{8,}?)\s+\1$/)
  if (dup) q = dup[1]
  q = q.slice(0, maxChars).trim()
  if (q.length >= minChars) return q
  // ★ 剥完太短时要分两种情况，不能一律退回原文：
  //   · 原文里**本来就只有指令性词**（"（当前任务：…）"）→ 退回原文等于保证搜出一堆垃圾，
  //     返回空串让调用方看见"这条查询没法用"；
  //   · 原文里没有指令词、只是本来就短（"zstd 帧"）→ 那是有效查询，原样返回。
  const wasInstruction = /当前任务|常见故障原因|常见原因|解决办法|正确用法|最佳实践|仍不成功|重复调用无进展/.test(original)
  return wasInstruction ? '' : original.slice(0, maxChars)
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase() } catch { return '' }
}

/**
 * 按域名偏好给来源排序。这类"卡住了怎么办"的查询搜到的 SEO 垃圾特别多，
 * 官方文档 / GitHub issue / StackOverflow 的命中率明显更高。
 * 默认只优先、不排除——小众但精准的答案不该被白名单挡掉。
 */
export function preferSources(sources, cfg) {
  const list = Array.isArray(cfg.preferDomains) ? cfg.preferDomains : []
  if (list.length === 0) return sources
  const isPreferred = (u) => {
    const h = hostOf(u)
    return h !== '' && list.some(d => h === d || h.endsWith('.' + d))
  }
  const pref = sources.filter(s => isPreferred(s.url))
  const rest = sources.filter(s => !isPreferred(s.url))
  return cfg.domainStrict ? pref : [...pref, ...rest]
}

/**
 * 抓取若干来源的正文，并**如实统计**这一步的结果。
 *
 * 返回 `{ evidence, stats }` 而不是只返回数组：`stats` 是"为什么没料"的唯一证据。
 * 以前只有一行日志，于是队列里只留下一个 skipped —— 分不清是
 * "搜到的页面都取不到"（该换来源）还是"取到了但模型太保守"（该改提示词）。
 * 这两种故障的修法完全相反，混在一起报等于没报。
 */
async function fetchEvidence(ctx, repoRoot, sources, cfg, log) {
  const stats = { tried: 0, ok: 0, shell: 0, empty: 0, cached: 0, chars: 0, paths: {}, attempts: [] }
  if (!cfg.fetchSources) return { evidence: [], stats }
  const minChars = Number(cfg.fetchMinUsableChars) || 200
  const minProse = Number(cfg.fetchMinProse) || 0
  const out = []
  for (const s of preferSources(sources, cfg).slice(0, cfg.fetchTopN)) {
    stats.tried++
    const r = await fetchCached(ctx, repoRoot, s.url, cfg, log)
    if (r.cached) stats.cached++
    if (r.path) stats.paths[r.path] = (stats.paths[r.path] ?? 0) + 1
    const chars = String(r.text ?? '').trim().length
    if (chars < minChars) {
      stats.empty++
      if (r.shell) stats.shell++
      // 失败原因进 stats：诊断时能直接看到"是 404、是被 SSRF 拦、还是空壳页"
      if (r.attempts?.length) stats.attempts.push(...r.attempts.slice(0, 2))
      log('fetch unusable (' + chars + ' chars' + (r.shell ? ', JS 渲染壳页' : '') + ', ' + (r.path || 'no path') + '): ' + s.url)
      continue
    }
    // ★ 纯度门槛（可选，默认 0）。目录型页面字符数不少但 prose 极低，
    //   喂给蒸馏器只会稀释证据。默认关是因为**保守**：宁可让蒸馏器看到它再拒绝，
    //   也不要我们替它判断 —— 但开关留着，实测某类站点需要打开。
    const prose = proseOfText(r.text)
    if (minProse > 0 && prose < minProse) {
      stats.empty++
      log('fetch low-prose (' + prose.toFixed(2) + ' < ' + minProse + '): ' + s.url)
      continue
    }
    stats.ok++
    stats.chars += chars
    out.push({
      url: s.url, title: s.title,
      text: r.text.slice(0, cfg.fetchMaxChars),
      path: r.path, cached: !!r.cached, prose,
    })
    log('fetched ' + chars + ' chars (' + (r.path || '?') + (r.cached ? ', cached' : '') + ', prose ' + prose.toFixed(2) + '): ' + s.url)
  }
  return { evidence: out, stats }
}

/** 文本的 prose 比例（与 extract.js 同一判据，避免两处各写一份）。 */
function proseOfText(text) {
  const lines = String(text ?? '').split('\n').map(l => l.trim()).filter(Boolean)
  if (lines.length === 0) return 0
  const linkish = lines.filter(l => l.length < 60 && !/[.。！？!?：:]\s*$/.test(l)).length
  return 1 - linkish / lines.length
}

/**
 * 一句话说清"这一轮到底拿到了多少料"。
 *
 * 进的是 gap 的 lastReason，将来人（或模型）翻队列时要能一眼判断故障在哪一层：
 *   investigated=0 → 检索/抓取层的问题
 *   investigated>0 且被拒 → 蒸馏器的问题
 * 以前这里只有 "N page(s) fetched"，看不出路径（宿主还是直连）、
 * 有没有走缓存、有没有壳页 —— 那些恰好是排查时最先要问的。
 */
export function evidenceSummary(stats) {
  const s = stats || {}
  const paths = Object.entries(s.paths || {}).map(([k, v]) => k + '×' + v).join('/') || '无'
  return [
    (s.ok ?? 0) + ' usable',
    (s.tried ?? 0) + ' tried',
    s.shell ? s.shell + ' shell' : '',
    s.empty ? s.empty + ' empty' : '',
    s.cached ? s.cached + ' cached' : '',
    'path ' + paths,
    (s.chars ?? 0) + ' chars',
  ].filter(Boolean).join(', ')
}

function distillPrompt(query, content, sources, evidence) {
  const ev = sources.map((s, i) => `[${i + 1}] ${s.title || ''} <${s.url}>\n${(s.snippet || '').slice(0, 600)}`).join('\n\n')
  const pages = evidence.length
    ? evidence.map((e, i) => `### [P${i + 1}] ${e.title || ''} <${e.url}>\n${e.text}`).join('\n\n')
    : '(no page content could be fetched)'
  return [
    '## Question that the knowledge base could not answer',
    query,
    '',
    // ★ 检索摘要为空时**不留一个空的 "## Search summary" 段**，而是明说没有。
    //   实测宿主的 deepseek provider 只返回 sources（snippet 还要模型恰好引用过才有），
    //   于是 content 常常是空的。留个空标题会让模型以为"摘要被截断了"，
    //   而"这个 provider 本来就不给摘要"是一条**确定的事实**，该照实说。
    '## Search summary',
    (content || '(this provider returned no summary — judge only from the fetched page content below)').slice(0, 2000),
    '',
    '## Fetched page content  ← PRIMARY evidence',
    pages.slice(0, 14000),
    '',
    '## Search result list (titles/snippets only — NOT sufficient evidence on their own)',
    ev.slice(0, 4000) || '(none)',
    '',
    '## Task',
    'Decide whether the FETCHED PAGE CONTENT durably answers the question. If yes, write ONE concise wiki page.',
    'Base every claim on the fetched page content. Titles and snippets alone are NOT sufficient — if the fetched content is missing or does not answer the question, you MUST refuse.',
    'Return JSON exactly in this shape:',
    '{ "skip": false,',
    '  "id": "kebab-case-ascii-slug",',
    '  "title": "short title (may be Chinese)",',
    '  "category": "fact" | "decision" | "lesson" | "howto",',
    '  "confidence": 0.0-1.0,',
    '  "tags": ["..."],',
    '  "body": "markdown body, 3-15 lines, concrete and self-contained" }',
    'Or if the results do not answer it: { "skip": true, "reason": "..." }',
    'confidence must reflect how well the sources support the claim, not how plausible it sounds.',
  ].join('\n')
}

/**
 * 处理一个 gap：联网 → 蒸馏 → 落 staged。
 * 返回 { status, page?, reason? }，不抛异常（失败只记状态）。
 */
export async function acquireOne({ ctx, llm, repoRoot, gap, cfg, log = () => {} }) {
  const now = new Date().toISOString()
  if (!ctx?.web?.search) return { status: 'error', reason: 'ctx.web 不可用' }
  // 离线闸：跑测试/演示/想省额度时，一个开关就该让整条补料路径**不发一个请求**。
  // 放在 search 之后、任何网络调用之前 —— 它是这一层唯一的出口闸门。
  if (cfg.offline === true) return { status: 'skipped', reason: 'offline 已开启，未联网' }
  // 纵深防御：即使旧 gap 里残留了密钥，也绝不把它送进搜索引擎
  if (looksSecret(gap.query)) {
    return { status: 'skipped', reason: '查询含疑似密钥，拒绝联网（已脱敏的队列条目不受影响）' }
  }

  // ── 检索：先按清洗后的查询，空了再用原查询重试一次 ──
  //
  // ★ 为什么值得多花一次调用：只有**一个** provider 在跑（dsh-web-search-deepseek
  //   走 Anthropic 原生 web_search），没有引擎轮换可言 —— 一次查询没结果，
  //   这一轮就结束了。而"清洗掉指令尾缀"实测能把"常见故障原因 解决办法"这类
  //   稀释词拿掉，那些词是纯噪声。
  //
  // ★ 但**先清洗再兜底**，不是反过来：原查询里带着中文指令，召回面更大却更不准，
  //   只在清洗后一条都没有时才退回去。
  const searchQuery = cfg.normalizeSearchQuery === false ? gap.query : searchableQuery(gap.query)
  // 清洗后什么都不剩 = 这条查询本来就只是"我们要它干什么"，网上没有这种东西。
  // 直接判 skipped 而不是拿去搜 —— 搜它只会烧一次调用并收回无关页面。
  if (!searchQuery) return { status: 'skipped', reason: '查询清洗后为空（整条都是指令性词，网上没有对应内容）: ' + gap.query.slice(0, 80) }
  const tried = []
  let results = null
  let lastError = null
  for (const q of searchQuery === gap.query ? [gap.query] : [searchQuery, gap.query]) {
    tried.push(q)
    try {
      results = await ctx.web.search({ query: q, maxResults: cfg.webMaxResults })
    } catch (e) {
      // ★ 抛异常（provider 缺 key、网络断）与"返回零结果"是两件事，处理也不同：
      //   异常 = 这一条查询**没法执行**，换一条查询同样会失败 —— 直接报错，
      //   但要带上**是哪条查询**失败的（否则日志里只有一句 search failed）。
      //   零结果 = 查询本身不好，值得换一条再试。
      lastError = e
      continue
    }
    const n = (results?.sources ?? []).filter(s => s && s.url).length
    if (n > 0) break
  }
  if (searchQuery !== gap.query) log('search query normalized: ' + JSON.stringify(gap.query.slice(0, 60)) + ' -> ' + JSON.stringify(searchQuery.slice(0, 60)))
  const sources = (results?.sources ?? []).filter(s => s && s.url).map(s => ({ url: s.url, title: s.title, snippet: s.snippet }))
  if (sources.length === 0) {
    // 两种情况分开报：全都抛异常 = 检索能力不可用（该去查 provider/key），
    // 全都返回零结果 = 这条查询网上没有（该换查询词或放弃这个缺口）。
    if (lastError) return { status: 'error', reason: 'search failed on every query form (' + tried.length + '): ' + lastError.message + ' (last query: ' + tried[tried.length - 1].slice(0, 60) + ')' }
    return { status: 'skipped', reason: 'no search results (tried ' + tried.length + ' query form(s))' }
  }

  // ★ 搜索结果的**形状**决定了后面有没有料，这件事必须如实记下来（实测）。
  //
  //   宿主的 dsh-web-search-deepseek 走的是 Anthropic 原生 web_search 工具，
  //   它返回的 `sources` 里 **snippet 只在模型恰好引用了那一页时才有**
  //   （源码：citationSnippets 从 text block 的 citations 里取）。
  //   于是"搜到了 5 条，但一条摘要都没有"是**结构性**的常见情形，不是异常。
  //   以前这种情况只会走到"抓正文"那一步然后被蒸馏器以"只有标题和 URL"拒绝，
  //   而拒绝理由里看不出根因在检索层。
  const withSnippet = sources.filter(s => String(s.snippet ?? '').trim().length > 0).length
  const searchShape = {
    results: sources.length,
    withSnippet,
    summarized: typeof results?.content === 'string' && results.content.trim().length > 0,
  }
  if (withSnippet === 0) log('search returned ' + sources.length + ' sources with NO snippets (provider-dependent) — page fetch is the only evidence')

  // 先抓正文：只有标题和 snippet 的话蒸馏器只能拒绝（实测如此）
  const { evidence, stats: fetchStats } = await fetchEvidence(ctx, repoRoot, sources, cfg, log)

  let distilled
  // rawText 必须声明在 try 之外：诊断信息要在 catch 之后仍然可读。
  // （曾经把它写成 try 内的 const，导致非 JSON 分支抛 ReferenceError，
  //   把一次本可优雅跳过的结果变成整轮失败。）
  let rawText = ''
  try {
    rawText = await llm.chat({
      // 站点名让"这一步用了哪个模型"可回答，也是按站点覆盖配置的键。
      site: 'distill',
      system: DISTILL_SYSTEM,
      prompt: distillPrompt(gap.query, results.content, sources, evidence),
      maxTokens: cfg.distillMaxTokens,
      temperature: 0.1,
    })
    // ★ 契约过滤：思考过程里的示例对象（{"skip": true}）不该被当成蒸馏结果。
    //   distill 的契约：skip 为布尔，skip:true 带 reason，skip:false 带 body。
    //   与 harvest 的 ok 校验同一套路（见 lib/llm.js 的 extractJson 注释）。
    distilled = extractJson(rawText, (v) => typeof v?.skip === 'boolean'
      && (v.skip === true ? typeof v.reason === 'string' : typeof v.body === 'string'))
  } catch (e) {
    return { status: 'error', reason: 'distill failed: ' + e.message }
  }
  if (!distilled) {
    // 把原始输出带出来：没有它就只能猜"是模型没回、还是回了非 JSON"
    const raw = String(rawText ?? '')
    return { status: 'skipped', reason: 'distiller returned no JSON (' + evidenceSummary(fetchStats) + ', rawLen=' + raw.length + ', raw=' + JSON.stringify(raw.slice(0, 200)) + ')', fetchStats, searchShape }
  }
  // 记下取到几页正文：这是判断"是没料可写还是模型太保守"的关键区分
  if (distilled.skip === true) {
    return { status: 'skipped', reason: 'distiller refused (' + evidenceSummary(fetchStats) + '): ' + (distilled.reason ?? ''), fetchStats, searchShape }
  }

  const id = deriveId(distilled.id, distilled.title ?? gap.query, 'gap')
  const body = String(distilled.body ?? '').trim()
  if (!body) return { status: 'skipped', reason: 'empty body' }

  // ★ 把**取材统计**写进页面正文，而不是只写进日志。
  //
  //   理由：这一页是自动联网产出的，将来审它的人（或模型）要能回答
  //   "它有多少证据"。日志会轮转、会被清，页面不会。
  //   刻意只写统计不写结论 —— "取到 2 页"是事实，"所以可信"是判断，
  //   而判断属于读它的人。
  const provenance = '> 取材: ' + evidenceSummary(fetchStats) + '；检索 ' + searchShape.results + ' 条' +
    (searchShape.withSnippet === 0 ? '（无摘要，全部证据来自抓取的正文）' : '（' + searchShape.withSnippet + ' 条带摘要）')
  const page = {
    id,
    title: String(distilled.title ?? id),
    category: ['fact', 'decision', 'lesson', 'howto'].includes(distilled.category) ? distilled.category : 'fact',
    confidence: Math.max(0, Math.min(1, Number(distilled.confidence ?? 0.5) || 0.5)),
    sources: sources.map(s => s.url).slice(0, cfg.maxSourcesPerPage),
    tags: Array.isArray(distilled.tags) ? distilled.tags.map(String).slice(0, 8) : [],
    created: now,
    updated: now,
    hits: 0,
    body: body + '\n\n' + provenance + '\n> 缺口: ' + gap.query.slice(0, 200),
  }
  const file = await savePage(repoRoot, page, { staged: true })
  log('staged: ' + id + ' (gap ' + gap.id + ', ' + evidenceSummary(fetchStats) + ')')
  return { status: 'staged', page, file, fetchStats, searchShape }
}

/**
 * 后台补料 worker：跑一批 pending gap。
 * 非阻塞的兑现——调用方 await 它也不会卡住模型轮次（它在 turn/end 之后跑）。
 */
export async function runAcquisition({ ctx, llm, repoRoot, cfg, log = () => {}, onStaged = null }) {
  const gaps = await readGaps(repoRoot)
  // 花钱联网之前再确认一次：队列里可能有历史遗留或被手工写入的条目，
  // 记录侧的过滤挡不住它们。
  const pending = gaps
    .filter(g => g.status === 'pending')
    .filter((g) => {
      if (looksLikeGap(g.query, { minChars: cfg.minGapQueryChars })) return true
      g.status = 'skipped'
      g.lastStatus = 'skipped'
      g.lastReason = '不像真缺口（意图判据未通过），未消耗联网预算'
      g.lastAttempt = new Date().toISOString()
      log('gap 不像真缺口，跳过：' + String(g.query).slice(0, 40))
      return false
    })
    // 纵深防御：appendGap 已预标记过，但历史遗留 / 手工写入的 pending 条目
    // 仍可能带着不可检索的查询。在 slice（预算）之前挡掉 —— 不联网、不蒸馏。
    .filter((g) => {
      const reason = unsearchableGapReason(g.query)
      if (!reason) return true
      g.status = 'skipped'
      g.lastStatus = 'skipped'
      g.lastReason = '查询不可检索（' + reason + '），未消耗联网预算'
      g.lastAttempt = new Date().toISOString()
      log('gap 不可检索，直接跳过：' + String(g.query).slice(0, 40))
      return false
    })
    // 时机：预算有限（默认 2/轮）——把名额给「反复撞」的缺口（seen 高），
    // 而不是给最先登记的那几条。
    .sort((a, b) => (b.seen ?? 1) - (a.seen ?? 1))
    .slice(0, cfg.maxAcquisitionsPerRun)
  const summary = { considered: pending.length, staged: 0, skipped: 0, errors: 0, details: [] }
  for (const gap of pending) {
    if (gap.attempts >= cfg.maxAttemptsPerGap) { gap.status = 'abandoned'; continue }
    gap.attempts = (gap.attempts ?? 0) + 1
    gap.lastAttempt = new Date().toISOString()
    const res = await acquireOne({ ctx, llm, repoRoot, gap, cfg, log })
    if (res.status === 'staged') {
      gap.status = 'done'
      summary.staged++
      // 投递钩子：让调用方把结果推进**正在进行的那一轮**。
      // 不这么做的话，学到的东西要等到下一轮才可用 —— 而那时模型已经绕出去了。
      if (onStaged && res.page) {
        try { await onStaged(res.page, gap) } catch (e) { log('onStaged failed (non-fatal): ' + (e?.message ?? e)) }
      }
    }
    else if (res.status === 'skipped') { gap.status = 'skipped'; summary.skipped++ }
    else { gap.status = gap.attempts >= cfg.maxAttemptsPerGap ? 'abandoned' : 'pending'; summary.errors++ }
    // 把结果持久化回 gap 本身 —— 否则下次看队列只知道"skipped"，
    // 不知道是没搜到、模型拒绝、还是模型没回合法 JSON。
    gap.lastStatus = res.status
    gap.lastReason = res.reason ?? ''
    // 取材统计**持久化到 gap 上**（不只是日志）。队列是"哪些缺口学不动"
    // 的唯一台账，而没有这一列时它只能回答"被拒了"，答不出"为什么"。
    if (res.fetchStats) gap.lastFetch = { ...res.fetchStats, attempts: (res.fetchStats.attempts ?? []).slice(0, 4) }
    if (res.searchShape) gap.lastSearch = res.searchShape
    // res.page 只在 staged 时存在；写成 page: res.page?.id 会让值为 undefined，
    // 而工具输出必须是 lossless JSON → 整个 wiki_acquire 调用失败。
    const detail = { id: gap.id, query: gap.query.slice(0, 80), status: res.status, reason: res.reason ?? '' }
    if (res.page?.id) detail.page = res.page.id
    summary.details.push(detail)
    if (cfg.minIntervalMs > 0) await new Promise(r => setTimeout(r, cfg.minIntervalMs))
  }
  // ⚠️ 写回走 updateGaps：**读与写必须在同一把锁里**。
  //
  // 这里以前是"重读一遍再合并" —— 那只是把窗口从几百行缩小到几行，并没有
  // 关掉它：appendGap 只要落在"重读"与"写回"之间，它刚登记的 gap 照样被
  // 整文件覆盖掉。而补料这条路本身要几秒（联网+蒸馏），窗口一点都不小。
  //
  // 合并规则不变：期间新增的条目保留，只把「我处理过的」那些字段并回去。
  await updateGaps(repoRoot, (latest) => {
    const byId = new Map(latest.map(g => [g.id, g]))
    for (const g of gaps) {
      const cur = byId.get(g.id)
      if (cur) {
        cur.status = g.status
        cur.attempts = g.attempts
        if (g.lastStatus !== undefined) cur.lastStatus = g.lastStatus
        if (g.lastReason !== undefined) cur.lastReason = g.lastReason
        if (g.lastAttempt !== undefined) cur.lastAttempt = g.lastAttempt
        if (g.lastFetch !== undefined) cur.lastFetch = g.lastFetch
        if (g.lastSearch !== undefined) cur.lastSearch = g.lastSearch
      } else {
        byId.set(g.id, g)   // 期间被删掉的，按我们这份为准
      }
    }
    return [...byId.values()]
  })
  return summary
}
