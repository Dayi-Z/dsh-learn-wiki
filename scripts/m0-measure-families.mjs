// M0：测量所有插件的能力族成本。
//
// 标定基准（本会话实测，不是猜的）：
//   dsh-rag-self-train  42 工具 -> schema 2,214 token   (中文为主)
//   browser             18 工具 -> schema   802 token   (纯英文技术描述)
//   反推密度：中文 ~2.56 字符/token；技术英文 ~6.5 字符/token
// （英文 4.0 的常识值对技术文本偏低——领域词重复度高，tokenizer 效率更高）
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/
const CJK_PER_TOKEN = 2.56
const LATIN_PER_TOKEN = 6.5
const OVERHEAD_PER_TOOL = 12

const weigh = (s) => {
  let cjk = 0, latin = 0
  for (const ch of String(s)) CJK.test(ch) ? cjk++ : latin++
  return { chars: cjk + latin, cjk, latin, tokens: Math.round(cjk / CJK_PER_TOKEN + latin / LATIN_PER_TOKEN) }
}

async function jsFiles(dir, depth = 0, out = []) {
  if (depth > 3) return out
  let ents = []
  try { ents = await readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      await jsFiles(p, depth + 1, out)
    } else if (/\.(js|mjs|cjs)$/.test(e.name) && !e.name.endsWith('.map')) {
      try { const st = await stat(p); if (st.size < 3_000_000) out.push(p) } catch {}
    }
  }
  return out
}

/** 从一个 JS 文件里抽工具定义与提示词段。 */
function analyze(src) {
  const tools = []
  // 工具定义：name: 'x' ... description: '...'
  const re = /name:\s*(['"])([a-zA-Z][a-zA-Z0-9_]*)\1[\s\S]{0,400}?description:\s*(['"])((?:[^'"\\]|\\.)*?)\3/g
  for (const m of src.matchAll(re)) {
    tools.push({ name: m[2], desc: m[4] })
  }
  // 提示词段：systemPrompt.section({ ... text: <...> })
  let promptChars = 0, promptCount = 0
  const pre = /systemPrompt\.section\(\{([\s\S]{0,6000}?)\}\)/g
  for (const m of src.matchAll(pre)) {
    const body = m[1]
    const strs = [...body.matchAll(/(['"])((?:[^'"\\]|\\.){60,}?)\1/g)].map(x => x[2])
    for (const s of strs) { promptChars += s.length; promptCount++ }
  }
  return { tools, promptChars, promptCount }
}

const roots = [
  process.env.USERPROFILE + '\\.dsh\\profiles\\web\\node_modules',
  'D:\\Harness\\dsh-desktop\\resources\\app\\node_modules\\@deepseek-ai',
]

// 收集候选包目录
const pkgs = []
for (const root of roots) {
  let ents = []
  try { ents = await readdir(root, { withFileTypes: true }) } catch { continue }
  for (const e of ents) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue
    if (e.name.startsWith('@')) {
      let subs = []
      try { subs = await readdir(join(root, e.name), { withFileTypes: true }) } catch { continue }
      for (const s of subs) if (s.isDirectory() || s.isSymbolicLink()) pkgs.push({ name: e.name + '/' + s.name, dir: join(root, e.name, s.name) })
    } else {
      pkgs.push({ name: e.name, dir: join(root, e.name) })
    }
  }
}

const rows = []
for (const pkg of pkgs) {
  const files = await jsFiles(pkg.dir)
  if (files.length === 0) continue
  const seen = new Set()
  let descChars = 0, descCjk = 0, descLatin = 0, promptChars = 0, promptCount = 0
  for (const f of files) {
    let src = ''
    try { src = await readFile(f, 'utf8') } catch { continue }
    const { tools, promptChars: pc, promptCount: pn } = analyze(src)
    for (const t of tools) {
      if (seen.has(t.name)) continue
      seen.add(t.name)
      const w = weigh(t.desc)
      descChars += w.chars; descCjk += w.cjk; descLatin += w.latin
    }
    promptChars += pc; promptCount += pn
  }
  if (seen.size === 0) continue
  const toolTokens = Math.round(descCjk / CJK_PER_TOKEN + descLatin / LATIN_PER_TOKEN) + seen.size * OVERHEAD_PER_TOOL
  rows.push({
    pkg: pkg.name, tools: seen.size, toolTokens,
    names: [...seen].sort().join(' '),
    promptChars, promptCount,
    promptTokens: Math.round(weigh('x'.repeat(promptChars)).tokens),
  })
}

rows.sort((a, b) => b.toolTokens - a.toolTokens)
console.log('包名'.padEnd(46) + '工具  schema~  prompt字符')
console.log('-'.repeat(80))
for (const r of rows) {
  console.log(r.pkg.padEnd(46) + String(r.tools).padStart(4) + String(r.toolTokens).padStart(8) + String(r.promptChars).padStart(11))
}
console.log('')
console.log('=== 明细（仅第三方插件）===')
for (const r of rows.filter(r => !r.pkg.startsWith('@deepseek-ai/'))) {
  console.log(r.pkg + '  (' + r.tools + ' 工具, ~' + r.toolTokens + ' token)')
  console.log('   ' + r.names.slice(0, 220))
}
