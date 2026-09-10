const KEY = process.env.PROBE_KEY
const BASE = 'https://opencode.ai/zen/v1'

async function tryChat(label, model, extraHeaders = {}, extraBody = {}) {
  const t0 = Date.now()
  try {
    const res = await fetch(BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY, ...extraHeaders },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: '只回复两字：可用' }], max_tokens: 16, ...extraBody }),
      signal: AbortSignal.timeout(45000),
    })
    const body = (await res.text()).replace(/\s+/g, ' ')
    console.log(label.padEnd(46) + 'HTTP ' + String(res.status).padEnd(4) + (Date.now() - t0 + 'ms').padEnd(8) + body.slice(0, 120))
  } catch (e) { console.log(label.padEnd(46) + '❌ ' + String(e.message).slice(0, 70)) }
}

console.log('--- 付费模型（免费档之外）---')
for (const m of ['deepseek-v4-flash', 'deepseek-v4-pro', 'glm-5.3', 'kimi-k2.7-code', 'minimax-m3', 'gpt-6-astra', 'claude-fable-5-1', 'gemini-3.8-flash']) {
  await tryChat(m, m)
}

console.log('')
console.log('--- 免费模型 + session 变体 ---')
const freeModel = 'nemotron-3-ultra-free'
await tryChat('free + x-session-id', freeModel, { 'x-session-id': 'dsh-learn-wiki' })
await tryChat('free + x-opencode-session-id', freeModel, { 'x-opencode-session-id': 'dsh-learn-wiki' })
await tryChat('free + session header', freeModel, { session: 'dsh-learn-wiki' })
await tryChat('free + body.sessionID', freeModel, {}, { sessionID: 'dsh-learn-wiki' })
await tryChat('free + body.session_id', freeModel, {}, { session_id: 'dsh-learn-wiki' })
await tryChat('free + x-opencode-client', freeModel, { 'x-opencode-client': 'opencode' })
