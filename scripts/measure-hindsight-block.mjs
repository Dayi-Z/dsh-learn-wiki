import { readFile } from 'node:fs/promises'
const p = process.env.USERPROFILE + '\\.dsh\\profiles\\web\\node_modules\\@vectorize-io\\hindsight-coding-agents\\dist\\dsh.js'
const src = await readFile(p, 'utf8')

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/
const toks = (s) => { let c = 0, l = 0; for (const ch of s) CJK.test(ch) ? c++ : l++; return Math.round(c / 2.56 + l / 6.5) }

// 找注入块里的特征句
for (const needle of ['FIRST STOP for any question', 'ALSO your correction tool', 'No knowledge pages yet']) {
  const i = src.indexOf(needle)
  console.log(needle + '  -> ' + (i < 0 ? 'NOT FOUND' : 'at ' + i))
}

// 反引号模板串通常包含整段指引；找出同时含两个特征句的那个模板
const i1 = src.indexOf('FIRST STOP for any question')
if (i1 > 0) {
  // 向前找模板起点（反引号或引号）
  let start = i1
  for (let d = 0; d < 8000 && start > 0; d++) {
    const ch = src[start]
    if (ch === '`' || ch === "'") break
    start--
  }
  // 向后找终点
  const q = src[start]
  let end = i1
  for (let d = 0; d < 20000 && end < src.length; d++) {
    if (src[end] === q && src[end - 1] !== '\\') break
    end++
  }
  const block = src.slice(start + 1, end)
  console.log('')
  console.log('=== 注入块静态模板 ===')
  console.log('长度      : ' + block.length + ' 字符')
  console.log('估算 token: ~' + toks(block))
  console.log('摘要      : ' + block.slice(0, 220).replace(/\n/g, ' ') + ' …')
}
