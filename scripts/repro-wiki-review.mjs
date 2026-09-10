// 用真实 wiki 跑真实的 wiki_review 工具，定位非 lossless JSON 的字段
const registered = []
const ctxLike = {
  tools: { register: (d) => { registered.push(d); return () => {} }, schemas: () => [] },
  llm: { listProviders: () => [{ id: 'm' }], listModels: async () => [{ id: 'm' }], stream: async function* () {} },
  web: { search: async () => ({ sources: [] }) },
  on: () => () => {},
  effect: (fn) => fn(),
  inject: (s, cb) => cb({ systemPrompt: { section: () => {} } }),
}
const mod = await import('../index.js')
mod.apply(ctxLike, { wikiRoot: 'D:/Harness/dsh-wiki' })

const def = registered.find(d => d.name === 'wiki_review')
if (!def) { console.log('未注册'); process.exit(1) }
const v = await def.execute({}, { signal: { throwIfAborted() {} } })

const bad = []
const walk = (x, path) => {
  if (x === undefined) { bad.push(path); return }
  if (x === null || typeof x !== 'object') return
  if (Array.isArray(x)) { x.forEach((y, i) => walk(y, path + '[' + i + ']')); return }
  for (const [k, val] of Object.entries(x)) walk(val, path + '.' + k)
}
walk(v, 'result')
console.log('非 lossless 字段:')
console.log(bad.length ? bad.join('\n') : '  (无 —— 输出合法)')
console.log('')
console.log('顶层键: ' + Object.keys(v).join(', '))
console.log('usage 键: ' + Object.keys(v.usage ?? {}).join(', '))
