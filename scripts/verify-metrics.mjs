// 命中率与补料收益度量的自检。
//
// 这一块的独特风险：**数字会被人当真**。一个算错的百分比不会报错，
// 它只会让人做出错误的判断（"补料没用，关掉吧"）。
//
// 所以测的重点是三条诚实边界：
//   1. 日志派生的数是**下界**，窗口必须一起报出来
//   2. confirmed 是弱信号，不能被说成成功率
//   3. **拿不到数据时给 null，不给 0** —— 一个自信的 0% 比没有数字更糟
import { parseLog, injectionStats, acquisitionRoi, libraryUsage, buildMetrics, renderMetrics } from '../lib/metrics.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

// ── 1. 日志解析：用真实形态的行 ──
console.log('')
console.log('── 日志解析 ──')
const LOG = [
  '[2026-09-10T07:58:53.087Z] inject bucket=hit best=0.2275 hit=1 weak=0',
  '[2026-09-10T08:00:00.000Z] inject bucket=weak best=0.190 hit=0 weak=2',
  '[2026-09-10T08:01:00.000Z] staged: some-page (gap abc123def456)',
  '[2026-09-10T08:02:00.000Z] background acquisition (turn-end): {"considered":2,"staged":0,"skipped":2,"errors":0}',
  '[2026-09-10T08:03:00.000Z] deliver: 已投递到当前轮 -> some-page',
  '[2026-09-10T08:04:00.000Z] usage: 记为确认 some-page',
  '[2026-09-10T08:05:00.000Z] fetched 33187 chars: https://x.com/a',
  '这一行不是任何已知形态，必须被忽略而不是让解析炸掉',
].join('\n')
{
  const L = parseLog(LOG)
  check('抽出注入', L.injections.length === 2 && L.injections[0].bucket === 'hit', JSON.stringify(L.injections[0]))
  check('抽出落暂存（含 gap 关联）', L.stagings.length === 1 && L.stagings[0].gap === 'abc123def456', JSON.stringify(L.stagings[0]))
  check('抽出补料批次与计数', L.acquisitions.length === 1 && L.acquisitions[0].considered === 2, JSON.stringify(L.acquisitions[0]))
  check('抽出投递', L.deliveries.length === 1 && L.deliveries[0].page === 'some-page', JSON.stringify(L.deliveries[0]))
  check('抽出证据记录', L.usage.length === 1)
  check('抽出抓取字数', L.fetches.length === 1 && L.fetches[0].chars === 33187)
  check('无法识别的行被忽略，不炸', L.total === 8)
  check('★ 报出日志窗口（没有窗口，那些比例就没有分母可言）',
    L.from === '2026-09-10T07:58:53.087Z' && L.to !== null, L.from + ' ~ ' + L.to)
  // 能匹配正则、但里面的 JSON 是坏的 —— 这才是真正要防的情形。
  // （不匹配正则的行在上一检查组已经证明会被整个忽略。）
  const bad = parseLog('[x] background acquisition (t): {坏掉的 json}')
  check('补料批次的 JSON 坏掉时不编造字段',
    bad.acquisitions.length === 1 && bad.acquisitions[0].considered === undefined,
    JSON.stringify(bad.acquisitions[0]))
}

// ── 2. 注入统计 ──
console.log('')
console.log('── 注入命中率 ──')
{
  const s = injectionStats(parseLog(LOG).injections)
  check('总数与分桶', s.total === 2 && s.byBucket.hit === 1 && s.byBucket.weak === 1, JSON.stringify(s.byBucket))
  check('hit 比例', s.hitRate === 0.5, String(s.hitRate))
  check('★ 明说 miss 不进日志（否则这个比例会被读成"全部轮次"）',
    /miss/.test(s.note), s.note)
  check('★ 没有注入时给 null 而不是 0（0 会被读成"一次都没命中"）',
    injectionStats([]).hitRate === null)
}

// ── 3. 补料漏斗 ──
console.log('')
console.log('── 补料漏斗 ──')
{
  const gaps = [
    { id: 'abc123def456', status: 'done', attempts: 1, seen: 3, lastReason: '' },
    { id: 'nope00000000', status: 'skipped', attempts: 1, seen: 1, lastReason: 'distiller refused (0 page(s) fetched): 没有抓取到任何页面正文内容' },
    { id: 'refused11111', status: 'skipped', attempts: 2, seen: 2, lastReason: 'distiller refused (3 page(s) fetched): 内容与本仓库无关' },
  ]
  const pages = [
    { id: 'some-page', status: 'committed', created: '2026-09-01T00:00:00Z' },
    { id: 'not-yet', status: 'staged', created: '2026-09-01T00:00:00Z' },
  ]
  const usage = { pages: { 'some-page': { hits: 2, confirmed: 1, suspect: 0 } } }
  const roi = acquisitionRoi({ gaps, log: parseLog(LOG), pages, usage })
  check('漏斗四级都对', JSON.stringify(roi.funnel) === JSON.stringify({ gap: 3, produced: 1, committed: 1, confirmed: 1 }),
    JSON.stringify(roi.funnel))
  check('★ 按 gap 关联到页（不是"看起来像"）',
    roi.rows.find(r => r.gap === 'abc123def456').produced[0] === 'some-page')
  check('拒绝原因分成"抓不到正文"与"蒸馏器拒绝"（修法不同：前者换检索词，后者是闸门在工作）',
    roi.skipReasons.noFetch === 1 && roi.skipReasons.refused === 1, JSON.stringify(roi.skipReasons))
  check('★ 明说 confirmed 不是成功率、相关不等于因果',
    /弱信号/.test(roi.note) && /不能证明/.test(roi.note), roi.note)

  // 落暂存但没固化的，不能算进"固化"
  const roi2 = acquisitionRoi({
    gaps: [{ id: 'g2', status: 'done', attempts: 1, seen: 1, lastReason: '' }],
    log: parseLog('[t] staged: not-yet (gap g2)'),
    pages, usage,
  })
  check('★ 只落暂存、还没固化的，不计入固化', roi2.funnel.produced === 1 && roi2.funnel.committed === 0,
    JSON.stringify(roi2.funnel))
}

// ── 4. 利用率 ──
console.log('')
console.log('── 知识库利用率 ──')
{
  const pages = [
    { id: 'a', status: 'committed' }, { id: 'b', status: 'committed' },
    { id: 'c', status: 'committed' }, { id: 's', status: 'staged' },
  ]
  const usage = { pages: { a: { hits: 3, confirmed: 1, suspect: 0 }, b: { hits: 1, confirmed: 0, suspect: 1 } } }
  const lib = libraryUsage(pages, usage)
  check('只统计已固化页（staged 不计入分母）', lib.committed === 3, String(lib.committed))
  check('从没命中过的页被列出来', lib.neverHit === 1 && lib.neverHitIds[0] === 'c', JSON.stringify(lib.neverHitIds))
  check('利用率 = 命中过 / 已固化', lib.utilization === 0.6667, String(lib.utilization))
  check('空库时利用率为 null 而不是 0', libraryUsage([], {}).utilization === null)
}

// ── 5. ★ 拿不到数据时不许编 ──
console.log('')
console.log('── 拿不到日志时（最能暴露"编数字"的地方）──')
{
  const m = buildMetrics({ logText: '', gaps: [], pages: [], usage: {} })
  check('窗口未知时 from/to 为 null', m.window.from === null && m.window.to === null, JSON.stringify(m.window))
  check('★ 没有注入 -> hitRate 为 null，**不是 0%**', m.injections.hitRate === null, String(m.injections.hitRate))
  check('caveats 里明说窗口是未知的', m.caveats.some(c => /窗口/.test(c)), JSON.stringify(m.caveats[0]))
  check('漏斗全 0 但不报比例（分母为 0 时不装作有结论）',
    m.acquisition.funnel.gap === 0 && m.library.utilization === null)

  const txt = renderMetrics(m)
  check('渲染里带上"这些数字不能说明什么"',
    /不能说明什么/.test(txt) && /下界/.test(txt))
  check('渲染里 null 显示为 — 而不是 0%', txt.includes('—'), txt.split('\n').find(l => /利用率/.test(l)))
}

console.log(failures === 0 ? '\n度量自检全部通过' : '\n有 ' + failures + ' 项未通过')
process.exit(failures === 0 ? 0 : 1)
