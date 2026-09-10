import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const raw = await readFile(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
const creds = {}
for (const line of raw.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/)
  if (m) creds[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
}
console.log('解析到 ' + Object.keys(creds).length + ' 个 key\n')

const DAS = 'https://www.dasixda.com/v1'
const candidates = [
  ['DEEPSEEK_API_KEY',   'https://api.deepseek.com/v1', 'deepseek-chat'],
  ['INFER_API_KEY',      'https://inferaiapi.com/v1',  'deepseek-v4-flash'],
  ['OPENCODE_API_KEY',   'https://opencode.ai/zen/v1', 'deepseek-v4-flash-free'],
  ['DSD_API_KEY',        DAS, 'deepseek-v4-flash'],
  ['DSDGPT_API_KEY',     DAS, 'gpt-6-astra'],
  ['DEEPSEEKDND_API_KEY', DAS, 'deepseek-v4-flash'],
]

for (const [name, base, model] of candidates) {
  const key = creds[name]
  if (!key) { console.log(name.padEnd(22) + ' 缺失'); continue }
  const t0 = Date.now()
  try {
    const res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'OK' }], max_tokens: 5 }),
      signal: AbortSignal.timeout(25000),
    })
    const body = (await res.text()).replace(/\s+/g, ' ').slice(0, 130)
    console.log(name.padEnd(22) + ' HTTP ' + String(res.status).padEnd(4) + (Date.now() - t0 + 'ms').padEnd(8) + (res.ok ? '✅ ' + body : '❌ ' + body))
  } catch (e) {
    console.log(name.padEnd(22) + ' ❌ ' + String(e.message).slice(0, 80))
  }
}
