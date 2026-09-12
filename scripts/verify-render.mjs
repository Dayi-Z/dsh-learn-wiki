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

const { toolGroups, toolRowsVisible, familyOpen, knowledgeView, KFILTERS, pendingTotal } = M.__logic

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

// ── 折叠（72 行 ≈ 6 屏，收起来才看得全）──
console.log('')
console.log('── 族折叠 ──')
{
  const all = toolGroups(tools, '', 'all')
  const allRows = all.filter(g => g.kind === 'row').length
  const allGroups = all.filter(g => g.kind === 'group')

  // ★ 默认全部收起。第一版让「核心」默认展开，量完才发现几乎没用：
  //   核心族是最大的一族（44/72），展开它等于没折。
  check('★ 默认全部收起（核心族占 44/72，展开它等于没折）',
    allGroups.every(g => familyOpen(g.family, {}, false) === false),
    JSON.stringify(allGroups.map(g => g.family + ':' + familyOpen(g.family, {}, false))))

  const vis = toolRowsVisible(all, { collapsed: {}, forceOpen: false })
  const visRows = vis.filter(g => g.kind === 'row').length
  check('★ 收起后可见行数**为 0**（族标题还在，行全收）', visRows === 0,
    visRows + ' / ' + allRows)
  check('★ 族标题**一个都不能少**（收起的是行，不是族本身）',
    vis.filter(g => g.kind === 'group').length === allGroups.length,
    vis.filter(g => g.kind === 'group').length + ' vs ' + allGroups.length)

  check('显式展开覆盖默认', familyOpen('web', { web: false }, false) === true)
  check('显式收起覆盖默认', familyOpen('核心', { 核心: true }, false) === false)

  // ★ 搜索/筛选时强制展开
  const forced = toolRowsVisible(all, { collapsed: { 核心: true, web: true }, forceOpen: true })
  check('★ 有搜索词/非默认筛选时一律展开（搜到了却看不见，比不搜更糟）',
    forced.filter(g => g.kind === 'row').length === allRows,
    forced.filter(g => g.kind === 'row').length + ' vs ' + allRows)

  // ★ 折叠后标题必须自己把话说完整
  check('★ 族标题带条数、token 合计、已裁计数（收起后它是唯一看得见的东西）',
    allGroups.every(g => typeof g.n === 'number' && typeof g.tokens === 'number' && typeof g.denied === 'number'
      && g.n > 0 && g.tokens > 0),
    JSON.stringify(allGroups.map(g => g.family + ':' + g.n + '/' + g.tokens + '/' + g.denied)))
  check('每族的 token 合计 = 该族成员之和',
    allGroups.every(g => g.tokens === all.filter(r => r.kind === 'row' && (r.item.family || '核心') === g.family)
      .reduce((s, r) => s + (r.item.approxTokens || 0), 0)),
    '合计对不上就说明统计的是别的族')

  // DOM 层的断言放在下面工具表渲染出来之后 —— toolHtml 在这里还没定义。
}

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
  // 受控全展开：默认全收起会让下面"每行都有 checkbox"这类断言一行都渲染不出来。
  // 这不是给测试开后门 —— 界面上有真的「全部展开 / 收起」按钮走同一条路径。
  ['工具段（全展开）', C.ToolsSection, { state, forceOpen: true }],
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
// 折叠之后，"渲染出的行数"要和 toolRowsVisible 算出的**可见**行数一致，
// 而不是和全部行数一致 —— 那两个数在默认状态下本来就不一样。
const expVisible = toolRowsVisible(toolGroups(tools, '', 'all'), { collapsed: {}, forceOpen: false })
  .filter((g) => g.kind === 'row').length
check('工具表：渲染出的数据行数 = toolRowsVisible 算出的可见行数',
  count(toolHtml, 'class="lw-tr"') === expVisible,
  'DOM ' + count(toolHtml, 'class="lw-tr"') + ' vs 期望 ' + expVisible)
check('工具表：渲染出的族标题数 = 分组数',
  count(toolHtml, 'class="lw-group"') === expGroups,
  'DOM ' + count(toolHtml, 'class="lw-group"') + ' vs 期望 ' + expGroups)
// ── 折叠在 DOM 层的断言（放在这里因为 toolHtml 刚才是未定义的）──
{
  const all = toolGroups(tools, '', 'all')
  const allGroups = all.filter(g => g.kind === 'group')
  check('★ 族标题渲染成真 <button> 且带 aria-expanded（折叠控件用 div 是常见的偷懒）',
    count(toolHtml, 'class="lw-groupbtn"') === allGroups.length
    && count(toolHtml, 'aria-expanded="false"') >= allGroups.length,
    'btn=' + count(toolHtml, 'class="lw-groupbtn"') + ' collapsed=' + count(toolHtml, 'aria-expanded="false"'))
  check('★ 默认收起时一行工具都不渲染（族标题仍在）',
    count(toolHtml, 'class="lw-tr"') === 0 && count(toolHtml, 'class="lw-group"') === allGroups.length,
    'rows=' + count(toolHtml, 'class="lw-tr"') + ' groups=' + count(toolHtml, 'class="lw-group"'))
  check('★ 收起时提示"显示 N 行"（否则人会以为工具少了）',
    /收起中，显示 \d+ 行/.test(toolHtml), (toolHtml.match(/收起中[^<]*/) || ['(无)'])[0])
  check('★ 收起时族标题仍报出条数与 token（否则收起等于什么都看不到）',
    allGroups.every(g => toolHtml.includes('>' + g.family + '<') && toolHtml.includes('>' + g.n + ' 个<')),
    '五族的条数都要在')
}

check('工具表：每个族名都出现在 HTML 里',
  ['核心', 'github', 'hindsight', 'web', 'wiki'].every((f) => toolHtml.includes('>' + f + '<')),
  ['核心', 'github', 'hindsight', 'web', 'wiki'].filter((f) => !toolHtml.includes('>' + f + '<')).join(',') || '全部命中')
check('★ 工具表：族标题里的计数与纯函数一致（不是恒显示 1）',
  toolGroups(tools, '', 'all').filter((g) => g.kind === 'group')
    .every((g) => toolHtml.includes('class="lw-group-n">' + g.n + ' 个<')),
  JSON.stringify(toolGroups(tools, '', 'all').filter((g) => g.kind === 'group').map((g) => g.n)))

// checkbox 那条断言要看**展开状态**下的渲染：默认全收起时一行都没有，
// 拿它去断言"每行都有 checkbox"等于什么都没测。
const toolOpenHtml = results['工具段（全展开）'].html
check('工具表：每行都有键盘可达的 checkbox（带 aria-label）',
  count(toolOpenHtml, 'type="checkbox"') === expRows
  && count(toolOpenHtml, 'aria-label="裁掉 ') + count(toolOpenHtml, 'aria-label="放回 ') === expRows,
  'checkbox=' + count(toolOpenHtml, 'type="checkbox"') + ' vs 期望 ' + expRows)
check('★ 全展开时行数与纯函数一致（证明折叠只是"隐藏"，没有丢行）',
  count(toolOpenHtml, 'class="lw-tr"') === expRows,
  'DOM ' + count(toolOpenHtml, 'class="lw-tr"') + ' vs 期望 ' + expRows)
check('有「全部展开 / 收起」按钮（默认全收起之后，想通览一遍的人需要一条路）',
  toolHtml.includes('全部展开 / 收起'))

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

// ── 2.5 输入框上方的待办提示条 ──
//
// 这条子要解决的是一个非技术问题：staged 固化与 .trash 分拣全靠人工，
// 而界面上没有任何东西提示"有东西在等"。所以测的重点不是"画得好不好看"，
// 而是两条**行为契约**：
//   * 没待办时**整条不出现**（常驻噪音会训练人忽略它）
//   * 有可固化页时，第一屏是「全部固化」而**不是**「确认固化」
//     —— 一键写多个文件必须先问一句，误触的代价比多一次点击大
console.log('')
console.log('── 待办提示条（输入框上方） ──')

check('待办总数：无数据算 0', pendingTotal(null) === 0)
check('待办总数：三段相加（待固化 + 回收站 + 已拒绝）',
  pendingTotal({ stagedTotal: 6, trash: 10, rejected: 2 }) === 18,
  String(pendingTotal({ stagedTotal: 6, trash: 10, rejected: 2 })))
check('待办总数：缺字段不炸', pendingTotal({ stagedTotal: 3 }) === 3)

{
  const P = M.__components.PendingBar
  check('导出了 PendingBar（否则这条子根本无法被断言）', typeof P === 'function')

  const empty = renderToStaticMarkup(h(P, { pending: { stagedTotal: 0, stagedReady: 0, trash: 0, rejected: 0, staged: [] } }))
  check('★ 没待办时整条不渲染（返回空，不是画一条 0）', empty === '', JSON.stringify(empty))

  const bar = renderToStaticMarkup(h(P, {
    pending: {
      stagedTotal: 6, stagedReady: 6, trash: 10, rejected: 2,
      staged: [{ id: 'a', ready: true }, { id: 'b', ready: true }],
    },
  }))
  check('有待办时画出来', bar.length > 0, bar.length + ' 字符')
  check('★ 条上带 lw-root —— 整套 --lw-* 变量定义在 .lw-root 上而不是 :root，',
    bar.includes('lw-root') && bar.includes('lw-pend'),
    '这一条错了整条就会是无样式裸标签（无回退值的 var() 会让声明整条失效）')
  check('数字说全了：页数与待分拣数分开报',
    bar.includes('6') && bar.includes('页待固化') && bar.includes('12') && bar.includes('个待分拣'),
    bar.replace(/<[^>]+>/g, '|').slice(0, 120))
  check('★ 第一屏是「全部固化」，且**没有**直接出现「确认固化」（一键写多文件必须先问一句）',
    bar.includes('全部固化') && !bar.includes('确认固化'),
    JSON.stringify([bar.includes('全部固化'), bar.includes('确认固化')]))
  // ★ 两个计数各自可点、各自开对应的页签。
  //   之前只有一个笼统的「处理」按固定顺序挑页签 —— 那意味着"12 个待分拣"
  //   旁边的按钮会把你送到知识页签，而那里根本没有分拣界面。
  //   数字和它点开的东西必须对得上。
  check('★ 两个计数都是可点的入口（不是纯文字）',
    count(bar, 'lw-pend-chip') === 2, 'chip=' + count(bar, 'lw-pend-chip'))
  check('两个计数分别写着各自要去的地方',
    /title="打开「知识」页签/.test(bar) && /title="打开「分拣」页签/.test(bar))
  check('用 role=status + aria-live 播报（读屏用户也该知道有东西在等）',
    bar.includes('role="status"') && bar.includes('aria-live="polite"'))

  // 没有可固化页、只有待分拣时：不该出现「全部固化」
  const onlyTriage = renderToStaticMarkup(h(P, {
    pending: { stagedTotal: 2, stagedReady: 0, trash: 3, rejected: 0, staged: [{ id: 'x', ready: false }] },
  }))
  check('★ 没有「已通过闸门」的页时不出现「全部固化」',
    !onlyTriage.includes('全部固化') && onlyTriage.includes('待分拣'),
    onlyTriage.replace(/<[^>]+>/g, '|').slice(0, 120))
}

// ── 2.6 分拣页签 ──
//
// 这一页是补一个"数字说有事、点进去没事"的死胡同：待办条写着 N 个待分拣，
// 而面板里原先根本没有能处理它们的界面。所以测的重点是**决策输入齐不齐**
// 和**不可逆操作有没有门槛**。
console.log('')
console.log('── 分拣页签 ──')

const triageFixture = [
  {
    rel: '.trash/staged-20260101-000000/x.md', id: 'trashed-x', title: '回收站里的 X',
    category: 'lesson', confidence: 0.8, sources: 3, from: '.trash', reason: null, batch: 'staged-20260101-000000',
    bytes: 1200, mtime: '2026-01-01T00:00:00.000Z', bodyChars: 500,
    excerpt: '摘录：这一页讲的是某件已经过时的事。', truncated: true,
  },
  {
    rel: '.rejected/y.md', id: 'rejected-y', title: '被拒绝的 Y',
    category: 'fact', confidence: 0.6, sources: 1, from: '.rejected',
    reason: { kind: 'REJECTED', date: '2026-09-11', text: '撞名误报，与本项目无关。' }, batch: null,
    bytes: 800, mtime: '2026-01-02T00:00:00.000Z', bodyChars: 300,
    excerpt: '摘录：撞名误报，与本项目无关。', truncated: false,
  },
]
{
  const T = M.__components.TriageTab
  check('导出了 TriageTab（否则这一页根本无法被断言）', typeof T === 'function')
  const tri = renderToStaticMarkup(h(T, { items: triageFixture }))
  check('两类的条目都画出来了', tri.includes('回收站里的 X') && tri.includes('被拒绝的 Y'))
  check('来源标签区分回收站与已拒绝', tri.includes('回收站') && tri.includes('已拒绝'))
  check('★ 每条都带摘录（不看内容无从判断"这页还要不要"）',
    tri.includes('摘录：这一页讲的是某件已经过时的事。'))
  check('★ 第一屏是「永久删除」而**不是**「确认永久删除」（不可逆操作必须两段）',
    tri.includes('永久删除') && !tri.includes('确认永久删除'),
    JSON.stringify([tri.includes('永久删除'), tri.includes('确认永久删除')]))
  check('有「恢复」入口', tri.includes('恢复'))
  check('★ 写清楚"恢复"是回到 staged 而不是直接生效（否则用户以为恢复完就参与召回了）',
    tri.includes('staged/') && tri.includes('固化闸门'))
  check('分段导航带两类的计数',
    tri.includes('全部 2') && tri.includes('回收站 1') && tri.includes('已拒绝 1'),
    tri.replace(/<[^>]+>/g, '|').slice(0, 90))
  check('空列表时给一句解释而不是一片空白',
    renderToStaticMarkup(h(T, { items: [] })).includes('没有条目'))

  // ── 原因：对应"明确标记拒绝原因 / 回收原因"那条需求 ──
  check('★ 有记录的原因要显示出来（不是让人把文件打开自己翻）',
    tri.includes('拒绝原因') && tri.includes('撞名误报，与本项目无关。') && tri.includes('2026-09-11'),
    '拒绝原因 + 日期 + 正文，三段都要在')
  check('★ 没记录原因时**如实说没记录**，绝不编一个',
    tri.includes('未记录原因'),
    '编出来的理由会被后来的人当成证据 —— 那比没有理由危险得多')
  check('★ 没记录时给出约定文档的位置（否则下一个人还是不知道该写）',
    tri.includes('.trash/README.md'))
  check('★ 两个来源的标签配色不同（语义不同；长得一样就得每次去读文字）',
    tri.includes('lw-tri-tag rej') && tri.includes('lw-tri-tag tra'))
}

// ── 3. 退化路径 ──
console.log('')
console.log('── 退化路径（原语 require 失败，界面不能整个消失） ──')
const M2 = H.build(false)
// 每个组件的 props 不同：页签吃 state，提示条吃 pending。
// ★ 之前给提示条也喂 state，于是它按"没待办"正确地渲染了空，
//   测试却报"没画出内容"—— 那是断言写错了，不是代码错了。
//   讽刺的是这条错误恰好又证明了"没待办时不渲染"是对的。
const PENDING_FIXTURE = {
  stagedTotal: 2, stagedReady: 2, trash: 1, rejected: 0,
  staged: [{ id: 'a', title: 'A', ready: true }, { id: 'b', title: 'B', ready: true }],
}
for (const [label, Component, props] of [
  ['能力页签', M2.__components.CapabilitiesTab, { state }],
  ['知识页签', M2.__components.KnowledgeTab, { state }],
  ['补料页签', M2.__components.SupplyTab, { state }],
  ['底栏入口', M2.__components.FooterEntry, { state }],
  ['待办提示条', M2.__components.PendingBar, { pending: PENDING_FIXTURE }],
  ['分拣页签', M2.__components.TriageTab, { items: triageFixture }],
]) {
  try {
    const html = renderToStaticMarkup(h(Component, props))
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

// ── 4.5 底栏入口：座位的 wide 契约 ──
console.log('')
console.log('── 底栏入口（座位 sidebar.footer.action 的 wide 契约）──')
// 座位契约原文：「Whether the sidebar renders wide content (false = 56px rail)」。
// 原先 FooterEntry 一个 props 都不接，于是侧边栏收起时它还当着"图标 + 文字"的整行宽，
// 而旁边的 cordis 单元格和下面的设置钮都收成了 36px 圆 —— 三者对不齐。
{
  const mk = (props) => renderToStaticMarkup(h(C.FooterEntry, props))
  const wideHtml = mk({ wide: true })
  const railHtml = mk({ wide: false })
  const bareHtml = mk({})            // 缺省 / 老调用点
  const bareUndef = mk(undefined)

  check('wide=true：渲染标签', wideHtml.includes('lw-fb-label') && wideHtml.includes('learn-wiki'))
  check('★ wide=false：不渲染标签（36px 圆里放不下字）', !railHtml.includes('lw-fb-label'))
  check('★ wide=false：按钮与单元格都换成轨道类名',
    railHtml.includes('lw-fb-rail') && railHtml.includes('lw-fb-cell-rail'))
  check('★ wide=false：没有可见标签，可及名必须由 aria-label 提供',
    railHtml.includes('aria-label="learn-wiki"'))
  check('wide=true：不出现轨道类名',
    !wideHtml.includes('lw-fb-cell-rail') && !wideHtml.includes('"lw-fb lw-fb-rail"'))
  check('不传 props / 传 undefined 都退化为宽态（测试与老调用点依赖这条）',
    bareHtml.includes('lw-fb-label') && bareUndef.includes('lw-fb-label'))

  // ★ 结构断言：单元格必须是**宿主那一行的直接子节点**。
  //   css 的 *:has(> .lw-fb-cell) 走 DOM 树，靠它把宿主的行改成可换行；
  //   一旦有人把单元格再包一层（比如退回 display:contents 的壳子），
  //   :has() 就选不到宿主，入口会被挤出那一行。
  check('★ 渲染根节点就是单元格本身（中间不能再套一层壳）',
    wideHtml.startsWith('<div class="lw-fb-cell') && railHtml.startsWith('<div class="lw-fb-cell'),
    '根 = ' + wideHtml.slice(0, 40))

  const css = M.__css
  check('★ CSS 里有让宿主那行换行的规则（否则第二个使用者会被挤出容器）',
    css.includes(':has(> .lw-fb-cell)') && css.includes('flex-wrap:wrap'))
  check('CSS 定义了单元格 / 按钮 / 轨道态三类度量',
    /.lw-fb-cell\{[^}]*\}/.test(css) && /\.lw-fb\{[^}]*\}/.test(css) && /\.lw-fb-rail\{[^}]*\}/.test(css))
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
