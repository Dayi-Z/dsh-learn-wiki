import { readFile } from 'node:fs/promises'
const p = process.env.USERPROFILE + '\\.dsh\\profiles\\web\\node_modules\\@vectorize-io\\hindsight-coding-agents\\dist\\dsh.js'
const src = await readFile(p, 'utf8')
for (const needle of ['systemPrompt.section', 'systemPrompt.context', 'suppressRuntimeContext', 'additionalContext']) {
  let from = 0, hits = []
  while (true) { const i = src.indexOf(needle, from); if (i < 0) break; hits.push(i); from = i + 1 }
  console.log(needle + ' -> ' + hits.length + ' 次')
  for (const i of hits.slice(0, 2)) {
    console.log('   @' + i + ': ' + src.slice(Math.max(0, i - 160), i + 220).replace(/\\n/g, ' '))
  }
}
