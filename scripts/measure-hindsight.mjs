// 称重 @vectorize-io/hindsight-coding-agents（DSH 变体 dist/dsh.js）。
// 两类成本：工具 schema + 每轮注入的知识块。
import { readFile } from 'node:fs/promises'

const p = process.env.USERPROFILE + '\\.dsh\\profiles\\web\\node_modules\\@vectorize-io\\hindsight-coding-agents\\dist\\dsh.js'
const src = await readFile(p, 'utf8')

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/
const stat = (s) => {
  let cjk = 0, latin = 0
  for (const ch of s) CJK.test(ch) ? cjk++ : latin++
  return { chars: s.length, cjk, latin }
}
// 标定：中文 2.56 字符/token；技术英文实测约 6.5
const toks = (x) => Math.round(x.cjk / 2.56 + x.latin / 6.5)

// ── 1. 工具定义 ──
const toolNames = [...src.matchAll(/name:\s*['"](hindsight_[a-z_]+)['"]/g)].map(m => m[1])
const uniqTools = [...new Set(toolNames)]

// 抓每个工具附近的 description
const descs = []
for (const name of uniqTools) {
  const i = src.indexOf(`name: "${name}"`)
  const j = i >= 0 ? i : src.indexOf(`name: '${name}'`)
  if (j < 0) continue
  const win = src.slice(j, j + 2500)
  const m = win.match(/description:\s*['"]([\s\S]{20,1200}?)['"]\s*,\s*(?:parameters|inputSchema|handler|execute)/)
  if (m) descs.push(m[1].replace(/\\n/g, '\n'))
}

console.log('=== 工具 schema ===')
console.log('工具数        : ' + uniqTools.length)
console.log('抓到描述      : ' + descs.length)
let tAll = { chars: 0, cjk: 0, latin: 0 }
for (const d of descs) { const s = stat(d); tAll.chars += s.chars; tAll.cjk += s.cjk; tAll.latin += s.latin }
console.log('描述合计      : ' + tAll.chars + ' 字符 (中文 ' + tAll.cjk + ' / 其他 ' + tAll.latin + ')')
console.log('估算 token    : ~' + (toks(tAll) + uniqTools.length * 12) + '  (含每工具 12 结构开销)')
console.log('')

// ── 2. 每轮注入的知识块 ──
const marker = 'This repository has a Hindsight memory'
const k = src.indexOf(marker)
console.log('=== 每轮注入的知识块 ===')
if (k < 0) { console.log('未在源码中找到模板（可能是运行时拼接）') }
else {
  // 向后截一段，找模板结束
  const win = src.slice(k, k + 6000)
  const s = stat(win)
  console.log('模板起点附近 6000 字符  : 中文 ' + s.cjk + ' / 其他 ' + s.latin)
  console.log('提示：这段是模板，实际注入还会拼上工具指引与知识页列表')
}
