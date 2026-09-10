// 修复 Hindsight 的 LLM key：只替换 API key 一行，模型与 base URL 不动。
// **绝不打印密钥。** 改前备份。
import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const embedPath = join(homedir(), '.hindsight', 'embed')
const credPath = join(homedir(), '.dsh', '.credentials.yaml')

const credRaw = await readFile(credPath, 'utf8')
const m = credRaw.match(/^\s*DSDGPT_API_KEY\s*:\s*(.+?)\s*$/m)
if (!m) { console.error('未找到 DSDGPT_API_KEY'); process.exit(1) }
const newKey = m[1].replace(/^["']|["']$/g, '').trim()

const embed = await readFile(embedPath, 'utf8')
const lines = embed.split(/\r?\n/)
const oldLine = lines.find(l => /^\s*HINDSIGHT_API_LLM_API_KEY=/.test(l))
if (!oldLine) { console.error('embed 里没有 HINDSIGHT_API_LLM_API_KEY'); process.exit(1) }

const oldKey = oldLine.split('=')[1] ?? ''
if (oldKey.trim() === newKey) { console.log('key 已经是目标值，无需修改'); process.exit(0) }

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
await copyFile(embedPath, embedPath + '.bak-' + stamp)
console.log('已备份: embed.bak-' + stamp)

const next = lines.map(l => /^\s*HINDSIGHT_API_LLM_API_KEY=/.test(l) ? 'HINDSIGHT_API_LLM_API_KEY=' + newKey : l).join('\n')
await writeFile(embedPath, next, 'utf8')

console.log('已替换 HINDSIGHT_API_LLM_API_KEY')
console.log('  旧 key 尾 4 位: ...' + oldKey.trim().slice(-4) + '  (长度 ' + oldKey.trim().length + ')')
console.log('  新 key 尾 4 位: ...' + newKey.slice(-4) + '  (长度 ' + newKey.length + ')')
console.log('  模型保持不变: ' + (embed.match(/^\s*HINDSIGHT_API_LLM_MODEL=(.*)$/m)?.[1] ?? '?'))
