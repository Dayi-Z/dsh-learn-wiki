import { readFile } from 'node:fs/promises'
const p = process.env.USERPROFILE + '\\.dsh\\profiles\\web\\node_modules\\@vectorize-io\\hindsight-coding-agents\\dist\\dsh.js'
const src = await readFile(p, 'utf8')
for (const needle of ['agent/session-start', 'agent.inject', 'agent.followup', 'agent/created', 'additionalContext']) {
  let from = 0, hits = []
  while (true) { const i = src.indexOf(needle, from); if (i < 0) break; hits.push(i); from = i + 1 }
  console.log('=== ' + needle + ' -> ' + hits.length + ' 次 ===')
  for (const i of hits.slice(0, 3)) {
    console.log('@' + i + ': ' + src.slice(Math.max(0, i - 240), i + 260).replace(/\\n/g, ' '))
    console.log('')
  }
}
