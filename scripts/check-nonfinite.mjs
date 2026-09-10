// 找 undefined / NaN / Infinity —— 三类都不是 lossless JSON
const registered = []
const ctxLike = {
  tools: { register: (d) => { registered.push(d); return () => {} }, schemas: () => [] },
  llm: { listProviders: () => [{ id: 'm' }], listModels: async () => [{ id: 'm' }], stream: async function* () {} },
  web: { search: async () => ({ sources: [] }) },
  on: () => () => {}, effect: (fn) => fn(),
  inject: (s, cb) => cb({ systemPrompt: { section: () => {} } }),
}
const mod = await import('../index.js')
mod.apply(ctxLike, { wikiRoot: 'D:/Harness/dsh-wiki' })

for (const toolName of ['wiki_review', 'wiki_recall', 'wiki_struggle', 'wiki_acquire']) {
  const def = registered.find(d => d.name === toolName)
  if (!def) continue
  const args = toolName === 'wiki_recall' ? { query: '能力包 token' } : toolName === 'wiki_acquire' ? { dryRun: true } : {}
  let v
  try { v = await def.execute(args, { signal: { throwIfAborted() {} } }) }
  catch (e) { console.log(toolName + ': execute 抛异常 ' + e.message); continue }
  const bad = []
  const walk = (x, path) => {
    if (x === undefined) { bad.push(path + ' = undefined'); return }
    if (typeof x === 'number' && !Number.isFinite(x)) { bad.push(path + ' = ' + x); return }
    if (x === null || typeof x !== 'object') return
    if (Array.isArray(x)) { x.forEach((y, i) => walk(y, path + '[' + i + ']')); return }
    for (const [k, val] of Object.entries(x)) walk(val, path + '.' + k)
  }
  walk(v, 'result')
  console.log(toolName.padEnd(16) + (bad.length ? '❌ ' + bad.length + ' 处' : '✅ 合法'))
  for (const b of bad.slice(0, 8)) console.log('     ' + b)
}
