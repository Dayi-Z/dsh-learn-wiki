// 详查 infer：先验 key 是否被接受（/models），再逐个试配置里的模型。
// DSDGPT 用同一个解析器是通的，所以解析没问题。
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const raw = await readFile(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
const get = (n) => {
  const m = raw.match(new RegExp('^\\s*' + n + '\\s*:\\s*(.+?)\\s*$', 'm'))
  return m ? m[1].replace(/^["']|["']$/g, '').trim() : null
}
const key = get('INFER_API_KEY')
console.log('INFER_API_KEY 长度: ' + (key ? key.length : 'null') + '  前4: ' + (key ? key.slice(0, 4) : '-'))

const bases = ['https://inferaiapi.com/v1', 'https://api.inferaiapi.com/v1', 'https://inferaiapi.com/api/v1']
for (const base of bases) {
  try {
    const res = await fetch(base + '/models', { headers: { authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(20000) })
    const body = (await res.text()).replace(/\s+/g, ' ')
    console.log('\nGET ' + base + '/models -> HTTP ' + res.status)
    console.log('   ' + body.slice(0, 300))
  } catch (e) { console.log('\nGET ' + base + '/models -> ❌ ' + String(e.message).slice(0, 70)) }
}

// 逐个模型试 chat
const models = ['deepseek-v4-flash', 'deepseek-v4-pro', 'glm-5.1', 'glm-5.2', 'minimax-m3']
console.log('\n--- chat/completions @ https://inferaiapi.com/v1 ---')
for (const model of models) {
  const t0 = Date.now()
  try {
    const res = await fetch('https://inferaiapi.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: '回复 OK' }], max_tokens: 8 }),
      signal: AbortSignal.timeout(40000),
    })
    const body = (await res.text()).replace(/\s+/g, ' ')
    console.log('  ' + model.padEnd(20) + ' HTTP ' + String(res.status).padEnd(4) + (Date.now() - t0 + 'ms').padEnd(9) + body.slice(0, 110))
  } catch (e) { console.log('  ' + model.padEnd(20) + ' ❌ ' + String(e.message).slice(0, 70)) }
}
