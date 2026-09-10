// 从源码估算 rag-self-train 的 schema 开销。
// 目的：在停掉插件之前先给出一个**可被证伪**的预测值，
// 这样重启后的 context_audit 数字才有对照意义。
import { readFile } from 'node:fs/promises'

const src = await readFile('D:/Harness/dsh-rag-self-train/src/dsh/tools/kb-tools.ts', 'utf8')

// 描述字面量：单引号 / 双引号 / 反引号三种都可能
const DESC = /description:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|' + '`' + '([^' + '`' + ']*)' + '`' + ')/gs
const descs = [...src.matchAll(DESC)].map(m => m[1] ?? m[2] ?? m[3] ?? '')

const names = [...src.matchAll(/name:\s*'(rag_[a-z_]+)'/g)].map(m => m[1])

// 参数说明（prop(type, required, description) 的第三项）
const PROP = /prop\((?:'|")[a-z]+(?:'|"),\s*(?:true|false),\s*(?:'|")((?:[^'"\\]|\\.)*)(?:'|")/g
const params = [...src.matchAll(PROP)].map(m => m[1])

const descChars = descs.reduce((s, d) => s + d.length, 0)
const paramChars = params.reduce((s, p) => s + p.length, 0)
const total = descChars + paramChars

console.log('工具数              : ' + names.length)
console.log('描述条数 / 字符     : ' + descs.length + ' / ' + descChars)
console.log('参数说明条数 / 字符 : ' + params.length + ' / ' + paramChars)
console.log('合计字符            : ' + total)
console.log('')
// 中英混排的经验换算：约 1.4 字符/token（含 JSON 键名与结构开销）
const est = Math.round(total / 1.4)
console.log('估算 token（÷1.4）  : ~' + est)
console.log('当前全量实测        : 131 个工具 / 10,077 token')
console.log('预测停用后          : ' + (131 - names.length) + ' 个工具 / ~' + (10077 - est) + ' token')
console.log('')
console.log('--- 最长的 5 条描述 ---')
;[...descs].sort((a, b) => b.length - a.length).slice(0, 5).forEach(d => console.log('  ' + d.length + ' 字符 | ' + d.slice(0, 56) + '…'))
