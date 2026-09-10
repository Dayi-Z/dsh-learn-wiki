// 清理触发器换向之前积累的噪声 gap。
// 那些全是用户的对话原话（"ok 按你的倾向来"、"已重启 一起写进 wiki"），
// 没有一条是真的知识缺口。保留，只会让补料预算继续浪费在它们身上。
import { readGaps, writeGaps } from '../lib/acquire.js'
import { looksLikeGap } from '../lib/recall.js'

const ROOT = 'D:/Harness/dsh-wiki'
const gaps = await readGaps(ROOT)
const keep = []
const drop = []
for (const g of gaps) {
  const q = String(g.query ?? '')
  // 症状查询的特征：含"反复修改/重复调用/原因/解决办法"
  const isSymptom = /反复修改|重复调用|常见原因|解决办法|常见故障/.test(q)
  const isConversational = /^(ok|OK|好的|继续|已重启|先|是的|嗯)/.test(q.trim())
  if (isSymptom) keep.push(g)
  else if (isConversational || !looksLikeGap(q, { minChars: 12 })) drop.push(g)
  else keep.push(g)
}
await writeGaps(ROOT, keep)
console.log('保留 ' + keep.length + ' 条，丢弃 ' + drop.length + ' 条噪声:')
for (const g of drop) console.log('  - ' + JSON.stringify(String(g.query).slice(0, 56)))
