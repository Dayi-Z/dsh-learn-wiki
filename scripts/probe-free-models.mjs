const KEY = process.env.OC_KEY
const BASE = 'https://opencode.ai/zen/v1'
const FREE = [
  'nemotron-3-ultra-free',
  'nemotron-3.5-lightning-free',
  'mimo-v2.5-free',
  'ling-3.0-flash-fin-free',
  'muse-spark-1.3-contributor-free',
  'muse-spark-1.2-contributor-free',
  'deepseek-v4-flash-free',
  'big-pickle',
]
console.log('模型'.padEnd(34) + '结果')
console.log('-'.repeat(76))
for (const m of FREE) {
  const t0 = Date.now()
  try {
    const res = await fetch(BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY, 'x-session-id': 'hindsight-bank' },
      body: JSON.stringify({ model: m, messages: [{ role: 'user', content: '回复OK' }], max_tokens: 8 }),
      signal: AbortSignal.timeout(50000),
    })
    const ms = Date.now() - t0
    const body = (await res.text()).replace(/\s+/g, ' ')
    if (res.ok) {
      console.log(m.padEnd(34) + '✅ ' + String(ms + 'ms').padEnd(9) + body.slice(0, 60))
    } else {
      let why = body.slice(0, 90)
      try { const j = JSON.parse(body); why = j?.error?.type ?? j?.error?.code ?? why } catch {}
      console.log(m.padEnd(34) + '❌ HTTP ' + String(res.status).padEnd(4) + String(ms + 'ms').padEnd(9) + why)
    }
  } catch (e) { console.log(m.padEnd(34) + '❌ ' + String(e.message).slice(0, 60)) }
}
