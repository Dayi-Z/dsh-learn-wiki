// UI 数据接口自检：跑的必须是**真实 wiki**，否则测不到真实的页面/证据形状。
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

const ROOT = process.argv[2] || 'D:/Harness/dsh-wiki'
let route = null

const ctxLike = {
  tools: { register: () => () => {}, schemas: () => [{ name: 'read', description: 'Read a file' }] },
  llm: { listProviders: () => [{ id: 'm' }], listModels: async () => [{ id: 'm' }], stream: async function* () {} },
  web: { search: async () => ({ sources: [] }) },
  webServer: { register: (r) => { route = r; return () => {} } },
  on: () => () => {},
  effect: (fn) => fn(),
  inject: (s, cb) => cb({ systemPrompt: { section: () => {} } }),
}

const mod = await import('../index.js')
mod.apply(ctxLike, { wikiRoot: ROOT })

check('声明了 webServer 依赖', mod.inject.includes('webServer'), JSON.stringify(mod.inject))
// ★ 这条断言是补上来的：曾经注册成 kind:'exact' + '/learn-wiki/api/state'，
// 于是 /api/page 根本进不到 handler，前端拿到 404 HTML 才炸出 JSON 解析错误。
// 旧测试直接调 route.handler，绕过了路由匹配，所以完全测不出来——
// 又一次印证：自建的测试替身永远比真实边界松。
check('★ 路由用 prefix 注册（否则 /api/page 根本到不了 handler）',
  route !== null && route.kind === 'prefix' && route.path === '/learn-wiki',
  JSON.stringify(route && { kind: route.kind, path: route.path }))

// ★ 光断言 kind/path 的**值**还不够——紧接着就又栽了一次：
// path 写成 '/learn-wiki/'（多个尾斜杠），kind 和 path 看上去都对，
// 但宿主的匹配规则是
//     if (pathname !== prefix && !pathname.startsWith(prefix + '/')) continue
// （照抄 dsh-host-webserver/lib/index.js:199），它拿 prefix 和 prefix+'/' 去比，
// 于是 '/learn-wiki/' 会去找 '/learn-wiki//api/state' —— 永远不匹配。
// 请求落到 SPA 兜底路由，前端拿到 index.html，而且是 **HTTP 200**，
// 比 404 更难查（状态码是成功的，只有 content-type 露馅）。
//
// 所以这里照抄真实匹配规则，逐条验证**每条 API 路径都进得来**。
const matchesPrefix = (prefix, pathname) => pathname === prefix || pathname.startsWith(prefix + '/')
const API_PATHS = [
  '/learn-wiki/api/state', '/learn-wiki/api/page',
  '/learn-wiki/api/commit', '/learn-wiki/api/capabilities',
  '/learn-wiki/api/pending', '/learn-wiki/api/triage',
  // 模型目录是**单独一条**端点而不是并进 /api/state：列 provider/模型可能打网络，
  // 而 /api/state 每 8 秒被轮询一次。新加一条路径就得来这里加一行 —— 这条断言
  // 存在的意义正是"漏注册就红"。
  '/learn-wiki/api/models', '/learn-wiki/api/llm', '/learn-wiki/api/harvest',
]
const regd = route && route.kind === 'prefix' ? route.path : null
const unmatched = API_PATHS.filter(p => !(regd !== null && matchesPrefix(regd, p)))
check('★ 按宿主的真实匹配规则，每条 API 路径都可达',
  unmatched.length === 0, 'prefix=' + JSON.stringify(regd) + ' 匹配不上的: ' + JSON.stringify(unmatched))

// 造一个假的 req/res 来调用 handler
function call(pathname) {
  return new Promise((resolve) => {
    let code = 0, body = ''
    const res = {
      writeHead: (c) => { code = c },
      end: (b) => { body = b; resolve({ code, body }) },
    }
    route.handler({ url: pathname, method: 'GET' }, res)
  })
}

const ok = await call('/learn-wiki/api/state')
check('返回 200', ok.code === 200, 'code=' + ok.code + (ok.code !== 200 ? '  body=' + String(ok.body).slice(0, 300) : ''))

let payload = null
try { payload = JSON.parse(ok.body) } catch (e) { check('响应是合法 JSON', false, e.message) }
if (payload) {
  check('响应是合法 JSON', true)
  check('ok=true', payload.ok === true)
  check('含 app.wikiRoot', typeof payload.app?.wikiRoot === 'string', payload.app?.wikiRoot)
  check('含 capabilities 段', !!payload.capabilities, Object.keys(payload.capabilities || {}).join(','))
  check('含 knowledge 段', !!payload.knowledge, Object.keys(payload.knowledge || {}).join(','))
  check('含 gaps 段', !!payload.gaps)
  check('含 struggles 段', !!payload.struggles)
  check('含 skills 段', !!payload.skills, Object.keys(payload.skills || {}).join(','))
  check('含 llm 段（模式 + 站点清单 + 上次实际用了谁）',
    !!payload.llm && typeof payload.llm.mode === 'string'
    && Array.isArray(payload.llm.siteList) && payload.llm.siteList.length >= 2,
    JSON.stringify({ mode: payload.llm?.mode, sites: (payload.llm?.siteList || []).map(s => s.id) }))
  check('★ llm 段里**不含** provider/model 目录（那条路径每 8 秒轮询一次，不能顺手列模型）',
    payload.llm && payload.llm.providers === undefined,
    Object.keys(payload.llm || {}).join(','))
  check('★ 读不到技能注册表时如实报告，而不是假装是空的',
    payload.skills?.available === false && typeof payload.skills?.reason === 'string',
    'available=' + payload.skills?.available + ' reason=' + payload.skills?.reason)
  // 工具目录要能直接喂给界面：每个工具都得有「用途」和「族」。
  // 没有这两样，那一页就只剩一串光秃秃的名字——用户看不出它是干什么的。
  const capItems = payload.capabilities?.catalog?.items ?? []
  check('★ 工具目录非空（否则界面上的用途/族无从显示）', capItems.length > 0, 'n=' + capItems.length)
  check('★ 每个工具都带用途',
    capItems.length > 0 && capItems.every(i => typeof i.purpose === 'string' && i.purpose.length > 0),
    JSON.stringify(capItems.slice(0, 2).map(i => i.name + ' → ' + String(i.purpose).slice(0, 46))))
  check('★ 每个工具都带命名族（DSH 不暴露归属插件，这里给的是从名字推出的族，是事实但不是归属声明）',
    capItems.length > 0 && capItems.every(i => typeof i.family === 'string'),
    JSON.stringify(capItems.slice(0, 4).map(i => i.name + ' → ' + JSON.stringify(i.family))))
  check('用途被截断到表格放得下', capItems.every(i => i.purpose.length <= 151),
    'max=' + Math.max(...capItems.map(i => i.purpose.length)))

  check('★ 能力包给了 kept/denied 两笔账',
    typeof payload.capabilities?.totals?.kept === 'number'
    && typeof payload.capabilities?.totals?.deniedTokens === 'number',
    JSON.stringify(payload.capabilities?.totals))
  check('★ 知识页带证据分类', (payload.knowledge.committed || []).every(p => typeof p.cls === 'string'),
    JSON.stringify((payload.knowledge.committed || []).slice(0, 2).map(p => p.id + ':' + p.cls)))
  check('★ 证据分布已统计', payload.knowledge.counts && Object.keys(payload.knowledge.counts).length > 0,
    JSON.stringify(payload.knowledge.counts))
  console.log('  已固化 ' + (payload.knowledge.committed || []).length
    + ' ／ staged ' + (payload.knowledge.staged || []).length
    + ' ／ gap ' + payload.gaps.total
    + ' ／ 挣扎 ' + payload.struggles.total)

  // 输出必须也是 lossless JSON（走 UI 的 JSON.stringify 同样会炸在 undefined 上）
  const bad = []
  const walk = (x, path) => {
    if (x === undefined) { bad.push(path); return }
    if (typeof x === 'number' && !Number.isFinite(x)) { bad.push(path + '=' + x); return }
    if (x === null || typeof x !== 'object') return
    if (Array.isArray(x)) { x.forEach((y, i) => walk(y, path + '[' + i + ']')); return }
    for (const [k, v] of Object.entries(x)) walk(v, path + '.' + k)
  }
  walk(payload, '$')
  check('★ 接口输出是 lossless JSON', bad.length === 0, bad.slice(0, 5).join(', '))
}

// ── 轻量待办端点 ──
//
// 它会被**常驻界面**轮询（输入框上方那条提示条），所以这里额外钉两件事：
//   1. 口径：stagedReady 必须真的等于 staged 里 ready 的条数，而且用的是
//      **同一个 commitReadiness**。对不上的后果是界面显示"全部固化"、
//      一按却全被 409 拒掉 —— 那比不显示还糟。
//   2. 体量：这条路径每 30 秒跑一次，不能顺手把整个知识库读一遍。
{
  const pend = await call('/learn-wiki/api/pending')
  check('pending 返回 200', pend.code === 200, 'code=' + pend.code + (pend.code !== 200 ? ' body=' + String(pend.body).slice(0, 200) : ''))
  let pj = null
  try { pj = JSON.parse(pend.body) } catch (e) { check('pending 响应是合法 JSON', false, e.message) }
  if (pj) {
    check('pending 响应是合法 JSON', true)
    check('pending ok=true', pj.ok === true)
    check('pending stagedTotal 与数组长度一致', pj.stagedTotal === (pj.staged || []).length,
      'total=' + pj.stagedTotal + ' len=' + (pj.staged || []).length)
    check('pending stagedReady 与逐条 ready 一致',
      pj.stagedReady === (pj.staged || []).filter(x => x.ready).length,
      'stagedReady=' + pj.stagedReady)
    check('pending trash/rejected 都是数字',
      Number.isFinite(pj.trash) && Number.isFinite(pj.rejected),
      'trash=' + pj.trash + ' rejected=' + pj.rejected)

    // ★ 跨路径一致性：拿真正的闸门复算一遍。
    //   这条断言的价值在于它**跨了两个实现**（HTTP 层 vs lib/wiki.js），
    //   单独测哪一边都发现不了口径漂移。
    const { loadPages: lp, commitReadiness: cr } = await import('../lib/wiki.js')
    const { pages: realPages } = await lp(ROOT)
    const realStaged = realPages.filter(p => p.status === 'staged')
    const realReady = realStaged.filter(p => cr(p).ready).map(p => p.id).sort()
    const apiReady = (pj.staged || []).filter(x => x.ready).map(x => x.id).sort()
    check('★ ready 与 lib 的 commitReadiness 复算完全一致',
      JSON.stringify(realReady) === JSON.stringify(apiReady),
      'api=' + JSON.stringify(apiReady) + ' lib=' + JSON.stringify(realReady))
    check('★ 每条都带 blockers 字段（界面据此解释为什么不能固化）',
      (pj.staged || []).every(x => Array.isArray(x.blockers)),
      JSON.stringify((pj.staged || []).slice(0, 2).map(x => x.id + ':' + JSON.stringify(x.blockers))))
  }
}

// ── 原因解析（纯函数，直接测）──
//
// 这是 .rejected/README.md 里那条**约定**的执行者："移进来的文件必须在文件头
// 补一段 > REJECTED: 说明为什么被拒，包括具体证据、来源 gap、日期"。
// 在此之前约定只活在文档里、代码完全没实现，所以界面上看不到原因。
{
  const { parseTriageReason } = await import('../lib/wiki.js')
  const one = parseTriageReason('> REJECTED: 2026-09-11 —— 撞名误报，与本项目无关。\n\n正文')
  check('解析单行原因（含日期）',
    one && one.kind === 'REJECTED' && one.date === '2026-09-11' && one.text === '撞名误报，与本项目无关。',
    JSON.stringify(one))
  const multi = parseTriageReason('> TRASHED: 2026-09-11 —— 泛化的第三方教训，与本项目无关。\n> 正文讲的是 mcp-toolbox 的时序问题。\n\n正文开始')
  check('★ 跨行原因要合并成一段（约定里原因常分两行写）',
    multi && multi.kind === 'TRASHED' && /mcp-toolbox/.test(multi.text) && !/正文开始/.test(multi.text),
    JSON.stringify(multi && multi.text))
  check('★ 没有标记就返回 null —— 不许编一个理由',
    parseTriageReason('就是一段普通正文，没有任何标记') === null)
  check('正文里出现同名字样但不在行首，不算原因',
    parseTriageReason('这句话里提到 REJECTED: 但不是标记行') === null)
  check('中英文冒号都认',
    parseTriageReason('> TRASHED： 2026-01-01 — 测试').kind === 'TRASHED')
}

// ── 分拣接口（读路径走真实 wiki，写路径在下面的临时仓库上测）──
{
  const t = await call('/learn-wiki/api/triage')
  check('triage 返回 200', t.code === 200, 'code=' + t.code)
  let tj = null
  try { tj = JSON.parse(t.body) } catch (e) { check('triage 响应是合法 JSON', false, e.message) }
  if (tj) {
    check('triage 响应是合法 JSON', true)
    check('triage ok=true 且有 items', tj.ok === true && Array.isArray(tj.items))
    check('★ 每个条目都带 rel 与 from（写操作与筛选都靠它们）',
      tj.items.every(x => typeof x.rel === 'string' && (x.from === '.trash' || x.from === '.rejected')),
      JSON.stringify(tj.items.slice(0, 2).map(x => x.rel)))
    check('★ 每个条目都带摘录（不看内容无从判断"这页还要不要"）',
      tj.items.every(x => typeof x.excerpt === 'string'),
      'excerpt 长度 ' + JSON.stringify(tj.items.slice(0, 3).map(x => x.excerpt.length)))
    check('★ 列表**不带全文**（八篇正文每次打开面板都传一遍是浪费）',
      tj.items.every(x => x.full === undefined && x.body === undefined))
    check('★ 列表带 reason 字段（有就给原因，没有就是 null —— 界面据此显示"未记录"）',
      tj.items.every(x => 'reason' in x),
      JSON.stringify(tj.items.slice(0, 3).map(x => x.id + ':' + (x.reason ? x.reason.kind : 'null'))))
    check('★ 已拒绝的两条都解析出了原因和日期（它们是按约定写的）',
      tj.items.filter(x => x.from === '.rejected').every(x => x.reason && x.reason.date && x.reason.text),
      JSON.stringify(tj.items.filter(x => x.from === '.rejected').map(x => x.reason)))
    check('★ README 之类的说明文件不在列表里（否则"分拣完了"是假的）',
      !tj.items.some(x => /readme/i.test(x.rel)),
      JSON.stringify(tj.items.map(x => x.rel).slice(0, 6)))

    // 路径穿越：写操作会移动和删除文件，而 rel 来自请求体
    const attacks = ['../../pages/lesson/edit-requires-reading-first-mechanism.md',
      '.trash/../../pages/fact/schema-e86e06.md', '/etc/passwd', '.trashfoo/x.md']
    let leaked = []
    for (const a of attacks) {
      const rr = await call('/learn-wiki/api/triage?rel=' + encodeURIComponent(a))
      if (rr.code === 200) leaked.push(a)
    }
    check('★ 路径穿越被挡住（读单条也不许越界）', leaked.length === 0, leaked.join(', '))
  }
}

const nf = await call('/learn-wiki/nope')
check('未知路径返回 404', nf.code === 404, 'code=' + nf.code)

// ── 写路由：在**临时仓库**上测，不碰真实 wiki ──
const T = '.tmp-ui-write'
await rm(T, { recursive: true, force: true })
const { ensureRepo, savePage } = await import('../lib/wiki.js')
await ensureRepo(T)
const stamp = new Date().toISOString()
await savePage(T, {
  id: 'writable', title: '可提交页', category: 'fact', confidence: 0.8,
  sources: ['https://example.com/x'], tags: [], created: stamp, updated: stamp, hits: 0, body: '内容',
}, { staged: true })
await savePage(T, {
  id: 'no-source', title: '无来源页', category: 'fact', confidence: 0.8,
  sources: [], tags: [], created: stamp, updated: stamp, hits: 0, body: '内容',
}, { staged: true })

route = null
mod.apply(ctxLike, { wikiRoot: T })

function postCall(pathname, body) {
  return new Promise((resolve) => {
    let code = 0
    const req = {
      url: pathname, method: 'POST',
      destroy: () => {},
      // 关键：在**监听器注册时**才投递 body，而不是固定 setTimeout。
      // handler 的第一个 await 是 getCfg()，等它走到 readBody() 时定时器可能已经发完了，
      // 事件就丢了 —— 实测踩到。真实 node http 流会缓冲，所以这只是 mock 不够真。
      on: (ev, cb) => {
        if (ev === 'end') {
          setTimeout(() => {
            req._data && req._data(JSON.stringify(body))
            cb()
          }, 0)
        }
        if (ev === 'data') req._data = cb
        return req
      },
    }
    const res = { writeHead: (c) => { code = c }, end: (b) => resolve({ code, body: b }) }
    // 超时保护：否则一旦 handler 没调 end，测试会静默挂死（比失败更难查）
    setTimeout(() => resolve({ code: -1, body: '(超时：handler 未响应)' }), 3000)
    route.handler(req, res)
  })
}

const c1 = await postCall('/learn-wiki/api/commit', { id: 'writable' })
check('★ commit 有来源的暂存页成功', c1.code === 200 && JSON.parse(c1.body).ok === true,
  'code=' + c1.code + ' ' + String(c1.body).slice(0, 120))

const c2 = await postCall('/learn-wiki/api/commit', { id: 'no-source' })
const c2j = JSON.parse(c2.body)
check('★ 无 sources 被闸门拒绝（两段式的第二道闸）', c2.code === 409 && c2j.ok === false,
  'code=' + c2.code + ' blockers=' + JSON.stringify(c2j.blockers))

const c3 = await postCall('/learn-wiki/api/commit', { id: '根本不存在' })
check('commit 未知 id 返回 404', c3.code === 404, 'code=' + c3.code)

// ── 分拣写路径（同样只在临时仓库上）──
{
  const { mkdir, writeFile } = await import('node:fs/promises')
  const { existsSync } = await import('node:fs')
  const mkPage = (id, title) => '---\nid: ' + id + '\ntitle: ' + title
    + '\ncategory: lesson\nconfidence: 0.8\nstatus: staged\nsources:\n  - https://x\n---\n\n正文 ' + id + '\n'
  await mkdir(join(T, '.trash', 'staged-20260101-000000'), { recursive: true })
  await mkdir(join(T, '.rejected'), { recursive: true })
  await writeFile(join(T, '.trash', 'staged-20260101-000000', 'a.md'), mkPage('tri-a', '回收站 A'), 'utf8')
  await writeFile(join(T, '.trash', 'b.md'), mkPage('tri-b', '回收站 B'), 'utf8')
  await writeFile(join(T, '.rejected', 'c.md'), mkPage('tri-c', '被拒绝 C'), 'utf8')
  await writeFile(join(T, '.rejected', 'README.md'), '# 说明\n', 'utf8')

  const list = JSON.parse((await call('/learn-wiki/api/triage')).body)
  check('分拣列表按 rel 精确列出（含子目录里的条目）',
    list.items.length === 3 && list.items.some(x => x.rel === '.trash/staged-20260101-000000/a.md'),
    JSON.stringify(list.items.map(x => x.rel)))

  const one = JSON.parse((await call('/learn-wiki/api/triage?rel=' + encodeURIComponent('.trash/b.md'))).body)
  check('按 rel 取全文', one.ok === true && /正文 tri-b/.test(one.body), String(one.body).slice(0, 60))

  // ★ confirm 守卫：这是**服务端**的闸，不是前端那个两段式
  const noConfirm = await postCall('/learn-wiki/api/triage', { rel: '.trash/b.md', action: 'discard' })
  check('★ 不带 confirm 的永久删除被拒（不可逆操作的服务端闸）',
    noConfirm.code === 400 && /confirm/.test(String(noConfirm.body)),
    'code=' + noConfirm.code + ' ' + String(noConfirm.body).slice(0, 90))
  check('★ 被拒之后文件**还在**（守卫真的拦住了，不是先删后报错）',
    existsSync(join(T, '.trash', 'b.md')))

  // 恢复 → 必须进 staged，绝不进 pages
  const rest = await postCall('/learn-wiki/api/triage', { rel: '.trash/b.md', action: 'restore' })
  check('恢复成功', rest.code === 200 && JSON.parse(rest.body).ok === true, String(rest.body).slice(0, 120))
  check('★ 恢复落到 staged/ 而不是 pages/（两段式的第一段不许被绕过）',
    existsSync(join(T, 'staged', 'b.md')) && !existsSync(join(T, 'pages', 'lesson', 'b.md')))
  const after = JSON.parse((await call('/learn-wiki/api/triage')).body)
  check('恢复后它从分拣列表里消失', !after.items.some(x => x.rel === '.trash/b.md'),
    JSON.stringify(after.items.map(x => x.rel)))

  // 真正的删除
  const del = await postCall('/learn-wiki/api/triage', { rel: '.rejected/c.md', action: 'discard', confirm: true })
  check('带 confirm 的永久删除成功', del.code === 200 && JSON.parse(del.body).ok === true, String(del.body).slice(0, 120))
  check('文件确实没了', !existsSync(join(T, '.rejected', 'c.md')))

  // 路径穿越走写路径也不行
  const trav = await postCall('/learn-wiki/api/triage', { rel: '../pages/lesson/x.md', action: 'discard', confirm: true })
  check('★ 写路径的路径穿越也被挡住', trav.code === 400, 'code=' + trav.code + ' ' + String(trav.body).slice(0, 90))

  // 非法 action
  const badAct = await postCall('/learn-wiki/api/triage', { rel: '.trash/staged-20260101-000000/a.md', action: '删掉' })
  check('未知 action 返回 400', badAct.code === 400, 'code=' + badAct.code)
}

const c4 = await postCall('/learn-wiki/api/capabilities', { enabled: true, explicitOnly: ['workflow', 'ralph'] })
check('★ 能力包配置写回成功', c4.code === 200 && JSON.parse(c4.body).ok === true, String(c4.body).slice(0, 140))
const { readFile: rf } = await import('node:fs/promises')
const saved = JSON.parse(await rf(join(T, 'wiki.config.json'), 'utf8'))
check('★ 配置确实落进 wiki.config.json', JSON.stringify(saved.capabilities.explicitOnly) === '["workflow","ralph"]',
  JSON.stringify(saved.capabilities))

const c5 = await postCall('/learn-wiki/api/capabilities', { bad: 1 })
check('非法载荷返回 400', c5.code === 400, 'code=' + c5.code)

// ── 模型：目录 / 写配置 / 触发提炼 ──
//
// 这一段跑在临时 root（T）上（见上文 mod.apply 的那次重挂），所以写配置
// **不会**碰到真实的 dsh-wiki/wiki.config.json。
{
  const m = await call('/learn-wiki/api/models')
  let mj = null
  try { mj = JSON.parse(m.body) } catch (e) { check('api/models 响应是合法 JSON', false, e.message) }
  check('api/models 返回 200 且是 JSON', m.code === 200 && !!mj, 'code=' + m.code)
  if (mj) {
    check('api/models ok=true', mj.ok === true)
    check('★ 带 provider 目录（界面要拿它做下拉框）',
      Array.isArray(mj.providers) && mj.providers.every(p => typeof p.id === 'string' && Array.isArray(p.models)),
      JSON.stringify((mj.providers || []).map(p => p.id + '(' + p.models.length + ')')))
    check('★ 带全部站点及其人话名字（界面不自己翻译一份）',
      Array.isArray(mj.sites) && mj.sites.length >= 2 && mj.sites.every(s => s.id && s.label),
      JSON.stringify(mj.sites))
    check('★ 带每个站点解析出来的路由（下一次会问谁）',
      mj.routes && mj.routes.distill && mj.routes.harvest
      && typeof mj.routes.distill.mode === 'string',
      JSON.stringify(Object.keys(mj.routes || {})))
  }

  // 写配置：故意塞进一个拼错的 mode 和一个字符串形式的候选
  const w = await postCall('/learn-wiki/api/llm', {
    mode: 'ROTATE', models: ['m'], onError: 'sure-why-not',
    sites: { distill: { models: ['m/m'] } },
  })
  let wj = null
  try { wj = JSON.parse(w.body) } catch (e) { check('api/llm 响应是合法 JSON', false, e.message) }
  check('api/llm 写回成功', w.code === 200 && wj && wj.ok === true, 'code=' + w.code + ' ' + String(w.body).slice(0, 160))
  if (wj) {
    check('★ mode 拼错被归一化成 single 才落盘（存进去的和生效的必须是同一份解释）',
      wj.saved.mode === 'single', String(wj.saved.mode))
    check('★ onError 认不出来时落 next', wj.saved.onError === 'next', String(wj.saved.onError))
    check('★ 字符串 "m" 被解析成 { provider:"m", model:"" }',
      wj.saved.models.length === 1 && wj.saved.models[0].provider === 'm' && wj.saved.models[0].model === '',
      JSON.stringify(wj.saved.models))
  }
  const onDisk = JSON.parse(await rf(join(T, 'wiki.config.json'), 'utf8'))
  check('★ 归一化后的 llm 块**确实落进了文件**（不是只在响应里好看）',
    onDisk.llm && onDisk.llm.mode === 'single' && onDisk.llm.onError === 'next',
    JSON.stringify(onDisk.llm))
  check('★ 写 llm 不动 capabilities（一次保存不该冲掉手工配好的别的段）',
    onDisk.capabilities && JSON.stringify(onDisk.capabilities.explicitOnly) === '["workflow","ralph"]',
    JSON.stringify(onDisk.capabilities && onDisk.capabilities.explicitOnly))

  // 未注册的 provider：写得进去，但**运行时必须报出来**
  const w2 = await postCall('/learn-wiki/api/llm', { mode: 'rotate', models: ['nope/nope', 'm/m'] })
  const w2j = JSON.parse(w2.body)
  const rejected = w2j.routes && w2j.routes.distill && w2j.routes.distill.rejected
  check('★ 未注册的 provider 被运行时标出来（否则用户以为轮换在用两个模型）',
    Array.isArray(rejected) && rejected.length === 1 && /未注册/.test(rejected[0].why),
    JSON.stringify(rejected))
  check('★ 幸存的候选仍在（不是整份配置作废）',
    (w2j.routes.distill.candidates || []).length === 1, JSON.stringify(w2j.routes.distill.candidates))

  // 提炼：未知会话 id
  const hMiss = await postCall('/learn-wiki/api/harvest', { session: 'no-such-session-xyz' })
  let hmj = null
  try { hmj = JSON.parse(hMiss.body) } catch (e) { check('api/harvest 响应是合法 JSON', false, e.message) }
  check('★ 未知会话返回 404 + 可读原因（不是 HTML、不是 500）',
    hMiss.code === 404 && hmj && hmj.ok === false && /没找到会话/.test(String(hmj.error)),
    'code=' + hMiss.code + ' ' + String(hMiss.body).slice(0, 140))
}

// ── ★ 桌面载体（app://）形态的 POST ──
//
// 桌面端的 req 是 fetch Request 的**垫片**：它的 on() 只处理 close / aborted，
// 对 'data' 和 'end' **静默返回**，body 只能通过异步迭代读
// （dsh-host-desktop-carrier/lib/index.js:272）。
//
// 上面那个 postCall 的 mock 实现了 data/end —— 比真实边界宽松，
// 所以它测不出「handler 永远不 resolve」这个 bug。实测就这么漏过去了：
// 点任意一个工具前的方框 → Failed to fetch。
function postCallDesktop(pathname, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = {
    url: pathname,
    method: 'POST',
    headers: {},
    destroy: () => {},
    // 只"支持" close/aborted —— 其余事件名静默吞掉，和垫片一模一样
    on: () => req,
    once: () => req,
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c },
  }
  return new Promise((resolve) => {
    let code = 0
    const res = { writeHead: (c) => { code = c }, end: (b) => { clearTimeout(timer); resolve({ code, body: b }) } }
    const timer = setTimeout(
      () => resolve({ code: -1, body: '(超时：handler 未响应 —— 很可能在等一个永远不会触发的事件)' }),
      3000)
    Promise.resolve(route.handler(req, res)).catch((e) => { clearTimeout(timer); resolve({ code: -2, body: String(e && e.message) }) })
  })
}

// 同样的写路径，但走**桌面垫片**形态的 req
const d1 = await postCallDesktop('/learn-wiki/api/capabilities', { enabled: true, explicitOnly: ['workflow'] })
check('★ 桌面载体（app://）下 POST 也能被处理（body 走异步迭代，不是 data/end 事件）',
  d1.code === 200 && JSON.parse(d1.body).ok === true,
  'code=' + d1.code + ' ' + String(d1.body).slice(0, 140))
const d2 = await postCallDesktop('/learn-wiki/api/commit', { id: 'no-source' })
check('★ 桌面载体下 commit 的闸门照常生效',
  d2.code === 409 && JSON.parse(d2.body).ok === false,
  'code=' + d2.code + ' ' + String(d2.body).slice(0, 140))

// ── 读路由：单页正文（"行是活的"靠它） ──
const pg = await call('/learn-wiki/api/page?id=writable')
const pgj = JSON.parse(pg.body)
check('★ 单页接口把正文带回来', pg.code === 200 && pgj.ok === true && pgj.body.includes('内容'),
  'code=' + pg.code + ' body=' + JSON.stringify(pgj.body || '').slice(0, 80))
check('单页接口带 sources 与 usage',
  Array.isArray(pgj.sources) && pgj.sources.length === 1 && typeof pgj.usage?.hits === 'number',
  'sources=' + JSON.stringify(pgj.sources) + ' usage=' + JSON.stringify(pgj.usage))

const pgNoId = await call('/learn-wiki/api/page')
check('单页接口缺 id 返回 400', pgNoId.code === 400, 'code=' + pgNoId.code)

const pgMissing = await call('/learn-wiki/api/page?id=根本没有这页')
check('单页接口未知 id 返回 404', pgMissing.code === 404, 'code=' + pgMissing.code)

await rm(T, { recursive: true, force: true })

console.log(failures === 0 ? '\nALL PASS — UI 接口正确' : '\n' + failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
