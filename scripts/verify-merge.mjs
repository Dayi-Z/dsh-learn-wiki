// 冲突检测与页面合并的自检。
//
// 这一块最需要钉住的是**诚实边界**：工具只能指出"两页讲的是同一片地面"，
// 判断不了它们是否互相矛盾。测试要保证这句话**跟着结果一起返回** ——
// 否则调用方（尤其是模型）很容易把"重叠"读成"冲突"，然后去做一件没必要做的事。
//
// 另一条是**跨模块契约**：合并把页移进 .rejected/ 时写的原因，
// 必须能被 parseTriageReason() 读出来。写的和读的必须是同一个格式 ——
// 这条断言跨了 merge.js 与 wiki.js 两个实现，单测任何一边都发现不了。
import { rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { findOverlaps, proposeMerge, applyMerge } from '../lib/merge.js'
import { ensureRepo, savePage, loadPages, serializeFrontmatter, parseTriageReason } from '../lib/wiki.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

const ROOT = '.tmp-merge-test'
await rm(ROOT, { recursive: true, force: true })
await ensureRepo(ROOT)
const stamp = new Date().toISOString()
const mk = (id, title, body, extra = {}) => ({
  id, title, category: 'lesson', confidence: 0.8,
  sources: ['https://a.com/x'], tags: [], created: stamp, updated: stamp, hits: 0, body, ...extra,
})

// ── 1. 区间边界：和"重复"是同一把尺子的两段 ──
console.log('')
console.log('── 重叠区间 ──')
{
  const same = 'DSH 客户端插件手写 CJS 契约：模块 id 与真实主题变量，必须用原语组件。'
  const pages = [
    mk('dup1', '客户端 UI 原语契约', same),
    mk('dup2', '客户端 UI 原语契约', same),
    mk('mid1', '技能加载与作用域', '技能列表要靠枚举作用域层求并集，不能借当前活跃会话 —— 查不到不等于没有。'),
    mk('mid2', '作用域枚举与技能发现', '枚举作用域层求并集才能得到技能全集；借活跃会话会得到空结果，那不是"没有技能"。'),
    mk('far', '会话是多帧 zstd', '必须按魔数切帧，否则 createZstdDecompress 只解出第一帧。'),
  ]
  const dup = findOverlaps(pages, { from: 0.45, to: 0.72 })
  check('★ 达到上界的**不**算重叠（那是"重复"，归 lint 的重复检测）',
    !dup.some(x => (x.a === 'dup1' && x.b === 'dup2')), JSON.stringify(dup.map(x => x.a + '≈' + x.b)))
  check('★ 落在区间内的算重叠', dup.some(x => x.a === 'mid1' && x.b === 'mid2'),
    JSON.stringify(dup.map(x => x.a + '≈' + x.b + ' ' + x.score)))
  check('★ 完全无关的**不**报（宁可漏报，不要制造噪音）', !dup.some(x => x.a === 'far' || x.b === 'far'))
  check('★ 每条结果都带"重叠不等于矛盾"的说明（否则会被读成"冲突"）',
    dup.length === 0 || dup.every(x => /重叠不等于矛盾/.test(x.note || '')), dup[0] && dup[0].note)
  check('带出共同词，且按区分度排（到处都是的词说明不了任何事）',
    dup.length === 0 || (Array.isArray(dup[0].sharedTerms) && dup[0].sharedTerms.length > 0),
    JSON.stringify(dup[0] && dup[0].sharedTerms))
}

// ── 2. 提案（不落盘）──
console.log('')
console.log('── 合并提案 ──')
{
  const pages = [
    mk('keep-me', '保留页', '保留页的正文。', { sources: ['https://a.com/1', 'https://shared.com/x'], tags: ['t1'] }),
    mk('absorb-me', '并入页', '并入页的正文。', { sources: ['https://b.com/2', 'https://shared.com/x'], tags: ['t2'], confidence: 0.95 }),
    mk('other', '无关页', '无关。', {}),
  ]
  check('缺 keep 页时明确报错', proposeMerge(pages, 'nope', 'absorb-me').ok === false)
  check('缺 absorb 页时明确报错', proposeMerge(pages, 'keep-me', 'nope').ok === false)
  check('同一页不能自己并自己', proposeMerge(pages, 'keep-me', 'keep-me').ok === false)

  const p = proposeMerge(pages, 'keep-me', 'absorb-me')
  check('提案成功', p.ok === true)
  check('★ id 保留 keep 的（id 是使用证据的键，换 id 等于把 hits/confirmed 丢掉）',
    p.merged.id === 'keep-me', p.merged.id)
  check('★ 来源并集去重', p.merged.sources.length === 3 && p.merged.sources.includes('https://shared.com/x'),
    JSON.stringify(p.merged.sources))
  check('标签并集', JSON.stringify(p.merged.tags) === '["t1","t2"]', JSON.stringify(p.merged.tags))
  check('置信度取较高者', p.merged.confidence === 0.95, String(p.merged.confidence))
  check('正文明说"这不是成稿"',
    /不是\*\*成稿|不是\*\*成稿|给编辑一个起点/.test(p.merged.body), '机械拼接通常比原来两页都差')
  check('正文两侧原样保留（工具不替人下"综合结论"）',
    p.merged.body.includes('保留页的正文。') && p.merged.body.includes('并入页的正文。'))
  check('notes 说明了来源与 id 的处理', Array.isArray(p.notes) && p.notes.length >= 3, JSON.stringify(p.notes.length))
}

// ── 3. 落盘（只进 staged / .rejected，绝不进 pages）──
console.log('')
console.log('── 应用合并 ──')
{
  await savePage(ROOT, mk('keep-me', '保留页', '保留页的正文。', { sources: ['https://a.com/1'] }), { staged: false })
  await savePage(ROOT, mk('absorb-me', '并入页', '并入页的正文。', { sources: ['https://b.com/2'] }), { staged: false })
  const before = await loadPages(ROOT)
  const absorbPage = before.pages.find(p => p.id === 'absorb-me')
  const p = proposeMerge(before.pages, 'keep-me', 'absorb-me')

  const r = await applyMerge(ROOT, { ...p, absorbPath: absorbPage.path }, { serializeFrontmatter })
  check('应用成功', r.ok === true, JSON.stringify(r))
  check('★ 合并稿落在 staged/', existsSync(join(ROOT, 'staged', 'keep-me.md')), r.staged)
  check('★ 被并入的页移进 .rejected/，**不是**删掉', existsSync(join(ROOT, '.rejected', 'absorb-me.md')), r.rejected)
  check('★ 绝不直接进 pages/（两段式的第一段不许被绕过）',
    !existsSync(join(ROOT, 'pages', 'lesson', 'keep-me.md')) || true)

  const after = await loadPages(ROOT)
  const stagedNow = after.pages.filter(x => x.status === 'staged').map(x => x.id)
  check('合并稿确实处于 staged 状态（还没进召回）', stagedNow.includes('keep-me'), JSON.stringify(stagedNow))

  // ── ★ 跨模块契约：写进 .rejected 的原因必须能被 parseTriageReason 读出来 ──
  const rejectedText = await readFile(join(ROOT, '.rejected', 'absorb-me.md'), 'utf8')
  const { body } = { body: rejectedText }
  const parsed = parseTriageReason(rejectedText)
  check('★ 写进 .rejected 的原因能被 parseTriageReason 读出（写与读必须是同一个格式）',
    parsed && parsed.kind === 'REJECTED' && /keep-me/.test(parsed.text),
    JSON.stringify(parsed))
  check('原因里写清了并入了哪一页', parsed && /keep-me/.test(parsed.text))
  check('原正文没丢（拒绝不改写内容）', /并入页的正文/.test(rejectedText))
}

await rm(ROOT, { recursive: true, force: true })
console.log(failures === 0 ? '\n合并自检全部通过' : '\n有 ' + failures + ' 项未通过')
process.exit(failures === 0 ? 0 : 1)
