// 直接调 UI 端点的 handler，看界面到底拿到什么（不用 curl，桌面壳层没有独立端口）
let route = null
const ctxLike = {
  tools: { register: () => () => {}, schemas: () => [] },
  llm: { listProviders: () => [{ id: 'm' }], listModels: async () => [{ id: 'm' }], stream: async function* () {} },
  web: { search: async () => ({ sources: [] }) },
  webServer: { register: (r) => { route = r; return () => {} } },
  on: () => () => {}, effect: (fn) => fn(),
  inject: (s, cb) => cb({ systemPrompt: { section: () => {} } }),
}
const mod = await import('../index.js')
mod.apply(ctxLike, { wikiRoot: 'D:/Harness/dsh-wiki' })
const res = await new Promise((resolve) => {
  route.handler({ url: '/learn-wiki/api/state' }, { writeHead: () => {}, end: (b) => resolve(JSON.parse(b)) })
})

console.log('=== 能力 ===')
console.log('  enabled      : ' + res.capabilities.enabled)
console.log('  配置裁掉     : ' + (res.capabilities.configuredDeny || []).join(', '))
console.log('  目录快照     : ' + res.capabilities.catalog.total + ' 个  capturedAt=' + res.capabilities.catalog.capturedAt)
console.log('  其中已裁     : ' + (res.capabilities.catalog.items || []).filter(i => i.denied).length)
console.log('')
console.log('=== 知识 ===')
console.log('  已固化 ' + res.knowledge.committed.length + ' ／ staged ' + res.knowledge.staged.length)
console.log('  证据分布: ' + JSON.stringify(res.knowledge.counts))
console.log('')
for (const p of res.knowledge.committed) {
  console.log('  ' + p.id.padEnd(44) + p.cls.padEnd(16) + 'h=' + p.hits + ' c=' + p.confirmed + ' s=' + p.suspect + ' x' + p.factor + (p.quarantined ? ' [隔离]' : ''))
}
console.log('')
console.log('=== 补料 ===')
console.log('  gap: ' + JSON.stringify(res.gaps.counts))
console.log('  挣扎: ' + JSON.stringify(res.struggles.counts))
