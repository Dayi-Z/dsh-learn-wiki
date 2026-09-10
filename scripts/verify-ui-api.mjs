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
check('注册了 UI 路由', route !== null && route.path === '/learn-wiki/api/state', JSON.stringify(route && { kind: route.kind, path: route.path }))

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
    const handlers = {}
    const req = {
      url: pathname, method: 'POST',
      on: (ev, cb) => { handlers[ev] = cb; return req },
      destroy: () => {},
    }
    const res = { writeHead: (c) => { code = c }, end: (b) => resolve({ code, body: b }) }
    // 超时保护：否则一旦 handler 没调 end，测试会静默挂死（比失败更难查）
    setTimeout(() => resolve({ code: -1, body: '(超时：handler 未响应)' }), 2000)
    route.handler(req, res)
    setTimeout(() => { handlers.data && handlers.data(JSON.stringify(body)); handlers.end && handlers.end() }, 0)
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

const c4 = await postCall('/learn-wiki/api/capabilities', { enabled: true, explicitOnly: ['workflow', 'ralph'] })
check('★ 能力包配置写回成功', c4.code === 200 && JSON.parse(c4.body).ok === true, String(c4.body).slice(0, 140))
const { readFile: rf } = await import('node:fs/promises')
const saved = JSON.parse(await rf(join(T, 'wiki.config.json'), 'utf8'))
check('★ 配置确实落进 wiki.config.json', JSON.stringify(saved.capabilities.explicitOnly) === '["workflow","ralph"]',
  JSON.stringify(saved.capabilities))

const c5 = await postCall('/learn-wiki/api/capabilities', { bad: 1 })
check('非法载荷返回 400', c5.code === 400, 'code=' + c5.code)

await rm(T, { recursive: true, force: true })

console.log(failures === 0 ? '\nALL PASS — UI 接口正确' : '\n' + failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
