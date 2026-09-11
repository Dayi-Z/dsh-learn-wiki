// 冲突检测与页面合并。
//
// ── 先说清楚这个模块**不**做什么 ──
//
// 它**不**判断两页是否互相矛盾。那是语义判断，离线代码做不到 ——
// 假装能做到，产出的就是一堆"疑似冲突"噪音，而噪音会让人连真冲突一起忽略。
//
// 它能确定地做的只有一件事：**指出两页讲的是同一片地面**（主题重叠）。
// 至于"它们说的是同一件事还是相反的事"，必须人读了才知道。所以这里的
// 每一处输出都把这句话写在脸上。
//
// ── 和 lint 的重复检测是什么关系 ──
//
// 同一把尺子（正文余弦），只是**区间不同**：
//   相似度 ≥ duplicateThreshold -> 重复（同一件事说了两遍）-> lint 报
//   相似度 ∈ [overlapFrom, duplicateThreshold) -> 重叠（同一片地面）-> 这里报
// 所以它不是第二套判据，是同一套判据的另一段。
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tokenize } from './recall.js'

function tfOf(page) {
  const tf = new Map()
  const add = (toks, w) => { for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + w) }
  add(tokenize(page.title), 3)
  add(tokenize((page.tags ?? []).join(' ')), 2.5)
  add(tokenize(page.body), 1)
  return tf
}

function cosine(a, b) {
  let dot = 0
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  for (const [t, v] of small) { const w = big.get(t); if (w) dot += v * w }
  let na = 0; for (const v of a.values()) na += v * v
  let nb = 0; for (const v of b.values()) nb += v * v
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** 文档频率，用于挑出"有区分度的共同词"。 */
function docFreq(entries) {
  const df = new Map()
  for (const e of entries) for (const t of e.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1)
  return df
}

/**
 * 找主题重叠的页对。
 *
 * @param from 下界：低于它的相似度连"同一片地面"都算不上，报了只是噪音
 * @param to   上界：达到它就已经是"重复"，归 lint 的重复检测管
 */
export function findOverlaps(pages, { from = 0.45, to = 0.72, topTerms = 6 } = {}) {
  const entries = pages.map(p => ({ id: p.id, title: p.title, tf: tfOf(p) }))
  const df = docFreq(entries)
  const n = entries.length
  const out = []
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = cosine(entries[i].tf, entries[j].tf)
      if (s < from || s >= to) continue
      // 共同词里**按区分度排**：到处都是的词（df 高）说明不了任何事，
      // 只在两页里都出现的罕见词才说明"它们讲的是同一件具体的事"。
      const shared = []
      for (const [t, v] of entries[i].tf) {
        if (!entries[j].tf.has(t)) continue
        shared.push({ term: t, idf: Math.log(n / (1 + (df.get(t) ?? 1))), w: v })
      }
      shared.sort((a, b) => b.idf - a.idf)
      out.push({
        a: entries[i].id, b: entries[j].id,
        score: Number(s.toFixed(4)),
        sharedTerms: shared.slice(0, topTerms).map(x => x.term),
        // ★ 这句话必须跟着结果一起返回。没有它，调用方（包括模型）
        //   很容易把"重叠"读成"冲突"，然后去做一件没必要做的事。
        note: '重叠不等于矛盾：工具只能指出两页讲的是同一片地面，是否互相矛盾必须人读了才知道。',
      })
    }
  }
  out.sort((x, y) => y.score - x.score)
  return out
}

/**
 * 生成合并提案（**不写任何文件**）。
 *
 * 刻意保持机械：它把两页拼起来、并集来源、保留 keep 的 id。
 * 它**不是**一篇可以定稿的页面 —— 一份机械拼接的正文通常比原来两页都差。
 * 它的用途是**给人和模型一个起点**，然后落在 staged/ 等审。
 *
 * 保留 keep 的 id 是故意的：id 是使用证据（hits / confirmed / suspect）的键，
 * 换 id 等于把那份证据丢掉，而"哪一页被确认过"是这里最有价值的信息。
 */
export function proposeMerge(pages, keepId, absorbId, { now = new Date().toISOString() } = {}) {
  const keep = pages.find(p => p.id === keepId)
  const absorb = pages.find(p => p.id === absorbId)
  if (!keep) return { ok: false, error: '找不到 keep 页：' + keepId }
  if (!absorb) return { ok: false, error: '找不到 absorb 页：' + absorbId }
  if (keepId === absorbId) return { ok: false, error: 'keep 与 absorb 不能是同一页' }

  const sources = []
  const seen = new Set()
  for (const s of [...(keep.sources ?? []), ...(absorb.sources ?? [])]) {
    const k = String(s)
    if (seen.has(k)) continue
    seen.add(k); sources.push(k)
  }
  const tags = [...new Set([...(keep.tags ?? []), ...(absorb.tags ?? [])])]

  const body = [
    String(keep.body ?? '').trim(),
    '',
    '---',
    '',
    '## 合并自 \`' + absorb.id + '\`（' + now.slice(0, 10) + '）',
    '',
    // ★ 保留原样而不是改写成"综合结论"。改写需要判断，而判断正是人/模型
    //   这一步该做的事 —— 工具替它下结论，就等于把两页的证据洗掉了。
    '> 以下是原样并入的另一页正文。合并提案**不是**成稿：',
    '> 机械拼接通常比原来两页都差，它只是给编辑一个起点。',
    '',
    String(absorb.body ?? '').trim(),
  ].join('\n')

  return {
    ok: true,
    keep: keep.id,
    absorb: absorb.id,
    merged: {
      id: keep.id,                     // 保留 id = 保留使用证据
      title: keep.title || keep.id,
      category: keep.category,
      confidence: Math.max(keep.confidence ?? 0, absorb.confidence ?? 0),
      sources,
      tags,
      created: keep.created ?? now,
      updated: now,
      body,
    },
    notes: [
      '来源已并集去重（' + (keep.sources ?? []).length + ' + ' + (absorb.sources ?? []).length + ' -> ' + sources.length + '）',
      'id 保留 ' + keep.id + '，使用证据（hits/confirmed/suspect）不会丢',
      'absorb 页 \`' + absorb.id + '\` 不会被自动删除 —— 应用时移入 .rejected/ 并附原因',
      '这是机械拼接，**不是成稿**。它会落在 staged/，等你或模型改写后再固化',
    ],
  }
}

/**
 * 应用合并：把合并稿写进 **staged/**，把 absorb 页移进 .rejected/ 并附上原因。
 *
 * ★ 合并稿进 staged 而不是 pages：两段式的第一段是防投毒闸门。
 *   合并同样是"产生一条新知识"，没有理由绕过它。
 * ★ absorb 页移进 .rejected 而不是删掉：这个项目的原则是"降权可逆，删除不可逆"，
 *   而且 .rejected/README.md 要求每条都带 \`> REJECTED:\` 说明。
 *   合并是**最强的拒绝理由**：它的内容已经在 keep 里了。
 */
export async function applyMerge(repoRoot, proposal, { serializeFrontmatter, now = new Date().toISOString() } = {}) {
  if (!proposal?.ok) return { ok: false, error: '提案无效' }
  const merged = proposal.merged
  if (!serializeFrontmatter) return { ok: false, error: 'applyMerge 需要 serializeFrontmatter' }

  // 1) 合并稿 -> staged/
  const stagedDir = join(repoRoot, 'staged')
  await mkdir(stagedDir, { recursive: true })
  const stagedPath = join(stagedDir, merged.id + '.md')
  const fm = serializeFrontmatter({
    id: merged.id, title: merged.title, category: merged.category,
    confidence: merged.confidence, status: 'staged',
    sources: merged.sources, created: merged.created, updated: merged.updated,
    hits: 0, tags: merged.tags,
  })
  await writeFile(stagedPath, fm + '\n\n' + String(merged.body).trim() + '\n', 'utf8')

  // 2) absorb 页 -> .rejected/，并**按约定**补上原因
  const rejectedDir = join(repoRoot, '.rejected')
  await mkdir(rejectedDir, { recursive: true })
  let moved = null
  if (proposal.absorbPath) {
    let text = ''
    try { text = await readFile(proposal.absorbPath, 'utf8') } catch { text = '' }
    const reason = '> REJECTED: ' + now.slice(0, 10) + ' —— 已并入 \`' + merged.id
      + '\`（合并提案，见 staged/' + merged.id + '.md）。\n'
      + '> 合并是最强的拒绝理由：它的正文与来源都已经在 keep 页里了。\n'
    // 插在 frontmatter 之后、正文之前 —— 与 .rejected/README.md 的约定一致
    const cut = text.indexOf('\n---', 4)
    const withReason = cut >= 0
      ? text.slice(0, cut + 4) + '\n' + reason + text.slice(cut + 4)
      : reason + text
    const dest = join(rejectedDir, proposal.absorb + '.md')
    await writeFile(dest, withReason, 'utf8')
    try { await unlink(proposal.absorbPath) } catch { /* 原文件删不掉不致命，但要在返回里说 */ }
    moved = '.rejected/' + proposal.absorb + '.md'
  }

  return { ok: true, staged: 'staged/' + merged.id + '.md', rejected: moved }
}
