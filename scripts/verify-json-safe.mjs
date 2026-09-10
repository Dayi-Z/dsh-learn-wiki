// lossless JSON 清洗器自检。
// 这个坑踩了四次（note/page/sessionId/…），每次都是"某个字段在某种数据形状下才 undefined"，
// 靠测试很难穷尽 —— 所以改成结构性兜底。但兜底本身也要有测试。
import { sanitizeJson, withSanitizedOutput } from '../lib/json-safe.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}
const clean = (v) => { const r = sanitizeJson(v); return { v: r.value, n: r.fixes.length, fixes: r.fixes } }

console.log('=== 三类非法值 ===')
const a = clean({ x: 1, y: undefined, z: 3 })
check('undefined 的键被删掉', !('y' in a.v) && a.v.x === 1 && a.v.z === 3, JSON.stringify(a.v))
check('清洗被记录', a.n === 1 && a.fixes[0] === '$.y = undefined', JSON.stringify(a.fixes))

const b = clean({ n: NaN, i: Infinity, m: -Infinity })
check('NaN -> null', b.v.n === null && b.v.i === null && b.v.m === null, JSON.stringify(b.v))
check('三个都被记录', b.n === 3, JSON.stringify(b.fixes))

console.log('\n=== 数组语义 ===')
const c = clean({ arr: [1, undefined, 3] })
check('★ 数组里的 undefined -> null（删掉会改变索引）', c.v.arr.length === 3 && c.v.arr[1] === null, JSON.stringify(c.v.arr))

console.log('\n=== 嵌套与特殊类型 ===')
const d = clean({ deep: { a: [{ b: undefined, c: NaN }] } })
check('深层嵌套也被清理', !('b' in d.v.deep.a[0]) && d.v.deep.a[0].c === null, JSON.stringify(d.v))
const e = clean({ when: new Date('2026-09-10T00:00:00Z') })
check('Date -> ISO 字符串', typeof e.v.when === 'string' && e.v.when.startsWith('2026-09-10'), e.v.when)
const f = clean({ fn: () => 1, big: 10n })
check('function 被删、bigint 变字符串', !('fn' in f.v) && f.v.big === '10', JSON.stringify(f.v))

const circ = {}; circ.self = circ
const g = clean(circ)
check('循环引用不炸', g.v.self === null, JSON.stringify(g.v))

console.log('\n=== 正常值不被改动 ===')
const h = clean({ s: 'ok', n: 42, b: true, nl: null, arr: [1, 2], o: { k: 'v' } })
check('干净输入零清洗', h.n === 0, JSON.stringify(h.fixes))
check('值原样保留', JSON.stringify(h.v) === JSON.stringify({ s: 'ok', n: 42, b: true, nl: null, arr: [1, 2], o: { k: 'v' } }), JSON.stringify(h.v))

console.log('\n=== 包装器 ===')
const logs = []
const wrapped = withSanitizedOutput(async () => ({ bad: undefined, nan: NaN }), (m) => logs.push(m), 'demo')
const out = await wrapped()
check('包装器清洗输出', !('bad' in out) && out.nan === null, JSON.stringify(out))
check('★ 清洗必须留痕（否则我看不见真 bug）', logs.length === 1 && logs[0].includes('demo'), JSON.stringify(logs))
const w2 = withSanitizedOutput(async () => ({ fine: 1 }), (m) => logs.push(m), 'demo2')
await w2()
check('干净输出不产生日志', logs.length === 1, JSON.stringify(logs.length))

console.log(failures === 0 ? '\nALL PASS — lossless 清洗正确' : '\n' + failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
