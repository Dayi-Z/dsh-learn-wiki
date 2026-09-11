// 清空 staged/。
//
// 这 12 页全部来自同一批误报：挣扎检测器的冷却键被计数污染（见 L1 页面
// root-cause-masking-bugs），于是"同一个文件改了 4 次"被判成卡住，
// 触发联网补料，产出这些页。它们从没被 commit —— 两段式闸门是有效的。
//
// 清掉前先备份到 .trash/，并且**用插件自己的 loadPages 复核** staged 确实归零，
// 而不是我看一眼目录说"清完了"。
import { readdir, readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadPages } from '../lib/wiki.js'

const ROOT = 'D:/Harness/dsh-wiki'
const STAGED = join(ROOT, 'staged')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const TRASH = join(ROOT, '.trash', 'staged-' + stamp)

if (!existsSync(STAGED)) { console.log('没有 staged 目录'); process.exit(0) }

const before = await loadPages(ROOT)
const stagedBefore = before.pages.filter(p => p.status === 'staged')
console.log('清理前 staged: ' + stagedBefore.length + ' 页')
for (const p of stagedBefore) console.log('  ' + p.id + '  <- ' + String(p.title ?? '').slice(0, 60))

await mkdir(TRASH, { recursive: true })
for (const f of await readdir(STAGED)) {
  if (f === '.gitkeep') continue
  await rename(join(STAGED, f), join(TRASH, f))
}
await writeFile(join(STAGED, '.gitkeep'), '', 'utf8')

const after = await loadPages(ROOT)
const stagedAfter = after.pages.filter(p => p.status === 'staged')
const committedAfter = after.pages.filter(p => p.status === 'committed')
console.log('')
console.log('清理后 staged: ' + stagedAfter.length + ' 页（应为 0）')
console.log('清理后 committed: ' + committedAfter.length + ' 页（不该动到）')
console.log('备份位置: ' + TRASH)
console.log(stagedAfter.length === 0 ? 'OK — staged 已归零，已固化的知识未被触碰' : '失败：staged 没清干净')
process.exit(stagedAfter.length === 0 ? 0 : 1)
