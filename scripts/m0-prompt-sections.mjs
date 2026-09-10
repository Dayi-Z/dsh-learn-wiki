// M0 补充：各插件 systemPrompt.section 的静态文本成本。
// context_audit 不计这部分（browser 那次它漏掉了总收益的 30%），必须单独量。
//
// 只扫各插件的入口文件，不做全包递归——上一版全包递归把数据当工具定义，
// 报出 @jackwener/opencli 有 419 个工具。宁窄勿假。
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const NM = process.env.USERPROFILE + '\\.dsh\\profiles\\web\\node_modules'
const targets = [
  ['gitcompass', ['lib/index.js', 'index.js', 'lib/main.js']],
  ['dsh-web-search-pro', ['lib/index.js']],
  ['dsh-learn-wiki', ['index.js']],
  ['memoripo', ['lib/index.js']],
  ['@liustack/modlens', ['lib/index.js', 'index.js']],
  ['dsh-mcp-lens', ['lib/index.js', 'index.js']],
  ['dsh-find-plugin', ['lib/index.js', 'index.js']],
]

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/
const weigh = (s) => {
  let c = 0, l = 0
  for (const ch of s) CJK.test(ch) ? c++ : l++
  return { chars: c + l, tokens: Math.round(c / 2.56 + l / 6.5) }
}

console.log('插件'.padEnd(28) + '段数  字符   token')
console.log('-'.repeat(56))
let sum = 0, sumTok = 0
for (const [pkg, cands] of targets) {
  let src = null, used = ''
  for (const c of cands) {
    try { src = await readFile(join(NM, pkg, c), 'utf8'); used = c; break } catch {}
  }
  if (!src) { console.log(pkg.padEnd(28) + '  (未找到入口)'); continue }
  // 抽 systemPrompt.section({...}) 里的长字符串
  let chars = 0, count = 0
  for (const m of src.matchAll(/systemPrompt\.section\(\{([\s\S]{0,8000}?)\}\)/g)) {
    const strs = [...m[1].matchAll(/(['"])((?:[^'"\\]|\\.){60,}?)\1/g)].map(x => x[2])
    for (const s of strs) { chars += s.length; count++ }
  }
  const t = weigh('x'.repeat(chars)).tokens
  sum += chars; sumTok += t
  console.log(pkg.padEnd(28) + String(count).padStart(4) + String(chars).padStart(7) + String(t).padStart(8))
}
console.log('-'.repeat(56))
console.log('合计'.padEnd(28) + '      ' + String(sum).padStart(7) + String(sumTok).padStart(8))
console.log('')
console.log('（未包含 @deepseek-ai 内置插件与 hindsight 的知识块 ~300 token）')
