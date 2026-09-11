// 清理孤儿 usage 记录：页面已经不在了，记录还留着。
//
// 这 4 条正是那批误报的产物 —— 挣扎检测器的冷却键被计数污染，
// 于是正常编辑被判成卡住，投递+继续挣扎被记成 suspect。
// 页面已被清掉，记录留着只会在下次分类时产生查不到页面的幽灵。
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadPages } from '../lib/wiki.js'

const ROOT = 'D:/Harness/dsh-wiki'
const UP = join(ROOT, 'usage.json')
if (!existsSync(UP)) { console.log('无 usage.json'); process.exit(0) }

const u = JSON.parse(await readFile(UP, 'utf8'))
const { pages } = await loadPages(ROOT)
const alive = new Set(pages.map(p => p.id))

const dropped = []
for (const id of Object.keys(u.pages ?? {})) {
  if (!alive.has(id)) { dropped.push(id); delete u.pages[id] }
}

// 把「孤儿」的定义写清楚：页面文件不存在，而不是"没被 commit"。
// staged 页有 usage 是正常的（它可能马上被 commit）。
console.log('存活页面 ' + alive.size + ' 个')
console.log('删除孤儿记录 ' + dropped.length + ' 条:')
for (const d of dropped) console.log('  ' + d)

if (dropped.length > 0) {
  const bak = join(ROOT, 'usage.backup-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json')
  await writeFile(bak, JSON.stringify(u, null, 2), 'utf8')
  await writeFile(UP, JSON.stringify(u, null, 2), 'utf8')
  console.log('已写入（旧文件已备份为 ' + bak.replace(ROOT, '') + '）')
} else {
  console.log('没有孤儿，未改动')
}
const left = Object.keys(u.pages ?? {}).length
console.log('剩余 usage 记录 ' + left + ' 条')
