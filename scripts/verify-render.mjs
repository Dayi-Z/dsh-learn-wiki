/**
 * 结构级渲染测试：**真 React** + **自写的原语替身** → 静态 HTML。
 *
 * ── 这个测试验证什么、不验证什么 ──
 *
 * 验证：
 *   1. 不崩。用真 React 渲染整棵组件树（服务端渲染，不挂浏览器）。
 *      这一类 bug 是实际发生过的：一个三元表达式少写了 ` : null `，
 *      组件在某个分支下返回 undefined，整棵树当场渲染失败 —— 而"看界面"
 *      是发现不了它的，因为界面根本没画出来。
 *   2. 分组正确。工具表按「族」分组：族标题出现一次、计数正确、顺序是
 *      核心在前其余按字母。
 *   3. 行数对。渲染出的行数 = 纯函数算出的行数，且**顺序**也一致。
 *   4. 位置稳定。★ 同一份知识，只改证据（命中/证实/反证），渲染出的
 *      行序必须逐条相同。这条是"排序不再随证据漂移"的回归测试。
 *
 * 不验证（明确说明，不假装）：
 *   · 样式。原语是**替身**，不是 DSH 真原语，所以颜色、间距、层级一律没测。
 *     每个替身元素都带 data-stub="<原名>"，出来的 HTML 一眼能看出哪段是替身。
 *   · 交互。服务端渲染不跑 useEffect，也不产生事件。点击/展开/提交这些
 *     路径由纯逻辑断言（__logic）覆盖，不是由这个测试覆盖。
 *   · 真实原语的契约漂移（比如 Pill 哪天改了 props）。替身是照它当前实现
 *     写的（Pill: 有 onClick 才是 button），原语一改这里不会响。
 *
 * 想看"界面到底长什么样"，用 scripts/ui-snapshot.mjs —— 它把同一套渲染
 * 结果配上真实主题 token 截成 PNG。两个脚本共用 scripts/lib/ui-harness.mjs，
 * 所以"测到的"和"看到的"是同一个东西。
 *
 * 用法：node scripts/verify-render.mjs
 */
import { loadHarness, makeTools, makePages, makeState, hasReact, APP_MODULES }
  from './lib/ui-harness.mjs'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}
const count = (hay, needle) => hay.split(needle).length - 1

if (!hasReact()) {
  console.log('  SKIP  DSH 的 node_modules 里没有 react，无法做渲染测试：' + APP_MODULES)
  process.exit(0)
}

const H = await loadHarness()
const h = H.h
const { renderToStaticMarkup } = H
console.log('  React ' + H.version + '（取自 DSH 自己的 node_modules）')

const M = H.build(true)
check('从模块加载器捕获到 factory', typeof H.factory === 'function')
check('导出 name/inject/apply（DSH 的客户端插件契约）',
  M.name === 'dsh-learn-wiki' && Array.isArray(M.inject) && typeof M.apply === 'function',
  M.name + ' inject=' + JSON.stringify(M.inject))
check('导出测试接缝 __components / __logic',
  !!M.__components && !!M.__logic && typeof M.__css === 'string' && M.__css.length > 1000,
  Object.keys(M.__components || {}).join(','))
if (!M.__components || !M.__logic) { console.log('\n无法继续'); process.exit(1) }

const { toolGroups, knowledgeView, KFILTERS } = M.__logic

// ── 1. 纯逻辑（不经 React） ──
console.log('')
console.log('── 纯逻辑（不经 React） ──')

const tools = makeTools()
const groups = toolGroups(tools, '', 'all')
const groupRows = groups.filter((g) => g.kind === 'group')
const rowRows = groups.filter((g) => g.kind === 'row')
const famOrder = groupRows.map((g) => g.family)
check('分组：族标题顺序正确（核心在前，其余按字母）',
  JSON.stringify(famOrder) === JSON.stringify(['核心', 'github', 'hindsight', 'web', 'wiki']),
  JSON.stringify(famOrder))
check('分组：行数 = 工具总数', rowRows.length === tools.length,
  rowRows.length + ' vs ' + tools.length)
// ★ 这一条第一次跑就抓到了真 bug：组计数用的是 out[out.length - 1]，
//   而循环体已经把行 push 进去了，于是 n++ 加到了行对象上，族标题恒显示 1。
check('★ 分组：每个族的计数 = 该族实际成员数',
  groupRows.every((g) => g.n === rowRows.filter((r) => (r.item.family || '核心') === g.family).length),
  JSON.stringify(groupRows.map((g) => g.family + ':' + g.n)))
check('分组：所有族的计数之和 = 总行数',
  groupRows.reduce((n, g) => n + g.n, 0) === rowRows.length)

// ★ 顺序不随勾选变：把 denied 全部翻转，行序必须逐字相同
const flipped = tools.map((t) => Object.assign({}, t, { denied: !t.denied }))
const namesBefore = toolGroups(tools, '', 'all').filter((g) => g.kind === 'row').map((r) => r.item.name)
const namesAfter = toolGroups(flipped, '', 'all').filter((g) => g.kind === 'row').map((r) => r.item.name)
check('★ 工具行序不随勾选变化（点了方框，行不换位置）',
  JSON.stringify(namesBefore) === JSON.stringify(namesAfter))

check('筛选：只看已裁 = denied 的那些',
  toolGroups(tools, '', 'denied').filter((g) => g.kind === 'row').every((r) => r.item.denied))
check('筛选：只看常驻 = 非 denied 的那些',
  toolGroups(tools, '', 'kept').filter((g) => g.kind === 'row').every((r) => !r.item.denied))
check('筛选：按名字搜不区分大小写',
  toolGroups(tools, 'HINDSIGHT_TOOL00', 'all').filter((g) => g.kind === 'row').length === 1)
check('筛选：搜不到时没有行',
  toolGroups(tools, '绝不可能匹配的名字', 'all').filter((g) => g.kind === 'row').length === 0)

const pages = makePages(15)
const view1 = knowledgeView(pages, 'all')
const ids1 = view1.shown.map((p) => p.id)
check('知识：按 id 升序', JSON.stringify(ids1) === JSON.stringify(ids1.slice().sort()), ids1.slice(0, 3).join(','))

// ★ 只改证据，行序必须完全一样
const evidenceChanged = pages.map((p, i) => Object.assign({}, p, {
  hits: (i * 7) % 5, confirmed: (i * 3) % 4, suspect: (i * 5) % 3,
  cls: ['confirmed', 'unconfirmed', 'suspect', 'dead'][i % 4], quarantined: i % 2 === 0,
}))
const ids2 = knowledgeView(evidenceChanged, 'all').shown.map((p) => p.id)
check('★ 知识行序不随证据变化（上一版按"需关注度"排，证据一变行就漂）',
  JSON.stringify(ids1) === JSON.stringify(ids2))

const filterCounts = {}
for (const f of KFILTERS) filterCounts[f.id] = knowledgeView(pages, f.id).shown.length
check('筛选：全部 = 全部', filterCounts.all === pages.length, JSON.stringify(filterCounts))
check('筛选：已确认 / 未确认 / 有反证 / 已隔离 各自非空',
  filterCounts.confirmed > 0 && filterCounts.unconfirmed > 0
  && filterCounts.suspect > 0 && filterCounts.quarantined > 0,
  JSON.stringify(filterCounts))
check('筛选：已确认 = cls 为 confirmed 的条数',
  filterCounts.confirmed === pages.filter((p) => p.cls === 'confirmed').length)
check('筛选：有反证 = suspect > 0 的条数（含观察中）',
  filterCounts.suspect === pages.filter((p) => (p.suspect || 0) > 0).length)
check('筛选：未知档位退回"全部"而不是空表',
  knowledgeView(pages, '根本不存在的档位').shown.length === pages.length)

// ── 2. 渲染 ──
console.log('')
console.log('── 渲染（真 React → 静态 HTML） ──')

const state = makeState()
const results = {}
function render(label, Component, props) {
  try {
    const html = renderToStaticMarkup(h(Component, props))
    results[label] = { ok: true, html }
    check('渲染 ' + label, true)
    return html
  } catch (e) {
    results[label] = { ok: false, error: String((e && e.message) || e) }
    check('渲染 ' + label, false, String((e && e.message) || e))
    return ''
  }
}

const C = M.__components
for (const [label, Component, props] of [
  ['能力页签（工具段）', C.CapabilitiesTab, { state }],
  ['工具段', C.ToolsSection, { state }],
  ['技能段', C.SkillsSection, { state }],
  ['知识页签', C.KnowledgeTab, { state }],
  ['补料页签', C.SupplyTab, { state }],
  ['面板外壳', C.PanelBody, {}],
  ['底栏入口', C.FooterEntry, {}],
  ['面板容器', C.Workbench, { onClose: () => {} }],
  ['展开行（读取中）', C.PageDetail, { id: 'x', meta: {}, page: { loading: true }, onRetry: () => {} }],
  ['展开行（读失败）', C.PageDetail, { id: 'x', meta: {}, page: { error: 'HTTP 404' }, onRetry: () => {} }],
  ['展开行（有正文）', C.PageDetail, {
    id: 'x', meta: { factor: 1.2 },
    page: {
      data: {
        id: 'x', category: 'fact', confidence: 0.7,
        created: '2026-09-01', updated: '2026-09-02', body: '正文',
        sources: ['https://example.com/a', 'not-a-url'],
        usage: { hits: 2, confirmed: 1, suspect: 0 },
      },
    },
    onRetry: () => {},
  }],
]) render(label, Component, props)

// 行数对
const toolHtml = results['工具段'].html
const expRows = toolGroups(tools, '', 'all').filter((g) => g.kind === 'row').length
const expGroups = toolGroups(tools, '', 'all').filter((g) => g.kind === 'group').length
check('工具表：渲染出的数据行数 = 纯函数算出的行数',
  count(toolHtml, 'class="lw-tr"') === expRows,
  'DOM ' + count(toolHtml, 'class="lw-tr"') + ' vs 期望 ' + expRows)
check('工具表：渲染出的族标题数 = 分组数',
  count(toolHtml, 'class="lw-group"') === expGroups,
  'DOM ' + count(toolHtml, 'class="lw-group"') + ' vs 期望 ' + expGroups)
check('工具表：每个族名都出现在 HTML 里',
  ['核心', 'github', 'hindsight', 'web', 'wiki'].every((f) => toolHtml.includes('>' + f + '<')),
  ['核心', 'github', 'hindsight', 'web', 'wiki'].filter((f) => !toolHtml.includes('>' + f + '<')).join(',') || '全部命中')
check('★ 工具表：族标题里的计数与纯函数一致（不是恒显示 1）',
  toolGroups(tools, '', 'all').filter((g) => g.kind === 'group')
    .every((g) => toolHtml.includes('class="lw-group-n">' + g.n + '<')),
  JSON.stringify(toolGroups(tools, '', 'all').filter((g) => g.kind === 'group').map((g) => g.n)))
check('工具表：每行都有键盘可达的 checkbox（带 aria-label）',
  count(toolHtml, 'type="checkbox"') === expRows && count(toolHtml, 'aria-label="裁掉 ') + count(toolHtml, 'aria-label="放回 ') === expRows)

// 行数对：知识表
const knHtml = results['知识页签'].html
const fixtureCount = (f) => state.knowledge.committed.filter(f.test).length
check('知识表：渲染出的数据行数 = 纯函数算出的行数（全部档）',
  count(knHtml, 'class="lw-tr x"') === knowledgeView(state.knowledge.committed, 'all').shown.length,
  'DOM ' + count(knHtml, 'class="lw-tr x"') + ' vs 期望 ' + knowledgeView(state.knowledge.committed, 'all').shown.length)
check('★ 知识表：筛选器带计数（否则你得点进去才知道那一档是空的）',
  KFILTERS.every((f) => knHtml.includes(f.label + ' ' + fixtureCount(f).toLocaleString('en-US'))),
  KFILTERS.map((f) => f.label + '→' + fixtureCount(f)).join(' '))
check('★ 知识表：每行的展开控件是真的 <button>（键盘可达；tr 不是）',
  count(knHtml, 'class="lw-chevbtn"') === count(knHtml, 'class="lw-tr x"')
  && count(knHtml, 'aria-expanded="false"') >= count(knHtml, 'class="lw-tr x"'),
  'chevbtn=' + count(knHtml, 'class="lw-chevbtn"') + ' rows=' + count(knHtml, 'class="lw-tr x"'))
check('技能表：渲染出的技能行数 = 夹具条数',
  count(results['技能段'].html, 'class="lw-tr x"') === 11,
  'DOM ' + count(results['技能段'].html, 'class="lw-tr x"'))

// ★ 渲染出来的行序 = 纯函数的行序（不能只是"数目对"，顺序也得对）
const domOrder = [...knHtml.matchAll(/aria-label="(?:收起|展开) ([^"]+)"/g)].map((m) => m[1])
const expOrder = knowledgeView(state.knowledge.committed, 'all').shown.map((p) => p.title)
check('★ 知识表：DOM 里的行序 = 纯函数算出的行序',
  JSON.stringify(domOrder) === JSON.stringify(expOrder),
  JSON.stringify(domOrder.slice(0, 3)) + ' vs ' + JSON.stringify(expOrder.slice(0, 3)))

// 证据变了，DOM 行序不能变
const state2 = makeState({ knowledge: Object.assign({}, state.knowledge, { committed: evidenceChanged }) })
const kn2 = render('知识页签（证据已变）', C.KnowledgeTab, { state: state2 })
const domOrder2 = [...kn2.matchAll(/aria-label="(?:收起|展开) ([^"]+)"/g)].map((m) => m[1])
check('★ 证据变化后 DOM 行序逐条相同（位置稳定性的端到端断言）',
  JSON.stringify(domOrder) === JSON.stringify(domOrder2),
  JSON.stringify(domOrder2.slice(0, 3)))

// 分段导航
const capHtml = results['能力页签（工具段）'].html
check('能力页签：有工具/技能分段导航（71+11 堆一列的问题）',
  capHtml.includes('role="tablist"') && capHtml.includes('工具 72') && capHtml.includes('技能 11'),
  'tablist=' + count(capHtml, 'role="tablist"'))
check('能力页签：默认只画工具段（不是两段首尾相接）',
  !capHtml.includes('常驻目录'))

// ── 3. 退化路径 ──
console.log('')
console.log('── 退化路径（原语 require 失败，界面不能整个消失） ──')
const M2 = H.build(false)
for (const [label, Component] of [
  ['能力页签', M2.__components.CapabilitiesTab],
  ['知识页签', M2.__components.KnowledgeTab],
  ['补料页签', M2.__components.SupplyTab],
  ['底栏入口', M2.__components.FooterEntry],
]) {
  try {
    const html = renderToStaticMarkup(h(Component, { state }))
    check('无原语时 ' + label + ' 仍然渲染', true)
    if (Component !== M2.__components.FooterEntry) {
      check('无原语时 ' + label + ' 画出了内容', html.length > 200, 'html=' + html.length + ' 字符')
    }
  } catch (e) {
    check('无原语时 ' + label + ' 仍然渲染', false, String((e && e.message) || e))
  }
}

// ── 4. 空状态与缺字段：历史 bug 就长在这里 ──
console.log('')
console.log('── 空状态与缺字段（历史 bug 就长在这里） ──')
for (const [label, over] of [
  ['目录未捕获', { capturedAt: false }],
  ['零工具', { items: [] }],
  ['技能注册表不可用', { skills: { available: false, reason: '拿不到 agent 作用域键' } }],
  ['技能注册表为空', { skills: { available: true, items: [], totals: { count: 0, catalogTokens: 0, bodyTokens: 0 } } }],
  ['零知识零暂存', { knowledge: { committed: [], staged: [], counts: {} } }],
  ['知识字段缺失', {
    knowledge: {
      committed: [
        { id: 'a', title: null, cls: 'confirmed' },
        { id: 'b', cls: null, suspect: null, hits: null, quarantined: null },
      ],
      staged: [], counts: {},
    },
  }],
  ['knowledge 是空对象（键全缺）', { knowledge: {} }],
]) {
  const s = makeState(over)
  for (const [cname, Component] of [
    ['能力页签', C.CapabilitiesTab],
    ['知识页签', C.KnowledgeTab],
    ['补料页签', C.SupplyTab],
  ]) {
    try {
      const html = renderToStaticMarkup(h(Component, { state: s }))
      check('空状态「' + label + '」下 ' + cname + ' 不崩且非空', html.length > 0, 'html=' + html.length)
    } catch (e) {
      check('空状态「' + label + '」下 ' + cname + ' 不崩', false, String((e && e.message) || e))
    }
  }
}

try {
  renderToStaticMarkup(h(C.CapabilitiesTab, { state: {} }))
  renderToStaticMarkup(h(C.KnowledgeTab, { state: {} }))
  renderToStaticMarkup(h(C.SupplyTab, { state: {} }))
  check('state 为空对象时不崩（这是首帧真实会发生的事）', true)
} catch (e) {
  check('state 为空对象时不崩', false, String((e && e.message) || e))
}

// ── 5. 诚实性 ──
console.log('')
console.log('── 诚实性 ──')
check('★ 原语替身在 HTML 里自曝身份（不假装测了样式）',
  count(toolHtml, 'data-stub="') > 0, '替身标记 ' + count(toolHtml, 'data-stub="') + ' 处')
check('★ 本测试不证明长相：样式/主题/层级一律未测，替身不是真原语', true,
  '要看长相用 scripts/ui-snapshot.mjs（同一个装载台 + 真实主题 token）')

console.log('')
if (failures === 0) {
  console.log('ALL PASS — 组件树能渲染、分组正确、行数与顺序可断言')
  console.log('提醒：这个测试**没有**验证样式与交互。替身不是真原语。')
} else {
  console.log(failures + ' FAILURE(S)')
}
process.exit(failures === 0 ? 0 : 1)
