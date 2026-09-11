import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadPages } from '../lib/wiki.js'

const ROOT = 'D:/Harness/dsh-wiki'
const { pages } = await loadPages(ROOT)
const committed = pages.filter(p => p.status === 'committed')
const staged = pages.filter(p => p.status === 'staged')
console.log('已固化 ' + committed.length + ' 页 / 暂存 ' + staged.length + ' 页')

const uPath = join(ROOT, 'usage.json')
if (existsSync(uPath)) {
  const u = JSON.parse(await readFile(uPath, 'utf8'))
  const byCls = {}
  for (const [id, st] of Object.entries(u.pages ?? {})) {
    const c = st.class ?? 'unconfirmed'
    byCls[c] = (byCls[c] ?? 0) + 1
    if ((st.suspect ?? 0) > 0) console.log('  有嫌疑: ' + id + ' suspect=' + st.suspect + ' hits=' + (st.hits ?? 0))
  }
  console.log('证据分布: ' + JSON.stringify(byCls))
} else console.log('(无 usage.json)')

const q = join(ROOT, 'gaps', 'queue.jsonl')
console.log('缺口队列: ' + (existsSync(q) ? (await readFile(q, 'utf8')).split(/\r?\n/).filter(l => l.trim()).length + ' 条' : '无文件'))
