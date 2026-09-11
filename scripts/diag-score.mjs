import { loadPages } from '../lib/wiki.js'
import { buildCorpus, scoreQuery, recallable } from '../lib/recall.js'
const { pages } = await loadPages('D:/Harness/dsh-wiki')
const corpus = buildCorpus(recallable(pages))
const all = scoreQuery(corpus, '如何配置 kubernetes sidecar 注入策略', { explain: true })
const r = all[0]
console.log('结果对象的键: ' + Object.keys(r).join(','))
const small = {}
for (const [k, v] of Object.entries(r)) {
  if (k === 'page') { small.pageId = v.id; continue }
  small[k] = Array.isArray(v) ? v.slice(0, 10) : v
}
console.log(JSON.stringify(small, null, 1).slice(0, 1600))
