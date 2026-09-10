// 用用户新创建的 opencode key 试。不打印 key 本身。
const KEY = process.env.PROBE_KEY
const BASE = 'https://opencode.ai/zen/v1'

console.log('key 长度 ' + KEY.length + '  尾4 …' + KEY.slice(-4))
console.log('')

// 1. 列模型
try {
  const res = await fetch(BASE + '/models', { headers: { authorization: 'Bearer ' + KEY }, signal: AbortSignal.timeout(25000) })
  console.log('GET /models -> HTTP ' + res.status)
  if (res.ok) {
    const j = await res.json()
    const ids = (j.data ?? []).map(m => m.id)
    console.log('  可用模型 ' + ids.length + ' 个:')
    console.log('   ' + ids.join(', ').slice(0, 700))
    console.log('')
    console.log('  免费档: ' + ids.filter(i => /free/i.test(i)).join(', '))
  } else {
    console.log('  ' + (await res.text()).slice(0, 200))
  }
} catch (e) { console.log('GET /models ❌ ' + String(e.message).slice(0, 90)) }

// 2. 试几个模型
console.log('')
console.log('--- chat/completions ---')
for (const model of ['nemotron-3-ultra-free', 'deepseek-v4-flash-free', 'laguna-s-2.1-free', 'big-pickle']) {
  const t0 = Date.now()
  try {
    const res = await fetch(BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: '只回复两个字：可用' }], max_tokens: 16 }),
      signal: AbortSignal.timeout(60000),
    })
    const body = (await res.text()).replace(/\s+/g, ' ')
    console.log('  ' + model.padEnd(26) + 'HTTP ' + String(res.status).padEnd(4) + (Date.now() - t0 + 'ms').padEnd(9) + body.slice(0, 150))
  } catch (e) { console.log('  ' + model.padEnd(26) + '❌ ' + String(e.message).slice(0, 80)) }
}
