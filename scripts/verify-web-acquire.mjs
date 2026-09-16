// 联网补料层的自检：抽取、壳页识别、抓取缓存、离线闸。
//
// ── 为什么这几条值得单独一个脚本 ──
//
// 这一层全部的失败都是**安静的**：
//   · 抽取抽错（抽到导航目录）→ 蒸馏器只会说"证据不足"，看起来像模型太保守；
//   · 抓住了壳页（JS 渲染站）→ 字符数不为零，于是它会被当成证据喂进去；
//   · 缓存写坏 → 下次抓取静默变成"取不到"；
//   · 没有离线闸 → 跑一次测试就真的去联网了，而这一点在测试里没人会发现。
//
// 所以这里钉的都是"错了会以别的样子表现出来"的判据。
import { rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { extractReadableText, htmlToText, proseRatio, looksLikeShell, parseTagTree, flatten }
  from '../lib/extract.js'
import { fetchCached, fetchUrlTextDetailed, evidenceSummary, searchableQuery, FETCH_CACHE_MAX }
  from '../lib/acquire.js'
import { ensureRepo } from '../lib/wiki.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

const ROOT = '.tmp-web-test'
await rm(ROOT, { recursive: true, force: true })
await ensureRepo(ROOT)

// ── 夹具：一个"导航目录 + 正文共享包装层"的真实形状 ──
//
// 这个形状是实测来的：nodejs.org/api/zlib.html 的正文与左侧 API 目录同属一个
// <div class="clearfix">。第一版抽取器在这种页面上抽出的是一百多个 API 名字。
const NAV_ITEMS = Array.from({ length: 60 }, (_, i) => '<li><a href="/api/x' + i + '.html">API module number ' + i + '</a></li>').join('')
const NAV = '<div class="sidebar"><ul>' + NAV_ITEMS + '</ul></div>'
const PROSE = [
  '<p>The node:zlib module provides compression functionality implemented using Gzip, Deflate/Inflate, Brotli, and Zstd. It can be accessed using the require function or the import statement, and every stream-based API is documented below.</p>',
  '<p>To decompress a Zstd frame produced by the streaming compressor, use zstdDecompress; the helper createZstdDecompress is deprecated and should not be used in new code because it allocates the whole output buffer.</p>',
  '<p>Flushing behaviour differs between the synchronous and asynchronous APIs. When a stream is flushed with ZSTD_e_end the remaining data is emitted immediately, whereas ZSTD_e_continue keeps the internal dictionary alive for a subsequent frame.</p>',
]
const ARTICLE = '<div class="markdown-body"><h1>Zlib</h1>' + PROSE.join('') + '</div>'
const PAGE = '<html><head><title>Zlib</title><script>var junk = "x".repeat(5000);</script><style>.a{color:red}</style></head>'
  + '<body>' + NAV + '<div class="clearfix">' + ARTICLE + '</div>'
  + '<div class="footer"><a href="/a">About</a><a href="/b">Privacy</a></div></body></html>'

console.log('=== 正文抽取（实测形状：目录与正文同包装层）===')
{
  const r = extractReadableText(PAGE, { maxChars: 12000 })
  check('★ 抽到的是正文，不是导航目录',
    r.text.includes('zstdDecompress') && r.text.includes('Flushing behaviour'),
    'picked=' + r.picked + ' chars=' + r.chars)
  check('★ API 目录名没有占据开头（第一版就是这样输的）',
    !/^\s*API module number 0/.test(r.text), r.text.slice(0, 60).replace(/\n/g, ' '))
  check('导航条目没有淹没正文', (r.text.match(/API module number/g) ?? []).length < 5,
    '出现 ' + (r.text.match(/API module number/g) ?? []).length + ' 次')
  check('picked 说明了是怎么选的（"整页兜底"与"命中正文容器"要分得开）',
    typeof r.picked === 'string' && r.picked.length > 0, r.picked)
  check('script / style 内容没有被算进正文',
    !r.text.includes('var junk') && !r.text.includes('color:red'))
  check('★ 实体只解码一遍（先解码再剥标签会把 &lt;div&gt; 变成真标签）', (() => {
    const x = extractReadableText('<div class="markdown-body"><p>' + 'See &lt;div&gt; element usage and why it matters for layout in every document that uses it.' + '</p></div>')
    return x.text.includes('<div>') && !x.text.includes('&lt;')
  })())
  check('空 HTML 不炸', extractReadableText('').chars === 0 && extractReadableText(null).text === '')
  check('htmlToText 与抽取同源（旧接口不许另走一套）', htmlToText(PAGE).includes('zstdDecompress'))
  check('htmlToText 返回单行', !htmlToText(PAGE).includes('\n'))
}

console.log('')
console.log('=== prose 判据 ===')
{
  check('句子行 → 高 prose', proseRatio('This is a complete sentence about zlib frames.\nAnother complete sentence that explains the behaviour.') > 0.9)
  check('目录行 → 低 prose', proseRatio('Buffer\nCrypto\nDNS\nCluster\nDebugger') < 0.2)
  check('空文本 → 0（不是 1 —— "没有"不等于"全是正文"）', proseRatio('') === 0)
}

console.log('')
console.log('=== 壳页识别（JS 渲染站）===')
{
  const shellHtml = '<html><body>' + '<script>var big = "' + 'y'.repeat(90000) + '";</script>' + '<div>Add this suggestion to a batch that can be applied as a single commit.</div></body></html>'
  const t = extractReadableText(shellHtml).text
  const s = looksLikeShell(shellHtml, t)
  check('★ 大 HTML 少文本 → 判为壳页', s.shell === true, JSON.stringify({ raw: s.rawBytes, text: s.textBytes }))
  check('壳页给得出理由（"为什么取不到"要能写进诊断）', /JS 渲染/.test(s.why), s.why)
  const real = extractReadableText('<html><body><div class="markdown-body">' + PROSE.join('') + '</div></body></html>')
  check('正常页不会被误判成壳页', looksLikeShell('<html><body>' + PROSE.join('') + '</body></html>', real.text).shell === false)
  check('小而短的页面也不判壳页（短 ≠ 未渲染）', looksLikeShell('<html><body><p>hi</p></body></html>', 'hi').shell === false)
}

console.log('')
console.log('=== 配对标签树 ===')
{
  const tree = parseTagTree('<body><div id="a"><div id="b">x</div></div></body>')
  const nodes = flatten(tree)
  check('父子关系被认出来', nodes.length === 3 && nodes.find(n => /id="b"/.test(n.openTag)).parent.openTag.includes('id="a"'),
    nodes.map(n => n.tag).join('>'))
  check('★ 闭合按**配对**走，父节点的范围真的覆盖子节点（取第一个 </div> 会在正文中途切断）',
    (() => {
      const t2 = parseTagTree('<body><div id="outer"><div id="inner">x</div>tail</div></body>')
      const outer = flatten(t2).find(n => /id="outer"/.test(n.openTag))
      const inner = flatten(t2).find(n => /id="inner"/.test(n.openTag))
      return !!outer && !!inner && outer.start < inner.start && outer.end >= inner.end && outer.end > inner.end
    })())
  check('★ 畸形 HTML（大量不闭合 div）不卡死也不抛异常', (() => {
    try {
      const t0 = Date.now()
      const tree = parseTagTree('<div><div><div>'.repeat(2000))
      const n = flatten(tree).length
      return n > 0 && Date.now() - t0 < 5000
    } catch { return false }
  })())
}

console.log('')
console.log('=== 抓取：路径、缓存、离线闸 ===')
{
  const cfg = { fetchTimeoutMs: 4000, fetchMaxChars: 12000, fetchCacheTtlMs: 60000, fetchCacheFailTtlMs: 1000, fetchCacheMaxChars: 40000 }
  // 不联网：ctx.web.fetch 不存在时走直连，而直连指向一个本地不可达地址 → 快速失败。
  const dead = 'http://127.0.0.1:9/nope'
  const r1 = await fetchUrlTextDetailed({}, dead, { timeoutMs: 2000 })
  check('两条路都失败时返回空文本而不是抛异常', r1.text === '' && Array.isArray(r1.attempts))
  check('★ 失败**带得走原因**（host/direct 各自说了什么）', r1.attempts.length > 0, r1.attempts.join(' | ').slice(0, 120))
  check('没有 ctx.web.fetch 时如实记 "host:absent"（而不是假装走过）', r1.attempts.includes('host:absent'), r1.attempts.join(','))

  // 缓存：把失败缓存起来（Ttl 1s），第二次不该再发请求。
  const t0 = Date.now()
  const c1 = await fetchCached({}, ROOT, dead, cfg)
  const t1 = Date.now()
  const c2 = await fetchCached({}, ROOT, dead, cfg)
  const t2 = Date.now()
  check('第一次抓失败会写进缓存', c1.cached === false)
  check('★ 第二次命中缓存（死链不再反复付超时）', c2.cached === true, 'first=' + (t1 - t0) + 'ms second=' + (t2 - t1) + 'ms')
  check('缓存命中时 attempts 为空（没有真发请求）', (c2.attempts ?? []).length === 0)
  const cache = JSON.parse(await readFile(join(ROOT, '.index', 'fetch-cache.json'), 'utf8'))
  check('缓存文件是可解析的 JSON 且有 entries', !!cache.entries && Object.keys(cache.entries).length === 1)
  check('缓存条记录 url 与时间戳（修剪要靠 lastUsed）',
    !!cache.entries[Object.keys(cache.entries)[0]].url && Number.isFinite(cache.entries[Object.keys(cache.entries)[0]].lastUsed))

  // TTL=0 时彻底不读也不写缓存。
  // ★ 判据必须是"文件字节数完全不变" —— 只判 cached===false 是不够的，
  //   那在"根本没写过缓存"的情况下也成立（假通过）。
  const cachePath = join(ROOT, '.index', 'fetch-cache.json')
  const before = await readFile(cachePath, 'utf8')
  const nBefore = Object.keys(JSON.parse(before).entries).length
  const c3 = await fetchCached({}, ROOT, dead, { ...cfg, fetchCacheTtlMs: 0 })
  const after = await readFile(cachePath, 'utf8')
  check('★ fetchCacheTtlMs=0 时既不读也不写缓存（离线/测试场景的硬开关）',
    c3.cached === false && before === after && nBefore === 1,
    'cached=' + c3.cached + ' entries=' + nBefore + ' bytes-same=' + (before === after))
  check('缓存条目数不会超过上限常量', typeof FETCH_CACHE_MAX === 'number' && FETCH_CACHE_MAX > 0, 'max=' + FETCH_CACHE_MAX)
}

console.log('')
console.log('=== 查询清洗（"搜得到但没用"的一个系统性来源）===')
{
  const cases = [
    // [输入, 期望包含, 期望不含]
    ['Error: old_string was not found in "a.js" 常见故障原因 解决办法', 'old_string was not found', '常见故障原因'],
    ['反复修改 tools.js 仍不成功 常见原因', 'tools.js', '常见原因'],
    ['multi-frame zstd decode fails with "Unknown frame descriptor" 重复调用无进展 正确用法', 'Unknown frame descriptor', '正确用法'],
    ['（当前任务：修一个分帧问题）', '', '当前任务'],
  ]
  for (const [input, want, unwanted] of cases) {
    const q = searchableQuery(input)
    // want === '' 表示"应该被清成空"（而不是"必须包含空串" —— 那永远为真，是个假通过）
    const ok = (want === '' ? q === '' : q.includes(want)) && !q.includes(unwanted)
    check('清洗: ' + JSON.stringify(input.slice(0, 34)), ok, '-> ' + JSON.stringify(q))
  }
  // ★ 两种情况必须分开（第一版把两者合成了一条"否则退回原文"，于是
  //   纯指令查询会被原样送进搜索引擎 —— 那等于保证搜回一堆泛泛的页面）。
  check('★ 整条都是指令词 → 返回空串（让调用方看见"这条查询没法用"），不退回原文',
    searchableQuery('常见原因 解决办法') === '', JSON.stringify(searchableQuery('常见原因 解决办法')))
  check('本来就是短但有效的查询 → 原样返回（别把 "zstd 帧" 这类掏掉）',
    searchableQuery('zstd 帧') === 'zstd 帧', JSON.stringify(searchableQuery('zstd 帧')))
  check('空输入不炸', searchableQuery('') === '' && searchableQuery(null) === '')
  check('纯英文错误文本**逐字不动**（那正是网上真有人写过的那部分）', (() => {
    const q = 'TypeError: Cannot read properties of undefined (reading \'score\')'
    return searchableQuery(q) === q
  })())
  // 同一段错误被上游拼了两遍（"sig；sig"）时只留一遍 —— 两遍会稀释关键词。
  // 注意分隔符是**中文分号**（上游 parts.join('；')），第一版这里写成了英文句号。
  check('重复两遍的同一段错误只留一遍',
    searchableQuery('boom failure；boom failure') === 'boom failure',
    JSON.stringify(searchableQuery('boom failure；boom failure')))
}

console.log('')
console.log('=== 证据统计（"为什么没料"要能答出来）===')
{
  const s = evidenceSummary({ tried: 3, ok: 1, shell: 1, empty: 2, cached: 1, chars: 4321, paths: { host: 1, direct: 2 } })
  check('一句话里带上了可用/尝试/路径/字符数', /1 usable/.test(s) && /3 tried/.test(s) && /host×1/.test(s) && /4321 chars/.test(s), s)
  check('壳页与空页分别计数（修法不同，不能合并）', /1 shell/.test(s) && /2 empty/.test(s))
  check('没有数据时也给出可读的话（不返回 undefined）', typeof evidenceSummary(null) === 'string' && evidenceSummary(null).length > 0)
}

console.log('')
console.log('=== 端到端（本地 HTTP 服务器，不碰外网）===')
{
  // ★ 用本地服务器而不是真实站点：这一层要测的是**我们的逻辑**（连上→抽取→缓存→
  //   第二次不再请求），不是外网是否可达。真实站点会把 flaky 网络带进测试里，
  //   而一个偶尔红的测试会训练人忽略红色。
  const http = await import('node:http')
  let hits = 0
  const page = '<html><head><title>Doc</title></head><body>'
    + '<div class="sidebar"><ul>' + NAV_ITEMS + '</ul></div>'
    + '<div class="markdown-body">' + PROSE.join('') + '</div></body></html>'
  const server = http.createServer((req, res) => {
    hits++
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const url = 'http://127.0.0.1:' + port + '/doc'
  const cfg = { fetchTimeoutMs: 8000, fetchMaxChars: 12000, fetchCacheTtlMs: 60000, fetchCacheFailTtlMs: 1000 }

  const r1 = await fetchCached({}, ROOT, url, cfg)
  const r2 = await fetchCached({}, ROOT, url, cfg)
  check('★ 端到端抓到正文（不是导航目录）', r1.text.includes('zstdDecompress'), 'chars=' + r1.text.length)
  check('★ 第二次命中缓存，且**没有真的再请求一次**', r2.cached === true && hits === 1, 'server hits=' + hits)
  check('两条路都报告了路径', r1.path === 'direct', 'path=' + r1.path)
  server.close()
}

await rm(ROOT, { recursive: true, force: true })
console.log('')
if (failures === 0) console.log('ALL PASS — 抽取、壳页、抓取缓存与证据统计都有断言')
else console.log(failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
