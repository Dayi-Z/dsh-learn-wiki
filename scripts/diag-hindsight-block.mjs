// 诊断：为什么每轮注入的知识块说"No knowledge pages yet"，而实际有 28 页。
// 数据是好的（hindsight_list_knowledge_pages 能列出 28 个），所以问题在注入侧的判定条件。
import { readFile } from 'node:fs/promises'

const p = process.env.USERPROFILE + '\\.dsh\\profiles\\web\\node_modules\\@vectorize-io\\hindsight-coding-agents\\dist\\dsh.js'
const src = await readFile(p, 'utf8')

const i = src.indexOf('No knowledge pages yet')
if (i < 0) { console.log('NOT FOUND'); process.exit(0) }

// 往前找条件表达式所在区域
const before = src.slice(Math.max(0, i - 3000), i)
console.log('=== 标记前 3,000 字符（找判定条件）===')
console.log(before.replace(/\\n/g, '\n'))
console.log('')
console.log('=== 标记后 800 字符 ===')
console.log(src.slice(i, i + 800).replace(/\\n/g, '\n'))
