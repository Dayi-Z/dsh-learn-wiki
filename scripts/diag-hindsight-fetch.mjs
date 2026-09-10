import { readFile } from 'node:fs/promises'
const p = process.env.USERPROFILE + '\\.dsh\\profiles\\web\\node_modules\\@vectorize-io\\hindsight-coding-agents\\dist\\dsh.js'
const src = await readFile(p, 'utf8')

const show = (label, idx, span = 900) => {
  console.log('=== ' + label + ' @' + idx + ' ===')
  console.log(src.slice(idx, idx + span).replace(/\\n/g, '\n'))
  console.log('')
}

// parsePageList 的调用点 -> 找到取数逻辑
let from = 0
const calls = []
while (true) {
  const i = src.indexOf('parsePageList(', from)
  if (i < 0) break
  calls.push(i); from = i + 1
}
console.log('parsePageList 调用点: ' + calls.length)
for (const i of calls.slice(0, 3)) show('call', Math.max(0, i - 1200), 1500)

// buildKnowledgePreamble 的调用点
from = 0
const bp = []
while (true) {
  const i = src.indexOf('buildKnowledgePreamble(', from)
  if (i < 0) break
  bp.push(i); from = i + 1
}
console.log('buildKnowledgePreamble 调用点: ' + bp.length)
for (const i of bp) show('preamble', Math.max(0, i - 900), 1200)
