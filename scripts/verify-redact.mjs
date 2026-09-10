import { redact, looksSecret } from '../lib/redact.js'

const cases = [
  ['端点 https://opencode.ai/zen/v1 key：sk-hT4DqjCjxQDsbO4OP76saCIg0cVEwf5MlYJIUYboZQ3OPqeFUylD2NUFJtDh1nlT 我重新创建了', true],
  ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456', true],
  ['OPENCODE_API_KEY=sk-2abcdefghijklmnopqrstuvwxyz', true],
  ['ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', true],
  ['正常的项目问题：如何配置 cordis.patch.yml 的 config 块', false],
  ['报错 ECONNREFUSED 127.0.0.1:8888 怎么办', false],
  ['能力包按需装配工具集能省多少 token', false],
]

let bad = 0
for (const [t, want] of cases) {
  const got = looksSecret(t)
  const ok = got === want
  if (!ok) bad++
  console.log((ok ? '  PASS  ' : '  FAIL  ') + String(got).padEnd(6) + redact(t).slice(0, 76))
}

// 脱敏后原文的密钥必须不残留
const secret = 'sk-hT4DqjCjxQDsbO4OP76saCIg0cVEwf5MlYJIUYboZQ3OPqeFUylD2NUFJtDh1nlT'
const cleaned = redact('key：' + secret + ' 结束')
const leaked = cleaned.includes(secret) || cleaned.includes(secret.slice(0, 30))
console.log((leaked ? '  FAIL  ' : '  PASS  ') + '脱敏后原密钥不残留  — ' + cleaned)
if (leaked) bad++

console.log(bad ? '\n' + bad + ' FAILURE(S)' : '\nALL PASS — 密钥脱敏正确')
process.exit(bad ? 1 : 0)
