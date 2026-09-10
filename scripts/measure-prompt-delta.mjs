// 精确称重：web-search-pro 在 browser 缺席时裁掉的那段提示词。
// 这段收益不在 context_audit 的 schemaTokens 里，必须单独算，
// 否则会低估"关闭 browser"的总收益。
import { readFile } from 'node:fs/promises'

const p = process.env.USERPROFILE + '\\.dsh\\profiles\\web\\node_modules\\dsh-web-search-pro\\lib\\index.js'
const src = await readFile(p, 'utf8')

const m = src.match(/text:\s*browser\s*\?\s*'((?:[^'\\\\]|\\\\.)*)'\s*:\s*'((?:[^'\\\\]|\\\\.)*)'/s)
if (!m) { console.error('未匹配到两段文案'); process.exit(1) }

const [withBrowser, withoutBrowser] = [m[1], m[2]]
const stat = (s) => {
  let cjk = 0, latin = 0
  for (const ch of s) {
    if (/[\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) cjk++
    else latin++
  }
  return { chars: s.length, cjk, latin }
}
const A = stat(withBrowser), B = stat(withoutBrowser)
const toks = (x) => Math.round(x.cjk / 2.56 + x.latin / 4.0)

console.log('browser 存在时的指引 : ' + A.chars + ' 字符 (中文 ' + A.cjk + ' / 其他 ' + A.latin + ')  -> ~' + toks(A) + ' token')
console.log('browser 缺席时的指引 : ' + B.chars + ' 字符 (中文 ' + B.cjk + ' / 其他 ' + B.latin + ')  -> ~' + toks(B) + ' token')
console.log('')
console.log('提示词段净省         : ' + (A.chars - B.chars) + ' 字符  -> ~' + (toks(A) - toks(B)) + ' token')
console.log('')
console.log('=== 关闭 browser 的总收益 ===')
console.log('  工具 schema（实测） : 802 token   <- context_audit 7,863 -> 7,061')
console.log('  提示词段（计算）    : ~' + (toks(A) - toks(B)) + ' token   <- 不在 audit 里')
console.log('  合计                : ~' + (802 + toks(A) - toks(B)) + ' token / 请求')
