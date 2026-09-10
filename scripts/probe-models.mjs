import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const raw = await readFile(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
const m = raw.match(/^\s*DSDGPT_API_KEY\s*:\s*(.+?)\s*$/m)
const key = m[1].replace(/^["']|["']$/g, '').trim()

const models = ['deepseek-v4-flash', 'deepseek-v4-pro', 'gpt-5.6-terra', 'gpt-6-astra', 'glm-5.2', 'minimax-m3', 'kimi-k2.5']
for (const model of models) {
  const t0 = Date.now()
  try {
    const res = await fetch('https://www.dasixda.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: '回复 OK' }], max_tokens: 8 }),
      signal: AbortSignal.timeout(40000),
    })
    const ms = Date.now() - t0
    if (res.ok) {
      const j = await res.json().catch(() => null)
      console.log(model.padEnd(20) + ' ✅ ' + String(ms + 'ms').padEnd(9) + (j?.choices?.[0]?.message?.content ?? '').slice(0, 20).replace(/\n/g, ' '))
    } else {
      console.log(model.padEnd(20) + ' ❌ HTTP ' + res.status + '  ' + (await res.text()).replace(/\s+/g, ' ').slice(0, 70))
    }
  } catch (e) { console.log(model.padEnd(20) + ' ❌ ' + String(e.message).slice(0, 60)) }
}
