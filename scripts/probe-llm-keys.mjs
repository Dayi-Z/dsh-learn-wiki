// 探活：找出哪个 key 能真正调用。**绝不打印密钥本身。**
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const raw = await readFile(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
const creds = {}
for (const line of raw.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/)
  if (m) creds[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

const candidates = [
  { name: 'DeepSeek 官方', key: creds.DEEPSEEK_API_KEY, base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: 'infer', key: creds.INFER_API_KEY, base: 'https://inferaiapi.com/v1', model: 'deepseek-v4-flash' },
  { name: 'opencode(免费)', key: creds.OPENCODE_API_KEY, base: 'https://opencode.ai/zen/v1', model: 'deepseek-v4-flash-free' },
]

for (const c of candidates) {
  if (!c.key) { console.log(c.name.padEnd(20) + ' 无 key'); continue }
  const t0 = Date.now()
  try {
    const res = await fetch(c.base + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + c.key },
      body: JSON.stringify({ model: c.model, messages: [{ role: 'user', content: 'reply with OK' }], max_tokens: 5 }),
      signal: AbortSignal.timeout(25000),
    })
    const txt = (await res.text()).slice(0, 160)
    console.log(c.name.padEnd(20) + ' HTTP ' + res.status + '  ' + (Date.now() - t0) + 'ms  ' + (res.ok ? '✅ 可用' : '❌ ' + txt.replace(/\s+/g, ' ')))
  } catch (e) {
    console.log(c.name.padEnd(20) + ' ❌ ' + String(e.message).slice(0, 90))
  }
}
