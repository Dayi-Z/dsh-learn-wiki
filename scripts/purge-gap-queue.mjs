// 清理误报产生的垃圾缺口。
//
// 这批缺口的来源是一次真实事故：挣扎检测器的冷却去重键里混进了计数，
// 于是"同一个文件改了 4 次"这种正常迭代被反复判成卡住，
// 每次都去联网补料，并把资料插进对话。实测一个会话里产生了十几条。
//
// 清理前先备份 —— "清掉"必须可逆，否则下次想复盘误报率就没有原料了。
import { readFile, writeFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'D:/Harness/dsh-wiki'
const Q = join(ROOT, 'gaps', 'queue.jsonl')

if (!existsSync(Q)) { console.log('没有队列文件: ' + Q); process.exit(0) }

const raw = await readFile(Q, 'utf8')
const lines = raw.split(/\r?\n/).filter(l => l.trim())
const rows = []
const bad = []
for (const l of lines) {
  try { rows.push(JSON.parse(l)) } catch { bad.push(l) }
}

const byStatus = {}
for (const r of rows) byStatus[r.status ?? '(无)'] = (byStatus[r.status ?? '(无)'] ?? 0) + 1

console.log('队列共 ' + rows.length + ' 条，解析失败 ' + bad.length + ' 条')
console.log('按状态: ' + JSON.stringify(byStatus))
console.log('')
console.log('全部条目:')
for (const r of rows) {
  console.log('  [' + String(r.status).padEnd(8) + '] ' + String(r.query ?? '').slice(0, 100))
}

// 备份
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const bak = join(ROOT, 'gaps', 'queue.backup-' + stamp + '.jsonl')
await rename(Q, bak)
await writeFile(Q, '', 'utf8')
console.log('')
console.log('已备份到: ' + bak)
console.log('队列已清空（文件保留为空，appendGap 继续可用）')
