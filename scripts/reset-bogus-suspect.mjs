// 清掉用**错误归因规则**采集的嫌疑证据。
//
// 背景：修复前，weak 桶（我们明确标注"弱相关、不要直接采信"）注入的页
// 也会因为后续挣扎而被记为 suspect。那是错误归因 —— 模型被告知别信它，
// 它就不该为后续失败负责。规则已修，但**旧数据还留在 usage.json 里**。
//
// 留着它会让后续判断建立在脏数据上（x0.7 的降权、以及未来可能的隔离）。
// 所以清零重来，并把这次重置记进 usage.json 的 meta，便于日后追溯。
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = 'D:/Harness/dsh-wiki'
const p = join(ROOT, 'usage.json')
const u = JSON.parse(await readFile(p, 'utf8'))

const affected = []
for (const [id, st] of Object.entries(u.pages ?? {})) {
  if ((st.suspect ?? 0) > 0) {
    affected.push({ id, suspect: st.suspect, hits: st.hits, confirmed: st.confirmed })
    st.suspect = 0
    st.resetReason = 'attribution-fix: weak 桶不应计证据（2026-09-10）'
  }
}

u.meta = {
  ...(u.meta ?? {}),
  lastResetAt: new Date().toISOString(),
  lastResetReason: '归因规则修正：weak 桶注入不再计入确认/嫌疑。此前的 suspect 是用旧规则采集的，不可信。',
}

await writeFile(p, JSON.stringify(u, null, 2) + '\n', 'utf8')
console.log('已清零 ' + affected.length + ' 条错误嫌疑:')
for (const a of affected) console.log('  ' + a.id.padEnd(44) + 'suspect ' + a.suspect + ' -> 0  (hits=' + a.hits + ')')
console.log('')
console.log('hits 保留（liveness 是"有没有被检索到"，与归因规则无关）')
