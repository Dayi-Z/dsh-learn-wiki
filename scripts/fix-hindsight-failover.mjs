// 给 Hindsight 配多模型 failover 链：免费档偶发 502 时自动换下一个。
//
// 实测可用的免费模型（带 x-session-id）：
//   nemotron-3.5-lightning-free  1.1s  ← 主
//   ling-3.0-flash-fin-free      1.3s
//   big-pickle                   1.9s
//   nemotron-3-ultra-free        4.7s
//   mimo-v2.5-free              10.2s
// 不可用：muse-spark-*.contributor-free (403 RegionError)、deepseek-v4-flash-free (400)
//
// 成员字段来自 config.py 的 LLMMemberConfig：PROVIDER / API_KEY / MODEL / BASE_URL / DEFAULT_HEADERS …
// 成员**不继承**主成员的这些值，必须逐个写全。
import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const embedPath = join(homedir(), '.hindsight', 'embed')
const KEY = process.env.OC_KEY
if (!KEY) { console.error('缺少 OC_KEY'); process.exit(1) }

const BASE = 'https://opencode.ai/zen/v1'
const HDR = JSON.stringify({ 'x-session-id': 'hindsight-bank' })
const CHAIN = ['ling-3.0-flash-fin-free', 'big-pickle', 'nemotron-3-ultra-free', 'mimo-v2.5-free']

const DESIRED = {
  HINDSIGHT_API_LLM_STRATEGY: JSON.stringify({ mode: 'failover' }),
  // 主（index 0）
  HINDSIGHT_API_LLM_PROVIDER: 'openai',
  HINDSIGHT_API_LLM_BASE_URL: BASE,
  HINDSIGHT_API_LLM_MODEL: 'nemotron-3.5-lightning-free',
  HINDSIGHT_API_LLM_API_KEY: KEY,
  HINDSIGHT_API_LLM_DEFAULT_HEADERS: HDR,
}
CHAIN.forEach((model, i) => {
  const n = i + 1
  DESIRED['HINDSIGHT_API_LLM_' + n + '_PROVIDER'] = 'openai'
  DESIRED['HINDSIGHT_API_LLM_' + n + '_BASE_URL'] = BASE
  DESIRED['HINDSIGHT_API_LLM_' + n + '_MODEL'] = model
  DESIRED['HINDSIGHT_API_LLM_' + n + '_API_KEY'] = KEY
  DESIRED['HINDSIGHT_API_LLM_' + n + '_DEFAULT_HEADERS'] = HDR
})

let lines = (await readFile(embedPath, 'utf8')).split(/\r?\n/)
// 先清掉旧的链成员，避免残留 index 造成"不连续"
lines = lines.filter(l => !/^\s*HINDSIGHT_API_LLM_\d+_/.test(l))

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
await copyFile(embedPath, embedPath + '.bak-' + stamp)
console.log('备份: embed.bak-' + stamp)

for (const [k, v] of Object.entries(DESIRED)) {
  const re = new RegExp('^\\s*' + k + '=')
  const idx = lines.findIndex(l => re.test(l))
  const line = k + '=' + v
  if (idx >= 0) lines[idx] = line; else lines.push(line)
  const shown = k.includes('KEY') ? '(隐藏)' : v
  console.log('  ' + (idx >= 0 ? 'set    ' : 'add    ') + k.replace('HINDSIGHT_API_', '') + ' = ' + shown)
}

await writeFile(embedPath, lines.join('\n'), 'utf8')
console.log('\n链长度: 主 + ' + CHAIN.length + ' 个备用 = ' + (CHAIN.length + 1) + ' 个模型')
