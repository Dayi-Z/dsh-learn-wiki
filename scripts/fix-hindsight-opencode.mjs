// 把 Hindsight 指向 OpenCode 免费档。
// 免费档需要 x-session-id 头 —— 这是实测出来的：没有它报 MissingSessionID，
// 有了它 HTTP 200 并返回真实补全。
import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const embedPath = join(homedir(), '.hindsight', 'embed')
const KEY = process.env.OC_KEY
if (!KEY) { console.error('缺少 OC_KEY'); process.exit(1) }

const DESIRED = {
  HINDSIGHT_API_LLM_PROVIDER: 'openai',
  HINDSIGHT_API_LLM_BASE_URL: 'https://opencode.ai/zen/v1',
  HINDSIGHT_API_LLM_MODEL: 'nemotron-3-ultra-free',
  HINDSIGHT_API_LLM_API_KEY: KEY,
  HINDSIGHT_API_LLM_DEFAULT_HEADERS: '{"x-session-id":"dsh-learn-wiki"}',
}

let lines = (await readFile(embedPath, 'utf8')).split(/\r?\n/)
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
await copyFile(embedPath, embedPath + '.bak-' + stamp)

const setKey = (key, value) => {
  const re = new RegExp('^\\s*' + key + '=')
  const idx = lines.findIndex(l => re.test(l))
  const line = key + '=' + value
  if (idx >= 0) lines[idx] = line
  else lines.push(line)
  return idx >= 0 ? 'updated' : 'added'
}

console.log('备份: embed.bak-' + stamp)
for (const [k, v] of Object.entries(DESIRED)) {
  const old = lines.find(l => new RegExp('^\\s*' + k + '=').test(l))
  const oldShown = k.includes('KEY') ? '(已隐藏)' : (old ? old.split('=').slice(1).join('=') : '(无)')
  const nowShown = k.includes('KEY') ? '(已隐藏)' : v
  console.log('  ' + setKey(k, v).padEnd(8) + k.replace('HINDSIGHT_API_LLM_', '') + ' : ' + oldShown + '  ->  ' + nowShown)
}

await writeFile(embedPath, lines.join('\n'), 'utf8')
console.log('\n已写入 ' + embedPath)
