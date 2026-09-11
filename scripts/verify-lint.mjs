// wiki lint 的自检。
//
// 这一块的风险和别处不同：**lint 的价值全在"报出来的东西是对的"**。
// 误报比漏报更伤 —— 人一旦被引到错误的修法上，就会开始不信这个工具，
// 而一个不被信任的检查等于没有检查。
//
// 所以这里测的重点是**边界**：
//   * 裸文件名（不知道相对谁）不能报成死链 —— 那是"我不知道"，不是"它没了"
//   * 指向另一页 id 的 source 是**合法的内部交叉引用**，不是"不像指针"
//     （第一版就误报了它，因为语法判据看不出它其实有含义）
//   * URL 离线验证不了，必须计入"没查"，不能计成"正常"
//   * lint 只读：跑一遍不许改动任何文件
import { rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  extractWikiLinks, findBrokenLinks, classifySource, inspectSources,
  findDuplicates, findStale, lintWiki, renderLint,
} from '../lib/lint.js'
import { ensureRepo, savePage, loadPages } from '../lib/wiki.js'
import { DEFAULT_POLICY } from '../lib/usage.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

const ROOT = '.tmp-lint-test'
await rm(ROOT, { recursive: true, force: true })
await ensureRepo(ROOT)

const stamp = new Date().toISOString()

// ── 1. 死链 ──
console.log('')
console.log('── 死链 ──')
{
  const links = extractWikiLinks('看 [[page:alpha]] 和 [[beta]] 以及 [普通链接](x)')
  check('抽出两种写法的 wiki 链接', links.length === 2 && links[0].target === 'alpha' && links[1].target === 'beta',
    JSON.stringify(links.map(l => l.target)))
  check('普通 markdown 链接不算 wiki 链接', !links.some(l => l.target === 'x'))

  const pages = [
    { id: 'a', body: '见 [[page:b]]' },
    { id: 'b', body: '正文' },
    { id: 'c', body: '见 [[page:不存在]]' },
  ]
  const broken = findBrokenLinks(pages)
  check('★ 只报指向不存在页的那些', broken.length === 1 && broken[0].from === 'c', JSON.stringify(broken))
}

// ── 2. 来源分型（这里是误报最容易发生的地方）──
console.log('')
console.log('── 来源分型 ──')
{
  const known = new Set(['hindsight-pid-c5783a'])
  check('URL', classifySource('https://a.com/x', { known }).kind === 'url')
  check('session://', classifySource('session://abc', { known }).kind === 'url')
  check('★ 指向另一页 id = 合法内部引用，**不是**"不像指针"',
    classifySource('hindsight-pid-c5783a', { known }).kind === 'page',
    '第一版在这里误报过：语法判据看不出这个字符串有含义')
  check('绝对路径', classifySource('D:/x/y.js', { known }).kind === 'path')
  check('相对路径', classifySource('lib/acquire.js', { known }).kind === 'path')
  check('裸文件名（带扩展名）算 path，只是基准未知',
    classifySource('acquire.js', { known }).kind === 'path')
  check('★ 整句话 = weak，且理由说清是哪种',
    classifySource('context_audit detail=developer receipt (71 tools', { known }).kind === 'weak')
  check('★ 分号拼起来的多个来源单独给理由（修法不同：应拆成列表项）',
    /分号|列表/.test(classifySource('a.js; b.js; c.js', { known }).why || ''),
    classifySource('a.js; b.js; c.js', { known }).why)
}

// ── 3. 存在性：三类不能混为一谈 ──
console.log('')
console.log('── 来源存在性（"我不知道" ≠ "它没了"）──')
{
  const pages = [{
    id: 'p',
    sources: [
      'https://example.com/a',
      'D:/definitely/not/here.js',
      'lib/acquire.js',
      '有些 中文 句子 不是路径',
    ],
  }]
  const r = inspectSources(pages, { exists: () => false, known: new Set(['p']) })
  check('★ 绝对路径不存在 -> dead', r.dead.length === 1 && /not\/here/.test(r.dead[0].source), JSON.stringify(r.dead))
  check('★ 裸/相对名解析不出来 -> unresolved，**不是** dead', r.unresolved.length === 1 && r.unresolved[0].source === 'lib/acquire.js',
    JSON.stringify(r.unresolved))
  check('★ URL 计入"未验证"，不报 ok', r.urls === 1, 'urls=' + r.urls)
  check('★ 整句话 -> weak，不混进 unresolved', r.weak.length === 1, JSON.stringify(r.weak))

  const r2 = inspectSources([{ id: 'p', sources: ['D:/x/y.js'] }], { exists: () => true, known: new Set(['p']) })
  check('存在的绝对路径算 ok', r2.ok === 1 && r2.dead.length === 0)
}

// ── 4. 重复 ──
console.log('')
console.log('── 重复 ──')
{
  const same = 'DSH 客户端插件的手写 CJS 契约：模块 id 与主题变量，必须用原语组件。'
  const pages = [
    { id: 'x', title: '客户端 UI 原语契约', body: same },
    { id: 'y', title: '客户端 UI 原语契约（重复）', body: same },
    { id: 'z', title: '完全无关的另一个主题', body: '会话是多帧 zstd，必须按魔数切帧，否则只解出第一帧。' },
  ]
  const dup = findDuplicates(pages)
  check('★ 内容几乎相同的两页被报出来', dup.some(d => (d.a === 'x' && d.b === 'y')), JSON.stringify(dup))
  check('★ 无关的页**不**被报（宁可漏报，不要制造噪音）',
    !dup.some(d => d.a === 'z' || d.b === 'z'))
  check('相似度按降序', dup.length < 2 || dup[0].score >= dup[1].score)
}

// ── 5. 过期：必须复用 classify 的口径 ──
console.log('')
console.log('── 过期 ──')
{
  const old = new Date(Date.now() - 30 * 86400000).toISOString()
  const fresh = new Date(Date.now() - 1 * 86400000).toISOString()
  const pages = [
    { id: 'old-zero', created: old, body: 'x' },
    { id: 'fresh-zero', created: fresh, body: 'x' },
    { id: 'old-hit', created: old, body: 'x' },
  ]
  const usage = { pages: { 'old-hit': { hits: 3, confirmed: 1, suspect: 0 } } }
  const stale = findStale(pages, usage, { policy: DEFAULT_POLICY })
  check('★ 页龄超阈值且零命中 -> 过期', stale.some(s => s.id === 'old-zero'), JSON.stringify(stale))
  check('★ 刚写的零命中**不**算过期（否则新知识一出生就被判死）',
    !stale.some(s => s.id === 'fresh-zero'))
  check('★ 有命中的**不**算过期', !stale.some(s => s.id === 'old-hit'))
  check('带出页龄与命中数，供人判断', stale[0] && typeof stale[0].ageDays === 'number' && stale[0].hits === 0,
    JSON.stringify(stale[0]))
}

// ── 6. 顶层：诚实报告"没查什么" + 只读 ──
console.log('')
console.log('── 顶层报告 ──')
{
  await savePage(ROOT, {
    id: 'alpha', title: 'A', category: 'lesson', confidence: 0.8,
    sources: ['https://example.com/a', 'D:/definitely/not/here.js'],
    tags: [], created: stamp, updated: stamp, hits: 0, body: '见 [[page:missing-one]]',
  }, { staged: false })
  const { pages } = await loadPages(ROOT)

  const r = await lintWiki(ROOT, { pages, usage: { pages: {} }, pluginRoot: null })
  check('死链被报出', r.brokenLinks.length === 1, JSON.stringify(r.brokenLinks))
  check('失效来源被报出', r.deadSources.length === 1, JSON.stringify(r.deadSources))
  check('★ 明确列出"这次没查什么"（URL 离线验证不了）',
    r.notChecked.some(x => /URL/.test(x)), JSON.stringify(r.notChecked))
  check('★ findings 把 weak 也算进去（否则"0 问题"是假的）',
    r.findings === r.brokenLinks.length + r.deadSources.length + r.weakSources.length + r.duplicates.length + r.stale.length,
    'findings=' + r.findings)

  const txt = renderLint(r)
  check('渲染里带上"没有检查的"那一段',
    /没有\*\*检查|没有\*\*检查的|没有.*检查的/.test(txt) || txt.includes('这次'),
    txt.split('\n').slice(-4).join(' / '))

  // ── 只读断言：跑 lint 前后，目录里每个文件的 (size, mtime) 必须一模一样 ──
  const snap = async () => {
    const out = {}
    const walk = async (d) => {
      const { readdir } = await import('node:fs/promises')
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) await walk(p)
        else { const s = await stat(p); out[p] = s.size + ':' + s.mtimeMs }
      }
    }
    await walk(ROOT)
    return out
  }
  const before = await snap()
  await lintWiki(ROOT, { pages, usage: { pages: {} }, pluginRoot: null })
  await lintWiki(ROOT, { pages, usage: { pages: {} }, pluginRoot: null })
  const after = await snap()
  check('★ lint 只读：跑两遍不改动任何文件', JSON.stringify(before) === JSON.stringify(after),
    Object.keys(before).length + ' 个文件')
}

await rm(ROOT, { recursive: true, force: true })
console.log(failures === 0 ? '\nlint 自检全部通过' : '\n有 ' + failures + ' 项未通过')
process.exit(failures === 0 ? 0 : 1)
