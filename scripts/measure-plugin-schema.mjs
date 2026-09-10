// 标定过的 schema 成本估算器。
//
// 演进过程（每一步都由实测逼出来）：
//   v1 拍脑袋 ÷1.4        -> 预测 4,043，实测 2,214，高估 1.8 倍  ✗
//   v2 加中英分密度        -> 回测只给 1,347，漏了参数说明          ✗
//   v3 补齐参数说明 + 结构开销（当前）
//
// 标定基准：dsh-rag-self-train，42 工具、描述+参数合计 5,660 字符、实测 2,214 token。
import { readFile } from 'node:fs/promises'

const CJK_PER_TOKEN = 2.56    // 实测标定
const LATIN_PER_TOKEN = 4.0   // 英文经验值，未在本机标定 -> 是误差主要来源
const JSON_OVERHEAD_PER_TOOL = 12 // 工具名/类型/required/JSON 结构骨架的粗略固定开销

const path = process.argv[2]
if (!path) { console.error('usage: node measure-plugin-schema.mjs <file>'); process.exit(2) }
const src = await readFile(path, 'utf8')

const grab = (re, g = 1) => [...src.matchAll(re)].map(m => m[g] ?? '')

const names = grab(/name:\s*'([a-zA-Z_][a-zA-Z0-9_]*)'/g)

// 描述：三种引号都要抓
const descs = [
  ...grab(/description:\s*'((?:[^'\\]|\\.)*)'/g),
  ...grab(/description:\s*"((?:[^"\\]|\\.)*)"/g),
  ...grab(/description:\s*' + '`' + '([^' + '`' + ']*)' + '`' + '/g),
]
// 参数说明：prop(type, required, '说明') —— v2 漏掉的就是这部分
const params = grab(/prop\((?:'|")[a-z]+(?:'|"),\s*(?:true|false),\s*(?:'|")((?:[^'"\\]|\\.)*)(?:'|")/g)

const all = [...descs, ...params]
let cjk = 0, latin = 0
for (const d of all) {
  for (const ch of d) {
    if (/[\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) cjk++
    else latin++
  }
}

const cjkTok = Math.round(cjk / CJK_PER_TOKEN)
const latinTok = Math.round(latin / LATIN_PER_TOKEN)
const overhead = names.length * JSON_OVERHEAD_PER_TOOL
const total = cjkTok + latinTok + overhead

console.log('文件              : ' + path.split(/[\\/]/).pop())
console.log('工具数            : ' + names.length)
console.log('描述条数 / 参数条数: ' + descs.length + ' / ' + params.length)
console.log('中文字符 -> token : ' + cjk + ' -> ~' + cjkTok)
console.log('非中文 -> token   : ' + latin + ' -> ~' + latinTok)
console.log('结构开销          : ' + names.length + ' × ' + JSON_OVERHEAD_PER_TOOL + ' = ~' + overhead)
console.log('合计估算 token    : ~' + total)
