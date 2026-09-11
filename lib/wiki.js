// L1 存储层：Markdown wiki 的解析、扫描、写入与索引。
// 设计约束（见 dsh-wiki/README.md）：
//   1. pages/ 是唯一参与召回的目录，staged/ 永不参与（投毒防线）
//   2. 解析失败的行原样保留，不做破坏性重写（人可自由编辑）
//   3. .index/ 是派生物，任何时候都可删除重建，不作为真相来源
import { readFile, writeFile, readdir, mkdir, stat, unlink, rename, rmdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative, resolve, sep, posix } from 'node:path'
import { createHash } from 'node:crypto'

/** 把任意字符串压成 ascii kebab-case。中文会被整体剥掉，所以单独用不够。 */
export function slugify(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

/**
 * 派生一个稳定且不易碰撞的页面 id。
 *
 * 坑：中文标题经 slugify 后几乎什么都不剩——"DSH 插件 link 安装的模块解析"
 * 只剩 "dsh-link"。多个中文标题都以同一个英文词开头时（很常见），
 * 它们会派生出同一个 id 并互相覆盖。所以当 slug 信号太弱时补一段内容哈希。
 */
export function deriveId(preferred, title, fallbackPrefix = 'note') {
  // 显式给了 ascii id 就完全尊重，不加哈希（模型/用户是权威）
  const explicit = slugify(preferred)
  if (explicit) return explicit
  const src = String(title ?? '')
  const base = slugify(src)
  // 标题含中文 → slug 必然有损，不能用它当唯一标识。
  // "DSH 插件 link 安装的模块解析" 和 "DSH 插件 link 的加载顺序" 都会塌成
  // "dsh-link"；光看 slug 长度是发现不了的（它有 8 个字符，看着"够长"）。
  // 所以判断依据是"来源是否含 CJK"，不是"slug 有多长"。
  const lossy = /[\u3400-\u4dbf\u4e00-\u9fff]/.test(src)
  if (base && !lossy) return base
  const h = createHash('sha256').update(src).digest('hex').slice(0, 6)
  return (base ? base + '-' : fallbackPrefix + '-') + h
}

export const CATEGORIES = ['fact', 'decision', 'lesson', 'howto']
export const STATUSES = ['staged', 'committed']

/** 极简 YAML frontmatter 解析：标量、数字、布尔、以及 `- ` 列表。复杂结构不猜，原样留字符串。 */
export function parseFrontmatter(text) {
  const src = String(text ?? '')
  if (!src.startsWith('---')) return { data: {}, body: src, raw: '' }
  const end = src.indexOf('\n---', 3)
  if (end === -1) return { data: {}, body: src, raw: '' }
  const raw = src.slice(3, end)
  const body = src.slice(end + 4).replace(/^\r?\n/, '')
  const data = {}
  let listKey = null
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const item = line.match(/^\s*-\s+(.*)$/)
    if (item && listKey) { data[listKey].push(coerce(item[1])); continue }
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (!kv) continue
    const key = kv[1]
    const val = kv[2].trim()
    if (val === '') { data[key] = []; listKey = key; continue }
    listKey = null
    if (val.startsWith('[') && val.endsWith(']')) {
      data[key] = val.slice(1, -1).split(',').map(s => coerce(s.trim())).filter(s => s !== '')
      continue
    }
    data[key] = coerce(val)
  }
  return { data, body, raw }
}

function coerce(v) {
  const s = String(v).trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1)
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  return s
}

export function serializeFrontmatter(data) {
  const lines = ['---']
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue
    if (Array.isArray(v)) {
      if (v.length === 0) { lines.push(k + ': []'); continue }
      lines.push(k + ':')
      for (const it of v) lines.push('  - ' + String(it))
    } else {
      lines.push(k + ': ' + String(v))
    }
  }
  lines.push('---')
  return lines.join('\n')
}

/** 规范化一个页面对象；补默认值并校验。返回 { page, errors }。 */
export function normalizePage(data, body, fallbackId = '') {
  const errors = []
  const id = String(data.id ?? fallbackId ?? '').trim()
  if (!id) errors.push('missing id')
  const category = String(data.category ?? 'fact').trim()
  if (!CATEGORIES.includes(category)) errors.push('bad category: ' + category)
  let confidence = Number(data.confidence ?? 0.5)
  if (!Number.isFinite(confidence)) { confidence = 0.5; errors.push('bad confidence') }
  confidence = Math.max(0, Math.min(1, confidence))
  const status = String(data.status ?? 'committed').trim()
  if (!STATUSES.includes(status)) errors.push('bad status: ' + status)
  const sources = Array.isArray(data.sources) ? data.sources.map(String) : (data.sources ? [String(data.sources)] : [])
  const tags = Array.isArray(data.tags) ? data.tags.map(String) : (data.tags ? String(data.tags).split(/[,\s]+/).filter(Boolean) : [])
  return {
    page: { id, category, confidence, status, sources, tags,
      title: String(data.title ?? id).trim(),
      created: String(data.created ?? ''),
      updated: String(data.updated ?? ''),
      hits: Number(data.hits ?? 0) || 0,
      body: String(body ?? '') },
    errors,
  }
}

async function walk(dir, out = []) {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) await walk(p, out)
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p)
  }
  return out
}

/**
 * 读取仓库里全部页面：pages/（已固化）与 staged/（暂存）。
 *
 * 两者一起读是有意的——staged 必须能被 wiki_review / wiki_commit 看到。
 * 它不参与召回这一点由 recallable() 的 status==='committed' 过滤保证，
 * 而不是靠"不读进来"。把防线放在过滤层而不是 IO 层，review/commit 才有页面可用。
 */
export async function loadPages(repoRoot) {
  const sources = [
    { dir: join(repoRoot, 'pages'), prefix: 'pages/' },
    { dir: join(repoRoot, 'staged'), prefix: 'staged/' },
  ]
  const pages = []
  const errors = []
  for (const { dir, prefix } of sources) {
    const files = await walk(dir)
    for (const f of files) {
      let text
      try { text = await readFile(f, 'utf8') } catch (e) { errors.push({ file: f, error: String(e.message) }); continue }
      const rel = relative(repoRoot, f).split(sep).join(posix.sep)
      const base = rel.replace(new RegExp('^' + prefix.replace('/', '\\/')), '').replace(/\.md$/, '')
      const fallbackId = base.split('/').pop()
      const { data, body } = parseFrontmatter(text)
      const { page, errors: perr } = normalizePage(data, body, fallbackId)
      // staged/ 目录下的文件即使没写 status 也一律视为 staged
      if (prefix === 'staged/' && data.status === undefined) page.status = 'staged'
      if (perr.length) errors.push({ file: rel, error: perr.join('; ') })
      page.path = f
      page.relPath = rel
      pages.push(page)
    }
  }
  return { pages, errors }
}

/** 校验页面是否可 commit：必须有来源，且 frontmatter 无错。 */
export function commitReadiness(page) {
  const blockers = []
  if (!page.sources || page.sources.length === 0) blockers.push('no sources (每条知识必须可溯源)')
  if (!page.id) blockers.push('missing id')
  if (!CATEGORIES.includes(page.category)) blockers.push('bad category')
  if (!page.body || !page.body.trim()) blockers.push('empty body')
  return { ready: blockers.length === 0, blockers }
}

/** 写入一个页面（原子替换正文，保留 frontmatter 的规范序列化）。 */
export async function savePage(repoRoot, page, { staged = false } = {}) {
  const dir = join(repoRoot, staged ? 'staged' : 'pages', staged ? '' : page.category)
  await mkdir(dir, { recursive: true })
  const file = join(dir, page.id + '.md')
  const fm = serializeFrontmatter({
    id: page.id, title: page.title, category: page.category,
    confidence: page.confidence, status: staged ? 'staged' : 'committed',
    sources: page.sources, created: page.created, updated: page.updated,
    hits: page.hits ?? 0, tags: page.tags,
  })
  await writeFile(file, fm + '\n\n' + String(page.body ?? '').trim() + '\n', 'utf8')
  return file
}

/**
 * 只读 staged/ 的简报，**不碰 pages/**。
 *
 * 为什么单独做一个而不是用 loadPages：/learn-wiki/api/pending 会被**常驻界面**
 * 轮询（输入框上方那条），而 loadPages 会把 pages/ 下每个已固化页的正文都读进来
 * 解析一遍 —— 那是"为了显示一个数字，把整个知识库读一遍"。
 * 这里只要 frontmatter：暂存页是几 KB 的小文件，轮询代价可以忽略。
 */
export async function readStagedBrief(repoRoot) {
  const dir = join(repoRoot, 'staged')
  let names = []
  try { names = await readdir(dir) } catch { return [] }
  const out = []
  for (const f of names) {
    if (!f.endsWith('.md')) continue
    let text
    try { text = await readFile(join(dir, f), 'utf8') } catch { continue }
    const { data, body } = parseFrontmatter(text)
    const { page } = normalizePage(data, body, f.replace(/\.md$/, ''))
    // staged/ 下的文件即使没写 status 也一律视为 staged（与 loadPages 同一条规则，
    // 两处必须一致，否则界面显示的"待固化"和实际能固化的是两拨东西）
    if (data.status === undefined) page.status = 'staged'
    page.relPath = 'staged/' + f
    out.push(page)
  }
  out.sort((a, b) => String(b.created ?? '').localeCompare(String(a.created ?? '')))
  return out
}

/**
 * 数一数 .trash/ 与 .rejected/ 里各有多少待分拣的条目。
 *
 * .trash 下有两种形态：整批清理时是一层**子目录**（staged-<时间戳>/），
 * 单页删除时是散落的 .md。两种都要数，否则"分拣完了"会是假的。
 */
export async function countTriage(repoRoot) {
  // README.md 是这两个目录的**说明文件**（.rejected/README.md 解释了为什么是拒绝
  // 而不是删除），不是待分拣的页面。算进去角标就会永远比真实待办多一个，
  // 而"数字对不上"会让人不再信任这个角标。
  const isPage = (name) => name.endsWith('.md') && name.toLowerCase() !== 'readme.md'
  const count = async (sub) => {
    let ents = []
    try { ents = await readdir(join(repoRoot, sub), { withFileTypes: true }) } catch { return 0 }
    let n = 0
    for (const e of ents) {
      if (e.isDirectory()) {
        try { n += (await readdir(join(repoRoot, sub, e.name))).filter(isPage).length } catch { /* 子目录读不动就不算 */ }
      } else if (isPage(e.name)) n++
    }
    return n
  }
  return { trash: await count('.trash'), rejected: await count('.rejected') }
}

// ── 分拣：回收站 / 已拒绝里的条目，人决定恢复还是永久删除 ──────────────
//
// 为什么需要它：这两类条目原先**没有任何界面**，于是只能靠读文件分拣。
// 而它们恰恰是最需要看内容才能决定的东西（"这页我还要不要"）。
//
// ★ 与 commit 的区别：恢复**回 staged/**，绝不直接进 pages/。
//   两段式的第一段是防投毒闸门（LLM 蒸馏出来的东西一旦进 pages/ 就参与
//   自动召回）。"从回收站捞回来"不该成为绕过闸门的后门 —— 捞回来仍然要
//   重新过一遍 commitReadiness。

/** 允许分拣的两个目录。写操作只认这两个前缀。 */
export const TRIAGE_DIRS = ['.trash', '.rejected']

function isTriagePage(name) {
  return name.endsWith('.md') && name.toLowerCase() !== 'readme.md'
}

/**
 * 从正文里解析"为什么被拒/被回收"。
 *
 * ★ 这是**既定约定，不是我发明的**：.rejected/README.md 写着
 *   "移进来的文件必须在文件头补一段 `> REJECTED:` 说明为什么被拒，
 *    包括判定它错误的具体证据、产生它的那条 gap、日期"。
 *   只不过在此之前**代码完全没有实现它** —— 约定只活在文档里，
 *   所以界面上看不到原因，人只能把文件打开自己翻。
 *
 * 解析不出来就返回 null，**绝不编造**：界面会如实显示"未记录原因"。
 * 编一个理由比没有理由更糟 —— 它会被后来的人当成证据。
 */
export function parseTriageReason(body) {
  const lines = String(body ?? '').split('\n')
  const head = lines.findIndex(l => /^\s*>\s*(REJECTED|TRASHED)\s*[:：]/i.test(l))
  if (head < 0) return null
  const kind = lines[head].match(/^\s*>\s*(REJECTED|TRASHED)/i)[1].toUpperCase()
  // 原因常常跨行：连续的 > 行都算同一段
  const buf = []
  for (let i = head; i < lines.length; i++) {
    const m = lines[i].match(/^\s*>\s?(.*)$/)
    if (!m) break
    buf.push(m[1])
  }
  let rest = buf.join(' ').replace(/^(REJECTED|TRASHED)\s*[:：]\s*/i, '').trim()
  // 约定首段带日期：REJECTED: 2026-09-11 —— <原因>
  let date = null
  const d = rest.match(/^(\d{4}-\d{2}-\d{2})\s*[—–\-]{1,2}\s*(.*)$/)
  if (d) { date = d[1]; rest = d[2].trim() }
  return { kind, date, text: rest.replace(/\*\*/g, '').trim() }
}

/**
 * 把一个客户端传来的相对路径解析成**确定在 .trash/ 或 .rejected/ 里面**的绝对路径。
 *
 * ★ 这是安全边界，不是格式化。restore/discard 会**移动和删除文件**，
 *   而路径来自 HTTP 请求体。没有这一层，一条 ../../pages/lesson/xxx.md
 *   就能把已固化的知识页删掉。所以判据是"解析之后的绝对路径必须真的落在
 *   允许的目录里"，而不是"字符串看起来像不像"——后者挡不住 ../ 和各种编码。
 */
export function resolveTriagePath(repoRoot, rel) {
  const raw = String(rel ?? '').replace(/\\/g, '/')
  if (!raw) return { ok: false, error: '缺少 path' }
  if (raw.includes('\0')) return { ok: false, error: 'path 非法' }
  const abs = resolve(repoRoot, raw)
  const allowed = TRIAGE_DIRS.map(d => resolve(repoRoot, d) + sep)
  if (!allowed.some(prefix => abs.startsWith(prefix))) {
    return { ok: false, error: '拒绝：path 必须落在 ' + TRIAGE_DIRS.join(' / ') + ' 之内' }
  }
  if (!abs.endsWith('.md')) return { ok: false, error: '拒绝：只处理 .md' }
  const base = abs.slice(abs.lastIndexOf(sep) + 1).toLowerCase()
  if (base === 'readme.md') return { ok: false, error: '拒绝：README 是说明文件，不是待分拣页' }
  return { ok: true, abs, rel: relative(repoRoot, abs).split(sep).join(posix.sep) }
}

/**
 * 列出待分拣条目。
 *
 * .trash 下有两种形态，都要列：整批清理时是一层**子目录**
 * （staged-<时间戳>/），单页删除时是散落的 .md。
 * 不列子目录的话，10 个条目会一个都不显示，而角标却写着 10 —— 那种
 * "数字说有事、界面说没事"的组合比不显示更糟。
 */
export async function listTriage(repoRoot, { excerptChars = 400 } = {}) {
  const out = []
  for (const sub of TRIAGE_DIRS) {
    const dir = join(repoRoot, sub)
    let ents = []
    try { ents = await readdir(dir, { withFileTypes: true }) } catch { continue }
    const push = async (abs, batch) => {
      let text = ''
      try { text = await readFile(abs, 'utf8') } catch { return }
      let st = null
      try { st = await stat(abs) } catch { /* 拿不到大小就留空 */ }
      const { data, body } = parseFrontmatter(text)
      const { page } = normalizePage(data, body, abs.slice(abs.lastIndexOf(sep) + 1).replace(/\.md$/, ''))
      const clean = String(body ?? '').replace(/\s+/g, ' ').trim()
      out.push({
        // 为什么被拒/被回收。解析不到就是 null —— 界面如实显示"未记录原因"。
        reason: parseTriageReason(body),
        rel: relative(repoRoot, abs).split(sep).join(posix.sep),
        id: page.id,
        title: page.title || page.id,
        category: page.category ?? '',
        confidence: typeof page.confidence === 'number' ? page.confidence : null,
        sources: (page.sources ?? []).length,
        from: sub,
        batch: batch || null,
        bytes: st ? st.size : null,
        mtime: st ? new Date(st.mtimeMs).toISOString() : null,
        bodyChars: clean.length,
        // 摘录是**决策输入**：不看内容无从判断"这页还要不要"。
        // 全文按需另取（列表里塞 10 篇正文会让每次打开面板都慢一拍）。
        excerpt: clean.slice(0, excerptChars),
        truncated: clean.length > excerptChars,
      })
    }
    for (const e of ents) {
      if (e.isDirectory()) {
        let inner = []
        try { inner = await readdir(join(dir, e.name)) } catch { continue }
        for (const f of inner.filter(isTriagePage)) await push(join(dir, e.name, f), e.name)
      } else if (isTriagePage(e.name)) {
        await push(join(dir, e.name), null)
      }
    }
  }
  out.sort((a, b) => String(b.mtime ?? '').localeCompare(String(a.mtime ?? '')))
  return out
}

/** 读一个分拣条目的全文（列表只给摘录，展开时按需取）。 */
export async function readTriageBody(repoRoot, rel) {
  const r = resolveTriagePath(repoRoot, rel)
  if (!r.ok) return r
  try {
    const text = await readFile(r.abs, 'utf8')
    const { body } = parseFrontmatter(text)
    return { ok: true, rel: r.rel, body: String(body ?? '') }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/**
 * 恢复：移回 staged/。
 *
 * 目标已存在时**拒绝**，不覆盖。覆盖会静默丢掉现在 staged 里的那一版，
 * 而两边的 id 相同不代表内容相同（很可能正是"改过之后再恢复旧的"这种情形）。
 * 宁可报错让人自己决定。
 */
export async function restoreTriage(repoRoot, rel) {
  const r = resolveTriagePath(repoRoot, rel)
  if (!r.ok) return r
  const name = r.abs.slice(r.abs.lastIndexOf(sep) + 1)
  const dest = join(repoRoot, 'staged', name)
  if (existsSync(dest)) {
    return { ok: false, error: 'staged/ 里已经有同名页面（' + name + '）。先处理它，或改名后再恢复 —— 直接覆盖会丢掉现有那一版。' }
  }
  try {
    await mkdir(join(repoRoot, 'staged'), { recursive: true })
    await rename(r.abs, dest)
  } catch (e) {
    return { ok: false, error: '恢复失败：' + String(e?.message ?? e) }
  }
  await pruneEmptyBatch(repoRoot, r.abs)
  return { ok: true, restored: 'staged/' + name }
}

/**
 * 永久删除。**不可逆** —— 所以调用方必须先显式确认（见 index.js 的 confirm 检查）。
 *
 * 删掉之后如果那个批次目录空了就一并删掉，免得 .trash 里攒一堆空壳。
 */
export async function discardTriage(repoRoot, rel) {
  const r = resolveTriagePath(repoRoot, rel)
  if (!r.ok) return r
  try {
    await unlink(r.abs)
  } catch (e) {
    return { ok: false, error: '删除失败：' + String(e?.message ?? e) }
  }
  await pruneEmptyBatch(repoRoot, r.abs)
  return { ok: true, discarded: r.rel }
}

/** 批次目录空了就删掉它（rmdir 只删空目录，非空会抛，正好当护栏）。 */
async function pruneEmptyBatch(repoRoot, abs) {
  const dir = abs.slice(0, abs.lastIndexOf(sep))
  if (resolve(dir) === resolve(repoRoot, 'staged')) return
  if (!TRIAGE_DIRS.some(d => resolve(dir).startsWith(resolve(repoRoot, d) + sep))) return
  try { await rmdir(dir) } catch { /* 还有别的条目就不删，正常 */ }
}

export async function ensureRepo(repoRoot) {
  for (const d of ['pages/fact', 'pages/decision', 'pages/lesson', 'pages/howto', 'staged', 'gaps', '.index']) {
    await mkdir(join(repoRoot, d), { recursive: true })
  }
  return repoRoot
}

export function repoExists(repoRoot) {
  return existsSync(join(repoRoot, 'pages'))
}
