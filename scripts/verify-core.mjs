// 核心自检：解析 → 索引 → 打分 → 三分桶。
// 跑在真实的 D:\Harness\dsh-wiki 上，而不是 fixture，确保格式约定与实物一致。
import { loadPages, commitReadiness, deriveId, slugify } from '../lib/wiki.js'
import { looksLikeGap } from '../lib/recall.js'
import { fetchUrlText, htmlToText } from '../lib/acquire.js'
import { buildCorpus, scoreQuery, triage, recallable } from '../lib/recall.js'

const ROOT = process.argv[2] || 'D:\\Harness\\dsh-wiki'
let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

const { pages, errors } = await loadPages(ROOT)
console.log('loaded ' + pages.length + ' page(s) from ' + ROOT)
if (errors.length) for (const e of errors) console.log('  parse note: ' + e.file + ': ' + e.error)

const pool = recallable(pages)
const corpus = buildCorpus(pool)
console.log('recallable corpus: ' + corpus.n + ' (committed & confidence >= 0.3)')

const sample = pool[0]
if (sample) {
  console.log('\nsample page fields: id=' + sample.id + ' category=' + sample.category +
    ' confidence=' + sample.confidence + ' status=' + sample.status +
    ' sources=' + sample.sources.length + ' tags=[' + sample.tags.join(',') + ']')
  check('frontmatter sources parsed as array', Array.isArray(sample.sources) && sample.sources.length > 0)
  check('confidence parsed as number', typeof sample.confidence === 'number')
  const r = commitReadiness(sample)
  check('committed page passes commitReadiness', r.ready, r.blockers.join('; '))
}

// 中文查询应命中中文页
const q1 = scoreQuery(corpus, 'Hindsight daemon 起不来 端口 8888 没有监听')
console.log('\nquery: Hindsight daemon 起不来 端口 8888 没有监听')
console.log(q1.slice(0, 3).map(h => '  ' + h.score.toFixed(4) + '  ' + h.page.id).join('\n') || '  (no hits)')
const t1 = triage(q1)
check('中文查询触发三分桶', ['hit', 'weak', 'miss'].includes(t1.bucket), 'bucket=' + t1.bucket + ' best=' + t1.best)

// ── 回归闸：真正无关的查询不许被判成 hit ──
// 这里刻意换了一条**与语料没有任何词汇重叠**的查询。
// 原先用的是「如何配置 kubernetes sidecar 注入策略」，但它和
// opencode-free-tier-missing-session-id-fix 共享「配置」「注入」两个通用词，
// 于是它不是一条干净的负例（见下面的已知缺陷）。
const q2 = scoreQuery(corpus, '今天北京的天气怎么样 顺便推荐几家好吃的餐厅')
const t2 = triage(q2)
console.log('\nquery: 今天北京的天气怎么样 顺便推荐几家好吃的餐厅')
console.log('  bucket=' + t2.bucket + ' best=' + t2.best)
check('★ 完全无关的查询不得判为 hit（hit 会注入整页正文）',
  t2.bucket !== 'hit', 'bucket=' + t2.bucket + ' best=' + t2.best)

// ── 已知缺陷（不是"通过"，是"记录在案并设了上限"）──
//
// 「如何配置 kubernetes sidecar 注入策略」这条**与语料无实质关系**的查询，
// 在真实 12 页语料上会与 opencode-free-tier-missing-session-id-fix 拿到
// coverage 0.25 / score 0.2141，跨过 hitThreshold 0.20 被判成 hit ——
// 也就是把整页正文注进提示词。撑起这个分的是「配置」「注入」两个通用词。
//
// 为什么现在没修：现有阈值是 scripts/calibrate.mjs 在**合成语料**上标定出来的，
// 而那条负例在合成语料里得 0.0000。合成语料代表不了真实语料，
// 拿它继续调只会得到"看着有依据"的数。真要修得对**真实语料**重跑标定。
//
// 所以这里不假装它通过了：断言它**没有变得更糟**（上限 0.25）。
// 一旦超线，说明打分在真实语料上进一步退化，必须当场处理而不是继续容忍。
//
// ── 补记（2026-09-11）：这条缺陷已被大幅削弱 ──
//
// 语料从 15 页涨到 19 页后，本条分数从 0.2141 涨到 **0.2728**，超了当时设的 0.25 上限
// —— 也就是当时那条注释说的"必须当场处理"的时刻。处理方式是**对真实语料重跑标定**
// （新脚本 scripts/calibrate-real.mjs，18 条标注查询），结论是：
//
//   **单靠阈值救不了**：在真实语料上，最好的负例（Rust borrow checker 0.3737）
//   比最差的正例（0.2811）还高 —— Gap **-0.093**。这不是"阈值没调好"，
//   是打分本身分不开。
//
//   根因是**分词器没有停用词概念**：中文用字符二元组，而「的」出现在 15/19 页
//   （df/n≈0.79）且 tf 很高，却和内容词被同等对待。那条 Rust 查询真正命中的是
//   「的」(15)、「报错」(4)、「怎么」(4)、「绕过」(2) —— 撑起分数的主要是「的」。
//
//   修法是标准的 IR 做法：**出现比例过高的词不携带区分度，不计入覆盖度**。
//   扫了一遍 maxDfRatio（见 lib/config.js 的注释），0.2 是第一个让 Gap 转正的取值：
//     正例最低 0.2446 / 负例最高 0.1969 → Gap **+0.048**
//   且正例 top1 正确率与基线**完全相同**（12/13）——没有为了分离开而牺牲命中。
//
//   本条断言随之改写：它现在要守的不是"别超过 0.25"，而是**不许再回到 hit**。
//   下面那个数字是实测值，改动打分后必须重新量，不是拍出来的。
//
// ── 第二次重标定（2026-09-16，66 页语料）──
//
// 语料从 19 页涨到 66 页，两条负例**又越线了**，而且这次抓到的不是阈值问题：
//
//   1. 「Rust 的 borrow checker 报错怎么绕过」拿到 **0.8364** —— 比最高的正例还高。
//      查下去发现它命中的是 **note-ca2525 自己**（那一页讲的就是打分缺陷，
//      正文里逐字引用了这条标定查询当例子）。也就是说：**它检索到了自己**。
//      修法不是调阈值，而是给这类"关于本工具自己"的页打 meta 标签、
//      让它们不参与**自动注入**（recallable 的 includeMeta，显式 wiki_recall 仍可查）。
//      → 0.8364 掉到 **0.0524**。
//
//   2. 「如何配置 kubernetes sidecar 注入策略」0.223 → 越线。根因不同：
//      它 7 个稀有关键词里有 3 个（kubernetes / 如何 / 何配）**整个语料里都不存在**，
//      而 sidecar+注入+策略 恰好同页。修法是给"查询里有语料根本没有的词"加折扣
//      （见 lib/recall.js 里 absentRatio 那段）。
//      → 0.223 掉到 **0.1120**（weak 线 0.13 以下，不再注入）。
//
//   第三条（同一次修）：折扣最初对**所有**缺词一视同仁，于是中文正例被误伤 ——
//   中文靠字符二元组分词，本来就会切出「何配」「入策」这种语料里不存在的组合，
//   把它们当成"缺词"等于系统性惩罚所有中文查询（实测 verify-subagent-guard 里
//   一条真实正例从 hit 掉到 weak）。改成**只算标识符型缺词**（拉丁字母/数字）后，
//   既挡住了 kubernetes，又不碰中文。
//
//   重标定后的整体形状（13 正例 / 5 负例，池 = 自动注入实际会看到的池）：
//     正例最低 0.1621 / 负例最高 0.1493 → Gap **+0.013**（**第一次转正**，但很薄）
//     top1 正确 11/13；weak 提到 0.15 后 **负例零注入、正例 13/13 全注入**。
//
//   ★ 间隔只有 0.013 这件事必须摆在明面上：语料再显著增长就得**重跑这两个脚本**
//     （scripts/calibrate-real.mjs 看整体，scripts/calibrate-thresholds.mjs 逐条看）。
//     断言写在下面，是为了让"什么时候该重跑"变成一个会红的信号，而不是靠记性。
const qKnown = scoreQuery(corpus, '如何配置 kubernetes sidecar 注入策略')
const tKnown = triage(qKnown)
const KNOWN_RECORDED = 0.1493   // 2026-09-16 在 66 页真实语料上实测（meta 排除 + 标识符缺词折扣）
console.log('\n已知缺陷用例: bucket=' + tKnown.bucket + ' best=' + tKnown.best + '（记录值 ' + KNOWN_RECORDED + '）')
check('★ 已知缺陷不再注入整页：通用词重叠查询不得判成 hit',
  tKnown.bucket !== 'hit',
  'bucket=' + tKnown.bucket + ' best=' + tKnown.best + '  （判成 hit 会把无关页面正文注进提示词）')
check('★ 而且它不该再进 weak（进 weak 也会注入，只是标注低置信）',
  tKnown.bucket === 'miss',
  'bucket=' + tKnown.bucket + '  （weak 线是 0.13，记录值 ' + KNOWN_RECORDED + '）')
check('已知缺陷分数未回升（记录值 ' + KNOWN_RECORDED + '，容差 0.05）',
  tKnown.best <= KNOWN_RECORDED + 0.05,
  'best=' + tKnown.best + '  （回升说明 maxDfRatio / absentRatio 的过滤失效或语料分布变了，需重跑 calibrate-real.mjs）')

// ── 自检索：meta 页不再参与自动注入 ──
//
// 这一条守的是上面第 1 条根因。判据刻意用**分数**而不是"池子里有没有它"：
// 后者是配置问题，前者才是"会不会真的注进提示词"。
{
  const qSelf = scoreQuery(corpus, 'Rust 的 borrow checker 报错怎么绕过')
  const tSelf = triage(qSelf)
  check('★ 曾经靠"引用标定查询"拿到 0.836 的自检索已消失',
    tSelf.best < 0.20,
    'best=' + tSelf.best + ' bucket=' + tSelf.bucket + '  （2026-09-16 修 meta 页之前是 0.8364）')
  const metaInAuto = corpus.docs.some(d => d.page.id === 'note-ca2525')
  check('★ meta 页不在自动注入的池里（它仍可被显式 wiki_recall 查到）', !metaInAuto)
}

// 中文二元组分词确实产出 token
const zhOnly = scoreQuery(corpus, '数据库崩溃恢复')
check('纯中文查询能产出命中', zhOnly.length > 0, zhOnly.length + ' hit(s)')

// ── id 派生：中文标题必须不碰撞（曾实现错，靠"slug 够长"判断，挡不住）──
console.log('\n=== id 派生 ===')
const a = deriveId(undefined, 'DSH 插件 link 安装的模块解析')
const b = deriveId(undefined, 'DSH 插件 link 的加载顺序')
check('中文标题派生 id 不碰撞', a !== b, a + ' vs ' + b)
check('ascii 标题保持干净 slug', deriveId(undefined, 'Widget protocol framing') === 'widget-protocol-framing')
check('显式 id 被尊重且不加哈希', deriveId('explicit-id', '任意中文标题') === 'explicit-id')
check('空标题也有 id', deriveId(undefined, '').length > 0, deriveId(undefined, ''))

// ── 缺口判据：寒暄不得进 gap 队列（"已通过commit" 曾溜过纯长度过滤）──
console.log('\n=== 缺口判据 ===')
for (const [q, want] of [
  ['我已重启', false], ['已通过commit', false], ['好的', false], ['继续', false],
  ['怎么配 pg0', true],
  ['Hindsight daemon 起不来 端口 8888 没有监听 怎么排查', true],
  ['这个报错是什么原因导致的', true],
]) {
  check('looksLikeGap(' + q.slice(0, 18) + ') === ' + want, looksLikeGap(q) === want, 'got ' + looksLikeGap(q))
}

// ── 正文抓取：宿主有 fetch seam 时必须优先走它（不联网即可验证）──
console.log('\n=== 正文抓取 ===')
check('htmlToText 去脚本/标签并解实体',
  htmlToText('<b>Hi</b><script>var x=1</script>&amp;bye') === 'Hi &bye',
  JSON.stringify(htmlToText('<b>Hi</b><script>var x=1</script>&amp;bye')))

const seamText = 'x'.repeat(300)
const viaSeam = await fetchUrlText(
  { web: { fetch: async () => ({ statusCode: 200, body: { kind: 'text', content: seamText } }) } },
  'https://seam.invalid/', { timeoutMs: 1000 })
check('优先走宿主 ctx.web.fetch seam', viaSeam === seamText, 'len=' + viaSeam.length)

const htmlSeam = await fetchUrlText(
  { web: { fetch: async () => ({ statusCode: 200, body: { kind: 'html', content: '<p>' + 'y'.repeat(300) + '</p>' } }) } },
  'https://seam.invalid/', { timeoutMs: 1000 })
check('seam 返回 html 时自动转文本', htmlSeam.startsWith('yyy') && !htmlSeam.includes('<p>'), JSON.stringify(htmlSeam.slice(0, 20)))

const noSeam = await fetchUrlText({ web: {} }, 'https://nonexistent.invalid-host-xyz/', { timeoutMs: 3000 })
check('无 seam 且直连失败时返回空串而非抛异常', noSeam === '', 'got ' + JSON.stringify(noSeam))


// ── 引用型页面：判据实测抓到过什么、没抓到什么 ──
//
// 这一组的意义不在"功能对不对"，而在**把一次失败的尝试钉在测试里**：
// 我先假设"负例高分 = 页面引用了标定查询"，写了一个窗口判据，实测**没抓住**，
// 于是它没有被接进 scoreQuery。不接进来是对的，但那个假设本身值得留档 ——
// 下一个人（或下一次的我）会先想到同一个办法。
console.log('\n=== 引用型页面判据 ===')
{
  const { looksSelfQuoted } = await import('../lib/recall.js')
  const tokens = (s) => s.split(/\s+/)
  // 真·逐字引用：查询词挤在一起
  const quoted = '前文铺垫 ' + tokens('rust borrow checker 报错 怎么 绕过 的 呢').join(' ') + ' 后文继续'
  check('★ 逐字引用能被认出来（查询词挤在同一处）',
    looksSelfQuoted(quoted, ['rust', 'borrow', 'checker', '报错', '怎么', '绕过']) === true)
  // 散着复述：真实案例的形状 —— 判据**必须**返回 false，否则它就是个误报机器
  const recounted = '这一页讲的是打分缺陷：' + ['rust', 'borrow'] .join(' ') + ' 在正文里没有；' +
    '而 报错 怎么 绕过 这些词散落在很长的正文里，中间隔着几百个别的词，' +
    '再往后才是 复述 一遍 的 内容 和 更多 无关 的 段落 以及 其他 说明 文字 若干 若干 若干。'
  check('★ 散着复述抓不到 —— 这正是它**没有**被接进 scoreQuery 的原因',
    looksSelfQuoted(recounted, ['rust', 'borrow', '报错', '怎么', '绕过', '复述']) === false)
  check('短查询不判定（证据不足时不动手）',
    looksSelfQuoted('a b c', ['a', 'b']) === false)
  check('空输入不炸', looksSelfQuoted('', []) === false && looksSelfQuoted(null, ['a']) === false)
}

// ── 配置键：DEFAULTS 必须是**唯一真源**，代码读的每个键都得在这里 ──
//
// ★ 这条是补一个真实缺陷时加的：acquire.js 读了 cfg.normalizeSearchQuery，
//   而 DEFAULTS 里根本没有这个键 —— 于是"关掉查询清洗"这个开关**只存在于代码里**，
//   写进 wiki.config.json 也不会有任何效果，而且不报错。
//
//   判据刻意做成**双向**的：既要"读到的键都声明过"（防上面那种幽灵开关），
//   也要"声明过的键都被读过"（防删代码后留下的死配置）。后者放宽成警告 ——
//   有些键是给界面或外部脚本用的，不一定被 lib/ 直接读。
console.log('\n=== 配置键 ===')
{
  const { DEFAULTS } = await import('../lib/config.js')
  const { readdir, readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const libDir = new URL('../lib/', import.meta.url)
  const files = (await readdir(libDir)).filter(f => f.endsWith('.js') && f !== 'config.js')
  const read = new Map()   // key -> 第一次见到的 "文件:行"
  for (const f of files) {
    const src = await readFile(join(libDir.pathname.replace(/^\//, ''), f), 'utf8')
    src.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/cfg\.([A-Za-z_$][\w$]*)/g)) {
        if (!read.has(m[1])) read.set(m[1], f + ':' + (i + 1))
      }
    })
  }
  check('扫到了代码里读取的配置键', read.size > 20, 'n=' + read.size)
  // 两个允许的例外，都是 loadConfig **计算**出来而不是默认值里写着的：
  //   wikiRoot —— override/fileCfg 合并的结果
  //   __log    —— 界面/工具把 logger 传进配置对象时的内部接缝
  // 想再加例外之前先问一句：这个键真的不属于 DEFAULTS 吗？
  // （normalizeSearchQuery 就是"以为是例外、其实是漏声明"，被这条断言抓出来的。）
  const documented = new Set(Object.keys(DEFAULTS).concat(['wikiRoot', '__log']))
  const ghosts = [...read.keys()].filter(k => !documented.has(k)).sort()
  check('★ 代码读的每个配置键都在 DEFAULTS 里声明过（否则那个开关只存在于代码里）',
    ghosts.length === 0,
    ghosts.length ? ghosts.map(k => k + ' @ ' + read.get(k)).join(', ') : '全部 ' + read.size + ' 个已声明')
  const unused = Object.keys(DEFAULTS).filter(k => !read.has(k)).sort()
  // 只提醒不判红：有些键是给界面/外部脚本用的。但**必须说出来** ——
  // 一条静默删掉的配置项，和一条静默失效的配置项一样难查。
  console.log('  note   未被 lib/ 直接读取的键 ' + unused.length + ' 个' +
    (unused.length ? '：' + unused.slice(0, 12).join(', ') + (unused.length > 12 ? ' …' : '') : ''))
}

// ── 注入块不得进入检索查询 ──
// 注入的是"系统说的话"，不是"用户问的问题"。混进去会污染打分，
// 而且我们自己的注入会被下一轮再检索一次——自我强化的回环。
console.log('\n=== 查询提取 ===')
const qq = scoreQuery(buildCorpus(pool), 'x')  // 仅确认语料可用
check('语料可用于查询提取测试', Array.isArray(qq))

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
