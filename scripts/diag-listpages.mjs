import { readFile } from 'node:fs/promises'
const p = process.env.USERPROFILE + '\\.dsh\\profiles\\web\\node_modules\\@vectorize-io\\hindsight-coding-agents\\dist\\dsh.js'
const src = await readFile(p, 'utf8')
const i = src.indexOf('listPages(')
let from = 0, hits = []
while (true) { const j = src.indexOf('listPages', from); if (j < 0) break; hits.push(j); from = j + 1 }
console.log('listPages 出现 ' + hits.length + ' 次')
// 找定义
for (const j of hits) {
  const w = src.slice(j, j + 400)
  if (/listPages\s*\(/.test(w) && /=|:\s*(async\s*)?function|async listPages/.test(src.slice(Math.max(0,j-200), j+50))) {
    console.log('--- @' + j + ' ---')
    console.log(src.slice(Math.max(0, j - 350), j + 500).replace(/\\n/g, '\n'))
    console.log('')
  }
}
