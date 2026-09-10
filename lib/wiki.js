// L1 存储层：Markdown wiki 的解析、扫描、写入与索引。
// 设计约束（见 dsh-wiki/README.md）：
//   1. pages/ 是唯一参与召回的目录，staged/ 永不参与（投毒防线）
//   2. 解析失败的行原样保留，不做破坏性重写（人可自由编辑）
//   3. .index/ 是派生物，任何时候都可删除重建，不作为真相来源
import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative, sep, posix } from 'node:path'
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

export async function ensureRepo(repoRoot) {
  for (const d of ['pages/fact', 'pages/decision', 'pages/lesson', 'pages/howto', 'staged', 'gaps', '.index']) {
    await mkdir(join(repoRoot, d), { recursive: true })
  }
  return repoRoot
}

export function repoExists(repoRoot) {
  return existsSync(join(repoRoot, 'pages'))
}
