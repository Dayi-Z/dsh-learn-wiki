// 「被纠正」触发器的自检。
//
// ── 这个检测器的本质局限，必须写在测试里 ──
//
// 它是**关键词**检测，不是语义理解。所以它一定漏报 —— 而且可以举出**真实例子**：
// 本项目开发过程中，用户说过"按钮未与主题同步 字体颜色与按钮同色完全不可见"，
// 那是一次货真价实的纠正，但它以陈述句形式出现，一个关键词都不命中。
//
// 这不打算修。修它就得引入语义判断，而误报的代价（把一条好知识降权、
// 在日志里留下噪音）比漏报高。所以这里的目标是：
//   · 常见纠正形态要认出来
//   · 提问**绝不能**被当成纠正（那是最容易犯的错）
//   · 漏报的边界要写清楚，而不是假装覆盖面很广
import { looksLikeCorrection, correctionRecord } from '../lib/correction.js'
import { SIGNAL_TYPES } from '../lib/struggle.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

// ── 1. 该认出来的 ──
console.log('')
console.log('── 该认出来的（真实语料形态）──')
const YES = [
  '不对，应该是先读再改',
  '不是这样的，我说的是用 B 方案',
  '错了，那个接口是 POST',
  '搞错了，是另一个文件',
  '你应该先跑测试再提交',
  '我说的是 keep 那一页，不是 absorb',
  '别改 CHANGELOG，先改代码',
  '不要动 source.entries',
  '重来，按我上一条说的做',
  '纠正一下：那个路径是错的',
  'no, that is the wrong file',
  "that's wrong, it should be lowercase",
  'actually, use the other slot',
  'I said read the file first',
  '你理解错了，缓存不是那个意思',
]
for (const t of YES) {
  const r = looksLikeCorrection(t)
  check('认出：' + JSON.stringify(t.slice(0, 24)), r.yes, JSON.stringify(r.markers))
}

// ── 2. ★ 绝不能认错：提问 ──
console.log('')
console.log('── 绝不能当成纠正（提问是最容易犯的错）──')
const NO_Q = [
  '这样不对吗？',
  '为什么不生效？',
  '不是应该先读再改吗？',
  '为什么和真实LLM有关系？',
  '你现在进行到哪了？',
  '这样可以吗？',
  'is this wrong?',
]
for (const t of NO_Q) {
  const r = looksLikeCorrection(t)
  check('问句不算：' + JSON.stringify(t.slice(0, 20)), r.yes === false, r.reason || JSON.stringify(r.markers))
}

// ── 3. 普通请求不能被误判 ──
console.log('')
console.log('── 普通请求 ──')
const NO = [
  '把待办按顺序清掉',
  '开始吧',
  '顺便把memoripo停掉',
  '现在的主要工作不是修改guardian 是继续完善learnwiki直到达到上线标准',
  '可以 开始吧',
  '做针对分拣的内容',
  '这个文件在哪里',
]
for (const t of NO) {
  const r = looksLikeCorrection(t)
  check('不是纠正：' + JSON.stringify(t.slice(0, 22)), r.yes === false, JSON.stringify(r.markers))
}

// ── 4. ★ 如实记录漏报（不假装覆盖面很广）──
console.log('')
console.log('── 已知漏报（写出来，而不是假装检测得到）──')
{
  const missed = [
    '按钮未与主题同步 字体颜色与按钮同色完全不可见',
    '侧边栏已经消失了 把待办按顺序清掉',
    'web端又自己崩了 你自己检查一下',
  ]
  let got = 0
  for (const t of missed) if (looksLikeCorrection(t).yes) got++
  check('★ 陈述句形式的纠正确实检测不到 —— 这是**已知且接受**的边界，不是 bug',
    got < missed.length,
    got + '/' + missed.length + ' 命中；漏报是关键词检测的固有代价，修它要引入语义判断')
  check('★ 而且漏报不会造成伤害（它只是少记一次嫌疑，不会记错）',
    looksLikeCorrection(missed[0]).yes === false)
}

// ── 5. 记录形状：必须与挣扎记录同形 ──
console.log('')
console.log('── 记录形状 ──')
{
  const rec = correctionRecord({
    agent: { id: 'session-abc' }, text: '  不对，应该是 A 方案  ', markers: ['不对'],
    corrected: ['page-x'], origin: 'agent', depth: 0, now: 1700000000000,
  })
  check('★ 与挣扎记录同形（wiki_struggle / 界面 / wiki_sessions 已经在读那个形状）',
    typeof rec.ts === 'string' && typeof rec.sessionId === 'string'
    && Array.isArray(rec.signals) && rec.signals[0].type === 'user-correction',
    JSON.stringify(Object.keys(rec)))
  check('★ 信号类型已登记进 SIGNAL_TYPES（否则读的一方认不出它）',
    SIGNAL_TYPES.includes('user-correction'), JSON.stringify(SIGNAL_TYPES))
  check('原话被规范化并保留', rec.signals[0].detail === '不对，应该是 A 方案', rec.signals[0].detail)
  check('identity 不含计数/时间（否则同一件事会被拆成不同的键）',
    !/\d{4}-\d{2}-\d{2}|×\d/.test(rec.signals[0].identity), rec.signals[0].identity)
  check('被归因的页带在记录里（可追溯）', JSON.stringify(rec.corrected) === '["page-x"]')
  check('origin / depth 带上（子代理与主代理的记录含义不同）',
    rec.origin === 'agent' && rec.depth === 0)
  check('没有 agent 时不炸，sessionId 退化成空串（不是 undefined —— 那会让工具输出非 lossless JSON）',
    correctionRecord({ text: 'x', markers: [] }).sessionId === '')
  check('超长原话被截断', correctionRecord({ text: 'x'.repeat(5000), markers: [] }).signals[0].detail.length <= 300)
}

// ── 6. 不该触发补料 ──
console.log('')
console.log('── 不该触发联网补料 ──')
{
  // 这个断言读的是配置，不是运行结果：纠正的答案来自用户，
  // 联网去搜用户刚说过的话是最糟的反应（搜不到，而且等于承认没在听）。
  const { DEFAULTS } = await import('../lib/config.js')
  check('★ user-correction **不在** gapTriggerSignals 白名单里',
    !(DEFAULTS.gapTriggerSignals ?? []).includes('user-correction'),
    JSON.stringify(DEFAULTS.gapTriggerSignals))
}

console.log(failures === 0 ? '\n纠正检测自检全部通过' : '\n有 ' + failures + ' 项未通过')
process.exit(failures === 0 ? 0 : 1)
