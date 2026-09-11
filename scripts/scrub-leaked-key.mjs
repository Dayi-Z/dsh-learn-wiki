// 擦除已泄漏的密钥（全库扫描 + 用 redact() 擦除，保证擦除规则与预防规则同源）。
//
// 密钥**不写进脚本**：从环境变量或命令行读。
// 特意这样设计——写这个脚本时我自己就把 key 硬编码进来过一次，
// 于是"用来清理泄漏的工具"变成了新的泄漏点。
//
//   node scripts/scrub-leaked-key.mjs <wikiRoot> <secret>
//   $env:LEAKED_SECRET='sk-...'; node scripts/scrub-leaked-key.mjs D:/Harness/dsh-wiki
import { redact } from '../lib/redact.js'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = process.argv[2] || process.env.WIKI_ROOT || 'D:/Harness/dsh-wiki'
const SECRET = process.argv[3] || process.env.LEAKED_SECRET || ''

if (!SECRET || SECRET.length < 8) {
  console.error('缺少要擦除的密钥。用法：node scripts/scrub-leaked-key.mjs <wikiRoot> <secret>')
  process.exit(2)
}

let scanned = 0, scrubbed = 0
async function walk(dir) {
  let ents = []
  try { ents = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { await walk(p); continue }
    let txt = ''
    try { txt = await readFile(p, 'utf8') } catch { continue }
    scanned++
    if (!txt.includes(SECRET)) continue
    await writeFile(p, redact(txt), 'utf8')
    scrubbed++
    console.log('  已擦除: ' + p.replace(ROOT, ''))
  }
}
await walk(ROOT)
console.log('扫描 ' + scanned + ' 个文件，擦除 ' + scrubbed + ' 个')
process.exit(scrubbed >= 0 ? 0 : 1)
